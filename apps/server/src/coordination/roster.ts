/**
 * Who can be addressed within one leader run.
 *
 * Registered for the whole plan before any worker starts, because a DAG's
 * downstream members are legitimate recipients before they exist as processes —
 * a message sent to one now should ride in with its first turn, not bounce.
 *
 * Identity is the immutable `workerRunId`. The model-visible name carries the
 * iteration so a replanned subtask reusing an id is still distinguishable.
 */
export interface RosterMember {
  workerRunId: string;
  subtaskId: string;
  displayName: string;
  state: "not_started" | "active" | "idle" | "closed";
}

export class Roster {
  private readonly members = new Map<string, RosterMember>();

  constructor(readonly parentRunId: string) {}

  register(
    workerRunId: string,
    subtaskId: string,
    iteration: number,
    displayName?: string,
  ): RosterMember {
    const member: RosterMember = {
      workerRunId,
      subtaskId,
      displayName: displayName?.trim() || "it" + iteration + "/" + subtaskId,
      state: "not_started",
    };
    this.members.set(workerRunId, member);
    return member;
  }

  setState(workerRunId: string, state: RosterMember["state"]): void {
    const member = this.members.get(workerRunId);
    if (member) member.state = state;
  }

  get(workerRunId: string): RosterMember | undefined {
    return this.members.get(workerRunId);
  }

  /** Accepts either the immutable id or the model-visible name. */
  resolve(target: string): RosterMember | undefined {
    const direct = this.members.get(target);
    if (direct) return direct;
    return [...this.members.values()].find(
      (member) => member.displayName === target || member.subtaskId === target,
    );
  }

  list(): RosterMember[] {
    return [...this.members.values()];
  }
}
