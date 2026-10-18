import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { decodeInputLog, replayRun } from '../src/sim/replay';
import { FIXED_DT, MAX_RUN_SECONDS } from '../src/sim/constants';
import type { BackendMode, HandlerRequest, HandlerResponse } from './types';
import type { LeaderboardStore } from './store';
import { firstHeader, hashIp, isRecord, mondayStartUtc, normalizeNickname, readJsonBody, UUID_PATTERN } from './validation';

export interface HandlerContext {
  store: LeaderboardStore | null;
  mode: BackendMode;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

interface RunTokenPayload {
  runId: string;
  playerId: string;
  seed: number;
  iat: number;
  exp: number;
  v: 1;
}

const BODY_LIMIT = 800_000;
const INPUT_LOG_LIMIT = 700_000;
const RATE_WINDOW_MS = 60_000;
const DEV_TOKEN_SECRET = 'thrustshift-local-dev-only-token-secret';
const DEV_IP_SALT = 'thrustshift-local-dev-only-ip-salt';

function response(mode: BackendMode, status: number, body: Record<string, unknown>): HandlerResponse {
  return {
    status,
    body: { ...body, mode },
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  };
}

function unavailable(context: HandlerContext): HandlerResponse | null {
  if (context.store) return null;
  return response('not-configured', 503, { error: 'leaderboard_not_configured' });
}

function methodAllowed(request: HandlerRequest, method: string, mode: BackendMode): HandlerResponse | null {
  if (request.method.toUpperCase() === method) return null;
  return response(mode, 405, { error: 'method_not_allowed' });
}

function secret(context: HandlerContext, name: 'RUN_TOKEN_SECRET' | 'IP_HASH_SALT'): string | null {
  const env = context.env ?? process.env;
  const value = env[name];
  if (value) return value;
  if (env.NODE_ENV !== 'production') return name === 'RUN_TOKEN_SECRET' ? DEV_TOKEN_SECRET : DEV_IP_SALT;
  return null;
}

function signedToken(payload: RunTokenPayload, key: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', key).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyToken(token: string, key: string): RunTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = createHmac('sha256', key).update(parts[0]).digest();
  let provided: Buffer;
  let decoded: unknown;
  try {
    provided = Buffer.from(parts[1], 'base64url');
    decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as unknown;
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected) || !isRecord(decoded)) return null;
  const value = decoded;
  if (
    value.v !== 1
    || typeof value.runId !== 'string'
    || !UUID_PATTERN.test(value.runId)
    || typeof value.playerId !== 'string'
    || !UUID_PATTERN.test(value.playerId)
    || !Number.isInteger(value.seed)
    || (value.seed as number) < 0
    || (value.seed as number) > 0xffff_ffff
    || !Number.isInteger(value.iat)
    || !Number.isInteger(value.exp)
  ) return null;
  return value as unknown as RunTokenPayload;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function getIpHash(request: HandlerRequest, context: HandlerContext): string | null {
  const salt = secret(context, 'IP_HASH_SALT');
  if (!salt) return null;
  const forwarded = firstHeader(request, 'x-forwarded-for');
  const ip = (forwarded?.split(',')[0]?.trim() || request.ip || 'unknown').slice(0, 128);
  return hashIp(ip, salt);
}

function parseBody(request: HandlerRequest, mode: BackendMode): { body: Record<string, unknown> } | { response: HandlerResponse } {
  const result = readJsonBody(request, BODY_LIMIT);
  if (result.error) {
    const status = result.error === 'content_type_must_be_application_json' ? 415 : 400;
    return { response: response(mode, status, { error: result.error }) };
  }
  return { body: result.body! };
}

export function createHandlers(context: HandlerContext) {
  const mode = context.mode;
  const now = context.now ?? Date.now;

  async function runStart(request: HandlerRequest): Promise<HandlerResponse> {
    const wrongMethod = methodAllowed(request, 'POST', mode);
    if (wrongMethod) return wrongMethod;
    const notReady = unavailable(context);
    if (notReady) return notReady;
    const parsed = parseBody(request, mode);
    if ('response' in parsed) return parsed.response;
    const playerId = parsed.body.playerId;
    if (typeof playerId !== 'string' || !UUID_PATTERN.test(playerId)) return response(mode, 400, { error: 'invalid_player_id' });
    const tokenKey = secret(context, 'RUN_TOKEN_SECRET');
    const ipHash = getIpHash(request, context);
    if (!tokenKey || !ipHash) return response(mode, 503, { error: 'leaderboard_not_configured' });

    try {
      const timestamp = now();
      if (!await context.store!.rateLimitHit(`ip:${ipHash}:run-start`, RATE_WINDOW_MS, 30, timestamp)) return response(mode, 429, { error: 'rate_limited' });
      if (!await context.store!.rateLimitHit(`player:${playerId}:run-start`, RATE_WINDOW_MS, 30, timestamp)) return response(mode, 429, { error: 'rate_limited' });
      await context.store!.ensurePlayer(playerId);
      const runId = randomUUID();
      const seed = randomBytes(4).readUInt32LE(0);
      const issuedAt = timestamp;
      const iat = Math.floor(timestamp / 1000);
      const exp = iat + 30 * 60;
      await context.store!.createRun({
        id: runId,
        playerId,
        seed,
        issuedAt,
        expiresAt: exp * 1000,
        status: 'started',
      });
      const runToken = signedToken({ runId, playerId, seed, iat, exp, v: 1 }, tokenKey);
      return response(mode, 200, { runToken, seed, runId, expiresAt: new Date(exp * 1000).toISOString() });
    } catch {
      return response(mode, 500, { error: 'internal_error' });
    }
  }

  async function submitScore(request: HandlerRequest): Promise<HandlerResponse> {
    const wrongMethod = methodAllowed(request, 'POST', mode);
    if (wrongMethod) return wrongMethod;
    const notReady = unavailable(context);
    if (notReady) return notReady;
    const parsed = parseBody(request, mode);
    if ('response' in parsed) return parsed.response;
    const { runToken, playerId, nickname, inputLog, claimed } = parsed.body;
    if (typeof runToken !== 'string' || runToken.length > 4096) return response(mode, 400, { error: 'invalid_run_token' });
    if (typeof playerId !== 'string' || !UUID_PATTERN.test(playerId)) return response(mode, 400, { error: 'invalid_player_id' });
    const normalizedNickname = normalizeNickname(nickname);
    if (!normalizedNickname) return response(mode, 400, { error: 'nickname_rejected' });
    if (typeof inputLog !== 'string' || inputLog.length > INPUT_LOG_LIMIT) return response(mode, 400, { error: 'invalid_input_log' });
    if (!isRecord(claimed) || !isNonNegativeInteger(claimed.score) || !isNonNegativeInteger(claimed.distance)
      || !isNonNegativeInteger(claimed.flips) || !isNonNegativeInteger(claimed.durationMs)
      || claimed.durationMs > MAX_RUN_SECONDS * 1000) {
      return response(mode, 400, { error: 'invalid_claim' });
    }
    const tokenKey = secret(context, 'RUN_TOKEN_SECRET');
    const ipHash = getIpHash(request, context);
    if (!tokenKey || !ipHash) return response(mode, 503, { error: 'leaderboard_not_configured' });
    const payload = verifyToken(runToken, tokenKey);
    if (!payload || payload.playerId !== playerId) return response(mode, 401, { error: 'invalid_run_token' });
    const timestamp = now();
    if (timestamp >= payload.exp * 1000 || payload.iat * 1000 > timestamp + 30_000) return response(mode, 401, { error: 'run_token_expired' });

    let inputs: boolean[];
    try {
      inputs = decodeInputLog(inputLog);
    } catch {
      return response(mode, 400, { error: 'invalid_input_log' });
    }
    const simulatedMs = inputs.length * FIXED_DT * 1000;
    if (timestamp - payload.iat * 1000 < simulatedMs * 0.9 - 1500) return response(mode, 429, { error: 'submission_too_fast' });
    if (!await context.store!.rateLimitHit(`ip:${ipHash}:submit-score`, RATE_WINDOW_MS, 10, timestamp)) return response(mode, 429, { error: 'rate_limited' });

    try {
      const run = await context.store!.getRun(payload.runId);
      if (!run || run.playerId !== playerId || run.seed !== payload.seed) return response(mode, 404, { error: 'run_not_found' });
      if (run.status !== 'started') return response(mode, 409, { error: 'run_already_used' });
      if (timestamp >= run.expiresAt) return response(mode, 401, { error: 'run_token_expired' });
      if (!await context.store!.consumeRun(run.id, timestamp)) return response(mode, 409, { error: 'run_already_used' });

      const verified = replayRun(payload.seed, inputs);
      const exactClaimMatches = claimed.score === verified.stats.score
        && claimed.distance === verified.stats.distance
        && claimed.flips === verified.stats.totalFlips
        && claimed.durationMs === verified.durationMs;
      if (!verified.crashed || !exactClaimMatches) {
        await context.store!.rejectRun(run.id);
        return response(mode, 422, { error: 'replay_verification_failed' });
      }

      await context.store!.setNickname(playerId, normalizedNickname, timestamp);
      const createdAt = new Date(timestamp).toISOString();
      await context.store!.saveScore({
        runId: run.id,
        playerId,
        score: verified.stats.score,
        distance: verified.stats.distance,
        flips: verified.stats.totalFlips,
        maxCombo: verified.stats.maxCombo,
        durationMs: verified.durationMs,
        createdAt,
      });
      const [allTime, week] = await Promise.all([
        context.store!.leaderboard(null, playerId),
        context.store!.leaderboard(mondayStartUtc(timestamp), playerId),
      ]);
      return response(mode, 200, {
        accepted: true,
        score: verified.stats.score,
        rankAllTime: allTime.you?.rank ?? null,
        rankWeek: week.you?.rank ?? null,
        personalBest: allTime.you?.best ?? verified.stats.score,
        verified: true,
      });
    } catch {
      return response(mode, 500, { error: 'internal_error' });
    }
  }

  async function leaderboard(request: HandlerRequest): Promise<HandlerResponse> {
    const wrongMethod = methodAllowed(request, 'GET', mode);
    if (wrongMethod) return wrongMethod;
    const notReady = unavailable(context);
    if (notReady) return notReady;
    const period = request.query.period ?? 'all';
    const playerId = request.query.playerId ?? null;
    if (period !== 'all' && period !== 'week') return response(mode, 400, { error: 'invalid_period' });
    if (playerId && !UUID_PATTERN.test(playerId)) return response(mode, 400, { error: 'invalid_player_id' });
    try {
      const since = period === 'week' ? mondayStartUtc(now()) : null;
      const board = await context.store!.leaderboard(since, playerId);
      return response(mode, 200, {
        entries: board.entries.map(({ rank, nickname, score, flips, createdAt, isYou }) => ({ rank, nickname, score, flips, createdAt, isYou })),
        you: board.you,
      });
    } catch {
      return response(mode, 500, { error: 'internal_error' });
    }
  }

  async function player(request: HandlerRequest): Promise<HandlerResponse> {
    const wrongMethod = methodAllowed(request, 'POST', mode);
    if (wrongMethod) return wrongMethod;
    const notReady = unavailable(context);
    if (notReady) return notReady;
    const parsed = parseBody(request, mode);
    if ('response' in parsed) return parsed.response;
    const playerId = parsed.body.playerId;
    const nickname = normalizeNickname(parsed.body.nickname);
    if (typeof playerId !== 'string' || !UUID_PATTERN.test(playerId)) return response(mode, 400, { error: 'invalid_player_id' });
    if (!nickname) return response(mode, 400, { error: 'nickname_rejected' });
    try {
      await context.store!.setNickname(playerId, nickname, now());
      return response(mode, 200, { updated: true, nickname });
    } catch {
      return response(mode, 500, { error: 'internal_error' });
    }
  }

  const guard = (handler: (request: HandlerRequest) => Promise<HandlerResponse>) => async (request: HandlerRequest): Promise<HandlerResponse> => {
    try {
      return await handler(request);
    } catch {
      return response(mode, 500, { error: 'internal_error' });
    }
  };

  return {
    runStart: guard(runStart),
    submitScore: guard(submitScore),
    leaderboard: guard(leaderboard),
    player: guard(player),
  };
}
