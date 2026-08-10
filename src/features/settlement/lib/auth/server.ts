import "server-only";

import { ACCESS_TOKEN_COOKIE } from "@/lib/auth-session.server";
import {
  createAuth0AccessTokenVerifier,
  readAuth0VerifierConfig,
  verifyAuth0AccessToken,
} from "@/lib/auth-verifier.server";

import {
  authorizeSettlementRequest,
  type SettlementAccessTokenVerifier,
  type SettlementRole,
} from "./core";

export { ACCESS_TOKEN_COOKIE };
export {
  createAuth0AccessTokenVerifier,
  readAuth0VerifierConfig,
  verifyAuth0AccessToken,
};

type GuardDependencies = {
  verifier?: SettlementAccessTokenVerifier;
  now?: () => number;
};

export async function requireSettlementAuth(
  request: Request,
  minimumRole: SettlementRole = "operator",
  dependencies: GuardDependencies = {},
): Promise<Response | null> {
  const result = await authorizeSettlementRequest(
    request,
    minimumRole,
    dependencies.verifier ?? verifyAuth0AccessToken,
    dependencies.now,
  );
  if (result.ok) return null;
  return Response.json(
    { error: result.status === 401 ? "Unauthorized" : "Forbidden" },
    { status: result.status },
  );
}
