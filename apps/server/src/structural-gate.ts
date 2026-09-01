import { GitClient } from "./git-client.js";

export interface StructuralGateResult {
  level: "structural";
  passed: boolean;
  evidence: {
    actualHead: string;
    expectedHead: string;
    clean: boolean;
    whitespaceErrors: string[];
  };
}

/** Milestone 1 structural evidence only; this does not establish semantic correctness. */
export class StructuralGate {
  constructor(private readonly git: GitClient) {}

  async verify(workspacePath: string, expectedHead: string): Promise<StructuralGateResult> {
    const actualHead = await this.git.head(workspacePath);
    const clean = await this.git.isClean(workspacePath);
    const whitespaceErrors = await this.git.diffCheck(
      workspacePath,
      expectedHead + "^",
      expectedHead,
    );
    return {
      level: "structural",
      passed: actualHead === expectedHead && clean && whitespaceErrors.length === 0,
      evidence: { actualHead, expectedHead, clean, whitespaceErrors },
    };
  }
}
