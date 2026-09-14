---
name: curate-index
description: Decide whether a project belongs in the agent-stack index and which layer it sits in, then refresh the generated pages. Use for the weekly curation schedule and whenever someone proposes or questions a listing.
---

# Curating the index

The page answers one question for someone building an agent product: **what would you actually assemble
to ship and run an agent?** Every membership decision comes back to that sentence.

## 1. Start from what changed

`candidates` runs discovery and returns the projects nobody has judged yet, with their description,
stars and how they were found. It does not judge anything; that is the point of it being a tool.

A candidate arrives having already cleared a floor that needs no judgement: open licence, pushed within
90 days, not a fork, at least 100 stars or ten user issues in 30 days. The floor exists to drop what
cannot be measured or is already dead. Everything else is ranked by score, not filtered out — a small
project that ships weekly and answers its users outranks a large one that does neither.

## 2. Read it, then decide

Use `repo-readme` before every verdict. The description is written for a launch; the README says what
the thing is. Two questions, in this order:

**Is it part of the stack?** Include a project a builder would use, evaluate or fork: an agent they run,
the harness under it, the framework they build with, the client they put in front, the router, sandbox,
memory, evaluation or guardrail around it.

Exclude, however many stars it has:

| Not in the stack | Why it keeps appearing |
|---|---|
| Lessons, courses, interview guides, "awesome" lists, papers | They rank highly and describe themselves with the same words |
| Demos, templates, starters | Built to be read once, not depended on |
| General infrastructure that mentions AI | A database "built for agentic workloads" is a database |
| Vertical applications where the agent is an implementation detail | Job hunting, social scheduling, video editing, news dashboards |

**Which layer?** Pick the one its users would look for it under. The distinction people get wrong most
often is **use versus build**: Claude Code and Cursor are things you use to write code; a harness is the
loop you build on. When a project ships both, place it where its users think of it.

If neither question has a clear answer after reading, mark it not in stack and say why. A wrong
inclusion is visible and correctable; a vague one rots.

## 3. Re-read what changed, on the evidence

`review-queue` lists projects whose verdict may no longer hold and why: archived, renamed, description
changed since it was judged, silent for months, or filed under a layer the verdict never named. It ranks
by how many signals a project shows; it decides nothing.

There is deliberately no "re-judge everything every 30 days" rule. Most projects do not change in a
month, and the ones that matter change the week they pivot — a calendar spends judgement evenly on a
problem that is not evenly distributed. Read the projects whose signals suggest the description you
judged is no longer the project, and leave the rest.

Two signals mean different things. **Archived or silent** is a fact about maintenance, and the page
already prints it, so removal is rarely the answer — a widely used project that stopped shipping is
exactly what a reader wants to see flagged. **A changed description** is a fact about identity, and it
is the one that moves a project between layers or out of the index.

Recording a new verdict for a project replaces the old one, so a correction is just a rerun.

## 4. Record verdicts, then refresh

`record-verdict` appends to `data/classified.json`; one call per batch of judgements. Then `refresh`
runs the deterministic half: seeds, measurement, scores, README, the sixteen layer pages, and the
weekly diff. Read its summary — a layer that lost several projects at once is a signal that a search or
a judgement went wrong, not a result to publish.

When a decision needs to survive the next run, it belongs in `overrides.json`: `include` forces a
project into a layer, `exclude` keeps one out, `packages` declares what a repository publishes so that
weekly installs can be read. Every entry needs a reason, because the pipeline reruns and the next
reader has to know whether the correction still applies.

## 5. Report

Say what was judged, what was added, what was removed and what you would not decide alone. Name the
projects; counts alone hide the mistake you want caught. When a run is thin, say that rather than
padding it — a quiet week in a 400-project index is information about the ecosystem.
