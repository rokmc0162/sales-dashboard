import { NextResponse } from "next/server";

import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { readBoundedJsonBody } from "@/features/settlement/lib/api-body";
import {
  createPostgresSettlementJobApiStore,
  createSettlementJob,
  getLatestSettlementJob,
} from "@/features/settlement/lib/worker/job-contract";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const unauthorized = await requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const month = new URL(request.url).searchParams.get("month") ?? "";
  const store = createPostgresSettlementJobApiStore();
  const result = await getLatestSettlementJob(store, month);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.value, {
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  const unauthorized = await requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const body = await readBoundedJsonBody(request);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });

  const store = createPostgresSettlementJobApiStore();
  const result = await createSettlementJob(store, body.body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ job_id: result.job_id }, { status: 201 });
}
