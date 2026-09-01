# Interface — making a team of agents legible

## What was missing

The baseline interface was built for one agent and one conversation. Once a
leader dispatches several workers, three things become invisible at once: what
the workers are doing, how their work relates, and what the team has spent.

There was a second, quieter problem. Real capability existed that nobody could
see. The skill hub lived on disk and was reachable only through tools inside a
container, so an operator could not tell an empty hub from a full one. Worker
trajectories were recorded but never rendered. Capability that cannot be observed
may as well not be there — for a user deciding whether to trust the system, and
for a reviewer deciding whether it is real.

## The rule the design is accountable to

> Cute, but never fake. Every animated thing on screen is a rendering of real
> execution data. If a visual cannot name the field it came from, it does not
> ship.

Each visual element maps to something the system actually recorded:

```
creature identity   <- Agent
creature state      <- run event stream + run status
a "move"            <- tool event
party membership    <- orchestration child runs
animation           <- state transition
mission phase       <- persisted orchestration phase
```

The practical consequence is a list of things the interface refuses to display:
levels, XP, star ratings, badges, progress percentages, usage counts, and any
other number the system does not record. Several of these were built and then
removed once it was clear they had no source.

## What we built

| Area | Files | Shows |
|---|---|---|
| The party | `AgentParty.tsx`, `CreatureSprite.tsx`, `creature-state.ts` | The leader and every worker, with state derived from their event streams |
| Timeline | `ToolTimeline.tsx`, `moves.ts` | Commands, file changes, tool calls and messages in one chronological view |
| Mission phase | `MissionPhases.tsx` | The orchestration phase, read from what the server persisted |
| Plan | `PlanPanel.tsx` | The plan the leader maintains, which the model otherwise keeps out of its prose |
| Chatroom | `AgentMessages.tsx` | All agent-to-agent traffic in journal order, both ends named |
| Artifacts | `RunArtifacts.tsx` | What the run published |
| Skill hub | `SkillHub.tsx` | What agents have published, with provenance |
| Spend | `agent-stats.ts` | Tokens and estimated cost for the run |

**Failure is rendered, not hidden.** The chatroom is chronological, because a
chatroom reads in time — but the failure that ordering makes easiest to miss is a
message nobody received, so undelivered messages are counted on the fold line and
painted red inside, with the refusal reason shown next to the state. A reader who
never opens the panel still sees that something did not arrive.

**Empty and broken look different.** A mission where nobody spoke renders no
chatroom at all, rather than an empty section that has to be read to be
dismissed. A hub that could not be read says so instead of showing an empty list.

**Animation is state, not decoration.** Each creature's motion comes from its
run state, and the sixteen species-specific idle animations are keyed off real
transitions. When we found that most of them were unreachable — bound to a state
almost no agent was ever in — that was a bug in the mapping, and it was fixed by
correcting which states they attach to, not by loosening the rule.

## The boundary

**Who owns the decision.** The server owns every value. The interface owns
arrangement, emphasis and pacing, and derives nothing that the server did not
record. Where a display value is inferred rather than reported — "in progress"
for a plan step, for instance — it is inferred from persisted state and never
invented as a failure.

**What crosses.** Only the read APIs described in [trace.md](trace.md). The
interface has no privileged channel into a run and cannot see anything a person
could not fetch themselves.

**What happens on failure.** A read error is reported as a read error. A missing
projection renders nothing rather than a placeholder that implies data. A run
that predates a feature renders without it instead of taking the page down.

## Tests

The web suite tests behaviour rather than markup: state derivation
(`creature-state.test.ts`, `agent-stats.test.ts`), the chatroom's ordering and
undelivered-message accounting (`AgentMessages.test.tsx`), timeline grouping
(`ToolTimeline.test.tsx`), hub honesty for empty and unreadable states
(`SkillHub.test.tsx`), and polling lifetime (`App.*.test.tsx`).

One test deserves a note. `CreatureSprite.motion.test.tsx` loads the real
stylesheet into the DOM and asks the rendering engine which animation is
actually running, rather than asserting against CSS text. A text assertion passes
even when the rule is unreachable, which is exactly how the unreachable-animation
bug survived in the first place.

## Known limits

**Updates are polled, not pushed.** The client polls the run endpoints on an
interval. This is a transport choice and the data model does not depend on it; a
live channel would be an additional reader over the same records.

**Three web tests are currently failing** — two in `App.transcript.test.tsx` and
one in `ProjectDialogs.test.tsx`. They are assertion failures about where
integration bookkeeping is rendered, not crashes.

**The suite requires Node 22.** The repository declares it, but the version guard
only runs on `prestart`, so running the tests on Node 20 produces a confusing
`undici` error rather than a clear version message.
