# Agent Continuity Middleware

A coding agent team that can coordinate now and reuse what it learns later.

Built for TikTok TechJam 2026 on top of the Volc Agent Launchpad starter kit —
a browser UI, a Fastify control plane, and Codex running inside disposable
containers.

---

## Run it

### What you need

| | |
|---|---|
| **Node 22+** | the repo enforces this; on Node 20 the test suite fails with a confusing `undici` error rather than a version message |
| **Docker** (or Podman / Colima) | agents run in containers; the startup script detects the engine |
| **A model provider key** | OpenRouter or BytePlus ModelArk |

### Step by step

```bash
# 1. Node 22 or newer. Check first; the startup script refuses anything older.
node --version                      # want v22.x or above
nvm use 22                          # if you use nvm and the check came back v20

# 2. Docker (or Podman, or Colima) must be running. The script detects which.
docker info >/dev/null && echo "engine ready"

# 3. Your provider key. Copy the template, then edit ARK_API_KEY into it.
cp .env.example .env
$EDITOR .env                        # set ARK_API_KEY=sk-...

# 4. Dependencies.
npm install

# 5. Start everything.
npm run poc
```

Open **http://localhost:3000**.

Step 5 reads `.env`, builds the runtime image, checks that ports 3000, 3001 and
3002 are free, builds the web and API bundles, and starts the server. It prints
the directory it keeps state in, and cleans up its own containers when you stop
it with Ctrl-C.

Anything already exported takes precedence over `.env`, so a one-off override
needs no edit to the file:

```bash
ARK_MODEL=some/other-model npm run poc
```

### If you'd rather run it in dev mode

`npm run dev` starts the two workspaces directly, so export `.env` into your
shell first:

```bash
set -a          # export everything defined from here on
. ./.env        # load the file
set +a          # back to normal

npm run dev     # web on :5173, API on :3000, both watching
```

Note that `npm run dev` does **not** set `RUNTIME_PROVIDER=container`, so agents
run directly on the host with no isolation. Use `npm run poc` for anything you
care about.

### Checking it works

```bash
curl localhost:3000/api/health          # {"ok":true,"service":"volc-agent-launchpad"}
```

For the test suite and what it covers, see [Verification](#verification).

### Ports

| Port | What |
|---|---|
| 3000 | Web UI and API |
| 3001 | Model egress proxy — every model call from a container goes through here |
| 3002 | Team coordination — the endpoint worker subprocesses talk to |

---

## What this is

The platform we started from hands you a real coding agent sealed in a
disposable container. Everything it knows, says, or works out dies with the
box. It has no teammates and no way to address one, and it cannot tell the next
session anything, because there is no next session it can reach. Run the same
task twice and the second run starts as ignorant as the first.

That is an infrastructure gap rather than a model one. A stronger model in the
same container is still in the container. What is missing is an exit.

This project builds the layer that provides one, in two halves.

![The same task producing two outputs: a verified result that ends with the run,
and a validated skill that outlives it in the hub for future
sessions](docs/assets/two-halves.png)

### Coordination — within a run

A leader plans, the middleware validates the plan before any worker starts, and
the scheduler runs each dependency layer as a parallel wave.

- **Identity comes from the token, not the message.** An agent that could write
  its own name into a `from` field could impersonate a sibling, and every later
  judgement built on *who said this* would be worthless.
- **Three delivery modes.** `quiet` waits for the recipient's next turn and
  costs nothing. `talk` joins an active turn or queues for an idle one.
  `wakeup` starts a turn immediately and spends from the team's follow-up
  budget. Without the distinction, agents spend the run's budget telling each
  other "got it".
- **The journal is written before delivery.** A sender told its message was
  queued must not lose it to a crash, so what still needs delivering is
  recomputed from disk rather than held in memory.
- **One budget** covers the leader and every worker.

### Capability — across runs

An agent that solved something once can write it up as a skill, have it
validated, and publish it to a hub any later session can install from. A
deterministic router ranks and installs matching skills before an agent's first
turn, rather than leaving discovery to the agent.

Installs land in the shared workspace by default, which is where the two halves
physically meet: what one agent installs, its siblings can use immediately.

### What it refuses to do

- **No invented numbers.** The hub reports no usage counts, because nothing on
  disk records usage.
- **An unreadable hub is not an empty hub.** If a read fails the page says the
  read failed.
- **Every animated thing on screen is real execution data.** If a visual cannot
  name the field it came from, it does not ship — which is why there are no
  levels, XP, or progress percentages.

---

## How it fits together

![Architecture: a trusted control plane holding plan validation, the message
and delivery pipeline, the event and telemetry pipeline, and the skill hub,
above a trust boundary with disposable worker containers below
it](docs/assets/agent-continuity-architecture-reference.png)

One request in, one boundary in the middle. The control plane plans, validates,
mediates and records; the containers below the line execute and are thrown away.
Nothing durable lives below the line — which is the whole point, because the
starter kit's problem was that everything lived there.

Three things cross the boundary downward: a **validated dispatch**, a **message
carrying a run token**, and a **model request carrying that same run token**.
Two things cross upward: **runtime events** and a **skill package with its
evidence**. That is the entire contract.

### The boundary

Read this table as: who decides, what actually moves, and what you get instead
of a decision when it fails.

| Capability | Who owns the decision | What crosses | What happens on failure |
|---|---|---|---|
| **Task decomposition** | The leader owns the split and who gets what. The middleware owns whether that plan is admissible at all | A subtask DAG | A plan with a cycle, a self-dependency, an unknown dependency or a duplicate worker name is refused **before any worker starts** — not repaired |
| **Agent identity** | The control plane, always. An agent never names itself | A per-run token; the sender is read from it and the `from` field is ignored | `401 unauthorized`. A forged or expired token cannot address anyone |
| **Message delivery** | The middleware decides when a message becomes a model turn — `quiet`, `talk` or `wakeup` | Message content plus workspace refs | Written to the journal *before* the sender is told it was queued; what still needs delivering is recomputed from disk, never from memory |
| **Model access** | The control plane holds the provider key and never hands it down | A model request plus the run token, through the proxy on :3001 | `401`. The container has nothing that works anywhere else, which is also how a call is attributed to a run |
| **Spend** | The middleware, across the leader and every worker as one total | Token counts, per call | Admission stops. A wakeup past the follow-up budget is refused and reported, not silently dropped |
| **Skill publication** | The agent owns the content; the middleware owns validation and provenance | A skill package plus the evidence files behind it | Blocking provenance warnings reject the skill even when the match is strong |
| **Observation** | The middleware. Agents do not choose what is recorded about them | Runtime events, redacted on the write path | A trace that cannot be read says so; it never renders as an empty one |

Longer versions, with the reasoning: [`docs/design/`](docs/design/) — the
boundary sections of [coordination](docs/design/coordination.md#the-boundary),
[skills](docs/design/skills.md#the-boundary) and
[interface](docs/design/interface.md#the-boundary).

---

## Demo

Create an agent in the UI and give it a task that genuinely needs a team. The
run below is the one the published skill comes from:

> Research the current state of autonomous agent systems and produce a concise
> technical report comparing at least 6 recent agent frameworks or research
> systems. Use subagents in parallel to investigate different systems, verify
> claims from primary sources, and identify recurring architectural patterns.
> From the findings, create one lightweight reusable Skill that captures a
> useful research workflow or comparison method discovered during the task.
> Keep the Skill small and practical, validate it briefly, then publish it to
> the Skill Hub. Finally, deliver a comparison table, key architectural
> patterns, major limitations, one proposed improvement, and references.

**What to watch, in order.**

| Where | What you are actually looking at |
|---|---|
| The plan panel | The leader's subtask graph *after* validation admitted it. Nothing runs before this exists |
| The team view | Workers appearing together, not in sequence. In the reference run five started within 18 seconds of each other |
| A worker that waits | The skill builder does not start until the skill architect finishes. That is `dependsOn`, enforced by the scheduler, not politeness |
| The timeline | Each worker's real commands and file changes, redacted on the way to disk |
| Spend | One running total for the leader and every worker, labelled an estimate |
| The Skill Hub | The published skill, its validation notes, and the evidence files it was distilled from |

**What the reference run did.** Sixteen and a half minutes, one leader, nine
workers, all completed. Four researchers split the systems by family — SDK
frameworks, graph and multi-agent, coding agents, research autonomy — and ran
concurrently. Then a five-stage chain built the skill and put it through the
gates: architect, builder, gate, re-gate, and a fresh-context forward test that
checks the skill works for an agent that did not write it. It compared twelve
systems and published `primary-source-system-comparison` to the hub, which you
can read back over the API:

```bash
curl localhost:3000/api/skills
curl localhost:3000/api/skills/primary-source-system-comparison
```

The skill's record carries the evidence it was distilled from — the four
research reports and the build report, all in the shared workspace — so the
route from the run to the reusable artifact is inspectable rather than asserted.

---

## When things go wrong

Every case below is enforced in code and leaves evidence a human can read.

| Situation | What happens | Evidence | Pinned by |
|---|---|---|---|
| Two agents waking each other in a loop | The pair keeps talking, stops being able to wake each other | Receipt reason `downgraded_to_quiet` | `coordination-anomaly` · *fires on strict direction reversals*, *downgrades the offending pair's wakeups afterwards*, *resets when a third party joins* |
| Follow-up budget spent | Wakeup refused, not dropped | Red `Never arrived · FOLLOW_UP_LIMIT` in the chat panel | `coordination-delivery` · *stops waking a worker once its follow-up budget is spent* |
| Impersonation, out-of-run recipient, path escape, dispatch without the leader token | Refused | Rejection at the ingress | `coordination-ingress` · *takes the sender from the token, never from the request*, *refuses a recipient outside this leader run*, *refuses a workspace ref that climbs out of the shared directory*, *allows only the leader token to dispatch subagents* |
| Crash mid-delivery | Pending set rebuilt from the journal | The journal itself | `coordination-team-journal` · *reports a queued message with no receipt as pending after reload*; `coordination-delivery` · *recomputes what still needs delivering from the journal, not memory* |
| A worker stops making progress | Runtime cancelled, attempt ended | Fault record with the evidence behind it | `orchestration-trajectory` · *warns on the second identical checkpoint and stops on the third*, *expands one batch_tool_call into nested steps so batching cannot hide a loop*; `orchestration-fault-detector` · *classifies a trajectory stop as a repairable stall* |
| A secret reaches a write path | Masked before it lands, not cleaned up afterwards | The stored trace itself | `redact` · *removes the literal secret anywhere in a string*, *masks secret-named keys and walks nested structures*, *does not let source text spoof a truncation marker* |
| An invalid plan | Refused before any worker starts | The rejection, naming the offending subtask | `orchestration-validation` · *throws on a cycle*, *throws on a self-dependency*, *throws on a dependency to an unknown subtask*, *throws on duplicate worker agent names* |

The loop detector deliberately only downgrades and reports. Intervening
automatically is itself a model turn, and can deepen the loop it meant to break.

---

## Verification

```bash
npm test                   # both suites
npm run check              # typecheck, tests, production build

npm test -w @launchpad/server -- coordination     # just the coordination suites
npm test -w @launchpad/web                        # the interface, ~5 seconds
```

**131 test files: 93 on the server, 38 on the web.** The server suite is 1603
tests and takes about eleven minutes — it runs single-threaded on purpose,
because several suites create and verify real git repositories and contend for
the disk otherwise. The web suite is 383 tests in about five seconds.

Tests target middleware behaviour rather than rendering. The
[failure table above](#when-things-go-wrong) names the test behind each claim;
the same holds for the ordinary path:

| Behaviour | Pinned by |
|---|---|
| Delivery modes really differ | `coordination-delivery` · *injects quiet and wakes wakeup*, *steers talk into an active turn without waking idle workers* |
| Identity comes from the token | `coordination-ingress` · *takes the sender from the token, never from the request* |
| A queued message survives the target not existing yet | `coordination-delivery` · *holds a message for a worker that has not started*, *redelivers queued messages when the target runtime attaches* |
| The journal is gapless and concurrent-safe | `coordination-team-journal` · *assigns gapless sequences and rebuilds the projection from disk*, *serialises concurrent appends without dropping or reordering* |
| One budget spans leader and workers | `coordination-budget` · *covers leader and worker usage in one total* |
| The scheduler waits on dependencies | `orchestration-runtime-lifetime` · *queues live leader workers until their dependsOn subtasks finish* |
| The skill router declines rather than guesses | `orchestration-skill-router` · *does not install for low-confidence tasks*, *rejects a skill with blocking provenance warnings despite a strong match* |
| Worker tokens die with the team | `orchestration-runtime-lifetime` · *keeps worker model tokens valid until the team closes* |

## Where to look in the code

| Path | What |
|---|---|
| [`docs/design/`](docs/design/) | Why the system looks like this — start with the README there |
| [`apps/server/src/README.md`](apps/server/src/README.md) | Map of the 96 server modules |
| [`apps/server/src/orchestration/README.md`](apps/server/src/orchestration/README.md) | Map of the 47 orchestration modules, grouped by when they run |
| `apps/server/src/coordination/` | Roster, ingress, delivery, journal, budget, loop detection |
| `apps/server/src/model-proxy.ts` | The control plane on the model-call path |
| `apps/server/src/redact.ts` | Secrets removed before anything reaches disk |
| `apps/web/src/` | The interface |

---

## Known limits

**Container egress is not allowlisted.** Model traffic is mediated through the
proxy, but arbitrary outbound connections from a container are not restricted.

**Skill promotion is automatic once validation passes.** `publish_skill` writes
to the global hub on its own authority. Validation and provenance are the only
gate; a human does not stand between an agent and the hub.

**Cost is an estimate.** It comes from published provider rates, is labelled as
an estimate wherever it appears, and is never an input to an automatic decision.

---

## Security

The provider key stays in the control plane. Containers carry a per-run token
that is meaningless anywhere else, which is also how a call is attributed to a
run. Redaction runs on the write path rather than as a cleanup pass, so a stored
trace, a screenshot of the timeline, and an exported log are covered by one rule.

Do not commit `.env`. Report vulnerabilities per [SECURITY.md](SECURITY.md).

## License

See [LICENSE](LICENSE).
