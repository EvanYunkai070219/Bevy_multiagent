/** Covers the authenticated HTTP API, including Run event pagination. */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../src/agent-service.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { HttpError } from "../src/errors.js";
import { EventLog } from "../src/event-log.js";
import { GitClient } from "../src/git-client.js";
import { JsonStore } from "../src/store.js";
import { ProjectRegistry } from "../src/project-registry.js";
import { ProjectRepositoryManager } from "../src/project-repository-manager.js";
import { ProjectRunManager } from "../src/project-run-manager.js";
import { WorkspaceManager } from "../src/workspace.js";
import type { OrchestratorParts } from "../src/orchestration/orchestrator.js";
import type { AgentRunner } from "../src/types.js";
import type { ModelCredentialIssuer } from "../src/model-proxy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function failFastDoubles() {
  const calls = { planner: 0, runner: 0, model: 0 };
  const runner: AgentRunner = {
    run: async () => {
      calls.runner += 1;
      throw new Error("runner must not be admitted");
    },
    cancel: async () => false,
    isAvailable: async () => true,
  };
  const parts = {
    planner: {
      plan: async () => {
        calls.planner += 1;
        throw new Error("planner must not be admitted");
      },
    },
    evaluator: { evaluate: async () => { throw new Error("evaluator must not be admitted"); } },
    replanner: { replan: async () => { throw new Error("replanner must not be admitted"); } },
    synthesizer: { synthesize: async () => { throw new Error("synthesizer must not be admitted"); } },
  } as unknown as OrchestratorParts;
  const modelProxy: ModelCredentialIssuer = {
    issue: () => {
      calls.model += 1;
      throw new Error("model must not be admitted");
    },
    revoke: () => undefined,
    terminalError: () => undefined,
  };
  return { calls, runner, parts, modelProxy };
}

async function makeRealService(
  runner: AgentRunner = {
    run: async () => ({ output: "unused", threadId: null, usage: null }),
    cancel: async () => false,
    isAvailable: async () => true,
  },
  extras: { parts?: OrchestratorParts; modelProxy?: ModelCredentialIssuer } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "app-events-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    WORKSPACE_SOURCE_ROOTS: root,
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    CODEX_RUNTIME_MODE: "exec",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const git = new GitClient(5_000);
  const projectRegistry = new ProjectRegistry(
    store,
    new ProjectRepositoryManager(config.workspaceRoot, config.workspaceSourceRoots, git),
    git,
  );
  const realService = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    new EventLog(path.join(root, "data", "events")),
    extras.parts,
    extras.modelProxy,
    undefined,
    new ProjectRunManager(path.join(root, "project-runs"), [root], git),
    {},
    projectRegistry,
    git,
  );
  await realService.initialize();
  return { config, service: realService, store, root, git };
}

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
  getRunEvents: async (runId: string, after: number, limit?: number) => ({
    events: [
      {
        seq: after + 1,
        runId,
        agentId: "agent-1",
        spanId: "span-1",
        parentSpanId: "run",
        kind: "command",
        name: "bash",
        status: "ok",
        startedAt: "2026-08-26T00:00:00.000Z",
        endedAt: "2026-08-26T00:00:01.000Z",
        durationMs: 1000,
        input: { command: "ls" },
        output: { exitCode: 0 },
        error: null,
        attributes: { itemType: "command_execution" },
        usage: null,
      },
    ],
    lastSeq: after + 1,
    complete: true,
    limit,
  }),
} as unknown as AgentService;

const RUN_ID = "11111111-1111-4111-8111-111111111111";

describe("HTTP boundary", () => {
  it("adds evolution only on an explicit bounded run query", async () => {
    const calls: unknown[] = [];
    const boundaryService = {
      listAgents: () => [],
      getRun: () => ({ id: RUN_ID }),
      getEvolution: async (input: unknown) => {
        calls.push(input);
        return {
          syncState: "synced",
          primaryFault: null,
          warningLevel: null,
          terminalReason: null,
          runBranch: null,
          baseCommit: null,
          headCommit: null,
          counts: {
            declared: 0, prunedDuplicate: 0, admitted: 0, executed: 0,
            verified: 0, promoted: 0, rolledBack: 0, historicalEvidenceUsed: 0,
          },
          nodes: [], edges: [], observations: [], cues: [], transfers: [], quarantines: [],
          nextCursor: null,
        };
      },
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), boundaryService);

    const ordinary = await app.inject({ method: "GET", url: `/api/runs/${RUN_ID}` });
    expect(ordinary.json()).toEqual({ run: { id: RUN_ID } });
    expect(calls).toHaveLength(0);

    const included = await app.inject({
      method: "GET",
      url: `/api/runs/${RUN_ID}?includeEvolution=true&evolutionLimit=100&evolutionDepth=3`,
    });
    expect(included.statusCode).toBe(200);
    expect(included.json()).toHaveProperty("evolution.syncState", "synced");
    expect(calls).toEqual([{ runId: RUN_ID, after: null, limit: 100, depth: 3 }]);

    const invalid = await app.inject({
      method: "GET",
      url: `/api/runs/${RUN_ID}?includeEvolution=true&evolutionLimit=201`,
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("recursively removes internal authority and terminal publication intent from every public payload", async () => {
    const secret = "fixture-owner-secret-never-public";
    const eventHash = "a".repeat(64);
    const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const boundaryService = {
      listAgents: () => [],
      listProjects: () => [
        {
          id: PROJECT_ID,
          displayName: "Secret Project",
          repositoryPath: "/tmp/project",
          gitCommonDev: 1,
          gitCommonIno: 2,
          repositoryRealPath: "/private/tmp/project",
          gitCommonRealPath: "/private/tmp/project/.git",
          baselineTransition: {
            runId: RUN_ID,
            expectedCommit: "a".repeat(40),
            nextCommit: "b".repeat(40),
            state: "prepared",
          },
        },
      ],
      getRun: () => ({
        id: RUN_ID,
        project: {
          attempts: [{ attemptId: "a1", revision: 1, ownerToken: secret }],
          nested: { ownerToken: secret },
          canonicalAuthority: { workspaceDev: 9, workspaceIno: 8 },
        },
        terminalPublicationIntent: { eventHash, output: "internal-only" },
      }),
      getRunEvents: async () => ({
        events: [{ attributes: {
          ownerToken: secret,
          terminalPublicationIntent: { eventHash },
          safe: "visible",
        } }],
        lastSeq: 1,
        complete: true,
      }),
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), boundaryService);

    for (const url of [`/api/runs/${RUN_ID}`, `/api/runs/${RUN_ID}/events`, "/api/projects"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("ownerToken");
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain("terminalPublicationIntent");
      expect(response.body).not.toContain(eventHash);
      expect(response.body).not.toContain("baselineTransition");
      expect(response.body).not.toContain("gitCommonDev");
      expect(response.body).not.toContain("gitCommonIno");
      expect(response.body).not.toContain("canonicalAuthority");
      expect(response.body).not.toContain("repositoryRealPath");
      expect(response.body).not.toContain("gitCommonRealPath");
    }
    await app.close();
  });

  it("strips healing authority paths, raw commands, and terminal-latch fields from the run endpoint", async () => {
    const AUTHORITY_ROOT = "/var/launchpad/authority-root";
    const secret = "fixture-owner-secret-never-public";
    const boundaryService = {
      listAgents: () => [],
      getRun: () => ({
        id: RUN_ID,
        orchestration: {
          healing: {
            verifications: [
              {
                id: "ver-1",
                subjectType: "candidate",
                subjectId: "cand-1",
                stage: "finalist",
                authorityManifestHash: "m".repeat(64),
                gates: [
                  {
                    gateId: "backend-targeted",
                    tier: "targeted",
                    passed: true,
                    evidenceRef: "evidence/gate-1.json",
                    failureFingerprint: null,
                  },
                ],
                failureKind: null,
                mandatoryPassed: true,
                hardProgress: 1,
                regressionCount: 0,
                modelCalls: 2,
                reservedTokens: 400,
                actualInputTokens: 120,
                actualOutputTokens: 80,
                elapsedMs: 1500,
                verifiedAt: "2026-08-29T00:00:03.000Z",
                rawCommand: "python /var/launchpad/authority-root/hidden-test.py",
                authorityAssetPath: AUTHORITY_ROOT + "/manifest.json",
                hiddenTestNames: ["secret_oracle"],
                verificationCommand: "node /var/launchpad/authority-root/secret.js",
                authorityCommand: ["node", "/var/launchpad/authority-root/secret.js"],
                rawEvidence: "fixture secret output",
                credentials: { token: secret },
                modelToken: secret,
              },
            ],
            nodes: [
              {
                subtaskId: "backend",
                revision: 1,
                state: "completed",
                ownerToken: secret,
                latchListeners: ["internal-terminal-latch"],
                terminalLatch: { closed: true },
                workspacePath: AUTHORITY_ROOT + "/candidate",
              },
            ],
            budget: {
              usedModelCalls: 4,
              reservedTokens: 400,
              warningLevel: "advisory",
            },
          },
        },
      }),
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), boundaryService);
    const response = await app.inject({ method: "GET", url: `/api/runs/${RUN_ID}` });
    expect(response.statusCode).toBe(200);
    const publicRun = response.json().run as {
      orchestration: {
        healing: {
          verifications: Record<string, unknown>[];
          nodes: Record<string, unknown>[];
          budget: Record<string, unknown>;
        };
      };
    };
    expect(publicRun.orchestration.healing.verifications[0]).not.toHaveProperty("rawCommand");
    expect(publicRun.orchestration.healing.verifications[0]).not.toHaveProperty("authorityAssetPath");
    expect(publicRun.orchestration.healing.verifications[0]).not.toHaveProperty("hiddenTestNames");
    expect(publicRun.orchestration.healing.verifications[0]).not.toHaveProperty("verificationCommand");
    expect(publicRun.orchestration.healing.verifications[0]).not.toHaveProperty("authorityCommand");
    expect(publicRun.orchestration.healing.verifications[0]).not.toHaveProperty("rawEvidence");
    expect(publicRun.orchestration.healing.verifications[0]).not.toHaveProperty("credentials");
    expect(publicRun.orchestration.healing.verifications[0]).not.toHaveProperty("modelToken");
    expect(publicRun.orchestration.healing.nodes[0]).not.toHaveProperty("ownerToken");
    expect(publicRun.orchestration.healing.nodes[0]).not.toHaveProperty("latchListeners");
    expect(publicRun.orchestration.healing.nodes[0]).not.toHaveProperty("terminalLatch");
    expect(publicRun.orchestration.healing.nodes[0]).not.toHaveProperty("workspacePath");
    expect(publicRun.orchestration.healing.verifications[0]).toMatchObject({
      id: "ver-1",
      authorityManifestHash: "m".repeat(64),
      modelCalls: 2,
      reservedTokens: 400,
    });
    expect(publicRun.orchestration.healing.budget.warningLevel).toBe("advisory");
    expect(JSON.stringify(publicRun)).not.toContain(AUTHORITY_ROOT);
    expect(JSON.stringify(publicRun)).not.toContain(secret);
    expect(JSON.stringify(publicRun)).not.toContain("rawCommand");
    await app.close();
  });

  it("recursively strips evolution outbox internals, record hashes, owners, credentials, paths, hidden gates, and raw failures", async () => {
    const AUTHORITY_ROOT = "/var/launchpad/authority-root";
    const boundaryService = {
      listAgents: () => [],
      getRun: () => ({
        id: RUN_ID,
        orchestration: {
          evolutionOutbox: [{
            id: "outbox-1",
            recordHash: "internal-record-hash",
            records: [{
              type: "node",
              value: {
                ownerToken: "internal-owner",
                credential: "internal-credential",
                authorityPath: AUTHORITY_ROOT + "/manifest.json",
                hiddenGateIds: ["secret-gate"],
                rawFailureOutput: "secret failure output",
              },
            }],
          }],
          healing: {
            safe: "visible",
            nested: {
              recordHashes: ["internal-record-hash"],
              ownerId: "internal-owner",
              credentials: { apiKey: "internal-credential" },
              authorityRoot: AUTHORITY_ROOT,
              artifactLocation: "/private/evolution/artifact.json",
              privatePath: "/private/evolution/checkpoint",
              apiToken: "internal-api-token",
              hiddenGateId: "secret-gate",
              rawVerificationOutput: "secret failure output",
            },
          },
        },
      }),
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), boundaryService);
    const response = await app.inject({ method: "GET", url: `/api/runs/${RUN_ID}` });
    expect(response.statusCode).toBe(200);
    const body = response.body;
    for (const forbidden of [
      "evolutionOutbox",
      "recordHash",
      "internal-record-hash",
      "ownerToken",
      "ownerId",
      "internal-owner",
      "credential",
      "internal-credential",
      "authorityPath",
      "authorityRoot",
      AUTHORITY_ROOT,
      "artifactLocation",
      "/private/evolution/artifact.json",
      "privatePath",
      "/private/evolution/checkpoint",
      "apiToken",
      "internal-api-token",
      "hiddenGate",
      "secret-gate",
      "rawFailureOutput",
      "rawVerificationOutput",
      "secret failure output",
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
    expect(body).toContain("visible");
    await app.close();
  });

  it("redacts canonical workspace and verifier commands from run and nested event payloads", async () => {
    const privateValues = {
      runCanonical: "/private/launchpad/fix-round-1/run-canonical",
      eventCanonical: "/private/launchpad/fix-round-1/event-canonical",
      runVerifier: "/opt/launchpad/bin/run-verifier --token=run-secret-8417",
      eventVerifier: "/opt/launchpad/bin/event-verifier --token=event-secret-2753",
      runVerifiers: [
        "/opt/launchpad/bin/run-gate-a --secret=run-a-1942",
        "/opt/launchpad/bin/run-gate-b --secret=run-b-6385",
      ],
      eventVerifiers: [
        "/opt/launchpad/bin/event-gate-a --secret=event-a-4076",
        "/opt/launchpad/bin/event-gate-b --secret=event-b-9521",
      ],
    };
    const boundaryService = {
      listAgents: () => [],
      getRun: () => ({
        id: RUN_ID,
        project: { canonicalWorkspacePath: privateValues.runCanonical, safe: "run-visible" },
        orchestration: {
          healing: {
            verificationAuthority: {
              verifierCommand: privateValues.runVerifier,
              verifierCommands: privateValues.runVerifiers,
              safe: "verification-visible",
            },
          },
        },
      }),
      getRunEvents: async () => ({
        events: [{
          attributes: {
            canonicalWorkspacePath: privateValues.eventCanonical,
            nested: {
              verifierCommand: privateValues.eventVerifier,
              verifierCommands: privateValues.eventVerifiers,
              safe: "event-visible",
            },
          },
        }],
        lastSeq: 1,
        complete: true,
      }),
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), boundaryService);

    for (const url of [`/api/runs/${RUN_ID}`, `/api/runs/${RUN_ID}/events`]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("canonicalWorkspacePath");
      expect(response.body).not.toContain("verifierCommand");
      for (const secret of [
        privateValues.runCanonical,
        privateValues.eventCanonical,
        privateValues.runVerifier,
        privateValues.eventVerifier,
        ...privateValues.runVerifiers,
        ...privateValues.eventVerifiers,
      ]) {
        expect(response.body).not.toContain(secret);
      }
      expect(response.body).toContain("visible");
    }
    await app.close();
  });

  it("rejects a client-supplied workspaceSource and admits only message content", async () => {
    const accepted: unknown[] = [];
    const messageService = {
      sendMessage: async (agentId: string, content: string, extra?: unknown) => {
        accepted.push({ agentId, content, extra, args: extra });
        return { run: { id: RUN_ID, workspaceSource: { mode: "ephemeral_research" } }, message: { id: "message-1" } };
      },
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), messageService);
    const url = "/api/agents/11111111-1111-4111-8111-111111111111/messages";

    const injectedSource = await app.inject({
      method: "POST",
      url,
      payload: {
        content: "build a todo app",
        workspaceSource: {
          mode: "existing_repository",
          repositoryPath: "/tmp/hijack",
          revision: "HEAD",
        },
      },
    });
    expect(injectedSource.statusCode).toBe(400);
    expect(accepted).toEqual([]);

    const acceptedContent = await app.inject({
      method: "POST",
      url,
      payload: { content: "build a todo app" },
    });
    expect(acceptedContent.statusCode).toBe(202);
    expect(accepted).toEqual([
      {
        agentId: "11111111-1111-4111-8111-111111111111",
        content: "build a todo app",
        extra: undefined,
        args: undefined,
      },
    ]);
    await app.close();
  });

  it("reports the resolved pricing on the system route", async () => {
    const pricingService = {
      listAgents: () => [],
      systemInfo: async () => ({
        arkConfigured: true,
        pricing: {
          inputPerMillion: 0.04,
          outputPerMillion: 0.08,
          cachedInputPerMillion: 0.008,
          source: "provider",
          contextWindow: 1_310_720,
        },
      }),
    } as unknown as AgentService;

    const app = await createApp(loadConfig({ NODE_ENV: "test" }), pricingService);
    const response = await app.inject({ method: "GET", url: "/api/system" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      pricing: { inputPerMillion: number; source: string } | null;
    };
    expect(body.pricing?.inputPerMillion).toBe(0.04);
    expect(body.pricing?.source).toBe("provider");
    await app.close();
  });

  it("serves run events from a sequence cursor", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const response = await app.inject({
      method: "GET",
      url: "/api/runs/" + RUN_ID + "/events?after=3",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      events: { seq: number }[];
      lastSeq: number;
      complete: boolean;
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.seq).toBe(4);
    expect(body.lastSeq).toBe(4);
    expect(body.complete).toBe(true);
    await app.close();
  });

  it("defaults the cursor to the start of the run", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const response = await app.inject({
      method: "GET",
      url: "/api/runs/" + RUN_ID + "/events",
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { lastSeq: number }).lastSeq).toBe(1);
    await app.close();
  });

  it("returns 404 for a missing run but 200 for an existing empty terminal run", async () => {
    const { config, service: realService, store } = await makeRealService();
    await store.mutate((database) => {
      database.runs.push({
        id: RUN_ID,
        agentId: "agent-1",
        status: "completed",
        prompt: "done",
        output: "done",
        error: null,
        usage: null,
        startedAt: "2026-08-26T00:00:00.000Z",
        completedAt: "2026-08-26T00:00:01.000Z",
        createdAt: "2026-08-26T00:00:00.000Z",
      });
    });
    const app = await createApp(config, realService);

    const existing = await app.inject({
      method: "GET",
      url: "/api/runs/" + RUN_ID + "/events",
    });
    expect(existing.statusCode).toBe(200);
    expect(existing.json()).toMatchObject({ events: [], complete: true });

    const missing = await app.inject({
      method: "GET",
      url: "/api/runs/22222222-2222-4222-8222-222222222222/events",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Run not found" });
    await app.close();
  });

  it("returns a leader run's worker child runs", async () => {
    const { config, service: realService, store } = await makeRealService();
    const leaderRunId = "33333333-3333-4333-8333-333333333333";
    const worker1Id = "44444444-4444-4444-8444-444444444444";
    const worker2Id = "55555555-5555-4555-8555-555555555555";
    await store.mutate((database) => {
      database.runs.push(
        {
          id: leaderRunId,
          agentId: "agent-1",
          kind: "orchestration",
          parentRunId: null,
          orchestration: null,
          status: "completed",
          prompt: "leader",
          output: "leader done",
          error: null,
          usage: null,
          startedAt: "2026-08-26T00:00:00.000Z",
          completedAt: "2026-08-26T00:00:05.000Z",
          createdAt: "2026-08-26T00:00:00.000Z",
        },
        {
          id: worker1Id,
          agentId: "agent-2",
          kind: "subtask",
          parentRunId: leaderRunId,
          orchestration: null,
          status: "completed",
          prompt: "worker 1",
          output: "worker 1 done",
          error: null,
          usage: null,
          startedAt: "2026-08-26T00:00:01.000Z",
          completedAt: "2026-08-26T00:00:02.000Z",
          createdAt: "2026-08-26T00:00:01.000Z",
        },
        {
          id: worker2Id,
          agentId: "agent-3",
          kind: "subtask",
          parentRunId: leaderRunId,
          orchestration: null,
          status: "completed",
          prompt: "worker 2",
          output: "worker 2 done",
          error: null,
          usage: null,
          startedAt: "2026-08-26T00:00:02.000Z",
          completedAt: "2026-08-26T00:00:03.000Z",
          createdAt: "2026-08-26T00:00:02.000Z",
        },
      );
    });
    const app = await createApp(config, realService);

    const response = await app.inject({
      method: "GET",
      url: "/api/runs/" + leaderRunId + "/children",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { runs: { id: string }[] };
    expect(body.runs.map((run) => run.id)).toEqual([worker1Id, worker2Id]);
    await app.close();
  });

  it("returns an empty list for a run with no children", async () => {
    const { config, service: realService, store } = await makeRealService();
    const soloRunId = "66666666-6666-4666-8666-666666666666";
    await store.mutate((database) => {
      database.runs.push({
        id: soloRunId,
        agentId: "agent-1",
        kind: "single",
        parentRunId: null,
        orchestration: null,
        status: "completed",
        prompt: "solo",
        output: "solo done",
        error: null,
        usage: null,
        startedAt: "2026-08-26T00:00:00.000Z",
        completedAt: "2026-08-26T00:00:01.000Z",
        createdAt: "2026-08-26T00:00:00.000Z",
      });
    });
    const app = await createApp(config, realService);

    const response = await app.inject({
      method: "GET",
      url: "/api/runs/" + soloRunId + "/children",
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { runs: unknown[] }).runs).toEqual([]);
    await app.close();
  });

  it("rejects a non-uuid run id on the events route", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const response = await app.inject({
      method: "GET",
      url: "/api/runs/not-a-uuid/events",
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an out-of-range limit on the events route", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const response = await app.inject({
      method: "GET",
      url: "/api/runs/" + RUN_ID + "/events?limit=5000",
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("requires the shared token on the events route", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/runs/" + RUN_ID + "/events",
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("creates managed and external projects, lists them, and opens project chats", async () => {
    const failFast = failFastDoubles();
    const { config, service, root, git } = await makeRealService(failFast.runner, {
      parts: failFast.parts,
      modelProxy: failFast.modelProxy,
    });
    const app = await createApp(config, service);
    const repository = path.join(root, "external-repo");
    await git.run(root, ["init", "-b", "main", "--", repository]);
    await writeFile(path.join(repository, "README.md"), "external\n", "utf8");
    await git.run(repository, ["add", "--", "README.md"]);
    await git.run(repository, ["commit", "-m", "initial"]);

    const managed = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { kind: "managed", displayName: "Todo Flow" },
    });
    expect(managed.statusCode).toBe(201);
    const managedBody = managed.json() as {
      project: { id: string; displayName: string; sourceKind: string; baselineCommit: string };
    };
    expect(managedBody.project.displayName).toBe("Todo Flow");
    expect(managedBody.project.sourceKind).toBe("managed");
    expect(managedBody.project.baselineCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(managed.body).not.toContain("gitCommonDev");
    expect(managed.body).not.toContain("baselineTransition");

    const external = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        kind: "external",
        displayName: "CodeJam",
        repositoryPath: repository,
      },
    });
    expect(external.statusCode).toBe(201);
    const externalBody = external.json() as { project: { id: string; sourceKind: string } };
    expect(externalBody.project.sourceKind).toBe("external");

    const listed = await app.inject({ method: "GET", url: "/api/projects" });
    expect(listed.statusCode).toBe(200);
    const listedBody = listed.json() as { projects: { id: string }[] };
    // Newest first: the external project was opened after the managed one. This
    // used to assert insertion order, and kept asserting it after the list was
    // deliberately reversed for the sidebar.
    expect(listedBody.projects.map((project) => project.id)).toEqual([
      externalBody.project.id,
      managedBody.project.id,
    ]);
    expect(listed.body).not.toContain("gitCommonIno");
    expect(listed.body).not.toContain("ephemeral_research");

    const chat = await app.inject({
      method: "POST",
      url: "/api/projects/" + managedBody.project.id + "/chats",
      payload: { name: "Fix project outcome persistence" },
    });
    expect(chat.statusCode).toBe(201);
    const chatBody = chat.json() as {
      agent: { projectId: string | null; unassignedPlacement: string | null; role: string };
    };
    expect(chatBody.agent.projectId).toBe(managedBody.project.id);
    expect(chatBody.agent.unassignedPlacement).toBeNull();
    expect(chatBody.agent.role).toBe("leader");
    expect(failFast.calls).toEqual({ planner: 0, runner: 0, model: 0 });
    await app.close();
  });

  it("renames projects through PATCH with bounded errors and no repository path leak", async () => {
    const { config, root, service } = await makeRealService();
    const app = await createApp(config, service);
    const project = await service.createManagedProject({ displayName: "Before" });

    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/projects/" + project.id,
      payload: { displayName: "  After  " },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ project: { id: project.id, displayName: "After" } });
    expect(renamed.body).not.toContain(project.repositoryPath);
    expect(renamed.body).not.toContain(root);

    const missing = await app.inject({
      method: "PATCH",
      url: "/api/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      payload: { displayName: "Missing" },
    });
    expect(missing.statusCode).toBe(404);

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/projects/" + project.id,
      payload: { displayName: "x".repeat(81) },
    });
    expect(invalid.statusCode).toBe(400);
    expect(service.listProjects().find((item) => item.id === project.id)?.displayName).toBe("After");
    await app.close();
  });

  it("renames a chat through PATCH without changing its other fields", async () => {
    const { config, service } = await makeRealService();
    const app = await createApp(config, service);
    const project = await service.createManagedProject({ displayName: "Chat rename route" });
    const chat = await service.createProjectChat(project.id, {
      name: "Before chat rename",
      description: "Keep this description",
      instructions: "Keep these instructions",
      role: "standalone",
    });
    const before = service.getAgent(chat.id);

    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/agents/" + chat.id,
      payload: { name: "  After chat rename  " },
    });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ agent: { id: chat.id, name: "After chat rename" } });
    const after = service.getAgent(chat.id);
    expect({ ...after, name: before.name, updatedAt: before.updatedAt }).toEqual(before);

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/agents/" + chat.id,
      payload: { name: "invalid\r\nname" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(service.getAgent(chat.id)).toEqual(after);
    await app.close();
  });

  it("keeps POST /api/agents as temporary-chat creation", async () => {
    const { config, service } = await makeRealService();
    const app = await createApp(config, service);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Scratch" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      agent: { projectId: string | null; unassignedPlacement: string | null };
    };
    expect(body.agent.projectId).toBeNull();
    expect(body.agent.unassignedPlacement).toBe("temporary");
    await app.close();
  });

  it("derives a temporary chat source automatically and never binds a client repository", async () => {
    const failFast = failFastDoubles();
    const { config, service } = await makeRealService(failFast.runner, {
      parts: failFast.parts,
      modelProxy: failFast.modelProxy,
    });
    const app = await createApp(config, service);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Temp Research" },
    });
    const agentId = (created.json() as { agent: { id: string } }).agent.id;
    const sent = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: { content: "research this" },
    });
    expect(sent.statusCode).toBe(202);
    const body = sent.json() as {
      run: { workspaceSource: unknown; projectId: string | null };
    };
    expect(body.run.workspaceSource).toEqual({ mode: "ephemeral_research" });
    expect(body.run.projectId).toBeNull();
    await service.stopAgent(agentId);
    await app.close();
  });

  it("returns 4xx with zero planner, model, or runtime calls for invalid project authority", async () => {
    const failFast = failFastDoubles();
    const { config, service, git } = await makeRealService(failFast.runner, {
      parts: failFast.parts,
      modelProxy: failFast.modelProxy,
    });
    const app = await createApp(config, service);
    const missingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "app-outside-source-"));
    temporaryDirectories.push(outsideRoot);
    await git.run(outsideRoot, ["init", "-b", "main", "--", outsideRoot]);
    await writeFile(path.join(outsideRoot, "README.md"), "outside\n", "utf8");
    await git.run(outsideRoot, ["add", "--", "README.md"]);
    await git.run(outsideRoot, ["commit", "-m", "outside"]);

    const malformed = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { displayName: "Nope" },
    });
    expect(malformed.statusCode).toBe(400);

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        kind: "external",
        displayName: "Outside",
        repositoryPath: outsideRoot,
        revision: "HEAD",
      },
    });
    expect(unauthorized.statusCode).toBeGreaterThanOrEqual(400);
    expect(unauthorized.statusCode).toBeLessThan(500);

    const missingChat = await app.inject({
      method: "POST",
      url: "/api/projects/" + missingId + "/chats",
      payload: { name: "Missing" },
    });
    expect(missingChat.statusCode).toBe(404);

    const invalidId = await app.inject({
      method: "POST",
      url: "/api/projects/not-a-uuid/chats",
      payload: { name: "Invalid" },
    });
    expect(invalidId.statusCode).toBe(400);

    const managed = await service.createManagedProject({ displayName: "Soon Missing" });
    await rm(managed.repositoryPath, { recursive: true, force: true });
    await service.initialize();
    try {
      await service.createProjectChat(managed.id, { name: "Unavailable Chat" });
      const chats = service.listAgents().filter((agent) => agent.projectId === managed.id);
      const sent = await app.inject({
        method: "POST",
        url: "/api/agents/" + chats[0]!.id + "/messages",
        payload: { content: "build" },
      });
      expect(sent.statusCode).toBeGreaterThanOrEqual(400);
      expect(sent.statusCode).toBeLessThan(500);
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).toBeGreaterThanOrEqual(400);
      expect((error as { statusCode?: number }).statusCode).toBeLessThan(500);
    }
    expect(failFast.calls).toEqual({ planner: 0, runner: 0, model: 0 });
    await app.close();
  });
});

describe("published artifacts and the skill hub over HTTP", () => {
  const ARTIFACT_ID = "44444444-4444-4444-8444-444444444444";

  function routeService() {
    return {
      listAgents: () => [],
      listRunArtifacts: (runId: string) => ({
        artifacts: [{ id: ARTIFACT_ID, type: "report", ownerWorkerRunId: runId }],
      }),
      readRunArtifact: (_runId: string, artifactId: string) => ({
        artifact: { id: artifactId },
        text: "the deliverable",
      }),
      listSkills: () => ({ skills: [{ name: "repo-triage", version: "1" }] }),
      readSkill: (name: string, version?: string) => ({
        skill: { name, version: version ?? "latest", skillMarkdown: "# doc" },
      }),
    } as unknown as AgentService;
  }

  it("lists what a run published", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), routeService());
    const response = await app.inject({ method: "GET", url: `/api/runs/${RUN_ID}/artifacts` });
    expect(response.statusCode).toBe(200);
    expect(response.json().artifacts[0].id).toBe(ARTIFACT_ID);
    await app.close();
  });

  it("serves one published artifact's content", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), routeService());
    const response = await app.inject({
      method: "GET",
      url: `/api/runs/${RUN_ID}/artifacts/${ARTIFACT_ID}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().text).toBe("the deliverable");
    await app.close();
  });

  it("refuses an artifact id that is a path", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), routeService());
    const response = await app.inject({
      method: "GET",
      url: `/api/runs/${RUN_ID}/artifacts/..%2F..%2Flaunchpad.json`,
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("lists the skills agents have published", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), routeService());
    const response = await app.inject({ method: "GET", url: "/api/skills" });
    expect(response.statusCode).toBe(200);
    expect(response.json().skills[0].name).toBe("repo-triage");
    await app.close();
  });

  it("reads one skill, at the version asked for", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), routeService());
    const response = await app.inject({
      method: "GET",
      url: "/api/skills/repo-triage?version=2",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().skill.version).toBe("2");
    await app.close();
  });
});

/**
 * The shipped configuration is the one that serves the UI, and it silently
 * dropped the app's error handler.
 *
 * `setNotFoundHandler` -- registered only in production, for the SPA fallback
 * -- was installed before `setErrorHandler`, and Fastify then never applied the
 * custom handler to those routes. Every typed failure came back as a bare 500
 * with Fastify's default body: a malformed id, "Agent not found", the 409 that
 * refuses to delete a project while one of its chats is running. Only the
 * development and test builds mapped them correctly, which is exactly the
 * inversion that hides a bug: the tests passed and the product did not.
 *
 * Found in a browser against the production server, where `/api/runs/<legacy
 * non-uuid id>/events` answered 500 instead of 400.
 */
describe("typed failures survive the production wiring", () => {
  /** `@fastify/static` refuses to start without its root, and `npm run check` tests before it builds. */
  async function withWebDist<T>(body: () => Promise<T>): Promise<T> {
    const dist = fileURLToPath(new URL("../../web/dist", import.meta.url));
    const existed = existsSync(dist);
    if (!existed) await mkdir(dist, { recursive: true });
    try {
      return await body();
    } finally {
      if (!existed) await rm(dist, { recursive: true, force: true });
    }
  }

  const productionConfig = () =>
    loadConfig({ NODE_ENV: "production", HOST: "127.0.0.1", LOG_LEVEL: "silent" });

  it("answers a malformed run id with 400, not 500", async () => {
    await withWebDist(async () => {
      const app = await createApp(productionConfig(), service);
      const response = await app.inject({
        method: "GET",
        url: "/api/runs/afed9e8de0a11f2160a1a08d814b736c/events",
      });
      expect(response.statusCode).toBe(400);
      await app.close();
    });
  });

  it("keeps a service's own status code instead of flattening it to 500", async () => {
    await withWebDist(async () => {
      const refusing = {
        listAgents: () => [],
        getRun: () => {
          throw new HttpError(409, "A chat in this project is running");
        },
      } as unknown as AgentService;
      const app = await createApp(productionConfig(), refusing);
      const response = await app.inject({ method: "GET", url: `/api/runs/${RUN_ID}` });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("A chat in this project is running");
      await app.close();
    });
  });
});
