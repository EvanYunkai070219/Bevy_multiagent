/** Defines the security and truncation contract for persisted run events. */
import { describe, expect, it } from "vitest";
import {
  REDACTED,
  createRedactor,
  looksSecret,
  stripInternalAuthority,
  truncateHead,
  truncateHeadTail,
} from "../src/redact.js";

describe("secret key detection", () => {
  it("masks secret-like keys", () => {
    expect(looksSecret("api_key")).toBe(true);
    expect(looksSecret("apiKey")).toBe(true);
    expect(looksSecret("access_token")).toBe(true);
    expect(looksSecret("Authorization")).toBe(true);
    expect(looksSecret("password")).toBe(true);
  });

  it("keeps token counters visible", () => {
    expect(looksSecret("tokens_used")).toBe(false);
    expect(looksSecret("total_tokens")).toBe(false);
    expect(looksSecret("input_tokens")).toBe(false);
    expect(looksSecret("command")).toBe(false);
  });
});

describe("head truncation", () => {
  it("leaves short strings untouched", () => {
    expect(truncateHead("hello", 10)).toBe("hello");
  });

  it("marks the original length when truncating", () => {
    const result = truncateHead("abcdefghij", 4);
    expect(result.startsWith("abcd")).toBe(true);
    expect(result).toContain("original_chars=10");
  });
});

describe("head-and-tail truncation", () => {
  it("leaves short strings untouched", () => {
    expect(truncateHeadTail("hello", 10)).toBe("hello");
  });

  it("keeps both the beginning and the end", () => {
    const value = "START" + "x".repeat(100) + "FAILURE-AT-THE-END";
    const result = truncateHeadTail(value, 10);
    expect(result.startsWith("START")).toBe(true);
    expect(result.endsWith("AT-THE-END")).toBe(true);
    expect(result).toContain("original_chars=" + value.length);
  });

  it("preserves the failing summary of a long test log", () => {
    const log =
      "PASS a.test.ts\n".repeat(2000) +
      "FAIL src/auth.test.ts\nExpected: 401\nReceived: 200\n";
    const result = truncateHeadTail(log, 200);
    expect(result).toContain("Expected: 401");
    expect(result).toContain("Received: 200");
  });

  it("does not let source text spoof a truncation marker", () => {
    const value =
      "START ... (truncated, original_chars=1) ... " +
      "x".repeat(1000) +
      "TRUE-TAIL";
    const result = truncateHeadTail(value, 20);
    expect(result.length).toBeLessThan(value.length);
    expect(result).toContain("original_chars=" + value.length);
    expect(result).toContain("TRUE-TAIL");
  });
});

describe("redactor", () => {
  it("removes the literal secret anywhere in a string", () => {
    const redact = createRedactor(["super-secret-ark-key"]);
    const result = redact({
      command: "echo super-secret-ark-key && ls",
    }) as Record<string, string>;
    expect(result.command).not.toContain("super-secret-ark-key");
    expect(result.command).toContain(REDACTED);
  });

  it("masks secret-named keys and walks nested structures", () => {
    const redact = createRedactor([]);
    const result = redact({
      outer: { api_key: "abc123", tokens_used: 42 },
      list: [{ password: "hunter2" }],
    }) as Record<string, Record<string, unknown>>;
    expect(result.outer.api_key).toBe(REDACTED);
    expect(result.outer.tokens_used).toBe(42);
    expect((result.list as unknown as Record<string, unknown>[])[0]?.password)
      .toBe(REDACTED);
  });

  it("removes an explicitly configured secret even when it is short", () => {
    const redact = createRedactor(["abc"]);
    const result = redact({ text: "abcdef" }) as Record<string, string>;
    expect(result.text).toBe("***def");
  });

  it("leaves truncation to the event kind-specific pipeline", () => {
    const redact = createRedactor([]);
    const long = "x".repeat(9000);
    const result = redact({ output: long }) as Record<string, string>;
    expect(result.output).toBe(long);
  });

  it("leaves non-string scalars untouched", () => {
    const redact = createRedactor(["super-secret-ark-key"]);
    const result = redact({ exitCode: 0, ok: true, missing: null }) as Record<
      string,
      unknown
    >;
    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.missing).toBeNull();
  });
});

describe("public authority redaction", () => {
  it("recursively removes internal evolution authority while preserving public counters", () => {
    const value = stripInternalAuthority({
      nodes: [{
        id: "public-node",
        nested: {
          ownerToken: "owner-private",
          authorityPath: "/private/authority",
          hiddenGateName: "held-out-secret",
          rawPrompt: "do not expose",
          actualInputTokens: 42,
        },
      }],
      evolutionOutbox: [{ recordHash: "private-hash" }],
    });
    expect(value).toEqual({
      nodes: [{ id: "public-node", nested: { actualInputTokens: 42 } }],
    });
  });
});
