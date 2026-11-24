---
"@statewalker/vcs-commands": minor
---

`git.show()` (`ShowCommand`) is `git show`: commits as `git log -1 -p` shows them with show's
defaults (merges' dense combined diff, `--stat`, `--name-only`, `--format`, `-s`, `-m`, `-c`,
`--first-parent`), annotated tags (`tag <name>`, the tagger, the message, then the tagged
object, nested tags followed), trees (`tree <name>` and the top-level entries), blobs (raw, or
through the path's textconv under `--textconv` for `<rev>:<path>` and `:<path>`), several objects
at once with git's separators (a commit named twice shown once, path-limited commits that change
none of the paths left out), and ranges or `-<n>` walking as `git log`. `call()` returns stdout,
stderr lines and the exit status (255 for a tag whose object is missing); `callText()` the text.
`DiffCommand.textconvBlob` runs a path's textconv on a blob (statewalker/statewalker-root#312).
