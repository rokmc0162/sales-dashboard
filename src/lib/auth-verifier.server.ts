import "server-only";

import type { JWTVerifyGetKey } from "jose";

import type { AccessTokenVerifier } from "./auth-core";
import {
  discardUpstreamBody,
  fetchAuthUpstream,
  readBoundedUpstreamJson,
} from "./auth-route.server";

export type Auth0VerifierConfig = {
  issuer: string;
  audience: string;
  jwksUrl: URL;
};

type Auth0TokenValidationConfig = Pick<
  Auth0VerifierConfig,
  "issuer" | "audience"
>;

const AUTH0_DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export function readAuth0VerifierConfig(
  env: Record<string, string | undefined> = process.env,
): Auth0VerifierConfig {
  const domain = env.AUTH0_DOMAIN;
  const audience = env.AUTH0_AUDIENCE;
  if (
    !domain ||
    !AUTH0_DOMAIN_PATTERN.test(domain) ||
    !audience ||
    audience.trim() !== audience ||
    audience.length > 2_048
  ) {
    throw new Error("Auth configuration unavailable");
  }

  const issuer = `https://${domain}/`;
  return {
    issuer,
    audience,
    jwksUrl: new URL(".well-known/jwks.json", issuer),
  };
}

export function createAuth0AccessTokenVerifier(
  config: Auth0TokenValidationConfig,
  keySet: JWTVerifyGetKey,
): AccessTokenVerifier {
  return async (token) => {
    const { jwtVerify } = await import("jose");
    const { payload } = await jwtVerify(token, keySet, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
    });
    return payload;
  };
}

let cachedJwks: { url: string; keySet: JWTVerifyGetKey } | undefined;

const boundedJwksFetch: typeof globalThis.fetch = async (input, init) => {
  const response = await fetchAuthUpstream(String(input), init ?? {});
  if (!response.ok) {
    await discardUpstreamBody(response);
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
    });
  }
  const payload = await readBoundedUpstreamJson(response);
  return Response.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
};

export const verifyAuth0AccessToken: AccessTokenVerifier = async (token) => {
  const config = readAuth0VerifierConfig();
  const { createRemoteJWKSet, customFetch } = await import("jose");
  const url = config.jwksUrl.href;
  if (!cachedJwks || cachedJwks.url !== url) {
    cachedJwks = {
      url,
      keySet: createRemoteJWKSet(config.jwksUrl, {
        [customFetch]: boundedJwksFetch,
        timeoutDuration: 5_000,
      }),
    };
  }
  return createAuth0AccessTokenVerifier(config, cachedJwks.keySet)(token);
};
