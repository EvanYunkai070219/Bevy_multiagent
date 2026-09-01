# Server source map

96 TypeScript modules, about 41k lines. This page says what each block is
responsible for so you can find the right file without opening ten wrong ones.

Design rationale lives in [`docs/design/`](../../../docs/design/); this is a
layout map, not an argument.

## Where to start

| If you want to know… | Open |
|---|---|
| How a request becomes a running agent | `index.ts` → `app.ts` → `agent-service.ts` |
| How several agents are coordinated | [`orchestration/README.md`](orchestration/README.md) |
| How agents talk to each other | [`coordination/`](#coordination--agents-talking-to-each-other) |
| What gets recorded and where | [`run-events.ts`, `event-log.ts`](#trace--the-event-record) |
| How a container is launched | `container-codex-runner.ts`, `runtime/` |
| What tools an agent has | `launchpad-mcp-server-source.ts` |

## Entry and HTTP

| File | Responsibility |
|---|---|
| `index.ts` | Process entry. Assembles every component and wires the optional ones |
| `app.ts` | Fastify routes and their request validation |
| `agent-service.ts` | The service layer behind the routes: agent and run lifecycle |
| `errors.ts` | `HttpError` and terminal run errors |
| `config.ts` | Environment schema, and generation of the runtime's own config file |
| `storage-layout.ts` | Which path on disk holds what |
| `store.ts` | The JSON database and its mutation lock |
| `types.ts` | Shared domain types. Read this before changing a persisted shape |

## Running an agent

| File | Responsibility |
|---|---|
| `runner-factory.ts` | Picks a runner from configuration |
| `codex-runner.ts` | Builds the CLI invocation and parses its event output |
| `container-codex-runner.ts` | The containerised runner, including hardening flags |
| `launchpad-mcp-server-source.ts` | The MCP server injected into every container, as a source string |
| `workspace.ts`, `workspace-files.ts` | Per-agent workspaces and bounded file access |
| `runtime/` | The seam between "what the orchestration wants" and "how a worker runs" — one-shot turns and addressable sessions |

`launchpad-mcp-server-source.ts` is one large `String.raw` template. Nothing
inside it may contain a backtick or `${`; use string concatenation.

## Trace — the event record

Everything else is built on this. See [`docs/design/trace.md`](../../../docs/design/trace.md).

| File | Responsibility |
|---|---|
| `run-events.ts` | Parses runtime output into provider-neutral drafts |
| `event-log.ts` | Append-only JSONL per run, with sidecars for oversized payloads |
| `trajectory-log.ts` | Human-readable projection of the same records |
| `refined-trajectory-log.ts` | A second, more compact projection |
| `redact.ts` | Removes secrets and bounds strings **before** anything is written |
| `model-proxy.ts` | Puts the control plane on the model-call path; issues per-run tokens |
| `pricing.ts` | Estimates spend from token counts and published rates |
| `published-artifacts.ts` | Artifacts a run published, and reading them back |

## Coordination — agents talking to each other

See [`docs/design/coordination.md`](../../../docs/design/coordination.md).

| File | Responsibility |
|---|---|
| `coordination/roster.ts` | Who is addressable in a leader run |
| `coordination/ingress.ts` | The only way a worker subprocess reaches the team; decides the sender |
| `coordination/server.ts` | The HTTP surface that subprocess talks to |
| `coordination/messages.ts` | Message and receipt shapes; the three delivery modes |
| `coordination/team-runtime.ts` | Delivery, downgrades, follow-up budget, quiescence |
| `coordination/team-journal.ts` | Append-only team record; delivery state is derived from it |
| `coordination/anomaly-detector.ts` | Detects exchanges that stopped making progress |
| `coordination/token-ledger.ts` | One spend total across the leader and every worker |

## Projects and Git

| File | Responsibility |
|---|---|
| `project-registry.ts` | Project records and baseline advancement |
| `project-repository-manager.ts` | Managed and external repository identity |
| `project-run-manager.ts` | Project-scoped run preflight and bookkeeping |
| `project-attempt-executor.ts` | Executes one attempt against a project |
| `project-migration.ts` | One-off migration of legacy chats into projects |
| `attempt-workspace-manager.ts` | Per-attempt worktrees and their cleanup |
| `contribution-collector.ts` | Collects a worker's bounded Git contribution |
| `contribution-integrator.ts` | Integrates a collected contribution, with rollback |
| `structural-gate.ts` | The structural pass a contribution must clear |
| `git-client.ts` | Every Git invocation the server makes |

A user's own branch, index and worktree are never touched. Attempts work in
separate worktrees, and integration rolls back the canonical repository on
failure.

## Skills

See [`docs/design/skills.md`](../../../docs/design/skills.md).

| File | Responsibility |
|---|---|
| `skill-hub.ts` | Reads the published hub for the control plane. Read-only by design |
| `orchestration/skill-router.ts` | Ranks and installs before an agent's first turn |
| `orchestration/skill-creation.ts` | Recognises a skill-creation request |

Publishing and installing stay with the agents, through MCP tools. The control
plane only reads, so a page can never mint capability no run produced.

## Orchestration

47 modules across nine root files and five subdirectories, grouped by when they
run. It has its own map:
[`orchestration/README.md`](orchestration/README.md).

## Conventions

**Header comments carry the "why".** Where a module has one, it states the
failure the module exists to prevent rather than restating what the code does.
Coverage is uneven — the trace and coordination modules have them, most of
`orchestration/` does not yet.

**Canonical fields only.** Event consumers read `input`, `output` and `error`.
`attributes` is provider-specific display metadata and no logic depends on it.

**Persisted shapes are append-only in practice.** Adding a field is cheap;
changing the meaning of one is not. `types.ts` is the place to look first.

**Tests target behaviour.** `apps/server/tests/` is flat and named by subject.
The suite requires Node 22 — on Node 20 it fails with a confusing `undici`
error rather than a version message.

## Known rough edges

`orchestration/orchestrator.ts` is 6,493 lines and should be split along the
seams already visible in it: the leader loop, live dispatch, the healing hooks,
and prompt construction. `launchpad-mcp-server-source.ts` at 3,302 lines has the
same problem. Both are deliberately left alone for now, because a structural
change to either is the highest-risk edit available in this repository.
