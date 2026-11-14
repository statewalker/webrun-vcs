---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-transport-lfs": minor
"@statewalker/vcs-transport-xet": minor
---

**webrun-wire dependencies move to their published lines:** `@statewalker/webrun-streams` ^0.4.0 (from ^0.2.0) and `@statewalker/webrun-http-streams` ^0.6.0 (from ^0.2.1). The demos also move to `@statewalker/webrun-streams-livekit` ^0.3.0 and `@statewalker/webrun-streams-signaling` ^0.3.0, and add `@statewalker/webrun-rpc` ^0.12.0 and `@statewalker/webrun-msgpack` ^0.11.0.

- **vcs-transport-lfs, vcs-transport-xet:** `serveLfs` and `serveXet` are now typed as returning `FetchHandler`, `(request: Request) => Response | Promise<Response>`, instead of the deprecated `HttpHandler`. The two are the same type (`HttpHandler` is now an alias), so callers need no change.
- **vcs-transport:** no API change. `serveGitOverWebrunHttp` and `webrunHttpFetch` pick up webrun-http-streams' behaviour since 0.2.x: a 400 or 500 no longer sends the error's `stack` in `x-webrun-error`; a call ends however its exchange ends (a body read to its end no longer holds a port of a multiplexed link); an aborted request's signal ends its response body at once; and a served `Request` has a `signal` that aborts when the caller leaves.
- **Peers must upgrade together.** webrun-streams 0.3 removed `emulateMux`; every webrun transport now runs `webrun-rpc`'s port stack (`messageTargetOver…` plus `overPipe` / `multiplexPort` with `msgpackCodec`, `connect` / `serve`), whose wire format differs. A peer running `webrunClientDuplex` or `serveRepoOverWebrun` over `emulateMux` cannot talk to one on the port stack. The webrtc and livekit demos are ported to the port stack, with a 1 MiB per-port window so transfers pipeline instead of waiting a round trip per chunk.
