import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleVercelRequest } from '../server/vercelAdapter.js';

export default function runStart(request: VercelRequest, response: VercelResponse): Promise<void> {
  return handleVercelRequest('runStart', request, response);
}
