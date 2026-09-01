import type { MutationDelta, VerificationResult } from "../../types.js";
import {
  exactRepeatKey as fingerprintExactRepeatKey,
  usableFingerprints,
} from "./evolution-fingerprints.js";
import type {
  EvolutionFingerprints,
  EvolutionPayload,
  LineageNode,
  LineageObservation,
} from "./evolution-types.js";
import type { HistoricalAuditDecision } from "./historical-evidence-auditor.js";

export interface HistoricalTrialMatch {
  exactRepeatKey: string;
  candidateNodeId: string;
  candidateFamily: MutationDelta["family"];
  terminalObservationId: string;
  verificationId: string;
  verification: VerificationResult | null;
  evidenceRefs: string[];
}

type IndexHealth = "ready" | "unavailable" | "quarantined";

interface IndexedTrial {
  readonly match: HistoricalTrialMatch;
  readonly createdAt: string;
}

export function exactRepeatKey(fingerprints: EvolutionFingerprints): string | null {
  return fingerprintExactRepeatKey(fingerprints);
}

export class ExactRepeatIndex {
  readonly #matches = new Map<string, IndexedTrial>();
  readonly #blocked = new Set<string>();
  #health: IndexHealth = "unavailable";

  rebuild(records: readonly EvolutionPayload[], audits: readonly HistoricalAuditDecision[]): void {
    this.#matches.clear();
    this.#blocked.clear();
    this.#health = "ready";

    const auditByRecord = new Map(audits.map((audit) => [audit.recordId, audit]));
    const candidateNodes = records
      .filter((payload): payload is Extract<EvolutionPayload, { type: "node" }> =>
        payload.type === "node" && payload.value.kind === "candidate")
      .map((payload) => payload.value);
    const nodeById = new Map(candidateNodes.map((node) => [node.id, node]));
    const observations = new Map<string, LineageObservation[]>();
    for (const payload of records) {
      if (payload.type !== "observation") continue;
      const node = nodeById.get(payload.value.nodeId);
      if (node === undefined) continue;
      const logicalId = logicalCandidateId(node);
      const values = observations.get(logicalId) ?? [];
      values.push(payload.value);
      observations.set(logicalId, values);
    }

    const grouped = new Map<string, Array<{ node: LineageNode; terminal: LineageObservation; negative: boolean }>>();
    for (const node of candidateNodes) {
      const audit = auditByRecord.get(node.id);
      if (!audit?.trustedForPruning || audit.quarantine !== null ||
        node.fingerprints === null || !usableFingerprints(node.fingerprints) ||
        node.verificationIds.length === 0) continue;
      const family = candidateFamily(node.entityId);
      if (family === null) continue;
      const lifecycle = observations.get(logicalCandidateId(node)) ?? [];
      if (!lifecycle.some((value) => value.kind === "executed")) continue;
      const terminals = lifecycle.filter((value) =>
        value.kind === "rejected" || value.kind === "rolled_back" ||
        value.kind === "verified" || value.kind === "promoted" ||
        value.kind === "cancelled" || value.kind === "restart_cancelled",
      ).sort(compareObservation);
      const terminal = terminals.at(-1);
      if (terminal === undefined) continue;
      const key = compoundKey(node.projectId, node.sourceFingerprint, node.fingerprints, family);
      if (key === null) continue;
      const hasNegative = terminals.some((value) =>
        value.kind === "rejected" || value.kind === "rolled_back");
      const hasPositive = terminals.some((value) =>
        value.kind === "verified" || value.kind === "promoted");
      if (hasNegative && hasPositive) {
        this.#blocked.add(key);
        this.#health = "quarantined";
        continue;
      }
      const values = grouped.get(key) ?? [];
      values.push({
        node,
        terminal,
        negative: hasNegative,
      });
      grouped.set(key, values);
    }

    for (const [key, trials] of grouped) {
      if (this.#blocked.has(key)) continue;
      const negatives = trials.filter((trial) => trial.negative);
      const positives = trials.filter((trial) => !trial.negative);
      if (negatives.length > 0 && positives.length > 0) {
        this.#blocked.add(key);
        this.#health = "quarantined";
        continue;
      }
      const latest = negatives.sort((left, right) =>
        right.node.createdAt.localeCompare(left.node.createdAt) ||
        right.node.id.localeCompare(left.node.id),
      )[0];
      if (latest === undefined) continue;
      const repeatKey = fingerprintExactRepeatKey(latest.node.fingerprints!);
      const family = candidateFamily(latest.node.entityId);
      if (repeatKey === null || family === null) continue;
      this.#matches.set(key, {
        createdAt: latest.node.createdAt,
        match: {
          exactRepeatKey: repeatKey,
          candidateNodeId: latest.node.id,
          candidateFamily: family,
          terminalObservationId: latest.terminal.id,
          verificationId: auditByRecord.get(latest.node.id)?.verification?.id ??
            [...latest.node.verificationIds].sort()[0]!,
          verification: structuredClone(auditByRecord.get(latest.node.id)?.verification ?? null),
          evidenceRefs: [...new Set(latest.node.evidenceRefs)].sort(),
        },
      });
    }
  }

  markUnavailable(): void {
    this.#matches.clear();
    this.#blocked.clear();
    this.#health = "unavailable";
  }

  find(input: {
    projectId: string;
    sourceFingerprint: string;
    fingerprints: EvolutionFingerprints;
    candidateFamily: MutationDelta["family"];
  }): HistoricalTrialMatch | null {
    if (this.#health === "unavailable") return null;
    const key = compoundKey(
      input.projectId,
      input.sourceFingerprint,
      input.fingerprints,
      input.candidateFamily,
    );
    if (key === null || this.#blocked.has(key)) return null;
    const trial = this.#matches.get(key);
    return trial === undefined ? null : structuredClone(trial.match);
  }

  health(): IndexHealth {
    return this.#health;
  }
}

function compoundKey(
  projectId: string,
  sourceFingerprint: string,
  fingerprints: EvolutionFingerprints,
  family: MutationDelta["family"],
): string | null {
  if (projectId.length === 0 || sourceFingerprint.length === 0) return null;
  const repeatKey = fingerprintExactRepeatKey(fingerprints);
  return repeatKey === null ? null : `${projectId}\0${sourceFingerprint}\0${repeatKey}\0${family}`;
}

function candidateFamily(entityId: string): MutationDelta["family"] | null {
  if (entityId.endsWith("-context_patch")) return "context_patch";
  if (entityId.endsWith("-strategy_patch")) return "strategy_patch";
  if (entityId.endsWith("-control")) return "control";
  return null;
}

function logicalCandidateId(node: LineageNode): string {
  return `${node.projectId}\0${node.runId}\0${node.entityId}`;
}

function compareObservation(left: LineageObservation, right: LineageObservation): number {
  return left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
}
