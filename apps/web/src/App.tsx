import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlanPanel, selectPlan } from "./PlanPanel";
import { MarkdownText } from "./MarkdownText";
import { ToolTimeline } from "./ToolTimeline";
import { UsageBadge, UsageSummary } from "./UsageSummary";
import { OperatorMessage, WorkspaceImage, looksLikeImage } from "./WorkspaceFile";
import { RunResult } from "./RunResult";
import { SelectedSkills } from "./SelectedSkills";
import {
  CreateManagedProjectDialog,
  CreateProjectChatDialog,
  OpenExternalProjectDialog,
} from "./ProjectDialogs";
import { ProjectRunSummary } from "./ProjectRunSummary";
import { ProjectsSidebar } from "./ProjectsSidebar";
import type { RenameTarget } from "./RenameDialog";
import { partitionParty } from "./AgentParty";
import { MissionPhases } from "./MissionPhases";
import { WorkerInspector, roleLabel } from "./WorkerInspector";
import { ActiveWorkers } from "./ActiveWorkers";
import { RunArtifacts, collectArtifacts } from "./RunArtifacts";
import { PublishedArtifacts } from "./PublishedArtifacts";
import { AgentMessages } from "./AgentMessages";
import { SkillHub } from "./SkillHub";
import { RunHeader, RunMetadata } from "./RunHeader";
import { buildTranscript } from "./run-history";
import { useSessionEvents } from "./useSessionEvents";
import {
  pickSelection,
  recallLeaderOnly,
  recallPanelHidden,
  recallSelection,
  rememberLeaderOnly,
  rememberPanelHidden,
  rememberSelection,
} from "./selection";
import { assignCreatures } from "./creatures";
import { formatClock } from "./format";
import { EvolutionPanel, shouldLoadEvolution } from "./EvolutionPanel";
import { api, ApiError, setAuthToken } from "./api";
import type {
  Agent,
  AgentRun,
  CreateChatRequest,
  CreateProjectRequest,
  EvolutionProjection,
  Message,
  Project,
  RunEvent,
  SystemInfo,
} from "./types";

type AppDialog =
  | { type: "managed" }
  | { type: "external" }
  | { type: "new-chat"; projectId: string }
  | { type: "temporary" };

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
  role: "standalone" as "standalone" | "leader",
};

const PRODUCT_NAME = "Bevy";
const PRODUCT_MARK = "B";

/** How often the roster is re-read while a run is in flight. See `runLive`. */
const AGENT_SYNC_MS = 2000;

interface RunTraceState {
  cursor: number;
  events: RunEvent[];
}

function mergeEvolutionPages(
  current: EvolutionProjection,
  page: EvolutionProjection,
): EvolutionProjection {
  const mergeById = <T extends { id: string }>(left: T[], right: T[]): T[] =>
    [...new Map([...left, ...right].map((value) => [value.id, value])).values()];
  return {
    ...page,
    primaryFault: current.primaryFault ?? page.primaryFault,
    warningLevel: current.warningLevel === "severe" || page.warningLevel === "severe"
      ? "severe"
      : current.warningLevel ?? page.warningLevel,
    counts: {
      declared: current.counts.declared + page.counts.declared,
      prunedDuplicate: current.counts.prunedDuplicate + page.counts.prunedDuplicate,
      admitted: current.counts.admitted + page.counts.admitted,
      executed: current.counts.executed + page.counts.executed,
      verified: current.counts.verified + page.counts.verified,
      promoted: current.counts.promoted + page.counts.promoted,
      rolledBack: current.counts.rolledBack + page.counts.rolledBack,
      branchPruned: current.counts.branchPruned + page.counts.branchPruned,
      branchReturned: current.counts.branchReturned + page.counts.branchReturned,
      historicalEvidenceUsed: Math.max(
        current.counts.historicalEvidenceUsed,
        page.counts.historicalEvidenceUsed,
      ),
    },
    nodes: mergeById(current.nodes, page.nodes),
    edges: mergeById(current.edges, page.edges),
    observations: mergeById(current.observations, page.observations),
    cues: mergeById(current.cues, page.cues),
    transfers: mergeById(current.transfers, page.transfers),
    capsules: mergeById(current.capsules, page.capsules),
    branchReturns: mergeById(current.branchReturns, page.branchReturns),
    quarantines: mergeById(current.quarantines, page.quarantines),
  };
}

function mergeRunEventPage(
  current: RunTraceState | undefined,
  page: { events: RunEvent[]; lastSeq: number },
): RunTraceState {
  const bySequence = new Map<number, RunEvent>();
  for (const event of current?.events ?? []) bySequence.set(event.seq, event);
  for (const event of page.events) bySequence.set(event.seq, event);
  return {
    cursor: Math.max(current?.cursor ?? 0, page.lastSeq),
    events: [...bySequence.values()].sort((left, right) => left.seq - right.seq),
  };
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function RolePill({ agent }: { agent: Agent }) {
  return (
    <span className="role-pill">
      {agent.role === "leader"
        ? "Leader"
        : agent.role === "worker"
          ? "Worker"
          : "Standalone"}
    </span>
  );
}


export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [dialog, setDialog] = useState<AppDialog | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /**
   * Which destination the main column is showing.
   *
   * A destination, not a toggle. As a boolean only the hub's own button could
   * clear it, so choosing a chat in the sidebar moved the selection under a
   * page that was still the hub -- nothing appeared to happen and only a reload
   * got you out. Anything that opens a chat now names the view it belongs to.
   */
  const [view, setView] = useState<"chats" | "skills">("chats");
  const showSkillHub = view === "skills";
  /** The agent panel is a third of the window; putting it away is a preference. */
  const [panelHidden, setPanelHidden] = useState(recallPanelHidden);
  /**
   * Whether a leader's transcript is narrowed to the leader's own run. The
   * session view is the default; this is for missions with enough workers that
   * what the leader itself decided is hard to pick out of the interleaving.
   */
  const [leaderOnly, setLeaderOnly] = useState(recallLeaderOnly);
  /** The settings panel for whatever is selected. Reseeded on every selection. */
  const [form, setForm] = useState(emptyForm);
  /**
   * The temporary new-chat dialog, which starts blank and stays that way.
   * It used to share `form` with the settings panel above, so the effect that
   * reseeds that panel from `selected` -- and the roster poll that hands it a
   * new object every two seconds -- filled an open dialog in with whichever
   * agent happened to be highlighted.
   */
  const [chatForm, setChatForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<{ path: string; bytes: number }[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  /** Every Run this chat has had, newest first -- the history the picker offers. */
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [evolution, setEvolution] = useState<EvolutionProjection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  /** Which agent the right rail is showing. Workers are inspected, not chatted to. */
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const pendingAutoScrollRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  const runTraces = useRef(new Map<string, RunTraceState>());
  const visibleRunIdRef = useRef<string | null>(null);
  const evolutionRequestRef = useRef<AbortController | null>(null);
  selectedIdRef.current = selectedId;

  // Cast once, here, so every surface draws the same agent as the same
  // creature -- and so a leader and its workers are never the same one twice.
  const cast = useMemo(() => assignCreatures(agents), [agents]);

  const plan = useMemo(() => selectPlan(runEvents), [runEvents]);
  // One expression drives both the extra grid column and the aside itself.
  // Splitting them would leave either an empty third column or an aside with
  // no column to sit in.
  const showRail = plan !== null && plan.length > 0;

  const runLive =
    activeRun !== null &&
    (activeRun.status === "queued" || activeRun.status === "running");

  /**
   * `runs` is a snapshot; `activeRun` is polled. A Run that is still going
   * would otherwise be listed with the status it had when the list was
   * fetched -- "queued", for the whole of its life -- and a Run just started
   * would not be listed at all until the next refresh.
   */
  const runList = useMemo(() => {
    if (activeRun === null) return runs;
    return runs.some((item) => item.id === activeRun.id)
      ? runs.map((item) => (item.id === activeRun.id ? activeRun : item))
      : [activeRun, ...runs];
  }, [runs, activeRun]);

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  // A worker is somewhere you look, not something you talk to: it takes no
  // messages and owns no settings, so its session is the transcript alone.
  const viewingWorker = selected !== null && selected.role === "worker";
  const dispatcher = useMemo(
    () =>
      selected?.parentAgentId == null
        ? null
        : (agents.find((agent) => agent.id === selected.parentAgentId) ?? null),
    [agents, selected?.parentAgentId],
  );

  /**
   * Which mission the view belongs to, as opposed to which agent is selected.
   *
   * A worker is a member of its leader's mission whichever member you happen to
   * be reading. Keying the roster off `selected` meant that opening a worker
   * asked "who are this worker's workers", got none, and emptied the party its
   * leader had -- navigation silently rewriting membership. A worker run
   * carries its leader's run in `parentRunId`, so the mission is already known.
   */
  const missionLeaderId = viewingWorker
    ? (selected?.parentAgentId ?? null)
    : (selected?.id ?? null);
  const missionRunId = viewingWorker
    ? (activeRun?.parentRunId ?? null)
    : (activeRun?.id ?? null);
  const missionRunAgentId = viewingWorker
    ? (dispatcher?.id ?? null)
    : (activeRun?.agentId ?? null);

  const session = useSessionEvents({
    leaderRunId: missionRunId,
    leaderAgentId: missionRunAgentId,
    // Reading a worker, `runEvents` holds that worker's own trace, not the
    // leader's. Folding it in as the leader's stream would attribute the
    // worker's work to whoever ran the mission.
    leaderEvents: viewingWorker ? [] : runEvents,
    agents,
    leaderRunning: runLive,
  });

  /**
   * The mission's own run, when the reader is inside one of its members. It
   * decides whether the party has disbanded, and a worker's run cannot answer
   * that for the mission it belongs to.
   */
  const [missionRun, setMissionRun] = useState<AgentRun | null>(null);
  useEffect(() => {
    if (!viewingWorker || missionRunId === null) {
      setMissionRun(null);
      return;
    }
    let cancelled = false;
    void api
      .run(missionRunId)
      .then((result) => {
        if (!cancelled) setMissionRun(result.run);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [viewingWorker, missionRunId]);

  // A settled mission disbands its party. While it runs, everyone it dispatched
  // stays on screen, finished or not.
  const missionStatus = (viewingWorker ? missionRun : activeRun)?.status ?? null;
  const leaderSettled =
    missionStatus === null ||
    missionStatus === "completed" ||
    missionStatus === "failed" ||
    missionStatus === "cancelled";

  const { party, bench } = useMemo(
    () =>
      partitionParty({
        workers: agents.filter(
          (agent) => agent.role === "worker" && agent.parentAgentId === missionLeaderId,
        ),
        runs: session.runs,
        byRun: session.byRun,
        leaderSettled,
      }),
    [agents, missionLeaderId, session.runs, session.byRun, leaderSettled],
  );

  const inspected = useMemo(
    () => agents.find((agent) => agent.id === inspectedId) ?? null,
    [agents, inspectedId],
  );
  const inspectedRun = session.runs.find((run) => run.agentId === inspectedId);

  // With no worker picked the rail still has a subject: the agent this chat
  // talks to. An empty rail beside a running mission is a wasted column.
  const railAgent = inspected ?? selected;
  // The subject's own run, so the card counts that agent's work rather than
  // showing a column of zeros next to a leader that is plainly busy.
  const railRun = inspected === null ? (activeRun ?? undefined) : inspectedRun;
  const railHasSubject =
    !showSkillHub &&
    railAgent !== null &&
    (showRail || party.length > 0 || activeRun !== null);
  const railOpen = railHasSubject && !panelHidden;

  const togglePanel = (): void => {
    setPanelHidden((current) => {
      rememberPanelHidden(!current);
      return !current;
    });
  };

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) => pickSelection(next, current, recallSelection()));
  }, []);

  const refreshProjects = useCallback(async () => {
    const { projects: next } = await api.listProjects();
    setProjects(next);
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const showRunTrace = (runId: string, agentId: string): void => {
    visibleRunIdRef.current = runId;
    if (selectedIdRef.current === agentId) {
      setRunEvents(runTraces.current.get(runId)?.events ?? []);
    }
  };

  const updateStickToBottom = (): void => {
    const element = messagesRef.current;
    if (!element) return;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 80;
  };

  const scrollMessagesToBottom = (behavior: ScrollBehavior = "auto"): void => {
    const element = messagesRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
  };

  const fetchRunEventPage = async (
    runId: string,
    agentId: string,
  ): Promise<{ advanced: boolean; received: number }> => {
    const current = runTraces.current.get(runId);
    const requestedAfter = current?.cursor ?? 0;
    const page = await api.runEvents(runId, requestedAfter);
    const next = mergeRunEventPage(runTraces.current.get(runId), page);
    runTraces.current.set(runId, next);
    if (
      mountedRef.current &&
      selectedIdRef.current === agentId &&
      visibleRunIdRef.current === runId
    ) {
      setRunEvents(next.events);
    }
    return {
      advanced: next.cursor > requestedAfter,
      received: page.events.length,
    };
  };

  const drainRunEvents = async (runId: string, agentId: string): Promise<void> => {
    while (mountedRef.current) {
      const page = await fetchRunEventPage(runId, agentId);
      if (page.received === 0 || !page.advanced) return;
    }
  };

  const refreshRuns = async (agentId: string): Promise<void> => {
    const result = await api.runs(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) setRuns(result.runs);
  };

  /**
   * Read a different Run of this chat.
   *
   * There is no second code path for a historical Run: the Run id the rest of
   * the app keys off is simply pointed somewhere else, so the transcript,
   * trajectory, worker tree, plan, usage and artifacts all follow. A Run that
   * has already settled is drained page by page -- persisted traces routinely
   * exceed the API's page cap -- and one still in flight is polled like any
   * other live Run.
   */
  const openRun = (runId: string): void => {
    const agentId = selectedIdRef.current;
    if (agentId === null) return;
    const target = runs.find((item) => item.id === runId);
    if (target === undefined || target.id === activeRun?.id) return;
    setActiveRun(target);
    showRunTrace(runId, agentId);
    pendingAutoScrollRef.current = true;
    if (["queued", "running"].includes(target.status)) {
      void pollRun(runId, agentId).catch(() => undefined);
      return;
    }
    void drainRunEvents(runId, agentId).catch(() => undefined);
  };

  const bootstrap = useCallback(async () => {
    await Promise.all([
      refreshAgents(),
      refreshProjects(),
      api.system().then(setSystem),
    ]);
  }, [refreshAgents, refreshProjects]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    // Only a real selection is written down. `selectedId` is null on mount --
    // the roster has not loaded yet -- and clearing storage there erased the id
    // that `refreshAgents` was about to restore from, one tick later. The rules
    // in selection.ts were correct; nothing ever reached them, so every reload
    // silently fell through to "first non-worker chat".
    if (selectedId !== null) rememberSelection(selectedId);
    setActiveRun(null);
    setRuns([]);
    setAttachments([]);
    visibleRunIdRef.current = null;
    setRunEvents([]);
    pendingAutoScrollRef.current = true;
    stickToBottomRef.current = true;
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        setRuns(result.runs);
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (!latest) return;
        showRunTrace(latest.id, selectedId);
        if (["queued", "running"].includes(latest.status)) {
          // Selection hydration is independent of the background-poller lock.
          // This matters when switching back to a Run already being polled.
          void fetchRunEventPage(latest.id, selectedId).catch(() => undefined);
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
          return;
        }
        // Persisted terminal traces may exceed the API's 500-event page cap.
        // Drain synchronously page-by-page without adding another timer.
        void drainRunEvents(latest.id, selectedId).catch(() => undefined);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  /**
   * Keep the roster live while a mission is.
   *
   * A leader mints, names and renames its workers mid-run, but `refreshAgents`
   * otherwise only ran at startup and once a run settled. So a worker dispatched
   * a minute ago stayed invisible, and one the leader had since named kept its
   * placeholder, until the operator reloaded the page. `pickSelection` keeps
   * whatever is open open, so this can never move the reader.
   */
  useEffect(() => {
    if (!runLive) return;
    const timer = window.setInterval(() => {
      void refreshAgents().catch(() => undefined);
    }, AGENT_SYNC_MS);
    return () => window.clearInterval(timer);
  }, [runLive, refreshAgents]);

  useEffect(() => {
    evolutionRequestRef.current?.abort();
    evolutionRequestRef.current = null;
    setEvolution(null);
    const run = activeRun;
    if (run === null || !shouldLoadEvolution(run, false)) return;
    let cancelled = false;
    let timer: number | undefined;
    const live = ["queued", "running"].includes(run.status);
    const load = async (): Promise<void> => {
      const controller = new AbortController();
      evolutionRequestRef.current?.abort();
      evolutionRequestRef.current = controller;
      try {
        const response = await api.run(run.id, {
          includeEvolution: true,
          limit: 100,
          depth: 4,
          signal: controller.signal,
        });
        if (!cancelled && !controller.signal.aborted && visibleRunIdRef.current === run.id) {
          setEvolution(response.evolution ?? null);
        }
      } catch (reason) {
        if (!cancelled && !controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        if (evolutionRequestRef.current === controller) evolutionRequestRef.current = null;
        if (!cancelled && live) timer = window.setTimeout(() => void load(), 2_000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      evolutionRequestRef.current?.abort();
      evolutionRequestRef.current = null;
    };
  }, [activeRun?.id, activeRun?.status]);

  const showMoreEvolution = async (): Promise<void> => {
    if (activeRun === null || evolution?.nextCursor === null || evolution === null) return;
    evolutionRequestRef.current?.abort();
    const controller = new AbortController();
    evolutionRequestRef.current = controller;
    try {
      const response = await api.run(activeRun.id, {
        includeEvolution: true,
        after: evolution.nextCursor,
        limit: 100,
        depth: 4,
        signal: controller.signal,
      });
      if (!controller.signal.aborted && response.evolution && visibleRunIdRef.current === activeRun.id) {
        setEvolution((current) => current === null ? response.evolution! : mergeEvolutionPages(current, response.evolution!));
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
        role: selected.role === "leader" ? "leader" : "standalone",
      });
    }
  }, [selected]);

  /**
   * The active Run's messages leave the flat history and take their real
   * positions: the prompt opens the Run, anything said afterwards belongs
   * inside the activity where it was said, and the answer closes it.
   */
  const transcript = useMemo(
    () =>
      buildTranscript({
        messages,
        runs: runList,
        viewedRunId: activeRun?.id ?? null,
      }),
    [messages, runList, activeRun?.id],
  );

  useEffect(() => {
    if (pendingAutoScrollRef.current || stickToBottomRef.current) {
      pendingAutoScrollRef.current = false;
      requestAnimationFrame(() => scrollMessagesToBottom("auto"));
    }
  }, [
    messages.length,
    runEvents.length,
    // The whole-session stream loads and grows on its own polling loop.
    // Without it here, entering a session scrolled to the bottom of a page
    // that was still short — then hundreds of events arrived, stretched the
    // transcript, and left the reader parked at the oldest step.
    session.ordered.length,
    activeRun?.id,
    activeRun?.status,
    activeRun?.orchestration?.phase,
    activeRun?.orchestration?.workerResults.length,
    activeRun?.orchestration?.evaluationRecords.length,
  ]);

  const createTemporaryChat = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(chatForm);
      await refreshAgents();
      setSelectedId(agent.id);
      setDialog(null);
      setChatForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const createManagedProject = async (
    body: Extract<CreateProjectRequest, { kind: "managed" }>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.createProject(body);
      await refreshProjects();
      setDialog({ type: "new-chat", projectId: project.id });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const openExternalProject = async (
    body: Extract<CreateProjectRequest, { kind: "external" }>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.createProject(body);
      await refreshProjects();
      setDialog({ type: "new-chat", projectId: project.id });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const createProjectChat = async (projectId: string, body: CreateChatRequest) => {
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createProjectChat(projectId, body);
      await refreshAgents();
      setSelectedId(agent.id);
      setDialog(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, {
        name: form.name,
        description: form.description,
        instructions: form.instructions,
      });
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Put a file into the Agent's workspace and tell the Agent where it went.
   *
   * The Agent cannot see the operator's disk, so an attachment is only useful
   * once it exists in the workspace under a path the prompt can name. The path
   * is appended to the prompt for exactly that reason.
   */
  const attachFile = async (file: File): Promise<void> => {
    if (!selected) return;
    setUploading(true);
    setError(null);
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read " + file.name));
        reader.onload = () => {
          const result = String(reader.result ?? "");
          resolve(result.slice(result.indexOf(",") + 1));
        };
        reader.readAsDataURL(file);
      });
      const { file: written } = await api.uploadWorkspaceFile(
        selected.id,
        file.name,
        contentBase64,
      );
      setAttachments((current) => [...current, written]);
      setPrompt((current) =>
        current.trimEnd().length === 0
          ? written.path + "\n"
          : current.trimEnd() + "\n" + written.path + "\n",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setUploading(false);
    }
  };

  const deleteAgent = async (target: Agent | null = selected) => {
    if (!target) return;
    if (!window.confirm("Delete " + target.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(target.id);
      if (target.id === selectedId) setSelectedId(null);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const renameSidebarTarget = async (target: RenameTarget, name: string): Promise<void> => {
    if (target.kind === "chat") {
      const renamed = await api.renameChat(target.id, name);
      setAgents((current) =>
        current.map((agent) => (agent.id === target.id ? renamed : agent)),
      );
      return;
    }

    const renamed = await api.renameProject(target.id, name);
    setProjects((current) =>
      current.map((project) => (project.id === target.id ? renamed : project)),
    );
  };

  /**
   * Delete a project, and say what goes with it before it does.
   *
   * The chats inside a project cannot outlive it -- they resolve their
   * workspace through it -- so the confirmation names how many are about to go
   * rather than letting the count be a surprise. An external project's own
   * repository is never touched; only a repository this system created is.
   */
  const deleteProject = async (project: Project) => {
    const chats = agents.filter((agent) => agent.projectId === project.id).length;
    const consequence =
      chats === 0
        ? ""
        : " Its " + chats + " chat" + (chats === 1 ? "" : "s") + " will be deleted too.";
    if (!window.confirm("Delete " + project.displayName + "?" + consequence)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteProject(project.id);
      await Promise.all([refreshProjects(), refreshAgents()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        // The trace is supporting detail: if it fails to load, the run status
        // still has to get through.
        const [result] = await Promise.all([
          api.run(runId),
          fetchRunEventPage(runId, agentId).catch(() => null),
        ]);
        if (
          selectedIdRef.current === agentId &&
          visibleRunIdRef.current === runId
        ) {
          setActiveRun(result.run);
        }
        if (!["queued", "running"].includes(result.run.status)) {
          // The page fetched alongside the terminal status is already merged.
          // Continue from its per-Run cursor until the backlog is exhausted.
          await drainRunEvents(runId, agentId).catch(() => undefined);
          await Promise.all([
            refreshMessages(agentId),
            refreshAgents(),
            refreshRuns(agentId).catch(() => undefined),
          ]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setAttachments([]);
    setError(null);
    pendingAutoScrollRef.current = true;
    stickToBottomRef.current = true;
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
        if (activeRun?.id !== result.run.id) {
          runTraces.current.delete(result.run.id);
        }
        showRunTrace(result.run.id, selected.id);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * Nobody types a worker's brief. A dispatched worker's opening message is
   * stored with role "user" because that is the slot a run's prompt occupies,
   * and rendering it as "You" told the operator they had said something they
   * never said. On a worker it is the leader speaking.
   */
  const speakerOf = (message: Message): string => {
    if (message.role === "assistant") return selected?.name ?? "Agent";
    if (viewingWorker) return dispatcher?.name ?? "Leader";
    return "You";
  };

  const renderMessage = (message: Message) => (
    <article
      className={
        "message message-" + message.role + (viewingWorker && message.role === "user" ? " message-brief" : "")
      }
      key={message.id}
    >
      <div className="message-meta">
        <strong>{speakerOf(message)}</strong>
        <span>{formatClock(message.createdAt)}</span>
      </div>
      {message.role === "assistant" ? (
        <MarkdownText className="message-body markdown-body">{message.content}</MarkdownText>
      ) : selected === null || viewingWorker ? (
        <MarkdownText className="message-body markdown-body">{message.content}</MarkdownText>
      ) : (
        <OperatorMessage agentId={selected.id} content={message.content} />
      )}
    </article>
  );

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">{PRODUCT_MARK}</div>
          <span className="eyebrow">{PRODUCT_NAME}</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">{PRODUCT_MARK}</div>
          <span className="eyebrow">{PRODUCT_NAME}</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open " + PRODUCT_NAME}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div
      className={"app-shell app-shell--with-nav" + (railOpen ? " app-shell--with-rail" : "")}
    >
      {/* Destinations first, then the list that belongs to the one you picked.
          The rail is what the app is; the panel is what is in it. */}
      <nav className="nav-rail" aria-label="Sections">
        <div className="brand-mark">{PRODUCT_MARK}</div>
        <button
          type="button"
          className={"nav-rail-item" + (view === "chats" ? " nav-rail-item--active" : "")}
          {...(view === "chats" ? { "aria-current": "page" as const } : {})}
          onClick={() => setView("chats")}
        >
          <span className="nav-rail-glyph" aria-hidden="true">◧</span>
          Chats
        </button>
        <button
          type="button"
          className={"nav-rail-item" + (view === "skills" ? " nav-rail-item--active" : "")}
          {...(view === "skills" ? { "aria-current": "page" as const } : {})}
          onClick={() => setView("skills")}
        >
          <span className="nav-rail-glyph" aria-hidden="true">◆</span>
          Skills
        </button>
      </nav>

      <aside className="sidebar">
        <div className="brand">
          <div>
            <strong>{PRODUCT_NAME}</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <ProjectsSidebar
          projects={projects}
          agents={agents}
          selectedId={selectedId}
          onSelectChat={(id) => {
            // Picking a chat IS picking the chats view.
            setView("chats");
            // A worker opens as a session of its own now. Nothing is ever sent
            // to one, so it opens read-only -- but a rail card summarising six
            // counters was never an answer to "what did this worker actually
            // do", and its transcript, its trajectory and its usage are the
            // same data the leader's session already renders.
            setInspectedId(null);
            setSelectedId(id);
          }}
          onNewChat={(projectId) => {
            setDialog({ type: "new-chat", projectId });
          }}
          onCreateProject={() => {
            setDialog({ type: "managed" });
          }}
          onOpenProject={() => {
            setDialog({ type: "external" });
          }}
          party={party}
          bench={bench}
          partyLeaderId={missionLeaderId}
          cast={cast}
          onDeleteChat={(agent) => void deleteAgent(agent)}
          onDeleteProject={(project) => void deleteProject(project)}
          onRename={renameSidebarTarget}
          onNewTemporaryChat={() => {
            setChatForm(emptyForm);
            setDialog({ type: "temporary" });
          }}
        />

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {showSkillHub ? (
          <SkillHub onClose={() => setView("chats")} />
        ) : selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                  <RolePill agent={selected} />
                </div>
                <p>
                  {viewingWorker
                    ? roleLabel(selected) +
                      (dispatcher === null ? "" : " · dispatched by " + dispatcher.name)
                    : selected.description ||
                      "A Codex coding Agent in an isolated workspace."}
                </p>
              </div>
              <div className="header-actions">
                {/* A worker owns almost none of these: it has no instructions
                    of its own to edit, stopping it mid-mission strands the
                    leader waiting on it, and deleting it would delete the
                    record of what the mission did. What it does own is a
                    process — the panel toggle stays, or putting the panel away
                    on a worker's page locked the reader out of it. */}
                {viewingWorker ? (
                  <>
                    {railHasSubject && (
                      <button
                        className={"button button-ghost" + (railOpen ? " button-on" : "")}
                        onClick={togglePanel}
                        aria-pressed={railOpen}
                      >
                        Process
                      </button>
                    )}
                    {dispatcher !== null && (
                      <button
                        className="button button-ghost button-warn"
                        onClick={() => setSelectedId(dispatcher.id)}
                      >
                        ← {dispatcher.name}
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    {/* The panel used to be opened by a handle pinned to the
                        window edge and closed by a button inside itself, so
                        using the control moved it. Opening lives here, with the
                        other things you can do to this chat; closing lives on
                        the panel, which is the thing being closed. */}
                    {railHasSubject && (
                      <button
                        className={"button button-ghost" + (railOpen ? " button-on" : "")}
                        onClick={togglePanel}
                        aria-pressed={railOpen}
                      >
                        Process
                      </button>
                    )}
                    <button
                      className="button button-ghost"
                      onClick={() => setShowSettings((value) => !value)}
                      disabled={busy || selected.status === "busy"}
                    >
                      Settings
                    </button>
                    <button
                      className="button button-ghost"
                      onClick={toggleAgent}
                      disabled={busy}
                    >
                      {selected.status === "stopped" ? "Start" : "Stop"}
                    </button>
                    <button
                      className="button button-danger"
                      onClick={() => void deleteAgent()}
                      disabled={busy || selected.status === "busy"}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">{viewingWorker ? "Worker session" : "Playground"}</span>
                  <h2>
                    {viewingWorker
                      ? "What " + selected.name + " did"
                      : "Build something with your Agent"}
                  </h2>
                </div>
                <div className="playground-status">
                  <UsageBadge events={runEvents} pricing={system?.pricing ?? null} />
                  <div className="session-info">
                    <span className="pulse" />
                    {selected.codexThreadId ? "Session connected" : "New session"}
                  </div>
                </div>
              </div>

              <div
                className="messages"
                ref={messagesRef}
                onScroll={updateStickToBottom}
              >
                {messages.length === 0 && !activeRun && viewingWorker ? (
                  <div className="welcome">
                    <h3>{selected.name} has not run yet.</h3>
                    <p>
                      A worker only runs when its leader dispatches it. Its
                      transcript appears here once it does.
                    </p>
                  </div>
                ) : messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  /* Runs in the order they happened, each opening with its own
                     header. Every boundary is drawn, not just the one around
                     the Run being read -- eight messages under a single header
                     is what made the order look wrong. */
                  transcript.rows.map((row) =>
                    row.kind === "run" ? (
                      <RunHeader
                        key={"run-" + row.run.id}
                        runs={runList}
                        run={row.run}
                        position={row.position}
                        total={row.total}
                        sessionName={selected.name}
                        onSelect={openRun}
                        pickable={row.run.id === activeRun?.id}
                      />
                    ) : (
                      renderMessage(row.message)
                    ),
                  )
                )}
                {/* Nobody typed a worker's brief, so no user message carries it
                    -- the run's prompt is the only record of what this worker
                    was sent to do, and without it its transcript opens on work
                    with no stated goal. */}
                {viewingWorker && activeRun !== null && transcript.rows.every((row) => row.kind === "run") && (
                  <article className="message message-user">
                    <div className="message-meta">
                      <strong>{dispatcher?.name ?? "Leader"}</strong>
                      <span>{formatClock(activeRun.createdAt)}</span>
                    </div>
                    <MarkdownText className="message-body markdown-body">
                      {activeRun.prompt}
                    </MarkdownText>
                  </article>
                )}
                {/* The work and what was said about it, in order. This is the
                    transcript, so it is not behind a fold. */}
                {!viewingWorker && session.runs.length > 0 && (
                  <div className="transcript-scope" role="group" aria-label="Transcript scope">
                    <button
                      type="button"
                      className={"scope-option" + (leaderOnly ? "" : " selected")}
                      aria-pressed={!leaderOnly}
                      onClick={() => {
                        setLeaderOnly(false);
                        rememberLeaderOnly(false);
                      }}
                    >
                      Whole session
                    </button>
                    <button
                      type="button"
                      className={"scope-option" + (leaderOnly ? " selected" : "")}
                      aria-pressed={leaderOnly}
                      onClick={() => {
                        setLeaderOnly(true);
                        rememberLeaderOnly(true);
                      }}
                    >
                      Leader only
                    </button>
                  </div>
                )}
                <ToolTimeline
                  events={
                    viewingWorker || leaderOnly
                      ? runEvents
                      : session.ordered.map((row) => row.event)
                  }
                  actorOf={(event) => session.actors[event.runId] ?? null}
                  steers={transcript.steers}
                  answerShownSeparately={transcript.answer !== null}
                  {...(activeRun ? { runStatus: activeRun.status } : {})}
                  failureReason={activeRun?.error ?? null}
                  agentId={selected.id}
                />
                <RunResult
                  answer={transcript.answer}
                  events={runEvents}
                  failed={activeRun?.status === "failed"}
                  agentId={selected.id}
                />
                <RunMetadata
                  events={session.ordered.map((row) => row.event)}
                  artifactCount={
                    collectArtifacts(session.ordered.map((row) => row.event)).length
                  }
                />
                <SelectedSkills plans={activeRun?.orchestration?.skillRouting} />
                <UsageSummary
                  events={runEvents}
                  pricing={system?.pricing ?? null}
                />
                {activeRun?.project && <ProjectRunSummary project={activeRun.project} />}
                {evolution && (
                  <EvolutionPanel runId={activeRun?.id} evolution={evolution} onShowMore={() => void showMoreEvolution()} />
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
              </div>

              {viewingWorker ? (
                /* A composer here would be a lie: the API takes no message for
                   a worker, and the leader is the only thing that can give one
                   more work. */
                <div className="composer composer--readonly">
                  <span>
                    Workers take their instructions from their leader, not from
                    here.
                  </span>
                  {dispatcher !== null && (
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() => setSelectedId(dispatcher.id)}
                    >
                      Open {dispatcher.name}
                    </button>
                  )}
                </div>
              ) : (
              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : selected.status === "busy"
                        ? "Steer this Agent while it is running…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={selected.status === "stopped"}
                  rows={3}
                />
                {attachments.length > 0 && (
                  <div className="composer-attachments">
                    {attachments.map((file) => (
                      <span className="composer-attachment" key={file.path}>
                        {looksLikeImage(file.path) && (
                          <WorkspaceImage
                            agentId={selected.id}
                            path={file.path}
                            alt={file.path}
                          />
                        )}
                        <span className="composer-attachment-name">
                          {file.path.split("/").pop()}
                        </span>
                        <button
                          type="button"
                          className="composer-attachment-remove"
                          aria-label={"Remove " + file.path}
                          onClick={() => {
                            setAttachments((current) =>
                              current.filter((item) => item.path !== file.path),
                            );
                            // The prompt carries the path; removing the chip has
                            // to remove the line, or the Agent still goes looking.
                            setPrompt((current) =>
                              current
                                .split("\n")
                                .filter((line) => line.trim() !== file.path)
                                .join("\n"),
                            );
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="composer-footer">
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="composer-file-input"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      // Reset first: choosing the same file twice must still fire.
                      event.target.value = "";
                      if (file) void attachFile(file);
                    }}
                  />
                  <button
                    type="button"
                    className="composer-attach"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || selected.status === "stopped"}
                    aria-label="Attach a file to the workspace"
                    title="Attach a file to the workspace"
                  >
                    {uploading ? "…" : "+"}
                  </button>
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  {/* While a Run is in flight the send control IS the stop
                      control: the button under the reader's hand does the thing
                      the moment asks for, rather than sending them to a header
                      three panels away. */}
                  {activeRun && ["queued", "running"].includes(activeRun.status) ? (
                    <button
                      type="button"
                      className="send-button send-button--stop"
                      onClick={() => void toggleAgent()}
                      disabled={busy}
                      aria-label="Stop run"
                      title="Stop run"
                    >
                      <span className="send-button-square" aria-hidden="true" />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      disabled={!prompt.trim() || selected.status === "stopped"}
                      aria-label="Send message"
                    >
                      ↑
                    </button>
                  )}
                </div>
              </form>
              )}
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">{PRODUCT_MARK}</div>
            <span className="eyebrow">{PRODUCT_NAME}</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setChatForm(emptyForm);
                setDialog({ type: "temporary" });
              }}
            >
              New chat
            </button>
          </div>
        )}
      </main>

      {/* Keep the panel control in one viewport position: moving it with the
          panel made the same action jump away from the reader's pointer. */}
      {railHasSubject && (
        <button
          type="button"
          className="panel-control"
          onClick={togglePanel}
          aria-label={panelHidden ? "Show the agent panel" : "Hide the agent panel"}
          title={panelHidden ? "Show the agent panel" : "Hide the agent panel"}
        >
          <span aria-hidden="true">{panelHidden ? "←" : "→"}</span>
        </button>
      )}
      {railOpen && (
        <aside className="rail" aria-label="Agent panel">
          <div className="rail-head" aria-hidden="true" />
          {railAgent !== null && (
            <WorkerInspector
              agent={railAgent}
              events={railRun === undefined ? [] : (session.byRun[railRun.id] ?? [])}
              {...(railRun === undefined ? {} : { runStatus: railRun.status })}
              cast={cast}
            />
          )}
          <ActiveWorkers
            party={party}
            selectedId={inspectedId}
            onSelect={(id) => setInspectedId((current) => (current === id ? null : id))}
            cast={cast}
          />
          {/* The session's chatroom: everything every agent said over `talk`,
              not just the inspected one's own mail. Folded shut, and a mission
              where nobody spoke shows nothing here at all. */}
          {missionRunId !== null && (
            <AgentMessages
              // The team journal is built per LEADER run — a worker's own run
              // has no journal, so the chatroom always reads the mission's.
              leaderRunId={missionRunId}
              running={runLive}
            />
          )}
          {/* Structural integration and repair evolution now render with the
              run's own details in the transcript column (moved there on main);
              rendering them here too would show every record twice. */}
          {/* What the mission produced, from every agent on it -- a leader's
              answer routinely points at a file a worker wrote. */}
          <RunArtifacts events={session.ordered.map((row) => row.event)} />
          {/* And what an agent published on purpose, which is a different and
              usually shorter list than everything it wrote. */}
          {activeRun !== null && (
            <PublishedArtifacts
              runId={activeRun.id}
              running={runLive}
              // A worker answers for its own output; the leader is the mission.
              {...(viewingWorker ? { ownerRunId: activeRun.id } : {})}
            />
          )}
          {plan !== null && plan.length > 0 && <PlanPanel todos={plan} />}
          {activeRun?.orchestration != null && (
            <MissionPhases phase={activeRun.orchestration.phase} />
          )}
          {/* Decoration, and the only thing here that is not read off a run.
              It fills the space under the cards rather than leaving the column
              half empty, and it is hidden from assistive tech because it says
              nothing. */}
          <div className="rail-mascot" aria-hidden="true">
            <img src="/creatures/sloth.png" alt="" />
          </div>
        </aside>
      )}

      {dialog?.type === "managed" && (
        <CreateManagedProjectDialog
          busy={busy}
          error={error}
          onClose={() => setDialog(null)}
          onCreateManaged={(body) => void createManagedProject(body)}
        />
      )}

      {dialog?.type === "external" && (
        <OpenExternalProjectDialog
          busy={busy}
          error={error}
          onClose={() => setDialog(null)}
          onOpenExternal={(body) => void openExternalProject(body)}
        />
      )}

      {dialog?.type === "new-chat" && (
        <CreateProjectChatDialog
          projectId={dialog.projectId}
          busy={busy}
          error={error}
          takenNames={agents.map((agent) => agent.name)}
          onClearError={() => setError(null)}
          onClose={() => setDialog(null)}
          onCreateChat={(projectId, body) => void createProjectChat(projectId, body)}
        />
      )}

      {dialog?.type === "temporary" && (
        <div className="modal-backdrop" onMouseDown={() => setDialog(null)}>
          <form
            className="modal"
            onSubmit={createTemporaryChat}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">Temporary</span>
                <h2>New chat</h2>
                <p>Uses an ephemeral workspace outside Projects.</p>
              </div>
              <button type="button" onClick={() => setDialog(null)}>
                ×
              </button>
            </div>
            <label>
              Role
              <select
                value={chatForm.role}
                onChange={(event) =>
                  setChatForm({
                    ...chatForm,
                    role: event.target.value as "standalone" | "leader",
                  })
                }
              >
                <option value="standalone">Standalone</option>
                <option value="leader">Leader</option>
              </select>
            </label>
            <label>
              Name
              <input
                autoFocus
                placeholder="Scratch research"
                value={chatForm.name}
                onChange={(event) => setChatForm({ ...chatForm, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Optional summary"
                value={chatForm.description}
                onChange={(event) =>
                  setChatForm({ ...chatForm, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={chatForm.instructions}
                onChange={(event) =>
                  setChatForm({ ...chatForm, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create chat"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
