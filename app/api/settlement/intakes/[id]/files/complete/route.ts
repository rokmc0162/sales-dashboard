import { requireSettlementApiPrincipal } from "@/features/settlement/lib/api-auth";
import { readBoundedJson } from "@/lib/auth-route.server";
import { INTAKE_ERROR } from "@/features/settlement/lib/intake/contract";
import {
  createIntakeAdminClient,
  currentDraftRevision,
  fetchIntakeObject,
  intakeJson,
  mapIntakeDbError,
  readBackIntakeObject,
} from "@/features/settlement/lib/intake/server";

export const runtime = "nodejs";

/**
 * Finalizes one uploaded source object and places it in the month draft.
 *
 * The server itself reads the uploaded bytes back from private Storage and
 * verifies byte size and SHA-256 against the registered expectations before
 * the object may transition to finalized; any mismatch quarantines the
 * object with a deterministic 422. Draft placement uses the optimistic
 * expected_draft_revision — a stale revision is a deterministic 409 carrying
 * the current revision.
 *
 * Placement is a single RPC either way: if a current draft entry holds this
 * object's canonical path, replace_settlement_intake_draft_entry atomically
 * swaps that entry to the verified new object (the old object row is never
 * touched — it may be frozen into submitted versions); otherwise
 * upsert_settlement_intake_draft_entry inserts at the lowest free position.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireSettlementApiPrincipal(request);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await readBoundedJson(request, 4_096);
  } catch {
    return intakeJson({ error: INTAKE_ERROR.invalidBody }, { status: 400 });
  }
  const payload = (body ?? {}) as {
    object_id?: unknown;
    expected_draft_revision?: unknown;
  };
  const objectId = payload.object_id;
  const expectedRevision = payload.expected_draft_revision;
  if (typeof objectId !== "string" || objectId.length === 0) {
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
  const object = await fetchIntakeObject(supabase, objectId);
  if (!object || object.intake_id !== intakeId) {
    return intakeJson({ error: INTAKE_ERROR.unknownObject }, { status: 404 });
  }
  if (object.status === "quarantined") {
    return intakeJson({ error: INTAKE_ERROR.invalidObjectState }, { status: 409 });
  }

  if (object.status === "uploading") {
    const readBack = await readBackIntakeObject(
      supabase,
      object.storage_path,
      object.expected_size_bytes,
    );
    if (!readBack.ok) {
      if (readBack.error === INTAKE_ERROR.objectMissing) {
        return intakeJson({ error: INTAKE_ERROR.objectMissing }, { status: 409 });
      }
      await supabase
        .rpc("quarantine_settlement_intake_object", {
          p_object_id: object.id,
          p_reason: "storage read-back size mismatch",
          p_actor: auth.principal.subject,
        })
        .then(() => undefined, () => undefined);
      return intakeJson({ error: INTAKE_ERROR.sizeMismatch }, { status: 422 });
    }
    if (readBack.sha256 !== object.expected_sha256) {
      await supabase
        .rpc("quarantine_settlement_intake_object", {
          p_object_id: object.id,
          p_reason: "storage read-back sha256 mismatch",
          p_actor: auth.principal.subject,
        })
        .then(() => undefined, () => undefined);
      return intakeJson({ error: INTAKE_ERROR.hashMismatch }, { status: 422 });
    }

    const { error: finalizeError } = await supabase.rpc(
      "finalize_settlement_intake_object",
      {
        p_object_id: object.id,
        p_observed_size_bytes: readBack.sizeBytes,
        p_observed_sha256: readBack.sha256,
        p_actor: auth.principal.subject,
      },
    );
    if (finalizeError) {
      const mapped = mapIntakeDbError(finalizeError);
      return intakeJson(mapped.body, { status: mapped.status });
    }
  }

  // Draft placement. Replaying a complete for an object that is already in
  // the draft is a no-op returning the current revision.
  const { data: existingEntries, error: entriesError } = await supabase
    .from("settlement_intake_draft_entries")
    .select("id")
    .eq("intake_id", intakeId)
    .eq("object_id", object.id)
    .limit(1);
  if (entriesError) {
    return intakeJson({ error: INTAKE_ERROR.rpcFailed }, { status: 500 });
  }
  if ((existingEntries ?? []).length > 0) {
    const revision = await currentDraftRevision(supabase, intakeId);
    return intakeJson({ draft_revision: revision, object_id: object.id });
  }

  // If a current draft entry holds this canonical path, this complete is a
  // replacement: one atomic RPC swaps the entry to the verified new object.
  // Otherwise the RPC inserts at the lowest free position. Positions and
  // draft path uniqueness are owned by the RPCs under the intake lock.
  const placement =
    object.replacement_for_object_id
      ? await supabase.rpc("replace_settlement_intake_draft_entry", {
          p_intake_id: intakeId,
          p_old_object_id: object.replacement_for_object_id,
          p_new_object_id: object.id,
          p_expected_draft_revision: expectedRevision,
          p_actor: auth.principal.subject,
        })
      : await supabase.rpc("upsert_settlement_intake_draft_entry", {
          p_intake_id: intakeId,
          p_object_id: object.id,
          p_expected_draft_revision: expectedRevision,
          p_actor: auth.principal.subject,
        });
  if (placement.error || typeof placement.data !== "number") {
    const mapped = mapIntakeDbError(
      placement.error ?? { message: "empty placement result" },
    );
    if (mapped.body.error === INTAKE_ERROR.staleDraftRevision) {
      const current = await currentDraftRevision(supabase, intakeId);
      return intakeJson(
        { ...mapped.body, draft_revision: current },
        { status: mapped.status },
      );
    }
    return intakeJson(mapped.body, { status: mapped.status });
  }

  return intakeJson({
    draft_revision: placement.data,
    object_id: object.id,
  });
}
