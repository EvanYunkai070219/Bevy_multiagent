/**
 * A file out of an Agent's workspace, shown rather than described.
 *
 * An agent that says "the chart is in outputs/chart.png" has told you where it
 * is and nothing about what it contains. When the answer references a file this
 * renders it: an image inline, anything else as a link that downloads.
 *
 * The bytes are fetched rather than linked because authorisation is a header —
 * an `<img src>` at the API would arrive unauthenticated once a bearer token is
 * configured, and a token in the query string would end up in history and logs.
 */
import { useEffect, useState } from "react";
import { api } from "./api";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);

/** SVG is deliberately absent: it renders as a document and can carry script. */
export function looksLikeImage(filePath: string): boolean {
  const clean = filePath.split(/[?#]/)[0] ?? "";
  const extension = clean.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(extension);
}

/** Absolute and data URLs belong to whoever wrote them, not to a workspace. */
export function isWorkspacePath(url: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("//");
}

export function WorkspaceImage({
  agentId,
  path,
  alt,
}: {
  agentId: string;
  path: string;
  alt: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setSrc(null);
    setFailed(false);

    void api
      .workspaceFile(agentId, path)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      // The object URL pins the blob in memory until it is released.
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [agentId, path]);

  if (failed) {
    // Say which file could not be read rather than showing a broken frame.
    return <code className="workspace-file-missing">{path}</code>;
  }
  if (src === null) return <span className="workspace-file-loading">{path}</span>;
  return <img className="workspace-image" src={src} alt={alt || path} />;
}

export function WorkspaceDownload({
  agentId,
  path,
  label,
}: {
  agentId: string;
  path: string;
  label: string;
}) {
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const blob = await api.workspaceFile(agentId, path);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = path.split("/").pop() ?? "file";
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button type="button" className="workspace-file-link" onClick={() => void save()}>
      {label || path}
      {busy ? " …" : ""}
    </button>
  );
}

/**
 * A message someone typed, with any file they attached shown rather than
 * spelled out.
 *
 * An attachment reaches the Agent as a path appended to the prompt, which is
 * what the Agent needs and the opposite of what a person needs: they picked a
 * picture and want to see the picture. Lines that are nothing but a workspace
 * path become the file they point at; every other line stays text.
 */
export function OperatorMessage({
  agentId,
  content,
}: {
  agentId: string;
  content: string;
}) {
  const lines = content.split("\n");
  const blocks: { text: string[]; files: string[] } = { text: [], files: [] };
  for (const line of lines) {
    const candidate = line.trim();
    const isBarePath =
      candidate.length > 0 &&
      !/\s/.test(candidate) &&
      candidate.includes("/") &&
      isWorkspacePath(candidate);
    if (isBarePath) blocks.files.push(candidate);
    else blocks.text.push(line);
  }

  const text = blocks.text.join("\n").trim();
  return (
    <div className="message-body">
      {blocks.files.length > 0 && (
        <div className="message-files">
          {blocks.files.map((path) =>
            looksLikeImage(path) ? (
              <WorkspaceImage key={path} agentId={agentId} path={path} alt={path} />
            ) : (
              <WorkspaceDownload key={path} agentId={agentId} path={path} label={path} />
            ),
          )}
        </div>
      )}
      {text.length > 0 && <span>{text}</span>}
    </div>
  );
}
