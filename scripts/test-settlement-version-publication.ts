import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import path from "node:path";

import {
  PublicationEvidenceError,
  publishClaimedVersionWorkbook,
  type SettlementPublicationRow,
  type VersionPublicationStore,
} from "../src/features/settlement/lib/worker/version-publication";

const ROOT = path.resolve(`.tmp/version-publication-${process.pid}-${randomUUID()}`);
const identity = {
  jobId: "10000000-0000-4000-8000-000000000001",
  runId: "20000000-0000-4000-8000-000000000001",
  sourceVersionId: "30000000-0000-4000-8000-000000000001",
  workerId: "publication-worker",
  claimToken: "40000000-0000-4000-8000-000000000001",
};
function sha(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
function publication(bytes: Buffer): SettlementPublicationRow {
  return {
    id: "50000000-0000-4000-8000-000000000001", month: "2026-08-01",
    source_version_id: identity.sourceVersionId, job_id: identity.jobId, run_id: identity.runId,
    artifact_bucket: "upload-debug", artifact_path: `publications/${identity.runId}/candidate.xlsx`,
    artifact_sha256: sha(bytes), artifact_size_bytes: bytes.byteLength,
    workbook_sheet_count: 2, workbook_row_count: 3, published_at: new Date().toISOString(),
  };
}
class Store implements VersionPublicationStore {
  uploads = 0; publishes = 0; current = "60000000-0000-4000-8000-000000000001";
  uploadError: Error | null = null; publishResult: SettlementPublicationRow | null;
  stored: SettlementPublicationRow | null;
  constructor(readonly bytes: Buffer) { this.publishResult = publication(bytes); this.stored = publication(bytes); }
  async uploadAndVerify(input: { path: string; bytes: Buffer; sha256: string; sizeBytes: number }) {
    this.uploads += 1; if (this.uploadError) throw this.uploadError;
    assert.equal(input.path, `publications/${identity.runId}/candidate.xlsx`);
    assert.equal(input.sha256, sha(this.bytes)); assert.equal(input.sizeBytes, this.bytes.byteLength);
    assert.deepEqual(input.bytes, this.bytes);
  }
  async currentPublicationId(jobId: string) { assert.equal(jobId, identity.jobId); return this.current; }
  async publish(input: { expectedCurrentPublicationId: string | null }) {
    this.publishes += 1; assert.equal(input.expectedCurrentPublicationId, this.current); return this.publishResult;
  }
  async getPublication() { return this.stored; }
}

async function main() {
  await fsp.mkdir(ROOT, { recursive: true, mode: 0o700 });
  try {
    const bytes = Buffer.from("verified publication workbook");
    const dir = path.join(ROOT, "artifact"); await fsp.mkdir(dir, { mode: 0o700 });
    const candidatePath = path.join(dir, "office-verified.xlsx"); await fsp.writeFile(candidatePath, bytes, { mode: 0o600 });
    const input = { identity, candidatePath, workbookSha256: sha(bytes), workbookSizeBytes: bytes.byteLength };

    const okStore = new Store(bytes);
    const ok = await publishClaimedVersionWorkbook(input, okStore);
    assert.equal(ok.outcome, "published"); assert.equal(okStore.uploads, 1); assert.equal(okStore.publishes, 1);

    const preOfficePath = path.join(dir, "candidate.xlsx"); await fsp.writeFile(preOfficePath, bytes, { mode: 0o600 });
    assert.deepEqual(await publishClaimedVersionWorkbook({ ...input, candidatePath: preOfficePath }, new Store(bytes)), { outcome: "failed" });

    const networkStore = new Store(bytes); networkStore.uploadError = new Error("network secret");
    assert.deepEqual(await publishClaimedVersionWorkbook(input, networkStore), { outcome: "retry" });
    assert.equal(networkStore.publishes, 0);

    const mismatchStore = new Store(bytes); mismatchStore.uploadError = new PublicationEvidenceError("publication storage mismatch");
    assert.deepEqual(await publishClaimedVersionWorkbook(input, mismatchStore), { outcome: "failed" });

    const deniedStore = new Store(bytes); deniedStore.publishResult = null;
    assert.deepEqual(await publishClaimedVersionWorkbook(input, deniedStore), { outcome: "lease_lost" });

    const readBackStore = new Store(bytes); readBackStore.stored = { ...publication(bytes), artifact_sha256: "f".repeat(64) };
    assert.deepEqual(await publishClaimedVersionWorkbook(input, readBackStore), { outcome: "failed" });

    await fsp.writeFile(candidatePath, Buffer.from("changed"), { mode: 0o600 });
    assert.deepEqual(await publishClaimedVersionWorkbook(input, new Store(bytes)), { outcome: "failed" });

    const target = path.join(ROOT, "target.xlsx"); await fsp.writeFile(target, bytes, { mode: 0o600 });
    const linked = path.join(dir, "candidate-linked.xlsx"); await fsp.symlink(target, linked);
    assert.deepEqual(await publishClaimedVersionWorkbook({ ...input, candidatePath: linked }, new Store(bytes)), { outcome: "failed" });

    console.log("test-settlement-version-publication: all assertions passed");
  } finally { await fsp.rm(ROOT, { recursive: true, force: true }); }
}
void main();
