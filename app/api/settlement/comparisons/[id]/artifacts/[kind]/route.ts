/**
 * GET /api/settlement/comparisons/[id]/artifacts/[kind]
 *   Authenticated short signed-url redirect for private comparison artifacts.
 *   kind = answer | candidate. Storage paths never leave the server.
 */
import { NextResponse } from "next/server";

import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { getComparisonArtifactPaths } from "@/features/settlement/lib/comparison/store";
import { apiError, apiUnexpected } from "@/lib/api-utils";

export const runtime = "nodejs";
export const maxDuration = 30;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ["answer", "candidate"] as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; kind: string }> },
) {
  const unauthorized = await requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const { id, kind } = await params;
  if (!UUID_PATTERN.test(id)) {
    return apiError("invalid run id", 400);
  }
  if (!KINDS.includes(kind as (typeof KINDS)[number])) {
    return apiError("kind must be answer or candidate", 400);
  }

  const { supabaseServer: supabase } = await import("@/lib/supabase-server");
  const { getSignedArchiveUrl } = await import("@/features/settlement/lib/storage/archive");
  let run;
  try {
    run = await getComparisonArtifactPaths(id);
  } catch (e) {
    return apiUnexpected(e);
  }
  if (!run) {
    return apiError("comparison run not found", 404);
  }

  const path = kind === "answer" ? run.answer_storage_path : run.candidate_storage_path;
  if (!path) {
    return apiError("artifact not available", 404);
  }
  const signedUrl = await getSignedArchiveUrl(path, 300, supabase);
  if (!signedUrl) {
    return apiError("artifact not available", 404);
  }
  return NextResponse.redirect(signedUrl, { status: 302 });
}
