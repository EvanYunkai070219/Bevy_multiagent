export interface RateLimitDecision {
  retry: boolean;
  delayMs: number;
  reason:
    | "safe_retry"
    | "missing_retry_after"
    | "invalid_retry_after"
    | "usage_present"
    | "deadline_insufficient"
    | "retry_exhausted";
}

const MAX_RETRY_AFTER_MS = 30_000;

export function rateLimitDecision(input: {
  status: number;
  retryAfter: string | null;
  responseBody: string;
  attempt: 1 | 2;
  remainingMs: number;
}): RateLimitDecision {
  if (input.attempt !== 1 || input.status !== 429) {
    return deny("retry_exhausted");
  }
  if (hasUsageEvidence(input.responseBody)) {
    return deny("usage_present");
  }
  if (input.retryAfter === null || input.retryAfter.trim() === "") {
    return deny("missing_retry_after");
  }
  const delayMs = parseRetryAfter(input.retryAfter);
  if (delayMs === null) {
    return deny("invalid_retry_after");
  }
  if (delayMs > input.remainingMs) {
    return deny("deadline_insufficient");
  }
  return { retry: true, delayMs, reason: "safe_retry" };
}

function deny(reason: RateLimitDecision["reason"]): RateLimitDecision {
  return { retry: false, delayMs: 0, reason };
}

function hasUsageEvidence(body: string): boolean {
  const parsed = parseJsonObject(body);
  if (parsed !== null && parsed.usage !== null && typeof parsed.usage === "object") {
    return true;
  }
  return /"usage"\s*:\s*\{/.test(body);
}

function parseRetryAfter(header: string): number | null {
  const trimmed = header.trim();
  if (trimmed === "") return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    const delayMs = seconds * 1000;
    if (delayMs > MAX_RETRY_AFTER_MS) return null;
    return delayMs;
  }
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  const delayMs = Math.max(0, at - Date.now());
  if (delayMs > MAX_RETRY_AFTER_MS) return null;
  return delayMs;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
