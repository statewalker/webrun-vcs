---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-transport": minor
"@statewalker/vcs-commands": minor
---

HTTP authentication as native git: Digest (RFC 7616: MD5, SHA-256, SHA-512-256) answered as curl answers it, `http.proactiveAuth` (git 2.46+) asking the credential helper before the first request, and a POST answering 401 after an open `info/refs` asking the helper and sending the request again (remote-curl's `post_rpc`). vcs-utils gains a portable `md5`/`md5Hex` and synchronous `sha256Hex`/`sha512_256Hex` for Digest.
