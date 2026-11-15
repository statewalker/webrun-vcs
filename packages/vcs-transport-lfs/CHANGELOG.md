# @statewalker/vcs-transport-lfs

## 0.4.0

### Minor Changes

- f474fe0: **Runs on webrun-wire's current lines: `@statewalker/webrun-streams` ^0.6, `@statewalker/webrun-http-streams` ^0.8, and (for vcs-transport-xet) `@statewalker/webrun-content-transfer` ^0.4.**
  
  The dependency ranges cross breaking lines, so an application that also depends on webrun-streams or webrun-http-streams moves with them to keep one copy. The transport code is unchanged: it already used the current names (no misspelt aliases), and the `Duplex`, `fetchOverDuplex` / `serveFetchOverDuplex` and `FetchHandler` it uses keep their shape.

### Patch Changes

- Updated dependencies [7d77bf8]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
- Updated dependencies [d45dfb0]
  - @statewalker/vcs-utils@0.5.0

## 0.3.0

### Minor Changes

- 2075781: **Git LFS conformance with native git-lfs: pointers, server, client, git-lfs object layout.** Tested against git-lfs 3.4 (`git push`, `git lfs push`, `git lfs pull`, `git clone`).
  
  - **Pointers:** `parseLfsPointer(textOrBytes)` reads as git-lfs's `DecodeFrom`: the first 1024 bytes only (`LFS_POINTER_MAX_SIZE`), Go `TrimSpace` trimming, CRLF, the hawser and git-media version aliases, `ext-N-name` lines (returned as `extensions`), a signed or zero-padded size, nothing after `size`. It agrees with native git-lfs on 48 cases. `formatLfsPointer` writes extensions by priority and an empty object as `""` (as git-lfs does; before, a full pointer).
  - **Stores:** new `LfsObjectStore` interface, with `contentStoreLfsObjects(store, resolver)` and `createFilesLfsStore(files, root?)`: a `FilesApi` in git-lfs's layout (`lfs/objects/aa/bb/<oid>`, partials at `lfs/incomplete/<oid>.part`), verified writes through `lfs/tmp/` and an atomic `move`, shared with native git-lfs.
  - **Server:** `serveLfs(store, resolver, opts?)` or `serveLfs(objects, opts?)` with `LfsServerOptions`: `authorize` (401 with `LFS-Authenticate`, 403), `transferAuth` (per-action headers, `expires_in`, `authenticated`), `maxBatchObjects`/`maxBatchBytes` (413), `maxObjectSize`, `publicUrl`, `documentationUrl`. Upload batches give no actions for held objects and a `verify` action for the others (`POST …/verify`); `hash_algo` other than sha256 is 409; per-object 404/422; `GET` answers `Range` with 206/416. Error bodies are `{ message, request_id?, documentation_url? }`. **Changed:** hrefs keep the endpoint's path prefix (before, only the origin), so the server works under `…/info/lfs`.
  - **Client:** `lfsUpload`/`lfsDownload` also take an `LfsObjectStore`, `opts.headers` and `opts.credentials`; action headers replace the client's case-insensitively; the batch answer must match what was asked (oids and sizes); uploads call `verify`; downloads skip held objects and resume from a store's partials with `Range: bytes=N-`. **Changed:** a batch answered with a non-2xx status throws, with the server's message (before, its body was parsed as a batch response).
  - **Hardening (review):** the client sends `opts.headers`/`opts.credentials` only to hrefs on the endpoint's origin (new `opts.headersFor(href)` for other origins); a 206 from the wrong offset or without `Content-Range`, a 416, or a partial that changes while it is appended to drop the held bytes and restart once from zero (`LfsPartialChangedError`); the files store moves through `moveCompleting` and never leaves a temporary file after a throw; `partial.exclusive` serializes downloads across stores over one FilesApi instance and root; `PUT` and verify authorize before validating; a 500 carries only a generic message and `request_id`, the error going to the new `onError` option.
- 575f0c8: **Git LFS File Locking API, client and server** (git-lfs `docs/api/locking.md`), interoperable with native `git lfs lock`, `locks`, `locks --verify`, `unlock` and the pre-push lock check (`lfs.<url>.locksverify=true`), and with Gitea's locking API.
  
  - **Client:** `lfsLocks(url, fetchImpl?, opts?)` gives `createLock(path, ref?)`, `listLocks({ path?, id?, cursor?, limit?, refspec? })`, `allLocks(query?)` (follows `next_cursor`, yields each lock once by id, and stops at an empty page), `verifyLocks({ ref?, cursor?, limit? })` → `{ ours, theirs, nextCursor? }` and `unlock(id, { force?, ref? })`, all in `application/vnd.git-lfs+json`. Refusals throw `LfsLockError` with the `status` (401 with the `authenticate` challenge, 403, 404, 409 with the existing `lock`, …). `headers`/`credentials` go only to the endpoint's origin; redirects are followed by the client, so they never follow one elsewhere (`headersFor(href)` applies there).
  - **Server:** `serveLfs(store, { locks: { store, identify, admin?, perRef?, pageSize? } })` serves `POST/GET …/locks`, `POST …/locks/verify` and `POST …/locks/<id>/unlock`. `authorize` runs first (as `download` for a listing, `upload` otherwise, with the lock call as a new optional third argument). The owner comes from `identify(request)`, which is **required** (`serveLfs` throws without it) and must name only a verified caller, since whoever it names can unlock that user's locks; `basicUserIdentity` reads the Basic user name without checking the password and is safe only behind an `authorize` that verifies Basic passwords. No identity is 401 with `LFS-Authenticate`. Paths are normalised (`normalizeLockPath`), a held path is 409 with the existing lock, force-unlocking someone else's lock needs `admin(request, lock)`, verify splits by owner, pages use opaque cursors, and refs are ignored unless `perRef: true` (an empty ref name is no ref). Without `locks`, every lock route is 404 (git-lfs: locking not supported); before, `POST …/locks/verify` reached the object verify route. A `POST …/locks/verify` whose body names an `oid` stays the object verify, so an endpoint that itself ends in `/locks` keeps its object verify with or without `locks`.
  - **Stores:** `LfsLockStore` with `createMemoryLockStore()` and `createFilesLockStore(files, root?)` (one JSON file per lock under `lfs/locks/`, created with an exclusive create; a file left empty or half-written by a crashed writer is removed and created over).
- 0335389: **Large objects stream: incremental SHA-256, streaming LFS and webrun-chunks.** No LFS or webrun-chunks path holds a whole object in memory any more.
  
  - **vcs-utils:** new `createSha256()`, an incremental `Hasher` like `createSha1()` (on `@noble/hashes`). The streaming request body helpers (`requestBody`, `fetchWithRequestBody`, `shouldStreamRequestBody`, `supportsRequestStreams`, `isBrowserContext`, `toReadableStream`) moved here from vcs-transport and are exported from `@statewalker/vcs-utils/streams`.
  - **vcs-transport:** re-exports those helpers from vcs-utils; its public API is unchanged.
  - **vcs-transport-lfs (breaking):** `lfsUpload` sends a streaming body (`duplex: "half"`, with `content-length` from the local object's manifest; browsers collect unless the new sixth argument `{ streamRequestBody: true }` is passed, and drop `content-length` from a streamed body). An object whose local size disagrees with the pointer or the batch response is reported as `size mismatch` and skipped, and any per-object failure, a rejected `fetch` included, is that object's `error` event instead of aborting the rest. `lfsDownload` and the server's `PUT` store the body as it arrives, hashing it on the way, and record no mapping when its SHA-256 does not match. A refused object is not removed (store ids come from content, so removing it could delete a concurrent honest upload of the same bytes); the store's `gc`, with the resolver's values as live roots, reclaims it. `lfsDownload` also checks the pointer size and reports the new reason `size mismatch`, and the server caps a `PUT` at its `content-length` (`422`); a body that runs past either is cut off and its stream cancelled. Unread responses (upload replies, failed downloads) are cancelled. The server's `GET` streams with `content-length`. `sha256Hex` now takes a buffer or a stream (`ByteSource`) and no longer uses Web Crypto. New: `createLfsPointer` (streamed oid and size, the hashing half of a clean filter), `formatLfsPointer`, `parseLfsPointer` (strict: `version` first, other keys in alphabetical order, size a safe integer), `LFS_POINTER_VERSION`, `storeVerified`, and the types `LfsTransferOptions`, `LfsStoreResult`, `ByteSource`.
  - **vcs-transport-xet (breaking):** a webrun-chunks download (then named `xet`; see the `hf-xet-read` changeset for the rename) verifies the assembled object by streaming it through SHA-256 and also checks its size (`size mismatch`). The server now verifies an uploaded object's whole-file SHA-256 against the oid while assembling it, and refuses it on a mismatch (`webrun-chunks upload refused: sha256 mismatch`). As with LFS, a refused object on either side is left for the store's `gc`, never removed. New `WebrunChunksOptions.streamRequestBody` for the basic fallback.
- 46f2a01: **Move to `@statewalker/webrun-files` 0.12 and webrun-sync 0.3.** webrun-files, -browser, -mem and -node go from ^0.11.0 to ^0.12.0. webrun-storage, -content-store, -content-transfer and -files-sync go from ^0.2.0 to ^0.3.0, which are their releases on webrun-files 0.12. Both are breaking lines. webrun-files 0.12 resolves `..` segments before any filter, guard or mount sees a path, and throws `Path climbs above the root` for a path above the root. Consumers must move to webrun-files 0.12 too, so a single copy of the core is installed.
  
  - **vcs-store-files:** `GitResolutionStore` without an explicit `worktreePath` now defaults it to `dirname(gitDir)`, not the literal path `<gitDir>/..`. That literal path left the resolution to the store, and with `gitDir` at the root it now throws.
  - **vcs-core:** `decodeTreeEntries` now refuses entry names that git fsck rejects: empty, `.`, `..`, or containing `/`. Such names come only from crafted trees, for example fetched from a remote. Checkout turns entry names into worktree paths, and webrun-files 0.12 resolves `..`, so a tree `sub/` → `..` → `.git/config` would otherwise write into the repository's own `.git`.
- b124917: **webrun-wire dependencies move to their published lines:** `@statewalker/webrun-streams` ^0.4.0 (from ^0.2.0) and `@statewalker/webrun-http-streams` ^0.6.0 (from ^0.2.1). The demos also move to `@statewalker/webrun-streams-livekit` ^0.3.0 and `@statewalker/webrun-streams-signaling` ^0.3.0, and add `@statewalker/webrun-rpc` ^0.12.0 and `@statewalker/webrun-msgpack` ^0.11.0.
  
  - **vcs-transport-lfs, vcs-transport-xet:** `serveLfs` and `serveWebrunChunks` (then `serveXet`; renamed in the same release, see `hf-xet-read`) are now typed as returning `FetchHandler`, `(request: Request) => Response | Promise<Response>`, instead of the deprecated `HttpHandler`. The two are the same type (`HttpHandler` is now an alias), so callers need no change.
  - **vcs-transport:** no API change. `serveGitOverWebrunHttp` and `webrunHttpFetch` pick up webrun-http-streams' behaviour since 0.2.x: a 400 or 500 no longer sends the error's `stack` in `x-webrun-error`; a call ends however its exchange ends (a body read to its end no longer holds a port of a multiplexed link); an aborted request's signal ends its response body at once; and a served `Request` has a `signal` that aborts when the caller leaves.
  - **Peers must upgrade together.** webrun-streams 0.3 removed `emulateMux`; every webrun transport now runs `webrun-rpc`'s port stack (`messageTargetOver…` plus `overPipe` / `multiplexPort` with `msgpackCodec`, `connect` / `serve`), whose wire format differs. A peer running `webrunClientDuplex` or `serveRepoOverWebrun` over `emulateMux` cannot talk to one on the port stack. The webrtc and livekit demos are ported to the port stack, with a 1 MiB per-port window so transfers pipeline instead of waiting a round trip per chunk.

### Patch Changes

- a44fa4b: **Breaking (vcs-transport-xet):** the package now speaks real Hugging Face Xet (read side), and the webrun private chunk transfer that was advertised as `xet` moves to the `@statewalker/vcs-transport-xet/webrun-chunks` entry point under the transfer id `webrun-chunks`.
  
  New at the package root: `downloadXetFile` (Hub `paths-info`, read token, `/v2/reconstructions` with v1 fallback, xorb `Range` fetches with retries, resume and signed-URL refresh), `xetTokenSource` / `hubReadTokens` (tokens renewed before expiry and once after a 401), `fetchReconstruction`, `httpRanges`, `reconstruct` (streamed, chunk by chunk, with optional per-chunk and per-term verification from a shard), `readXorbChunks` (none, LZ4, ByteGrouping4-LZ4), `readShard` / `writeShard` / `verifierFromShard`, `chunkStream` (gear-hash CDC, 8/64/128 KiB) and the keyed BLAKE3 `chunkHash`, `xorbHash`, `fileHash`, `rangeHash`, checked against the Xet specification's reference files. BLAKE3 comes from `@noble/hashes`.
  
  Safe by default: `downloadXetFile` checks a whole file's Xet hash and size when the last byte is out (`XetIntegrityError`; `verifyFile: false` opts out), so its output is provisional until the loop completes. `verifierFromShard(shard, fileHash)` refuses an answer whose term list is not the file's, and chunks of xorbs the shard does not list, before any byte is yielded (`wholeFile: false` for range requests). Chunks over xet-core's limits (128 KiB uncompressed, 256 KiB payload) are refused. `httpRanges` gives up on a peer that cuts the body every few bytes and reads `Retry-After` dates; a token request shared by several callers is not aborted by one of them.
  
  Migration for the private transfer: import from `@statewalker/vcs-transport-xet/webrun-chunks` and rename `xetUpload` → `webrunChunksUpload`, `xetDownload` → `webrunChunksDownload`, `serveXet` → `serveWebrunChunks`, `XET_TRANSFER(S)` → `WEBRUN_CHUNKS_TRANSFER(S)`, `XetOptions` / `XetTransportEvent` / `XetBatch*` → `WebrunChunksOptions` / `WebrunChunksTransportEvent` / `WebrunChunksBatch*`. The batch now negotiates `webrun-chunks` and the chunk channel is `POST {base}/webrun-chunks/<oid>`, so clients and servers must be upgraded together.
  
  vcs-transport-lfs: documentation only (points to the renamed transfer).
- Updated dependencies [3b82e8b]
- Updated dependencies [2d1e1c1]
- Updated dependencies [3b59cf9]
- Updated dependencies [e509d97]
- Updated dependencies [bc7c6e2]
- Updated dependencies [c60d922]
- Updated dependencies [07ace72]
- Updated dependencies [b6a5d9c]
- Updated dependencies [ee92812]
- Updated dependencies [c2c944f]
- Updated dependencies [060fcd0]
- Updated dependencies [0a580e3]
- Updated dependencies [0335389]
- Updated dependencies [7392d8e]
- Updated dependencies [46f2a01]
  - @statewalker/vcs-utils@0.4.0

## 0.2.3

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/content-store@0.1.1
