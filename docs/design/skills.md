# Skills — carrying a method into the next session

## What was missing

Containers and workspaces are disposable. When a run ends, the workspace goes
with it, which means a second session physically cannot see anything the first
session worked out. Run the same task twice and the second attempt starts as
ignorant as the first.

Nothing about that is a model limitation. It is a missing store, a missing
retrieval path, and a missing installation step — all of which live outside the
agent.

## What we built

A persistent hub outside any disposable runtime, plus the tools an agent uses to
put things into it and take things out.

| Piece | Where | Responsibility |
|---|---|---|
| Hub store | `<data>/skill-hub/skills/<name>/<version>/` | Package files beside a `.launchpad-skill.json` record |
| Agent tools | `launchpad-mcp-server-source.ts` | `validate_skill`, `publish_skill`, `search_skills`, `read_skill`, `install_skill` |
| Wiki + proposals | same file | `*_skill_wiki` and `*_skill_proposal` tools for evolving an existing skill |
| Control-plane read | `skill-hub.ts` | Reads the published record; serves `GET /api/skills` and `/api/skills/:name` |
| Router | `orchestration/skill-router.ts` | Ranks and installs before an agent starts |

**Publication is gated by validation.** `validate_skill` checks the package as a
reusable artefact rather than as code that runs: frontmatter, resource links that
actually resolve, script and test hints, clutter files, and whether a
fresh-context forward test was recorded. Publishing a package that fails
validation returns `SKILL_VALIDATION_FAILED` and writes nothing.

**Provenance travels with the package.** Each record carries the run and agent
that produced it, the evidence it cited, any origin patterns, the version it
supersedes, and provenance warnings raised at publication time.

**Selection moved from the agent to the middleware.** Leaving reuse to "the agent
may remember to search" means the agent spends turns discovering options and may
still pick nothing. The router classifies the task, retrieves candidates, ranks
them, and applies a policy gate before the agent's first turn: packages with
blocking provenance warnings are rejected, at most one primary and two supporting
skills are injected, and a low-confidence match produces a shortlist instead of
an installation. Installing into the durable `$CODEX_HOME` requires an explicit
request; the default target is the run's shared workspace.

**Installs land where siblings can read them.** `install_skill` defaults to
`$COMMON_WORKSPACE/skills/<name>`, which is the same directory the coordination
layer gives the team. What one agent installs, the others can use immediately —
this is the point where the two halves of the middleware physically meet.

## Two things we deliberately do not do

**We do not report usage counts.** Nothing on disk records usage. A count would
have to be invented, and an invented number would make the hub look busier than
the runs actually made it.

**We do not report an unreadable hub as an empty one.** If the read fails the
page says the read failed. "No skills yet" and "we could not tell" are different
facts and a reader is entitled to know which one they are looking at.

## The boundary

**Who owns the decision.** The agent owns the content of a skill. The middleware
owns validation, ranking, the policy gate, provenance recording, and where a
package is installed.

**What crosses.** A skill folder plus its provenance record, moving outward into
the hub at publication and downward into the shared workspace at installation.
Usage does not cross, because it is not recorded.

**What happens on failure.**

| Situation | Behaviour |
|---|---|
| Validation fails | Refused with `SKILL_VALIDATION_FAILED`; nothing enters the hub |
| Version already published | Refused; the publisher chooses a new version label |
| Blocking provenance warning | Router rejects the candidate |
| No confident match | Shortlist summary instead of an installation |
| Hub unreadable | The reader reports a read failure, not an empty hub |
| A published folder with no record | Skipped — it is an unfinished copy, not a version |

## Tests

`launchpad-mcp-server.test.ts` covers validation refusal, publication, and the
publish-then-install path across two runs; `orchestration-skill-router.test.ts`
covers ranking and the policy gate; `skill-hub` read behaviour is covered
alongside the API routes.

## Known limits

**Promotion into the global hub is not yet human-gated.** `publish_skill` writes
to the hub once validation passes. The hub is global — every future run in every
project can install from it — so the decision to promote something there belongs
to a person, and today it does not sit with one. The intended design is that an
agent stages a validated package and a human publishes it, with staged packages
invisible to search and install until then. That is implemented as a plan, not as
code.

**The data directory is mounted into worker containers.** The approval boundary
above, once built, is an authority boundary for well-behaved tooling rather than
a defence against a container that writes to the hub directory directly.
Tightening the mount is separate work.
