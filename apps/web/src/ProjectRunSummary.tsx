import type { ProjectRunRecord } from "./types";

export function ProjectRunSummary({ project }: { project: ProjectRunRecord }) {
  const integrated = project.integrations.filter((item) => item.state === "integrated");
  const primaryFailure = project.integrations.find(
    (item) => item.state === "conflicted" || item.state === "rolled_back",
  );
  const preservedAttempts = project.attempts.filter((attempt) => attempt.cleanup === "preserved");

  return (
    <section className="project-run-summary" aria-label="Project run">
      <div className="project-run-summary-head">
        <span className="eyebrow">Structural integration</span>
        {project.runBranch && <code>{project.runBranch}</code>}
      </div>
      <strong>
        {integrated.length} {integrated.length === 1 ? "commit" : "commits"} integrated
      </strong>
      {integrated.length > 0 && (
        <span className="project-run-commits">
          {integrated
            .map((item) => item.canonicalHeadAfter?.slice(0, 12))
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
      {primaryFailure?.reason && (
        <span className="project-run-reason">{primaryFailure.reason}</span>
      )}
      {preservedAttempts.length > 0 && (
        <div className="project-run-preserved">
          <strong>
            {preservedAttempts.length}{" "}
            {preservedAttempts.length === 1 ? "attempt" : "attempts"} preserved
          </strong>
          {preservedAttempts.map((attempt) => (
            <span key={attempt.attemptId}>
              {attempt.subtaskId}
              {attempt.reason ? `: ${attempt.reason}` : ""}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
