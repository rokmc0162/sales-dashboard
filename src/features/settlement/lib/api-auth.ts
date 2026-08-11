import {
  authorizeSettlementRequest,
  type SettlementPrincipal,
  type SettlementRole,
} from "./auth/core";
import { requireSettlementAuth, verifyAuth0AccessToken } from "./auth/server";

export { requireSettlementAuth } from "./auth/server";
export type { SettlementPrincipal } from "./auth/core";

export async function requireSettlementApiAuth(
  request: Request,
  minimumRole: SettlementRole = "operator",
): Promise<Response | null> {
  return await requireSettlementAuth(request, minimumRole);
}

/**
 * Same gate as requireSettlementApiAuth, but hands back the verified
 * principal so RPC calls can record the acting subject in the intake audit
 * trail.
 */
export async function requireSettlementApiPrincipal(
  request: Request,
  minimumRole: SettlementRole = "operator",
): Promise<
  | { ok: true; principal: SettlementPrincipal }
  | { ok: false; response: Response }
> {
  const result = await authorizeSettlementRequest(
    request,
    minimumRole,
    verifyAuth0AccessToken,
  );
  if (result.ok) return { ok: true, principal: result.principal };
  return {
    ok: false,
    response: Response.json(
      { error: result.status === 401 ? "Unauthorized" : "Forbidden" },
      { status: result.status },
    ),
  };
}
