export interface HandlerRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | undefined>;
  body: unknown;
  ip: string;
}

export interface HandlerResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export type BackendMode = 'supabase' | 'dev-memory' | 'not-configured';
