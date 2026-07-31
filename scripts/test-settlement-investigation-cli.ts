/**
 * Pure argv-validation assertions for the Hermes investigation CLI. Importing
 * the CLI module must not open a database connection — parseCliArgs is pure.
 * Run: node --import tsx scripts/test-settlement-investigation-cli.ts
 */
import assert from "node:assert/strict";

import {
  COMMENT_BODY_MAX_LENGTH,
  ROOT_CAUSE_SUMMARY_MAX_LENGTH,
} from "../src/features/settlement/lib/comparison/investigation";
import { DIFF_LIST_LIMIT, parseCliArgs } from "./settlement-investigation-cli";

const DIFF_ID = "0b7e4a52-9c1d-4f6e-8a3b-2d5c7e9f1a4b";

function expectError(argv: string[], fragment: string) {
  const result = parseCliArgs(argv);
  assert.equal(result.ok, false, `expected error for: ${argv.join(" ")}`);
  if (!result.ok) {
    assert.ok(
      result.error.includes(fragment),
      `error "${result.error}" should mention "${fragment}"`,
    );
  }
}

// ── Shared bounds ──────────────────────────────────────────────────────────

assert.equal(DIFF_LIST_LIMIT, 200, "list must be bounded to 200 diffs");

// ── help ───────────────────────────────────────────────────────────────────

assert.deepEqual(parseCliArgs([]), { ok: true, cmd: { command: "help" } });
assert.deepEqual(parseCliArgs(["help"]), { ok: true, cmd: { command: "help" } });
assert.deepEqual(parseCliArgs(["--help"]), { ok: true, cmd: { command: "help" } });
assert.deepEqual(parseCliArgs(["-h"]), { ok: true, cmd: { command: "help" } });

// ── list ───────────────────────────────────────────────────────────────────

assert.deepEqual(parseCliArgs(["list", "--month", "202607"]), {
  ok: true,
  cmd: { command: "list", month: "2026-07-01", status: null, json: false },
});
assert.deepEqual(
  parseCliArgs(["list", "--month", "202612", "--status", "question_pending", "--json"]),
  {
    ok: true,
    cmd: { command: "list", month: "2026-12-01", status: "question_pending", json: true },
  },
);

expectError(["list"], "--month");
expectError(["list", "--month", "2026-07"], "--month");
expectError(["list", "--month", "2026070"], "--month");
expectError(["list", "--month", "abc123"], "--month");
expectError(["list", "--month", "202613"], "01-12");
expectError(["list", "--month", "202600"], "01-12");
expectError(["list", "--month", "202607", "--status", "done"], "--status");
expectError(["list", "--month", "202607", "--month", "202608"], "duplicate");
expectError(["list", "--month", "202607", "--verbose"], "unknown flag");
expectError(["list", "--month"], "requires a value");
expectError(["list", "202607"], "unexpected argument");

// ── answer ─────────────────────────────────────────────────────────────────

assert.deepEqual(
  parseCliArgs(["answer", "--diff-id", DIFF_ID, "--comment", "  파서가 원인입니다  ", "--status", "investigating"]),
  {
    ok: true,
    cmd: {
      command: "answer",
      diffId: DIFF_ID,
      comment: "파서가 원인입니다",
      status: "investigating",
      stage: null,
      summary: null,
    },
  },
);
assert.deepEqual(
  parseCliArgs([
    "answer",
    "--diff-id", DIFF_ID,
    "--comment", "세율 셀 오독이 확인됐습니다",
    "--status", "cause_confirmed",
    "--stage", "parser",
    "--summary", "파서가 세율 셀을 잘못 읽음",
  ]),
  {
    ok: true,
    cmd: {
      command: "answer",
      diffId: DIFF_ID,
      comment: "세율 셀 오독이 확인됐습니다",
      status: "cause_confirmed",
      stage: "parser",
      summary: "파서가 세율 셀을 잘못 읽음",
    },
  },
);

// Bounds: comment is trimmed before the 4000 check; summary is bounded too.
const maxComment = "a".repeat(COMMENT_BODY_MAX_LENGTH);
const okMax = parseCliArgs(["answer", "--diff-id", DIFF_ID, "--comment", `  ${maxComment}  `, "--status", "resolved"]);
assert.equal(okMax.ok, true);
if (okMax.ok && okMax.cmd.command === "answer") {
  assert.equal(okMax.cmd.comment.length, COMMENT_BODY_MAX_LENGTH);
}
expectError(
  ["answer", "--diff-id", DIFF_ID, "--comment", "a".repeat(COMMENT_BODY_MAX_LENGTH + 1), "--status", "resolved"],
  "--comment",
);
const okMaxSummary = parseCliArgs([
  "answer", "--diff-id", DIFF_ID, "--comment", "ok", "--status", "cause_confirmed",
  "--summary", "s".repeat(ROOT_CAUSE_SUMMARY_MAX_LENGTH),
]);
assert.equal(okMaxSummary.ok, true);
expectError(
  [
    "answer", "--diff-id", DIFF_ID, "--comment", "ok", "--status", "cause_confirmed",
    "--summary", "s".repeat(ROOT_CAUSE_SUMMARY_MAX_LENGTH + 1),
  ],
  "--summary",
);

expectError(["answer", "--comment", "ok", "--status", "resolved"], "--diff-id");
expectError(["answer", "--diff-id", "not-a-uuid", "--comment", "ok", "--status", "resolved"], "--diff-id");
expectError(["answer", "--diff-id", DIFF_ID, "--status", "resolved"], "--comment");
expectError(["answer", "--diff-id", DIFF_ID, "--comment", "   ", "--status", "resolved"], "blank");
expectError(["answer", "--diff-id", DIFF_ID, "--comment", "ok"], "--status");
expectError(["answer", "--diff-id", DIFF_ID, "--comment", "ok", "--status", "done"], "--status");
expectError(
  ["answer", "--diff-id", DIFF_ID, "--comment", "ok", "--status", "cause_confirmed", "--stage", "network"],
  "--stage",
);
expectError(["answer", "--diff-id", DIFF_ID, "--comment", "ok", "--status", "resolved", "--force"], "unknown flag");

// ── unknown command ────────────────────────────────────────────────────────

expectError(["patch"], "unknown command");

console.log("test-settlement-investigation-cli: all assertions passed");
