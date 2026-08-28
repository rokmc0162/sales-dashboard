import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE, verifySession } from "@/lib/session";

const CANONICAL_HOST = "rvjp-dashboard.vercel.app";
const LEGACY_HOSTS = new Set(["rvjp-nextjs.vercel.app"]);

export default async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const host = req.headers.get("host")?.split(":")[0];

  if (host && LEGACY_HOSTS.has(host)) {
    const canonicalUrl = req.nextUrl.clone();
    canonicalUrl.protocol = "https";
    canonicalUrl.hostname = CANONICAL_HOST;
    canonicalUrl.port = "";
    return NextResponse.redirect(canonicalUrl, 308);
  }

  // The signature is verified here, not merely the cookie's presence: anyone
  // can set a cookie, so presence alone gated nothing. Runs on Edge, which is
  // why session.ts is built on Web Crypto and shared with the Node routes —
  // one implementation, so middleware and the API can never disagree.
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  const authenticated = session !== null;

  if (pathname === "/") {
    return NextResponse.redirect(
      new URL(authenticated ? "/dashboard" : "/login", req.url),
    );
  }

  if (pathname === "/login" && authenticated) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  if (pathname === "/login" || pathname.startsWith("/health")) {
    return NextResponse.next();
  }

  if (!authenticated) {
    // Carry the destination so login can send the user back where they aimed.
    const loginUrl = new URL("/login", req.url);
    const target = `${pathname}${req.nextUrl.search}`;
    if (target !== "/" && target.length <= 512) loginUrl.searchParams.set("next", target);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon\\.ico|health|icons/|.*\\.png$|.*\\.jpg$|.*\\.jpeg$|.*\\.svg$|.*\\.ico$).*)"],
};
