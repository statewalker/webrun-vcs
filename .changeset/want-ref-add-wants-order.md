---
"@statewalker/vcs-transport": patch
---

A v2 fetch from a server that takes `want-ref` now writes its wants in git's `add_wants` order. The sought refs go in one pass sorted by name, a clone's `HEAD` first, followed tags as `want-ref` too, then the ids exact-id refspecs ask for as `want <id>`, even when a named ref lists the same id. `FetchPackRequest.wantRefs` takes these entries in order (`WantEntry`: a name, or an id alone).
