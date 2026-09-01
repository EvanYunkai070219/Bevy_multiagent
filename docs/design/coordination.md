# Coordination — several agents inside one run

## What was missing

The baseline runs one agent per container and stops there. Starting a second
container is easy; the hard part is everything that turns two processes into a
team, and none of it existed:

- Nothing decided what could run at the same time and what had to wait.
- An agent had no way to address another agent, and no way to prove which agent
  a message came from.
- A message the sender believed was queued disappeared if the process died.
- Nothing tracked what the team as a whole was spending.

## What we built

A leader plans, the middleware validates the plan before any worker starts, and
the scheduler runs each dependency layer as a parallel wave.

| Component | File | Responsibility |
|---|---|---|
| Scheduler | `orchestration/scheduler.ts` | Kahn layering over the subtask graph; independent work runs as one wave |
| Roster | `coordination/roster.ts` | Who is addressable, registered for the whole plan before anyone starts |
| Ingress | `coordination/ingress.ts` | The only way a worker's MCP subprocess reaches the team |
| HTTP surface | `coordination/server.ts` | Token-authenticated endpoint the subprocess talks to |
| Delivery | `coordination/team-runtime.ts` | Applies `quiet` / `talk` / `wakeup` semantics, budgets, downgrades |
| Journal | `coordination/team-journal.ts` | Append-only record; delivery state is derived from it |
| Budget | `coordination/token-ledger.ts` | One total across the leader and every worker |
| Loop detector | `coordination/anomaly-detector.ts` | Watches the message stream for exchanges that stopped making progress |
| Runtime seam | `runtime/agent-runtime.ts` | Hides whether a worker is a one-shot turn or an addressable session |
| Trajectory monitor | `orchestration/workers/trajectory.ts` | Ends a worker that is no longer making progress |

Four decisions in there are load-bearing and worth stating plainly.

**Identity comes from the token, not the message.** A worker hands a request to
the ingress, and the ingress decides who the sender is. An agent that could write
its own name into a `from` field could impersonate a sibling, and every later
judgement built on *who said this* — including the ones a human makes reading the
transcript — would be worthless.

**The roster covers the whole plan, not the running processes.** A downstream
node in a dependency graph is a legitimate recipient before it exists as a
process. Registering it up front means a message sent now rides in with that
worker's first turn instead of bouncing.

**Three delivery modes, because delivery costs money.** `quiet` waits for the
recipient's next turn and costs nothing extra. `talk` joins an active turn, or
queues if the recipient is idle. `wakeup` starts a turn immediately and spends
from the team's follow-up budget. Without the distinction, agents spend the run's
budget telling each other "got it".

**The journal is written before delivery, not after.** The failure this prevents
is narrow and unpleasant: a sender is told its message is queued, the process
dies, and the message no longer exists. On restart, what still needs delivering
is recomputed from disk rather than held in memory.

## The boundary

**Who owns the decision.** The leader owns how the task is split and who gets
what. The middleware owns identity, delivery semantics, the durable record, and
the budget. An agent owns what it says — but not who it is.

**What crosses.** Bounded message text plus paths into the shared workspace.
Large content stays in the workspace and the message carries the pointer. A token
scopes both who you are and who you may address, and buys nothing outside its own
leader run.

**What happens on failure.**

| Situation | Behaviour | Evidence left behind |
|---|---|---|
| Recipient has not started | Message queues and rides in with its first turn | Journal entry, no receipt yet |
| Follow-up budget spent | Wakeup refused, not dropped | Receipt with reason `FOLLOW_UP_LIMIT` |
| Two agents waking each other in a loop | Pair keeps talking, stops being able to wake each other | Receipt with reason `downgraded_to_quiet` |
| Quiet note that never found a turn | Recorded as undelivered | Receipt with reason `NO_FURTHER_TURN` |
| Impersonation, out-of-run recipient, path escape, dispatch without the leader token | Refused | Rejection at the ingress |
| Process dies mid-delivery | Pending set rebuilt from the journal | The journal itself |
| Worker stops making progress | Runtime cancelled, attempt ended | Fault record plus the evidence behind it |

The loop detector deliberately downgrades and reports rather than intervening.
An automatic intervention is itself a model turn and can deepen the loop it was
meant to break.

The trajectory monitor stops on any of: no evidence of progress, a repeated
action signature, oscillation between states, drift outside the declared scope, a
protected-path violation, consumer incompatibility, or a runtime step limit.

## Tests

Behaviour, not rendering: `coordination-delivery.test.ts` (delivery modes,
downgrade, redelivery on attach, journal-derived recovery),
`coordination-ingress.test.ts` (sender from token, out-of-run recipient, path
escape, size bound, leader-only dispatch), `coordination-anomaly.test.ts`,
`coordination-budget.test.ts`, `orchestration-scheduler.test.ts`,
`orchestration-runtime-lifetime.test.ts`.

## Known limits

**Container egress is not allowlisted.** Containers run on a bridge network.
Model traffic is mediated (see [trace.md](trace.md)), but arbitrary outbound
connections are not restricted.

**Bounded self-healing is not on the production path.** The repair tournament,
its verification gates, and the cross-run memory of failed repairs are
implemented and pass an end-to-end deterministic fixture, but enabling them for
real project work is blocked on two things we found during integration: the
planner is never given the contract catalogue it is expected to declare against,
and one class of trusted history causes the pruning index to quarantine itself.
Until both are fixed, the feature stays behind a disabled switch.
