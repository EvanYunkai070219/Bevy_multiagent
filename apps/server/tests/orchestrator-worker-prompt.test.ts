import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "../src/agent-service.js";
import { AttemptWorkspaceManager } from "../src/attempt-workspace-manager.js";
import { ContributionCollector } from "../src/contribution-collector.js";
import { loadConfig } from "../src/config.js";
import { EventLog } from "../src/event-log.js";
import { GitClient } from "../src/git-client.js";
import type { CoordinationIngress } from "../src/coordination/ingress.js";
import {
  boundedWorkerPrompt,
  buildLeaderCodexPrompt,
  buildWorkerPrompt,
  isSkillCreationRequest,
  isSharedWorkspaceDeliverableRequest,
  Orchestrator,
  requiresProjectContributionRequest,
} from "../src/orchestration/orchestrator.js";
import type { OrchestratorParts } from "../src/orchestration/orchestrator.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import { ExecRuntime } from "../src/runtime/exec-runtime.js";
import type { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { ProjectRegistry } from "../src/project-registry.js";
import { ProjectRepositoryManager } from "../src/project-repository-manager.js";
import { ProjectRunManager } from "../src/project-run-manager.js";
import { JsonStore } from "../src/store.js";
import type {
  AgentRunner,
  Database,
  LeaderPlan,
  LeaderSubtask,
  RunnerRequest,
  SkillInjectionPlan,
  WorkerResult,
} from "../src/types.js";
import { WorkspaceManager } from "../src/workspace.js";

const subtask: LeaderSubtask = {
  id: "s1",
  title: "Research the auth flow",
  role: "researcher",
  prompt: "Investigate how login works.",
  objective: "Understand auth",
  successCriteria: ["Describe the token exchange"],
  expectedOutput: "A short report",
  dependsOn: [],
};

describe("boundedWorkerPrompt collaboration clause", () => {
  it("tells the worker to read and post shared material", () => {
    const prompt = boundedWorkerPrompt(subtask, defaultExecutionPolicy);
    expect(prompt).toContain("whiteboard_read");
    expect(prompt).toContain("list_artifacts");
    expect(prompt).toContain("publish_artifact");
    expect(prompt).toContain("whiteboard_post");
  });

  it("still contains the original subtask prompt and time budget", () => {
    const prompt = boundedWorkerPrompt(subtask, defaultExecutionPolicy);
    expect(prompt).toContain("Investigate how login works.");
    expect(prompt).toContain("Time budget");
  });

  it("names the runtime interpreters available to the worker", () => {
    const prompt = boundedWorkerPrompt(subtask, defaultExecutionPolicy);
    expect(prompt).toContain("python3");
    expect(prompt).toContain("ripgrep");
  });

  it("explains the private vs shared workspace so file handoffs work", () => {
    const prompt = boundedWorkerPrompt(subtask, defaultExecutionPolicy);
    expect(prompt).toContain("COMMON_WORKSPACE");
    expect(prompt).toContain("/common-workspace");
    // Must warn that /workspace is private, so the model doesn't hand off there.
    expect(prompt).toMatch(/private/i);
  });

  it("requires compact status/report files and shared dependency caches", () => {
    const prompt = boundedWorkerPrompt(subtask, defaultExecutionPolicy);
    expect(prompt).toContain("$COMMON_WORKSPACE/status/<subtask-id>.json");
    expect(prompt).toContain("$COMMON_WORKSPACE/reports/<subtask-id>.md");
    expect(prompt).toContain("LAUNCHPAD_DEPENDENCY_CACHE");
    expect(prompt).toContain("PIP_CACHE_DIR");
    expect(prompt).toContain("NPM_CONFIG_CACHE");
    expect(prompt).toContain("PYTHONUSERBASE");
    expect(prompt).toContain("lazy-bootstrapped");
  });

  it("tells workers to discover reusable skill hub entries before rebuilding workflows", () => {
    const prompt = boundedWorkerPrompt(subtask, defaultExecutionPolicy);
    expect(prompt).toContain("Skill hub:");
    expect(prompt).toContain("bootstrap_context.skills");
    expect(prompt).toContain("read_skill");
    expect(prompt).toContain("install_skill");
    expect(prompt).toContain("scope=codex_home");
  });

  it("injects only the middleware-selected skill context when provided", () => {
    const prompt = buildWorkerPrompt(
      subtask,
      [],
      defaultExecutionPolicy,
      false,
      selectedSkillPlan(),
    );

    expect(prompt).toContain("Middleware-selected Skill Hub context");
    expect(prompt).toContain("academic-pdf-extractor v1.4");
    expect(prompt).not.toContain("pdf-analysis v2.1");
  });

  it("injects selected skill context into the live leader prompt", () => {
    const prompt = buildLeaderCodexPrompt(
      "Extract citations from an academic PDF.",
      false,
      selectedSkillPlan(),
    );

    expect(prompt).toContain("Middleware-selected Skill Hub context");
    expect(prompt).toContain("academic-pdf-extractor v1.4");
    expect(prompt).not.toContain("pdf-analysis v2.1");
  });
});

const upstreamResult: WorkerResult = {
  subtaskId: "research", workerId: "w1", workerRunId: "r1", iteration: 1, attempt: 1,
  status: "completed", output: "The auth uses OAuth2 device flow.", usage: null,
  durationMs: 5, artifacts: [],
};

describe("buildWorkerPrompt upstream injection", () => {
  it("includes an upstream section with the dependency output", () => {
    const prompt = buildWorkerPrompt(subtask, [upstreamResult], defaultExecutionPolicy);
    expect(prompt).toContain("Upstream results you depend on");
    expect(prompt).toContain("research");
    expect(prompt).toContain("OAuth2 device flow");
  });
  it("stays byte-identical to the base prompt when there is no upstream", () => {
    const prompt = buildWorkerPrompt(subtask, [], defaultExecutionPolicy);
    expect(prompt).not.toContain("Upstream results");
    // The last base bullet must be immediately followed by the final bullet with
    // no blank line between them (the upstream section injects here only when present).
    expect(prompt).toContain("catch downstream.\n- Final output must include");
  });
});

function selectedSkillPlan(): SkillInjectionPlan {
  return {
    runId: "run-1",
    task: "Extract citations from an academic PDF.",
    createdAt: "2026-08-30T00:00:00.000Z",
    mode: "selected",
    needs: [
      {
        id: "academic_pdf_extraction",
        label: "Academic PDF extraction",
        confidence: 0.91,
        evidence: ["task mentions PDF"],
        constraints: { mustBeLocal: true },
      },
    ],
    selected: [
      {
        candidate: {
          name: "academic-pdf-extractor",
          version: "1.4",
          description: "Academic PDF extraction",
          tags: ["academic_pdf_extraction"],
          notes: "",
          createdAt: "2026-08-30T00:00:00.000Z",
          evidenceRefs: [],
          provenanceWarnings: [],
          installArguments: {
            name: "academic-pdf-extractor",
            version: "1.4",
            scope: "run",
            destination: "$COMMON_WORKSPACE/skills/academic-pdf-extractor",
          },
        },
        score: 0.91,
        reasons: ["exact capability tag"],
        risks: [],
      },
    ],
    rejected: [
      {
        candidate: {
          name: "pdf-analysis",
          version: "2.1",
          description: "Generic PDF analysis",
          tags: ["pdf_analysis"],
          notes: "",
          createdAt: "2026-08-30T00:00:00.000Z",
          evidenceRefs: [],
          provenanceWarnings: [],
          installArguments: { name: "pdf-analysis", version: "2.1", scope: "run" },
        },
        score: 0.64,
        reasons: ["generic PDF support"],
        risks: ["generic PDF fit"],
      },
    ],
    install: [
      {
        name: "academic-pdf-extractor",
        version: "1.4",
        scope: "run",
        destination: "$COMMON_WORKSPACE/skills/academic-pdf-extractor",
      },
    ],
    promptContext: [
      "Middleware-selected Skill Hub context:",
      "- academic-pdf-extractor v1.4 at $COMMON_WORKSPACE/skills/academic-pdf-extractor. Use its SKILL.md before rebuilding this workflow. Selection evidence: exact capability tag.",
    ].join("\n"),
  };
}

describe("Orchestrator skill routing state", () => {
  it("records selected Skill Hub decisions in orchestration state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-skill-routing-"));
    temporaryDirectories.push(root);
    const dataDirectory = path.join(root, "data");
    const commonWorkspace = path.join(root, "common");
    await publishTestSkill(dataDirectory, "academic-pdf-extractor", "1.4", {
      description: "Academic paper PDF extraction for citations and references",
      tags: ["academic_pdf_extraction", "citations"],
      notes: "validated citation extraction success",
      evidenceRefs: ["run-7"],
    });
    const orchestrator = new Orchestrator(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        ...oneWorkerParts(),
        skillRouting: { dataDirectory },
      },
      () => false,
    );
    const state = (orchestrator as unknown as {
      initialState(): SkillInjectionState;
      routeSkillsForTask(
        runId: string,
        task: string,
        commonWorkspacePath: string,
        state: SkillInjectionState,
      ): Promise<SkillInjectionPlan | null>;
    }).initialState();

    const plan = await (orchestrator as unknown as {
      routeSkillsForTask(
        runId: string,
        task: string,
        commonWorkspacePath: string,
        state: SkillInjectionState,
      ): Promise<SkillInjectionPlan | null>;
    }).routeSkillsForTask(
      "run-1",
      "Extract citations from an academic PDF.",
      commonWorkspace,
      state,
    );

    expect(plan?.selected[0]?.candidate.name).toBe("academic-pdf-extractor");
    expect(state.skillRouting).toHaveLength(1);
    expect(state.skillRouting[0]?.install[0]?.scope).toBe("run");
    await expect(access(path.join(commonWorkspace, "skills", "academic-pdf-extractor", "SKILL.md")))
      .resolves.toBeUndefined();
  });
});

type SkillInjectionState = { skillRouting?: SkillInjectionPlan[] } & Record<string, unknown>;

async function publishTestSkill(
  dataDirectory: string,
  name: string,
  version: string,
  record: Record<string, unknown>,
): Promise<void> {
  const root = path.join(dataDirectory, "skill-hub", "skills", name, version);
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, ".launchpad-skill.json"),
    JSON.stringify({
      name,
      version,
      description: name + " description",
      createdAt: "2026-08-30T00:00:00.000Z",
      ...record,
    }),
    "utf8",
  );
  await writeFile(path.join(root, "SKILL.md"), "# " + name + "\n\nUse me.\n", "utf8");
}

describe("skill creation prompt quality mode", () => {
  it("detects skill creation requests without triggering on unrelated skilled wording", () => {
    expect(isSkillCreationRequest("create a browser automation skill")).toBe(true);
    expect(isSkillCreationRequest("Generate SKILL.md for a reusable tool")).toBe(true);
    expect(isSkillCreationRequest("improve skill generation quality")).toBe(true);
    expect(isSkillCreationRequest("hire a skilled engineer for this task")).toBe(false);
  });

  it("adds skill-package quality requirements to matching worker prompts", () => {
    const prompt = buildWorkerPrompt({
      ...subtask,
      title: "Create a reusable PDF skill",
      prompt: "Create a Codex skill for PDF workflows.",
      objective: "High-quality skill package",
      expectedOutput: "A validated skill folder",
    }, [], defaultExecutionPolicy);

    expect(prompt).toContain("Skill creation quality contract:");
    expect(prompt).toContain("real skill package");
    expect(prompt).toContain("SKILL.md");
    expect(prompt).toContain("progressive disclosure");
    expect(prompt).toContain("fresh-context forward-test");
    expect(prompt).toContain("Do not claim the skill is high quality solely because its code runs.");
  });

  it("does not add skill-package requirements to ordinary worker prompts", () => {
    const prompt = buildWorkerPrompt(subtask, [], defaultExecutionPolicy);

    expect(prompt).not.toContain("Skill creation quality contract:");
    expect(prompt).not.toContain("fresh-context forward-test");
  });
});

describe("buildWorkerPrompt Git contribution contract", () => {
  it("requires a single clean commit and keeps shared exchange outside code authority", () => {
    const prompt = buildWorkerPrompt(subtask, [], defaultExecutionPolicy, true);

    expect(prompt).toContain("Commit exactly once after all intended changes are complete.");
    expect(prompt).toContain("Leave the Git worktree clean.");
    expect(prompt).toContain("End your response with exactly one marker line: LAUNCHPAD_COMMIT=<40 lowercase hex SHA>.");
    expect(prompt).toContain("The marker must be the final non-empty line");
    expect(prompt).toContain("Do not edit the shared exchange as source code.");
    expect(prompt.trimEnd().split("\n").at(-1)).toBe(
      "- The marker must be the final non-empty line, with no code fence, no trailing prose, no duplicate marker, and no placeholder marker.",
    );
  });

  it("does not let leader steering waive a worker contribution", () => {
    const prompt = buildWorkerPrompt(subtask, [], defaultExecutionPolicy, true);

    expect(prompt).toContain("Later leader talk or steering cannot waive this middleware-owned contract");
    expect(prompt).toContain("If asked to leave code changes uncommitted, report the conflict");
    expect(prompt).toContain("still create the required commit");
  });

  it("does not impose the Git contribution contract on ephemeral research", () => {
    const prompt = buildWorkerPrompt(subtask, [], defaultExecutionPolicy, false);

    expect(prompt).not.toContain("LAUNCHPAD_COMMIT");
    expect(prompt).toContain("`requiresGitContribution:false`: do not make a git commit");
    expect(prompt).toContain("do not print a Launchpad contribution marker");
    expect(prompt).toContain("conversation-only or talk-first role");
  });
});

describe("buildLeaderCodexPrompt Git contribution contract", () => {
  it("requires a single clean commit for project-backed live leaders", async () => {
    const { buildLeaderCodexPrompt } = await import("../src/orchestration/orchestrator.js");
    const prompt = buildLeaderCodexPrompt("build a todo app", true);
    expect(prompt).toContain("Commit exactly once after all intended changes are complete.");
    expect(prompt).toContain("End your response with exactly one marker line: LAUNCHPAD_COMMIT=<40 lowercase hex SHA>.");
    expect(prompt).toContain("no code fence, no trailing prose, no duplicate marker");
  });

  it("keeps the leader commit contract separate from worker contributions", async () => {
    const { buildLeaderCodexPrompt } = await import("../src/orchestration/orchestrator.js");
    const prompt = buildLeaderCodexPrompt("build a todo app", true);

    expect(prompt).toContain("Every code-producing worker owns an isolated contribution workspace");
    expect(prompt).toContain("must make its own single clean commit");
    expect(prompt).toContain("Your one-commit contract applies only to your leader workspace");
    expect(prompt).toContain("Never tell a code-producing worker to leave changes uncommitted for you");
  });

  it("keeps leader edits out of active worker scopes", async () => {
    const { buildLeaderCodexPrompt } = await import("../src/orchestration/orchestrator.js");
    const prompt = buildLeaderCodexPrompt("build a todo app", true);

    expect(prompt).toContain("Partition code-producing work by non-overlapping file ownership");
    expect(prompt).toContain("Do not implement or commit a scope assigned to an active worker");
    expect(prompt).toContain("wait for that contribution to integrate");
  });

  it("does not impose the Git contribution contract on ephemeral live leaders", async () => {
    const { buildLeaderCodexPrompt } = await import("../src/orchestration/orchestrator.js");
    const prompt = buildLeaderCodexPrompt("research this", false);
    expect(prompt).not.toContain("LAUNCHPAD_COMMIT");
    expect(prompt).toContain("pass `initialMessage` in dispatch_subagent");
    expect(prompt).toContain("launchpad.wait_for_workers");
    expect(prompt).toContain("pendingHandoffs.suggestedAction");
    expect(prompt).toContain("dispatch all independent workers immediately");
    expect(prompt).toContain("Dispatch workers with one-phase prompts");
    expect(prompt).toContain("read all available handoff files with one read_many_files or batch_tool_call");
    expect(prompt).toContain("should finish well under 2 minutes");
    expect(prompt).toContain("read_file/read_many_files can read `$COMMON_WORKSPACE");
  });

  it("adds skill quality gates for live skill-creation leaders", async () => {
    const { buildLeaderCodexPrompt } = await import("../src/orchestration/orchestrator.js");
    const prompt = buildLeaderCodexPrompt("Create a high-quality Codex skill for PDFs", false);

    expect(prompt).toContain("Skill creation quality mode:");
    expect(prompt).toContain("reusable Codex skill");
    expect(prompt).toContain("SKILL.md");
    expect(prompt).toContain("structural validation");
    expect(prompt).toContain("fresh worker");
    expect(prompt).toContain("The final answer must distinguish functional completion from skill quality");
  });

  it("tells live leaders to use status files, cached deps, and clustered retests", async () => {
    const { buildLeaderCodexPrompt } = await import("../src/orchestration/orchestrator.js");
    const prompt = buildLeaderCodexPrompt("Create a high-quality Codex skill for PDFs", false);

    expect(prompt).toContain("$COMMON_WORKSPACE/status/<subtask-id>.json");
    expect(prompt).toContain("$COMMON_WORKSPACE/reports/<subtask-id>.md");
    expect(prompt).toContain("Live dispatch enforces dependsOn");
    expect(prompt).toContain("LAUNCHPAD_DEPENDENCY_CACHE");
    expect(prompt).toContain("one clustered fix wave");
    expect(prompt).toContain("one retest per failed gate/category");
    expect(prompt).toContain("Cap secondary-artifact validation loops");
    expect(prompt).toContain("one structural validation and one fresh-context smoke test");
    expect(prompt).toContain("Do not spawn duplicate replacements");
    expect(prompt).toContain("Require an integration gate before critique or forward-test");
    expect(prompt).toContain("real skill folder exists at the contracted path");
    expect(prompt).toContain("qualitative reviewer gate");
  });

  it("tells workers to do one large work phase before handoff", async () => {
    const { boundedWorkerPrompt } = await import("../src/orchestration/orchestrator.js");
    const prompt = boundedWorkerPrompt({
      id: "research-a",
      agentName: "researcher-a",
      title: "Research A",
      role: "researcher",
      prompt: "Research A and write a report.",
      objective: "report",
      successCriteria: ["report exists"],
      expectedOutput: "markdown report",
      dependsOn: [],
    }, {
      ...defaultExecutionPolicy,
      workerTimeoutMs: 600_000,
    });

    expect(prompt).toContain("plan once, then do the largest safe work phase");
    expect(prompt).toContain("One-shot handoff default");
    expect(prompt).toContain("update it only on material phase changes");
    expect(prompt).toContain("$COMMON_WORKSPACE/status/<subtask-id>.json");
    expect(prompt).toContain("$COMMON_WORKSPACE/reports/<subtask-id>.md");
  });

  it("tells live leaders to discover and install reusable skills before assigning rebuild work", async () => {
    const { buildLeaderCodexPrompt } = await import("../src/orchestration/orchestrator.js");
    const prompt = buildLeaderCodexPrompt("Build a PDF extraction workflow", false);

    expect(prompt).toContain("published hub skills");
    expect(prompt).toContain("tool_search/search_skills");
    expect(prompt).toContain("read_skill");
    expect(prompt).toContain("install_skill");
  });

  it("preserves shared-workspace semantics for explicit common-workspace deliverables", async () => {
    const { buildLeaderCodexPrompt } = await import("../src/orchestration/orchestrator.js");
    const prompt = buildLeaderCodexPrompt(
      "Create a high-quality Codex skill at $COMMON_WORKSPACE/skills/codex-ppt",
      false,
    );

    expect(prompt).not.toContain("LAUNCHPAD_COMMIT");
    expect(prompt).toContain("Preserve shared-workspace semantics");
    expect(prompt).toContain("requiresGitContribution:false");
    expect(prompt).toContain("not a separate project commit");
  });

  it("preserves shared-workspace semantics for Skill Hub deliverables even without explicit paths", async () => {
    const { buildLeaderCodexPrompt } = await import("../src/orchestration/orchestrator.js");
    const prompt = buildLeaderCodexPrompt(
      "Build a reusable Distributed Systems Architect Skill and publish it to the Skill Hub.",
      false,
    );

    expect(prompt).not.toContain("LAUNCHPAD_COMMIT");
    expect(prompt).toContain("Preserve shared-workspace semantics");
    expect(prompt).toContain("requiresGitContribution:false");
    expect(prompt).toContain("shared skill folder under $COMMON_WORKSPACE");
  });
});

describe("requiresProjectContributionRequest", () => {
  it("keeps greetings and project questions out of the Git contribution path", () => {
    expect(requiresProjectContributionRequest("hi")).toBe(false);
    expect(requiresProjectContributionRequest("what files changed?")).toBe(false);
    expect(requiresProjectContributionRequest("review the current implementation")).toBe(false);
  });

  it("requires project contributions for mutating work", () => {
    expect(requiresProjectContributionRequest("build a todo app")).toBe(true);
    expect(requiresProjectContributionRequest("fix the failing validator")).toBe(true);
  });

  it("does not require project contribution for explicit shared-workspace deliverables", () => {
    expect(isSharedWorkspaceDeliverableRequest("put it at $COMMON_WORKSPACE/skills/x")).toBe(true);
    expect(isSharedWorkspaceDeliverableRequest("write output to /common-workspace/skills/x")).toBe(true);
    expect(requiresProjectContributionRequest(
      "create a high-quality Codex skill at $COMMON_WORKSPACE/skills/codex-ppt",
    )).toBe(false);
  });

  it("does not require project contribution for reusable Skill Hub deliverables", () => {
    expect(isSharedWorkspaceDeliverableRequest(
      "Build a reusable Distributed Systems Architect Skill and publish it to the Skill Hub.",
    )).toBe(true);
    expect(isSharedWorkspaceDeliverableRequest("create a high-quality Codex skill")).toBe(true);
    expect(requiresProjectContributionRequest(
      "Study a corpus, build a reusable skill, validate it, and publish to the skill hub.",
    )).toBe(false);
  });

  it("tells the leader that timeout extension is telemetry and cannot outrun the root deadline", async () => {
    const { buildLeaderCodexPrompt } = await import("../src/orchestration/orchestrator.js");
    const prompt = buildLeaderCodexPrompt("coordinate workers");
    expect(prompt).toMatch(/root deadline/i);
    expect(prompt).toMatch(/telemetry|cannot extend the root|never extend the root/i);
    expect(prompt).toMatch(/inspect_worker_progress[\s\S]*observational|cannot invent progress|cannot authorize continuation/i);
  });
});

const temporaryDirectories: string[] = [];

type PersistenceFault = "attempt_start" | "attempt_ready" | "attempt_failure" | "child_terminal";

class TransitionFaultStore extends JsonStore {
  constructor(filePath: string, private readonly fault: PersistenceFault, private remaining: number) {
    super(filePath);
  }

  override async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    const before = this.snapshot();
    const probe = structuredClone(before);
    await mutation(probe);
    if (this.remaining > 0 && detectsTransition(before, probe, this.fault)) {
      this.remaining -= 1;
      throw new Error("injected " + this.fault + " persistence failure");
    }
    return super.mutate(mutation);
  }
}

function detectsTransition(before: Database, after: Database, fault: PersistenceFault): boolean {
  for (const nextRun of after.runs) {
    const previous = before.runs.find((item) => item.id === nextRun.id);
    if (fault === "child_terminal" && previous?.kind === "subtask" && previous.status === "running" &&
      nextRun.status !== "running") return true;
    const previousAttempts = previous?.project?.attempts ?? [];
    const nextAttempts = nextRun.project?.attempts ?? [];
    if (fault === "attempt_start" && nextAttempts.length > previousAttempts.length) return true;
    for (const nextAttempt of nextAttempts) {
      const previousAttempt = previousAttempts.find((item) =>
        item.attemptId === nextAttempt.attemptId && item.revision === nextAttempt.revision
      );
      if (fault === "attempt_ready" && previousAttempt?.state === "running" &&
        nextAttempt.state === "contribution_ready") return true;
      if (fault === "attempt_failure" && previousAttempt?.state === "running" &&
        ["failed", "cancelled"].includes(nextAttempt.state)) return true;
    }
  }
  return false;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function oneWorkerParts(): OrchestratorParts {
  const plan: LeaderPlan = {
    needsSubagents: true,
    rationale: "One isolated coding contribution.",
    subtasks: [{
      id: "implement",
      title: "Implement",
      role: "engineer",
      prompt: "Implement the requested change.",
      objective: "Implement",
      successCriteria: ["one commit exists"],
      expectedOutput: "one commit",
      dependsOn: [],
    }],
  };
  return {
    planner: {
      plan: async () => ({
        status: "available",
        plan,
        model: "planner-model",
        promptVersion: "planner-v1",
      }),
    } as OrchestratorParts["planner"],
    evaluator: {
      evaluate: async () => ({
        status: "available",
        model: "evaluator-model",
        promptVersion: "evaluator-v1",
        evaluation: { sufficient: false, subtaskEvaluations: [], missingInformation: ["integration pending"] },
      }),
    } as OrchestratorParts["evaluator"],
    replanner: {
      replan: async () => ({
        status: "available",
        plan: { ...plan, subtasks: [] },
        model: "replanner-model",
        promptVersion: "replanner-v1",
      }),
    } as OrchestratorParts["replanner"],
    synthesizer: {
      synthesize: async () => ({ output: "integration pending", promptVersion: "synthesizer-v1" }),
    } as OrchestratorParts["synthesizer"],
    policy: { ...defaultExecutionPolicy, maxIterations: 1, maxTotalWorkerRuns: 1 },
  };
}

async function serviceFixture(
  runnerFactory: (store: JsonStore) => AgentRunner,
  partsFactory?: (store: JsonStore, root: string) => Partial<OrchestratorParts>,
  storeFactory: (filePath: string) => JsonStore = (filePath) => new JsonStore(filePath),
) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-project-worker-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    CODEX_RUNTIME_MODE: "exec",
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const store = storeFactory(path.join(root, "data", "db.json"));
  const git = new GitClient(5_000);
  const projectRegistry = new ProjectRegistry(
    store,
    new ProjectRepositoryManager(config.workspaceRoot, config.workspaceSourceRoots, git),
    git,
  );
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runnerFactory(store),
    new EventLog(path.join(root, "data", "events"), { secrets: [config.arkApiKey] }),
    { ...oneWorkerParts(), ...partsFactory?.(store, root) },
    undefined,
    undefined,
    new ProjectRunManager(path.join(root, "project-runs"), [root], git),
    {},
    projectRegistry,
    git,
  );
  await service.initialize();
  return { root, service, store, projectRegistry };
}

async function startManagedRun(
  service: AgentService,
  projectName: string,
  prompt = "build",
) {
  const project = await service.createManagedProject({ displayName: projectName });
  const leader = await service.createProjectChat(project.id, { name: projectName + "-chat" });
  const sent = await service.sendMessage(leader.id, prompt);
  return { project, leader, run: sent.run };
}

function emitCommand(request: RunnerRequest): void {
  request.sink?.emit({
    spanId: "worker-command",
    parentSpanId: "run",
    kind: "command",
    name: "git",
    status: "ok",
    startedAt: "2026-08-28T00:00:00.000Z",
    endedAt: "2026-08-28T00:00:01.000Z",
    durationMs: 1_000,
    input: { command: "git commit" },
    output: { exitCode: 0 },
    error: null,
    attributes: {},
    usage: null,
  });
}

class LateToolEventRuntime implements AgentRuntime {
  private sink: RunnerRequest["sink"];

  constructor(private readonly inner: AgentRuntime) {}

  async start(request: RunnerRequest) {
    this.sink = request.sink;
    request.sink?.emit({
      spanId: "late-tool",
      parentSpanId: "run",
      kind: "command",
      name: "git",
      status: "in_progress",
      startedAt: "2026-08-28T00:00:00.000Z",
      endedAt: null,
      durationMs: null,
      input: { command: "git commit" },
      output: {},
      error: null,
      attributes: {},
      usage: null,
    });
    return this.inner.start(request);
  }

  async quiesce(reason: string) {
    this.sink?.emit({
      spanId: "late-tool",
      parentSpanId: "run",
      kind: "command",
      name: "git",
      status: "ok",
      startedAt: "2026-08-28T00:00:00.000Z",
      endedAt: "2026-08-28T00:00:01.000Z",
      durationMs: 1_000,
      input: { command: "git commit" },
      output: { exitCode: 0 },
      error: null,
      attributes: {},
      usage: null,
    });
    await this.inner.quiesce(reason);
  }

  inject(message: Parameters<AgentRuntime["inject"]>[0]) {
    return this.inner.inject(message);
  }

  wake(message: Parameters<AgentRuntime["wake"]>[0]) {
    return this.inner.wake(message);
  }

  waitForIdle() {
    return this.inner.waitForIdle();
  }

  snapshot() {
    return this.inner.snapshot();
  }

  capability() {
    return this.inner.capability();
  }

  close(reason: string) {
    return this.inner.close(reason);
  }

  cancel(reason: string) {
    return this.inner.cancel(reason);
  }
}

class MarkerRepairRuntime implements AgentRuntime {
  private threadId: string | null = null;
  private head = "";
  private state: "not_started" | "active" | "idle" | "closed" = "not_started";

  constructor(private readonly repairMessages: string[]) {}

  async start(request: RunnerRequest) {
    this.state = "active";
    this.threadId = "repair-thread";
    emitCommand(request);
    await writeFile(path.join(request.workspacePath, "implemented.txt"), "done\n", "utf8");
    const git = new GitClient(5_000);
    await git.run(request.workspacePath, ["add", "--", "implemented.txt"]);
    await git.run(request.workspacePath, ["commit", "-m", "implement"]);
    this.head = await git.head(request.workspacePath);
    this.state = "idle";
    return {
      output: "Done\nLAUNCHPAD_COMMIT=<forgot to paste the commit>",
      threadId: this.threadId,
      usage: null,
    };
  }

  async inject() {
    return { state: "delivered" as const, via: "pending_quiet" as const };
  }

  async wake(message: Parameters<AgentRuntime["wake"]>[0]) {
    this.repairMessages.push(message.content);
    return {
      state: "delivered" as const,
      via: "follow_up" as const,
      output: "Done after repair\nLAUNCHPAD_COMMIT=" + this.head,
      usage: null,
    };
  }

  async waitForIdle() {}

  snapshot() {
    return { state: this.state, threadId: this.threadId, activeTurnId: null };
  }

  capability() {
    return "live_steer" as const;
  }

  async close() {
    this.state = "closed";
  }

  async quiesce() {
    this.state = "closed";
  }

  async cancel() {
    this.state = "closed";
  }
}

class ClosedMarkerRuntime implements AgentRuntime {
  private threadId: string | null = null;
  private state: "not_started" | "active" | "idle" | "closed" = "not_started";

  constructor(private readonly repairMessages: string[]) {}

  async start(request: RunnerRequest) {
    this.state = "active";
    this.threadId = "closed-marker-thread";
    emitCommand(request);
    await writeFile(path.join(request.workspacePath, "implemented.txt"), "done\n", "utf8");
    const git = new GitClient(5_000);
    await git.run(request.workspacePath, ["add", "--", "implemented.txt"]);
    await git.run(request.workspacePath, ["commit", "-m", "implement"]);
    this.state = "closed";
    return {
      output: "Done\nLAUNCHPAD_COMMIT=<forgot to paste the commit>",
      threadId: this.threadId,
      usage: null,
    };
  }

  async inject() {
    return { state: "undeliverable" as const, reason: "TARGET_CLOSED" };
  }

  async wake(message: Parameters<AgentRuntime["wake"]>[0]) {
    this.repairMessages.push(message.content);
    return { state: "undeliverable" as const, reason: "TARGET_CLOSED" };
  }

  async waitForIdle() {}

  snapshot() {
    return { state: this.state, threadId: this.threadId, activeTurnId: null };
  }

  capability() {
    return "live_steer" as const;
  }

  async close() {
    this.state = "closed";
  }

  async quiesce() {
    this.state = "closed";
  }

  async cancel() {
    this.state = "closed";
  }
}

class MissingContributionRepairRuntime implements AgentRuntime {
  private threadId: string | null = null;
  private state: "not_started" | "active" | "idle" | "closed" = "not_started";
  private workspacePath = "";

  constructor(private readonly repairMessages: string[]) {}

  async start(request: RunnerRequest) {
    this.state = "active";
    this.threadId = "missing-contribution-thread";
    this.workspacePath = request.workspacePath;
    this.state = "idle";
    return {
      output: "I need to inspect the repo before editing.",
      threadId: this.threadId,
      usage: null,
    };
  }

  async inject() {
    return { state: "delivered" as const, via: "pending_quiet" as const };
  }

  async wake(message: Parameters<AgentRuntime["wake"]>[0]) {
    this.repairMessages.push(message.content);
    emitCommand({
      runId: "repair",
      agentId: "repair",
      workspacePath: this.workspacePath,
      prompt: "",
    } as RunnerRequest);
    await writeFile(path.join(this.workspacePath, "implemented.txt"), "done\n", "utf8");
    const git = new GitClient(5_000);
    await git.run(this.workspacePath, ["add", "--", "implemented.txt"]);
    await git.run(this.workspacePath, ["commit", "-m", "implement after repair"]);
    const head = await git.head(this.workspacePath);
    return {
      state: "delivered" as const,
      via: "follow_up" as const,
      output: "Done after contribution repair\nLAUNCHPAD_COMMIT=" + head,
      usage: null,
    };
  }

  async waitForIdle() {}

  snapshot() {
    return { state: this.state, threadId: this.threadId, activeTurnId: null };
  }

  capability() {
    return "live_steer" as const;
  }

  async close() {
    this.state = "closed";
  }

  async quiesce() {
    this.state = "closed";
  }

  async cancel() {
    this.state = "closed";
  }
}

describe("project worker contribution routing", () => {
  it("rolls back an applied contribution when cancellation wins before durable integration", async () => {
    let signalApplied!: () => void;
    const applied = new Promise<void>((resolve) => { signalApplied = resolve; });
    let releaseHook!: () => void;
    const mayContinue = new Promise<void>((resolve) => { releaseHook = resolve; });
    const { service } = await serviceFixture(
      () => ({
        run: async (request) => {
          emitCommand(request);
          await writeFile(path.join(request.workspacePath, "cancelled-change.txt"), "change\n", "utf8");
          const git = new GitClient(5_000);
          await git.run(request.workspacePath, ["add", "--", "cancelled-change.txt"]);
          await git.run(request.workspacePath, ["commit", "-m", "candidate"]);
          return { output: "Done\nLAUNCHPAD_COMMIT=" + await git.head(request.workspacePath), threadId: null, usage: null };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      () => ({
        afterCanonicalIntegrationForTest: async () => {
          signalApplied();
          await mayContinue;
        },
      }),
    );
    const { leader, run } = await startManagedRun(service, "cancel-integration");
    await applied;
    const stopping = service.stopAgent(leader.id);
    releaseHook();
    await stopping;

    const cancelled = service.getRun(run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.project?.headCommit).toBe(cancelled.project?.source.baseCommit);
    expect(cancelled.project?.attempts[0]).toMatchObject({ state: "cancelled", cleanup: "preserved" });
    expect(cancelled.project?.integrations[0]).toMatchObject({
      state: "rolled_back", structuralDecision: "failed", reason: "user_cancelled",
    });
    expect(await new GitClient(5_000).head(cancelled.project!.canonicalWorkspacePath))
      .toBe(cancelled.project?.source.baseCommit);
    expect(await new GitClient(5_000).isClean(cancelled.project!.canonicalWorkspacePath)).toBe(true);
  }, 20_000);

  it("keeps an integrated node completed and settles later siblings when cleanup is preserved", async () => {
    let cleanupCalls = 0;
    const twoWorkerPlan: LeaderPlan = {
      needsSubagents: true,
      rationale: "two siblings",
      subtasks: ["first", "second"].map((id) => ({
        id, title: id, role: "engineer", prompt: id, objective: id,
        successCriteria: ["commit"], expectedOutput: "commit", dependsOn: [],
      })),
    };
    const { service } = await serviceFixture(
      () => ({
        run: async (request) => {
          emitCommand(request);
          const file = request.prompt.startsWith("first") ? "first.txt" : "second.txt";
          await writeFile(path.join(request.workspacePath, file), file + "\n", "utf8");
          const git = new GitClient(5_000);
          await git.run(request.workspacePath, ["add", "--", file]);
          await git.run(request.workspacePath, ["commit", "-m", file]);
          return { output: "Done\nLAUNCHPAD_COMMIT=" + await git.head(request.workspacePath), threadId: null, usage: null };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      (_store, root) => ({
        planner: {
          plan: async () => ({ status: "available", plan: twoWorkerPlan, model: "planner", promptVersion: "v1" }),
        } as OrchestratorParts["planner"],
        policy: { ...defaultExecutionPolicy, maxIterations: 1, maxTotalWorkerRuns: 2 },
        attemptWorkspaces: new class extends AttemptWorkspaceManager {
          override async removeIntegrated(...args: Parameters<AttemptWorkspaceManager["removeIntegrated"]>) {
            cleanupCalls += 1;
            if (cleanupCalls === 1) {
              return { action: "preserved" as const, attemptId: args[1].attemptId, reason: "unverifiable" as const };
            }
            return super.removeIntegrated(...args);
          }
        }(new GitClient(5_000)),
      }),
    );
    const { run } = await startManagedRun(service, "cleanup-continue");
    await expect.poll(() => service.getRun(run.id).status, { timeout: 20_000 }).toBe("completed");
    const completed = service.getRun(run.id);
    expect(completed.orchestration?.workerResults.map((result) => result.status)).toEqual(["completed", "completed"]);
    expect(completed.project?.integrations.map((record) => record.subtaskId)).toEqual(["first", "second"]);
    expect(completed.project?.integrations.map((record) => record.state)).toEqual(["integrated", "integrated"]);
    expect(completed.project?.attempts.find((attempt) => attempt.subtaskId === "first"))
      .toMatchObject({ cleanup: "preserved", reason: "unverifiable" });
    expect(completed.project?.attempts.find((attempt) => attempt.subtaskId === "second")?.cleanup)
      .toBe("removed");
  }, 30_000);

  it.each(["attempt_start", "attempt_ready", "child_terminal"] as const)(
    "retries one %s persistence failure without rerunning the worker",
    async (fault) => {
      let calls = 0;
      const { service, store } = await serviceFixture(
        () => ({
          run: async (request) => {
            calls += 1;
            emitCommand(request);
            await writeFile(path.join(request.workspacePath, "implemented.txt"), "done\n", "utf8");
            const git = new GitClient(5_000);
            await git.run(request.workspacePath, ["add", "--", "implemented.txt"]);
            await git.run(request.workspacePath, ["commit", "-m", "implement"]);
            return {
              output: "Done\nLAUNCHPAD_COMMIT=" + await git.head(request.workspacePath),
              threadId: null,
              usage: null,
            };
          },
          cancel: async () => false,
          isAvailable: async () => true,
        }),
        undefined,
        (filePath) => new TransitionFaultStore(filePath, fault, 1),
      );
      const { run } = await startManagedRun(service, "retry-" + fault);

      await expect.poll(() => service.getRun(run.id).status, { timeout: 20_000 }).toBe("completed");
      expect(calls).toBe(1);
      expect(service.getRun(run.id).project?.attempts[0]).toMatchObject({
        state: "integrated",
        cleanup: "removed",
      });
      expect(store.snapshot().runs.find((item) => item.parentRunId === run.id)?.status).toBe("completed");
    },
    30_000,
  );

  it.each([1, 2])(
    "keeps the child terminal when attempt-failure persistence fails %i time(s)",
    async (failures) => {
      const { service, store } = await serviceFixture(
        () => ({
          run: async (request) => {
            emitCommand(request);
            await writeFile(path.join(request.workspacePath, "dirty.txt"), "dirty\n", "utf8");
            return {
              output: "Done\nLAUNCHPAD_COMMIT=0000000000000000000000000000000000000000",
              threadId: null,
              usage: null,
            };
          },
          cancel: async () => false,
          isAvailable: async () => true,
        }),
        undefined,
        (filePath) => new TransitionFaultStore(filePath, "attempt_failure", failures),
      );
      const { run } = await startManagedRun(service, "failure-publication-" + failures);

      await expect.poll(() => service.getRun(run.id).status, { timeout: 10_000 })
        .toMatch(/completed|failed/);
      expect(store.snapshot().runs.find((item) => item.parentRunId === run.id)?.status).toBe("failed");
      const persistedAttempt = service.getRun(run.id).project?.attempts[0];
      if (failures === 2) {
        expect(persistedAttempt).toMatchObject({
          state: "running",
          cleanup: "preserved",
          reason: "attempt_failure_persistence_failed",
        });
        const parentEvents = await service.getRunEvents(run.id, 0);
        expect(parentEvents.events.some((event) => event.name === "attempt_failure_persistence_failed"))
          .toBe(true);
        expect(JSON.stringify(parentEvents.events)).not.toContain("injected attempt_failure persistence failure");
      } else {
        expect(persistedAttempt?.state).toBe("failed");
      }
    },
    15_000,
  );

  it("does not contradict a closed completed child trace after two terminal-store denials", async () => {
    const { service, store } = await serviceFixture(
      () => ({
        run: async (request) => {
          emitCommand(request);
          await writeFile(path.join(request.workspacePath, "implemented.txt"), "done\n", "utf8");
          const git = new GitClient(5_000);
          await git.run(request.workspacePath, ["add", "--", "implemented.txt"]);
          await git.run(request.workspacePath, ["commit", "-m", "implement"]);
          return {
            output: "Done\nLAUNCHPAD_COMMIT=" + await git.head(request.workspacePath),
            threadId: null,
            usage: null,
          };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      undefined,
      (filePath) => new TransitionFaultStore(filePath, "child_terminal", 2),
    );
    const { run } = await startManagedRun(service, "persistent-child-terminal");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 10_000 }).toMatch(/completed|failed/);
    const child = store.snapshot().runs.find((item) => item.parentRunId === run.id);
    expect(child?.status).toBe("running");
    const childEvents = await service.getRunEvents(child!.id, 0);
    expect(childEvents.events.filter((event) => event.kind === "run" && event.status !== "in_progress"))
      .toHaveLength(1);
    expect(childEvents.events.some((event) => event.name === "failed")).toBe(false);
  }, 15_000);

  it.each(["attempt_start", "attempt_ready"] as const)(
    "fails safely after two %s persistence denials without retrying the worker",
    async (fault) => {
      let calls = 0;
      const { service, store } = await serviceFixture(
        () => ({
          run: async (request) => {
            calls += 1;
            emitCommand(request);
            await writeFile(path.join(request.workspacePath, "implemented.txt"), "done\n", "utf8");
            const git = new GitClient(5_000);
            await git.run(request.workspacePath, ["add", "--", "implemented.txt"]);
            await git.run(request.workspacePath, ["commit", "-m", "implement"]);
            return {
              output: "Done\nLAUNCHPAD_COMMIT=" + await git.head(request.workspacePath),
              threadId: null,
              usage: null,
            };
          },
          cancel: async () => false,
          isAvailable: async () => true,
        }),
        undefined,
        (filePath) => new TransitionFaultStore(filePath, fault, 2),
      );
      const { run } = await startManagedRun(service, "persistent-" + fault);

      await expect.poll(() => service.getRun(run.id).status, { timeout: 10_000 })
        .toMatch(/completed|failed/);
      expect(calls).toBe(fault === "attempt_start" ? 0 : 1);
      const child = store.snapshot().runs.find((item) => item.parentRunId === run.id);
      expect(child?.status).toBe("failed");
      expect(service.getRun(run.id).project?.attempts.some(
        (attempt) => attempt.state === "contribution_ready",
      )).toBe(false);
    },
    15_000,
  );

  it("preserves a competing persisted owner when attempt insertion loses the race", async () => {
    let runnerCalls = 0;
    const { service } = await serviceFixture(
      () => ({
        run: async () => {
          runnerCalls += 1;
          return { output: "must not run", threadId: null, usage: null };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      (store) => ({
        attemptWorkspaces: new AttemptWorkspaceManager(new GitClient(5_000), {
          afterReadyPublishedForTest: async () => {
            const projectRun = store.snapshot().runs.find((item) => item.project?.state === "ready");
            const project = projectRun?.project;
            if (!projectRun || !project || project.attempts.length > 0) return;
            const attemptsDirectory = path.join(path.dirname(project.canonicalWorkspacePath), "attempts");
            const markerName = (await readdir(attemptsDirectory)).find((name) =>
              name.startsWith(".attempt-") && name.endsWith(".json")
            );
            if (!markerName) throw new Error("ready sidecar missing");
            const sidecar = JSON.parse(await readFile(path.join(attemptsDirectory, markerName), "utf8"));
            await store.mutate((database) => {
              const live = database.runs.find((item) => item.id === projectRun.id)?.project;
              live?.attempts.push({
                attemptId: sidecar.attemptId,
                revision: sidecar.revision,
                ownerToken: "33333333-3333-4333-8333-333333333333",
                subtaskId: sidecar.subtaskId,
                baseCommit: sidecar.baseCommit,
                workspacePath: path.join(attemptsDirectory, sidecar.attemptId + "-r" + sidecar.revision),
                state: "running",
                cleanup: "preserved",
                headCommit: sidecar.baseCommit,
                reason: "competing_owner",
              });
            });
          },
        }),
      }),
    );
    const { run } = await startManagedRun(service, "duplicate-owner");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 10_000 }).toBe("failed");
    const completed = service.getRun(run.id);
    expect(runnerCalls).toBe(0);
    expect(completed.project?.attempts).toHaveLength(1);
    expect(completed.project?.attempts[0]).toMatchObject({
      ownerToken: "33333333-3333-4333-8333-333333333333",
      state: "running",
      reason: "competing_owner",
    });
  });

  it("cancels after collection without publishing contribution-ready evidence", async () => {
    let signalCollection!: () => void;
    let releaseCollection!: () => void;
    const collecting = new Promise<void>((resolve) => { signalCollection = resolve; });
    const mayFinish = new Promise<void>((resolve) => { releaseCollection = resolve; });
    const { service } = await serviceFixture(
      () => ({
        run: async (request) => {
          emitCommand(request);
          await writeFile(path.join(request.workspacePath, "implemented.txt"), "done\n", "utf8");
          const git = new GitClient(5_000);
          await git.run(request.workspacePath, ["add", "--", "implemented.txt"]);
          await git.run(request.workspacePath, ["commit", "-m", "implement"]);
          return {
            output: "Done\nLAUNCHPAD_COMMIT=" + await git.head(request.workspacePath),
            threadId: null,
            usage: null,
          };
        },
        cancel: async () => true,
        isAvailable: async () => true,
      }),
      () => ({
        contributionCollector: new class extends ContributionCollector {
          override async collect(input: Parameters<ContributionCollector["collect"]>[0]) {
            const evidence = await super.collect(input);
            signalCollection();
            await mayFinish;
            return evidence;
          }
        }(new GitClient(5_000)),
      }),
    );
    const { leader, run } = await startManagedRun(service, "cancel-after-collect");
    await collecting;
    const cancellationRequests = (service as unknown as {
      cancellationRequests: Set<string>;
    }).cancellationRequests;
    cancellationRequests.add(leader.id);
    releaseCollection();

    await expect.poll(() => service.getRun(run.id).status, { timeout: 10_000 }).toBe("cancelled");
    expect(service.getRun(run.id).project?.attempts[0]).toMatchObject({
      state: "cancelled",
      cleanup: "preserved",
    });
    expect(service.getRun(run.id).orchestration?.workerResults.some(
      (result) => result.status === "contribution_ready",
    )).toBe(false);
    cancellationRequests.delete(leader.id);
  }, 15_000);

  it("persists the detached attempt before the runner starts and publishes evidence only after collection", async () => {
    const requests: RunnerRequest[] = [];
    let persistedAtStart = false;
    const { service } = await serviceFixture((store) => ({
      run: async (request) => {
        requests.push(request);
        const parent = store.snapshot().runs.find((run) => run.id === request.parentRunId);
        const attempt = parent?.project?.attempts.find((item) => item.workspacePath === request.workspacePath);
        persistedAtStart = attempt?.state === "running" && attempt.headCommit === attempt.baseCommit;
        emitCommand(request);
        await writeFile(path.join(request.workspacePath, "implemented.txt"), "done\n", "utf8");
        const git = new GitClient(5_000);
        await git.run(request.workspacePath, ["add", "--", "implemented.txt"]);
        await git.run(request.workspacePath, ["commit", "-m", "implement"]);
        const head = await git.head(request.workspacePath);
        return {
          output: "Implemented\nLAUNCHPAD_COMMIT=" + head,
          threadId: "worker-thread",
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    }));
    const { run } = await startManagedRun(service, "isolated-worker");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 10_000 }).toBe("completed");
    const completed = service.getRun(run.id);
    const result = completed.orchestration?.workerResults[0];
    const attempt = completed.project?.attempts[0];
    expect(persistedAtStart).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.workspacePath).toContain(path.join(".runs", run.id, "attempts"));
    expect(requests[0]?.commonWorkspacePath).toContain(path.join("data", "events"));
    expect(requests[0]?.commonWorkspacePath).toContain(run.id);
    expect(requests[0]?.commonWorkspacePath).toContain("common-workspace");
    expect(requests[0]?.prompt).toContain("LAUNCHPAD_COMMIT=<40 lowercase hex SHA>");
    expect(result).toMatchObject({
      status: "completed",
      contribution: {
        attemptId: attempt?.attemptId,
        headCommit: attempt?.headCommit,
        verificationLevel: "structural",
      },
    });
    expect(attempt).toMatchObject({ state: "integrated", cleanup: "removed", reason: null });
  }, 15_000);

  it("wakes a live worker once to repair an invalid commit marker before failing the attempt", async () => {
    const repairMessages: string[] = [];
    const { service } = await serviceFixture(
      () => ({
        run: async () => {
          throw new Error("runtimeFactory handles this test");
        },
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      () => ({
        runtimeFactory: () => new MarkerRepairRuntime(repairMessages),
      }),
    );
    const { run } = await startManagedRun(service, "repair-marker");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 10_000 }).toBe("completed");
    expect(repairMessages).toHaveLength(1);
    expect(repairMessages[0]).toContain("Contribution repair required");
    expect(repairMessages[0]).toContain("If no committed contribution exists yet, continue the original subtask now");
    const completed = service.getRun(run.id);
    expect(completed.orchestration?.workerResults[0]).toMatchObject({
      status: "completed",
      output: expect.stringContaining("Done after repair"),
    });
    expect(completed.project?.attempts[0]).toMatchObject({
      state: "integrated",
      cleanup: "removed",
    });
  }, 15_000);

  it("preserves a structurally failed attempt without retrying or removing it", async () => {
    let calls = 0;
    const { service } = await serviceFixture(() => ({
      run: async (request) => {
        calls += 1;
        emitCommand(request);
        await writeFile(path.join(request.workspacePath, "dirty.txt"), "not committed\n", "utf8");
        return {
          output: "Done\nLAUNCHPAD_COMMIT=0000000000000000000000000000000000000000",
          threadId: null,
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    }));
    const { run } = await startManagedRun(service, "failed-worker");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 10_000 }).toBe("failed");
    const completed = service.getRun(run.id);
    const attempt = completed.project?.attempts[0];
    expect(calls).toBe(1);
    expect(completed.orchestration?.workerResults[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("contribution_marker_mismatch"),
    });
    expect(attempt).toMatchObject({ state: "failed", cleanup: "preserved" });
    await expect(access(attempt!.workspacePath)).resolves.toBeUndefined();
  });

  it("does not let an old revision and owner overwrite a newer attempt generation", async () => {
    const { service } = await serviceFixture((store) => ({
      run: async (request) => {
        emitCommand(request);
        await writeFile(path.join(request.workspacePath, "implemented.txt"), "done\n", "utf8");
        const git = new GitClient(5_000);
        await git.run(request.workspacePath, ["add", "--", "implemented.txt"]);
        await git.run(request.workspacePath, ["commit", "-m", "implement"]);
        const head = await git.head(request.workspacePath);
        await store.mutate((database) => {
          const parent = database.runs.find((run) => run.id === request.parentRunId);
          const attempt = parent?.project?.attempts.find((item) => item.workspacePath === request.workspacePath);
          if (attempt) {
            attempt.revision += 1;
            attempt.ownerToken = "22222222-2222-4222-8222-222222222222";
            attempt.cleanup = "preserved";
            attempt.reason = "owned_by_newer_revision";
          }
        });
        return { output: "Done\nLAUNCHPAD_COMMIT=" + head, threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    }));
    const { run } = await startManagedRun(service, "stale-worker");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 10_000 }).toBe("failed");
    const completed = service.getRun(run.id);
    expect(completed.orchestration?.workerResults[0]?.status).toBe("failed");
    expect(completed.project?.attempts[0]).toMatchObject({
      revision: 2,
      ownerToken: "22222222-2222-4222-8222-222222222222",
      state: "running",
      cleanup: "preserved",
      reason: "owned_by_newer_revision",
    });
  });

  it("keeps ephemeral research on the existing task workspace without a commit marker", async () => {
    const requests: RunnerRequest[] = [];
    const { root, service } = await serviceFixture(() => ({
      run: async (request) => {
        requests.push(request);
        emitCommand(request);
        return { output: "research complete", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    }));
    const leader = await service.createAgent({ name: "Lead", role: "leader" });
    const { run } = await service.sendMessage(leader.id, "research");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 10_000 }).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.workspacePath).toContain(path.sep + ".tasks" + path.sep);
    expect(requests[0]?.prompt).not.toContain("LAUNCHPAD_COMMIT");
    expect(service.getRun(run.id).project?.attempts).toEqual([]);
    expect(service.getRun(run.id).orchestration?.workerResults[0]?.status).toBe("completed");
  });

  it("validates worker protocol after quiesce so a late tool event cannot fail a valid attempt", async () => {
    const { service } = await serviceFixture(
      () => ({
        run: async (request) => {
          await writeFile(path.join(request.workspacePath, "implemented.txt"), "done\n", "utf8");
          const git = new GitClient(5_000);
          await git.run(request.workspacePath, ["add", "--", "implemented.txt"]);
          await git.run(request.workspacePath, ["commit", "-m", "implement"]);
          return {
            output: "Done\nLAUNCHPAD_COMMIT=" + await git.head(request.workspacePath),
            threadId: "worker-thread",
            usage: null,
          };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      () => ({
        runtimeFactory: (runner) => new LateToolEventRuntime(new ExecRuntime(runner)),
      }),
    );
    const { run } = await startManagedRun(service, "late-protocol");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 10_000 }).toBe("completed");
    const completed = service.getRun(run.id);
    expect(completed.orchestration?.workerResults[0]?.error ?? "").not.toContain("OPEN_TOOL_CALL");
    expect(completed.orchestration?.workerResults[0]?.validation?.integrity).not.toBe("invalid");
    expect(completed.project?.attempts[0]).toMatchObject({ state: "integrated", cleanup: "removed" });
  }, 15_000);

  it("validates all worker event pages before reporting an open tool call", async () => {
    const { service } = await serviceFixture(
      () => ({
        run: async (request) => {
          request.sink?.emit({
            spanId: "long-tool",
            parentSpanId: "run",
            kind: "command",
            name: "long-running-command",
            status: "in_progress",
            startedAt: "2026-08-28T00:00:00.000Z",
            endedAt: null,
            durationMs: null,
            input: { command: "sleepy" },
            output: {},
            error: null,
            attributes: {},
            usage: null,
          });
          for (let index = 0; index < 520; index += 1) {
            request.sink?.emit({
              spanId: "filler-command-" + index,
              parentSpanId: "run",
              kind: "command",
              name: "filler",
              status: "ok",
              startedAt: "2026-08-28T00:00:00.000Z",
              endedAt: "2026-08-28T00:00:01.000Z",
              durationMs: 1,
              input: { command: "true" },
              output: { exitCode: 0 },
              error: null,
              attributes: {},
              usage: null,
            });
          }
          request.sink?.emit({
            spanId: "long-tool",
            parentSpanId: "run",
            kind: "command",
            name: "long-running-command",
            status: "ok",
            startedAt: "2026-08-28T00:00:00.000Z",
            endedAt: "2026-08-28T00:00:02.000Z",
            durationMs: 2_000,
            input: { command: "sleepy" },
            output: { exitCode: 0 },
            error: null,
            attributes: {},
            usage: null,
          });
          await writeFile(path.join(request.workspacePath, "implemented.txt"), "done\n", "utf8");
          const git = new GitClient(5_000);
          await git.run(request.workspacePath, ["add", "--", "implemented.txt"]);
          await git.run(request.workspacePath, ["commit", "-m", "implement"]);
          return {
            output: "Done\nLAUNCHPAD_COMMIT=" + await git.head(request.workspacePath),
            threadId: "worker-thread",
            usage: null,
          };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      }),
    );
    const { run } = await startManagedRun(service, "paged-protocol");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 10_000 }).toBe("completed");
    const completed = service.getRun(run.id);
    expect(completed.orchestration?.workerResults[0]?.error ?? "").not.toContain("OPEN_TOOL_CALL");
    expect(completed.orchestration?.workerResults[0]?.validation?.integrity).toBe("valid");
    expect(completed.project?.attempts[0]).toMatchObject({ state: "integrated", cleanup: "removed" });
  }, 15_000);
});

function codingWorker(): (store: JsonStore) => AgentRunner {
  return () => ({
    run: async (request) => {
      emitCommand(request);
      await writeFile(path.join(request.workspacePath, "implemented.txt"), "done\n", "utf8");
      const git = new GitClient(5_000);
      await git.run(request.workspacePath, ["add", "--", "implemented.txt"]);
      await git.run(request.workspacePath, ["commit", "-m", "implement"]);
      return {
        output: "Done\nLAUNCHPAD_COMMIT=" + await git.head(request.workspacePath),
        threadId: null,
        usage: null,
      };
    },
    cancel: async () => false,
    isAvailable: async () => true,
  });
}

function succeedingParts(): Partial<OrchestratorParts> {
  return {
    evaluator: {
      evaluate: async () => ({
        status: "available",
        model: "evaluator-model",
        promptVersion: "evaluator-v1",
        evaluation: { sufficient: true, subtaskEvaluations: [], missingInformation: [] },
      }),
    } as OrchestratorParts["evaluator"],
    synthesizer: {
      synthesize: async () => ({ output: "shipped", promptVersion: "synthesizer-v1" }),
    } as OrchestratorParts["synthesizer"],
  };
}

function liveLeaderParts(root: string): {
  ingresses: Map<string, CoordinationIngress>;
  parts: Partial<OrchestratorParts>;
} {
  const ingresses = new Map<string, CoordinationIngress>();
  return {
    ingresses,
    parts: {
      coordination: {
        dataDir: path.join(root, "data"),
        baseUrl: "http://127.0.0.1:9",
        register(token, ingress) {
          ingresses.set(token, ingress);
        },
        unregister(token) {
          ingresses.delete(token);
        },
      },
    },
  };
}

async function writeTodoApp(request: RunnerRequest) {
  emitCommand(request);
  await writeFile(path.join(request.workspacePath, "todo.html"), "<!doctype html>\n<title>todo</title>\n", "utf8");
  const git = new GitClient(5_000);
  await git.run(request.workspacePath, ["add", "--", "todo.html"]);
  await git.run(request.workspacePath, ["commit", "-m", "todo app"]);
  return {
    output: "Shipped the todo app.\nLAUNCHPAD_COMMIT=" + await git.head(request.workspacePath),
    threadId: null,
    usage: null,
  };
}

class FailBaselineFinalizeStore extends JsonStore {
  private failNextAdvance = true;

  override async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    const before = this.snapshot();
    const probe = structuredClone(before);
    await mutation(probe);
    const advancing = probe.projects.some((project) => {
      const previous = before.projects.find((item) => item.id === project.id);
      return previous !== undefined && previous.baselineCommit !== project.baselineCommit;
    });
    if (advancing && this.failNextAdvance) {
      this.failNextAdvance = false;
      throw new Error("injected baseline persist failure");
    }
    return super.mutate(mutation);
  }
}

describe("project baseline publication", () => {
  it("advances the Project baseline after a successful integrated outcome", async () => {
    const { service, projectRegistry } = await serviceFixture(codingWorker(), succeedingParts);
    const project = await service.createManagedProject({ displayName: "Ship It" });
    const chat = await service.createProjectChat(project.id, { name: "Ship Chat" });
    const before = await new GitClient(5_000).head(project.repositoryPath);
    const { run } = await service.sendMessage(chat.id, "build");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 20_000 }).toBe("completed");
    const completed = service.getRun(run.id);
    expect(completed.orchestration?.outcome?.value).toBe("succeeded");
    expect(projectRegistry.get(project.id).baselineCommit).toBe(completed.project?.headCommit);
    expect(projectRegistry.get(project.id).baselineCommit).not.toBe(project.baselineCommit);
    expect(await new GitClient(5_000).head(project.repositoryPath)).toBe(before);
  }, 25_000);

  it("converts CAS failure into a typed failed outcome instead of synthesized success", async () => {
    const { service, projectRegistry } = await serviceFixture(codingWorker(), succeedingParts);
    vi.spyOn(projectRegistry, "advanceBaseline").mockRejectedValue(new Error("stale baseline"));
    const project = await service.createManagedProject({ displayName: "Stale Ship" });
    const chat = await service.createProjectChat(project.id, { name: "Stale Chat" });
    const { run } = await service.sendMessage(chat.id, "build");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 20_000 }).toBe("failed");
    const failed = service.getRun(run.id);
    expect(failed.orchestration?.outcome?.value).toBe("failed");
    expect(failed.orchestration?.outcome?.reason).toMatch(/compare-and-swap/i);
    expect(projectRegistry.get(project.id).baselineCommit).toBe(project.baselineCommit);
  }, 25_000);

  it("does not publish completed when baseline persist fails after the Git ref update", async () => {
    const { service, store, projectRegistry } = await serviceFixture(
      codingWorker(),
      succeedingParts,
      (filePath) => new FailBaselineFinalizeStore(filePath),
    );
    const project = await service.createManagedProject({ displayName: "Persist Fail" });
    const chat = await service.createProjectChat(project.id, { name: "Persist Chat" });
    const { run } = await service.sendMessage(chat.id, "build");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 20_000 }).toBe("failed");
    expect(service.getRun(run.id).status).not.toBe("completed");
    expect(service.getRun(run.id).orchestration?.outcome?.value).toBe("failed");
    expect(store.snapshot().projects[0]?.baselineTransition?.state).toBe("prepared");
    await projectRegistry.recoverBaselineTransitions();
    expect(projectRegistry.get(project.id).baselineCommit).not.toBe(project.baselineCommit);
    expect(store.snapshot().projects[0]?.baselineTransition).toBeUndefined();
  }, 25_000);
});

describe("project-backed live leader contributions", () => {
  it("allows a project-backed conversational turn without requiring a contribution", async () => {
    const runtimeRequests: RunnerRequest[] = [];
    const { service, projectRegistry } = await serviceFixture(
      () => ({
        run: async (request) => {
          runtimeRequests.push(request);
          return {
            output: "Hi! I'm ready to help.",
            threadId: null,
            usage: null,
          };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      (_store, root) => liveLeaderParts(root).parts,
    );
    const project = await service.createManagedProject({ displayName: "Project Chat" });
    const leader = await service.createProjectChat(project.id, { name: "Project Chat" });
    const { run } = await service.sendMessage(leader.id, "hi");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 20_000 }).toBe("completed");
    const completed = service.getRun(run.id);
    expect(runtimeRequests[0]?.prompt).not.toContain("LAUNCHPAD_COMMIT");
    expect(runtimeRequests[0]?.workspacePath).toBe(leader.workspacePath);
    expect(completed.project?.attempts).toEqual([]);
    expect(completed.project?.integrations).toEqual([]);
    expect(completed.project?.headCommit).toBe(project.baselineCommit);
    expect(projectRegistry.get(project.id).baselineCommit).toBe(project.baselineCommit);
    expect(completed.output).toBe("Hi! I'm ready to help.");
  }, 25_000);

  it("resumes project chat context and workspace for non-contribution follow-ups", async () => {
    const runtimeRequests: RunnerRequest[] = [];
    const { service, root } = await serviceFixture(
      () => ({
        run: async (request) => {
          runtimeRequests.push(request);
          await writeFile(
            path.join(request.workspacePath, "chat-note.txt"),
            "remembered from " + request.prompt + "\n",
            "utf8",
          );
          return {
            output: "reply to " + request.prompt,
            threadId: request.threadId ?? "thread-project-chat",
            usage: null,
          };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      (_store, root) => liveLeaderParts(root).parts,
    );
    const project = await service.createManagedProject({ displayName: "Continuity Project" });
    const leader = await service.createProjectChat(project.id, { name: "Continuity Chat" });
    const first = await service.sendMessage(leader.id, "hi");

    await expect.poll(() => service.getRun(first.run.id).status, { timeout: 20_000 }).toBe("completed");
    const second = await service.sendMessage(leader.id, "what did we just do?");
    await expect.poll(() => service.getRun(second.run.id).status, { timeout: 20_000 }).toBe("completed");

    expect(runtimeRequests).toHaveLength(2);
    expect(runtimeRequests.map((request) => request.workspacePath)).toEqual([
      leader.workspacePath,
      leader.workspacePath,
    ]);
    expect(runtimeRequests[1]?.threadId).toBe("thread-project-chat");
    expect(runtimeRequests[0]?.commonWorkspacePath).toBe(runtimeRequests[1]?.commonWorkspacePath);
    expect(runtimeRequests[0]?.commonWorkspacePath).toContain(path.join(root, "data", "events"));
    expect(runtimeRequests[0]?.commonWorkspacePath).toContain(first.run.id);
    expect(runtimeRequests[0]?.commonWorkspacePath).not.toContain(leader.id);
    expect(await readFile(path.join(leader.workspacePath, "chat-note.txt"), "utf8"))
      .toContain("what did we just do?");

    // Both follow-ups must record their trajectory under the original run's
    // session bundle, not under the leader agent id or a fresh per-run folder.
    const sessions = await readdir(path.join(root, "data", "events"));
    expect(sessions.filter((name) => name.endsWith("_" + leader.id))).toEqual([]);
    const leaderSessions = sessions.filter((name) => name.endsWith("_" + first.run.id));
    expect(leaderSessions).toHaveLength(1);
    const runFolders = sessions.filter(
      (name) => name.endsWith("_" + second.run.id),
    );
    expect(runFolders).toEqual([]);
    const members = await readdir(path.join(root, "data", "events", leaderSessions[0]!));
    expect(members.filter((name) => name.startsWith("leader")).length).toBe(2);
  }, 30_000);

  it("preserves shared-workspace deliverables without forcing project contributions", async () => {
    const dispatchResults: unknown[] = [];
    const workerRequests: RunnerRequest[] = [];
    let live: ReturnType<typeof liveLeaderParts> | null = null;
    const { service, projectRegistry } = await serviceFixture(
      () => ({
        run: async (request) => {
          if (request.parentRunId) {
            workerRequests.push(request);
            const skillDir = path.join(request.commonWorkspacePath!, "skills", "codex-ppt");
            await mkdir(skillDir, { recursive: true });
            await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: codex-ppt\n---\n", "utf8");
            return {
              output: "shared skill package created at $COMMON_WORKSPACE/skills/codex-ppt",
              threadId: null,
              usage: null,
            };
          }
          const token = request.coordinationEnv?.LAUNCHPAD_COORDINATION_TOKEN;
          if (!token) throw new Error("leader coordination token missing");
          const ingress = live?.ingresses.get(token);
          if (!ingress) throw new Error("leader ingress missing");
          dispatchResults.push(await ingress.dispatch(token, {
            id: "skill-builder",
            prompt: "Create the skill package at $COMMON_WORKSPACE/skills/codex-ppt.",
            agentName: "Skill Builder",
          }));
          return {
            output: "done: $COMMON_WORKSPACE/skills/codex-ppt",
            threadId: null,
            usage: null,
          };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      (_store, root) => {
        live = liveLeaderParts(root);
        return live.parts;
      },
    );
    const project = await service.createManagedProject({ displayName: "Shared Skill" });
    const leader = await service.createProjectChat(project.id, { name: "Shared Skill Chat" });
    const { run } = await service.sendMessage(
      leader.id,
      "Create a high-quality Codex skill at $COMMON_WORKSPACE/skills/codex-ppt",
    );

    await expect.poll(() => service.getRun(run.id).status, { timeout: 25_000 }).toBe("completed");
    expect(dispatchResults[0]).toMatchObject({
      ok: true,
      result: { status: "running", subtaskId: "skill-builder" },
    });
    expect(workerRequests[0]?.prompt).not.toContain("LAUNCHPAD_COMMIT");
    expect(workerRequests[0]?.workspacePath).toContain(path.sep + ".tasks" + path.sep);
    expect(await readFile(
      path.join(workerRequests[0]!.commonWorkspacePath!, "skills", "codex-ppt", "SKILL.md"),
      "utf8",
    )).toContain("name: codex-ppt");
    const completed = service.getRun(run.id);
    expect(completed.project?.attempts).toEqual([]);
    expect(completed.project?.integrations).toEqual([]);
    expect(completed.project?.headCommit).toBe(project.baselineCommit);
    expect(projectRegistry.get(project.id).baselineCommit).toBe(project.baselineCommit);
    expect(completed.orchestration?.workerResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subtaskId: "skill-builder", status: "completed" }),
      ]),
    );
  }, 30_000);

  it("runs the live leader in an isolated attempt and integrates the todo app", async () => {
    const runtimeRequests: RunnerRequest[] = [];
    const { service, projectRegistry } = await serviceFixture(
      () => ({
        run: async (request) => {
          runtimeRequests.push(request);
          return writeTodoApp(request);
        },
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      (_store, root) => liveLeaderParts(root).parts,
    );
    const project = await service.createManagedProject({ displayName: "Todo App" });
    const leader = await service.createProjectChat(project.id, { name: "Todo Chat" });
    const before = await new GitClient(5_000).head(project.repositoryPath);
    const { run } = await service.sendMessage(leader.id, "build a todo app");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 20_000 }).toBe("completed");
    const completed = service.getRun(run.id);
    expect(runtimeRequests[0]?.workspacePath).toContain("/.runs/");
    expect(runtimeRequests[0]?.workspacePath).not.toBe(leader.workspacePath);
    expect(completed.project?.integrations).toHaveLength(1);
    expect(completed.orchestration?.outcome?.value).toBe("succeeded");
    expect(completed.project?.headCommit).not.toBe(completed.project?.source.baseCommit);
    expect(projectRegistry.get(project.id).baselineCommit).toBe(completed.project?.headCommit);
    expect(await new GitClient(5_000).head(project.repositoryPath)).toBe(before);
  }, 25_000);

  it("wakes the live leader once to repair an invalid contribution marker", async () => {
    const repairMessages: string[] = [];
    const { service } = await serviceFixture(
      () => ({
        run: async () => {
          throw new Error("runtimeFactory handles this test");
        },
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      (_store, root) => ({
        ...liveLeaderParts(root).parts,
        runtimeFactory: () => new MarkerRepairRuntime(repairMessages),
      }),
    );
    const project = await service.createManagedProject({ displayName: "Leader Marker Repair" });
    const leader = await service.createProjectChat(project.id, { name: "Leader Repair Chat" });
    const { run } = await service.sendMessage(leader.id, "build a todo app");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 20_000 }).toBe("completed");
    expect(repairMessages).toHaveLength(1);
    expect(repairMessages[0]).toContain("Contribution repair required");
    expect(repairMessages[0]).toContain("If no committed contribution exists yet, continue the original task now");
    const completed = service.getRun(run.id);
    expect(completed.project?.integrations).toHaveLength(1);
    expect(completed.orchestration?.workerResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subtaskId: "leader",
          status: "completed",
          output: expect.stringContaining("Done after repair"),
        }),
      ]),
    );
    expect(completed.project?.attempts[0]).toMatchObject({
      state: "integrated",
      cleanup: "removed",
    });
  }, 25_000);

  it("does not wake a closed leader runtime to repair an invalid contribution marker", async () => {
    const repairMessages: string[] = [];
    const { service } = await serviceFixture(
      () => ({
        run: async () => {
          throw new Error("runtimeFactory handles this test");
        },
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      (_store, root) => ({
        ...liveLeaderParts(root).parts,
        runtimeFactory: () => new ClosedMarkerRuntime(repairMessages),
      }),
    );
    const project = await service.createManagedProject({ displayName: "Closed Leader Marker" });
    const leader = await service.createProjectChat(project.id, { name: "Closed Leader Marker Chat" });
    const { run } = await service.sendMessage(leader.id, "build a todo app");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 20_000 }).toBe("failed");
    expect(repairMessages).toEqual([]);
    const completed = service.getRun(run.id);
    expect(completed.orchestration?.workerResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subtaskId: "leader",
          status: "failed",
          error: expect.stringContaining("contribution_marker_invalid"),
        }),
      ]),
    );
    const events = await service.getRunEvents(run.id, 0);
    expect(events.events.some((event) => event.name === "leader_contribution_marker_repair")).toBe(false);
  }, 25_000);

  it("wakes the live leader once to continue after a missing contribution", async () => {
    const repairMessages: string[] = [];
    const { service } = await serviceFixture(
      () => ({
        run: async () => {
          throw new Error("runtimeFactory handles this test");
        },
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      (_store, root) => ({
        ...liveLeaderParts(root).parts,
        runtimeFactory: () => new MissingContributionRepairRuntime(repairMessages),
      }),
    );
    const project = await service.createManagedProject({ displayName: "Leader Missing Repair" });
    const leader = await service.createProjectChat(project.id, { name: "Leader Missing Chat" });
    const { run } = await service.sendMessage(leader.id, "build a todo app");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 20_000 }).toBe("completed");
    expect(repairMessages).toHaveLength(1);
    expect(repairMessages[0]).toContain("Original task: build a todo app");
    expect(repairMessages[0]).toContain("continue the original task now");
    const completed = service.getRun(run.id);
    expect(completed.project?.integrations).toHaveLength(1);
    expect(completed.orchestration?.workerResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subtaskId: "leader",
          status: "completed",
          output: expect.stringContaining("Done after contribution repair"),
        }),
      ]),
    );
    expect(completed.project?.attempts[0]).toMatchObject({
      state: "integrated",
      cleanup: "removed",
    });
  }, 25_000);

  it("does not treat a natural-language success as authority without a commit marker", async () => {
    const { service, projectRegistry } = await serviceFixture(
      () => ({
        run: async () => ({
          output: "The todo app is complete and ready to ship.",
          threadId: null,
          usage: null,
        }),
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      (_store, root) => liveLeaderParts(root).parts,
    );
    const project = await service.createManagedProject({ displayName: "No Marker" });
    const leader = await service.createProjectChat(project.id, { name: "No Marker Chat" });
    const { run } = await service.sendMessage(leader.id, "build a todo app");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 20_000 })
      .toMatch(/completed|failed/);
    const completed = service.getRun(run.id);
    expect(["failed", "unknown"]).toContain(completed.orchestration?.outcome?.value);
    expect(completed.project?.headCommit).toBe(completed.project?.source.baseCommit);
    expect(completed.project?.integrations).toEqual([]);
    expect(projectRegistry.get(project.id).baselineCommit).toBe(project.baselineCommit);
    const events = await service.getRunEvents(run.id, 0);
    expect(events.events.some((event) => event.name === "synthesis" && event.status === "ok")).toBe(false);
    expect(events.events.some((event) => event.kind === "run" && event.name === "completed" && event.status === "ok"))
      .toBe(false);
  }, 25_000);

  it("returns running for async dispatch and durably settles the worker before leader completion", async () => {
    const dispatchResults: unknown[] = [];
    let live: ReturnType<typeof liveLeaderParts> | null = null;
    const { service } = await serviceFixture(
      () => ({
        run: async (request) => {
          if (request.parentRunId) {
            return writeTodoApp(request);
          }
          const token = request.coordinationEnv?.LAUNCHPAD_COORDINATION_TOKEN;
          if (!token) throw new Error("leader coordination token missing");
          const ingress = live?.ingresses.get(token);
          if (!ingress) throw new Error("leader ingress missing");
          dispatchResults.push(await ingress.dispatch(token, {
            id: "implement",
            prompt: "Implement the todo app.",
            agentName: "Builder",
          }));
          return { output: "Worker finished the todo app.", threadId: null, usage: null };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      (_store, root) => {
        live = liveLeaderParts(root);
        return live.parts;
      },
    );
    const project = await service.createManagedProject({ displayName: "Dispatch Todo" });
    const leader = await service.createProjectChat(project.id, { name: "Dispatch Chat" });
    const { run } = await service.sendMessage(leader.id, "have a worker build the todo app");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 25_000 }).toBe("completed");
    expect(dispatchResults[0]).toMatchObject({
      ok: true,
      result: { status: "running", subtaskId: "implement" },
    });
    const completed = service.getRun(run.id);
    expect(completed.orchestration?.workerResults).toContainEqual(
      expect.objectContaining({ status: "completed", subtaskId: "implement" }),
    );
    expect(completed.orchestration?.workerResults.some((result) => result.status === "contribution_ready"))
      .toBe(false);
    expect(completed.project?.integrations).toHaveLength(1);
    expect(completed.orchestration?.outcome?.value).toBe("succeeded");
    expect(completed.project?.headCommit).not.toBe(completed.project?.source.baseCommit);
  }, 30_000);

  it("reuses the persistent worker workspace for live dispatches from a continued leader run", async () => {
    const workerRequests: RunnerRequest[] = [];
    let live: ReturnType<typeof liveLeaderParts> | null = null;
    const { service, store } = await serviceFixture(
      () => ({
        run: async (request) => {
          if (request.parentRunId) {
            workerRequests.push(request);
            return {
              output: "continued worker used " + request.workspacePath,
              threadId: request.threadId ?? "worker-thread",
              usage: null,
            };
          }
          const token = request.coordinationEnv?.LAUNCHPAD_COORDINATION_TOKEN;
          if (!token) throw new Error("leader coordination token missing");
          const ingress = live?.ingresses.get(token);
          if (!ingress) throw new Error("leader ingress missing");
          await ingress.dispatch(token, {
            id: "context-worker",
            prompt: "Continue in the same worker workspace.",
            agentName: "Context Worker",
            wait: true,
            requiresGitContribution: false,
          });
          return { output: "leader done", threadId: request.threadId, usage: null };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      (_store, root) => {
        live = liveLeaderParts(root);
        return live.parts;
      },
    );
    const project = await service.createManagedProject({ displayName: "Continued Dispatch" });
    const leader = await service.createProjectChat(project.id, { name: "Continued Dispatch Chat" });
    const previousRunId = "22222222-2222-4222-8222-222222222222";
    await store.mutate((database) => {
      database.runs.push({
        id: previousRunId,
        agentId: leader.id,
        projectId: project.id,
        kind: "orchestration",
        parentRunId: null,
        orchestration: null,
        workspaceSource: {
          mode: "existing_repository",
          repositoryPath: project.repositoryPath,
          revision: project.baselineCommit,
        },
        project: {
          source: {
            mode: "existing_repository",
            repositoryPath: project.repositoryPath,
            requestedRevision: project.baselineCommit,
            baseCommit: project.baselineCommit,
            sourceFingerprint: "continued-dispatch",
          },
          runBranch: "launchpad/run/" + previousRunId,
          canonicalWorkspacePath: path.join(project.repositoryPath, ".old-canonical"),
          headCommit: project.baselineCommit,
          state: "cancelled",
          attempts: [],
          integrations: [],
        },
        status: "cancelled",
        prompt: "Dispatch the context worker.",
        output: null,
        error: "Run was cancelled before an outcome could be established.",
        usage: null,
        startedAt: "2026-08-30T00:00:00.000Z",
        completedAt: "2026-08-30T00:01:00.000Z",
        createdAt: "2026-08-30T00:00:00.000Z",
      });
    });
    const sent = await service.sendMessage(leader.id, "continue");
    await expect.poll(() => service.getRun(sent.run.id).status, { timeout: 15_000 }).toBe("completed");

    expect(sent.run.parentRunId).toBe(previousRunId);
    expect(workerRequests).toHaveLength(1);
    expect(workerRequests[0]?.workspacePath).not.toContain(path.sep + ".tasks" + path.sep);
    expect(workerRequests[0]?.workspacePath).toContain(path.join("workspaces"));
    const eventSessions = await readdir(path.join(path.dirname(workerRequests[0]!.commonWorkspacePath!), ".."));
    expect(eventSessions.some((entry) => entry.endsWith("_" + sent.run.id))).toBe(false);
    expect(eventSessions.some((entry) => entry.endsWith("_" + previousRunId))).toBe(true);
  }, 30_000);

  it("allows project-backed read-only dispatches to complete without commit markers", async () => {
    const dispatchResults: unknown[] = [];
    const workerRequests: RunnerRequest[] = [];
    let live: ReturnType<typeof liveLeaderParts> | null = null;
    const { service } = await serviceFixture(
      () => ({
        run: async (request) => {
          if (request.parentRunId) {
            workerRequests.push(request);
            return {
              output: "validation complete; no files changed",
              threadId: null,
              usage: null,
            };
          }
          const token = request.coordinationEnv?.LAUNCHPAD_COORDINATION_TOKEN;
          if (!token) throw new Error("leader coordination token missing");
          const ingress = live?.ingresses.get(token);
          if (!ingress) throw new Error("leader ingress missing");
          dispatchResults.push(await ingress.dispatch(token, {
            id: "forward-test",
            prompt: "Forward-test the skill without editing files.",
            agentName: "Forward Tester",
            requiresGitContribution: false,
            wait: true,
          }));
          return writeTodoApp(request);
        },
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      (_store, root) => {
        live = liveLeaderParts(root);
        return live.parts;
      },
    );
    const project = await service.createManagedProject({ displayName: "Read Only Dispatch" });
    const leader = await service.createProjectChat(project.id, { name: "Read Only Chat" });
    const { run } = await service.sendMessage(leader.id, "build and forward-test");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 30_000 }).toBe("completed");
    expect(dispatchResults[0]).toMatchObject({
      ok: true,
      result: { status: "completed", subtaskId: "forward-test" },
    });
    expect(workerRequests[0]?.prompt).not.toContain("LAUNCHPAD_COMMIT");
    expect(workerRequests[0]?.workspacePath).toContain(path.sep + ".tasks" + path.sep);
    const completed = service.getRun(run.id);
    expect(completed.project?.integrations).toHaveLength(1);
    expect(completed.project?.attempts.some((attempt) => attempt.subtaskId === "forward-test"))
      .toBe(false);
    expect(completed.orchestration?.workerResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subtaskId: "forward-test", status: "completed" }),
        expect.objectContaining({ subtaskId: "leader", status: "completed" }),
      ]),
    );
  }, 35_000);

  it("cancels after leader collection without integrating or advancing the baseline", async () => {
    let signalCollection!: () => void;
    const collecting = new Promise<void>((resolve) => { signalCollection = resolve; });
    let releaseCollection!: () => void;
    const mayFinish = new Promise<void>((resolve) => { releaseCollection = resolve; });
    const { service, projectRegistry } = await serviceFixture(
      () => ({
        run: async (request) => writeTodoApp(request),
        cancel: async () => true,
        isAvailable: async () => true,
      }),
      (_store, root) => ({
        ...liveLeaderParts(root).parts,
        contributionCollector: new class extends ContributionCollector {
          override async collect(input: Parameters<ContributionCollector["collect"]>[0]) {
            const evidence = await super.collect(input);
            signalCollection();
            await mayFinish;
            return evidence;
          }
        }(new GitClient(5_000)),
      }),
    );
    const project = await service.createManagedProject({ displayName: "Cancel Collect" });
    const leader = await service.createProjectChat(project.id, { name: "Cancel Collect Chat" });
    const { run } = await service.sendMessage(leader.id, "build a todo app");
    await collecting;
    const stopping = service.stopAgent(leader.id);
    await Promise.resolve();
    releaseCollection();
    await stopping;

    const cancelled = service.getRun(run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.project?.integrations).toEqual([]);
    expect(cancelled.project?.headCommit).toBe(cancelled.project?.source.baseCommit);
    expect(projectRegistry.get(project.id).baselineCommit).toBe(project.baselineCommit);
    expect(cancelled.orchestration?.workerResults.some((result) => result.status === "contribution_ready"))
      .toBe(false);
  }, 20_000);

  it("rolls back a live-leader contribution cancelled inside integration", async () => {
    let signalApplied!: () => void;
    const applied = new Promise<void>((resolve) => { signalApplied = resolve; });
    let releaseHook!: () => void;
    const mayContinue = new Promise<void>((resolve) => { releaseHook = resolve; });
    const { service, projectRegistry } = await serviceFixture(
      () => ({
        run: async (request) => writeTodoApp(request),
        cancel: async () => false,
        isAvailable: async () => true,
      }),
      (_store, root) => ({
        ...liveLeaderParts(root).parts,
        afterCanonicalIntegrationForTest: async () => {
          signalApplied();
          await mayContinue;
        },
      }),
    );
    const project = await service.createManagedProject({ displayName: "Cancel Integrate" });
    const leader = await service.createProjectChat(project.id, { name: "Cancel Integrate Chat" });
    const { run } = await service.sendMessage(leader.id, "build a todo app");
    await applied;
    const stopping = service.stopAgent(leader.id);
    releaseHook();
    await stopping;

    const cancelled = service.getRun(run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.project?.headCommit).toBe(cancelled.project?.source.baseCommit);
    expect(cancelled.project?.integrations[0]).toMatchObject({
      state: "rolled_back", structuralDecision: "failed", reason: "user_cancelled",
    });
    expect(projectRegistry.get(project.id).baselineCommit).toBe(project.baselineCommit);
  }, 20_000);
});
