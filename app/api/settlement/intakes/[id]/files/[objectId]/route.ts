import { requireSettlementApiPrincipal } from "@/features/settlement/lib/api-auth";
import { readBoundedJson } from "@/lib/auth-route.server";
import { INTAKE_ERROR } from "@/features/settlement/lib/intake/contract";
import {
  createIntakeAdminClient,
  currentDraftRevision,
  intakeJson,
  mapIntakeDbError,
} from "@/features/settlement/lib/intake/server";

export const runtime = "nodejs";

/**
 * Removes one file from the month draft. Only the draft reference goes away:
 * the immutable source object and any submitted version snapshots that
 * reference it stay untouched (orphaned uploads are reclaimed by prepare on
 * re-upload, or by the separate bounded orphan GC).
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; objectId: string }> },
) {
  const auth = await requireSettlementApiPrincipal(request);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await readBoundedJson(request, 4_096);
  } catch {
    return intakeJson({ error: INTAKE_ERROR.invalidBody }, { status: 400 });
  }
  const expectedRevision = (body as { expected_draft_revision?: unknown } | null)
    ?.expected_draft_revision;
  if (
    typeof expectedRevision !== "number" ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    return intakeJson({ error: INTAKE_ERROR.invalidBody }, { status: 400 });
  }

  const { id: intakeId, objectId } = await params;
  const supabase = createIntakeAdminClient();
  const { data: revision, error } = await supabase.rpc(
    "remove_settlement_intake_draft_entry",
    {
      p_intake_id: intakeId,
      p_object_id: objectId,
      p_expected_draft_revision: expectedRevision,
      p_actor: auth.principal.subject,
    },
  );
  if (error || typeof revision !== "number") {
    const mapped = mapIntakeDbError(error ?? { message: "empty remove result" });
    if (mapped.body.error === INTAKE_ERROR.staleDraftRevision) {
      const current = await currentDraftRevision(supabase, intakeId);
      return intakeJson(
        { ...mapped.body, draft_revision: current },
        { status: mapped.status },
      );
    }
    return intakeJson(mapped.body, { status: mapped.status });
  }

  return intakeJson({ draft_revision: revision });
}
