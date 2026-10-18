import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleVercelRequest } from '../server/vercelAdapter.js';

export default function player(request: VercelRequest, response: VercelResponse): Promise<void> {
  return handleVercelRequest('player', request, response);
}
