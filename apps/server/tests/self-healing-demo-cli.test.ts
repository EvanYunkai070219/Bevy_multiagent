import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("self-healing demo CLI", () => {
  it("exits non-zero naturally after printing false acceptance invariants", async () => {
    const executable = path.resolve(process.cwd(), "../../node_modules/.bin/tsx");
    const script = path.resolve(process.cwd(), "scripts/self-healing-demo.ts");
    let failure: unknown;
    try {
      await execFileAsync(executable, [script], {
        env: {
          ...process.env,
          LAUNCHPAD_SELF_HEALING_DEMO_SCENARIO: "evaluator_unavailable",
        },
        timeout: 60_000,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 1,
      stdout: expect.stringContaining("outcome=unknown"),
      stderr: expect.stringContaining("acceptance failed: outcome, baseline"),
    });
  }, 70_000);
});
