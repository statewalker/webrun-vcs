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
  getLocalRef: (ref) => refStore.get(ref),
  exportPack: (wants, exclude) => repository.exportPack(wants, exclude),
});
result.updates.get(`refs/peers/${myPeerId}/main`); // { ok: true }
```

`token` is the membership token the hub minted (`mintToken` of
`@statewalker/httpeers-access/issuer`), or a function returning a current one. `connection.call`
is the caller `Duplex` of a webrun-streams connection to the peer.

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
  `receivePack.hooks` run after this check.

The identity is the transport's: `servePeerConnection` replaces any `x-httpeers-peer` header the
caller sent with the peer it was told the transport proved, and `peerFetch`/`withMeshToken`
never send one. Behind another edge, pass `access.provenPeer`.

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
again: no byte is received twice. Into a store with partials (`createFilesLfsStore`), what
arrived stays when every source fails, and the next call resumes from there. When the last
byte is in, the object is verified as a whole before it becomes visible; on a mismatch, or when
no source is left, the holders are tried one at a time until a copy verifies, and the sources
whose bytes differ from the verified object are reported in `bad`.

## API

| Export | Description |
|--------|-------------|
| `meshGitHandler(options)` | git smart-HTTP handler behind the mesh's access checks. `options`: `createFetchHandler`'s (protocol v2, limits, `receivePack`), plus `repository` + `refStore` or `resolveRepository`, `access`, `ownNamespace?` |
| `meshLfsHandler(options)` | LFS handler behind the mesh's access checks. `options`: `serveLfs`'s, plus `objects`, `access`, `locks?` (`identify` optional), `ranged?` (default true), `authorize?(request, operation, caller, lock?)` |
| `lfsSwarmDownload(pointers, sources, store, opts?)` | Multi-source download → `{ downloaded, failed, bad, received }`. `opts`: `chunkSize?`, `windowBytes?`, `signal?` |
| `meshGitFetch(options)`, `meshGitPush(options)` | The fetch client and push of `@statewalker/vcs-transport` through a peer (`call` or `fetchImpl`, and `token`) |
| `servePeerConnection(handler, { remotePeer })` | The serving end of a peer connection: a webrun `Duplex` |
| `peerFetch(call, token)`, `withMeshToken(fetchImpl, token)`, `meshRemoteFetch({ call?, fetchImpl?, token })` | The calling end: a `fetchImpl` with the token |
| `withMeshAccess(access, next)` | The access middleware for other handlers: `next(request, { peer, capabilities })` |
| `gitRules({ contributors? })`, `GIT_READ`, `GIT_WRITE`, `GIT_WRITE_OWN` | The default rule set and capability names |
| `MeshAccessOptions` | `{ issuer, rules?, keys?, revocation?, selfPeer?, provenPeer?, now? }` |
| `RANGED_TRANSFER` | `"ranged"` |

## Limits

- `ranged` covers downloads. Uploads are whole `PUT`s as in `basic`; uploads in parts
  (`Content-Range`, resumable across peers) are not implemented, because the LFS stores keep
  partials only as an appended prefix.
- tus uploads are not supported.
