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
import statistics
import sys
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOTS = ROOT / "data" / "snapshots.csv"
LATEST = ROOT / "data" / "latest.json"
README = ROOT / "README.md"
API = "https://api.github.com"
NOW = datetime.now(UTC)
OUTSIDE = {"NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN"}
# A release body shorter than this says "v1.2.3" and nothing about what changed for the user.
NOTE_CHARS = 80


def api(path: str):
    request = urllib.request.Request(
        API + path,
        headers={"user-agent": "ai-agent-stack", "accept": "application/vnd.github+json",
                 **({"authorization": f"Bearer {os.environ['GITHUB_TOKEN']}"} if os.environ.get("GITHUB_TOKEN") else {})},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def days_since(timestamp: str | None) -> int | None:
    if not timestamp:
        return None
    # Clamp: GitHub timestamps can sit a few seconds in the future against our clock.
    return max(0, (NOW - datetime.fromisoformat(timestamp.replace("Z", "+00:00"))).days)


def within(days: int | None, limit: int) -> bool:
    """`days or 999` silently drops everything that happened today, because 0 is falsy."""
    return days is not None and days <= limit


def measure(repo: str) -> dict | None:
    try:
        info = api(f"/repos/{repo}")
    except urllib.error.HTTPError as error:
        print(f"  skip {repo}: {error.code}", file=sys.stderr)
        return None
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
    return {
        "repo": repo,
        "user_issues_truncated": truncated,
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


def table(rows: list[dict]) -> str:
    head = ("| Project | Stars | Stars/day | Last release with notes | Releases (90d) | User issues (30d) | Answered | Last push |\n"
            "|---|---:|---:|---:|---:|---:|---:|---:|\n")
    lines = []
    for row in rows:
        release = f"{row['last_release_days']}d ago" if row["last_release_days"] is not None else "—"
        push = f"{row['pushed_days']}d ago" if row["pushed_days"] is not None else "—"
        pace = f"+{row['velocity']}" if row.get("velocity") else "—"
        issues = f"{row['user_issues_30d']}{'+' if row.get('user_issues_truncated') else ''}"
        answered = f"{row['user_issues_answered_30d']}/{row['user_issues_30d']}" if row["user_issues_30d"] else "—"
        lines.append(
            f"| [{row['repo']}](https://github.com/{row['repo']})<br><sub>{row['description'][:90]}</sub> "
            f"| {row['stars']:,} | {pace} | {release} | {row['releases_with_notes_90d']} | {issues} | {answered} | {push} |"
        )
    return head + "\n".join(lines) + "\n"


def main() -> None:
    seeds = json.loads((ROOT / "seeds.json").read_text())
    history = load_previous()
    measured_at = NOW.isoformat()
    results, snapshot_rows = [], []

    for category in seeds["categories"]:
        rows = []
        for repo in category["repos"]:
            row = measure(repo)
            if not row:
                continue
            row["velocity"] = velocity(repo, row["stars"], history)
            row["category"] = category["id"]
            rows.append(row)
            snapshot_rows.append([measured_at, repo, row["stars"], row["pushed_days"], row["user_issues_30d"]])
            print(f"  {repo:<40} {row['stars']:>8,} stars")
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

    all_rows = [row for category in results for row in category["rows"]]
    shipping = [r for r in all_rows if within(r["last_release_days"], 30)]
    body = [
        f"<!-- generated by scripts/collect.py on {NOW:%Y-%m-%d}; edits here are overwritten -->",
        "",
        f"**{len(all_rows)} open-source projects across {len(results)} layers, measured {NOW:%Y-%m-%d}.** "
        f"{len(shipping)} shipped a release with real notes in the last 30 days; "
        f"{len([r for r in all_rows if not within(r['pushed_days'], 30)])} have not been touched in a month.",
        "",
    ]
    for category in results:
        body += [f"## {category['title']}", "", category["blurb"], "", table(category["rows"]), ""]
    body += [
        "## How to read this",
        "",
        "- **Stars/day** comes from comparing snapshots in [`data/snapshots.csv`](data/snapshots.csv). A first measurement has none, so the column fills in from the second run onwards.",
        "- **Last release with notes** ignores tags whose body is a version number. A release that does not say what changed for the user is a code change, not a release.",
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
