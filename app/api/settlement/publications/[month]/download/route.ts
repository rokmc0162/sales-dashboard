import { NextResponse } from "next/server";

import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { loadCurrentPublishedArtifact } from "@/features/settlement/lib/publication/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request, { params }: { params: Promise<{ month: string }> }) {
  const unauthorized = await requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;
  const { month } = await params;
  if (!/^\d{6}$/.test(month)) return NextResponse.json({ error: "invalid_month" }, { status: 400 });
  try {
    const artifact = await loadCurrentPublishedArtifact(month);
    if (!artifact) return NextResponse.json({ error: "publication_not_found" }, { status: 404 });
    return new NextResponse(artifact.bytes as unknown as BodyInit, {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${artifact.filename}"; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
        "content-length": String(artifact.bytes.byteLength),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "publication_download_unavailable" }, { status: 503 });
  }
}
