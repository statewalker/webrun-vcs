---
"@statewalker/vcs-utils": patch
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-commands": patch
---

**Faster `git log -p` / `--stat`, and a faster index read, with the same output.**

On a 3,000-commit history (built bundles, `node scripts/bench-porcelain.mjs`) `log -p` takes about 2.4 s instead of 3.0 s and `log --stat` about 2.1 s instead of 2.6 s; the diffs of the commits alone take about half the time.

- **vcs-utils:** a typed array of its own costs a backing store outside the heap (a microsecond or two), more than the loops of a small diff over it. `allocInt32` (beside `allocBytes`) carves small `Int32Array`s from the shared slabs, and xdiff takes its per-diff arrays from it or from scratch buffers reused across diffs (the classification's table, the class counts, the Myers arrays, the discard actions). A buffer's lines are split and hashed in one pass (`LineHasher`). `encodeGitPath` encodes a short ASCII path into a slab view, and hunk headers and hunk bodies are written without buffers of their own.
- **vcs-working-tree:** `parseIndexFile` checks a short ASCII path (no empty component, no `.git` one, no NUL) as it reads its bytes, so only the other paths go through `validatePath` afterwards.
- **vcs-commands:** a command looks up its entry points (`call`, `callText`, ...) once per class, not once per instance (`git log -p` makes a diff command per commit); a tree-to-tree diff reads the submodule settings (`.gitmodules`) only when a submodule changed.
