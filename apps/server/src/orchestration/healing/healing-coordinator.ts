import { randomUUID } from "node:crypto";
import type { RunEventDraft, RunEventSink } from "../../run-events.js";
import type {
  DiagnosisRecord,
  EvidenceSnapshot,
  FaultRecord,
  HealingState,
  SubtaskContract,
  TaskNodeState,
} from "../../types.js";
import type { Diagnoser } from "./diagnoser.js";
import { RunTerminalError, type RunControl } from "../run-control.js";

export type HealingAdmission =
  | { status: "admitted"; fault: FaultRecord; diagnosis: DiagnosisRecord }
  | { status: "unavailable"; fault: FaultRecord; diagnosis: DiagnosisRecord | null; reason: string }
  | { status: "terminal"; error: RunTerminalError };

export interface HealingCoordinatorDeps {
  mutateHealing<T>(mutate: (healing: HealingState) => T): Promise<T>;
  withAuthorityLock<T>(operation: () => Promise<T>): Promise<T>;
  diagnoser: Pick<Diagnoser, "diagnose">;
  control: RunControl;
  sink: RunEventSink;
  healingEnabled: boolean;
  projectReady: boolean;
  evidenceFor(
    fault: FaultRecord,
  ): Pick<
    EvidenceSnapshot,
    "id" | "source" | "failureFingerprints" | "changedPaths" | "stateFingerprint"
  >[];
  budgetScopeId: string;
}

type Claim =
  | { action: "diagnose"; fault: FaultRecord; diagnosisId: string; revision: number; subtaskId: string }
  | { action: "done"; admission: HealingAdmission };

export class HealingCoordinator {
  constructor(private readonly deps: HealingCoordinatorDeps) {}

  async begin(
    fault: FaultRecord,
    node: TaskNodeState,
    contract: SubtaskContract,
  ): Promise<HealingAdmission> {
    const claim = await this.deps.withAuthorityLock(() => this.claim(fault, node));
    if (claim.action === "done") return claim.admission;
    try {
      this.deps.sink.emit(
        diagnosisEvent("diagnosis_started", claim.subtaskId, "Diagnosing repairable fault.", "in_progress", {
          faultId: claim.fault.id,
          diagnosisId: claim.diagnosisId,
        }),
      );
    } catch {
      return await this.deps.withAuthorityLock(() =>
        this.attach(claim, unavailableDiagnosis(claim.fault.id, claim.diagnosisId), "event_sink_failed"),
      );
    }
    let diagnosis: DiagnosisRecord;
    try {
      this.deps.control.assertActive();
      diagnosis = await this.deps.diagnoser.diagnose({
        fault: claim.fault,
        contract,
        evidence: this.deps.evidenceFor(claim.fault),
        control: this.deps.control,
        budgetScopeId: this.deps.budgetScopeId,
        sink: this.deps.sink,
      });
      diagnosis = { ...diagnosis, id: claim.diagnosisId, faultId: claim.fault.id };
    } catch (error) {
      if (error instanceof RunTerminalError) {
        await this.deps.withAuthorityLock(() =>
          this.attach(claim, unavailableDiagnosis(claim.fault.id, claim.diagnosisId), "terminal"),
        );
        return { status: "terminal", error };
      }
      diagnosis = unavailableDiagnosis(claim.fault.id, claim.diagnosisId);
    }
    return this.deps.withAuthorityLock(() =>
      this.attach(
        claim,
        diagnosis,
        diagnosis.status === "available" ? "admitted" : "diagnosis_unavailable",
      ),
    );
  }

  private async claim(fault: FaultRecord, node: TaskNodeState): Promise<Claim> {
    return this.deps.mutateHealing((healing) => {
      if (!healing.faults.some((item) => item.id === fault.id)) {
        healing.faults.push(structuredClone(fault));
      }
      const current = healing.nodes.find((item) => item.subtaskId === node.subtaskId);
      if (
        healing.tournaments.some(
          (item) => item.subtaskId === (current?.subtaskId ?? node.subtaskId) &&
            item.revision === (current?.revision ?? node.revision),
        )
      ) {
        const existing = current
          ? healing.diagnoses.find((item) => item.id === current.diagnosisId) ?? null
          : null;
        return {
          action: "done",
          admission: existing?.status === "available"
            ? { status: "admitted", fault, diagnosis: existing }
            : { status: "unavailable", fault, diagnosis: existing, reason: "tournament_exists" },
        };
      }
      if (
        current &&
        current.state !== "cancelled" &&
        current.state !== "repairing" &&
        current.state !== "completed" &&
        current.state !== "verifying" &&
        current.state !== "integration_pending" &&
        current.state !== "integrating"
      ) {
        current.faultId = fault.id;
        current.state = "failed";
        current.updatedAt = new Date().toISOString();
      }
      const unavailable = (reason: string, diagnosis: DiagnosisRecord | null = null): Claim => ({
        action: "done",
        admission: { status: "unavailable", fault, diagnosis, reason },
      });
      try {
        this.deps.control.assertActive();
      } catch (error) {
        if (error instanceof RunTerminalError) {
          return { action: "done", admission: { status: "terminal", error } };
        }
      }
      if (!this.deps.healingEnabled) return unavailable("healing_disabled");
      if (!this.deps.projectReady) return unavailable("project_not_ready");
      if (!fault.repairable) return unavailable("fault_not_repairable");
      if (!current) return unavailable("node_missing");
      if (current.state === "cancelled") return unavailable("cancelled");
      if (
        current.revision !== node.revision ||
        (current.state !== "failed" && current.state !== "running")
      ) {
        return unavailable("revision_mismatch");
      }
      if (
        healing.tournaments.some(
          (item) => item.subtaskId === current.subtaskId && item.revision === current.revision,
        )
      ) {
        return unavailable("tournament_exists");
      }
      if (current.diagnosisId) {
        const existing = healing.diagnoses.find((item) => item.id === current.diagnosisId) ?? null;
        if (existing?.status === "available") {
          return {
            action: "done",
            admission: { status: "admitted", fault, diagnosis: existing },
          };
        }
        return unavailable("already_claimed", existing);
      }
      const diagnosisId = randomUUID();
      current.diagnosisId = diagnosisId;
      current.updatedAt = new Date().toISOString();
      return {
        action: "diagnose",
        fault: structuredClone(fault),
        diagnosisId,
        revision: current.revision,
        subtaskId: current.subtaskId,
      };
    });
  }

  private async attach(
    claim: Extract<Claim, { action: "diagnose" }>,
    diagnosis: DiagnosisRecord,
    reason: string,
  ): Promise<HealingAdmission> {
    return this.deps.mutateHealing((healing) => {
      const current = healing.nodes.find((item) => item.subtaskId === claim.subtaskId);
      const fault =
        healing.faults.find((item) => item.id === claim.fault.id) ?? claim.fault;
      if (
        !current ||
        current.revision !== claim.revision ||
        current.state === "cancelled"
      ) {
        if (current && current.diagnosisId === claim.diagnosisId && current.revision !== claim.revision) {
          current.diagnosisId = null;
        }
        return {
          status: "unavailable" as const,
          fault,
          diagnosis: null,
          reason: current?.state === "cancelled" ? "cancelled" : "stale_revision",
        };
      }
      const recorded = withControl(diagnosis);
      if (!healing.diagnoses.some((item) => item.id === recorded.id)) {
        healing.diagnoses.push(recorded);
      }
      current.diagnosisId = recorded.id;
      current.faultId = fault.id;
      current.state = "failed";
      current.updatedAt = new Date().toISOString();
      if (recorded.status === "available" && reason === "admitted") {
        return { status: "admitted" as const, fault, diagnosis: recorded };
      }
      return {
        status: "unavailable" as const,
        fault,
        diagnosis: recorded,
        reason,
      };
    });
  }
}

export function leaderMayInterpretResults(
  admissions: HealingAdmission[],
  nodes: TaskNodeState[] = [],
): boolean {
  if (nodes.length > 0) {
    return !nodes.some(
      (node) =>
        node.state === "failed" ||
        node.state === "blocked" ||
        node.state === "cancelled" ||
        node.state === "repairing",
    );
  }
  return admissions.length === 0;
}

function withControl(diagnosis: DiagnosisRecord): DiagnosisRecord {
  if (diagnosis.status !== "available") return structuredClone(diagnosis);
  const families = diagnosis.allowedMutationFamilies.filter((item) => item !== "control");
  return {
    ...diagnosis,
    allowedMutationFamilies: ["control", ...families],
  };
}

function unavailableDiagnosis(faultId: string, id: string): DiagnosisRecord {
  return {
    id,
    faultId,
    status: "unavailable",
    classification: "",
    rationale: "",
    allowedMutationFamilies: [],
    createdAt: new Date().toISOString(),
  };
}

function diagnosisEvent(
  name: string,
  subtaskId: string,
  text: string,
  status: RunEventDraft["status"],
  attributes: Record<string, unknown>,
): RunEventDraft {
  const timestamp = new Date().toISOString();
  return {
    spanId: "healing-" + name + "-" + subtaskId,
    parentSpanId: "run",
    kind: "delegation",
    name,
    status,
    startedAt: timestamp,
    endedAt: status === "in_progress" ? null : timestamp,
    durationMs: status === "in_progress" ? null : 0,
    input: {},
    output: { text },
    error: status === "error" || status === "warning" ? { message: text, code: name } : null,
    attributes: { subtaskId, ...attributes },
    usage: null,
  };
}
