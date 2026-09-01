import {
  assertSelfHealingDemoAccepted,
  formatSelfHealingDemo,
  runDeterministicSelfHealingDemo,
  runDeterministicSelfHealingScenario,
  type SelfHealingScenario,
} from "./self-healing-demo-fixture.js";

try {
  const requestedScenario = process.env.LAUNCHPAD_SELF_HEALING_DEMO_SCENARIO;
  const allowedScenarios = new Set<SelfHealingScenario>([
    "success", "normal_success", "evaluator_unavailable", "all_candidates_fail",
    "consumer_regression", "expensive_tie", "malformed_diagnosis", "checkpoint_failure",
    "authority_compromise", "promotion_conflict", "post_gate_rollback",
  ]);
  if (requestedScenario !== undefined && !allowedScenarios.has(requestedScenario as SelfHealingScenario)) {
    throw new Error("unknown self-healing demo scenario: " + requestedScenario);
  }
  const result = requestedScenario === undefined
    ? await runDeterministicSelfHealingDemo()
    : await runDeterministicSelfHealingScenario(requestedScenario as SelfHealingScenario);
  process.stdout.write(formatSelfHealingDemo(result) + "\n");
  assertSelfHealingDemoAccepted(result);
  process.exitCode = 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write("self-healing demo failed: " + message + "\n");
  process.exitCode = 1;
}
