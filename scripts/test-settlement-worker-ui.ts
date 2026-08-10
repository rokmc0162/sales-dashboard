import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  exceedsSettlementJobFileLimit,
  MAX_SETTLEMENT_JOB_FILES,
} from "../src/features/settlement/lib/storage/direct-upload-client";

const clientPath = new URL("../src/features/settlement/lib/storage/direct-upload-client.ts", import.meta.url);
const uiPath = new URL("../src/features/settlement/components/SettlementClient.tsx", import.meta.url);
const routePath = new URL("../app/api/settlement/jobs/route.ts", import.meta.url);

async function main() {
  const [client, ui, route] = await Promise.all([
    readFile(clientPath, "utf8"),
    readFile(uiPath, "utf8"),
    readFile(routePath, "utf8"),
  ]);

  assert.match(client, /export async function uploadSettlementFileToStorage\(/);
  assert.match(client, /return \{ upload_id: prepared\.upload_id \};/);
  assert.match(client, /export async function enqueueSettlementJob\(/);
  assert.match(client, /export function fetchSettlementJobStatus\(/);
  assert.match(client, /export async function pollSettlementJob\(/);
  assert.match(client, /signal\?: AbortSignal/);
  assert.match(client, /DEFAULT_JOB_POLL_TIMEOUT_MS/);
  assert.match(client, /throw new Error\("job polling timed out"\)/);
  assert.match(client, /export async function uploadSettlementFileDirect\(/);

  assert.doesNotMatch(ui, /uploadSettlementFileDirect/);
  assert.match(ui, /uploadSettlementFileToStorage/);
  assert.match(ui, /enqueueSettlementJob\(targetIso, transferred\)/);
  assert.match(ui, /position: transferred\.length/);
  assert.match(ui, /pollSettlementJob\(enqueued\.job_id/);
  assert.match(ui, /fetchLatestSettlementJob\(toIsoMonth\(month\)/);
  for (const phase of ["업로드", "대기", "파싱", "Excel 검증", "완료/검토 필요"]) {
    assert.equal(ui.includes(phase), true, `missing visible phase: ${phase}`);
  }
  assert.doesNotMatch(ui, /localStorage/);
  assert.doesNotMatch(ui, /prepared\.(?:path|token)/);
  assert.match(ui, /const busyOwnerRef = useRef<symbol \| null>\(null\)/);
  assert.match(ui, /busyOwnerRef\.current !== null\) return/);
  assert.match(ui, /busyOwnerRef\.current === owner/);
  assert.match(ui, /if \(busyOwnerRef\.current !== owner\) return/);
  assert.doesNotMatch(ui, /finally \{\s*activePollControllerRef\.current = null/);
  assert.match(ui, /terminal\.status === 'completed' \|\| terminal\.status === 'completed_with_warnings'/);
  assert.equal(MAX_SETTLEMENT_JOB_FILES, 200);
  assert.equal(exceedsSettlementJobFileLimit(200), false);
  assert.equal(exceedsSettlementJobFileLimit(201), true);
  const startUploadIndex = ui.indexOf("async function startUpload");
  const limitIndex = ui.indexOf("if (exceedsSettlementJobFileLimit(selected.length))", startUploadIndex);
  const transferIndex = ui.indexOf("await uploadSettlementFileToStorage", startUploadIndex);
  assert.ok(startUploadIndex >= 0 && limitIndex > startUploadIndex && transferIndex > limitIndex,
    "the 200-file rejection must happen before the first Storage transfer");
  assert.match(ui, /한 번에 최대.*파일만 업로드할 수 있습니다/);
  assert.match(ui, /一度にアップロードできるファイルは最大/);

  assert.match(route, /export async function GET\(request: Request\)/);
  assert.match(route, /searchParams\.get\("month"\)/);
  assert.match(route, /await requireSettlementApiAuth\(request\)/);
  assert.match(route, /"cache-control": "no-store"/);

  console.log("test-settlement-worker-ui: all assertions passed");
}

void main();
