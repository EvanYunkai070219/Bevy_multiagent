import { createHash } from "node:crypto";
import { GitClient } from "./git-client.js";
import type { AttemptWorkspaceRecord, ContributionRecord } from "./types.js";

export type ContributionErrorCode =
  | "contribution_attempt_mismatch"
  | "contribution_git_unavailable"
  | "contribution_marker_invalid"
  | "contribution_marker_mismatch"
  | "contribution_metadata_tampered"
  | "contribution_tool_protocol_failed"
  | "contribution_worktree_dirty"
  | "contribution_wrong_ancestry"
  | "contribution_commit_count"
  | "contribution_no_changes"
  | "contribution_reserved_path";

export class ContributionError extends Error {
  readonly name = "ContributionError";
  readonly cause?: unknown;

  constructor(readonly code: ContributionErrorCode, message: string, cause?: unknown) {
    super(message);
    Object.defineProperty(this, "cause", { value: cause, enumerable: false, configurable: true });
  }
}

export class ContributionCollector {
  constructor(private readonly git: GitClient) {}

  async collect(input: {
    attempt: AttemptWorkspaceRecord;
    subtaskId: string;
    workerOutput: string;
  }): Promise<ContributionRecord> {
    if (
      input.attempt.subtaskId !== input.subtaskId ||
      input.attempt.state !== "running" ||
      input.attempt.kind === "repair" ||
      !Number.isSafeInteger(input.attempt.revision) ||
      input.attempt.revision < 1 ||
      !/^[0-9a-f-]{36}$/i.test(input.attempt.ownerToken)
    ) {
      throw new ContributionError(
        "contribution_attempt_mismatch",
        "Contribution does not belong to the active subtask attempt",
      );
    }
    const claimed = parseContributionCommitMarker(input.workerOutput);
    try {
      return await this.collectGitEvidence(input.attempt, input.subtaskId, claimed);
    } catch (error) {
      if (error instanceof ContributionError) throw error;
      throw new ContributionError(
        "contribution_git_unavailable",
        "Git contribution evidence could not be inspected",
        error,
      );
    }
  }

  private async collectGitEvidence(
    attempt: AttemptWorkspaceRecord,
    subtaskId: string,
    claimed: string,
  ): Promise<ContributionRecord> {
    const cwd = attempt.workspacePath;
    try {
      await this.git.validateStandaloneAttempt(cwd, attempt.baseCommit);
    } catch (error) {
      if ((error as { code?: unknown }).code === "git_metadata_tampered") {
        throw new ContributionError(
          "contribution_metadata_tampered",
          "Contribution repository metadata failed the standalone manifest",
        );
      }
      throw error;
    }
    const head = await this.git.head(cwd);
    if (claimed !== head) {
      throw new ContributionError(
        "contribution_marker_mismatch",
        "Claimed contribution commit does not match Git HEAD",
      );
    }
    if (!(await this.git.isClean(cwd))) {
      throw new ContributionError(
        "contribution_worktree_dirty",
        "Contribution worktree is not clean",
      );
    }
    if (!(await this.git.isAncestor(cwd, attempt.baseCommit, head))) {
      throw new ContributionError(
        "contribution_wrong_ancestry",
        "Contribution HEAD does not descend from the attempt base",
      );
    }
    if ((await this.git.commitCount(cwd, attempt.baseCommit, head)) !== 1) {
      throw new ContributionError(
        "contribution_commit_count",
        "Contribution must contain exactly one commit",
      );
    }
    const changedPaths = await this.git.changedPaths(cwd, attempt.baseCommit, head);
    if (changedPaths.length === 0) {
      throw new ContributionError(
        "contribution_no_changes",
        "Contribution commit has no changed paths",
      );
    }
    if (changedPaths.some(isReservedPath)) {
      throw new ContributionError(
        "contribution_reserved_path",
        "Contribution changes middleware-reserved .launchpad state",
      );
    }
    const diffHash = createHash("sha256")
      .update(await this.git.binaryDiff(cwd, attempt.baseCommit, head))
      .digest("hex");
    const ownerFingerprint = createHash("sha256").update(attempt.ownerToken).digest("hex");
    const contributionId = createHash("sha256")
      .update(attempt.attemptId)
      .update("\0")
      .update(String(attempt.revision))
      .update("\0")
      .update(ownerFingerprint)
      .update("\0")
      .update(subtaskId)
      .update("\0")
      .update(attempt.baseCommit)
      .update("\0")
      .update(head)
      .update("\0")
      .update(diffHash)
      .digest("hex");
    return {
      contributionId,
      attemptId: attempt.attemptId,
      attemptRevision: attempt.revision,
      ownerFingerprint,
      subtaskId,
      baseCommit: attempt.baseCommit,
      headCommit: head,
      changedPaths,
      diffHash,
      verificationLevel: "structural",
      verificationIds: [],
    };
  }
}

export function parseContributionCommitMarker(workerOutput: string): string {
  const lines = workerOutput.replace(/\r\n/g, "\n").split("\n");
  const finalLine = [...lines].reverse().find((line) => line.length > 0);
  const markerLines = lines.filter(
    (line) =>
      /^\s*launchpad_commit\b/i.test(line) &&
      line !== "LAUNCHPAD_COMMIT=<40 lowercase hex SHA>",
  );
  if (
    markerLines.length !== 1 ||
    finalLine === undefined ||
    !/^LAUNCHPAD_COMMIT=[0-9a-f]{40}$/.test(finalLine)
  ) {
    throw new ContributionError(
      "contribution_marker_invalid",
      "Worker output must end with exactly one lowercase LAUNCHPAD_COMMIT marker",
    );
  }
  return finalLine.slice("LAUNCHPAD_COMMIT=".length);
}

function isReservedPath(changedPath: string): boolean {
  return changedPath === ".launchpad" || changedPath.startsWith(".launchpad/");
}
