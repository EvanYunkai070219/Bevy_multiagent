/**
 * What the agents have learned, as a place you can go.
 *
 * A worker that solves something well can validate and publish the write-up to
 * a persistent hub, and a later worker can install it. That is the platform
 * accumulating capability across runs -- the most interesting thing it does --
 * and it was entirely invisible: the hub lived on disk, reachable only through
 * MCP tools inside a container, so an operator could not tell an empty hub from
 * a full one.
 *
 * Everything on this page is read from the published record. There is no usage
 * count and no "last used" because nothing on disk records either; inventing
 * them would make the hub look busier than the runs actually made it. What
 * there is instead is provenance: which run produced the skill, what evidence
 * was cited, and what version it replaced.
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import { MarkdownText } from "./MarkdownText";
import type { SkillDetail, SkillSummary } from "./types";
import { formatFullStamp } from "./format";

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function SkillDetailView({
  detail,
  onVersion,
}: {
  detail: SkillDetail;
  onVersion: (version: string) => void;
}) {
  return (
    <div className="skill-detail">
      <header className="skill-detail-head">
        <div>
          <span className="eyebrow">Skill</span>
          <h2>{detail.name}</h2>
          <p>{detail.description}</p>
        </div>
        {detail.versions.length > 1 && (
          <label className="skill-version-picker">
            <span>Version</span>
            <select
              value={detail.version}
              onChange={(event) => onVersion(event.target.value)}
            >
              {[...detail.versions].reverse().map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      <dl className="skill-facts">
        <div>
          <dt>Version</dt>
          <dd>{detail.version}</dd>
        </div>
        <div>
          <dt>Published</dt>
          <dd>{formatFullStamp(detail.createdAt) || "unrecorded"}</dd>
        </div>
        {/* The run is the provenance: it is where the skill was earned, and it
            is still openable in the transcript. */}
        <div>
          <dt>Produced by run</dt>
          <dd>{detail.ownerRunId ?? "unrecorded"}</dd>
        </div>
        {detail.supersedesVersion !== null && (
          <div>
            <dt>Replaces</dt>
            <dd>{detail.supersedesVersion}</dd>
          </div>
        )}
      </dl>

      {detail.tags.length > 0 && (
        <div className="skill-tags">
          {detail.tags.map((tag) => (
            <span className="skill-tag" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      )}

      {detail.notes.trim() !== "" && <p className="skill-notes">{detail.notes}</p>}

      {detail.provenanceWarnings.length > 0 && (
        <ul className="skill-warnings">
          {detail.provenanceWarnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      {detail.evidenceRefs.length > 0 && (
        <section className="skill-section">
          <h3>Evidence cited</h3>
          <ul className="skill-refs">
            {detail.evidenceRefs.map((ref) => (
              <li key={ref}>{ref}</li>
            ))}
          </ul>
        </section>
      )}

      {detail.originPatterns.length > 0 && (
        <section className="skill-section">
          <h3>Origin patterns</h3>
          <ul className="skill-refs">
            {detail.originPatterns.map((pattern) => (
              <li key={pattern}>{pattern}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="skill-section">
        <h3>SKILL.md</h3>
        {detail.skillMarkdown === null ? (
          <p className="skill-empty">
            This published folder has no SKILL.md. The files below are what it holds.
          </p>
        ) : (
          <MarkdownText className="markdown-body skill-markdown">
            {detail.skillMarkdown}
          </MarkdownText>
        )}
      </section>

      {detail.files.length > 0 && (
        <section className="skill-section">
          <h3>Files</h3>
          <ul className="skill-files">
            {detail.files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function SkillHub({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<SkillSummary[] | null>(null);
  const [openName, setOpenName] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .skills()
      .then((result) => {
        if (!cancelled) setList(Array.isArray(result.skills) ? result.skills : []);
      })
      .catch((cause) => {
        // An unreadable hub is not an empty hub, and saying "no skills yet"
        // when the read failed would report a lie about the platform.
        if (!cancelled) setError(reason(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const open = (name: string, version?: string): void => {
    setOpenName(name);
    setDetail(null);
    setError(null);
    void api
      .skill(name, version)
      .then((result) => setDetail(result.skill))
      .catch((cause) => setError(reason(cause)));
  };

  return (
    <section className="skill-hub">
      <header className="skill-hub-head">
        <div>
          <span className="eyebrow">Skill hub</span>
          <h1>What the agents have published</h1>
          <p>
            Skills are written, validated and published by agents during runs, and
            installed by later agents that need them. This is the persistent hub
            those publications land in.
          </p>
        </div>
        <button
          type="button"
          className="button button-ghost"
          onClick={onClose}
          aria-label="Close the skill hub"
        >
          Close
        </button>
      </header>

      {error !== null && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      <div className="skill-hub-body">
        <ul className="skill-list">
          {list !== null &&
            list.map((item) => (
              <li key={item.name}>
                <button
                  type="button"
                  className={
                    "skill-row" + (item.name === openName ? " skill-row--open" : "")
                  }
                  onClick={() => open(item.name)}
                >
                  <span className="skill-row-name">{item.name}</span>
                  <span className="skill-row-description">{item.description}</span>
                  <span className="skill-row-meta">
                    v{item.version}
                    {item.versions.length > 1
                      ? " · " + item.versions.length + " versions"
                      : ""}
                    {formatFullStamp(item.createdAt) === ""
                      ? ""
                      : " · " + formatFullStamp(item.createdAt)}
                  </span>
                </button>
              </li>
            ))}
        </ul>

        {list !== null && list.length === 0 && error === null && (
          <div className="skill-empty-hub">
            <h2>No skills have been published yet.</h2>
            <p>
              A skill appears here when an agent validates one and publishes it
              during a run. Nothing is seeded: this list is exactly what the runs
              on this machine have produced.
            </p>
          </div>
        )}

        {detail !== null && (
          <SkillDetailView
            detail={detail}
            onVersion={(version) => open(detail.name, version)}
          />
        )}
      </div>
    </section>
  );
}
