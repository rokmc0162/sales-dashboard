export const ACCESS_TOKEN_COOKIE = "RVJP-ACCESS-TOKEN";
export const REFRESH_TOKEN_COOKIE = "X-REFRESH-TOKEN";
export const ROLES_CLAIM = "https://api.riverse.net/roles";

export type SettlementRole = "operator" | "admin";

export type VerifiedAccessTokenPayload = Record<string, unknown> & {
  exp?: unknown;
  sub?: unknown;
};

export type AccessTokenVerifier = (
  token: string,
) => Promise<VerifiedAccessTokenPayload>;

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isSameOriginMutation(request: Request): boolean {
  if (!MUTATION_METHODS.has(request.method.toUpperCase())) return true;
  if (request.headers.get("origin") !== new URL(request.url).origin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "same-origin";
}

export type VerifiedSettlementIdentityResult =
  | {
      ok: true;
      payload: VerifiedAccessTokenPayload;
      principal: { subject: string; role: SettlementRole };
    }
  | { ok: false; status: 401 | 403 };

export function uniqueCookieValue(
  header: string | null,
  name: string,
): string | null {
  if (!header) return null;

  const values: string[] = [];
  for (const part of header.split(";")) {
    const cookie = part.trim();
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    values.push(cookie.slice(separator + 1));
  }

  // Duplicate cookie names are ambiguous and can enable cookie shadowing. Fail closed.
  if (values.length !== 1 || values[0].length === 0) return null;
  try {
    return decodeURIComponent(values[0]);
  } catch {
    return null;
  }
}

export function isJwtShaped(token: string): boolean {
  const parts = token.split(".");
  return (
    parts.length === 3 &&
    parts.every((part) => part.length > 0 && /^[A-Za-z0-9_-]+$/.test(part))
  );
}

export function settlementRoleFromProviderRoles(
  roles: unknown,
): SettlementRole | null {
  if (!Array.isArray(roles) || !roles.every((role) => typeof role === "string")) {
    return null;
  }
  if (roles.includes("ADMIN") || roles.includes("settlement_admin")) {
    return "admin";
  }
  if (roles.includes("settlement_operator")) return "operator";
  return null;
}

export async function verifySettlementAccessToken(
  token: string,
  verifier: AccessTokenVerifier,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<VerifiedSettlementIdentityResult> {
  if (!isJwtShaped(token)) return { ok: false, status: 401 };

  let payload: VerifiedAccessTokenPayload;
  try {
    payload = await verifier(token);
  } catch {
    return { ok: false, status: 401 };
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.sub !== "string" ||
    payload.sub.length === 0 ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= now()
  ) {
    return { ok: false, status: 401 };
  }

  const role = settlementRoleFromProviderRoles(payload[ROLES_CLAIM]);
  if (!role) return { ok: false, status: 403 };

  return {
    ok: true,
    payload,
    principal: { subject: payload.sub, role },
  };
}
