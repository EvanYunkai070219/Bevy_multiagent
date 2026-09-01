/** Redacts secret material and bounds strings before event data is persisted. */
export const REDACTED = "***";
export const MAX_STRING_CHARS = 8_192;
export const HEAD_TAIL_CHARS = 4_096;

const SECRET_TOKENS = new Set([
  "token",
  "password",
  "passwd",
  "pwd",
  "secret",
  "apikey",
  "authorization",
  "authorisation",
  "cookie",
  "credential",
]);

function isHeadTruncated(value: string, limit: number): boolean {
  const suffix = value.slice(limit);
  const match = /^\.\.\. \(truncated, original_chars=(\d+)\)$/.exec(suffix);
  return match !== null && Number(match[1]) > limit;
}

function isHeadTailTruncated(value: string, half: number): boolean {
  if (value.length < half * 2) return false;
  const middle = value.slice(half, value.length - half);
  const match =
    /^\n\.\.\. \(truncated, original_chars=(\d+)\) \.\.\.\n$/.exec(middle);
  return match !== null && Number(match[1]) > half * 2;
}

export function looksSecret(key: string): boolean {
  const tokens = key
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.includes("tokens")) return false;
  if (tokens.some((token) => SECRET_TOKENS.has(token))) return true;
  return tokens.includes("api") && tokens.includes("key");
}

export function truncateHead(value: string, limit = MAX_STRING_CHARS): string {
  if (value.length <= limit || isHeadTruncated(value, limit)) return value;
  return (
    value.slice(0, limit) + "... (truncated, original_chars=" + value.length + ")"
  );
}

/**
 * Keep both ends of a long payload.
 *
 * Command output puts the decisive detail at the end: a test run is thousands
 * of passing lines followed by the failure summary. Head-only truncation would
 * discard exactly the part a failure analyser needs.
 */
export function truncateHeadTail(
  value: string,
  half = HEAD_TAIL_CHARS,
): string {
  if (value.length <= half * 2 || isHeadTailTruncated(value, half)) return value;
  return (
    value.slice(0, half) +
    "\n... (truncated, original_chars=" +
    value.length +
    ") ...\n" +
    value.slice(value.length - half)
  );
}

/**
 * Build a deep redactor.
 *
 * Two layers of protection: values under secret-looking keys are replaced
 * wholesale, and the literal secrets are stripped from every string so a
 * credential echoed into command output cannot reach the event log.
 */
export function createRedactor(secrets: string[]): (value: unknown) => unknown {
  const literals = secrets.filter((secret) => secret.trim().length > 0);

  const scrub = (value: string): string => {
    let output = value;
    for (const literal of literals) {
      output = output.split(literal).join(REDACTED);
    }
    return output;
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return scrub(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        output[key] = looksSecret(key) ? REDACTED : walk(item);
      }
      return output;
    }
    return value;
  };

  return walk;
}

/** Remove middleware-only authority fields from any public response envelope. */
export function stripInternalAuthority(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInternalAuthority);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isInternalAuthorityKey(key))
      .map(([key, item]) => [key, stripInternalAuthority(item)]),
  );
}

function isInternalAuthorityKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    key === "evolutionOutbox" ||
    normalized === "recordhash" ||
    normalized === "recordhashes" ||
    normalized.includes("credential") ||
    normalized.includes("secret") ||
    normalized.includes("owner") ||
    normalized.endsWith("token") ||
    normalized.endsWith("path") ||
    normalized.endsWith("location") ||
    normalized.startsWith("hidden") && normalized.includes("gate") ||
    normalized.startsWith("raw") ||
    normalized === "authoritypath" ||
    normalized === "authorityroot" ||
    normalized === "authorityassetpath" ||
    key === "terminalPublicationIntent" ||
    key === "canonicalAuthority" ||
    key === "baselineTransition" ||
    key === "gitCommonDev" ||
    key === "gitCommonIno" ||
    key === "repositoryRealPath" ||
    key === "gitCommonRealPath" ||
    key === "verificationCommand" ||
    key === "verifierCommand" ||
    key === "verifierCommands" ||
    key === "authorityCommand" ||
    key === "hiddenTestNames" ||
    key === "hiddenGateNames" ||
    key === "credentials" ||
    key === "credential" ||
    key === "modelToken" ||
    key === "coordinationToken" ||
    key === "canonicalWorkspacePath" ||
    key === "workspacePath" ||
    key === "latchListeners" ||
    key === "terminalLatch"
  );
}
