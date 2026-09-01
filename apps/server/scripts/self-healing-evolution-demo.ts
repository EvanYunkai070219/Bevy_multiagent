import { pathToFileURL } from "node:url";
import {
  runProductionEvolutionDemo,
  type ProductionEvolutionDemoResult,
} from "./self-healing-demo-fixture.js";

export type SelfHealingEvolutionDemoResult = ProductionEvolutionDemoResult;

export const runDeterministicSelfHealingEvolutionDemo = runProductionEvolutionDemo;

export function assertSelfHealingEvolutionDemoAccepted(result: SelfHealingEvolutionDemoResult): void {
  const failures = [
    ...(result.fixture === "accepted-m2-production-path" ? [] : ["fixture"]),
    ...(result.firstRun.candidateExecutions === 3 ? [] : ["first exploration"]),
    ...(result.repeatRun.pruned > 0 &&
      result.repeatRun.candidateExecutions + result.repeatRun.pruned === 3 ? [] : ["exact repeat"]),
    ...(result.changedRun.candidateExecutions === 3 && result.changedRun.pruned === 0
      ? [] : ["changed exploration"]),
    ...(result.analogousCue.pruned === 0 && result.analogousCue.cues >= 1 &&
      result.analogousCue.cues <= 3 && result.analogousCue.capsules === 0
      ? [] : ["analogous cue"]),
    ...(result.branchReturn.capsules > 0 && result.branchReturn.pruned > 0 &&
      result.branchReturn.returned > 0 && result.branchReturn.successfulSiblingIntegrated
      ? [] : ["branch return"]),
    ...(result.projectIsolation.projectId !== result.projectId &&
      result.projectIsolation.pruned === 0 && result.projectIsolation.cues === 0
      ? [] : ["Project isolation"]),
    ...(result.exclusions.cancellation.quarantined &&
      result.exclusions.cancellation.quarantineReason === "schema_invalid" &&
      result.exclusions.cancellation.pruned === 0 && result.exclusions.cancellation.cues === 0 &&
      result.exclusions.cancellation.capsules === 0 &&
      result.exclusions.malformedEvidence.quarantined &&
      result.exclusions.malformedEvidence.quarantineReason === "evidence_reference_invalid" &&
      result.exclusions.malformedEvidence.pruned === 0 &&
      result.exclusions.malformedEvidence.cues === 0 &&
      result.exclusions.malformedEvidence.capsules === 0
      ? [] : ["historical exclusions"]),
    ...(!result.reconciliation.pending && result.reconciliation.droppedHistoryCount === 0
      ? [] : ["reconciliation"]),
    ...(result.projection.counts.executed > 0 ? [] : ["projection"]),
    ...(result.sourceIntegrity ? [] : ["source integrity"]),
  ];
  if (failures.length > 0) {
    throw new Error("self-healing evolution demo acceptance failed: " + failures.join(", "));
  }
}

export function formatSelfHealingEvolutionDemo(result: SelfHealingEvolutionDemoResult): string {
  return [
    "fixture=accepted-m2-production-path",
    "run_1=detect -> diagnose -> tournament -> execute -> verify -> integrate",
    "run_2=restart -> exact history -> prune trusted negatives",
    "run_3=changed diagnosis context -> explore again",
    `project_id=${result.projectId}`,
    `run_ids=${result.runIds.join(",")}`,
    `first_executed=${result.firstRun.candidateExecutions}`,
    `repeat_pruned=${result.repeatRun.pruned}`,
    `changed_executed=${result.changedRun.candidateExecutions}`,
    `changed_pruned=${result.changedRun.pruned}`,
    `analogous_pruned=${result.analogousCue.pruned}`,
    `analogous_cues=${result.analogousCue.cues}`,
    `analogous_capsules=${result.analogousCue.capsules}`,
    `branch_capsules=${result.branchReturn.capsules}`,
    `branch_pruned=${result.branchReturn.pruned}`,
    `branch_returned=${result.branchReturn.returned}`,
    `successful_sibling_integrated=${result.branchReturn.successfulSiblingIntegrated}`,
    `cancelled_quarantine=${result.exclusions.cancellation.quarantineReason ?? "none"}`,
    `cancelled_pruned=${result.exclusions.cancellation.pruned}`,
    `cancelled_cues=${result.exclusions.cancellation.cues}`,
    `cancelled_capsules=${result.exclusions.cancellation.capsules}`,
    `malformed_quarantine=${result.exclusions.malformedEvidence.quarantineReason ?? "none"}`,
    `malformed_pruned=${result.exclusions.malformedEvidence.pruned}`,
    `malformed_cues=${result.exclusions.malformedEvidence.cues}`,
    `malformed_capsules=${result.exclusions.malformedEvidence.capsules}`,
    `isolated_project_id=${result.projectIsolation.projectId}`,
    `isolated_project_pruned=${result.projectIsolation.pruned}`,
    `isolated_project_cues=${result.projectIsolation.cues}`,
    `reconciliation_pending=${result.reconciliation.pending}`,
    `dropped_history=${result.reconciliation.droppedHistoryCount}`,
    `nodes=${result.projection.nodes}`,
    `observations=${result.projection.observations}`,
    `history_sync=${result.projection.syncState}`,
    `branch=${result.runBranch}`,
    `base_commit=${result.baseCommit}`,
    `head_commit=${result.headCommit}`,
    `user_branch_integrity=${result.sourceIntegrity}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const result = await runDeterministicSelfHealingEvolutionDemo();
  assertSelfHealingEvolutionDemoAccepted(result);
  process.stdout.write(formatSelfHealingEvolutionDemo(result) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
