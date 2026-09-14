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

## Changing the workflow

Two organisation policies apply, and both fail in ways that are easy to misread.

**Actions must be pinned to a commit SHA.** `sha_pinning_required` is on, so `uses: actions/checkout@v4`
fails at the "Set up job" step before any log appears. Pin and leave the tag in a comment:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

```bash
gh api repos/actions/checkout/git/ref/tags/v7.0.1 --jq .object.sha
```

**The default token is read-only.** Both the organisation and the repository set
`default_workflow_permissions: read`. That is only the default: a workflow may still ask for more, which
is why `measure.yml` declares `permissions: contents: write` and can push its own commit. If an
organisation policy ever forbids the elevation, add a fine-grained PAT with *Contents: read and write*
as the repository secret `MEASURE_TOKEN`; the checkout step already prefers it when present.
