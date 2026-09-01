import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AttemptWorkspaceManager } from "../src/attempt-workspace-manager.js";
import { GitClient, GitCommandError } from "../src/git-client.js";
import { createMutationCandidates } from "../src/orchestration/healing/mutation-factory.js";
import {
  canonicalHash,
  runtimeCapabilityFingerprint,
} from "../src/orchestration/evolution/evolution-fingerprints.js";
import {
  buildCandidateContextManifest,
  serializeCandidateContextManifest,
} from "../src/orchestration/healing/candidate-context-manifest.js";
import {
  RepairCheckpointError,
  RepairWorkspaceManager,
} from "../src/orchestration/healing/repair-workspaces.js";
import type { RunEventDraft } from "../src/run-events.js";
import type {
  AttemptWorkspaceRecord,
  DiagnosisRecord,
  EvidenceSnapshot,
  FaultRecord,
  ProjectRunRecord,
  RepairCheckpoint,
  SubtaskContract,
  TaskNodeState,
} from "../src/types.js";
import type {
  CandidateContextManifestV1,
  RuntimeCapabilityManifestV2,
} from "../src/orchestration/evolution/evolution-types.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface RepairFixture {
  git: GitClient;
  attempts: AttemptWorkspaceManager;
  project: ProjectRunRecord;
  base: string;
  common: string;
  evidenceRef: string;
  evidencePath: string;
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve());
  });
  return hash.digest("hex");
}

async function fixture(): Promise<RepairFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-repair-workspaces-"));
  directories.push(root);
  const canonical = path.join(root, ".runs", "run-1", "canonical");
  await mkdir(canonical, { recursive: true });
  const git = new GitClient(5_000);
  await git.run(canonical, ["init", "-b", "main"]);
  await writeFile(path.join(canonical, "README.md"), "initial\n", "utf8");
  await mkdir(path.join(canonical, "src"), { recursive: true });
  await writeFile(path.join(canonical, "src", "app.ts"), "export const n = 1;\n", "utf8");
  await git.run(canonical, ["add", "--", "README.md", "src/app.ts"]);
  await git.run(canonical, ["commit", "-m", "initial"]);
  const base = await git.head(canonical);
  const common = path.join(root, "common-workspace");
  await mkdir(common, { recursive: true });
  const evidencePath = path.join(common, "contract-evidence.json");
  await writeFile(evidencePath, JSON.stringify({ contract: "build-api", failed: true }) + "\n", "utf8");
  return {
    git,
    attempts: new AttemptWorkspaceManager(git),
    project: {
      source: {
        mode: "new_project",
        repositoryPath: canonical,
        requestedRevision: "seed",
        baseCommit: base,
        sourceFingerprint: "f".repeat(64),
      },
      runBranch: "main",
      canonicalWorkspacePath: canonical,
      headCommit: base,
      state: "ready",
      attempts: [],
      integrations: [],
    },
    base,
    common,
    evidenceRef: await hashFile(evidencePath),
    evidencePath,
  };
}

function persist(project: ProjectRunRecord, attempt: ProjectRunRecord["attempts"][number]): void {
  project.attempts.push({ ...attempt });
}

function contract(): SubtaskContract {
  return {
    subtaskId: "build-api",
    revision: 1,
    contractKey: "build-api",
    inputs: ["README.md"],
    outputs: ["src/app.ts"],
    dependencyIds: [],
    downstreamConsumers: ["build-ui"],
    allowedMutationPaths: ["src/", "README.md"],
    protectedPaths: [".launchpad/", "authority/"],
    artifactSchemaIds: [],
    targetedGateIds: ["unit"],
    contractGateIds: ["schema"],
    consumerGateIds: ["compat"],
    regressionGateIds: ["reg"],
    authorizedTools: ["list_files", "read_file", "search_files"],
  };
}

function node(attemptId: string): TaskNodeState {
  return {
    subtaskId: "build-api",
    revision: 1,
    state: "failed",
    blockedBy: [],
    attemptId,
    faultId: "fault-1",
    diagnosisId: "diag-1",
    tournamentId: null,
    verificationIds: [],
    integrationContributionId: null,
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
}

function fault(evidenceRef: string): FaultRecord {
  return {
    id: "fault-1",
    subtaskId: "build-api",
    revision: 1,
    class: "hard_failure",
    reasonCode: "targeted_gate_failed",
    summary: "unit failed",
    repairable: true,
    evidenceRefs: [evidenceRef],
    affectedConsumers: ["build-ui"],
    detectedAt: "2026-08-29T00:00:00.000Z",
  };
}

function diagnosis(): DiagnosisRecord {
  return {
    id: "diag-1",
    faultId: "fault-1",
    status: "available",
    classification: "context",
    rationale: "The worker missed frozen contract evidence.",
    allowedMutationFamilies: ["control", "context_patch", "strategy_patch"],
    createdAt: "2026-08-29T00:00:00.000Z",
  };
}

async function dirtyFailedAttempt(setup: RepairFixture) {
  const attempt = await setup.attempts.create({
    runId: "run-1",
    project: setup.project,
    attemptId: "failed-attempt",
    revision: 1,
    subtaskId: "build-api",
    baseCommit: setup.base,
  });
  persist(setup.project, { ...attempt, state: "failed" });
  const failed = { ...attempt, state: "failed" as const };
  await writeFile(path.join(failed.workspacePath, "README.md"), "tracked change\n", "utf8");
  await writeFile(path.join(failed.workspacePath, "src", "staged.ts"), "export const staged = true;\n", "utf8");
  await setup.git.run(failed.workspacePath, ["add", "--", "src/staged.ts"]);
  await writeFile(path.join(failed.workspacePath, "src", "untracked.ts"), "export const loose = true;\n", "utf8");
  return failed;
}

async function captureAttempt(git: GitClient, workspace: string) {
  const indexPath = path.join(workspace, ".git", "index");
  return {
    head: await git.head(workspace),
    index: await readFile(indexPath),
    staged: await git.run(workspace, ["diff", "--cached", "--name-only", "-z"]),
    status: await git.run(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]),
    refs: await git.run(workspace, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    config: await git.run(workspace, ["config", "--local", "--list"]),
    readme: await readFile(path.join(workspace, "README.md")),
    stagedFile: await readFile(path.join(workspace, "src", "staged.ts")),
    untracked: await readFile(path.join(workspace, "src", "untracked.ts")),
  };
}

function manager(
  setup: RepairFixture,
  extra: ConstructorParameters<typeof RepairWorkspaceManager>[2] = {},
) {
  return new RepairWorkspaceManager(setup.git, setup.attempts, {
    commonWorkspacePath: setup.common,
    ...extra,
  });
}

function freezeInput(
  setup: RepairFixture,
  attempt: AttemptWorkspaceRecord,
  overrides: Record<string, unknown> = {},
) {
  return {
    runId: "run-1",
    project: setup.project,
    node: node(attempt.attemptId),
    attempt,
    contract: contract(),
    authorityManifestHash: "a".repeat(64),
    contextEvidenceRefs: [setup.evidenceRef],
    runtimeCapabilityHash: "c".repeat(64),
    ...overrides,
  };
}

function runtimeCapabilityManifest(): RuntimeCapabilityManifestV2 {
  return {
    schemaVersion: 2,
    harnessVersion: "orchestration-1",
    repairPromptVersion: "repair-candidate-v1",
    diagnosisPromptVersion: "diagnoser-v1",
    modelId: "model-2026-08",
    runtimeMode: "local-process:app_server",
    toolSchemaHash: "1".repeat(64),
    excludedToolHash: "2".repeat(64),
    sandboxPolicyHash: "3".repeat(64),
    containerImageId: null,
    timeoutMs: 240_000,
    stepCap: 20,
    rootResourceHorizonHash: "4".repeat(64),
  };
}

function candidateContextManifest(): CandidateContextManifestV1 {
  return {
    schemaVersion: 1,
    fault: { class: "hard_failure", reasonCode: "targeted_gate_failed" },
    snapshots: [{
      source: "verification",
      mandatoryFailures: 1,
      consumerPassed: false,
      regressionCount: 0,
      failureFingerprints: ["5".repeat(64)],
      changedPaths: ["src/app.ts"],
      protectedViolations: [],
      stateFingerprint: "6".repeat(64),
    }],
    diagnosis: {
      status: "available",
      classification: "context",
      rationale: "Missing producer contract evidence.",
      allowedMutationFamilies: ["context_patch"],
    },
  };
}

describe("RepairWorkspaceManager.freeze", () => {
  it("records complete schema-v2 fingerprints and freezes stable candidate context separately from raw audit", async () => {
    const setup = await fixture();
    const attempt = await dirtyFailedAttempt(setup);
    const repair = manager(setup);
    const context = candidateContextManifest();
    const runtime = runtimeCapabilityManifest();
    const reorderedContract = Object.fromEntries(
      Object.entries(contract()).reverse(),
    ) as unknown as SubtaskContract;

    const frozen = await repair.freeze(freezeInput(setup, attempt, {
      contract: reorderedContract,
      candidateContextManifest: context,
      contextAuditEvidenceRefs: [setup.evidenceRef],
      runtimeCapabilityManifest: runtime,
    }));
    const candidateContextBytes = Buffer.from(serializeCandidateContextManifest(context));
    const candidateContextRef = createHash("sha256").update(candidateContextBytes).digest("hex");
    const bundle = await repair.readContextBundle(frozen);

    expect(frozen.fingerprintSchemaVersion).toBe(2);
    expect(frozen.fingerprintComplete).toBe(true);
    expect(frozen.repositoryBaseHash).toBe(canonicalHash({
      baseCommit: setup.base,
      sourceFingerprint: setup.project.source.sourceFingerprint,
    }));
    expect(frozen.contractHash).toBe(canonicalHash(contract()));
    expect(frozen.runtimeCapabilityHash).toBe(runtimeCapabilityFingerprint(runtime).hash);
    expect(frozen.faultEvidenceHash).toBe(candidateContextRef);
    expect(frozen.contextEvidenceRefs).toEqual([candidateContextRef]);
    expect(frozen.contextAuditEvidenceRefs).toEqual([setup.evidenceRef]);
    expect(Object.keys(bundle)).toEqual([candidateContextRef]);
    expect(bundle[candidateContextRef]).toEqual(candidateContextBytes);
    expect(bundle[candidateContextRef]!.toString("utf8")).not.toContain("contract-evidence");
  });

  it("marks a checkpoint incomplete when any runtime capability field is unavailable", async () => {
    const setup = await fixture();
    const attempt = await dirtyFailedAttempt(setup);
    const incomplete = { ...runtimeCapabilityManifest() } as Record<string, unknown>;
    delete incomplete.modelId;
    const frozen = await manager(setup).freeze(freezeInput(setup, attempt, {
      candidateContextManifest: candidateContextManifest(),
      contextAuditEvidenceRefs: [setup.evidenceRef],
      runtimeCapabilityManifest: incomplete,
    }));
    expect(frozen.fingerprintSchemaVersion).toBe(2);
    expect(frozen.fingerprintComplete).toBe(false);
    expect(frozen.runtimeCapabilityHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not freeze or fingerprint malformed candidate-visible context as complete", async () => {
    const setup = await fixture();
    const attempt = await dirtyFailedAttempt(setup);
    const rawSnapshot = {
      id: "snapshot-raw-1",
      attemptId: attempt.attemptId,
      sequence: 1,
      ...candidateContextManifest().snapshots[0],
      diffRiskUnits: 1,
      modelCalls: 1,
      commands: 1,
      toolCalls: 1,
      elapsedMs: 1,
      contentHash: "7".repeat(64),
      createdAt: "2026-08-29T00:00:00.000Z",
    } as unknown as Record<string, unknown>;
    delete rawSnapshot.stateFingerprint;
    const malformed = buildCandidateContextManifest({
      fault: fault(setup.evidenceRef),
      snapshots: [rawSnapshot as unknown as EvidenceSnapshot],
      diagnosis: diagnosis(),
    });
    const repair = manager(setup);

    const frozen = await repair.freeze(freezeInput(setup, attempt, {
      candidateContextManifest: malformed,
      contextAuditEvidenceRefs: [setup.evidenceRef],
      runtimeCapabilityManifest: runtimeCapabilityManifest(),
    }));

    expect(frozen.fingerprintComplete).toBe(false);
    expect(frozen.faultEvidenceHash).toBe("");
    expect(frozen.contextEvidenceRefs).toEqual([]);
    expect(await repair.readContextBundle(frozen)).toEqual({});
  });

  it("snapshots working state without touching the live attempt Git index or canonical objects", async () => {
    const setup = await fixture();
    const attempt = await dirtyFailedAttempt(setup);
    const before = await captureAttempt(setup.git, attempt.workspacePath);
    const canonicalBefore = {
      head: await setup.git.head(setup.project.canonicalWorkspacePath),
      refs: await setup.git.run(setup.project.canonicalWorkspacePath, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
      ]),
      status: await setup.git.run(setup.project.canonicalWorkspacePath, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
    };
    const events: RunEventDraft[] = [];
    const repair = manager(setup, { sink: { emit: (draft) => events.push(draft) } });

    const frozen = await repair.freeze(freezeInput(setup, attempt));
    const after = await captureAttempt(setup.git, attempt.workspacePath);
    const observed = await repair.observe(frozen);

    expect(after).toEqual(before);
    expect(frozen.originalBaseCommit).toBe(setup.base);
    expect(frozen.sourceAttemptId).toBe(attempt.attemptId);
    expect(frozen.sourceAttemptRevision).toBe(attempt.revision);
    expect(await setup.git.run(attempt.workspacePath, ["rev-parse", frozen.checkpointCommit + "^"])).toBe(setup.base);
    expect(await setup.git.run(attempt.workspacePath, ["rev-parse", frozen.treeHash])).toBe(frozen.treeHash);
    expect(await setup.git.run(attempt.workspacePath, ["ls-tree", "-r", "--name-only", frozen.treeHash])).toContain(
      "src/untracked.ts",
    );
    expect(await setup.git.run(attempt.workspacePath, ["ls-tree", "-r", "--name-only", frozen.treeHash])).toContain(
      "src/staged.ts",
    );
    expect(observed.treeHash).toBe(frozen.treeHash);
    expect(observed.contextBundleHash).toBe(frozen.contextBundleHash);
    expect(frozen.contextEvidenceRefs).toEqual([setup.evidenceRef]);
    await expect(setup.git.resolveCommit(setup.project.canonicalWorkspacePath, frozen.checkpointCommit)).rejects.toMatchObject({
      code: "git_failed",
    });
    expect(await setup.git.head(setup.project.canonicalWorkspacePath)).toBe(canonicalBefore.head);
    expect(await setup.git.run(setup.project.canonicalWorkspacePath, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ])).toBe(canonicalBefore.refs);
    expect(await setup.git.run(setup.project.canonicalWorkspacePath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ])).toBe(canonicalBefore.status);
    expect(events.some((item) => item.name === "repair_tournament_started")).toBe(true);
    expect(frozen.allowedMutationPaths).toEqual(["src/", "README.md"]);
    expect(frozen.protectedPaths).toEqual([".launchpad/", "authority/"]);
  });

  it("rewrites the durable checkpoint with its repair graph fence binding", async () => {
    const setup = await fixture();
    const attempt = await dirtyFailedAttempt(setup);
    const repair = manager(setup);
    const frozen = await repair.freeze(freezeInput(setup, attempt));
    frozen.repairGraphFenceHash = "a".repeat(64);

    await repair.persistBoundCheckpoint(frozen);

    const file = path.join(
      path.dirname(setup.project.canonicalWorkspacePath),
      "repair-checkpoints",
      frozen.id + ".json",
    );
    const persisted = JSON.parse(await readFile(file, "utf8")) as RepairCheckpoint;
    expect(persisted.repairGraphFenceHash).toBe("a".repeat(64));
  });

  it("freezes a content-addressed context bundle that ignores later common-workspace mutation", async () => {
    const setup = await fixture();
    const attempt = await dirtyFailedAttempt(setup);
    const repair = manager(setup);
    const frozen = await repair.freeze(freezeInput(setup, attempt));
    await writeFile(setup.evidencePath, JSON.stringify({ contract: "build-api", failed: false, mutated: true }) + "\n");
    const candidates = createMutationCandidates({
      tournamentId: "tour-1",
      checkpoint: frozen,
      fault: fault(setup.evidenceRef),
      diagnosis: diagnosis(),
      contract: contract(),
    });
    const created = await repair.createCandidate({
      runId: "run-1",
      project: setup.project,
      checkpoint: frozen,
      candidate: candidates[1]!,
      revision: 1,
    });
    expect(created.kind).toBe("repair");
    const bundle = await repair.readContextBundle(frozen);
    expect(createHash("sha256").update(bundle[setup.evidenceRef]!).digest("hex")).toBe(setup.evidenceRef);
    expect(bundle[setup.evidenceRef]!.toString("utf8")).toContain("\"failed\":true");
    expect(bundle[setup.evidenceRef]!.toString("utf8")).not.toContain("mutated");
    expect(frozen.contextBundleHash).toBe(
      createHash("sha256").update(setup.evidenceRef).update("\0").update(bundle[setup.evidenceRef]!).digest("hex"),
    );
  });

  it("fails closed on Git timeout before fingerprinting and leaves the attempt and candidates untouched", async () => {
    const setup = await fixture();
    const attempt = await dirtyFailedAttempt(setup);
    const before = await captureAttempt(setup.git, attempt.workspacePath);
    const events: RunEventDraft[] = [];
    const repair = manager(setup, {
      sink: { emit: (draft) => events.push(draft) },
      hooks: {
        async beforeFingerprintForTest() {
          throw GitCommandError.from(
            Object.assign(new Error("timed out"), { killed: true, code: "ETIMEDOUT" }),
            ["status", "--porcelain=v2"],
          );
        },
      },
    });

    await expect(repair.freeze(freezeInput(setup, attempt))).rejects.toMatchObject({
      name: "RepairCheckpointError",
      code: "checkpoint_unavailable",
    });
    expect(RepairCheckpointError).toBeDefined();
    expect(await captureAttempt(setup.git, attempt.workspacePath)).toEqual(before);
    expect(events.some((item) => item.name === "repair_tournament_started")).toBe(false);
    const candidates = createMutationCandidates({
      tournamentId: "tour-1",
      checkpoint: {
        id: "unused",
        runId: "run-1",
        subtaskId: "build-api",
        taskRevision: 1,
        sourceAttemptId: attempt.attemptId,
        sourceAttemptRevision: attempt.revision,
        originalBaseCommit: setup.base,
        checkpointCommit: setup.base,
        treeHash: setup.base,
        contractHash: "0".repeat(64),
        authorityManifestHash: "a".repeat(64),
        contextBundleHash: "b".repeat(64),
        contextEvidenceRefs: [setup.evidenceRef],
        runtimeCapabilityHash: "c".repeat(64),
        allowedMutationPaths: ["src/", "README.md"],
        protectedPaths: [".launchpad/", "authority/"],
        createdAt: "2026-08-29T00:00:00.000Z",
      },
      fault: fault(setup.evidenceRef),
      diagnosis: diagnosis(),
      contract: contract(),
    });
    expect(candidates.map((item) => item.state)).toEqual(["not_started", "not_started", "not_started"]);
    await expect(setup.git.resolveCommit(setup.project.canonicalWorkspacePath, setup.base)).resolves.toBe(setup.base);
  });

  it("revalidates exact attempt ownership after the snapshot and before publishing", async () => {
    const setup = await fixture();
    const attempt = await dirtyFailedAttempt(setup);
    const sidecar = path.join(
      path.dirname(setup.project.canonicalWorkspacePath),
      "attempts",
      `.attempt-${attempt.attemptId}-r${attempt.revision}.json`,
    );
    const repair = manager(setup, {
      hooks: {
        async afterSnapshotBeforeRevalidateForTest() {
          const parsed = JSON.parse(await readFile(sidecar, "utf8")) as Record<string, unknown>;
          parsed.ownerToken = "11111111-1111-4111-8111-111111111111";
          await writeFile(sidecar, JSON.stringify(parsed), "utf8");
        },
      },
    });
    await expect(repair.freeze(freezeInput(setup, attempt))).rejects.toMatchObject({
      name: "RepairCheckpointError",
    });
  });

  it("rejects a running, mismatched, or repair-kind freeze admission", async () => {
    const setup = await fixture();
    const running = await setup.attempts.create({
      runId: "run-1",
      project: setup.project,
      attemptId: "running-attempt",
      revision: 1,
      subtaskId: "build-api",
      baseCommit: setup.base,
    });
    persist(setup.project, running);
    await expect(manager(setup).freeze(freezeInput(setup, running))).rejects.toMatchObject({
      name: "RepairCheckpointError",
    });

    const failed = await dirtyFailedAttempt(setup);
    await expect(
      manager(setup).freeze(
        freezeInput(setup, failed, { node: { ...node(failed.attemptId), attemptId: "other-attempt" } }),
      ),
    ).rejects.toMatchObject({ name: "RepairCheckpointError" });
    await expect(
      manager(setup).freeze(freezeInput(setup, failed, { contract: { ...contract(), subtaskId: "other-task" } })),
    ).rejects.toMatchObject({ name: "RepairCheckpointError" });
    await expect(
      manager(setup).freeze(freezeInput(setup, failed, { node: { ...node(failed.attemptId), revision: 9 } })),
    ).rejects.toMatchObject({ name: "RepairCheckpointError" });
    await expect(
      manager(setup).freeze(freezeInput(setup, { ...failed, kind: "repair" })),
    ).rejects.toMatchObject({ name: "RepairCheckpointError" });
  });

  it("freezes after sibling integration advances the live project head", async () => {
    const setup = await fixture();
    const attempt = await dirtyFailedAttempt(setup);
    const canonical = setup.project.canonicalWorkspacePath;
    await writeFile(path.join(canonical, "src", "app.ts"), "export const n = 9;\n", "utf8");
    await setup.git.run(canonical, ["add", "--", "src/app.ts"]);
    await setup.git.run(canonical, ["commit", "-m", "sibling integration"]);
    setup.project.headCommit = await setup.git.head(canonical);

    const frozen = await manager(setup).freeze(freezeInput(setup, attempt));
    expect(frozen.originalBaseCommit).toBe(setup.base);
    expect(frozen.originalBaseCommit).not.toBe(setup.project.headCommit);
  });

  it("refuses ephemeral and non-Git-backed projects at freeze", async () => {
    const setup = await fixture();
    const attempt = await dirtyFailedAttempt(setup);
    await expect(
      manager(setup).freeze(
        freezeInput(setup, attempt, {
          project: { ...setup.project, source: { ...setup.project.source, mode: "ephemeral_research" } },
        }),
      ),
    ).rejects.toMatchObject({
      name: "RepairCheckpointError",
      message: expect.stringMatching(/ephemeral/i),
    });
    await expect(
      manager(setup).freeze(
        freezeInput(setup, attempt, {
          project: {
            ...setup.project,
            headCommit: null,
            source: { ...setup.project.source, baseCommit: null },
          },
        }),
      ),
    ).rejects.toMatchObject({
      name: "RepairCheckpointError",
      message: expect.stringMatching(/Git-backed/i),
    });
  });
});

describe("RepairWorkspaceManager ownership and metadata attacks", () => {
  it("rejects replaced, symlinked, mismatched, and tampered source attempts without canonical leakage", async () => {
    const attacks: Array<(setup: RepairFixture, attempt: Awaited<ReturnType<typeof dirtyFailedAttempt>>) => Promise<void>> = [
      async (_setup, attempt) => {
        await rm(attempt.workspacePath, { recursive: true, force: true });
        await symlink(_setup.project.canonicalWorkspacePath, attempt.workspacePath);
      },
      async (_setup, attempt) => {
        attempt.ownerToken = "00000000-0000-4000-8000-000000000000";
      },
      async (_setup, attempt) => {
        attempt.revision = 9;
      },
      async (setup, attempt) => {
        const sidecar = path.join(
          path.dirname(setup.project.canonicalWorkspacePath),
          "attempts",
          `.attempt-${attempt.attemptId}-r${attempt.revision}.json`,
        );
        const parsed = JSON.parse(await readFile(sidecar, "utf8")) as Record<string, unknown>;
        parsed.ownerToken = "11111111-1111-4111-8111-111111111111";
        await writeFile(sidecar, JSON.stringify(parsed), "utf8");
      },
      async (setup, attempt) => {
        await setup.git.run(attempt.workspacePath, ["update-ref", "refs/replace/" + setup.base, setup.base]);
      },
      async (_setup, attempt) => {
        await writeFile(path.join(attempt.workspacePath, ".git", "objects", "info", "alternates"), "/tmp/untrusted\n");
      },
      async (setup, attempt) => {
        await setup.git.run(attempt.workspacePath, ["remote", "add", "origin", "file:///tmp/untrusted"]);
      },
      async (_setup, attempt) => {
        await writeFile(path.join(attempt.workspacePath, ".git", "hooks", "post-commit"), "#!/bin/sh\nexit 0\n");
      },
      async (setup, attempt) => {
        await setup.git.run(attempt.workspacePath, ["config", "core.hooksPath", "/tmp/hostile-hooks"]);
      },
    ];
    for (const attack of attacks) {
      const setup = await fixture();
      const attempt = await dirtyFailedAttempt(setup);
      await attack(setup, attempt);
      const canonicalObjects = path.join(setup.project.canonicalWorkspacePath, ".git", "objects");
      const before = await readdir(canonicalObjects, { recursive: true });
      await expect(manager(setup).freeze(freezeInput(setup, attempt))).rejects.toMatchObject({
        name: "RepairCheckpointError",
      });
      const after = await readdir(canonicalObjects, { recursive: true });
      expect(after).toEqual(before);
    }
  }, 30_000);

  it("rejects a missing base, source mismatch, path escape, and a checkpoint that does not descend from the attempt base", async () => {
    const setup = await fixture();
    const attempt = await dirtyFailedAttempt(setup);
    await expect(
      manager(setup).freeze(freezeInput(setup, attempt, { project: { ...setup.project, source: { ...setup.project.source, sourceFingerprint: "0".repeat(64) } } })),
    ).rejects.toMatchObject({ name: "RepairCheckpointError" });

    const escaped = {
      ...attempt,
      workspacePath: path.join(path.dirname(attempt.workspacePath), "..", "escaped"),
    };
    await expect(manager(setup).freeze(freezeInput(setup, escaped))).rejects.toMatchObject({
      name: "RepairCheckpointError",
    });

    const missingBase = { ...attempt, baseCommit: "0".repeat(40) };
    await expect(manager(setup).freeze(freezeInput(setup, missingBase))).rejects.toMatchObject({
      name: "RepairCheckpointError",
    });

    const frozen = await manager(setup).freeze(freezeInput(setup, attempt));
    const unrelatedRoot = await mkdtemp(path.join(tmpdir(), "launchpad-unrelated-"));
    directories.push(unrelatedRoot);
    await setup.git.run(unrelatedRoot, ["init", "-b", "main"]);
    await writeFile(path.join(unrelatedRoot, "README.md"), "other\n", "utf8");
    await setup.git.run(unrelatedRoot, ["add", "--", "README.md"]);
    await setup.git.run(unrelatedRoot, ["commit", "-m", "other"]);
    const unrelated = await setup.git.head(unrelatedRoot);
    const candidates = createMutationCandidates({
      tournamentId: "tour-1",
      checkpoint: { ...frozen, checkpointCommit: unrelated },
      fault: fault(setup.evidenceRef),
      diagnosis: diagnosis(),
      contract: contract(),
    });
    const before = await readdir(path.join(setup.project.canonicalWorkspacePath, ".git", "objects"), { recursive: true });
    await expect(
      manager(setup).createCandidate({
        runId: "run-1",
        project: setup.project,
        checkpoint: { ...frozen, checkpointCommit: unrelated },
        candidate: candidates[0]!,
        revision: 1,
      }),
    ).rejects.toMatchObject({ name: "RepairCheckpointError" });
    expect(
      await readdir(path.join(setup.project.canonicalWorkspacePath, ".git", "objects"), { recursive: true }),
    ).toEqual(before);
    await manager(setup).recover(setup.project);
    expect(
      await readdir(path.join(setup.project.canonicalWorkspacePath, ".git", "objects"), { recursive: true }),
    ).toEqual(before);
  });
});

describe("RepairWorkspaceManager.createCandidate", () => {
  it("creates three isolated candidates that share the frozen checkpoint and not Git or runtime state", async () => {
    const setup = await fixture();
    const attempt = await dirtyFailedAttempt(setup);
    const repair = manager(setup);
    const frozen = await repair.freeze(freezeInput(setup, attempt));
    const [control, contextPatch, strategy] = createMutationCandidates({
      tournamentId: "tour-1",
      checkpoint: frozen,
      fault: fault(setup.evidenceRef),
      diagnosis: diagnosis(),
      contract: contract(),
    });
    const created = [];
    for (const candidate of [control, contextPatch, strategy]) {
      created.push(
        await repair.createCandidate({
          runId: "run-1",
          project: setup.project,
          checkpoint: frozen,
          candidate,
          revision: 1,
        }),
      );
    }
    expect(created).toHaveLength(3);
    expect(new Set(created.map((item) => item.ownerToken)).size).toBe(3);
    expect(new Set(created.map((item) => item.workspacePath)).size).toBe(3);
    const gitDirs = await Promise.all(created.map((item) => realpath(path.join(item.workspacePath, ".git"))));
    expect(new Set(gitDirs).size).toBe(3);
    for (const item of created) {
      expect(item.kind).toBe("repair");
      expect(item.checkpointId).toBe(frozen.id);
      expect(item.baseCommit).toBe(setup.base);
      expect(await setup.git.head(item.workspacePath)).toBe(frozen.checkpointCommit);
      expect(await realpath(await setup.git.commonGitDirectory(item.workspacePath))).toBe(
        await realpath(path.join(item.workspacePath, ".git")),
      );
      expect(await setup.git.run(item.workspacePath, ["remote"])).toBe("");
      await expect(lstat(path.join(item.workspacePath, ".git", "FETCH_HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
      const sidecar = JSON.parse(
        await readFile(
          path.join(
            path.dirname(setup.project.canonicalWorkspacePath),
            "attempts",
            `.attempt-${item.attemptId}-r${item.revision}.json`,
          ),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(sidecar.kind).toBe("repair");
      expect(sidecar.checkpointId).toBe(frozen.id);
      expect(sidecar.checkpointHash).toBe(frozen.checkpointCommit);
      expect(sidecar.sourceOwnerFingerprint).toBe(createHash("sha256").update(attempt.ownerToken).digest("hex"));
      await expect(setup.git.resolveCommit(setup.project.canonicalWorkspacePath, frozen.checkpointCommit)).rejects.toMatchObject({
        code: "git_failed",
      });
    }
    expect(control.delta.instructionPatch).toBe("");
    expect(contextPatch.delta.addedEvidenceRefs).toEqual([setup.evidenceRef]);
    expect(strategy.delta.instructionPatch.toLowerCase()).toMatch(/inspect/);
  });
});

describe("RepairWorkspaceManager.squashWinner", () => {
  it("builds a middleware-owned one-commit contribution from the original base without mutating canonical", async () => {
    const setup = await fixture();
    const attempt = await dirtyFailedAttempt(setup);
    const repair = manager(setup);
    const frozen = await repair.freeze(freezeInput(setup, attempt));
    const [, , strategy] = createMutationCandidates({
      tournamentId: "tour-1",
      checkpoint: frozen,
      fault: fault(setup.evidenceRef),
      diagnosis: diagnosis(),
      contract: contract(),
    });
    const candidate = await repair.createCandidate({
      runId: "run-1",
      project: setup.project,
      checkpoint: frozen,
      candidate: strategy,
      revision: 1,
    });
    persist(setup.project, candidate);
    await writeFile(path.join(candidate.workspacePath, "src", "app.ts"), "export const n = 2;\n", "utf8");
    await setup.git.run(candidate.workspacePath, ["add", "--", "src/app.ts"]);
    await setup.git.run(candidate.workspacePath, ["commit", "-m", "candidate edit"]);
    const winnerHead = await setup.git.head(candidate.workspacePath);
    const winnerTree = await setup.git.run(candidate.workspacePath, ["rev-parse", winnerHead + "^{tree}"]);
    const canonicalHead = await setup.git.head(setup.project.canonicalWorkspacePath);

    const contribution = await repair.squashWinner({
      project: setup.project,
      checkpoint: frozen,
      candidate: { ...strategy, attemptId: candidate.attemptId, state: "verified" },
      attempt: { ...candidate, headCommit: winnerHead, state: "contribution_ready" },
      verificationIds: ["ver-1"],
    });

    expect(contribution.baseCommit).toBe(setup.base);
    expect(contribution.attemptId).toBe(candidate.attemptId);
    expect(contribution.attemptRevision).toBe(candidate.revision);
    expect(contribution.ownerFingerprint).toBe(createHash("sha256").update(candidate.ownerToken).digest("hex"));
    expect(contribution.verificationIds).toEqual(["ver-1"]);
    expect(await setup.git.commitCount(candidate.workspacePath, setup.base, contribution.headCommit)).toBe(1);
    expect(await setup.git.run(candidate.workspacePath, ["rev-parse", contribution.headCommit + "^"])).toBe(setup.base);
    expect(await setup.git.run(candidate.workspacePath, ["rev-parse", contribution.headCommit + "^{tree}"])).toBe(
      winnerTree,
    );
    expect(contribution.headCommit).not.toBe(frozen.checkpointCommit);
    expect(await setup.git.head(setup.project.canonicalWorkspacePath)).toBe(canonicalHead);
    await expect(
      setup.git.resolveCommit(setup.project.canonicalWorkspacePath, contribution.headCommit),
    ).rejects.toMatchObject({ code: "git_failed" });
    expect(contribution.changedPaths.every((item) => item === "README.md" || item.startsWith("src/"))).toBe(true);
    expect(contribution.changedPaths.some((item) => item.startsWith(".launchpad"))).toBe(false);
  });

  it("rejects a winner that edits a protected path", async () => {
    const setup = await fixture();
    const attempt = await dirtyFailedAttempt(setup);
    const repair = manager(setup);
    const frozen = await repair.freeze(freezeInput(setup, attempt));
    const [control] = createMutationCandidates({
      tournamentId: "tour-1",
      checkpoint: frozen,
      fault: fault(setup.evidenceRef),
      diagnosis: diagnosis(),
      contract: contract(),
    });
    const candidate = await repair.createCandidate({
      runId: "run-1",
      project: setup.project,
      checkpoint: frozen,
      candidate: control,
      revision: 1,
    });
    persist(setup.project, candidate);
    await mkdir(path.join(candidate.workspacePath, ".launchpad"), { recursive: true });
    await writeFile(path.join(candidate.workspacePath, ".launchpad", "secret"), "nope\n", "utf8");
    await setup.git.run(candidate.workspacePath, ["add", "--", ".launchpad/secret"]);
    await setup.git.run(candidate.workspacePath, ["commit", "-m", "protected"]);
    const winnerHead = await setup.git.head(candidate.workspacePath);

    await expect(
      repair.squashWinner({
        project: setup.project,
        checkpoint: frozen,
        candidate: { ...control, attemptId: candidate.attemptId, state: "verified" },
        attempt: { ...candidate, headCommit: winnerHead, state: "contribution_ready" },
        verificationIds: ["ver-1"],
      }),
    ).rejects.toMatchObject({ name: "RepairCheckpointError" });
    expect(await setup.git.head(setup.project.canonicalWorkspacePath)).toBe(setup.base);
  });

  it("rejects a winner that edits a path outside the frozen allowed mutation set", async () => {
    const setup = await fixture();
    const attempt = await dirtyFailedAttempt(setup);
    const repair = manager(setup);
    const frozen = await repair.freeze(freezeInput(setup, attempt));
    const [control] = createMutationCandidates({
      tournamentId: "tour-1",
      checkpoint: frozen,
      fault: fault(setup.evidenceRef),
      diagnosis: diagnosis(),
      contract: contract(),
    });
    const candidate = await repair.createCandidate({
      runId: "run-1",
      project: setup.project,
      checkpoint: frozen,
      candidate: control,
      revision: 1,
    });
    persist(setup.project, candidate);
    await mkdir(path.join(candidate.workspacePath, "docs"), { recursive: true });
    await writeFile(path.join(candidate.workspacePath, "docs", "extra.md"), "undeclared\n", "utf8");
    await setup.git.run(candidate.workspacePath, ["add", "--", "docs/extra.md"]);
    await setup.git.run(candidate.workspacePath, ["commit", "-m", "undeclared path"]);
    const winnerHead = await setup.git.head(candidate.workspacePath);

    await expect(
      repair.squashWinner({
        project: setup.project,
        checkpoint: frozen,
        candidate: { ...control, attemptId: candidate.attemptId, state: "verified" },
        attempt: { ...candidate, headCommit: winnerHead, state: "contribution_ready" },
        verificationIds: ["ver-1"],
      }),
    ).rejects.toMatchObject({ name: "RepairCheckpointError" });
    expect(await setup.git.head(setup.project.canonicalWorkspacePath)).toBe(setup.base);
  });

  it("rejects a swapped or replaced candidate directory without mutating canonical", async () => {
    const attacks: Array<(setup: RepairFixture, workspacePath: string) => Promise<void>> = [
      async (setup, workspacePath) => {
        await rm(workspacePath, { recursive: true, force: true });
        await symlink(setup.project.canonicalWorkspacePath, workspacePath);
      },
      async (setup, workspacePath) => {
        await rm(workspacePath, { recursive: true, force: true });
        await mkdir(workspacePath, { recursive: true });
        await setup.git.run(workspacePath, ["init", "-b", "main"]);
        await writeFile(path.join(workspacePath, "README.md"), "decoy\n", "utf8");
        await setup.git.run(workspacePath, ["add", "--", "README.md"]);
        await setup.git.run(workspacePath, ["commit", "-m", "decoy"]);
      },
    ];
    for (const attack of attacks) {
      const setup = await fixture();
      const attempt = await dirtyFailedAttempt(setup);
      const repair = manager(setup);
      const frozen = await repair.freeze(freezeInput(setup, attempt));
      const [control] = createMutationCandidates({
        tournamentId: "tour-1",
        checkpoint: frozen,
        fault: fault(setup.evidenceRef),
        diagnosis: diagnosis(),
        contract: contract(),
      });
      const candidate = await repair.createCandidate({
        runId: "run-1",
        project: setup.project,
        checkpoint: frozen,
        candidate: control,
        revision: 1,
      });
      persist(setup.project, candidate);
      await writeFile(path.join(candidate.workspacePath, "src", "app.ts"), "export const n = 2;\n", "utf8");
      await setup.git.run(candidate.workspacePath, ["add", "--", "src/app.ts"]);
      await setup.git.run(candidate.workspacePath, ["commit", "-m", "candidate edit"]);
      const winnerHead = await setup.git.head(candidate.workspacePath);
      const canonical = setup.project.canonicalWorkspacePath;
      const before = {
        head: await setup.git.head(canonical),
        refs: await setup.git.run(canonical, ["for-each-ref", "--format=%(refname) %(objectname)"]),
        status: await setup.git.run(canonical, ["status", "--porcelain=v1", "--untracked-files=all"]),
        index: await readFile(path.join(canonical, ".git", "index")),
      };
      await attack(setup, candidate.workspacePath);
      await expect(
        repair.squashWinner({
          project: setup.project,
          checkpoint: frozen,
          candidate: { ...control, attemptId: candidate.attemptId, state: "verified" },
          attempt: { ...candidate, headCommit: winnerHead, state: "contribution_ready" },
          verificationIds: ["ver-1"],
        }),
      ).rejects.toMatchObject({ name: "RepairCheckpointError" });
      expect(await setup.git.head(canonical)).toBe(before.head);
      expect(await setup.git.run(canonical, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(before.refs);
      expect(
        await setup.git.run(canonical, ["status", "--porcelain=v1", "--untracked-files=all"]),
      ).toBe(before.status);
      expect(await readFile(path.join(canonical, ".git", "index"))).toEqual(before.index);
    }
  }, 30_000);

  it("refuses squash when the project is ephemeral", async () => {
    const setup = await fixture();
    const attempt = await dirtyFailedAttempt(setup);
    const repair = manager(setup);
    const frozen = await repair.freeze(freezeInput(setup, attempt));
    const [control] = createMutationCandidates({
      tournamentId: "tour-1",
      checkpoint: frozen,
      fault: fault(setup.evidenceRef),
      diagnosis: diagnosis(),
      contract: contract(),
    });
    const candidate = await repair.createCandidate({
      runId: "run-1",
      project: setup.project,
      checkpoint: frozen,
      candidate: control,
      revision: 1,
    });
    persist(setup.project, candidate);
    const winnerHead = await setup.git.head(candidate.workspacePath);
    setup.project.source = { ...setup.project.source, mode: "ephemeral_research" };

    await expect(
      repair.squashWinner({
        project: setup.project,
        checkpoint: frozen,
        candidate: { ...control, attemptId: candidate.attemptId, state: "verified" },
        attempt: { ...candidate, headCommit: winnerHead, state: "contribution_ready" },
        verificationIds: ["ver-1"],
      }),
    ).rejects.toMatchObject({
      name: "RepairCheckpointError",
      message: expect.stringMatching(/ephemeral/i),
    });
    expect(await setup.git.head(setup.project.canonicalWorkspacePath)).toBe(setup.base);
  });
});
