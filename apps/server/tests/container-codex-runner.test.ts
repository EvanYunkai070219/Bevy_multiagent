/** Verifies isolated container invocation arguments and runtime safeguards. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  buildContainerRunArgs,
  containerName,
} from "../src/container-codex-runner.js";
import { GitClient } from "../src/git-client.js";

const exec = promisify(execFile);
const containerIt = process.env.LAUNCHPAD_CONTAINER_INTEGRATION === "1" ? it : it.skip;

describe("Container Codex runner", () => {
  containerIt("mounts a self-contained attempt where commit works but canonical refs cannot change", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-container-git-"));
    try {
      const source = path.join(root, "source");
      const attempt = path.join(root, "attempt");
      const codexHome = path.join(root, "codex-home");
      const data = path.join(root, "data");
      await Promise.all([mkdir(source), mkdir(codexHome), mkdir(data)]);
      const git = new GitClient(10_000);
      await git.run(source, ["init", "-b", "main"]);
      await writeFile(path.join(source, "README.md"), "base\n", "utf8");
      await git.run(source, ["add", "--", "README.md"]);
      await git.run(source, ["commit", "-m", "base"]);
      const canonicalHead = await git.head(source);
      const canonicalStatus = await git.run(source, ["status", "--porcelain=v1", "--untracked-files=all"]);
      const canonicalRefs = await git.run(source, ["for-each-ref", "--format=%(refname) %(objectname)"]);
      await git.worktreeAdd(source, attempt, canonicalHead);

      const engine = process.env.CONTAINER_ENGINE ?? "docker";
      const image = process.env.CONTAINER_RUNTIME_IMAGE ?? "volc-agent-runtime:local";
      const config = loadConfig({
        NODE_ENV: "test",
        APP_DATA_DIR: data,
        CODEX_HOME: codexHome,
        RUNTIME_PROVIDER: "container",
        CONTAINER_ENGINE: engine,
        CONTAINER_RUNTIME_IMAGE: image,
        RUNTIME_INSTANCE_ID: "git-contract",
      });
      const args = buildContainerRunArgs({
        runId: "container-git-contract",
        agentId: "container-git-contract",
        workspacePath: attempt,
        prompt: "unused",
        threadId: null,
      }, config, engine);
      const imageIndex = args.indexOf(image);
      expect(imageIndex).toBeGreaterThan(0);
      const script = [
        "set -eu",
        "git status --porcelain",
        "git config user.email launchpad@example.invalid",
        "git config user.name Launchpad",
        "printf 'container\\n' > container.txt",
        "git add -- container.txt",
        "git commit -m container-attempt",
        "test \"$(git rev-parse --git-common-dir)\" = .git",
        "test -z \"$(git remote)\"",
        "! git push origin HEAD:main",
      ].join("\n");
      await exec(engine, [...args.slice(0, imageIndex + 1), "sh", "-lc", script], { timeout: 30_000 });

      expect(await git.head(source)).toBe(canonicalHead);
      expect(await git.run(source, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(canonicalStatus);
      expect(await git.run(source, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(canonicalRefs);
      expect(await git.head(attempt)).not.toBe(canonicalHead);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 40_000);

  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        runId: "run-1",
        agentId: "agent/unsafe",
        parentRunId: "leader-run",
        workspacePath: "/tmp/agent-workspace",
        commonWorkspacePath: "/tmp/common-workspace",
        prompt: "write a small program",
        threadId: null,
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args.slice(args.indexOf("runtime:test") + 1, args.indexOf("runtime:test") + 5))
      .toEqual(["sh", "-lc", expect.stringContaining("import yaml"), "launchpad-bootstrap"]);
    expect(args.join(" ")).toContain("pip install --user --break-system-packages --quiet pyyaml");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    expect(args).toContain("type=bind,src=/tmp/common-workspace,dst=/common-workspace");
    expect(args).toContain("type=bind,src=/tmp/codex-home,dst=/codex-home");
    expect(args).toContain("--add-dir");
    expect(args).toContain("/common-workspace");
    expect(args).toContain("type=bind,src=" + config.dataDirectory + ",dst=/launchpad-data");
    expect(args).toContain("type=bind,src=" + config.workerDependencyCacheDir + ",dst=/launchpad-cache");
    expect(args).toContain("COMMON_WORKSPACE=/common-workspace");
    expect(args).toContain("LAUNCHPAD_DATA_DIR=/launchpad-data");
    expect(args).toContain("LAUNCHPAD_DEPENDENCY_CACHE=/launchpad-cache");
    expect(args).toContain("PIP_CACHE_DIR=/launchpad-cache/pip");
    expect(args).toContain("UV_CACHE_DIR=/launchpad-cache/uv");
    expect(args).toContain("NPM_CONFIG_CACHE=/launchpad-cache/npm");
    expect(args).toContain("PYTHONUSERBASE=/launchpad-cache/python/user");
    expect(args).toContain("LAUNCHPAD_PIP_BOOTSTRAP=/launchpad-cache/python/get-pip.py");
    expect(args).toContain("LAUNCHPAD_SYSTEM_PYTHON=/usr/bin/python3");
    expect(args).toContain("BASH_ENV=/launchpad-cache/python/shell-env.sh");
    expect(args).toContain(
      "PATH=/launchpad-cache/python/bin:/launchpad-cache/python/user/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    expect(args).toContain("LAUNCHPAD_RUN_ID=run-1");
    expect(args).toContain("LAUNCHPAD_PARENT_RUN_ID=leader-run");
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args.join(" ")).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        runId: "run-2",
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
    expect(args).not.toContain("COMMON_WORKSPACE=/common-workspace");
  });

  it("pins a repair candidate to the resolved digest after the configured tag retags", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_RUNTIME_IMAGE: "runtime:stable",
    });
    const resolvedAtStartup = "sha256:" + "1".repeat(64);
    const request = {
      runId: "repair-run",
      agentId: "repair-agent",
      parentRunId: "leader-run",
      workspacePath: "/tmp/repair-workspace",
      prompt: "repair",
      threadId: null,
      runtimeImageId: resolvedAtStartup,
      coordinationEnv: {
        LAUNCHPAD_COORDINATION_URL: "",
        LAUNCHPAD_COORDINATION_TOKEN: "",
        LAUNCHPAD_REPAIR_CANDIDATE: "1",
      },
    };

    const args = buildContainerRunArgs(request, config);
    expect(args).toContain(resolvedAtStartup);
    expect(args).not.toContain("runtime:stable");
    const unresolvedArgs = buildContainerRunArgs(
      { ...request, runtimeImageId: undefined },
      config,
    );
    expect(unresolvedArgs).toContain("runtime:stable");
    expect(unresolvedArgs).not.toContain(resolvedAtStartup);
  });
});

describe("Container model credential", () => {
  const config = () =>
    loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "sk-real-provider-key",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      RUNTIME_INSTANCE_ID: "test-instance",
    });

  const request = (modelToken?: string) => ({
    runId: "run-1",
    agentId: "agent-1",
    workspacePath: "/tmp/ws",
    prompt: "go",
    threadId: null,
    ...(modelToken === undefined ? {} : { modelToken }),
  });

  it("keeps both the token and the real key out of argv", () => {
    const joined = buildContainerRunArgs(request("run-token-abc"), config(), "docker").join(" ");

    // Substring, not array membership: `not.toContain` on an array only
    // matches whole elements, which is how "ARK_API_KEY=<secret>" slipped past
    // the older assertion.
    expect(joined).not.toContain("sk-real-provider-key");
    expect(joined).not.toContain("run-token-abc");
    expect(joined).toContain("--env ARK_API_KEY ");
  });

  it("reaches the host proxy through the gateway mapping", () => {
    const args = buildContainerRunArgs(request("run-token-abc"), config(), "docker");

    expect(args).toContain("--add-host");
    expect(args).toContain("host.docker.internal:host-gateway");
  });

  it("passes the credential by environment, not by value, in both modes", () => {
    const withToken = buildContainerRunArgs(request("run-token-abc"), config(), "docker");
    const withoutToken = buildContainerRunArgs(request(), config(), "docker");

    expect(withToken).toEqual(withoutToken);
    expect(withoutToken.join(" ")).not.toContain("sk-real-provider-key");
  });
});
