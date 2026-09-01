/**
 * Reading and writing files inside one Agent's workspace, and nowhere else.
 *
 * The paths that reach here come from a browser and from model output, so the
 * only safe posture is to resolve everything against the workspace root and
 * refuse anything that lands outside it — including by way of a symbolic link,
 * which `resolve` alone will happily walk through.
 */
import { realpathSync } from "node:fs";
import path from "node:path";

/** Big enough for a screenshot or a small PDF, small enough to hold in memory. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Where an upload lands, relative to the workspace root. */
export const UPLOAD_DIR = "uploads";

export class WorkspaceFileError extends Error {
  constructor(
    readonly code: "path_escapes_workspace" | "invalid_name" | "too_large" | "not_a_file",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceFileError";
  }
}

/**
 * Resolve a caller-supplied relative path inside `root`.
 *
 * `mustExist` decides which path is checked against the real filesystem: an
 * existing file is resolved itself, while a file about to be created can only
 * have its parent directory resolved — `realpath` on a path that does not exist
 * throws.
 */
export function resolveInsideWorkspace(
  root: string,
  relative: string,
  options: { mustExist: boolean; realpath?: (target: string) => string } = {
    mustExist: true,
  },
): string {
  if (typeof relative !== "string" || relative.trim().length === 0) {
    throw new WorkspaceFileError("invalid_name", "A path is required");
  }
  if (relative.includes("\0")) {
    throw new WorkspaceFileError("invalid_name", "A path cannot contain a null byte");
  }

  const realpathOf = options.realpath ?? realpathSync;
  const base = path.resolve(root);
  // The Agent talks in container paths. `/workspace` is where its own workspace
  // is mounted, so `/workspace/report.txt` and `report.txt` are the same file;
  // any other absolute path is read as workspace-relative rather than followed.
  const cleaned = relative.replace(/^\/+(workspace\/)?/, "");
  const target = path.resolve(base, cleaned);

  const withinLexically = (candidate: string): boolean => {
    const rel = path.relative(base, candidate);
    return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  };

  if (!withinLexically(target)) {
    throw new WorkspaceFileError(
      "path_escapes_workspace",
      "Path escapes the workspace: " + relative,
    );
  }

  // `..` can be lexically clean and still leave the workspace through a link.
  let real: string;
  if (options.mustExist) {
    try {
      real = realpathOf(target);
    } catch {
      throw new WorkspaceFileError("not_a_file", "No such file in the workspace: " + relative);
    }
  } else {
    // The target does not exist yet, and neither may its parents. Resolve the
    // nearest ancestor that does: that is the deepest point a link could have
    // redirected, and everything below it is about to be created by us.
    let ancestor = path.dirname(target);
    let resolved: string | null = null;
    while (resolved === null) {
      try {
        resolved = realpathOf(ancestor);
      } catch {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          throw new WorkspaceFileError("not_a_file", "No such directory: " + relative);
        }
        ancestor = parent;
      }
    }
    real = resolved;
  }
  const realBase = realpathOf(base);
  const relToReal = path.relative(realBase, real);
  const insideReal =
    real === realBase || (!relToReal.startsWith("..") && !path.isAbsolute(relToReal));
  if (!insideReal) {
    throw new WorkspaceFileError(
      "path_escapes_workspace",
      "Path escapes the workspace through a symbolic link: " + relative,
    );
  }

  if (options.mustExist) return real;
  // Reattach whatever of the requested path lay below the ancestor we resolved.
  const tail = path.relative(realpathOf(base), target);
  return path.join(realpathOf(base), tail);
}

/**
 * A filename an upload can safely become.
 *
 * Only the basename survives, so a name like `../../etc/passwd` becomes
 * `passwd` rather than an error the caller has to handle.
 */
export function sanitiseUploadName(name: string): string {
  const base = path.basename(String(name ?? "").trim());
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  const bounded = cleaned.slice(0, 120);
  if (bounded.length === 0 || bounded === "." || bounded === "..") {
    throw new WorkspaceFileError("invalid_name", "Upload needs a usable filename");
  }
  return bounded;
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".json": "application/json",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".html": "text/plain",
  ".htm": "text/plain",
  ".xml": "text/plain",
  ".yaml": "text/plain",
  ".yml": "text/plain",
};

/**
 * What to label the bytes as.
 *
 * Anything not recognised is served as a download rather than guessed at, and
 * HTML is deliberately labelled `text/plain`: a workspace file is agent output,
 * and serving it as a document would let it run script on this origin.
 */
export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function isRenderableImage(filePath: string): boolean {
  const type = contentTypeFor(filePath);
  // SVG renders as a document and can carry script, so it is not previewed.
  return type.startsWith("image/") && type !== "image/svg+xml";
}

/** Decode an upload body, refusing anything past the cap before it is written. */
export function decodeUpload(contentBase64: string): Buffer {
  if (typeof contentBase64 !== "string" || contentBase64.length === 0) {
    throw new WorkspaceFileError("invalid_name", "Upload content is required");
  }
  // Base64 inflates by 4/3, so the encoded cap is checked first and the decoded
  // size checked again: a malformed body can decode to less than it claims.
  if (contentBase64.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 16) {
    throw new WorkspaceFileError("too_large", "Upload exceeds the size limit");
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.byteLength === 0) {
    throw new WorkspaceFileError("invalid_name", "Upload decoded to no content");
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new WorkspaceFileError("too_large", "Upload exceeds the size limit");
  }
  return bytes;
}
