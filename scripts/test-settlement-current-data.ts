import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  handleCurrentExport,
  type CurrentExportDependencies,
  handleCurrentStatus,
  type CurrentStatusLoader,
} from "../src/features/settlement/lib/current-data-routes";

const AUTH_COOKIE = "X-REFRESH-TOKEN=rvjp-temporary-mock-refresh-token";
const authenticatedRequest = (path: string) => new Request(`http://local${path}`, {
  headers: { cookie: AUTH_COOKIE },
});

function loaderResult(overrides: Partial<Awaited<ReturnType<CurrentStatusLoader>>> = {}) {
  return {
    records: [{ title_jp: "private title", amount: 999, storage_path: "/private/file.xlsx" }],
    source: "supabase-private-path",
    loadError: null,
    sourceWarnings: ["booklive"],
    ...overrides,
  } as Awaited<ReturnType<CurrentStatusLoader>>;
}

async function main() {
  let statusLoaderCalled = false;
  const statusLoader: CurrentStatusLoader = async () => {
    statusLoaderCalled = true;
    return loaderResult();
  };

  const unauthorizedStatus = await handleCurrentStatus(
    new Request("http://local/api/settlement/current-status/202606"),
    "202606",
    statusLoader,
  );
  assert.equal(unauthorizedStatus.status, 401);
  assert.equal(statusLoaderCalled, false, "authentication must run before loading records");

  const invalidStatus = await handleCurrentStatus(
    authenticatedRequest("/api/settlement/current-status/2026-06"),
    "2026-06",
    statusLoader,
  );
  assert.equal(invalidStatus.status, 400);
  assert.equal(statusLoaderCalled, false, "month validation must run before loading records");

  let statusOptions: { allowIncompleteSources?: boolean } | undefined;
  const readyStatus = await handleCurrentStatus(
    authenticatedRequest("/api/settlement/current-status/202606"),
    "202606",
    async (_month, options) => {
      statusOptions = options;
      return loaderResult();
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
    async () => loaderResult({ records: [], sourceWarnings: [] }),
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
    async () => loaderResult({
      records: [],
      loadError: {
        status: 500,
        error: "Failed to fetch settlement records",
        details: "title=private /storage/secret.xlsx amount=999",
      },
      sourceWarnings: [],
    }),
  );
  const failedStatusText = await failedStatus.text();
  assert.equal(failedStatus.status, 500);
  assert.equal(failedStatusText.includes("/storage/secret.xlsx"), false);
  assert.equal(failedStatusText.includes("amount=999"), false);

  let exportLoaderCalled = false;
  const exportDeps: CurrentExportDependencies = {
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
    exportDeps,
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
      loadRecords: async (_month, options) => {
        exportOptions = options;
        return loaderResult();
      },
      fillTemplate: async ({ records }) => {
        filledRecords = records;
        return exportDeps.fillTemplate({ month: "202606", records });
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

  const [settlementClient, previewWindow, previewTable, strictExport] = await Promise.all([
    readFile(new URL("../src/features/settlement/components/SettlementClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/settlement/components/InputPreviewWindow.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/settlement/components/InputPreviewTable.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/settlement/export-v2/[month]/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(settlementClient, /3\. 현재 정산 데이터/);
  assert.match(settlementClient, /3\. 現在の精算データ/);
  assert.match(settlementClient, /fetch\(`\/api\/settlement\/current-status\/\$\{month\}`/);
  assert.match(settlementClient, /new AbortController\(\)/);
  assert.match(settlementClient, /signal: controller\.signal/);
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
