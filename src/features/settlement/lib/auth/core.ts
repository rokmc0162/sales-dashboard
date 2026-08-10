import {
  ACCESS_TOKEN_COOKIE,
  type AccessTokenVerifier,
  isSameOriginMutation,
  type SettlementRole,
  uniqueCookieValue,
  verifySettlementAccessToken,
} from "@/lib/auth-core";

export type SettlementAccessTokenVerifier = AccessTokenVerifier;
export type { SettlementRole } from "@/lib/auth-core";

export type SettlementPrincipal = {
  subject: string;
  role: SettlementRole;
};

export type SettlementAuthorizationResult =
  | { ok: true; principal: SettlementPrincipal }
  | { ok: false; status: 401 | 403 };

function meetsMinimumRole(actual: SettlementRole, minimum: SettlementRole) {
  return minimum === "operator" || actual === "admin";
}

export async function authorizeSettlementRequest(
  request: Request,
  minimumRole: SettlementRole,
  verifier: SettlementAccessTokenVerifier,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<SettlementAuthorizationResult> {
  if (!isSameOriginMutation(request)) return { ok: false, status: 403 };

  const token = uniqueCookieValue(
    request.headers.get("cookie"),
    ACCESS_TOKEN_COOKIE,
  );
  if (!token) return { ok: false, status: 401 };

  const verified = await verifySettlementAccessToken(token, verifier, now);
  if (!verified.ok) return verified;
  if (!meetsMinimumRole(verified.principal.role, minimumRole)) {
    return { ok: false, status: 403 };
  }

  return { ok: true, principal: verified.principal };
}
