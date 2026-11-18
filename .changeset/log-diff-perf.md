---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": minor
---

**Faster `git log -p` / `--stat` / `--name-status` and `git diff` between commits, with the same output.**

On a 3,000-commit history (a few hundred files, built bundles) `log -p` takes about 3.1 s instead of 8.6 s (native git 1.0 s), `log --stat` 2.6 s instead of 6.9 s, `log --name-status` 0.8 s instead of 2.1 s; on a 20,000-commit one `log -p` takes about 32 s instead of 56 s.

- **vcs-utils:** xdiff splits lines with a native `indexOf` scan, hashes them four bytes at a time, and a buffer's lines and hashes are kept (weakly) for its next diff, as `git log -p` diffs each version twice. The classification skips the lines both files share byte for byte at their start and end (their class is their twin's; same classes, same numbering, so the same diff). Line and prefix comparisons go four bytes at a time. `diffLineCounts` sums the script's changes instead of emitting hunks (unless `--ignore-blank-lines`), `writeHunks` writes each hunk as one buffer, `RawText.isBinary` looks for the NUL with `indexOf`, and short ASCII paths decode without a spread.
- **vcs-core:** `Blobs.open` (optional) gives a blob's size and content from one read of the object; `probeBlob`, `load` and `size` use it (a packed delta was resolved two or three times before). `Trees.entries` (optional) hands out the cached decoded entries without a copy per read, and `Trees.raw` the stored tree bytes, which the new `TreeEntryCursor` walks decoding only what is asked (git's `tree_desc`). `GitObjects.listPrefix` and `findAbbrevLengths` take a `cache` in which a store keeps listings for one operation. `overlayMethods` binds each method once.
- **vcs-store-files:** with that cache, the loose objects of each fan-out directory are listed once (git's `odb_loose_cache`) instead of once per abbreviated id.
- **vcs-commands:** `log` and `diff` abbreviate through that cache (`createIdAbbreviator(workingCopy, { cacheListings })`); `log` prints inside one worktree batch, so attributes files and the configuration are read once for all its diffs, not per commit and path. Tree comparisons walk both trees' bytes in git's order and skip identical entries undecoded; a tree's full id is read at once (no revision lookup and header read); the commands sharing reads keep lately read small blobs (32 MiB), so a version is read once for its two diffs.
