---
"@statewalker/vcs-transport": patch
---

HTTP `push`, `fetch`, `clone` and `lsRemote` send `Credentials.token` as `Authorization: Bearer <token>`. They sent `Basic` auth built from the missing username and password (`undefined:undefined`) instead.
