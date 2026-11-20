---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-transport-httpeers": minor
"@statewalker/vcs-workspace": patch
---

**httpeers connectors, a server side for `messagePortDuplex`, and a transports guide.**

- `@statewalker/vcs-transport-httpeers`: `createHttpeersConnector(options)` registers mesh peers with a `GitTransportRegistry`, so vcs-commands' clone, fetch, pull, push and ls-remote reach them. `httpeers://<peer>/<repo>` (default `mode: "http"`) is smart HTTP over the mesh through `meshRemoteFetch`: a webrun caller to the peer (`call(peer)`, with the membership token, sent only to that peer's origin) or a `fetchImpl` that already reaches peers (`peerUrl`). `httpeers+git://<peer>/<repo>` (`mode: "native"`) is git's native protocol on a stream the host opens (`openStream`, e.g. httpeers-libp2p's `openDuplex`), the token in the stream's open frame. `meshGitDuplexHandler(options)` serves that side, mounted at `HTTPEERS_GIT_DUPLEX_PATH` (`/git`) of httpeers-libp2p's duplex mounts: the token is verified as `meshGitHandler` verifies a request's (a refusal is git's `ERR access denied: …`), then `serveGitConnection` serves the repository the request line names with the same capability rules (`git:read` to fetch; `git:write`, or `git:write-own` inside `refs/peers/<peerId>/*`, to push; receive-pack only with `enableReceivePack`; `daemon.*` never overrides).
- `@statewalker/vcs-transport`: `serveOverPort(port, run, options?)` runs any server (`serveOverDuplex` for a fixed service, `serveGitService`) on one end of a port whose other end is `messagePortDuplex`: the non-deprecated replacement for the server side of `createMessagePortDuplex`. A user guide, `docs/transports.md`, covers choosing a transport, registering connectors with `Git.fromWorkingCopy(workingCopy, { transports })`, client and server examples for HTTP, git://, ssh, MessagePort, WebSocket, libp2p and HTTPeers, and the security notes for serving. `createMessagePortDuplex`, `messagePortFetch` and `messagePortServe` stay deprecated (the integration tests still use them).
- `@statewalker/vcs-workspace`: the `duplexRemote` example uses `messagePortDuplex` / `serveOverPort`.
