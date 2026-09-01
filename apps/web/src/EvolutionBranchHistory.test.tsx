// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EvolutionBranchHistory } from "./EvolutionBranchHistory";
import type {
  BranchReturnRecord,
  EvolutionProjection,
  LineageEdge,
  LineageNode,
  LineageObservation,
  SanitizedFailureCapsule,
} from "./types";

afterEach(cleanup);

function node(
  id: string,
  kind: LineageNode["kind"],
  entityId: string,
  createdAt: string,
): LineageNode {
  return {
    id,
    projectId: "project-1",
    sourceFingerprint: "s".repeat(64),
    runId: "run-1",
    subtaskId: kind === "source" ? null : "backend",
    kind,
    entityId,
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

function projection(): EvolutionProjection {
  const checkpoint = node("checkpoint", "attempt", "attempt-backend", "2026-08-31T00:00:00.000Z");
  const candidate = node("candidate", "candidate", "candidate-context", "2026-08-31T00:00:01.000Z");
  const promotion = node("promotion", "promotion", "promotion-backend", "2026-08-31T00:00:02.000Z");
  const observations: LineageObservation[] = [{
    id: "observation-pruned",
    projectId: "project-1",
    runId: "run-1",
    nodeId: candidate.id,
    kind: "branch_pruned",
    candidateState: "rejected",
    terminalReason: "protected_rejection",
    modelCalls: 1,
    reservedTokens: 10,
    actualInputTokens: 4,
    actualOutputTokens: 2,
    elapsedMs: 80,
    occurredAt: "2026-08-31T00:00:03.000Z",
  }];
  const edges: LineageEdge[] = [
    {
      id: "edge-fork",
      projectId: "project-1",
      fromNodeId: checkpoint.id,
      toNodeId: candidate.id,
      kind: "repair_fork",
      createdAt: candidate.createdAt,
    },
    {
      id: "edge-returned",
      projectId: "project-1",
      fromNodeId: candidate.id,
      toNodeId: checkpoint.id,
      kind: "returned_to",
      createdAt: "2026-08-31T00:00:03.000Z",
    },
    {
      id: "edge-promotion",
      projectId: "project-1",
      fromNodeId: candidate.id,
      toNodeId: promotion.id,
      kind: "promoted_as",
      createdAt: promotion.createdAt,
    },
  ];
  const capsules: SanitizedFailureCapsule[] = [{
    id: "capsule-1",
    projectId: "project-1",
    runId: "run-1",
    tournamentId: "tournament-1",
    candidateId: "candidate-context",
    candidateFamily: "context_patch",
    returnCheckpointId: "attempt-backend",
    stopReason: "protected_rejection",
    summary: "Protected contract verification rejected the continuation.",
    evidenceRefs: ["evidence-contract", "evidence-consumer"],
    createdAt: "2026-08-31T00:00:03.000Z",
  }];
  const branchReturns: BranchReturnRecord[] = [{
    id: "return-1",
    projectId: "project-1",
    runId: "run-1",
    candidateNodeId: candidate.id,
    checkpointNodeId: checkpoint.id,
    capsuleId: capsules[0].id,
    createdAt: "2026-08-31T00:00:03.000Z",
  }];
  return {
    syncState: "synced",
    historyHealth: { droppedHistoryCount: 0, droppedReason: null, reconciliationPending: false },
    primaryFault: null,
    warningLevel: null,
    terminalReason: null,
    runBranch: "launchpad/run/run-1",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    counts: {
      declared: 1,
      prunedDuplicate: 0,
      admitted: 1,
      executed: 1,
      verified: 0,
      promoted: 1,
      rolledBack: 0,
      branchPruned: 1,
      branchReturned: 1,
      historicalEvidenceUsed: 0,
    },
    nodes: [checkpoint, candidate, promotion],
    edges,
    observations,
    cues: [],
    transfers: [],
    capsules,
    branchReturns,
    quarantines: [],
    nextCursor: null,
  };
}

describe("EvolutionBranchHistory", () => {
  it("keeps recorded history collapsed until requested, then shows branch-return lineage", () => {
    render(<EvolutionBranchHistory evolution={projection()} />);

    const disclosure = screen.getByRole("button", { name: "View branch history" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: "Recorded branch history" })).toBeNull();

    fireEvent.click(disclosure);

    const history = screen.getByRole("group", { name: "Recorded branch history" });
    expect(within(history).getByRole("button", { name: /attempt.*backend/i })).toBeTruthy();
    expect(within(history).getByRole("button", { name: /candidate.*backend/i })).toBeTruthy();
    expect(within(history).getByRole("button", { name: /promotion.*backend/i })).toBeTruthy();
    expect(within(history).getByText("branch pruned")).toBeTruthy();
    expect(within(history).getByText(/returned to attempt/i)).toBeTruthy();
    expect(within(history).getByText(/recorded history.*does not select, rank, execute, or promote/i)).toBeTruthy();
  });

  it("reveals only sanitized candidate, checkpoint, evidence, outcome, and return reason", () => {
    render(<EvolutionBranchHistory evolution={projection()} />);
    fireEvent.click(screen.getByRole("button", { name: "View branch history" }));
    fireEvent.click(screen.getByRole("button", { name: /candidate.*backend/i }));

    const details = screen.getByRole("region", { name: "Selected branch record" });
    expect(within(details).getByText("context patch")).toBeTruthy();
    expect(within(details).getByText(/attempt.*backend/i)).toBeTruthy();
    expect(within(details).getByText("evidence-contract")).toBeTruthy();
    expect(within(details).getByText("evidence-consumer")).toBeTruthy();
    expect(within(details).getByText("branch pruned")).toBeTruthy();
    expect(within(details).getByText("protected rejection")).toBeTruthy();
    expect(details.textContent).not.toMatch(/mutationContentHash|repairGraphFenceHash|authority token/i);
  });

  it("resets disclosure and selection when the active run changes", () => {
    const firstRun = projection();
    const rendered = render(<EvolutionBranchHistory runId="run-1" evolution={firstRun} />);
    fireEvent.click(screen.getByRole("button", { name: "View branch history" }));
    fireEvent.click(screen.getByRole("button", { name: /candidate.*backend/i }));
    expect(screen.getByRole("region", { name: "Selected branch record" })).toBeTruthy();

    rendered.rerender(<EvolutionBranchHistory
      runId="run-2"
      evolution={{
        ...firstRun,
        runBranch: "launchpad/run/run-2",
        nodes: firstRun.nodes.map((value) => ({ ...value, runId: "run-2" })),
      }}
    />);

    expect(screen.getByRole("button", { name: "View branch history" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: "Recorded branch history" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Selected branch record" })).toBeNull();
  });

  it("maps records and relationships to deterministic wide-screen tracks and connectors", () => {
    const rendered = render(<EvolutionBranchHistory evolution={projection()} />);
    fireEvent.click(screen.getByRole("button", { name: "View branch history" }));

    const tracks = [...rendered.container.querySelectorAll("[data-lineage-track-id]")]
      .map((element) => element.getAttribute("data-lineage-track-id"));
    expect(tracks).toEqual(["checkpoint", "candidate", "promotion"]);

    const connectors = [...rendered.container.querySelectorAll("[data-lineage-edge-id]")]
      .map((element) => ({
        id: element.getAttribute("data-lineage-edge-id"),
        kind: element.getAttribute("data-lineage-edge-kind"),
        from: element.getAttribute("data-lineage-from-track"),
        to: element.getAttribute("data-lineage-to-track"),
      }));
    expect(connectors).toEqual([
      { id: "edge-fork", kind: "repair_fork", from: "0", to: "1" },
      { id: "edge-returned", kind: "returned_to", from: "1", to: "0" },
      { id: "edge-promotion", kind: "promoted_as", from: "1", to: "2" },
    ]);
  });

  it("preserves selection when a new record arrives and exposes the responsive vertical lineage hook", () => {
    const initial = projection();
    const rendered = render(<EvolutionBranchHistory runId="run-1" evolution={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "View branch history" }));
    fireEvent.click(screen.getByRole("button", { name: /candidate.*backend/i }));

    const nextCandidate = node("candidate-next", "candidate", "candidate-strategy", "2026-08-31T00:00:04.000Z");
    rendered.rerender(<EvolutionBranchHistory runId="run-1" evolution={{
      ...initial,
      nodes: [...initial.nodes, nextCandidate],
      observations: [...initial.observations, {
        id: "observation-next",
        projectId: "project-1",
        runId: "run-1",
        nodeId: nextCandidate.id,
        kind: "declared",
        candidateState: "not_started",
        terminalReason: null,
        modelCalls: 0,
        reservedTokens: 0,
        actualInputTokens: 0,
        actualOutputTokens: 0,
        elapsedMs: 0,
        occurredAt: nextCandidate.createdAt,
      }],
    }} />);

    expect(screen.getByRole("button", { name: /candidate.*strategy/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /candidate.*context/i }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("region", { name: "Selected branch record" }).textContent).toContain("context patch");
    expect(rendered.container.querySelector(".evolution-branch-history__lineage--vertical-narrow")).toBeTruthy();
  });
});
