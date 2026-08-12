import assert from "node:assert/strict";

import { runSettlementWorkerCycle } from "../src/features/settlement/lib/worker/worker-cycle";

async function main(): Promise<void> {
  const calls: string[] = [];
  const version = await runSettlementWorkerCycle({
    versionEnabled: true,
    claimVersion: async () => { calls.push("claim-version"); return { id: "run" }; },
    runVersion: async () => { calls.push("run-version"); return { outcome: "snapshot_ready" }; },
    claimLegacy: async () => { calls.push("claim-legacy"); return { id: "job" }; },
    runLegacy: async () => { calls.push("run-legacy"); return { outcome: "completed" }; },
  });
  assert.deepEqual(version, { kind: "version", outcome: "snapshot_ready" });
  assert.deepEqual(calls, ["claim-version", "run-version"]);

  calls.length = 0;
  const legacy = await runSettlementWorkerCycle({
    versionEnabled: true,
    claimVersion: async () => { calls.push("claim-version"); return null; },
    runVersion: async () => { throw new Error("must not run"); },
    claimLegacy: async () => { calls.push("claim-legacy"); return { id: "job" }; },
    runLegacy: async () => { calls.push("run-legacy"); return { outcome: "completed" }; },
  });
  assert.deepEqual(legacy, { kind: "legacy", outcome: "completed" });
  assert.deepEqual(calls, ["claim-version", "claim-legacy", "run-legacy"]);

  calls.length = 0;
  const disabled = await runSettlementWorkerCycle({
    versionEnabled: false,
    claimVersion: async () => { calls.push("claim-version"); return { id: "run" }; },
    runVersion: async () => { calls.push("run-version"); return { outcome: "snapshot_ready" }; },
    claimLegacy: async () => { calls.push("claim-legacy"); return null; },
    runLegacy: async () => { calls.push("run-legacy"); return { outcome: "completed" }; },
  });
  assert.deepEqual(disabled, { kind: "idle" });
  assert.deepEqual(calls, ["claim-legacy"]);
  console.log("test-settlement-worker-cycle: all assertions passed");
}
void main();
