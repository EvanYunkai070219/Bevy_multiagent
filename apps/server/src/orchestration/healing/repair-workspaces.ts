import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AttemptWorkspaceManager } from "../../attempt-workspace-manager.js";
import { GitClient, GitCommandError } from "../../git-client.js";
import type { RunEventDraft } from "../../run-events.js";
import type {
  AttemptWorkspaceRecord,
  ContributionRecord,
  MutationCandidate,
  ProjectRunRecord,
  RepairCheckpoint,
  HealingState,
  SubtaskContract,
  TaskNodeState,
} from "../../types.js";
import type {
  CandidateContextManifestV1,
  RuntimeCapabilityManifestV2,
} from "../evolution/evolution-types.js";
import {
  canonicalHash,
  runtimeCapabilityFingerprint,
} from "../evolution/evolution-fingerprints.js";
import {
  candidateContextHash,
  serializeCandidateContextManifest,
} from "./candidate-context-manifest.js";

export interface FreezeRepairCheckpointInput {
  runId: string;
  project: ProjectRunRecord;
  node: TaskNodeState;
  attempt: AttemptWorkspaceRecord;
  contract: SubtaskContract;
  authorityManifestHash: string;
  /** Legacy context refs remain readable but make a new checkpoint incomplete. */
  contextEvidenceRefs?: string[];
  /** Raw snapshots/diagnosis remain audit-only and are never copied to the candidate bundle. */
  contextAuditEvidenceRefs?: string[];
  candidateContextManifest?: CandidateContextManifestV1;
  /** Legacy hashes remain readable but cannot make a schema-v2 checkpoint complete. */
  runtimeCapabilityHash?: string;
  runtimeCapabilityManifest?: RuntimeCapabilityManifestV2 | Record<string, unknown>;
}

export interface CreateRepairCandidateInput {
  runId: string;
  project: ProjectRunRecord;
  checkpoint: RepairCheckpoint;
  candidate: MutationCandidate;
  revision: number;
}

export interface SquashRepairWinnerInput {
  project: ProjectRunRecord;
  checkpoint: RepairCheckpoint;
  candidate: MutationCandidate;
  attempt: AttemptWorkspaceRecord;
  verificationIds: string[];
}

export interface RepairWorkspaceHooks {
  beforeFingerprintForTest?(): Promise<void>;
  afterSnapshotBeforeRevalidateForTest?(): Promise<void>;
}

export class RepairCheckpointError extends Error {
  readonly name = "RepairCheckpointError";
  readonly cause?: unknown;

  constructor(
    readonly code: "checkpoint_unavailable" | "repair_workspace_rejected" | "repair_candidate_rejected",
    message: string,
    cause?: unknown,
  ) {
    super(message);
    Object.defineProperty(this, "cause", { value: cause, enumerable: false, configurable: true });
  }
}

export class RepairWorkspaceManager {
  private readonly records = new Map<string, { file: string; bundleDir: string; checkpoint: RepairCheckpoint }>();

  constructor(
    private readonly git: GitClient,
    private readonly attempts: AttemptWorkspaceManager,
    private readonly options: {
      commonWorkspacePath?: string;
      sink?: { emit(draft: RunEventDraft): void };
      hooks?: RepairWorkspaceHooks;
      emitTournamentStarted?: boolean;
    } = {},
  ) {}

  async freeze(input: FreezeRepairCheckpointInput): Promise<RepairCheckpoint> {
    try {
      this.assertHealingProject(input.project);
      this.assertFreezeAdmission(input);
      await this.attempts.assertExactOwner(input.project, input.attempt);
      await this.options.hooks?.beforeFingerprintForTest?.();
      await this.git.trajectoryFingerprint(input.attempt.workspacePath, 5_000);
      await this.git.validateStandaloneAttempt(input.attempt.workspacePath, input.attempt.baseCommit);
      const snapshot = await this.git.snapshotWorkingTree(input.attempt.workspacePath, input.attempt.baseCommit);
      if (!(await this.git.isAncestor(input.attempt.workspacePath, input.attempt.baseCommit, snapshot.commit))) {
        throw rejected("Checkpoint is not descended from the attempt base");
      }
      const id = createHash("sha256")
        .update(input.runId)
        .update("\0")
        .update(snapshot.commit)
        .digest("hex")
        .slice(0, 32);
      const runDir = path.dirname(path.resolve(input.project.canonicalWorkspacePath));
      const bundleDir = path.join(runDir, "repair-checkpoints", id, "bundle");
      const context = input.candidateContextManifest === undefined
        ? {
            bundleHash: await this.freezeContextBundle(input.contextEvidenceRefs ?? [], bundleDir),
            evidenceRefs: [...(input.contextEvidenceRefs ?? [])],
            faultEvidenceHash: "",
            complete: false,
          }
        : await this.freezeCandidateContext(input.candidateContextManifest, bundleDir);
      const runtime = input.runtimeCapabilityManifest === undefined
        ? {
            hash: input.runtimeCapabilityHash ?? "",
            complete: false,
          }
        : runtimeCapabilityFingerprint(input.runtimeCapabilityManifest);
      await this.options.hooks?.afterSnapshotBeforeRevalidateForTest?.();
      await this.attempts.assertExactOwner(input.project, input.attempt);
      const repositoryBaseHash = canonicalHash({
        baseCommit: input.project.source.baseCommit,
        sourceFingerprint: input.project.source.sourceFingerprint,
      });
      const contractHash = canonicalHash(input.contract);
      const sourceComplete =
        /^[0-9a-f]{40}$/u.test(input.project.source.baseCommit ?? "") &&
        /^[0-9a-f]{64}$/u.test(input.project.source.sourceFingerprint);
      const checkpoint: RepairCheckpoint = {
        id,
        runId: input.runId,
        subtaskId: input.node.subtaskId,
        taskRevision: input.node.revision,
        sourceAttemptId: input.attempt.attemptId,
        sourceAttemptRevision: input.attempt.revision,
        originalBaseCommit: input.attempt.baseCommit,
        checkpointCommit: snapshot.commit,
        treeHash: snapshot.treeHash,
        fingerprintSchemaVersion: 2,
        fingerprintComplete:
          sourceComplete &&
          /^[0-9a-f]{64}$/u.test(input.authorityManifestHash) &&
          runtime.complete &&
          context.complete,
        repositoryBaseHash,
        contractHash,
        authorityManifestHash: input.authorityManifestHash,
        contextBundleHash: context.bundleHash,
        faultEvidenceHash: context.faultEvidenceHash,
        contextEvidenceRefs: context.evidenceRefs,
        contextAuditEvidenceRefs: sortedUnique(input.contextAuditEvidenceRefs ?? []),
        runtimeCapabilityHash: runtime.hash,
        allowedMutationPaths: [...input.contract.allowedMutationPaths],
        protectedPaths: [...input.contract.protectedPaths],
        createdAt: new Date().toISOString(),
      };
      const file = path.join(runDir, "repair-checkpoints", id + ".json");
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, JSON.stringify(checkpoint), "utf8");
      this.records.set(id, { file, bundleDir, checkpoint });
      if (this.options.emitTournamentStarted !== false) this.emitTournamentStarted(checkpoint);
      return checkpoint;
    } catch (error) {
      throw this.mapFreezeError(error);
    }
  }

  async observe(checkpoint: RepairCheckpoint): Promise<Pick<RepairCheckpoint, "treeHash" | "contextBundleHash">> {
    const recorded = this.records.get(checkpoint.id)?.checkpoint ?? checkpoint;
    return { treeHash: recorded.treeHash, contextBundleHash: recorded.contextBundleHash };
  }

  async persistBoundCheckpoint(checkpoint: RepairCheckpoint): Promise<void> {
    const record = this.records.get(checkpoint.id);
    if (!record || !/^[0-9a-f]{64}$/u.test(checkpoint.repairGraphFenceHash ?? "")) {
      throw rejected("Repair checkpoint fence binding is invalid");
    }
    const bound = structuredClone(checkpoint);
    const temporary = record.file + ".tmp";
    await writeFile(temporary, JSON.stringify(bound), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, record.file);
    record.checkpoint = bound;
  }

  async readContextBundle(checkpoint: RepairCheckpoint): Promise<Record<string, Buffer>> {
    const directory = this.records.get(checkpoint.id)?.bundleDir;
    if (!directory) throw rejected("Frozen context bundle is missing");
    const entries: Record<string, Buffer> = {};
    for (const ref of checkpoint.contextEvidenceRefs) {
      entries[ref] = await readFile(path.join(directory, ref));
    }
    return entries;
  }

  async createCandidate(input: CreateRepairCandidateInput): Promise<AttemptWorkspaceRecord> {
    try {
      this.assertHealingProject(input.project);
      const source = input.project.attempts.find(
        (item) =>
          item.attemptId === input.checkpoint.sourceAttemptId &&
          item.revision === input.checkpoint.sourceAttemptRevision,
      );
      if (!source) throw rejected("Repair candidate is missing its source attempt");
      await this.attempts.assertExactOwner(input.project, source);
      if (
        input.candidate.checkpointId !== input.checkpoint.id ||
        !(await this.git.isAncestor(
          source.workspacePath,
          input.checkpoint.originalBaseCommit,
          input.checkpoint.checkpointCommit,
        ))
      ) {
        throw rejected("Checkpoint is not descended from the attempt base");
      }
      return await this.attempts.create({
        runId: input.runId,
        project: input.project,
        attemptId: input.candidate.id,
        revision: input.revision,
        subtaskId: input.checkpoint.subtaskId,
        baseCommit: input.checkpoint.originalBaseCommit,
        kind: "repair",
        checkpointId: input.checkpoint.id,
        checkpointHash: input.checkpoint.checkpointCommit,
        sourceOwnerFingerprint: createHash("sha256").update(source.ownerToken).digest("hex"),
        sourceWorkspace: source.workspacePath,
        expectedHead: input.checkpoint.checkpointCommit,
      });
    } catch (error) {
      throw this.mapCandidateError(error);
    }
  }

  async squashWinner(input: SquashRepairWinnerInput): Promise<ContributionRecord> {
    try {
      this.assertHealingProject(input.project);
      if (
        input.candidate.attemptId !== input.attempt.attemptId ||
        input.attempt.kind !== "repair" ||
        input.attempt.checkpointId !== input.checkpoint.id
      ) {
        throw rejected("Squash authority does not match the repair candidate");
      }
      const recorded = input.project.attempts.find(
        (item) =>
          item.attemptId === input.attempt.attemptId &&
          item.revision === input.attempt.revision &&
          item.ownerToken === input.attempt.ownerToken &&
          item.workspacePath === input.attempt.workspacePath,
      );
      if (!recorded) throw rejected("Squash authority does not match the repair candidate");
      await this.revalidateSquashOwner(input.project, recorded, input.checkpoint.originalBaseCommit);
      const head = await this.git.head(input.attempt.workspacePath);
      const tree = await this.git.run(input.attempt.workspacePath, ["rev-parse", head + "^{tree}"]);
      await this.revalidateSquashOwner(input.project, recorded, input.checkpoint.originalBaseCommit);
      const squashed = await this.git.commitTree(
        input.attempt.workspacePath,
        tree,
        input.checkpoint.originalBaseCommit,
        "launchpad repair winner",
      );
      if (
        !(await this.git.isAncestor(input.attempt.workspacePath, input.checkpoint.originalBaseCommit, squashed)) ||
        (await this.git.commitCount(input.attempt.workspacePath, input.checkpoint.originalBaseCommit, squashed)) !== 1
      ) {
        throw rejected("Squashed winner is not a one-commit descendant of the original base");
      }
      await this.revalidateSquashOwner(input.project, recorded, input.checkpoint.originalBaseCommit);
      await this.git.run(input.attempt.workspacePath, ["checkout", "--detach", squashed]);
      await this.revalidateSquashOwner(input.project, recorded, input.checkpoint.originalBaseCommit);
      const changedPaths = await this.git.changedPaths(
        input.attempt.workspacePath,
        input.checkpoint.originalBaseCommit,
        squashed,
      );
      this.assertAllowedPaths(changedPaths, input.checkpoint);
      const diffHash = createHash("sha256")
        .update(await this.git.binaryDiff(
          input.attempt.workspacePath,
          input.checkpoint.originalBaseCommit,
          squashed,
        ))
        .digest("hex");
      const ownerFingerprint = createHash("sha256").update(input.attempt.ownerToken).digest("hex");
      const contributionId = createHash("sha256")
        .update(input.attempt.attemptId)
        .update("\0")
        .update(String(input.attempt.revision))
        .update("\0")
        .update(ownerFingerprint)
        .update("\0")
        .update(input.attempt.subtaskId)
        .update("\0")
        .update(input.checkpoint.originalBaseCommit)
        .update("\0")
        .update(squashed)
        .update("\0")
        .update(diffHash)
        .digest("hex");
      return {
        contributionId,
        attemptId: input.attempt.attemptId,
        attemptRevision: input.attempt.revision,
        ownerFingerprint,
        subtaskId: input.attempt.subtaskId,
        baseCommit: input.checkpoint.originalBaseCommit,
        headCommit: squashed,
        changedPaths,
        diffHash,
        verificationLevel: "structural",
        verificationIds: [...input.verificationIds],
      };
    } catch (error) {
      throw this.mapCandidateError(error);
    }
  }

  async recover(project: ProjectRunRecord): Promise<void> {
    const attempts = path.join(path.dirname(path.resolve(project.canonicalWorkspacePath)), "attempts");
    let entries: string[] = [];
    try {
      entries = await readdir(attempts);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.startsWith("launchpad-repair-quarantine-")) continue;
      await rm(path.join(attempts, entry), { recursive: true, force: true });
    }
  }

  async recoverCandidates(
    project: ProjectRunRecord,
    healing: HealingState,
  ): Promise<Map<string, Awaited<ReturnType<AttemptWorkspaceManager["recover"]>>>> {
    const recovered = new Map<string, Awaited<ReturnType<AttemptWorkspaceManager["recover"]>>>();
    for (const attempt of project.attempts) {
      if (attempt.kind !== "repair" || attempt.cleanup !== "active") continue;
      const candidate = healing.candidates.find((item) => item.attemptId === attempt.attemptId);
      if (!candidate || candidate.state === "promoted") {
        recovered.set(attempt.attemptId, {
          action: "preserved",
          attemptId: attempt.attemptId,
          reason: "unverifiable",
        });
        continue;
      }
      recovered.set(attempt.attemptId, await this.attempts.recover(project, attempt));
    }
    return recovered;
  }

  private async freezeContextBundle(refs: string[], directory: string): Promise<string> {
    const files = await this.hashCommonWorkspace(this.options.commonWorkspacePath);
    const selected: Array<[string, Buffer]> = [];
    for (const ref of refs) {
      const match = files.get(ref);
      if (!match) throw unavailable("Frozen context evidence is missing from the common workspace");
      selected.push([ref, match]);
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const hash = createHash("sha256");
    for (const [ref, bytes] of selected) {
      hash.update(ref).update("\0").update(bytes);
      await writeFile(path.join(directory, ref), bytes);
    }
    return hash.digest("hex");
  }

  private async freezeCandidateContext(
    manifest: CandidateContextManifestV1,
    directory: string,
  ): Promise<{
    bundleHash: string;
    evidenceRefs: string[];
    faultEvidenceHash: string;
    complete: boolean;
  }> {
    const evidenceRef = candidateContextHash(manifest);
    if (evidenceRef === null) {
      return {
        bundleHash: await this.freezeContextBundle([], directory),
        evidenceRefs: [],
        faultEvidenceHash: "",
        complete: false,
      };
    }
    const bytes = Buffer.from(serializeCandidateContextManifest(manifest), "utf8");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, evidenceRef), bytes);
    const bundleHash = createHash("sha256")
      .update(evidenceRef)
      .update("\0")
      .update(bytes)
      .digest("hex");
    return {
      bundleHash,
      evidenceRefs: [evidenceRef],
      faultEvidenceHash: evidenceRef,
      complete: true,
    };
  }

  private async hashCommonWorkspace(root: string | undefined): Promise<Map<string, Buffer>> {
    const files = new Map<string, Buffer>();
    if (!root) return files;
    await this.walkFiles(root, async (file) => {
      const bytes = await readFile(file);
      files.set(createHash("sha256").update(bytes).digest("hex"), bytes);
    });
    return files;
  }

  private async walkFiles(root: string, visit: (file: string) => Promise<void>): Promise<void> {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(root, entry.name);
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await this.walkFiles(target, visit);
      else if (stat.isFile()) await visit(target);
    }
  }

  private emitTournamentStarted(checkpoint: RepairCheckpoint): void {
    if (!this.options.sink) return;
    const timestamp = new Date().toISOString();
    this.options.sink.emit({
      spanId: "healing-repair_tournament_started-" + checkpoint.subtaskId,
      parentSpanId: "run",
      kind: "delegation",
      name: "repair_tournament_started",
      status: "ok",
      startedAt: timestamp,
      endedAt: timestamp,
      durationMs: 0,
      input: {},
      output: { text: "Repair checkpoint frozen." },
      error: null,
      attributes: { checkpointId: checkpoint.id, subtaskId: checkpoint.subtaskId },
      usage: null,
    });
  }

  private async revalidateSquashOwner(
    project: ProjectRunRecord,
    recorded: AttemptWorkspaceRecord,
    originalBaseCommit: string,
  ): Promise<void> {
    await this.attempts.assertExactOwner(project, recorded);
    await this.git.validateStandaloneAttempt(recorded.workspacePath, originalBaseCommit);
  }

  private assertHealingProject(project: ProjectRunRecord): void {
    if (project.source.mode === "ephemeral_research") {
      throw rejected("ephemeral_research never enters repair");
    }
    if (
      (project.source.mode !== "new_project" && project.source.mode !== "existing_repository") ||
      !project.headCommit ||
      !project.source.baseCommit
    ) {
      throw rejected("Healing requires a Git-backed project");
    }
  }

  private assertFreezeAdmission(input: FreezeRepairCheckpointInput): void {
    if (input.attempt.state !== "failed") {
      throw rejected("Freeze requires a failed attempt");
    }
    if (input.attempt.kind === "repair") {
      throw rejected("Freeze cannot consume a repair candidate");
    }
    if (input.node.attemptId !== input.attempt.attemptId) {
      throw rejected("Freeze node does not match the failed attempt");
    }
    if (
      input.node.subtaskId !== input.attempt.subtaskId ||
      input.node.revision !== input.attempt.revision ||
      input.contract.subtaskId !== input.attempt.subtaskId ||
      input.contract.revision !== input.attempt.revision
    ) {
      throw rejected("Freeze node, attempt, and contract identities do not match");
    }
  }

  private assertAllowedPaths(changedPaths: string[], checkpoint: RepairCheckpoint): void {
    for (const changed of changedPaths) {
      if (pathCovered(changed, checkpoint.protectedPaths)) {
        throw rejected("Winner edits a protected path");
      }
      if (!pathCovered(changed, checkpoint.allowedMutationPaths)) {
        throw rejected("Winner edits a path outside the allowed mutation set");
      }
    }
  }

  private mapFreezeError(error: unknown): RepairCheckpointError {
    if (error instanceof RepairCheckpointError) return error;
    if (error instanceof GitCommandError && error.code === "git_timeout") {
      return unavailable("Git fingerprint timed out", error);
    }
    return rejected(error instanceof Error ? error.message : "Repair checkpoint was rejected", error);
  }

  private mapCandidateError(error: unknown): RepairCheckpointError {
    if (error instanceof RepairCheckpointError) return error;
    return rejected(error instanceof Error ? error.message : "Repair candidate was rejected", error);
  }
}

function unavailable(message: string, cause?: unknown): RepairCheckpointError {
  return new RepairCheckpointError("checkpoint_unavailable", message, cause);
}

function rejected(message: string, cause?: unknown): RepairCheckpointError {
  return new RepairCheckpointError("repair_workspace_rejected", message, cause);
}

function pathCovered(value: string, prefixes: string[]): boolean {
  return prefixes.some((item) => {
    const prefix = item.endsWith("/") ? item.slice(0, -1) : item;
    return value === item || value === prefix || value.startsWith(prefix + "/");
  });
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}
