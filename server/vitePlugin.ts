import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { createHandlers } from './handlers.js';
import { MemoryStore } from './store.js';
import type { HandlerRequest, HandlerResponse } from './types.js';

function requestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > 800_000) reject(new Error('body_too_large'));
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, result: HandlerResponse): void {
  response.statusCode = result.status;
  for (const [name, value] of Object.entries(result.headers ?? {})) response.setHeader(name, value);
  response.end(JSON.stringify(result.body));
}

export function thrustshiftApiPlugin(): Plugin {
  const handlers = createHandlers({
    store: new MemoryStore(),
    mode: 'dev-memory',
    env: { ...process.env, NODE_ENV: 'development' },
  });

  return {
    name: 'thrustshift-dev-api',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const path = url.pathname;
        const route = path === '/api/run-start' ? handlers.runStart
          : path === '/api/submit-score' ? handlers.submitScore
            : path === '/api/leaderboard' ? handlers.leaderboard
              : path === '/api/player' ? handlers.player
                : null;
        if (!route) {
          next();
          return;
        }
        let body: unknown = undefined;
        if (request.method?.toUpperCase() === 'POST') {
          try {
            body = await requestBody(request);
          } catch {
            send(response, { status: 413, body: { error: 'body_too_large', mode: 'dev-memory' } });
            return;
          }
        }
        const headers: HandlerRequest['headers'] = request.headers;
        const forwarded = request.headers['x-forwarded-for'];
        const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() ?? request.socket.remoteAddress ?? 'unknown';
        const handlerRequest: HandlerRequest = {
          method: request.method ?? 'GET',
          headers,
          query: Object.fromEntries(url.searchParams.entries()),
          body,
          ip,
        };
        send(response, await route(handlerRequest));
      });
    },
  };
}
