import { describe, expect, it } from "vitest";
import {
  formatSelfHealingEvolutionDemo,
  runDeterministicSelfHealingEvolutionDemo,
} from "../scripts/self-healing-evolution-demo.js";

describe("Milestone 3 one-command evolution demo", () => {
  it("prints repeat/change/lineage decisions and operator integrity evidence", async () => {
    const result = await runDeterministicSelfHealingEvolutionDemo();
    const output = formatSelfHealingEvolutionDemo(result);
    for (const line of [
      "fixture=accepted-m2-production-path",
      "run_1=detect -> diagnose -> tournament -> execute -> verify -> integrate",
      "run_2=restart -> exact history -> prune trusted negatives",
      "run_3=changed diagnosis context -> explore again",
    ]) expect(output).toContain(line);
    for (const label of [
      "project_id", "run_ids", "first_executed", "repeat_pruned", "changed_executed",
      "nodes", "observations", "history_sync", "branch", "base_commit", "head_commit",
      "user_branch_integrity",
    ]) expect(output).toContain(label + "=");
    expect(output).not.toMatch(/ARK_API_KEY|owner\.json|\.volc-agent-launchpad|fixture-secret/i);
  }, 120_000);
});
