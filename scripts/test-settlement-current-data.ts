import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  handleCurrentExport,
  type CurrentExportDependencies,
  handleCurrentStatus,
  type CurrentStatusLoader,
} from "../src/features/settlement/lib/current-data-routes";
import { fetchCurrentSettlementStatus } from "../src/features/settlement/lib/storage/current-status-client";

const authenticatedRequest = (path: string) => new Request(`http://local${path}`, {
  headers: { origin: "http://local" },
});
const allowAuth = async () => null;
const denyAuth = async () =>
  Response.json({ error: "Unauthorized" }, { status: 401 });

function loaderResult(overrides: Partial<Awaited<ReturnType<CurrentStatusLoader>>> = {}) {
  return {
    records: [{ title_jp: "private title", amount: 999, storage_path: "/private/file.xlsx" }],
    source: "supabase-private-path",
    loadError: null,
    sourceWarnings: ["booklive"],
    ...overrides,
  } as Awaited<ReturnType<CurrentStatusLoader>>;
}

const statusPayload = {
  month: "202606",
  recordCount: 7,
  warningCount: 1,
  isComplete: false,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function noWaitBackoff(delayMs: number, signal: AbortSignal): Promise<void> {
  assert.ok(delayMs >= 500 && delayMs <= 1_500, "retry delay must stay short and bounded");
  assert.equal(signal.aborted, false);
}

async function assertSafeStatusFailure(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "current settlement status unavailable");
    return true;
  });
}

async function testCurrentStatusClient(): Promise<void> {
  const retryController = new AbortController();
  let retryCalls = 0;
  const recovered = await fetchCurrentSettlementStatus("202606", retryController.signal, {
    fetchImpl: async (input, init) => {
      retryCalls += 1;
      assert.equal(input, "/api/settlement/current-status/202606");
      assert.equal(init?.signal, retryController.signal);
      return retryCalls === 1
        ? new Response("private timeout details", { status: 500 })
        : jsonResponse({ ...statusPayload, ignoredPrivateField: "not returned" });
    },
    backoff: noWaitBackoff,
  });
  assert.equal(retryCalls, 2, "one 500 must retry once before succeeding");
  assert.deepEqual(recovered, statusPayload, "only the validated status fields must be returned");

  let exhaustedCalls = 0;
  const exhaustedDelays: number[] = [];
  await assertSafeStatusFailure(fetchCurrentSettlementStatus("202606", new AbortController().signal, {
    fetchImpl: async () => {
      exhaustedCalls += 1;
      return new Response("private database details", { status: 500 });
    },
    backoff: async (delayMs, signal) => {
      assert.equal(signal.aborted, false);
      exhaustedDelays.push(delayMs);
    },
  }));
  assert.equal(exhaustedCalls, 3, "5xx responses must stop after three total attempts");
  assert.deepEqual(exhaustedDelays, [500, 1_500], "backoff must be exactly 500ms then 1500ms");

  let unauthorizedCalls = 0;
  await assertSafeStatusFailure(fetchCurrentSettlementStatus("202606", new AbortController().signal, {
    fetchImpl: async () => {
      unauthorizedCalls += 1;
      return new Response("private auth details", { status: 401 });
    },
    backoff: noWaitBackoff,
  }));
  assert.equal(unauthorizedCalls, 1, "4xx responses must not retry");

  let networkCalls = 0;
  const networkRecovered = await fetchCurrentSettlementStatus("202606", new AbortController().signal, {
    fetchImpl: async () => {
      networkCalls += 1;
      if (networkCalls === 1) throw new Error("private network details");
      return jsonResponse(statusPayload);
    },
    backoff: noWaitBackoff,
  });
  assert.equal(networkCalls, 2, "transient network failures must retry");
  assert.deepEqual(networkRecovered, statusPayload);

  let responseReadCalls = 0;
  const responseReadRecovered = await fetchCurrentSettlementStatus("202606", new AbortController().signal, {
    fetchImpl: async () => {
      responseReadCalls += 1;
      if (responseReadCalls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => { throw new TypeError("private response stream details"); },
        } as Response;
      }
      return jsonResponse(statusPayload);
    },
    backoff: noWaitBackoff,
  });
  assert.equal(responseReadCalls, 2, "transient response-body network failures must retry");
  assert.deepEqual(responseReadRecovered, statusPayload);

  let malformedCalls = 0;
  await assertSafeStatusFailure(fetchCurrentSettlementStatus("202606", new AbortController().signal, {
    fetchImpl: async () => {
      malformedCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError("private malformed JSON details"); },
      } as Response;
    },
    backoff: noWaitBackoff,
  }));
  assert.equal(malformedCalls, 1, "malformed successful responses must not retry");

  const fetchAbort = new Error("private abort details");
  fetchAbort.name = "AbortError";
  let abortCalls = 0;
  let abortBackoffCalls = 0;
  await assert.rejects(
    fetchCurrentSettlementStatus("202606", new AbortController().signal, {
      fetchImpl: async () => {
        abortCalls += 1;
        throw fetchAbort;
      },
      backoff: async () => {
        abortBackoffCalls += 1;
      },
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(abortCalls, 1, "AbortError must stop immediately");
  assert.equal(abortBackoffCalls, 0, "AbortError must not enter backoff");

  const backoffAbortController = new AbortController();
  let backoffAbortFetchCalls = 0;
  await assert.rejects(
    fetchCurrentSettlementStatus("202606", backoffAbortController.signal, {
      fetchImpl: async () => {
        backoffAbortFetchCalls += 1;
        return new Response("private timeout details", { status: 500 });
      },
      backoff: async (_delayMs, signal) => {
        backoffAbortController.abort();
        assert.equal(signal.aborted, true);
        const error = new Error("private backoff abort details");
        error.name = "AbortError";
        throw error;
      },
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(backoffAbortFetchCalls, 1, "abort during backoff must prevent the next fetch");

  let invalidCalls = 0;
  await assertSafeStatusFailure(fetchCurrentSettlementStatus("202606", new AbortController().signal, {
    fetchImpl: async () => {
      invalidCalls += 1;
      return jsonResponse({
        month: "202606",
        recordCount: "7",
        warningCount: 1,
        isComplete: false,
        privateDetails: "must not escape",
      });
    },
    backoff: noWaitBackoff,
  }));
  assert.equal(invalidCalls, 1, "invalid successful responses must fail without retrying");
}

async function main() {
  await testCurrentStatusClient();

  let statusLoaderCalled = false;
  const statusLoader: CurrentStatusLoader = async () => {
    statusLoaderCalled = true;
    return loaderResult();
  };

  const unauthorizedStatus = await handleCurrentStatus(
    new Request("http://local/api/settlement/current-status/202606"),
    "202606",
    { auth: denyAuth, loadRecords: statusLoader },
  );
  assert.equal(unauthorizedStatus.status, 401);
  assert.equal(statusLoaderCalled, false, "authentication must run before loading records");

  const invalidStatus = await handleCurrentStatus(
    authenticatedRequest("/api/settlement/current-status/2026-06"),
    "2026-06",
    { auth: allowAuth, loadRecords: statusLoader },
  );
  assert.equal(invalidStatus.status, 400);
  assert.equal(statusLoaderCalled, false, "month validation must run before loading records");

  let statusOptions: { allowIncompleteSources?: boolean } | undefined;
  const readyStatus = await handleCurrentStatus(
    authenticatedRequest("/api/settlement/current-status/202606"),
    "202606",
    {
      auth: allowAuth,
      loadRecords: async (_month, options) => {
        statusOptions = options;
        return loaderResult();
      },
    },
  );
  assert.equal(readyStatus.status, 200);
  assert.deepEqual(await readyStatus.json(), {
    month: "202606",
    recordCount: 1,
    warningCount: 1,
    isComplete: false,
  });
  assert.equal(statusOptions?.allowIncompleteSources, true);
  assert.equal(readyStatus.headers.get("cache-control"), "no-store");

  const emptyStatus = await handleCurrentStatus(
    authenticatedRequest("/api/settlement/current-status/202606"),
    "202606",
    {
      auth: allowAuth,
      loadRecords: async () => loaderResult({ records: [], sourceWarnings: [] }),
    },
  );
  assert.deepEqual(await emptyStatus.json(), {
    month: "202606",
    recordCount: 0,
    warningCount: 0,
    isComplete: true,
  });

  const failedStatus = await handleCurrentStatus(
    authenticatedRequest("/api/settlement/current-status/202606"),
    "202606",
    {
      auth: allowAuth,
      loadRecords: async () => loaderResult({
        records: [],
        loadError: {
          status: 500,
          error: "Failed to fetch settlement records",
          details: "title=private /storage/secret.xlsx amount=999",
        },
        sourceWarnings: [],
      }),
    },
  );
  const failedStatusText = await failedStatus.text();
  assert.equal(failedStatus.status, 500);
  assert.equal(failedStatusText.includes("/storage/secret.xlsx"), false);
  assert.equal(failedStatusText.includes("amount=999"), false);

  let exportLoaderCalled = false;
  const exportDeps: CurrentExportDependencies = {
    auth: allowAuth,
    loadRecords: async () => {
      exportLoaderCalled = true;
      return loaderResult();
    },
    fillTemplate: async () => ({
      buffer: Buffer.from("xlsx-fixture"),
      rows_written: 1,
      electronic_rows: 1,
      publication_rows: 0,
      fill_ms: 1,
    }),
  };

  const unauthorizedExport = await handleCurrentExport(
    new Request("http://local/api/settlement/export-current/202606.xlsx"),
    "202606.xlsx",
    { ...exportDeps, auth: denyAuth },
  );
  assert.equal(unauthorizedExport.status, 401);
  assert.equal(exportLoaderCalled, false);

  const invalidExport = await handleCurrentExport(
    authenticatedRequest("/api/settlement/export-current/2026-06.xlsx"),
    "2026-06.xlsx",
    exportDeps,
  );
  assert.equal(invalidExport.status, 400);
  assert.equal(exportLoaderCalled, false);

  let exportOptions: { allowIncompleteSources?: boolean } | undefined;
  let filledRecords: Record<string, unknown>[] | undefined;
  const incompleteExport = await handleCurrentExport(
    authenticatedRequest("/api/settlement/export-current/202606.xlsx"),
    "202606.xlsx",
    {
      auth: allowAuth,
      loadRecords: async (_month, options) => {
        exportOptions = options;
        return loaderResult();
      },
      fillTemplate: async ({ records }) => {
        filledRecords = records;
        return exportDeps.fillTemplate!({ month: "202606", records });
      },
    },
  );
  assert.equal(incompleteExport.status, 200);
  assert.equal(exportOptions?.allowIncompleteSources, true);
  assert.equal(filledRecords?.length, 1);
  assert.equal(
    incompleteExport.headers.get("content-type"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.match(
    incompleteExport.headers.get("content-disposition") ?? "",
    /JP_INPUT_CURRENT_202606\.xlsx/,
  );
  assert.equal(incompleteExport.headers.get("x-export-current-status"), "incomplete");
  assert.equal(incompleteExport.headers.get("x-export-current-warning-count"), "1");
  assert.equal(Buffer.from(await incompleteExport.arrayBuffer()).toString(), "xlsx-fixture");

  const completeExport = await handleCurrentExport(
    authenticatedRequest("/api/settlement/export-current/202606.xlsx"),
    "202606.xlsx",
    {
      ...exportDeps,
      loadRecords: async () => loaderResult({ sourceWarnings: [] }),
    },
  );
  assert.equal(completeExport.headers.get("x-export-current-status"), "complete");
  assert.equal(completeExport.headers.get("x-export-current-warning-count"), "0");

  const emptyExport = await handleCurrentExport(
    authenticatedRequest("/api/settlement/export-current/202606.xlsx"),
    "202606.xlsx",
    {
      ...exportDeps,
      loadRecords: async () => loaderResult({ records: [], sourceWarnings: [] }),
    },
  );
  assert.equal(emptyExport.status, 404);

  const failedExport = await handleCurrentExport(
    authenticatedRequest("/api/settlement/export-current/202606.xlsx"),
    "202606.xlsx",
    {
      ...exportDeps,
      fillTemplate: async () => {
        throw new Error("title=private /storage/secret.xlsx amount=999");
      },
    },
  );
  const failedExportText = await failedExport.text();
  assert.equal(failedExport.status, 500);
  assert.equal(failedExportText.includes("/storage/secret.xlsx"), false);
  assert.equal(failedExportText.includes("amount=999"), false);

  const [settlementClient, currentStatusClient, previewWindow, previewTable, strictExport] = await Promise.all([
    readFile(new URL("../src/features/settlement/components/SettlementClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/settlement/lib/storage/current-status-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/features/settlement/components/InputPreviewWindow.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/settlement/components/InputPreviewTable.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/settlement/export-v2/[month]/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(settlementClient, /3\. 현재 정산 데이터/);
  assert.match(settlementClient, /3\. 現在の精算データ/);
  assert.match(settlementClient, /fetchCurrentSettlementStatus\(month, controller\.signal\)/);
  assert.match(settlementClient, /new AbortController\(\)/);
  assert.match(currentStatusClient, /fetchImpl\(`\/api\/settlement\/current-status\/\$\{month\}`, \{ signal \}\)/);
  assert.match(currentStatusClient, /const MAX_ATTEMPTS = 3/);
  const errorBranchStart = settlementClient.indexOf(") : currentStatusError ? (");
  const currentDataBranchStart = settlementClient.indexOf(") : currentStatus && currentStatus.recordCount === 0");
  assert.ok(errorBranchStart >= 0 && currentDataBranchStart > errorBranchStart);
  const errorBranch = settlementClient.slice(errorBranchStart, currentDataBranchStart);
  assert.match(errorBranch, /onClick=\{\(\) => setCurrentStatusVersion\(\(version\) => version \+ 1\)\}/);
  assert.match(errorBranch, /다시 시도/);
  assert.match(errorBranch, /再試行/);
  assert.doesNotMatch(errorBranch, /export-current|openPreviewWindow/, "data actions must stay hidden in the error branch");
  assert.doesNotMatch(settlementClient, /preview-v2/);
  assert.equal(
    [...settlementClient.matchAll(
      /if \(terminal\.status === 'completed' \|\| terminal\.status === 'completed_with_warnings'\) \{\s*setMonthPlatformsVersion\([^;]+;\s*\}\s*setCurrentStatusVersion/g,
    )].length,
    2,
    "current status must refresh after recovered and newly started jobs reach any terminal state",
  );
  assert.match(
    settlementClient,
    /setMonthPlatformsVersion\(\(v\) => v \+ 1\);\s*setCurrentStatusVersion\(\(v\) => v \+ 1\);/,
  );
  assert.match(settlementClient, /현재 파싱본 Excel 다운로드/);
  assert.match(settlementClient, /現在の解析版Excelをダウンロード/);
  assert.match(settlementClient, /완전성 검사 후 최종 Excel/);
  assert.match(settlementClient, /完全性検査後の最終Excel/);
  assert.ok(
    settlementClient.indexOf("/api/settlement/export-current/")
      < settlementClient.indexOf("/api/settlement/export-v2/"),
    "current workbook must be the primary download action",
  );

  assert.match(previewTable, /sourceWarnings\?: string\[\]/);
  assert.match(previewWindow, /현재 정산 데이터/);
  assert.match(previewWindow, /現在の精算データ/);
  assert.match(previewWindow, /preview\.sourceWarnings/);
  assert.match(previewWindow, /preview\.sheets\.length/);
  assert.ok(
    previewWindow.indexOf("/api/settlement/export-current/")
      < previewWindow.indexOf("/api/settlement/export-v2/"),
    "preview current workbook download must precede the strict final action",
  );

  assert.doesNotMatch(strictExport, /allowIncompleteSources/);
  assert.match(strictExport, /loadInputV2Records\(month\)/);

  console.log("test-settlement-current-data: all assertions passed");
}

void main();
