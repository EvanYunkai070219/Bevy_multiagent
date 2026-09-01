import { useEffect, useMemo, useState } from "react";
import { AgentParty, orderWorkers, type PartyMember } from "./AgentParty";
import { CreatureSprite } from "./CreatureSprite";
import { creatureOf, type Creature } from "./creatures";
import { PositionedActionMenu } from "./PositionedActionMenu";
import { RenameDialog, type RenameTarget } from "./RenameDialog";
import type { Agent, Project } from "./types";

export interface ProjectsSidebarProps {
  projects: Project[];
  agents: Agent[];
  selectedId: string | null;
  onSelectChat(id: string): void;
  onNewChat(projectId: string): void;
  onCreateProject(): void;
  onOpenProject(): void;
  onNewTemporaryChat(): void;
  onDeleteChat(agent: Agent): void;
  onDeleteProject(project: Project): void;
  onRename?(target: RenameTarget, name: string): Promise<void>;
  /**
   * The squad on the active mission, and the workers not on it. Optional: with
   * no mission running, every leader simply lists the workers it owns.
   */
  party?: PartyMember[];
  bench?: Agent[];
  /** Whose branch the party belongs to; every other leader lists its own. */
  partyLeaderId?: string | null;
  /** Who wears which creature. Absent, each agent falls back to its own hash. */
  cast?: Record<string, Creature>;
}

type MenuTarget =
  | { kind: "chat"; agent: Agent; trigger: HTMLElement }
  | { kind: "project"; project: Project; trigger: HTMLElement };

interface ActiveRename {
  target: RenameTarget;
  trigger: HTMLElement;
}

function isTopLevelChat(agent: Agent): boolean {
  return agent.role !== "worker";
}

/** Everyone the chat has: the agent you talk to, plus the workers it spawned. */
function crew(agent: Agent, workers: Agent[]): Agent[] {
  return [agent, ...workers];
}

function busyCount(agent: Agent, workers: Agent[]): number {
  return crew(agent, workers).filter((member) => member.status === "busy").length;
}

/**
 * Counts only. "3 active" is the number of agents the server reports as busy --
 * not a guess, and not a number that outlives the run that produced it.
 */
function crewSummary(agent: Agent, workers: Agent[]): string {
  const total = crew(agent, workers).length;
  const busy = busyCount(agent, workers);
  const size = total + " agent" + (total === 1 ? "" : "s");
  return busy > 0 ? size + " · " + busy + " active" : size + " · Idle";
}

/**
 * The chat, shown as the creatures in it rather than as a letter in a box.
 *
 * Three at most: past that the row stops being recognisable at a glance, which
 * is the only thing it is for.
 */
function ChatCrew({
  agent,
  workers,
  cast,
}: {
  agent: Agent;
  workers: Agent[];
  cast?: Record<string, Creature>;
}) {
  const everyone = crew(agent, workers);
  const shown = everyone.slice(0, 3);
  // The stack stops at three to stay recognisable, so it says how many it is
  // not showing. Three creatures beside a chat that dispatched nine workers
  // otherwise reads as a chat that has three.
  const hidden = everyone.length - shown.length;
  return (
    <span className="crew">
      {shown.map((member) => (
        <CreatureSprite
          key={member.id}
          creature={creatureOf(member, cast)}
          state={member.status === "busy" ? "working" : "idle"}
          name={member.name}
          size={34}
        />
      ))}
      {hidden > 0 && <span className="crew-more">+{hidden}</span>}
    </span>
  );
}

/**
 * One chat and, beneath it, the workers a leader run delegated to.
 *
 * Workers are not chats — nothing is ever sent to them directly — but they are
 * where a multi-agent run's real work is visible, so they stay reachable from
 * the same place rather than only from inside a leader's transcript.
 */
function ChatBranch({
  agent,
  workers,
  party,
  bench,
  selectedId,
  expanded,
  onToggleWorkers,
  onSelectChat,
  menuOpen,
  onOpenMenu,
  cast,
}: {
  agent: Agent;
  workers: Agent[];
  party: PartyMember[];
  bench: Agent[];
  selectedId: string | null;
  expanded: boolean;
  onToggleWorkers(leaderId: string): void;
  onSelectChat(id: string): void;
  menuOpen: boolean;
  onOpenMenu(agent: Agent, trigger: HTMLElement): void;
  cast?: Record<string, Creature>;
}) {
  return (
    <div className="agent-group">
      <button
        type="button"
        className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => onSelectChat(agent.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenMenu(agent, event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.shiftKey && event.key === "F10") {
            event.preventDefault();
            onOpenMenu(agent, event.currentTarget);
          }
        }}
      >
        <ChatCrew agent={agent} workers={workers} cast={cast} />
        <div className="agent-card-copy">
          {/* The dot rides the name's own line. Tucked under it inside the
              meta row it rendered as a clipped half-circle — a status light
              you could not read is worse than none. */}
          <span className="agent-card-title">
            <strong>{agent.name}</strong>
            <span className={"crew-dot crew-dot--" + (busyCount(agent, workers) > 0 ? "live" : "idle")} />
          </span>
          <span className="agent-card-meta">
            {agent.name.length > 0 && crewSummary(agent, workers)}
          </span>
        </div>
      </button>
      {workers.length > 0 && (
        <>
          <button
            type="button"
            className="worker-toggle"
            aria-expanded={expanded}
            onClick={() => onToggleWorkers(agent.id)}
          >
            <span>{expanded ? "▾" : "▸"}</span>
            {workers.length} worker{workers.length === 1 ? "" : "s"}
          </button>
          {expanded && (
            <AgentParty
              party={party}
              bench={bench}
              selectedId={selectedId}
              onSelect={onSelectChat}
              cast={cast}
            />
          )}
        </>
      )}
    </div>
  );
}

export function ProjectsSidebar({
  projects,
  agents,
  selectedId,
  onSelectChat,
  onNewChat,
  onCreateProject,
  onOpenProject,
  onNewTemporaryChat,
  onDeleteChat,
  onDeleteProject,
  onRename = () => Promise.resolve(),
  party = [],
  bench = [],
  partyLeaderId = null,
  cast,
}: ProjectsSidebarProps) {
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedLeaderIds, setExpandedLeaderIds] = useState<Set<string>>(() => new Set());
  // One menu, two subjects. A project and a chat are deleted the same way and
  // from the same gesture, so they share the surface rather than growing a
  // second popup with its own dismissal rules to keep in step.
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [rename, setRename] = useState<ActiveRename | null>(null);

  const projectIds = useMemo(() => new Set(projects.map((project) => project.id)), [projects]);

  const workersByLeader = useMemo(() => {
    const byLeader = new Map<string, Agent[]>();
    for (const agent of agents) {
      if (agent.role !== "worker" || agent.parentAgentId === null) continue;
      const current = byLeader.get(agent.parentAgentId) ?? [];
      current.push(agent);
      byLeader.set(agent.parentAgentId, current);
    }
    // Dispatch order, so the branch agrees with the party, the bench and the
    // rail instead of inheriting whatever order the store happened to yield.
    for (const [leaderId, list] of byLeader) byLeader.set(leaderId, orderWorkers(list));
    return byLeader;
  }, [agents]);

  // Selecting a leader reveals its workers without a second click, and selecting
  // a worker keeps its own row on screen. Expansion stays in state rather than
  // being derived, so a deliberate collapse survives until the next selection.
  const selectedLeaderId = useMemo(() => {
    const selected = agents.find((agent) => agent.id === selectedId);
    if (selected === undefined) return null;
    return selected.role === "worker" ? selected.parentAgentId : selected.id;
  }, [agents, selectedId]);

  useEffect(() => {
    if (selectedLeaderId === null) return;
    setExpandedLeaderIds((current) =>
      current.has(selectedLeaderId) ? current : new Set(current).add(selectedLeaderId),
    );
  }, [selectedLeaderId]);

  const { chatsByProject, unassignedChats } = useMemo(() => {
    const byProject = new Map<string, Agent[]>();
    const unassigned: Agent[] = [];

    for (const agent of agents) {
      if (!isTopLevelChat(agent)) continue;

      if (agent.projectId !== null && projectIds.has(agent.projectId)) {
        const current = byProject.get(agent.projectId) ?? [];
        current.push(agent);
        byProject.set(agent.projectId, current);
        continue;
      }

      // Everything else is a chat outside Projects. `unassignedPlacement` still
      // records how it got here — deliberately temporary, or left unbound by a
      // migration that refused to guess — because migration reads it back. The
      // distinction is provenance, not behaviour: execution keys off projectId
      // alone, so the navigation does not split it into two sections the reader
      // has to tell apart. Never invent a Project binding.
      unassigned.push(agent);
    }

    return { chatsByProject: byProject, unassignedChats: unassigned };
  }, [agents, projectIds]);

  const toggleWorkers = (leaderId: string): void => {
    setExpandedLeaderIds((current) => {
      const next = new Set(current);
      if (next.has(leaderId)) next.delete(leaderId);
      else next.add(leaderId);
      return next;
    });
  };

  const toggleProject = (projectId: string): void => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  return (
    <>
      <div className="sidebar-actions">
        <button
          type="button"
          className="button button-primary create-button"
          onClick={onCreateProject}
        >
          <span>＋</span> New project
        </button>
        <button
          type="button"
          className="button button-ghost sidebar-secondary"
          onClick={onNewTemporaryChat}
        >
          New chat
        </button>
      </div>

      <div className="sidebar-label">
        <span>Projects</span>
        <span className="sidebar-label-end">
          {projects.length}
          {/* Opening an existing repository lost its row in the action stack.
              It keeps its own affordance here rather than the capability
              disappearing with the button. */}
          <button
            type="button"
            className="label-action"
            onClick={onOpenProject}
            title="Open an existing project"
            aria-label="Open an existing project"
          >
            ⊕
          </button>
        </span>
      </div>

      <nav className="agent-list">
        {projects.map((project) => {
          const chats = chatsByProject.get(project.id) ?? [];
          const collapsed = collapsedProjectIds.has(project.id);
          return (
            <div className="project-group" key={project.id}>
              <div
                className="project-heading"
                onContextMenu={(event) => {
                  event.preventDefault();
                  const trigger =
                    event.currentTarget.querySelector<HTMLButtonElement>(".project-menu-button");
                  if (trigger !== null) setMenu({ kind: "project", project, trigger });
                }}
              >
                <button
                  type="button"
                  className="project-toggle"
                  aria-expanded={!collapsed}
                  aria-label={"Toggle " + project.displayName + " project"}
                  onClick={() => toggleProject(project.id)}
                >
                  <span>{collapsed ? "▸" : "▾"}</span>
                  <strong>{project.displayName}</strong>
                </button>
                <button
                  type="button"
                  className="project-new-chat"
                  onClick={() => onNewChat(project.id)}
                  aria-label={"New chat in " + project.displayName}
                >
                  ＋
                </button>
                {/* A project could be made and never unmade. Right-click works
                    too, but a capability that exists only on a gesture nobody
                    is told about is a capability nobody has. */}
                <button
                  type="button"
                  className="project-menu-button"
                  aria-label={"Actions for " + project.displayName}
                  aria-haspopup="menu"
                  aria-expanded={menu?.kind === "project" && menu.project.id === project.id}
                  onClick={(event) => {
                    const trigger = event.currentTarget;
                    setMenu((current) =>
                      current?.kind === "project" && current.project.id === project.id
                        ? null
                        : { kind: "project", project, trigger },
                    );
                  }}
                >
                  ⋯
                </button>
              </div>
              {!collapsed && (
                <div className="project-chats">
                  {chats.map((chat) => (
                    <ChatBranch
                      key={chat.id}
                      agent={chat}
                      workers={workersByLeader.get(chat.id) ?? []}
                      party={chat.id === partyLeaderId ? party : []}
                      bench={
                        chat.id === partyLeaderId ? bench : workersByLeader.get(chat.id) ?? []
                      }
                      selectedId={selectedId}
                      expanded={expandedLeaderIds.has(chat.id)}
                      onToggleWorkers={toggleWorkers}
                      onSelectChat={onSelectChat}
                      menuOpen={menu?.kind === "chat" && menu.agent.id === chat.id}
                      onOpenMenu={(agent, trigger) =>
                        setMenu((current) =>
                          current?.kind === "chat" && current.agent.id === agent.id
                            ? null
                            : { kind: "chat", agent, trigger },
                        )
                      }
                      cast={cast}
                    />
                  ))}
                  {chats.length === 0 && (
                    <div className="empty-project-chats">No chats yet</div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        <div className="project-group unassigned-group">
          <div className="sidebar-label nested-label">
            <span>Chats</span>
            <span>{unassignedChats.length}</span>
          </div>
          {unassignedChats.map((chat) => (
            <ChatBranch
              key={chat.id}
              agent={chat}
              workers={workersByLeader.get(chat.id) ?? []}
              party={chat.id === partyLeaderId ? party : []}
              bench={chat.id === partyLeaderId ? bench : workersByLeader.get(chat.id) ?? []}
              selectedId={selectedId}
              expanded={expandedLeaderIds.has(chat.id)}
              onToggleWorkers={toggleWorkers}
              onSelectChat={onSelectChat}
              menuOpen={menu?.kind === "chat" && menu.agent.id === chat.id}
              onOpenMenu={(agent, trigger) =>
                setMenu((current) =>
                  current?.kind === "chat" && current.agent.id === agent.id
                    ? null
                    : { kind: "chat", agent, trigger },
                )
              }
              cast={cast}
            />
          ))}
        </div>

        {projects.length === 0 && unassignedChats.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create a project or a chat to get started.
            </div>
          )}
      </nav>

      {menu !== null && (
        <PositionedActionMenu trigger={menu.trigger} onDismiss={() => setMenu(null)}>
          <div className="chat-menu-title">
            {menu.kind === "chat" ? menu.agent.name : menu.project.displayName}
          </div>
          <button
            type="button"
            role="menuitem"
            className="chat-menu-item"
            onClick={() => {
              const current = menu;
              setMenu(null);
              setRename({
                trigger: current.trigger,
                target:
                  current.kind === "chat"
                    ? { kind: "chat", id: current.agent.id, currentName: current.agent.name }
                    : {
                        kind: "project",
                        id: current.project.id,
                        currentName: current.project.displayName,
                      },
              });
            }}
          >
            Edit name
          </button>
          <button
            type="button"
            role="menuitem"
            className="chat-menu-item chat-menu-item--danger"
            onClick={() => {
              const target = menu;
              setMenu(null);
              if (target.kind === "chat") onDeleteChat(target.agent);
              else onDeleteProject(target.project);
            }}
          >
            {menu.kind === "chat" ? "Delete chat" : "Delete project"}
          </button>
        </PositionedActionMenu>
      )}

      {rename !== null && (
        <RenameDialog
          target={rename.target}
          trigger={rename.trigger}
          onClose={() => setRename(null)}
          onRename={onRename}
        />
      )}
    </>
  );
}
