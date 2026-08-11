import { requireSettlementApiPrincipal } from "@/features/settlement/lib/api-auth";
import { readBoundedJson } from "@/lib/auth-route.server";
import {
  INTAKE_BUCKET,
  INTAKE_ERROR,
  MAX_INTAKE_FILE_BYTES,
  canonicalizeIntakePath,
  isValidSha256,
} from "@/features/settlement/lib/intake/contract";
import {
  createIntakeAdminClient,
  fetchDraftObjectByPathKey,
  fetchIntakeById,
  intakeJson,
  mapIntakeDbError,
} from "@/features/settlement/lib/intake/server";

export const runtime = "nodejs";

function boundedContentType(value: unknown): string {
  if (typeof value !== "string") return "application/octet-stream";
  let cleaned = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) cleaned += ch;
  }
  cleaned = cleaned.trim().slice(0, 100);
  return cleaned || "application/octet-stream";
}

/**
 * Registers an immutable source object for one draft file and hands the
 * browser a short-lived signed-upload capability for the private intake
 * bucket. Nothing here trusts the client-declared size/hash: they are only
 * recorded as expectations that the complete route verifies by reading the
 * uploaded bytes back server-side.
 *
 * Duplicate handling is deterministic: a canonical path already held by a
 * current draft entry yields 409 duplicate_path unless the caller asked to
 * replace it. Replacement is prepare-passive: it requires the optimistic
 * expected_draft_revision and only stages/registers the new object — the old
 * draft object is never quarantined or removed here. The atomic swap happens
 * in complete (replace_settlement_intake_draft_entry) once the new bytes are
 * verified, so a failed upload leaves the old draft fully intact.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireSettlementApiPrincipal(request);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await readBoundedJson(request, 8_192);
  } catch {
    return intakeJson({ error: INTAKE_ERROR.invalidBody }, { status: 400 });
  }
  const payload = (body ?? {}) as {
    relative_path?: unknown;
    content_type?: unknown;
    size_bytes?: unknown;
    sha256?: unknown;
    replace?: unknown;
    expected_draft_revision?: unknown;
  };

  const path = canonicalizeIntakePath(payload.relative_path);
  if (!path.ok) {
    return intakeJson({ error: path.error, reason: path.reason }, { status: 400 });
  }
  const sizeBytes = payload.size_bytes;
  if (
    typeof sizeBytes !== "number" ||
    !Number.isInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > MAX_INTAKE_FILE_BYTES
  ) {
    return intakeJson({ error: INTAKE_ERROR.invalidSize }, { status: 400 });
  }
  if (!isValidSha256(payload.sha256)) {
    return intakeJson({ error: INTAKE_ERROR.invalidSha256 }, { status: 400 });
  }
  const sha256 = (payload.sha256 as string).toLowerCase();
  const replace = payload.replace === true;
  const rawRevision = payload.expected_draft_revision;
  if (typeof rawRevision !== "number" || !Number.isInteger(rawRevision) || rawRevision < 0) {
    return intakeJson({ error: INTAKE_ERROR.invalidBody }, { status: 400 });
  }
  const expectedRevision = rawRevision;

  const { id: intakeId } = await params;
  const supabase = createIntakeAdminClient();
  const intake = await fetchIntakeById(supabase, intakeId);
  if (!intake) {
    return intakeJson({ error: INTAKE_ERROR.unknownIntake }, { status: 404 });
  }
  if (replace && intake.draft_revision !== expectedRevision) {
    return intakeJson(
      {
        error: INTAKE_ERROR.staleDraftRevision,
        draft_revision: intake.draft_revision,
      },
      { status: 409 },
    );
  }

  // Duplicate detection against *current draft entries* only. Historical
  // finalized objects (frozen into submitted versions) and orphaned uploads
  // never block a path — the RPCs re-enforce this under the intake lock.
  const existing = await fetchDraftObjectByPathKey(supabase, intakeId, path.pathKey);
  if (existing && !replace) {
    // Also covers case collisions: a different display path with the same
    // canonical (lowercase NFC) key deterministically lands here.
    return intakeJson(
      {
        error: INTAKE_ERROR.duplicatePath,
        path_key: path.pathKey,
        existing_object_id: existing.id,
        existing_display_path: existing.display_name,
      },
      { status: 409 },
    );
  }

  const { data: object, error: registerError } = await supabase.rpc(
    "register_settlement_intake_object",
    {
      p_intake_id: intakeId,
      p_path_key: path.pathKey,
      p_display_name: path.displayPath,
      p_content_type: boundedContentType(payload.content_type),
      p_expected_size_bytes: sizeBytes,
      p_expected_sha256: sha256,
      p_actor: auth.principal.subject,
      p_expected_draft_revision: expectedRevision,
      p_replacement_for_object_id: replace ? (existing?.id ?? null) : null,
    },
  );
  if (registerError || !object) {
    const mapped = mapIntakeDbError(registerError ?? { message: "empty register result" });
    return intakeJson(mapped.body, { status: mapped.status });
  }

  const { data: signed, error: signedError } = await supabase.storage
    .from(INTAKE_BUCKET)
    .createSignedUploadUrl(object.storage_path);
  if (signedError || !signed) {
    await supabase
      .rpc("quarantine_settlement_intake_object", {
        p_object_id: object.id,
        p_reason: "signed upload URL creation failed",
        p_actor: auth.principal.subject,
      })
      .then(() => undefined, () => undefined);
    return intakeJson({ error: INTAKE_ERROR.rpcFailed }, { status: 500 });
  }

  return intakeJson({
    object_id: object.id,
    bucket: INTAKE_BUCKET,
    path: object.storage_path,
    token: signed.token,
    path_key: path.pathKey,
    display_path: path.displayPath,
  });
}
