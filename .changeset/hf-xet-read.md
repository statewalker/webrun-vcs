---
"@statewalker/vcs-transport-xet": minor
"@statewalker/vcs-transport-lfs": patch
---

**Breaking (vcs-transport-xet):** the package now speaks real Hugging Face Xet (read side), and the webrun private chunk transfer that was advertised as `xet` moves to the `@statewalker/vcs-transport-xet/webrun-chunks` entry point under the transfer id `webrun-chunks`.

New at the package root: `downloadXetFile` (Hub `paths-info`, read token, `/v2/reconstructions` with v1 fallback, xorb `Range` fetches with retries, resume and signed-URL refresh), `xetTokenSource` / `hubReadTokens` (tokens renewed before expiry and once after a 401), `fetchReconstruction`, `httpRanges`, `reconstruct` (streamed, chunk by chunk, with optional per-chunk and per-term verification from a shard), `readXorbChunks` (none, LZ4, ByteGrouping4-LZ4), `readShard` / `writeShard` / `verifierFromShard`, `chunkStream` (gear-hash CDC, 8/64/128 KiB) and the keyed BLAKE3 `chunkHash`, `xorbHash`, `fileHash`, `rangeHash`, checked against the Xet specification's reference files. BLAKE3 comes from `@noble/hashes`.

Safe by default: `downloadXetFile` checks a whole file's Xet hash and size when the last byte is out (`XetIntegrityError`; `verifyFile: false` opts out), so its output is provisional until the loop completes. `verifierFromShard(shard, fileHash)` refuses an answer whose term list is not the file's, and chunks of xorbs the shard does not list, before any byte is yielded (`wholeFile: false` for range requests). Chunks over xet-core's limits (128 KiB uncompressed, 256 KiB payload) are refused. `httpRanges` gives up on a peer that cuts the body every few bytes and reads `Retry-After` dates; a token request shared by several callers is not aborted by one of them.

Migration for the private transfer: import from `@statewalker/vcs-transport-xet/webrun-chunks` and rename `xetUpload` → `webrunChunksUpload`, `xetDownload` → `webrunChunksDownload`, `serveXet` → `serveWebrunChunks`, `XET_TRANSFER(S)` → `WEBRUN_CHUNKS_TRANSFER(S)`, `XetOptions` / `XetTransportEvent` / `XetBatch*` → `WebrunChunksOptions` / `WebrunChunksTransportEvent` / `WebrunChunksBatch*`. The batch now negotiates `webrun-chunks` and the chunk channel is `POST {base}/webrun-chunks/<oid>`, so clients and servers must be upgraded together.

vcs-transport-lfs: documentation only (points to the renamed transfer).
