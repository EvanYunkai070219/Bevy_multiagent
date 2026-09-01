import { describe, expect, it } from "vitest";
import {
  compileContracts,
  type ContractCatalogEntry,
} from "../src/orchestration/healing/contract-compiler.js";
import type { LeaderPlan } from "../src/types.js";

const catalog: ContractCatalogEntry[] = [
  {
    contractKey: "backend-producer",
    allowedInputs: ["docs/api.md", "docs/schema.md"],
    allowedOutputs: ["src/api.ts", "src/db.ts"],
    allowedMutationPaths: ["src/api.ts", "src/db.ts"],
    protectedPaths: [".launchpad", "package-lock.json"],
    artifactSchemaIds: ["backend-schema"],
    targetedGateIds: ["backend-targeted"],
    contractGateIds: ["backend-contract"],
    consumerGateIds: ["backend-consumer"],
    regressionGateIds: ["backend-regression"],
    authorizedTools: ["read_file", "search_files"],
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

function subtask(
  id: string,
  extras: Partial<{
    contractKey: string;
    inputs: string[];
    outputs: string[];
    mutationPaths: string[];
    dependsOn: string[];
  }> = {},
) {
  return {
    id,
    title: id,
    role: id,
    prompt: "do " + id,
    objective: id,
    successCriteria: ["done"],
    expectedOutput: "files",
    dependsOn: extras.dependsOn ?? [],
    contractKey: extras.contractKey,
    inputs: extras.inputs,
    outputs: extras.outputs,
    mutationPaths: extras.mutationPaths,
  };
}

function plan(subtasks: ReturnType<typeof subtask>[]): LeaderPlan {
  return { needsSubagents: true, rationale: "split", subtasks };
}

describe("compileContracts", () => {
  it("derives consumers from dependsOn, attaches catalog gates, and sorts paths", () => {
    const compiled = compileContracts(
      plan([
        subtask("backend", {
          contractKey: "backend-producer",
          inputs: ["docs/schema.md", "docs/api.md", "docs/api.md"],
          outputs: ["src/db.ts", "src/api.ts"],
          mutationPaths: ["src/db.ts", "src/api.ts"],
        }),
        subtask("integration", {
          contractKey: "integration-consumer",
          inputs: ["src/api.ts"],
          outputs: ["tests/integration.test.ts"],
          mutationPaths: ["tests/integration.test.ts"],
          dependsOn: ["backend"],
        }),
      ]),
      catalog,
    );
    expect(compiled.contracts[0]).toMatchObject({
      subtaskId: "backend",
      revision: 1,
      dependencyIds: [],
      downstreamConsumers: ["integration"],
      targetedGateIds: ["backend-targeted"],
      consumerGateIds: ["backend-consumer"],
    });
    expect(compiled.contracts[0]?.inputs).toEqual(["docs/api.md", "docs/schema.md"]);
    expect(compiled.contracts[0]?.outputs).toEqual(["src/api.ts", "src/db.ts"]);
    expect(compiled.nodes[0]).toMatchObject({
      subtaskId: "backend",
      revision: 1,
      state: "pending",
      blockedBy: [],
    });
    expect(compiled.contracts[1]).toMatchObject({
      subtaskId: "integration",
      dependencyIds: ["backend"],
      downstreamConsumers: [],
    });
  });

  it("rejects an unknown contract key", () => {
    expect(() =>
      compileContracts(
        plan([subtask("backend", { contractKey: "not-in-catalog" })]),
        catalog,
      ),
    ).toThrow(/unknown contract key/i);
  });

  it("rejects absolute paths, parent segments, protected paths, and undeclared outputs", () => {
    expect(() =>
      compileContracts(
        plan([
          subtask("backend", {
            contractKey: "backend-producer",
            outputs: ["/etc/passwd"],
          }),
        ]),
        catalog,
      ),
    ).toThrow(/absolute path/i);
    expect(() =>
      compileContracts(
        plan([
          subtask("backend", {
            contractKey: "backend-producer",
            mutationPaths: ["src/../secrets"],
          }),
        ]),
        catalog,
      ),
    ).toThrow(/\.\./);
    expect(() =>
      compileContracts(
        plan([
          subtask("backend", {
            contractKey: "backend-producer",
            mutationPaths: [".launchpad"],
          }),
        ]),
        catalog,
      ),
    ).toThrow(/protected path/i);
    expect(() =>
      compileContracts(
        plan([
          subtask("backend", {
            contractKey: "backend-producer",
            outputs: ["src/undeclared.ts"],
          }),
        ]),
        catalog,
      ),
    ).toThrow(/undeclared output/i);
  });

  it("rejects duplicate node IDs and a changed dependency set", () => {
    expect(() =>
      compileContracts(
        plan([
          subtask("backend", { contractKey: "backend-producer" }),
          subtask("backend", { contractKey: "backend-producer" }),
        ]),
        catalog,
      ),
    ).toThrow(/duplicate/i);
    const first = compileContracts(
      plan([
        subtask("backend", { contractKey: "backend-producer" }),
        subtask("integration", {
          contractKey: "integration-consumer",
          dependsOn: ["backend"],
        }),
      ]),
      catalog,
    );
    expect(() =>
      compileContracts(
        plan([
          subtask("backend", { contractKey: "backend-producer" }),
          subtask("integration", {
            contractKey: "integration-consumer",
            dependsOn: [],
          }),
        ]),
        catalog,
        first.contracts,
      ),
    ).toThrow(/dependency set/i);
  });

  it("does not take gate IDs or extra paths from the model", () => {
    const compiled = compileContracts(
      plan([
        subtask("backend", {
          contractKey: "backend-producer",
          inputs: ["docs/api.md"],
          outputs: ["src/api.ts"],
          mutationPaths: ["src/api.ts"],
        }),
      ]),
      catalog,
    );
    expect(compiled.contracts[0]?.targetedGateIds).toEqual(["backend-targeted"]);
    expect(compiled.contracts[0]?.authorizedTools).toEqual(["read_file", "search_files"]);
    expect(compiled.contracts[0]?.protectedPaths).toEqual([".launchpad", "package-lock.json"]);
  });
});
