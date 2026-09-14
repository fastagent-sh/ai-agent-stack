#!/usr/bin/env python3
"""What changed in the stack this week.

The snapshots exist anyway, so the diff between them is free — and it is the one thing a list of links
can never have. A reader who already knows the landscape does not need the landscape again; they need
to know what moved since they last looked.

Writes CHANGES.md. Needs at least two snapshots taken a few days apart, so it produces nothing on the
first run and says so.

Usage: python3 scripts/changes.py [--days 7]
"""
from __future__ import annotations

import csv
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOTS = ROOT / "data" / "snapshots.csv"
OUT = ROOT / "CHANGES.md"
NOW = datetime.now(UTC)


def history() -> dict[str, list[tuple[datetime, int]]]:
    series: dict[str, list[tuple[datetime, int]]] = {}
    for row in csv.DictReader(SNAPSHOTS.open()):
        series.setdefault(row["repo"], []).append((datetime.fromisoformat(row["measured_at"]), int(row["stars"])))
    for points in series.values():
        points.sort()
    return series


def main() -> None:
    days = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 7
    series = history()
    latest = json.loads((ROOT / "data" / "latest.json").read_text())
    described = {row["repo"]: row for category in latest["categories"] for row in category["rows"]}
    titles = {category["id"]: category["title"] for category in latest["categories"]}

    moves = []
    for repo, points in series.items():
        if len(points) < 2:
            continue
        now_at, now_stars = points[-1]
        # The oldest point still inside the window, so a weekly run compares week to week.
        # Two snapshots hours apart say nothing. The first run of the day produced "risers" that were
        # really rounding, so a comparison point has to be at least a day old.
        earlier = [p for p in points if (now_at - p[0]).total_seconds() >= 86400]
        if not earlier:
            continue
        then_at, then_stars = ([p for p in earlier if (now_at - p[0]).days >= days] or earlier)[-1]
        span = (now_at - then_at).total_seconds() / 86400
        moves.append({
            "repo": repo,
            "gained": now_stars - then_stars,
            "per_day": (now_stars - then_stars) / span,
            "stars": now_stars,
            "span": round(span),
            "row": described.get(repo, {}),
        })

    if not moves:
        OUT.write_text(
            "# Changes\n\nNot yet: velocity needs two snapshots taken at least a day apart, and only one\n"
            "measurement exists so far. This page fills in after the next weekly run.\n"
        )
        print("only one snapshot so far; nothing to diff")
        return

    moves.sort(key=lambda move: -move["per_day"])
    rising = moves[:15]
    # Projects that stopped shipping are the other half of the story, and nobody publishes it.
    stalled = sorted(
        (m for m in moves if (m["row"].get("last_release_days") or 0) > 60 and m["row"].get("category")),
        key=lambda move: -move["stars"],
    )[:10]

    lines = [
        f"# Changes — week of {NOW:%Y-%m-%d}",
        "",
        f"Measured against the snapshot {rising[0]['span']} days earlier. "
        "[Back to the stack](README.md).",
        "",
        "## Gaining fastest",
        "",
        "| Project | Layer | Stars | Gained | Per day |",
        "|---|---|---:|---:|---:|",
    ]
    for move in rising:
        layer = titles.get(move["row"].get("category"), "")
        lines.append(f"| [{move['repo']}](https://github.com/{move['repo']}) | {layer} | {move['stars']:,} | +{move['gained']:,} | +{move['per_day']:.0f} |")

    if stalled:
        lines += [
            "",
            "## Still listed, no longer shipping",
            "",
            "Projects with no release carrying real notes for over two months. Attention is not maintenance.",
            "",
            "| Project | Layer | Stars | Last release with notes |",
            "|---|---|---:|---:|",
        ]
        for move in stalled:
            layer = titles.get(move["row"].get("category"), "")
            lines.append(f"| [{move['repo']}](https://github.com/{move['repo']}) | {layer} | {move['stars']:,} | {move['row'].get('last_release_days')}d ago |")

    OUT.write_text("\n".join(lines) + "\n")
    print(f"{len(rising)} rising, {len(stalled)} stalled, written to CHANGES.md")


if __name__ == "__main__":
    main()
