import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRuntimeHandlers } from './runtime.js';
import type { HandlerRequest } from './types.js';

type HandlerName = 'runStart' | 'submitScore' | 'leaderboard' | 'player';

function adaptRequest(request: VercelRequest): HandlerRequest {
  const query: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.query)) query[key] = Array.isArray(value) ? value[0] : value;
  const forwarded = request.headers['x-forwarded-for'];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || request.socket.remoteAddress || 'unknown';
  return {
    method: request.method ?? 'GET',
    headers: request.headers,
    query,
    body: request.body,
    ip,
  };
}

export async function handleVercelRequest(name: HandlerName, request: VercelRequest, response: VercelResponse): Promise<void> {
  const env = process.env;
  const mode = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
    ? 'supabase'
    : env.NODE_ENV !== 'production' || env.ALLOW_DEV_LEADERBOARD === '1'
      ? 'dev-memory'
      : 'not-configured';
  try {
    const handlers = getRuntimeHandlers();
    const result = await handlers[name](adaptRequest(request));
    for (const [header, value] of Object.entries(result.headers ?? {})) response.setHeader(header, value);
    response.status(result.status).json(result.body);
  } catch {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.status(500).json({ error: 'internal_error', mode });
  }
}
