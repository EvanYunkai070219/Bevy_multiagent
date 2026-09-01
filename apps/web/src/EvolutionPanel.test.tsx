// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import {
  EvolutionPanel,
  selectEvolutionViewModel,
  shouldLoadEvolution,
} from "./EvolutionPanel";
import type {
  AgentRun,
  EvolutionProjection,
  LineageEdge,
  LineageNode,
  LineageObservation,
} from "./types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function node(id: string, kind: LineageNode["kind"], createdAt: string, runId = "run-current"): LineageNode {
  return {
    id,
    projectId: "project-1",
    sourceFingerprint: "s".repeat(64),
    runId,
    subtaskId: kind === "source" ? null : "backend",
    kind,
    entityId: `${kind}-${id}`,
    revision: 1,
    harnessVersionHash: "h".repeat(64),
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    faultId: null,
    fingerprints: null,
    verificationIds: [],
    evidenceRefs: [],
    changedPaths: [],
    createdAt,
  };
}

function edge(id: string, from: LineageNode, to: LineageNode, kind: LineageEdge["kind"]): LineageEdge {
  return {
    id,
    projectId: "project-1",
    fromNodeId: from.id,
    toNodeId: to.id,
    kind,
    createdAt: to.createdAt,
  };
}

function observation(
  id: string,
  target: LineageNode,
  kind: LineageObservation["kind"],
  candidateState: LineageObservation["candidateState"],
): LineageObservation {
  return {
    id,
    projectId: "project-1",
    runId: target.runId,
    nodeId: target.id,
    kind,
    candidateState,
    terminalReason: null,
    modelCalls: 0,
    reservedTokens: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    elapsedMs: 0,
    occurredAt: target.createdAt,
  };
}

function projection(overrides: Partial<EvolutionProjection> = {}): EvolutionProjection {
  return {
    syncState: "synced",
    historyHealth: { droppedHistoryCount: 0, droppedReason: null, reconciliationPending: false },
    primaryFault: { class: "hard_failure", summary: "Backend contract gate failed", evidenceRefs: [] },
    warningLevel: "severe",
    terminalReason: null,
    runBranch: "launchpad/run/run-current",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    counts: {
      declared: 3,
      prunedDuplicate: 2,
      admitted: 1,
      executed: 1,
      verified: 1,
      promoted: 1,
      rolledBack: 0,
      branchPruned: 0,
      branchReturned: 0,
      historicalEvidenceUsed: 2,
    },
    nodes: [],
    edges: [],
    observations: [],
    cues: [],
    transfers: [],
    capsules: [],
    branchReturns: [],
    quarantines: [],
    nextCursor: null,
    ...overrides,
  };
}

describe("selectEvolutionViewModel", () => {
  it("keeps truthful counts, primary fault, sticky warning, commits, and deterministic tree edges", () => {
    const attempt = node("attempt", "attempt", "2026-08-30T00:00:00.000Z");
    const candidate = node("candidate", "candidate", "2026-08-30T00:00:01.000Z");
    const input = projection({
      nodes: [candidate, attempt],
      edges: [edge("repair", attempt, candidate, "repair_fork")],
      observations: [observation("verified", candidate, "verified", "verified")],
      cues: [{
        id: "cue-1", projectId: "project-1", sourceCandidateNodeId: candidate.id,
        contractKey: "backend", gateTier: "contract", failureFingerprint: "f".repeat(64),
        summary: "Contract output missing", evidenceRefs: [], exactRepeatKey: "x".repeat(64),
        createdAt: candidate.createdAt,
      }],
      transfers: [{
        id: "transfer-1", projectId: "project-1", cueId: "cue-1",
        targetCandidateNodeId: candidate.id, differingFingerprintFields: ["contractHash"],
        outcome: "helped", evidenceRefs: [], createdAt: candidate.createdAt,
      }],
    });

    const view = selectEvolutionViewModel(input);
    expect(view.counts).toEqual({
      declared: 3, prunedDuplicate: 2, admitted: 1, executed: 1,
      verified: 1, promoted: 1, rolledBack: 0, branchPruned: 0,
      branchReturned: 0, historicalEvidenceUsed: 2,
    });
    expect(view.primaryFault?.summary).toBe("Backend contract gate failed");
    expect(view.warningLevel).toBe("severe");
    expect(view.branchLabel).toBe("launchpad/run/run-current");
    expect(view.commitLabel).toBe("aaaaaaa → bbbbbbb");
    expect(view.treeRows.map((row) => ({ id: row.id, depth: row.depth, edge: row.edgeLabel })))
      .toEqual([
        { id: "attempt", depth: 0, edge: null },
        { id: "candidate", depth: 1, edge: "repair fork" },
      ]);
    expect(view.cueCount).toBe(1);
    expect(view.transferCount).toBe(1);
  });
});

describe("EvolutionPanel", () => {
  it("shows every lifecycle count as a separate truthful value", () => {
    render(<EvolutionPanel evolution={projection()} />);
    const panel = screen.getByRole("region", { name: /repair evolution/i });

    expect(within(panel).getByText("3 declared")).toBeTruthy();
    expect(within(panel).getByText("2 pruned")).toBeTruthy();
    expect(within(panel).getByText("1 admitted")).toBeTruthy();
    expect(within(panel).getByText("1 executed")).toBeTruthy();
    expect(within(panel).getByText("1 verified")).toBeTruthy();
    expect(within(panel).getByText("1 promoted")).toBeTruthy();
    expect(within(panel).getByText("0 rolled back")).toBeTruthy();
    expect(within(panel).getByText("0 branch pruned")).toBeTruthy();
    expect(within(panel).getByText("0 returned")).toBeTruthy();
    expect(within(panel).getByText("2 historical evidence")).toBeTruthy();
    const disclosure = within(panel).getByRole("button", { name: "View branch history" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(within(panel).queryByRole("group", { name: "Recorded branch history" })).toBeNull();
  });

  it("shows checkpoint declarations as not started rather than executed", () => {
    const candidates = [0, 1, 2].map((index) =>
      node(`candidate-${index}`, "candidate", `2026-08-30T00:00:0${index}.000Z`));
    render(<EvolutionPanel evolution={projection({
      counts: { ...projection().counts, declared: 3, prunedDuplicate: 0, admitted: 0, executed: 0, verified: 0, promoted: 0, historicalEvidenceUsed: 0 },
      nodes: candidates,
      observations: candidates.map((candidate, index) =>
        observation(`declared-${index}`, candidate, "declared", "not_started")),
    })} />);

    expect(screen.getByText("3 declared · 0 pruned · 0 executed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View branch history" }));
    expect(screen.getAllByText("not started")).toHaveLength(3);
    expect(screen.queryByText(/evaluated/i)).toBeNull();
  });

  it("shows exact-repeat, promotion, rollback, pending sync, and quarantine truth without raw evidence", () => {
    const candidate = node("candidate", "candidate", "2026-08-30T00:00:00.000Z");
    const integration = node("integration", "integration", "2026-08-30T00:00:01.000Z");
    const promotion = node("promotion", "promotion", "2026-08-30T00:00:02.000Z");
    render(<EvolutionPanel evolution={projection({
      syncState: "pending",
      counts: { ...projection().counts, declared: 3, prunedDuplicate: 3, admitted: 0, executed: 0 },
      nodes: [candidate, integration, promotion],
      edges: [
        edge("integrated", candidate, integration, "integrated_as"),
        edge("promoted", integration, promotion, "promoted_as"),
      ],
      observations: [observation("promoted-observation", candidate, "promoted", "promoted")],
      quarantines: [{
        id: "quarantine-1", projectId: "project-1", targetRecordId: candidate.id,
        reason: "evidence_missing", evidenceRefs: ["raw-private-evidence"],
        quarantinedAt: "2026-08-30T00:00:03.000Z",
      }],
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "View branch history" }));

    const panel = screen.getByRole("region", { name: /repair evolution/i });
    expect(within(panel).getByText("3 declared · 3 pruned · 0 executed")).toBeTruthy();
    expect(within(panel).getByText("History sync pending")).toBeTruthy();
    expect(within(panel).getByText(/1 quarantined/i)).toBeTruthy();
    expect(within(panel).getByText(/evidence missing/i)).toBeTruthy();
    expect(panel.textContent).not.toContain("raw-private-evidence");
    expect(within(panel).getByText("promoted")).toBeTruthy();
  });

  it("visually distinguishes a historical verification", () => {
    const historical = node("old-candidate", "candidate", "2026-08-29T00:00:00.000Z", "run-old");
    const current = node("current-attempt", "attempt", "2026-08-30T00:00:00.000Z", "run-current");
    render(<EvolutionPanel evolution={projection({
      nodes: [historical, current],
      observations: [observation("old-verification", historical, "verified", "verified")],
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "View branch history" }));
    expect(screen.getByText("Historical verification")).toBeTruthy();
  });

  it("shows rollback and restart cancellation without calling the producer completed", () => {
    const candidate = node("candidate-rollback", "candidate", "2026-08-30T00:00:00.000Z");
    const rollback = node("rollback", "rollback", "2026-08-30T00:00:01.000Z");
    render(<EvolutionPanel evolution={projection({
      terminalReason: "server_restarted",
      counts: { ...projection().counts, promoted: 0, rolledBack: 1 },
      nodes: [candidate, rollback],
      edges: [edge("rolled-back", candidate, rollback, "rolled_back_to")],
      observations: [observation("rollback-observation", candidate, "rolled_back", "rolled_back")],
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "View branch history" }));
    expect(screen.getByText("rolled back")).toBeTruthy();
    expect(screen.getByText("Restart cancelled")).toBeTruthy();
    expect(screen.queryByText("completed")).toBeNull();
  });

  it("discloses bounded dropped-history health without exposing storage paths", () => {
    render(<EvolutionPanel evolution={projection({
      syncState: "unavailable",
      historyHealth: {
        droppedHistoryCount: 2,
        droppedReason: "outbox_entry_limit",
        reconciliationPending: true,
      },
    })} />);
    const panel = screen.getByRole("region", { name: /repair evolution/i });
    expect(within(panel).getByText("2 history records dropped · outbox entry limit")).toBeTruthy();
    expect(within(panel).getByText("History reconciliation pending")).toBeTruthy();
    expect(panel.textContent).not.toMatch(/\/evolution\/|owner\.json|segments\//i);
  });
});

describe("evolution loading", () => {
  it("never loads history for a temporary or ephemeral-research chat", () => {
    const temporary = { projectId: null, workspaceSource: { mode: "ephemeral_research" } } as AgentRun;
    expect(shouldLoadEvolution(temporary, false)).toBe(false);
    expect(shouldLoadEvolution(temporary, true)).toBe(false);
    expect(shouldLoadEvolution({ ...temporary, projectId: "project-1", workspaceSource: { mode: "existing_repository", repositoryPath: "/repo", revision: "main" } }, true)).toBe(true);
  });

  it("requests bounded pages only when evolution is explicitly included", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ run: { id: "run-1" }, evolution: projection() }),
    });
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    await api.run("run-1", {
      includeEvolution: true,
      after: "opaque-cursor",
      limit: 100,
      depth: 4,
      signal: controller.signal,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/api/runs/run-1?includeEvolution=true&evolutionAfter=opaque-cursor&evolutionLimit=100&evolutionDepth=4",
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });
});
