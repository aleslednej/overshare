# overshare

Exports releases of a private source repo into a public target repo as one commit per release, without the source
repo's development history: no review threads, bot activity or internal references, only the files you allow.

- One source repo maps to one target repo. Each export adds one release commit on top of the previous one; the
  target repo's history is linear and overshare never force-pushes.
- Only release tags `vX.Y.Z` on the source repo's `main` are exported, in semver order.
- Files come from `git archive <tag>`, never from the working tree, and only from an explicit allowlist.
- Every export runs checks over everything it publishes; any finding aborts it and nothing is pushed.

## Requirements

- [Bun](https://bun.sh)
- `git`
- [`gitleaks`](https://github.com/gitleaks/gitleaks) in `PATH`

overshare reaches both repos through `git`, so their credentials come from your git setup.

## Usage

Run it from the root of the source repo, where `overshare.yaml` lives. No package is published yet, so run it from a
clone of this repo:

```sh
bun /path/to/overshare/src/cli.ts plan    [tag] [--notes <file>] [--file <path>=<file>]...
bun /path/to/overshare/src/cli.ts release [tag]  --notes <file>  [--file <path>=<file>]... [--yes]
```

- `plan` is a dry run: the same pipeline as `release`, ending with the list of added, modified and deleted files in
  the target repo. It changes nothing.
- `release` builds the export, asks for confirmation, then pushes the release commit and an annotated tag
  atomically. `--notes` is required; the notes become the commit message body and the tag annotation, verbatim.
- `--file <path>=<file>` adds or replaces a file in the export (a one-off README, a changelog). Repeatable.
- `--yes` skips the confirmation.
- Without `tag`, overshare lists the release tags that are ready to export and asks you to pick one.

## Configuration

`overshare.yaml` in the root of the source repo. Only `target`, `identity` and `include` are required:

```yaml
# owner/repo means a GitHub repo; anything else is used as a git URL or path.
target: you/my-tool

# Author, committer and tagger of every release commit.
identity: "Your Name <you@users.noreply.github.com>"

# Allowlist of literal paths (files or directories, no globs). Nothing else goes out.
include:
  - src/
  - package.json
  - LICENSE

# A committed directory whose content is copied to the root of the export,
# for files that belong only in the target repo.
overlay: oss/

# Regex replacements on allowlisted files.
transforms:
  - files: package.json
    replace: 'github\.com/acme-internal/'
    with: 'github.com/you/'

# Case-insensitive regexes that must not appear in anything the export publishes (see Checks).
forbidden:
  - 'acme-internal'

# Globs exempt from the built-in denylist.
denylistExceptions:
  - '**/.env.example'
```

## Checks

Each check collects all of its findings, then the export aborts listing them:

- **Denylist:** `AGENTS.md`, `CLAUDE.md`, `.env*` and `.claude/` at any depth.
- **Symlinks:** any symlink in the export.
- **Forbidden patterns:** from `forbidden`, in paths, text file contents, the release notes and the identity.
  Binary files are listed in the plan as not checked.
- **Secrets:** `gitleaks` over the tree and the release notes, with its default rules. Nothing in the export can turn
  it off: a `.gitleaks.toml`, `.gitleaksignore` or `gitleaks:allow` comment has no effect.
- **`export-subst`:** an allowlisted file with this attribute aborts the build, since it would expand source repo
  metadata.

## Target repo setup

- Disable pull requests and enable private vulnerability reporting.
- Commit to the target repo only through overshare; a manual commit is overwritten by the next export.
- Publish GitHub Releases and packages from the target repo's own CI on tag push.

## License

[Apache-2.0](LICENSE)
