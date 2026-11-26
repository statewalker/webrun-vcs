---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-utils-node": minor
---

git:// over MessagePorts: `createGitDaemonConnector`'s `openSocket`, `createSshConnector`'s `exec` and `GitDaemon.serve` accept a `MessagePort` as well as a `Duplex` (`ByteStream`, `isDuplex`, `duplexOfStream`), so a Node socket through vcs-utils-node's adapter (`connectSocketPort`, `listenSocketPorts`), a `MessageChannel`, a worker or a WebSocket bridge carry the same session. `messagePortDuplex` takes `drainTimeout` (`DEFAULT_PORT_DRAIN_TIMEOUT`) for a serving side's close, which lets the far end take the whole answer before the client's input is abandoned. `listenSocketPorts` gives `onPort` the client's address (`SocketPeer`), and a socket the adapter half-closed is flushed before it is destroyed.
