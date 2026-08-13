import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { emptyLookupMaps, toSalesRecords, type TransformContext, type TransformResult } from "../src/features/settlement/lib/aggregation/to-sales-records";
import type { RawRecord } from "../src/features/settlement/lib/schema/sales";
import type { SalesRecordInsert } from "../src/features/settlement/lib/supabase/types";
import {
  buildLocalParseStage,
  LocalParseStageError,
  type LocalParseStageErrorCode,
} from "../src/features/settlement/lib/worker/local-parse-stage";
import type { VersionSourceManifestEntry } from "../src/features/settlement/lib/worker/version-source-snapshot";

function sha(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function entry(position: number, displayPath: string, bytes: Buffer): VersionSourceManifestEntry {
  return {
    objectId: `00000000-0000-4000-8000-${String(position + 1).padStart(12, "0")}`,
    position,
    pathKey: displayPath.toLowerCase(),
    displayPath,
    sizeBytes: bytes.length,
    sha256: sha(bytes),
    storagePath: `intake/202607/${String(position + 1).padStart(32, "0")}/${String(position + 1).padStart(32, "0")}`,
  };
}

async function fixture(): Promise<{ root: string; entries: VersionSourceManifestEntry[] }> {
  const createdRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "local-parse-stage-"));
  const root = await fsp.realpath(createdRoot);
  await fsp.chmod(root, 0o700);
  const sources = [
    { e: entry(0, "a.csv", Buffer.from("a")), b: Buffer.from("a") },
    { e: entry(2, "nested/b.csv", Buffer.from("b")), b: Buffer.from("b") },
  ];
  for (const source of sources) {
    const target = path.join(root, "files", source.e.displayPath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, source.b);
  }
  return { root, entries: sources.map((source) => source.e) };
}

function raw(name: string, summary = false): RawRecord {
  return { row_index: 0, data: { title_jp: name, is_summary: summary } };
}

function insert(month: string, title: string): SalesRecordInsert {
  return {
    title_jp: title,
    company: "RJ",
    sales_month: month,
    settlement_month: month,
    settlement_batch: month,
    country: "JP",
    type: "WT",
    distribution_strategy: "non-ex",
    settlement_currency: "JPY",
    vehicle_currency: "KRW",
    total_amount_jpy: 1,
    fee_jpy: 0,
    before_tax_jpy: 1,
    after_tax_jpy: 1,
    rs_rate: 1,
    before_tax_income_jpy: 1,
    withholding_tax_jpy: 0,
    consumption_tax_jpy: 0,
    after_tax_income_jpy_a: 1,
    mg_begin: 0,
    mg_increase: 0,
    mg_decrease: 0,
    mg_end: 0,
  } as SalesRecordInsert;
}

function dependencies(overrides?: {
  platform?: string;
  errors?: string[];
  rows?: RawRecord[];
  confidence?: number;
  throwParser?: boolean;
  transformErrors?: boolean;
}) {
  const months: string[] = [];
  return {
    months,
    parseFile: async ({ filename }: { filename: string; buffer: Buffer }) => {
      if (overrides?.throwParser) throw new Error("sensitive parser detail");
      return {
        platform_code: overrides?.platform ?? "synthetic",
        sales_month: null,
        settlement_month: null,
        records: overrides?.rows ?? [raw(filename)],
        errors: overrides?.errors ?? [],
        detection_confidence: overrides?.confidence ?? 1,
      };
    },
    toSalesRecords: (rows: RawRecord[], context: TransformContext): TransformResult => {
      months.push(context.settlement_month);
      return {
        inserts: rows.map((row) => insert(context.settlement_month, String(row.data.title_jp))),
        errors: overrides?.transformErrors ? [{ row_index: 0, platform_code: "synthetic", field: "x", message: "sensitive" }] : [],
        platform_code: "synthetic",
        resolved: { clients: new Set(), channels: new Set() },
      };
    },
  };
}

async function expectCode(run: () => Promise<unknown>, code: LocalParseStageErrorCode): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof LocalParseStageError);
    assert.equal(error.code, code);
    assert.equal(error.message, code, "error must not expose source/parser details");
    return true;
  });
}

async function main(): Promise<void> {
  const created: string[] = [];
  try {
    const f = await fixture(); created.push(f.root);
    const deps = dependencies();
    const base = { snapshotDir: f.root, entries: f.entries, settlementMonth: "2026-07-01", lookups: emptyLookupMaps(), ...deps };
    const first = await buildLocalParseStage(base);
    const replay = await buildLocalParseStage(base);
    assert.equal(first.digest, replay.digest);
    assert.deepEqual(first.files.map((x) => x.position), [0, 2]);
    assert.deepEqual(first.files.map((x) => x.displayPath), ["a.csv", "nested/b.csv"]);
    assert.deepEqual(deps.months, ["2026-07-01", "2026-07-01", "2026-07-01", "2026-07-01"]);
    assert.equal(first.counts.rawRows, 2);
    assert.equal(first.counts.salesRows, 2);
    const retainedRaw = first.rawRows[0].data;
    const retainedSales = first.salesRows[0].record;
    retainedRaw.title_jp = "mutated-stage-copy";
    retainedSales.title_jp = "mutated-stage-copy";
    const isolated = await buildLocalParseStage(base);
    assert.equal(isolated.digest, replay.digest, "caller mutation of a returned stage must not affect replay");

    await fsp.writeFile(path.join(f.root, "files", "extra.csv"), "extra");
    await expectCode(() => buildLocalParseStage(base), "SOURCE_CHANGED");
    await fsp.rm(path.join(f.root, "files", "extra.csv"));

    await expectCode(() => buildLocalParseStage({ ...base, entries: [...f.entries].reverse() }), "INVALID_MANIFEST");
    await expectCode(() => buildLocalParseStage({ ...base, entries: [f.entries[0], { ...f.entries[1], objectId: f.entries[0].objectId }] }), "INVALID_MANIFEST");
    await fsp.writeFile(path.join(f.root, "files", "a.csv"), "changed");
    await expectCode(() => buildLocalParseStage(base), "SOURCE_CHANGED");

    const cases: Array<[LocalParseStageErrorCode, Parameters<typeof dependencies>[0]]> = [
      ["PARSER_FAILED", { throwParser: true }],
      ["UNSUPPORTED_SOURCE", { platform: "unknown" }],
      ["PARSER_FAILED", { errors: ["sensitive"] }],
      ["NO_ROWS", { rows: [] }],
      ["PARSER_FAILED", { confidence: Number.NaN }],
      ["TRANSFORM_FAILED", { transformErrors: true }],
    ];
    for (const [code, options] of cases) {
      const next = await fixture(); created.push(next.root);
      await expectCode(() => buildLocalParseStage({ snapshotDir: next.root, entries: next.entries, settlementMonth: "2026-07-01", lookups: emptyLookupMaps(), ...dependencies(options) }), code);
    }

    const summary = await fixture(); created.push(summary.root);
    const summaryResult = await buildLocalParseStage({ snapshotDir: summary.root, entries: summary.entries, settlementMonth: "2026-07-01", lookups: emptyLookupMaps(), ...dependencies({ rows: [raw("summary", true)] }) });
    assert.equal(summaryResult.counts.summaryFiles, 2);

    const realTransform = await fixture(); created.push(realTransform.root);
    const realResult = await buildLocalParseStage({
      snapshotDir: realTransform.root,
      entries: realTransform.entries,
      settlementMonth: "2026-07-01",
      lookups: emptyLookupMaps(),
      parseFile: async ({ filename }) => ({
        platform_code: "synthetic",
        sales_month: null,
        settlement_month: null,
        errors: [],
        detection_confidence: 1,
        records: [{ row_index: 0, data: {
          title_jp: `${filename}\nline`, client_code: "synthetic", channel_code: "synthetic",
          total_amount_jpy: 1, before_tax_jpy: 1, after_tax_jpy: 1, rs_rate: 1,
          before_tax_income_jpy: 1, after_tax_income_jpy: 1,
        } }],
      }),
      toSalesRecords,
    });
    assert.equal(realResult.salesRows.length, 2, "real transformer output must be canonical-stage compatible");
    assert.equal(realResult.salesRows[0].record.clients, "synthetic", "stage retains workbook client code");
    assert.equal(realResult.salesRows[0].record.channel, "synthetic", "stage retains workbook channel code");
    assert.equal(realResult.salesRows[0].record.client_code, "synthetic", "stage retains canonical client code");
    assert.equal(realResult.salesRows[0].record.channel_code, "synthetic", "stage retains canonical channel code");

    const duplicateRows = await fixture(); created.push(duplicateRows.root);
    await expectCode(() => buildLocalParseStage({ snapshotDir: duplicateRows.root, entries: duplicateRows.entries, settlementMonth: "2026-07-01", lookups: emptyLookupMaps(), ...dependencies({ rows: [raw("a"), raw("b")] }) }), "INVALID_STAGE_VALUE");

    const invalid = await fixture(); created.push(invalid.root);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    await expectCode(() => buildLocalParseStage({ snapshotDir: invalid.root, entries: invalid.entries, settlementMonth: "2026-07-01", lookups: emptyLookupMaps(), ...dependencies({ rows: [{ row_index: 0, data: cyclic }] }) }), "INVALID_STAGE_VALUE");

    const linked = await fixture(); created.push(linked.root);
    await fsp.rm(path.join(linked.root, "files", "a.csv"));
    await fsp.symlink(path.join(linked.root, "files", "nested", "b.csv"), path.join(linked.root, "files", "a.csv"));
    await expectCode(() => buildLocalParseStage({ snapshotDir: linked.root, entries: linked.entries, settlementMonth: "2026-07-01", lookups: emptyLookupMaps(), ...dependencies() }), "SOURCE_CHANGED");

    console.log("test-settlement-local-parse-stage: all assertions passed");
  } finally {
    await Promise.all(created.map((root) => fsp.rm(root, { recursive: true, force: true })));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
