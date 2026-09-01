// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectsSidebar } from "./ProjectsSidebar";
import type { RenameTarget } from "./RenameDialog";
import type { Agent, Project } from "./types";

afterEach(() => {
  cleanup();
});

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_PROJECT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CHAT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEMP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PREV_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const WORKER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const project: Project = {
  id: PROJECT_ID,
  displayName: "CodeJam",
  sourceKind: "external",
  repositoryPath: "/Users/me/repos/CodeJam",
  baselineBranch: "launchpad/project/codejam",
  baselineCommit: "a".repeat(40),
  state: "ready",
  lastError: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
};

const otherProject: Project = {
  id: OTHER_PROJECT_ID,
  displayName: "OtherRepo",
  sourceKind: "managed",
  repositoryPath: "/workspaces/projects/other",
  baselineBranch: "launchpad/project/other",
  baselineCommit: "b".repeat(40),
  state: "ready",
  lastError: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
};

function agent(partial: Partial<Agent> & Pick<Agent, "id" | "name">): Agent {
  return {
    description: "",
    instructions: "",
    status: "ready",
    role: "standalone",
    parentAgentId: null,
    specialty: null,
    projectId: null,
    unassignedPlacement: null,
    workspacePath: "/runtime/agents/" + partial.id,
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...partial,
  };
}

const agents: Agent[] = [
  agent({
    id: CHAT_ID,
    name: "Fix project outcome",
    projectId: PROJECT_ID,
    role: "leader",
  }),
  agent({
    id: TEMP_ID,
    name: "Scratch research",
    unassignedPlacement: "temporary",
  }),
  agent({
    id: PREV_ID,
    name: "Legacy ambiguous chat",
    unassignedPlacement: "previous",
  }),
  agent({
    id: WORKER_ID,
    name: "backend-worker",
    role: "worker",
    parentAgentId: CHAT_ID,
    specialty: "backend",
    projectId: PROJECT_ID,
  }),
];

describe("ProjectsSidebar", () => {
  it("groups project chats and everything outside a project while workers stay collapsed", async () => {
    const user = userEvent.setup();
    const onSelectChat = vi.fn();

    render(
      <ProjectsSidebar
        projects={[project, otherProject]}
        agents={agents}
        selectedId={null}
        onSelectChat={onSelectChat}
        onNewChat={() => undefined}
        onCreateProject={() => undefined}
        onOpenProject={() => undefined}
        onNewTemporaryChat={() => undefined}
        onDeleteChat={() => undefined}
        onDeleteProject={() => undefined}
      />,
    );

    expect(screen.getByText("CodeJam")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Toggle CodeJam project" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /fix project outcome/i })).toBeTruthy();
    // One bucket for everything outside a Project: how a chat came to be
    // unassigned is provenance the reader should not have to adjudicate.
    expect(screen.getByText("Chats")).toBeTruthy();
    expect(screen.queryByText("Temporary chats")).toBeNull();
    expect(screen.queryByText("Previous chats")).toBeNull();
    // Collapsed, not hidden: the leader advertises the count and holds the rows.
    expect(screen.queryByText("backend-worker")).toBeNull();
    expect(screen.getByRole("button", { name: /1 worker$/ })).toBeTruthy();

    const codeJamGroup = screen.getByText("CodeJam").closest(".project-group");
    expect(codeJamGroup).toBeTruthy();
    expect(
      within(codeJamGroup as HTMLElement).getByRole("button", {
        name: /fix project outcome/i,
      }),
    ).toBeTruthy();

    const otherGroup = screen.getByText("OtherRepo").closest(".project-group");
    expect(otherGroup).toBeTruthy();
    expect(
      within(otherGroup as HTMLElement).queryByRole("button", {
        name: /fix project outcome/i,
      }),
    ).toBeNull();

    const chatsGroup = screen.getByText("Chats").closest(".project-group");
    expect(chatsGroup).toBeTruthy();
    expect(
      within(chatsGroup as HTMLElement).getByRole("button", {
        name: /scratch research/i,
      }),
    ).toBeTruthy();
    expect(
      within(chatsGroup as HTMLElement).getByRole("button", {
        name: /legacy ambiguous chat/i,
      }),
    ).toBeTruthy();
    // A Project chat is still owned by its Project and never doubles up here.
    expect(
      within(chatsGroup as HTMLElement).queryByRole("button", {
        name: /fix project outcome/i,
      }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: /fix project outcome/i }));
    expect(onSelectChat).toHaveBeenCalledWith(CHAT_ID);
  });

  it("reveals a leader's workers without a second click when it is selected", () => {
    render(
      <ProjectsSidebar
        projects={[project, otherProject]}
        agents={agents}
        selectedId={CHAT_ID}
        onSelectChat={() => undefined}
        onNewChat={() => undefined}
        onCreateProject={() => undefined}
        onOpenProject={() => undefined}
        onNewTemporaryChat={() => undefined}
        onDeleteChat={() => undefined}
        onDeleteProject={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: /backend-worker/i })).toBeTruthy();
  });

  it("keeps a selected worker on screen by expanding the leader that owns it", () => {
    // A worker is reachable by id — a restored selection, a deep link — while
    // never appearing as a top-level chat. Its row still has to be visible, or
    // the transcript on the right belongs to nothing the navigation admits to.
    render(
      <ProjectsSidebar
        projects={[project, otherProject]}
        agents={agents}
        selectedId={WORKER_ID}
        onSelectChat={() => undefined}
        onNewChat={() => undefined}
        onCreateProject={() => undefined}
        onOpenProject={() => undefined}
        onNewTemporaryChat={() => undefined}
        onDeleteChat={() => undefined}
        onDeleteProject={() => undefined}
      />,
    );

    const worker = screen.getByRole("button", { name: /backend-worker/i });
    expect(worker.className).toContain("selected");
  });

  it("toggles workers by hand and reports the state to assistive tech", async () => {
    const user = userEvent.setup();
    render(
      <ProjectsSidebar
        projects={[project, otherProject]}
        agents={agents}
        selectedId={null}
        onSelectChat={() => undefined}
        onNewChat={() => undefined}
        onCreateProject={() => undefined}
        onOpenProject={() => undefined}
        onNewTemporaryChat={() => undefined}
        onDeleteChat={() => undefined}
        onDeleteProject={() => undefined}
      />,
    );

    const toggle = screen.getByRole("button", { name: /1 worker$/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /backend-worker/i })).toBeTruthy();

    await user.click(toggle);
    expect(screen.queryByRole("button", { name: /backend-worker/i })).toBeNull();
  });

  it("offers delete on the row itself, aimed at the row that was right-clicked", async () => {
    // Deleting used to require selecting a chat and crossing to a header button
    // three panels away, which named nothing and could act on the wrong row.
    const user = userEvent.setup();
    const onDeleteChat = vi.fn();

    render(
      <ProjectsSidebar
        projects={[project, otherProject]}
        agents={agents}
        selectedId={null}
        onSelectChat={() => undefined}
        onNewChat={() => undefined}
        onCreateProject={() => undefined}
        onOpenProject={() => undefined}
        onNewTemporaryChat={() => undefined}
        onDeleteChat={onDeleteChat}
        onDeleteProject={() => undefined}
      />,
    );

    expect(screen.queryByRole("menu")).toBeNull();

    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByRole("button", { name: /legacy ambiguous chat/i }),
    });

    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Legacy ambiguous chat")).toBeTruthy();

    await user.click(within(menu).getByRole("menuitem", { name: /delete chat/i }));
    expect(onDeleteChat).toHaveBeenCalledTimes(1);
    expect(onDeleteChat.mock.calls[0]?.[0]?.id).toBe(PREV_ID);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the row menu on Escape without deleting anything", async () => {
    const user = userEvent.setup();
    const onDeleteChat = vi.fn();

    render(
      <ProjectsSidebar
        projects={[project, otherProject]}
        agents={agents}
        selectedId={null}
        onSelectChat={() => undefined}
        onNewChat={() => undefined}
        onCreateProject={() => undefined}
        onOpenProject={() => undefined}
        onNewTemporaryChat={() => undefined}
        onDeleteChat={onDeleteChat}
        onDeleteProject={() => undefined}
      />,
    );

    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByRole("button", { name: /scratch research/i }),
    });
    expect(screen.getByRole("menu")).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onDeleteChat).not.toHaveBeenCalled();
  });
});

describe("deleting a project", () => {
  function renderSidebar(onDeleteProject: (project: Project) => void) {
    render(
      <ProjectsSidebar
        projects={[project, otherProject]}
        agents={agents}
        selectedId={null}
        onSelectChat={() => undefined}
        onNewChat={() => undefined}
        onCreateProject={() => undefined}
        onOpenProject={() => undefined}
        onNewTemporaryChat={() => undefined}
        onDeleteChat={() => undefined}
        onDeleteProject={onDeleteProject}
      />,
    );
  }

  it("offers it from a button on the project row, not only a hidden gesture", async () => {
    const user = userEvent.setup();
    const onDeleteProject = vi.fn();
    renderSidebar(onDeleteProject);

    await user.click(screen.getByRole("button", { name: /actions for CodeJam/i }));

    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("CodeJam")).toBeTruthy();
    await user.click(within(menu).getByRole("menuitem", { name: /delete project/i }));

    expect(onDeleteProject).toHaveBeenCalledTimes(1);
    expect(onDeleteProject.mock.calls[0]?.[0]?.id).toBe(PROJECT_ID);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("aims at the project that was right-clicked", async () => {
    const user = userEvent.setup();
    const onDeleteProject = vi.fn();
    renderSidebar(onDeleteProject);

    await user.pointer({
      keys: "[MouseRight]",
      // The toggle, not the "+ new chat" or the actions button beside it.
      target: screen.getByRole("button", { name: /OtherRepo/, expanded: true }),
    });
    await user.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: /delete project/i }),
    );

    expect(onDeleteProject.mock.calls[0]?.[0]?.id).toBe(OTHER_PROJECT_ID);
  });

  it("still deletes a chat, not its project, from a chat row", async () => {
    const user = userEvent.setup();
    const onDeleteProject = vi.fn();
    renderSidebar(onDeleteProject);

    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByRole("button", { name: /scratch research/i }),
    });
    expect(
      within(screen.getByRole("menu")).queryByRole("menuitem", { name: /delete project/i }),
    ).toBeNull();
    expect(onDeleteProject).not.toHaveBeenCalled();
  });
});

describe("renaming from sidebar menus", () => {
  function renderSidebar(onRename: (target: RenameTarget, name: string) => Promise<void>) {
    render(
      <ProjectsSidebar
        projects={[project, otherProject]}
        agents={agents}
        selectedId={CHAT_ID}
        onSelectChat={() => undefined}
        onNewChat={() => undefined}
        onCreateProject={() => undefined}
        onOpenProject={() => undefined}
        onNewTemporaryChat={() => undefined}
        onDeleteChat={() => undefined}
        onDeleteProject={() => undefined}
        onRename={onRename}
      />,
    );
  }

  it("puts Edit name above the distinct project delete action and returns focus", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn(async () => undefined);
    renderSidebar(onRename);

    const trigger = screen.getByRole("button", { name: "Actions for CodeJam" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const menu = screen.getByRole("menu");
    expect(
      within(menu).getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Edit name", "Delete project"]);

    await user.click(within(menu).getByRole("menuitem", { name: "Edit name" }));
    const input = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(input);
    await user.type(input, "Renamed project");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    expect(onRename).toHaveBeenCalledWith(
      { kind: "project", id: PROJECT_ID, currentName: "CodeJam" },
      "Renamed project",
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("offers the same ordered actions for a chat while keeping chat delete targeted", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn(async () => undefined);
    renderSidebar(onRename);

    const chatTrigger = screen.getByRole("button", { name: /scratch research/i });
    expect(chatTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(chatTrigger.getAttribute("aria-haspopup")).toBe("menu");
    await user.pointer({ keys: "[MouseRight]", target: chatTrigger });
    expect(chatTrigger.getAttribute("aria-expanded")).toBe("true");

    const menu = screen.getByRole("menu");
    expect(
      within(menu).getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Edit name", "Delete chat"]);

    await user.click(within(menu).getByRole("menuitem", { name: "Edit name" }));
    const input = screen.getByRole("textbox", { name: "Chat name" });
    await user.clear(input);
    await user.type(input, "Renamed chat");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    expect(onRename).toHaveBeenCalledWith(
      { kind: "chat", id: TEMP_ID, currentName: "Scratch research" },
      "Renamed chat",
    );
  });

  it("anchors a bare project-heading context menu to the focusable actions button", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn(async () => undefined);
    renderSidebar(onRename);
    const heading = screen.getByText("CodeJam").closest(".project-heading") as HTMLElement;
    const trigger = screen.getByRole("button", { name: "Actions for CodeJam" });

    fireEvent.contextMenu(heading);
    await user.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "Edit name" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(document.activeElement).toBe(trigger);
  });
});
