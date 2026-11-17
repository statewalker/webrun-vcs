---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-store-kv": minor
"@statewalker/vcs-store-sql": minor
"@statewalker/vcs-commands": minor
---

**Revisions: abbreviated ids, `describe` names, ranges and revision sets, as git reads them.**

- **vcs-core:** object stores look ids up by prefix. `GitObjects.listPrefix` (and `listObjectsWithPrefix`, which falls back to `list()`), `StagingBlobStore.listPrefix`, `RawStorage.keysWithPrefix` (`rawKeysWithPrefix`; the memory, compressed and composite stores implement it), `Pack.idsWithPrefix` (a binary search in the idx, as git's `find_short_packed_object`) and `PackSet.listPrefix`; quarantine views include their objects. `findAbbrevLengths` asks the store for the ids sharing the start length instead of listing every object when it can. `MINIMUM_ABBREV_LENGTH` is git's 4.
- **vcs-store-files / vcs-store-kv / vcs-store-sql:** prefix lookups read one loose fan-out directory plus the packs' idx (files backend, `FileRawStorage`), a KV prefix scan, and an SQL key range.
- **vcs-commands:** the revision resolver reads abbreviated ids (`get_short_oid`: 4 to 40 hex digits; the type the context needs or `core.disambiguate` picks among several objects; git's `error: short object ID ... is ambiguous` with its sorted `hint:` candidate list; `warning: refname 'x' is ambiguous.` for a ref that is also a short id), `git describe` names (`<ref>-<n>-g<abbrev>`, with git 2.5x's check of the ref and count parts (2.43 takes any `-g<abbrev>`)), and `./` / `../` paths in `<rev>:<path>` and `:<path>` relative to `RevParseCommand.setPrefix`. Commands that need a commit read abbreviations as committishes. New `git.revList()` (`RevListCommand`) lists the commits of `a..b`, `a...b`, `^a`, `x^@`, `x^!`, `x^-<n>` and `--not` (`parseRevisionArgs`, a port of `handle_revision_arg`); `revParse().addArgument()` prints arguments as `git rev-parse` does, `^<id>` lines included, and `--verify` prints a range before refusing it as git does. `RevisionError.output` holds what git printed on stdout before dying. `abbreviateId` abbreviates as git prints ids; merge's `Updating a..b` and `Created autostash:` and rebase's autostash, skipped-commit and todo-backup lines use it.
