#!/usr/bin/env bash
# The whole refresh, in order. Discovery and classification need a model, so this runs where the
# credentials are (a laptop or a deployed agent); the weekly GitHub Action runs measurement only.
#   GITHUB_TOKEN=... scripts/pipeline.sh
set -euo pipefail
cd "$(dirname "$0")/.."

python3 -u scripts/discover.py "$@"   # candidates: listed + searches + other people's lists
python3 -u scripts/classify.py        # a model reads each new README and places it in a layer
python3 -u scripts/seed.py            # verdicts + overrides.json -> seeds.json
python3 -u scripts/collect.py         # measure everything, score it, write README and layer pages
python3 -u scripts/changes.py         # diff against the previous snapshot

git add -A
git diff --staged --quiet || git commit -m "refresh: $(date -u +%Y-%m-%d)"
echo "done; push when the diff looks right"
