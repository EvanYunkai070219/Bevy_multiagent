import type { ProjectRegistry } from "./project-registry.js";
import { JsonStore } from "./store.js";
import type { Agent, AgentRun } from "./types.js";

export async function migrateLegacyChats(store: JsonStore, registry: ProjectRegistry): Promise<void> {
  const snapshot = store.snapshot();
  const topLevel = snapshot.agents.filter((agent) => agent.parentAgentId === null);
  for (const agent of topLevel) {
    if (agent.projectId) continue;
    if (agent.unassignedPlacement === "temporary") continue;

    const runs = snapshot.runs.filter((run) => run.agentId === agent.id);
    const identities = await verifiableIdentities(registry, runs);
    if (identities.size === 1) {
      const source = [...identities.values()][0]!;
      const project = await registry.openExternal({
        displayName: agent.name,
        repositoryPath: source.repositoryPath,
        revision: source.revision,
      });
      await assignAgent(store, agent.id, project.id, null);
      continue;
    }
    const placement: Agent["unassignedPlacement"] =
      runs.length > 0 && runs.every((run) => run.workspaceSource?.mode === "ephemeral_research")
        ? "temporary"
        : "previous";
    await assignAgent(store, agent.id, null, placement);
  }
}

async function verifiableIdentities(
  registry: ProjectRegistry,
  runs: AgentRun[],
): Promise<Map<string, { repositoryPath: string; revision: string }>> {
  const identities = new Map<string, { repositoryPath: string; revision: string }>();
  for (const run of runs) {
    const source = run.workspaceSource;
    if (source?.mode !== "existing_repository") continue;
    try {
      const prepared = await registry.inspectExternal(source.repositoryPath, source.revision);
      const key = prepared.identity.gitCommonDev + ":" + prepared.identity.gitCommonIno;
      if (!identities.has(key)) {
        identities.set(key, { repositoryPath: source.repositoryPath, revision: source.revision });
      }
    } catch {
      // Missing or unverifiable historical paths are not identities.
    }
  }
  return identities;
}

async function assignAgent(
  store: JsonStore,
  agentId: string,
  projectId: string | null,
  unassignedPlacement: Agent["unassignedPlacement"],
): Promise<void> {
  await store.mutate((database) => {
    const agent = database.agents.find((item) => item.id === agentId);
    if (!agent) return;
    if (agent.projectId === projectId && agent.unassignedPlacement === unassignedPlacement) return;
    agent.projectId = projectId;
    agent.unassignedPlacement = unassignedPlacement;
  });
}
