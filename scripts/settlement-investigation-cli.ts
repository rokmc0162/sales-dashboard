/**
 * Hermes CLI for settlement comparison investigations.
 *
 *   npm run settlement:investigations -- list --month 202607 [--status question_pending] [--json]
 *   npm run settlement:investigations -- answer --diff-id <UUID> --comment <TEXT> \
 *     --status <investigation_status> [--stage <root_cause_stage>] [--summary <TEXT>]
 *
 * `list` shows matching diffs across every completed comparison run for a month
 * (bounded to 200 rows, each comment thread bounded to 200 rows) with IDs,
 * identity/field, investigation status/stage/summary, and the operator/hermes
 * thread. Storage paths and secrets are never selected or printed.
 *
 * `answer` transactionally appends an author_type=hermes comment and updates
 * the diff's investigation fields.
 *
 * Requires SUPABASE_DATABASE_URL (direct Postgres connection); there is
 * deliberately no anon-key fallback. All SQL uses parameterized tagged
 * templates — never string interpolation.
 */
import postgres from "postgres";

import {
  COMMENT_BODY_MAX_LENGTH,
  COMMENT_LIST_LIMIT,
  DIFF_INVESTIGATION_STATUSES,
  ROOT_CAUSE_STAGES,
  ROOT_CAUSE_SUMMARY_MAX_LENGTH,
} from "../src/features/settlement/lib/comparison/investigation";
import type {
  ComparisonCommentAuthorType,
  ComparisonDiffCategory,
  ComparisonDiffReviewStatus,
  ComparisonInvestigationStatus,
  ComparisonRootCauseStage,
} from "../src/features/settlement/lib/supabase/types";

export const DIFF_LIST_LIMIT = 200;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_ARG_PATTERN = /^\d{6}$/;

export type ListCommand = {
  command: "list";
  month: string; // YYYY-MM-01, matching settlement_comparison_runs.month
  status: ComparisonInvestigationStatus | null;
  json: boolean;
};

export type AnswerCommand = {
  command: "answer";
  diffId: string;
  comment: string;
  status: ComparisonInvestigationStatus;
  stage: ComparisonRootCauseStage | null; // null = leave unchanged
  summary: string | null; // null = leave unchanged
};

export type HelpCommand = { command: "help" };

export type CliParseResult =
  | { ok: true; cmd: ListCommand | AnswerCommand | HelpCommand }
  | { ok: false; error: string };

function parseFlags(
  tokens: string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[],
): { ok: true; flags: Map<string, string | true> } | { ok: false; error: string } {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      return { ok: false, error: `unexpected argument: ${token}` };
    }
    const name = token.slice(2);
    if (flags.has(name)) {
      return { ok: false, error: `duplicate flag: --${name}` };
    }
    if (booleanFlags.includes(name)) {
      flags.set(name, true);
      continue;
    }
    if (!valueFlags.includes(name)) {
      return { ok: false, error: `unknown flag: --${name}` };
    }
    const value = tokens[i + 1];
    if (value === undefined) {
      return { ok: false, error: `--${name} requires a value` };
    }
    flags.set(name, value);
    i += 1;
  }
  return { ok: true, flags };
}

function parseInvestigationStatus(
  value: string | true,
  flag: string,
): ComparisonInvestigationStatus | { error: string } {
  if (
    typeof value !== "string" ||
    !DIFF_INVESTIGATION_STATUSES.includes(value as ComparisonInvestigationStatus)
  ) {
    return { error: `--${flag} must be one of: ${DIFF_INVESTIGATION_STATUSES.join(", ")}` };
  }
  return value as ComparisonInvestigationStatus;
}

/** Pure argv parsing so it is testable without a database connection. */
export function parseCliArgs(argv: string[]): CliParseResult {
  if (argv.length === 0) return { ok: true, cmd: { command: "help" } };
  const [command, ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    return { ok: true, cmd: { command: "help" } };
  }

  if (command === "list") {
    const parsed = parseFlags(rest, ["month", "status"], ["json"]);
    if (!parsed.ok) return parsed;
    const month = parsed.flags.get("month");
    if (typeof month !== "string" || !MONTH_ARG_PATTERN.test(month)) {
      return { ok: false, error: "--month must be YYYYMM (e.g. 202607)" };
    }
    const monthNumber = Number(month.slice(4, 6));
    if (monthNumber < 1 || monthNumber > 12) {
      return { ok: false, error: "--month must have a month part of 01-12" };
    }
    let status: ComparisonInvestigationStatus | null = null;
    const statusRaw = parsed.flags.get("status");
    if (statusRaw !== undefined) {
      const statusResult = parseInvestigationStatus(statusRaw, "status");
      if (typeof statusResult !== "string") return { ok: false, error: statusResult.error };
      status = statusResult;
    }
    return {
      ok: true,
      cmd: {
        command: "list",
        month: `${month.slice(0, 4)}-${month.slice(4, 6)}-01`,
        status,
        json: parsed.flags.get("json") === true,
      },
    };
  }

  if (command === "answer") {
    const parsed = parseFlags(rest, ["diff-id", "comment", "status", "stage", "summary"], []);
    if (!parsed.ok) return parsed;
    const diffId = parsed.flags.get("diff-id");
    if (typeof diffId !== "string" || !UUID_PATTERN.test(diffId)) {
      return { ok: false, error: "--diff-id must be a UUID" };
    }
    const commentRaw = parsed.flags.get("comment");
    if (typeof commentRaw !== "string") {
      return { ok: false, error: "--comment is required" };
    }
    const comment = commentRaw.trim();
    if (comment.length === 0) {
      return { ok: false, error: "--comment must not be blank" };
    }
    if (comment.length > COMMENT_BODY_MAX_LENGTH) {
      return { ok: false, error: `--comment must be at most ${COMMENT_BODY_MAX_LENGTH} characters` };
    }
    const statusRaw = parsed.flags.get("status");
    if (statusRaw === undefined) {
      return { ok: false, error: "--status is required" };
    }
    const statusResult = parseInvestigationStatus(statusRaw, "status");
    if (typeof statusResult !== "string") return { ok: false, error: statusResult.error };
    let stage: ComparisonRootCauseStage | null = null;
    const stageRaw = parsed.flags.get("stage");
    if (stageRaw !== undefined) {
      if (
        typeof stageRaw !== "string" ||
        !ROOT_CAUSE_STAGES.includes(stageRaw as ComparisonRootCauseStage)
      ) {
        return { ok: false, error: `--stage must be one of: ${ROOT_CAUSE_STAGES.join(", ")}` };
      }
      stage = stageRaw as ComparisonRootCauseStage;
    }
    let summary: string | null = null;
    const summaryRaw = parsed.flags.get("summary");
    if (summaryRaw !== undefined) {
      if (typeof summaryRaw !== "string") {
        return { ok: false, error: "--summary requires a value" };
      }
      if (summaryRaw.length > ROOT_CAUSE_SUMMARY_MAX_LENGTH) {
        return {
          ok: false,
          error: `--summary must be at most ${ROOT_CAUSE_SUMMARY_MAX_LENGTH} characters`,
        };
      }
      summary = summaryRaw;
    }
    return {
      ok: true,
      cmd: { command: "answer", diffId, comment, status: statusResult, stage, summary },
    };
  }

  return { ok: false, error: `unknown command: ${command} (expected list, answer, or help)` };
}

function printHelp() {
  console.log(`settlement-investigation-cli — Hermes CLI for comparison diff investigations

Usage:
  npm run settlement:investigations -- list --month YYYYMM [--status <status>] [--json]
  npm run settlement:investigations -- answer --diff-id <UUID> --comment <TEXT> \\
      --status <status> [--stage <stage>] [--summary <TEXT>]
  npm run settlement:investigations -- help

Commands:
  list     Matching diffs across all completed comparison runs for the month
           (max ${DIFF_LIST_LIMIT} diffs, max ${COMMENT_LIST_LIMIT} comments per thread), with IDs,
           identity/field, investigation status/stage/summary, and comments.
  answer   Transactionally append a hermes comment to a diff and update its
           investigation fields.

Values:
  status   ${DIFF_INVESTIGATION_STATUSES.join(" | ")}
  stage    ${ROOT_CAUSE_STAGES.join(" | ")}

Environment:
  SUPABASE_DATABASE_URL   required — direct Postgres connection (no anon fallback)`);
}

type Sql = postgres.Sql;

type CliDiffRow = {
  id: string;
  run_id: string;
  run_created_at: string;
  run_completed_at: string | null;
  category: ComparisonDiffCategory;
  identity_channel: string | null;
  identity_type: string | null;
  identity_title: string | null;
  field: string | null;
  review_status: ComparisonDiffReviewStatus;
  investigation_status: ComparisonInvestigationStatus;
  root_cause_stage: ComparisonRootCauseStage | null;
  root_cause_summary: string | null;
  created_at: string;
};

type CliCommentRow = {
  id: string;
  diff_id: string;
  author_type: ComparisonCommentAuthorType;
  body: string;
  created_at: string;
};

async function runList(sql: Sql, cmd: ListCommand) {
  const fetchedDiffs = cmd.status
    ? await sql<CliDiffRow[]>`
        select
          d.id, d.run_id, r.created_at::text as run_created_at,
          r.completed_at::text as run_completed_at,
          d.category, d.identity_channel, d.identity_type, d.identity_title, d.field,
          d.review_status, d.investigation_status, d.root_cause_stage, d.root_cause_summary,
          d.created_at::text
        from settlement_comparison_diffs d
        join settlement_comparison_runs r on r.id = d.run_id
        where r.month = ${cmd.month}
          and r.status = 'completed'
          and d.investigation_status = ${cmd.status}
        order by r.created_at desc, d.created_at asc, d.id asc
        limit ${DIFF_LIST_LIMIT + 1}
      `
    : await sql<CliDiffRow[]>`
        select
          d.id, d.run_id, r.created_at::text as run_created_at,
          r.completed_at::text as run_completed_at,
          d.category, d.identity_channel, d.identity_type, d.identity_title, d.field,
          d.review_status, d.investigation_status, d.root_cause_stage, d.root_cause_summary,
          d.created_at::text
        from settlement_comparison_diffs d
        join settlement_comparison_runs r on r.id = d.run_id
        where r.month = ${cmd.month}
          and r.status = 'completed'
        order by r.created_at desc, d.created_at asc, d.id asc
        limit ${DIFF_LIST_LIMIT + 1}
      `;

  const diffsTruncated = fetchedDiffs.length > DIFF_LIST_LIMIT;
  const diffs = fetchedDiffs.slice(0, DIFF_LIST_LIMIT);
  if (diffs.length === 0) {
    if (cmd.json) {
      console.log(JSON.stringify({ month: cmd.month, diffs: [] }, null, 2));
    } else {
      console.log(`no matching completed-run differences for ${cmd.month.slice(0, 7)}`);
    }
    return;
  }

  const diffIds = diffs.map((diff) => diff.id);
  const rankedComments = await sql<(CliCommentRow & { thread_rank: number })[]>`
    with ranked as (
      select id, diff_id, author_type, body, created_at,
             row_number() over (
               partition by diff_id order by created_at desc, id desc
             )::int as thread_rank
      from settlement_comparison_comments
      where diff_id in ${sql(diffIds)}
    )
    select id, diff_id, author_type, body, created_at::text, thread_rank
    from ranked
    where thread_rank <= ${COMMENT_LIST_LIMIT + 1}
    order by diff_id asc, created_at asc, id asc
  `;

  const commentsByDiff = new Map<string, CliCommentRow[]>();
  const commentsTruncatedByDiff = new Set<string>();
  for (const diffId of diffIds) {
    const thread = rankedComments.filter((comment) => comment.diff_id === diffId);
    if (thread.length > COMMENT_LIST_LIMIT) commentsTruncatedByDiff.add(diffId);
    commentsByDiff.set(diffId, thread.slice(-COMMENT_LIST_LIMIT));
  }

  if (cmd.json) {
    console.log(
      JSON.stringify(
        {
          month: cmd.month,
          diff_count: diffs.length,
          diff_limit: DIFF_LIST_LIMIT,
          diffs_truncated: diffsTruncated,
          comment_limit_per_diff: COMMENT_LIST_LIMIT,
          diffs: diffs.map((diff) => ({
            ...diff,
            comments_truncated: commentsTruncatedByDiff.has(diff.id),
            comments: commentsByDiff.get(diff.id) ?? [],
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`month ${cmd.month.slice(0, 7)} · all completed comparison runs`);
  console.log(
    `diffs: ${diffs.length}${cmd.status ? ` (status=${cmd.status})` : ""}` +
      (diffsTruncated ? ` — truncated at ${DIFF_LIST_LIMIT}` : ""),
  );
  for (const diff of diffs) {
    console.log("");
    console.log(`◆ ${diff.id} · run ${diff.run_id} · completed ${diff.run_completed_at ?? "-"}`);
    console.log(
      `  identity: ${diff.identity_channel ?? "-"} / ${diff.identity_type ?? "-"} / ${diff.identity_title ?? "-"}`,
    );
    console.log(
      `  category: ${diff.category} · field: ${diff.field ?? "-"} · review: ${diff.review_status}`,
    );
    console.log(
      `  investigation: ${diff.investigation_status} · stage: ${diff.root_cause_stage ?? "-"} · summary: ${diff.root_cause_summary ?? "-"}`,
    );
    if (commentsTruncatedByDiff.has(diff.id)) {
      console.log(`  … older comments omitted (showing newest ${COMMENT_LIST_LIMIT})`);
    }
    for (const comment of commentsByDiff.get(diff.id) ?? []) {
      console.log(`  [${comment.author_type} | ${comment.created_at}] ${comment.body}`);
    }
  }
}

async function runAnswer(sql: Sql, cmd: AnswerCommand) {
  const result = (await sql.begin(async (tx) => {
    const trx = tx as unknown as Sql;
    const parent = await trx<{ id: string }[]>`
      select id
      from settlement_comparison_diffs
      where id = ${cmd.diffId}
      for update
    `;
    if (!parent[0]) return null;
    const commentRows = await trx<{ id: string; created_at: string }[]>`
      insert into settlement_comparison_comments (diff_id, author_type, body)
      values (${cmd.diffId}, 'hermes', ${cmd.comment})
      returning id, created_at::text
    `;
    const diffRows = await trx<
      Pick<CliDiffRow, "id" | "investigation_status" | "root_cause_stage" | "root_cause_summary">[]
    >`
      update settlement_comparison_diffs
      set investigation_status = ${cmd.status},
          root_cause_stage = case
            when ${cmd.stage !== null} then ${cmd.stage}
            else root_cause_stage
          end,
          root_cause_summary = case
            when ${cmd.summary !== null} then ${cmd.summary}
            else root_cause_summary
          end
      where id = ${cmd.diffId}
      returning id, investigation_status, root_cause_stage, root_cause_summary
    `;
    return { comment: commentRows[0], diff: diffRows[0] };
  })) as { comment: { id: string; created_at: string }; diff: Pick<CliDiffRow, "id" | "investigation_status" | "root_cause_stage" | "root_cause_summary"> } | null;

  if (!result) {
    throw new Error("diff not found");
  }
  console.log(`answered diff ${result.diff.id}`);
  console.log(`  comment: ${result.comment.id} (hermes, ${result.comment.created_at})`);
  console.log(
    `  investigation: ${result.diff.investigation_status} · stage: ${result.diff.root_cause_stage ?? "-"} · summary: ${result.diff.root_cause_summary ?? "-"}`,
  );
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`error: ${parsed.error}`);
    console.error("run with --help for usage");
    process.exitCode = 1;
    return;
  }
  const cmd = parsed.cmd;
  if (cmd.command === "help") {
    printHelp();
    return;
  }
  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) {
    console.error(
      "error: SUPABASE_DATABASE_URL is required (direct Postgres connection; no anon-key fallback)",
    );
    process.exitCode = 1;
    return;
  }
  const sql = postgres(url, { max: 1, prepare: false, ssl: "require" });
  try {
    if (cmd.command === "list") await runList(sql, cmd);
    else await runAnswer(sql, cmd);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only run when invoked as the entry script; importing parseCliArgs from the
// arg-validation tests must never run main. The path boundary keeps
// test-settlement-investigation-cli.ts from matching.
const entryScript = process.argv[1] ?? "";
if (/(^|[\\/])settlement-investigation-cli\.(ts|js|mjs|cjs)$/.test(entryScript)) {
  void main();
}
