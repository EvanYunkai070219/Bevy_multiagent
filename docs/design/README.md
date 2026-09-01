# Design

The platform we started from hands you a real coding agent sealed in a disposable
container. Everything that agent knows, says, or works out dies with the box. It
has no teammates and no way to address one, and it cannot tell the next session
anything, because there is no next session it can reach.

That is an infrastructure gap rather than a model one. A stronger model in the
same container is still in the container. What is missing is an exit.

We built the layer that provides one: information that survives the agent that
produced it, and information that survives the session that produced it.

## The four pieces

| Document | Subject |
|---|---|
| [coordination.md](coordination.md) | How several agents work as a team inside one run |
| [trace.md](trace.md) | The event record everything else is built on |
| [skills.md](skills.md) | How a method proven in one run reaches a later one |
| [interface.md](interface.md) | How all of it is made legible to a person |

They are not independent features. [trace.md](trace.md) is the substrate: the
same normalised event stream feeds the timeline, the usage and cost numbers,
restart recovery, and the evidence behind every automatic decision. Coordination
and skills are the two directions information travels once that substrate
exists — sideways to a peer, forward to a future session — and they meet at the
shared workspace, where a skill installed from the hub lands in the directory
sibling agents already read from.

## What each document contains

Every one of them answers the same four questions, because that is what makes a
design reviewable rather than merely descriptive:

1. **What was missing** in the baseline platform.
2. **What we built**, and where it lives in this repository.
3. **The boundary**: who owns the decision, what data crosses it, and what
   happens when something fails.
4. **Known limits** — what we did not do, and what is not yet wired.

## Reading order

If you have five minutes, read this page and the boundary section of
[coordination.md](coordination.md). If you are evaluating whether the middleware
is real rather than represented, [trace.md](trace.md) is the one to read, because
every other claim in these documents is checkable against the records it
describes.

## Status

Coordination, trace, skills, and the interface are on the production path.
Bounded self-healing and its cross-run failure memory are implemented and
verified against a deterministic fixture, but integration surfaced two blockers
on the production path, so they are described in
[coordination.md](coordination.md#known-limits) as unfinished rather than
presented as working.
