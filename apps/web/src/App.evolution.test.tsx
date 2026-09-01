// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { AgentRun, EvolutionProjection } from "./types";

vi.mock("./CoordinationPanel", () => ({ CoordinationPanel: () => null }));
vi.mock("./WorkerTrajectories", () => ({ WorkerTrajectories: () => null }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function evolution(declared: number): EvolutionProjection {
  return {
    syncState: "pending",
    historyHealth: { droppedHistoryCount: 0, droppedReason: null, reconciliationPending: true },
    primaryFault: null,
    warningLevel: null,
    terminalReason: null,
    runBranch: "launchpad/run/run-1",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    counts: {
      declared,
      prunedDuplicate: 0,
      admitted: 0,
      executed: 0,
      verified: 0,
      promoted: 0,
      rolledBack: 0,
      branchPruned: 0,
      branchReturned: 0,
      historicalEvidenceUsed: 0,
    },
    nodes: [], edges: [], observations: [], cues: [], transfers: [], capsules: [], branchReturns: [], quarantines: [],
    nextCursor: null,
  };
}

describe("App evolution loading", () => {
  it("refreshes bounded evolution while the selected run remains running", async () => {
    vi.useFakeTimers();
    const run = {
      id: "run-1",
      agentId: "agent-1",
      projectId: "project-1",
      kind: "orchestration",
      parentRunId: null,
      status: "running",
      prompt: "repair",
      output: null,
      error: null,
      usage: null,
      createdAt: "2026-08-30T00:00:00.000Z",
      startedAt: "2026-08-30T00:00:01.000Z",
      completedAt: null,
      workspaceSource: { mode: "existing_repository", repositoryPath: "/repo", revision: "main" },
      project: {
        source: {
          mode: "existing_repository", repositoryPath: "/repo", requestedRevision: "main",
          baseCommit: "a".repeat(40), sourceFingerprint: "s".repeat(64),
        },
        runBranch: "launchpad/run/run-1", canonicalWorkspacePath: "/worktree",
        headCommit: "b".repeat(40), state: "ready", attempts: [], integrations: [],
      },
      orchestration: {
        phase: "executing", iteration: 1, iterationPlans: [], evaluationRecords: [], workerResults: [],
        provenance: { harnessVersion: "m3" },
      },
    } as AgentRun;
    let evolutionReads = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown;
      if (url === "/api/auth") body = { required: false };
      else if (url === "/api/agents") body = { agents: [{
        id: "agent-1", name: "Repair agent", description: "", instructions: "", status: "busy",
        role: "leader", parentAgentId: null, specialty: null, projectId: "project-1",
        unassignedPlacement: null, workspacePath: "/worktree", codexThreadId: null,
        lastError: null, createdAt: run.createdAt, updatedAt: run.createdAt,
      }] };
      else if (url === "/api/projects") body = { projects: [{
        id: "project-1", displayName: "CodeJam", sourceKind: "external", repositoryPath: "/repo",
        baselineBranch: "main", baselineCommit: "a".repeat(40), state: "ready", lastError: null,
        createdAt: run.createdAt, updatedAt: run.createdAt,
      }] };
      else if (url === "/api/system") body = {
        arkConfigured: true, arkBaseUrl: "", arkModel: "test", codexAvailable: true,
        codexSandboxMode: "workspace-write", runtimeProvider: "local-process",
        containerEngine: null, runtime: "test", pricing: null,
      };
      else if (url === "/api/agents/agent-1/messages") body = { messages: [] };
      else if (url === "/api/agents/agent-1/runs") body = { runs: [run] };
      else if (url.startsWith("/api/runs/run-1?includeEvolution=true")) {
        evolutionReads += 1;
        body = { run, evolution: evolution(evolutionReads) };
      } else if (url === "/api/runs/run-1") body = { run };
      else if (url.startsWith("/api/runs/run-1/events")) {
        body = { events: [], lastSeq: 0, complete: false };
      } else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => body } as Response;
    });
    vi.stubGlobal("fetch", fetch);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(evolutionReads).toBe(1);
    expect(screen.getByText("1 declared")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(evolutionReads).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(`${evolutionReads} declared`)).toBeTruthy();
    expect(fetch.mock.calls.some(([url]) => String(url) === "/api/runs/run-1")).toBe(true);
  });
});
