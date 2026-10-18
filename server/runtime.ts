import { MemoryStore, SupabaseStore } from './store';
import { createHandlers } from './handlers';

const devMemory = new MemoryStore();
let supabaseHandlers: ReturnType<typeof createHandlers> | null = null;
let supabaseUrl = '';
let supabaseServiceKey = '';

export function getRuntimeHandlers(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof createHandlers> {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    if (!supabaseHandlers || supabaseUrl !== env.SUPABASE_URL || supabaseServiceKey !== env.SUPABASE_SERVICE_ROLE_KEY) {
      supabaseUrl = env.SUPABASE_URL;
      supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY;
      supabaseHandlers = createHandlers({
        store: new SupabaseStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
        mode: 'supabase',
        env,
      });
    }
    return supabaseHandlers;
  }
  if (env.NODE_ENV !== 'production' || env.ALLOW_DEV_LEADERBOARD === '1') {
    return createHandlers({ store: devMemory, mode: 'dev-memory', env });
  }
  return createHandlers({ store: null, mode: 'not-configured', env });
}
