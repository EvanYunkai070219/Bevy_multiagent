import type { SkillInjectionPlan, SkillRouteRank } from "./types";

function selectedRows(plans: SkillInjectionPlan[]): SkillRouteRank[] {
  const rows: SkillRouteRank[] = [];
  const seen = new Set<string>();
  for (const plan of plans) {
    for (const rank of plan.selected ?? []) {
      const key = rank.candidate.name + "@" + rank.candidate.version;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(rank);
    }
  }
  return rows;
}

function installedPath(plan: SkillInjectionPlan, rank: SkillRouteRank): string {
  const installed = plan.install.find((item) =>
    item.name === rank.candidate.name && item.version === rank.candidate.version
  );
  return installed?.installedPath ??
    installed?.destination ??
    rank.candidate.installArguments.destination ??
    "$COMMON_WORKSPACE/skills/" + rank.candidate.name;
}

export function SelectedSkills({ plans }: { plans?: SkillInjectionPlan[] }) {
  const safePlans = Array.isArray(plans) ? plans : [];
  const rows = selectedRows(safePlans);
  if (rows.length === 0) return null;

  return (
    <section className="selected-skills" aria-label="Selected skills">
      <div className="selected-skills-head">
        <span className="eyebrow">Selected Skills</span>
        <span>{rows.length} installed</span>
      </div>
      <ul>
        {rows.map((rank) => {
          const plan = safePlans.find((item) =>
            item.selected.some((selected) =>
              selected.candidate.name === rank.candidate.name &&
              selected.candidate.version === rank.candidate.version
            )
          )!;
          return (
            <li key={rank.candidate.name + "@" + rank.candidate.version}>
              <div className="selected-skill-main">
                <strong>{rank.candidate.name}</strong>
                <span>v{rank.candidate.version}</span>
                <span>{Math.round(rank.score * 100)}%</span>
              </div>
              <code>{installedPath(plan, rank)}</code>
              {rank.reasons.length > 0 && (
                <p>{rank.reasons.slice(0, 2).join("; ")}</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
