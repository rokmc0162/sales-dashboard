import { NextRequest, NextResponse } from "next/server";

import { tempLoginEnabled } from "@/lib/session";
import { apiError } from "@/lib/api-utils";

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN!;
const AUTH0_M2M_CLIENT_ID = process.env.AUTH0_M2M_CLIENT_ID!;
const AUTH0_M2M_CLIENT_SECRET = process.env.AUTH0_M2M_CLIENT_SECRET!;
const TEMP_ACCESS_TOKEN = "rvjp-temporary-mock-access-token";

// GET: 사용자 정보 조회
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return apiError("Unauthorized", 401);
  }

  const token = authHeader.replace("Bearer ", "");
  // 임시 우회 프로필. ALLOW_TEMP_LOGIN=1 일 때만 응답한다.
  if (tempLoginEnabled() && token === TEMP_ACCESS_TOKEN) {
    return NextResponse.json({
      email: "temporary@riverse.local",
      name: "RIVERSE 임시 접속",
      picture: undefined,
    });
  }

  const res = await fetch(`https://${AUTH0_DOMAIN}/userinfo`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    return apiError("Invalid token", 401);
  }

  return NextResponse.json(await res.json());
}

// PATCH: 프로필 수정 (M2M 토큰 필요)
export async function PATCH(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return apiError("Unauthorized", 401);
  }

  // /userinfo로 사용자 ID 추출 (JWT/opaque 모두 지원)
  const token = authHeader.replace("Bearer ", "");
  const userinfoRes = await fetch(`https://${AUTH0_DOMAIN}/userinfo`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!userinfoRes.ok) {
    return apiError("Invalid token", 401);
  }
  const { sub: userId } = (await userinfoRes.json()) as { sub: string };

  // M2M 토큰 발급
  const tokenRes = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: AUTH0_M2M_CLIENT_ID,
      client_secret: AUTH0_M2M_CLIENT_SECRET,
      audience: `https://${AUTH0_DOMAIN}/api/v2/`,
    }),
  });
  if (!tokenRes.ok) {
    return apiError("Management token failed");
  }
  const { access_token: mgmtToken } = await tokenRes.json();

  // Management API로 프로필 수정
  const body = (await request.json()) as { name?: string; picture?: string };
  const updateRes = await fetch(
    `https://${AUTH0_DOMAIN}/api/v2/users/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${mgmtToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!updateRes.ok) {
    return NextResponse.json(
      { error: "Profile update failed" },
      { status: updateRes.status },
    );
  }

  return NextResponse.json(await updateRes.json());
}
