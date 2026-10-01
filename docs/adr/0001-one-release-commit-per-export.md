---
status: accepted
---

# One release commit per export

The target repo receives exactly one release commit per export, containing the tree of one release tag, instead of
the source repo's history. Code is published as "open source, not open contribution": development, reviews and
discussion stay in the private source repo, the target repo has pull requests disabled and accepts only issues, and
fixes for those issues are made in the source repo and arrive with the next export. We chose this over developing in
public because the source repo's history (internal reviews, bot and agent activity, internal references) is not meant
for the public, and target repo history, once published, is effectively irreversible.

## Consequences

- External contributors cannot open pull requests, and a squashed export drops any `Co-authored-by` attribution, so
  credit has to go into release notes.
- History in the target repo is a linear chain of release commits, so `git blame` there resolves only to releases.
- overshare never force-pushes the target repo; rewriting its history is a manual incident response, not a feature.
