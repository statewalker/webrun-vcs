---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-transport-httpeers": minor
"@statewalker/vcs-transport-lfs": minor
"@statewalker/vcs-transport-xet": minor
---

**Runs on webrun-wire's current lines: `@statewalker/webrun-streams` ^0.6, `@statewalker/webrun-http-streams` ^0.8, and (for vcs-transport-xet) `@statewalker/webrun-content-transfer` ^0.4.**

The dependency ranges cross breaking lines, so an application that also depends on webrun-streams or webrun-http-streams moves with them to keep one copy. The transport code is unchanged: it already used the current names (no misspelt aliases), and the `Duplex`, `fetchOverDuplex` / `serveFetchOverDuplex` and `FetchHandler` it uses keep their shape.
