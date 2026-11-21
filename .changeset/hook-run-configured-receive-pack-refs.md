---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-transport": minor
"@statewalker/vcs-working-tree": minor
---

**`git hook run` and `git hook list`, configured receive hooks, and the reference-transaction hook of pack-refs.**

- `git.hookRun(name)` (`HookRunCommand`) is `git hook run`: the arguments after `--` (`setArgs`), `--to-stdin` (`setToStdin`, read only when a hook runs; "could not open" is fatal, exit 128), `--ignore-missing`, git's "cannot find a hook named" error (exit 1), git 2.5x's refusal of unknown hook names (`setAllowUnknownHookName`; 2.43 runs any name), the configured hooks before the hooks directory's script and their exit codes or'ed together. The result carries git's exit status and stderr; `getHookOutput()` gathers the same.
- `git.hookList(name)` (`HookListCommand`) is git 2.5x's `git hook list` with `-z` and `--show-scope`: configured hooks by friendly name (`disabled` / `event-disabled` marked), the script as `hook from hookdir`, "no hooks found" (exit 1). git 2.43 has none: the command throws its usage error there.
- The receive side of local and served pushes runs git 2.5x's configured hooks (`hook.<name>.*` of the receiving repository) for pre-receive, update, post-receive, post-update, push-to-checkout and reference-transaction, as receive-pack runs them through the hook API (`OpenedRepositoryConfig.listWithOrigin`).
- `pack-refs` and `gc` run the reference-transaction hook as git's `files_optimize`: the packed store's transaction (`<zero> <id> <ref>` for each loose ref packed, also when there is none), then one transaction per pruned ref in reverse name order; a refusal throws `RefTransactionAbortedError` with nothing packed or the rest left loose. `pack-refs` without `--all` or refs packs the loose tags as git does (`Refs.packRefs` takes `prefixes`), and per-worktree refs (`refs/bisect/` ...) stay loose.
- Config values carry their scope (`ConfigValueOrigin.scope`: system, global, local, worktree; an included file's is the including file's).
- `Refs.packRefs` returns how many refs it packed (`PackRefsResult.refsPacked` counts those) and takes `auto` (git 2.5x's `pack-refs --auto`, `should_pack_refs`: nothing locked and no hook unless `max(16, log2(packed-refs size / 100) * 5)` loose refs wait; `PackRefsCommand.setAuto`, and 2.5x's `gc --auto`) and `onError`. A loose ref whose object is missing stays loose (`error: <ref> does not point to a valid object!`, `FilesRefBatchOptions.hasObject`), as does a loose name failing check_refname_format; a ref changed between its packing and its prune keeps its loose file (`error: cannot lock ref '<ref>': is at X but expected Y`, its transaction ending after `preparing`). The error lines go to the hook output and `errors` of `PackRefsResult` / `GCCommandResult`.
- `git hook run --to-stdin=<path>`: a relative path climbing above the repository's files is read from the host (never the worktree's file of the clamped name); one that cannot be read is git's fatal "could not open".
- A broken `hook.<name>.*` configuration of the receiving repository makes receive-pack die (`ReceivePackDiedError` from a receive hook): a local push fails with git's fatal line and "the remote end hung up unexpectedly", a served HTTP push's answer ends without a report; no ref moves.
- Config include paths resolve `.` and `..` (`include.path=../inc` of a repository's config, read by `FileWorktree.openRepositoryAt` and the working copy alike); one above the repository's files is read from the host where the files have a root directory.
