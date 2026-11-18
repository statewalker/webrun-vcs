---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-utils-node": minor
---

**Fetch and push summaries as git prints them, `rebase.instructionFormat`, grafts and replace refs in history walks.**

- **vcs-transport:** the ids of fetch and push summaries (`a..b`, `+ a...b`) are abbreviated as git's find_unique_abbrev under `core.abbrev` (new `abbrev` option of fetch and push; `RepositoryFacade.abbrevLengths`, implemented by `createRepositoryFacade`), no longer cut to 7 digits. Fetch and push results carry `abbrevLengths` and `summaryWidth` (git's `transport_summary_width`). `formatPushStatus` renders git's push report (`To <url>`, ` * [new branch]  main -> main`, ` ! [rejected]  main -> main (fetch first)`, `Everything up-to-date`); `fetchUpdateDisplay`, `formatFetchDisplay` and `fetchRefcolWidth` render git's fetch lines (full and compact formats). A forced tag update's summary is now `[tag update]` (git's `t` line), and a new ref is named after the remote ref (`[new tag]` for a remote tag), as git does. `FetchClientResult.backfilledTags` lists the tags found in the fetched history.
- **vcs-commands:** `FetchResult.display` and `PushResult.display` hold the stderr lines git prints for the refs. `rebase.instructionFormat` formats the todo lines (and the `Could not apply` line) through git's pretty format, `# ` put before a format that does not start with `#` (git 2.45+); the todo's text is kept as written when read back. `formatCommitPretty` is git's user format (`%H %h %T %t %P %p`, `%an %ae %al %ad %aD %ar %at %ai %aI %as` and the committer's, `%s %f %b %B %e`, `%n %% %x..`, colors, `%+ %- % ` magic). Log, rev-list, revision parents (`HEAD~2`) and merge bases apply replace refs (`refs/replace/<id>`, `GIT_REPLACE_REF_BASE`) and grafts (`info/grafts`), as git's parse_commit does; `setUseReplaceRefs(false)` is `--no-replace-objects`, and `core.useReplaceRefs=false` and `GIT_NO_REPLACE_OBJECTS` turn them off. `fsck` walks grafted parents (a parent grafted away is dangling; `bad graft data` and `bad graft parent` errors as git's).
- **vcs-core:** `loadObjectReplacements`, `createReplacedCommits`, `parseGraftFile` and `replacementOf`; `Refs.readGrafts` (optional) reads `info/grafts`.
- **vcs-store-files:** the file ref store and linked worktrees' refs read `info/grafts`.
- **vcs-working-tree / vcs-utils-node:** `GitHostEnvironment.noReplaceObjects` and `replaceRefBase`, read from `GIT_NO_REPLACE_OBJECTS` and `GIT_REPLACE_REF_BASE`.
