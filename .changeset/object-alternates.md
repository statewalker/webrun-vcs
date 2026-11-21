---
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-transport": patch
"@statewalker/vcs-commands": patch
---

**Object alternates in the files store; `clone --shared`, `--reference`, `--reference-if-able` and `--dissociate`.**

- `createGitFilesBackend` reads the repository's alternates as git does: `$GIT_ALTERNATE_OBJECT_DIRECTORIES` (`:`-separated, C-quoted entries) then `objects/info/alternates` (comments, relative entries from the objects directory), each followed by its own alternates down to git's depth limit, the objects directory itself and repeats skipped, with git's error lines (`objects.alternates.errors`, `onAlternatesError`). Paths are read through the FilesApi (absolute ones inside its `rootDirectory`). New `GitObjects.alternates` (`list`, `add`, `refresh`, `refs`, `dissociate`), options `alternates`, `alternatesFromEnvironment` and `workTree` (where relative variable entries are resolved: the worktree top, as git), and `OpenRepositoryOptions.alternates`; `openRepository` and submodules opened with `openGitlink` never apply the environment variable. `alternates.add()` writes the file under `alternates.lock`; `refs()` leaves out an alternate's refs to objects it lacks. A repository without alternates reads through its own store, no layer added.
- Reads, `has`, listings, prefix lookups (abbreviations, disambiguation) and the approximate count include borrowed objects; writes skip an object an alternate holds and go to the repository's own objects only.
- `repack()` copies borrowed objects unless the new `local` (`git repack -l`); `gc()` passes it (`repack -d -l`) and, like `GcOrchestrator`, prunes only the repository's own objects; `prunePacked` also removes loose copies an alternate's pack holds. gc, repack, prune and `notes prune` no longer refuse repositories with alternates (`assertNoAlternates` is removed). An alternate git cannot read either (gone, a path that cannot be normalized, nesting too deep) is reported in the new `GcResult.errors`/`RepackResult.errors` and they go on, as git; they refuse, deleting nothing, only where git reads alternates this store does not (`objects/info/alternates` under `alternates: false`, an absolute entry outside the FilesApi's root: `AlternatesUnreadableError`), and a ref, HEAD (a linked worktree's too) or index entry whose object is missing is fatal (`MissingRootError`: `bad object <ref>`, as git dies), where it used to be dropped from the roots.
- `fsck` reads and checks the alternates' objects too, as git's default `--full`, in each version's order.
- receive-pack advertises the alternates' refs as `.have` (`RepositoryFacade.alternateRefs`, `core.alternateRefsPrefixes`), and fetch offers them as negotiation tips and complete history, as fetch-pack does.
- `CloneCommand.setShared`, `addReference`, `addReferenceIfAble` (messages in `CloneResult.messages`) and `setDissociate`, with git's alternates lines and errors (`computeAlternatePath`).
- Dumb HTTP's `info/refs` now peels a tag only an alternate holds.
