import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface RunRecord {
  id: string;
  playerId: string;
  seed: number;
  issuedAt: number;
  expiresAt: number;
  status: 'started' | 'used' | 'rejected';
  usedAt?: number;
}

export interface ScoreRecord {
  runId: string;
  playerId: string;
  score: number;
  distance: number;
  flips: number;
  maxCombo: number;
  durationMs: number;
  createdAt: string;
}

export interface LeaderboardRow {
  rank: number;
  playerId: string;
  nickname: string;
  score: number;
  flips: number;
  createdAt: string;
  isYou: boolean;
}

export interface LeaderboardData {
  entries: LeaderboardRow[];
  you: { best: number; rank: number } | null;
}

export interface LeaderboardStore {
  ensurePlayer(playerId: string): Promise<void>;
  setNickname(playerId: string, nickname: string, now: number): Promise<void>;
  getNickname(playerId: string): Promise<string | null>;
  createRun(run: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
  consumeRun(runId: string, now: number): Promise<boolean>;
  rejectRun(runId: string): Promise<void>;
  rateLimitHit(key: string, windowMs: number, max: number, now: number): Promise<boolean>;
  saveScore(score: ScoreRecord): Promise<void>;
  leaderboard(since: string | null, playerId: string | null): Promise<LeaderboardData>;
}

interface Player {
  id: string;
  nickname: string;
}

export class MemoryStore implements LeaderboardStore {
  private readonly players = new Map<string, Player>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly scores: ScoreRecord[] = [];
  private readonly limits = new Map<string, number>();

  async ensurePlayer(playerId: string): Promise<void> {
    if (!this.players.has(playerId)) this.players.set(playerId, { id: playerId, nickname: 'NeonDriver' });
  }

  async setNickname(playerId: string, nickname: string): Promise<void> {
    this.players.set(playerId, { id: playerId, nickname });
  }

  async getNickname(playerId: string): Promise<string | null> {
    return this.players.get(playerId)?.nickname ?? null;
  }

  async createRun(run: RunRecord): Promise<void> {
    this.runs.set(run.id, { ...run });
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }

  async consumeRun(runId: string, now: number): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'started') return false;
    run.status = 'used';
    run.usedAt = now;
    return true;
  }

  async rejectRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run) run.status = 'rejected';
  }

  async rateLimitHit(key: string, windowMs: number, max: number, now: number): Promise<boolean> {
    const bucket = `${key}:${Math.floor(now / windowMs)}`;
    const count = (this.limits.get(bucket) ?? 0) + 1;
    this.limits.set(bucket, count);
    return count <= max;
  }

  async saveScore(score: ScoreRecord): Promise<void> {
    this.scores.push({ ...score });
  }

  async leaderboard(since: string | null, playerId: string | null): Promise<LeaderboardData> {
    const sinceTime = since ? Date.parse(since) : -Infinity;
    const bestByPlayer = new Map<string, ScoreRecord>();
    for (const score of this.scores) {
      if (Date.parse(score.createdAt) < sinceTime) continue;
      const current = bestByPlayer.get(score.playerId);
      if (!current || score.score > current.score || (score.score === current.score && score.createdAt < current.createdAt)) bestByPlayer.set(score.playerId, score);
    }
    const ranked = [...bestByPlayer.values()].sort((a, b) => b.score - a.score || a.createdAt.localeCompare(b.createdAt) || a.playerId.localeCompare(b.playerId));
    const youIndex = playerId ? ranked.findIndex((score) => score.playerId === playerId) : -1;
    const entries = ranked.slice(0, 50).map((score, index) => ({
      rank: index + 1,
      playerId: score.playerId,
      nickname: this.players.get(score.playerId)?.nickname ?? 'NeonDriver',
      score: score.score,
      flips: score.flips,
      createdAt: score.createdAt,
      isYou: score.playerId === playerId,
    }));
    const youScore = youIndex >= 0 ? ranked[youIndex] : null;
    return {
      entries,
      you: youScore ? { best: youScore.score, rank: youIndex + 1 } : null,
    };
  }
}

interface LeaderboardRpcRow {
  rank: number;
  player_id: string;
  nickname: string;
  score: number;
  flips: number;
  created_at: string;
  is_you: boolean;
}

function throwOnError(error: { message: string } | null): void {
  if (error) throw new Error(`supabase_store_error: ${error.message}`);
}

export class SupabaseStore implements LeaderboardStore {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async ensurePlayer(playerId: string): Promise<void> {
    const { error } = await this.client.from('players').upsert(
      { id: playerId, nickname: 'NeonDriver' },
      { onConflict: 'id', ignoreDuplicates: true },
    );
    throwOnError(error);
  }

  async setNickname(playerId: string, nickname: string, now: number): Promise<void> {
    const { error } = await this.client.from('players').upsert({
      id: playerId,
      nickname,
      updated_at: new Date(now).toISOString(),
    }, { onConflict: 'id' });
    throwOnError(error);
  }

  async getNickname(playerId: string): Promise<string | null> {
    const { data, error } = await this.client.from('players').select('nickname').eq('id', playerId).maybeSingle();
    throwOnError(error);
    return data?.nickname ?? null;
  }

  async createRun(run: RunRecord): Promise<void> {
    const { error } = await this.client.from('runs').insert({
      id: run.id,
      player_id: run.playerId,
      seed: run.seed,
      issued_at: new Date(run.issuedAt).toISOString(),
      expires_at: new Date(run.expiresAt).toISOString(),
      status: run.status,
    });
    throwOnError(error);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const { data, error } = await this.client.from('runs')
      .select('id,player_id,seed,issued_at,expires_at,status,used_at')
      .eq('id', runId)
      .maybeSingle();
    throwOnError(error);
    if (!data) return null;
    return {
      id: data.id,
      playerId: data.player_id,
      seed: Number(data.seed),
      issuedAt: Date.parse(data.issued_at),
      expiresAt: Date.parse(data.expires_at),
      status: data.status,
      usedAt: data.used_at ? Date.parse(data.used_at) : undefined,
    };
  }

  async consumeRun(runId: string, now: number): Promise<boolean> {
    const { data, error } = await this.client.from('runs')
      .update({ status: 'used', used_at: new Date(now).toISOString() })
      .eq('id', runId)
      .eq('status', 'started')
      .select('id')
      .maybeSingle();
    throwOnError(error);
    return Boolean(data);
  }

  async rejectRun(runId: string): Promise<void> {
    const { error } = await this.client.from('runs').update({ status: 'rejected' }).eq('id', runId).in('status', ['started', 'used']);
    throwOnError(error);
  }

  async rateLimitHit(key: string, windowMs: number, max: number, now: number): Promise<boolean> {
    const { data, error } = await this.client.rpc('rate_limit_hit', {
      p_key: key,
      p_window_seconds: Math.max(1, Math.floor(windowMs / 1000)),
      p_max: max,
      p_now: new Date(now).toISOString(),
    });
    throwOnError(error);
    return data === true;
  }

  async saveScore(score: ScoreRecord): Promise<void> {
    const { error } = await this.client.from('scores').insert({
      run_id: score.runId,
      player_id: score.playerId,
      score: score.score,
      distance: score.distance,
      flips: score.flips,
      max_combo: score.maxCombo,
      duration_ms: score.durationMs,
      created_at: score.createdAt,
    });
    throwOnError(error);
  }

  async leaderboard(since: string | null, playerId: string | null): Promise<LeaderboardData> {
    const { data, error } = await this.client.rpc('leaderboard_data', {
      p_since: since,
      p_player_id: playerId,
    });
    throwOnError(error);
    const rows = (data ?? []) as LeaderboardRpcRow[];
    const you = playerId ? rows.find((row) => row.player_id === playerId) : undefined;
    return {
      entries: rows.filter((row) => row.rank <= 50).map((row) => ({
        rank: Number(row.rank),
        playerId: row.player_id,
        nickname: row.nickname,
        score: Number(row.score),
        flips: Number(row.flips),
        createdAt: row.created_at,
        isYou: row.is_you,
      })),
      you: you ? { best: Number(you.score), rank: Number(you.rank) } : null,
    };
  }
}
