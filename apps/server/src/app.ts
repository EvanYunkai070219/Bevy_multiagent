import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import { createRedactor, stripInternalAuthority } from "./redact.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const projectIdParams = z.object({ id: z.string().uuid() });
const workspaceFileQuery = z.object({ path: z.string().min(1).max(1_024) });
const uploadBody = z.object({
  name: z.string().min(1).max(255),
  contentBase64: z.string().min(1),
});
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
  role: z.enum(["leader", "standalone"]).optional(),
  parentAgentId: z.string().uuid().nullable().optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const runArtifactParams = z.object({
  id: z.string().uuid(),
  artifactId: z.string().uuid(),
});
const skillNameParams = z.object({ name: z.string().min(1).max(80) });
const skillVersionQuery = z.object({ version: z.string().min(1).max(80).optional() });
const runEventsQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});
const runQuery = z.object({
  includeEvolution: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  evolutionAfter: z.string().min(1).max(4_096).optional(),
  evolutionLimit: z.coerce.number().int().min(1).max(200).default(100),
  evolutionDepth: z.coerce.number().int().min(0).max(4).default(4),
});
const createProjectBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("managed"), displayName: z.string().trim().min(1).max(80) }),
  z.object({
    kind: z.literal("external"),
    displayName: z.string().trim().min(1).max(80),
    repositoryPath: z.string().trim().min(1).max(4096),
    revision: z.string().trim().min(1).max(256).default("HEAD"),
  }),
]);
const renameProjectBody = z.object({
  displayName: z.string().trim().min(1).max(80).refine((value) => !/[\r\n]/u.test(value)),
});
const createProjectChatBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
  role: z.enum(["leader", "standalone"]).optional(),
});
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
}).strict();

export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });
  const redactPublicPayload = createRedactor([config.authToken, config.arkApiKey]);

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  // Store/restart recovery needs the raw owner token; no HTTP consumer does.
  // Apply this recursively at the single public serialization boundary so a
  // future route or event envelope cannot accidentally expose it.
  app.addHook("preSerialization", async (_request, _reply, payload) =>
    redactPublicPayload(stripInternalAuthority(payload)));

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/projects", async () => ({ projects: service.listProjects() }));

  app.post("/api/projects", async (request, reply) => {
    const body = createProjectBody.parse(request.body);
    const project =
      body.kind === "managed"
        ? await service.createManagedProject({ displayName: body.displayName })
        : await service.openProject({
            displayName: body.displayName,
            repositoryPath: body.repositoryPath,
            revision: body.revision,
          });
    return reply.code(201).send({ project });
  });

  app.delete("/api/projects/:id", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    return service.deleteProject(id);
  });

  app.patch("/api/projects/:id", async (request) => {
    const { id } = projectIdParams.parse(request.params);
    const body = renameProjectBody.parse(request.body);
    return { project: await service.renameProject({ projectId: id, displayName: body.displayName }) };
  });

  app.post("/api/projects/:id/chats", async (request, reply) => {
    const { id } = projectIdParams.parse(request.params);
    const body = createProjectChatBody.parse(request.body);
    const agent = await service.createProjectChat(id, body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  /**
   * Bytes out of one Agent's workspace, so the browser can show what the Agent
   * produced. The path is confined to that Agent's workspace by the service;
   * `Content-Disposition: inline` with an explicit type is what lets an image
   * render, and anything unrecognised arrives as a download rather than being
   * guessed at.
   */
  app.get("/api/agents/:id/files", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const { path: requested } = workspaceFileQuery.parse(request.query);
    const file = service.readWorkspaceFile(id, requested);
    return reply
      .header("Content-Type", file.contentType)
      .header("Content-Disposition", 'inline; filename="' + file.filename + '"')
      // Agent output is not this origin's document, and must never be treated
      // as one by a sniffing browser.
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "no-store")
      .send(file.bytes);
  });

  app.post(
    "/api/agents/:id/files",
    // Base64 inflates by 4/3; the service enforces the real cap on the bytes.
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const { id } = agentIdParams.parse(request.params);
      const body = uploadBody.parse(request.body);
      const file = await service.writeWorkspaceUpload(id, body.name, body.contentBase64);
      return reply.code(201).send({ file });
    },
  );

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const query = runQuery.parse(request.query);
    const run = service.getRun(id);
    if (!query.includeEvolution) return { run };
    const evolution = await service.getEvolution({
      runId: id,
      after: query.evolutionAfter ?? null,
      limit: query.evolutionLimit,
      depth: query.evolutionDepth,
    });
    return { run, evolution };
  });

  app.get("/api/runs/:id/events", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const { after, limit } = runEventsQuery.parse(request.query);
    return service.getRunEvents(id, after, limit);
  });

  // Coordination is only trustworthy if it can be inspected. In particular a
  // quiet note nobody read has to be visible: the sender believes it passed the
  // information on, and nothing else in the run says otherwise.
  app.get("/api/runs/:id/coordination", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return service.getCoordination(id);
  });

  /**
   * What the mission published, and the bytes of one published artifact.
   *
   * `publish_artifact` is how an agent names a durable output, and the shared
   * directory it writes to had no reader outside the container -- so the run's
   * actual deliverable was invisible to the operator who asked for it. Both
   * ids are validated as ids by the service before any path is built.
   */
  app.get("/api/runs/:id/artifacts", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return service.listRunArtifacts(id);
  });

  app.get("/api/runs/:id/artifacts/:artifactId", async (request) => {
    const { id, artifactId } = runArtifactParams.parse(request.params);
    return service.readRunArtifact(id, artifactId);
  });

  /**
   * The persistent skill hub, read-only.
   *
   * Publishing and installing stay with the agents that earned the skill; the
   * control plane only reads, so a page here can never mint capability that no
   * run produced.
   */
  app.get("/api/skills", async () => service.listSkills());

  app.get("/api/skills/:name", async (request) => {
    const { name } = skillNameParams.parse(request.params);
    const { version } = skillVersionQuery.parse(request.query);
    return service.readSkill(name, version);
  });

  app.get("/api/runs/:id/children", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { runs: service.getChildRuns(id) };
  });

  /**
   * Registered before the production-only SPA fallback, and that order matters.
   *
   * `setNotFoundHandler` establishes its own handling context, and installing
   * it first left this handler unapplied in exactly the build that ships: every
   * typed failure -- a malformed id, a 404 for a missing Agent, the 409 that
   * refuses to delete a project with a running chat -- came back as a bare 500.
   * Development and test were unaffected, so the tests agreed with a product
   * that was wrong.
   */
  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
