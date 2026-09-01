/**
 * The work a Run did, told as a transcript rather than a table.
 *
 * What the agent SAYS is the spine. The work it did between two things it said
 * collapses to one line — "6 thoughts · 5 tool calls" — and opens into a flat
 * list of steps, each a sentence about what happened rather than the name of an
 * event type. Only an opened step gets a card, so the page is never boxes
 * inside boxes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CreatureSprite } from "./CreatureSprite";
import { creatureStateOf } from "./creature-state";
import { MarkdownText } from "./MarkdownText";
import { moveFor, talkOf, type TalkMessage } from "./moves";
import { describedRole } from "./WorkerInspector";
import type { Actor } from "./useSessionEvents";
import type { Message, RunEvent, RunStatus } from "./types";

const HIDDEN_KINDS = new Set(["run", "turn"]);

// Codex reports setup diagnostics -- unknown model metadata, for example -- as
// an item at the start of every turn. They repeat verbatim and are not user
// activity, so the GUI hides them while the JSONL log still preserves them.
const DIAGNOSTIC_CODE = "codex_diagnostic";

/** Lines shown before a long block is folded. Enough to see what happened. */
const CLAMP_LINES = 12;

const GLYPH: Record<string, string> = {
  reasoning: "✳",
  command: "❯",
  mcp_tool: "⌘",
  api_call: "◇",
  file_change: "✎",
  web_search: "⌕",
  delegation: "⇢",
  todo: "☰",
};

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "";
  if (durationMs < 1000) return durationMs + "ms";
  return (durationMs / 1000).toFixed(1) + "s";
}

// Reads only canonical fields. `attributes` is provider-specific and must not
// be consumed by logic — see the normalisation contract in the design doc.
function subject(event: RunEvent): string {
  return (
    event.input.command ??
    event.input.tool ??
    event.input.paths?.join(", ") ??
    event.output.changedFiles?.join(", ") ??
    event.input.text ??
    event.name
  );
}

/**
 * A sentence, not a type name. "command" told the reader what kind of row they
 * were looking at; "Ran ./build.sh" tells them what the Run did.
 */
export function stepLabel(event: RunEvent, settled = false): string {
  // A span still open on a settled run is not running -- nothing is. It was cut
  // off, so it gets the past tense rather than "Running…" forever.
  const running = event.status === "in_progress" && !settled;
  switch (event.kind) {
    case "reasoning":
      return running ? "Thinking…" : "Thought";
    case "command":
      return (running ? "Running " : "Ran ") + subject(event);
    case "mcp_tool":
      return (running ? "Calling " : "Called ") + event.name;
    case "api_call":
      return running ? "Waiting on the model" : "Model call";
    case "file_change":
      return "Changed " + subject(event);
    case "web_search":
      return "Searched " + subject(event);
    case "todo":
      return "Updated the plan";
    case "message":
      return "Reported";
    case "delegation":
      return (running ? "Dispatching " : "Dispatched ") + subject(event);
    case "error":
      return event.error?.message ?? "Error";
    default:
      return event.name;
  }
}

function conversationText(event: RunEvent): string {
  return event.output.text ?? event.input.text ?? "";
}

function isBlankReasoning(event: RunEvent): boolean {
  return event.kind === "reasoning" && conversationText(event).trim().length === 0;
}

function StepGlyph({ event, settled }: { event: RunEvent; settled: boolean }) {
  if (event.status === "in_progress") {
    // The spinner is a claim that work is happening. Once the run has stopped
    // that claim is false, and an open span means the step was cut off -- so it
    // gets a mark that says unfinished instead of one that says wait.
    if (settled) {
      return (
        <span className="step-glyph step-glyph--stalled" aria-hidden="true">
          ⋯
        </span>
      );
    }
    return <span className="step-glyph step-glyph--pending" aria-hidden="true" />;
  }
  if (event.status === "error") {
    return (
      <span className="step-glyph step-glyph--error" aria-hidden="true">
        !
      </span>
    );
  }
  return (
    <span className="step-glyph" aria-hidden="true">
      {GLYPH[event.kind] ?? "·"}
    </span>
  );
}

/**
 * A command that prints a thousand lines should not push the rest of the run
 * off the screen. Folding is by line count rather than by measured height, so
 * what the reader gets is the same regardless of viewport, and the button can
 * say exactly how much is still hidden.
 */
function Clamped({ children }: { children: string }) {
  const [open, setOpen] = useState(false);
  const lines = children.split("\n");
  if (lines.length <= CLAMP_LINES) return <pre>{children}</pre>;

  const hidden = lines.length - CLAMP_LINES;
  return (
    <>
      <pre>{open ? children : lines.slice(0, CLAMP_LINES).join("\n")}</pre>
      <button type="button" className="step-clamp" onClick={() => setOpen(!open)}>
        {open ? "Show less" : "Show " + hidden + " more line" + (hidden === 1 ? "" : "s")}
      </button>
    </>
  );
}

function prettyText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

function Field({ label, children }: { label: string; children: string | undefined }) {
  if (children === undefined || children.length === 0) return null;
  return (
    <div className="step-field">
      <div className="step-field-label">{label}</div>
      <Clamped>{prettyText(children)}</Clamped>
    </div>
  );
}

function parseJsonText(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function decodeNestedJsonText(value: unknown): unknown {
  if (typeof value === "string") return parseJsonText(value);
  if (Array.isArray(value)) return value.map(decodeNestedJsonText);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, decodeNestedJsonText(item)]),
    );
  }
  return value;
}

function prettyValue(value: unknown): string {
  if (typeof value === "string") return prettyText(value);
  return JSON.stringify(decodeNestedJsonText(value), null, 2);
}

function attributeText(
  attributes: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = attributes[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * One agent's message to another, shown as a message.
 *
 * A `talk` call rendered like any other MCP call put the recipient and the
 * sentence inside a JSON blob under `Arguments`, which is the one shape that
 * hides the two things a conversation is made of.
 */
function TalkDetail({ message, from, event }: { message: TalkMessage; from: string; event: RunEvent }) {
  const status = event.error?.message ?? event.output.text;
  return (
    <div className="step-detail talk">
      <div className="talk-route">
        <span className="talk-party">{from}</span>
        <span className="talk-arrow" aria-hidden="true">
          →
        </span>
        <span className="talk-party">{message.target || "teammate"}</span>
        {event.status === "error" && <span className="talk-undelivered">undelivered</span>}
      </div>
      <p className="talk-content">{message.content}</p>
      {message.refs.length > 0 && (
        <div className="talk-refs">
          {message.refs.map((ref) => (
            <code key={ref}>{ref}</code>
          ))}
        </div>
      )}
      <Field label={event.status === "error" ? "Error" : "Delivery"} children={status} />
    </div>
  );
}

/** One card, one level deep, with named parts instead of a raw dump. */
function StepDetail({ event, actor }: { event: RunEvent; actor: Actor | null }) {
  const talk = talkOf(event);
  if (talk !== null) {
    return <TalkDetail message={talk} from={actor?.name ?? "This agent"} event={event} />;
  }

  if (event.kind === "message" || event.kind === "reasoning") {
    return (
      <MarkdownText className="step-detail step-detail--prose markdown-body">
        {conversationText(event)}
      </MarkdownText>
    );
  }

  if (event.kind === "command") {
    return (
      <div className="step-detail">
        <Field label="Command" children={event.input.command} />
        <Field
          label={
            event.output.exitCode === undefined
              ? "Output"
              : "Output · exit " + event.output.exitCode
          }
          children={event.output.text}
        />
        <Field label="Error" children={event.error?.message} />
      </div>
    );
  }

  if (event.kind === "delegation" && event.name === "dispatch_subagent") {
    return (
      <div className="step-detail">
        <Field label="Worker" children={attributeText(event.attributes, "workerName")} />
        <Field label="Objective" children={attributeText(event.attributes, "objective")} />
        <Field label="Prompt" children={attributeText(event.attributes, "prompt")} />
        <Field
          label={event.error === null ? "Result" : "Error"}
          children={event.error?.message ?? event.output.text}
        />
      </div>
    );
  }

  const fallbackInput =
    Object.keys(event.input).length === 0 ? undefined : prettyValue(event.input);
  const fallbackOutput =
    Object.keys(event.output).length === 0 ? undefined : prettyValue(event.output);

  return (
    <div className="step-detail">
      <Field label="Tool" children={event.input.tool ?? event.name} />
      <Field label="Arguments" children={event.input.text ?? fallbackInput} />
      <Field label="Changed files" children={event.output.changedFiles?.join("\n")} />
      <Field label="Result" children={event.output.text ?? fallbackOutput} />
      <Field label="Error" children={event.error?.message} />
    </div>
  );
}

/**
 * A step is one line until it has something to say for itself.
 *
 * Only a failure opens on its own — folding a failure is hiding it. A running
 * step used to open too, which meant every in-flight tool call in a live
 * mission unfolded its full argument card unasked; the glyph and the present
 * tense on the line already say "running", so the card waits to be asked for,
 * like any other step.
 */
function Step({
  event,
  actor,
  settled,
}: {
  event: RunEvent;
  actor: Actor | null;
  settled: boolean;
}) {
  const attributed = actor !== null;
  const auto = event.status === "error";
  const [pinned, setPinned] = useState<boolean | null>(null);
  const open = pinned ?? auto;
  // Move language belongs to an attributed transcript. Unattributed, the step
  // keeps the sentence it has always had, so a caller that passes no actors --
  // and every test written against that shape -- sees no change at all.
  const move = attributed ? moveFor(event) : null;
  // The leader deciding is not the same act as a worker doing. Both are steps,
  // but a reader has to be able to tell them apart without reading the text.
  const decision = event.kind === "delegation";

  return (
    <li className={"step step--" + event.status + (decision ? " step--decision" : "")}>
      <button type="button" className="step-line" onClick={() => setPinned(!open)}>
        <StepGlyph event={event} settled={settled} />
        {move === null ? (
          <span className="step-text">{stepLabel(event, settled)}</span>
        ) : (
          <>
            <span className={"step-move step-move--" + move.category}>{move.label}</span>
            <span className="step-text">{move.summary(event)}</span>
          </>
        )}
        <span className="step-duration">{formatDuration(event.durationMs)}</span>
        <span className="step-caret">{open ? "⌄" : "›"}</span>
      </button>
      {open && <StepDetail event={event} actor={actor} />}
    </li>
  );
}

interface EventRow {
  sort: string;
  event: RunEvent;
}

type Row = { sort: string; event: RunEvent } | { sort: string; steer: Message };

function isSteer(row: Row): row is { sort: string; steer: Message } {
  return "steer" in row;
}

/**
 * Which run an actor speaks for, as a plain value.
 *
 * A function rather than a property read: the accumulator it is called with is
 * only ever reassigned inside a closure, so control-flow analysis narrows it to
 * `null` at the call site and a direct `?.runId` would be typed `never`.
 */
function runOf(actor: Actor | null): string | null {
  return actor === null ? null : actor.runId;
}

/**
 * The transcript is a spine of things that were SAID, with the work that
 * produced them folded in between. What the operator said mid-Run belongs on
 * that spine too — burying a steer inside a fold would let a collapsed group
 * hide the fact that a human intervened.
 */
type Node =
  | { kind: "work"; rows: Row[]; actor: Actor | null }
  | { kind: "say"; event: RunEvent }
  | { kind: "steer"; steer: Message };

export function summariseSteps(rows: Row[]): {
  text: string;
  running: boolean;
  failed: boolean;
} {
  let thoughts = 0;
  let calls = 0;
  let notes = 0;
  let running = false;
  let failed = false;
  for (const row of rows) {
    if (isSteer(row)) continue;
    if (row.event.status === "in_progress") running = true;
    if (row.event.status === "error") failed = true;
    if (row.event.kind === "reasoning") thoughts += 1;
    else if (row.event.kind === "message") notes += 1;
    else calls += 1;
  }
  const parts: string[] = [];
  if (thoughts > 0) parts.push(thoughts + " thought" + (thoughts === 1 ? "" : "s"));
  if (calls > 0) parts.push(calls + " tool call" + (calls === 1 ? "" : "s"));
  if (notes > 0) parts.push(notes + " note" + (notes === 1 ? "" : "s"));
  return { text: parts.join(" · ") || "no steps", running, failed };
}

function Group({
  rows,
  openByDefault,
  actor,
  settled,
  runStatus,
  revealed = false,
}: {
  rows: Row[];
  openByDefault: boolean;
  actor: Actor | null;
  settled: boolean;
  runStatus?: RunStatus;
  /**
   * Something inside was explicitly asked for. Only the last group opens by
   * default, so revealing model calls revealed the one that happened to fall
   * in it -- the rest stayed folded while the button claimed all of them.
   */
  revealed?: boolean;
}) {
  const [pinned, setPinned] = useState<boolean | null>(null);
  const { text, running, failed } = summariseSteps(rows);
  // Nothing is in flight once the Run has stopped, whatever spans were left
  // open. Reading `running` off the events alone kept a killed step's group
  // pinned open with a spinner in it long after the Run had finished.
  const live = running && !settled;
  // While the RUN is live the transcript is narration plus one folded line per
  // group — the reader opens what they want to watch. Auto-opening the
  // trailing group (and every group holding a failure) is how a long mission
  // turned into a wall; the summary line already says "partly failed" when it
  // must. A settled run read back later keeps the richer defaults: the last
  // group and any failure open themselves, because by expanding the verdict
  // the reader has asked to see the process.
  const runLive = runStatus !== undefined && !settled;
  const open = pinned ?? (runLive ? revealed : openByDefault || failed || revealed);
  const events = rows.filter((row): row is EventRow => !isSteer(row)).map((row) => row.event);

  return (
    <div className="stream-group">
      <button
        type="button"
        className="stream-summary"
        aria-expanded={open}
        onClick={() => setPinned(!open)}
      >
        {actor === null ? (
          live ? (
            <span className="step-glyph step-glyph--pending" aria-hidden="true" />
          ) : (
            <span className="stream-summary-check" aria-hidden="true">
              ✓
            </span>
          )
        ) : (
          <CreatureSprite
            creature={actor.creature}
            state={creatureStateOf(events, runStatus)}
            name={actor.name}
            size={24}
          />
        )}
        {actor !== null && <strong className="stream-summary-actor">{actor.name}</strong>}
        {/* The same rule the rail follows: a specialty that is really a machine
            identity -- `<role>-<subtask>-<sha256 head>` -- is not a caption. The
            actor's name above already says who this is. */}
        {describedRole(actor?.specialty ?? null) !== null && (
          <span className="stream-summary-role">{describedRole(actor!.specialty)}</span>
        )}
        <span>{text}</span>
        {failed && <span className="stream-summary-failed">partly failed</span>}
        <span className="step-caret">{open ? "⌄" : "›"}</span>
      </button>
      {open && (
        <ul className="stream-steps">
          {rows.map((row) =>
            isSteer(row) ? null : (
              <Step
                key={row.event.runId + ":" + row.event.spanId}
                event={row.event}
                actor={actor}
                settled={settled}
              />
            ),
          )}
        </ul>
      )}
    </div>
  );
}

const SETTLED = new Set<RunStatus>(["completed", "failed", "cancelled"]);

/** What the reader needs to know about a finished Run, in one line. */
function verdict(
  status: RunStatus,
  failure: string | null,
): { tone: "ok" | "bad"; label: string; reason: string | null } {
  if (status === "failed") return { tone: "bad", label: "Didn't finish", reason: failure };
  if (status === "cancelled") return { tone: "bad", label: "Stopped", reason: failure };
  return { tone: "ok", label: "Completed", reason: null };
}

export function ToolTimeline({
  events,
  steers = [],
  answerShownSeparately = false,
  runStatus,
  failureReason = null,
  agentId,
  actorOf,
}: {
  events: RunEvent[];
  /** Messages sent mid-Run. They belong where they were said, not above. */
  steers?: Message[];
  /**
   * The Run's answer is rendered as its own Result. The last thing the agent
   * said IS that answer, so the stream drops it rather than printing it twice —
   * the earlier messages stay, because those are narration, not the answer.
   */
  answerShownSeparately?: boolean;
  /** Absent while the caller has no Run; a settled Run folds the whole stream. */
  runStatus?: RunStatus;
  /** Why a Run stopped short, when it did. */
  failureReason?: string | null;
  /** Whose workspace a file named in the prose belongs to. */
  agentId?: string;
  /**
   * Who produced an event, when several agents share one transcript. Absent, or
   * returning null, renders exactly as before: attribution is additive, and it
   * never reaches ordering.
   */
  actorOf?: (event: RunEvent) => Actor | null;
}) {
  const [showModelCalls, setShowModelCalls] = useState(false);
  const [openSettled, setOpenSettled] = useState(false);

  const rows = useMemo(() => {
    // Span ids are minted per run, so two runs sharing this transcript can mint
    // the same one. Identity here has to be run-scoped or their steps collapse
    // into each other.
    const key = (event: RunEvent): string => event.runId + ":" + event.spanId;
    const latest = new Map<string, RunEvent>();
    // A span's place in the transcript is where it STARTED, and only its first
    // event says so. Rows carry the span's latest event, whose `startedAt` is
    // that event's own timestamp — on a completion it equals the end time, so
    // ordering by it would sort every step by when it finished and slide a long
    // one past everything that ran while it was open.
    //
    // Where it started is its first appearance in `events`, NOT its `seq`.
    // `seq` restarts at 1 in every run, so ordering a multi-agent transcript by
    // it put a worker's first step beside the leader's first step: the leader
    // saying "no teammates yet, I'll dispatch both workers" rendered after the
    // two workers had already started. Interleaving runs is the caller's job,
    // it has already been done, and re-sorting here threw it away.
    const firstIndex = new Map<string, number>();
    const firstAt = new Map<string, string>();
    let position = 0;
    for (const event of events) {
      if (HIDDEN_KINDS.has(event.kind)) continue;
      const current = latest.get(key(event));
      if (!current || event.seq > current.seq) latest.set(key(event), event);
      if (!firstIndex.has(key(event))) {
        firstIndex.set(key(event), position);
        firstAt.set(key(event), event.startedAt);
      }
      position += 1;
    }
    return [...latest.values()]
      .sort(
        (left, right) => (firstIndex.get(key(left)) ?? 0) - (firstIndex.get(key(right)) ?? 0),
      )
      .map<EventRow>((event) => ({
        sort: firstAt.get(key(event)) ?? event.startedAt,
        event,
      }));
  }, [events]);

  const visible = rows.filter(
    (row) => row.event.error?.code !== DIAGNOSTIC_CODE && !isBlankReasoning(row.event),
  );
  const modelCalls = visible.filter((row) => row.event.kind === "api_call");
  // Revealing model calls must interleave them, not append the block. `visible`
  // is already in start order, so filtering it preserves that; concatenating
  // two filtered lists would put every model call after every command.
  const kept: EventRow[] = showModelCalls
    ? visible
    : visible.filter((row) => row.event.kind !== "api_call");

  const settled = runStatus !== undefined && SETTLED.has(runStatus);
  const liveRun = runStatus !== undefined && !settled;
  // While the run is going, the whole stream — every group and everything
  // said between them — renders inside ONE bounded box. The box follows its
  // own tail so a new tool call slides into view, and its header line folds
  // the entire long stream away without a trip back to the top. A reader who
  // scrolled up inside the box is reading something, so arrivals stop moving
  // it until they come back to the tail themselves. `follow` is a ref, not
  // state — where the box sits is not something to re-render over.
  const [openLive, setOpenLive] = useState(true);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const follow = useRef(true);
  const rendered = kept.length;
  useEffect(() => {
    const box = boxRef.current;
    if (!liveRun || box === null || !follow.current) return;
    box.scrollTop = box.scrollHeight;
  }, [liveRun, openLive, rendered]);
  const handleScroll = (): void => {
    const box = boxRef.current;
    if (box === null) return;
    follow.current = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  };

  // Steps keep their `seq` order; a steer is only placed BETWEEN them, by the
  // wall clock the two happen to share. Re-sorting the whole list by timestamp
  // would hand step ordering back to a field that cannot carry it.
  const ordered: Row[] = [...kept];
  for (const steer of steers) {
    const at = ordered.findIndex(
      (row) => !isSteer(row) && row.sort.localeCompare(steer.createdAt) > 0,
    );
    const row: Row = { sort: steer.createdAt, steer };
    if (at === -1) ordered.push(row);
    else ordered.splice(at, 0, row);
  }

  // Anything said closes the run of work above it: that work is what produced
  // it. So does a change of actor -- one group, one character, or a collapsed
  // line could not say whose work it is summarising.
  const nodes: Node[] = [];
  let pending: Row[] = [];
  let pendingActor: Actor | null = null;
  const flush = (): void => {
    if (pending.length > 0) nodes.push({ kind: "work", rows: pending, actor: pendingActor });
    pending = [];
    pendingActor = null;
  };
  for (const row of ordered) {
    if (isSteer(row)) {
      flush();
      nodes.push({ kind: "steer", steer: row.steer });
      continue;
    }
    const actor = actorOf?.(row.event) ?? null;
    // Only the leader's voice is the spine. A worker's report is its own work
    // product, so it folds into that worker's group like anything else it did
    // -- otherwise ten workers narrating turns the transcript into a wall of
    // prose that no fold can close.
    if (row.event.kind === "message" && actor?.isLeader !== false) {
      flush();
      nodes.push({ kind: "say", event: row.event });
      continue;
    }
    if (pending.length > 0 && runOf(actor) !== runOf(pendingActor)) flush();
    pendingActor = actor;
    pending.push(row);
  }
  flush();

  if (answerShownSeparately && nodes.at(-1)?.kind === "say") nodes.pop();
  if (nodes.length === 0) return null;
  // Work that ends the transcript is what is happening now. Work followed by
  // something said is finished, and folds: the sentence it produced is the
  // point, and the steps that got there are the detail.
  const trailing = nodes.length - 1;

  // A finished Run's process is one line. Everything it thought and every tool
  // it reached for got it to the answer below, and the answer is what the
  // reader came for — but when it did NOT get there, that line has to say so
  // and say why, or folding becomes hiding.
  // What the agent said is the spine, not a step it took.
  const work = kept.filter((row) => row.event.kind !== "message");
  const steps = work.length;
  const failedSteps = work.filter((row) => row.event.status === "error").length;

  if (settled && !openSettled) {
    const { tone, label, reason } = verdict(runStatus, failureReason);
    return (
      <section className="stream">
        <button
          type="button"
          className={"stream-verdict stream-verdict--" + tone}
          aria-expanded={false}
          onClick={() => setOpenSettled(true)}
        >
          <span className="stream-verdict-mark" aria-hidden="true">
            {tone === "ok" ? "✓" : "!"}
          </span>
          <strong>{label}</strong>
          <span className="stream-verdict-count">
            {steps} step{steps === 1 ? "" : "s"}
            {failedSteps > 0 ? " · " + failedSteps + " failed" : ""}
          </span>
          {reason !== null && reason.length > 0 && (
            <span className="stream-verdict-reason">{reason}</span>
          )}
          <span className="step-caret">›</span>
        </button>
      </section>
    );
  }

  const body = (
    <>
      {nodes.map((node, index) => {
        if (node.kind === "steer") {
          return (
            <p className="stream-steer" key={node.steer.id}>
              <span className="step-steer-label">you said</span>
              {node.steer.content}
            </p>
          );
        }
        if (node.kind === "say") {
          return (
            <MarkdownText
              className="stream-say markdown-body"
              agentId={agentId}
              key={node.event.spanId}
            >
              {conversationText(node.event)}
            </MarkdownText>
          );
        }
        // A group's identity is its first step, not its position. Runs are
        // polled independently, so an earlier-clocked group can be INSERTED
        // above this one on any poll; position-keyed groups inherited each
        // other's fold state when that happened, which is why folding a live
        // group looked like it "didn't work" — the fold jumped to whichever
        // group landed on that index next.
        const head = node.rows.find((row): row is EventRow => !isSteer(row));
        return (
          <Group
            key={head === undefined ? "work:" + index : "work:" + head.event.runId + ":" + head.event.spanId}
            rows={node.rows}
            openByDefault={index === trailing}
            revealed={
              showModelCalls &&
              node.rows.some((row) => !isSteer(row) && row.event.kind === "api_call")
            }
            actor={node.actor}
            settled={settled}
            {...(runStatus === undefined ? {} : { runStatus })}
          />
        );
      })}
      {/* Driven by the run's own status, never by a guess about the events: a
          leader waiting on its workers has no open step, and once the last one
          closed the transcript was indistinguishable from a finished run. The
          line goes away on a real terminal status and only then. */}
      {liveRun && (
        <p className="stream-running">
          <span className="step-glyph step-glyph--pending" aria-hidden="true" />
          Still working
        </p>
      )}
    </>
  );

  return (
    <section className="stream">
      {settled && (
        <button
          type="button"
          className="stream-verdict stream-verdict--open"
          aria-expanded
          onClick={() => setOpenSettled(false)}
        >
          <strong>{verdict(runStatus, failureReason).label}</strong>
          <span className="step-caret">⌄</span>
        </button>
      )}
      {liveRun ? (
        <>
          {/* The running counterpart of the settled verdict line: the whole
              process folds and unfolds from here, while it is still going. */}
          <button
            type="button"
            className="stream-verdict stream-live"
            aria-expanded={openLive}
            onClick={() => {
              // Reopening is asking for "now": whatever tail-following the
              // reader had wandered away from is restored with the box.
              if (!openLive) follow.current = true;
              setOpenLive(!openLive);
            }}
          >
            <span className="step-glyph step-glyph--pending" aria-hidden="true" />
            <strong>Working</strong>
            <span className="stream-verdict-count">
              {steps} step{steps === 1 ? "" : "s"}
              {failedSteps > 0 ? " · " + failedSteps + " failed" : ""}
            </span>
            <span className="step-caret">{openLive ? "⌄" : "›"}</span>
          </button>
          {openLive && (
            <div className="stream-live-box" ref={boxRef} onScroll={handleScroll}>
              {body}
            </div>
          )}
        </>
      ) : (
        body
      )}
      {modelCalls.length > 0 && (
        <button
          type="button"
          className="stream-debug"
          onClick={() => setShowModelCalls((value) => !value)}
        >
          {showModelCalls ? "Hide" : "Show"} {modelCalls.length} model call
          {modelCalls.length === 1 ? "" : "s"}
        </button>
      )}
    </section>
  );
}
