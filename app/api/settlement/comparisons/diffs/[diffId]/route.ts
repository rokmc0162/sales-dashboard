/**
 * PATCH /api/settlement/comparisons/diffs/[diffId]
 *   Operator review verdict and/or investigation progress for one diff:
 *   body { review_status?, note?, investigation_status?, root_cause_stage?,
 *   root_cause_summary? }.
 *   review_status ∈ pending|candidate_correct|golden_correct|needs_review|resolved.
 *   Setting a review status stamps reviewed_at.
 */
import { NextResponse } from "next/server";

import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { readBoundedJsonBody } from "@/features/settlement/lib/api-body";
import { validateDiffInvestigationPatch } from "@/features/settlement/lib/comparison/investigation";
import { validateDiffReviewPatch } from "@/features/settlement/lib/comparison/review";
import { patchComparisonDiffReview } from "@/features/settlement/lib/comparison/store";

export const runtime = "nodejs";
export const maxDuration = 30;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ diffId: string }> },
) {
  const unauthorized = requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const { diffId } = await params;
  if (!UUID_PATTERN.test(diffId)) {
    return NextResponse.json({ error: "invalid diff id" }, { status: 400 });
  }

  const read = await readBoundedJsonBody(request);
  if (!read.ok) {
    return NextResponse.json({ error: read.error }, { status: read.status });
  }
  const body = read.body;
  const review = validateDiffReviewPatch(body, { allowEmpty: true });
  if (!review.ok) {
    return NextResponse.json({ error: review.error }, { status: 400 });
  }
  const investigation = validateDiffInvestigationPatch(body);
  if (!investigation.ok) {
    return NextResponse.json({ error: investigation.error }, { status: 400 });
  }
  const patch = { ...review.patch, ...investigation.patch };
  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "provide review_status, note, and/or investigation fields" },
      { status: 400 },
    );
  }

  let data;
  try {
    data = await patchComparisonDiffReview(diffId, {
      ...patch,
      reviewed_by: review.patch.review_status !== undefined ? "settlement-dashboard" : undefined,
    });
  } catch {
    // Bounded route context only — the diffId is a validated UUID. The DB
    // error message is never sent to the client.
    console.error(`settlement comparison diff PATCH failed (diff ${diffId})`);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "diff not found" }, { status: 404 });
  }
  return NextResponse.json({ diff: data });
}
