export const LAUNCHPAD_MCP_SERVER_SOURCE = String.raw`#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const workspace = resolve(process.env.LAUNCHPAD_WORKSPACE_PATH || process.cwd());
const codexHome = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : "";
const repairCandidate = process.env.LAUNCHPAD_REPAIR_CANDIDATE === "1";
const repairAllowedTools = new Set();
if (repairCandidate) {
  try {
    const declared = JSON.parse(process.env.LAUNCHPAD_REPAIR_ALLOWED_TOOLS || "[]");
    if (Array.isArray(declared)) {
      for (const name of declared) if (typeof name === "string" && name.length > 0) repairAllowedTools.add(name);
    }
  } catch {}
}
const commonWorkspace = repairCandidate ? "" : (process.env.COMMON_WORKSPACE ? resolve(process.env.COMMON_WORKSPACE) : "");
const dataDir = process.env.LAUNCHPAD_DATA_DIR ? resolve(process.env.LAUNCHPAD_DATA_DIR) : "";
const agentId = process.env.LAUNCHPAD_AGENT_ID || "unknown-agent";
const agentRole = String(process.env.LAUNCHPAD_AGENT_ROLE || "").toLowerCase();
const runId = process.env.LAUNCHPAD_RUN_ID || "unknown-run";
const parentRunId = process.env.LAUNCHPAD_PARENT_RUN_ID || "";
const coordinationUrl = repairCandidate ? "" : (process.env.LAUNCHPAD_COORDINATION_URL || "");
const coordinationToken = repairCandidate ? "" : (process.env.LAUNCHPAD_COORDINATION_TOKEN || "");
const browserState = new Map();
const jobs = new Map();
const MAX_RUNNING_JOBS = 8;
const JOB_OUTPUT_LIMIT = 2_000_000;
const WAIT_FOR_WORKERS_SAFE_TIMEOUT_SECONDS = 110;

function runtimeEnv(extra = {}) {
  const cache = process.env.LAUNCHPAD_DEPENDENCY_CACHE || "";
  const pythonPaths = cache
    ? [cache + "/python/bin", cache + "/python/user/bin"]
    : [];
  const inheritedPath = process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  return {
    ...process.env,
    ...(cache ? {
      PIP_CACHE_DIR: process.env.PIP_CACHE_DIR || cache + "/pip",
      UV_CACHE_DIR: process.env.UV_CACHE_DIR || cache + "/uv",
      NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE || cache + "/npm",
      PYTHONUSERBASE: process.env.PYTHONUSERBASE || cache + "/python/user",
      LAUNCHPAD_PIP_BOOTSTRAP: process.env.LAUNCHPAD_PIP_BOOTSTRAP || cache + "/python/get-pip.py",
      LAUNCHPAD_SYSTEM_PYTHON: process.env.LAUNCHPAD_SYSTEM_PYTHON || "/usr/bin/python3",
      BASH_ENV: process.env.BASH_ENV || cache + "/python/shell-env.sh",
      PATH: [...pythonPaths, inheritedPath].join(":"),
    } : {}),
    ...extra,
  };
}

let runTerminal = false;

function remainingRootMs() {
  const raw = process.env.LAUNCHPAD_ROOT_DEADLINE_AT;
  if (!raw) return Number.POSITIVE_INFINITY;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY;
  return Math.max(0, at - Date.now());
}

function runHasEnded() {
  if (remainingRootMs() <= 0) runTerminal = true;
  return runTerminal;
}

function refuseIfTerminal(name) {
  if (name !== "dispatch_subagent" && name !== "extend_worker_timeout" && name !== "start_job") {
    return;
  }
  if (!runHasEnded()) return;
  throw new Error("RUN_TERMINAL: no new tool admission after the root is terminal");
}

function requireLeader(action) {
  if (runId !== parentRunId) {
    throw new Error("UNAUTHORIZED: only the leader can " + action);
  }
}

const tools = [
  tool("web_search", "Search the public web for current information. For source code repositories, prefer git clone plus search_files.", {
    query: str("Search query"), max_results: int("Maximum results", 8), timeout_seconds: int("Request timeout seconds", 20)
  }, ["query"]),
  tool("fetch_webpage", "Fetch a webpage as readable text. Use after web_search; do not use for source repo trees when git clone is better.", {
    url: str("URL to fetch"), max_chars: int("Maximum returned characters", 20000), timeout_seconds: int("Request timeout seconds", 45)
  }, ["url"]),
  tool("publish_artifact", "Publish text, a /workspace file, or a $COMMON_WORKSPACE file as a durable run artifact. Shared files may be passed as $COMMON_WORKSPACE/foo, /common-workspace/foo, or foo when they exist only in the shared workspace.", {
    text: str("Artifact text"), path: str("Workspace-relative file path to publish"), type: str("Artifact type"), description: str("Short description")
  }, []),
  tool("list_artifacts", "List artifacts published in this worker or leader run.", { run_id: str("Run id, defaults to this run") }, []),
  tool("read_artifact", "Read one published artifact by id.", { artifact_id: str("Artifact id"), run_id: str("Run id, defaults to this run"), max_chars: int("Maximum returned characters", 50000) }, ["artifact_id"]),
  tool("list_teammates", "List the other workers of this leader run you can address, with their current state.", {}, []),
  tool("dispatch_subagent", "Leader-only: dispatch one worker subagent. Defaults to asynchronous launch; keep it async for long-running builders, researchers, validators, and forward tests so the leader can coordinate, synthesize, and read shared handoffs. Use wait=true only for short workers expected to finish well under 2 minutes. dependsOn is enforced: a dependent worker is queued and will not start until prerequisite subtasks finish, so validators do not run against stubs. For talk-first workers, pass initialMessage so the first message is queued with the worker before its first turn. Require workers to maintain $COMMON_WORKSPACE/status/<subtask-id>.json and $COMMON_WORKSPACE/reports/<subtask-id>.md so you can consume durable summaries without repeated trajectory polling.", {
    id: str("Optional stable subtask id"),
    agentName: str("Distinct worker agent display name"),
    title: str("Short subtask title"),
    role: str("Worker role/specialty"),
    prompt: str("Concrete worker task prompt"),
    objective: str("Objective this worker should satisfy"),
    successCriteria: { type: "array", items: { type: "string" }, description: "Success criteria" },
    expectedOutput: str("Expected output shape"),
    dependsOn: { type: "array", items: { type: "string" }, description: "Completed subtasks this dispatch depends on" },
    requiresGitContribution: bool("Project-backed runs only: set false for read-only validation, smoke-test, review, or forward-test workers that should not commit"),
    initialMessage: str("Optional first talk message to queue for the worker before its first turn starts"),
    initialMessageWorkspaceRefs: { type: "array", items: { type: "string" }, description: "Paths under COMMON_WORKSPACE referenced by initialMessage" },
    wait: bool("Block until the worker finishes; defaults to false for live leader runs"),
    contractKey: str("Catalog contract key this worker may narrow"),
    inputs: { type: "array", items: { type: "string" }, description: "Workspace-relative input paths declared by the catalog" },
    outputs: { type: "array", items: { type: "string" }, description: "Workspace-relative output paths declared by the catalog" },
    mutationPaths: { type: "array", items: { type: "string" }, description: "Workspace-relative mutation paths declared by the catalog" }
  }, ["prompt"]),
  tool("wait_for_workers", "Leader-only: wait for specific workers/subtasks, or all outstanding async workers, without shell sleep or repeated model polling. Returns compact terminal summaries, pending workers, and pendingHandoffs showing expected status/report files plus suggestedAction. Use one bounded wait as a checkpoint, then follow pendingHandoffs.suggestedAction or synthesize before waiting again. Single calls are capped below the MCP client timeout.", {
    targets: { type: "array", items: { type: "string" }, description: "Worker run ids, agent display names, or subtask ids. Empty means all outstanding async workers." },
    timeout_seconds: int("Seconds to wait, default 300, max 110 per call", 300)
  }, []),
  tool("inspect_worker_progress", "Leader-only: get a compact progress summary for a worker without reading its full trajectory into context. Use sparingly: prefer worker status/report files first, batch multiple inspections with batch_tool_call, and inspect only when a worker is blocked, stale, near timeout, or done.", {
    target: str("Worker run id, agent display name, or subtask id"),
    max_events: int("Maximum recent events to inspect", 120)
  }, ["target"]),
  tool("extend_worker_timeout", "Leader-only: give an active worker more wall-clock time when inspect_worker_progress shows useful progress.", {
    target: str("Worker run id, agent display name, or subtask id"),
    additional_seconds: int("Extra seconds to add, capped by the harness"),
    reason: str("Short reason for extending")
  }, ["target", "additional_seconds"]),
  tool("send_message", "Send a teammate information they should have next time they work. Does NOT wake them, so it costs no model turn. Use for progress, findings, and pointers to files.", { target: str("Teammate worker id or display name"), content: str("Message text, at most 2000 characters"), workspace_refs: { type: "array", items: { type: "string" }, description: "Paths under COMMON_WORKSPACE this message refers to" } }, ["target", "content"]),
  tool("talk", "Send a lightweight teammate message. If the target is currently in a Codex turn, it is steered into that live turn; if idle or not started, it queues quietly for the next turn. Use for quick questions, answers, and status pings. Put large content in COMMON_WORKSPACE and send paths.", { target: str("Teammate worker id or display name"), content: str("Short message text, at most 2000 characters"), workspace_refs: { type: "array", items: { type: "string" }, description: "Paths under COMMON_WORKSPACE this message refers to" } }, ["target", "content"]),
  tool("followup_task", "Ask a teammate to act now. Wakes them if idle and interrupts them if running, so it costs a model turn — use only when the recipient must read something, fix something, or answer you.", { target: str("Teammate worker id or display name"), content: str("What you need them to do, at most 2000 characters"), workspace_refs: { type: "array", items: { type: "string" }, description: "Paths under COMMON_WORKSPACE this request refers to" } }, ["target", "content"]),
  tool("register_custom_tool", "Register a run-scoped custom tool script for this agent team. Put shared tools in COMMON_WORKSPACE so sibling agents can call them immediately through call_custom_tool.", {
    name: str("Distinct tool name, letters/numbers/underscore/dash/dot, max 64 chars"),
    description: str("What the tool does and expected JSON arguments"),
    path: str("Script path under COMMON_WORKSPACE or this workspace"),
    interpreter: str("Optional interpreter: bash, node, or python3. Inferred from extension when omitted."),
    timeout_seconds: int("Execution timeout seconds", 30)
  }, ["name", "path"]),
  tool("list_custom_tools", "List run-scoped custom tools registered by this agent team.", { query: str("Optional text filter") }, []),
  tool("call_custom_tool", "Call a run-scoped custom tool by name with JSON arguments. Arguments are passed on stdin and LAUNCHPAD_CUSTOM_TOOL_ARGS.", {
    name: str("Registered custom tool name"),
    arguments: { type: "object", additionalProperties: true, description: "JSON arguments for the custom tool" },
    timeout_seconds: int("Optional execution timeout seconds")
  }, ["name"]),
  tool("bootstrap_context", "Read the run's shared startup context in one call: teammates, whiteboard, artifacts, custom tools, and shared workspace files.", {
    max_entries: int("Maximum entries per section", 50)
  }, []),
  tool("whiteboard_post", "Post a short note to the shared run whiteboard so sibling workers and the leader can see it.", { text: str("Note text"), kind: str("Optional kind, e.g. finding, question, decision") }, ["text"]),
  tool("whiteboard_read", "Read shared run whiteboard entries from sibling workers, oldest first.", { since: str("Only entries strictly after this ISO timestamp"), max: int("Maximum entries", 100) }, []),
  tool("view_task", "View this run's task-board state.", { task_id: str("Optional task id") }, []),
  tool("claim_task", "Claim a task in the local task board.", { task_id: str("Task id") }, ["task_id"]),
  tool("submit_plan", "Record this worker's short execution plan for a task.", { task_id: str("Task id"), plan: str("Plan text") }, ["task_id","plan"]),
  tool("complete_task", "Mark a task complete and attach a result summary.", { task_id: str("Task id"), result: str("Result summary") }, ["task_id","result"]),
  tool("report_progress", "Record structured progress for the current worker run.", { task_id: str("Task id"), status: str("Status text"), detail: str("Progress details") }, ["status"]),
  tool("list_files", "List files below the workspace with bounded output.", { path: str("Workspace-relative directory"), max_entries: int("Maximum entries", 200) }, []),
  tool("search_files", "Search workspace files with ripgrep.", { query: str("Pattern/query"), path: str("Workspace-relative path"), glob: str("Optional glob"), max_results: int("Maximum matches", 100) }, ["query"]),
  tool("read_file", "Read a file from /workspace, or from $COMMON_WORKSPACE when the path is prefixed with $COMMON_WORKSPACE/, /common-workspace/, common-workspace/, or exists only in the shared workspace.", { path: str("Workspace-relative or shared-workspace file path"), max_chars: int("Maximum returned characters", 40000) }, ["path"]),
  tool("read_many_files", "Read several files from /workspace and/or $COMMON_WORKSPACE in one call.", { paths: { type: "array", items: { type: "string" }, description: "Workspace-relative or shared-workspace paths" }, max_chars_each: int("Maximum chars per file", 16000) }, ["paths"]),
  tool("validate_skill", "Validate a generated Codex skill folder for reusable skill quality: SKILL.md frontmatter, resource links, script/test hints, clutter files, and forward-test evidence.", {
    path: str("Path to the skill folder under /workspace or $COMMON_WORKSPACE"),
    max_findings: int("Maximum findings to return", 50)
  }, ["path"]),
  tool("publish_skill", "Promote a validated Codex skill folder into the persistent Launchpad skill hub so future agents can discover and install it.", {
    path: str("Path to the skill folder under /workspace or $COMMON_WORKSPACE"),
    version: str("Optional version label, defaults to a timestamped version"),
    tags: { type: "array", items: { type: "string" }, description: "Search tags" },
    notes: str("Short publication notes or validation evidence"),
    origin_patterns: { type: "array", items: { type: "string" }, description: "Skill wiki pattern pages that motivated this version" },
    evidence_refs: { type: "array", items: { type: "string" }, description: "Run, worker, artifact, or file references that support this version" },
    supersedes_version: str("Optional prior skill version superseded by this publication")
  }, ["path"]),
  tool("search_skills", "Search the persistent Launchpad skill hub for reusable Codex skills that can be installed into this run.", {
    query: str("Search query over name, description, tags, and notes"),
    limit: int("Maximum results", 10)
  }, []),
  tool("read_skill", "Read metadata and a SKILL.md preview for one skill published in the persistent Launchpad skill hub.", {
    name: str("Skill name from search_skills"),
    version: str("Optional exact version; defaults to latest"),
    max_chars: int("Maximum SKILL.md preview characters", 12000)
  }, ["name"]),
  tool("install_skill", "Install a skill from the persistent Launchpad skill hub into this run, normally under $COMMON_WORKSPACE/skills/<name> for sibling agents to reuse, or into $CODEX_HOME/skills/<name> with scope=codex_home.", {
    name: str("Skill name from search_skills"),
    version: str("Optional exact version; defaults to latest"),
    scope: str("Install scope: run (default) or codex_home"),
    destination: str("Optional install directory under /workspace or $COMMON_WORKSPACE; with scope=codex_home, under $CODEX_HOME")
  }, ["name"]),
  tool("search_skill_wiki", "Search the persistent skill wiki: pattern pages, index, evolution log, and skill impact history compiled from prior agent experience.", {
    query: str("Search query over wiki pages and skill impact records"),
    skill: str("Optional skill name filter for impact records"),
    limit: int("Maximum results", 10),
    max_chars: int("Maximum text excerpt characters per result", 1200)
  }, []),
  tool("read_skill_wiki", "Read one page from the persistent skill wiki, such as index.md, log.md, skill-impact.md, patterns/<name>.md, or impact-records.jsonl.", {
    path: str("Wiki-relative path to read"),
    max_chars: int("Maximum returned characters", 20000)
  }, ["path"]),
  tool("update_skill_wiki", "Create or incrementally update persistent skill wiki pattern pages, index.md, and log.md after analyzing agent traces.", {
    create_patterns: { type: "array", items: { type: "object", additionalProperties: true }, description: "New patterns as {name, content}; name is under patterns/ unless already prefixed" },
    update_patterns: { type: "array", items: { type: "object", additionalProperties: true }, description: "Pattern edits as {name, edits:[{op, target?, content}]}; ops: append, replace, insert_after" },
    update_index: str("Optional complete replacement content for index.md"),
    append_log: str("Optional log entry to append to log.md"),
    evidence_refs: { type: "array", items: { type: "string" }, description: "Run, worker, artifact, or trace references used as evidence" }
  }, []),
  tool("stage_skill_proposal", "Stage a candidate skill evolution proposal, snapshotting the candidate skill folder and wiki evidence before validation gating.", {
    candidate_path: str("Path to the candidate skill folder under /workspace or $COMMON_WORKSPACE"),
    skill: str("Optional skill name; defaults to candidate SKILL.md frontmatter name"),
    base_version: str("Optional prior hub version this proposal modifies"),
    proposed_version: str("Optional proposed version label for accepted publication"),
    proposal_summary: str("Short description of the proposed skill change"),
    diff: str("Unified diff or concise patch summary"),
    origin_patterns: { type: "array", items: { type: "string" }, description: "Wiki pattern pages that motivated the proposal" },
    evidence_refs: { type: "array", items: { type: "string" }, description: "Run, worker, artifact, or trace references used as evidence" },
    notes: str("Additional notes for validation or future proposers")
  }, ["candidate_path"]),
  tool("read_skill_proposal", "Read one staged skill proposal, including metadata, validation summary, and SKILL.md/PURPOSE.md previews from its snapshot.", {
    proposal_id: str("Proposal id returned by stage_skill_proposal"),
    max_chars: int("Maximum preview characters", 12000)
  }, ["proposal_id"]),
  tool("list_skill_proposals", "List or search staged/finalized skill proposals so abandoned or recently accepted skill edits remain discoverable.", {
    query: str("Optional search query over proposal metadata"),
    skill: str("Optional skill name filter"),
    status: str("Optional proposal status filter: staged, accepted, or rejected"),
    limit: int("Maximum results", 20)
  }, []),
  tool("finalize_skill_proposal", "Finalize a staged skill proposal after validation: record accepted/rejected impact, and optionally publish an accepted candidate to the skill hub.", {
    proposal_id: str("Proposal id returned by stage_skill_proposal"),
    accepted: bool("Whether validation accepted the proposal"),
    validation_score: str("Validation score or metric summary"),
    validation_delta: str("Validation delta versus previous best, if known"),
    publish: bool("If accepted, publish the staged candidate as a normal hub skill version"),
    version: str("Optional publish version override; defaults to proposed_version or timestamp"),
    notes: str("Additional validation notes")
  }, ["proposal_id", "accepted"]),
  tool("record_skill_impact", "Append a validation-gated skill evolution result to the persistent skill wiki so future agents avoid repeating failed patches and can reuse successful patterns.", {
    skill: str("Skill name"),
    version: str("Skill version or proposal version"),
    accepted: bool("Whether the proposal was accepted after validation"),
    validation_score: str("Validation score or metric summary"),
    validation_delta: str("Validation delta versus previous best, if known"),
    proposal_summary: str("Short description of the proposed skill change"),
    diff: str("Unified diff or concise patch summary"),
    origin_patterns: { type: "array", items: { type: "string" }, description: "Wiki pattern pages that motivated the proposal" },
    evidence_refs: { type: "array", items: { type: "string" }, description: "Run, worker, artifact, or trace references used as evidence" },
    notes: str("Additional notes for future skill proposers")
  }, ["skill", "accepted"]),
  tool("search_run_events", "Search persisted Launchpad JSONL events for a run.", { query: str("Search text"), run_id: str("Run id, defaults to current or parent run"), max_results: int("Maximum matching events", 50) }, ["query"]),
  tool("read_worker_log", "Read the tail of a worker/leader event log. Per-event text (command/output/error) is clipped to max_chars by default to protect your context window; clipped events are flagged truncated:true. To read an event in full, raise max_chars or pass full:true — nothing is hidden, only trimmed by default.", { run_id: str("Run id, defaults to current run"), max_events: int("Maximum events", 80), max_chars: int("Max characters of text kept per event field before clipping (default 600, up to 200000)", 600), full: { type: "boolean", description: "Return every event's text in full, bypassing clipping" } }, []),
  tool("summarize_worker_trace", "Summarize event counts and recent activity for a worker/leader run.", { run_id: str("Run id, defaults to current run") }, []),
  tool("browser_open", "Open a URL in the lightweight fetch-backed browser session.", { url: str("URL"), timeout_seconds: int("Request timeout seconds", 45) }, ["url"]),
  tool("browser_snapshot", "Return title, text excerpt, and links from the lightweight browser session.", { max_chars: int("Maximum text characters", 20000) }, []),
  tool("browser_click", "Browser click is unavailable in the lightweight MCP browser; use fetch/browser_snapshot or request Playwright integration.", { selector: str("Selector or link text") }, ["selector"]),
  tool("browser_type", "Browser typing is unavailable in the lightweight MCP browser; use app-specific APIs or request Playwright integration.", { selector: str("Selector"), text: str("Text") }, ["selector","text"]),
  tool("browser_screenshot", "Browser screenshot is unavailable in the lightweight MCP browser; request Playwright integration for visual tasks.", {}, []),
  tool("tool_search", "Search Launchpad's local MCP tool catalog.", { query: str("Tool search query"), limit: int("Maximum tools", 8) }, ["query"]),
  tool("tool_call", "Call a Launchpad MCP tool discovered with tool_search.", { tool_name: str("Tool name"), arguments: { type: "object", additionalProperties: true } }, ["tool_name"]),
  tool("batch_tool_call", "Call several independent Launchpad MCP tools in one model tool turn. Use for cheap read-only discovery calls; set parallel=true only when call order does not matter.", {
    calls: { type: "array", items: { type: "object", properties: { tool_name: str("Tool name"), arguments: { type: "object", additionalProperties: true } }, required: ["tool_name"] }, description: "Tool calls to execute, max 8" },
    parallel: bool("Run calls concurrently when order does not matter; defaults to false")
  }, ["calls"]),
  tool("start_job", "Start a long-running shell command in the background, so this agent can continue reasoning and inspect output later.", {
    command: str("Shell command to run"),
    cwd: str("Optional working directory under /workspace or $COMMON_WORKSPACE"),
    timeout_seconds: int("Hard timeout seconds, default 1800, max 7200", 1800),
    max_output_chars: int("Maximum output chars returned immediately", 4000)
  }, ["command"]),
  tool("list_jobs", "List background jobs started by this agent's Launchpad MCP server.", {}, []),
  tool("read_job_output", "Read captured stdout/stderr for a background job without blocking. Pass offsets from the prior response to get only new output.", {
    job_id: str("Job id"),
    stdout_offset: int("Character offset into stdout", 0),
    stderr_offset: int("Character offset into stderr", 0),
    max_chars: int("Maximum combined output characters", 20000)
  }, ["job_id"]),
  tool("wait_job", "Wait briefly for a background job to finish, returning the latest captured output. Use short waits and keep steering responsive.", {
    job_id: str("Job id"),
    timeout_seconds: int("Seconds to wait, default 5, max 60", 5),
    stdout_offset: int("Character offset into stdout", 0),
    stderr_offset: int("Character offset into stderr", 0),
    max_chars: int("Maximum combined output characters", 20000)
  }, ["job_id"]),
  tool("cancel_job", "Cancel a running background job started by this agent.", { job_id: str("Job id") }, ["job_id"]),
  tool("loop_status", "Inspect repeated MCP tool-call patterns for this run.", {}, []),
];
const toolMap = new Map(tools.map((t) => [t.name, t]));
const REPAIR_EXCLUDED_TOOLS = new Set([
  "dispatch_subagent", "inspect_worker_progress", "extend_worker_timeout", "bootstrap_context",
  "start_job", "list_jobs", "read_job_output", "wait_job", "cancel_job",
  "send_message", "talk", "followup_task", "register_custom_tool", "list_custom_tools", "call_custom_tool",
  "batch_tool_call",
]);
const REPAIR_META_TOOLS = new Set(["tool_search", "tool_call"]);
const LEADER_ONLY_TOOLS = new Set([
  "dispatch_subagent", "wait_for_workers", "inspect_worker_progress", "extend_worker_timeout",
]);
const WORKER_BASE_TOOLS = new Set([
  "publish_artifact", "list_artifacts", "read_artifact",
  "bootstrap_context", "whiteboard_post", "whiteboard_read",
  "list_files", "search_files", "read_file", "read_many_files",
  "start_job", "list_jobs", "read_job_output", "wait_job", "cancel_job",
  "tool_search", "tool_call", "batch_tool_call", "loop_status",
]);
const RESEARCH_TOOLS = new Set([...WORKER_BASE_TOOLS, "web_search", "fetch_webpage"]);
const BUILDER_TOOLS = new Set([
  ...WORKER_BASE_TOOLS,
  "validate_skill", "search_skills", "read_skill", "install_skill",
  "search_skill_wiki", "read_skill_wiki", "stage_skill_proposal", "read_skill_proposal", "list_skill_proposals",
]);
const TESTER_TOOLS = new Set([
  ...WORKER_BASE_TOOLS,
  "web_search", "fetch_webpage", "validate_skill", "search_skills", "read_skill",
  "browser_open", "browser_snapshot",
]);
const DEFAULT_WORKER_TOOLS = new Set([
  ...WORKER_BASE_TOOLS,
  "web_search", "fetch_webpage", "validate_skill", "search_skills", "read_skill", "install_skill",
  "browser_open", "browser_snapshot",
]);
function repairToolAllowed(name) {
  return !REPAIR_EXCLUDED_TOOLS.has(name) && (REPAIR_META_TOOLS.has(name) || repairAllowedTools.has(name));
}
function roleToolAllowed(name) {
  if (!agentRole || !parentRunId || runId === parentRunId || agentRole === "leader") return true;
  if (LEADER_ONLY_TOOLS.has(name)) return false;
  if (agentRole.includes("research")) return RESEARCH_TOOLS.has(name);
  if (agentRole.includes("test") || agentRole.includes("review") || agentRole.includes("validat")) return TESTER_TOOLS.has(name);
  if (agentRole.includes("build") || agentRole.includes("implement") || agentRole.includes("skill")) return BUILDER_TOOLS.has(name);
  return DEFAULT_WORKER_TOOLS.has(name);
}
function listedTools() {
  if (repairCandidate) return tools.filter((item) => repairToolAllowed(item.name));
  return tools.filter((item) => roleToolAllowed(item.name));
}
const resources = [
  resource("launchpad://context", "Launchpad run context", "Current agent/run/workspace identifiers and how Launchpad MCP is scoped.", "application/json"),
  resource("launchpad://tools", "Launchpad tool catalog", "Callable Launchpad MCP tools exposed to this Codex worker.", "application/json"),
  resource("launchpad://custom-tools", "Shared custom tool registry", "Run-scoped custom tools registered by this leader/worker team.", "application/json"),
  resource("launchpad://skills", "Persistent skill hub", "Reusable Codex skills published from prior Launchpad runs.", "application/json"),
  resource("launchpad://skill-wiki", "Persistent skill wiki", "Compiled agent experience for skill evolution: patterns, logs, and validation impact history.", "application/json"),
  resource("launchpad://whiteboard", "Shared run whiteboard", "Current shared whiteboard entries for this leader run.", "application/json"),
  resource("launchpad://artifacts", "Shared run artifacts", "Artifact metadata published by this run's workers.", "application/json"),
];

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) void handleLine(line);
  }
});
process.stdin.on("end", () => terminateAllJobs());
process.on("SIGTERM", () => {
  terminateAllJobs();
  process.exit(0);
});

async function handleLine(line) {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (!request || typeof request !== "object" || request.id === undefined) return;
  try {
    const result = await dispatch(request.method, request.params || {});
    respond(request.id, { result });
  } catch (error) {
    respond(request.id, { error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
  }
}

async function dispatch(method, params) {
  if (method === "initialize") {
    return { protocolVersion: params.protocolVersion || "2024-11-05", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "launchpad-tools", version: "1.0.0" } };
  }
  if (method === "tools/list") return { tools: compactToolCatalog(listedTools()) };
  if (method === "resources/list") return { resources };
  if (method === "resources/templates/list") return { resourceTemplates };
  if (method === "resources/read") return readResource(params.uri);
  if (method === "tools/call") {
    const name = params.name;
    const args = params.arguments || {};
    let result;
    if (!toolMap.has(name)) {
      result = toolFailure(String(name || ""), args, new Error("Unknown tool: " + name));
    } else if (!listedTools().some((tool) => tool.name === name)) {
      result = {
        ok: false,
        error: "Tool is not available for this agent role: " + name,
        role: agentRole || (runId === parentRunId ? "leader" : "worker"),
        hint: "Use tools/list or tool_search to choose a role-appropriate Launchpad tool.",
      };
    } else {
      try {
        result = await callTool(name, args, 0);
      } catch (error) {
        result = toolFailure(name, args, error);
      }
    }
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }], isError: result && result.ok === false };
  }
  return {};
}

const resourceTemplates = [
  resourceTemplate("launchpad://artifact/{id}", "Launchpad artifact by id", "Read one shared artifact's content by its id.", "text/plain"),
  resourceTemplate("launchpad://skill/{name}", "Launchpad skill by name", "Read one published skill's metadata and SKILL.md preview.", "application/json"),
  resourceTemplate("launchpad://skill-wiki/{path}", "Launchpad skill wiki page", "Read one persistent skill wiki page by relative path.", "text/markdown"),
  resourceTemplate("launchpad://whiteboard/{id}", "Launchpad whiteboard entry by id", "Read one shared whiteboard entry by its id.", "application/json"),
];

function resource(uri, name, description, mimeType) {
  return { uri, name, description, mimeType };
}

function resourceTemplate(uriTemplate, name, description, mimeType) {
  return { uriTemplate, name, description, mimeType };
}

function readResource(uri) {
  const normalized = String(uri || "");
  if (normalized === "launchpad://context") {
    return resourceText(normalized, JSON.stringify({
      agentId,
      runId,
      parentRunId: parentRunId || null,
      workspace,
      codexHome: codexHome || null,
      sharedRunKey: safeRunId(parentRunId || runId),
      notes: [
        "Use tools/list or the launchpad://tools resource to discover callable tools.",
        "MCP resources are read-only context; call tools through tools/call.",
        "Sibling workers share whiteboard and artifact resources when LAUNCHPAD_PARENT_RUN_ID is set.",
        "Agents can add run-scoped custom tools by writing scripts in $COMMON_WORKSPACE and calling register_custom_tool.",
        "Agents can install hub skills into $COMMON_WORKSPACE/skills by default, or into $CODEX_HOME/skills with install_skill scope=codex_home.",
        "If selectedSkills is non-empty, middleware already ranked and installed those skills for this run.",
        "Skill maintainers can search/read launchpad://skill-wiki before proposing skill edits, then record accepted or rejected validation results with record_skill_impact.",
      ],
      selectedSkills: selectedSkillsForRun(),
    }, null, 2));
  }
  if (normalized === "launchpad://tools") {
    return resourceText(normalized, JSON.stringify({ tools: listedTools() }, null, 2));
  }
  if (normalized === "launchpad://whiteboard") {
    return resourceText(normalized, JSON.stringify(whiteboardRead({ max: 200 }), null, 2));
  }
  if (normalized === "launchpad://custom-tools") {
    return resourceText(normalized, JSON.stringify(listCustomTools({}), null, 2));
  }
  if (normalized === "launchpad://skills") {
    return resourceText(normalized, JSON.stringify(searchSkills({ limit: 100 }), null, 2));
  }
  if (normalized === "launchpad://skill-wiki") {
    return resourceText(normalized, JSON.stringify(searchSkillWiki({ limit: 100 }), null, 2));
  }
  if (normalized === "launchpad://artifacts") {
    return resourceText(normalized, JSON.stringify(listArtifacts({}), null, 2));
  }
  if (normalized.startsWith("launchpad://artifact/")) {
    const id = normalized.slice("launchpad://artifact/".length);
    return resourceText(normalized, JSON.stringify(readArtifact({ artifact_id: id }), null, 2), "text/plain");
  }
  if (normalized.startsWith("launchpad://skill/")) {
    const spec = normalized.slice("launchpad://skill/".length);
    const [name, version] = spec.split("@", 2);
    return resourceText(normalized, JSON.stringify(readSkill({ name, version }), null, 2));
  }
  if (normalized.startsWith("launchpad://skill-wiki/")) {
    const path = decodeURIComponent(normalized.slice("launchpad://skill-wiki/".length));
    return resourceText(normalized, JSON.stringify(readSkillWiki({ path }), null, 2), "text/markdown");
  }
  if (normalized.startsWith("launchpad://whiteboard/")) {
    const id = normalized.slice("launchpad://whiteboard/".length);
    const match = whiteboardRead({ max: 500 }).entries.find((entry) => entry.id === id);
    return resourceText(normalized, JSON.stringify(match || null, null, 2));
  }
  throw new Error("Unknown resource: " + normalized);
}

function resourceText(uri, text, mimeType = "application/json") {
  return { contents: [{ uri, mimeType, text }] };
}

async function callTool(name, args, depth) {
  recordCall(name, args);
  refuseIfTerminal(name);
  if (repairCandidate && !repairToolAllowed(name)) {
    return { ok: false, error: "Tool is excluded from the repair candidate allowlist: " + name };
  }
  if (name === "tool_search") return searchTools(args);
  if (name === "tool_call") {
    if (depth > 0) return { ok: false, error: "Nested tool_call is not allowed" };
    return callTool(String(args.tool_name || ""), args.arguments || {}, depth + 1);
  }
  if (name === "batch_tool_call") {
    if (depth > 0) return { ok: false, error: "Nested batch_tool_call is not allowed" };
    return batchToolCall(args, depth + 1);
  }
  if (name === "web_search") return webSearch(args);
  if (name === "fetch_webpage") return fetchWebpage(args);
  if (name === "publish_artifact") return publishArtifact(args);
  if (name === "list_artifacts") return listArtifacts(args);
  if (name === "read_artifact") return readArtifact(args);
  if (name === "list_teammates") return listTeammates();
  if (name === "dispatch_subagent") return dispatchSubagent(args);
  if (name === "wait_for_workers") return waitForWorkers(args);
  if (name === "inspect_worker_progress") return inspectWorkerProgress(args);
  if (name === "extend_worker_timeout") return extendWorkerTimeout(args);
  if (name === "send_message") return coordinationSend(args, "quiet");
  if (name === "talk") return coordinationSend(args, "talk");
  if (name === "followup_task") return coordinationSend(args, "wakeup");
  if (name === "register_custom_tool") return registerCustomTool(args);
  if (name === "list_custom_tools") return listCustomTools(args);
  if (name === "call_custom_tool") return callCustomTool(args);
  if (name === "bootstrap_context") return bootstrapContext(args);
  if (name === "whiteboard_post") return whiteboardPost(args);
  if (name === "whiteboard_read") return whiteboardRead(args);
  if (["view_task","claim_task","submit_plan","complete_task","report_progress"].includes(name)) return taskTool(name, args);
  if (name === "list_files") return listFiles(args);
  if (name === "search_files") return searchFiles(args);
  if (name === "read_file") return readFileTool(args);
  if (name === "read_many_files") return readManyFiles(args);
  if (name === "validate_skill") return validateSkill(args);
  if (name === "publish_skill") return publishSkill(args);
  if (name === "search_skills") return searchSkills(args);
  if (name === "read_skill") return readSkill(args);
  if (name === "install_skill") return installSkill(args);
  if (name === "search_skill_wiki") return searchSkillWiki(args);
  if (name === "read_skill_wiki") return readSkillWiki(args);
  if (name === "update_skill_wiki") return updateSkillWiki(args);
  if (name === "stage_skill_proposal") return stageSkillProposal(args);
  if (name === "read_skill_proposal") return readSkillProposal(args);
  if (name === "list_skill_proposals") return listSkillProposals(args);
  if (name === "finalize_skill_proposal") return finalizeSkillProposal(args);
  if (name === "record_skill_impact") return recordSkillImpact(args);
  if (name === "search_run_events") return searchRunEvents(args);
  if (name === "read_worker_log") return readWorkerLog(args);
  if (name === "summarize_worker_trace") return summarizeWorkerTrace(args);
  if (name === "browser_open") return browserOpen(args);
  if (name === "browser_snapshot") return browserSnapshot(args);
  if (name.startsWith("browser_")) return { ok: false, unavailable: true, error: toolMap.get(name)?.description };
  if (name === "start_job") return startJob(args);
  if (name === "list_jobs") return listJobs(args);
  if (name === "read_job_output") return readJobOutput(args);
  if (name === "wait_job") return waitJob(args);
  if (name === "cancel_job") return cancelJob(args);
  if (name === "loop_status") return loopStatus();
  return { ok: false, error: "Unknown tool: " + name };
}

async function batchToolCall(args, depth) {
  const calls = Array.isArray(args.calls) ? args.calls.slice(0, 8) : [];
  if (calls.length === 0) {
    return { ok: false, error: "batch_tool_call requires a non-empty calls array" };
  }
  const runOne = async (call, index) => {
    const toolName = String(call?.tool_name || "");
    if (!toolName) {
      return { index, ok: false, tool: "", error: "tool_name is required" };
    }
    if (toolName === "tool_call" || toolName === "batch_tool_call") {
      return {
        index,
        ok: false,
        tool: toolName,
        error: "Nested " + toolName + " is not allowed inside batch_tool_call",
      };
    }
    if (repairCandidate && !repairToolAllowed(toolName)) {
      return { index, ok: false, tool: toolName, error: "Tool is excluded from the repair candidate allowlist: " + toolName };
    }
    if (!toolMap.has(toolName)) {
      return { index, ok: false, tool: toolName, error: "Unknown tool: " + toolName };
    }
    try {
      const result = await callTool(toolName, call?.arguments || {}, depth);
      return { index, tool: toolName, ok: result?.ok !== false, result };
    } catch (error) {
      return {
        index,
        tool: toolName,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const results = args.parallel === true
    ? await Promise.all(calls.map((call, index) => runOne(call, index)))
    : [];
  if (args.parallel !== true) {
    for (let index = 0; index < calls.length; index += 1) {
      results.push(await runOne(calls[index], index));
    }
  }
  const fatal = results.some((result) =>
    /UNAUTHORIZED|RUN_TERMINAL|excluded from the repair candidate allowlist|Nested /i.test(
      String(result.error ?? ""),
    ),
  );
  return {
    ok: !fatal,
    all_ok: results.every((result) => result.ok),
    failed_count: results.filter((result) => !result.ok).length,
    parallel: args.parallel === true,
    truncated: Array.isArray(args.calls) && args.calls.length > calls.length,
    results,
  };
}

async function webSearch(args) {
  const query = required(args.query, "query");
  const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  const page = await fetchText(url, args.timeout_seconds || 20);
  const matches = [...page.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
  const max = Math.max(1, Math.min(Number(args.max_results || 8), 20));
  return { ok: true, query, results: matches.slice(0, max).map((m) => ({ title: cleanHtml(m[2]), url: decodeDuckUrl(m[1]), snippet: cleanHtml(m[3]) })) };
}

async function fetchWebpage(args) {
  const url = required(args.url, "url");
  const html = await fetchText(url, args.timeout_seconds || 45);
  return webpageResult(url, html, args.max_chars ?? 20000);
}

function sharedDir(sub) {
  const base = dataDir
    ? join(dataDir, "runs", "shared", safeRunId(parentRunId || runId), sub)
    : join(workspace, ".launchpad", sub);
  mkdirSync(base, { recursive: true });
  return base;
}

function writeTextAtomic(target, text) {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = target + "." + randomUUID().slice(0, 8) + ".tmp";
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, target);
}

function appendTextAtomic(target, text) {
  let prior = "";
  try {
    prior = readFileSync(target, "utf8");
  } catch {}
  writeTextAtomic(target, prior + text);
}

function writeJsonAtomic(target, value) {
  writeTextAtomic(target, JSON.stringify(value, null, 2));
}

function publishArtifact(args) {
  const id = randomUUID();
  const type = String(args.type || "text");
  const description = String(args.description || "");
  let text = args.text == null ? "" : String(args.text);
  let sourcePath = null;
  if (args.path) {
    const source = resolvePublishSourcePath(String(args.path));
    if (!source.ok) return source;
    sourcePath = readablePathLabel(source.path);
    try {
      text = readFileSync(source.path, "utf8");
    } catch (error) {
      return {
        ok: false,
        error: "Artifact source file could not be read.",
        path: String(args.path),
        sourcePath,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const dir = sharedDir("artifacts");
  const contentPath = join(dir, id + ".txt");
  const metadata = { id, type, description, sourcePath, ownerWorkerId: agentId, ownerWorkerRunId: runId, createdAt: new Date().toISOString(), path: id + ".txt" };
  writeTextAtomic(contentPath, text);
  writeJsonAtomic(join(dir, id + ".json"), metadata);
  return { ok: true, artifact: metadata };
}

function listArtifacts(args) {
  const dir = sharedDir("artifacts");
  let entries = [];
  try { entries = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))); } catch {}
  if (args.run_id) entries = entries.filter((entry) => entry.ownerWorkerRunId === String(args.run_id));
  entries.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return { ok: true, artifacts: entries };
}

function readArtifact(args) {
  const rawId = required(args.artifact_id, "artifact_id");
  const id = safeRunId(rawId);
  const dir = sharedDir("artifacts");
  try {
    const metadataPath = join(dir, id + ".json");
    const contentPath = join(dir, id + ".txt");
    if (!existsSync(metadataPath) || !existsSync(contentPath)) {
      return {
        ok: false,
        tool: "read_artifact",
        error: "Artifact was not found.",
        artifact_id: rawId,
        hint: "Call list_artifacts and pass one artifact id to read_artifact. sourcePath is only the publishing worker's original file path.",
      };
    }
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    const text = readFileSync(contentPath, "utf8");
    return { ok: true, artifact: metadata, text: clip(text, args.max_chars ?? 50000) };
  } catch (error) {
    return {
      ok: false,
      tool: "read_artifact",
      error: "Artifact could not be read.",
      artifact_id: rawId,
      detail: error instanceof Error ? error.message : String(error),
      hint: "Call list_artifacts and pass one artifact id to read_artifact. sourcePath is only the publishing worker's original file path.",
    };
  }
}

/**
 * Coordination goes through the server's authenticated ingress, never straight
 * to disk. The token identifies this worker; nothing in the request can claim to
 * be someone else, and the server persists the message before answering — so a
 * tool that returned ok is a message that survives a crash.
 */
async function coordinationCall(path, body) {
  if (!coordinationUrl || !coordinationToken) {
    throw new Error("Coordination is unavailable for this run: no ingress was provisioned.");
  }
  const response = await fetch(coordinationUrl.replace(/\/+$/, "") + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + coordinationToken,
    },
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error("Coordination refused: " + clip(text, 300));
  try { return JSON.parse(text); } catch { return { ok: true }; }
}

async function listTeammates() {
  const result = await coordinationCall("/teammates", {});
  return { ok: true, teammates: result.teammates || [] };
}

async function dispatchSubagent(args) {
  requireLeader("dispatch_subagent");
  const result = await coordinationCall("/dispatch_subagent", {
    id: args.id === undefined ? undefined : String(args.id),
    agentName: args.agentName === undefined ? undefined : String(args.agentName),
    title: args.title === undefined ? undefined : String(args.title),
    role: args.role === undefined ? undefined : String(args.role),
    prompt: required(args.prompt, "prompt"),
    objective: args.objective === undefined ? undefined : String(args.objective),
    successCriteria: Array.isArray(args.successCriteria) ? args.successCriteria.map(String) : undefined,
    expectedOutput: args.expectedOutput === undefined ? undefined : String(args.expectedOutput),
    dependsOn: Array.isArray(args.dependsOn) ? args.dependsOn.map(String) : undefined,
    requiresGitContribution: args.requiresGitContribution === false ? false : args.requiresGitContribution === true ? true : undefined,
    initialMessage: args.initialMessage === undefined ? undefined : String(args.initialMessage),
    initialMessageWorkspaceRefs: Array.isArray(args.initialMessageWorkspaceRefs)
      ? args.initialMessageWorkspaceRefs.map(String)
      : undefined,
    wait: args.wait === true,
    contractKey: args.contractKey === undefined ? undefined : String(args.contractKey),
    inputs: Array.isArray(args.inputs) ? args.inputs.map(String) : undefined,
    outputs: Array.isArray(args.outputs) ? args.outputs.map(String) : undefined,
    mutationPaths: Array.isArray(args.mutationPaths) ? args.mutationPaths.map(String) : undefined,
  });
  return result && typeof result === "object" ? result : { ok: true, result };
}

async function waitForWorkers(args) {
  const requestedTimeoutSeconds = Number(args.timeout_seconds || args.timeoutSeconds || 300);
  const timeoutSeconds = Math.max(
    1,
    Math.min(requestedTimeoutSeconds, WAIT_FOR_WORKERS_SAFE_TIMEOUT_SECONDS),
  );
  const result = await coordinationCall("/wait_workers", {
    targets: Array.isArray(args.targets) ? args.targets.map(String) : undefined,
    timeoutSeconds,
  });
  if (
    result &&
    typeof result === "object" &&
    requestedTimeoutSeconds > timeoutSeconds &&
    result.timedOut === true
  ) {
    return {
      ...result,
      requestedTimeoutSeconds,
      timeoutSeconds,
      hint:
        "This wait returned before the MCP client timeout. Follow pendingHandoffs.suggestedAction before waiting again; inspect only stale, blocked, or contradictory workers.",
    };
  }
  return result && typeof result === "object" ? result : { ok: true, result };
}

async function inspectWorkerProgress(args) {
  requireLeader("inspect_worker_progress");
  const result = await coordinationCall("/inspect_worker", {
    target: required(args.target, "target"),
    maxEvents: Number(args.max_events || 120),
  });
  return result && typeof result === "object" ? result : { ok: true, result };
}

async function extendWorkerTimeout(args) {
  requireLeader("extend_worker_timeout");
  const result = await coordinationCall("/extend_worker_timeout", {
    target: required(args.target, "target"),
    additionalSeconds: Number(args.additional_seconds || 0),
    reason: args.reason === undefined ? undefined : String(args.reason),
  });
  return result && typeof result === "object" ? result : { ok: true, result };
}

async function coordinationSend(args, delivery) {
  const target = required(args.target, "target");
  const content = required(args.content, "content");
  const refs = Array.isArray(args.workspace_refs) ? args.workspace_refs.map(String) : [];
  const result = await coordinationCall("/messages", {
    to: String(target),
    content: String(content),
    delivery,
    workspaceRefs: refs,
  });
  return { ok: true, message_id: result.id, delivery };
}

function customToolsDir() {
  return sharedDir("custom-tools");
}

function customToolName(value) {
  const name = required(value, "name").trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name)) {
    throw new Error("CUSTOM_TOOL_INVALID_NAME: use 1-64 chars: letters, numbers, underscore, dash, or dot, starting with a letter");
  }
  return name;
}

function customToolKey(value) {
  return customToolName(value).toLowerCase();
}

function readCustomToolRecords() {
  const dir = customToolsDir();
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        try { return JSON.parse(readFileSync(join(dir, file), "utf8")); } catch { return null; }
      })
      .filter((entry) => entry && typeof entry === "object" && entry.name);
  } catch {
    return [];
  }
}

function listCustomTools(args) {
  const query = String(args.query || "").toLowerCase();
  let entries = readCustomToolRecords();
  entries.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (query) {
    entries = entries.filter((tool) => (
      String(tool.name || "") + " " + String(tool.description || "")
    ).toLowerCase().includes(query));
  }
  return { ok: true, tools: entries };
}

function findCustomTool(name) {
  const key = customToolKey(name);
  return readCustomToolRecords().find((tool) => String(tool.key || tool.name).toLowerCase() === key) || null;
}

function registerCustomTool(args) {
  const name = customToolName(args.name);
  const key = name.toLowerCase();
  const source = resolveCustomToolScriptPath(required(args.path, "path"));
  if (!source.ok) return source;
  const timeoutSeconds = boundedTimeoutSeconds(args.timeout_seconds, 30);
  return withCustomToolRegistryLock(() => {
    const existing = readCustomToolRecords().find((tool) => String(tool.key || tool.name).toLowerCase() === key);
    if (existing) {
      return {
        ok: false,
        error: "CUSTOM_TOOL_NAME_EXISTS: " + name + " is already registered for this run",
        existing,
        hint: "Custom tool names are distinct per leader run. Choose a new name, or call the existing tool with call_custom_tool.",
      };
    }
    const toolRecord = {
      name,
      key,
      description: String(args.description || ""),
      path: readablePathLabel(source.path),
      interpreter: customToolInterpreter(args.interpreter, source.path),
      timeoutSeconds,
      ownerAgentId: agentId,
      ownerRunId: runId,
      createdAt: new Date().toISOString(),
    };
    writeJsonAtomic(join(customToolsDir(), key + ".json"), toolRecord);
    return {
      ok: true,
      tool: toolRecord,
      hint: "Other agents in this leader run can discover it with list_custom_tools and call it with call_custom_tool.",
    };
  });
}

function resolveCustomToolScriptPath(input) {
  try {
    const source = publishSourcePath(input);
    if (!existsSync(source)) {
      return {
        ok: false,
        error: "Custom tool script was not found.",
        path: input,
        workspace,
        commonWorkspace: commonWorkspace || null,
        hint: commonWorkspace
          ? "Create the script in /workspace for private use or $COMMON_WORKSPACE for team use before registering it."
          : "Create the script in /workspace before registering it. COMMON_WORKSPACE is not configured for this run.",
      };
    }
    if (parentRunId && commonWorkspace && !isInside(commonWorkspace, source)) {
      return {
        ok: false,
        error: "Custom tool script is private to this worker workspace.",
        path: input,
        resolvedPath: readablePathLabel(source),
        hint: "For other agents to use this tool, write the script under $COMMON_WORKSPACE and register that path.",
      };
    }
    return { ok: true, path: source };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      path: input,
      workspace,
      commonWorkspace: commonWorkspace || null,
      hint: commonWorkspace
        ? "register_custom_tool accepts scripts under /workspace or $COMMON_WORKSPACE; team-shared tools must be under $COMMON_WORKSPACE."
        : "register_custom_tool accepts scripts under /workspace. COMMON_WORKSPACE is not configured.",
    };
  }
}

function customToolInterpreter(value, scriptPath) {
  const raw = String(value || "").trim();
  if (raw) {
    if (["bash", "node", "python3"].includes(raw)) return raw;
    throw new Error("CUSTOM_TOOL_BAD_INTERPRETER: expected bash, node, or python3");
  }
  if (scriptPath.endsWith(".js") || scriptPath.endsWith(".mjs") || scriptPath.endsWith(".cjs")) return "node";
  if (scriptPath.endsWith(".py")) return "python3";
  return "bash";
}

function callCustomTool(args) {
  const toolRecord = findCustomTool(args.name);
  if (!toolRecord) {
    return {
      ok: false,
      error: "CUSTOM_TOOL_NOT_FOUND: " + String(args.name || ""),
      availableTools: readCustomToolRecords().map((tool) => tool.name),
      hint: "Call list_custom_tools to discover run-scoped tools before calling one.",
    };
  }
  const script = materializeCustomToolPath(String(toolRecord.path || ""));
  if (!script.ok) return script;
  const jsonArgs = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
    ? args.arguments
    : {};
  const timeoutSeconds = boundedTimeoutSeconds(args.timeout_seconds, Number(toolRecord.timeoutSeconds) || 30);
  const serialized = JSON.stringify(jsonArgs);
  const result = spawnSync(String(toolRecord.interpreter || "bash"), [script.path], {
    cwd: dirname(script.path),
    input: serialized + "\n",
    env: runtimeEnv({
      LAUNCHPAD_CUSTOM_TOOL_ARGS: serialized,
      LAUNCHPAD_CUSTOM_TOOL_NAME: String(toolRecord.name),
      LAUNCHPAD_CUSTOM_TOOL_OWNER_RUN_ID: String(toolRecord.ownerRunId || ""),
    }),
    encoding: "utf8",
    timeout: timeoutSeconds * 1000,
    maxBuffer: 2_000_000,
  });
  return {
    ok: result.status === 0 && !result.error,
    tool: toolRecord.name,
    exitCode: result.status,
    signal: result.signal || null,
    stdout: clip(result.stdout || "", 100000),
    stderr: clip(result.stderr || "", 100000),
    ...(result.error ? { error: result.error.message } : {}),
  };
}

async function bootstrapContext(args) {
  const max = Math.max(1, Math.min(Number(args.max_entries || 50), 200));
  let teammates = [];
  if (coordinationUrl && coordinationToken) {
    try {
      teammates = (await listTeammates()).teammates || [];
    } catch {}
  }
  return {
    ok: true,
    agentId,
    runId,
    parentRunId: parentRunId || null,
    workspace,
    codexHome: codexHome || null,
    commonWorkspace: commonWorkspace || null,
    teammates,
    whiteboard: whiteboardRead({ max }).entries,
    artifacts: listArtifacts({}).artifacts.slice(-max),
    customTools: listCustomTools({}).tools.slice(-max),
    skills: searchSkills({ limit: max }).skills,
    selectedSkills: selectedSkillsForRun().slice(-max),
    skillWiki: {
      resource: "launchpad://skill-wiki",
      index: "launchpad://skill-wiki/index.md",
      impact: "launchpad://skill-wiki/skill-impact.md",
      recent: searchSkillWiki({ limit: Math.min(max, 10), max_chars: 600 }).results,
    },
    skillProposals: listSkillProposals({ limit: Math.min(max, 20) }).proposals,
    jobs: listJobs({}).jobs.slice(-max),
    sharedFiles: listSharedFiles(max),
    hint: "Use this once at startup instead of separate whiteboard_read, list_artifacts, list_teammates, list_custom_tools, search_skills, search_skill_wiki, list_jobs, and shared-directory discovery calls.",
  };
}

function selectedSkillsForRun() {
  const parent = parentRunId || runId;
  if (!dataDir) return [];
  let database;
  try {
    database = JSON.parse(readFileSync(join(dataDir, "launchpad.json"), "utf8"));
  } catch {
    return [];
  }
  const runs = Array.isArray(database.runs) ? database.runs : [];
  const root = runs.find((item) => item && item.id === parent) ||
    runs.find((item) => item && item.id === runId);
  const records = root?.orchestration?.skillRouting;
  if (!Array.isArray(records)) return [];
  return records.flatMap((record) => {
    const selected = Array.isArray(record?.selected) ? record.selected : [];
    return selected.map((rank) => {
      const candidate = rank?.candidate || {};
      const install = Array.isArray(record?.install)
        ? record.install.find((item) => item && item.name === candidate.name)
        : null;
      return {
        name: String(candidate.name || ""),
        version: String(candidate.version || ""),
        score: Number.isFinite(Number(rank?.score)) ? Number(rank.score) : null,
        installedPath: install?.installedPath || install?.destination || candidate.installArguments?.destination ||
          (candidate.name ? "$COMMON_WORKSPACE/skills/" + candidate.name : null),
        reasons: Array.isArray(rank?.reasons) ? rank.reasons.filter((item) => typeof item === "string").slice(0, 5) : [],
        risks: Array.isArray(rank?.risks) ? rank.risks.filter((item) => typeof item === "string").slice(0, 5) : [],
        selectedAt: String(record.createdAt || ""),
        task: String(record.task || ""),
      };
    }).filter((item) => item.name && item.version);
  });
}

function materializeCustomToolPath(label) {
  try {
    const raw = String(label || "");
    let full;
    if (raw.startsWith("$COMMON_WORKSPACE/")) {
      if (!commonWorkspace) throw new Error("COMMON_WORKSPACE is not configured for this agent.");
      full = resolve(commonWorkspace, raw.slice("$COMMON_WORKSPACE/".length));
      if (!isInside(commonWorkspace, full)) throw new Error("Path escapes COMMON_WORKSPACE: " + raw);
    } else if (isAbsolute(raw)) {
      full = resolve(raw);
      if (!isInside(workspace, full) && !(commonWorkspace && isInside(commonWorkspace, full))) {
        throw new Error("Path escapes workspace: " + raw);
      }
    } else {
      full = publishSourcePath(raw);
    }
    if (!existsSync(full)) {
      return { ok: false, error: "Custom tool script was not found.", path: raw, hint: "The registered script path no longer exists in this agent's visible workspace." };
    }
    return { ok: true, path: full };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      path: label,
      hint: "Custom tools must point to a script visible to the calling agent, normally under $COMMON_WORKSPACE.",
    };
  }
}

function boundedTimeoutSeconds(value, fallback) {
  const raw = Number(value || fallback);
  if (!Number.isFinite(raw) || raw <= 0) return Math.max(1, Math.min(Number(fallback || 30), 120));
  return Math.max(1, Math.min(Math.floor(raw), 120));
}

function withCustomToolRegistryLock(work) {
  const dir = customToolsDir();
  const lock = join(dir, ".register.lock");
  const deadline = Date.now() + TASK_LOCK_TIMEOUT_MS;
  let held = false;
  while (!held) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), agentId + " " + String(Date.now()), "utf8");
      held = true;
    } catch {
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { age = 0; }
      if (age > TASK_LOCK_STALE_MS) {
        try { rmSync(lock, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("CUSTOM_TOOL_REGISTRY_BUSY: registry lock held longer than " + TASK_LOCK_TIMEOUT_MS + " ms");
      }
      sleepSync(25);
    }
  }
  try {
    return work();
  } finally {
    try { rmSync(lock, { recursive: true, force: true }); } catch {}
  }
}

function whiteboardPost(args) {
  const text = required(args.text, "text");
  const id = randomUUID();
  const entry = { id, author: agentId, authorRunId: runId, kind: String(args.kind || "note"), text: String(text), createdAt: new Date().toISOString() };
  writeJsonAtomic(join(sharedDir("whiteboard"), id + ".json"), entry);
  return { ok: true, entry };
}

function whiteboardRead(args) {
  const dir = sharedDir("whiteboard");
  let entries = [];
  try { entries = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))); } catch {}
  entries.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (args.since) entries = entries.filter((entry) => String(entry.createdAt) > String(args.since));
  const max = Math.max(1, Math.min(Number(args.max || 100), 500));
  return { ok: true, entries: entries.slice(0, max) };
}

function taskTool(name, args) {
  const taskId = String(args.task_id || runId);
  if (name === "view_task") {
    const state = readTaskState();
    const task = state.tasks[taskId];
    return {
      ok: true,
      revision: Number(state.revision) || 0,
      task: args.task_id ? task : undefined,
      tasks: args.task_id ? undefined : Object.values(state.tasks),
    };
  }
  const expected = args.expected_revision === undefined ? undefined : Number(args.expected_revision);
  const committed = withTaskState((state) => {
    state.tasks[taskId] ||= { task_id: taskId, status: "pending", claimant: null, plan: null, result: null, progress: [] };
    const task = state.tasks[taskId];
    if (name === "claim_task") {
      // First writer under the lock wins; a later claim sees the taken state.
      if (task.status === "claimed" && task.claimant && task.claimant !== agentId) {
        throw new Error("TASK_ALREADY_CLAIMED: " + taskId + " is held by " + task.claimant);
      }
      task.status = "claimed";
      task.claimant = agentId;
    }
    if (name === "submit_plan") { task.plan = String(args.plan || ""); task.status = "planned"; }
    if (name === "complete_task") { task.result = String(args.result || ""); task.status = "completed"; task.completedAt = new Date().toISOString(); }
    if (name === "report_progress") task.progress.push({ at: new Date().toISOString(), agentId, status: String(args.status || ""), detail: String(args.detail || "") });
    return task;
  }, expected);
  return { ok: true, revision: committed.revision, task: committed.result };
}

function listFiles(args) {
  const requested = String(args.path || ".");
  try {
    const root = workspacePath(requested);
    const max = Math.max(1, Math.min(Number(args.max_entries || 200), 1000));
    const out = [];
    walk(root, out, max);
    return { ok: true, root: relative(workspace, root) || ".", files: out };
  } catch (error) {
    return fileToolFailure("list_files", requested, error);
  }
}

function listSharedFiles(max) {
  if (!commonWorkspace) return [];
  try {
    const out = [];
    walkUnder(commonWorkspace, commonWorkspace, out, max);
    return out;
  } catch {
    return [];
  }
}

function searchFiles(args) {
  const requested = String(args.path || ".");
  try {
    required(args.query, "query");
    workspacePath(requested);
    const cmd = ["--line-number", "--no-heading", "--color", "never", "--", String(args.query), requested];
    if (args.glob) cmd.unshift("--glob", String(args.glob));
    const result = spawnSync("rg", cmd, { cwd: workspace, encoding: "utf8", timeout: 30_000, maxBuffer: 2_000_000 });
    const lines = (result.stdout || "").split(/\r?\n/).filter(Boolean).slice(0, Math.max(1, Math.min(Number(args.max_results || 100), 500)));
    return { ok: result.status === 0 || result.status === 1, matches: lines, stderr: clip(result.stderr || "", 2000) };
  } catch (error) {
    return fileToolFailure("search_files", requested, error);
  }
}

function readFileTool(args) {
  const requested = String(required(args.path, "path"));
  try {
    const path = readableFilePath(requested);
    return { ok: true, path: readablePathLabel(path), text: clip(readFileSync(path, "utf8"), args.max_chars ?? 40000) };
  } catch (error) {
    return fileToolFailure("read_file", requested, error);
  }
}

function readManyFiles(args) {
  const paths = Array.isArray(args.paths) ? args.paths : [];
  return {
    ok: true,
    files: paths.map((p) => {
      const requested = String(p);
      try {
        const path = readableFilePath(requested);
        return { path: readablePathLabel(path), requestedPath: requested, ok: true, text: clip(readFileSync(path, "utf8"), args.max_chars_each ?? 16000) };
      } catch (error) {
        return fileToolFailure("read_file", requested, error);
      }
    }),
  };
}

function validateSkill(args) {
  const requested = String(required(args.path, "path"));
  const maxFindings = Math.max(1, Math.min(Number(args.max_findings || 50), 200));
  try {
    const root = publishSourcePath(requested);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return {
        ok: false,
        path: requested,
        error: "SKILL_PATH_NOT_DIRECTORY",
        findings: [finding("error", "structure", "Skill path must be an existing directory.")],
      };
    }
    const findings = [];
    const skillPath = join(root, "SKILL.md");
    if (!existsSync(skillPath) || !statSync(skillPath).isFile()) {
      findings.push(finding("error", "structure", "Missing required SKILL.md at the skill root."));
      return skillValidationResult(requested, root, {}, findings, maxFindings);
    }

    const skillText = readFileSync(skillPath, "utf8");
    const frontmatter = parseSkillFrontmatter(skillText);
    if (!frontmatter.ok) {
      findings.push(finding("error", "frontmatter", frontmatter.error));
    }
    const name = String(frontmatter.values.name || "");
    const description = String(frontmatter.values.description || "");
    const folderName = basename(root);
    if (!name) {
      findings.push(finding("error", "frontmatter", "Frontmatter must include name."));
    } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      findings.push(finding("error", "frontmatter", "Skill name must be lowercase hyphen-case."));
    }
    if (name && folderName !== name) {
      findings.push(finding("warning", "naming", "Skill folder name should match frontmatter name '" + name + "'."));
    }
    if (!description) {
      findings.push(finding("error", "frontmatter", "Frontmatter must include description."));
    } else {
      if (description.length < 60) {
        findings.push(finding("warning", "trigger", "Description is probably too short to trigger reliably."));
      }
      if (!/\b(use|when|for|whenever|trigger|asks?|needs?)\b/i.test(description)) {
        findings.push(finding("warning", "trigger", "Description should include when to use the skill, not only what it is."));
      }
    }

    const body = frontmatter.body || skillText;
    const bodyLines = body.split(/\r?\n/).length;
    if (bodyLines > 500 || body.length > 30000) {
      findings.push(finding("warning", "progressive_disclosure", "SKILL.md is large; move detailed examples or references into referenced files."));
    }
    if (!/progressive disclosure|references\/|scripts\/|assets\//i.test(body)) {
      findings.push(finding("warning", "progressive_disclosure", "SKILL.md should explain how to use bundled scripts, references, or assets when they exist."));
    }

    const rootEntries = safeDirEntries(root);
    const rootNames = rootEntries.map((entry) => entry.name);
    for (const clutter of rootNames.filter((name) => /^(README|INSTALL|INSTALLATION|CHANGELOG|QUICK_REFERENCE)(\.md|\.txt)?$/i.test(name))) {
      findings.push(finding("warning", "clutter", "Avoid extra skill docs unless explicitly requested: " + clutter + "."));
    }
    for (const dirname of ["scripts", "references", "assets"]) {
      const dir = join(root, dirname);
      if (existsSync(dir) && !statSync(dir).isDirectory()) {
        findings.push(finding("error", "structure", dirname + " must be a directory when present."));
      }
    }

    const links = markdownRelativeLinks(body);
    for (const link of links) {
      const full = resolve(root, link);
      if (!isInside(root, full) || !existsSync(full)) {
        findings.push(finding("error", "resources", "Referenced path does not exist or escapes skill root: " + link));
      }
    }
    const mentionedResources = mentionedResourcePaths(body);
    for (const file of skillResourceFiles(root).filter((item) => !mentionedResources.has(item)).slice(0, 8)) {
      findings.push(finding("warning", "resources", "Bundled resource is not referenced from SKILL.md: " + file));
    }

    const portablePathMatches = portablePathReferences(body);
    for (const pathRef of portablePathMatches.slice(0, 5)) {
      findings.push(finding("warning", "portability", "Avoid embedding local scratch paths in reusable skill guidance: " + pathRef));
    }
    if (portablePathMatches.length > 5) {
      findings.push(finding("warning", "portability", "Additional local scratch path references found: " + (portablePathMatches.length - 5)));
    }

    const resourceSummary = skillResourceSummary(root);
    const imageLinks = markdownRelativeImageLinks(body);
    if (resourceSummary.imageFiles.length > 0 && imageLinks.length === 0) {
      findings.push(finding("warning", "grounding", "references/ or assets/ contains images, but SKILL.md does not map or embed image resources."));
    }
    if (resourceSummary.hasReferenceFiles && !resourceSummary.hasReferenceIndex && !/source|provenance|evidence|ground|reference/i.test(body)) {
      findings.push(finding("warning", "grounding", "references/ exists without a manifest/index/provenance file or SKILL.md source-grounding guidance."));
    }
    for (const imageLink of imageLinks) {
      if (!/^(?:references|assets)\//.test(imageLink)) {
        findings.push(finding("warning", "grounding", "Image resource should live under references/ or assets/ for portable reuse: " + imageLink));
      }
    }

    const scriptDir = join(root, "scripts");
    const scriptFiles = existsSync(scriptDir) && statSync(scriptDir).isDirectory()
      ? safeDirEntries(scriptDir).filter((entry) => entry.isFile()).map((entry) => entry.name)
      : [];
    if (scriptFiles.length > 0) {
      const scriptMentioned = /scripts\/|script/i.test(body);
      if (!scriptMentioned) {
        findings.push(finding("warning", "scripts", "scripts/ exists but SKILL.md does not describe when to use its scripts."));
      }
      const hasSmokeHint = /smoke|test|validate|verification|run .*script|quick_validate/i.test(body) ||
        scriptFiles.some((file) => /test|smoke|validate|check/i.test(file));
      if (!hasSmokeHint) {
        findings.push(finding("warning", "scripts", "Scripts exist but no representative smoke-test or validation path is documented."));
      }
      for (const file of scriptFiles) {
        const full = join(scriptDir, file);
        const mode = statSync(full).mode;
        const text = readFileSync(full, "utf8").slice(0, 200);
        if (!/^#!/.test(text) && (mode & 0o111) === 0 && /\.(sh|bash|py|js|mjs|cjs)$/.test(file)) {
          findings.push(finding("warning", "scripts", "Script has no shebang and is not executable: scripts/" + file));
        }
      }
    }

    const agentsYaml = join(root, "agents", "openai.yaml");
    if (existsSync(join(root, "agents")) && !existsSync(agentsYaml)) {
      findings.push(finding("warning", "metadata", "agents/ exists but agents/openai.yaml is missing."));
    }
    if (existsSync(agentsYaml)) {
      const yaml = readFileSync(agentsYaml, "utf8");
      for (const key of ["display_name", "short_description", "default_prompt"]) {
        if (!yamlHasTopLevelOrInterfaceKey(yaml, key)) {
          findings.push(finding("warning", "metadata", "agents/openai.yaml is missing " + key + "."));
        }
      }
      if (name && !yaml.toLowerCase().includes(name.replace(/-/g, " ").split(" ")[0])) {
        findings.push(finding("warning", "metadata", "agents/openai.yaml may not match the skill name/description."));
      }
    }

    const forwardEvidence = rootNames.some((item) => /forward.*test|fresh.*context|eval|evaluation/i.test(item)) ||
      /forward-test|fresh context|fresh-context|subagent/i.test(body);
    if (!forwardEvidence) {
      findings.push(finding("warning", "forward_test", "No fresh-context forward-test prompt/result evidence found."));
    }
    const qualityText = [name, description, body].join("\n");
    if (isCreativeArtifactSkill(qualityText) && !hasQualitativeReviewGate(qualityText)) {
      findings.push(finding("warning", "quality_gate", "Creative artifact skills should document a qualitative reviewer gate, not only structural validation."));
    }
    if (isContestProblemSetterSkill(qualityText)) {
      for (const gate of contestProblemSetterGateGaps(qualityText, scriptFiles)) {
        findings.push(finding("warning", "contest_gate", "Contest problem-setter skill should require " + gate + "."));
      }
    }

    return skillValidationResult(requested, root, { name, description }, findings, maxFindings);
  } catch (error) {
    return {
      ok: false,
      path: requested,
      error: error instanceof Error ? error.message : String(error),
      hint: toolHint("validate_skill", requested),
    };
  }
}

function skillValidationResult(requested, root, metadata, findings, maxFindings) {
  const errors = findings.filter((item) => item.severity === "error").length;
  const warnings = findings.filter((item) => item.severity === "warning").length;
  return {
    ok: errors === 0,
    path: requested,
    resolvedPath: readablePathLabel(root),
    metadata,
    summary: { errors, warnings, findings: findings.length },
    findings: findings.slice(0, maxFindings),
    clipped: findings.length > maxFindings,
  };
}

function publishSkill(args) {
  const requested = String(required(args.path, "path"));
  const validation = validateSkill({ path: requested, max_findings: 200 });
  if (!validation.ok) {
    return {
      ok: false,
      error: "SKILL_VALIDATION_FAILED",
      validation,
      hint: "Fix validation errors before publishing this skill to the hub.",
    };
  }
  const sourceRoot = publishSourcePath(requested);
  return publishValidatedSkillFromPath(sourceRoot, validation, args, readablePathLabel(sourceRoot));
}

function publishValidatedSkillFromPath(sourceRoot, validation, args, sourcePathLabel) {
  const name = String(validation.metadata?.name || "");
  if (!name) {
    return {
      ok: false,
      error: "SKILL_NAME_MISSING",
      validation,
    };
  }
  const version = skillVersion(args.version);
  const skillRoot = join(skillHubSkillsDir(), name, version);
  const metadataPath = join(skillRoot, ".launchpad-skill.json");
  if (existsSync(skillRoot)) {
    return {
      ok: false,
      error: "SKILL_VERSION_EXISTS: " + name + "@" + version,
      skill: readSkillHubRecord(name, version),
      hint: "Choose a new version label or omit version for a timestamped version.",
    };
  }
  mkdirSync(dirname(skillRoot), { recursive: true });
  copyDirectory(sourceRoot, skillRoot);
  const originPatterns = skillWikiRefs(args.origin_patterns);
  const evidenceRefs = skillWikiRefs(args.evidence_refs);
  const purposePath = join(sourceRoot, "PURPOSE.md");
  const provenanceWarnings = originPatterns.length > 0 && (!existsSync(purposePath) || !statSync(purposePath).isFile())
    ? ["Skill publication cites origin_patterns but the skill folder has no PURPOSE.md explaining provenance."]
    : [];
  const record = {
    name,
    version,
    description: String(validation.metadata?.description || ""),
    tags: skillTags(args.tags),
    notes: String(args.notes || ""),
    sourcePath: sourcePathLabel || readablePathLabel(sourceRoot),
    hubPath: readablePathLabel(skillRoot),
    originPatterns,
    evidenceRefs,
    supersedesVersion: args.supersedes_version === undefined || String(args.supersedes_version).trim() === ""
      ? null
      : skillVersion(args.supersedes_version),
    provenanceWarnings,
    ownerAgentId: agentId,
    ownerRunId: runId,
    parentRunId: parentRunId || null,
    validation: validation.summary,
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(metadataPath, record);
  writeSkillHubIndex();
  return {
    ok: true,
    skill: record,
    hint: "Future agents can discover it with search_skills and install it with install_skill.",
  };
}

function searchSkills(args) {
  const query = String(args.query || "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(Number(args.limit || 10), 50));
  let records = readSkillHubRecords();
  records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (query) {
    records = records.filter((record) => skillSearchHaystack(record).includes(query));
  }
  return {
    ok: true,
    query,
    skills: latestSkillRecords(records).slice(0, limit),
    totalMatches: records.length,
  };
}

function readSkill(args) {
  const name = skillName(required(args.name, "name"));
  const version = args.version === undefined || String(args.version).trim() === ""
    ? ""
    : skillVersion(args.version);
  const record = readSkillHubRecord(name, version);
  if (!record) {
    return {
      ok: false,
      error: "SKILL_NOT_FOUND: " + name + (version ? "@" + version : ""),
      available: searchSkills({ query: name, limit: 10 }).skills,
    };
  }
  const source = materializeSkillHubPath(record);
  if (!source.ok) return source;
  const skillPath = join(source.path, "SKILL.md");
  const purposePath = join(source.path, "PURPOSE.md");
  let text = "";
  let purposeText = "";
  try {
    text = readFileSync(skillPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      error: "SKILL_BODY_UNREADABLE",
      skill: record,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    if (existsSync(purposePath) && statSync(purposePath).isFile()) {
      purposeText = readFileSync(purposePath, "utf8");
    }
  } catch {}
  return {
    ok: true,
    skill: record,
    path: readablePathLabel(source.path),
    skillMd: clip(text, args.max_chars ?? 12000),
    clipped: text.length > Number(args.max_chars ?? 12000),
    purposeMd: purposeText ? clip(purposeText, args.max_chars ?? 12000) : "",
    purposeClipped: purposeText.length > Number(args.max_chars ?? 12000),
    install: {
      tool: "install_skill",
      arguments: { name: record.name, version: record.version },
      codexHomeArguments: { name: record.name, version: record.version, scope: "codex_home" },
    },
  };
}

function installSkill(args) {
  const name = skillName(required(args.name, "name"));
  const version = args.version === undefined || String(args.version).trim() === ""
    ? ""
    : skillVersion(args.version);
  const record = readSkillHubRecord(name, version);
  if (!record) {
    return {
      ok: false,
      error: "SKILL_NOT_FOUND: " + name + (version ? "@" + version : ""),
      available: searchSkills({ query: name, limit: 10 }).skills,
      hint: "Call search_skills to discover published skills and pass an exact name to install_skill.",
    };
  }
  const source = materializeSkillHubPath(record);
  if (!source.ok) return source;
  const destination = resolveSkillInstallDestination(args.destination, record.name, args.scope);
  if (!destination.ok) return destination;
  if (existsSync(destination.path)) {
    rmSync(destination.path, { recursive: true, force: true });
  }
  mkdirSync(dirname(destination.path), { recursive: true });
  copyDirectory(source.path, destination.path);
  const installRecord = {
    name: record.name,
    version: record.version,
    installedPath: readablePathLabel(destination.path),
    sourceHubPath: record.hubPath,
    installedByAgentId: agentId,
    installedByRunId: runId,
    installedAt: new Date().toISOString(),
  };
  writeJsonAtomic(join(destination.path, ".launchpad-installed-skill.json"), installRecord);
  return {
    ok: true,
    skill: record,
    installed: installRecord,
    hint: "Reference " + installRecord.installedPath + " in worker prompts, or use it directly from this run.",
  };
}

function searchSkillWiki(args) {
  ensureSkillWiki();
  const query = String(args.query || "").trim().toLowerCase();
  const skillFilter = String(args.skill || "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(Number(args.limit || 10), 50));
  const maxChars = Math.max(200, Math.min(Number(args.max_chars || 1200), 8000));
  const results = [];
  for (const page of listSkillWikiPages()) {
    let text = "";
    try {
      text = readFileSync(page.fullPath, "utf8");
    } catch {
      continue;
    }
    const haystack = (page.path + "\n" + text).toLowerCase();
    if (query && !haystack.includes(query)) continue;
    if (skillFilter && !haystack.includes(skillFilter)) continue;
    const index = query ? haystack.indexOf(query) : 0;
    const start = Math.max(0, index - 160);
    results.push({
      path: page.path,
      kind: page.kind,
      excerpt: clip(text.slice(start), maxChars),
    });
    if (results.length >= limit) break;
  }
  return {
    ok: true,
    query,
    skill: skillFilter || null,
    results,
    wiki: {
      root: readablePathLabel(skillWikiRoot()),
      index: "launchpad://skill-wiki/index.md",
      impact: "launchpad://skill-wiki/skill-impact.md",
    },
  };
}

function readSkillWiki(args) {
  ensureSkillWiki();
  const requested = String(args.path || "index.md").trim() || "index.md";
  const page = resolveSkillWikiPath(requested);
  if (!page.ok) return page;
  if (!existsSync(page.path) || !statSync(page.path).isFile()) {
    return {
      ok: false,
      error: "SKILL_WIKI_PAGE_NOT_FOUND",
      path: page.relativePath,
      available: listSkillWikiPages().map((entry) => entry.path).slice(0, 100),
    };
  }
  const text = readFileSync(page.path, "utf8");
  const maxChars = Math.max(0, Math.min(Number(args.max_chars ?? 20000), 200000));
  return {
    ok: true,
    path: page.relativePath,
    text: clip(text, maxChars),
    clipped: text.length > maxChars,
  };
}

function updateSkillWiki(args) {
  ensureSkillWiki();
  const changed = [];
  const created = [];
  const evidenceRefs = skillWikiRefs(args.evidence_refs);
  const createPatterns = Array.isArray(args.create_patterns) ? args.create_patterns.slice(0, 20) : [];
  const updatePatterns = Array.isArray(args.update_patterns) ? args.update_patterns.slice(0, 20) : [];
  for (const pattern of createPatterns) {
    const name = skillWikiPatternPath(pattern?.name);
    const page = resolveSkillWikiPath(name);
    if (!page.ok) return page;
    if (existsSync(page.path)) {
      return { ok: false, error: "SKILL_WIKI_PATTERN_EXISTS", path: page.relativePath };
    }
    const content = normalizeSkillWikiPatternContent(pattern?.content, evidenceRefs);
    writeTextAtomic(page.path, content);
    created.push(page.relativePath);
    changed.push(page.relativePath);
  }
  for (const pattern of updatePatterns) {
    const name = skillWikiPatternPath(pattern?.name);
    const page = resolveSkillWikiPath(name);
    if (!page.ok) return page;
    if (!existsSync(page.path)) {
      return { ok: false, error: "SKILL_WIKI_PATTERN_NOT_FOUND", path: page.relativePath };
    }
    const edits = Array.isArray(pattern?.edits) ? pattern.edits.slice(0, 30) : [];
    let text = readFileSync(page.path, "utf8");
    for (const edit of edits) {
      const applied = applySkillWikiEdit(text, edit);
      if (!applied.ok) return { ...applied, path: page.relativePath };
      text = applied.text;
    }
    writeTextAtomic(page.path, text);
    changed.push(page.relativePath);
  }
  if (args.update_index !== undefined && args.update_index !== null && String(args.update_index).trim() !== "") {
    writeTextAtomic(join(skillWikiRoot(), "index.md"), ensureMarkdownHeading(String(args.update_index), "Skill Wiki Index"));
    changed.push("index.md");
  }
  if (args.append_log !== undefined && args.append_log !== null && String(args.append_log).trim() !== "") {
    appendTextAtomic(join(skillWikiRoot(), "log.md"), formatSkillWikiMaintainerLog(String(args.append_log), evidenceRefs));
    changed.push("log.md");
  }
  return {
    ok: true,
    created,
    changed: [...new Set(changed)],
    evidenceRefs,
    wiki: {
      index: "launchpad://skill-wiki/index.md",
      log: "launchpad://skill-wiki/log.md",
    },
    hint: "Skill proposers can now read these pattern pages and cite them through publish_skill origin_patterns or record_skill_impact.",
  };
}

function stageSkillProposal(args) {
  ensureSkillWiki();
  const requested = String(required(args.candidate_path, "candidate_path"));
  const validation = validateSkill({ path: requested, max_findings: 200 });
  if (!validation.ok) {
    return {
      ok: false,
      error: "SKILL_PROPOSAL_VALIDATION_FAILED",
      validation,
      hint: "Fix candidate skill validation errors before staging a proposal.",
    };
  }
  const sourceRoot = publishSourcePath(requested);
  const skill = args.skill === undefined || String(args.skill).trim() === ""
    ? skillName(String(validation.metadata?.name || ""))
    : skillName(args.skill);
  const id = "proposal-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  const root = join(skillProposalRoot(), id);
  const snapshotPath = join(root, "candidate");
  copyDirectory(sourceRoot, snapshotPath);
  const record = {
    id,
    skill,
    baseVersion: String(args.base_version || ""),
    proposedVersion: args.proposed_version === undefined || String(args.proposed_version).trim() === ""
      ? ""
      : skillVersion(args.proposed_version),
    proposalSummary: String(args.proposal_summary || ""),
    diff: String(args.diff || ""),
    originPatterns: skillWikiRefs(args.origin_patterns),
    evidenceRefs: skillWikiRefs(args.evidence_refs),
    notes: String(args.notes || ""),
    candidateSourcePath: readablePathLabel(sourceRoot),
    candidateSnapshotPath: readablePathLabel(snapshotPath),
    ownerAgentId: agentId,
    ownerRunId: runId,
    parentRunId: parentRunId || null,
    validation: validation.summary,
    validationMetadata: validation.metadata,
    status: "staged",
    createdAt: new Date().toISOString(),
    finalizedAt: null,
    impactId: null,
    publishedSkill: null,
  };
  writeJsonAtomic(skillProposalMetadataPath(id), record);
  appendTextAtomic(join(skillWikiRoot(), "log.md"), "- " + record.createdAt + ": staged proposal " + id + " for " + skill + " - " + (record.proposalSummary || "candidate skill change") + "\n");
  return {
    ok: true,
    proposal: record,
    read: { tool: "read_skill_proposal", arguments: { proposal_id: id } },
    finalize: { tool: "finalize_skill_proposal", arguments: { proposal_id: id, accepted: true } },
    hint: "Run validation on the staged candidate, then call finalize_skill_proposal with accepted=true or false.",
  };
}

function readSkillProposal(args) {
  const id = skillProposalId(required(args.proposal_id, "proposal_id"));
  const record = readSkillProposalRecord(id);
  if (!record) {
    return { ok: false, error: "SKILL_PROPOSAL_NOT_FOUND", proposal_id: id };
  }
  const snapshotPath = materializeSkillProposalSnapshotPath(record);
  const maxChars = Math.max(0, Math.min(Number(args.max_chars ?? 12000), 200000));
  let skillMd = "";
  let purposeMd = "";
  try {
    skillMd = readFileSync(join(snapshotPath, "SKILL.md"), "utf8");
  } catch {}
  try {
    const purposePath = join(snapshotPath, "PURPOSE.md");
    if (existsSync(purposePath) && statSync(purposePath).isFile()) {
      purposeMd = readFileSync(purposePath, "utf8");
    }
  } catch {}
  return {
    ok: true,
    proposal: record,
    skillMd: clip(skillMd, maxChars),
    skillMdClipped: skillMd.length > maxChars,
    purposeMd: clip(purposeMd, maxChars),
    purposeMdClipped: purposeMd.length > maxChars,
  };
}

function listSkillProposals(args) {
  const query = String(args.query || "").trim().toLowerCase();
  const skillFilter = String(args.skill || "").trim().toLowerCase();
  const statusFilter = String(args.status || "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(Number(args.limit || 20), 100));
  let proposals = readSkillProposalRecords();
  proposals.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  if (skillFilter) proposals = proposals.filter((proposal) => String(proposal.skill || "").toLowerCase() === skillFilter);
  if (statusFilter) proposals = proposals.filter((proposal) => String(proposal.status || "").toLowerCase() === statusFilter);
  if (query) proposals = proposals.filter((proposal) => skillProposalHaystack(proposal).includes(query));
  return {
    ok: true,
    query,
    skill: skillFilter || null,
    status: statusFilter || null,
    proposals: proposals.slice(0, limit),
    totalMatches: proposals.length,
  };
}

function finalizeSkillProposal(args) {
  ensureSkillWiki();
  const id = skillProposalId(required(args.proposal_id, "proposal_id"));
  const record = readSkillProposalRecord(id);
  if (!record) {
    return { ok: false, error: "SKILL_PROPOSAL_NOT_FOUND", proposal_id: id };
  }
  if (record.status !== "staged") {
    return { ok: false, error: "SKILL_PROPOSAL_ALREADY_FINALIZED", proposal: record };
  }
  const accepted = Boolean(args.accepted);
  const impact = recordSkillImpact({
    skill: record.skill,
    version: args.version || record.proposedVersion || record.baseVersion || "",
    accepted,
    validation_score: args.validation_score || "",
    validation_delta: args.validation_delta || "",
    proposal_summary: record.proposalSummary,
    diff: record.diff,
    origin_patterns: record.originPatterns,
    evidence_refs: record.evidenceRefs,
    notes: [record.notes, args.notes ? String(args.notes) : ""].filter(Boolean).join("\n"),
  });
  let published = null;
  if (accepted && Boolean(args.publish)) {
    const snapshotPath = materializeSkillProposalSnapshotPath(record);
    const validation = { ok: true, metadata: record.validationMetadata || { name: record.skill }, summary: record.validation || {} };
    published = publishValidatedSkillFromPath(snapshotPath, validation, {
      version: args.version || record.proposedVersion || undefined,
      tags: [],
      notes: [record.proposalSummary, args.notes ? String(args.notes) : ""].filter(Boolean).join("\n"),
      origin_patterns: record.originPatterns,
      evidence_refs: record.evidenceRefs,
      supersedes_version: record.baseVersion || undefined,
    }, record.candidateSnapshotPath);
    if (!published.ok) {
      return { ok: false, error: "SKILL_PROPOSAL_PUBLISH_FAILED", published, impact };
    }
  }
  const next = {
    ...record,
    status: accepted ? "accepted" : "rejected",
    finalizedAt: new Date().toISOString(),
    impactId: impact.impact?.id || null,
    publishedSkill: published?.skill || null,
  };
  writeJsonAtomic(skillProposalMetadataPath(id), next);
  return {
    ok: true,
    proposal: next,
    impact,
    published,
    hint: accepted && !published ? "Accepted impact was recorded. Publish separately or pass publish=true to promote the staged candidate." : "Proposal finalized.",
  };
}

function recordSkillImpact(args) {
  ensureSkillWiki();
  const skill = skillName(required(args.skill, "skill"));
  const accepted = Boolean(args.accepted);
  const version = args.version === undefined || String(args.version).trim() === ""
    ? new Date().toISOString().replace(/[:.]/g, "-")
    : skillVersion(args.version);
  const record = {
    id: randomUUID(),
    skill,
    version,
    accepted,
    validationScore: String(args.validation_score || ""),
    validationDelta: String(args.validation_delta || ""),
    proposalSummary: String(args.proposal_summary || ""),
    diff: String(args.diff || ""),
    originPatterns: skillWikiRefs(args.origin_patterns),
    evidenceRefs: skillWikiRefs(args.evidence_refs),
    notes: String(args.notes || ""),
    ownerAgentId: agentId,
    ownerRunId: runId,
    parentRunId: parentRunId || null,
    createdAt: new Date().toISOString(),
  };
  appendTextAtomic(join(skillWikiRoot(), "impact-records.jsonl"), JSON.stringify(record) + "\n");
  appendTextAtomic(join(skillWikiRoot(), "skill-impact.md"), formatSkillImpactMarkdown(record));
  appendTextAtomic(join(skillWikiRoot(), "log.md"), formatSkillWikiLog(record));
  return {
    ok: true,
    impact: record,
    pages: {
      impact: "launchpad://skill-wiki/skill-impact.md",
      log: "launchpad://skill-wiki/log.md",
    },
    hint: "Future skill proposers should read skill-impact.md before repeating or extending this intervention.",
  };
}

function skillHubRoot() {
  const root = dataDir ? join(dataDir, "skill-hub") : join(workspace, ".launchpad", "skill-hub");
  mkdirSync(root, { recursive: true });
  return root;
}

function skillHubSkillsDir() {
  const dir = join(skillHubRoot(), "skills");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function skillWikiRoot() {
  const dir = join(skillHubRoot(), "wiki");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function skillProposalRoot() {
  const dir = join(skillHubRoot(), "proposals");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function skillProposalId(value) {
  const id = String(value || "").trim();
  if (!/^proposal-[a-zA-Z0-9_.-]{1,120}$/.test(id)) {
    throw new Error("SKILL_PROPOSAL_BAD_ID");
  }
  return id;
}

function skillProposalMetadataPath(id) {
  return join(skillProposalRoot(), skillProposalId(id), "proposal.json");
}

function readSkillProposalRecord(id) {
  try {
    const record = JSON.parse(readFileSync(skillProposalMetadataPath(id), "utf8"));
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}

function readSkillProposalRecords() {
  const records = [];
  for (const proposalEntry of safeDirEntries(skillProposalRoot())) {
    if (!proposalEntry.isDirectory()) continue;
    const id = proposalEntry.name;
    try {
      skillProposalId(id);
    } catch {
      continue;
    }
    const record = readSkillProposalRecord(id);
    if (record) records.push(record);
  }
  return records;
}

function skillProposalHaystack(record) {
  return [
    record.id,
    record.skill,
    record.status,
    record.baseVersion,
    record.proposedVersion,
    record.proposalSummary,
    record.diff,
    record.notes,
    Array.isArray(record.originPatterns) ? record.originPatterns.join(" ") : "",
    Array.isArray(record.evidenceRefs) ? record.evidenceRefs.join(" ") : "",
  ].map((value) => String(value || "").toLowerCase()).join(" ");
}

function materializeSkillProposalSnapshotPath(record) {
  const id = skillProposalId(record.id);
  const full = join(skillProposalRoot(), id, "candidate");
  if (!existsSync(full) || !statSync(full).isDirectory()) {
    throw new Error("SKILL_PROPOSAL_SNAPSHOT_MISSING: " + id);
  }
  return full;
}

function ensureSkillWiki() {
  const root = skillWikiRoot();
  mkdirSync(join(root, "patterns"), { recursive: true });
  const defaults = [
    ["index.md", "# Skill Wiki Index\n\nCompiled patterns from agent experience. Add one concise entry per reusable failure mode or success strategy.\n"],
    ["log.md", "# Skill Wiki Evolution Log\n\nChronological notes from skill consolidation and validation-gated edits.\n"],
    ["skill-impact.md", "# Skill Impact Tracker\n\nAccepted and rejected skill proposals. Skill proposers should read this before repeating an intervention.\n"],
    ["impact-records.jsonl", ""],
  ];
  for (const [file, text] of defaults) {
    const full = join(root, file);
    if (!existsSync(full)) writeTextAtomic(full, text);
  }
}

function listSkillWikiPages() {
  ensureSkillWiki();
  const root = skillWikiRoot();
  const pages = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of safeDirEntries(current)) {
      const full = join(current, entry.name);
      const rel = relative(root, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!/\.(md|jsonl|txt)$/i.test(entry.name)) continue;
      pages.push({
        path: rel,
        fullPath: full,
        kind: rel.startsWith("patterns/") ? "pattern" : rel === "skill-impact.md" || rel === "impact-records.jsonl" ? "impact" : "wiki",
      });
    }
  }
  pages.sort((a, b) => a.path.localeCompare(b.path));
  return pages;
}

function resolveSkillWikiPath(input) {
  const requested = String(input || "index.md").trim().replace(/^launchpad:\/\/skill-wiki\//, "");
  if (!requested || requested.includes("\0") || isAbsolute(requested)) {
    return { ok: false, error: "SKILL_WIKI_BAD_PATH: use a wiki-relative path" };
  }
  const root = skillWikiRoot();
  const full = resolve(root, requested);
  if (!isInside(root, full)) {
    return { ok: false, error: "SKILL_WIKI_BAD_PATH: path escapes skill wiki" };
  }
  return {
    ok: true,
    path: full,
    relativePath: relative(root, full).replace(/\\/g, "/"),
  };
}

function readSkillHubRecords() {
  const dir = skillHubSkillsDir();
  const records = [];
  for (const skillEntry of safeDirEntries(dir)) {
    if (!skillEntry.isDirectory()) continue;
    const skillDir = join(dir, skillEntry.name);
    for (const versionEntry of safeDirEntries(skillDir)) {
      if (!versionEntry.isDirectory()) continue;
      const metadata = readSkillHubRecord(skillEntry.name, versionEntry.name);
      if (metadata) records.push(metadata);
    }
  }
  return records;
}

function readSkillHubRecord(name, version) {
  const safeName = skillName(name);
  const base = join(skillHubSkillsDir(), safeName);
  let selectedVersion = String(version || "");
  if (!selectedVersion) {
    const versions = safeDirEntries(base)
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    selectedVersion = versions.at(-1) || "";
  }
  if (!selectedVersion) return null;
  try {
    const record = JSON.parse(readFileSync(join(base, selectedVersion, ".launchpad-skill.json"), "utf8"));
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}

function writeSkillHubIndex() {
  const records = readSkillHubRecords();
  records.sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.version).localeCompare(String(b.version)));
  writeJsonAtomic(join(skillHubRoot(), "index.json"), { updatedAt: new Date().toISOString(), skills: records });
}

function latestSkillRecords(records) {
  const byName = new Map();
  for (const record of records) {
    const prior = byName.get(record.name);
    if (!prior || String(record.createdAt).localeCompare(String(prior.createdAt)) > 0) {
      byName.set(record.name, record);
    }
  }
  return Array.from(byName.values());
}

function skillSearchHaystack(record) {
  return [
    record.name,
    record.version,
    record.description,
    Array.isArray(record.tags) ? record.tags.join(" ") : "",
    Array.isArray(record.originPatterns) ? record.originPatterns.join(" ") : "",
    Array.isArray(record.evidenceRefs) ? record.evidenceRefs.join(" ") : "",
    record.notes,
  ].map((value) => String(value || "").toLowerCase()).join(" ");
}

function skillName(value) {
  const name = String(value || "").trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error("SKILL_INVALID_NAME: use lowercase hyphen-case");
  }
  return name;
}

function skillVersion(value) {
  const raw = String(value || "").trim();
  const version = raw || new Date().toISOString().replace(/[:.]/g, "-");
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(version)) {
    throw new Error("SKILL_INVALID_VERSION: use 1-80 chars: letters, numbers, underscore, dash, or dot");
  }
  return version;
}

function skillTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))]
    .filter((tag) => /^[a-z0-9_.-]{1,40}$/.test(tag))
    .slice(0, 20);
}

function skillWikiRefs(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((ref) => String(ref).trim()).filter(Boolean))]
    .filter((ref) => ref.length <= 300 && !ref.includes("\0"))
    .slice(0, 50);
}

function skillWikiPatternPath(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.includes("\0") || isAbsolute(raw)) {
    throw new Error("SKILL_WIKI_BAD_PATTERN_NAME: use a relative markdown file name");
  }
  const normalized = raw.startsWith("patterns/") ? raw : "patterns/" + raw;
  if (!/^patterns\/[a-z0-9][a-z0-9_.\/-]*\.md$/.test(normalized) || normalized.includes("..")) {
    throw new Error("SKILL_WIKI_BAD_PATTERN_NAME: use patterns/lowercase-name.md");
  }
  return normalized;
}

function normalizeSkillWikiPatternContent(content, evidenceRefs) {
  const text = ensureMarkdownHeading(String(content || "").trim(), "Skill Wiki Pattern");
  if (evidenceRefs.length === 0 || /(^|\n)## Evidence refs\b/i.test(text)) return text + (text.endsWith("\n") ? "" : "\n");
  return text + (text.endsWith("\n") ? "" : "\n") + "\n## Evidence refs\n\n" + evidenceRefs.map((ref) => "- " + ref).join("\n") + "\n";
}

function ensureMarkdownHeading(text, fallbackTitle) {
  const trimmed = String(text || "").trim();
  if (/^#\s+/m.test(trimmed)) return trimmed + "\n";
  return "# " + fallbackTitle + "\n\n" + trimmed + "\n";
}

function applySkillWikiEdit(text, edit) {
  const op = String(edit?.op || "").trim();
  const content = String(edit?.content || "");
  if (op === "append") {
    return { ok: true, text: text + (text.endsWith("\n") ? "" : "\n") + content + (content.endsWith("\n") ? "" : "\n") };
  }
  const target = String(edit?.target || "");
  if (!target) {
    return { ok: false, error: "SKILL_WIKI_EDIT_TARGET_REQUIRED" };
  }
  const index = text.indexOf(target);
  if (index < 0) {
    return { ok: false, error: "SKILL_WIKI_EDIT_TARGET_NOT_FOUND", target };
  }
  if (op === "replace") {
    return { ok: true, text: text.slice(0, index) + content + text.slice(index + target.length) };
  }
  if (op === "insert_after") {
    return { ok: true, text: text.slice(0, index + target.length) + content + text.slice(index + target.length) };
  }
  return { ok: false, error: "SKILL_WIKI_BAD_EDIT_OP: expected append, replace, or insert_after" };
}

function formatSkillWikiMaintainerLog(summary, evidenceRefs) {
  const lines = [
    "",
    "## " + new Date().toISOString() + " - Wiki maintainer update",
    "",
    String(summary).trim(),
  ];
  if (evidenceRefs.length > 0) {
    lines.push("", "Evidence refs:", ...evidenceRefs.map((ref) => "- " + ref));
  }
  lines.push("");
  return lines.join("\n");
}

function formatSkillImpactMarkdown(record) {
  const status = record.accepted ? "Accepted" : "Rejected";
  return [
    "",
    "## " + record.createdAt + " - " + status + " - " + record.skill + "@" + record.version,
    "",
    "- Proposal: " + (record.proposalSummary || "(not provided)"),
    "- Validation: " + (record.validationScore || "(not provided)") + (record.validationDelta ? " (" + record.validationDelta + ")" : ""),
    "- Origin patterns: " + (record.originPatterns.length ? record.originPatterns.join(", ") : "(none recorded)"),
    "- Evidence refs: " + (record.evidenceRefs.length ? record.evidenceRefs.join(", ") : "(none recorded)"),
    "- Run: " + record.ownerRunId + (record.parentRunId ? " under " + record.parentRunId : ""),
    record.notes ? "- Notes: " + record.notes : "",
    record.diff ? "\n~~~diff\n" + record.diff.slice(0, 20000) + "\n~~~" : "",
    "",
  ].filter((line) => line !== "").join("\n");
}

function formatSkillWikiLog(record) {
  const status = record.accepted ? "accepted" : "rejected";
  return "- " + record.createdAt + ": " + status + " " + record.skill + "@" + record.version + " - " + (record.proposalSummary || "skill proposal") + "\n";
}

function materializeSkillHubPath(record) {
  try {
    const name = skillName(record.name);
    const version = skillVersion(record.version);
    const full = join(skillHubSkillsDir(), name, version);
    if (!existsSync(full) || !statSync(full).isDirectory()) {
      return { ok: false, error: "SKILL_HUB_COPY_MISSING", skill: { name, version } };
    }
    return { ok: true, path: full };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function resolveSkillInstallDestination(input, name, scope) {
  try {
    const requestedScope = String(scope || "run").trim();
    if (requestedScope !== "run" && requestedScope !== "codex_home") {
      return {
        ok: false,
        error: "SKILL_BAD_INSTALL_SCOPE: expected run or codex_home",
      };
    }
    if (requestedScope === "codex_home") {
      if (!codexHome) {
        return {
          ok: false,
          error: "CODEX_HOME_UNAVAILABLE",
          hint: "The MCP server was not launched with CODEX_HOME in its environment.",
        };
      }
      if (input !== undefined && input !== null && String(input).trim() !== "") {
        const full = codexHomePath(String(input));
        return { ok: true, path: full };
      }
      return { ok: true, path: join(codexHome, "skills", skillName(name)) };
    }
    if (input !== undefined && input !== null && String(input).trim() !== "") {
      const full = publishSourcePath(String(input));
      return { ok: true, path: full };
    }
    if (commonWorkspace) {
      return { ok: true, path: join(commonWorkspace, "skills", skillName(name)) };
    }
    return { ok: true, path: join(workspace, "skills", skillName(name)) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      hint: "Run-scope install destinations must stay under /workspace or $COMMON_WORKSPACE. Codex-home installs must stay under $CODEX_HOME.",
    };
  }
}

function copyDirectory(source, destination) {
  const sourceStat = statSync(source);
  if (!sourceStat.isDirectory()) {
    throw new Error("COPY_SOURCE_NOT_DIRECTORY: " + source);
  }
  if (existsSync(destination)) {
    rmSync(destination, { recursive: true, force: true });
  }
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      const rel = relative(source, src);
      if (!rel) return true;
      return !rel.split(/[\\/]/).some((part) => part === ".git" || part === "node_modules");
    },
  });
}

function finding(severity, category, message) {
  return { severity, category, message };
}

function parseSkillFrontmatter(text) {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { ok: false, error: "SKILL.md must start with YAML frontmatter delimited by ---.", values: {}, body: text };
  }
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { ok: false, error: "SKILL.md frontmatter is missing a closing --- delimiter.", values: {}, body: text };
  }
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) values[kv[1]] = kv[2].replace(/^['"]|['"]$/g, "").trim();
  }
  return { ok: true, values, body: match[2] };
}

function markdownRelativeLinks(text) {
  const links = [];
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const raw = String(match[1] || "").split("#", 1)[0].trim();
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#")) continue;
    links.push(raw);
  }
  return links;
}

function markdownRelativeImageLinks(text) {
  const links = [];
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = String(match[1] || "").split("#", 1)[0].trim();
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#")) continue;
    links.push(raw);
  }
  return links;
}

function mentionedResourcePaths(text) {
  const paths = new Set(markdownRelativeLinks(text).concat(markdownRelativeImageLinks(text)));
  for (const match of text.matchAll(/(?:^|[\s"'(])((?:references|scripts|assets)\/[A-Za-z0-9._~/-]+)/g)) {
    paths.add(String(match[1] || "").replace(/[.,;:]+$/, ""));
  }
  return paths;
}

function portablePathReferences(text) {
  const refs = new Set();
  for (const match of text.matchAll(/(^|[\s("'])((?:\/Users\/|\/tmp\/|\/workspace(?:\/|\b)|\/common-workspace(?:\/|\b))[^\s)"']*)/gm)) {
    refs.add(match[2]);
  }
  return Array.from(refs);
}

function skillResourceFiles(root) {
  const files = [];
  for (const dirname of ["references", "assets", "scripts"]) {
    const dir = join(root, dirname);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of safeDirEntries(current)) {
        const full = join(current, entry.name);
        const rel = relative(root, full).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          stack.push(full);
        } else {
          files.push(rel);
        }
      }
    }
  }
  return files.sort();
}

function isCreativeArtifactSkill(text) {
  return /\b(generate|create|design|draft|write|produce|build)\b[\s\S]{0,80}\b(deck|presentation|slide|problem|statement|article|report|image|visual|asset|story|copy|creative|artifact)\b/i.test(text);
}

function hasQualitativeReviewGate(text) {
  return /\b(qualitative|human-facing|reviewer|critique|domain-faithful|non-generic|original|polish|quality rubric|acceptance rubric)\b/i.test(text);
}

function isContestProblemSetterSkill(text) {
  return /\b(problem[- ]setter|programming contest|contest problem|olympiad|HKOI|IOI|Codeforces|AtCoder)\b/i.test(text);
}

function contestProblemSetterGateGaps(text, scriptFiles) {
  const combined = text + "\n" + scriptFiles.join(" ");
  const required = [
    ["sample verification", /\b(sample|samples)\b[\s\S]{0,80}\b(check|verify|run|match|reference)\b/i],
    ["brute-vs-reference cross-checking", /\b(brute|bruteforce|oracle)\b[\s\S]{0,100}\b(reference|target|intended|solution)\b/i],
    ["originality or reskin auditing", /\b(originality|reskin|near[- ]copy|semantic[- ]difference|web search)\b/i],
    ["unintended-solution probing", /\b(unintended|wrong approach|weaker solution|complexity claim|TLE)\b/i],
  ];
  return required
    .filter(([, pattern]) => !pattern.test(combined))
    .map(([label]) => label);
}

function skillResourceSummary(root) {
  const imageFiles = [];
  let hasReferenceFiles = false;
  let hasReferenceIndex = false;
  for (const dirname of ["references", "assets"]) {
    const dir = join(root, dirname);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of safeDirEntries(current)) {
        const full = join(current, entry.name);
        const rel = relative(root, full).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (dirname === "references") hasReferenceFiles = true;
        if (/^(references|assets)\/(?:.*\/)?(?:manifest|index|provenance|sources)\.(md|json|ya?ml|txt)$/i.test(rel)) {
          hasReferenceIndex = true;
        }
        if (/\.(png|jpe?g|gif|webp|avif)$/i.test(entry.name)) {
          imageFiles.push(rel);
        }
      }
    }
  }
  return { imageFiles, hasReferenceFiles, hasReferenceIndex };
}

function yamlHasTopLevelOrInterfaceKey(yaml, key) {
  let inInterface = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inInterface = /^interface\s*:/.test(line);
      if (new RegExp("^" + key + "\\s*:").test(line)) return true;
      continue;
    }
    if (inInterface && new RegExp("^\\s+" + key + "\\s*:").test(line)) return true;
  }
  return false;
}

function safeDirEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function searchRunEvents(args) {
  const events = readEvents(args.run_id || parentRunId || runId);
  const q = String(args.query || "").toLowerCase();
  return { ok: true, matches: events.filter((event) => JSON.stringify(event).toLowerCase().includes(q)).slice(0, args.max_results || 50) };
}

function readWorkerLog(args) {
  const events = readEvents(args.run_id || runId).slice(-(args.max_events || 80));
  if (args.full) return { ok: true, events, clipped: false };
  const maxChars = Math.max(0, Math.min(Number(args.max_chars ?? 600), 200000));
  let anyTruncated = false;
  const clippedEvents = events.map((event) => {
    const { next, truncated } = clipEventText(event, maxChars);
    if (truncated) anyTruncated = true;
    return next;
  });
  return {
    ok: true,
    events: clippedEvents,
    clipped: anyTruncated,
    ...(anyTruncated
      ? {
          hint:
            "Some events were trimmed to " +
            maxChars +
            " chars/field (truncated:true). To see one in full, call again with a higher max_chars or full:true.",
        }
      : {}),
  };
}

/**
 * Return a shallow copy of an event with its bulky free-text fields
 * (command / output / error text) clipped to 'max' characters. Structure —
 * seq, kind, name, status, timings, exit code — is preserved untouched so the
 * caller can still see what happened; only the volume is trimmed. This is
 * default-on protection for the reader's context window, never a hard wall:
 * read_worker_log's full:true / higher max_chars returns the untouched text.
 */
function clipEventText(event, max) {
  if (event === null || typeof event !== "object") return { next: event, truncated: false };
  let truncated = false;
  const clipField = (value) => {
    const text = String(value ?? "");
    if (text.length <= max) return value;
    truncated = true;
    return text.slice(0, max) + "…[+" + (text.length - max) + " chars, use full:true]";
  };
  const input = event.input && typeof event.input === "object" ? { ...event.input } : event.input;
  if (input && typeof input === "object") {
    if (typeof input.command === "string") input.command = clipField(input.command);
    if (typeof input.text === "string") input.text = clipField(input.text);
  }
  const output = event.output && typeof event.output === "object" ? { ...event.output } : event.output;
  if (output && typeof output === "object" && typeof output.text === "string") {
    output.text = clipField(output.text);
  }
  const error = event.error && typeof event.error === "object" ? { ...event.error } : event.error;
  if (error && typeof error === "object" && typeof error.message === "string") {
    error.message = clipField(error.message);
  }
  const next = { ...event, input, output, error };
  if (truncated) next.truncated = true;
  return { next, truncated };
}

function summarizeWorkerTrace(args) {
  const events = readEvents(args.run_id || runId);
  const counts = {};
  for (const event of events) counts[event.kind || event.type || "unknown"] = (counts[event.kind || event.type || "unknown"] || 0) + 1;
  return { ok: true, run_id: args.run_id || runId, counts, tail: events.slice(-10).map((e) => ({ kind: e.kind, status: e.status, name: e.name, text: clip(e.output?.text || e.error?.message || "", 500) })) };
}

async function browserOpen(args) {
  const url = required(args.url, "url");
  const html = await fetchText(url, args.timeout_seconds || 45);
  browserState.set(runId, { url, html });
  return webpageResult(url, html, 4000);
}

function browserSnapshot(args) {
  const state = browserState.get(runId);
  if (!state) return { ok: false, error: "No page is open. Call browser_open first." };
  return webpageResult(state.url, state.html, args.max_chars ?? 20000);
}

function startJob(args) {
  const command = required(args.command, "command");
  cleanupOldJobs();
  const running = [...jobs.values()].filter((job) => job.status === "running").length;
  if (running >= MAX_RUNNING_JOBS) {
    return {
      ok: false,
      error: "JOB_LIMIT_REACHED: " + String(MAX_RUNNING_JOBS) + " background jobs are already running",
      jobs: listJobs({}).jobs,
      hint: "Wait for, read, or cancel an existing job before starting another.",
    };
  }
  let cwd;
  try {
    cwd = jobCwd(args.cwd);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      cwd: args.cwd === undefined ? null : String(args.cwd),
      workspace,
      commonWorkspace: commonWorkspace || null,
      hint: "cwd must stay under /workspace or $COMMON_WORKSPACE.",
    };
  }
  const timeoutSeconds = boundedJobTimeoutSeconds(args.timeout_seconds, 1800);
  const shell = existsSync("/usr/bin/bash") ? "/usr/bin/bash" : "/bin/bash";
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const child = spawn(shell, ["-lc", String(command)], {
    cwd,
    env: runtimeEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const job = {
    id,
    command: clip(command, 2000),
    cwd: readablePathLabel(cwd),
    status: "running",
    startedAt,
    endedAt: null,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    outputTruncated: false,
    child,
    timeout: null,
    killTimer: null,
    waiters: [],
  };
  jobs.set(id, job);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => appendJobOutput(job, "stdout", chunk));
  child.stderr.on("data", (chunk) => appendJobOutput(job, "stderr", chunk));
  child.on("error", (error) => {
    appendJobOutput(job, "stderr", error instanceof Error ? error.message : String(error));
    finishJob(job, "failed", null, null);
  });
  child.on("exit", (code, signal) => {
    const status = job.status === "timed_out" || job.status === "cancelled"
      ? job.status
      : code === 0 ? "completed" : "failed";
    finishJob(job, status, code, signal || null);
  });
  job.timeout = setTimeout(() => {
    if (job.status !== "running") return;
    job.status = "timed_out";
    job.endedAt = new Date().toISOString();
    killJobTree(job);
  }, timeoutSeconds * 1000);
  job.timeout.unref();
  return {
    ok: true,
    job: jobSummary(job),
    output: readJobOutput({ job_id: id, max_chars: args.max_output_chars ?? 4000 }),
    hint: "Use read_job_output for non-blocking checks, wait_job for short waits, or cancel_job to stop it.",
  };
}

function listJobs(_args) {
  cleanupOldJobs();
  return { ok: true, jobs: [...jobs.values()].map(jobSummary) };
}

function readJobOutput(args) {
  const job = getJob(args.job_id);
  if (!job) {
    return {
      ok: false,
      error: "JOB_NOT_FOUND: " + String(args.job_id || ""),
      jobs: [...jobs.values()].map(jobSummary),
    };
  }
  const maxChars = Math.max(1, Math.min(Number(args.max_chars || 20000), 200000));
  const stdoutOffset = Math.max(0, Math.min(Number(args.stdout_offset || 0), job.stdout.length));
  const stderrOffset = Math.max(0, Math.min(Number(args.stderr_offset || 0), job.stderr.length));
  const stdoutRoom = Math.max(0, maxChars);
  const stdout = clip(job.stdout.slice(stdoutOffset), stdoutRoom);
  const stderr = clip(job.stderr.slice(stderrOffset), Math.max(0, maxChars - stdout.length));
  return {
    ok: true,
    job: jobSummary(job),
    stdout,
    stderr,
    stdoutOffset,
    stderrOffset,
    nextStdoutOffset: stdoutOffset + stdout.length,
    nextStderrOffset: stderrOffset + stderr.length,
    outputTruncated: job.outputTruncated || stdoutOffset + stdout.length < job.stdout.length || stderrOffset + stderr.length < job.stderr.length,
  };
}

async function waitJob(args) {
  const job = getJob(args.job_id);
  if (!job) {
    return {
      ok: false,
      error: "JOB_NOT_FOUND: " + String(args.job_id || ""),
      jobs: [...jobs.values()].map(jobSummary),
    };
  }
  if (job.status === "running") {
    const requested = Math.max(0, Math.min(Number(args.timeout_seconds || 5), 60));
    const seconds = Math.min(requested, remainingRootMs() / 1000, 60);
    await new Promise((resolveWait) => {
      const timer = setTimeout(resolveWait, seconds * 1000);
      timer.unref();
      job.waiters.push(() => {
        clearTimeout(timer);
        resolveWait();
      });
    });
  }
  return readJobOutput(args);
}

function cancelJob(args) {
  const job = getJob(args.job_id);
  if (!job) {
    return {
      ok: false,
      error: "JOB_NOT_FOUND: " + String(args.job_id || ""),
      jobs: [...jobs.values()].map(jobSummary),
    };
  }
  if (job.status === "running") {
    job.status = "cancelled";
    job.endedAt = new Date().toISOString();
    killJobTree(job);
    notifyJobWaiters(job);
  }
  return { ok: true, job: jobSummary(job) };
}

function getJob(id) {
  return jobs.get(String(id || ""));
}

function killJobTree(job) {
  const child = job.child;
  const pid = child && child.pid;
  if (job.timeout) {
    clearTimeout(job.timeout);
    job.timeout = null;
  }
  try {
    if (pid) process.kill(-pid, "SIGTERM");
    else if (child) child.kill("SIGTERM");
  } catch {}
  job.killTimer = setTimeout(() => {
    try {
      if (pid) process.kill(-pid, "SIGKILL");
      else if (job.child) job.child.kill("SIGKILL");
    } catch {}
  }, 3000);
  job.killTimer.unref();
}

function terminateAllJobs() {
  if (runTerminal) return;
  runTerminal = true;
  for (const job of jobs.values()) {
    if (job.status === "running") {
      job.status = "cancelled";
      job.endedAt = new Date().toISOString();
      killJobTree(job);
      notifyJobWaiters(job);
    }
  }
}

function finishJob(job, status, code, signal) {
  if (job.status !== "timed_out" && job.status !== "cancelled") {
    job.status = status;
    job.endedAt = new Date().toISOString();
  }
  job.exitCode = code;
  job.signal = signal;
  if (job.timeout) clearTimeout(job.timeout);
  if (job.killTimer && job.status !== "running") clearTimeout(job.killTimer);
  notifyJobWaiters(job);
}

function notifyJobWaiters(job) {
  const waiters = job.waiters.splice(0);
  for (const waiter of waiters) {
    try { waiter(); } catch {}
  }
}

function appendJobOutput(job, key, chunk) {
  const next = String(chunk || "");
  if (!next) return;
  const otherKey = key === "stdout" ? "stderr" : "stdout";
  const currentTotal = job.stdout.length + job.stderr.length;
  const remaining = JOB_OUTPUT_LIMIT - currentTotal;
  if (remaining <= 0) {
    job.outputTruncated = true;
    return;
  }
  if (next.length > remaining) job.outputTruncated = true;
  job[key] += next.slice(0, Math.max(0, remaining));
  if (job[otherKey].length + job[key].length > JOB_OUTPUT_LIMIT) {
    job.outputTruncated = true;
    job[key] = job[key].slice(0, Math.max(0, JOB_OUTPUT_LIMIT - job[otherKey].length));
  }
}

function cleanupOldJobs() {
  const finished = [...jobs.values()].filter((job) => job.status !== "running");
  finished.sort((a, b) => String(a.endedAt || a.startedAt).localeCompare(String(b.endedAt || b.startedAt)));
  while (jobs.size > 40 && finished.length > 0) {
    const job = finished.shift();
    jobs.delete(job.id);
  }
}

function jobSummary(job) {
  return {
    id: job.id,
    command: job.command,
    cwd: job.cwd,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    stdoutChars: job.stdout.length,
    stderrChars: job.stderr.length,
    outputTruncated: job.outputTruncated,
  };
}

function jobCwd(input) {
  if (input === undefined || input === null || String(input).trim() === "") return workspace;
  const raw = String(input);
  if (raw === "$COMMON_WORKSPACE") {
    if (!commonWorkspace) throw new Error("COMMON_WORKSPACE is not configured: " + raw);
    return commonWorkspace;
  }
  if (raw.startsWith("$COMMON_WORKSPACE/")) {
    if (!commonWorkspace) throw new Error("COMMON_WORKSPACE is not configured: " + raw);
    const full = resolve(commonWorkspace, raw.slice("$COMMON_WORKSPACE/".length));
    if (!isInside(commonWorkspace, full)) throw new Error("Path escapes COMMON_WORKSPACE: " + raw);
    return full;
  }
  if (isAbsolute(raw)) {
    const full = resolve(raw);
    if (isInside(workspace, full)) return full;
    if (commonWorkspace && isInside(commonWorkspace, full)) return full;
    throw new Error("Path escapes workspace: " + raw);
  }
  return workspacePath(raw);
}

function boundedJobTimeoutSeconds(value, fallback) {
  const raw = Number(value || fallback);
  if (!Number.isFinite(raw) || raw <= 0) return Math.max(1, Math.min(Number(fallback || 1800), 7200));
  return Math.max(1, Math.min(Math.floor(raw), 7200));
}

function searchTools(args) {
  const query = String(args.query || "").toLowerCase();
  const limit = Math.max(1, Math.min(Number(args.limit || 8), 30));
  const staticResults = listedTools().filter((t) => (t.name + " " + t.description).toLowerCase().includes(query));
  const customResults = (repairCandidate ? [] : readCustomToolRecords())
    .filter((toolRecord) => (
      String(toolRecord.name || "") + " " + String(toolRecord.description || "")
    ).toLowerCase().includes(query))
    .map((toolRecord) => ({
      name: "custom:" + toolRecord.name,
      description: "Custom run-scoped tool. " + String(toolRecord.description || ""),
      callWith: "call_custom_tool",
      arguments: { name: toolRecord.name, arguments: {} },
    }));
  const skillResults = latestSkillRecords(readSkillHubRecords())
    .filter((skill) => !query || skillSearchHaystack(skill).includes(query))
    .map((skill) => ({
      name: "skill:" + skill.name,
      description: "Published Codex skill. " + String(skill.description || ""),
      version: skill.version,
      tags: Array.isArray(skill.tags) ? skill.tags : [],
      callWith: "read_skill",
      arguments: { name: skill.name, version: skill.version },
      installWith: "install_skill",
      installArguments: { name: skill.name, version: skill.version },
    }));
  const results = [...staticResults, ...customResults, ...skillResults].slice(0, limit);
  return { ok: true, query, results };
}

function loopStatus() {
  const state = readTaskState();
  return {
    ok: true,
    recentCalls: state.calls.slice(-30),
    warning: detectLoop(state.calls),
    observational: true,
    authorizesContinuation: false,
  };
}

function recordCall(name, args) {
  const hash = createHash("sha1").update(name + JSON.stringify(args, Object.keys(args).sort())).digest("hex").slice(0, 12);
  try {
    withTaskState((state) => {
      state.calls.push({ at: new Date().toISOString(), agentId, name, hash });
      state.calls = state.calls.slice(-60);
    });
  } catch {
    // Bookkeeping must never fail the tool call it is describing.
  }
}

function detectLoop(calls) {
  if (calls.length < 8) return null;
  const last = calls.at(-1)?.hash;
  const trailing = [...calls].reverse().findIndex((c) => c.hash !== last);
  const count = trailing < 0 ? calls.length : trailing;
  return count >= 8 ? { kind: "repeated_tool_call", trailingIdentical: count } : null;
}

function readEvents(id) {
  if (!dataDir) return [];
  const safe = safeRunId(String(id));
  const rawId = String(id);
  for (const base of [["runs", "events"], ["event"], ["events"]]) {
    const root = join(dataDir, ...base);
    let sessions = [];
    try {
      sessions = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory() || session.name === ".deleted") continue;
      const sessionPath = join(root, session.name);
      // Current layout: session dir with a manifest mapping a member folder to
      // this run id, each member holding trajectory.jsonl.
      try {
        const manifest = JSON.parse(readFileSync(join(sessionPath, "session.json"), "utf8"));
        const member = (manifest.members || []).find((m) => m.runId === rawId);
        if (member) return parseJsonlFile(join(sessionPath, member.member, "trajectory.jsonl"));
      } catch {}
    }
    // Legacy layouts: flat "{ts}_{runId}/events.jsonl" and bare "{runId}.jsonl".
    try {
      const sub = sessions.find(
        (entry) => entry.isDirectory() && entry.name.endsWith("_" + safe),
      );
      if (sub) return parseJsonlFile(join(root, sub.name, "events.jsonl"));
    } catch {}
    try {
      const flat = readdirSync(root)
        .find((entry) => entry === safe + ".jsonl" || entry.endsWith("-" + safe + ".jsonl"));
      if (flat) return parseJsonlFile(join(root, flat));
    } catch {}
  }
  return [];
}

function parseJsonlFile(file) {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function readTaskState() {
  const dir = dataDir ? join(dataDir, "runs", "tool-state") : join(workspace, ".launchpad", "tool-state");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, safeRunId(parentRunId || runId) + ".json");
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return { tasks: {}, calls: [] }; }
}

function taskStateDir() {
  const dir = dataDir ? join(dataDir, "runs", "tool-state") : join(workspace, ".launchpad", "tool-state");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTaskState(state) {
  const dir = taskStateDir();
  const target = join(dir, safeRunId(parentRunId || runId) + ".json");
  writeTextAtomic(target, JSON.stringify(state, null, 2));
}

function positiveIntEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : fallback;
}

const TASK_LOCK_TIMEOUT_MS = positiveIntEnv("LAUNCHPAD_TASK_LOCK_TIMEOUT_MS", 5000);
const TASK_LOCK_STALE_MS = Math.max(
  positiveIntEnv("LAUNCHPAD_TASK_LOCK_STALE_MS", 30000),
  TASK_LOCK_TIMEOUT_MS + 1000,
);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serialise read-modify-write on the shared task file.
 *
 * Sibling workers run concurrently against one file keyed by parent run, so an
 * unguarded read-then-write loses whichever update lands first. A directory
 * create is the atomic primitive available here; the loser retries rather than
 * clobbering. A lock older than the stale bound is reclaimed, because a worker
 * container can vanish mid-write and nothing else would ever release it.
 */
function withTaskState(mutate, expectedRevision) {
  const dir = taskStateDir();
  const lock = join(dir, safeRunId(parentRunId || runId) + ".lock");
  const deadline = Date.now() + TASK_LOCK_TIMEOUT_MS;
  let held = false;
  while (!held) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), agentId + " " + String(Date.now()), "utf8");
      held = true;
    } catch (error) {
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { age = 0; }
      if (age > TASK_LOCK_STALE_MS) {
        try { rmSync(lock, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("TASK_STATE_BUSY: task state lock held longer than " + TASK_LOCK_TIMEOUT_MS + " ms");
      }
      sleepSync(50);
    }
  }
  try {
    const state = readTaskState();
    const current = Number(state.revision) || 0;
    if (expectedRevision !== undefined && Number(expectedRevision) !== current) {
      throw new Error("TASK_STALE_REVISION: expected " + String(expectedRevision) + " but state is at " + String(current));
    }
    const result = mutate(state);
    state.revision = current + 1;
    writeTaskState(state);
    return { result, revision: state.revision };
  } finally {
    try { rmSync(lock, { recursive: true, force: true }); } catch {}
  }
}

async function fetchText(url, seconds) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(5, Number(seconds || 20)) * 1000);
  try {
    const response = await fetch(String(url), { signal: controller.signal, headers: { "user-agent": "LaunchpadMCP/1.0" } });
    const text = await response.text();
    if (!response.ok) throw new Error("HTTP " + response.status + ": " + clip(text, 500));
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function webpageResult(url, html, maxChars) {
  const title = cleanHtml((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [,""])[1]);
  const text = clip(cleanHtml(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")), maxChars);
  const links = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].slice(0, 50).map((m) => ({ text: cleanHtml(m[2]), href: m[1] }));
  return { ok: true, url, title, text, links };
}

function walk(dir, out, max) {
  if (out.length >= max) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".launchpad") continue;
    const full = join(dir, entry.name);
    out.push({ path: relative(workspace, full), type: entry.isDirectory() ? "directory" : "file" });
    if (entry.isDirectory()) walk(full, out, max);
    if (out.length >= max) break;
  }
}

function walkUnder(root, dir, out, max) {
  if (out.length >= max) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".launchpad") continue;
    const full = join(dir, entry.name);
    out.push({ path: "$COMMON_WORKSPACE/" + (relative(root, full) || "."), type: entry.isDirectory() ? "directory" : "file" });
    if (entry.isDirectory()) walkUnder(root, full, out, max);
    if (out.length >= max) break;
  }
}

function workspacePath(input) {
  const full = resolve(workspace, input);
  const rel = relative(workspace, full);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path escapes workspace: " + input);
  return full;
}

function publishSourcePath(input) {
  if (input.startsWith("$COMMON_WORKSPACE/")) {
    if (!commonWorkspace) throw new Error("COMMON_WORKSPACE is not configured: " + input);
    const full = resolve(commonWorkspace, input.slice("$COMMON_WORKSPACE/".length));
    if (!isInside(commonWorkspace, full)) throw new Error("Path escapes COMMON_WORKSPACE: " + input);
    return full;
  }
  if (input.startsWith("/common-workspace/") || input === "/common-workspace") {
    if (!commonWorkspace) throw new Error("COMMON_WORKSPACE is not configured: " + input);
    const suffix = input === "/common-workspace" ? "" : input.slice("/common-workspace/".length);
    const full = resolve(commonWorkspace, suffix);
    if (!isInside(commonWorkspace, full)) throw new Error("Path escapes COMMON_WORKSPACE: " + input);
    return full;
  }
  if (input.startsWith("common-workspace/") || input === "common-workspace") {
    if (!commonWorkspace) throw new Error("COMMON_WORKSPACE is not configured: " + input);
    const suffix = input === "common-workspace" ? "" : input.slice("common-workspace/".length);
    const full = resolve(commonWorkspace, suffix);
    if (!isInside(commonWorkspace, full)) throw new Error("Path escapes COMMON_WORKSPACE: " + input);
    return full;
  }
  if (input === "$COMMON_WORKSPACE") {
    if (!commonWorkspace) throw new Error("COMMON_WORKSPACE is not configured: " + input);
    return commonWorkspace;
  }
  if (isAbsolute(input)) {
    const full = resolve(input);
    if (isInside(workspace, full)) return full;
    if (commonWorkspace && isInside(commonWorkspace, full)) return full;
    throw new Error("Path escapes workspace: " + input);
  }
  const workspaceCandidate = workspacePath(input);
  if (existsSync(workspaceCandidate)) return workspaceCandidate;
  if (commonWorkspace) {
    const commonCandidate = resolve(commonWorkspace, input);
    if (!isInside(commonWorkspace, commonCandidate)) throw new Error("Path escapes COMMON_WORKSPACE: " + input);
    if (existsSync(commonCandidate)) return commonCandidate;
  }
  return workspaceCandidate;
}

function readableFilePath(input) {
  const full = publishSourcePath(input);
  if (!existsSync(full)) throw new Error("ENOENT: no such file or directory, open '" + full + "'");
  if (!statSync(full).isFile()) throw new Error("Path is not a file: " + input);
  return full;
}

function codexHomePath(input) {
  if (!codexHome) throw new Error("CODEX_HOME is not configured: " + input);
  if (input === "$CODEX_HOME") return codexHome;
  if (input.startsWith("$CODEX_HOME/")) {
    const full = resolve(codexHome, input.slice("$CODEX_HOME/".length));
    if (!isInside(codexHome, full)) throw new Error("Path escapes CODEX_HOME: " + input);
    return full;
  }
  if (isAbsolute(input)) {
    const full = resolve(input);
    if (isInside(codexHome, full)) return full;
    throw new Error("Path escapes CODEX_HOME: " + input);
  }
  const full = resolve(codexHome, input);
  if (!isInside(codexHome, full)) throw new Error("Path escapes CODEX_HOME: " + input);
  return full;
}

function resolvePublishSourcePath(input) {
  try {
    const source = publishSourcePath(input);
    if (existsSync(source)) return { ok: true, path: source };
    const candidates = [workspacePath(input)];
    if (commonWorkspace && !isAbsolute(input)) candidates.push(resolve(commonWorkspace, input));
    return {
      ok: false,
      error: "Artifact source file was not found.",
      path: input,
      workspace,
      commonWorkspace: commonWorkspace || null,
      checked: candidates.map(readablePathLabel),
      hint: commonWorkspace
        ? "Write the file inside /workspace or $COMMON_WORKSPACE, or pass the absolute /common-workspace/... path."
        : "COMMON_WORKSPACE is not configured in the Launchpad MCP environment; restart with the updated MCP config overrides or publish a file from /workspace.",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      path: input,
      workspace,
      commonWorkspace: commonWorkspace || null,
      hint: commonWorkspace
        ? "publish_artifact only accepts files under /workspace or $COMMON_WORKSPACE."
        : "COMMON_WORKSPACE is not configured in the Launchpad MCP environment; /common-workspace cannot be published until the MCP env includes it.",
    };
  }
}

function readablePathLabel(full) {
  if (isInside(workspace, full)) return relative(workspace, full) || ".";
  if (codexHome && isInside(codexHome, full)) {
    return "$CODEX_HOME/" + (relative(codexHome, full) || ".");
  }
  if (commonWorkspace && isInside(commonWorkspace, full)) {
    return "$COMMON_WORKSPACE/" + (relative(commonWorkspace, full) || ".");
  }
  return full;
}

function toolFailure(name, args, error) {
  const message = error instanceof Error ? error.message : String(error);
  const requestedPath = args && typeof args === "object" && "path" in args ? String(args.path) : undefined;
  return {
    ok: false,
    tool: name,
    error: message,
    ...(requestedPath ? { path: requestedPath } : {}),
    hint: toolHint(name, requestedPath),
  };
}

function fileToolFailure(tool, requested, error) {
  const detail = error instanceof Error ? error.message : String(error);
  const artifact = findArtifactBySourcePath(requested);
  return {
    ok: false,
    tool,
    error: "Workspace file could not be read.",
    path: requested,
    workspace,
    detail,
    ...(artifact
      ? {
        artifact_id: artifact.id,
        artifact: { id: artifact.id, description: artifact.description, sourcePath: artifact.sourcePath, ownerWorkerRunId: artifact.ownerWorkerRunId },
        hint: "This path matches a published artifact sourcePath. Use launchpad.read_artifact with artifact_id " + artifact.id + " instead of launchpad.read_file.",
      }
      : { hint: toolHint(tool, requested) }),
  };
}

function findArtifactBySourcePath(requested) {
  const normalized = String(requested || "").replace(/^\.\/+/, "");
  try {
    const artifacts = listArtifacts({}).artifacts || [];
    return artifacts.find((artifact) => {
      const source = String(artifact.sourcePath || "");
      return source === normalized || source === requested || basename(source) === basename(normalized);
    }) || null;
  } catch {
    return null;
  }
}

function toolHint(name, requestedPath) {
  if (name === "read_file" || name === "read_many_files") {
    return commonWorkspace
      ? "read_file can read /workspace files and $COMMON_WORKSPACE files. Use $COMMON_WORKSPACE/foo, /common-workspace/foo, common-workspace/foo, or a relative path such as reports/foo.md when it exists only in the shared workspace. If the path came from list_artifacts, read_artifact by artifact_id also works."
      : "read_file reads this worker's private /workspace. COMMON_WORKSPACE is not configured for shared files.";
  }
  if (name === "publish_artifact") {
    return commonWorkspace
      ? "Publish a file under /workspace or $COMMON_WORKSPACE, or pass text directly."
      : "Publish a file under /workspace, pass text directly, or restart with COMMON_WORKSPACE configured for shared files.";
  }
  if (name === "register_custom_tool" || name === "call_custom_tool" || name === "list_custom_tools") {
    return "Use register_custom_tool for scripts under $COMMON_WORKSPACE, list_custom_tools to discover them, and call_custom_tool to run one by name.";
  }
  if (name === "list_files" || name === "search_files") {
    return "This tool only inspects this worker's private /workspace.";
  }
  if (requestedPath) {
    return "Check required arguments and whether the path is in this worker's visible workspace.";
  }
  return "Check required arguments and tool availability.";
}

function isInside(root, full) {
  const rel = relative(root, full);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeRunId(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(name + " is required");
  return value;
}

function cleanHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/\s+/g, " ").trim();
}

function decodeDuckUrl(url) {
  try {
    const parsed = new URL(url, "https://duckduckgo.com");
    return parsed.searchParams.get("uddg") || parsed.href;
  } catch { return url; }
}

function clip(text, max) {
  return String(text || "").slice(0, Math.max(0, Number(max || 0)));
}

function tool(name, description, properties, required) {
  return { name, description, inputSchema: { type: "object", properties, required } };
}

function compactToolCatalog(entries) {
  return entries.map((entry) => ({
    ...entry,
    description: compactToolDescription(entry.description),
    inputSchema: compactJsonSchema(entry.inputSchema),
  }));
}

function compactToolDescription(value) {
  const text = String(value || "").trim();
  if (text.length <= 120) return text;
  return text.slice(0, 117).replace(/\s+\S*$/, "") + "...";
}

function compactJsonSchema(value) {
  if (Array.isArray(value)) return value.map((item) => compactJsonSchema(item));
  if (value === null || typeof value !== "object") return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "description") continue;
    output[key] = compactJsonSchema(child);
  }
  return output;
}

function str(description) {
  return { type: "string", description };
}

function int(description, defaultValue) {
  return { type: "integer", description, default: defaultValue };
}

function bool(description) {
  return { type: "boolean", description };
}

function respond(id, payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
}
`;
