# Adding or removing a project

Membership is the only hand-made decision here; every column is measured.

**To propose a project**, open a pull request that adds its `owner/repo` to the right category in
[`seeds.json`](seeds.json), with one sentence on which layer it belongs to and why someone shipping an
agent would reach for it.

Two rules keep the page useful:

- **Open source only.** Release cadence, real user issues and activity cannot be read for a closed
  product, so a closed product would need a different, weaker standard of evidence.
- **Something you would put in production**, not a demo, a tutorial, a paper list or a wrapper around a
  single API call.

A project is dropped when it stops being findable in the data: no release with notes and no commits for
months. That removal is automatic in the numbers and manual in `seeds.json`; open a PR for it.

Corrections to the measurement itself are more valuable than additions. If a number is wrong, say which
repository and what you expected — the collector is [`scripts/collect.py`](scripts/collect.py) and it
runs in about two minutes.
