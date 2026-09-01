import { describe, expect, it } from "vitest";
import { LiveDagAdmission } from "../src/orchestration/live-dag-admission.js";
import type { ContractCatalogEntry } from "../src/orchestration/healing/contract-compiler.js";
import { emptyHealingState } from "../src/types.js";
import type { OrchestrationState } from "../src/types.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";

const catalog: ContractCatalogEntry[] = [
  {
    contractKey: "backend-producer",
    allowedInputs: ["docs/api.md"],
    allowedOutputs: ["src/api.ts"],
    allowedMutationPaths: ["src/api.ts"],
    protectedPaths: [".launchpad"],
    artifactSchemaIds: ["backend-schema"],
    targetedGateIds: ["backend-targeted"],
    contractGateIds: ["backend-contract"],
    consumerGateIds: ["backend-consumer"],
    regressionGateIds: ["backend-regression"],
    authorizedTools: ["read_file"],
  },
  {
    contractKey: "integration-consumer",
    allowedInputs: ["src/api.ts"],
    allowedOutputs: ["tests/integration.test.ts"],
    allowedMutationPaths: ["tests/integration.test.ts"],
    protectedPaths: [".launchpad"],
    artifactSchemaIds: ["integration-schema"],
    targetedGateIds: ["integration-targeted"],
    contractGateIds: ["integration-contract"],
    consumerGateIds: ["integration-consumer-gate"],
    regressionGateIds: ["integration-regression"],
    authorizedTools: ["read_file"],
  },
];

function emptyState(): OrchestrationState {
  return {
    phase: "executing",
    iteration: 1,
    iterationPlans: [
      {
        iteration: 1,
        createdAt: "2026-08-29T00:00:00.000Z",
        reason: "leader_codex",
        plan: {
          needsSubagents: true,
          rationale: "live",
          subtasks: [],
        },
      },
    ],
    evaluationRecords: [],
    workerResults: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, workerRuns: 0 },
    policySnapshot: defaultExecutionPolicy,
    provenance: {
      harnessVersion: "orchestration-1",
      plannerPromptVersion: "planner-v1",
      evaluatorPromptVersion: "evaluator-v1",
      replannerPromptVersion: "replanner-v1",
      synthesizerPromptVersion: "synthesizer-v1",
    },
    healing: emptyHealingState(),
  };
}

describe("LiveDagAdmission", () => {
  it("refuses a planned graph admission without mutation while a repair fence is active", () => {
    const admission = new LiveDagAdmission(catalog);
    const state = emptyState();
    state.healing.repairGraphFence = {
      runId: "run-1",
      tournamentId: "tournament-1",
      graphRevision: 0,
      graphHash: "a".repeat(64),
      contractHashes: [],
      admittedAt: "2026-08-31T00:00:00.000Z",
    };
    const before = structuredClone(state.healing);
    const result = (admission as LiveDagAdmission & {
      tryAdmitPlan(state: OrchestrationState, plan: OrchestrationState["iterationPlans"][number]["plan"]):
        { ok: false; error: "repair_graph_frozen" };
    }).tryAdmitPlan(state, {
      needsSubagents: true,
      rationale: "late replan",
      subtasks: [{
        id: "backend",
        role: "backend",
        prompt: "write api",
        dependsOn: [],
        contractKey: "backend-producer",
        outputs: ["src/api.ts"],
      }],
    });

    expect(result).toEqual({ ok: false, error: "repair_graph_frozen" });
    expect(state.healing).toEqual(before);
  });

  it("compiles a unique dispatch, appends the consumer to its producer, and bumps revision", () => {
    const admission = new LiveDagAdmission(catalog);
    const state = emptyState();
    const backend = admission.admit(state, {
      id: "backend",
      prompt: "write api",
      contractKey: "backend-producer",
      outputs: ["src/api.ts"],
      mutationPaths: ["src/api.ts"],
    }, "2026-08-29T00:00:00.000Z");
    expect(backend.contract.revision).toBe(1);
    expect(backend.startWorker).toBe(true);
    expect(backend.node.state).toBe("ready");

    const integration = admission.admit(state, {
      id: "integration",
      prompt: "write tests",
      contractKey: "integration-consumer",
      dependsOn: ["backend"],
      inputs: ["src/api.ts"],
      outputs: ["tests/integration.test.ts"],
    }, "2026-08-29T00:00:01.000Z");
    expect(integration.startWorker).toBe(false);
    expect(integration.node.state).toBe("blocked");
    expect(integration.node.blockedBy).toEqual(["backend"]);
    expect(state.healing.contracts.find((item) => item.subtaskId === "backend")).toMatchObject({
      revision: 2,
      downstreamConsumers: ["integration"],
    });
    expect(state.iterationPlans[0]?.plan.subtasks[0]?.prompt).toBe("write api");
    expect(state.healing.contracts.find((item) => item.subtaskId === "integration")?.revision).toBe(1);
    expect(state.healing.nodes.find((item) => item.subtaskId === "backend")?.revision).toBe(2);
  });

  it("does not rewrite an existing node's revision downward when a later consumer is admitted", () => {
    const admission = new LiveDagAdmission(catalog);
    const state = emptyState();
    admission.admit(state, {
      id: "backend",
      prompt: "write api",
      contractKey: "backend-producer",
    });
    const backend = state.healing.nodes.find((item) => item.subtaskId === "backend")!;
    backend.revision = 5;
    admission.admit(state, {
      id: "integration",
      prompt: "write tests",
      contractKey: "integration-consumer",
      dependsOn: ["backend"],
    });
    expect(state.healing.contracts.find((item) => item.subtaskId === "backend")?.revision).toBe(2);
    expect(state.healing.nodes.find((item) => item.subtaskId === "backend")?.revision).toBe(5);
  });

  it("gives anonymous dispatches a UUID fallback so a colliding ordinal does not wedge admission", () => {
    const admission = new LiveDagAdmission(catalog);
    const state = emptyState();
    admission.admit(state, {
      id: "leader-dispatch-1",
      prompt: "named",
      contractKey: "backend-producer",
    });
    const anonymous = admission.admit(state, {
      prompt: "anonymous worker",
      contractKey: "integration-consumer",
    });
    expect(anonymous.subtask.id).toMatch(/^leader-dispatch-2-[0-9a-f]{8}$/);
    expect(anonymous.subtask.id).not.toBe("leader-dispatch-1");
  });

  it("rejects an empty catalog before any admit", () => {
    expect(() => new LiveDagAdmission([])).toThrow(/missing contract catalog/i);
  });

  it("rejects a duplicate dispatch id instead of replacing the admitted node", () => {
    const admission = new LiveDagAdmission(catalog);
    const state = emptyState();
    admission.admit(state, {
      id: "backend",
      prompt: "write api",
      contractKey: "backend-producer",
    });
    const snapshot = structuredClone(state.healing);
    expect(() =>
      admission.admit(state, {
        id: "backend",
        prompt: "rewrite api with a different prompt",
        contractKey: "backend-producer",
      }),
    ).toThrow(/already admitted/i);
    expect(state.healing).toEqual(snapshot);
    expect(state.iterationPlans[0]?.plan.subtasks[0]?.prompt).toBe("write api");
  });

  it("rejects dependsOn ids that have not been admitted", () => {
    const admission = new LiveDagAdmission(catalog);
    const state = emptyState();
    expect(() =>
      admission.admit(state, {
        id: "integration",
        prompt: "write tests",
        contractKey: "integration-consumer",
        dependsOn: ["backend"],
      }),
    ).toThrow(/not admitted/i);
  });

  it("rejects gate IDs, verifier commands, protected-path exceptions, permissions, timeout extensions, and budgets", () => {
    const admission = new LiveDagAdmission(catalog);
    const state = emptyState();
    expect(() =>
      admission.admit(state, {
        id: "backend",
        prompt: "write api",
        contractKey: "backend-producer",
        targetedGateIds: ["model-chosen"],
      } as never),
    ).toThrow(/gate/i);
    expect(() =>
      admission.admit(state, {
        id: "backend",
        prompt: "write api",
        contractKey: "backend-producer",
        rawCommand: "rm -rf /",
      } as never),
    ).toThrow(/verifier|rawCommand|command/i);
  });
});
