import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContributionIntegrator } from "../src/contribution-integrator.js";
import { GitClient } from "../src/git-client.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import { RunControl } from "../src/orchestration/run-control.js";
import { StructuralGate } from "../src/structural-gate.js";
import { captureCanonicalWorkspaceAuthority } from "../src/project-run-manager.js";
import type {
  ContributionRecord,
  ProjectRunRecord,
  VerificationResult,
} from "../src/types.js";
import { verificationDenial } from "../src/types.js";

const roots: string[] = [];

function control(): RunControl {
  return new RunControl(defaultExecutionPolicy);
}

function structuralOnly(): { control: RunControl } {
  return { control: control() };
}

function verificationResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    id: "verification-post-1",
    subjectType: "contribution",
    subjectId: "contribution-1",
    stage: "post_integration",
    authorityManifestHash: "d".repeat(64),
    gates: [{
      gateId: "post-integration",
      tier: "post_integration",
      passed: overrides.mandatoryPassed !== false,
      evidenceRef: "e".repeat(64),
      failureFingerprint: overrides.mandatoryPassed === false ? "f".repeat(64) : null,
    }],
    failureKind: overrides.mandatoryPassed === false ? "deterministic_gate_failure" : null,
    mandatoryPassed: true,
    hardProgress: 1,
    regressionCount: 0,
    modelCalls: 0,
    reservedTokens: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    elapsedMs: 1,
    verifiedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  git: GitClient;
  project: ProjectRunRecord;
  base: string;
  contribution: ContributionRecord;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-integrator-"));
  roots.push(root);
  const canonical = path.join(root, "canonical");
  const candidate = path.join(root, "candidate");
  await mkdir(canonical);
  const git = new GitClient(5_000);
  await git.run(canonical, ["init", "-b", "main"]);
  await writeFile(path.join(canonical, "README.md"), "base\n", "utf8");
  await git.run(canonical, ["add", "--", "README.md"]);
  await git.run(canonical, ["commit", "-m", "base"]);
  const base = await git.head(canonical);
  await git.worktreeAdd(canonical, candidate, base);
  await writeFile(path.join(candidate, "feature.txt"), "feature\n", "utf8");
  await git.run(candidate, ["add", "--", "feature.txt"]);
  await git.run(candidate, ["commit", "-m", "feature"]);
  const head = await git.head(candidate);
  await git.importExactCommit(canonical, candidate, base, head);
  return {
    git,
    base,
    project: await (async () => {
      const project: ProjectRunRecord = {
      source: { mode: "new_project", repositoryPath: canonical, requestedRevision: "seed", baseCommit: base, sourceFingerprint: "f".repeat(64) },
      runBranch: "main", canonicalWorkspacePath: canonical, headCommit: base,
      state: "ready", attempts: [], integrations: [],
      };
      project.canonicalAuthority = await captureCanonicalWorkspaceAuthority(git, project);
      return project;
    })(),
    contribution: {
      contributionId: "contribution-1", attemptId: "attempt-1", attemptRevision: 1,
      ownerFingerprint: "a".repeat(64), subtaskId: "feature", baseCommit: base,
      headCommit: head, changedPaths: ["feature.txt"], diffHash: "b".repeat(64),
      verificationLevel: "structural",
    },
  };
}

describe("verificationDenial", () => {
  const valid: VerificationResult = verificationResult();

  it("rejects a missing, empty-id, wrong-stage, or wrong-subject result before the verdict", () => {
    expect(verificationDenial(null, "pre_integration", "contribution-1"))
      .toBe("pre_integration_verification_malformed");
    expect(verificationDenial({ ...valid, id: "" }, "post_integration", "contribution-1"))
      .toBe("post_integration_verification_malformed");
    expect(verificationDenial({ ...valid, stage: "pre_integration" }, "post_integration", "contribution-1"))
      .toBe("post_integration_verification_malformed");
    expect(verificationDenial({ ...valid, subjectId: "other" }, "post_integration", "contribution-1"))
      .toBe("post_integration_verification_malformed");
  });

  it("does not let mandatoryPassed authorize a malformed result", () => {
    expect(verificationDenial(
      { ...valid, stage: "post_integration", mandatoryPassed: true, id: "" },
      "pre_integration",
      "contribution-1",
    )).toBe("pre_integration_verification_malformed");
  });

  it("returns null only when the shape matches and mandatoryPassed is true", () => {
    expect(verificationDenial(valid, "post_integration", "contribution-1")).toBeNull();
    expect(verificationDenial({
      ...valid,
      mandatoryPassed: false,
      failureKind: "deterministic_gate_failure",
    }, "post_integration", "contribution-1"))
      .toBe("post_integration_verification_failed");
  });
});

describe("ContributionIntegrator", () => {
  it("advances the canonical head only after the structural gate passes", async () => {
    const { git, project, base, contribution } = await fixture();
    const result = await new ContributionIntegrator(git, new StructuralGate(git))
      .integrate("run-1", project, contribution, structuralOnly());

    expect(result.record).toMatchObject({
      state: "integrated", structuralDecision: "passed", canonicalHeadBefore: base,
    });
    expect(result.projectHead).toBe(await git.head(project.canonicalWorkspacePath));
    expect(result.projectHead).not.toBe(base);
    expect(result.verification).toBeNull();
  }, 15_000);

  it("runs the post-integration authority on the applied canonical head before deciding", async () => {
    const { git, project, base, contribution } = await fixture();
    const seen: {
      workspacePath: string;
      appliedHead: string;
      canonicalHeadBefore: string;
      headAtCall: string;
    }[] = [];

    const result = await new ContributionIntegrator(git, new StructuralGate(git))
      .integrate("run-post-pass", project, contribution, {
        control: control(),
        postIntegrationVerify: async (workspacePath, appliedHead, canonicalHeadBefore) => {
          seen.push({
            workspacePath,
            appliedHead,
            canonicalHeadBefore,
            headAtCall: await git.head(workspacePath),
          });
          return verificationResult();
        },
      });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.workspacePath).toBe(project.canonicalWorkspacePath);
    expect(seen[0]?.appliedHead).toBe(seen[0]?.headAtCall);
    expect(seen[0]?.appliedHead).not.toBe(base);
    expect(seen[0]?.canonicalHeadBefore).toBe(base);
    expect(result.record).toMatchObject({
      state: "integrated",
      structuralDecision: "passed",
      canonicalHeadAfter: seen[0]?.appliedHead,
      verificationIds: ["verification-post-1"],
    });
    expect(result.verification?.mandatoryPassed).toBe(true);
  }, 15_000);

  it("resets and cleans the canonical checkout when post-integration verification fails", async () => {
    const { git, project, base, contribution } = await fixture();
    const untracked = path.join(project.canonicalWorkspacePath, "authority-scratch.txt");

    const result = await new ContributionIntegrator(git, new StructuralGate(git))
      .integrate("run-post-fail", project, contribution, {
        control: control(),
        postIntegrationVerify: async () => {
          await writeFile(untracked, "left behind\n", "utf8");
          return verificationResult({ mandatoryPassed: false });
        },
      });

    expect(result.record).toMatchObject({
      state: "rolled_back",
      structuralDecision: "failed",
      canonicalHeadBefore: base,
      canonicalHeadAfter: null,
      verificationIds: ["verification-post-1"],
    });
    expect(result.record.reason).toContain("post_integration_verification_failed");
    expect(result.projectHead).toBe(base);
    expect(await git.head(project.canonicalWorkspacePath)).toBe(base);
    expect(await git.isClean(project.canonicalWorkspacePath)).toBe(true);
    await expect(access(untracked)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.verification?.mandatoryPassed).toBe(false);
  }, 15_000);

  it("refuses to apply anything once the run control has already latched terminal", async () => {
    const { git, project, base, contribution } = await fixture();
    const latched = control();
    latched.stop("user_cancelled", "cancelled before apply");
    let verified = 0;

    await expect(new ContributionIntegrator(git, new StructuralGate(git))
      .integrate("run-terminal", project, contribution, {
        control: latched,
        postIntegrationVerify: async () => { verified += 1; return verificationResult(); },
      })).rejects.toThrow(/cancelled before apply/);

    expect(verified).toBe(0);
    expect(await git.head(project.canonicalWorkspacePath)).toBe(base);
    expect(await git.isClean(project.canonicalWorkspacePath)).toBe(true);
  }, 15_000);

  it("rolls back rather than publishing when the control latches after verification", async () => {
    const { git, project, base, contribution } = await fixture();
    const latching = control();

    await expect(new ContributionIntegrator(git, new StructuralGate(git))
      .integrate("run-terminal-late", project, contribution, {
        control: latching,
        postIntegrationVerify: async () => {
          latching.stop("root_deadline", "deadline elapsed mid-integration");
          return verificationResult();
        },
      })).rejects.toThrow(/deadline elapsed mid-integration/);

    expect(await git.head(project.canonicalWorkspacePath)).toBe(base);
    expect(await git.isClean(project.canonicalWorkspacePath)).toBe(true);
  }, 15_000);

  it("does not consult the authority when the structural gate already failed", async () => {
    const { git, project, base, contribution } = await fixture();
    let verified = 0;
    const gate = {
      verify: async (_workspace: string, expectedHead: string) => ({
        level: "structural" as const,
        passed: false,
        evidence: { actualHead: expectedHead, expectedHead, clean: false, whitespaceErrors: [] },
      }),
    } as StructuralGate;

    const result = await new ContributionIntegrator(git, gate)
      .integrate("run-structural-first", project, contribution, {
        control: control(),
        postIntegrationVerify: async () => { verified += 1; return verificationResult(); },
      });

    expect(verified).toBe(0);
    expect(result.record.state).toBe("rolled_back");
    expect(result.verification).toBeNull();
    expect(await git.head(project.canonicalWorkspacePath)).toBe(base);
  }, 15_000);

  it("aborts a conflict and proves the canonical head did not move", async () => {
    const { git, project, base, contribution } = await fixture();
    await writeFile(path.join(project.canonicalWorkspacePath, "feature.txt"), "canonical\n", "utf8");
    await git.run(project.canonicalWorkspacePath, ["add", "--", "feature.txt"]);
    await git.run(project.canonicalWorkspacePath, ["commit", "-m", "canonical feature"]);
    const before = await git.head(project.canonicalWorkspacePath);
    project.headCommit = before;

    const result = await new ContributionIntegrator(git, new StructuralGate(git))
      .integrate("run-conflict", project, contribution, structuralOnly());

    expect(result.record).toMatchObject({
      state: "conflicted", structuralDecision: "failed", canonicalHeadBefore: before,
      canonicalHeadAfter: null,
    });
    expect(result.record.reason).toContain("integration_conflict");
    expect(result.projectHead).toBe(before);
    expect(await git.head(project.canonicalWorkspacePath)).toBe(before);
    expect(await git.isClean(project.canonicalWorkspacePath)).toBe(true);
    expect(base).not.toBe(before);
  }, 15_000);

  it("resets only the canonical workspace when the post-apply structural gate fails", async () => {
    const { git, project, base, contribution } = await fixture();
    const gate = {
      verify: async (_workspace: string, expectedHead: string) => ({
        level: "structural" as const,
        passed: false,
        evidence: { actualHead: expectedHead, expectedHead, clean: false, whitespaceErrors: [] },
      }),
    } as StructuralGate;

    const result = await new ContributionIntegrator(git, gate)
      .integrate("run-rollback", project, contribution, structuralOnly());

    expect(result.record).toMatchObject({
      state: "rolled_back", structuralDecision: "failed", reason: "structural_workspace_dirty",
      canonicalHeadBefore: base, canonicalHeadAfter: null,
    });
    expect(result.projectHead).toBe(base);
    expect(await git.head(project.canonicalWorkspacePath)).toBe(base);
  }, 15_000);

  it("removes real untracked files and proves exact clean rollback", async () => {
    const { git, project, base, contribution } = await fixture();
    const untracked = path.join(project.canonicalWorkspacePath, "untracked-after-apply.txt");
    const gate = {
      verify: async (_workspace: string, expectedHead: string) => {
        await writeFile(untracked, "untrusted\n", "utf8");
        return {
          level: "structural" as const,
          passed: false,
          evidence: { actualHead: expectedHead, expectedHead, clean: false, whitespaceErrors: [] },
        };
      },
    } as StructuralGate;

    const result = await new ContributionIntegrator(git, gate)
      .integrate("run-untracked", project, contribution, structuralOnly());

    expect(result.record.state).toBe("rolled_back");
    expect(await git.head(project.canonicalWorkspacePath)).toBe(base);
    expect(await git.isClean(project.canonicalWorkspacePath)).toBe(true);
    await expect(access(untracked)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("rejects a canonical replacement before apply without mutating the replacement", async () => {
    const { git, project, contribution } = await fixture();
    const displaced = project.canonicalWorkspacePath + "-displaced";
    const marker = path.join(project.canonicalWorkspacePath, "replacement.txt");
    const integrator = new ContributionIntegrator(git, new StructuralGate(git), {
      beforeApplyRevalidationForTest: async () => {
        await rename(project.canonicalWorkspacePath, displaced);
        await mkdir(project.canonicalWorkspacePath);
        await writeFile(marker, "replacement\n", "utf8");
      },
    });

    await expect(integrator.integrate("run-replaced", project, contribution, structuralOnly()))
      .rejects.toThrow("canonical_workspace_identity_changed");
    expect(await access(marker)).toBeUndefined();
    expect(await readFile(marker, "utf8")).toBe("replacement\n");
  }, 15_000);

  it("rejects a canonical replacement before rollback without mutating the replacement", async () => {
    const { git, project, contribution } = await fixture();
    const displaced = project.canonicalWorkspacePath + "-rollback-displaced";
    const marker = path.join(project.canonicalWorkspacePath, "replacement.txt");
    const gate = {
      verify: async (_workspace: string, expectedHead: string) => ({
        level: "structural" as const,
        passed: false,
        evidence: { actualHead: expectedHead, expectedHead, clean: false, whitespaceErrors: [] },
      }),
    } as StructuralGate;
    const integrator = new ContributionIntegrator(git, gate, {
      beforeRollbackRevalidationForTest: async () => {
        await rename(project.canonicalWorkspacePath, displaced);
        await mkdir(project.canonicalWorkspacePath);
        await writeFile(marker, "replacement\n", "utf8");
      },
    });

    await expect(integrator.integrate("run-rollback-replaced", project, contribution, structuralOnly()))
      .rejects.toThrow("canonical_workspace_identity_changed");
    expect(await readFile(marker, "utf8")).toBe("replacement\n");
  }, 15_000);

  it("fails closed when conflict abort cannot prove exact head equality", async () => {
    const before = "0".repeat(40);
    let headCalls = 0;
    const fakeGit = {
      head: async () => (++headCalls === 1 ? before : "1".repeat(40)),
      resolveCommit: async () => before,
      cherryPick: async () => { throw new Error("conflict"); },
      abortCherryPick: async () => undefined,
      isClean: async () => true,
    } as unknown as GitClient;
    const project: ProjectRunRecord = {
      source: { mode: "new_project", repositoryPath: "canonical", requestedRevision: "seed", baseCommit: before, sourceFingerprint: "f".repeat(64) },
      runBranch: "main", canonicalWorkspacePath: "canonical", headCommit: before,
      state: "ready", attempts: [], integrations: [],
    };
    const contribution: ContributionRecord = {
      contributionId: "changed-head", attemptId: "attempt", attemptRevision: 1,
      ownerFingerprint: "a".repeat(64), subtaskId: "task", baseCommit: before,
      headCommit: "2".repeat(40), changedPaths: ["file"], diffHash: "b".repeat(64),
      verificationLevel: "structural",
    };

    await expect(new ContributionIntegrator(fakeGit, {} as StructuralGate, {
      assertAuthorityForTest: async () => undefined,
    })
      .integrate("run", project, contribution, structuralOnly())).rejects.toThrow("integration_conflict_head_changed");
  });

  it("serializes one run while allowing a different run to proceed", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let entered = 0;
    const fakeGit = {
      head: async (cwd: string) => cwd + "0".repeat(39),
      resolveCommit: async (_cwd: string, revision: string) => revision,
      cherryPick: async (cwd: string) => {
        entered += 1; events.push("enter:" + cwd);
        if (cwd === "a") await firstBlocked;
        events.push("leave:" + cwd);
      },
      abortCherryPick: async () => undefined,
      resetHard: async () => undefined,
    } as unknown as GitClient;
    const gate = { verify: async (cwd: string) => ({
      level: "structural" as const, passed: true,
      evidence: { actualHead: cwd + "1".repeat(39), expectedHead: cwd + "1".repeat(39), clean: true, whitespaceErrors: [] },
    }) } as StructuralGate;
    const integrator = new ContributionIntegrator(fakeGit, gate, {
      assertAuthorityForTest: async () => undefined,
    });
    const project = (cwd: string): ProjectRunRecord => ({
      source: { mode: "new_project", repositoryPath: cwd, requestedRevision: "seed", baseCommit: cwd + "0".repeat(39), sourceFingerprint: "f".repeat(64) },
      runBranch: "main", canonicalWorkspacePath: cwd, headCommit: cwd + "0".repeat(39),
      state: "ready", attempts: [], integrations: [],
    });
    const contribution = (id: string): ContributionRecord => ({
      contributionId: id, attemptId: id, attemptRevision: 1, ownerFingerprint: "a".repeat(64),
      subtaskId: id, baseCommit: "0".repeat(40), headCommit: "1".repeat(40), changedPaths: [id],
      diffHash: "b".repeat(64), verificationLevel: "structural",
    });

    const first = integrator.integrate("same", project("a"), contribution("one"), structuralOnly());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = integrator.integrate("same", project("a"), contribution("two"), structuralOnly());
    const independent = integrator.integrate("other", project("b"), contribution("three"), structuralOnly());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(entered).toBe(2);
    releaseFirst();
    await Promise.all([first, queued, independent]);
    expect(events.indexOf("leave:a")).toBeLessThan(events.lastIndexOf("enter:a"));
  });
});
