#!/usr/bin/env python3
"""Decide what each candidate actually is, by reading it.

Membership is a judgement, and a regular expression is a bad judge. The keyword filter it replaces let
in a Java interview guide ("covers ... AI application development"), a distributed database ("built for
agentic workloads") and a news dashboard ("AI-powered news aggregation") — none of them false
descriptions, all of them the wrong answer. In 2026 "AI" appears in nearly every repository blurb, so
the word carries no information.

So the model reads the README and answers two questions a pattern cannot: **is this part of the stack
you assemble to ship an agent**, and **which layer**. The mechanical bar stays mechanical — stars,
user issues, licence, last push are measurements, and nothing here overrides them.

The verdicts land in data/classified.json for a human to approve into seeds.json. Nothing is added to
the page by a model alone.

Usage: python3 scripts/classify.py [--batch 15] [--limit 999]
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENT_DIR = Path.home() / "coding" / "x-growth" / "fastagent"
CANDIDATES = ROOT / "data" / "candidates.json"
OUT = ROOT / "data" / "classified.json"
README_CHARS = 1200

PROMPT = """You are classifying open-source repositories for an index called "the open-source AI agent stack".

The index answers one question for someone building an agent product: what would you actually assemble
to ship and run an agent? Include a project only if a builder would reach for it as part of that stack.

Include an agent product itself when a builder would use, evaluate or fork it — a coding agent, a
research agent, a browser agent, a desktop assistant. Include the plumbing around it too: clients and
chat UIs, provider routers and account switchers, sandboxes, memory, evaluation.

Exclude, however popular: learning material, lesson repos and interview guides; awesome lists; demos
and templates; general infrastructure that merely mentions AI in its description (databases, generic
monitoring, generic scraping libraries); and vertical applications where the agent is an implementation
detail rather than the product (job hunting, social media scheduling, video editing, news dashboards).

When a project fits two layers, choose the one its users would look for it under.

Layers:
{layers}

For each repository below, reply with one JSON object per line, no markdown fence:
{{"repo": "owner/name", "in_stack": true|false, "layer": "<layer id or null>", "why": "<8 words max>"}}

Repositories:
{repos}"""


def readme(repo: str) -> str:
    for branch in ("HEAD",):
        try:
            request = urllib.request.Request(f"https://raw.githubusercontent.com/{repo}/{branch}/README.md", headers={"user-agent": "ai-agent-stack"})
            with urllib.request.urlopen(request, timeout=20) as response:
                text = response.read().decode("utf8", "ignore")
            text = re.sub(r"!\[[^\]]*\]\([^)]*\)|<[^>]+>|\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)", " ", text)
            return re.sub(r"\s+", " ", text).strip()[:README_CHARS]
        except Exception:  # noqa: BLE001 - a missing README is a fact about the repo, not a crash
            return ""
    return ""


def ask(prompt: str) -> list[dict]:
    result = subprocess.run(
        ["fastagent", "invoke", prompt, "--no-input"],
        cwd=AGENT_DIR, capture_output=True, text=True, timeout=900,
    )
    verdicts = []
    for line in result.stdout.splitlines():
        line = line.strip().strip("`")
        if line.startswith("{") and '"repo"' in line:
            try:
                verdicts.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    if not verdicts:
        print(result.stdout[-400:] or result.stderr[-400:], file=sys.stderr)
    return verdicts


def main() -> None:
    batch_size = int(sys.argv[sys.argv.index("--batch") + 1]) if "--batch" in sys.argv else 15
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else 10_000

    data = json.loads(CANDIDATES.read_text())
    layers = "\n".join(f"- {key}: {value['title']} — {value['blurb']}" for key, value in data["layers"].items())
    seen: dict[str, dict] = json.loads(OUT.read_text()).get("verdicts", {}) if OUT.exists() else {}

    pending = []
    for layer in data["layers"].values():
        for candidate in layer["candidates"]:
            if candidate["repo"] not in seen:
                pending.append(candidate)
    pending = pending[:limit]
    print(f"{len(seen)} already judged, {len(pending)} to read")

    for start in range(0, len(pending), batch_size):
        batch = pending[start : start + batch_size]
        blocks = []
        for candidate in batch:
            blocks.append(f"### {candidate['repo']} ({candidate['stars']} stars)\ndescription: {candidate['description']}\nREADME: {readme(candidate['repo'])}")
        verdicts = ask(PROMPT.format(layers=layers, repos="\n\n".join(blocks)))
        for verdict in verdicts:
            if verdict.get("repo"):
                seen[verdict["repo"]] = verdict
        OUT.write_text(json.dumps({"verdicts": seen}, indent=1) + "\n")
        kept = sum(1 for v in verdicts if v.get("in_stack"))
        print(f"  batch {start // batch_size + 1}: {len(verdicts)} judged, {kept} in the stack")

    in_stack = [v for v in seen.values() if v.get("in_stack")]
    print(f"\n{len(in_stack)} of {len(seen)} judged to be part of the agent stack")
    for verdict in sorted(seen.values(), key=lambda v: (v.get("layer") or "", v["repo"])):
        if not verdict.get("in_stack"):
            print(f"  out: {verdict['repo']:<44}{verdict.get('why', '')}")


if __name__ == "__main__":
    main()
