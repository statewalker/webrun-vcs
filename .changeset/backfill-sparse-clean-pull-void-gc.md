---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
---

**`git backfill`, `git sparse-checkout clean`, pulls into an unborn branch and gc prune in
partial clones.**

```typescript
// git backfill --min-batch-size=1000: a partial clone's missing blobs, batched by path
const { batches } = await git.backfill().setMinBatchSize(1000).call();
// git sparse-checkout clean -f: the directories outside the cone, removed whole
await git.sparseCheckout().setArguments(["clean", "-f"]).call();
```

`BackfillCommand` (git 2.49+) walks the commits from HEAD or the revisions given, then their
trees path by path in git's path-walk order, and fetches the absent blobs through the promisor
remotes in batches of `--min-batch-size` ids (default 50000), with `--sparse`/`--no-sparse` and
`--[no-]include-edges`; under 2.43 compatibility it fails as 2.43, which has no such command.
Revisions are read as git reads them: annotated tags are peeled (`backfill v1`, `v1..main`,
`main ^v1`), `HEAD:dir` walks that tree from `dir/`, `HEAD:file` and tagged blobs are fetched,
and a revision git refuses fails with git's message. `setAll(true)` (`--all`), `--not`,
`addPath()` (`-- <path>`, history simplified to the commits changing the paths) and
`setArguments()` (the command line) are supported; other rev-list options and pathspec magic
are refused with exit status 128 instead of being ignored.

`sparse-checkout clean` (git 2.5x; unknown to 2.43) removes every directory the index collapses
to a sparse directory (never one at or below a directory holding an intent-to-add entry, as
git's invalid cache-tree nodes keep them; `sparse-checkout reapply` follows the same rule), with
git's refusals (`must be in a sparse-checkout`, cone mode,
`clean.requireForce`), `--dry-run`, `--force`, `--verbose` and its `Removing`/`Would remove`
lines.

`pull --rebase` on an unborn branch with an index refuses before fetching, as git does
(`Updating an unborn branch with changes added to the index.`); other pulls into an unborn
branch run git's `pull_into_void` (`MergeCommand.callIntoVoid`), keeping staged changes the
fetched commit does not overwrite.

`GcOrchestrator` with `FileGcStrategy` now prunes partial clones: promisor objects are kept
without being walked (`GcRoots.keep`), the local objects promisor objects link to are roots,
and unreachable loose objects go as `git gc --prune=now` drops them.
