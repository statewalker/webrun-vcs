---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-transport": patch
---

A fetch without `--atomic` whose reference-transaction hook refuses now leaves in `FETCH_HEAD` the lines git writes before it dies: every line under git 2.5x (one transaction after them all, a no-op fetch's empty one included), the lines up to the refused ref's own transaction under 2.43. With `--atomic` `FETCH_HEAD` stays truncated, as before. vcs-transport's `fetchResultOf(error)` and `refusedRefOf(error)` give a caller what the fetch had done when the hook refused (statewalker/webrun-vcs#503).
