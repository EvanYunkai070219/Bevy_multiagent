import { RunCancelledError } from "./errors.js";
import { AttemptWorkspaceManager } from "./attempt-workspace-manager.js";
import {
  ContributionCollector,
  ContributionError,
  parseContributionCommitMarker,
} from "./contribution-collector.js";
import { looksLikeUnparsedToolCall } from "./tool-call-protocol.js";
import { classifyWorkerError } from "./orchestration/scheduler.js";
import { TrajectoryStoppedError } from "./orchestration/healing/fault-detector.js";
import type {
  AttemptWorkspaceRecord,
  ProjectRunRecord,
  RunnerResult,
  WorkerResult,
} from "./types.js";

export interface ProjectAttemptPersistence {
  persistAttemptStarted(
    runId: string,
    expectedProject: ProjectRunRecord,
    attempt: AttemptWorkspaceRecord,
  ): Promise<void>;
  persistContributionReady(
    runId: string,
    expected: AttemptWorkspaceRecord,
    headCommit: string,
    authorityEpoch: number,
  ): Promise<void>;
  persistAttemptFailure(
    runId: string,
    expected: AttemptWorkspaceRecord,
    state: "failed" | "cancelled",
    reason: string,
  ): Promise<void>;
  persistCompensationEvidence(
    runId: string,
    attempt: AttemptWorkspaceRecord,
    reason: string,
  ): Promise<void>;
  persistAttemptRecoveryEvidence(
    runId: string,
    expected: AttemptWorkspaceRecord,
  ): Promise<void>;
  loadProject(runId: string): ProjectRunRecord | null;
  withAuthorityLock<T>(runId: string, operation: () => Promise<T>): Promise<T>;
  beforeContributionReadyForTest?(): Promise<void>;
}

export interface ProjectAttemptExecuteInput {
  runId: string;
  project: ProjectRunRecord;
  attemptId: string;
  revision: number;
  subtaskId: string;
  baseCommit: string;
  authorityEpoch: number;
  throwIfCancelled: () => void;
  run: (workspacePath: string, attempt: AttemptWorkspaceRecord) => Promise<RunnerResult>;
  repairCommitMarker?: (input: {
    attempt: AttemptWorkspaceRecord;
    runnerResult: RunnerResult;
    error: ContributionError;
  }) => Promise<RunnerResult | null>;
  quiesce: () => Promise<void>;
  afterQuiesce?: (runnerResult: RunnerResult) => Promise<void>;
  existingAttempt?: AttemptWorkspaceRecord;
}

export class ProjectAttemptExecutor {
  constructor(
    private readonly attemptWorkspaces: AttemptWorkspaceManager,
    private readonly contributionCollector: ContributionCollector,
    private readonly persistence: ProjectAttemptPersistence,
  ) {}

  async execute(input: ProjectAttemptExecuteInput): Promise<{
    runnerResult: RunnerResult;
    workerResult: WorkerResult;
  }> {
    const started = Date.now();
    let attempt: AttemptWorkspaceRecord | null = null;
    let ownsPersistedAttempt = false;
    let runnerResult: RunnerResult | null = null;
    let quiesced = false;
    const quiesceOnce = async () => {
      if (quiesced) return;
      quiesced = true;
      try {
        await input.quiesce();
      } catch (error) {
        throw new RuntimeAbsenceUnprovenError(error);
      }
    };
    try {
      if (input.existingAttempt) {
        attempt = input.existingAttempt;
        ownsPersistedAttempt = true;
      } else {
        attempt = await this.attemptWorkspaces.create({
          runId: input.runId,
          project: input.project,
          attemptId: input.attemptId,
          revision: input.revision,
          subtaskId: input.subtaskId,
          baseCommit: input.baseCommit,
        });
        await this.persistence.persistAttemptStarted(input.runId, input.project, attempt);
        ownsPersistedAttempt = true;
      }
      runnerResult = await input.run(attempt.workspacePath, attempt);
      try {
        parseContributionCommitMarker(runnerResult.output);
      } catch (error) {
        if (looksLikeUnparsedToolCall(runnerResult.output)) {
          throw new ContributionError(
            "contribution_tool_protocol_failed",
            "Model emitted tool-call markup as assistant text; no native tool calls ran, so contribution repair would repeat the broken protocol",
          );
        }
        if (
          input.repairCommitMarker &&
          error instanceof ContributionError &&
          error.code === "contribution_marker_invalid"
        ) {
          const repaired = await input.repairCommitMarker({
            attempt,
            runnerResult,
            error,
          });
          if (repaired !== null) runnerResult = repaired;
        }
      }
      await quiesceOnce();
      input.throwIfCancelled();
      if (input.afterQuiesce) await input.afterQuiesce(runnerResult);
      input.throwIfCancelled();
      // Stalls throw from run() and never reach structural collection.
      const contribution = await this.contributionCollector.collect({
        attempt,
        subtaskId: input.subtaskId,
        workerOutput: runnerResult.output,
      });
      input.throwIfCancelled();
      await this.persistence.withAuthorityLock(input.runId, async () => {
        await this.persistence.beforeContributionReadyForTest?.();
        input.throwIfCancelled();
        await this.persistence.persistContributionReady(
          input.runId,
          attempt!,
          contribution.headCommit,
          input.authorityEpoch,
        );
      });
      return {
        runnerResult,
        workerResult: {
          subtaskId: input.subtaskId,
          workerId: null,
          workerRunId: null,
          iteration: 1,
          attempt: 1,
          status: "contribution_ready",
          output: runnerResult.output,
          usage: runnerResult.usage,
          durationMs: Date.now() - started,
          artifacts: [],
          contribution,
        },
      };
    } catch (error) {
      let terminalError = error;
      try {
        await quiesceOnce();
      } catch (quiesceError) {
        terminalError = quiesceError;
      }
      if (attempt && !ownsPersistedAttempt) {
        const latestProject = this.persistence.loadProject(input.runId);
        if (latestProject) {
          const recovery = await this.attemptWorkspaces.compensateUnpersisted(
            latestProject,
            attempt,
          );
          if (recovery.action === "preserved") {
            await this.persistence.persistCompensationEvidence(
              input.runId,
              attempt,
              workerErrorMessage(terminalError),
            ).catch(() => undefined);
          }
        }
      }
      const status = classifyWorkerError(terminalError);
      let message = workerErrorMessage(terminalError);
      if (attempt && ownsPersistedAttempt) {
        try {
          await this.persistence.persistAttemptFailure(
            input.runId,
            attempt,
            status === "cancelled" ? "cancelled" : "failed",
            message,
          );
        } catch {
          message += "; attempt_failure_persistence_failed";
          await this.persistence.persistAttemptRecoveryEvidence(input.runId, attempt)
            .catch(() => undefined);
        }
      }
      return {
        runnerResult: runnerResult ?? { output: "", threadId: null, usage: null },
        workerResult: {
          subtaskId: input.subtaskId,
          workerId: null,
          workerRunId: null,
          iteration: 1,
          attempt: 1,
          status,
          output: runnerResult?.output ?? "",
          error: message,
          usage: runnerResult?.usage ?? null,
          durationMs: Date.now() - started,
          artifacts: [],
        },
      };
    }
  }
}

function workerErrorMessage(error: unknown): string {
  if (error instanceof RuntimeAbsenceUnprovenError) return "infrastructure_failure";
  if (error instanceof TrajectoryStoppedError) return error.message;
  if (error instanceof ContributionError) return error.code + ": " + error.message;
  if (error instanceof RunCancelledError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

class RuntimeAbsenceUnprovenError extends Error {
  readonly name = "RuntimeAbsenceUnprovenError";

  constructor(cause: unknown) {
    super("infrastructure_failure", { cause });
  }
}
