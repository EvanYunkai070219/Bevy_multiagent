/**
 * Chooses hub skills for a run before its first turn.
 *
 * The agents already have tools to search and install skills themselves, and
 * leaving it there did not work: discovery costs turns, the agent sees a list
 * it cannot evaluate cheaply, and it often installs nothing. Selection is a
 * decision the middleware can make once, deterministically, from the task text
 * and the hub's own provenance records.
 *
 * The gate matters more than the ranking. A candidate carrying a blocking
 * provenance warning is rejected outright; a low-confidence match produces a
 * shortlist rather than an installation, because installing the wrong method is
 * worse than installing none. Durable installation into the agent's home
 * directory requires an explicit request — the default lands in the run's
 * shared workspace, where siblings can read it and it disappears with the run.
 */
import { readFileSync } from "node:fs";
import { appendFile, cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { listSkills, readSkillFromHub, type SkillDetail } from "../skill-hub.js";
import type {
  SkillCapabilityNeed,
  SkillInjectionPlan,
  SkillRouteCandidate,
  SkillRouteInstall,
  SkillRouteRank,
} from "../types.js";

const MAX_CANDIDATES_TO_READ = 25;
const PRIMARY_SCORE_THRESHOLD = 0.58;
const SUPPORTING_SCORE_THRESHOLD = 0.72;
const LOW_CONFIDENCE_THRESHOLD = 0.42;
const BLOCKING_WARNING = /\b(block|reject|unsafe|invalid|untrusted|poison|malicious)\b/i;
const MAX_FEEDBACK_RECORDS = 500;

export interface SkillRouteInput {
  runId: string;
  task: string;
  now?: string;
  dataDirectory?: string;
  commonWorkspacePath?: string;
  candidates?: SkillRouteCandidate[];
  allowCodexHomeInstall?: boolean;
}

export interface SkillRoutingOutcomeInput {
  dataDirectory: string;
  runId: string;
  runStatus: string;
  taskOutcome?: string;
  completedAt: string;
  plans: SkillInjectionPlan[];
}

interface SkillRoutingFeedback {
  successes: number;
  failures: number;
}

export function classifyCapabilityNeeds(input: SkillRouteInput): SkillCapabilityNeed[] {
  const text = normalize(input.task);
  const needs: SkillCapabilityNeed[] = [];
  const add = (
    id: string,
    label: string,
    confidence: number,
    evidence: string[],
    constraints: SkillCapabilityNeed["constraints"] = {},
  ) => {
    needs.push({ id, label, confidence, evidence, constraints });
  };

  if (/\b(pdf|paper|article|citation|citations|doi|arxiv|table extraction)\b/.test(text)) {
    const academicEvidence = matches(text, [
      ["pdf", /\bpdfs?\b/],
      ["academic paper", /\b(academic|paper|article|arxiv|doi|citation|citations|references)\b/],
      ["structured extraction", /\b(extract|extraction|tables?|figures?|references|citations)\b/],
    ]);
    add(
      academicEvidence.some((item) => item !== "pdf")
        ? "academic_pdf_extraction"
        : "pdf_analysis",
      academicEvidence.some((item) => item !== "pdf")
        ? "Academic PDF extraction"
        : "PDF analysis",
      academicEvidence.some((item) => item !== "pdf") ? 0.91 : 0.72,
      academicEvidence.length > 0 ? academicEvidence : ["task mentions PDF"],
      { mustBeLocal: true, canModifyWorkspace: false },
    );
  }

  if (/\b(slide|slides|deck|ppt|pptx|presentation)\b/.test(text)) {
    add("presentation_generation", "Presentation generation", 0.82, ["task mentions slides"], {
      canModifyWorkspace: true,
    });
  }

  if (/\b(browser|webarena|website|web app|playwright|scrape|crawler)\b/.test(text)) {
    add("browser_automation", "Browser automation", 0.74, ["task mentions browser/web automation"], {
      requiresSandbox: true,
    });
  }

  if (/\b(test failure|stack trace|traceback|regression|debug|failing test)\b/.test(text)) {
    add("debugging", "Debugging", 0.69, ["task mentions failure/debugging"], {
      canModifyWorkspace: true,
    });
  }

  if (needs.length === 0 && text.trim().length > 0) {
    add("general_task", "General task", 0.2, ["no specific reusable capability detected"], {});
  }

  return needs.sort((left, right) => right.confidence - left.confidence);
}

export function retrieveSkillCandidates(
  input: SkillRouteInput,
  needs = classifyCapabilityNeeds(input),
): SkillRouteCandidate[] {
  if (input.candidates !== undefined) return input.candidates;
  if (!input.dataDirectory) return [];

  const terms = new Set<string>();
  for (const need of needs) {
    terms.add(need.id.replaceAll("_", " "));
    terms.add(need.label);
  }
  for (const token of normalize(input.task).split(/\s+/).filter((item) => item.length >= 4)) {
    terms.add(token);
  }

  const summaries = listSkills(input.dataDirectory)
    .filter((summary) => {
      const haystack = normalize([
        summary.name,
        summary.description,
        summary.tags.join(" "),
        summary.notes,
      ].join(" "));
      return [...terms].some((term) => haystack.includes(normalize(term)));
    })
    .slice(0, MAX_CANDIDATES_TO_READ);

  return summaries.map((summary) =>
    detailToCandidate(readSkillFromHub(input.dataDirectory!, summary.name, summary.version)),
  );
}

export function rankSkillCandidates(
  needs: SkillCapabilityNeed[],
  candidates: SkillRouteCandidate[],
  feedback = new Map<string, SkillRoutingFeedback>(),
): SkillRouteRank[] {
  return candidates.map((candidate) => rankCandidate(needs, candidate, feedback))
    .sort((left, right) =>
      right.score - left.score ||
      right.candidate.createdAt.localeCompare(left.candidate.createdAt) ||
      left.candidate.name.localeCompare(right.candidate.name),
    );
}

export function buildSkillInjectionPlan(input: SkillRouteInput): SkillInjectionPlan {
  const needs = classifyCapabilityNeeds(input);
  const candidates = retrieveSkillCandidates(input, needs);
  const ranked = rankSkillCandidates(needs, candidates, readSkillRoutingFeedback(input.dataDirectory));
  const selected = ranked
    .filter((rank) => rank.score >= PRIMARY_SCORE_THRESHOLD && !hasBlockingWarning(rank))
    .slice(0, 1);
  const supporting = ranked
    .filter((rank) =>
      selected.every((item) => item.candidate.name !== rank.candidate.name) &&
      rank.score >= SUPPORTING_SCORE_THRESHOLD &&
      !hasBlockingWarning(rank)
    )
    .slice(0, 2);
  const finalSelected = [...selected, ...supporting];
  const rejected = ranked.filter((rank) =>
    finalSelected.every((item) => item.candidate.name !== rank.candidate.name),
  );
  const highConfidenceNeed = needs.some((need) => need.confidence >= LOW_CONFIDENCE_THRESHOLD);
  const install = finalSelected.map((rank): SkillRouteInstall => ({
    ...rank.candidate.installArguments,
    scope: input.allowCodexHomeInstall === true
      ? rank.candidate.installArguments.scope
      : "run",
  }));
  const mode = finalSelected.length > 0
    ? "selected"
    : ranked.length > 0 && highConfidenceNeed
      ? "shortlist"
      : "none";

  return {
    runId: input.runId,
    task: input.task,
    createdAt: input.now ?? new Date().toISOString(),
    needs,
    selected: finalSelected,
    rejected,
    install: mode === "selected" ? install : [],
    promptContext: promptContext(mode, finalSelected, ranked.slice(0, 3)),
    mode,
  };
}

export function readSkillRoutingFeedback(dataDirectory?: string): Map<string, SkillRoutingFeedback> {
  const feedback = new Map<string, SkillRoutingFeedback>();
  if (!dataDirectory) return feedback;
  let text = "";
  try {
    text = readFileSync(path.join(dataDirectory, "skill-hub", "router-impact.jsonl"), "utf8");
  } catch {
    return feedback;
  }
  const lines = text.split(/\r?\n/).filter(Boolean).slice(-MAX_FEEDBACK_RECORDS);
  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const selected = Array.isArray(record.selected) ? record.selected : [];
    const helped = record.runStatus === "completed" &&
      (record.taskOutcome === "succeeded" || record.taskOutcome === null);
    const failed = record.runStatus === "failed" || record.taskOutcome === "failed";
    for (const item of selected) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const selectedItem = item as Record<string, unknown>;
      const name = typeof selectedItem.name === "string" ? selectedItem.name : "";
      const version = typeof selectedItem.version === "string" ? selectedItem.version : "";
      if (!name || !version) continue;
      const key = skillKey(name, version);
      const prior = feedback.get(key) ?? { successes: 0, failures: 0 };
      if (helped) prior.successes += 1;
      if (failed) prior.failures += 1;
      feedback.set(key, prior);
    }
  }
  return feedback;
}

export async function installSelectedSkills(
  plan: SkillInjectionPlan,
  input: Pick<SkillRouteInput, "dataDirectory" | "commonWorkspacePath">,
): Promise<SkillInjectionPlan> {
  if (!input.dataDirectory || !input.commonWorkspacePath || plan.install.length === 0) return plan;
  const installed: SkillRouteInstall[] = [];
  for (const item of plan.install) {
    if (item.scope !== "run") {
      installed.push(item);
      continue;
    }
    const detail = readSkillFromHub(input.dataDirectory, item.name, item.version);
    const source = path.join(input.dataDirectory, "skill-hub", "skills", detail.name, detail.version);
    const destination = item.destination ??
      path.join(input.commonWorkspacePath, "skills", detail.name);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, force: true });
    await writeFile(
      path.join(destination, ".launchpad-selected-skill.json"),
      JSON.stringify({
        name: detail.name,
        version: detail.version,
        selectedAt: new Date().toISOString(),
        runId: plan.runId,
      }, null, 2) + "\n",
      "utf8",
    );
    installed.push({ ...item, destination, installedPath: destination });
  }
  const installedByName = new Map(installed.map((item) => [item.name, item]));
  const selected = plan.selected.map((rank) => {
    const installedSkill = installedByName.get(rank.candidate.name);
    if (!installedSkill) return rank;
    const destination = installedSkill.installedPath ?? installedSkill.destination;
    return {
      ...rank,
      candidate: {
        ...rank.candidate,
        installArguments: {
          ...rank.candidate.installArguments,
          ...(destination === undefined ? {} : { destination }),
        },
      },
    };
  });
  const nextPlan = { ...plan, install: installed, selected };
  if (nextPlan.mode === "selected") {
    nextPlan.promptContext = promptContext(nextPlan.mode, nextPlan.selected, nextPlan.selected);
  }
  return nextPlan;
}

export function formatSkillPromptContext(plan?: SkillInjectionPlan | null): string {
  return plan?.promptContext.trim() ? "\n\n" + plan.promptContext.trim() : "";
}

export async function recordSkillRoutingOutcome(input: SkillRoutingOutcomeInput): Promise<void> {
  const routed = input.plans.filter((plan) => plan.mode !== "none" || plan.selected.length > 0);
  if (routed.length === 0) return;
  const directory = path.join(input.dataDirectory, "skill-hub");
  await mkdir(directory, { recursive: true });
  for (const plan of routed) {
    await appendFile(
      path.join(directory, "router-impact.jsonl"),
      JSON.stringify({
        schemaVersion: 1,
        runId: input.runId,
        runStatus: input.runStatus,
        taskOutcome: input.taskOutcome ?? null,
        completedAt: input.completedAt,
        mode: plan.mode,
        task: plan.task,
        selected: plan.selected.map((rank) => ({
          name: rank.candidate.name,
          version: rank.candidate.version,
          score: rank.score,
          reasons: rank.reasons,
          risks: rank.risks,
        })),
        rejected: plan.rejected.slice(0, 5).map((rank) => ({
          name: rank.candidate.name,
          version: rank.candidate.version,
          score: rank.score,
          reasons: rank.reasons,
          risks: rank.risks,
        })),
        installed: plan.install.map((item) => ({
          name: item.name,
          version: item.version,
          scope: item.scope,
          installedPath: item.installedPath ?? item.destination ?? null,
        })),
      }) + "\n",
      "utf8",
    );
  }
}

function detailToCandidate(detail: SkillDetail): SkillRouteCandidate {
  return {
    name: detail.name,
    version: detail.version,
    description: detail.description,
    tags: detail.tags,
    notes: detail.notes,
    createdAt: detail.createdAt,
    evidenceRefs: detail.evidenceRefs,
    provenanceWarnings: detail.provenanceWarnings,
    installArguments: { name: detail.name, version: detail.version, scope: "run" },
  };
}

function rankCandidate(
  needs: SkillCapabilityNeed[],
  candidate: SkillRouteCandidate,
  feedback: Map<string, SkillRoutingFeedback>,
): SkillRouteRank {
  const haystack = normalize([
    candidate.name,
    candidate.description,
    candidate.tags.join(" "),
    candidate.notes,
    candidate.evidenceRefs.join(" "),
  ].join(" "));
  let score = 0;
  const reasons: string[] = [];
  const risks: string[] = [];

  for (const need of needs) {
    const needTerms = termsForNeed(need);
    const matches = needTerms.filter((term) => haystack.includes(term));
    if (matches.length === 0) continue;
    const contribution = Math.min(0.64, 0.2 + matches.length * 0.11) * need.confidence;
    score += contribution;
    reasons.push("matches " + need.id + ": " + matches.slice(0, 3).join(", "));
  }

  if (candidate.tags.some((tag) => needs.some((need) => normalize(tag) === normalize(need.id)))) {
    score += 0.18;
    reasons.push("exact capability tag");
  }
  if (candidate.evidenceRefs.length > 0 || /\b(success|accepted|validated|forward test|impact)\b/i.test(candidate.notes)) {
    score += 0.08;
    reasons.push("has validation or impact evidence");
  }
  if (candidate.provenanceWarnings.length > 0) {
    score -= hasBlockingWarning({ candidate }) ? 0.5 : 0.14;
    risks.push("provenance warning: " + candidate.provenanceWarnings[0]);
  }
  if (isGenericPdfSkill(candidate) && needs.some((need) => need.id === "academic_pdf_extraction")) {
    score -= 0.12;
    risks.push("generic PDF fit for an academic extraction task");
  }
  const prior = feedback.get(skillKey(candidate.name, candidate.version));
  if (prior !== undefined) {
    if (prior.successes > 0) {
      score += Math.min(0.18, prior.successes * 0.06);
      reasons.push("prior router success: " + prior.successes);
    }
    if (prior.failures > prior.successes) {
      score -= Math.min(0.18, (prior.failures - prior.successes) * 0.06);
      risks.push("prior router failure: " + prior.failures);
    }
  }

  return {
    candidate,
    score: clamp(score),
    reasons: reasons.length > 0 ? reasons : ["no strong capability match"],
    risks,
  };
}

function skillKey(name: string, version: string): string {
  return name + "@" + version;
}

function termsForNeed(need: SkillCapabilityNeed): string[] {
  const common = [
    normalize(need.id),
    normalize(need.id.replaceAll("_", " ")),
    normalize(need.label),
  ];
  if (need.id === "academic_pdf_extraction") {
    return [...common, "academic", "paper", "pdf", "citation", "citations", "references", "doi", "table extraction"];
  }
  if (need.id === "pdf_analysis") return [...common, "pdf", "analysis", "extract"];
  if (need.id === "presentation_generation") return [...common, "slides", "deck", "ppt", "pptx", "presentation"];
  if (need.id === "browser_automation") return [...common, "browser", "playwright", "web automation", "webarena"];
  if (need.id === "debugging") return [...common, "debug", "regression", "test failure", "traceback"];
  return common;
}

function promptContext(
  mode: SkillInjectionPlan["mode"],
  selected: SkillRouteRank[],
  shortlist: SkillRouteRank[],
): string {
  if (mode === "selected" && selected.length > 0) {
    return [
      "Middleware-selected Skill Hub context:",
      ...selected.map((rank) => {
        const installed = rank.candidate.installArguments.destination ??
          "$COMMON_WORKSPACE/skills/" + rank.candidate.name;
        return "- " + rank.candidate.name + " v" + rank.candidate.version +
          " at " + installed + ". Use its SKILL.md before rebuilding this workflow. " +
          "Selection evidence: " + rank.reasons.slice(0, 3).join("; ") + ".";
      }),
    ].join("\n");
  }
  if (mode === "shortlist" && shortlist.length > 0) {
    return [
      "Skill Hub shortlist:",
      ...shortlist.map((rank) =>
        "- " + rank.candidate.name + " v" + rank.candidate.version +
        " scored " + rank.score.toFixed(2) + ": " + rank.reasons.slice(0, 2).join("; "),
      ),
      "No skill was installed automatically; inspect before use.",
    ].join("\n");
  }
  return "";
}

function hasBlockingWarning(rank: Pick<SkillRouteRank, "candidate">): boolean {
  return rank.candidate.provenanceWarnings.some((warning) => BLOCKING_WARNING.test(warning));
}

function isGenericPdfSkill(candidate: SkillRouteCandidate): boolean {
  const text = normalize([candidate.name, candidate.description, candidate.tags.join(" ")].join(" "));
  return text.includes("pdf") && !/(academic|paper|citation|citations|doi|references)/.test(text);
}

function matches(text: string, patterns: [string, RegExp][]): string[] {
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([label]) => "task mentions " + label);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}
