/**
 * GET /api/settlement/comparisons/[id]/workbook-review
 * Rebuilds a bounded workbook-centered review from immutable private artifacts.
 */
import { NextResponse } from "next/server";

import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { compareInputWorkbooks } from "@/features/settlement/lib/comparison/compare";
import { buildWorkbookReview } from "@/features/settlement/lib/comparison/workbook-review";
import { readInputSheet } from "@/features/settlement/lib/comparison/workbook";
import {
  getComparisonArtifactPaths,
  getComparisonRun,
  listAllComparisonDiffs,
  WORKBOOK_REVIEW_DIFF_LIMIT,
} from "@/features/settlement/lib/comparison/store";
import { downloadArchiveBuffer } from "@/features/settlement/lib/storage/archive";
import type { Json } from "@/features/settlement/lib/supabase/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function summarySheetName(summary: Json | null, key: "candidate_sheet" | "golden_sheet"): string | undefined {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return undefined;
  const value = summary[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const unauthorized = requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: "invalid run id" }, { status: 400 });
  }

  try {
    const [run, artifacts, persistedDiffs] = await Promise.all([
      getComparisonRun(id),
      getComparisonArtifactPaths(id),
      listAllComparisonDiffs(id),
    ]);
    if (!run || !artifacts) {
      return NextResponse.json({ error: "comparison run not found" }, { status: 404 });
    }
    if (!artifacts.answer_storage_path || !artifacts.candidate_storage_path) {
      return NextResponse.json({ error: "comparison artifacts not available" }, { status: 404 });
    }

    const [goldenBuffer, candidateBuffer] = await Promise.all([
      downloadArchiveBuffer(artifacts.answer_storage_path),
      downloadArchiveBuffer(artifacts.candidate_storage_path),
    ]);
    const candidateSheetName = summarySheetName(run.summary, "candidate_sheet");
    const goldenSheetName = summarySheetName(run.summary, "golden_sheet");
    const comparison = await compareInputWorkbooks({
      candidate: candidateBuffer,
      golden: goldenBuffer,
      candidateSheetName,
      goldenSheetName,
      maxDiffs: WORKBOOK_REVIEW_DIFF_LIMIT,
    });
    const golden = await readInputSheet(
      goldenBuffer,
      goldenSheetName,
      goldenSheetName !== undefined,
    );
    const review = buildWorkbookReview(golden, comparison.diffs, persistedDiffs);
    return NextResponse.json({ review });
  } catch (error) {
    console.error(
      "[settlement workbook review] build failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json({ error: "failed to build workbook review" }, { status: 500 });
  }
}
