# Trace — the record everything else is built on

## What was missing

The agent runtime emits a detailed stream while it works: reasoning, command
execution, file changes, tool calls, token usage. The baseline parsed four event
types out of that stream and discarded the rest.

That is not only a monitoring gap. Without the stream there is nothing for a
timeline to render, nothing to attribute spend to, nothing to rebuild state from
after a crash, and no evidence behind any automatic decision. Every other part of
this system needed it to exist first.

A second gap sat underneath it. The agent held real provider credentials inside
its container and called the model directly, so the control plane was not on the
call path at all. Nothing outside the container could observe or attribute those
calls, and the key was somewhere we did not control.

## What we built

One normalised, provider-neutral event stream, persisted append-only, feeding
every consumer.

```
runtime stdout ──► createEventCollector ──► RunEventDraft[] ──► RunEventSink ──► EventLog (JSONL)
                     (run-events.ts)         provider-neutral    redact + persist   └► trajectory-log.ts
```

| Component | File | Responsibility |
|---|---|---|
| Collector | `run-events.ts` | Parses runtime output into stable drafts |
| Event log | `event-log.ts` | Append-only JSONL per run, plus sidecars for oversized payloads |
| Projection | `trajectory-log.ts` | Human-readable rendering of the same records |
| Redactor | `redact.ts` | Removes secrets and bounds strings before anything is written |
| Egress proxy | `model-proxy.ts` | Puts the control plane on the model-call path |
| Cost | `pricing.ts` | Estimates spend from token counts and published rates |

**Downstream reads canonical fields only.** Consumers use `input`, `output` and
`error`; `attributes` is provider-specific display metadata and no logic depends
on it. That rule is what lets the runtime change without the consumers changing.

**The proxy is on the path, not beside it.** Because the runtime issues its calls
from inside the container, an external monitor could not reliably see them. The
generated runtime configuration points at our proxy instead, which records each
call before forwarding it. The real provider key stays in the control plane, and
each container carries a per-run token that is meaningless anywhere else — which
is also what makes a call attributable to a run and an agent.

**Redaction is on the write path.** Secret-shaped fields are replaced and long
strings are bounded before an event reaches disk, rather than being cleaned up
afterwards. The proxy, the event log, the trajectory log, and the container
runner all share one redactor, so a stored trace, a screenshot of the timeline,
and an exported log are covered by the same rule instead of three.

**Cost is reported as an estimate, and reasoning tokens are separated out.**
Providers bill reasoning as output, but it is not part of what the agent
produced, so the visible output count subtracts it. The estimate is derived from
published rates and is never used as an input to any automatic decision.

## What is queryable

| Endpoint | Returns |
|---|---|
| `GET /api/runs/:id/events` | The run's event stream, paginated |
| `GET /api/runs/:id/coordination` | The team's message journal with delivery state |
| `GET /api/runs/:id/children` | A leader run's worker tree |
| `GET /api/runs/:id/artifacts` | Artifacts published during the run |

The browser timeline renders those same records rather than a separate display
copy. One stream drives the timeline, the usage numbers, restart recovery, and
the evidence behind faults, which means what the interface shows is what the
system acted on.

## The boundary

**Who owns the decision.** The middleware decides what is recorded, what is
redacted, and what is truncated. An agent cannot suppress its own trace, and
cannot see another run's.

**What crosses.** Out of the container: the agent's own events and its model
requests, both mediated. Into the container: a per-run token, never a provider
key.

**What happens on failure.** A payload over the field limit spills into a
fingerprint-named sidecar rather than being dropped or truncating the record
around it. If the proxy is unavailable no run could have started, so it is a
startup dependency rather than a runtime risk. If redaction cannot classify a
field it is bounded anyway, because the length limit applies regardless of
content.

## Tests

`run-events` parsing and sanitisation, `event-log` persistence and sidecar
spilling, `redact` classification and bounding, `model-proxy` recording and
credential isolation, `pricing` estimation.

## Known limits

**Cost is an estimate, not billing truth.** It comes from published rates that
can change, and it is labelled as an estimate wherever it is shown.

**Redaction is field-shape based.** It catches secret-shaped keys and bounds
everything; it will not recognise a credential that an agent chooses to print
inside ordinary prose. Keeping secrets out of prompts remains a property of how
the run is set up, not something the redactor can guarantee alone.
