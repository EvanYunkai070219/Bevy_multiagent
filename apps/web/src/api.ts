import type {
  Agent,
  AgentRun,
  CreateChatRequest,
  CreateProjectRequest,
  Message,
  Project,
  PublishedArtifact,
  RunEvent,
  SkillDetail,
  SkillSummary,
  RunResponse,
  SystemInfo,
  CoordinationView,
  ProjectRecord,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

/**
 * Workspace bytes, fetched rather than linked.
 *
 * Authorisation is a header, so an `<img src>` pointing at the API would arrive
 * unauthenticated the moment a bearer token is configured — and putting the
 * token in the query string would write it into history and logs.
 */
async function fetchBlob(url: string): Promise<Blob> {
  const response = await fetch(url, {
    headers: authToken ? { Authorization: "Bearer " + authToken } : {},
  });
  if (!response.ok) {
    throw new ApiError("Could not read that file", response.status);
  }
  return await response.blob();
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  workspaceFile: (agentId: string, filePath: string) =>
    fetchBlob(
      "/api/agents/" + agentId + "/files?path=" + encodeURIComponent(filePath),
    ),
  uploadWorkspaceFile: (agentId: string, name: string, contentBase64: string) =>
    request<{ file: { path: string; bytes: number } }>(
      "/api/agents/" + agentId + "/files",
      { method: "POST", body: JSON.stringify({ name, contentBase64 }) },
    ),
  system: () => request<SystemInfo>("/api/system"),
  listProjects: () => request<{ projects: Project[] }>("/api/projects"),
  createProject: (body: CreateProjectRequest) =>
    request<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteProject: (projectId: string) =>
    request<{ deletedChats: number; removedRepository: boolean }>(
      "/api/projects/" + projectId,
      { method: "DELETE" },
    ),
  createProjectChat: (projectId: string, body: CreateChatRequest) =>
    request<{ agent: Agent }>("/api/projects/" + projectId + "/chats", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
    role?: "standalone" | "leader";
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  renameChat: async (id: string, name: string): Promise<Agent> =>
    (await request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    })).agent,
  renameProject: async (id: string, displayName: string): Promise<ProjectRecord> =>
    (await request<{ project: ProjectRecord }>("/api/projects/" + id, {
      method: "PATCH",
      body: JSON.stringify({ displayName }),
    })).project,
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (
    id: string,
    evolution?: {
      includeEvolution: true;
      after?: string | null;
      limit?: number;
      depth?: number;
      signal?: AbortSignal;
    },
  ) => {
    const query = evolution === undefined
      ? ""
      : "?" + new URLSearchParams({
          includeEvolution: "true",
          ...(evolution.after ? { evolutionAfter: evolution.after } : {}),
          evolutionLimit: String(evolution.limit ?? 100),
          evolutionDepth: String(evolution.depth ?? 4),
        }).toString();
    return request<RunResponse>(
      "/api/runs/" + id + query,
      evolution?.signal === undefined ? undefined : { signal: evolution.signal },
    );
  },
  children: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/runs/" + id + "/children"),
  coordination: (id: string) =>
    request<CoordinationView>("/api/runs/" + id + "/coordination"),
  runArtifacts: (id: string) =>
    request<{ artifacts: PublishedArtifact[] }>("/api/runs/" + id + "/artifacts"),
  runArtifact: (id: string, artifactId: string) =>
    request<{ artifact: PublishedArtifact; text: string }>(
      "/api/runs/" + id + "/artifacts/" + artifactId,
    ),
  skills: () => request<{ skills: SkillSummary[] }>("/api/skills"),
  skill: (name: string, version?: string) =>
    request<{ skill: SkillDetail }>(
      "/api/skills/" +
        encodeURIComponent(name) +
        (version === undefined ? "" : "?version=" + encodeURIComponent(version)),
    ),
  runEvents: (id: string, after: number) =>
    request<{ events: RunEvent[]; lastSeq: number; complete: boolean }>(
      "/api/runs/" + id + "/events?after=" + after,
    ),
};
