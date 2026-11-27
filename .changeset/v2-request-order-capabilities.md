---
"@statewalker/vcs-transport": patch
---

upload-pack (protocol v2) reads a request as git's serve.c and process_args do: a capability line the server does not advertise, or that names no client capability (`session-id=` without `transfer.advertiseSID`, a command name), ends the request as git's "unknown capability" death; a `filter` line without `uploadpack.allowFilter` dies as an unexpected line with no `ERR` packet; and `want`/`want-ref` refusals follow request order, so the first bad line is the one reported.
