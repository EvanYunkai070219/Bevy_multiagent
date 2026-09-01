import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateServerDataLayout, serverDataPaths } from "../src/storage-layout.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "launchpad-storage-layout-"));
  directories.push(directory);
  return directory;
}

describe("server data layout", () => {
  it("groups run and runtime data under clear top-level directories", () => {
    const paths = serverDataPaths("/tmp/launchpad-data");

    expect(paths.database).toBe("/tmp/launchpad-data/db/launchpad.json");
    expect(paths.eventLog).toBe("/tmp/launchpad-data/runs/events");
    expect(paths.sharedRuns).toBe("/tmp/launchpad-data/runs/shared");
    expect(paths.teamRuns).toBe("/tmp/launchpad-data/runs/team");
    expect(paths.toolState).toBe("/tmp/launchpad-data/runs/tool-state");
    expect(paths.containerAuthority).toBe("/tmp/launchpad-data/runtime/container-authority");
  });

  it("moves legacy data directories when the new location is empty", async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, "launchpad.json"), "{}\n", "utf8");
    await mkdir(path.join(root, "event", "run-1"), { recursive: true });
    await mkdir(path.join(root, "shared", "run-1"), { recursive: true });
    await mkdir(path.join(root, "team", "run-1"), { recursive: true });
    await mkdir(path.join(root, "tool-state"), { recursive: true });
    await mkdir(path.join(root, "container-authority"), { recursive: true });

    await migrateServerDataLayout(root);

    expect(await readFile(path.join(root, "db", "launchpad.json"), "utf8")).toBe("{}\n");
    expect(await readdir(path.join(root, "runs", "events"))).toEqual(["run-1"]);
    expect(await readdir(path.join(root, "runs", "shared"))).toEqual(["run-1"]);
    expect(await readdir(path.join(root, "runs", "team"))).toEqual(["run-1"]);
    expect(await readdir(path.join(root, "runs", "tool-state"))).toEqual([]);
    expect(await readdir(path.join(root, "runtime", "container-authority"))).toEqual([]);
  });

  it("leaves legacy data in place when a new target already exists", async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, "event", "legacy"), { recursive: true });
    await mkdir(path.join(root, "runs", "events", "current"), { recursive: true });

    await migrateServerDataLayout(root);

    expect(await readdir(path.join(root, "event"))).toEqual(["legacy"]);
    expect(await readdir(path.join(root, "runs", "events"))).toEqual(["current"]);
  });
});
