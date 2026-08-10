import "server-only";

import {
  ACCESS_TOKEN_COOKIE,
  type AccessTokenVerifier,
  isSameOriginMutation,
  ROLES_CLAIM,
  uniqueCookieValue,
  verifySettlementAccessToken,
} from "./auth-core";
import { verifyAuth0AccessToken } from "./auth-verifier.server";

type GlobalAdminDependencies = {
  verifier?: AccessTokenVerifier;
  now?: () => number;
};

export async function requireGlobalAdminAuth(
  request: Request,
  dependencies: GlobalAdminDependencies = {},
): Promise<Response | null> {
  if (!isSameOriginMutation(request)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const token = uniqueCookieValue(
    request.headers.get("cookie"),
    ACCESS_TOKEN_COOKIE,
  );
  if (!token) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const verified = await verifySettlementAccessToken(
    token,
    dependencies.verifier ?? verifyAuth0AccessToken,
    dependencies.now,
  );
  if (!verified.ok) {
    return Response.json(
      { error: verified.status === 401 ? "Unauthorized" : "Forbidden" },
      { status: verified.status },
    );
  }

  const providerRoles = verified.payload[ROLES_CLAIM];
  if (!Array.isArray(providerRoles) || !providerRoles.includes("ADMIN")) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}