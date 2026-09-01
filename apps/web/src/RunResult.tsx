/**
 * What a Run produced, told apart from how it got there.
 *
 * The answer used to be one message among the prompt, the steers and a fully
 * expanded activity list, so the thing a reader came for looked exactly like
 * the thinking that preceded it. It now closes the Run in its own block, with
 * the files the Run touched named underneath — a summary that says "written to
 * report.txt" is only useful if the path is somewhere you can find it.
 */
import { MarkdownText } from "./MarkdownText";
import { WorkspaceDownload, WorkspaceImage, looksLikeImage } from "./WorkspaceFile";
import type { Message, RunEvent } from "./types";

const MAX_LISTED_FILES = 12;

/**
 * Paths the Run actually changed, in the order they were first touched.
 *
 * Read only from the canonical `changedFiles`; `attributes` is provider-shaped
 * and must not be consumed by logic.
 */
export function producedFiles(events: RunEvent[]): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    for (const path of event.output?.changedFiles ?? []) {
      const trimmed = path.trim();
      if (trimmed.length > 0) seen.add(trimmed);
    }
  }
  return [...seen];
}

export function RunResult({
  answer,
  events,
  failed,
  agentId,
}: {
  answer: Message | null;
  events: RunEvent[];
  failed: boolean;
  /** Whose workspace the named files belong to. */
  agentId?: string;
}) {
  const files = producedFiles(events);
  if (answer === null && files.length === 0) return null;

  const listed = files.slice(0, MAX_LISTED_FILES);
  const hidden = files.length - listed.length;

  return (
    <section className={"run-result" + (failed ? " run-result--failed" : "")}>
      <div className="run-result-head">
        <span className="eyebrow">Result</span>
      </div>
      {answer !== null && (
        <MarkdownText className="run-result-body markdown-body" agentId={agentId}>
          {answer.content}
        </MarkdownText>
      )}
      {files.length > 0 && (
        <div className="run-result-files">
          <div className="run-result-files-label">
            {files.length} file{files.length === 1 ? "" : "s"} changed
          </div>
          <ul>
            {listed.map((path) => (
              <li key={path}>
                {agentId !== undefined && looksLikeImage(path) ? (
                  <WorkspaceImage agentId={agentId} path={path} alt={path} />
                ) : agentId !== undefined ? (
                  <WorkspaceDownload agentId={agentId} path={path} label={path} />
                ) : (
                  <code>{path}</code>
                )}
              </li>
            ))}
            {hidden > 0 && <li className="run-result-files-more">and {hidden} more</li>}
          </ul>
        </div>
      )}
    </section>
  );
}
