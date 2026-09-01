/**
 * Reading the persistent skill hub from the control plane.
 *
 * Agents accumulate skills: a worker that solved something once can validate,
 * publish and later install the write-up, and every one of those is written to
 * `<data>/skill-hub/skills/<name>/<version>/` with a `.launchpad-skill.json`
 * record beside the skill's own files. That is real capability the platform is
 * building up, and until now it was visible only to agents holding the MCP
 * tools -- there was no HTTP route at all, so an operator could not tell
 * whether the hub held nothing or held a dozen skills.
 *
 * This reads that directory and nothing else. Nothing is derived, counted or
 * inferred: usage is not recorded anywhere on disk, so this reports no usage.
 * A field that is absent from the record is absent here too.
 */
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import path from "node:path";
import { HttpError } from "./errors.js";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^[a-zA-Z0-9_.-]{1,80}$/;
const RECORD = ".launchpad-skill.json";
/** Enough for a long SKILL.md; a hub entry is documentation, not a dataset. */
const MAX_MARKDOWN = 60_000;
/** A skill folder is a handful of files. A pathological one must not be a page of noise. */
const MAX_FILES = 300;

export interface SkillSummary {
  name: string;
  version: string;
  description: string;
  tags: string[];
  notes: string;
  ownerAgentId: string | null;
  ownerRunId: string | null;
  createdAt: string;
  /** Every published version of this skill, oldest first. */
  versions: string[];
}

export interface SkillDetail extends SkillSummary {
  sourcePath: string | null;
  hubPath: string | null;
  originPatterns: string[];
  evidenceRefs: string[];
  supersedesVersion: string | null;
  provenanceWarnings: string[];
  /** Null when the published folder has no SKILL.md, rather than an empty page. */
  skillMarkdown: string | null;
  files: string[];
}

function checkedName(value: string): string {
  if (!NAME.test(value) || value.length > 80) {
    throw new HttpError(400, "Not a valid skill name");
  }
  return value;
}

/**
 * The publisher's own version rule allows dots, which allows `..`. Reading is
 * done from a URL, so the traversal case is rejected here explicitly rather
 * than relying on a regular expression written for a different purpose.
 */
function checkedVersion(value: string): string {
  if (!VERSION.test(value) || value === "." || value.includes("..")) {
    throw new HttpError(400, "Not a valid skill version");
  }
  return value;
}

function skillsRoot(dataDirectory: string): string {
  return path.join(dataDirectory, "skill-hub", "skills");
}

function directories(target: string): string[] {
  try {
    return readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function text(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === "string" ? (record[key] as string) : null;
}

function strings(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readRecord(root: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, RECORD), "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Published versions of one skill, in the order they were published. */
function versionsOf(dataDirectory: string, name: string): { version: string; createdAt: string }[] {
  const base = path.join(skillsRoot(dataDirectory), name);
  const published: { version: string; createdAt: string }[] = [];
  for (const version of directories(base)) {
    if (!VERSION.test(version) || version.includes("..")) continue;
    const record = readRecord(path.join(base, version));
    // A folder with no record is a copy that never finished publishing. It is
    // not a version, and listing it would offer a detail page that 404s.
    if (record === null) continue;
    published.push({ version, createdAt: text(record, "createdAt") ?? "" });
  }
  return published.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.version.localeCompare(right.version),
  );
}

function summarise(
  record: Record<string, unknown>,
  name: string,
  version: string,
  versions: string[],
): SkillSummary {
  return {
    name,
    version,
    description: text(record, "description") ?? "",
    tags: strings(record, "tags"),
    notes: text(record, "notes") ?? "",
    ownerAgentId: text(record, "ownerAgentId"),
    ownerRunId: text(record, "ownerRunId"),
    createdAt: text(record, "createdAt") ?? "",
    versions,
  };
}

/** One row per skill at its newest version, most recently published first. */
export function listSkills(dataDirectory: string): SkillSummary[] {
  const skills: SkillSummary[] = [];
  for (const name of directories(skillsRoot(dataDirectory))) {
    if (!NAME.test(name)) continue;
    const versions = versionsOf(dataDirectory, name);
    const latest = versions.at(-1);
    if (latest === undefined) continue;
    const record = readRecord(path.join(skillsRoot(dataDirectory), name, latest.version));
    if (record === null) continue;
    skills.push(
      summarise(record, name, latest.version, versions.map((item) => item.version)),
    );
  }
  return skills.sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || left.name.localeCompare(right.name),
  );
}

/** Relative paths inside the published folder, excluding the hub's own record. */
function bundledFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (found.length >= MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) return;
      const relative = prefix === "" ? entry.name : prefix + "/" + entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else if (entry.isFile() && entry.name !== RECORD) found.push(relative);
    }
  };
  walk(root, "");
  // SKILL.md is the skill; everything else is a resource it refers to, so it
  // leads the list rather than landing wherever the alphabet puts it.
  return found.sort((left, right) =>
    left === "SKILL.md"
      ? -1
      : right === "SKILL.md"
        ? 1
        : left.localeCompare(right),
  );
}

export function readSkillFromHub(
  dataDirectory: string,
  name: string,
  version?: string,
): SkillDetail {
  const safeName = checkedName(name);
  const versions = versionsOf(dataDirectory, safeName);
  const selected =
    version === undefined || version === ""
      ? versions.at(-1)?.version
      : checkedVersion(version);
  if (selected === undefined) throw new HttpError(404, "Skill not found");

  const root = path.join(skillsRoot(dataDirectory), safeName, selected);
  const record = readRecord(root);
  if (record === null) throw new HttpError(404, "Skill not found");

  let skillMarkdown: string | null = null;
  try {
    skillMarkdown = readFileSync(path.join(root, "SKILL.md"), "utf8").slice(0, MAX_MARKDOWN);
  } catch {
    skillMarkdown = null;
  }

  return {
    ...summarise(record, safeName, selected, versions.map((item) => item.version)),
    sourcePath: text(record, "sourcePath"),
    hubPath: text(record, "hubPath"),
    originPatterns: strings(record, "originPatterns"),
    evidenceRefs: strings(record, "evidenceRefs"),
    supersedesVersion: text(record, "supersedesVersion"),
    provenanceWarnings: strings(record, "provenanceWarnings"),
    skillMarkdown,
    files: bundledFiles(root),
  };
}
