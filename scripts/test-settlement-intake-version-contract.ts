// Product-direction contract for the web intake + immutable version pipeline.
//
// Proves, by deterministic source inspection (no network, no database):
//   1. Web private Supabase Storage is the authoritative intake surface.
//   2. The browser has no Google Drive upload or resumable-session dependency.
//   3. Draft mutations never enqueue settlement jobs.
//   4. Submitted versions are immutable and submit replay is idempotent.
//   5. Google Drive backup is worker-only code.
//   6. Candidate generation cannot copy or import golden output.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const MIGRATION_REL = "supabase/migrations/029_settlement_web_intake_versions.sql";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);

async function walk(relDir: string): Promise<string[]> {
  const absDir = path.join(repoRoot, relDir);
  const entries = await readdir(absDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const files: string[] = [];
  for (const entry of entries) {
    const rel = path.posix.join(relDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(rel)));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(rel);
    }
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:import|export)\s[^"'`;]*?from\s*["']([^"']+)["']/g,
    /import\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function extractFunction(sql: string, name: string): string {
  const match = sql.match(
    new RegExp(`create or replace function ${name}\\([\\s\\S]+?\\n\\$\\$;`, "i"),
  );
  assert.ok(match, `migration must define function ${name}`);
  return match[0];
}

async function main() {
  const sql = await readFile(path.join(repoRoot, MIGRATION_REL), "utf8");
  const sourceFiles = [
    ...(await walk("app")),
    ...(await walk("src")),
    ...(await walk("scripts")),
  ];
  const sources = new Map<string, string>();
  for (const file of sourceFiles) {
    sources.set(file, await readFile(path.join(repoRoot, file), "utf8"));
  }

  // ------------------------------------------------------------------
  // 1. Web private Supabase Storage is the authoritative intake.
  // ------------------------------------------------------------------
  assert.match(
    sql,
    /insert into storage\.buckets \(id, name, public\)\s*values \('settlement-intake', 'settlement-intake', false\)/i,
    "intake bucket must be created private",
  );
  assert.match(
    sql,
    /on conflict \(id\) do update set public = false/i,
    "intake bucket must stay private even if it already exists",
  );
  assert.match(
    sql,
    /storage_bucket\s+text not null default 'settlement-intake'\s+check \(storage_bucket = 'settlement-intake'\)/i,
    "source objects must be pinned to the private intake bucket",
  );
  assert.doesNotMatch(
    sql,
    /drive|google|resumable/i,
    "the intake schema must not depend on Google Drive",
  );

  // ------------------------------------------------------------------
  // 2. No browser Drive upload or resumable-session dependency.
  // ------------------------------------------------------------------
  const driveImporterAllowlist = [
    "scripts/settlement-worker.ts",
    "scripts/test-settlement-drive-client.ts",
    "scripts/test-settlement-drive-config.ts",
  ];
  const driveImporterAllowedPrefixes = [
    "src/features/settlement/lib/google-drive/",
    "src/features/settlement/lib/worker/",
  ];
  for (const [file, source] of sources) {
    const importsDrive = importSpecifiers(source).some((specifier) =>
      specifier.includes("google-drive"),
    );
    if (!importsDrive) continue;
    const allowed =
      driveImporterAllowlist.includes(file) ||
      driveImporterAllowedPrefixes.some((prefix) => file.startsWith(prefix));
    assert.ok(
      allowed,
      `${file} imports google-drive code outside the worker boundary`,
    );
  }
  for (const file of [
    "src/features/settlement/lib/google-drive/config.server.ts",
    "src/features/settlement/lib/google-drive/client.server.ts",
  ]) {
    const source = sources.get(file);
    assert.ok(source, `${file} must exist`);
    assert.ok(
      importSpecifiers(source).includes("server-only"),
      `${file} must import "server-only" so bundlers reject browser usage`,
    );
  }
  const browserSurfacePrefixes = [
    "app/",
    "src/components/",
    "src/features/settlement/components/",
    "src/providers/",
  ];
  for (const [file, source] of sources) {
    if (!browserSurfacePrefixes.some((prefix) => file.startsWith(prefix))) {
      continue;
    }
    assert.doesNotMatch(
      source,
      /google-?drive|resumable|uploadType=resumable/i,
      `${file} must not carry a browser Drive upload/session dependency`,
    );
  }
  for (const [file, source] of sources) {
    if (file === "src/features/settlement/lib/google-drive/client.server.ts") {
      continue;
    }
    // This contract file quotes the forbidden pattern in its own assertion.
    if (file === "scripts/test-settlement-intake-version-contract.ts") continue;
    if (driveImporterAllowlist.includes(file)) continue;
    assert.doesNotMatch(
      source,
      /startResumableUpload/,
      `${file} must not start Drive resumable upload sessions`,
    );
  }

  // ------------------------------------------------------------------
  // 3. Draft mutations never enqueue settlement jobs.
  // ------------------------------------------------------------------
  const draftFunctions = [
    "create_settlement_intake",
    "register_settlement_intake_object",
    "finalize_settlement_intake_object",
    "quarantine_settlement_intake_object",
    "upsert_settlement_intake_draft_entry",
    "remove_settlement_intake_draft_entry",
    "reorder_settlement_intake_draft",
  ];
  for (const name of draftFunctions) {
    const body = extractFunction(sql, name);
    assert.doesNotMatch(
      body,
      /settlement_jobs|enqueue_settlement_job/i,
      `${name} must not touch the settlement job queue`,
    );
  }

  // ------------------------------------------------------------------
  // 4. Version submit is immutable and idempotent.
  // ------------------------------------------------------------------
  const submit = extractFunction(sql, "submit_settlement_intake_version");
  assert.match(
    submit,
    /pg_advisory_xact_lock/i,
    "submit must serialize per intake with an advisory lock",
  );
  assert.match(
    submit,
    /manifest_sha256 = v_manifest_sha256[\s\S]+?return v_existing/i,
    "submitting the same manifest again must return the existing version",
  );
  assert.match(
    submit,
    /coalesce\(max\(version_no\), 0\) \+ 1/i,
    "version numbers must be assigned monotonically",
  );
  assert.doesNotMatch(
    submit,
    /settlement_jobs|enqueue_settlement_job/i,
    "submit must not create settlement_jobs (queue wiring is migration 030)",
  );
  for (const table of [
    "settlement_intake_versions",
    "settlement_intake_version_files",
  ]) {
    assert.match(
      sql,
      new RegExp(
        `create trigger trg_${table}_immutable\\s+before update or delete on ${table}`,
        "i",
      ),
      `${table} rows must be frozen by an immutability trigger`,
    );
    assert.match(
      sql,
      new RegExp(`grant select on table ${table} to service_role`, "i"),
      `${table} must be directly readable but writable only through RPCs`,
    );
    assert.doesNotMatch(
      sql,
      new RegExp(`grant[^;]*(insert|update|delete)[^;]*on table ${table}`, "i"),
      `${table} must never receive direct insert/update/delete grants`,
    );
  }

  // ------------------------------------------------------------------
  // 5. Google Drive backup is worker-only.
  // ------------------------------------------------------------------
  const driveBackupScript = sources.get("scripts/sync-uploads-to-drive.mjs");
  assert.ok(
    driveBackupScript,
    "the Drive backup mirror must live in the worker scripts directory",
  );
  for (const [file, source] of sources) {
    if (file.startsWith("scripts/")) continue;
    assert.ok(
      !importSpecifiers(source).some((specifier) =>
        specifier.includes("sync-uploads-to-drive"),
      ),
      `${file} must not wire the Drive backup mirror into the web app`,
    );
  }

  // ------------------------------------------------------------------
  // 6. Candidate generation cannot copy or import golden output.
  // ------------------------------------------------------------------
  const generationPrefixes = [
    "src/features/settlement/lib/export/",
    "src/features/settlement/lib/parsers/",
    "src/features/settlement/lib/aggregation/",
  ];
  for (const [file, source] of sources) {
    if (!generationPrefixes.some((prefix) => file.startsWith(prefix))) continue;
    for (const specifier of importSpecifiers(source)) {
      assert.ok(
        !/comparison|golden/i.test(specifier),
        `${file} imports "${specifier}" — candidate generation must not read golden output`,
      );
    }
  }
  assert.doesNotMatch(
    sql,
    /settlement_comparison|golden/i,
    "the intake/version schema must not reference golden comparison data",
  );

  console.log("test-settlement-intake-version-contract: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
