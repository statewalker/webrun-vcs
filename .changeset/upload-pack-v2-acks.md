---
"@statewalker/vcs-transport": patch
"@statewalker/vcs-commands": patch
---

Protocol v2 upload-pack acknowledges haves as git 2.45+ does: a have whose child (or a copy of it) came earlier in the request gets no ACK (`do_got_oid`'s `THEY_HAVE`). The new `acknowledgeEveryHave` server setting keeps git 2.43's behaviour, and `servedRepositoryOf` sets it under 2.43 compatibility.
