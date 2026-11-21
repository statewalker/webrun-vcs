---
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-transport": patch
"@statewalker/vcs-commands": patch
---

**Object alternates in the files store; `clone --shared`, `--reference`, `--reference-if-able` and `--dissociate`.**

- `createGitFilesBackend` reads the repository's alternates as git does: `$GIT_ALTERNATE_OBJECT_DIRECTORIES` (`:`-separated, C-quoted entries) then `objects/info/alternates` (comments, relative entries from the objects directory), each followed by its own alternates down to git's depth limit, the objects directory itself and repeats skipped, with git's error lines (`objects.alternates.errors`, `onAlternatesError`). Paths are read through the FilesApi (absolute ones inside its `rootDirectory`). New `GitObjects.alternates` (`list`, `add`, `refresh`, `refs`, `dissociate`), options `alternates` and `alternatesFromEnvironment`, and `OpenRepositoryOptions.alternates`; `openRepository` never applies the environment variable.
- Reads, `has`, listings, prefix lookups (abbreviations, disambiguation) and the approximate count include borrowed objects; writes skip an object an alternate holds and go to the repository's own objects only.
- `repack()` copies borrowed objects unless the new `local` (`git repack -l`); `gc()` passes it (`repack -d -l`) and, like `GcOrchestrator`, prunes only the repository's own objects; `prunePacked` also removes loose copies an alternate's pack holds. gc, repack, prune and `notes prune` no longer refuse repositories with alternates (`assertNoAlternates` is removed).
- `fsck` reads and checks the alternates' objects too, as git's default `--full`, in each version's order.
- receive-pack advertises the alternates' refs as `.have` (`RepositoryFacade.alternateRefs`, `core.alternateRefsPrefixes`), and fetch offers them as negotiation tips and complete history, as fetch-pack does.
- `CloneCommand.setShared`, `addReference`, `addReferenceIfAble` (messages in `CloneResult.messages`) and `setDissociate`, with git's alternates lines and errors (`computeAlternatePath`).
- Dumb HTTP's `info/refs` now peels a tag only an alternate holds.
