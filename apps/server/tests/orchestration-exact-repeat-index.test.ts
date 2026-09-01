import { describe, expect, it } from "vitest";
import {
  ExactRepeatIndex,
  exactRepeatKey,
} from "../src/orchestration/evolution/exact-repeat-index.js";
import type {
  EvolutionFingerprints,
  EvolutionPayload,
  LineageNode,
  LineageObservation,
} from "../src/orchestration/evolution/evolution-types.js";
import type { HistoricalAuditDecision } from "../src/orchestration/evolution/historical-evidence-auditor.js";

const hash = (character: string) => character.repeat(64);

function fingerprints(overrides: Partial<EvolutionFingerprints> = {}): EvolutionFingerprints {
  return {
    schemaVersion: 2,
    complete: true,
    repositoryBaseHash: hash("1"),
    contractHash: hash("2"),
    authorityManifestHash: hash("3"),
    runtimeCapabilityHash: hash("4"),
    faultEvidenceHash: hash("5"),
    mutationContentHash: hash("6"),
    ...overrides,
  };
}

function candidateNode(
  id: string,
  family: "control" | "context_patch" | "strategy_patch" = "control",
  overrides: Partial<LineageNode> = {},
): LineageNode {
  return {
    id,
    projectId: "project-1",
    sourceFingerprint: hash("a"),
    runId: "run-1",
    subtaskId: "backend",
    kind: "candidate",
    entityId: `tournament-1-${family}`,
    revision: 1,
    harnessVersionHash: hash("b"),
    baseCommit: "c".repeat(40),
    headCommit: null,
    faultId: "fault-1",
    fingerprints: fingerprints(),
    verificationIds: ["verification-1"],
    evidenceRefs: [hash("d")],
    changedPaths: [],
    createdAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

function observation(
  nodeId: string,
  kind: LineageObservation["kind"],
  suffix: string,
): LineageObservation {
  return {
    id: hash(suffix),
    projectId: "project-1",
    runId: "run-1",
    nodeId,
    kind,
    candidateState: kind === "rejected" ? "rejected" : kind === "rolled_back" ? "rolled_back" : "running",
    terminalReason: kind === "rejected" || kind === "rolled_back" ? "deterministic_gate_failure" : null,
    modelCalls: kind === "executed" ? 1 : 0,
    reservedTokens: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    elapsedMs: 1,
    occurredAt: `2026-08-29T00:00:0${suffix === "e" ? 1 : 2}.000Z`,
  };
}

function trusted(recordId: string, overrides: Partial<HistoricalAuditDecision> = {}): HistoricalAuditDecision {
  return {
    recordId,
    trustedForPruning: true,
    trustedForCue: true,
    quarantine: null,
    ...overrides,
  };
}

function history(node: LineageNode, terminal: LineageObservation["kind"] = "rejected"): EvolutionPayload[] {
  return [
    { type: "node", value: node },
    { type: "observation", value: observation(node.id, "executed", "e") },
    { type: "observation", value: observation(node.id, terminal, "f") },
  ];
}

describe("exactRepeatKey", () => {
  it("is canonical and changes for every one-field identity change", () => {
    const base = fingerprints();
    const reordered = {
      complete: true,
      mutationContentHash: hash("6"),
      faultEvidenceHash: hash("5"),
      runtimeCapabilityHash: hash("4"),
      authorityManifestHash: hash("3"),
      contractHash: hash("2"),
      repositoryBaseHash: hash("1"),
      schemaVersion: 2,
    } as const;
    expect(exactRepeatKey(base)).toBe(exactRepeatKey(reordered));
    for (const field of [
      "repositoryBaseHash",
      "contractHash",
      "authorityManifestHash",
      "runtimeCapabilityHash",
      "faultEvidenceHash",
      "mutationContentHash",
    ] as const) {
      expect(exactRepeatKey({ ...base, [field]: hash("f") })).not.toBe(exactRepeatKey(base));
    }
  });

  it("rejects incomplete, legacy, missing, empty, and malformed identities", () => {
    const base = fingerprints();
    expect(exactRepeatKey({ ...base, complete: false })).toBeNull();
    expect(exactRepeatKey({ ...base, schemaVersion: 1 } as EvolutionFingerprints)).toBeNull();
    expect(exactRepeatKey({ ...base, contractHash: "" })).toBeNull();
    expect(exactRepeatKey({ ...base, authorityManifestHash: "not-a-hash" })).toBeNull();
    expect(exactRepeatKey({ ...base, mutationContentHash: undefined } as unknown as EvolutionFingerprints)).toBeNull();
  });
});

describe("ExactRepeatIndex", () => {
  it.each(["rejected", "rolled_back"] as const)(
    "returns a trusted executed %s negative from the same Project/source",
    (terminal) => {
      const node = candidateNode(hash("1"), "context_patch");
      const index = new ExactRepeatIndex();
      index.rebuild(history(node, terminal), [trusted(node.id)]);

      expect(index.find({
        projectId: node.projectId,
        sourceFingerprint: node.sourceFingerprint,
        fingerprints: node.fingerprints!,
        candidateFamily: "context_patch",
      })).toMatchObject({
        candidateNodeId: node.id,
        candidateFamily: "context_patch",
        terminalObservationId: hash("f"),
        verificationId: "verification-1",
      });
      expect(index.health()).toBe("ready");
    },
  );

  it("joins immutable transition nodes for the same logical candidate", () => {
    const executedNode = candidateNode(hash("a"), "strategy_patch", {
      verificationIds: [],
      createdAt: "2026-08-29T00:00:01.000Z",
    });
    const terminalNode = candidateNode(hash("b"), "strategy_patch", {
      createdAt: "2026-08-29T00:00:02.000Z",
    });
    const index = new ExactRepeatIndex();
    index.rebuild([
      { type: "node", value: executedNode },
      { type: "node", value: terminalNode },
      { type: "observation", value: observation(executedNode.id, "executed", "e") },
      { type: "observation", value: observation(terminalNode.id, "rejected", "f") },
    ], [trusted(terminalNode.id)]);

    expect(index.find({
      projectId: terminalNode.projectId,
      sourceFingerprint: terminalNode.sourceFingerprint,
      fingerprints: terminalNode.fingerprints!,
      candidateFamily: "strategy_patch",
    })?.candidateNodeId).toBe(terminalNode.id);
  });

  it.each([
    { label: "not executed", kinds: ["rejected"] },
    { label: "cancelled", kinds: ["executed", "cancelled"] },
    { label: "promoted", kinds: ["executed", "promoted"] },
    { label: "missing terminal", kinds: ["executed"] },
  ] as const)("does not index $label history", ({ kinds }) => {
    const node = candidateNode(hash("2"));
    const records: EvolutionPayload[] = [
      { type: "node", value: node },
      ...kinds.map((kind, index) => ({
        type: "observation" as const,
        value: observation(node.id, kind, index === 0 ? "e" : "f"),
      })),
    ];
    const index = new ExactRepeatIndex();
    index.rebuild(records, [trusted(node.id)]);
    expect(index.find({
      projectId: node.projectId,
      sourceFingerprint: node.sourceFingerprint,
      fingerprints: node.fingerprints!,
      candidateFamily: "control",
    })).toBeNull();
  });

  it("fails closed for untrusted, quarantined, missing-verification, cross-Project, or cross-source history", () => {
    const node = candidateNode(hash("3"));
    const query = { projectId: node.projectId, sourceFingerprint: node.sourceFingerprint,
      fingerprints: node.fingerprints!, candidateFamily: "control" as const };
    for (const setup of [
      { node, audit: trusted(node.id, { trustedForPruning: false }) },
      { node, audit: trusted(node.id, { quarantine: {} as HistoricalAuditDecision["quarantine"] }) },
      { node: { ...node, verificationIds: [] }, audit: trusted(node.id) },
    ]) {
      const index = new ExactRepeatIndex();
      index.rebuild(history(setup.node), [setup.audit]);
      expect(index.find(query)).toBeNull();
    }
    const index = new ExactRepeatIndex();
    index.rebuild(history(node), [trusted(node.id)]);
    expect(index.find({ ...query, projectId: "project-2" })).toBeNull();
    expect(index.find({ ...query, sourceFingerprint: hash("9") })).toBeNull();
  });

  it("quarantines an exact key with contradictory terminal evidence", () => {
    const negative = candidateNode(hash("4"), "control");
    const positive = candidateNode(hash("5"), "control", {
      fingerprints: negative.fingerprints,
      verificationIds: ["verification-2"],
    });
    const index = new ExactRepeatIndex();
    index.rebuild([
      ...history(negative),
      ...history(positive, "promoted"),
    ], [trusted(negative.id), trusted(positive.id)]);

    expect(index.health()).toBe("quarantined");
    expect(index.find({
      projectId: negative.projectId,
      sourceFingerprint: negative.sourceFingerprint,
      fingerprints: negative.fingerprints!,
      candidateFamily: "control",
    })).toBeNull();
  });

  it("indexes exact negative repeats independently for each candidate family", () => {
    const context = candidateNode(hash("8"), "context_patch");
    const strategy = candidateNode(hash("9"), "strategy_patch", {
      verificationIds: ["verification-2"],
    });
    const index = new ExactRepeatIndex();
    index.rebuild([
      ...history(context),
      ...history(strategy),
    ], [trusted(context.id), trusted(strategy.id)]);

    const query = {
      projectId: context.projectId,
      sourceFingerprint: context.sourceFingerprint,
      fingerprints: context.fingerprints!,
    };
    expect(index.find({ ...query, candidateFamily: "context_patch" }))
      .toMatchObject({ candidateNodeId: context.id, candidateFamily: "context_patch" });
    expect(index.find({ ...query, candidateFamily: "strategy_patch" }))
      .toMatchObject({ candidateNodeId: strategy.id, candidateFamily: "strategy_patch" });
    expect(index.find({ ...query, candidateFamily: "control" })).toBeNull();
    expect(index.health()).toBe("ready");
  });

  it("clears stale trusted matches when a refresh becomes unavailable", () => {
    const node = candidateNode(hash("7"));
    const index = new ExactRepeatIndex();
    index.rebuild(history(node), [trusted(node.id)]);
    expect(index.find({ projectId: node.projectId, sourceFingerprint: node.sourceFingerprint,
      fingerprints: node.fingerprints!, candidateFamily: "control" })).not.toBeNull();

    index.markUnavailable();

    expect(index.health()).toBe("unavailable");
    expect(index.find({ projectId: node.projectId, sourceFingerprint: node.sourceFingerprint,
      fingerprints: node.fingerprints!, candidateFamily: "control" })).toBeNull();
  });
});
