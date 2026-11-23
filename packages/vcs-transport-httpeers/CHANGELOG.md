# @statewalker/vcs-transport-httpeers

## 0.4.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/vcs-core crosses a breaking line
  - @statewalker/vcs-transport crosses a breaking line
  - @statewalker/vcs-utils crosses a breaking line

### Patch Changes

- Updated dependencies
- Updated dependencies [a8726f7]
- Updated dependencies [a8726f7]
- Updated dependencies [990a2f7]
- Updated dependencies [a8726f7]
- Updated dependencies [a8726f7]
- Updated dependencies [f291133]
- Updated dependencies [d5813ff]
- Updated dependencies [1038d26]
- Updated dependencies [f91199d]
- Updated dependencies [ca9b22b]
- Updated dependencies [d0db396]
- Updated dependencies [48b5a7e]
  - @statewalker/vcs-transport-lfs@0.6.0
  - @statewalker/vcs-core@0.7.0
  - @statewalker/vcs-utils@0.7.0
  - @statewalker/vcs-transport@0.7.0

## 0.3.0

### Minor Changes

- c72622c: **httpeers connectors, a server side for `messagePortDuplex`, and a transports guide.**
  
  - `@statewalker/vcs-transport-httpeers`: `createHttpeersConnector(options)` registers mesh peers with a `GitTransportRegistry`, so vcs-commands' clone, fetch, pull, push and ls-remote reach them. `httpeers://<peer>/<repo>` (default `mode: "http"`) is smart HTTP over the mesh through `meshRemoteFetch`: a webrun caller to the peer (`call(peer)`, with the membership token, sent only to that peer's origin) or a `fetchImpl` that already reaches peers (`peerUrl`). `httpeers+git://<peer>/<repo>` (`mode: "native"`) is git's native protocol on a stream the host opens (`openStream`, e.g. httpeers-libp2p's `openDuplex`), the token in the stream's open frame. `meshGitDuplexHandler(options)` serves that side, mounted at `HTTPEERS_GIT_DUPLEX_PATH` (`/git`) of httpeers-libp2p's duplex mounts: the token is verified as `meshGitHandler` verifies a request's (a refusal is git's `ERR access denied: …`), then `serveGitConnection` serves the repository the request line names with the same capability rules (`git:read` to fetch; `git:write`, or `git:write-own` inside `refs/peers/<peerId>/*`, to push; receive-pack only with `enableReceivePack`; `daemon.*` never overrides). The stream's proven peer is its only identity (an `access.provenPeer` is ignored). Its `guard(serve, caller, context)` option wraps each authorized stream, e.g. with httpeers-access's `guardStream` to end a revoked member's stream; `MeshCaller.issuedAt` (the token's `iat`) lets a member re-admitted with a newer token through. The peer of an httpeers URL must be letters, digits, `-` or `_` (no `user@`, no `:port`); a `fetchImpl` needs `peerUrl`, which carries the case-sensitive peer id in the path, and a `call` connector addresses its requests to `HTTPEERS_CALL_ORIGIN`. `withMeshToken`/`meshRemoteFetch` take a `scope`: the token goes only to that base URL and below it, and a redirect out of it is refused; the connector pins the token to the repository's URL, as every peer behind one edge shares an origin.
  - `@statewalker/vcs-transport`: `serveOverPort(port, run, options?)` runs any server (`serveOverDuplex` for a fixed service, `serveGitService`) on one end of a port whose other end is `messagePortDuplex`: the non-deprecated replacement for the server side of `createMessagePortDuplex`. `serveOverPort` and `serveGitOverPort` close their port once the session is over (right away when the client took the whole answer, else `lingerTimeout`, default `DEFAULT_PORT_LINGER_TIMEOUT` = 1 s, after the server settled), which closes the other end of a `MessageChannel` too, so a session nobody closes keeps no worker or Node process alive; their teardown closes the port as well. `messagePortDuplex`'s `close` closes its port (idempotent), and a real `MessagePort`'s `close` event fails a session whose other end went away instead of leaving it waiting. `webrunServerDuplex` takes `onDrained` (the run settled and every byte it wrote was handed on). `createDuplexConnector` aborts a pending `open` when the request's `signal` aborts, as when `connectTimeout` passes. A user guide, `docs/transports.md`, covers choosing a transport, registering connectors with `Git.fromWorkingCopy(workingCopy, { transports })`, client and server examples for HTTP, git://, ssh, MessagePort, WebSocket, libp2p and HTTPeers, and the security notes for serving. `createMessagePortDuplex`, `messagePortFetch` and `messagePortServe` stay deprecated (the integration tests still use them).
  - `@statewalker/vcs-workspace`: the `duplexRemote` example uses `messagePortDuplex` / `serveOverPort`.

### Patch Changes

- Updated dependencies [09aa062]
- Updated dependencies [a86d47a]
- Updated dependencies [d5158af]
- Updated dependencies [d84c354]
- Updated dependencies [d84c354]
- Updated dependencies [05a5cae]
- Updated dependencies [9517fc9]
- Updated dependencies [0135cdd]
- Updated dependencies [1777896]
- Updated dependencies [1777896]
- Updated dependencies [20c317e]
- Updated dependencies [21d6866]
- Updated dependencies [e1c44ca]
- Updated dependencies [457680a]
- Updated dependencies [7f697fd]
- Updated dependencies [4e839be]
- Updated dependencies [257e9cf]
- Updated dependencies [de6af72]
- Updated dependencies [a8df903]
- Updated dependencies [0a39cdc]
- Updated dependencies [57846c3]
- Updated dependencies [f078ebd]
- Updated dependencies [5863bf1]
- Updated dependencies [35239a9]
- Updated dependencies [32f7288]
- Updated dependencies [53ecad0]
- Updated dependencies [bbf5ca1]
- Updated dependencies [df0147c]
- Updated dependencies [c72622c]
- Updated dependencies [54f881d]
- Updated dependencies [7314646]
- Updated dependencies [8329312]
- Updated dependencies [2ce29f8]
- Updated dependencies [2ce29f8]
- Updated dependencies [2d0759a]
- Updated dependencies [c80355f]
- Updated dependencies [7314646]
- Updated dependencies [79b57ea]
- Updated dependencies [c3ee332]
- Updated dependencies [bd31e0f]
- Updated dependencies [9e462a8]
- Updated dependencies [1efa875]
- Updated dependencies [98be9b5]
- Updated dependencies [87d6d55]
- Updated dependencies [af93342]
- Updated dependencies [d489ee7]
- Updated dependencies [d489ee7]
- Updated dependencies [2796b2d]
- Updated dependencies [7c63add]
- Updated dependencies [966768c]
- Updated dependencies [68ef504]
- Updated dependencies [bd2140b]
- Updated dependencies [7dc8308]
- Updated dependencies [979230c]
- Updated dependencies [979230c]
- Updated dependencies [9234799]
- Updated dependencies [32ab2c4]
- Updated dependencies [68c571d]
- Updated dependencies [f745816]
- Updated dependencies [2523eff]
- Updated dependencies [b7426bc]
- Updated dependencies [d676bf4]
- Updated dependencies [65e2515]
- Updated dependencies [68cedb7]
- Updated dependencies [f0d8ddd]
- Updated dependencies [0b1ccae]
- Updated dependencies [eb5ad83]
- Updated dependencies [8a603c0]
- Updated dependencies [b31fadc]
- Updated dependencies [5558be8]
- Updated dependencies [c80355f]
- Updated dependencies [35239a9]
- Updated dependencies [0798366]
  - @statewalker/vcs-transport-lfs@0.5.0
  - @statewalker/vcs-core@0.6.0
  - @statewalker/vcs-utils@0.6.0
  - @statewalker/vcs-transport@0.6.0

## 0.2.0

### Minor Changes

- f474fe0: **Runs on webrun-wire's current lines: `@statewalker/webrun-streams` ^0.6, `@statewalker/webrun-http-streams` ^0.8, and (for vcs-transport-xet) `@statewalker/webrun-content-transfer` ^0.4.**
  
  The dependency ranges cross breaking lines, so an application that also depends on webrun-streams or webrun-http-streams moves with them to keep one copy. The transport code is unchanged: it already used the current names (no misspelt aliases), and the `Duplex`, `fetchOverDuplex` / `serveFetchOverDuplex` and `FetchHandler` it uses keep their shape.

### Patch Changes

- Updated dependencies [7d77bf8]
- Updated dependencies [875db86]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [01d2219]
- Updated dependencies [3818fee]
- Updated dependencies [3292f46]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [f474fe0]
- Updated dependencies [d45dfb0]
  - @statewalker/vcs-utils@0.5.0
  - @statewalker/vcs-transport@0.5.0
  - @statewalker/vcs-core@0.5.0
  - @statewalker/vcs-transport-lfs@0.4.0

## 0.1.1

### Patch Changes

- 6e56b86: First release of `@statewalker/vcs-transport-httpeers` through CI. Version 0.1.0 was published by hand (a package's first version, process README §4). This patch, with no code change, goes out through the `publish` job, so npm validates the package's trusted publisher (statewalker/webrun-vcs, ci.yml, environment npm) before its pending window closes.

## 0.1.0

### Minor Changes

- 03b17ed: **Breaking defaults: upload-pack v2 serves any object it has, an atomic push applies the refs refused only before its transaction, and `object-info` is off unless asked for; each stricter behaviour stays available as an option.**
  
  - **vcs-transport, upload-pack:** over protocol v2 a `want <oid>` is now served for any object the repository has, as git's v2 upload-pack (its `parse_want` refuses only a missing object, whatever `uploadpack.allow*SHA1InWant` say); before, v2 defaulted to `"REACHABLE_COMMIT"`. v0/v1 keeps git's `"ADVERTISED"`. `requestPolicy: "REACHABLE_COMMIT"` (on `serveOverDuplex`, `createHttpHandler`, `createGitHttpServer`, `createFetchHandler`, `handleUploadPack(V2)`) refuses objects no branch or tag reaches over both versions, with git's `ERR upload-pack: not our ref <oid>`; no git setting does this over v2. The policy values are documented as the new exported type `UploadPackRequestPolicy`, mapped to git's `uploadpack.*` settings.
  - **vcs-transport, upload-pack v2 errors:** an `ERR` packet is written as git's `packet_writer_error` (no newline) and is no longer followed by a flush, as git dies right after it.
  - **vcs-transport, receive-pack:** an atomic push follows git's `execute_commands_atomic`. A command refused before the ref transaction (connectivity `missing necessary objects`, `shallow update not allowed`, `authorize`, as git's hidden refs) keeps its error and the others are applied together; before, they all got `atomic push failure`. A `preReceive` verdict refusing some refs by name (`rejectedRefs`; git's pre-receive refuses only whole pushes) counts as an `update` hook refusal: the others get `atomic push failure`. The first refusal of git's `update()` checks (ref name, checked-out branch, deletes, non-fast-forward, `bad ref`, the `update` hook) stops the checks, so later `update` hooks no longer run, and the others get `atomic push failure`; a stale old value now fails the transaction (`atomic transaction failed` for every ref in it), as git's ref transaction does when it commits. A branch pointing at a non-commit is refused in `update()` after the `update` hook, as git 2.55+'s `ref_transaction_update`, with its wording `invalid new value provided` (atomic or not; was `failed to update ref`). New `strictAtomic` (`ReceivePackServerOptions`, `serveOverDuplex`, `ReceivePackConfig`): an atomic push that refuses any ref refuses them all (`atomic push failure`), the previous behaviour.
  - **vcs-transport, object-info:** the v2 server no longer advertises `object-info` by default and refuses the command (`invalid command 'object-info'`), as git since 2.45 without `transfer.advertiseObjectInfo` (2.43 and 2.44 always advertise it). New `advertiseObjectInfo: true` (`serveOverDuplex`, the HTTP handlers, `ProcessConfiguration`) advertises `object-info=size type`, as git 2.56 (2.45 to 2.55 advertise a bare `object-info`), limited to the attributes the repository facade can answer (`size` needs `getObjectSize`, `type` `getObjectType`; neither: not advertised), and the command now also answers the `type` attribute (`<oid> <size> <type>`). Every requested object is looked up, attributes or not (`<oid> ` for a missing one), as current git. `SERVER_V2_CAPABILITIES` no longer lists `object-info`; new `OBJECT_INFO_CAPABILITY` and `serverV2Capabilities(capabilities, advertiseObjectInfo)`.
  - **vcs-transport-httpeers:** `meshGitHandler` takes `requestPolicy` and defaults it to `"REACHABLE_COMMIT"`, so a `git:read` caller fetches what the refs publish, not every object the repository holds; pass `"ANY"` for git's v2 behaviour.
  - **vcs-workspace:** `createSyncServer` takes `requestPolicy`, passed to its smart-HTTP and duplex servers (default git's: v2 serves any object; `"REACHABLE_COMMIT"` to refuse objects no ref reaches).
- 4d42bb2: **New package: git and Git LFS over an httpeers mesh.** `meshGitHandler` puts the smart-HTTP server of `@statewalker/vcs-transport` behind `@statewalker/httpeers-access` (Biscuit membership tokens bound to the transport-proven peer, capabilities from mesh roles through `gitRules`, revocation): upload-pack needs `git:read`, receive-pack `git:write`, or `git:write-own`, which limits a push to `refs/peers/<peerId>/*` (refused refs answered `ng … not allowed`, checked before the pack is read). `meshLfsHandler` does the same for `serveLfs` (lock owners are peer ids) and negotiates a `ranged` download transfer when a client offers it, while native git-lfs keeps `basic`. `lfsSwarmDownload` fetches byte ranges of one object from several peers at once, writes them in order within a bounded window, verifies SHA-256 and size at the end, falls back between sources, resumes from a store's partial and reports peers that served wrong bytes. `servePeerConnection`, `peerFetch`, `meshGitFetch` and `meshGitPush` run the existing clients over a webrun `Duplex`. Hardened after review: a stalled peer is timed out (`idleTimeoutMs`) and its chunk taken over by an idle peer (`reassignAfterMs`); a peer ignoring `Range` is read once, sequentially; a copy resumed from bytes another peer wrote never blames its holder; the token goes only to the remote's origin and cross-origin redirects throw `MeshRedirectError`; a repeated `service` parameter is a 400; identity comes only from an edge (`bindProvenPeer`, which `servePeerConnection` calls) or `access.provenPeer`, never from a client's header; `transferAuth` is not offered by `meshLfsHandler`.
- 8db23c6: **Breaking: one push client, like git's send-pack (P3.5).**
  
  `push` (smart HTTP), `pushOverDuplex` and vcs-commands' `PushCommand` now run one implementation (`push-client/`) of git's transport.c, remote.c and send-pack.c push logic, with I/O adapters for smart HTTP (`openHttpReceivePackConnection`) and duplex streams (`openDuplexReceivePackConnection`).
  
  - **Refspecs as `git push`** (`matchPushRefs`): `src:dst`, `+`, `:dst` deletes, `^src`, short names (`main`), `HEAD`, object ids, short destinations of refs the remote has, new short destinations typed from the source (a branch or a tag; otherwise git's "The destination you provided is not a full refname" error), patterns (`--all`, `--tags`), `:` (matching), `prune` (`--prune`; with `+refs/*:refs/*`, `--mirror`). Refspec errors throw `PushRefspecError` before anything is sent.
  - **Per-ref statuses as git's** (`setPushStatus`, `PushRefStatus`, `summary`): `up-to-date`, `[new branch]`/`[new tag]`, fast-forward, `rejected-fetch-first`, `rejected-nonfastforward`, `rejected-needs-force`, `rejected-already-exists` (tags), `rejected-stale` (`forceWithLease`), `rejected-nodelete`, `atomic-push-failed`, `remote-rejected` (`ng`), `remote-failure`. Refused refs are not sent; `atomic` sends nothing when one is refused.
  - **The request:** only advertised capabilities are asked for (`report-status`, `side-band-64k`, `quiet`, `atomic`, `push-options`, `object-format`, `agent`; `ofs-delta` is used, not asked, as git); `atomic`/`pushOptions` the server does not advertise throw. The pack is thin against every advertised tip that is here (and `.have` lines), unless `no-thin` or `thin: false`; deletes only send no pack; nothing to update sends no request. Over smart HTTP the body streams (`streamRequestBody: false` collects it, with a `Content-Length`), `timeout` is an idle timeout, the report is read as it arrives (keep-alives, progress), 401/403 are `AuthenticationError`s.
  - **API changes:** `push(options)` takes `repository` and `refStore` (was `getLocalRef` and `exportPack`) and returns `PushClientResult` (`updates: PushRefUpdate[]`, `unpack`, `packObjects`, `packBytes`, `bytesSent`, `capabilities`; was `HttpPushResult` with `updates: Map`, `unpackStatus`, `objectCount`); new options `forceWithLease`, `trackingValue`, `pushOptions`, `prune`, `thin`, `dryRun`, `quiet`, `onProgress` (was `onProgressMessage`). `pushOverDuplex` takes the same options plus `duplex`/`closeDuplex` (no `delete`); `RefPushStatus` gains `status`, `PushResult` gains `report`. Removed: `httpPush` (use `push`), `clientPushTransitions`/`clientPushHandlers` (the client push FSM), `HttpPushResult`, `RefUpdateResult`, `BasePushOptions`, `BaseDuplexOptions`, `ProcessConfiguration.pushRefspecs`. `readServerGreeting`, `ServerGreeting` and `withTimeout` are exported from the fetch client for the push connections.
  - **vcs-commands `PushCommand`:** runs the push client; `setForceWithLease(ref?, expect?)`, `setPrune`; `setPushAll`/`setPushTags` push `refs/heads/*`/`refs/tags/*`; without refspecs the remote's `push` refspecs, else the current branch; accepted refs move their remote-tracking refs (`refs/remotes/<remote>/…`). `PushStatus.REJECTED_REMOTE_CHANGED` (stale lease) and `RemoteRefUpdate.summary` are new; "fetch first" maps to `REJECTED_NONFASTFORWARD` (as JGit), `forceUpdate` is whether the update was allowed to force, `messages` holds the server's progress.
  - **vcs-transport-httpeers:** `meshGitPush` returns the push client's `PushClientResult` and takes `repository`/`refStore` (was `getLocalRef`/`exportPack`).
  - **Review fixes:** revision sources and lease values (`resolveRevision`, `RepositoryFacade.resolvePrefix` for abbreviated ids); `ForceWithLease.ref` optional (covers the rest); `--prune` with patterns without a colon and with `:`; a pattern wins over `:`; git's messages for duplicate destinations and detached HEADs; a missing or unreadable report keeps refs as `remote-failure`; shallow lines; the idle timeout times the server only, `pushOverDuplex` takes `timeout`/`signal`, an aborted signal sends nothing. `PushCommand`: `callOrThrow` throws on a stale lease, `setStreamRequestBody`, `push.default` (`simple` by default: without refspecs a branch without an upstream on its own remote, or with one of another name, is refused; a detached HEAD is refused), remote-tracking refs follow up-to-date refs too. `RemoteConfigStore` gains `value`/`setValue`.

### Patch Changes

- Updated dependencies [03b17ed]
- Updated dependencies [3b82e8b]
- Updated dependencies [2d1e1c1]
- Updated dependencies [3b59cf9]
- Updated dependencies [44b3105]
- Updated dependencies [e509d97]
- Updated dependencies [658066d]
- Updated dependencies [bc7c6e2]
- Updated dependencies [c60d922]
- Updated dependencies [a44fa4b]
- Updated dependencies [07ace72]
- Updated dependencies [f440ae3]
- Updated dependencies [2075781]
- Updated dependencies [575f0c8]
- Updated dependencies [b6a5d9c]
- Updated dependencies [08309ab]
- Updated dependencies [accab85]
- Updated dependencies [ee92812]
- Updated dependencies [8db23c6]
- Updated dependencies [c2c944f]
- Updated dependencies [c9bfe06]
- Updated dependencies [d04f62d]
- Updated dependencies [8c6e99c]
- Updated dependencies [060fcd0]
- Updated dependencies [6a3a31d]
- Updated dependencies [33612d4]
- Updated dependencies [6964023]
- Updated dependencies [6343211]
- Updated dependencies [5684650]
- Updated dependencies [e77be2f]
- Updated dependencies [bb70139]
- Updated dependencies [0a580e3]
- Updated dependencies [3a69a0f]
- Updated dependencies [0335389]
- Updated dependencies [7392d8e]
- Updated dependencies [60dd7da]
- Updated dependencies [081386c]
- Updated dependencies [c767140]
- Updated dependencies [46f2a01]
- Updated dependencies [b124917]
- Updated dependencies [b758bc0]
  - @statewalker/vcs-transport@0.4.0
  - @statewalker/vcs-utils@0.4.0
  - @statewalker/vcs-core@0.4.0
  - @statewalker/vcs-transport-lfs@0.3.0
