import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareWorkerDependencyCache,
  workerDependencyEnvironment,
} from "../src/runtime/dependency-cache.js";

describe("worker dependency cache", () => {
  it("creates cache-backed python and pip shims", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-dependency-cache-"));
    const cache = path.join(root, "cache");
    try {
      await prepareWorkerDependencyCache({ workerDependencyCacheDir: cache });

      await access(path.join(cache, "pip"));
      await access(path.join(cache, "uv"));
      await access(path.join(cache, "npm"));
      await access(path.join(cache, "python/bin/python3"));
      await access(path.join(cache, "python/bin/pip"));
      await access(path.join(cache, "python/user"));
      await access(path.join(cache, "python/shell-env.sh"));

      const python = await readFile(path.join(cache, "python/bin/python3"), "utf8");
      const pip = await readFile(path.join(cache, "python/bin/pip"), "utf8");
      const shellEnv = await readFile(path.join(cache, "python/shell-env.sh"), "utf8");
      expect(python).toContain("https://bootstrap.pypa.io/get-pip.py");
      expect(python).toContain("LAUNCHPAD_PIP_BOOTSTRAP");
      expect(python).toContain("--break-system-packages");
      expect(pip).toContain("python3 -m pip");
      expect(shellEnv).toContain("python3()");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("puts the shared python shims before the inherited PATH", () => {
    const env = workerDependencyEnvironment(
      { workerDependencyCacheDir: "/host/cache" },
      {
        runtimeCacheDir: "/runtime/cache",
        pathValue: "/usr/bin",
        pathDelimiter: ":",
      },
    );

    expect(env.LAUNCHPAD_DEPENDENCY_CACHE).toBe("/runtime/cache");
    expect(env.PYTHONUSERBASE).toBe("/runtime/cache/python/user");
    expect(env.LAUNCHPAD_PIP_BOOTSTRAP).toBe("/runtime/cache/python/get-pip.py");
    expect(env.BASH_ENV).toBe("/runtime/cache/python/shell-env.sh");
    expect(env.PATH).toBe(
      "/runtime/cache/python/bin:/runtime/cache/python/user/bin:/usr/bin",
    );
  });
});
