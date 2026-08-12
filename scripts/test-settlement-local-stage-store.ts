import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { LocalParseStageError, type LocalParseStageResult } from "../src/features/settlement/lib/worker/local-parse-stage";
import { persistLocalParseStage } from "../src/features/settlement/lib/worker/local-stage-store";

const STAGE: LocalParseStageResult = {
  schemaVersion: 1,
  settlementMonth: "2026-07-01",
  files: [], rawRows: [], salesRows: [],
  counts: { files: 0, rawRows: 0, salesRows: 0, summaryFiles: 0 },
  digest: "448aae0ed13aa2cf514fc5ac81815d7d5dc29d6383ff9937bf8883ca13dd93e6",
};

async function expectCode(run: () => Promise<unknown>, code: string) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof LocalParseStageError);
    assert.equal(error.code, code);
    return true;
  });
}

async function main(): Promise<void> {
  const created = await fsp.mkdtemp(path.join(os.tmpdir(), "local-stage-store-"));
  const root = await fsp.realpath(created);
  await fsp.chmod(root, 0o700);
  try {
    const first = await persistLocalParseStage({ workRoot: root, runId: "run-1", stage: STAGE });
    assert.equal(first.reused, false);
    assert.equal((await fsp.stat(first.stagingDir)).mode & 0o777, 0o700);
    assert.equal((await fsp.stat(first.stagePath)).mode & 0o777, 0o600);

    await fsp.mkdir(path.join(root, "runs", "run-empty", "staging"), { recursive: true, mode: 0o700 });
    const resumedEmpty = await persistLocalParseStage({ workRoot: root, runId: "run-empty", stage: STAGE });
    assert.equal(resumedEmpty.reused, false, "a crash-left empty staging directory must resume safely");

    const concurrent = await Promise.all(Array.from({ length: 4 }, () => persistLocalParseStage({ workRoot: root, runId: "run-race", stage: STAGE })));
    assert.equal(new Set(concurrent.map((result) => result.sha256)).size, 1, "concurrent no-clobber writers must converge");
    const replay = await persistLocalParseStage({ workRoot: root, runId: "run-1", stage: STAGE });
    assert.equal(replay.reused, true);
    assert.equal(replay.sha256, first.sha256);

    await fsp.writeFile(path.join(first.stagingDir, "unexpected"), "x");
    await expectCode(() => persistLocalParseStage({ workRoot: root, runId: "run-1", stage: STAGE }), "SOURCE_CHANGED");
    await fsp.rm(path.join(first.stagingDir, "unexpected"));
    await fsp.writeFile(first.stagePath, "{}");
    await expectCode(() => persistLocalParseStage({ workRoot: root, runId: "run-1", stage: STAGE }), "SOURCE_CHANGED");
    await expectCode(() => persistLocalParseStage({ workRoot: root, runId: "../bad", stage: STAGE }), "INVALID_INPUT");
    await expectCode(() => persistLocalParseStage({ workRoot: root, runId: "run-2", stage: { ...STAGE, digest: "0".repeat(64) } }), "INVALID_STAGE_VALUE");
    console.log("test-settlement-local-stage-store: all assertions passed");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
