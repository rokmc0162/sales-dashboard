import { requireSettlementApiPrincipal } from "@/features/settlement/lib/api-auth";
import { readBoundedJson } from "@/lib/auth-route.server";
import {
  INTAKE_ERROR,
  MAX_INTAKE_FILES,
} from "@/features/settlement/lib/intake/contract";
import {
  createIntakeAdminClient,
  currentDraftRevision,
  intakeJson,
  mapIntakeDbError,
} from "@/features/settlement/lib/intake/server";

export const runtime = "nodejs";

/**
 * Reorders the whole draft in one optimistic step: the client sends the
 * complete permutation of draft object IDs plus the expected revision; the
 * RPC verifies both and assigns dense positions 0..n-1.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireSettlementApiPrincipal(request);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await readBoundedJson(request, 32_768);
  } catch {
    return intakeJson({ error: INTAKE_ERROR.invalidBody }, { status: 400 });
  }
  const payload = (body ?? {}) as {
    object_ids?: unknown;
    expected_draft_revision?: unknown;
  };
  const objectIds = payload.object_ids;
  const expectedRevision = payload.expected_draft_revision;
  if (
    !Array.isArray(objectIds) ||
    objectIds.length < 1 ||
    objectIds.length > MAX_INTAKE_FILES ||
    objectIds.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    return intakeJson({ error: INTAKE_ERROR.invalidBody }, { status: 400 });
  }
  if (
    typeof expectedRevision !== "number" ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    return intakeJson({ error: INTAKE_ERROR.invalidBody }, { status: 400 });
  }

  const { id: intakeId } = await params;
  const supabase = createIntakeAdminClient();
  const { data: revision, error } = await supabase.rpc(
    "reorder_settlement_intake_draft",
    {
      p_intake_id: intakeId,
      p_object_ids: objectIds as string[],
      p_expected_draft_revision: expectedRevision,
      p_actor: auth.principal.subject,
    },
  );
  if (error || typeof revision !== "number") {
    const mapped = mapIntakeDbError(error ?? { message: "empty reorder result" });
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
