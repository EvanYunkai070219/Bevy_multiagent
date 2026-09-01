import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  taskWorkspacePath(workerId: string, leaderRunId: string, workerRunId: string): string {
    return path.join(this.root, workerId, ".tasks", leaderRunId, workerRunId);
  }

  commonWorkspacePath(leaderRunId: string): string {
    return path.join(this.root, ".shared", leaderRunId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
    await mkdir(path.join(this.root, ".shared"), { recursive: true });
  }

  async createCommon(leaderRunId: string): Promise<string> {
    const workspacePath = this.commonWorkspacePath(leaderRunId);
    await mkdir(workspacePath, { recursive: true });
    return workspacePath;
  }

  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: true });
    await this.writeInstructions(agent);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  async createTaskScoped(agent: Agent, workspacePath: string): Promise<void> {
    await mkdir(workspacePath, { recursive: true });
    await this.writeInstructions({ ...agent, workspacePath });
    await writeFile(
      path.join(workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(workspacePath, "README.md"),
      [
        "# " + agent.name + " task workspace",
        "",
        "This fresh workspace is scoped to one delegated worker run.",
        "The owning worker's persistent identity is " + agent.id + ".",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  async writeInstructions(agent: Agent): Promise<void> {
    await writeFile(
      path.join(agent.workspacePath, "AGENTS.md"),
      buildInstructions(agent),
      "utf8",
    );
  }

  /**
   * Fingerprint of the instructions this Agent will actually run with.
   *
   * Recorded on every Run so two Runs can be compared on content rather than on
   * a version number somebody remembered to bump.
   */
  instructionsHash(agent: Agent): string {
    return createHash("sha256")
      .update(buildInstructions(agent))
      .digest("hex")
      .slice(0, 12);
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }
}

/** The exact AGENTS.md content the Runtime will read. */
export function buildInstructions(agent: Agent): string {
  return [
    "# Platform-managed Agent instructions",
    "",
    "You are the coding Agent named " + agent.name + ".",
    agent.description ? "Purpose: " + agent.description : "",
    "",
    "## Instructions",
    "",
    agent.instructions ||
      "Help the user complete coding tasks in this workspace. Explain material results concisely.",
    "",
    "## Workspace rules",
    "",
    "- Work only inside this workspace unless the user explicitly requests otherwise.",
    "- Preserve existing user files and avoid destructive operations.",
    "- Build and test changes when practical.",
    "- Never print environment variables or credentials.",
    "",
    "This file is regenerated when the Agent configuration is updated.",
    "",
  ]
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n");
}
