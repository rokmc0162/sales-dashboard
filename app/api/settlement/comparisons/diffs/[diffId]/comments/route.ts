/**
 * GET  /api/settlement/comparisons/diffs/[diffId]/comments
 *   Comment thread for one diff: the newest 200 comments in chronological
 *   order, plus `truncated` when earlier comments were omitted.
 * POST /api/settlement/comparisons/diffs/[diffId]/comments
 *   Operator asks a question: body { body }. The author is always assigned
 *   server-side (operator) — a client-supplied author_type is ignored — and
 *   the parent diff moves to investigation_status=question_pending in the
 *   same transaction as the insert.
 */
import { NextResponse } from "next/server";

import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { readBoundedJsonBody } from "@/features/settlement/lib/api-body";
import { validateCommentPost } from "@/features/settlement/lib/comparison/investigation";
import { apiError } from "@/lib/api-utils";
import {
  insertComparisonComment,
  listComparisonComments,
} from "@/features/settlement/lib/comparison/store";

export const runtime = "nodejs";
export const maxDuration = 30;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ diffId: string }> },
) {
  const unauthorized = await requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const { diffId } = await params;
  if (!UUID_PATTERN.test(diffId)) {
    return apiError("invalid diff id", 400);
  }

  let listed;
  try {
    listed = await listComparisonComments(diffId);
  } catch {
    console.error(`settlement comparison comments GET failed (diff ${diffId})`);
    return apiError("internal error");
  }
  if (listed === null) {
    return apiError("diff not found", 404);
  }
  return NextResponse.json({ comments: listed.comments, truncated: listed.truncated });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ diffId: string }> },
) {
  const unauthorized = await requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const { diffId } = await params;
  if (!UUID_PATTERN.test(diffId)) {
    return apiError("invalid diff id", 400);
  }

  const read = await readBoundedJsonBody(request);
  if (!read.ok) {
    return apiError(read.error, read.status);
  }
  const validation = validateCommentPost(read.body);
  if (!validation.ok) {
    return apiError(validation.error, 400);
  }

  let comment;
  try {
    comment = await insertComparisonComment(diffId, validation.body, "operator");
  } catch {
    console.error(`settlement comparison comments POST failed (diff ${diffId})`);
    return apiError("internal error");
  }
  if (!comment) {
    return apiError("diff not found", 404);
  }
  return NextResponse.json({ comment }, { status: 201 });
}
