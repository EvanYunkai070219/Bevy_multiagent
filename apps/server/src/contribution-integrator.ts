import { GitClient } from "./git-client.js";
import { StructuralGate } from "./structural-gate.js";
import { assertCanonicalWorkspaceAuthority } from "./project-run-manager.js";
import type { RunControl } from "./orchestration/run-control.js";
import { verificationDenial } from "./types.js";
import type {
  ContributionRecord,
  IntegrationRecord,
  ProjectRunRecord,
  VerificationResult,
} from "./types.js";

const COMMIT = /^[0-9a-f]{40}$/;

export interface ContributionIntegratorHooks {
  /** @internal Deterministic identity-race seam; never populate from request input. */
  beforeApplyRevalidationForTest?(): Promise<void>;
  /** @internal Deterministic rollback identity-race seam. */
  beforeRollbackRevalidationForTest?(): Promise<void>;
  /** @internal Fake-Git seam only. */
  assertAuthorityForTest?: typeof assertCanonicalWorkspaceAuthority;
}

export interface ContributionIntegrateOptions {
  control: RunControl;
  /**
   * Absent only when healing is off, where the structural gate stays the sole
   * post-apply evidence. Present, its mandatory verdict — not the structural
   * gate — decides whether the applied commit may stay on the canonical head.
   *
   * `canonicalHeadBefore` is the range base the authority must judge: on the
   * canonical checkout only `canonicalHeadBefore..appliedHead` belongs to this
   * contribution, while the attempt's own base commit may sit several earlier
   * contributions back.
   */
  postIntegrationVerify?(
    workspacePath: string,
    appliedHead: string,
    canonicalHeadBefore: string,
  ): Promise<VerificationResult>;
}

export interface ContributionIntegrationOutcome {
  record: IntegrationRecord;
  projectHead: string;
  verification: VerificationResult | null;
}

export class ContributionIntegrator {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly git: GitClient,
    private readonly gate: StructuralGate,
    private readonly hooks: ContributionIntegratorHooks = {},
  ) {}

  async integrate(
    runId: string,
    project: ProjectRunRecord,
    contribution: ContributionRecord,
    options: ContributionIntegrateOptions,
  ): Promise<ContributionIntegrationOutcome> {
    const predecessor = this.queues.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = predecessor.catch(() => undefined).then(() => turn);
    this.queues.set(runId, tail);
    await predecessor.catch(() => undefined);
    try {
      options.control.assertActive();
      return await this.integrateSerialized(project, contribution, options);
    } finally {
      release();
      if (this.queues.get(runId) === tail) this.queues.delete(runId);
    }
  }

  /** Cancellation/recovery authority: restore only the identity-pinned canonical checkout. */
  async restore(project: ProjectRunRecord, expectedHead: string): Promise<void> {
    await this.rollback(project, expectedHead);
  }

  private async integrateSerialized(
    project: ProjectRunRecord,
    contribution: ContributionRecord,
    options: ContributionIntegrateOptions,
  ): Promise<ContributionIntegrationOutcome> {
    const workspace = project.canonicalWorkspacePath;
    options.control.assertActive();
    await this.assertAuthority(project, project.headCommit ?? undefined);
    const canonicalHeadBefore = await this.git.head(workspace);
    if (!COMMIT.test(canonicalHeadBefore)) throw new Error("integration_canonical_head_unresolved");
    if (project.headCommit !== canonicalHeadBefore) throw new Error("integration_canonical_head_mismatch");
    if ((await this.git.resolveCommit(workspace, canonicalHeadBefore)) !== canonicalHeadBefore) {
      throw new Error("integration_canonical_head_unresolved");
    }

    await this.hooks.beforeApplyRevalidationForTest?.();
    options.control.assertActive();
    await this.assertAuthority(project, canonicalHeadBefore);
    try {
      await this.git.cherryPick(workspace, contribution.headCommit);
    } catch (error) {
      await this.hooks.beforeRollbackRevalidationForTest?.();
      await this.assertAuthority(project);
      await this.git.abortCherryPick(workspace);
      const headAfterAbort = await this.git.head(workspace);
      if (headAfterAbort !== canonicalHeadBefore || !(await this.git.isClean(workspace))) {
        throw new Error("integration_conflict_head_changed");
      }
      await this.assertAuthority(project, canonicalHeadBefore);
      return {
        record: {
          contributionId: contribution.contributionId,
          subtaskId: contribution.subtaskId,
          canonicalHeadBefore,
          canonicalHeadAfter: null,
          state: "conflicted",
          structuralDecision: "failed",
          reason: "integration_conflict: " + errorMessage(error),
          verificationIds: [],
        },
        projectHead: canonicalHeadBefore,
        verification: null,
      };
    }

    const appliedHead = await this.git.head(workspace);
    await this.assertAuthority(project, appliedHead);
    let gate;
    try {
      gate = await this.gate.verify(workspace, appliedHead);
    } catch (error) {
      await this.rollback(project, canonicalHeadBefore);
      return this.rolledBack(
        contribution,
        canonicalHeadBefore,
        "structural_gate_error: " + errorMessage(error),
        null,
      );
    }
    if (!gate.passed) {
      await this.rollback(project, canonicalHeadBefore);
      return this.rolledBack(
        contribution,
        canonicalHeadBefore,
        structuralReason(gate.evidence),
        null,
      );
    }

    let verification: VerificationResult | null = null;
    if (options.postIntegrationVerify) {
      await this.guardApplied(options, project, canonicalHeadBefore, appliedHead);
      try {
        verification = await options.postIntegrationVerify(
          workspace,
          appliedHead,
          canonicalHeadBefore,
        );
      } catch (error) {
        await this.rollback(project, canonicalHeadBefore);
        return this.rolledBack(
          contribution,
          canonicalHeadBefore,
          "post_integration_verification_error: " + errorMessage(error),
          null,
        );
      }
      const denial = verificationDenial(
        verification,
        "post_integration",
        contribution.contributionId,
      );
      if (denial) {
        await this.rollback(project, canonicalHeadBefore);
        return this.rolledBack(contribution, canonicalHeadBefore, denial, verification);
      }
    }

    await this.guardApplied(options, project, canonicalHeadBefore, appliedHead);
    return {
      record: {
        contributionId: contribution.contributionId,
        subtaskId: contribution.subtaskId,
        canonicalHeadBefore,
        canonicalHeadAfter: appliedHead,
        state: "integrated",
        structuralDecision: "passed",
        reason: null,
        verificationIds: verification ? [verification.id] : [],
      },
      projectHead: appliedHead,
      verification,
    };
  }

  /**
   * Nothing applied may survive a terminal run or a canonical checkout that is
   * no longer the one this decision was computed against.
   */
  private async guardApplied(
    options: ContributionIntegrateOptions,
    project: ProjectRunRecord,
    canonicalHeadBefore: string,
    appliedHead: string,
  ): Promise<void> {
    try {
      options.control.assertActive();
    } catch (error) {
      await this.rollback(project, canonicalHeadBefore);
      throw error;
    }
    await this.assertAuthority(project, appliedHead);
  }

  private rolledBack(
    contribution: ContributionRecord,
    canonicalHeadBefore: string,
    reason: string,
    verification: VerificationResult | null,
  ): ContributionIntegrationOutcome {
    return {
      record: {
        contributionId: contribution.contributionId,
        subtaskId: contribution.subtaskId,
        canonicalHeadBefore,
        canonicalHeadAfter: null,
        state: "rolled_back",
        structuralDecision: "failed",
        reason,
        verificationIds: verification ? [verification.id] : [],
      },
      projectHead: canonicalHeadBefore,
      verification,
    };
  }

  private async rollback(project: ProjectRunRecord, expectedHead: string): Promise<void> {
    const workspace = project.canonicalWorkspacePath;
    await this.hooks.beforeRollbackRevalidationForTest?.();
    await this.assertAuthority(project);
    await this.git.resetHard(workspace, expectedHead);
    await this.assertAuthority(project, expectedHead);
    await this.git.cleanUntracked(workspace);
    await this.assertAuthority(project, expectedHead);
    if ((await this.git.head(workspace)) !== expectedHead || !(await this.git.isClean(workspace))) {
      throw new Error("integration_rollback_head_mismatch");
    }
  }

  private assertAuthority(project: ProjectRunRecord, expectedHead?: string): Promise<void> {
    return (this.hooks.assertAuthorityForTest ?? assertCanonicalWorkspaceAuthority)(
      this.git,
      project,
      expectedHead,
    );
  }
}

function structuralReason(evidence: {
  actualHead: string;
  expectedHead: string;
  clean: boolean;
  whitespaceErrors: string[];
}): string {
  if (evidence.actualHead !== evidence.expectedHead) return "structural_head_mismatch";
  if (!evidence.clean) return "structural_workspace_dirty";
  if (evidence.whitespaceErrors.length > 0) return "structural_diff_check_failed";
  return "structural_gate_failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
