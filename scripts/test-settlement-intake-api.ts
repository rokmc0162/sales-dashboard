// Contract tests for the web intake draft/version API (Task: web intake APIs
// on top of migration 029). Two layers, both deterministic and offline:
//   1. behavioral unit tests of the shared canonical path/limit contract;
//   2. static source-inspection of the route handlers: auth gating, server-only
//      service-role usage, signed-upload issuance, read-back verification,
//      optimistic draft revisions and deterministic error mapping.

import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  INTAKE_BUCKET,
  INTAKE_ERROR,
  MAX_INTAKE_FILES,
  MAX_INTAKE_FILE_BYTES,
  canonicalizeIntakePath,
  intakeFileName,
  isValidIntakeMonthKey,
  isValidSha256,
} from "../src/features/settlement/lib/intake/contract";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const ROUTES = {
  workspace: "app/api/settlement/intakes/route.ts",
  prepare: "app/api/settlement/intakes/[id]/files/prepare/route.ts",
  complete: "app/api/settlement/intakes/[id]/files/complete/route.ts",
  remove: "app/api/settlement/intakes/[id]/files/[objectId]/route.ts",
  reorder: "app/api/settlement/intakes/[id]/reorder/route.ts",
  submit: "app/api/settlement/intakes/[id]/submit/route.ts",
} as const;

const SERVER_HELPER = "src/features/settlement/lib/intake/server.ts";
const CLIENT_HELPER = "src/features/settlement/lib/intake/intake-client.ts";
const CONTRACT = "src/features/settlement/lib/intake/contract.ts";
const LEGACY_UPLOAD_ROUTE = "app/api/settlement/upload/route.ts";

async function main() {
  // ---------------- canonical path contract ----------------
  {
    const simple = canonicalizeIntakePath("Folder/Report.PDF");
    assert.ok(simple.ok);
    assert.equal(simple.displayPath, "Folder/Report.PDF");
    assert.equal(simple.pathKey, "folder/report.pdf");
    assert.equal(intakeFileName(simple.displayPath), "Report.PDF");

    // Separator normalization: Windows-style relative paths and leading '/'.
    const backslash = canonicalizeIntakePath("Folder\\Sub\\file.xlsx");
    assert.ok(backslash.ok);
    assert.equal(backslash.pathKey, "folder/sub/file.xlsx");
    const leading = canonicalizeIntakePath("/Folder/file.csv");
    assert.ok(leading.ok);
    assert.equal(leading.pathKey, "folder/file.csv");

    // Unicode: NFD input (macOS filenames) must canonicalize to NFC.
    const nfd = "가".normalize("NFD");
    assert.notEqual(nfd, "가");
    const unicode = canonicalizeIntakePath(`${nfd}/파일.pdf`);
    assert.ok(unicode.ok);
    assert.equal(unicode.pathKey, "가/파일.pdf".normalize("NFC"));
    assert.equal(unicode.displayPath, "가/파일.pdf".normalize("NFC"));

    // macOS-style case collision: distinct display paths, one canonical key.
    const upper = canonicalizeIntakePath("Data/REPORT.pdf");
    const lower = canonicalizeIntakePath("data/report.pdf");
    assert.ok(upper.ok && lower.ok);
    assert.equal(upper.pathKey, lower.pathKey);
    assert.notEqual(upper.displayPath, lower.displayPath);

    // Deterministic rejections — never silently rewritten.
    for (const bad of [
      "",
      "..",
      "a/../b.pdf",
      "./a.pdf",
      "a//b.pdf",
      "a/",
      `a/${String.fromCharCode(7)}bell.pdf`, // embedded control character
      "x".repeat(301),
      42,
      null,
      undefined,
    ]) {
      const result = canonicalizeIntakePath(bad as never);
      assert.equal(result.ok, false, `path ${String(bad).slice(0, 40)} must be rejected`);
      if (!result.ok) assert.equal(result.error, INTAKE_ERROR.invalidPath);
    }

    assert.ok(isValidIntakeMonthKey("202608"));
    assert.ok(!isValidIntakeMonthKey("202613"));
    assert.ok(!isValidIntakeMonthKey("2026-08"));
    assert.ok(isValidSha256("a".repeat(64)));
    assert.ok(!isValidSha256("z".repeat(64)));
    assert.ok(!isValidSha256("abc"));

    assert.equal(INTAKE_BUCKET, "settlement-intake");
    assert.equal(MAX_INTAKE_FILES, 200);
    assert.equal(MAX_INTAKE_FILE_BYTES, 104_857_600);
  }

  // ---------------- static route contracts ----------------
  const sources = new Map<string, string>();
  for (const rel of [...Object.values(ROUTES), SERVER_HELPER, CLIENT_HELPER, CONTRACT]) {
    sources.set(rel, await readFile(path.join(repoRoot, rel), "utf8"));
  }

  // Legacy upload pipeline must stay operational (route exists) but the new
  // intake surface must never call into it.
  await access(path.join(repoRoot, LEGACY_UPLOAD_ROUTE));
  for (const [file, source] of sources) {
    assert.doesNotMatch(
      source,
      /\/api\/settlement\/upload["'`/]/,
      `${file} must not call the legacy synchronous upload route`,
    );
    assert.doesNotMatch(
      source,
      /enqueueSettlementJob|settlement_jobs|enqueue_settlement_job/,
      `${file} must not enqueue settlement jobs (queue wiring is a later task)`,
    );
    assert.doesNotMatch(
      source,
      /google-?drive|resumable/i,
      `${file} must not depend on Google Drive`,
    );
  }

  // Server-only admin client: the service-role key is resolved inside the
  // shared server helper; routes never touch key env vars themselves and the
  // browser client never sees any service-role name.
  const serverHelper = sources.get(SERVER_HELPER)!;
  assert.match(serverHelper, /^import "server-only";/m, "intake server helper must be server-only");
  assert.match(serverHelper, /createServiceClient/, "intake server helper must use the service-role client");

  // Read-back must stream: short-lived signed download URL, incremental
  // SHA-256 with byte counting, and a hard 100 MiB abort — never a whole-file
  // buffer in memory.
  assert.match(serverHelper, /createSignedUrl\(storagePath/, "read-back must fetch via a short-lived signed download URL");
  assert.match(serverHelper, /createHash\("sha256"\)/, "read-back must compute a real SHA-256");
  assert.match(serverHelper, /response\.body/, "read-back must consume the response body as a stream");
  assert.match(serverHelper, /getReader\(\)/, "read-back must stream chunk by chunk");
  assert.match(serverHelper, /hash\.update\(/, "read-back must hash incrementally");
  assert.match(serverHelper, /controller\.abort\(\)/, "read-back must hard-abort past the byte cap");
  assert.match(serverHelper, /MAX_INTAKE_FILE_BYTES/, "read-back must enforce the hard 100 MiB cap");
  assert.doesNotMatch(serverHelper, /arrayBuffer/, "read-back must never buffer the whole object");
  assert.doesNotMatch(serverHelper, /\.download\(/, "read-back must not use the buffering download API");

  // Workspace version files must paginate until complete, with a loud bound.
  assert.match(serverHelper, /\.range\(offset, offset \+ /, "version files must be fetched with .range pagination");
  assert.match(serverHelper, /MAX_VERSION_FILE_ROWS = 10_000/, "pagination must be bounded at 10k rows");
  assert.match(serverHelper, /version files overflow/i, "pagination overflow must fail loudly");

  assert.match(serverHelper, /stale draft revision/i, "stale revisions must map deterministically");
  assert.match(serverHelper, /status: 409, body: \{ error: INTAKE_ERROR\.staleDraftRevision \}/);
  assert.match(serverHelper, /status: 409, body: \{ error: INTAKE_ERROR\.duplicatePath \}/);
  assert.match(serverHelper, /already in the draft/i, "RPC draft path collisions must map to duplicate_path");
  assert.match(serverHelper, /status: 400, body: \{ error: INTAKE_ERROR\.limitExceeded \}/);

  const clientHelper = sources.get(CLIENT_HELPER)!;
  for (const [file, source] of sources) {
    if (file === SERVER_HELPER) continue;
    assert.doesNotMatch(
      source,
      /SERVICE_ROLE|RVJP_DB_ADMIN_TOKEN/,
      `${file} must not reference service-role credentials`,
    );
  }
  assert.doesNotMatch(clientHelper, /server-only/, "browser intake client must stay browser-safe");
  assert.match(clientHelper, /uploadToSignedUrl/, "browser must use the signed-upload capability");
  assert.match(clientHelper, /crypto\.subtle\.digest\("SHA-256"/, "browser must hash files for the expectation");

  // Upload orchestration: prepare and byte transfer run exactly once; a 409
  // stale revision on complete retries COMPLETE only, exactly once, with the
  // same object_id and the server-reported revision — then fails visibly.
  const uploadOrchestrator = clientHelper.slice(
    clientHelper.indexOf("export async function uploadIntakeFile"),
  );
  assert.ok(uploadOrchestrator.length > 0, "intake client must export uploadIntakeFile");
  assert.equal(
    (uploadOrchestrator.match(/prepareIntakeUpload\(/g) ?? []).length,
    1,
    "prepare must run exactly once per upload (no whole-upload retry)",
  );
  assert.equal(
    (uploadOrchestrator.match(/uploadIntakeBytes\(/g) ?? []).length,
    1,
    "bytes must be transferred exactly once per upload",
  );
  assert.equal(
    (uploadOrchestrator.match(/completeIntakeUpload\(/g) ?? []).length,
    2,
    "complete may be retried exactly once on a stale draft revision",
  );
  assert.match(
    uploadOrchestrator,
    /staleDraftRevision/,
    "the single complete retry must be gated on stale_draft_revision",
  );
  assert.match(
    clientHelper,
    /export (async )?function completeIntakeUpload/,
    "complete must be a separately callable step",
  );

  // path_locked_by_version is gone: version-referenced paths stay replaceable.
  assert.doesNotMatch(
    sources.get(CONTRACT)!,
    /path_locked_by_version|pathLockedByVersion/,
    "the contract must not define path_locked_by_version",
  );
  assert.doesNotMatch(
    serverHelper,
    /path_locked_by_version|pathLockedByVersion/,
    "the server error map must not produce path_locked_by_version",
  );

  // Every route: nodejs runtime, auth-gated, service client from the helper.
  for (const [name, rel] of Object.entries(ROUTES)) {
    const source = sources.get(rel)!;
    assert.match(source, /export const runtime = "nodejs";/, `${name} must run on nodejs`);
    assert.match(
      source,
      /requireSettlementApiAuth\(request\)|requireSettlementApiPrincipal\(request\)/,
      `${name} must gate on settlement auth`,
    );
    assert.match(source, /createIntakeAdminClient\(\)/, `${name} must use the server-only admin client`);
    assert.doesNotMatch(source, /NEXT_PUBLIC_SUPABASE_ANON_KEY/, `${name} must not use the anon key`);
  }
  // Mutations must record the acting principal for the audit trail.
  for (const name of ["prepare", "complete", "remove", "reorder", "submit"] as const) {
    const source = sources.get(ROUTES[name])!;
    assert.match(source, /requireSettlementApiPrincipal\(request\)/, `${name} must resolve the principal`);
    assert.match(source, /auth\.principal\.subject/, `${name} must pass the actor to the RPCs`);
    assert.match(source, /readBoundedJson\(request/, `${name} must read a bounded JSON body`);
  }

  const workspaceRoute = sources.get(ROUTES.workspace)!;
  assert.match(workspaceRoute, /isValidIntakeMonthKey\(monthKey\)/, "workspace GET must validate the month");
  assert.match(workspaceRoute, /loadIntakeWorkspace\(/, "workspace GET must return the bounded workspace read");
  assert.match(workspaceRoute, /create_settlement_intake/, "workspace POST must use the idempotent create RPC");

  const prepare = sources.get(ROUTES.prepare)!;
  assert.match(
    prepare,
    /p_replacement_for_object_id:\s*replace \? \(existing\?\.id \?\? null\) : null/,
    "prepare must bind explicit replacement intent to the staged object",
  );
  assert.match(prepare, /canonicalizeIntakePath\(payload\.relative_path\)/, "prepare must canonicalize the client path");
  assert.match(prepare, /register_settlement_intake_object/, "prepare must register through the RPC");
  assert.match(prepare, /createSignedUploadUrl\(object\.storage_path\)/, "prepare must issue a signed upload URL");
  assert.match(prepare, /INTAKE_ERROR\.duplicatePath/, "prepare must report deterministic duplicates");
  assert.match(prepare, /MAX_INTAKE_FILE_BYTES/, "prepare must enforce the per-file byte cap");
  // Replacement is prepare-passive: it only stages/registers the new object
  // under an explicit optimistic revision. The old draft object must stay
  // fully intact until complete swaps atomically.
  assert.match(prepare, /fetchDraftObjectByPathKey\(/, "prepare duplicates must be detected against current draft entries");
  assert.match(prepare, /replace && /, "prepare must gate replacement behavior explicitly");
  assert.match(prepare, /expected_draft_revision/, "prepare replacement must require the optimistic revision");
  assert.match(prepare, /INTAKE_ERROR\.staleDraftRevision/, "prepare replacement must reject stale revisions");
  assert.doesNotMatch(
    prepare,
    /replaced by new upload|superseded orphan/,
    "prepare must never quarantine or displace the old draft object",
  );
  assert.doesNotMatch(prepare, /path_locked_by_version|pathLockedByVersion/, "version-referenced paths must stay replaceable");

  const complete = sources.get(ROUTES.complete)!;
  assert.match(
    complete,
    /object\.replacement_for_object_id[\s\S]+?replace_settlement_intake_draft_entry/,
    "complete may replace only the object explicitly bound during prepare",
  );
  assert.doesNotMatch(
    complete,
    /fetchDraftObjectByPathKey/,
    "complete must not infer replacement intent from current path occupancy",
  );
  assert.match(complete, /readBackIntakeObject\(/, "complete must read the uploaded bytes back server-side");
  assert.match(complete, /finalize_settlement_intake_object/, "complete must finalize through the RPC");
  assert.match(complete, /INTAKE_ERROR\.hashMismatch/, "complete must fail deterministically on hash mismatch");
  assert.match(complete, /INTAKE_ERROR\.sizeMismatch/, "complete must fail deterministically on size mismatch");
  assert.match(complete, /quarantine_settlement_intake_object/, "complete must quarantine mismatched uploads");
  assert.match(complete, /expected_draft_revision/, "complete must take the optimistic revision");
  assert.match(complete, /upsert_settlement_intake_draft_entry/, "complete must place the file in the draft");
  assert.match(
    complete,
    /replace_settlement_intake_draft_entry/,
    "complete must swap replacements through the single atomic RPC",
  );
  assert.doesNotMatch(
    complete,
    /remove_settlement_intake_draft_entry/,
    "complete must never remove-then-insert a replacement",
  );
  assert.doesNotMatch(
    complete,
    /p_position/,
    "draft positions must be allocated inside the RPC, not by the route",
  );
  assert.match(
    complete,
    /readBack\.sha256 !== object\.expected_sha256/,
    "complete must compare observed vs expected sha256 before finalize",
  );

  const remove = sources.get(ROUTES.remove)!;
  assert.match(remove, /export async function DELETE/, "remove must be a DELETE handler");
  assert.match(remove, /remove_settlement_intake_draft_entry/, "remove must use the draft-entry RPC");
  assert.match(remove, /INTAKE_ERROR\.staleDraftRevision/, "remove must surface stale conflicts");

  const reorder = sources.get(ROUTES.reorder)!;
  assert.match(reorder, /reorder_settlement_intake_draft/, "reorder must use the reorder RPC");
  assert.match(reorder, /MAX_INTAKE_FILES/, "reorder must bound the permutation size");
  assert.match(reorder, /INTAKE_ERROR\.staleDraftRevision/, "reorder must surface stale conflicts");

  const submit = sources.get(ROUTES.submit)!;
  assert.match(submit, /submit_settlement_intake_version/, "submit must use the submit RPC");
  assert.match(submit, /expected_draft_revision/, "submit must take the optimistic revision");
  assert.match(submit, /version_no/, "submit must return the immutable version number");
  assert.match(submit, /settlement_intake_version_files/, "submit must return the frozen file snapshot");

  // Stale conflicts must return the current revision so clients can recover.
  for (const name of ["complete", "remove", "reorder", "submit"] as const) {
    assert.match(
      sources.get(ROUTES[name])!,
      /currentDraftRevision\(/,
      `${name} must include the current revision in stale responses`,
    );
  }

  console.log("test-settlement-intake-api: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
