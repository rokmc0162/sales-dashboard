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
 * Freezes the current draft into an immutable submitted version, then
 * enqueues it for worker processing. Both RPCs are replay-safe: submitting
 * an unchanged draft (same manifest digest) returns the already-created
 * version, and enqueue_settlement_version_job returns the existing job id
 * for an already-enqueued version — so retried requests converge on the
 * same version and job_id.
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
  const expectedRevision = (body as { expected_draft_revision?: unknown } | null)
    ?.expected_draft_revision;
  if (
    typeof expectedRevision !== "number" ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    return intakeJson({ error: INTAKE_ERROR.invalidBody }, { status: 400 });
  }

  const { id: intakeId } = await params;
  const supabase = createIntakeAdminClient();
  const { data: version, error } = await supabase.rpc(
    "submit_settlement_intake_version",
    {
      p_intake_id: intakeId,
      p_expected_draft_revision: expectedRevision,
      p_actor: auth.principal.subject,
    },
  );
  if (error || !version) {
    const mapped = mapIntakeDbError(error ?? { message: "empty submit result" });
    if (mapped.body.error === INTAKE_ERROR.staleDraftRevision) {
      const current = await currentDraftRevision(supabase, intakeId);
      return intakeJson(
        { ...mapped.body, draft_revision: current },
        { status: mapped.status },
      );
    }
    return intakeJson(mapped.body, { status: mapped.status });
  }

  const { data: jobId, error: enqueueError } = await supabase.rpc(
    "enqueue_settlement_version_job",
    {
      p_source_version_id: version.id,
      p_actor: auth.principal.subject,
      p_parser_version: null,
      p_rule_version: null,
    },
  );
  if (enqueueError || typeof jobId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    // Privacy-safe: no DB details leak; the version is already frozen, so the
    // client can retry submit and both RPCs converge on the same result.
    return intakeJson({ error: INTAKE_ERROR.rpcFailed }, { status: 500 });
  }

  // The immutable version is already durably queued. Response assembly may
  // fail independently, but a client retry converges on the same version/job.
  const { data: files, error: filesError } = await supabase
    .from("settlement_intake_version_files")
    .select("*")
    .eq("version_id", version.id)
    .order("position", { ascending: true });
  if (filesError) {
    return intakeJson({ error: INTAKE_ERROR.rpcFailed }, { status: 500 });
  }

  return intakeJson({
    job_id: jobId,
    version: {
      id: version.id,
      version_no: version.version_no,
      file_count: version.file_count,
      total_size_bytes: version.total_size_bytes,
      manifest_sha256: version.manifest_sha256,
      submitted_by: version.submitted_by,
      created_at: version.created_at,
      files: (files ?? []).map((file) => ({
        id: file.id,
        object_id: file.object_id,
        position: file.position,
        path_key: file.path_key,
        display_path: file.display_name,
        size_bytes: file.size_bytes,
        sha256: file.sha256,
      })),
    },
  });
}
