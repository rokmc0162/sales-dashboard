import { NextResponse } from "next/server";

import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { workbookBufferToPreview } from "@/features/settlement/lib/export/workbook-preview";
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
    const preview = await workbookBufferToPreview(artifact.bytes, {
      month,
      source: "published_verified_artifact",
      rowsWritten: artifact.status.rowCount ?? 0,
      electronicRows: 0,
      publicationRows: 0,
      generatedAt: artifact.status.publishedAt ?? new Date(0).toISOString(),
    });
    return NextResponse.json(preview, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "publication_preview_unavailable" }, { status: 503 });
  }
}
