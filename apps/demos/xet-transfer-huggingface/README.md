# webrun-chunks Dedup Transfer over HuggingFace Bytes

## What it is

A Node script that shows chunk-level deduplicated transfer with `@statewalker/vcs-transport-xet`, using a real HuggingFace model file as the payload. It fetches `pytorch_model.bin` once from `huggingface.co` over standard Git-LFS, then moves it between two in-memory content stores over the `webrun-chunks` transfer (formerly named `xet`; not Hugging Face Xet) in loopback (`serveWebrunChunks` server, `webrunChunksDownload` client), proving that only the missing chunks travel. It finishes with the fallback path: the same client against a plain LFS server moves the whole object.

## Layout

```
src/
  main.ts   the four steps
  lib.ts    makeStore() (mem content store), csHash, memResolver(), seedChunks(), spyStore(), stream helpers
```

```
[1] huggingface.co --standard LFS (lfsDownload)--> bytes, SHA-256 == oid
[2] bytes --store.put--> source store  (content-defined chunks, manifest)
[3] dest store pre-seeded with 60% of the unique chunks
    webrunChunksDownload(dest, ..., { fetchImpl: serveWebrunChunks(source, resolver) })
      LFS batch negotiates "webrun-chunks" -> only missing chunks -> dest.putChunk (spied)
[4] webrunChunksDownload(fallback, ..., { fetchImpl: serveLfs(source, resolver) })
      no "webrun-chunks" offered -> basic transfer -> whole object via store.put
```

The loopback URL is `http://chunks.loopback`; no request leaves the process because `fetchImpl` is the server handler itself.

## How to run it

1. `pnpm install && pnpm build` at the repository root (Node 24); the `@statewalker/vcs-transport-*` packages resolve to their built `dist/`.
2. With internet access to `huggingface.co` (needed for step 1 only):

   ```bash
   pnpm --filter @statewalker/vcs-demo-xet-huggingface start
   ```

It prints chunk counts for step 2, the dedup numbers for step 3 (`unique chunks`, `already present`, `chunks transferred`), the fallback result, and ends with `=== SUCCESS ===` and exit code 0.

## The code that matters

```typescript
import { serveLfs } from "@statewalker/vcs-transport-lfs";
import { serveWebrunChunks, webrunChunksDownload } from "@statewalker/vcs-transport-xet/webrun-chunks";

// Chunked transfer: the destination already holds some chunks.
for await (const event of webrunChunksDownload(destStore, destResolver, "http://chunks.loopback", [pointer], {
  fetchImpl: serveWebrunChunks(sourceStore, sourceResolver),
  hashContent: csHash,
})) {
  if (event.type === "error") throw new Error(event.reason);
}

// Fallback: a server that does not offer webrun-chunks.
for await (const event of webrunChunksDownload(fbStore, fbResolver, "http://chunks.loopback", [pointer], {
  fetchImpl: serveLfs(sourceStore, sourceResolver),
  hashContent: csHash,
})) { /* ... */ }
```

## Why it is the way it is

- **`webrun-chunks` is not HuggingFace's Xet.** It is a Git-LFS custom transfer agent with its own protocol (formerly advertised as `xet`): it negotiates `webrun-chunks` inside the standard LFS batch, then exchanges only missing chunks through `@statewalker/webrun-content-transfer`. Reading files from HuggingFace's Xet CAS is what the root of `@statewalker/vcs-transport-xet` does (`downloadXetFile`). The demo uses real HF bytes but runs the transfer between two local peers. The deduplication is real; only the peers are local.
- **Both peers share one chunk hash.** `csHash` is injected into every store and into `webrunChunksDownload` so chunk ids match on both sides; without that, no chunk would ever be "already present". Ids are prefixed `cs-sha256:` so they never collide with a bare LFS oid, and the resolver translates between the two.
- **Dedup is counted over unique chunks.** A content-defined manifest can reference the same chunk more than once, so the demo compares against the set of unique chunk ids. A spy on the destination's `putChunk` records exactly which chunks arrived.
- **The checks are strict.** The run fails unless transferred == unique − pre-seeded, no pre-seeded chunk is sent again, the reconstructed object's SHA-256 equals the oid, and the fallback path made zero `putChunk` calls.

## What will surprise you

- **Step 1 needs the network.** Offline, the script prints `=== FAILED ===` and the fetch error (for example `fetch failed`), exits 1, and never reaches the loopback part. An HTTP error on the pointer prints `failed to read pointer: HTTP <status> (HF unreachable?)`.
- **Failure messages name the broken property:** `object did not chunk — dedup would be trivial`, `dedup mismatch: moved <n>, expected <m>`, `a pre-seeded chunk was re-transferred`, `webrun-chunks reconstruction failed verification`, `basic fallback unexpectedly used chunk-level transfer`.
- **Everything is in memory.** All stores are `memBlobStore()` and all resolvers are `Map`s; nothing is written to disk.

## Reference

### Commands

| Command | What it does |
|---|---|
| `pnpm --filter @statewalker/vcs-demo-xet-huggingface start` | Run the demo (`tsx src/main.ts`) |
| `pnpm --filter @statewalker/vcs-demo-xet-huggingface typecheck` | `tsc --noEmit` |

### Payload

`hf-internal-testing/tiny-random-gpt2`, `pytorch_model.bin`: `oid = sha256:4fab47c129967e0db58e8faf8494e4bd04f2ea79bbe287ac2f90c4183c0194be`, `size = 3561811`.

### Dependencies

`@statewalker/vcs-transport-xet/webrun-chunks` (`serveWebrunChunks`, `webrunChunksDownload`), `@statewalker/vcs-transport-lfs` (`lfsDownload`, `serveLfs`, `sha256Hex`, `createLfsPointer`, `parseLfsPointer`), `@statewalker/webrun-content-store` (content store), `@statewalker/webrun-storage` (`memBlobStore`).
