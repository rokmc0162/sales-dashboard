import assert from "node:assert/strict";

import type { LookupMaps } from "../src/features/settlement/lib/aggregation/to-sales-records";
import type { DirectUploadRow } from "../src/features/settlement/lib/storage/direct-upload";
import type { SalesRecordInsert } from "../src/features/settlement/lib/supabase/types";
import {
  processParsedUpload,
  processPreparedUpload,
  type PreparedUploadProcessorDependencies,
  type PreparedUploadStore,
} from "../src/features/settlement/lib/worker/process-prepared-upload";

const uploadId = "11111111-1111-4111-8111-111111111111";
const rawRecordId = "22222222-2222-4222-8222-222222222222";
const now = "2026-08-01T00:00:00.000Z";
const row: DirectUploadRow = {
  id: uploadId,
  filename: "statement.xlsx",
  storage_path: `uploads/2026-06/${uploadId}.xlsx`,
  size_bytes: 8,
  content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  settlement_month: "2026-06-01",
  status: "uploaded",
};

function baseStore(): PreparedUploadStore {
  return {
    getUpload: async () => row,
    download: async () => Buffer.from("workbook"),
    markParsing: async () => "updated",
    findExactDuplicates: async () => [],
    updateUpload: async () => null,
    loadLookupRows: async () => ({ clients: [], channels: [], titles: [], titleAliases: [] }),
    insertRawRecords: async () => [],
    listExistingSalesRecords: async () => [],
    insertSalesRecords: async () => 0,
  };
}

async function main() {
  {
    // The exact-source lookup runs before parsing. A DB failure must stop the
    // pipeline and mark the upload failed without reaching any record insert.
    const store = baseStore();
    const updates: Array<Record<string, unknown>> = [];
    let parsed = false;
    let salesInsertCalls = 0;
    store.findExactDuplicates = async () => { throw new Error("private DB detail"); };
    store.updateUpload = async (_id, patch) => { updates.push(patch); return null; };
    store.insertSalesRecords = async () => { salesInsertCalls += 1; return 1; };
    const outcome = await processPreparedUpload({ uploadId }, {
      store,
      now: () => now,
      logger: { log() {}, warn() {}, error() {} },
      parseFile: async () => {
        parsed = true;
        throw new Error("must not parse");
      },
      toSalesRecords: (() => { throw new Error("must not transform"); }),
      buildLookupMaps: (() => { throw new Error("must not load lookups"); }),
    } as PreparedUploadProcessorDependencies);
    assert.equal(parsed, false);
    assert.equal(salesInsertCalls, 0);
    assert.deepEqual(outcome.body, {
      results: [{ upload_id: uploadId, file: row.filename, error: "duplicate check unavailable" }],
    });
    assert.equal(updates.at(-1)?.status, "failed");
    assert.equal(JSON.stringify(outcome).includes("private DB detail"), false);
  }

  {
    // Lookup loading happens after the upload is marked parsing. Failure must
    // close the upload as failed and never parse or insert downstream rows.
    const store = baseStore();
    const updates: Array<Record<string, unknown>> = [];
    let parsed = false;
    let salesInsertCalls = 0;
    store.loadLookupRows = async () => { throw new Error("private lookup detail"); };
    store.updateUpload = async (_id, patch) => { updates.push(patch); return null; };
    store.insertSalesRecords = async () => { salesInsertCalls += 1; return 1; };
    const outcome = await processPreparedUpload({ uploadId }, {
      store,
      now: () => now,
      logger: { log() {}, warn() {}, error() {} },
      parseFile: async () => {
        parsed = true;
        throw new Error("must not parse");
      },
      toSalesRecords: (() => { throw new Error("must not transform"); }),
      buildLookupMaps: (() => { throw new Error("must not build lookups"); }),
    } as PreparedUploadProcessorDependencies);
    assert.equal(parsed, false);
    assert.equal(salesInsertCalls, 0);
    assert.deepEqual(outcome.body, {
      results: [{ upload_id: uploadId, file: row.filename, error: "lookup data unavailable" }],
    });
    assert.equal(updates.at(-1)?.status, "failed");
    assert.equal(JSON.stringify(outcome).includes("private lookup detail"), false);
  }

  {
    // The transformed-sales duplicate lookup also fails closed. Raw evidence
    // may already be stored, but no sales row can be inserted without the gate.
    const store = baseStore();
    const updates: Array<Record<string, unknown>> = [];
    let salesInsertCalls = 0;
    store.updateUpload = async (_id, patch) => { updates.push(patch); return null; };
    store.insertRawRecords = async () => [{ id: rawRecordId, row_index: 1 }];
    store.listExistingSalesRecords = async () => { throw new Error("private DB detail"); };
    store.insertSalesRecords = async () => { salesInsertCalls += 1; return 1; };
    const lookups: LookupMaps = { clientIds: new Map(), channelIds: new Map() };
    const inserts = [{ title_jp: "safe fixture" }] as unknown as SalesRecordInsert[];
    const result = await processParsedUpload({
      store,
      uploadId,
      filename: row.filename,
      parsed: {
        platform_code: "booklive",
        sales_month: "2026-05-01",
        settlement_month: "2026-06-01",
        records: [{ row_index: 1, data: { safe: true } }],
        errors: [],
        detection_confidence: 1,
      },
      activeMonth: "2026-06-01",
      fallbackMonth: null,
      lookups,
      exactSourceGateApplied: true,
      toSalesRecords: (() => ({
        inserts,
        errors: [],
        platform_code: "booklive",
        resolved: { clients: new Set(), channels: new Set() },
      })) as Parameters<typeof processParsedUpload>[0]["toSalesRecords"],
      now: () => now,
      logger: { log() {}, warn() {}, error() {} },
    });
    assert.equal(salesInsertCalls, 0);
    assert.equal(result.error, "duplicate check unavailable");
    assert.equal(result.sales_records_written, 0);
    assert.equal(updates.at(-1)?.status, "failed");
    assert.equal(JSON.stringify(result).includes("private DB detail"), false);
  }

  console.log("test-settlement-worker-processor: all assertions passed");
}

void main();
