---
"@statewalker/vcs-core": minor
"@statewalker/vcs-transport": minor
"@statewalker/vcs-transport-adapters": patch
"@statewalker/vcs-commands": minor
---

**Fetch and clone check what they received, as git does.**

- **vcs-transport:** `fetchFromConnection` runs git's `check_connected` before it writes any ref: every new ref tip must reach only objects that are here, down to the existing refs and the alternates' refs (`connectivityErrors`, receive-pack's walk, so a fetch on top of a branch reads only what it brought). A deepening fetch is checked against its new shallow commits before the shallow file changes; a clone checks the refs it writes, except those in a pack index-pack found self-contained. A failure throws `FetchCheckError` with rev-list's lines (`fatal: bad object`, `error: Could not read`, `fatal: bad tree object`, `fatal: missing blob object`). `FetchClientOptions.fsckObjects` runs index-pack's `--strict` over each received pack (imported into a quarantine, so a refused pack leaves nothing behind): fsck of every object and every named object received or present (`fatal: did not receive expected object`), as a clone's `--check-self-contained-and-connected` also does. `RepositoryFacade.loadObject` reads an object's content, `PackImportOptions.onObject` reports each received object, and commits and tags the typed stores refuse are walked as git parses them (`lenientCommitHeader`, `lenientTagTarget`).
- **vcs-core:** pack imports report every received object with its place in the pack (`onObject` of `importPack`, `installPack` and `SerializationApi.importPack`: whole entries first, then deltas).
- **vcs-commands:** `git fetch` fails with git's `error: <url> did not send all necessary objects` (exit 1) and `git clone` with `fatal: remote did not send all necessary objects` when a server leaves history out, writing no ref. `fetch.fsckObjects` / `transfer.fsckObjects` (or `FetchCommand.setCheckFetchedObjects`) check received objects with `fetch.fsck.<msg-id>` severities and `fetch.fsck.skipList` (`fetchFsckOf`), in git's words (`error: object <id>: <msg-id>: <message>`, `fatal: fsck error in packed object`, `fatal: index-pack failed`). `FetchCommand.setCompatibility` picks 2.43's or 2.5x's output.
