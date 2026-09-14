#!/usr/bin/env python3
"""Propose what belongs on the page, instead of remembering it.

The first seed list was hand-written from memory, which is how a list is wrong the week after it is
made. Membership is now derived and only vetoed by hand:

    candidate pool  ->  a bar anyone can check  ->  a layer  ->  human review

The pool comes from lists other people maintain full time and from GitHub's own search. The bar is
deliberately dull — alive, adopted, open source, not a tutorial — because every interesting judgement
belongs in the measured columns, not in a private opinion about what deserves to be listed.

Usage: GITHUB_TOKEN=... python3 scripts/discover.py [--stars 1000]
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NOW = datetime.now(UTC)
API = "https://api.github.com"

# Curated by people who do it full time. Sampled 2026-09-13: 17/25 and 13/25 of their links had been
# pushed within 30 days, against 5/24 for e2b-dev/awesome-ai-agents, which is excluded for that reason.
SOURCE_LISTS = ["hesreallyhim/awesome-claude-code", "kyrolabs/awesome-agents"]

# One query set per layer. The layer a project lands in is decided by the query that found it and by
# the keywords below, so a project can be proposed for a layer without anyone having heard of it.
# Agents are split by what the agent is for, not by "coding versus general". The earlier split made
# "general" a bucket for everything that was not coding: research agents, browser agents, desktop
# assistants and vertical apps all landed together, and products like openclaw sit on both sides of it.
LAYERS = {
    "coding-agents": (
        "Coding agents",
        "You use it to write and change code. You are its user, not a builder on it.",
        ["topic:coding-agent", '"coding agent" in:name,description', "topic:ai-coding-assistant"],
        r"coding agent|code agent|pair program|cli agent|ide|editor|swe|vibe coding|codebase",
    ),
    "research-agents": (
        "Research and knowledge agents",
        "Agents that go and find out: deep research, document analysis, report writing.",
        ["deep research agent in:name,description", "research agent in:name,description", "document analysis agent in:description"],
        r"research|deep.?research|report|literature|analys[ei]s|knowledge base|summari",
    ),
    "browser-agents": (
        "Browser and computer-use agents",
        "Agents that drive a screen: browsers, desktops, phones.",
        ["browser agent in:name,description", "computer use agent in:description", "gui agent in:name,description"],
        r"browser|computer.use|gui agent|web automation|click|screenshot|desktop automation",
    ),
    "assistant-agents": (
        "Personal and desktop assistants",
        "The agent that sits next to your work and does errands across your own tools.",
        ["personal ai assistant in:name,description", "self-hosted assistant in:description", "desktop ai agent in:description"],
        r"personal|assistant|self.hosted|desktop|inbox|calendar|workspace|companion",
    ),
    "clients": (
        "Clients and interfaces",
        "The chat window, terminal UI or desktop shell you put in front of an agent.",
        ["ai chat ui in:name,description", "llm client in:name,description", "agent ui in:name,description"],
        r"\bui\b|client|chat(bot)? (app|interface|ui)|frontend|desktop app|tui|web ui",
    ),
    "harness": (
        "Harnesses and agent runtimes",
        "The loop you build on: tool execution, context management, turn control. Opinionated, not a library.",
        ["agent harness in:name,description", "agent runtime in:name,description", "agent loop in:description"],
        r"harness|agent loop|runtime|toolkit|agent os|execution engine",
    ),
    "frameworks": (
        "Frameworks and SDKs",
        "Composable libraries for building an agent: handoffs, structured output, graphs.",
        ["topic:agent-framework", "topic:ai-agents", "agent sdk in:name,description"],
        r"framework|sdk|library|multi.?agent|graph|orchestrat|workflow.*(build|defin)",
    ),
    "skills": (
        "Skills and instruction assets",
        "Files you load into an agent: skills, prompt packs, AGENTS.md collections. No code to run.",
        ["topic:claude-code", "agent skills in:name,description", "topic:prompt-engineering stars:>3000"],
        r"skill|prompt|instruction|agents\.md|claude\.md|playbook|persona|rules",
    ),
    "orchestration": (
        "Orchestration, durability and deployment",
        "What keeps an agent alive between turns: queues, retries, state, serving.",
        ["durable execution in:description", "workflow engine in:description stars:>2000", "agent platform in:description"],
        r"durable|queue|retry|state machine|serving|deploy|platform|scheduler",
    ),
    "memory": (
        "Memory and context",
        "What the agent remembers after the session ends.",
        ["agent memory in:name,description", "topic:memory stars:>2000", "context engineering in:description"],
        r"memory|context|recall|knowledge graph|retriev|rag\b",
    ),
    "gateways": (
        "Model gateways, routing and account switching",
        "Everything between your agent and whichever model answers: proxies, routers, key and account switchers.",
        ["llm gateway in:name,description", "llm proxy in:name,description", "model router in:description", "api key switcher in:description"],
        r"gateway|proxy|router|switch(er)?|load balanc|fallback|multi.?provider|rate limit|token.*(cost|budget)|api key",
    ),
    "protocol": (
        "MCP, protocols and registries",
        "The standards agents speak, the SDKs that implement them, and the registries tools are published to.",
        ["topic:mcp stars:>2000", "topic:model-context-protocol", "agent2agent OR a2a protocol in:name,description", "mcp registry in:name,description"],
        r"\bmcp\b|model context protocol|protocol|registry|a2a|interop|spec\b|standard",
    ),
    "capability-tools": (
        "Capability tools",
        "What an agent reaches for: search, scraping, documents, data access.",
        ["web scraping ai in:description", "agent tools in:name,description", "llm search api in:description"],
        r"scrap|crawl|search|document|spreadsheet|extract|data access|api wrapper",
    ),
    "sandboxes": (
        "Sandboxes and execution",
        "Where the agent's code is allowed to run.",
        ["code interpreter sandbox in:description", "topic:sandbox stars:>2000", "agent sandbox in:description"],
        r"sandbox|isolat|container|microvm|execution environment|code interpreter",
    ),
    "evaluation": (
        "Evaluation and observability",
        "How you find out whether the agent is still doing its job.",
        ["topic:llm-evaluation", "llm observability in:name,description", "agent evaluation in:name,description"],
        r"eval|observab|tracing|monitor|benchmark|telemetry|experiment",
    ),
    "security": (
        "Security and guardrails",
        "Stopping an agent from being talked into something, or taking the system with it.",
        ["prompt injection in:name,description", "llm guardrails in:name,description", "agent security in:description"],
        r"injection|guardrail|security|permission|red team|scanner|governance|policy",
    ),
}

# The layer keywords are loose on purpose, so relevance needs its own anchor: without it the first run
# proposed The Powder Toy, a Java interview guide and MockServer, all of which matched "sandbox",
# "agent" and "proxy" honestly enough.
DOMAIN = re.compile(r"\b(agent|agentic|llm|ai|mcp|prompt|model context|claude|gpt|codex|copilot|openai|anthropic|rag)\b", re.I)

# A list, a course or a demo is not a project you put in production.
EXCLUDE = re.compile(r"awesome|tutorial|course|roadmap|handbook|cookbook|examples?$|demo|starter|template|boilerplate|papers?$|interview|study|learn", re.I)


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
            # Search is rate-limited to 30/minute and drops connections when pushed; back off and retry.
            if attempt == attempts - 1:
                raise
            time.sleep(3 * (attempt + 1))


CACHE = ROOT / "data" / ".repo-cache.json"
_cache: dict[str, dict] = json.loads(CACHE.read_text()) if CACHE.exists() else {}


def repo_info(repo: str) -> dict | None:
    """Cached: a sweep re-reads hundreds of repositories, and most of them have not changed."""
    if repo not in _cache:
        try:
            _cache[repo] = api(f"/repos/{repo}")
        except urllib.error.HTTPError:
            _cache[repo] = {}
        except Exception:
            return None
    return _cache[repo] or None


def days_since(timestamp: str) -> int:
    return max(0, (NOW - datetime.fromisoformat(timestamp.replace("Z", "+00:00"))).days)


def pool() -> dict[str, set[str]]:
    """
    Candidates, remembering which layer's query found each one.

    Everything already on the page goes in first. Without that, a listed project falls off silently the
    week its search ranking dips: the first run of this version lost Claude Code, LangGraph, LiteLLM,
    Mastra, AutoGen, Langfuse and E2B, none of which had changed at all.
    """
    found: dict[str, set[str]] = {}
    seeds = json.loads((ROOT / "seeds.json").read_text())
    for category in seeds["categories"]:
        for entry in category["repos"]:
            repo = entry if isinstance(entry, str) else entry["repo"]
            found.setdefault(repo, set()).add("listed")
    for layer, (_, _, queries, _) in LAYERS.items():
        for query in queries:
            try:
                result = api(f"/search/repositories?q={urllib.parse.quote(query + ' pushed:>' + (NOW.replace(day=1)).strftime('%Y-%m-%d'))}&sort=stars&per_page=20")
            except Exception as error:  # noqa: BLE001 - a dropped search is a gap, not a crash
                print(f"  ! {query}: {error}", file=sys.stderr)
                continue
            time.sleep(1)  # the search endpoint allows 30 requests a minute
            for item in result.get("items", []):
                found.setdefault(item["full_name"], set()).add(layer)
    for source in SOURCE_LISTS:
        try:
            with urllib.request.urlopen(urllib.request.Request(f"https://raw.githubusercontent.com/{source}/HEAD/README.md", headers={"user-agent": "x"}), timeout=30) as response:
                text = response.read().decode("utf8", "ignore")
            for owner, name in re.findall(r"github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)", text):
                found.setdefault(f"{owner}/{name.rstrip('.')}", set()).add("from-list")
        except Exception as error:  # noqa: BLE001 - a missing list is a gap, not a failure
            print(f"  ! {source}: {error}", file=sys.stderr)
    return found


def user_issues(repo: str, days: int = 30) -> int:
    """Issues opened by someone who is not a maintainer. The second door into the list."""
    try:
        issues = api(f"/repos/{repo}/issues?state=all&sort=created&direction=desc&per_page=60")
    except Exception:  # noqa: BLE001 - an unreadable tracker is not evidence either way
        return 0
    return sum(
        1 for issue in issues
        if not issue.get("pull_request")
        and issue.get("author_association") in {"NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER"}
        and days_since(issue["created_at"]) <= days
    )


def classify(info: dict, hinted: set[str]) -> str | None:
    text = f"{info['full_name']} {info.get('description') or ''} {' '.join(info.get('topics') or [])}".lower()
    scored = [(len(re.findall(LAYERS[layer][3], text)), layer) for layer in LAYERS]
    best_count, best = max(scored)
    if best_count:
        return best
    real = hinted - {"from-list"}
    return sorted(real)[0] if real else None


def main() -> None:
    minimum = int(sys.argv[sys.argv.index("--stars") + 1]) if "--stars" in sys.argv else 100
    seeds = json.loads((ROOT / "seeds.json").read_text())
    already = {
        (entry if isinstance(entry, str) else entry["repo"])
        for category in seeds["categories"]
        for entry in category["repos"]
    }

    candidates = {repo: hints for repo, hints in pool().items() if not EXCLUDE.search(repo)}
    print(f"pool: {len(candidates)} candidates, reading repositories...")
    with ThreadPoolExecutor(max_workers=8) as runner:
        list(runner.map(repo_info, candidates))
    CACHE.write_text(json.dumps(_cache))
    print(f"read {len(_cache)} repositories (cached in {CACHE.name})\n")

    proposals: dict[str, list[dict]] = {}
    for repo, hints in candidates.items():
        info = repo_info(repo)
        if not info:
            continue
        reasons = []
        # The bar is now a floor, not a filter: scoring ranks, so gatekeeping by size only hides things.
        # It keeps out what cannot be measured or is already dead, and nothing else.
        adopted = info["stargazers_count"] >= minimum
        if days_since(info["pushed_at"]) > 90:
            reasons.append("not pushed in 90d")
        if info.get("fork"):
            reasons.append("fork")
        if not (info.get("license") or {}).get("spdx_id", "").replace("NOASSERTION", ""):
            reasons.append("no open licence")
        if EXCLUDE.search(info.get("description") or ""):
            reasons.append("list or tutorial")
        if "listed" in hints:
            pass
        elif not adopted:
            # A project with fewer stars but real users beats a starred repository nobody files against.
            # dapr/dapr-agents has 743 stars and 13 user issues in 30 days; stars alone would drop it.
            if user_issues(repo) < 10:
                continue
        if reasons:
            continue
        text = f"{info['full_name']} {info.get('description') or ''} {' '.join(info.get('topics') or [])}"
        if not DOMAIN.search(text):
            continue
        layer = classify(info, hints)
        if not layer:
            continue
        proposals.setdefault(layer, []).append({
            "repo": repo,
            "stars": info["stargazers_count"],
            "pushed_days": days_since(info["pushed_at"]),
            "description": (info.get("description") or "")[:80],
            "seeded": repo in already,
            "hints": sorted(hints),
        })

    out = {"generated_at": NOW.isoformat(), "bar": {"min_stars_or_user_issues": [minimum, 10], "pushed_within_days": 90, "open_licence": True}, "layers": {}}
    for layer, (title, blurb, _, _) in LAYERS.items():
        rows = sorted(proposals.get(layer, []), key=lambda row: -row["stars"])
        out["layers"][layer] = {"title": title, "blurb": blurb, "candidates": rows}
        new = [row for row in rows if not row["seeded"]]
        print(f"## {title}  ({len(rows)} pass the bar, {len(new)} not yet seeded)")
        for row in rows[:12]:
            mark = " " if row["seeded"] else "+"
            print(f" {mark} {row['repo']:<42}{row['stars']:>9,}  {row['description'][:58]}")
        print()
    (ROOT / "data" / "candidates.json").write_text(json.dumps(out, indent=1) + "\n")
    print(f"written to data/candidates.json")


if __name__ == "__main__":
    main()
