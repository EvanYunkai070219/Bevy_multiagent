# Orchestration map

47 modules, about 22k lines — the largest cluster in the server. Nine sit at the
root; the rest are grouped into five directories by when they run.

```
orchestration/
├── orchestrator.ts          the leader loop, and every prompt
├── scheduler.ts             dependency layering into parallel waves
├── live-dag-admission.ts    validates a plan graph before any worker starts
├── run-control.ts           cancellation and terminal state
├── policies.ts              execution policy defaults, prompt versions
├── skill-router.ts          ranks and installs hub skills before turn one
├── skill-creation.ts        recognises a skill-creation request
├── runtime-tool-schemas.ts  tool schemas derived from the injected MCP server
├── project-contribution-intent.ts
│
├── leader/         7   the leader's four model calls, and their client
├── workers/        6   watching, naming and validating workers
├── healing/       10   ⚠ off by default
├── verification/   5   ⚠ off by default
└── evolution/     10   ⚠ off by default
```

The three marked directories — 25 of the 47 modules — sit behind a switch that
is disabled by default and are not on the production path today. If you are
reading to understand how a normal multi-agent run works, you can skip all
three. Their status is in
[`docs/design/coordination.md`](../../../../docs/design/coordination.md#known-limits).

## Root — the loop

| File | Lines | Responsibility |
|---|---:|---|
| `orchestrator.ts` | 6493 | Plan, admit, dispatch, evaluate, synthesise. Both the planned-wave path and the live-dispatch path, plus every prompt |
| `scheduler.ts` | 141 | Kahn layering; each dependency layer runs as one parallel wave |
| `live-dag-admission.ts` | 216 | Validates a plan graph, including one that grows during live dispatch |
| `run-control.ts` | 203 | Cancellation and terminal state for a run |
| `policies.ts` | 167 | Execution policy defaults and prompt versions |
| `skill-router.ts` | 472 | Ranks hub skills and installs before an agent's first turn |
| `skill-creation.ts` | 10 | Recognises a skill-creation request from the task text |
| `runtime-tool-schemas.ts` | 76 | Tool schemas derived from the injected MCP server |
| `project-contribution-intent.ts` | 23 | Whether a prompt is asking for a Git contribution |

`orchestrator.ts` is where everything is wired together and it is far too large.
The seams are visible — the loop, live dispatch, the healing hooks, prompt
construction — but a structural change there is the highest-risk edit available
in this repository, so it has been left alone.

## `leader/` — the leader's model calls

The leader makes four kinds of call. Each has its own module; they share one
client.

| File | Lines | Responsibility |
|---|---:|---|
| `planner.ts` | 125 | Produces the initial subtask graph |
| `evaluator.ts` | 157 | Judges returned work |
| `replanner.ts` | 81 | Revises the graph after evaluation |
| `synthesizer.ts` | 88 | Joins worker results into one answer |
| `ark-client.ts` | 598 | The shared HTTP client; records every call |
| `validation.ts` | 176 | Parses and validates the JSON a model returned |
| `rate-limit.ts` | 79 | Backoff decisions for the client |

Reasoning is disabled by default for these four calls: on the models used here
the thinking pass dominated latency without improving the plan.

## `workers/` — watching what a worker actually does

| File | Lines | Responsibility |
|---|---:|---|
| `trajectory.ts` | 564 | Watches a worker and can end it — see the header comment for the seven stop reasons |
| `repository-trajectory.ts` | 41 | The Git-side observation the monitor uses |
| `worker-resolver.ts` | 125 | Worker naming and identity |
| `worker-validator.ts` | 79 | Validates what a worker returned |
| `budget.ts` | 273 | Spending ceilings and advisory thresholds |
| `budget-events.ts` | 132 | Persists budget state as events |

## `healing/` — bounded repair ⚠ off by default

Detects a repairable failure, runs one bounded repair tournament, and integrates
the winner through the same queue a human contribution uses.

| File | Lines | Responsibility |
|---|---:|---|
| `fault-detector.ts` | 235 | Classifies a failure; decides whether it is repairable at all |
| `healing-coordinator.ts` | 284 | Owns the once-per-fault lifecycle. No recursion |
| `diagnoser.ts` | 142 | One bounded diagnosis per fault |
| `mutation-factory.ts` | 277 | Generates three candidates: control, context patch, strategy patch |
| `repair-tournament.ts` | 1098 | Runs the candidates, applies pruning, selects a winner |
| `repair-workspaces.ts` | 545 | Freezes a checkpoint and creates candidate workspaces |
| `candidate-context-manifest.ts` | 204 | What context a candidate is allowed to see |
| `branch-return-recorder.ts` | 245 | Records the return of a candidate branch |
| `contract-compiler.ts` | 145 | Compiles a subtask into a contract from the catalogue |
| `outcome-resolver.ts` | 96 | Resolves the final outcome of an attempt |

Invariants to preserve: one diagnosis and one tournament per fault; a tie or
insufficient evidence means the control candidate wins; an agent cannot
authorise its own adoption with a test it wrote.

## `verification/` — the authority ⚠ off by default

Decides whether a candidate is acceptable. It runs outside the candidate's
workspace, in a hardened container, so the agent cannot reach it.

| File | Lines | Responsibility |
|---|---:|---|
| `verifier.ts` | 372 | The runner, and assembly of the verification authority |
| `verification-container.ts` | 2703 | Container execution of the gates |
| `verification-profile.ts` | 543 | Contract catalogue, gates, mutants, asset integrity |
| `verifier-manifest.ts` | 53 | Hashes the authority so a change is detectable |
| `evidence-store.ts` | 120 | Content-addressed evidence referenced by every decision |

A profile is a project's own quality manual, not a general-purpose one. A
subtask that cannot claim a contract from the catalogue is not eligible for
healing — the system would rather say it cannot verify than pretend it can.

## `evolution/` — cross-run memory ⚠ off by default

What was tried for a given failure and what it cost, so an identical failure can
skip a candidate already proven useless.

| File | Lines | Responsibility |
|---|---:|---|
| `evolution-types.ts` | 1054 | Record shapes and their validation |
| `evolution-store.ts` | 669 | Append-only persistence with compare-and-set on the head |
| `evolution-fingerprints.ts` | 295 | What counts as "the same failure" |
| `lineage-recorder.ts` | 736 | Writes the lineage graph as a tournament progresses |
| `evolution-projector.ts` | 268 | Validates and projects the graph |
| `evolution-query.ts` | 546 | The paginated read model behind the API |
| `evolution-reconciler.ts` | 431 | Two-phase recovery after a restart |
| `historical-evidence-auditor.ts` | 169 | Whether a historical record may be trusted |
| `exact-repeat-index.ts` | 185 | The index that decides what gets pruned |
| `failure-cues.ts` | 264 | Reusable cues distilled from past failures |

Pruning happens only on a fully identical fingerprint. Contradictory history is
quarantined rather than resolved by guessing, and an unreadable history means
"run normally", never "prune".

## Tests

`apps/server/tests/` is flat and named by subject: `orchestration-*` for this
directory, `coordination-*` for the messaging layer, `self-healing-*` for the
three disabled groups. The two acceptance suites
(`self-healing-m2-acceptance`, `self-healing-m3-acceptance`) drive a full
deterministic fixture and are the fastest way to watch those groups run.
