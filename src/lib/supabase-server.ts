import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

function getSupabaseServer(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Prefer the RVJP_ alias; the plain name is a compatibility fallback.
  // Never fall back to anon/public keys.
  const key =
    process.env.RVJP_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing server-only Supabase service-role configuration');
  }
  if (!_client) {
    _client = createClient(url, key);
  }
  return _client;
}

export const supabaseServer = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (getSupabaseServer() as unknown as Record<string | symbol, any>)[prop];
  },
});
