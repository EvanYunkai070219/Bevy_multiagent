import { describe, expect, it } from "vitest";
import { runProductionEvolutionLifecycleRegression } from "../scripts/self-healing-demo-fixture.js";

describe("Milestone 3 production fixture lifecycle", () => {
  it("repeatedly closes the full ownership graph idempotently", async () => {
    await expect(runProductionEvolutionLifecycleRegression(3)).resolves.toEqual({
      cycles: 3,
      timers: 0,
      watchers: 0,
      pendingOutbox: 0,
      openServers: 0,
      serverHandles: 0,
      childProcesses: 0,
      reconciledWorkloads: 3,
      doubleCloseSafe: true,
    });
  }, 120_000);
});
