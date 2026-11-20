# @statewalker/vcs-transport-httpeers

git and Git LFS between the peers of an [httpeers](https://github.com/statewalker/httpeers) mesh.

## Examples

### Serve a repository to the mesh

```typescript
import {
  gitRules,
  meshGitHandler,
  meshLfsHandler,
  servePeerConnection,
} from "@statewalker/vcs-transport-httpeers";
import { createFilesLfsStore, createMemoryLockStore } from "@statewalker/vcs-transport-lfs";

const access = { issuer: hubPeerId, rules: gitRules({ contributors: true }) };
const git = meshGitHandler({ repository, refStore, access });
const lfs = meshLfsHandler({
  objects: createFilesLfsStore(files, ".git"),
  access,
  locks: { store: createMemoryLockStore() },
});
const handler = (request: Request) =>
  new URL(request.url).pathname.includes("/info/lfs/") ? lfs(request) : git(request);

// for each incoming connection, once the transport proved who is calling:
const duplex = servePeerConnection(handler, { remotePeer: provenPeerId });
```

`repository` and `refStore` are a `RepositoryFacade` and a `RefStore` of
`@statewalker/vcs-transport` (`createRepositoryFacade({ history })`,
`createTransportRefStore(history.refs)`). `duplex` is a webrun `Duplex`: hand it to any
`webrun-streams-*` adapter's `serve`, or call it directly in-process.

### Fetch and push through a peer connection

```typescript
import { meshGitFetch, meshGitPush } from "@statewalker/vcs-transport-httpeers";

const remote = { url: "http://peer-b/repo.git", call: connection.call, token };

await meshGitFetch({ ...remote, repository, refStore, refspecs: ["+refs/heads/*:refs/remotes/b/*"] });

const result = await meshGitPush({
  ...remote,
  refspecs: [`refs/heads/main:refs/peers/${myPeerId}/main`],
  repository,
  refStore,
});
result.updates[0]; // { remoteRef: `refs/peers/${myPeerId}/main`, status: "ok", summary: "[new reference]", … }
```

`token` is the membership token the hub minted (`mintToken` of
`@statewalker/httpeers-access/issuer`), or a function returning a current one. `connection.call`
is the caller `Duplex` of a webrun-streams connection to the peer.

### Clone, fetch and push with vcs-commands

```typescript
import { Git } from "@statewalker/vcs-commands";
import { createDefaultTransports } from "@statewalker/vcs-transport";
import { createHttpeersConnector } from "@statewalker/vcs-transport-httpeers";

const transports = createDefaultTransports();
transports.register(createHttpeersConnector({ token, call: (peer) => connectionTo(peer).call }));
const git = Git.fromWorkingCopy(workingCopy, { transports });

await git.clone().setURI(`httpeers://${peerB}/repo.git`).call();
await git.push().setRemote("origin").setRefSpecs(`main:refs/peers/${myPeerId}/main`).call();
```

`httpeers://<peer>/<repo>` is smart HTTP over the mesh (the peer serves `meshGitHandler`), with
the token sent only to that peer. `call(peer)` returns a webrun caller `Duplex` to the peer; a
member whose own `fetch` already reaches peers passes `fetchImpl` and `peerUrl` instead.

### git's native protocol on an httpeers stream

```typescript
import { createDuplexMounts, openDuplex, serveDuplex } from "@statewalker/httpeers-libp2p";
import {
  createHttpeersConnector,
  HTTPEERS_GIT_DUPLEX_PATH,
  meshGitDuplexHandler,
} from "@statewalker/vcs-transport-httpeers";

// the serving peer
const mounts = createDuplexMounts();
mounts.provide(HTTPEERS_GIT_DUPLEX_PATH, meshGitDuplexHandler({ access, resolveRepository, enableReceivePack: true }));
await serveDuplex({ node, mounts });

// the calling peer: httpeers+git://<peer>/<repo>
transports.register(
  createHttpeersConnector({
    mode: "native",
    token,
    openStream: ({ peer, path, token }) => openDuplex({ node, peerId: peer, path, token }),
  }),
);
await git.fetch().setRemote(`httpeers+git://${peerB}/repo.git`).call();
```

httpeers-libp2p's duplex streams (`/httpeers-duplex/1.0.0`) carry the token in their open frame
and give the handler the peer the Noise handshake proved. `meshGitDuplexHandler` verifies the
token exactly as `meshGitHandler` does, answers a refusal with git's `ERR access denied: …`, then
serves git-daemon's request line through `serveGitConnection` with the same capability rules
(`git:read` to fetch; `git:write`, or `git:write-own` inside `refs/peers/<peerId>/*`, to push,
and only with `enableReceivePack`). A stream is authorized once, when it opens: wrap the handler
with httpeers-access's `guardStream` to end a revoked member's stream. This package does not
depend on httpeers-libp2p; the handler and `openStream` only match its shapes.

### Download one LFS object from several peers

```typescript
import { lfsSwarmDownload, meshRemoteFetch } from "@statewalker/vcs-transport-httpeers";

const result = await lfsSwarmDownload(
  pointers,
  [
    { name: "b", url: "http://b/repo.git/info/lfs", fetchImpl: meshRemoteFetch({ call: toB, token }) },
    { name: "c", url: "http://c/repo.git/info/lfs", fetchImpl: meshRemoteFetch({ call: toC, token }) },
    { name: "d", url: "http://d/repo.git/info/lfs", fetchImpl: meshRemoteFetch({ call: toD, token }) },
  ],
  createFilesLfsStore(files, ".git"),
  { chunkSize: 4 * 1024 * 1024 },
);
result.downloaded; // the oids stored, each verified (SHA-256 and size)
result.bad; // peers whose bytes did not match the verified object
```

## What it is

A small package between three others: the git smart-HTTP server and clients of
`@statewalker/vcs-transport`, the LFS server and store of `@statewalker/vcs-transport-lfs`, and
the access decision of `@statewalker/httpeers-access` (Biscuit membership tokens, Datalog rules,
revocation). The core transport packages stay independent of the mesh; nothing here is a new
wire protocol. Requests travel as Fetch exchanges over a webrun `Duplex`
(`@statewalker/webrun-http-streams`), so the same handlers serve over a libp2p stream, a
WebRTC channel, a MessagePort or in-process.

## Authorization

Each request's membership token (header `x-httpeers-token`) is verified against the mesh's
issuer and bound to the peer the transport proved: no token is 401, an expired token or one
minted for another peer is 401, a forged token or one of another mesh is 403, a token whose
roles the rule set does not allow at all is 403, a revoked or downgraded member's old token is
403. Capabilities come from the token's roles through the serving peer's own rules
(`gitRules`):

| Role | Capabilities (default) | With `gitRules({ contributors: true })` |
|------|------------------------|------------------------------------------|
| `admin` | `git:read`, `git:write` | the same |
| `member` | `git:read` | `git:read`, `git:write-own` |
| `hidden` | `git:read` | the same |

- upload-pack (fetch, clone, ls-remote) and LFS downloads and lock listings need `git:read`;
- receive-pack needs `git:write` (any ref) or `git:write-own`; LFS uploads and lock changes need
  either;
- a `git:write-own` caller pushes only into `refs/peers/<peerId>/*` (`ownNamespace` changes the
  prefix). Commands outside it are refused before the pack is read, as
  `ng <ref> not allowed: this peer writes refs/peers/<peerId>/* only`, the other commands of the
  push go on, and a push refused for every ref stores nothing. The application's own
  `receivePack.hooks` run after this check;
- `git:read` covers what the refs publish: by id, a caller may fetch the ref tips and the
  commits they reach, over protocol v0 and v2 alike (`requestPolicy: "REACHABLE_COMMIT"`).
  An object no branch or tag reaches (a refused push's leftovers, history a ref was rewound
  past) is `ERR upload-pack: not our ref <oid>`. Plain git's v2 serves any object it has;
  `requestPolicy: "ANY"` serves the mesh that way.

The identity is the transport's, and binding it is the edge's job. `servePeerConnection` binds
every request to the peer its transport proved (`bindProvenPeer`), replacing any
`x-httpeers-peer` header the caller sent. Another edge (an HTTP server in front of the
handlers, say) calls `bindProvenPeer(request, peer)` itself, or the handlers get
`access.provenPeer`. A request no edge bound, with no `provenPeer`, is anonymous whatever
peer header it carries, so every token it presents is refused (401): mounted straight on HTTP
without an edge, the handlers never trust a client's header. A request with a repeated
`service` parameter is refused (400), so the authorization and the git server cannot read it
two ways.

On the calling side the token goes only to the remote's origin (`origin`, which
`meshGitFetch`/`meshGitPush` take from their `url`; otherwise the first request's).
`peerFetch`/`withMeshToken` never send a peer header, handle redirects themselves (a
same-origin redirect of a request without a body is followed; one to another origin throws
`MeshRedirectError`), and send nothing mesh-related to another origin, such as an LFS action
href on a CDN.

## LFS

`meshLfsHandler` is `serveLfs` with the mesh's authorization, lock owners named by the caller's
proven peer id (callers with `git:write` may force-unlock), and the `ranged` transfer: a batch
offering `transfers: ["ranged", "basic"]` is answered `transfer: "ranged"`, one offering only
`basic` (native git-lfs) gets `basic`. `ranged` has the basic transfer's actions; its downloads
are ranged `GET`s (`Range: bytes=a-b`, answered 206). Native git-lfs works against the handler
as against any LFS server (it sends the token through `http.extraHeader`).

`lfsSwarmDownload` asks every source with one batch which objects it holds, cuts the ranges
still missing into chunks, and runs one worker per holder over a shared queue. Chunks are
written in object order as they arrive, so at most `windowBytes` wait in memory (two chunks
per source by default). A source that fails is dropped and the rest of its chunk is queued
again: no byte is received twice. A request that brings nothing for `idleTimeoutMs` (30 s)
fails and its source is dropped; before that, a source with nothing to do takes over a chunk
another source has sent nothing for `reassignAfterMs` (at most 5 s), so one stalled peer does
not stall the download. A source ignoring `Range` (answering 200) is read on from the same
response through the ranges nobody else has taken, and then does no more ranged work: it is
never read from the start once per chunk. Into a store with partials (`createFilesLfsStore`), what
arrived stays when every source fails, and the next call resumes from there. When the last
byte is in, the object is verified as a whole before it becomes visible; on a mismatch, or when
no source is left, the holders are tried one at a time (those that failed first, last) until a
copy verifies. A copy that fails after resuming from held bytes, which another source may have
sent, says nothing about its holder: it is dropped and that holder tried again from the first
byte. A source is reported in `bad` only for bytes it sent: a range whose hash differs from the
verified object, or a copy it sent whole that failed to verify.

## API

| Export | Description |
|--------|-------------|
| `meshGitHandler(options)` | git smart-HTTP handler behind the mesh's access checks. `options`: `createFetchHandler`'s (protocol v2, limits, `receivePack`), plus `repository` + `refStore` or `resolveRepository`, `access`, `ownNamespace?` (a `refs/` prefix; a trailing `/` is added), `requestPolicy?` (default `"REACHABLE_COMMIT"`, not git's v2 `"ANY"`) |
| `createHttpeersConnector(options)` | A transport connector for vcs-commands' remote commands. `mode: "http"` (default, scheme `httpeers`): `call(peer, request)` (with `token`) or `fetchImpl` (+ `peerUrl?(peer)`, `token?`), `headers?`. `mode: "native"` (scheme `httpeers+git`): `openStream({ peer, path, token, request }, { signal })` returning a webrun `Duplex` or `{ call, close? }`, `streamPath?` (default `HTTPEERS_GIT_DUPLEX_PATH`), `connectTimeout?`. Both: `name?`, `schemes?` |
| `meshGitDuplexHandler(options)` | git's native protocol for httpeers-libp2p's duplex mounts: `(input, { peerId, path?, token? })`. `options`: `serveGitConnection`'s (`resolveRepository`, `settings`, `initTimeout`, `timeout`, `informativeErrors`), `access`, `enableReceivePack?` (default false), `ownNamespace?`, `requestPolicy?` (default `"REACHABLE_COMMIT"`), `onSettled?(result, error, caller)` |
| `HTTPEERS_GIT_DUPLEX_PATH`, `HTTPEERS_SCHEME`, `HTTPEERS_NATIVE_SCHEME` | `"/git"`, `"httpeers"`, `"httpeers+git"` |
| `meshLfsHandler(options)` | LFS handler behind the mesh's access checks. `options`: `serveLfs`'s except `transferAuth` (per-action headers would let a transfer skip the capability check), plus `objects`, `access`, `locks?` (`identify` optional), `ranged?` (default true), `authorize?(request, operation, caller, lock?)` |
| `lfsSwarmDownload(pointers, sources, store, opts?)` | Multi-source download → `{ downloaded, failed, bad, received }`. `opts`: `chunkSize?`, `windowBytes?` (positive), `idleTimeoutMs?`, `reassignAfterMs?`, `signal?` |
| `meshGitFetch(options)`, `meshGitPush(options)` | The fetch client and push of `@statewalker/vcs-transport` through a peer (`call` or `fetchImpl`, and `token`) |
| `servePeerConnection(handler, { remotePeer })` | The serving end of a peer connection: a webrun `Duplex` |
| `bindProvenPeer(request, peer)` | For other edges: binds a request to the peer its transport proved |
| `peerFetch(call, token, opts?)`, `withMeshToken(fetchImpl, token, opts?)`, `meshRemoteFetch({ call?, fetchImpl?, token, origin? })` | The calling end: a `fetchImpl` with the token, pinned to the remote's origin. `opts`: `origin?`, `maxRedirects?` (5) |
| `MeshRedirectError` | Thrown for a redirect to another origin, or too many |
| `gitServiceOf(request)`, `isReceivePackRequest(request)` | The service of a git request, read as the transport's server reads it |
| `withMeshAccess(access, next)` | The access middleware for other handlers: `next(request, { peer, capabilities })` |
| `gitRules({ contributors? })`, `GIT_READ`, `GIT_WRITE`, `GIT_WRITE_OWN` | The default rule set and capability names |
| `MeshAccessOptions` | `{ issuer, rules?, keys?, revocation?, selfPeer?, provenPeer?, now? }` |
| `RANGED_TRANSFER` | `"ranged"` |

## Limits

- `ranged` covers downloads. Uploads are whole `PUT`s as in `basic`; uploads in parts
  (`Content-Range`, resumable across peers) are not implemented, because the LFS stores keep
  partials only as an appended prefix.
- tus uploads are not supported.
