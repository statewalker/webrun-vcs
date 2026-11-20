---
"@statewalker/vcs-commands": minor
---

Interactive patch modes as a library API: `add -p`, `reset -p`, `checkout -p`, `restore -p` and
`stash push -p` (`setPatch(true)` with a `setPatchSelector` callback answering git's prompts),
backed by a port of git's add-patch.c hunk engine (`runAddPatch`, git's patch-mode tables and
prompt texts for 2.43 and 2.5x, split, edit, goto, search, `--no-auto-advance`). `DiffCommand`
takes `reverse` (`diff -R`).
