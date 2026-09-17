# Project context

This repository publishes an index of the open-source projects someone assembles to ship and run an
agent: sixteen layers, measured daily, scored, and ranked inside each layer. It is not a curated link
list, and the difference is the point — a link list cannot say whether a project is still shipping or
whether anyone answers its users.

Two kinds of work meet here and must not blur:

- **Measurement is deterministic.** Stars, installs, release cadence, user issues and the scores derived
  from them come from `fastagent/lib/`, never from judgement. Generated files are never hand-edited.
- **Membership is judgement.** Whether a project belongs and in which layer is decided by the agent in
  `fastagent/`, which reads each candidate's README. A regular expression did that job first and put a
  Java interview guide, a database that renamed itself "built for agentic workloads", and a news
  dashboard into the index.

## Layout

| Path | What it is |
|---|---|
| `layers.json` | The sixteen layers: title, blurb, 163 search queries, classification keywords. One definition, read by discovery, scoring, rendering and the agent |
| `overrides.json` | The only hand-written data: `include` / `exclude` / `packages`, each entry with a reason |
| `fastagent/lib/` | The pipeline: `discover`, `measure`, `seeds`, `render`, `github`, `layers`, `index-data` |
| `fastagent/tools/` | What the agent can do: `candidates`, `repo-readme`, `record-verdict`, `review-queue`, `refresh` |
| `fastagent/skills/curate-index/` | How membership is decided |
| `fastagent/schedules/` | `daily-curate` (08:00 CST), `judge-backlog` (every 15 min while a backlog exists) |
| `scripts/` | Entry points: `discover.ts`, `refresh.ts`, `backfill.ts` |
| `data/` | `candidates.json`, `classified.json` (verdicts), `snapshots.csv` (append-only history), `latest.json`, `index.json` |
| `README.md`, `layers/*.md`, `CHANGES.md` | Generated. Edit the pipeline, not these |

## The flow

```
discover  → data/candidates.json   searches + new-repo windows + HN/trending + awesome lists + what is
                                   already listed, then a mechanical floor
judge     → data/classified.json   the agent reads each README: in the stack? which layer?
seeds     → seeds.json             verdicts corrected by overrides.json
measure   → data/snapshots.csv     tiered: top 20 per layer and stale rows every run, nothing twice a day
render    → README, layers/, CHANGES.md, data/index.json
```

Commands, from the repository root:

```bash
node scripts/discover.ts --stars 100   # a sweep; writes candidates
node scripts/refresh.ts                # seeds + measure + score + pages (what CI runs daily)
node scripts/refresh.ts --full         # re-read everything; hours of rate-limit waiting
node scripts/backfill.ts               # one-time domain enumeration by star bands
npm --prefix fastagent test            # unit tests
npm --prefix fastagent run typecheck
fastagent start --bind 127.0.0.1       # makes the schedules fire; they do not run otherwise
fastagent schedule history judge-backlog
```

## Decisions worth keeping

Each of these came from a failure, and reversing one re-creates it.

- **A listed project skips the discovery floor.** Only a judgement removes something from the index, never a ranking wobble. Without this, Claude Code, LangGraph, LiteLLM, Mastra and Langfuse all vanished in one run because their search ranking dipped.
- **Rows key on the name GitHub resolves to.** A renamed repository still answers on its old path, which listed `block/goose` and `aaif-goose/goose` as two projects.
- **`days || 999` is a bug.** Zero is falsy, so "created today" was discarded; it hid a month of user issues.
- **Only freshly read projects enter `snapshots.csv`.** Repeating a carried-forward star count invents a velocity of zero.
- **Velocity falls back to the oldest snapshot at least a day old.** A seven-day window against a three-day history reports nothing at all.
- **ETags are saved in discovery too.** A 304 costs no rate limit; not storing the tag re-reads thousands of repositories at full price.
- **The rate-limit backoff re-checks every minute** rather than sleeping the whole window: the quota can refill early, and one long sleep kept working for 55 minutes after the limit had cleared.
- **Re-judgement is driven by evidence, not a calendar.** `review-queue` surfaces archived, renamed, silent or mis-filed projects; most projects do not change in a month and the ones that matter change the week they pivot.
- **Backlog judging is a schedule, not a loop.** A shell loop treated a model usage limit as a reason to continue and called 262 more times, judging nothing.
- **Installs come only from packages declared in `overrides.json`.** Reading the name from a root manifest gave `vercel/ai` as "ai-repo" at 3 downloads a week.
- **Scores compare inside one layer only**, and every input is printed in the same row so the arithmetic is checkable.

## Operating notes

- Schedules fire only while `fastagent start` (or a deployment) is running. There is no resident host yet; AgentCore deployment is the open item.
- Model credentials live in `fastagent/.secrets/auth.json` (gitignored). `fastagent login openai-codex` from this directory replaces them.
- The GitHub Action measures only. Judging needs a model, and a public repository holds no model credentials — that split is why deployment matters.
- The organisation requires actions pinned to commit SHAs, and the default workflow token is read-only; `measure.yml` asks for `contents: write` explicitly. See `CONTRIBUTING.md`.
- `node scripts/refresh.ts` at this size is minutes when tiering works and hours when it does not. If a run takes hours, check how many rows were carried forward.

## State on 2026-09-17

- 2,750 projects published across 16 layers; 1,091 carry a measured velocity.
- 4,188 verdicts recorded, 4,842 candidates still queued from the domain backfill.
- Judging is limited by the model's usage window, not by the clock: roughly 500 verdicts a day.
- `CHANGES.md` has real content for the first time: fastest gainers, new-and-already-scoring, and listed-but-no-longer-shipping.

## Open items

1. **Switch the Codex account.** The backlog is limited by the model usage window. Stop the server, run
   `fastagent login openai-codex` from this directory, authorise a different account in a private
   browser window, then restart. The previous credentials were backed up outside the repository.
2. **Deploy to AWS AgentCore.** EventBridge drives the schedules, so judging and curation stop depending
   on a laptop, and the deployment carries its own model credentials.
3. **Finish the backlog**, then let `daily-curate` handle the incremental queue.
4. A watchdog script lives outside the repository while the agent runs locally: FastAgent has no
   per-turn timeout, and a hung model call blocked the scheduler for up to an hour. Deployment removes
   the need for it.
