import { createHash } from 'node:crypto';
import type { HandlerRequest } from './types';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BLOCKED_NICKNAMES = ['fuck', 'shit', 'bitch', 'cunt', 'nazi', 'nigger', 'fag', 'rape'];
const LEET_MAP: Record<string, string> = { '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '8': 'b', '9': 'g' };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasJsonContentType(request: HandlerRequest): boolean {
  const header = request.headers['content-type'] ?? request.headers['Content-Type'];
  const contentType = Array.isArray(header) ? header[0] : header;
  return typeof contentType === 'string' && /^application\/json(?:\s*;|$)/i.test(contentType);
}

export function readJsonBody(request: HandlerRequest, maxBytes = 800_000): { body?: Record<string, unknown>; error?: string } {
  if (!hasJsonContentType(request)) return { error: 'content_type_must_be_application_json' };
  let parsed: unknown = request.body;
  if (typeof parsed === 'string') {
    if (Buffer.byteLength(parsed, 'utf8') > maxBytes) return { error: 'body_too_large' };
    try { parsed = JSON.parse(parsed) as unknown; } catch { return { error: 'invalid_json' }; }
  } else {
    try {
      if (Buffer.byteLength(JSON.stringify(parsed ?? {}), 'utf8') > maxBytes) return { error: 'body_too_large' };
    } catch { return { error: 'invalid_json' }; }
  }
  if (!isRecord(parsed)) return { error: 'body_must_be_object' };
  return { body: parsed };
}

export function normalizeNickname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const nickname = value.trim().replace(/\s+/g, ' ');
  if (nickname.length < 3 || nickname.length > 16 || !/^[A-Za-z0-9 _.-]+$/.test(nickname)) return null;
  const normalized = nickname.toLowerCase().replace(/[01345789!@$]/g, (character) => LEET_MAP[character] ?? character).replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
  if (BLOCKED_NICKNAMES.some((word) => normalized.includes(word))) return null;
  return nickname;
}

export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

export function mondayStartUtc(timestamp: number): string {
  const date = new Date(timestamp);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

export function firstHeader(request: HandlerRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()] ?? request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
