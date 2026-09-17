import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ASSET_LAYERS, LAYERS, layerById } from "./layers.ts";
import { measureRepo, scoreProject, type Metrics, type Scores } from "./measure.ts";
import { pooled, saveEtags, within } from "./github.ts";

/** The front page ranks; a layer page lists. A navigation site needs both. */
const TOP_PER_LAYER = 12;
/**
 * Not everything is re-read every day. At 9,000 projects a full pass is 27,000 API calls — over five
 * hours of waiting on a 5,000/hour limit, and past the six-hour ceiling on a GitHub Actions job.
 *
 * So measurement is tiered by how much the number would move: what the page ranks highly, what is
 * actively being worked on, and what has simply not been read for a while. Everything else is carried
 * forward from the last run with its age printed, which is honest and free.
 */
const ALWAYS_MEASURE_TOP = 20;
const STALE_DAYS = 7;
const ACTIVE_PUSH_DAYS = 14;
const SNAPSHOTS = "data/snapshots.csv";

export type Row = Metrics & Scores & { category: string; starsPerDay?: number; starsPerDayMonth?: number; measuredDaysAgo?: number };

type Seeds = { categories: { id: string; title: string; blurb: string; repos: (string | { repo: string; package?: string })[] }[] };

/**
 * Star velocity over a window. Taking the oldest snapshot instead turns "gaining now" into "average
 * since we started watching" within weeks, which is the number nobody wants.
 */
async function velocities(workspace: string, windowDays: number): Promise<Map<string, number>> {
  const path = resolve(workspace, SNAPSHOTS);
  if (!existsSync(path)) return new Map();
  const series = new Map<string, { at: number; stars: number }[]>();
  for (const line of (await readFile(path, "utf8")).split("\n").slice(1)) {
    const [at, repo, stars] = line.split(",");
    if (!repo) continue;
    series.set(repo, [...(series.get(repo) ?? []), { at: Date.parse(at), stars: Number(stars) }]);
  }
  const out = new Map<string, number>();
  for (const [repo, points] of series) {
    points.sort((a, b) => a.at - b.at);
    const now = points[points.length - 1];
    // The most recent snapshot at least a window old: a comparison point hours away is rounding noise.
    const earlier = [...points].reverse().find((point) => now.at - point.at >= windowDays * 86_400_000);
    if (earlier) out.set(repo, ((now.stars - earlier.stars) / (now.at - earlier.at)) * 86_400_000);
  }
  return out;
}

/** Rows from the last run, so a skipped project keeps its numbers instead of vanishing from the page. */
async function previousRows(workspace: string): Promise<Map<string, Row & { measuredAt?: string }>> {
  const path = resolve(workspace, "data/latest.json");
  if (!existsSync(path)) return new Map();
  const previous = JSON.parse(await readFile(path, "utf8")) as { measuredAt: string; categories: { rows: Row[] }[] };
  return new Map(previous.categories.flatMap((category) => category.rows.map((row) => [row.repo, { ...row, measuredAt: previous.measuredAt }])));
}

export async function refresh(workspace: string, full = false) {
  const seeds = JSON.parse(await readFile(resolve(workspace, "seeds.json"), "utf8")) as Seeds;
  const previous = await previousRows(workspace);
  const [week, month] = [await velocities(workspace, 7), await velocities(workspace, 30)];
  const measuredAt = new Date().toISOString();
  const snapshot: string[] = [];
  const results: { id: string; title: string; blurb: string; rows: Row[] }[] = [];

  let reused = 0;
  for (const category of seeds.categories) {
    const ranked = [...category.repos].sort((a, b) => {
      const key = (entry: string | { repo: string }) => (typeof entry === "string" ? entry : entry.repo);
      return (previous.get(key(b))?.score ?? 0) - (previous.get(key(a))?.score ?? 0);
    });
    const due = (entry: string | { repo: string }, index: number) => {
      if (full || index < ALWAYS_MEASURE_TOP) return true;
      const before = previous.get(typeof entry === "string" ? entry : entry.repo);
      if (!before?.measuredAt) return true;
      const age = (Date.now() - Date.parse(before.measuredAt)) / 86_400_000;
      return age >= STALE_DAYS || within(before.pushedDays, ACTIVE_PUSH_DAYS);
    };
    const plan = ranked.map((entry, index) => ({ entry, measure: due(entry, index) }));
    const measured = await pooled(plan, 6, async ({ entry, measure }) => ({
      fresh: measure,
      metrics: measure ? await measureRepo(entry, workspace, ASSET_LAYERS.has(category.id)) : previous.get(typeof entry === "string" ? entry : entry.repo),
    }));
    reused += plan.filter((item) => !item.measure).length;
    const rows: Row[] = [];
    for (const { fresh, metrics } of measured) {
      if (!metrics) continue;
      // A week is the shortest span that is not noise; the month is kept for the changes page.
      const starsPerDay = week.get(metrics.repo) ?? month.get(metrics.repo);
      rows.push({
        ...metrics,
        ...scoreProject(metrics, starsPerDay, ASSET_LAYERS.has(category.id)),
        category: category.id,
        starsPerDay,
        starsPerDayMonth: month.get(metrics.repo),
        measuredDaysAgo: fresh ? 0 : Math.round((Date.now() - Date.parse((metrics as Row & { measuredAt?: string }).measuredAt ?? measuredAt)) / 86_400_000),
      });
      // Only freshly read projects enter the history: carrying a stale star count forward would
      // invent a velocity of zero for everything the tiering skipped.
      if (fresh) snapshot.push([measuredAt, metrics.repo, metrics.stars, metrics.pushedDays ?? "", metrics.userIssues30d].join(","));
    }
    const canonical = new Map<string, Row>();
    for (const row of rows) {
      const key = row.repo.toLowerCase();
      const existing = canonical.get(key);
      if (!existing || row.score > existing.score) canonical.set(key, row);
    }
    const rows2 = [...canonical.values()].sort((a, b) => b.score - a.score || b.stars - a.stars);
    rows.length = 0;
    rows.push(...rows2);
    results.push({ id: category.id, title: category.title, blurb: category.blurb, rows });
    console.log(`-- ${category.title}: ${rows.length} rows (${plan.filter((item) => item.measure).length} read, ${plan.filter((item) => !item.measure).length} carried forward)`);
  }

  const path = resolve(workspace, SNAPSHOTS);
  if (!existsSync(path)) await writeFile(path, "measured_at,repo,stars,pushed_days,user_issues_30d\n");
  await appendFile(path, `${snapshot.join("\n")}\n`);
  await writeFile(resolve(workspace, "data/latest.json"), `${JSON.stringify({ measuredAt, categories: results }, null, 1)}\n`);
  // A stable, documented shape for anyone who wants the data rather than the page.
  await writeFile(
    resolve(workspace, "data/index.json"),
    `${JSON.stringify(
      {
        measuredAt,
        source: "https://github.com/fastagent-sh/ai-agent-stack",
        licence: "MIT",
        scoring: "score = mean(adoption, upkeep, growth, answers); comparable within a layer only",
        projects: results.flatMap((category) =>
          category.rows.map((row) => ({
            repo: row.repo,
            layer: category.id,
            layerTitle: category.title,
            description: row.description,
            archived: row.archived,
            stars: row.stars,
            starsPerDay7d: row.starsPerDay ?? null,
            starsPerDay30d: row.starsPerDayMonth ?? null,
            weeklyDownloads: row.weeklyDownloads ?? null,
            lastReleaseDays: row.lastReleaseDays ?? null,
            releasesWithNotes90d: row.releasesWithNotes90d,
            commits90d: row.commits90d,
            userIssues30d: row.userIssues30d,
            userIssuesAnswered30d: row.userIssuesAnswered30d,
            scores: { adoption: row.adoption, upkeep: row.upkeep, growth: row.growth ?? null, answers: row.answers ?? null, score: row.score },
          })),
        ),
      },
      null,
      1,
    )}\n`,
  );
  await saveEtags();
  await writePages(workspace, results, measuredAt);
  await writeChanges(workspace, results);
  return { measuredAt, projects: results.reduce((sum, category) => sum + category.rows.length, 0), layers: results.length, carriedForward: reused };
}

const cell = (row: Row) =>
  `| [${row.repo}](https://github.com/${row.repo})${row.archived ? " ⚠️ archived" : ""}${row.measuredDaysAgo ? ` <sub title="last read ${row.measuredDaysAgo}d ago">·${row.measuredDaysAgo}d</sub>` : ""}<br><sub>${row.description.slice(0, 90)}</sub> | **${row.score}** | ${row.adoption} | ${row.upkeep} | ${row.growth ?? "—"} | ${row.answers ?? "—"} | ${row.stars.toLocaleString()} | ${row.starsPerDay ? `+${row.starsPerDay.toFixed(0)}` : "—"} `;

function table(rows: Row[], asset: boolean): string {
  const head = asset
    ? "| Project | Score | Adoption | Upkeep | Growth | Answers | Stars | Stars/day | Commits (90d) | User issues (30d) |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n"
    : "| Project | Score | Adoption | Upkeep | Growth | Answers | Stars | Stars/day | Weekly installs | Last release | User issues (30d) |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n";
  return (
    head +
    rows
      .map((row) => {
        const issues = `${row.userIssues30d}${row.userIssuesTruncated ? "+" : ""}`;
        if (asset) return `${cell(row)}| ${row.commits90d}${row.commits90d >= 100 ? "+" : ""} | ${issues} |`;
        const installs = row.weeklyDownloads ? row.weeklyDownloads.toLocaleString() : "—";
        const release = row.lastReleaseDays === undefined ? "—" : `${row.lastReleaseDays}d ago`;
        return `${cell(row)}| ${installs} | ${release} | ${issues} |`;
      })
      .join("\n") +
    "\n"
  );
}

async function writePages(workspace: string, results: { id: string; title: string; blurb: string; rows: Row[] }[], measuredAt: string) {
  const all = results.flatMap((category) => category.rows);
  const day = measuredAt.slice(0, 10);
  const body = [
    `<!-- generated by the pipeline on ${day}; edits here are overwritten -->`,
    "",
    `**${all.length} open-source projects across ${results.length} layers, measured ${day}.** ` +
      `${all.filter((row) => within(row.lastReleaseDays, 30)).length} shipped a release with real notes in the last 30 days; ` +
      `${all.filter((row) => !ASSET_LAYERS.has(row.category) && row.releasesWithNotes90d === 0).length} have shipped none in 90.`,
    "",
  ];
  await mkdir(resolve(workspace, "layers"), { recursive: true });
  for (const category of results) {
    const asset = ASSET_LAYERS.has(category.id);
    const top = category.rows.slice(0, TOP_PER_LAYER);
    body.push(`## ${category.title}`, "", category.blurb, "", table(top, asset));
    if (category.rows.length > top.length) body.push(`\n[All ${category.rows.length} projects in this layer →](layers/${category.id}.md)`);
    body.push("");
    await writeFile(
      resolve(workspace, `layers/${category.id}.md`),
      [
        `# ${category.title}`, "", category.blurb, "",
        `*${category.rows.length} projects, measured ${day}. [Back to the stack](../README.md).*`, "",
        table(category.rows, asset), "",
        "Columns are explained on the [main page](../README.md#how-to-read-this).", "",
      ].join("\n"),
    );
  }
  body.push(...howToRead());
  const readme = await readFile(resolve(workspace, "README.md"), "utf8");
  await writeFile(resolve(workspace, "README.md"), readme.split("<!-- BEGIN -->")[0] + "<!-- BEGIN -->\n" + body.join("\n"));
}

const howToRead = () => [
  "## How to read this",
  "",
  "**Score** averages four sub-scores and compares projects *inside one layer only*. The shape follows " +
    "[npms.io](https://github.com/npms-io/npms-analyzer), which scores packages on separate axes rather than one number, and " +
    "[Libraries.io's SourceRank 2.0](https://github.com/librariesio/libraries.io/issues/1916), whose goals are a score comparable " +
    "within an ecosystem, readable without explanation, and published with its breakdown.",
  "",
  "| Sub-score | Built from | Why |",
  "|---|---|---|",
  "| **Adoption** | stars and weekly installs, log scaled | Stars can be bought, so they are compressed hard and an install counts for more |",
  "| **Upkeep** | how recently a release with real notes shipped, and how many in 90 days (commits, for skills) | Attention is not maintenance |",
  "| **Growth** | stars per day between snapshots; for a project measured once, its lifetime average, discounted | A project published this month cannot show velocity yet, and should not score zero for it |",
  "| **Answers** | share of the last 30 days' user issues that got a reply, weighted by how many | Answering half of forty beats answering both of two. Shown as — under three issues |",
  "",
  "A composite score can be gamed — [there is a paper on exactly that for SourceRank](https://arxiv.org/html/2512.24400v1) — so every " +
    "input is printed in the same row. If a score looks wrong, the arithmetic is checkable.",
  "",
  "- **User issues** counts issues opened in the last 30 days by someone who is not a maintainer, via GitHub's `author_association`. It separates a project with users from one with an author. A `+` means the count filled an API page.",
  `- Not every project is re-read every day: the ${TOP_PER_LAYER * 2} highest scoring in each layer and anything pushed recently are read on every run, the rest at least weekly. A row carried forward shows how many days ago it was read.`,
  "- Every number here is also published as JSON at [`data/index.json`](data/index.json), regenerated with the page.",
  "- **Weekly installs** is npm or PyPI downloads for a package declared in [`overrides.json`](overrides.json). Detecting it from a repository's root manifest was tried and removed: in a monorepo it reads the placeholder package.",
  "",
];

/** The diff nobody else can publish, because it needs a history of snapshots. */
async function writeChanges(workspace: string, results: { rows: Row[] }[]) {
  const rows = results.flatMap((category) => category.rows).filter((row) => row.starsPerDay !== undefined);
  const day = new Date().toISOString().slice(0, 10);
  if (!rows.length) {
    await writeFile(
      resolve(workspace, "CHANGES.md"),
      "# Changes\n\nNot yet: velocity needs two snapshots at least a day apart, and only one measurement exists.\nThis page fills in after the next run.\n",
    );
    return;
  }
  const rising = [...rows].sort((a, b) => (b.starsPerDay ?? 0) - (a.starsPerDay ?? 0)).slice(0, 15);
  const fresh = [...rows].filter((row) => row.createdDays <= 60).sort((a, b) => b.score - a.score).slice(0, 10);
  const stalled = [...rows].filter((row) => (row.lastReleaseDays ?? 0) > 60 && !ASSET_LAYERS.has(row.category)).sort((a, b) => b.stars - a.stars).slice(0, 10);
  const line = (row: Row) => `| [${row.repo}](https://github.com/${row.repo}) | ${layerById(row.category)?.title ?? row.category} | ${row.stars.toLocaleString()} | +${(row.starsPerDay ?? 0).toFixed(0)}/day | ${row.score} |`;
  await writeFile(
    resolve(workspace, "CHANGES.md"),
    [
      `# Changes — ${day}`, "", "[Back to the stack](README.md).", "",
      "## Gaining fastest", "", "| Project | Layer | Stars | Pace | Score |", "|---|---|---:|---:|---:|",
      ...rising.map(line), "",
      ...(fresh.length ? ["## New and already scoring", "", "Created in the last 60 days.", "", "| Project | Layer | Stars | Pace | Score |", "|---|---|---:|---:|---:|", ...fresh.map(line), ""] : []),
      ...(stalled.length ? ["## Listed, no longer shipping", "", "No release with real notes for over two months. Attention is not maintenance.", "", "| Project | Layer | Stars | Pace | Score |", "|---|---|---:|---:|---:|", ...stalled.map(line), ""] : []),
    ].join("\n"),
  );
}
