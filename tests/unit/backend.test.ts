import { describe, expect, it } from 'vitest';
import { encodeInputLog, replayRun } from '../../src/sim/replay';
import { Simulation } from '../../src/sim/simulation';
import { createHandlers } from '../../server/handlers';
import { getRuntimeHandlers } from '../../server/runtime';
import { MemoryStore } from '../../server/store';
import { mondayStartUtc, normalizeNickname } from '../../server/validation';
import type { HandlerContext } from '../../server/handlers';
import type { HandlerRequest, HandlerResponse } from '../../server/types';

const PLAYER_ID = '01234567-89ab-4cde-8fab-0123456789ab';
const OTHER_PLAYER_ID = '11234567-89ab-4cde-8fab-0123456789ab';
const TOKEN_SECRET = 'test-run-token-secret-with-sufficient-entropy';
const IP_SALT = 'test-ip-hash-salt';

function createTestContext(initialNow = 1_700_000_000_000, options: Partial<HandlerContext> = {}) {
  let timestamp = initialNow;
  const store = options.store === undefined ? new MemoryStore() : options.store;
  const context: HandlerContext = {
    store,
    mode: options.mode ?? 'dev-memory',
    env: options.env ?? { NODE_ENV: 'test', RUN_TOKEN_SECRET: TOKEN_SECRET, IP_HASH_SALT: IP_SALT },
    now: () => timestamp,
  };
  return {
    handlers: createHandlers(context),
    store,
    setNow(value: number) { timestamp = value; },
  };
}

function request(method: string, body?: unknown, query: Record<string, string> = {}): HandlerRequest {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    query,
    body,
    ip: '203.0.113.8',
  };
}

function responseBody<T>(response: HandlerResponse): T {
  return response.body as T;
}

interface StartedRun {
  runToken: string;
  seed: number;
  runId: string;
  expiresAt: string;
  mode: string;
}

async function startRun(handlers: ReturnType<typeof createHandlers>, playerId = PLAYER_ID): Promise<StartedRun> {
  const response = await handlers.runStart(request('POST', { playerId }));
  expect(response.status).toBe(200);
  return responseBody<StartedRun>(response);
}

function inputUntilCrash(seed: number): { inputLog: string; result: ReturnType<typeof replayRun> } {
  const simulation = new Simulation(seed);
  const inputs: boolean[] = [];
  while (!simulation.state.crashed && inputs.length < 20 * 60 * 120) {
    inputs.push(false);
    simulation.step(false);
  }
  const result = replayRun(seed, inputs);
  expect(result.crashed).toBe(true);
  return { inputLog: encodeInputLog(inputs), result };
}

function claimedFor(result: ReturnType<typeof replayRun>) {
  return {
    score: result.stats.score,
    distance: result.stats.distance,
    flips: result.stats.totalFlips,
    durationMs: result.durationMs,
  };
}

describe('leaderboard request handlers', () => {
  it('selects an opt-in memory leaderboard or reports an unconfigured production backend', async () => {
    const unconfigured = getRuntimeHandlers({ NODE_ENV: 'production' });
    const unavailable = await unconfigured.leaderboard(request('GET'));
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ error: 'leaderboard_not_configured', mode: 'not-configured' });

    const optedIn = getRuntimeHandlers({ NODE_ENV: 'production', ALLOW_DEV_LEADERBOARD: '1' });
    const local = await optedIn.leaderboard(request('GET'));
    expect(local.status).toBe(200);
    expect(local.body).toMatchObject({ entries: [], you: null, mode: 'dev-memory' });
  });

  it('issues signed runs, verifies replays, saves authoritative scores, and consumes tokens once', async () => {
    const context = createTestContext();
    const started = await startRun(context.handlers);
    expect(started.seed).toBeGreaterThanOrEqual(0);
    expect(started.seed).toBeLessThanOrEqual(0xffff_ffff);
    expect(started.mode).toBe('dev-memory');

    const replay = inputUntilCrash(started.seed);
    context.setNow(1_700_000_000_000 + replay.result.durationMs + 2_000);
    const body = {
      runToken: started.runToken,
      playerId: PLAYER_ID,
      nickname: 'Neon Pilot',
      inputLog: replay.inputLog,
      claimed: claimedFor(replay.result),
    };
    const submitted = await context.handlers.submitScore(request('POST', body));
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({
      accepted: true,
      score: replay.result.stats.score,
      rankAllTime: 1,
      rankWeek: 1,
      personalBest: replay.result.stats.score,
      verified: true,
      mode: 'dev-memory',
    });

    const reused = await context.handlers.submitScore(request('POST', body));
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ error: 'run_already_used', mode: 'dev-memory' });
    const board = await context.handlers.leaderboard(request('GET', undefined, { period: 'all', playerId: PLAYER_ID }));
    expect(board.body).toMatchObject({
      entries: [{ rank: 1, nickname: 'Neon Pilot', score: replay.result.stats.score, isYou: true }],
      you: { best: replay.result.stats.score, rank: 1 },
      mode: 'dev-memory',
    });
  });

  it('rejects tampered, expired, too-fast, and impossible score submissions', async () => {
    const tamperedContext = createTestContext();
    const tamperedRun = await startRun(tamperedContext.handlers);
    const separator = tamperedRun.runToken.indexOf('.');
    const signatureStart = separator + 1;
    const replacement = tamperedRun.runToken[signatureStart] === 'A' ? 'B' : 'A';
    const tampered = `${tamperedRun.runToken.slice(0, signatureStart)}${replacement}${tamperedRun.runToken.slice(signatureStart + 1)}`;
    const invalidSignature = await tamperedContext.handlers.submitScore(request('POST', {
      runToken: tampered,
      playerId: PLAYER_ID,
      nickname: 'Driver One',
      inputLog: '',
      claimed: { score: 0, distance: 0, flips: 0, durationMs: 0 },
    }));
    expect(invalidSignature.status).toBe(401);

    const expiredContext = createTestContext();
    const expiredRun = await startRun(expiredContext.handlers);
    expiredContext.setNow(Date.parse(expiredRun.expiresAt) + 1);
    const expired = await expiredContext.handlers.submitScore(request('POST', {
      runToken: expiredRun.runToken,
      playerId: PLAYER_ID,
      nickname: 'Driver One',
      inputLog: '',
      claimed: { score: 0, distance: 0, flips: 0, durationMs: 0 },
    }));
    expect(expired.status).toBe(401);
    expect(expired.body).toMatchObject({ error: 'run_token_expired' });

    const fastContext = createTestContext();
    const fastRun = await startRun(fastContext.handlers);
    const tooFast = await fastContext.handlers.submitScore(request('POST', {
      runToken: fastRun.runToken,
      playerId: PLAYER_ID,
      nickname: 'Driver One',
      inputLog: encodeInputLog(Array.from({ length: 240 }, () => false)),
      claimed: { score: 0, distance: 0, flips: 0, durationMs: 0 },
    }));
    expect(tooFast.status).toBe(429);
    expect(tooFast.body).toMatchObject({ error: 'submission_too_fast' });

    const impossibleContext = createTestContext();
    const impossibleRun = await startRun(impossibleContext.handlers);
    const replay = inputUntilCrash(impossibleRun.seed);
    impossibleContext.setNow(1_700_000_000_000 + replay.result.durationMs + 2_000);
    const impossibleScore = replay.result.stats.score + Math.max(51, Math.ceil(replay.result.stats.score * 0.01) + 1);
    const rejected = await impossibleContext.handlers.submitScore(request('POST', {
      runToken: impossibleRun.runToken,
      playerId: PLAYER_ID,
      nickname: 'Driver One',
      inputLog: replay.inputLog,
      claimed: { ...claimedFor(replay.result), score: impossibleScore },
    }));
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ error: 'replay_verification_failed' });
  });

  it('validates JSON, UUIDs, nicknames, and server-backed rate limits', async () => {
    const context = createTestContext();
    const wrongType = await context.handlers.runStart({
      ...request('POST', { playerId: PLAYER_ID }),
      headers: { 'content-type': 'text/plain' },
    });
    expect(wrongType.status).toBe(415);
    expect(wrongType.body).toMatchObject({ error: 'content_type_must_be_application_json', mode: 'dev-memory' });

    const malformed = await context.handlers.runStart(request('POST', '{bad json'));
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ error: 'invalid_json' });

    const oversized = await context.handlers.runStart(request('POST', 'x'.repeat(800_001)));
    expect(oversized.status).toBe(400);
    expect(oversized.body).toMatchObject({ error: 'body_too_large' });

    const invalidPlayer = await context.handlers.runStart(request('POST', { playerId: 'not-a-uuid' }));
    expect(invalidPlayer.status).toBe(400);
    expect(invalidPlayer.body).toMatchObject({ error: 'invalid_player_id' });

    expect((await context.handlers.player(request('POST', { playerId: PLAYER_ID, nickname: 'Neon Pilot' }))).status).toBe(200);
    const invalidNickname = await context.handlers.player(request('POST', { playerId: PLAYER_ID, nickname: 'F4Gdriver' }));
    expect(invalidNickname.status).toBe(400);
    expect(invalidNickname.body).toMatchObject({ error: 'nickname_rejected' });
    expect(normalizeNickname('  Neon   Pilot  ')).toBe('Neon Pilot');
    expect(normalizeNickname('F4Gdriver')).toBeNull();
    expect(normalizeNickname('x!')).toBeNull();

    for (let index = 0; index < 30; index += 1) {
      expect((await context.handlers.runStart(request('POST', { playerId: PLAYER_ID }))).status).toBe(200);
    }
    const limited = await context.handlers.runStart(request('POST', { playerId: PLAYER_ID }));
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: 'rate_limited' });
  });

  it('returns ranked best-per-player all-time and weekly boards and handles unconfigured production', async () => {
    const now = Date.parse('2024-01-10T12:00:00.000Z');
    expect(mondayStartUtc(now)).toBe('2024-01-08T00:00:00.000Z');
    const store = new MemoryStore();
    await store.ensurePlayer(PLAYER_ID);
    await store.ensurePlayer(OTHER_PLAYER_ID);
    await store.setNickname(PLAYER_ID, 'First Driver');
    await store.setNickname(OTHER_PLAYER_ID, 'Second Driver');
    await store.saveScore({
      runId: 'score-1', playerId: PLAYER_ID, score: 500, distance: 50, flips: 2, maxCombo: 1, durationMs: 1_000,
      createdAt: '2024-01-07T12:00:00.000Z',
    });
    await store.saveScore({
      runId: 'score-2', playerId: PLAYER_ID, score: 100, distance: 10, flips: 0, maxCombo: 0, durationMs: 2_000,
      createdAt: '2024-01-09T12:00:00.000Z',
    });
    await store.saveScore({
      runId: 'score-3', playerId: OTHER_PLAYER_ID, score: 300, distance: 30, flips: 1, maxCombo: 1, durationMs: 2_000,
      createdAt: '2024-01-09T13:00:00.000Z',
    });
    const context = createTestContext(now, { store });
    const allTime = await context.handlers.leaderboard(request('GET', undefined, { period: 'all', playerId: PLAYER_ID }));
    expect(allTime.body).toMatchObject({
      entries: [
        { rank: 1, nickname: 'First Driver', score: 500, isYou: true },
        { rank: 2, nickname: 'Second Driver', score: 300, isYou: false },
      ],
      you: { best: 500, rank: 1 },
    });
    const weekly = await context.handlers.leaderboard(request('GET', undefined, { period: 'week', playerId: PLAYER_ID }));
    expect(weekly.body).toMatchObject({
      entries: [
        { rank: 1, nickname: 'Second Driver', score: 300 },
        { rank: 2, nickname: 'First Driver', score: 100, isYou: true },
      ],
      you: { best: 100, rank: 2 },
    });
    expect((await context.handlers.leaderboard(request('GET', undefined, { period: 'invalid' }))).status).toBe(400);

    const production = createHandlers({
      store: null,
      mode: 'not-configured',
      env: { NODE_ENV: 'production' },
      now: () => now,
    });
    const unavailable = await production.leaderboard(request('GET'));
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ error: 'leaderboard_not_configured', mode: 'not-configured' });
  });
});
