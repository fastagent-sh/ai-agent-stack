#!/usr/bin/env python3
"""Measure every seeded repository and regenerate README.md.

The page answers one question a curated link list cannot: **is this project still shipping, and to
whom?** So every column is an observation, not an opinion:

- `stars/day` needs two snapshots, which is why `data/snapshots.csv` is append-only. A single scrape
  cannot tell a project that grew this week from one that grew in 2024.
- a release **with notes** is the only evidence of user-facing change; a tag whose body is a version
  number is a code change, and is not counted.
- issues opened by non-maintainers, via GitHub's own `author_association`, separate a project with
  users from a project with an author.

Usage: GITHUB_TOKEN=... python3 scripts/collect.py
"""
from __future__ import annotations

import csv
import json
import os
import re
import urllib.parse
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LAYER_PAGES = ROOT / "layers"
# The front page ranks; the layer page lists. A navigation site needs both.
TOP_PER_LAYER = 12
# Skills and prompt packs have no releases to count, so they are measured on commits instead.
ASSET_LAYERS = {"skills"}
SNAPSHOTS = ROOT / "data" / "snapshots.csv"
LATEST = ROOT / "data" / "latest.json"
README = ROOT / "README.md"
API = "https://api.github.com"
DOWNLOAD_CACHE = ROOT / "data" / ".package-cache.json"
NOW = datetime.now(UTC)
OUTSIDE = {"NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN"}
# A release body shorter than this says "v1.2.3" and nothing about what changed for the user.
NOTE_CHARS = 80


def api(path: str, attempts: int = 3):
    request = urllib.request.Request(
        API + path,
        headers={"user-agent": "ai-agent-stack", "accept": "application/vnd.github+json",
                 **({"authorization": f"Bearer {os.environ['GITHUB_TOKEN']}"} if os.environ.get("GITHUB_TOKEN") else {})},
    )
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError:
            raise
        except Exception:
            # Connections drop under concurrency; one flaky read should not end a 400-repo sweep.
            if attempt == attempts - 1:
                raise
            time.sleep(2 * (attempt + 1))


def http_json(url: str):
    request = urllib.request.Request(url, headers={"user-agent": "ai-agent-stack"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


_package_cache: dict[str, dict] = json.loads(DOWNLOAD_CACHE.read_text()) if DOWNLOAD_CACHE.exists() else {}
_cache_lock = threading.Lock()
# pypistats answers 429 under concurrency, so registry reads are taken one at a time. There are only a
# handful of declared packages, so the wait costs nothing.
_registry_lock = threading.Lock()


def package_downloads(repo: str, declared: str | None) -> tuple[str, int] | tuple[None, None]:
    """
    Weekly installs, which is closer to use than a star: a star is a bookmark, an install is a
    dependency.

    The package must be declared in seeds.json as `npm:name` or `pypi:name`. Detecting it from the
    repository's root manifest was tried and removed: in a monorepo the root package is a placeholder,
    so vercel/ai resolved to "ai-repo" at 3 downloads a week against millions for the real package. A
    number that is quietly wrong is worse for this page than no number at all.
    """
    if not declared:
        return (None, None)
    # Six threads writing one file produced a corrupt cache on the first run; keep it in memory.
    with _cache_lock:
        entry = _package_cache.get(repo)
    if entry:
        return entry.get("package"), entry.get("weekly")
    registry, _, name = declared.partition(":")
    found: tuple[str | None, int | None] = (declared, None)
    with _registry_lock:
        for attempt in range(3):
            try:
                if registry == "npm":
                    found = (declared, http_json(f"https://api.npmjs.org/downloads/point/last-week/{urllib.parse.quote(name, safe='@/')}")["downloads"])
                elif registry == "pypi":
                    found = (declared, http_json(f"https://pypistats.org/api/packages/{name.lower().replace('_', '-')}/recent")["data"]["last_week"])
                break
            except Exception:  # noqa: BLE001 - a registry outage is a gap, not a zero
                time.sleep(5 * (attempt + 1))
        time.sleep(1)
    with _cache_lock:
        _package_cache[repo] = {"package": found[0], "weekly": found[1]}
    return found


def days_since(timestamp: str | None) -> int | None:
    if not timestamp:
        return None
    # Clamp: GitHub timestamps can sit a few seconds in the future against our clock.
    return max(0, (NOW - datetime.fromisoformat(timestamp.replace("Z", "+00:00"))).days)


def within(days: int | None, limit: int) -> bool:
    """`days or 999` silently drops everything that happened today, because 0 is falsy."""
    return days is not None and days <= limit


def measure(entry: str | dict) -> dict | None:
    """Seeds hold either "owner/repo" or {"repo": ..., "package": "npm:name"}."""
    try:
        return _measure(entry)
    except Exception as error:  # noqa: BLE001 - a repository we cannot read is a gap, not a crash
        print(f"  skip {entry}: {error}", file=sys.stderr)
        return None


def _measure(entry: str | dict) -> dict | None:
    repo = entry if isinstance(entry, str) else entry["repo"]
    declared = None if isinstance(entry, str) else entry.get("package")
    info = api(f"/repos/{repo}")
    releases = api(f"/repos/{repo}/releases?per_page=30")
    issues = api(f"/repos/{repo}/issues?state=all&sort=created&direction=desc&per_page=100")

    with_notes = [r for r in releases if len((r.get("body") or "").replace("#", "").strip()) >= NOTE_CHARS]
    recent_notes = [r for r in with_notes if within(days_since(r.get("published_at")), 90)]
    outside_issues = [
        i for i in issues
        if not i.get("pull_request") and i.get("author_association") in OUTSIDE and within(days_since(i["created_at"]), 30)
    ]
    answered = [i for i in outside_issues if i.get("comments", 0) > 0]
    # One page is 100 issues. A very busy tracker hits that ceiling, so the count is a floor, not a total.
    truncated = len(issues) == 100 and all(within(days_since(i["created_at"]), 30) for i in issues)
    package, weekly = package_downloads(repo, declared)
    commits_90d = 0
    try:
        since = (NOW - timedelta(days=90)).strftime("%Y-%m-%dT%H:%M:%SZ")
        page = api(f"/repos/{repo}/commits?since={since}&per_page=100")
        commits_90d = len(page)  # one page; 100 means "at least 100"
    except Exception:  # noqa: BLE001 - an empty or unreadable history is not a crash
        pass
    return {
        "repo": repo,
        "user_issues_truncated": truncated,
        "commits_90d": commits_90d,
        "package": package,
        "weekly_downloads": weekly,
        "name": info["name"],
        "description": (info.get("description") or "").strip(),
        "stars": info["stargazers_count"],
        "language": info.get("language") or "",
        "license": ((info.get("license") or {}).get("spdx_id") or "").replace("NOASSERTION", ""),
        "pushed_days": days_since(info["pushed_at"]),
        "last_release_days": days_since(with_notes[0]["published_at"]) if with_notes else None,
        "releases_with_notes_90d": len(recent_notes),
        "user_issues_30d": len(outside_issues),
        "user_issues_answered_30d": len(answered),
    }


def load_previous() -> dict[str, list[tuple[str, int]]]:
    history: dict[str, list[tuple[str, int]]] = {}
    if SNAPSHOTS.exists():
        for row in csv.DictReader(SNAPSHOTS.open()):
            history.setdefault(row["repo"], []).append((row["measured_at"], int(row["stars"])))
    return history


def velocity(repo: str, stars: int, history: dict) -> float | None:
    """Stars per day since the oldest snapshot we hold. Needs a previous run; None on the first."""
    points = sorted(history.get(repo, []))
    if not points:
        return None
    when, then = points[0]
    days = (NOW - datetime.fromisoformat(when)).total_seconds() / 86400
    return round((stars - then) / days, 1) if days >= 1 else None


def table(rows: list[dict], asset_layer: bool = False) -> str:
    """Asset layers get different columns: a folder of skills has no releases to count."""
    if asset_layer:
        head = ("| Project | Stars | Stars/day | Commits (90d) | User issues (30d) | Answered | Last push |\n"
                "|---|---:|---:|---:|---:|---:|---:|\n")  # asset layers publish no package
    else:
        head = ("| Project | Stars | Stars/day | Weekly installs | Last release with notes | Releases (90d) | User issues (30d) | Answered |\n"
                "|---|---:|---:|---:|---:|---:|---:|---:|\n")
    lines = []
    for row in rows:
        release = f"{row['last_release_days']}d ago" if row["last_release_days"] is not None else "—"
        push = f"{row['pushed_days']}d ago" if row["pushed_days"] is not None else "—"
        pace = f"+{row['velocity']}" if row.get("velocity") else "—"
        issues = f"{row['user_issues_30d']}{'+' if row.get('user_issues_truncated') else ''}"
        answered = f"{row['user_issues_answered_30d']}/{row['user_issues_30d']}" if row["user_issues_30d"] else "—"
        name = f"| [{row['repo']}](https://github.com/{row['repo']})<br><sub>{row['description'][:90]}</sub> | {row['stars']:,} | {pace} "
        if asset_layer:
            commits = f"{row['commits_90d']}{'+' if row['commits_90d'] >= 100 else ''}"
            lines.append(name + f"| {commits} | {issues} | {answered} | {push} |")
        else:
            installs = f"{row['weekly_downloads']:,}" if row.get("weekly_downloads") else "—"
            lines.append(name + f"| {installs} | {release} | {row['releases_with_notes_90d']} | {issues} | {answered} |")
    return head + "\n".join(lines) + "\n"


def main() -> None:
    seeds = json.loads((ROOT / "seeds.json").read_text())
    history = load_previous()
    measured_at = NOW.isoformat()
    results, snapshot_rows = [], []

    for category in seeds["categories"]:
        print(f"-- {category['title']}")
        with ThreadPoolExecutor(max_workers=6) as runner:
            measured = list(runner.map(measure, category["repos"]))
        rows = []
        for row in measured:
            if not row:
                continue
            row["velocity"] = velocity(row["repo"], row["stars"], history)
            row["category"] = category["id"]
            rows.append(row)
            snapshot_rows.append([measured_at, row["repo"], row["stars"], row["pushed_days"], row["user_issues_30d"]])
        print(f"   {len(rows)} measured")
        rows.sort(key=lambda r: (-(r["velocity"] or 0), -r["stars"]))
        results.append({**category, "rows": rows})

    SNAPSHOTS.parent.mkdir(exist_ok=True)
    new_file = not SNAPSHOTS.exists()
    with SNAPSHOTS.open("a", newline="") as handle:
        writer = csv.writer(handle)
        if new_file:
            writer.writerow(["measured_at", "repo", "stars", "pushed_days", "user_issues_30d"])
        writer.writerows(snapshot_rows)
    LATEST.write_text(json.dumps({"measured_at": measured_at, "categories": results}, indent=1) + "\n")
    DOWNLOAD_CACHE.write_text(json.dumps(_package_cache))

    all_rows = [row for category in results for row in category["rows"]]
    shipping = [r for r in all_rows if within(r["last_release_days"], 30)]
    body = [
        f"<!-- generated by scripts/collect.py on {NOW:%Y-%m-%d}; edits here are overwritten -->",
        "",
        f"**{len(all_rows)} open-source projects across {len(results)} layers, measured {NOW:%Y-%m-%d}.** "
        f"{len(shipping)} shipped a release with real notes in the last 30 days; "
        f"{len([r for r in all_rows if r['releases_with_notes_90d'] == 0 and r['category'] not in ASSET_LAYERS])} have shipped no release with notes in 90 days.",
        "",
    ]
    LAYER_PAGES.mkdir(exist_ok=True)
    for category in results:
        asset = category["id"] in ASSET_LAYERS
        top = category["rows"][:TOP_PER_LAYER]
        more = len(category["rows"]) - len(top)
        body += [
            f"## {category['title']}", "", category["blurb"], "", table(top, asset),
            f"\n[All {len(category['rows'])} projects in this layer →](layers/{category['id']}.md)" if more > 0 else "",
            "",
        ]
        rows = category["rows"]
        shipping = [r for r in rows if within(r["last_release_days"], 30)]
        responsive = sorted((r for r in rows if r["user_issues_30d"] >= 5), key=lambda r: -(r["user_issues_answered_30d"] / max(1, r["user_issues_30d"])))[:3]
        busiest = sorted(rows, key=lambda r: -r["user_issues_30d"])[:3]
        summary = (
            f"Of the {len(rows)} projects here, {len(shipping)} shipped a release with real notes in the last 30 days"
            + (f", and {len([r for r in rows if not within(r['last_release_days'], 90)])} have shipped none in 90" if not asset else "")
            + ". "
            + (f"Most user issues in the last 30 days: {', '.join(f'{r[chr(39)+chr(39)] if False else r["repo"]} ({r["user_issues_30d"]})' for r in busiest)}. " if busiest else "")
            + (f"Most of them answered: {', '.join(r['repo'] for r in responsive)}." if responsive else "")
        )
        page = [
            f"# {category['title']}", "", category["blurb"], "", summary, "",
            f"*{len(category['rows'])} open-source projects, measured {NOW:%Y-%m-%d}. "
            f"[Back to the stack](../README.md).*", "",
            table(category["rows"], asset), "",
            "Columns are explained in the [main page](../README.md#how-to-read-this). "
            "To propose a project, see [CONTRIBUTING.md](../CONTRIBUTING.md).", "",
        ]
        (LAYER_PAGES / f"{category['id']}.md").write_text("\n".join(page))
    body += [
        "## How to read this",
        "",
        "- **Weekly installs** is npm or PyPI downloads for the package the repository publishes, read from its own manifest. A star is a bookmark; an install is a dependency. A dash means the project ships no package.",
        "- **Stars/day** comes from comparing snapshots in [`data/snapshots.csv`](data/snapshots.csv). A first measurement has none, so the column fills in from the second run onwards.",
        "- **Last release with notes** ignores tags whose body is a version number. A release that does not say what changed for the user is a code change, not a release.",
        f"- Each layer page lists every project in it; the front page shows the {TOP_PER_LAYER} moving fastest.",
        "- **Commits (90d)** replaces the release columns for skills and prompt packs, which ship no releases. A `+` means the count filled an API page.",
        "- **User issues** counts issues opened in the last 30 days by someone who is not a maintainer, using GitHub's `author_association`. It separates a project that has users from a project that has an author. A `+` means the tracker filled a whole API page, so the number is a floor.",
        "- **Answered** is how many of those got at least one comment. It is a crude proxy for whether anyone is home.",
        "",
        "Stars measure attention, not quality, and none of these numbers say whether a project fits your problem. They say whether it is alive.",
        "",
    ]
    header = README.read_text().split("<!-- BEGIN -->")[0] if README.exists() else "# The open-source AI agent stack, measured weekly\n\n"
    README.write_text(header + "<!-- BEGIN -->\n" + "\n".join(body))
    print(f"\n{len(all_rows)} projects written to README.md")


if __name__ == "__main__":
    main()
