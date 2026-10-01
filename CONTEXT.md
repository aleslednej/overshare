# overshare

Exports releases of a private source repo into a public target repo as one commit per release,
without the source repo's development history.

## Language

### Repositories

**Source repo**:
The private repository where all development happens and the only place changes are made.
_Avoid_: internal repo, private repo

**Target repo**:
The public repository that receives only release commits, from exactly one source repo.
_Avoid_: public repo, mirror, OSS repo

### People and identity

**Operator**:
The person who runs an export and prepares its release notes and any files supplied for it.
_Avoid_: author, user, releaser

**Release identity**:
The name and email recorded as author and committer of every release commit and as tagger of its tag, fixed per
target repo in config.
_Avoid_: author, bot

### Releases

**Release tag**:
A tag of the exact form `vMAJOR.MINOR.PATCH` (no pre-release) on the source repo's `main`; the only kind of
tag that can be exported. Release tags are ordered by semver, not by history.
_Avoid_: version tag, deploy tag

**Export**:
Moving the content of one release tag from the source repo into the target repo as one release commit.
_Avoid_: sync, publish, mirror

**Release commit**:
The single commit in the target repo produced by one export, carrying that export's release notes.

**Last export**:
The highest release tag present in both the target repo and the source repo; any further export must be a higher
release tag.

**Candidate**:
A release tag that can be exported now: higher than the last export and after it in the source repo's history.

**Plan**:
The preview of one export, shown before anything is pushed: files added, changed and deleted in the target repo,
files replaced by the overlay, and warnings.
_Avoid_: diff, dry run (a dry run is the `plan` command, the plan is what it shows)

**Release notes**:
Markdown prepared for one export and supplied when running it; an export cannot happen without them.
_Avoid_: changelog (a changelog is a file in the tree, release notes belong to one export)

### Content selection

**Allowlist**:
The explicit list of source repo paths that may appear in the target repo; anything not listed stays private.
_Avoid_: whitelist

**Overlay**:
Files that exist only for the target repo and replace any allowlisted file at the same path. They are either
committed in the source repo or supplied by the operator for one export; the operator's files take precedence.
_Avoid_: public-only files, override

**Transform**:
A pattern-based rewrite applied to allowlisted files on their way to the target repo, such as replacing an
internal URL with a public one.
_Avoid_: patch, filter

### Safeguards

**Denylist**:
The built-in set of paths that never reach the target repo, whatever the allowlist says, unless matched by an
exception pattern in config.
_Avoid_: blacklist, ignore list

**Forbidden pattern**:
A pattern, defined per target repo, that must not appear in an export; finding one stops the export.
_Avoid_: blocked word, secret pattern (secrets are covered separately by secret scanning)
