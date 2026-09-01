import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  createContainerAuthority,
  CONTAINER_OWNER_LABEL,
  prepareContainerAuthority,
} from "../src/runtime/container-authority.js";
import { RunControl } from "../src/orchestration/run-control.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import {
  VerificationContainer,
  buildVerificationRunArgs,
  decodeVerificationWrapperExit,
} from "../src/orchestration/verification/verification-container.js";
import * as verificationContainerModule from "../src/orchestration/verification/verification-container.js";
import type { AuthorityGate } from "../src/orchestration/verification/verification-profile.js";
import { materializeAuthority } from "./verification-authority-fixtures.js";
import {
  fakeVerifierEngine,
  realVerificationFixture,
} from "./verification-container-fixtures.js";

const directories: string[] = [];
const containerIt = process.env.LAUNCHPAD_CONTAINER_INTEGRATION === "1" ? it : it.skip;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const gate: AuthorityGate = {
  id: "targeted",
  tier: "targeted",
  command: ["node", "gates/targeted.mjs"],
  assetIds: ["targeted-gate"],
  critical: true,
};

function verifierConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    ARK_API_KEY: "super-secret-provider-key",
    ARK_MODEL: "ep-test",
    APP_AUTH_TOKEN: "run-token-should-never-leak",
    ...overrides,
  });
}

async function readVerificationReconciliationRecords(dataDirectory: string): Promise<unknown[]> {
  const directory = path.join(dataDirectory, "container-authority", "verification-reconciliation");
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return Promise.all(entries
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map(async (entry) => JSON.parse(await readFile(path.join(directory, entry), "utf8")) as unknown));
}

async function realDockerFixture(root: string, gateSource: string) {
  const candidate = path.join(root, "candidate");
  const authorityRoot = path.join(root, "authority");
  await mkdir(candidate, { recursive: true, mode: 0o755 });
  await materializeAuthority(authorityRoot);
  await writeFile(path.join(authorityRoot, "gates", "targeted.mjs"), gateSource, { mode: 0o644 });
  const config = verifierConfig({
    APP_DATA_DIR: path.join(root, "data"),
    CONTAINER_ENGINE: process.env.CONTAINER_ENGINE ?? "docker",
    VERIFIER_CONTAINER_IMAGE: process.env.VERIFIER_CONTAINER_IMAGE ?? "node:22-bookworm-slim",
    VERIFIER_CONTAINER_USER: "65534:65534",
  });
  return {
    authorityRoot,
    candidate,
    container: new VerificationContainer(config),
    dataDirectory: config.dataDirectory,
  };
}

describe("VerificationContainer invocation", () => {
  type CompletionAuthority = {
    directoryPath: string;
    requestPath: string;
    artifactPath: string;
    temporaryPath: string;
    nonce: string;
    realPath: string;
    dev: number;
    ino: number;
    uid: number;
    gid: number;
    mode: number;
  };
  const completionApi = verificationContainerModule as unknown as {
    prepareVerificationCompletionAuthority?: (
      authority: ReturnType<typeof createContainerAuthority>,
    ) => Promise<CompletionAuthority>;
    validateVerificationCompletionArtifact?: (
      authority: CompletionAuthority,
      engineExitCode: number | null,
    ) => Promise<number | undefined>;
    removeVerificationCompletionAuthority?: (authority: CompletionAuthority) => Promise<void>;
  };

  async function preparedCompletion(root: string): Promise<CompletionAuthority> {
    const config = verifierConfig({ APP_DATA_DIR: path.join(root, "data") });
    const containerAuthority = createContainerAuthority("verifier", config);
    await prepareContainerAuthority(containerAuthority);
    return completionApi.prepareVerificationCompletionAuthority!(containerAuthority);
  }

  async function publishCompletion(authority: CompletionAuthority, exitCode: 0 | 1): Promise<void> {
    await unlink(authority.requestPath);
    await writeFile(
      authority.artifactPath,
      `{"schemaVersion":1,"nonce":"${authority.nonce}","exitCode":${exitCode}}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }

  it("requires a pinned exact origin artifact in addition to the reserved engine exit", async () => {
    expect(completionApi.prepareVerificationCompletionAuthority).toBeTypeOf("function");
    expect(completionApi.validateVerificationCompletionArtifact).toBeTypeOf("function");
    expect(completionApi.removeVerificationCompletionAuthority).toBeTypeOf("function");
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-completion-authority-"));
    directories.push(root);
    const completion = await preparedCompletion(root);
    await publishCompletion(completion, 0);

    await expect(completionApi.validateVerificationCompletionArtifact!(completion, 200)).resolves.toBe(0);
    await completionApi.removeVerificationCompletionAuthority!(completion);
    await expect(readdir(completion.directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["owner", "directory_mode", "hard_link"] as const)(
    "rejects completion artifact $caseName identity mutation",
    async (caseName) => {
      const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-completion-identity-"));
      directories.push(root);
      const completion = await preparedCompletion(root);
      await publishCompletion(completion, 0);
      let expected = completion;
      if (caseName === "owner") expected = { ...completion, uid: completion.uid + 1 };
      if (caseName === "directory_mode") await chmod(completion.directoryPath, 0o755);
      if (caseName === "hard_link") {
        const outside = path.join(root, "outside-completion");
        await rename(completion.artifactPath, outside);
        await link(outside, completion.artifactPath);
      }

      await expect(completionApi.validateVerificationCompletionArtifact!(expected, 200)).resolves.toBeUndefined();
      if (caseName === "directory_mode") await chmod(completion.directoryPath, 0o700);
      await completionApi.removeVerificationCompletionAuthority!(completion);
    },
  );

  it.each(["replacement", "symlink"] as const)(
    "does not follow a $caseName completion directory during cleanup",
    async (caseName) => {
      const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-completion-replacement-"));
      directories.push(root);
      const completion = await preparedCompletion(root);
      const original = completion.directoryPath + ".original";
      await rename(completion.directoryPath, original);
      if (caseName === "replacement") await mkdir(completion.directoryPath, { mode: 0o700 });
      else await symlink(original, completion.directoryPath);
      const sentinel = path.join(caseName === "replacement" ? completion.directoryPath : original, "sentinel");
      await writeFile(sentinel, "preserve\n", "utf8");

      await expect(completionApi.removeVerificationCompletionAuthority!(completion)).rejects.toThrow();
      await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve\n");
    },
  );

  it("accepts only the two reserved PID 1 wrapper exits across the complete engine exit domain", () => {
    for (let code = 0; code <= 255; code += 1) {
      const expected = code === 200 ? 0 : code === 201 ? 1 : undefined;
      expect(decodeVerificationWrapperExit(code), "engine exit " + code).toBe(expected);
    }
    expect(decodeVerificationWrapperExit(null), "engine signal/null exit").toBeUndefined();
  });

  it("runs a fixed root PID 1 wrapper and a numeric non-root gate with isolated completion volume and minimal privileges", () => {
    const config = verifierConfig({
      VERIFIER_CONTAINER_IMAGE: "node:22-bookworm-slim",
      VERIFIER_CONTAINER_CPU_LIMIT: "1",
      VERIFIER_CONTAINER_MEMORY_LIMIT: "256m",
      VERIFIER_CONTAINER_PIDS_LIMIT: "32",
      VERIFIER_CONTAINER_USER: "65534:65534",
    });
    const authority = createContainerAuthority("verifier", config);
    const args = buildVerificationRunArgs({
      candidatePath: "/host/candidate",
      authorityRoot: "/host/authority",
      gate,
      container: authority,
      config,
    });
    const joined = args.join("\n");
    expect(args[0]).toBe("create");
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(joined).toMatch(/type=bind,src=\/host\/candidate,dst=\/candidate.*readonly/);
    expect(joined).toMatch(/type=bind,src=\/host\/authority,dst=\/authority.*readonly/);
    expect(args).toContain("--read-only");
    expect(joined).toMatch(/tmpfs|destination=\/scratch|dst=\/scratch/);
    expect(args[args.indexOf("--user") + 1]).toBe("0:0");
    expect(args).toContain("--cap-drop");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args.filter((item, index) => args[index - 1] === "--cap-add" && item !== undefined)).toEqual([
      "KILL",
      "SETGID",
      "SETUID",
    ]);
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("--cpus");
    expect(args).toContain("--memory");
    expect(args).toContain("--pids-limit");
    expect(args).toContain("--cidfile");
    expect(args).toContain(CONTAINER_OWNER_LABEL + "=" + authority.ownerId);
    expect(joined).not.toContain("ARK_API_KEY");
    expect(joined).not.toContain("super-secret-provider-key");
    expect(joined).not.toContain("run-token-should-never-leak");
    expect(joined).not.toContain("APP_AUTH_TOKEN");
    expect(args).toContain("CI=1");
    expect(args).toContain("CANDIDATE=/candidate");
    expect(args).toContain("SCRATCH=/scratch");
    expect(args).toContain("GATE_ID=targeted");
    expect(joined).not.toContain("LAUNCHPAD_GATE_COMPLETION_NONCE");
    expect(args).not.toContain("--init");
    expect(joined).toContain(
      "type=volume,src=launchpad-verifier-completion-" + authority.ownerId +
      ",dst=/run/launchpad-result,volume-nocopy",
    );
    expect(joined).not.toMatch(/type=bind,src=.*dst=\/run\/launchpad-result/);
    expect(args[args.indexOf("--entrypoint") + 1]).toBe("node");
    const imageIndex = args.indexOf("node:22-bookworm-slim");
    expect(args.slice(imageIndex + 1, imageIndex + 2)).toEqual(["-e"]);
    expect(args.slice(-2)).toEqual(["node", "gates/targeted.mjs"]);
    expect(args).not.toContain("--rm");
  });

  it.each([
    "0:65534",
    "65534:0",
    "nobody:nogroup",
    "65534",
    "01:65534",
    "+1:1",
    "4294967295:1",
    "1:4294967295",
  ])("rejects non-exact, root, named, or out-of-range gate identity %s", (user) => {
    const config = verifierConfig({ VERIFIER_CONTAINER_USER: user });
    const authority = createContainerAuthority("verifier", config);

    expect(() => buildVerificationRunArgs({
      candidatePath: "/host/candidate",
      authorityRoot: "/host/authority",
      gate,
      container: authority,
      config,
    })).toThrow("exact non-root numeric uid:gid");
  });

  it("validates the gate identity before creating host or engine authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-invalid-identity-"));
    directories.push(root);
    const dataDirectory = path.join(root, "data");
    const config = verifierConfig({
      APP_DATA_DIR: dataDirectory,
      CONTAINER_ENGINE: path.join(root, "must-not-start"),
      VERIFIER_CONTAINER_USER: "0:0",
    });

    await expect(new VerificationContainer(config).run({
      candidatePath: path.join(root, "candidate"),
      authorityRoot: path.join(root, "authority"),
      gate,
      control: new RunControl(defaultExecutionPolicy),
    })).rejects.toThrow("exact non-root numeric uid:gid");
    await expect(readdir(path.join(dataDirectory, "container-authority"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("cleans up the owned container by exact id, owner label, and cidfile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-container-"));
    directories.push(root);
    const log = path.join(root, "commands.log");
    const id = "c".repeat(64);
    const engine = await fakeVerifierEngine(root, { log, runCid: id });
    const config = verifierConfig({
      APP_DATA_DIR: path.join(root, "data"),
      CONTAINER_ENGINE: engine,
      VERIFIER_CONTAINER_IMAGE: "node:22-bookworm-slim",
    });
    const candidate = path.join(root, "candidate");
    const authorityRoot = path.join(root, "authority");
    await mkdir(candidate);
    await materializeAuthority(authorityRoot);
    const container = new VerificationContainer(config);
    const result = await container.run({
      candidatePath: candidate,
      authorityRoot,
      gate,
      control: new RunControl(defaultExecutionPolicy),
    });
    expect(result).toMatchObject({ kind: "command_exit", exitCode: 0 });
    const recorded = await readFile(log, "utf8");
    expect(recorded).toContain("rm --force --volumes " + id);
    expect(recorded).toMatch(
      /volume inspect --format \{\{json \.\}\} launchpad-verifier-completion-[0-9a-f]{64}/,
    );
    expect(recorded).toMatch(/volume rm launchpad-verifier-completion-[0-9a-f]{64}/);
    expect(recorded).not.toMatch(/rm --force launchpad-/);
    expect(recorded).toContain("cp - " + id + ":/run/launchpad-result");
    expect(recorded).toContain("start --attach " + id);
    expect(recorded).toContain("cp " + id + ":/run/launchpad-result/completion.json");
    expect(recorded).not.toContain("start --attach launchpad-verifier-");
    expect(recorded).not.toMatch(/^cp launchpad-verifier-/m);
    expect(recorded).not.toMatch(/^cp - launchpad-verifier-/m);
  });

  it.each([
    { label: "success", gateExitCode: 0, expectedExitCode: 0 },
    { label: "failure", gateExitCode: 7, expectedExitCode: 1 },
  ])("returns the validated in-container command exit for genuine gate $label", async ({ gateExitCode, expectedExitCode }) => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-command-exit-"));
    directories.push(root);
    const fixture = await realVerificationFixture({
      root,
      behavior: { gateExitCode, runStderr: gateExitCode === 0 ? "" : "candidate tests failed\n" },
    });

    const result = await fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control: new RunControl(defaultExecutionPolicy),
    });

    expect(result).toMatchObject({ kind: "command_exit", exitCode: expectedExitCode });
  });

  it.each([
    {
      label: "bare reserved success without an origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "missing" },
    },
    {
      label: "bare reserved failure without an origin artifact",
      behavior: { engineExitCode: 201, completionArtifact: "missing" },
    },
    {
      label: "malformed artifact",
      behavior: { engineExitCode: 200, completionArtifact: "malformed" },
    },
    {
      label: "artifact with a missing field",
      behavior: { engineExitCode: 200, completionArtifact: "missing_field" },
    },
    {
      label: "artifact with an extra field",
      behavior: { engineExitCode: 200, completionArtifact: "extra_field" },
    },
    {
      label: "wrong artifact schema version",
      behavior: { engineExitCode: 200, completionArtifact: "wrong_version" },
    },
    {
      label: "wrong artifact nonce",
      behavior: { engineExitCode: 200, completionArtifact: "wrong_nonce" },
    },
    {
      label: "artifact and reserved exit disagreement",
      behavior: { engineExitCode: 200, completionArtifact: "wrong_exit" },
    },
    {
      label: "artifact with a non-reserved gate exit",
      behavior: { engineExitCode: 200, completionArtifact: "invalid_exit" },
    },
    {
      label: "artifact with writable mode",
      behavior: { engineExitCode: 200, completionArtifact: "wrong_mode" },
    },
    {
      label: "symlink artifact",
      behavior: { engineExitCode: 200, completionArtifact: "symlink" },
    },
    {
      label: "artifact with trailing bytes",
      behavior: { engineExitCode: 200, completionArtifact: "trailing" },
    },
    {
      label: "unconsumed nonce request",
      behavior: { engineExitCode: 200, completionArtifact: "request_retained" },
    },
    {
      label: "retained temporary publication state",
      behavior: { engineExitCode: 200, completionArtifact: "temp_retained" },
    },
  ] as const)("returns authority failure for $label", async ({ behavior }) => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-origin-proof-"));
    directories.push(root);
    const fixture = await realVerificationFixture({ root, behavior });

    const result = await fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control: new RunControl(defaultExecutionPolicy),
    });

    expect(result).toMatchObject({ kind: "authority_failure" });
  });

  it.each([
    { label: "delayed create", ignoresTermination: false },
    { label: "termination-ignoring create", ignoresTermination: true },
  ])("bounds a cancelled $label and persists exact absence-unproven reconciliation", async ({ ignoresTermination }) => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-cancel-create-"));
    directories.push(root);
    const createReady = path.join(root, "create-ready");
    const createPid = path.join(root, "create-pid");
    const createOverlap = path.join(root, "create-overlap");
    const log = path.join(root, "commands.log");
    const id = (ignoresTermination ? "b" : "a").repeat(64);
    const fixture = await realVerificationFixture({
      root,
      behavior: {
        createDelaySeconds: 0.6,
        createIgnoresTermination: ignoresTermination,
        createOverlapMarker: createOverlap,
        createPid,
        createReady,
        log,
        runCid: id,
      },
    });
    const control = new RunControl(defaultExecutionPolicy);
    const processKill = vi.spyOn(process, "kill");
    const captured = fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await expect.poll(
      async () => access(createReady).then(() => true).catch(() => false),
      { timeout: 5_000 },
    ).toBe(true);
    const cancelledAt = Date.now();
    const terminal = control.stop("user_cancelled", "cancelled during create");
    const thrown = await captured;
    const elapsedAfterCancellation = Date.now() - cancelledAt;
    const pid = Number((await readFile(createPid, "utf8")).trim());
    let processAliveAtReturn = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") processAliveAtReturn = false;
      else throw error;
    }
    const createGroupSignals = processKill.mock.calls.filter(([target, signal]) =>
      target === -pid && (signal === "SIGTERM" || signal === "SIGKILL")
    );
    processKill.mockRestore();
    const records = await readVerificationReconciliationRecords(fixture.config.dataDirectory);
    const recorded = await readFile(log, "utf8");

    expect(thrown).toBe(terminal);
    expect(thrown).toMatchObject({ cause: { code: "verification_container_absence_unproven" } });
    if (process.platform !== "win32") {
      expect(createGroupSignals.filter(([, signal]) => signal === "SIGTERM")).toHaveLength(1);
      expect(createGroupSignals.filter(([, signal]) => signal === "SIGKILL")).toHaveLength(
        ignoresTermination ? 1 : 0,
      );
    }
    expect(elapsedAfterCancellation).toBeLessThan(1_500);
    expect(processAliveAtReturn).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      schemaVersion: 2,
      revision: expect.any(Number),
      ownerToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      containerId: null,
      state: "container_create_pending",
    });
    const ownerId = (records[0] as { ownerId: string }).ownerId;
    expect(records[0]).toMatchObject({
      containerName: "launchpad-verifier-" + ownerId,
      volumeName: "launchpad-verifier-completion-" + ownerId,
    });
    expect(recorded).not.toContain("rm --force --volumes " + id);
    expect(recorded).not.toContain("cp - ");
    expect(recorded).not.toContain("start --attach");
    await expect(access(createOverlap)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists absence-unproven when the create transport exits before the daemon commits, then reconciles the exact late owner after restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-cancel-daemon-create-"));
    directories.push(root);
    const createReady = path.join(root, "create-ready");
    const createCommitted = path.join(root, "create-committed");
    const createPid = path.join(root, "create-pid");
    const log = path.join(root, "commands.log");
    const id = "d".repeat(64);
    const fixture = await realVerificationFixture({
      root,
      behavior: {
        createCommitMarker: createCommitted,
        createDaemonDelayMs: 400,
        createPid,
        createReady,
        createTransportExitsBeforeDaemonCommit: true,
        log,
        runCid: id,
      },
    });
    const startedAt = Date.now();
    const captured = fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control: new RunControl(defaultExecutionPolicy),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await expect.poll(
      async () => access(createReady).then(() => true).catch(() => false),
      { timeout: 5_000 },
    ).toBe(true);

    const thrown = await captured;
    const elapsedMs = Date.now() - startedAt;
    const pid = Number((await readFile(createPid, "utf8")).trim());
    let processAliveAtReturn = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") processAliveAtReturn = false;
      else throw error;
    }
    const recordsBeforeCommit = await readVerificationReconciliationRecords(fixture.config.dataDirectory);
    expect(thrown).toMatchObject({ code: "verification_container_absence_unproven" });
    expect(elapsedMs).toBeLessThan(4_000);
    expect(processAliveAtReturn).toBe(false);
    expect(recordsBeforeCommit).toHaveLength(1);
    expect(recordsBeforeCommit[0]).toMatchObject({
      schemaVersion: 2,
      revision: expect.any(Number),
      ownerToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      containerName: expect.stringMatching(/^launchpad-verifier-[0-9a-f]{64}$/),
      containerId: null,
      volumeName: expect.stringMatching(/^launchpad-verifier-completion-[0-9a-f]{64}$/),
      state: "container_create_pending",
    });
    const recordedBeforeCommit = await readFile(log, "utf8");
    expect(recordedBeforeCommit).not.toContain("start --attach");
    expect(recordedBeforeCommit).not.toContain("rm --force --volumes " + id);

    await expect.poll(
      async () => access(createCommitted).then(() => true).catch(() => false),
      { timeout: 5_000 },
    ).toBe(true);
    const restarted = new VerificationContainer(fixture.config) as VerificationContainer & {
      reconcilePending(): Promise<{ pending: number; removed: number }>;
    };
    expect(restarted.reconcilePending).toBeTypeOf("function");
    const reconciliation = await restarted.reconcilePending();
    const recordsAfterReconciliation = await readVerificationReconciliationRecords(
      fixture.config.dataDirectory,
    );
    const recorded = await readFile(log, "utf8");

    expect(reconciliation).toEqual({ pending: 0, removed: 1 });
    expect(recordsAfterReconciliation).toEqual([]);
    expect(recorded).toContain("rm --force --volumes " + id);
    expect(recorded).toMatch(/volume rm launchpad-verifier-completion-[0-9a-f]{64}/);
    await expect(access(path.join(root, "removed"))).resolves.toBeUndefined();
  });

  it("returns a bounded absence-unproven outcome when the create client and daemon never settle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-hung-create-"));
    directories.push(root);
    const createPid = path.join(root, "create-pid");
    const createReady = path.join(root, "create-ready");
    const log = path.join(root, "commands.log");
    const fixture = await realVerificationFixture({
      root,
      behavior: {
        createIgnoresTermination: true,
        createNeverSettles: true,
        createPid,
        createReady,
        log,
      },
      config: { VERIFIER_CONTAINER_TIMEOUT_MS: "5000" },
    });
    const running = fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control: new RunControl(defaultExecutionPolicy),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await expect.poll(
      async () => access(createReady).then(() => true).catch(() => false),
      { timeout: 15_000 },
    ).toBe(true);
    const startedAt = Date.now();
    const bounded = await Promise.race([
      running.then((value) => ({ kind: "settled" as const, value })),
      new Promise<{ kind: "still_running" }>((resolve) => {
        const timer = setTimeout(() => resolve({ kind: "still_running" }), 7_000);
        timer.unref();
      }),
    ]);
    if (bounded.kind === "still_running") {
      const pid = Number((await readFile(createPid, "utf8")).trim());
      try {
        process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await running;
    }
    const elapsedMs = Date.now() - startedAt;
    const records = await readVerificationReconciliationRecords(fixture.config.dataDirectory);
    const recorded = await readFile(log, "utf8");

    expect(bounded).toMatchObject({
      kind: "settled",
      value: { code: "verification_container_absence_unproven" },
    });
    expect(elapsedMs).toBeLessThan(7_000);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ state: "container_create_pending", containerId: null });
    expect(recorded).not.toContain("start --attach");
  }, 30_000);

  it("retains reconciliation and never removes a late container owned by someone else", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-reconcile-owner-"));
    directories.push(root);
    const createCommitted = path.join(root, "create-committed");
    const log = path.join(root, "commands.log");
    const fixture = await realVerificationFixture({
      root,
      behavior: {
        createCommitMarker: createCommitted,
        createDaemonDelayMs: 200,
        createTransportExitsBeforeDaemonCommit: true,
        inspectOwnerId: "someone-else",
        log,
        runCid: "9".repeat(64),
      },
    });
    const initial = await fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control: new RunControl(defaultExecutionPolicy),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(initial).toMatchObject({ code: "verification_container_absence_unproven" });
    await expect.poll(
      async () => access(createCommitted).then(() => true).catch(() => false),
      { timeout: 5_000 },
    ).toBe(true);

    const restarted = new VerificationContainer(fixture.config) as VerificationContainer & {
      reconcilePending(): Promise<{ pending: number; removed: number }>;
    };
    expect(restarted.reconcilePending).toBeTypeOf("function");
    const reconciliation = await restarted.reconcilePending();
    const records = await readVerificationReconciliationRecords(fixture.config.dataDirectory);
    const recorded = await readFile(log, "utf8");

    expect(reconciliation).toEqual({ pending: 1, removed: 0 });
    expect(records).toHaveLength(1);
    expect(recorded).not.toContain("rm --force --volumes " + "9".repeat(64));
    expect(recorded).not.toMatch(/volume rm launchpad-verifier-completion-/);
  });

  it("cancels the SIGKILL escalation on exit before delayed stdio close permits process-group reuse", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-term-settlement-"));
    directories.push(root);
    const runReady = path.join(root, "run-ready");
    const runPid = path.join(root, "run-pid");
    const fixture = await realVerificationFixture({
      root,
      behavior: {
        runDelaySeconds: 2,
        runExitBeforeCloseDelayMs: 250,
        runPid,
        runReady,
      },
    });
    const control = new RunControl(defaultExecutionPolicy);
    const processKill = vi.spyOn(process, "kill");
    const captured = fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await expect.poll(
      async () => access(runReady).then(() => true).catch(() => false),
      { timeout: 5_000 },
    ).toBe(true);
    const pid = Number((await readFile(runPid, "utf8")).trim());
    const terminal = control.stop("user_cancelled", "cancelled during a TERM-responsive gate");
    const thrown = await captured;
    const groupSignals = processKill.mock.calls.filter(([target]) => target === -pid);
    processKill.mockRestore();

    expect(thrown).toBe(terminal);
    if (process.platform !== "win32") {
      expect(groupSignals.filter(([, signal]) => signal === "SIGTERM")).toHaveLength(1);
      expect(groupSignals.filter(([, signal]) => signal === "SIGKILL")).toHaveLength(0);
    }
  });

  it("coalesces repeated termination requests into one joined TERM-to-KILL escalation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-repeated-termination-"));
    directories.push(root);
    const runReady = path.join(root, "run-ready");
    const runPid = path.join(root, "run-pid");
    const runOutputRelease = path.join(root, "run-output-release");
    const fixture = await realVerificationFixture({
      root,
      behavior: {
        runIgnoresTermination: true,
        runOutputRelease,
        runPid,
        runReady,
        runStdout: "x".repeat(16_384),
      },
      config: { VERIFIER_CONTAINER_MAX_OUTPUT_BYTES: "8192" },
    });
    const control = new RunControl(defaultExecutionPolicy);
    const processKill = vi.spyOn(process, "kill");
    const captured = fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await expect.poll(
      async () => access(runReady).then(() => true).catch(() => false),
      { timeout: 5_000 },
    ).toBe(true);
    const pid = Number((await readFile(runPid, "utf8")).trim());
    const terminal = control.stop("user_cancelled", "cancelled before output exhaustion");
    await writeFile(runOutputRelease, "release\n", "utf8");
    const thrown = await captured;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const groupSignals = processKill.mock.calls.filter(([target]) => target === -pid);
    processKill.mockRestore();

    expect(thrown).toBe(terminal);
    if (process.platform !== "win32") {
      expect(groupSignals.filter(([, signal]) => signal === "SIGTERM")).toHaveLength(1);
      expect(groupSignals.filter(([, signal]) => signal === "SIGKILL")).toHaveLength(1);
    }
  });

  it("joins a create that committed its cid at the cancellation boundary before exact cleanup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-cancel-committed-create-"));
    directories.push(root);
    const createReady = path.join(root, "create-committed");
    const createPid = path.join(root, "create-pid");
    const createOverlap = path.join(root, "create-overlap");
    const log = path.join(root, "commands.log");
    const id = "a".repeat(64);
    const fixture = await realVerificationFixture({
      root,
      behavior: {
        createCommittedReady: createReady,
        createHoldAfterSuccessSeconds: 0.6,
        createOverlapMarker: createOverlap,
        createPid,
        log,
        runCid: id,
      },
    });
    const control = new RunControl(defaultExecutionPolicy);
    const captured = fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await expect.poll(
      async () => access(createReady).then(() => true).catch(() => false),
      { timeout: 5_000 },
    ).toBe(true);
    const terminal = control.stop("user_cancelled", "cancelled after create committed");
    const thrown = await captured;
    const pid = Number((await readFile(createPid, "utf8")).trim());
    let processAliveAtReturn = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") processAliveAtReturn = false;
      else throw error;
    }
    const recorded = await readFile(log, "utf8");

    expect(thrown).toBe(terminal);
    expect(processAliveAtReturn).toBe(false);
    expect(recorded).toContain("rm --force --volumes " + id);
    expect(recorded).not.toContain("cp - ");
    expect(recorded).not.toContain("start --attach");
    await expect(access(path.join(root, "removed"))).resolves.toBeUndefined();
    await expect(access(createOverlap)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    {
      label: "slow ownership resolution before the gate",
      behavior: { inspectDelayAt: "created" as const, inspectDelayOnce: true, inspectDelaySeconds: 10 },
      forbiddenPhase: "cp - ",
      config: { VERIFIER_CONTAINER_TIMEOUT_MS: "8000" },
      maxElapsedMs: 18_000,
    },
    {
      label: "oversized ownership resolution before the gate",
      behavior: { inspectOutputAt: "created" as const, inspectOutputBytes: 16_384, inspectOutputOnce: true },
      forbiddenPhase: "cp - ",
      config: { VERIFIER_CONTAINER_MAX_OUTPUT_BYTES: "8192" },
      maxElapsedMs: undefined,
    },
    {
      label: "slow stopped-state inspection after the gate",
      behavior: { inspectDelayAt: "exited" as const, inspectDelayOnce: true, inspectDelaySeconds: 10 },
      forbiddenPhase: ":/run/launchpad-result/completion.json",
      config: { VERIFIER_CONTAINER_TIMEOUT_MS: "8000" },
      maxElapsedMs: 18_000,
    },
    {
      label: "oversized stopped-state inspection after the gate",
      behavior: { inspectOutputAt: "exited" as const, inspectOutputBytes: 16_384, inspectOutputOnce: true },
      forbiddenPhase: ":/run/launchpad-result/completion.json",
      config: { VERIFIER_CONTAINER_MAX_OUTPUT_BYTES: "8192" },
      maxElapsedMs: undefined,
    },
  ])("shares deadline/output authority with $label", async ({ behavior, config, forbiddenPhase, maxElapsedMs }) => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-shared-budget-"));
    directories.push(root);
    const log = path.join(root, "commands.log");
    const fixture = await realVerificationFixture({ root, behavior: { ...behavior, log }, config });

    const startedAt = Date.now();
    const result = await fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control: new RunControl(defaultExecutionPolicy),
    });
    const elapsedMs = Date.now() - startedAt;
    const recorded = await readFile(log, "utf8");

    expect(result).toMatchObject({ kind: "authority_failure" });
    expect(recorded).not.toContain(forbiddenPhase);
    expect(recorded).toMatch(/rm --force --volumes [0-9a-f]{64}/);
    await expect(access(path.join(root, "removed"))).resolves.toBeUndefined();
    if (maxElapsedMs !== undefined) expect(elapsedMs).toBeLessThan(maxElapsedMs);
  });

  it("cannot accept a valid artifact after the shared work deadline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-post-artifact-deadline-"));
    directories.push(root);
    const artifactReady = path.join(root, "artifact-ready");
    const artifactRelease = path.join(root, "artifact-release");
    const fixture = await realVerificationFixture({
      root,
      behavior: { artifactCopyReady: artifactReady, artifactCopyRelease: artifactRelease },
      config: { VERIFIER_CONTAINER_TIMEOUT_MS: "4000" },
    });
    const running = fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control: new RunControl(defaultExecutionPolicy),
    });
    await expect.poll(
      async () => access(artifactReady).then(() => true).catch(() => false),
      { timeout: 5_000 },
    ).toBe(true);
    const originalNow = Date.now;
    const shiftedNow = originalNow() + 3_500;
    let result;
    try {
      Date.now = () => shiftedNow;
      await writeFile(artifactRelease, "release\n", "utf8");
      result = await running;
    } finally {
      Date.now = originalNow;
    }

    expect(result).toMatchObject({ kind: "authority_failure" });
    await expect(access(path.join(root, "removed"))).resolves.toBeUndefined();
  });

  it("returns authority failure when final cleanup crosses the verifier lifecycle deadline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-final-deadline-"));
    directories.push(root);
    const finalCleanupReady = path.join(root, "final-cleanup-ready");
    const finalCleanupRelease = path.join(root, "final-cleanup-release");
    const fixture = await realVerificationFixture({
      root,
      behavior: {
        volumeInspectReady: finalCleanupReady,
        volumeInspectReadyAttempt: 1,
        volumeInspectRelease: finalCleanupRelease,
      },
      config: { VERIFIER_CONTAINER_TIMEOUT_MS: "4000" },
    });
    const control = new RunControl(defaultExecutionPolicy);
    const running = fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control,
    });
    await expect.poll(
      async () => access(finalCleanupReady).then(() => true).catch(() => false),
      { timeout: 5_000 },
    ).toBe(true);
    const originalNow = Date.now;
    const shiftedNow = originalNow() + 4_500;
    let result;
    try {
      Date.now = () => shiftedNow;
      await writeFile(finalCleanupRelease, "release\n", "utf8");
      result = await running;
    } finally {
      Date.now = originalNow;
    }

    expect(result).toMatchObject({ kind: "authority_failure" });
    await expect(readdir(path.join(fixture.config.dataDirectory, "container-authority"))).resolves.toEqual([
      "verification-reconciliation",
    ]);
  });

  it("keeps the current terminal authoritative when cleanup simultaneously crosses the lifecycle deadline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-final-deadline-terminal-"));
    directories.push(root);
    const finalCleanupReady = path.join(root, "final-cleanup-ready");
    const finalCleanupRelease = path.join(root, "final-cleanup-release");
    const fixture = await realVerificationFixture({
      root,
      behavior: {
        volumeInspectReady: finalCleanupReady,
        volumeInspectReadyAttempt: 1,
        volumeInspectRelease: finalCleanupRelease,
      },
      config: { VERIFIER_CONTAINER_TIMEOUT_MS: "4000" },
    });
    const control = new RunControl(defaultExecutionPolicy);
    const captured = fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await expect.poll(
      async () => access(finalCleanupReady).then(() => true).catch(() => false),
      { timeout: 5_000 },
    ).toBe(true);
    const originalNow = Date.now;
    const shiftedNow = originalNow() + 4_500;
    let terminal;
    let thrown;
    try {
      Date.now = () => shiftedNow;
      terminal = control.stop("user_cancelled", "cancelled at the final deadline boundary");
      await writeFile(finalCleanupRelease, "release\n", "utf8");
      thrown = await captured;
    } finally {
      Date.now = originalNow;
    }

    expect(thrown).toBe(terminal);
    expect(thrown).toMatchObject({ cause: { code: "verification_container_deadline_exceeded" } });
    await expect(readdir(path.join(fixture.config.dataDirectory, "container-authority"))).resolves.toEqual([
      "verification-reconciliation",
    ]);
  });

  it.each([
    { label: "request copy failure", behavior: { requestCopyFails: true } },
    { label: "created-state ownership inspection failure", behavior: { inspectFailsOnceAt: "created" as const } },
    { label: "start/attach failure", behavior: { startFails: true } },
    { label: "stopped-state ownership inspection failure", behavior: { inspectFailsOnceAt: "exited" as const } },
    { label: "artifact copy failure", behavior: { artifactCopyFails: true } },
    { label: "completion volume with the wrong type", behavior: { completionMountMutation: "wrong_type" as const } },
    { label: "read-only completion volume", behavior: { completionMountMutation: "read_only" as const } },
    { label: "completion volume with an invalid name", behavior: { completionMountMutation: "invalid_name" as const } },
    { label: "completion volume identity changed after start", behavior: { completionMountMutation: "changed_after_start" as const } },
  ])("returns authority failure for $label", async ({ behavior }) => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-lifecycle-authority-"));
    directories.push(root);
    const fixture = await realVerificationFixture({ root, behavior });

    const result = await fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control: new RunControl(defaultExecutionPolicy),
    });

    expect(result).toMatchObject({ kind: "authority_failure" });
  });

  it.each([
    {
      label: "numeric engine or daemon failure",
      behavior: { engineExitCode: 125 },
    },
    {
      label: "unwrapped numeric success",
      behavior: { engineExitCode: 0 },
    },
    {
      label: "wrapper launch or internal failure",
      behavior: { engineExitCode: 202 },
    },
    {
      label: "engine signal with a null exit",
      behavior: { engineSignal: "TERM" as const },
    },
    {
      label: "old forged completion record",
      behavior: {
        engineExitCode: 0,
        runStdout: "\u001e{\"schemaVersion\":1,\"nonce\":\"" + "a".repeat(64) + "\",\"exitCode\":0}\n",
      },
    },
    {
      label: "malformed and trailing completion state",
      behavior: { engineExitCode: 0, runStdout: "\u001e{not-json}\ntrailing-bytes" },
    },
  ])("returns authority failure for $label", async ({ behavior }) => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-reserved-exit-"));
    directories.push(root);
    const fixture = await realVerificationFixture({ root, behavior });

    const result = await fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control: new RunControl(defaultExecutionPolicy),
    });

    expect(result).toMatchObject({ kind: "authority_failure" });
  });

  it.each([
    {
      label: "outer wall timeout",
      behavior: { runDelaySeconds: 3 },
      config: { VERIFIER_CONTAINER_TIMEOUT_MS: "4000" },
    },
    {
      label: "outer output limit",
      behavior: { runStdout: "x".repeat(2_048) },
      config: { VERIFIER_CONTAINER_MAX_OUTPUT_BYTES: "1024" },
    },
  ])("returns a typed authority outcome for $label", async ({ behavior, config }) => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-resource-"));
    directories.push(root);
    const fixture = await realVerificationFixture({ root, behavior, config });

    const result = await fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control: new RunControl(defaultExecutionPolicy),
    });

    expect(result).toMatchObject({ kind: "authority_failure" });
  });

  it.each([
    { label: "engine spawn", engine: "missing", behavior: undefined },
    { label: "container ownership", engine: undefined, behavior: { inspectOwnerId: "not-the-owner" } },
    { label: "container absence", engine: undefined, behavior: { removeFails: true } },
  ])("throws a typed authority error for $label failure", async ({ engine, behavior }) => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-authority-"));
    directories.push(root);
    const fixture = await realVerificationFixture({
      root,
      engine: engine === "missing" ? path.join(root, "missing-engine") : undefined,
      behavior,
    });

    await expect(fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control: new RunControl(defaultExecutionPolicy),
    })).rejects.toMatchObject({ code: "verification_container_absence_unproven" });
  });

  it("fails closed when final owned-container removal cannot prove absence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-cleanup-"));
    directories.push(root);
    const engine = await fakeVerifierEngine(root, {
      runCid: "e".repeat(64),
      removeFails: true,
    });
    const config = verifierConfig({ APP_DATA_DIR: path.join(root, "data"), CONTAINER_ENGINE: engine });
    const candidate = path.join(root, "candidate");
    const authorityRoot = path.join(root, "authority");
    await mkdir(candidate);
    await materializeAuthority(authorityRoot);
    await expect(
      new VerificationContainer(config).run({
        candidatePath: candidate,
        authorityRoot,
        gate,
        control: new RunControl(defaultExecutionPolicy),
      }),
    ).rejects.toMatchObject({ code: "verification_container_absence_unproven" });
  });

  it("preserves a latched terminal reason when cleanup also cannot prove absence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-terminal-cleanup-"));
    directories.push(root);
    const ready = path.join(root, "run-ready");
    const engine = await fakeVerifierEngine(root, {
      runCid: "f".repeat(64),
      removeFails: true,
      runReady: ready,
      runDelaySeconds: 1,
    });
    const config = verifierConfig({ APP_DATA_DIR: path.join(root, "data"), CONTAINER_ENGINE: engine });
    const candidate = path.join(root, "candidate");
    const authorityRoot = path.join(root, "authority");
    await mkdir(candidate);
    await materializeAuthority(authorityRoot);
    const control = new RunControl(defaultExecutionPolicy);
    const running = new VerificationContainer(config).run({ candidatePath: candidate, authorityRoot, gate, control });
    await expect.poll(
      async () => readFile(ready, "utf8").then(() => true).catch(() => false),
      { timeout: 5_000 },
    ).toBe(true);
    const terminal = control.stop("emergency_token_fuse", "token fuse fired");
    let thrown: unknown;
    try {
      await running;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(terminal);
    expect(thrown).toMatchObject({
      reason: "emergency_token_fuse",
      cause: { code: "verification_container_absence_unproven" },
    });
  });

  it.each([
    { cleanup: "succeeds", removeFails: false },
    { cleanup: "fails", removeFails: true },
  ])("keeps cancellation terminal when final owned-container cleanup $cleanup", async ({ removeFails }) => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-terminal-final-cleanup-"));
    directories.push(root);
    const removeReady = path.join(root, "remove-ready");
    const fixture = await realVerificationFixture({
      root,
      behavior: { removeDelaySeconds: 2, removeFails, removeReady },
    });
    const control = new RunControl(defaultExecutionPolicy);
    const running = fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control,
    });
    const captured = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    await expect.poll(
      async () => readFile(removeReady, "utf8").then(() => true).catch(() => false),
      { timeout: 5_000 },
    ).toBe(true);
    const terminal = control.stop("user_cancelled", "cancelled during final container cleanup");
    const thrown = await captured;

    expect(thrown).toBe(terminal);
    if (removeFails) {
      expect(thrown).toMatchObject({ cause: { code: "verification_container_absence_unproven" } });
    }
  });

  it.each([
    { cleanup: "succeeds", removeFails: false },
    { cleanup: "fails", removeFails: true },
  ])("throws the current higher-priority terminal after cancellation cleanup $cleanup", async ({ removeFails }) => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-terminal-priority-"));
    directories.push(root);
    const runReady = path.join(root, "run-ready");
    const removeReady = path.join(root, "remove-ready");
    const fixture = await realVerificationFixture({
      root,
      behavior: {
        runDelaySeconds: 3,
        runReady,
        firstRemoveFails: true,
        firstRemoveDelaySeconds: 0,
        removeDelaySeconds: 1,
        removeReady,
        removeReadyAttempt: 2,
        removeFails,
      },
    });
    const control = new RunControl(defaultExecutionPolicy);
    const captured = fixture.container.run({
      candidatePath: fixture.workspace,
      authorityRoot: fixture.authorityRoot,
      gate,
      control,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await expect.poll(
      async () => readFile(runReady, "utf8").then(() => true).catch(() => false),
      { timeout: 5_000 },
    ).toBe(true);
    control.stop("root_deadline", "deadline fired before cancellation cleanup");
    await expect.poll(
      async () => readFile(removeReady, "utf8").then(() => true).catch(() => false),
      { timeout: 5_000 },
    ).toBe(true);
    const currentTerminal = control.stop("user_cancelled", "cancelled during cleanup");
    const thrown = await captured;

    expect(thrown).toBe(currentTerminal);
    if (removeFails) {
      expect(thrown).toMatchObject({ cause: { code: "verification_container_absence_unproven" } });
    }
  });

  it("does not pass inherited process credentials into the container engine environment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-env-"));
    directories.push(root);
    const envLog = path.join(root, "env.log");
    const engine = await fakeVerifierEngine(root, { envLog, runCid: "d".repeat(64) });
    const config = verifierConfig({
      APP_DATA_DIR: path.join(root, "data"),
      CONTAINER_ENGINE: engine,
    });
    const previous = process.env.ARK_API_KEY;
    process.env.ARK_API_KEY = "inherited-provider-key";
    process.env.AWS_SECRET_ACCESS_KEY = "inherited-cloud-key";
    try {
      const candidate = path.join(root, "candidate");
      const authorityRoot = path.join(root, "authority");
      await mkdir(candidate);
      await materializeAuthority(authorityRoot);
      await new VerificationContainer(config).run({
        candidatePath: candidate,
        authorityRoot,
        gate,
        control: new RunControl(defaultExecutionPolicy),
      });
    } finally {
      if (previous === undefined) delete process.env.ARK_API_KEY;
      else process.env.ARK_API_KEY = previous;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }
    const env = await readFile(envLog, "utf8");
    expect(env).not.toContain("inherited-provider-key");
    expect(env).not.toContain("inherited-cloud-key");
    expect(env).not.toContain("ARK_API_KEY=");
  });

  containerIt("joins a real attached gate before cancellation cleanup proves container and volume absence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-docker-cancel-"));
    directories.push(root);
    const fixture = await realDockerFixture(
      root,
      "await new Promise((resolve) => setTimeout(resolve, 30_000));\nprocess.exit(0);\n",
    );
    const control = new RunControl(defaultExecutionPolicy);
    const captured = fixture.container.run({
      candidatePath: fixture.candidate,
      authorityRoot: fixture.authorityRoot,
      gate: { ...gate, command: ["node", "/authority/gates/targeted.mjs"] },
      control,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const authorityDirectory = path.join(fixture.dataDirectory, "container-authority");
    let containerId = "";
    await expect.poll(async () => {
      const entries = await readdir(authorityDirectory).catch(() => []);
      const cidFile = entries.find((entry) => entry.endsWith(".cid"));
      if (cidFile === undefined) return false;
      containerId = (await readFile(path.join(authorityDirectory, cidFile), "utf8")).trim();
      return /^[0-9a-f]{64}$/.test(containerId);
    }, { timeout: 30_000 }).toBe(true);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const engine = process.env.CONTAINER_ENGINE ?? "docker";
    await expect.poll(async () => {
      const inspected = await exec(
        engine,
        ["container", "inspect", "--format", "{{json .}}", containerId],
        { timeout: 5_000 },
      ).catch(() => undefined);
      if (inspected === undefined) return false;
      const value = JSON.parse(inspected.stdout) as {
        State?: { Running?: boolean };
      };
      return value.State?.Running === true;
    }, { timeout: 30_000 }).toBe(true);
    const { stdout: inspectedOutput } = await exec(
      engine,
      ["container", "inspect", "--format", "{{json .}}", containerId],
      { timeout: 5_000 },
    );
    const inspected = JSON.parse(inspectedOutput) as {
      Mounts?: { Destination?: unknown; Name?: unknown }[];
    };
    const volumeName = inspected.Mounts?.find(
      (mount) => mount.Destination === "/run/launchpad-result",
    )?.Name;
    expect(volumeName).toMatch(/^launchpad-verifier-completion-[0-9a-f]{64}$/);

    const terminal = control.stop("user_cancelled", "cancelled while the real gate was attached");
    const thrown = await captured;

    expect(thrown).toBe(terminal);
    await expect(exec(
      engine,
      ["container", "inspect", "--format", "{{json .}}", containerId],
      { timeout: 5_000 },
    )).rejects.toBeDefined();
    await expect(exec(
      engine,
      ["volume", "inspect", "--format", "{{json .}}", String(volumeName)],
      { timeout: 5_000 },
    )).rejects.toBeDefined();
    await expect(readdir(authorityDirectory)).resolves.toEqual(["verification-reconciliation"]);
  }, 60_000);

  containerIt("does not trust a leaked nonce, forged record, or late descendant over the reaped gate failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-docker-forgery-"));
    directories.push(root);
    const fixture = await realDockerFixture(root, [
      "import { readFile } from 'node:fs/promises';",
      "import { spawn } from 'node:child_process';",
      "const wrapperPid = process.ppid;",
      "let environ = '';",
      "try { environ = await readFile('/proc/' + wrapperPid + '/environ', 'utf8'); } catch {}",
      "const leaked = environ.match(/(?:^|\\0)LAUNCHPAD_GATE_COMPLETION_NONCE=([0-9a-f]{64})(?:\\0|$)/)?.[1];",
      "const forged = '\\u001e' + JSON.stringify({ schemaVersion: 1, nonce: leaked ?? '0'.repeat(64), exitCode: 0 }) + '\\n';",
      "await new Promise((resolve) => process.stdout.write((leaked ? 'LEAKED_WRAPPER_NONCE\\n' : '') + forged, resolve));",
      "let wroteArtifact = false;",
      "try { await import('node:fs/promises').then(({ writeFile }) => writeFile('/run/launchpad-result/completion.json', forged)); wroteArtifact = true; } catch {}",
      "try { await import('node:fs/promises').then(({ writeFile }) => writeFile('/proc/' + wrapperPid + '/root/run/launchpad-result/completion.json', forged)); wroteArtifact = true; } catch {}",
      "if (wroteArtifact) process.stdout.write('WROTE_COMPLETION_ARTIFACT\\n');",
      "let readRequest = false;",
      "try { await readFile('/proc/' + wrapperPid + '/root/run/launchpad-result/request.json', 'utf8'); readRequest = true; } catch {}",
      "if (readRequest) process.stdout.write('READ_COMPLETION_REQUEST\\n');",
      "const late = spawn(process.execPath, ['-e', \"setTimeout(() => process.stdout.write('LATE_DESCENDANT_SURVIVED\\\\n'), 250)\"], {",
      "  stdio: ['ignore', 'inherit', 'inherit'],",
      "  detached: true,",
      "});",
      "late.unref();",
      "process.exit(7);",
      "",
    ].join("\n"));

    const result = await fixture.container.run({
      candidatePath: fixture.candidate,
      authorityRoot: fixture.authorityRoot,
      gate: { ...gate, command: ["node", "/authority/gates/targeted.mjs"] },
      control: new RunControl(defaultExecutionPolicy),
    });

    expect(Buffer.from(result.stdout).toString("utf8")).not.toContain("LEAKED_WRAPPER_NONCE");
    expect(Buffer.from(result.stdout).toString("utf8")).not.toContain("WROTE_COMPLETION_ARTIFACT");
    expect(Buffer.from(result.stdout).toString("utf8")).not.toContain("READ_COMPLETION_REQUEST");
    expect(Buffer.from(result.stdout).toString("utf8")).not.toContain("LATE_DESCENDANT_SURVIVED");
    expect(result).toMatchObject({ kind: "command_exit", exitCode: 1 });
    expect(await readdir(path.join(fixture.dataDirectory, "container-authority"))).toEqual([
      "verification-reconciliation",
    ]);
  }, 60_000);

  containerIt("keeps a gate signal attempt from reaching its root PID 1 wrapper", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-docker-kill-wrapper-"));
    directories.push(root);
    const fixture = await realDockerFixture(root, [
      "let denied = false;",
      "try { process.kill(process.ppid, 'SIGTERM'); } catch (error) { denied = error?.code === 'EPERM'; }",
      "process.exit(denied ? 7 : 0);",
      "",
    ].join("\n"));

    const result = await fixture.container.run({
      candidatePath: fixture.candidate,
      authorityRoot: fixture.authorityRoot,
      gate: { ...gate, command: ["node", "/authority/gates/targeted.mjs"] },
      control: new RunControl(defaultExecutionPolicy),
    });

    expect(result).toMatchObject({ kind: "command_exit", exitCode: 1 });
  }, 60_000);

  containerIt("does not let a gate spoof wrapper success with the reserved success exit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-docker-reserved-spoof-"));
    directories.push(root);
    const fixture = await realDockerFixture(root, "process.exit(200);\n");

    const result = await fixture.container.run({
      candidatePath: fixture.candidate,
      authorityRoot: fixture.authorityRoot,
      gate: { ...gate, command: ["node", "/authority/gates/targeted.mjs"] },
      control: new RunControl(defaultExecutionPolicy),
    });

    expect(result).toMatchObject({ kind: "command_exit", exitCode: 1 });
  }, 60_000);

  containerIt("treats an in-container gate spawn failure as authority failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-docker-spawn-failure-"));
    directories.push(root);
    const fixture = await realDockerFixture(root, "process.exit(0);\n");

    const result = await fixture.container.run({
      candidatePath: fixture.candidate,
      authorityRoot: fixture.authorityRoot,
      gate: { ...gate, command: ["/missing-verifier-interpreter", "/authority/gates/targeted.mjs"] },
      control: new RunControl(defaultExecutionPolicy),
    });

    expect(result).toMatchObject({ kind: "authority_failure" });
  }, 60_000);

  containerIt("proves a real gate can read candidate code, write scratch, and cannot write mounts or reach the network", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-docker-"));
    directories.push(root);
    const candidate = path.join(root, "candidate");
    const authorityRoot = path.join(root, "authority");
    await mkdir(candidate, { recursive: true, mode: 0o755 });
    await writeFile(path.join(candidate, "hello.txt"), "from-candidate\n", { mode: 0o644 });
    const profilePath = await materializeAuthority(authorityRoot);
    await writeFile(
      path.join(authorityRoot, "gates", "targeted.mjs"),
      [
        "import { readFile, readdir, readlink, writeFile } from 'node:fs/promises';",
        "import net from 'node:net';",
        "import path from 'node:path';",
        "const candidate = process.env.CANDIDATE;",
        "const scratch = process.env.SCRATCH;",
        "const ownStatus = await readFile('/proc/self/status', 'utf8');",
        "const wrapperStatus = await readFile('/proc/' + process.ppid + '/status', 'utf8');",
        "const statusValue = (source, name) => source.match(new RegExp('^' + name + ':\\\\s+([^\\\\n]+)$', 'm'))?.[1]?.trim();",
        "const zeroCaps = ['CapInh', 'CapPrm', 'CapEff', 'CapAmb'].every((name) => statusValue(ownStatus, name) === '0000000000000000');",
        "const noNewPrivileges = statusValue(ownStatus, 'NoNewPrivs') === '1';",
        "const wrapperIsRoot = statusValue(wrapperStatus, 'Uid')?.split(/\\s+/).every((value) => value === '0');",
        "let regainedUid = false;",
        "try { process.setuid(0); regainedUid = process.getuid() === 0; } catch {}",
        "let regainedGid = false;",
        "try { process.setgid(0); regainedGid = process.getgid() === 0; } catch {}",
        "let regainedGroups = false;",
        "try { process.setgroups([0]); regainedGroups = process.getgroups().includes(0); } catch {}",
        "let resultDirectoryReadable = false;",
        "try { await readdir('/run/launchpad-result'); resultDirectoryReadable = true; } catch {}",
        "const resultFdInherited = (await Promise.all((await readdir('/proc/self/fd')).map(async (fd) => readlink('/proc/self/fd/' + fd).catch(() => '')))).some((target) => target.includes('/run/launchpad-result'));",
        "await readFile(path.join(candidate, 'hello.txt'), 'utf8');",
        "await writeFile(path.join(scratch, 'out.txt'), 'scratch-ok');",
        "let wroteCandidate = false;",
        "try { await writeFile(path.join(candidate, 'pwned.txt'), 'no'); wroteCandidate = true; } catch {}",
        "let wroteAuthority = false;",
        "try { await writeFile(path.join('/authority', 'pwned.txt'), 'no'); wroteAuthority = true; } catch {}",
        "const networked = await new Promise((resolve) => {",
        "  const socket = net.connect({ host: '1.1.1.1', port: 80 }, () => { socket.destroy(); resolve(true); });",
        "  socket.setTimeout(1500);",
        "  socket.on('error', () => resolve(false));",
        "  socket.on('timeout', () => { socket.destroy(); resolve(false); });",
        "});",
        "if (process.getuid() !== 65534 || process.getgid() !== 65534 || process.getgroups().includes(0)) process.exit(2);",
        "if (!wrapperIsRoot || !zeroCaps || !noNewPrivileges || regainedUid || regainedGid || regainedGroups) process.exit(3);",
        "if (resultDirectoryReadable || resultFdInherited || Object.keys(process.env).some((name) => /COMPLETION|RESULT_NONCE/.test(name))) process.exit(4);",
        "if (wroteCandidate || wroteAuthority || networked) process.exit(5);",
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o644 },
    );
    void profilePath;
    const engine = process.env.CONTAINER_ENGINE ?? "docker";
    const image = process.env.VERIFIER_CONTAINER_IMAGE ?? "node:22-bookworm-slim";
    const config = verifierConfig({
      APP_DATA_DIR: path.join(root, "data"),
      CONTAINER_ENGINE: engine,
      VERIFIER_CONTAINER_IMAGE: image,
      VERIFIER_CONTAINER_USER: "65534:65534",
    });
    const container = new VerificationContainer(config);
    const result = await container.run({
      candidatePath: candidate,
      authorityRoot,
      gate: { ...gate, command: ["node", "/authority/gates/targeted.mjs"] },
      control: new RunControl(defaultExecutionPolicy),
    });
    expect(result).toMatchObject({ kind: "command_exit", exitCode: 0 });
    await expect(readFile(path.join(candidate, "pwned.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(path.join(authorityRoot, "pwned.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const { stdout } = await exec(engine, ["ps", "-aq", "--filter", "label=io.codejam.launchpad=verifier"], {
      timeout: 8_000,
    }).catch(() => ({ stdout: "" }));
    expect(String(stdout).trim()).toBe("");
  }, 60_000);
});
