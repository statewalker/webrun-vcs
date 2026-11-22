---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-core": patch
"@statewalker/vcs-working-tree": patch
---

**Faster `git diff` output, status untracked scans and `commit -a` of small files.**

```typescript
// one worktree operation for the whole output: attributes and config read once
const patch = await git.diff().setOldTree("main~999").setNewTree("main").callText();
```

`DiffCommand.callBytes`/`callText`, `callDiffstat` and `callFormats` run as one worktree operation
(`Worktree.batch`), as `git log` already ran its diffs: an attributes lookup outside an
operation opened one of its own, re-reading the configuration, `info/attributes` and the
`.gitattributes` files once per file printed. The untracked scan passes over the tracked files
of a directory listing without a promise or a result per file. A small object stored from a
stream (a worktree file of at most 64 KiB, as `add` and `commit -a` store them) is gathered and
compressed in one synchronous call instead of through a compression stream; `GitObjects.put`
copies each streamed chunk it keeps, so a source may refill one buffer for every chunk, and
closes the source when the store fails before reading it to its end.
