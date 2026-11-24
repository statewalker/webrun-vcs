---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-utils": minor
"@statewalker/vcs-store-files": minor
---

`git.config()` answers git's queries as native `git config` does, in the legacy options and in
2.46's `get`/`list` subcommands: `getRegexp`, `list`, `getUrlmatch` (`--get-urlmatch`,
`get --url=`), `getColor`, `getColorBool`, `setType` (`--type=bool|int|bool-or-int|bool-or-str|
path|expiry-date|color`: values canonicalised on get as `format_config`, on set/add as
`normalize_value`), `--default` with types, `setShowOrigin`, `setShowScope`, `setNameOnly`,
`setShowNames`, `setNullTerminated` (`-z`), `setIncludes`, `setBlob` (`--blob=<rev>:<path>`)
and `setCompatibility("2.43")` (`--list` ignoring `--type`, no `:(optional)` paths or `#rgb`
colors). vcs-utils gains git's URL matching (urlmatch.c: `normalizeUrl`, `matchUrls`,
`selectUrlMatches`) for `<section>.<url>.*` configuration. `GitWorkingCopyConfig` names a
relative include as git does (`.git/../include/x`) and takes `fileOnly` to read one file with
its includes (statewalker/statewalker-root#302).
