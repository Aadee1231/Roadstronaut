export interface LeaderboardEntry {
  rank: number;
  nickname: string;
  score: number;
  flips: number;
  createdAt: string;
  isYou: boolean;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  you: { best: number; rank: number | null } | null;
  mode: 'supabase' | 'dev-memory';
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error ?? `request_failed_${response.status}`), { status: response.status });
  return payload as T;
}

export async function startRun(playerId: string): Promise<{ runToken: string; seed: number; runId: string; expiresAt: string; mode: 'supabase' | 'dev-memory' }> {
  return request('/api/run-start', { playerId });
}

export async function submitScore(payload: {
  runToken: string;
  playerId: string;
  nickname: string;
  inputLog: string;
  claimed: { score: number; distance: number; flips: number; durationMs: number };
}): Promise<{ accepted: boolean; score: number; rankAllTime: number | null; rankWeek: number | null; personalBest: number; verified: true }> {
  return request('/api/submit-score', payload);
}

export async function getLeaderboard(period: 'all' | 'week', playerId: string): Promise<LeaderboardResponse> {
  return request(`/api/leaderboard?period=${period}&playerId=${encodeURIComponent(playerId)}`);
}

export async function updateNickname(playerId: string, nickname: string): Promise<void> {
  await request('/api/player', { playerId, nickname });
}
