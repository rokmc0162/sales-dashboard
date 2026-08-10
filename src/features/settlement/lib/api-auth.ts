import type { SettlementRole } from "./auth/core";
import { requireSettlementAuth } from "./auth/server";

export { requireSettlementAuth } from "./auth/server";

export async function requireSettlementApiAuth(
  request: Request,
  minimumRole: SettlementRole = "operator",
): Promise<Response | null> {
  return await requireSettlementAuth(request, minimumRole);
}
