// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import App from "./App";
import { api } from "./api";
import {
  CreateManagedProjectDialog,
  CreateProjectChatDialog,
  nameConflict,
  OpenExternalProjectDialog,
} from "./ProjectDialogs";
import { ProjectRunSummary } from "./ProjectRunSummary";
import type { ProjectRunRecord } from "./types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const agent = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Builder",
  description: "Builds projects",
  instructions: "Build carefully",
  status: "ready" as const,
  role: "leader" as const,
  parentAgentId: null,
  specialty: null,
  projectId: PROJECT_ID,
  unassignedPlacement: null,
  workspacePath: "/runtime/agents/builder",
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
};

const project = {
  id: PROJECT_ID,
  displayName: "CodeJam",
  sourceKind: "external" as const,
  repositoryPath: "/Users/me/repos/CodeJam",
  baselineBranch: "launchpad/project/codejam",
  baselineCommit: "a".repeat(40),
  state: "ready" as const,
  lastError: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
};

const sampleRun = {
  id: "22222222-2222-4222-8222-222222222222",
  agentId: agent.id,
  projectId: PROJECT_ID,
  kind: "orchestration" as const,
  parentRunId: null,
  orchestration: {
    phase: "completed",
    outcome: {
      value: "succeeded" as const,
      reason: "All checks passed",
      evidence: ["tests green"],
    },
    iteration: 1,
    iterationPlans: [],
    evaluationRecords: [],
    workerResults: [],
    provenance: { harnessVersion: "test" },
  },
  project: {
    source: {
      mode: "existing_repository" as const,
      repositoryPath: "/Users/me/repos/CodeJam",
      requestedRevision: "HEAD",
      baseCommit: "a".repeat(40),
      sourceFingerprint: "fp",
    },
    runBranch: "launchpad/run/run-1",
    canonicalWorkspacePath: "/runtime/run-1/canonical",
    headCommit: "b".repeat(40),
    state: "completed" as const,
    attempts: [],
    integrations: [],
  },
  status: "completed" as const,
  prompt: "build it",
  output: "done",
  error: null,
  usage: null,
  createdAt: "2026-08-28T00:00:01.000Z",
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

type AppAgentFixture = Omit<typeof agent, "status"> & {
  status: "ready" | "busy" | "stopped" | "error";
};
type AppRunFixture = Omit<typeof sampleRun, "status" | "output"> & {
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  output: string | null;
};

function installAppFetch({
  appAgent = agent,
  appRun = sampleRun,
  appMessages = [],
}: {
  appAgent?: AppAgentFixture;
  appRun?: AppRunFixture;
  appMessages?: unknown[];
} = {}): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/auth") return response({ required: false });
    if (url === "/api/system") {
      return response({
        arkConfigured: true,
        arkBaseUrl: "http://ark.invalid",
        arkModel: "test-model",
        codexAvailable: true,
        codexSandboxMode: "workspace-write",
        runtimeProvider: "container",
        containerEngine: "docker",
        runtime: "test-runtime",
        pricing: null,
      });
    }
    if (url === "/api/agents") return response({ agents: [appAgent] });
    if (url === "/api/projects") return response({ projects: [project] });
    if (url === `/api/agents/${agent.id}` && init?.method === "PATCH") {
      return response({ agent: { ...appAgent, name: "Authoritative chat name" } });
    }
    if (url === `/api/projects/${project.id}` && init?.method === "PATCH") {
      return response({ project: { ...project, displayName: "Authoritative project name" } });
    }
    if (url === `/api/agents/${agent.id}/messages` && init?.method === "POST") {
      return response(
        {
          run: appRun,
          message: {
            id: "33333333-3333-4333-8333-333333333333",
            agentId: agent.id,
            runId: appRun.id,
            role: "user",
            content: "build it",
            createdAt: "2026-08-28T00:00:01.000Z",
          },
        },
        202,
      );
    }
    if (url === `/api/agents/${agent.id}/messages`) return response({ messages: appMessages });
    if (url === `/api/agents/${agent.id}/runs`) return response({ runs: [appRun] });
    if (url.includes("/coordination")) {
      return response({ messages: [], undeliverableCount: 0 });
    }
    if (url.includes("/children")) {
      return response({ runs: [] });
    }
    if (url.includes("/events")) {
      return response({
        events: [
          {
            seq: 1,
            kind: "turn",
            usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 0 },
          },
        ],
        lastSeq: 1,
        complete: true,
      });
    }
    if (url.includes("/api/runs/")) {
      return response({
        run: appRun,
        events: [],
        lastSeq: 0,
        complete: true,
      });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function installScrollStubs(): void {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
}

describe("ProjectDialogs", () => {
  it("submits managed project creation with display name only", async () => {
    const user = userEvent.setup();
    const onCreateManaged = vi.fn();
    const onClose = vi.fn();

    render(
      <CreateManagedProjectDialog
        busy={false}
        onClose={onClose}
        onCreateManaged={onCreateManaged}
      />,
    );

    await user.type(screen.getByLabelText(/display name/i), "Todo Flow");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    expect(onCreateManaged).toHaveBeenCalledWith({
      kind: "managed",
      displayName: "Todo Flow",
    });
  });

  it("submits external project opening with path and HEAD revision", async () => {
    const user = userEvent.setup();
    const onOpenExternal = vi.fn();

    render(
      <OpenExternalProjectDialog
        busy={false}
        onClose={() => undefined}
        onOpenExternal={onOpenExternal}
      />,
    );

    await user.type(screen.getByLabelText(/display name/i), "CodeJam");
    await user.type(
      screen.getByLabelText(/folder path|repository path/i),
      "/Users/me/repos/CodeJam",
    );
    await user.click(screen.getByRole("button", { name: /open project/i }));

    expect(onOpenExternal).toHaveBeenCalledWith({
      kind: "external",
      displayName: "CodeJam",
      repositoryPath: "/Users/me/repos/CodeJam",
      revision: "HEAD",
    });
  });

  it("submits new chat with title and empty optional fields", async () => {
    const user = userEvent.setup();
    const onCreateChat = vi.fn();

    render(
      <CreateProjectChatDialog
        projectId={PROJECT_ID}
        busy={false}
        onClose={() => undefined}
        onCreateChat={onCreateChat}
      />,
    );

    await user.type(screen.getByLabelText(/title|name/i), "Fix project outcome persistence");
    await user.click(screen.getByRole("button", { name: /create chat|new chat/i }));

    expect(onCreateChat).toHaveBeenCalledWith(PROJECT_ID, {
      name: "Fix project outcome persistence",
      description: "",
      instructions: "",
      role: "standalone",
    });
  });

  it("stacks title and role controls in shared labelled fields without changing details", async () => {
    const user = userEvent.setup();

    render(
      <CreateProjectChatDialog
        projectId={PROJECT_ID}
        busy={false}
        onClose={() => undefined}
        onCreateChat={() => undefined}
      />,
    );

    const title = screen.getByLabelText("Title");
    const role = screen.getByLabelText("Role");
    const fields = Array.from(document.querySelectorAll(".dialog-field"));
    const titleField = fields.find((field) => field.contains(title));
    const roleField = fields.find((field) => field.contains(role));

    expect(titleField?.querySelector("label")?.htmlFor).toBe(title.id);
    expect(roleField?.querySelector("label")?.htmlFor).toBe(role.id);
    expect(titleField?.contains(role)).toBe(false);
    expect(roleField).toBeTruthy();
    expect(screen.queryByLabelText("Description")).toBeNull();
    expect(screen.queryByLabelText("Instructions")).toBeNull();

    await user.click(screen.getByRole("button", { name: "More options" }));

    expect(screen.getByLabelText("Description")).toBeTruthy();
    expect(screen.getByLabelText("Instructions")).toBeTruthy();
  });

  it("lets a project chat be created as a leader", async () => {
    // The role was previously never sent, so the server default silently made
    // every Project chat a leader and the choice could not be expressed at all.
    const user = userEvent.setup();
    const onCreateChat = vi.fn();

    render(
      <CreateProjectChatDialog
        projectId={PROJECT_ID}
        busy={false}
        onClose={() => undefined}
        onCreateChat={onCreateChat}
      />,
    );

    await user.type(screen.getByLabelText(/title|name/i), "Coordinate the rollout");
    await user.selectOptions(screen.getByLabelText(/role/i), "leader");
    await user.click(screen.getByRole("button", { name: /create chat|new chat/i }));

    expect(onCreateChat).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ role: "leader" }),
    );
  });
});

describe("App composer without per-message source", () => {
  it("sends exactly { content } and omits source labels from the composer", async () => {
    const fetch = installAppFetch();
    installScrollStubs();
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("button", { name: /builder/i });

    const composer = document.querySelector(".composer") as HTMLElement;
    expect(composer).toBeTruthy();
    const composerScope = within(composer);
    expect(composer.textContent ?? "").not.toMatch(
      /new_project|existing_repository|ephemeral_research/,
    );
    expect(composerScope.queryByLabelText("Workspace source")).toBeNull();
    expect(composerScope.queryByText("New project")).toBeNull();
    expect(composerScope.queryByText("Existing repository")).toBeNull();
    expect(composerScope.queryByText("Ephemeral research")).toBeNull();

    await user.type(
      screen.getByPlaceholderText("Describe what you want the Agent to do…"),
      "build it",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url) === `/api/agents/${agent.id}/messages` && init?.method === "POST",
        ),
      ).toBe(true);
    });

    const [, init] = fetch.mock.calls.find(
      ([url, options]) =>
        String(url) === `/api/agents/${agent.id}/messages` && options?.method === "POST",
    ) as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ content: "build it" });
  });

  it("keeps the main chat panel structure for a selected chat", async () => {
    installAppFetch();
    installScrollStubs();
    render(<App />);

    await screen.findByRole("heading", { name: "Builder" });
    const main = document.querySelector("main.main");
    expect(main).toBeTruthy();
    const scope = within(main as HTMLElement);

    expect(scope.getByText("ready")).toBeTruthy();
    expect(scope.getByRole("button", { name: /settings/i })).toBeTruthy();
    expect(document.querySelector(".messages")).toBeTruthy();
    expect(document.querySelector(".composer")).toBeTruthy();
    // Run metadata remains out of the transcript, while the active Project's
    // structural integration record is deliberately shown below it.
    await waitFor(() => {
      expect(document.querySelector(".usage-summary")).toBeTruthy();
    });
    expect(scope.queryByText("Orchestration")).toBeNull();
    expect(scope.queryByText("Task outcome")).toBeNull();
    expect(scope.getByText("Structural integration")).toBeTruthy();
  });
});

describe("App rename state", () => {
  it("uses authoritative chat and project responses without moving the selected chat", async () => {
    const user = userEvent.setup();
    const runningAgent: AppAgentFixture = { ...agent, status: "busy" };
    const runningRun: AppRunFixture = { ...sampleRun, status: "running", output: null };
    const persistentMessage = {
      id: "44444444-4444-4444-8444-444444444444",
      agentId: agent.id,
      runId: sampleRun.id,
      role: "assistant",
      content: "Persistent transcript content",
      createdAt: "2026-08-28T00:00:02.000Z",
    };
    const fetch = installAppFetch({
      appAgent: runningAgent,
      appRun: runningRun,
      appMessages: [persistentMessage],
    });
    installScrollStubs();
    render(<App />);

    await screen.findByRole("heading", { name: "Builder" });
    await screen.findByText("Persistent transcript content");
    await waitFor(() => expect(document.querySelector(".usage-summary")).toBeTruthy());
    const sidebar = document.querySelector("aside.sidebar") as HTMLElement;
    const sidebarScope = within(sidebar);
    const main = document.querySelector("main.main") as HTMLElement;
    const mainScope = within(main);
    const messages = document.querySelector(".messages");
    const runHeader = document.querySelector(".run-header");
    const runStatus = document.querySelector(".run-status--running");
    const usageSummary = document.querySelector(".usage-summary");
    expect(mainScope.getByText("busy")).toBeTruthy();
    expect(runStatus?.textContent).toContain("running");
    expect(runHeader?.textContent).toContain("Run 1 of 1");
    const stateRequestCount = () =>
      fetch.mock.calls.filter(([url, init]) => {
        const value = String(url);
        return init?.method !== "POST" &&
          (value === `/api/agents/${agent.id}/messages` ||
            value === `/api/agents/${agent.id}/runs`);
      }).length;
    const requestsBeforeRename = stateRequestCount();

    const chatTrigger = sidebarScope.getByRole("button", { name: /builder/i });
    await user.pointer({ keys: "[MouseRight]", target: chatTrigger });
    await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Edit name" }));
    const chatInput = screen.getByRole("textbox", { name: "Chat name" });
    await user.clear(chatInput);
    await user.type(chatInput, "Client chat name");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    await screen.findByRole("heading", { name: "Authoritative chat name", level: 1 });
    expect(sidebarScope.getByText("Authoritative chat name")).toBeTruthy();
    expect(document.querySelector(".messages")).toBe(messages);
    expect(document.querySelector(".run-header")).toBe(runHeader);
    expect(document.querySelector(".run-status--running")).toBe(runStatus);
    expect(document.querySelector(".usage-summary")).toBe(usageSummary);
    expect(screen.getByText("Persistent transcript content")).toBeTruthy();
    expect(stateRequestCount()).toBe(requestsBeforeRename);

    const projectTrigger = sidebarScope.getByRole("button", { name: "Actions for CodeJam" });
    await user.click(projectTrigger);
    await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Edit name" }));
    const projectInput = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(projectInput);
    await user.type(projectInput, "Client project name");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => {
      expect(sidebarScope.getByText("Authoritative project name")).toBeTruthy();
    });
    expect(
      screen.getByRole("heading", { name: "Authoritative chat name", level: 1 }),
    ).toBeTruthy();
    expect(document.querySelector(".messages")).toBe(messages);
    expect(document.querySelector(".run-header")).toBe(runHeader);
    expect(document.querySelector(".run-status--running")).toBe(runStatus);
    expect(document.querySelector(".usage-summary")).toBe(usageSummary);
    expect(stateRequestCount()).toBe(requestsBeforeRename);

    const patchBodies = fetch.mock.calls
      .filter(([, init]) => init?.method === "PATCH")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(patchBodies).toEqual([
      { name: "Client chat name" },
      { displayName: "Client project name" },
    ]);
  });
});

describe("message source serialization", () => {
  it("sends only content on the wire", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ run: {}, message: {} }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await api.sendMessage("agent-1", "build it");

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      content: "build it",
    });
    expect(String(init.body)).not.toMatch(/workspaceSource|ownerToken|terminalPublicationIntent/);
  });
});

describe("ProjectRunSummary", () => {
  it("reports only actual structural integrations, failure reasons, and preserved attempts", () => {
    const projectRecord: ProjectRunRecord = {
      source: {
        mode: "existing_repository",
        repositoryPath: "/srv/repos/example",
        requestedRevision: "main",
        baseCommit: "a".repeat(40),
        sourceFingerprint: "source-fingerprint",
      },
      runBranch: "launchpad/run/run-1",
      canonicalWorkspacePath: "/runtime/run-1/canonical",
      headCommit: "b".repeat(40),
      state: "failed",
      attempts: [
        {
          attemptId: "attempt-1",
          revision: 1,
          subtaskId: "backend",
          baseCommit: "a".repeat(40),
          workspacePath: "/runtime/run-1/attempt-1",
          state: "failed",
          cleanup: "preserved",
          headCommit: "c".repeat(40),
          reason: "kept for conflict inspection",
        },
      ],
      integrations: [
        {
          contributionId: "contribution-1",
          subtaskId: "frontend",
          canonicalHeadBefore: "a".repeat(40),
          canonicalHeadAfter: "b".repeat(40),
          state: "integrated",
          structuralDecision: "passed",
          reason: null,
        },
        {
          contributionId: "contribution-2",
          subtaskId: "backend",
          canonicalHeadBefore: "b".repeat(40),
          canonicalHeadAfter: null,
          state: "conflicted",
          structuralDecision: "failed",
          reason: "merge conflict in api.ts",
        },
      ],
    };

    const html = renderToStaticMarkup(<ProjectRunSummary project={projectRecord} />);

    expect(html).toContain("launchpad/run/run-1");
    expect(html).toContain("Structural integration");
    expect(html).toContain("1 commit integrated");
    expect(html).toContain("merge conflict in api.ts");
    expect(html).toContain("1 attempt preserved");
    expect(html).toContain("kept for conflict inspection");
    expect(html).not.toMatch(/trusted|held-out|healed|promoted/i);
  });
});

describe("name conflicts", () => {
  it("names the chat that already holds the name, and says the scope", () => {
    const message = nameConflict("bug-3", ["Other", "bug-3"]);
    expect(message).toContain('"bug-3"');
    expect(message).toContain("globally");
    expect(message).toContain("across every project");
  });

  it("matches regardless of case and surrounding space", () => {
    expect(nameConflict("  BUG-3 ", ["bug-3"])).not.toBeNull();
  });

  it("says nothing about an empty or free name", () => {
    expect(nameConflict("", ["bug-3"])).toBeNull();
    expect(nameConflict("bug-4", ["bug-3"])).toBeNull();
  });

  it("refuses to submit a taken name and shows why in the dialog", async () => {
    const onCreateChat = vi.fn();
    render(
      <CreateProjectChatDialog
        projectId="p1"
        busy={false}
        takenNames={["bug-3"]}
        onClose={() => undefined}
        onCreateChat={onCreateChat}
      />,
    );
    const title = screen.getByLabelText(/title/i);
    await userEvent.type(title, "bug-3");

    const describedBy = title.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? "")?.textContent).toMatch(
      /"bug-3".*globally.*across every project/i,
    );
    expect(screen.getByRole("textbox", { name: "Title" })).toBe(title);
    expect(screen.queryByLabelText("Loading")).toBeNull();

    const submit = screen.getByRole("button", { name: /create chat/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(submit);
    expect(onCreateChat).not.toHaveBeenCalled();
  });

  it("clears a server fallback after the title is edited", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [error, setError] = useState<string | null>(null);
      return (
        <CreateProjectChatDialog
          projectId="p1"
          busy={false}
          error={error}
          onClearError={() => setError(null)}
          onClose={() => undefined}
          onCreateChat={() =>
            setError(
              'The name "bug-3" is already in use. Names are shared globally across every project.',
            )
          }
        />
      );
    }

    render(<Harness />);
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.type(title, "bug-3");
    await user.click(screen.getByRole("button", { name: /create chat/i }));
    expect(screen.getByRole("alert").textContent).toContain('"bug-3"');

    await user.clear(title);
    await user.type(title, "bug-4");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

/**
 * "What is the purpose of revision?"
 *
 * It answers "which commit of this repository do you want opened", and almost
 * nobody wants anything but the one already checked out. As a top-level field
 * beside the folder path it read as a required decision, in vocabulary the
 * form never explained. It keeps working; it just stops asking.
 */
describe("the revision field", () => {
  it("is not one of the questions the form asks", async () => {
    render(
      <OpenExternalProjectDialog busy={false} onClose={() => undefined} onOpenExternal={() => undefined} />,
    );
    // `details` keeps its content in the DOM while closed, so what is asserted
    // is the fold: the field is not among the things being asked for.
    const fold = screen.getByText(/advanced/i).closest("details") as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(fold.contains(screen.getByLabelText(/revision/i))).toBe(true);
  });

  it("opens HEAD without being asked", async () => {
    const onOpenExternal = vi.fn();
    const user = userEvent.setup();
    render(
      <OpenExternalProjectDialog busy={false} onClose={() => undefined} onOpenExternal={onOpenExternal} />,
    );
    await user.type(screen.getByLabelText(/name|title/i), "CodeJam");
    await user.type(screen.getByLabelText(/folder path/i), "/Users/me/repos/CodeJam");
    await user.click(screen.getByRole("button", { name: /open project/i }));
    expect(onOpenExternal).toHaveBeenCalledWith(expect.objectContaining({ revision: "HEAD" }));
  });

  it("is still there for whoever needs it, and says what it is for", async () => {
    const user = userEvent.setup();
    render(
      <OpenExternalProjectDialog busy={false} onClose={() => undefined} onOpenExternal={() => undefined} />,
    );
    await user.click(screen.getByText(/advanced/i));
    const field = screen.getByLabelText(/revision/i);
    expect(field).toBeTruthy();
    expect(screen.getByText(/branch, tag or commit/i)).toBeTruthy();
  });

  it("sends the revision the operator chose", async () => {
    const onOpenExternal = vi.fn();
    const user = userEvent.setup();
    render(
      <OpenExternalProjectDialog busy={false} onClose={() => undefined} onOpenExternal={onOpenExternal} />,
    );
    await user.type(screen.getByLabelText(/name|title/i), "CodeJam");
    await user.type(screen.getByLabelText(/folder path/i), "/Users/me/repos/CodeJam");
    await user.click(screen.getByText(/advanced/i));
    await user.type(screen.getByLabelText(/revision/i), "release-2.0");
    await user.click(screen.getByRole("button", { name: /open project/i }));
    expect(onOpenExternal).toHaveBeenCalledWith(expect.objectContaining({ revision: "release-2.0" }));
  });
});
