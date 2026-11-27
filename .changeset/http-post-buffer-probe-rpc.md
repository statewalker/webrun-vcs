---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-commands": patch
---

Smart-HTTP POSTs follow remote-curl's `post_rpc` by size: a request within `http.postBuffer` (now read, `HttpClientSettings.postBuffer`) is held whole and sent again after a 401 the credential helper answers; a larger one first authenticates `probe_rpc`'s `0000` POST and is then sent once, streamed, so a push never builds or uploads its pack twice. `SmartHttpClient.postRpc` and `PushOptions.http` are new.
