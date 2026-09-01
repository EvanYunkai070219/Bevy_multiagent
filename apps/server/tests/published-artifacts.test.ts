import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../src/errors.js";
import {
  listPublishedArtifacts,
  readPublishedArtifact,
  sessionRootRunId,
} from "../src/published-artifacts.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const FIRST = "22222222-2222-4222-8222-222222222222";
const SECOND = "33333333-3333-4333-8333-333333333333";

let dataDirectory = "";

function publish(
  id: string,
  metadata: Record<string, unknown>,
  text: string,
  session = SESSION,
  layout: "current" | "legacy" = "current",
): void {
  const dir = layout === "current"
    ? path.join(dataDirectory, "runs", "shared", session, "artifacts")
    : path.join(dataDirectory, "shared", session, "artifacts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, id + ".json"), JSON.stringify({ id, ...metadata }), "utf8");
  writeFileSync(path.join(dir, id + ".txt"), text, "utf8");
}

beforeEach(() => {
  dataDirectory = mkdtempSync(path.join(tmpdir(), "published-artifacts-"));
});

afterEach(() => {
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("listPublishedArtifacts", () => {
  it("has nothing to list for a session that published nothing", () => {
    expect(listPublishedArtifacts(dataDirectory, SESSION)).toEqual([]);
  });

  it("reports what a worker published, with the size of the content", () => {
    publish(
      FIRST,
      {
        type: "report",
        description: "Findings",
        sourcePath: "/workspace/report.md",
        ownerWorkerId: "worker-1",
        ownerWorkerRunId: "run-1",
        createdAt: "2026-08-30T10:00:00.000Z",
      },
      "hello",
    );
    expect(listPublishedArtifacts(dataDirectory, SESSION)).toEqual([
      {
        id: FIRST,
        type: "report",
        description: "Findings",
        sourcePath: "/workspace/report.md",
        ownerWorkerId: "worker-1",
        ownerWorkerRunId: "run-1",
        createdAt: "2026-08-30T10:00:00.000Z",
        bytes: 5,
      },
    ]);
  });

  it("orders artifacts by when they were published", () => {
    publish(SECOND, { createdAt: "2026-08-30T11:00:00.000Z" }, "b");
    publish(FIRST, { createdAt: "2026-08-30T10:00:00.000Z" }, "a");
    expect(listPublishedArtifacts(dataDirectory, SESSION).map((item) => item.id)).toEqual([
      FIRST,
      SECOND,
    ]);
  });

  it("keeps one session's artifacts out of another's", () => {
    publish(FIRST, { createdAt: "2026-08-30T10:00:00.000Z" }, "a");
    publish(SECOND, { createdAt: "2026-08-30T10:00:00.000Z" }, "b", SECOND);
    expect(listPublishedArtifacts(dataDirectory, SESSION).map((item) => item.id)).toEqual([
      FIRST,
    ]);
  });

  it("skips an artifact whose metadata is unreadable rather than failing the list", () => {
    publish(FIRST, { createdAt: "2026-08-30T10:00:00.000Z" }, "a");
    writeFileSync(
      path.join(dataDirectory, "runs", "shared", SESSION, "artifacts", SECOND + ".json"),
      "{ not json",
      "utf8",
    );
    expect(listPublishedArtifacts(dataDirectory, SESSION).map((item) => item.id)).toEqual([
      FIRST,
    ]);
  });

  it("still lists artifacts from the legacy shared directory", () => {
    publish(FIRST, { createdAt: "2026-08-30T10:00:00.000Z" }, "legacy", SESSION, "legacy");

    expect(listPublishedArtifacts(dataDirectory, SESSION).map((item) => item.id)).toEqual([
      FIRST,
    ]);
  });
});

describe("readPublishedArtifact", () => {
  it("returns the published text with its metadata", () => {
    publish(FIRST, { type: "report", createdAt: "2026-08-30T10:00:00.000Z" }, "the body");
    const result = readPublishedArtifact(dataDirectory, SESSION, FIRST);
    expect(result.text).toBe("the body");
    expect(result.artifact.type).toBe("report");
  });

  it("refuses an id that is not an artifact id, before touching the disk", () => {
    expect(() => readPublishedArtifact(dataDirectory, SESSION, "../../launchpad.json")).toThrow(
      HttpError,
    );
  });

  it("refuses a session id that is not a run id", () => {
    expect(() => listPublishedArtifacts(dataDirectory, "../..")).toThrow(HttpError);
  });

  it("reports a missing artifact as not found", () => {
    try {
      readPublishedArtifact(dataDirectory, SESSION, FIRST);
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).statusCode).toBe(404);
    }
  });

  it("reports metadata without content as not found rather than as empty content", () => {
    const dir = path.join(dataDirectory, "runs", "shared", SESSION, "artifacts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, FIRST + ".json"), JSON.stringify({ id: FIRST }), "utf8");
    expect(() => readPublishedArtifact(dataDirectory, SESSION, FIRST)).toThrow(HttpError);
  });

  it("still reads artifacts from the legacy shared directory", () => {
    publish(FIRST, { type: "report", createdAt: "2026-08-30T10:00:00.000Z" }, "old", SESSION, "legacy");

    expect(readPublishedArtifact(dataDirectory, SESSION, FIRST).text).toBe("old");
  });
});

describe("sessionRootRunId", () => {
  const runs = [
    { id: "leader", parentRunId: null },
    { id: "worker", parentRunId: "leader" },
    { id: "nested", parentRunId: "worker" },
  ];

  it("is the run itself when nothing dispatched it", () => {
    expect(sessionRootRunId(runs, "leader")).toBe("leader");
  });

  it("is the leader's run for a worker it dispatched", () => {
    expect(sessionRootRunId(runs, "worker")).toBe("leader");
  });

  it("climbs the whole chain, not one step", () => {
    expect(sessionRootRunId(runs, "nested")).toBe("leader");
  });

  it("keeps the named parent when that run is no longer stored", () => {
    expect(sessionRootRunId([{ id: "orphan", parentRunId: "gone" }], "orphan")).toBe("gone");
  });

  it("terminates on a parent cycle instead of hanging", () => {
    const cycle = [
      { id: "a", parentRunId: "b" },
      { id: "b", parentRunId: "a" },
    ];
    expect(["a", "b"]).toContain(sessionRootRunId(cycle, "a"));
  });

  it("is the run itself when the run is not stored at all", () => {
    expect(sessionRootRunId([], "unknown")).toBe("unknown");
  });
});
