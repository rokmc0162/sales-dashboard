export function shouldClearAuthState(status: number): boolean {
  return status === 401 || status === 403;
}

export function refreshDelayMs(expiresIn: unknown): number | null {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) return null;
  if (expiresIn <= 0) return null;
  return Math.max(100, Math.floor(expiresIn * 800));
}

export const TRANSIENT_REFRESH_RETRY_MS = 30_000;

export function refreshRetryDelayMs(status?: number): number | null {
  return status !== undefined && shouldClearAuthState(status)
    ? null
    : TRANSIENT_REFRESH_RETRY_MS;
}
