// Structural, security, and concurrency contract for migration 029
// (settlement web intake draft/object/version schema). Deterministic static
// checks over the SQL source plus type-parity checks against the hand-written
// Supabase types.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../supabase/migrations/029_settlement_web_intake_versions.sql",
  import.meta.url,
);
const typesUrl = new URL(
  "../src/features/settlement/lib/supabase/types.ts",
  import.meta.url,
);

const TABLES = [
  "settlement_intake_months",
  "settlement_intake_objects",
  "settlement_intake_draft_entries",
  "settlement_intake_audit",
  "settlement_intake_versions",
  "settlement_intake_version_files",
] as const;

const FUNCTIONS: ReadonlyArray<[name: string, args: string]> = [
  ["create_settlement_intake", "text, text"],
  ["register_settlement_intake_object", "uuid, text, text, text, bigint, text, text"],
  ["finalize_settlement_intake_object", "uuid, bigint, text, text"],
  ["quarantine_settlement_intake_object", "uuid, text, text"],
  ["upsert_settlement_intake_draft_entry", "uuid, uuid, integer, bigint, text"],
  ["remove_settlement_intake_draft_entry", "uuid, uuid, bigint, text"],
  ["reorder_settlement_intake_draft", "uuid, uuid\\[\\], bigint, text"],
  ["submit_settlement_intake_version", "uuid, bigint, text"],
];

function extractTable(sql: string, name: string): string {
  const match = sql.match(
    new RegExp(`create table (?:public\\.)?${name} \\(([\\s\\S]+?)\\n\\);`, "i"),
  );
  assert.ok(match, `migration must create table ${name}`);
  return match[1];
}

function extractFunction(sql: string, name: string): string {
  const match = sql.match(
    new RegExp(`create or replace function ${name}\\([\\s\\S]+?\\n\\$\\$;`, "i"),
  );
  assert.ok(match, `migration must define function ${name}`);
  return match[0];
}

function columnNames(tableBody: string): string[] {
  const names: string[] = [];
  for (const line of tableBody.split("\n")) {
    const match = line.match(/^ {2}([a-z_]+) {2,}/);
    if (!match) continue;
    if (["check", "unique", "primary", "foreign", "constraint"].includes(match[1])) {
      continue;
    }
    names.push(match[1]);
  }
  return names;
}

async function main() {
  const [sql, types] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(typesUrl, "utf8"),
  ]);

  // ---------------- static sanity ----------------
  assert.match(sql, /^begin;/m, "migration must run in a transaction");
  assert.match(sql, /^commit;\s*$/m, "migration must commit");
  assert.equal(
    (sql.match(/\$\$/g) ?? []).length % 2,
    0,
    "dollar-quoted bodies must be balanced",
  );
  assert.doesNotMatch(
    sql,
    /create table if not exists/i,
    "transactional one-time migrations must fail on a mismatched partial schema",
  );
  assert.doesNotMatch(
    sql,
    /drop trigger if exists/i,
    "the one-time transaction must not silently reconcile a partial schema",
  );
  assert.match(sql, /-- rollback \(manual[^\n]*\):/i, "migration must document rollback");

  // ---------------- months: one intake per valid YYYYMM ----------------
  const months = extractTable(sql, "settlement_intake_months");
  assert.match(months, /month\s+date not null unique/i);
  assert.match(months, /month = date_trunc\('month', month\)::date/i);
  assert.match(months, /month_key\s+varchar\(6\) not null unique/i);
  assert.match(months, /\^\[0-9\]\{4\}\(0\[1-9\]\|1\[0-2\]\)\$/, "month_key must be a valid YYYYMM");
  assert.match(months, /draft_revision\s+bigint not null default 0/i);

  // ---------------- objects: immutable sources with lifecycle ----------------
  const objects = extractTable(sql, "settlement_intake_objects");
  assert.match(objects, /status in \('uploading','finalized','quarantined'\)/i);
  assert.match(objects, /storage_path\s+varchar\(200\) not null unique/i);
  assert.match(
    objects,
    /\^intake\/\[0-9\]\{6\}\/\[0-9a-f\]\{32\}\/\[0-9a-f\]\{32\}\$/,
    "storage paths must be opaque ASCII",
  );
  assert.match(objects, /display_name\s+varchar\(300\) not null/i);
  assert.match(objects, /display_name !~ '\[\[:cntrl:\]\]'/i);
  assert.match(objects, /expected_size_bytes\s+bigint not null check \(expected_size_bytes between 1 and 104857600\)/i);
  assert.match(objects, /expected_sha256\s+char\(64\) not null check \(expected_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.match(objects, /observed_size_bytes\s+bigint check/i);
  assert.match(objects, /observed_sha256\s+char\(64\) check/i);
  assert.match(objects, /path_key\s+varchar\(500\) not null/i);
  assert.match(objects, /check \(public\.settlement_intake_path_key_ok\(path_key\)\)/i);
  const pathKeyGuard = extractFunction(sql, "settlement_intake_path_key_ok");
  for (const clause of [
    "pg_catalog.length(p_path_key) between 1 and 500",
    "p_path_key !~ '[[:cntrl:]]'",
    "p_path_key !~ '\\\\'",
    "p_path_key !~ '^/'",
    "p_path_key !~ '/$'",
    "p_path_key !~ '//'",
    "p_path_key = pg_catalog.lower(p_path_key)",
    "p_path_key is nfc normalized",
  ]) {
    assert.ok(pathKeyGuard.includes(clause), `path_key guard missing ${clause}`);
  }
  assert.match(
    objects,
    /status <> 'finalized' or \(\s*observed_size_bytes is not null\s+and observed_sha256 is not null\s+and observed_size_bytes = expected_size_bytes\s+and observed_sha256 = expected_sha256/i,
    "finalized objects must have observed = expected",
  );
  assert.match(
    sql,
    /create unique index idx_settlement_intake_objects_path_key\s+on settlement_intake_objects \(intake_id, path_key\)\s+where status <> 'quarantined'/i,
    "canonical path_key must be unique among live objects",
  );
  const objectGuard = extractFunction(sql, "settlement_intake_objects_guard");
  assert.match(objectGuard, /tg_op = 'DELETE'/i);
  assert.match(objectGuard, /old\.status = 'finalized'/i);
  assert.match(
    objectGuard,
    /'uploading' and new\.status in \('finalized','quarantined'\)/i,
    "lifecycle must only move uploading→finalized/quarantined",
  );
  assert.match(
    objectGuard,
    /'finalized' and new\.status = 'quarantined'/i,
    "finalized objects may only be quarantined",
  );
  assert.match(
    objectGuard,
    /settlement_intake_version_files/i,
    "objects referenced by a version must be locked against change",
  );
  for (const frozen of [
    "intake_id", "storage_bucket", "storage_path", "path_key", "display_name",
    "content_type", "expected_size_bytes", "expected_sha256", "created_by", "created_at",
  ]) {
    assert.match(
      objectGuard,
      new RegExp(`new\\.${frozen} is distinct from old\\.${frozen}`, "i"),
      `object column ${frozen} must be immutable`,
    );
  }

  // ---------------- draft entries: optimistic revision + audit ----------------
  const drafts = extractTable(sql, "settlement_intake_draft_entries");
  assert.match(drafts, /position\s+integer not null check \(position between 0 and 199\)/i);
  assert.match(drafts, /revision\s+bigint not null default 1/i);
  assert.match(drafts, /unique \(intake_id, object_id\)/i);
  assert.match(drafts, /unique \(intake_id, position\)/i);
  const audit = extractTable(sql, "settlement_intake_audit");
  assert.match(audit, /actor\s+varchar\(200\) not null/i);
  assert.match(audit, /action\s+varchar\(100\) not null/i);
  assert.match(
    sql,
    /create trigger trg_settlement_intake_audit_immutable\s+before update or delete on settlement_intake_audit/i,
    "audit log must be append-only",
  );

  // ---------------- versions: immutable, monotonic, idempotent ----------------
  const versions = extractTable(sql, "settlement_intake_versions");
  assert.match(versions, /version_no\s+integer not null check \(version_no between 1 and 1000000\)/i);
  assert.match(versions, /file_count\s+integer not null check \(file_count between 1 and 200\)/i);
  assert.match(versions, /total_size_bytes\s+bigint not null check \(total_size_bytes between 1 and 20971520000\)/i);
  assert.match(versions, /manifest_sha256\s+char\(64\) not null check/i);
  assert.match(versions, /unique \(intake_id, version_no\)/i);
  assert.match(versions, /unique \(intake_id, manifest_sha256\)/i, "manifest uniqueness backs idempotent replay");
  const versionFiles = extractTable(sql, "settlement_intake_version_files");
  assert.match(versionFiles, /on delete restrict/i);
  assert.match(versionFiles, /unique \(version_id, position\)/i);
  assert.match(versionFiles, /unique \(version_id, object_id\)/i);
  assert.match(versionFiles, /unique \(version_id, path_key\)/i);
  for (const frozen of ["path_key", "display_name", "size_bytes", "sha256", "storage_path"]) {
    assert.match(
      versionFiles,
      new RegExp(`${frozen}\\s`, "i"),
      `version files must freeze ${frozen}`,
    );
  }
  const finalizedOnly = extractFunction(sql, "settlement_intake_version_files_check_source");
  assert.match(finalizedOnly, /status <> 'finalized'/i, "version files may only reference finalized objects");
  assert.match(
    sql,
    /create trigger trg_settlement_intake_version_files_source\s+before insert on settlement_intake_version_files/i,
  );

  // ---------------- concurrency ----------------
  const reorderFunction = extractFunction(sql, "reorder_settlement_intake_draft");
  assert.match(reorderFunction, /array_ndims\(p_object_ids\) <> 1/i);
  assert.match(reorderFunction, /cardinality\(p_object_ids\)/i);
  for (const name of [
    "create_settlement_intake",
    "register_settlement_intake_object",
    "upsert_settlement_intake_draft_entry",
    "remove_settlement_intake_draft_entry",
    "reorder_settlement_intake_draft",
    "submit_settlement_intake_version",
  ]) {
    assert.match(
      extractFunction(sql, name),
      /pg_catalog\.pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\(/i,
      `${name} must take a per-intake advisory lock`,
    );
  }
  for (const name of [
    "upsert_settlement_intake_draft_entry",
    "remove_settlement_intake_draft_entry",
    "reorder_settlement_intake_draft",
    "submit_settlement_intake_version",
  ]) {
    const body = extractFunction(sql, name);
    assert.match(body, /for no key update/i, `${name} must avoid FK key-share lock inversion`);
    assert.match(
      body,
      /draft_revision <> p_expected_(draft_)?revision/i,
      `${name} must enforce optimistic draft revisions`,
    );
    assert.match(
      body,
      /stale draft revision/i,
      `${name} must fail loudly on stale revisions`,
    );
  }
  assert.match(
    extractFunction(sql, "finalize_settlement_intake_object"),
    /for no key update/i,
    "finalize must row-lock the object",
  );

  // ---------------- security ----------------
  for (const table of TABLES) {
    assert.match(
      sql,
      new RegExp(`alter table ${table} enable row level security`, "i"),
      `${table} must enable RLS`,
    );
    assert.match(
      sql,
      new RegExp(`revoke all on table ${table} from public, anon, authenticated, service_role`, "i"),
      `${table} must revoke public roles and migration-028 service-role defaults`,
    );
    assert.match(
      sql,
      new RegExp(`grant select on table ${table} to service_role`, "i"),
      `${table} must be service-role only`,
    );
    assert.doesNotMatch(
      sql,
      new RegExp(`grant[^;]*(insert|update|delete)[^;]*on table ${table}`, "i"),
      `${table} direct writes must be RPC-only`,
    );
    assert.doesNotMatch(
      sql,
      new RegExp(`create policy[^;]+${table}`, "is"),
      `${table} must not carry browser-role policies`,
    );
  }
  for (const [name, args] of FUNCTIONS) {
    const body = extractFunction(sql, name);
    assert.match(body, /security definer/i, `${name} must be security definer`);
    assert.match(
      body,
      /set search_path = ''/i,
      `${name} must use an empty search_path`,
    );
    const argPattern = args.replaceAll(", ", ", ").replaceAll(",", ",\\s*");
    assert.match(
      sql,
      new RegExp(
        `revoke all on function ${name}\\(${argPattern}\\) from public, anon, authenticated`,
        "i",
      ),
      `${name} must be revoked from PUBLIC/anon/authenticated`,
    );
    assert.match(
      sql,
      new RegExp(`grant execute on function ${name}\\(${argPattern}\\) to service_role`, "i"),
      `${name} must be granted to service_role only`,
    );
  }
  assert.match(
    sql,
    /revoke all on sequence settlement_intake_audit_id_seq from public, anon, authenticated, service_role/i,
  );

  // ---------------- type parity ----------------
  for (const table of TABLES) {
    assert.match(
      types,
      new RegExp(`${table}: \\{`),
      `types.ts must expose Database entry for ${table}`,
    );
  }
  const typeSlices: ReadonlyArray<[table: (typeof TABLES)[number], rowType: string]> = [
    ["settlement_intake_months", "SettlementIntakeMonthRow"],
    ["settlement_intake_objects", "SettlementIntakeObjectRow"],
    ["settlement_intake_draft_entries", "SettlementIntakeDraftEntryRow"],
    ["settlement_intake_audit", "SettlementIntakeAuditRow"],
    ["settlement_intake_versions", "SettlementIntakeVersionRow"],
    ["settlement_intake_version_files", "SettlementIntakeVersionFileRow"],
  ];
  for (const [table, rowType] of typeSlices) {
    const slice = types.match(
      new RegExp(`export type ${rowType} = \\{([\\s\\S]+?)\\};`),
    );
    assert.ok(slice, `types.ts must define ${rowType}`);
    for (const column of columnNames(extractTable(sql, table))) {
      assert.match(
        slice[1],
        new RegExp(`\\b${column}[?]?:`),
        `${rowType} must include column ${column}`,
      );
    }
  }
  for (const [name] of FUNCTIONS) {
    assert.match(
      types,
      new RegExp(`${name}: \\{`),
      `types.ts must expose Functions entry for ${name}`,
    );
  }
  // Immutable tables must not offer an Update shape.
  for (const entry of ["settlement_intake_versions", "settlement_intake_version_files", "settlement_intake_audit"]) {
    const dbEntry = types.match(new RegExp(`${entry}: \\{[\\s\\S]+?\\};`));
    assert.ok(dbEntry, `types.ts must define Database entry for ${entry}`);
    assert.match(
      dbEntry[0],
      /Update: \{ \[K in never\]: never \}/,
      `${entry} must expose an empty Update type (immutable)`,
    );
  }

  console.log("test-settlement-intake-schema: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
