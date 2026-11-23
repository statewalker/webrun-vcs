---
"@statewalker/vcs-store-files": minor
---

**gc expires reflog entries before it computes what is reachable, as `git gc` runs `git reflog expire --all`.**

- `gc()` drops the reflog entries older than `gc.reflogExpire` (default 90 days), and those older than `gc.reflogExpireUnreachable` (default 30 days) whose old or new commit the ref's current tip does not reach (for `HEAD` and a linked worktree's `HEAD`: no ref reaches), with the per-ref forms `gc.<pattern>.reflogExpire` / `gc.<pattern>.reflogExpireUnreachable` (the first pattern that matches the ref's name, wildmatch) and `refs/stash` kept unless a pattern names it. The step runs before the reachability walk, so what only expired entries named is pruned in the same gc. It is skipped when both settings are `never`, or with `expireReflogs: false`; `GcResult.reflogEntriesPruned` counts what it removed, and a reflog whose ref is locked is left alone with git's `cannot lock ref` line in `errors`.
- New exports: `expireReflogs` (`git reflog expire --all`, with `--expire`/`--expire-unreachable`/`-n` as options), `gcExpiresReflogs`, `parseExpiryDate`, `wildmatch`, `ReflogExpiryConfigError`.
