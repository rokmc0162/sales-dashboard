import { NextResponse } from "next/server";

import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import {
  createPostgresSettlementJobApiStore,
  getSettlementJob,
} from "@/features/settlement/lib/worker/job-contract";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const unauthorized = await requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const store = createPostgresSettlementJobApiStore();
  const result = await getSettlementJob(store, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.value, {
    headers: { "cache-control": "no-store" },
  });
}
