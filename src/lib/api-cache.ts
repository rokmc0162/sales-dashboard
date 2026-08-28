/**
 * Caching for authenticated read routes.
 *
 * Requiring a session made these routes dynamic — a response that depends on the
 * caller cannot be statically generated — so the `export const revalidate` they
 * used to carry became inert and every request went to Supabase. Caching the
 * *data fetch* instead of the *request* restores the old behaviour: the session
 * is checked on every call, and only the expensive read is shared.
 *
 * The read must THROW on failure rather than return an error value. A rejected
 * promise is not stored, so a transient Supabase outage expires with the
 * request; returning `{ error }` would pin the failure for the whole TTL.
 *
 * The cache is keyed only by `key`, so it is shared across callers by design —
 * only use it for reads that are identical for every authenticated user. A read
 * that varies per user or per query string does not belong here.
 */
import { unstable_cache } from 'next/cache';

export function cachedRead<T>(
  key: string,
  revalidateSeconds: number,
  read: () => Promise<T>,
): () => Promise<T> {
  return unstable_cache(read, [key], { revalidate: revalidateSeconds, tags: [key] });
}

/**
 * `cachedRead` for a Supabase call, unwrapping `{ data, error }` and throwing on
 * error so the failure is never cached.
 */
export function cachedSupabaseRead<T>(
  key: string,
  revalidateSeconds: number,
  run: () => PromiseLike<{ data: T; error: { message: string } | null }>,
): () => Promise<T> {
  return cachedRead(key, revalidateSeconds, async () => {
    const { data, error } = await run();
    if (error) throw new Error(error.message);
    return data;
  });
}
