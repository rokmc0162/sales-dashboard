// UI contract tests for the settlement intake workspace (deterministic
// source inspection, no browser): the workspace is mounted visibly on
// /settlement, follows the operator month selection, supports multi-file and
// folder selection with relative paths, shows upload progress, offers
// replace/remove/reorder with optimistic revisions, confirms submission, and
// renders the immutable v1/v2 history — all without touching the legacy
// synchronous upload pipeline.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const WORKSPACE = "src/features/settlement/components/SettlementIntakeWorkspace.tsx";
const CLIENT_PAGE = "src/features/settlement/components/SettlementClient.tsx";
const INTAKE_CLIENT = "src/features/settlement/lib/intake/intake-client.ts";

async function main() {
  const [workspace, clientPage, intakeClient] = await Promise.all([
    readFile(path.join(repoRoot, WORKSPACE), "utf8"),
    readFile(path.join(repoRoot, CLIENT_PAGE), "utf8"),
    readFile(path.join(repoRoot, INTAKE_CLIENT), "utf8"),
  ]);

  // ---------------- visible mount on /settlement ----------------
  assert.match(
    clientPage,
    /import SettlementIntakeWorkspace from '@\/features\/settlement\/components\/SettlementIntakeWorkspace';/,
    "SettlementClient must import the intake workspace",
  );
  assert.match(
    clientPage,
    /<SettlementIntakeWorkspace month=\{month\} \/>/,
    "the workspace must be mounted with the operator-selected month",
  );

  // ---------------- month + workspace lifecycle ----------------
  assert.match(workspace, /export default function SettlementIntakeWorkspace\(\{ month \}/);
  assert.match(workspace, /fetchIntakeWorkspace\(month/, "workspace must load the month workspace");
  assert.match(workspace, /ensureIntakeWorkspace\(month\)/, "workspace must create the intake lazily");
  // A month switch must immediately drop the old month's workspace so no
  // mutation can run against a stale intake, and every mutation must verify
  // the loaded workspace still belongs to the selected month.
  assert.match(
    workspace,
    /setWorkspace\(null\);\s*\}, \[month\]\);/,
    "month change must clear the workspace immediately",
  );
  assert.match(
    workspace,
    /month_key !== month/,
    "mutations must guard workspace.month_key against the current month prop",
  );

  // ---------------- multi-file/folder selection with relative paths --------
  assert.match(workspace, /webkitdirectory/, "folder picker must be available");
  assert.match(workspace, /webkitRelativePath \|\| file\.name/, "picker must preserve relative paths");
  assert.match(workspace, /webkitGetAsEntry/, "drop traversal must preserve folder structure");
  assert.match(workspace, /entry\.fullPath\.replace\(\/\^\\\/\/, ''\)/, "dropped entries must keep relative paths");

  // ---------------- upload progress and status ----------------
  assert.match(workspace, /uploadIntakeFile\(\{/, "uploads must go through the intake client");
  assert.match(workspace, /hashing_uploading/, "per-file progress states must render");
  assert.match(workspace, /uploadRows/, "the upload list must be rendered");
  assert.match(workspace, /draft_revision/, "uploads must chain optimistic draft revisions");

  // ---------------- ordered list + replace/remove/reorder ----------------
  assert.match(workspace, /sort\(\(a, b\) => a\.position - b\.position\)/, "draft files must render in draft order");
  assert.match(workspace, /reorderIntakeDraft\(/, "reorder control must call the reorder API");
  assert.match(workspace, /removeIntakeFile\(/, "remove control must call the remove API");
  assert.match(workspace, /onReplaceClick/, "replace control must exist per file");
  assert.match(workspace, /replace: replaceAll/, "replace must be explicit in the upload call");
  assert.match(workspace, /startUploads\(\[\{ file: picked, relativePath: target\.display_path \}\], true\)/, "replace must reuse the entry's relative path");
  assert.match(workspace, /ArrowUp|ArrowDown/, "reorder controls must be visible");
  assert.match(workspace, /staleDraftRevision/, "stale draft conflicts must be handled");
  assert.doesNotMatch(
    workspace,
    /i -= 1/,
    "stale conflicts must not trigger an unlimited whole-upload retry loop",
  );
  assert.doesNotMatch(
    workspace,
    /disabled=\{[^}]*locked_by_version[^}]*\}/,
    "replace must never be permanently disabled for version-referenced files",
  );

  // ---------------- submit confirmation + version history ----------------
  assert.match(workspace, /window\.confirm\(/, "submit must ask for confirmation");
  assert.match(workspace, /submitIntakeVersion\(/, "submit must call the submit API");
  assert.match(workspace, /v\$\{result\.version\.version_no\}|v\{version\.version_no\}/, "the created version number must be shown");
  assert.match(workspace, /version\.version_no/, "version history must render version numbers");
  assert.match(workspace, /version\.submitted_by/, "version history must show the submitter");
  assert.match(workspace, /새 버전으로 재처리/, "editing after submit must announce reprocessing as a new version");

  // ---------------- no legacy pipeline usage ----------------
  for (const [name, source] of [
    ["workspace", workspace],
    ["intake-client", intakeClient],
  ] as const) {
    assert.doesNotMatch(
      source,
      /\/api\/settlement\/upload["'`/]|uploadSettlementFileDirect|enqueueSettlementJob/,
      `${name} must not use the legacy upload/enqueue pipeline`,
    );
    assert.doesNotMatch(
      source,
      /direct-upload-client/,
      `${name} must not import the legacy direct-upload client`,
    );
  }
  // The legacy client remains for the old flow, but the new workspace section
  // must be fully wired to the intake client instead.
  assert.match(workspace, /from '@\/features\/settlement\/lib\/intake\/intake-client'/);

  console.log("test-settlement-intake-ui: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
