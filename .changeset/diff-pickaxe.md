---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-utils": minor
---

Pickaxe in `git diff`, `git log` and `git show`, as git's diffcore-pickaxe.c: the new
`DiffTextOptions` `pickaxeString` (`-S<string>`, occurrence counts that differ; `pickaxeRegex`
for `--pickaxe-regex`), `pickaxeGrep` (`-G<regex>`, added or removed lines that match),
`findObjects` (`--find-object=<object>`, subtrees of a tree diff included), `pickaxeAll`
(`--pickaxe-all`) and `pickaxeIgnoreCase` (`-i`; `LogCommand.setRegexpIgnoreCase` sets it
too). Sides are read through textconv (`textconv: false` is `--no-textconv`), `-G` passes over
binary pairs unless `text`, regexes run through `compilePosixRegex` with `REG_NEWLINE`. The
pickaxe runs in diffcore's order: after rename detection, before `-O`, `--rotate-to` and
`--diff-filter`, on the queue `--relative` left. `git log` and `git show` hide commits whose
diff it empties and count `-n` in shown commits; combined diffs of merges take
find_paths_generic's way. A partial clone fetches each diff's absent blobs in one batch first,
as diffcore_std does. Option errors are git's (`cannot be used together`, `-S requires a
non-empty argument`, `unable to resolve`, `invalid regex`). `DiffPickaxe` is the engine.

`PosixRegex.exec`/`test` take `regexec` flags (`notbol` for `REG_NOTBOL`, `folded` with the new
`fold()` for a subject folded once), and GNU's buffer anchors (backslash-backquote,
backslash-quote) no longer match at line boundaries under `REG_NEWLINE`.
