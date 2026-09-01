import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Git creates and verifies real repositories in several suites. Bounding
    // file-level concurrency avoids disk/process contention that otherwise
    // turns their safety timeouts into teardown races on developer machines.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
