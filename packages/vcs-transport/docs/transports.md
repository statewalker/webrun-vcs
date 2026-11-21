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

### Serving repositories on disk as `git http-backend` does

A server for repositories on disk usually wants what native git's `http-backend` gives: the
repository's own hooks, the settings of its config, and the services switched on and off by
`http.*`. `createServedFetchHandler` takes the same resolver as `serveGitConnection` (a path to a
`ServedRepository`), so one resolver serves git://, ssh and HTTP alike:

```typescript
import { createBasePathResolver, createServedFetchHandler } from "@statewalker/vcs-transport";
import { remoteHookSession, servedRepositoryOf } from "@statewalker/vcs-commands";

const handleGit = createServedFetchHandler({
  resolveRepository: createBasePathResolver({
    files,                 // the storage the repositories are in
    basePath: "/srv/git",  // http-backend's GIT_PROJECT_ROOT
    exportAll: true,       // GIT_HTTP_EXPORT_ALL (else git-daemon-export-ok is required)
    openRepository: async (gitDir) => {
      // the repository's config includes stay inside the storage (see "Security notes")
      const opened = await host.worktree.openRepository?.(`..${gitDir}`, {
        configIncludes: "files",
      });
      if (!opened) return undefined;
      const hooks = remoteHookSession(host, opened); // host: a WorkingCopy with a hook runner
      return servedRepositoryOf(opened, hooks ? { hooks } : {});
    },
  }),
  // http-backend's REMOTE_USER: who the web server authenticated
  remoteUser: (request) => userFromAuthorization(request.headers.authorization),
  // http-backend's REMOTE_ADDR, if the server knows the client's address
  remoteAddr: (request) => request.headers["x-forwarded-for"],
});
Deno.serve(handleGit);
```

The repository path handed to `resolveRepository` is decoded segment by segment, as a web server
decodes `PATH_INFO` for http-backend: `/my%20repo.git/info/refs` asks for `/my repo.git`. A
segment that encodes `/`, `\` or NUL, or does not decode, is a `404` that never reaches the
resolver, and the decoded path must still pass `isUnsafeServicePath`.

A push runs the repository's pre-receive, update, post-receive and post-update hooks (their
output relayed as `remote:` lines), push-to-checkout for `receive.denyCurrentBranch=updateInstead`,
and the reference-transaction hook through `ServedRepository.around`, which lasts until the push
has ended, not only until the response head is out. pre-receive gets `GIT_QUARANTINE_PATH`,
`GIT_OBJECT_DIRECTORY` and `GIT_ALTERNATE_OBJECT_DIRECTORIES` as git sets them, so a hook running
native git (`git cat-file -t $new`) reads the pushed objects before they are published. As in
tmp-objdir.c's `env_append`, the repository's objects are appended to the
`GIT_ALTERNATE_OBJECT_DIRECTORIES` the host sets (the host environment's
`alternateObjectDirectories`; `createNodeGitHostEnvironment` reads it from `env`), after a `:`
and C-quoted when the directory holds a `:` or starts with `"`.
Every hook of the push (reference-transaction and push-to-checkout included) inherits
`REMOTE_USER` and `REMOTE_ADDR` from `remoteUser` and `remoteAddr`, and, where the host sets no
committer, `GIT_COMMITTER_NAME=<user>` and `GIT_COMMITTER_EMAIL=<user>@http.<addr>`
(`anonymous`, `(none)` when unknown), as http-backend's `run_service` hands them to receive-pack.

Settings are layered as `serveGitService` layers them: git's defaults, the operator's `settings`,
what the repository's config sets (`receive.*`, `uploadpack.hideRefs`, `receive.hideRefs`,
`transfer.hideRefs`), then the resolver's `ServedRepository.settings`.

The services follow http-backend's rules, the repository's config over the handler's options,
with two differences that matter to a server of many tenants' repositories:

| Service | Default | Config | Option |
|---|---|---|---|
| upload-pack (fetch, clone) | served | `http.uploadpack` | `enableUploadPack` |
| receive-pack (push) | served only to a request with a `remoteUser` | `http.receivepack` | `enableReceivePack` |
| dumb protocol (`HEAD`, `info/refs`, `objects/...`) | served; `objects/...` refused while refs are hidden | `http.getanyfile` | `getAnyFile` |

- An option the operator sets to `false` is final: a repository's `http.receivepack=true` (or
  `http.uploadpack`, `http.getanyfile`) cannot turn back on what the operator turned off, where
  http-backend lets the repository's config decide. An option left unset (or `true`) is still
  overridden by the repository's config, as in git.
- The dumb protocol is answered only where upload-pack is served (`403` otherwise), where
  http-backend serves it whatever `http.uploadpack` says, and `info/refs` leaves out the refs
  upload-pack hides (`transfer.hideRefs`, `uploadpack.hideRefs`), where http-backend lists them
  all.

A POST to `git-upload-pack` or `git-receive-pack` whose `Content-Type` is not exactly
`application/x-git-<service>-request` is answered `415 Unsupported Media Type` with
http-backend's body, `Expected POST with Content-Type '<expected>', but received '<actual>'
instead.`, after the service check (a refused service is still a `403`).

A service that is not enabled, or an unknown one, is answered `403` with an empty body, as
http-backend answers it ("Service not enabled: 'receive-pack'" goes to `logger.info`, where
http-backend writes it to its stderr); a native client prints `The requested URL returned error:
403`. An unknown path or repository is a `404`, the wrong method a `405` with `Allow`.
`allowOverride: false` keeps the repositories' `http.*` from overriding the options. A
failure (a throwing `remoteUser`, `remoteAddr` or `around`, an `around` that returns without serving)
is a `500` with the fixed body `Internal server error`; the detail goes to `logger.error`.

#### The dumb protocol

With `http.getanyfile` on (the default, as in http-backend) a native client that speaks only
the dumb protocol (`GIT_SMART_HTTP=0`, or an old client) clones and fetches from the handler
as from http-backend:

```console
$ GIT_SMART_HTTP=0 git clone https://git.example.com/r.git
```

The handler answers http-backend's dumb routes with its content types and cache headers:

| Path | Content-Type | Caching |
|---|---|---|
| `HEAD`, `info/refs` | `text/plain` | `info/refs` no-cache; `HEAD` none, as http-backend |
| `objects/info/packs` | `text/plain; charset=utf-8` | no-cache |
| `objects/info/alternates`, `objects/info/http-alternates` | `text/plain` | no-cache |
| `objects/xx/<38 or 62 hex>` | `application/x-git-loose-object` | a year (`public, max-age=31536000`) |
| `objects/pack/pack-<hex>.pack` | `application/x-git-packed-objects` | a year |
| `objects/pack/pack-<hex>.idx` | `application/x-git-packed-objects-toc` | a year |

`HEAD` and `info/refs` come from the refs, as http-backend generates them, and so does
`objects/info/packs`: one `P pack-<hex>.pack` line per pack of the repository's own (not its
alternates'), the youngest first, then an empty line. `git update-server-info` is not needed,
and the files it writes are not read. The other files are read from the git directory
through `ServedRepository.files`, with `Content-Length` and `Last-Modified` as
`send_local_file` sends them; a missing one is a `404`. Paths outside http-backend's table
(upper-case hex, a short name) are a `404` before any lookup.

The files of a repository with `objects/info/alternates` are served as they are (a dumb client
then fetches from the alternate, given `http.followRedirects=true`), but the repository's
object store reads no alternates: an annotated tag whose object only an alternate holds is
listed in `info/refs` without its peeled `^{}` line, where http-backend peels it.

`servedRepositoryOf` sets `files` for a repository opened from a FilesApi
(`OpenedRepository.files`, set by `Worktree.openRepository`), reading below its repository
directory (a linked worktree's common directory). A resolver of its own builds it with
`servedGitFilesOf(files, gitDir)`. A repository without `files`, one kept in a key-value, SQL or
in-memory store, has no loose objects or packs on disk to hand out: its dumb `HEAD` and
`info/refs` are still answered from its refs, and every `objects/...` path is a `404`, so a
dumb client cannot clone it (a smart client can).

Four differences from http-backend keep a server of many tenants' repositories safe:

- The object files fail closed under hidden refs. They hold everything, the objects only
  hidden refs reach included, so while any hidden-ref pattern applies to upload-pack (the
  operator's `settings.hideRefs` / `uploadPackHideRefs`, the repository's `transfer.hideRefs` /
  `uploadpack.hideRefs`, a resolver's `ServedRepository.settings`), every `objects/...` path
  is refused (`403`, as a disabled `getanyfile`) unless the operator passes `getAnyFile: true`
  or the repository sets `http.getanyfile=true` explicitly (and `allowOverride` is not
  false). `HEAD` and `info/refs` are still served: they leave the hidden refs out. With
  nothing hidden, http-backend's default stands and the files are served.

  ```ts
  // hidden refs, and the dumb protocol's files served anyway (their objects included)
  createServedFetchHandler({ resolveRepository, settings: { hideRefs: ["refs/internal"] }, getAnyFile: true });
  ```

- Only the object directory is served: a file whose path, symbolic links followed where the
  FilesApi can read them, leaves `<git dir>/objects` (as resolved) is a `404`, so an
  `objects/info/alternates` linked to `../config` hands out nothing; http-backend opens
  whatever a link names. An absolute link (an `objects` directory linked to
  `/srv/shared/objects`) is followed only when the FilesApi tells where it is rooted on the
  host (`rootDirectory`, as the Node FilesApi does) and the target lies below that root;
  otherwise what it names is a `404`.
- A refusal or a missing file carries the no-cache headers once. http-backend sends them
  after the headers its route already set (a second copy, or beside a loose object's one-year
  caching).
- A `HEAD` request for a file is answered with its headers (`Content-Length` from its
  stats) and no body, without opening it; a `GET` opens the file at the first read of its
  body and closes it when the response is cancelled.

A server that relies on `uploadpack.allowAnySHA1InWant` staying off without hiding refs (an
unreachable object a client must not fetch by id) turns the dumb protocol off with
`getAnyFile: false`: its object files hand out every object the repository holds.

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
the client with `serveOverPort` on the server. `serveGitOverPort` and `serveOverPort` close their
port once the session is over (and with it the other end of a `MessageChannel`), so a session
nobody closes keeps neither a worker nor a Node process alive: right away when the client took the
whole answer, else `lingerTimeout` (1 s) after the server settled, for a client such as
`fetchOverDuplex`, which stops reading at the end of the protocol. `createMessagePortDuplex`, `messagePortFetch` and
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
`fetchImpl` and `` peerUrl: (peer) => `http://local/${edgeKey}/${peer}` `` instead of `call`; the
token is then optional, since the edge adds it. `peerUrl` is required there and carries the peer
in the path: peer ids are case-sensitive and a URL host is lower-cased. A token the connector
sends is pinned to the repository's URL under it (every peer behind an edge shares one origin), and
a redirect out of it is refused. The peer of an httpeers URL is letters, digits, `-` and `_`; a
`user@` or a `:port` is refused.

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
`ERR access denied: …` over the native stream; the stream's proven peer is the only identity
(an `access.provenPeer` is ignored). A native stream is authorized once, when it opens; to end the
stream of a member revoked while it runs, give the handler httpeers-access's `guardStream` as its
`guard`:

```typescript
import { createRevocations, guardStream } from "@statewalker/httpeers-access";

const revocations = createRevocations(); // kept in sync with the hub's
meshGitDuplexHandler({
  access,
  resolveRepository,
  guard: (serve, caller, context) =>
    guardStream(serve, {
      peerId: context.peerId,
      revocations,
      // the token's iat: a member re-admitted with a newer token gets through
      ...(caller.issuedAt !== undefined
        ? { claims: { sub: context.peerId, issuedAt: caller.issuedAt } }
        : {}),
    }),
});
```

Wrapping the handler from outside (`(input, ctx) => guardStream((i) => handler(i, ctx), { peerId:
ctx.peerId, revocations })(input)`) works too, but without the token's `issuedAt`: a peer revoked
once then stays refused, even with a token minted after.

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

`open`'s `signal` aborts when `connectTimeout` passes or when the command's own signal aborts
(`GitConnectRequest.signal`), whichever comes first; the session then fails, and a stream that
still opens is closed.

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
- **Confine config includes on a shared host.** `Worktree.openRepository(location, options)`
  reads the opened repository's config as git does by default (`configIncludes: true`): an
  `include.path` or `includeIf.*.path` with a `~/` path, an absolute path or one climbing above
  the storage (`../../etc/x`) is read from the host's filesystem through the worktree's
  environment. That is what a local fetch from `../other` expects, and git-daemon and
  http-backend do the same, so it stays the default. But on a server whose repositories are
  configured by people who must not read the server's files, an include would bring any file
  the server process can read into the repository's settings (and a device or a huge file
  into its memory). Open served repositories with `configIncludes: "files"`: only files inside
  the repository's own git directory are included (its common directory, and a linked
  worktree's git directory: not another tenant's `../other.git/config`), where their symbolic
  links lead, no `~/` path, an absolute path only inside the storage's `rootDirectory`, and none
  larger than 1 MiB (`MAX_CONFINED_INCLUDE_SIZE`, our hardening: git has no limit, and a pack file
  is no configuration); or `false` to follow none. A storage without `lstat`/`readlink` cannot
  tell links apart, so `"files"` follows no include there. The system and global config files
  are the operator's and keep git's rules either way. The same option reaches the settings the
  object and ref stores read (`createGitFilesBackend({ configIncludes })`).
- **Hooks already run the owner's code.** With a hook runner installed, a served repository's
  `pre-receive`, `update` and `post-receive` scripts run on the server with its rights, so its
  owner can read whatever the server can, includes or not. Include confinement matters for
  serving without hooks (no `hookRunner`, or hooks for repositories whose owners are trusted
  only); confine the hooks themselves with the runner (a sandbox, a container) where owners
  are not trusted.
- **Identity is the transport's.** Over ssh and httpeers the transport proves who is calling;
  never take an identity from the payload. Over plain git:// and WebSocket there is none: put
  them behind something that authenticates, or serve read-only data.

See also: the [vcs-transport reference](../README.md), the
[vcs-transport-httpeers reference](../../vcs-transport-httpeers/README.md) and the
[vcs-commands reference](../../vcs-commands/README.md).
