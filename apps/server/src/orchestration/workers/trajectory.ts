/**
 * Watches one worker, and can end it.
 *
 * A worker that has stopped making progress does not report that it has. It
 * keeps taking turns, each one costing a model call, until the wall-clock
 * timeout finally fires — by which point the run has spent its budget on a loop
 * nobody was watching. This decides, from the evidence the worker is actually
 * producing, that the attempt is over.
 *
 * The stop reasons are deliberately specific rather than one "stuck" verdict,
 * because the reason is what a human needs afterwards: no evidence progress, a
 * repeated action signature, oscillation between states, drift outside the
 * declared scope, a protected-path violation, consumer incompatibility, or a
 * runtime step limit. Each stop carries the evidence refs behind it.
 */
import { createHash, randomUUID } from "node:crypto";
import type { RunEventDraft, RunEventSink } from "../../run-events.js";
import type { EvidenceSnapshot, SubtaskContract, VerificationResult } from "../../types.js";
import {
  RepositoryTrajectoryObserver,
  type TrajectoryGitClient,
} from "./repository-trajectory.js";

export type { EvidenceSnapshot } from "../../types.js";

export interface TrajectoryStop {
  reason:
    | "no_evidence_progress"
    | "repeated_signature"
    | "state_oscillation"
    | "scope_drift"
    | "protected_violation"
    | "consumer_incompatibility"
    | "runtime_step_limit";
  evidenceRefs: string[];
}

export type TrajectoryAction = "continue" | "warn" | "stop";

export interface ObserveResult {
  action: TrajectoryAction;
  reason?: TrajectoryStop["reason"];
}

export interface TrajectoryProgress {
  state: "unknown" | "unchanged" | "progressing" | "terminal";
  checkpointId: string | null;
}

export interface TrajectoryClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}

export interface TrajectoryMonitorOptions {
  attemptId: string;
  workspacePath?: string;
  git?: TrajectoryGitClient;
  checkpointMs?: number;
  maxSteps?: number | null;
  repeatedSignatureLimit?: number | null;
  clock?: TrajectoryClock;
  contract?: SubtaskContract;
  now?: () => string;
}

const UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const DURATION = /\b\d+(?:\.\d+)?(?:ms|s)\b/gi;
const JOB_ID = /("job_id"\s*:\s*")[^"]+"/gi;
const OFFSET = /("(stdout_offset|stderr_offset)"\s*:\s*)\d+/gi;

const defaultClock: TrajectoryClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

export class TrajectoryMonitor {
  private readonly attemptId: string;
  private readonly maxSteps: number | null;
  private readonly repeatedLimit: number | null;
  private readonly checkpointMs: number;
  private readonly clock: TrajectoryClock;
  private readonly isoNow: () => string;
  private readonly contract?: SubtaskContract;
  private readonly observer: RepositoryTrajectoryObserver | null;
  private readonly startedAt: number;
  private readonly recorded: EvidenceSnapshot[] = [];
  private readonly leasedCheckpoints = new Set<string>();
  private gitQueue: Promise<void> = Promise.resolve();
  private gitInflight = 0;
  private stop: TrajectoryStop | null = null;
  private terminalResolve!: (value: TrajectoryStop) => void;
  private readonly terminalPromise: Promise<TrajectoryStop>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastSignature: string | null = null;
  private signatureStreak = 0;
  private unchangedStreak = 0;
  private lastEvidenceKey: string | null = null;
  private lastRisk = 0;
  private risingRisk = 0;
  private steps = 0;
  private terminalEvents = 0;
  private modelCalls = 0;
  private commands = 0;
  private toolCalls = 0;
  private mandatoryFailures = 0;
  private changedPaths: string[] = [];
  private consumerPassed = true;
  private regressionCount = 0;
  private lastProgress: TrajectoryProgress = { state: "unknown", checkpointId: null };
  private timerArmed = false;

  constructor(options: TrajectoryMonitorOptions) {
    this.attemptId = options.attemptId;
    this.maxSteps = options.maxSteps ?? null;
    this.repeatedLimit = options.repeatedSignatureLimit ?? null;
    this.checkpointMs = options.checkpointMs ?? 60_000;
    this.clock = options.clock ?? defaultClock;
    this.isoNow = options.now ?? (() => new Date().toISOString());
    if (options.contract) this.contract = options.contract;
    this.startedAt = this.clock.now();
    this.observer =
      options.git && options.workspacePath
        ? new RepositoryTrajectoryObserver(options.git, {
            cwd: options.workspacePath,
            timeoutMs: 5_000,
          })
        : null;
    this.terminalPromise = new Promise((resolve) => {
      this.terminalResolve = resolve;
    });
  }

  wrapSink(sink: RunEventSink): RunEventSink {
    this.armTimer();
    return {
      emit: (draft: RunEventDraft): void => {
        sink.emit(draft);
        const result = this.observe(draft);
        if (this.observer && shouldCaptureGit(draft)) {
          const run = (): Promise<void> => {
            this.gitInflight += 1;
            return this.applyGitCapture(result).finally(() => {
              this.gitInflight -= 1;
            });
          };
          this.gitQueue = this.gitInflight === 0 ? run() : this.gitQueue.then(run);
        }
      },
    };
  }

  private async applyGitCapture(result: ObserveResult): Promise<void> {
    if (!this.observer) return;
    const fingerprint = await this.observer.capture();
    if (this.observer.oscillating()) {
      this.finish("state_oscillation");
    } else if (fingerprint && result.action !== "stop") {
      this.noteGitFingerprint(fingerprint);
    }
  }

  observe(event: RunEventDraft): ObserveResult {
    if (this.stop) return { action: "stop", reason: this.stop.reason };
    this.tally(event);
    const nested = expandBatchSignatures(event);
    const signatures = nested.length > 0 ? nested : [normalizeSignature(event)];
    if (countsAsRuntimeStep(event)) {
      this.steps += signatures.length;
      if (this.maxSteps !== null && this.steps > this.maxSteps) {
        return this.finish("runtime_step_limit");
      }
    }

    const protectedHits = this.protectedHits(event);
    if (protectedHits.length > 0) {
      this.checkpoint(event, { protectedViolations: protectedHits });
      return this.finish("protected_violation");
    }

    let signatureStop: ObserveResult | null = null;
    for (const signature of signatures) {
      const repeated = this.noteSignature(signature);
      if (this.repeatedLimit !== null && repeated >= this.repeatedLimit) {
        signatureStop = { action: "stop", reason: "repeated_signature" };
      }
    }

    const paths = changedPathsOf(event);
    if (paths.length > 0) this.changedPaths = unique(this.changedPaths.concat(paths));
    const failures = parseMandatoryFailures(event);
    if (failures !== null) this.mandatoryFailures = failures;
    else if (event.status === "error" && isTestOrBuild(event)) this.mandatoryFailures = Math.max(this.mandatoryFailures, 1);

    const checkpointed = this.shouldCheckpoint(event);
    if (checkpointed) this.checkpoint(event, { protectedViolations: protectedHits });

    if (this.repeatedLimit !== null && this.risingRisk >= this.repeatedLimit) {
      return this.finish("scope_drift");
    }

    if (
      this.repeatedLimit !== null &&
      checkpointed &&
      this.unchangedStreak >= this.repeatedLimit
    ) {
      return this.finish("no_evidence_progress");
    }
    if (signatureStop && !this.evidenceImproved()) {
      return this.finish("repeated_signature");
    }
    if (signatureStop) {
      this.markProgressing();
      return { action: "continue" };
    }
    if (
      this.repeatedLimit !== null &&
      this.unchangedStreak === this.repeatedLimit - 1 &&
      checkpointed
    ) {
      this.lastProgress = { state: "unchanged", checkpointId: this.recorded.at(-1)?.id ?? null };
      return { action: "warn" };
    }
    if (this.repeatedLimit !== null && this.signatureStreak === this.repeatedLimit - 1) {
      return { action: "warn" };
    }
    if (this.evidenceImproved() || this.lastProgress.state === "progressing") {
      this.markProgressing();
      return { action: "continue" };
    }
    if (this.recorded.length > 0) {
      this.lastProgress = {
        state: this.unchangedStreak > 0 ? "unchanged" : "progressing",
        checkpointId: this.recorded.at(-1)?.id ?? null,
      };
    }
    return { action: "continue" };
  }

  async observeVerification(result: VerificationResult): Promise<void> {
    this.consumerPassed = result.gates.filter((gate) => gate.tier === "consumer").every((gate) => gate.passed);
    this.regressionCount = result.regressionCount;
    if (!result.mandatoryPassed) this.mandatoryFailures = Math.max(this.mandatoryFailures, 1);
    this.checkpoint(null, {
      source: "verification",
      consumerPassed: this.consumerPassed,
      regressionCount: this.regressionCount,
    });
    if (
      result.gates.some((gate) => gate.tier === "consumer" && !gate.passed) ||
      (result.regressionCount > 0 && !this.consumerPassed)
    ) {
      this.finish("consumer_incompatibility");
    }
  }

  progress(): TrajectoryProgress {
    if (this.stop) return { state: "terminal", checkpointId: this.recorded.at(-1)?.id ?? null };
    return this.lastProgress;
  }

  consumeProgressLease(): string | null {
    const current = this.progress();
    if (current.state !== "progressing" || !current.checkpointId) return null;
    if (this.leasedCheckpoints.has(current.checkpointId)) return null;
    this.leasedCheckpoints.add(current.checkpointId);
    return current.checkpointId;
  }

  terminal(): Promise<TrajectoryStop> {
    return this.terminalPromise;
  }

  async drain(): Promise<void> {
    await this.gitQueue;
    this.disarmTimer();
  }

  dispose(): void {
    this.disarmTimer();
  }

  snapshots(): EvidenceSnapshot[] {
    return [...this.recorded];
  }

  private finish(reason: TrajectoryStop["reason"]): ObserveResult {
    if (!this.stop) {
      this.stop = {
        reason,
        evidenceRefs: this.recorded.map((item) => item.id),
      };
      this.lastProgress = { state: "terminal", checkpointId: this.recorded.at(-1)?.id ?? null };
      this.disarmTimer();
      this.terminalResolve(this.stop);
    }
    return { action: "stop", reason: this.stop.reason };
  }

  private noteSignature(signature: string): number {
    if (signature === this.lastSignature) this.signatureStreak += 1;
    else {
      this.lastSignature = signature;
      this.signatureStreak = 1;
    }
    return this.signatureStreak;
  }

  private shouldCheckpoint(event: RunEventDraft): boolean {
    if (event.status === "in_progress") return false;
    if (event.kind === "file_change") return true;
    if (isTestOrBuild(event)) return true;
    if (event.status === "error" && this.signatureStreak >= 2) return true;
    this.terminalEvents += 1;
    return this.terminalEvents % 4 === 0;
  }

  private checkpoint(
    event: RunEventDraft | null,
    extra: Partial<EvidenceSnapshot> = {},
  ): EvidenceSnapshot {
    const previous = this.recorded.at(-1);
    const paths = extra.changedPaths ?? (event ? changedPathsOf(event) : [...this.changedPaths]);
    const protectedViolations = extra.protectedViolations ?? [];
    const diffRiskUnits = extra.diffRiskUnits ?? this.outOfScopeRisk(paths);
    const failureFingerprints =
      extra.failureFingerprints ??
      (event?.status === "error" ? [normalizeSignature(event)] : previous?.failureFingerprints ?? []);
    const snapshot = buildSnapshot({
      attemptId: this.attemptId,
      sequence: this.recorded.length + 1,
      source: extra.source ?? "runtime",
      mandatoryFailures: extra.mandatoryFailures ?? this.mandatoryFailures,
      consumerPassed: extra.consumerPassed ?? this.consumerPassed,
      regressionCount: extra.regressionCount ?? this.regressionCount,
      failureFingerprints,
      changedPaths: paths,
      protectedViolations,
      diffRiskUnits,
      modelCalls: this.modelCalls,
      commands: this.commands,
      toolCalls: this.toolCalls,
      elapsedMs: this.clock.now() - this.startedAt,
      createdAt: this.isoNow(),
    });
    const key = evidenceKey(snapshot);
    if (!previous) {
      this.lastEvidenceKey = key;
      this.lastRisk = diffRiskUnits;
      if (diffRiskUnits > 0) this.risingRisk = 1;
      if (paths.length > 0) {
        this.unchangedStreak = 0;
        this.markProgressing(snapshot.id);
      } else {
        this.unchangedStreak = 1;
        this.lastProgress = { state: "unchanged", checkpointId: snapshot.id };
      }
      this.recorded.push(snapshot);
      return snapshot;
    }
    const improved = snapshot.mandatoryFailures < previous.mandatoryFailures;
    if (key === this.lastEvidenceKey) {
      this.unchangedStreak += 1;
      this.lastProgress = { state: "unchanged", checkpointId: snapshot.id };
    } else if (improved) {
      this.unchangedStreak = 0;
      this.signatureStreak = 0;
      this.risingRisk = 0;
      this.markProgressing(snapshot.id);
    } else if (diffRiskUnits > this.lastRisk && snapshot.mandatoryFailures >= previous.mandatoryFailures) {
      this.unchangedStreak = 0;
      this.risingRisk += 1;
      this.lastProgress = { state: "unchanged", checkpointId: snapshot.id };
    } else {
      this.unchangedStreak = 0;
      this.risingRisk = diffRiskUnits < this.lastRisk ? 0 : this.risingRisk;
      this.markProgressing(snapshot.id);
    }
    this.lastEvidenceKey = key;
    this.lastRisk = diffRiskUnits;
    this.recorded.push(snapshot);
    return snapshot;
  }

  private evidenceImproved(): boolean {
    if (this.recorded.length < 2) return false;
    const prev = this.recorded[this.recorded.length - 2]!;
    const last = this.recorded[this.recorded.length - 1]!;
    return last.mandatoryFailures < prev.mandatoryFailures;
  }

  private markProgressing(checkpointId?: string): void {
    this.lastProgress = {
      state: "progressing",
      checkpointId: checkpointId ?? this.recorded.at(-1)?.id ?? null,
    };
  }

  private noteGitFingerprint(_fingerprint: string): void {
    const snapshot = this.recorded.at(-1);
    if (snapshot) this.lastProgress = { ...this.lastProgress, checkpointId: snapshot.id };
  }

  private protectedHits(event: RunEventDraft): string[] {
    const allowed = this.contract?.protectedPaths ?? [];
    if (allowed.length === 0) return [];
    return changedPathsOf(event).filter((value) =>
      allowed.some((item) => value === item || value.startsWith(item + "/") || value.startsWith(item + "\\")),
    );
  }

  private outOfScopeRisk(paths: string[]): number {
    const allowed = this.contract?.allowedMutationPaths ?? [];
    if (allowed.length === 0) return 0;
    return paths.filter((value) => !allowed.some((item) => pathAllowed(value, item))).length;
  }

  private tally(event: RunEventDraft): void {
    if (event.kind === "command") this.commands += 1;
    if (event.kind === "mcp_tool") this.toolCalls += 1;
    if (event.kind === "turn" || event.kind === "api_call") this.modelCalls += 1;
  }

  private armTimer(): void {
    if (this.timerArmed || this.checkpointMs <= 0) return;
    this.timerArmed = true;
    const tick = (): void => {
      if (this.stop) return;
      this.checkpoint(null, { source: "runtime" });
      if (this.repeatedLimit !== null && this.unchangedStreak >= this.repeatedLimit) {
        this.finish("no_evidence_progress");
        return;
      }
      this.timer = this.clock.setTimeout(tick, this.checkpointMs);
    };
    this.timer = this.clock.setTimeout(tick, this.checkpointMs);
  }

  private disarmTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.timerArmed = false;
  }
}

function buildSnapshot(base: Omit<EvidenceSnapshot, "id" | "stateFingerprint" | "contentHash">): EvidenceSnapshot {
  const failureFingerprints = [...new Set(base.failureFingerprints.map((value) =>
    /^[0-9a-f]{64}$/u.test(value)
      ? value
      : createHash("sha256").update(value).digest("hex")))].sort();
  const serializedState = [
    base.source,
    base.mandatoryFailures,
    base.consumerPassed,
    base.regressionCount,
    failureFingerprints.join(","),
    base.changedPaths.join(","),
    base.protectedViolations.join(","),
    base.diffRiskUnits,
  ].join("|");
  const stateFingerprint = createHash("sha256").update(serializedState).digest("hex");
  return {
    ...base,
    failureFingerprints,
    id: randomUUID(),
    stateFingerprint,
    contentHash: createHash("sha256").update(stateFingerprint).digest("hex"),
  };
}

function evidenceKey(snapshot: EvidenceSnapshot): string {
  return [
    snapshot.mandatoryFailures,
    snapshot.changedPaths.join("\0"),
    snapshot.failureFingerprints.join("\0"),
    snapshot.consumerPassed,
    snapshot.regressionCount,
  ].join("|");
}

export function normalizeSignature(event: RunEventDraft): string {
  const command = stripVolatile(event.input.command ?? event.input.tool ?? event.name);
  const output = boundedFingerprint(stripVolatile(event.output.text ?? event.error?.message ?? ""));
  const gate = typeof event.attributes.failedGate === "string" ? event.attributes.failedGate : "";
  return [
    event.kind,
    command,
    event.status,
    event.output.exitCode ?? "",
    event.error?.code ?? "",
    gate,
    output,
    changedPathsOf(event).slice().sort().join(","),
  ].join(":");
}

export function expandBatchSignatures(event: RunEventDraft): string[] {
  if (!isBatchTool(event)) return [];
  const calls = readBatchCalls(event).slice(0, 8);
  return calls.map((call) =>
    stripVolatile((call.tool_name ?? call.tool ?? "") + ":" + JSON.stringify(call.arguments ?? {})),
  );
}

function isBatchTool(event: RunEventDraft): boolean {
  const name = (event.input.tool ?? event.name ?? "").toLowerCase();
  return name.includes("batch_tool_call");
}

function readBatchCalls(event: RunEventDraft): Array<{ tool_name?: string; tool?: string; arguments?: unknown }> {
  const attributed = event.attributes.calls;
  if (Array.isArray(attributed)) return attributed as Array<{ tool_name?: string; arguments?: unknown }>;
  const text = event.input.text;
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { calls?: unknown };
    return Array.isArray(parsed.calls) ? parsed.calls as Array<{ tool_name?: string; arguments?: unknown }> : [];
  } catch {
    return [];
  }
}

function stripVolatile(value: string): string {
  return value
    .replace(UUID, "<id>")
    .replace(ISO_TIME, "<time>")
    .replace(DURATION, "<dur>")
    .replace(JOB_ID, '$1<id>"')
    .replace(OFFSET, "$1*")
    .replace(/\s+/g, " ")
    .trim();
}

function boundedFingerprint(value: string): string {
  const normalized = value.replace(/\b\d+\b/g, "#");
  if (normalized.length <= 80) return normalized;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function countsAsRuntimeStep(event: RunEventDraft): boolean {
  if (event.status === "in_progress") return false;
  if (event.kind === "run" || event.kind === "file_change") return false;
  return event.kind === "turn" || event.kind === "mcp_tool" || event.kind === "command" || event.kind === "api_call";
}

function pathAllowed(value: string, allowed: string): boolean {
  return value === allowed || value.startsWith(allowed.endsWith("/") ? allowed : allowed + "/");
}

function changedPathsOf(event: RunEventDraft): string[] {
  return unique([...(event.input.paths ?? []), ...(event.output.changedFiles ?? [])]);
}

function isTestOrBuild(event: RunEventDraft): boolean {
  if (event.kind !== "command") return false;
  const command = event.input.command ?? "";
  return /\b(npm test|npm run test|cargo test|go test|make (?:test|check|build)|vitest|jest|pytest|tsc|eslint)\b/i.test(
    command,
  );
}

function parseMandatoryFailures(event: RunEventDraft): number | null {
  const text = event.output.text ?? "";
  const match = text.match(/(\d+)\s+failed/i);
  if (!match) return null;
  return Number(match[1]);
}

function shouldCaptureGit(event: RunEventDraft): boolean {
  return event.kind === "file_change" && event.status !== "in_progress";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
