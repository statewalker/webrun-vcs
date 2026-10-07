---
"@statewalker/vcs-transport": patch
---

HTTP `push`, `fetch`, `clone` and `lsRemote` send `Credentials.token` as the Basic auth password, with the username defaulting to `x-access-token`. They sent `Basic` auth built from the missing username and password (`undefined:undefined`) instead.
