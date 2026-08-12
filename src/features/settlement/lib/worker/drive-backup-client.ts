import { SettlementDriveClient, type SettlementDriveClientLimits } from "../google-drive/client";
import type { SettlementDriveBackupConfig } from "./drive-backup-config";
import {
  fetchGoogleServiceAccountToken,
  type FetchAccessTokenOptions,
  type GoogleAccessToken,
  type GoogleServiceAccountCredentials,
} from "./google-service-account-token";

// Refresh well before expiry so an upload never starts with a token that
// expires mid-request. One in-flight fetch is shared; a failed fetch caches
// nothing, so the next call retries cleanly.
export const TOKEN_REFRESH_MARGIN_SECONDS = 300;

export function createGoogleDriveAccessTokenProvider(
  credentials: GoogleServiceAccountCredentials,
  options: FetchAccessTokenOptions = {},
): () => Promise<string> {
  let cached: GoogleAccessToken | null = null;
  let pending: Promise<GoogleAccessToken> | null = null;
  const now = () =>
    Math.floor(options.nowEpochSeconds ? options.nowEpochSeconds() : Date.now() / 1_000);
  return async () => {
    if (cached && cached.expiresAtEpochSeconds - TOKEN_REFRESH_MARGIN_SECONDS > now()) {
      return cached.accessToken;
    }
    if (!pending) {
      pending = fetchGoogleServiceAccountToken(credentials, options)
        .then((token) => {
          cached = token;
          return token;
        })
        .finally(() => {
          pending = null;
        });
    }
    return (await pending).accessToken;
  };
}

export function createSettlementDriveBackupClient(
  config: Extract<SettlementDriveBackupConfig, { enabled: true }>,
  options: FetchAccessTokenOptions & { limits?: SettlementDriveClientLimits } = {},
): SettlementDriveClient {
  return new SettlementDriveClient(
    { sharedDriveId: config.sharedDriveId },
    createGoogleDriveAccessTokenProvider(
      { clientEmail: config.clientEmail, privateKey: config.privateKey },
      options,
    ),
    options.fetchImpl ?? globalThis.fetch,
    options.limits ?? {},
  );
}
