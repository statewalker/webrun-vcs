# Transports: reaching a remote over HTTP, git://, ssh, a MessagePort, a WebSocket, libp2p or an httpeers mesh

```typescript
import { Git } from "@statewalker/vcs-commands";
import { createDefaultTransports, createWebSocketConnector } from "@statewalker/vcs-transport";

const transports = createDefaultTransports();                 // http:// and https://
transports.register(createWebSocketConnector());              // ws:// and wss://

const git = Git.fromWorkingCopy(workingCopy, { transports });
await git.clone().setURI("wss://git.example.com/notes.git").call();
await git.push().setRemote("origin").call();                  // origin is wss://… now
```

That is the whole idea. A remote command (`clone`, `fetch`, `pull`, `push`, `ls-remote`) parses its
URL the way git does, asks the registry for the connector whose scheme matches, and runs git's
protocol over the session the connector returns. A connector returns one of two things:

- **a smart-HTTP endpoint** (`{ kind: "http", baseUrl, fetchImpl }`): requests to
  `<baseUrl>/info/refs` and `<baseUrl>/git-upload-pack`, sent through any `fetch` function;
- **a byte stream** (`{ kind: "native", duplex }`) carrying git's own native protocol, the one
  `git daemon` and `ssh` speak. The client writes git-daemon's request line first
  (`git-upload-pack /notes.git\0host=…\0`), so one server serves every repository its resolver
  finds.

Local paths and `file://` URLs never reach the registry: git's local transport serves them in
process.

## Choosing a transport

| You have | Use | URL |
| --- | --- | --- |
| A git server (GitHub, Gitea, `git http-backend`, our `createFetchHandler`) | the built-in HTTP connector | `https://host/repo.git` |
| A TCP socket opener (Node, Deno, a WebSocket-to-TCP relay) | `createGitDaemonConnector` / `openSocket` | `git://host/repo.git` |
| A way to run `ssh` (Node `child_process`, a shell service) | `createSshConnector` / `exec` | `ssh://user@host/repo.git`, `host:repo.git` |
| A Worker, an iframe, another tab | `createMessagePortConnector`, `connectGitOverPortMux` | any scheme you register, e.g. `worker://local/repo.git` |
| A browser talking to your server without HTTP round trips | `createWebSocketConnector` | `wss://host/repo.git` |
| A libp2p node | `createLibp2pConnector` | `libp2p://<peer-id>/repo.git` |
| An httpeers mesh | `createHttpeersConnector` (`@statewalker/vcs-transport-httpeers`) | `httpeers://<peer-id>/repo.git`, `httpeers+git://<peer-id>/repo.git` |
| Any other byte stream (WebRTC, LiveKit, a custom tunnel) | `createDuplexConnector`, `createWebrunConnector` | any scheme you register |

Smart HTTP is stateless and goes through proxies, CDNs and CORS; it is the right choice when there
is an HTTP server. Every other transport keeps one stream open for the whole exchange, which is
cheaper on a peer-to-peer link and the only option where there is no HTTP at all.

## Registering connectors

```typescript
const transports = createDefaultTransports({
  fetchImpl: (request) => fetch(request),                    // the HTTP connector's fetch
  openSocket: (host, port) => openTcp(host, port),           // adds git://
  exec: (target, command, env) => runSsh(target, command, env), // adds ssh
});
transports.register(myConnector, { priority: 10 });          // asked before the defaults

// every remote command of this facade uses them
const git = Git.fromWorkingCopy(workingCopy, { transports });

// or one command at a time
await Git.fromWorkingCopy(workingCopy).fetch().setRemote(url).setTransports(transports).call();
```

`register` returns a function that unregisters the connector; `transports.clone()` copies a
registry to extend separately. Among connectors of equal priority, the one registered last wins,
so a registration overrides a default for the same scheme. git's own rules still apply on top:
`protocol.<scheme>.allow=never` refuses a scheme (`fatal: transport 'x' not allowed`), and
`protocol.version` reaches the connector (`request.protocolVersion`; a push always asks for v0).

A connector of your own is a name, its schemes and a `connect` function:

```typescript
transports.register({
  name: "worker",
  schemes: ["worker"],
  async connect(request) {
    // request.url (parsed as git parses it), request.service, request.protocolVersion
    return { kind: "native", duplex: await openStreamFor(request), handshake: "git-daemon" };
  },
});
```

## HTTP

```typescript
// client: built in
const transports = createDefaultTransports({ headers: { "user-agent": "notes-app" } });
await git.clone().setURI("https://example.com/notes.git").setTransports(transports).call();
```

```typescript
// server: any Fetch-API host (Deno.serve, Bun.serve, a ServiceWorker, a Node adapter)
import { createFetchHandler } from "@statewalker/vcs-transport";

const handleGit = createFetchHandler({
  async resolveRepository(path) {
    return path === "/notes.git" ? { repository, refStore } : null;
  },
  receivePack: { hooks: { authorize: (commands, ctx) => isAllowedToPush(ctx) } },
});
Deno.serve(handleGit);
```

Credentials come from the command (`setCredentialsProvider`) or the connector's headers. The
handler speaks protocol v2 to clients that ask for it. It has no on/off switch for pushes: a
`resolveRepository` that returns `null`, or a `receivePack.hooks.authorize` that refuses, is how a
server says no.

## git://

```typescript
// client (Node): a TCP socket as a Duplex
import { connect } from "node:net";

const transports = createDefaultTransports({
  openSocket: (host, port) => tcpDuplex(connect({ host, port, allowHalfOpen: true })),
});
await git.clone().setURI("git://git.example.com/notes.git").setTransports(transports).call();
```

```typescript
// server: git-daemon's side on every connection
import { createServer } from "node:net";
import { createBasePathResolver, serveGitConnection } from "@statewalker/vcs-transport";
import { servedRepositoryOf } from "@statewalker/vcs-commands";

const resolveRepository = createBasePathResolver({
  files,                       // a FilesApi over the server's disk
  basePath: "/srv/git",        // git-daemon's --base-path
  openRepository: async (gitDir) => {
    const opened = await openRepository(gitDir);
    return opened && servedRepositoryOf(opened);
  },
});
createServer({ allowHalfOpen: true }, (socket) =>
  serveGitConnection({ duplex: tcpDuplex(socket), resolveRepository, initTimeout: 10_000, timeout: 60_000 }),
).listen(9418);
```

`tcpDuplex` is yours: a Node socket's data events as an async iterable, `write`, `end` as
`socket.end()` (the half-close git uses after a request) and `close` as `socket.destroy()`. Both
ends need `allowHalfOpen: true`, or the client's half-close also ends the server's answer.

## ssh

```typescript
import { spawn } from "node:child_process";
import { createDefaultTransports, sshArgs } from "@statewalker/vcs-transport";

const transports = createDefaultTransports({
  // target: { host, port?, user? }; command: "git-upload-pack '/notes.git'"
  exec: async (target, command, env) => {
    const child = spawn("ssh", ["-o", "SendEnv=GIT_PROTOCOL", ...sshArgs(target), command], {
      env: { ...process.env, ...env },
    });
    return processDuplex(child); // stdout as the read side, stdin as the write side
  },
});
await git.fetch().setRemote("git@example.com:org/notes.git").setTransports(transports).call();
```

The connector builds the remote command as git does (`--upload-pack`, `remote.<name>.uploadpack`,
the path shell-quoted) and passes `GIT_PROTOCOL=version=2` in `env` when protocol v2 is asked for.
Always build the argument list with `sshArgs`: it puts `--` before the destination and refuses a
host or user that starts with `-`, so a URL cannot smuggle an ssh option in. On the server, an ssh
channel already names the service and the path; serve it with `serveGitService({ duplex, service,
path, gitProtocol, resolveRepository })` (`parseGitServiceCommand` reads the command an ssh server
was asked to run).

## MessagePort: same page and Worker

```typescript
// same page: one MessageChannel per session
import { createMessagePortConnector, serveGitOverPort } from "@statewalker/vcs-transport";

const serve = { resolveRepository, enableReceivePack: true };
transports.register(
  createMessagePortConnector({
    name: "local",
    schemes: ["local"],
    openPort: () => {
      const { port1, port2 } = new MessageChannel();
      serveGitOverPort(port2, serve);
      return port1;
    },
  }),
);
await git.clone().setURI("local://page/notes.git").setTransports(transports).call();
```

```typescript
// worker.ts: many sessions over the worker's own port
import { serveGitOverPortMux } from "@statewalker/vcs-transport";

await serveGitOverPortMux(self, { resolveRepository, enableReceivePack: true });
```

```typescript
// page.ts
import { connectGitOverPortMux, createWebrunConnector } from "@statewalker/vcs-transport";

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const peer = await connectGitOverPortMux(worker);
transports.register(createWebrunConnector({ name: "worker", schemes: ["worker"], call: () => peer.call }));
await git.fetch().setRemote("worker://local/notes.git").setTransports(transports).call();
```

Both shapes run on webrun-rpc's stream tier: each direction moves one chunk at a time, so a large
pack never piles up in the port, and `Duplex.end` reaches the server as the end of its input. The
multiplexer serves at most 64 sessions at once (`maxPorts`). Code that runs one fixed service
without a registry (a `fetchOverDuplex` against a `serveOverDuplex`) pairs `messagePortDuplex` on
the client with `serveOverPort` on the server. `createMessagePortDuplex`, `messagePortFetch` and
`messagePortServe` are deprecated: they posted writes without backpressure.

## WebSocket

```typescript
// browser client
import { createWebSocketConnector } from "@statewalker/vcs-transport";

transports.register(createWebSocketConnector({ connectTimeout: 10_000 }));
await git.clone().setURI("wss://git.example.com/notes.git").setTransports(transports).call();
```

```typescript
// Node server with the `ws` package
import { WebSocketServer } from "ws";
import { DEFAULT_WEBSOCKET_MAX_FRAME_SIZE, serveGitOverWebSocket } from "@statewalker/vcs-transport";

new WebSocketServer({ port: 8080, maxPayload: DEFAULT_WEBSOCKET_MAX_FRAME_SIZE }).on(
  "connection",
  (socket) => serveGitOverWebSocket(socket, { resolveRepository, initTimeout: 10_000, timeout: 60_000 }),
);
```

One session per socket, in binary frames. A WebSocket has no half-close, so an empty binary frame
ends its sender's direction. Writes leave in frames of at most 64 KiB; a received frame over 1 MiB
closes the socket with code 1009. Set the `ws` server's `maxPayload` to the same limit, so it never
buffers a larger frame before the adapter sees it. The browser's `WebSocket` cannot pause, so its
reader has to keep up; the `ws` socket pauses while its reader lags.

## libp2p

```typescript
import { createLibp2pConnector, GIT_LIBP2P_PROTOCOL, serveGitOverLibp2pStream } from "@statewalker/vcs-transport";
import { peerIdFromString } from "@libp2p/peer-id";

// server
await node.handle(GIT_LIBP2P_PROTOCOL, ({ stream }) =>
  serveGitOverLibp2pStream(stream, { resolveRepository, timeout: 60_000 }),
);

// client
transports.register(
  createLibp2pConnector({
    dial: (peer, protocol, { signal }) => node.dialProtocol(peerIdFromString(peer), protocol, { signal }),
    connectTimeout: 30_000,
  }),
);
await git.fetch().setRemote(`libp2p://${peerId}/notes.git`).setTransports(transports).call();
```

The adapter is duck-typed (no libp2p dependency): libp2p 3's message streams and libp2p 1/2's
`{ source, sink }` both fit. `Duplex.close` waits at most a second for what is written, then
aborts the stream, so a peer that stopped reading cannot hold a session open.

## HTTPeers

An httpeers mesh authorizes every caller with a membership token the hub minted, bound to the peer
the transport proved. `@statewalker/vcs-transport-httpeers` gives it two connectors.

```typescript
// smart HTTP over the mesh: httpeers://<peer>/<repo>
import { createHttpeersConnector } from "@statewalker/vcs-transport-httpeers";

transports.register(
  createHttpeersConnector({
    token: () => currentMembershipToken(),
    call: (peer) => connectionTo(peer).call,          // a webrun-streams caller to the peer
  }),
);
await git.clone().setURI(`httpeers://${peerId}/notes.git`).setTransports(transports).call();
```

```typescript
// the serving peer
import { gitRules, meshGitHandler, servePeerConnection } from "@statewalker/vcs-transport-httpeers";

const handler = meshGitHandler({
  resolveRepository,                                  // as createFetchHandler's
  access: { issuer: hubPeerId, rules: gitRules({ contributors: true }) },
});
// per incoming connection, once its transport proved the caller:
serve(params, servePeerConnection(handler, { remotePeer: provenPeerId }));
```

A member that already reaches peers through its own `fetch` (an httpeers member's edge) passes
`fetchImpl` and `peerUrl: (peer) => edgeBaseUrl + peer` instead of `call`; the token is
then optional, since the edge adds it.

```typescript
// git's native protocol over httpeers-libp2p's duplex streams: httpeers+git://<peer>/<repo>
import { createDuplexMounts, openDuplex, serveDuplex } from "@statewalker/httpeers-libp2p";
import { HTTPEERS_GIT_DUPLEX_PATH, meshGitDuplexHandler } from "@statewalker/vcs-transport-httpeers";

// serving peer
const mounts = createDuplexMounts();
mounts.provide(
  HTTPEERS_GIT_DUPLEX_PATH,
  meshGitDuplexHandler({
    access: { issuer: hubPeerId, rules: gitRules({ contributors: true }) },
    resolveRepository: createBasePathResolver({ files, basePath: "/repos", exportAll: true, openRepository }),
    enableReceivePack: true,
    initTimeout: 10_000,
    timeout: 60_000,
  }),
);
await serveDuplex({ node, mounts });

// calling peer
transports.register(
  createHttpeersConnector({
    mode: "native",
    token,
    openStream: ({ peer, path, token }) => openDuplex({ node, peerId: peer, path, token }),
  }),
);
await git.fetch().setRemote(`httpeers+git://${peerId}/notes.git`).setTransports(transports).call();
```

Both serve the same rules. Every role with `git:read` may fetch; `git:write` (admins) may push to
any ref; with `gitRules({ contributors: true })` a member may push only into
`refs/peers/<its peer id>/*`, and a command outside it comes back as
`ng <ref> not allowed: this peer writes refs/peers/<id>/* only`. A token that is missing, expired,
forged or minted for another peer is refused: with 401 or 403 over HTTP, with git's
`ERR access denied: …` over the native stream. A native stream is authorized once, when it opens;
wrap the handler with httpeers-access's `guardStream` to end a revoked member's stream.

## Any other stream

```typescript
transports.register(
  createDuplexConnector({
    name: "tunnel",
    schemes: ["tunnel"],
    open: (request, { signal }) => openTunnel(request.url.host, { signal }), // a transport Duplex
    connectTimeout: 10_000,
  }),
);
// the other end:
await serveGitConnection({ duplex, resolveRepository });
```

For a webrun-streams channel (WebRTC, LiveKit), register `serveGitOverWebrun(serve)` with the
channel's `serve` and reach it with `createWebrunConnector({ call: () => call })`.

## Security notes

- **Map paths with `createBasePathResolver`.** The path in a request line is client input. Every
  server checks it as git-daemon does (no `..`, `//`, NUL or backslash) before `resolveRepository`
  sees it; `createBasePathResolver` then maps it below a base directory the way git-daemon does
  (`--base-path`, `.git` suffixes, `~user` only with `userPath`, symbolic links followed and kept
  inside the base) and serves only repositories with a `git-daemon-export-ok` file unless
  `exportAll` is set. Never join the path to a directory yourself.
- **Pushes are off by default.** `serveGitConnection`, `serveGitService` and every adapter's
  server serve upload-pack only, until `enableReceivePack: true`. A repository's
  `daemon.receivepack` can turn it on for git:// (`allowOverride`, as git-daemon); the httpeers
  native handler never lets it. The HTTP handler decides per request (`resolveRepository`,
  `receivePack.hooks.authorize`).
- **Bound the waiting.** Without limits a client may hold a server's session open forever: give
  `initTimeout` (git-daemon's `--init-timeout`, until the request line) and `timeout` (its
  `--timeout`, each wait for the client), and `connectTimeout` on the client's connectors.
- **Bound the frames.** The adapters never queue without limit: writes wait at the high water
  mark (1 MiB by default, `createByteQueue`). WebSocket frames over `maxFrameSize` (1 MiB) close
  the socket; set `ws`'s `maxPayload` to match. The port multiplexer serves at most `maxPorts`
  sessions at once.
- **Settings are layered.** What a served repository allows (`receive.denyDeletes`, hidden refs,
  `requestPolicy`, hooks) comes from, lowest first: git's defaults, the operator's `settings`, what
  the repository's config sets explicitly, then the resolver's `ServedRepository.settings`. A rule
  that must hold whatever a repository's config says goes in the last layer; hidden-ref lists are
  concatenated across the layers, so a repository cannot unhide what the resolver hides.
- **Identity is the transport's.** Over ssh and httpeers the transport proves who is calling;
  never take an identity from the payload. Over plain git:// and WebSocket there is none: put
  them behind something that authenticates, or serve read-only data.

See also: the [vcs-transport reference](../README.md), the
[vcs-transport-httpeers reference](../../vcs-transport-httpeers/README.md) and the
[vcs-commands reference](../../vcs-commands/README.md).
