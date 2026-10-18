import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleVercelRequest } from '../server/vercelAdapter.js';

export default function submitScore(request: VercelRequest, response: VercelResponse): Promise<void> {
  return handleVercelRequest('submitScore', request, response);
}
