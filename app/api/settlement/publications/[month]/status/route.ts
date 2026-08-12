import { NextResponse } from "next/server";

import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { loadPublishedSettlementStatus } from "@/features/settlement/lib/publication/server";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ month: string }> }) {
  const unauthorized = await requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;
  const { month } = await params;
  if (!/^\d{6}$/.test(month)) return NextResponse.json({ error: "invalid_month" }, { status: 400 });
  try {
    return NextResponse.json(await loadPublishedSettlementStatus(month), {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "publication_status_unavailable" }, { status: 503 });
  }
}
