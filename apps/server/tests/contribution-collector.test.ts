import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContributionCollector,
  ContributionError,
} from "../src/contribution-collector.js";
import { GitClient } from "../src/git-client.js";
import type { AttemptWorkspaceRecord } from "../src/types.js";

const temporaryDirectories: string[] = [];

class CollectorFixtureGit extends GitClient {
  override async validateStandaloneAttempt(): Promise<void> {
    // Exact metadata enforcement has real-Git mutation coverage in git-client.test.
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function repository(): Promise<{
  git: GitClient;
  root: string;
  base: string;
  attempt: AttemptWorkspaceRecord;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-contribution-"));
  temporaryDirectories.push(root);
  const git = new CollectorFixtureGit(5_000);
  await git.run(root, ["init", "-b", "main"]);
  await writeFile(path.join(root, "README.md"), "base\n", "utf8");
  await git.run(root, ["add", "--", "README.md"]);
  await git.run(root, ["commit", "-m", "base"]);
  const base = await git.head(root);
  return {
    git,
    root,
    base,
    attempt: {
      attemptId: "attempt-1",
      revision: 1,
      ownerToken: "11111111-1111-4111-8111-111111111111",
      subtaskId: "task-1",
      baseCommit: base,
      workspacePath: root,
      state: "running",
      cleanup: "active",
      headCommit: base,
      reason: null,
      kind: "task",
      checkpointId: null,
    },
  };
}

async function commitFile(
  fixture: Awaited<ReturnType<typeof repository>>,
  relativePath: string,
  content: string,
): Promise<string> {
  const target = path.join(fixture.root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  await fixture.git.run(fixture.root, ["add", "--", relativePath]);
  await fixture.git.run(fixture.root, ["commit", "-m", "worker contribution"]);
  return fixture.git.head(fixture.root);
}

function marker(sha: string): string {
  return "Worker summary\nLAUNCHPAD_COMMIT=" + sha;
}

async function expectCode(promise: Promise<unknown>, code: ContributionError["code"]) {
  await expect(promise).rejects.toMatchObject({ name: "ContributionError", code });
}

describe("ContributionCollector", () => {
  it("collects one clean descendant commit and hashes Git's raw binary diff", async () => {
    const fixture = await repository();
    const head = await commitFile(fixture, "src/file with spaces.txt", "first\n");

    const collected = await new ContributionCollector(fixture.git).collect({
      attempt: fixture.attempt,
      subtaskId: "task-1",
      workerOutput: marker(head),
    });

    expect(collected).toEqual({
      contributionId: expect.stringMatching(/^[0-9a-f]{64}$/),
      attemptId: "attempt-1",
      attemptRevision: 1,
      ownerFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      subtaskId: "task-1",
      baseCommit: fixture.base,
      headCommit: head,
      changedPaths: ["src/file with spaces.txt"],
      diffHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      verificationLevel: "structural",
      verificationIds: [],
    });
  });

  it("binds contribution identity to the exact internal attempt owner", async () => {
    const fixture = await repository();
    const head = await commitFile(fixture, "change.txt", "change\n");
    const collector = new ContributionCollector(fixture.git);
    const first = await collector.collect({
      attempt: fixture.attempt,
      subtaskId: "task-1",
      workerOutput: marker(head),
    });
    const second = await collector.collect({
      attempt: {
        ...fixture.attempt,
        ownerToken: "22222222-2222-4222-8222-222222222222",
      },
      subtaskId: "task-1",
      workerOutput: marker(head),
    });

    expect(second.ownerFingerprint).not.toBe(first.ownerFingerprint);
    expect(second.contributionId).not.toBe(first.contributionId);
    expect(first).not.toHaveProperty("ownerToken");
  });

  it("preserves NUL-delimited path names containing newlines", async () => {
    const fixture = await repository();
    const unusualPath = "src/line\nbreak.txt";
    const head = await commitFile(fixture, unusualPath, "content\n");

    const collected = await new ContributionCollector(fixture.git).collect({
      attempt: fixture.attempt,
      subtaskId: "task-1",
      workerOutput: marker(head),
    });

    expect(collected.changedPaths).toEqual([unusualPath]);
  });

  it("rejects a missing, malformed, duplicate, non-final, or uppercase marker", async () => {
    const fixture = await repository();
    const head = await commitFile(fixture, "change.txt", "change\n");
    const uppercase = head.toUpperCase();
    const outputs = [
      "Worker summary only",
      "LAUNCHPAD_COMMIT=short",
      marker(head) + "\nLAUNCHPAD_COMMIT=" + head,
      marker(head) + "\ntrailing prose",
      "LAUNCHPAD_COMMIT=" + uppercase,
      "launchpad_commit=" + head,
    ];

    for (const workerOutput of outputs) {
      await expectCode(
        new ContributionCollector(fixture.git).collect({
          attempt: fixture.attempt,
          subtaskId: "task-1",
          workerOutput,
        }),
        "contribution_marker_invalid",
      );
    }
  });

  it("rejects an output-only SHA claim that differs from Git HEAD", async () => {
    const fixture = await repository();
    await commitFile(fixture, "change.txt", "change\n");

    await expectCode(
      new ContributionCollector(fixture.git).collect({
        attempt: fixture.attempt,
        subtaskId: "task-1",
        workerOutput: marker(fixture.base),
      }),
      "contribution_marker_mismatch",
    );
  });

  it("rejects a dirty worktree even when the claimed commit is HEAD", async () => {
    const fixture = await repository();
    const head = await commitFile(fixture, "change.txt", "committed\n");
    await writeFile(path.join(fixture.root, "change.txt"), "dirty\n", "utf8");

    await expectCode(
      new ContributionCollector(fixture.git).collect({
        attempt: fixture.attempt,
        subtaskId: "task-1",
        workerOutput: marker(head),
      }),
      "contribution_worktree_dirty",
    );
  });

  it("rejects zero commits and multiple commits", async () => {
    const noCommit = await repository();
    await expectCode(
      new ContributionCollector(noCommit.git).collect({
        attempt: noCommit.attempt,
        subtaskId: "task-1",
        workerOutput: marker(noCommit.base),
      }),
      "contribution_commit_count",
    );

    const multiple = await repository();
    await commitFile(multiple, "one.txt", "one\n");
    const head = await commitFile(multiple, "two.txt", "two\n");
    await expectCode(
      new ContributionCollector(multiple.git).collect({
        attempt: multiple.attempt,
        subtaskId: "task-1",
        workerOutput: marker(head),
      }),
      "contribution_commit_count",
    );
  });

  it("rejects a clean head outside the recorded base ancestry", async () => {
    const fixture = await repository();
    await fixture.git.run(fixture.root, ["checkout", "--orphan", "unrelated"]);
    await fixture.git.run(fixture.root, ["rm", "-rf", "--", "."]);
    await writeFile(path.join(fixture.root, "unrelated.txt"), "unrelated\n", "utf8");
    await fixture.git.run(fixture.root, ["add", "--", "unrelated.txt"]);
    await fixture.git.run(fixture.root, ["commit", "-m", "unrelated"]);
    const head = await fixture.git.head(fixture.root);
    await fixture.git.run(fixture.root, ["checkout", "--detach", head]);
    await fixture.git.run(fixture.root, ["update-ref", "-d", "refs/heads/unrelated", head]);

    await expectCode(
      new ContributionCollector(fixture.git).collect({
        attempt: fixture.attempt,
        subtaskId: "task-1",
        workerOutput: marker(head),
      }),
      "contribution_wrong_ancestry",
    );
  });

  it("rejects empty changed paths and middleware-reserved .launchpad paths", async () => {
    const empty = await repository();
    await empty.git.run(empty.root, ["commit", "--allow-empty", "-m", "empty"]);
    const emptyHead = await empty.git.head(empty.root);
    await expectCode(
      new ContributionCollector(empty.git).collect({
        attempt: empty.attempt,
        subtaskId: "task-1",
        workerOutput: marker(emptyHead),
      }),
      "contribution_no_changes",
    );

    for (const reservedPath of [".launchpad", ".launchpad/owned.json"]) {
      const reserved = await repository();
      const head = await commitFile(reserved, reservedPath, "spoof\n");
      await expectCode(
        new ContributionCollector(reserved.git).collect({
          attempt: reserved.attempt,
          subtaskId: "task-1",
          workerOutput: marker(head),
        }),
        "contribution_reserved_path",
      );
    }
  });

  it("derives diffHash from content rather than arbitrary model prose", async () => {
    const fixture = await repository();
    const head = await commitFile(fixture, "change.txt", "version one\n");
    const collector = new ContributionCollector(fixture.git);
    const first = await collector.collect({
      attempt: fixture.attempt,
      subtaskId: "task-1",
      workerOutput: "first explanation\nLAUNCHPAD_COMMIT=" + head,
    });
    const sameGitDifferentOutput = await collector.collect({
      attempt: fixture.attempt,
      subtaskId: "task-1",
      workerOutput: "completely different explanation\nLAUNCHPAD_COMMIT=" + head,
    });
    expect(sameGitDifferentOutput.diffHash).toBe(first.diffHash);

    const secondFixture = await repository();
    const secondHead = await commitFile(secondFixture, "change.txt", "version two\n");
    const changedContent = await new ContributionCollector(secondFixture.git).collect({
      attempt: secondFixture.attempt,
      subtaskId: "task-1",
      workerOutput: marker(secondHead),
    });
    expect(changedContent.diffHash).not.toBe(first.diffHash);
  });

  it("does not confuse prose describing the required marker with another claim", async () => {
    const fixture = await repository();
    const head = await commitFile(fixture, "change.txt", "change\n");

    await expect(
      new ContributionCollector(fixture.git).collect({
        attempt: fixture.attempt,
        subtaskId: "task-1",
        workerOutput:
          "I followed: End your response with LAUNCHPAD_COMMIT=<40 lowercase hex SHA>.\n" +
          "LAUNCHPAD_COMMIT=" + head,
      }),
    ).resolves.toMatchObject({ headCommit: head });
  });

  it("ignores only the exact template placeholder when echoed as its own line or code fence", async () => {
    for (const template of [
      "LAUNCHPAD_COMMIT=<40 lowercase hex SHA>",
      "```text\nLAUNCHPAD_COMMIT=<40 lowercase hex SHA>\n```",
    ]) {
      const fixture = await repository();
      const head = await commitFile(fixture, "change.txt", "change\n");
      await expect(new ContributionCollector(fixture.git).collect({
        attempt: fixture.attempt,
        subtaskId: "task-1",
        workerOutput: template + "\nLAUNCHPAD_COMMIT=" + head,
      })).resolves.toMatchObject({ headCommit: head });
    }
  });

  it("rejects every non-template marker candidate even when a final valid claim follows", async () => {
    const candidates = [
      "LAUNCHPAD_COMMIT=short",
      "launchpad_commit=0123456789abcdef0123456789abcdef01234567",
      "LAUNCHPAD_COMMIT=0123456789ABCDEF0123456789ABCDEF01234567",
      "LAUNCHPAD_COMMIT =0123456789abcdef0123456789abcdef01234567",
    ];
    for (const candidate of candidates) {
      const fixture = await repository();
      const head = await commitFile(fixture, "change.txt", "change\n");
      await expectCode(new ContributionCollector(fixture.git).collect({
        attempt: fixture.attempt,
        subtaskId: "task-1",
        workerOutput: candidate + "\nLAUNCHPAD_COMMIT=" + head,
      }), "contribution_marker_invalid");
    }
  });

  it("rejects a stale subtask binding before trusting Git evidence", async () => {
    const fixture = await repository();
    const head = await commitFile(fixture, "change.txt", "change\n");

    await expectCode(
      new ContributionCollector(fixture.git).collect({
        attempt: fixture.attempt,
        subtaskId: "different-task",
        workerOutput: marker(head),
      }),
      "contribution_attempt_mismatch",
    );
  });

  it("classifies unavailable Git evidence as a typed collection failure", async () => {
    class UnavailableGit extends GitClient {
      override async validateStandaloneAttempt(): Promise<void> {}
      override async head(): Promise<string> {
        throw new Error("transport details that are not a detector code");
      }
    }
    const fixture = await repository();

    await expectCode(
      new ContributionCollector(new UnavailableGit(5_000)).collect({
        attempt: fixture.attempt,
        subtaskId: "task-1",
        workerOutput: marker(fixture.base),
      }),
      "contribution_git_unavailable",
    );
  });

  it("classifies worker-controlled Git metadata as a typed sanitized failure", async () => {
    const fixture = await repository();
    const head = await commitFile(fixture, "change.txt", "change\n");
    class TamperedGit extends CollectorFixtureGit {
      override async validateStandaloneAttempt(): Promise<void> {
        throw Object.assign(new Error("private metadata detail"), { code: "git_metadata_tampered" });
      }
    }

    await expectCode(
      new ContributionCollector(new TamperedGit(5_000)).collect({
        attempt: fixture.attempt,
        subtaskId: "task-1",
        workerOutput: marker(head),
      }),
      "contribution_metadata_tampered",
    );
  });

  it("rejects a repair candidate that has not been squashed into a one-commit contribution", async () => {
    const fixture = await repository();
    const head = await commitFile(fixture, "change.txt", "change\n");
    await expectCode(
      new ContributionCollector(fixture.git).collect({
        attempt: {
          ...fixture.attempt,
          kind: "repair",
          checkpointId: "chk-1",
          state: "running",
        },
        subtaskId: "task-1",
        workerOutput: marker(head),
      }),
      "contribution_attempt_mismatch",
    );
  });
});
