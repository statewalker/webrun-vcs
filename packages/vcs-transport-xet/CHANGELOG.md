# @statewalker/vcs-transport-xet

## 0.5.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/vcs-transport-lfs crosses a breaking line

### Patch Changes

- Updated dependencies [09aa062]
  - @statewalker/vcs-transport-lfs@0.5.0

## 0.4.0

### Minor Changes

- f474fe0: **Runs on webrun-wire's current lines: `@statewalker/webrun-streams` ^0.6, `@statewalker/webrun-http-streams` ^0.8, and (for vcs-transport-xet) `@statewalker/webrun-content-transfer` ^0.4.**
  
  The dependency ranges cross breaking lines, so an application that also depends on webrun-streams or webrun-http-streams moves with them to keep one copy. The transport code is unchanged: it already used the current names (no misspelt aliases), and the `Duplex`, `fetchOverDuplex` / `serveFetchOverDuplex` and `FetchHandler` it uses keep their shape.

### Patch Changes

- Updated dependencies [f474fe0]
  - @statewalker/vcs-transport-lfs@0.4.0

## 0.3.0

### Minor Changes

- a44fa4b: **Breaking (vcs-transport-xet):** the package now speaks real Hugging Face Xet (read side), and the webrun private chunk transfer that was advertised as `xet` moves to the `@statewalker/vcs-transport-xet/webrun-chunks` entry point under the transfer id `webrun-chunks`.
  
  New at the package root: `downloadXetFile` (Hub `paths-info`, read token, `/v2/reconstructions` with v1 fallback, xorb `Range` fetches with retries, resume and signed-URL refresh), `xetTokenSource` / `hubReadTokens` (tokens renewed before expiry and once after a 401), `fetchReconstruction`, `httpRanges`, `reconstruct` (streamed, chunk by chunk, with optional per-chunk and per-term verification from a shard), `readXorbChunks` (none, LZ4, ByteGrouping4-LZ4), `readShard` / `writeShard` / `verifierFromShard`, `chunkStream` (gear-hash CDC, 8/64/128 KiB) and the keyed BLAKE3 `chunkHash`, `xorbHash`, `fileHash`, `rangeHash`, checked against the Xet specification's reference files. BLAKE3 comes from `@noble/hashes`.
  
  Safe by default: `downloadXetFile` checks a whole file's Xet hash and size when the last byte is out (`XetIntegrityError`; `verifyFile: false` opts out), so its output is provisional until the loop completes. `verifierFromShard(shard, fileHash)` refuses an answer whose term list is not the file's, and chunks of xorbs the shard does not list, before any byte is yielded (`wholeFile: false` for range requests). Chunks over xet-core's limits (128 KiB uncompressed, 256 KiB payload) are refused. `httpRanges` gives up on a peer that cuts the body every few bytes and reads `Retry-After` dates; a token request shared by several callers is not aborted by one of them.
  
  Migration for the private transfer: import from `@statewalker/vcs-transport-xet/webrun-chunks` and rename `xetUpload` → `webrunChunksUpload`, `xetDownload` → `webrunChunksDownload`, `serveXet` → `serveWebrunChunks`, `XET_TRANSFER(S)` → `WEBRUN_CHUNKS_TRANSFER(S)`, `XetOptions` / `XetTransportEvent` / `XetBatch*` → `WebrunChunksOptions` / `WebrunChunksTransportEvent` / `WebrunChunksBatch*`. The batch now negotiates `webrun-chunks` and the chunk channel is `POST {base}/webrun-chunks/<oid>`, so clients and servers must be upgraded together.
  
  vcs-transport-lfs: documentation only (points to the renamed transfer).
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

- Updated dependencies [a44fa4b]
- Updated dependencies [2075781]
- Updated dependencies [575f0c8]
- Updated dependencies [0335389]
- Updated dependencies [46f2a01]
- Updated dependencies [b124917]
  - @statewalker/vcs-transport-lfs@0.3.0

## 0.2.4

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/vcs-transport-lfs@0.2.3

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/content-store@0.1.1
  - @statewalker/content-transfer@0.1.1
  - @statewalker/vcs-transport-lfs@0.1.1
