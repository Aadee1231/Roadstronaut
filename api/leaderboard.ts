import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleVercelRequest } from '../server/vercelAdapter';

export default function leaderboard(request: VercelRequest, response: VercelResponse): Promise<void> {
  return handleVercelRequest('leaderboard', request, response);
}
