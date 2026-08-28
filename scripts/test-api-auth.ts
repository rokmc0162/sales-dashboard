/**
 * Assertions for the shared API auth gate.
 * Run: node --import tsx scripts/test-api-auth.ts
 *
 * Hermetic: no network, no Supabase, secrets set locally.
 */
import assert from "node:assert/strict";

import { readCookie, requireApiAuth } from "../src/lib/api-auth";
import { SESSION_COOKIE, signSession } from "../src/lib/session";

process.env.SESSION_SECRET = "unit-test-secret-cccccccccccccccccccccccc";
delete process.env.SESSION_SECRET_PREVIOUS;
delete process.env.ALLOW_TEMP_LOGIN;
process.env.NODE_ENV = "test";

const HOST = "rvjp-dashboard.vercel.app";

function request(
  options: {
    method?: string;
    cookie?: string;
    origin?: string;
    host?: string;
    forwardedHost?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin) headers.set("origin", options.origin);
  headers.set("host", options.host ?? HOST);
  if (options.forwardedHost) headers.set("x-forwarded-host", options.forwardedHost);
  return new Request(`https://${options.host ?? HOST}/api/whatever`, {
    method: options.method ?? "GET",
    headers,
  });
}

async function cookieFor(roles: string[]): Promise<string> {
  const token = await signSession({ sub: "auth0|tester", email: "t@riverse.local", roles });
  return `${SESSION_COOKIE}=${token}`;
}

async function status(result: Awaited<ReturnType<typeof requireApiAuth>>): Promise<number | null> {
  return result ? result.status : null;
}

async function readCookieCases() {
  assert.equal(readCookie(null, "A"), null);
  assert.equal(readCookie("", "A"), null);
  assert.equal(readCookie("A=1", "A"), "1");
  assert.equal(readCookie("B=2; A=1", "A"), "1");
  assert.equal(readCookie("A=", "A"), null, "an empty value is not a credential");
  assert.equal(readCookie("AB=1", "A"), null, "must not match a longer cookie name");
  assert.equal(readCookie("A=a%20b", "A"), "a b", "values are url-decoded");
}

async function unauthenticated() {
  assert.equal(await status(await requireApiAuth(request())), 401, "no cookie must be rejected");
  assert.equal(
    await status(await requireApiAuth(request({ cookie: `${SESSION_COOKIE}=garbage` }))),
    401,
    "an unparseable session must be rejected",
  );

  // a forged cookie carrying the right shape but no valid signature
  const forged = Buffer.from(JSON.stringify({ sub: "x", roles: ["ADMIN"] })).toString("base64url");
  assert.equal(
    await status(await requireApiAuth(request({ cookie: `${SESSION_COOKIE}=a.${forged}.b` }))),
    401,
    "a forged session must be rejected",
  );
}

async function roles() {
  const staff = await cookieFor(["STAFF"]);
  const admin = await cookieFor(["ADMIN"]);

  assert.equal(await status(await requireApiAuth(request({ cookie: staff }))), null, "any session passes a plain check");
  assert.equal(
    await status(await requireApiAuth(request({ cookie: staff }), { role: "ADMIN" })),
    403,
    "a non-admin session must be forbidden from an admin route",
  );
  assert.equal(
    await status(await requireApiAuth(request({ cookie: admin }), { role: "ADMIN" })),
    null,
    "an admin session passes an admin route",
  );
}

async function origins() {
  const admin = await cookieFor(["ADMIN"]);
  const opts = { role: "ADMIN", mutating: true } as const;

  assert.equal(
    await status(await requireApiAuth(request({ method: "POST", cookie: admin }), opts)),
    403,
    "a write with no Origin must be refused",
  );
  assert.equal(
    await status(
      await requireApiAuth(
        request({ method: "POST", cookie: admin, origin: "https://evil.example" }),
        opts,
      ),
    ),
    403,
    "a cross-origin write must be refused",
  );
  assert.equal(
    await status(
      await requireApiAuth(request({ method: "POST", cookie: admin, origin: "not a url" }), opts),
    ),
    403,
    "an unparseable Origin must be refused",
  );
  assert.equal(
    await status(
      await requireApiAuth(
        request({ method: "POST", cookie: admin, origin: `https://${HOST}` }),
        opts,
      ),
    ),
    null,
    "a same-origin admin write passes",
  );

  // Vercel forwards the original host; the proxy's own Host must not win
  assert.equal(
    await status(
      await requireApiAuth(
        request({
          method: "POST",
          cookie: admin,
          origin: "https://rvjp-dashboard.vercel.app",
          host: "internal-proxy.local",
          forwardedHost: "rvjp-dashboard.vercel.app",
        }),
        opts,
      ),
    ),
    null,
    "x-forwarded-host is what the Origin is compared against",
  );

  // the Origin check runs before the session check, but an authenticated
  // same-origin request still needs a session
  assert.equal(
    await status(
      await requireApiAuth(request({ method: "POST", origin: `https://${HOST}` }), opts),
    ),
    401,
    "same-origin alone is not authentication",
  );
}

async function main() {
  await readCookieCases();
  await unauthenticated();
  await roles();
  await origins();
  console.log("api auth: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
