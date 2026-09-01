import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RunEventSink } from "../../run-events.js";
import type {
  DiagnosisRecord,
  EvidenceSnapshot,
  FaultRecord,
  SubtaskContract,
} from "../../types.js";
import type { ArkClient } from "../leader/ark-client.js";
import { apiCallContext } from "../leader/ark-client.js";
import { RunTerminalError, type RunControl } from "../run-control.js";
import { parseJsonObject } from "../leader/validation.js";

const CLASSIFICATIONS = [
  "context",
  "capability",
  "reasoning",
  "verification",
  "task",
  "coordination",
  "knowledge",
] as const;

const MUTATION_FAMILIES = ["context_patch", "strategy_patch"] as const;
const RATIONALE_MAX = 2000;

const diagnosisSchema = z
  .object({
    classification: z.enum(CLASSIFICATIONS),
    rationale: z.string().trim().min(1).max(RATIONALE_MAX),
    allowedMutationFamilies: z.array(z.enum(MUTATION_FAMILIES)).min(1),
  })
  .strict();

export class Diagnoser {
  constructor(private readonly ark: ArkClient) {}

  async diagnose(input: {
    fault: FaultRecord;
    contract: SubtaskContract;
    evidence: Pick<
      EvidenceSnapshot,
      "id" | "source" | "failureFingerprints" | "changedPaths" | "stateFingerprint"
    >[];
    control: RunControl;
    budgetScopeId: string;
    sink: RunEventSink;
  }): Promise<DiagnosisRecord> {
    const unavailable = (createdAt = new Date().toISOString()): DiagnosisRecord => ({
      id: randomUUID(),
      faultId: input.fault.id,
      status: "unavailable",
      classification: "",
      rationale: "",
      allowedMutationFamilies: [],
      createdAt,
    });
    try {
      input.control.assertActive();
      const snapshot = input.control.snapshot();
      if (
        snapshot.emergencyModelCallFuse !== null &&
        snapshot.usedModelCalls >= snapshot.emergencyModelCallFuse
      ) {
        throw input.control.stop(
          "emergency_model_call_fuse",
          "Emergency model-call fuse reached",
        );
      }
      const completion = await this.ark.completeJson(
        diagnosisMessages(input.fault, input.contract, input.evidence),
        apiCallContext(
          {
            sink: input.sink,
            iteration: 0,
            control: input.control,
            budgetScopeId: input.budgetScopeId,
          },
          "diagnoser",
          1,
        ),
      );
      const parsed = diagnosisSchema.parse(parseJsonObject(completion.text));
      const families = uniqueFamilies(parsed.allowedMutationFamilies);
      if (families.length === 0) return unavailable();
      return {
        id: randomUUID(),
        faultId: input.fault.id,
        status: "available",
        classification: parsed.classification,
        rationale: parsed.rationale,
        allowedMutationFamilies: families,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof RunTerminalError) return unavailable();
      return unavailable();
    }
  }
}

function uniqueFamilies(
  families: Array<(typeof MUTATION_FAMILIES)[number]>,
): Array<(typeof MUTATION_FAMILIES)[number]> {
  const seen = new Set<(typeof MUTATION_FAMILIES)[number]>();
  const unique: Array<(typeof MUTATION_FAMILIES)[number]> = [];
  for (const family of families) {
    if (seen.has(family)) continue;
    seen.add(family);
    unique.push(family);
  }
  return unique;
}

function diagnosisMessages(
  fault: FaultRecord,
  contract: SubtaskContract,
  evidence: Pick<
    EvidenceSnapshot,
    "id" | "source" | "failureFingerprints" | "changedPaths" | "stateFingerprint"
  >[],
) {
  return [
    {
      role: "system" as const,
      content:
        "You diagnose one failed task revision. Return only JSON matching " +
        "{ classification: 'context'|'capability'|'reasoning'|'verification'|'task'|'coordination'|'knowledge', " +
        "rationale: string, allowedMutationFamilies: ('context_patch'|'strategy_patch')[] }. " +
        "Rationale must be 1 to " +
        String(RATIONALE_MAX) +
        " characters. " +
        "Do not request agents, permissions, credentials, tools, budgets, verifier commands, expected outcomes, or mutation scope. " +
        "Do not include a control mutation; the coordinator adds the unchanged control experiment.",
    },
    {
      role: "user" as const,
      content: JSON.stringify({ fault, contract, evidence }),
    },
  ];
}
