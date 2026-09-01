/**
 * The HTTP surface a worker's MCP subprocess talks to.
 *
 * Separate from the main API because its caller is different: not a browser
 * with a session, but a sandboxed subprocess holding one short-lived token. The
 * token is the whole authorisation story — it names the sender, scopes the
 * roster, and cannot be traded for anything outside this leader run.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CoordinationIngress } from "./ingress.js";
import { assertNoForbiddenLeaderKeys } from "../types.js";

const MAX_BODY_BYTES = 64 * 1024;

export class CoordinationServer {
  private server: Server | null = null;
  private port = 0;
  /** One ingress per leader run; the token says which. */
  private readonly ingresses = new Map<string, CoordinationIngress>();

  register(token: string, ingress: CoordinationIngress): void {
    this.ingresses.set(token, ingress);
  }

  unregister(token: string): void {
    this.ingresses.delete(token);
  }

  async listen(port: number): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(port, "0.0.0.0", () => resolve());
    });
    const address = this.server?.address();
    this.port = typeof address === "object" && address !== null ? address.port : port;
  }

  baseUrl(host: string): string {
    return "http://" + host + ":" + this.port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server === null) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const ingress = this.ingresses.get(token);
    if (ingress === undefined) {
      request.resume();
      return send(response, 401, { error: "unauthorized" });
    }
    if (request.method !== "POST") {
      request.resume();
      return send(response, 405, { error: "method not allowed" });
    }

    let body: string;
    try {
      body = await readBody(request);
    } catch (error) {
      return send(response, 413, { error: String(error) });
    }

    let payload: Record<string, unknown>;
    try {
      payload = body.trim().length === 0 ? {} : (JSON.parse(body) as Record<string, unknown>);
    } catch {
      return send(response, 400, { error: "invalid json" });
    }

    try {
      if (request.url === "/teammates") {
        return send(response, 200, { teammates: ingress.listTeammates(token) });
      }
      if (request.url === "/messages") {
        const delivery =
          payload.delivery === "wakeup"
            ? "wakeup"
            : payload.delivery === "talk"
              ? "talk"
              : "quiet";
        const message = await ingress.submit(token, {
          to: String(payload.to ?? ""),
          content: String(payload.content ?? ""),
          delivery,
          workspaceRefs: Array.isArray(payload.workspaceRefs)
            ? (payload.workspaceRefs as string[])
            : [],
        });
        return send(response, 200, { id: message.id, to: message.toWorkerRunId });
      }
      if (request.url === "/dispatch_subagent") {
        assertNoForbiddenLeaderKeys(payload, "Leader dispatch");
        const dispatchRequest = {
          prompt: String(payload.prompt ?? ""),
          ...(typeof payload.id === "string" ? { id: payload.id } : {}),
          ...(typeof payload.agentName === "string" ? { agentName: payload.agentName } : {}),
          ...(typeof payload.title === "string" ? { title: payload.title } : {}),
          ...(typeof payload.role === "string" ? { role: payload.role } : {}),
          ...(typeof payload.objective === "string" ? { objective: payload.objective } : {}),
          ...(Array.isArray(payload.successCriteria)
            ? { successCriteria: payload.successCriteria.map(String) }
            : {}),
          ...(typeof payload.expectedOutput === "string"
            ? { expectedOutput: payload.expectedOutput }
            : {}),
          ...(Array.isArray(payload.dependsOn) ? { dependsOn: payload.dependsOn.map(String) } : {}),
          ...(typeof payload.requiresGitContribution === "boolean"
            ? { requiresGitContribution: payload.requiresGitContribution }
            : {}),
          ...(typeof payload.initialMessage === "string"
            ? { initialMessage: payload.initialMessage }
            : {}),
          ...(Array.isArray(payload.initialMessageWorkspaceRefs)
            ? { initialMessageWorkspaceRefs: payload.initialMessageWorkspaceRefs.map(String) }
            : {}),
          ...(typeof payload.wait === "boolean" ? { wait: payload.wait } : {}),
          ...(typeof payload.contractKey === "string" ? { contractKey: payload.contractKey } : {}),
          ...(Array.isArray(payload.inputs) ? { inputs: payload.inputs.map(String) } : {}),
          ...(Array.isArray(payload.outputs) ? { outputs: payload.outputs.map(String) } : {}),
          ...(Array.isArray(payload.mutationPaths)
            ? { mutationPaths: payload.mutationPaths.map(String) }
            : {}),
        };
        const result = await ingress.dispatch(token, dispatchRequest);
        return send(response, 200, result);
      }
      if (request.url === "/wait_workers") {
        const result = await ingress.wait(token, {
          ...(Array.isArray(payload.targets) ? { targets: payload.targets.map(String) } : {}),
          ...(typeof payload.timeoutSeconds === "number"
            ? { timeoutSeconds: payload.timeoutSeconds }
            : {}),
        });
        return send(response, 200, result);
      }
      if (request.url === "/inspect_worker") {
        const result = await ingress.inspect(token, {
          target: String(payload.target ?? ""),
          ...(typeof payload.maxEvents === "number" ? { maxEvents: payload.maxEvents } : {}),
        });
        return send(response, 200, result);
      }
      if (request.url === "/extend_worker_timeout") {
        const result = await ingress.extendTimeout(token, {
          target: String(payload.target ?? ""),
          additionalSeconds: Number(payload.additionalSeconds ?? 0),
          ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
        });
        return send(response, 200, result);
      }
      return send(response, 404, { error: "not found" });
    } catch (error) {
      // The refusal reason is the useful part: it tells the model what to do
      // differently, which a bare 400 would not.
      return send(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
