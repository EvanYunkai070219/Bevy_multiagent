export interface TrajectoryGitClient {
  trajectoryFingerprint(cwd: string, timeoutMs: number): Promise<string>;
}

export class RepositoryTrajectoryObserver {
  private lastValid: string | null = null;
  private readonly valid: string[] = [];

  constructor(
    private readonly git: TrajectoryGitClient,
    private readonly options: { cwd: string; timeoutMs?: number } = { cwd: "" },
  ) {}

  fingerprints(): string[] {
    return [...this.valid];
  }

  oscillating(): boolean {
    const seen = this.valid;
    if (seen.length < 3) return false;
    const a = seen[seen.length - 3];
    const b = seen[seen.length - 2];
    const c = seen[seen.length - 1];
    return a !== undefined && b !== undefined && c !== undefined && a === c && a !== b;
  }

  async capture(): Promise<string | null> {
    try {
      const value = await this.git.trajectoryFingerprint(
        this.options.cwd,
        this.options.timeoutMs ?? 5_000,
      );
      if (!value) return this.lastValid;
      this.lastValid = value;
      if (this.valid.at(-1) !== value) this.valid.push(value);
      return value;
    } catch {
      return this.lastValid;
    }
  }
}
