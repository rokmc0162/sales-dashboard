export type WorkerCycleResult =
  | { kind: "version"; outcome: string }
  | { kind: "legacy"; outcome: string }
  | { kind: "idle" };

export interface SettlementWorkerCycleDependencies<VersionRun, LegacyJob> {
  versionEnabled: boolean;
  claimVersion(): Promise<VersionRun | null>;
  runVersion(run: VersionRun): Promise<{ outcome: string }>;
  claimLegacy(): Promise<LegacyJob | null>;
  runLegacy(job: LegacyJob): Promise<{ outcome: string }>;
}

// Version and legacy claims remain mutually exclusive in SQL. When version
// processing is explicitly enabled, prefer it for one poll cycle; never claim
// a legacy job after already claiming a version run.
export async function runSettlementWorkerCycle<VersionRun, LegacyJob>(
  deps: SettlementWorkerCycleDependencies<VersionRun, LegacyJob>,
): Promise<WorkerCycleResult> {
  if (deps.versionEnabled) {
    const run = await deps.claimVersion();
    if (run) {
      const result = await deps.runVersion(run);
      return { kind: "version", outcome: result.outcome };
    }
  }
  const job = await deps.claimLegacy();
  if (!job) return { kind: "idle" };
  const result = await deps.runLegacy(job);
  return { kind: "legacy", outcome: result.outcome };
}
