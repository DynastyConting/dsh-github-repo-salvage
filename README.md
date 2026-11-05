# GitHub Repo Salvage

A read-only DSH plugin: given a GitHub repository whose source was erased or
whose history was force-pushed away, it finds the forks that still hold the
original commits, and verifies the recovered head against a known SHA.

## Why this exists

A force-push replaces a branch ref; it does not rewrite the forks that already
exist. A fork taken before the push keeps its own objects, so its default
branch still points at the pre-erasure tip. Comparing that tip's commit SHA
with a known-good SHA is the only cheap proof that the recovered tree is the
original one and not something a later fork owner edited.

The plugin also reads the repository activity log, which records `before` and
`after` SHAs for every push, force-push, branch creation and deletion. Those
SHAs are the other way back: `git fetch origin <sha>` serves an unreachable
commit even when the REST API answers `422 No commit found` for the same SHA.

## Tool

`github_repo_salvage`

| Parameter | Type | Meaning |
|---|---|---|
| `repo` | string, required | `owner/name`, a `github.com` URL, or a git URL |
| `maxForks` | integer | How many forks to inspect, 1-100. Default 30 |
| `expectedHead` | string | Commit SHA the recovered copy must match exactly |
| `includeForks` | boolean | Also list forks whose head equals the current one |

The result carries `currentHead`, `activityHeads` (ref states the activity log
recorded), `candidates` (earliest forks first, each with `head`, `sizeKb`,
`match`), `recommended` with a ready-to-run `git clone` command, and `notes`.

## Token

Anonymous GitHub API allows 60 requests per hour, which is not enough for a
repository with many forks. Set a token in the environment or in the row
config:

```yaml
- insert:
    - id: github-repo-salvage
      name: '@dynastyconting/dsh-github-repo-salvage'
      config:
        token: ghp_xxxxxxxxxxxxxxxxxxxx
```

`GITHUB_TOKEN` and `GH_TOKEN` are read as fallbacks.

## Install

From a DSH session, ask the agent to install the bundle from its absolute
directory with `plugin_manager` `install_bundle`. The package is
`@local/dsh-github-repo-salvage`; the patch inserts one Host row and no UI.

## Limits

- It inspects at most `maxForks` forks, oldest first. A repository whose
  oldest forks were all deleted or synced after the rewrite yields no
  candidate; the `notes` field says so instead of guessing.
- It never pushes, deletes a ref, or writes to the target repository.
- It cannot verify that a fork owner did not rewrite the tree after forking;
  only the SHA match does that, and only when `expectedHead` is supplied.
