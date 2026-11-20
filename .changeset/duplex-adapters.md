---
"@statewalker/vcs-transport": minor
---

**git's native protocol over MessagePorts, WebSockets and libp2p streams, with backpressure.**

- MessagePort: `messagePortDuplex(port)` and `serveGitOverPort(port, options)` run one git session per port on webrun-rpc's stream tier (`duplexOverPort` / `serveDuplexOverPort`): one chunk in flight per direction, the end of the client's input a half-close. `serveGitOverPortMux` / `connectGitOverPortMux` carry many sessions over one port (webrun-rpc's `overPipe` multiplexer, a 1 MiB window per session); `createMessagePortConnector` registers the first with a `GitTransportRegistry`, `createWebrunConnector` the second. The sentinel-based `createMessagePortDuplex`, `messagePortFetch` and `messagePortServe` are deprecated; the unused, unexported socket handler (`createGitSocketClient`, `handleGitSocketConnection`) is removed.
- WebSocket: `webSocketDuplex(socket)` (binary frames, one session per socket; an empty binary frame ends its sender's direction; writes wait while `bufferedAmount` is high; a `ws` socket pauses while its reader lags), `serveGitOverWebSocket(socket, options)` and `createWebSocketConnector({ createWebSocket? })` for `ws://` / `wss://` URLs, git-daemon's request line first.
- libp2p: `libp2pStreamDuplex(stream)` over any `{ source, sink, closeWrite?, close? }` stream (`end` is `closeWrite`), `serveGitOverLibp2pStream(stream, options)` for a `GIT_LIBP2P_PROTOCOL` (`/git/1.0.0`) handler and `createLibp2pConnector({ dial })` for `libp2p://<peer>/<path>` URLs. No libp2p dependency.
- `webrunClientDuplex` no longer queues without bound: writes go through `createByteQueue` (1 MiB high water mark, small chunks coalesced to 64 KiB) and return a promise while it is full; it gains `end` (a half-close). `webrunServerDuplex(run)` and `serveGitOverWebrun(options)` serve `serveGitConnection` on any webrun-streams `serve`.
- `createDuplexConnector({ name, schemes, open })` turns any byte stream the host opens into a connector.
