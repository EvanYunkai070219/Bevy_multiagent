/**
 * The only way a worker's MCP subprocess can reach the team.
 *
 * Workers do not write the mailbox themselves. Each gets a short-lived token
 * bound to its parent run and its own run id, and the token — not the request
 * body — decides who the sender is. A subprocess that could name its own sender
 * could impersonate a sibling, and every downstream judgement built on "who said
 * this" would be worthless.
 */
import { randomUUID } from "node:crypto";
import type { MessageDelivery, TeamMessageQueued } from "./messages.js";
import type { Roster } from "./roster.js";
import { assertNoForbiddenLeaderKeys } from "../types.js";

/** Long content belongs in the shared workspace; a message carries the pointer. */
export const MAX_CONTENT_CHARS = 2_000;

export interface SubmitRequest {
  to: string;
  content: string;
  delivery: MessageDelivery;
  workspaceRefs?: string[];
}

export interface DispatchSubagentRequest {
  id?: string;
  agentName?: string;
  title?: string;
  role?: string;
  prompt: string;
  objective?: string;
  successCriteria?: string[];
  expectedOutput?: string;
  dependsOn?: string[];
  /** Set false for read-only validation, smoke-test, or forward-test workers. */
  requiresGitContribution?: boolean;
  /** Optional first teammate message queued atomically with worker dispatch. */
  initialMessage?: string;
  initialMessageWorkspaceRefs?: string[];
  wait?: boolean;
  contractKey?: string;
  inputs?: string[];
  outputs?: string[];
  mutationPaths?: string[];
}

export interface WaitWorkersRequest {
  /** Worker run ids, display names, or subtask ids. Empty means all background workers. */
  targets?: string[];
  timeoutSeconds?: number;
}

export interface InspectWorkerRequest {
  target: string;
  maxEvents?: number;
}

export interface ExtendWorkerTimeoutRequest {
  target: string;
  additionalSeconds: number;
  reason?: string;
}

interface TokenEntry {
  parentRunId: string;
  workerRunId: string;
}

export class CoordinationIngress {
  private readonly tokens = new Map<string, TokenEntry>();

  constructor(
    private readonly roster: Roster,
    private readonly queue: (message: TeamMessageQueued) => Promise<void>,
    private readonly dispatchSubagent?: (
      request: DispatchSubagentRequest,
    ) => Promise<unknown>,
    private readonly inspectWorker?: (request: InspectWorkerRequest) => Promise<unknown>,
    private readonly extendWorkerTimeout?: (
      request: ExtendWorkerTimeoutRequest,
    ) => Promise<unknown>,
    private readonly waitWorkers?: (request: WaitWorkersRequest) => Promise<unknown>,
  ) {}

  issue(parentRunId: string, workerRunId: string): string {
    const token = randomUUID();
    this.tokens.set(token, { parentRunId, workerRunId });
    return token;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }

  listTeammates(token: string): { workerRunId: string; displayName: string; state: string }[] {
    const entry = this.tokens.get(token);
    if (entry === undefined) throw new Error("UNAUTHORIZED: unknown coordination token");
    return this.roster
      .list()
      .filter((member) => member.workerRunId !== entry.workerRunId)
      .map((member) => ({
        workerRunId: member.workerRunId,
        displayName: member.displayName,
        state: member.state,
      }));
  }

  async submit(token: string, request: SubmitRequest): Promise<TeamMessageQueued> {
    const entry = this.tokens.get(token);
    if (entry === undefined) throw new Error("UNAUTHORIZED: unknown coordination token");

    const recipient = this.roster.resolve(request.to);
    if (recipient === undefined) {
      throw new Error("RECIPIENT_NOT_IN_ROSTER: " + request.to);
    }
    if (recipient.workerRunId === entry.workerRunId) {
      throw new Error("RECIPIENT_IS_SENDER: a worker cannot message itself");
    }
    const content = String(request.content ?? "");
    if (content.trim().length === 0) throw new Error("EMPTY_CONTENT");
    if (content.length > MAX_CONTENT_CHARS) {
      throw new Error(
        "CONTENT_TOO_LONG: " +
          content.length +
          " chars exceeds " +
          MAX_CONTENT_CHARS +
          "; write it to $COMMON_WORKSPACE and send the path instead",
      );
    }
    const workspaceRefs = (request.workspaceRefs ?? []).map(normalizeRef);

    const message: TeamMessageQueued = {
      id: randomUUID(),
      parentRunId: entry.parentRunId,
      // From the token. A request that could name its own sender could
      // impersonate a sibling.
      fromWorkerRunId: entry.workerRunId,
      toWorkerRunId: recipient.workerRunId,
      delivery: request.delivery,
      content,
      workspaceRefs,
      createdAt: new Date().toISOString(),
    };
    // Persisted before the caller is told it was queued.
    await this.queue(message);
    return message;
  }

  async dispatch(token: string, request: DispatchSubagentRequest): Promise<unknown> {
    const entry = this.tokens.get(token);
    if (entry === undefined) throw new Error("UNAUTHORIZED: unknown coordination token");
    if (entry.workerRunId !== entry.parentRunId || this.dispatchSubagent === undefined) {
      throw new Error("DISPATCH_UNAVAILABLE: only the leader can dispatch subagents");
    }
    assertNoForbiddenLeaderKeys(request, "Leader dispatch");
    return await this.dispatchSubagent(request);
  }

  async wait(token: string, request: WaitWorkersRequest): Promise<unknown> {
    const entry = this.tokens.get(token);
    if (entry === undefined) throw new Error("UNAUTHORIZED: unknown coordination token");
    if (entry.workerRunId !== entry.parentRunId || this.waitWorkers === undefined) {
      throw new Error("WAIT_UNAVAILABLE: only the leader can wait for workers");
    }
    return await this.waitWorkers(request);
  }

  async inspect(token: string, request: InspectWorkerRequest): Promise<unknown> {
    const entry = this.tokens.get(token);
    if (entry === undefined) throw new Error("UNAUTHORIZED: unknown coordination token");
    if (entry.workerRunId !== entry.parentRunId || this.inspectWorker === undefined) {
      throw new Error("INSPECT_UNAVAILABLE: only the leader can inspect worker progress");
    }
    return await this.inspectWorker(request);
  }

  async extendTimeout(token: string, request: ExtendWorkerTimeoutRequest): Promise<unknown> {
    const entry = this.tokens.get(token);
    if (entry === undefined) throw new Error("UNAUTHORIZED: unknown coordination token");
    if (entry.workerRunId !== entry.parentRunId || this.extendWorkerTimeout === undefined) {
      throw new Error("EXTEND_TIMEOUT_UNAVAILABLE: only the leader can extend worker timeouts");
    }
    return await this.extendWorkerTimeout(request);
  }
}

/** Refs name shared-workspace paths; anything climbing out of it is refused. */
function normalizeRef(ref: string): string {
  const value = String(ref).replace(/\\/g, "/").replace(/^\/+/, "");
  if (value.split("/").includes("..")) {
    throw new Error("WORKSPACE_REF_ESCAPES: " + ref);
  }
  return value;
}
