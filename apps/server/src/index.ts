import { randomBytes } from "node:crypto";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { EventLog } from "./event-log.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { ModelProxy } from "./model-proxy.js";
import { resolvePricing } from "./pricing.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { CoordinationServer } from "./coordination/server.js";
import { GitClient } from "./git-client.js";
import { ProjectRegistry } from "./project-registry.js";
import { ProjectRepositoryManager } from "./project-repository-manager.js";
import { ProjectRunManager } from "./project-run-manager.js";
import { migrateServerDataLayout, serverDataPaths } from "./storage-layout.js";
import { createVerificationAuthority } from "./orchestration/verification/verifier.js";
import type { OrchestratorParts } from "./orchestration/orchestrator.js";
import { resolveRepairRuntimeCapabilityEnvironment } from "./orchestration/policies.js";
import { EvolutionStore } from "./orchestration/evolution/evolution-store.js";
import { LineageRecorder } from "./orchestration/evolution/lineage-recorder.js";
import { EvidenceStore } from "./orchestration/verification/evidence-store.js";
import { HistoricalEvidenceAuditor } from "./orchestration/evolution/historical-evidence-auditor.js";
import { EvolutionReconciler } from "./orchestration/evolution/evolution-reconciler.js";
import { ExactRepeatIndex } from "./orchestration/evolution/exact-repeat-index.js";
import { FailureCueService } from "./orchestration/evolution/failure-cues.js";
import { EvolutionQueryService } from "./orchestration/evolution/evolution-query.js";

const config = loadConfig();
await migrateServerDataLayout(config.dataDirectory);
const dataPaths = serverDataPaths(config.dataDirectory);

const store = new JsonStore(dataPaths.database);
const evolutionStore = new EvolutionStore({
  dataDirectory: config.dataDirectory,
  maxBytes: config.orchestrationEvolutionMaxBytes,
  queryLimit: config.orchestrationEvolutionQueryLimit,
});
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const events = new EventLog(dataPaths.eventLog, {
  secrets: [config.arkApiKey],
});
const git = new GitClient(config.gitCommandTimeoutMs);
const projectRepositoryManager = new ProjectRepositoryManager(
  config.workspaceRoot,
  config.workspaceSourceRoots,
  git,
);
const projectRegistry = new ProjectRegistry(store, projectRepositoryManager, git);
const projectRunManager = new ProjectRunManager(
  config.workspaceRoot,
  config.workspaceSourceRoots,
  git,
);

// Codex calls the model from inside its Runtime, so the only way to record
// those calls is to be on the path. Point the generated Codex config here; the
// proxy holds the real key and hands each Run a token instead.
const modelProxy = new ModelProxy({
  config,
  createSink: (runId, agentId) => events.createSink(runId, agentId),
  saveSidecar: (runId, label, digest, text) =>
    events.writeSidecar(runId, label, digest, text),
});
await modelProxy.listen(config.modelProxyPort);
// Codex resolves this from inside the container (or on the host, for the
// local-process runner).
const codexBaseUrl = modelProxy.baseUrl(
  config.runtimeProvider === "container" ? "host.docker.internal" : "127.0.0.1",
);
await writeCodexConfig({ ...config, arkBaseUrl: codexBaseUrl });

// Workers talk to each other through this, not through the main API: their
// caller is a sandboxed subprocess holding one short-lived token, not a browser
// with a session.
const coordinationServer = new CoordinationServer();
await coordinationServer.listen(config.coordinationPort);
const coordinationHost =
  config.runtimeProvider === "container" ? "host.docker.internal" : "127.0.0.1";

const healingParts: Partial<OrchestratorParts> = {};
const failureCueService = new FailureCueService();
const lineageRecorder = new LineageRecorder({ store, evolutionStore, failureCueService });
const exactRepeatIndex = new ExactRepeatIndex();
healingParts.lineageRecorder = lineageRecorder;
healingParts.exactRepeatIndex = exactRepeatIndex;
healingParts.failureCueService = failureCueService;
if (config.orchestrationHealingEnabled) {
  const authority = await createVerificationAuthority(config);
  healingParts.healingEnabled = true;
  healingParts.contractCatalog = authority.registry.catalog();
  healingParts.verificationRunner = authority.runner;
  healingParts.verificationRegistry = authority.registry;
  healingParts.runtimeCapabilityEnvironment =
    await resolveRepairRuntimeCapabilityEnvironment(config);
}

const evidenceStore = new EvidenceStore({
  dataDirectory: config.dataDirectory,
  secrets: [config.arkApiKey],
});
healingParts.faultEvidenceStore = evidenceStore;
const historicalAuditor = new HistoricalEvidenceAuditor({
  evidenceStore,
  candidateRun: (record) => {
    const snapshot = store.snapshot();
    const root = snapshot.runs.find((run) => run.id === record.runId);
    const attemptId = root?.orchestration?.healing.candidates.find((candidate) =>
      candidate.id === record.entityId)?.attemptId;
    return attemptId ? snapshot.runs.find((run) => run.id === attemptId) ?? null : null;
  },
});
const evolutionReconciler = new EvolutionReconciler({
  store,
  evolutionStore,
  lineageRecorder,
  auditor: historicalAuditor,
  exactRepeatIndex,
  failureCueService,
  evidenceStore,
});
healingParts.refreshEvolutionHistory = async () => {
  await evolutionReconciler.reconcile();
};

let service!: AgentService;
const evolutionQuery = new EvolutionQueryService({
  store: evolutionStore,
  runById: (runId) => service.getRun(runId),
  cursorSecret: config.authToken || randomBytes(32),
});
service = new AgentService(
  config,
  store,
  workspaces,
  runner,
  events,
  healingParts,
  modelProxy,
  {
    dataDir: config.dataDirectory,
    baseUrl: coordinationServer.baseUrl(coordinationHost),
    register: (token, ingress) => coordinationServer.register(token, ingress),
    unregister: (token) => coordinationServer.unregister(token),
  },
  projectRunManager,
  {},
  projectRegistry,
  git,
  evolutionReconciler,
  evolutionQuery,
);
await service.initialize();

// Rates are a convenience: a slow or unreachable provider must not delay or
// block startup, so failures degrade to showing token counts only.
const pricing = await resolvePricing(config);
service.setPricing(pricing);
if (pricing === null) {
  console.warn(
    "[launchpad] No model rates available; the Playground will show token counts without cost.",
  );
} else if (config.arkContextWindow === null && pricing.contextWindow !== undefined) {
  // Codex only ships metadata for OpenAI models; telling it the real window
  // lets it compact sensibly instead of guessing. The per-turn fallback-metadata
  // diagnostic still fires -- only a full model_catalog_json would stop it.
  await writeCodexConfig({
    ...config,
    arkBaseUrl: codexBaseUrl,
    arkContextWindow: pricing.contextWindow,
  });
}

const app = await createApp(config, service);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await evolutionStore.close();
  await modelProxy.close();
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
