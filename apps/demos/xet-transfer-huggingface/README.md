# Xet Chunk-Dedup Transfer over HuggingFace Bytes

## What it is

A Node script that shows chunk-level deduplicated transfer with `@statewalker/vcs-transport-xet`, using a real HuggingFace model file as the payload. It fetches `pytorch_model.bin` once from `huggingface.co` over standard Git-LFS, then moves it between two in-memory content stores over the `xet` transfer in loopback (`serveXet` server, `xetDownload` client), proving that only the missing chunks travel. It finishes with the fallback path: the same client against a plain LFS server moves the whole object.

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
    xetDownload(dest, ..., { fetchImpl: serveXet(source, resolver) })
      LFS batch negotiates "xet" -> only missing chunks -> dest.putChunk (spied)
[4] xetDownload(fallback, ..., { fetchImpl: serveLfs(source, resolver) })
      no "xet" offered -> basic transfer -> whole object via store.put
```

The loopback URL is `http://xet.loopback`; no request leaves the process because `fetchImpl` is the server handler itself.

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
import { serveXet, xetDownload } from "@statewalker/vcs-transport-xet";

// Chunked transfer: the destination already holds some chunks.
for await (const event of xetDownload(destStore, destResolver, "http://xet.loopback", [pointer], {
  fetchImpl: serveXet(sourceStore, sourceResolver),
  hashContent: csHash,
})) {
  if (event.type === "error") throw new Error(event.reason);
}

// Fallback: a server that does not offer xet.
for await (const event of xetDownload(fbStore, fbResolver, "http://xet.loopback", [pointer], {
  fetchImpl: serveLfs(sourceStore, sourceResolver),
  hashContent: csHash,
})) { /* ... */ }
```

## Why it is the way it is

- **This `xet` is not HuggingFace's Xet.** `@statewalker/vcs-transport-xet` is a Git-LFS custom transfer agent with its own protocol: it negotiates `xet` inside the standard LFS batch, then exchanges only missing chunks through `@statewalker/webrun-content-transfer`. HuggingFace's production Xet uses a different CAS protocol on the wire, so it cannot be negotiated against `huggingface.co`. The demo therefore uses real HF bytes but runs the transfer between two local peers. The deduplication is real; only the peers are local.
- **Both peers share one chunk hash.** `csHash` is injected into every store and into `xetDownload` so chunk ids match on both sides; without that, no chunk would ever be "already present". Ids are prefixed `cs-sha256:` so they never collide with a bare LFS oid, and the resolver translates between the two.
- **Dedup is counted over unique chunks.** A content-defined manifest can reference the same chunk more than once, so the demo compares against the set of unique chunk ids. A spy on the destination's `putChunk` records exactly which chunks arrived.
- **The checks are strict.** The run fails unless transferred == unique − pre-seeded, no pre-seeded chunk is sent again, the reconstructed object's SHA-256 equals the oid, and the fallback path made zero `putChunk` calls.

## What will surprise you

- **Step 1 needs the network.** Offline, the script prints `=== FAILED ===` and the fetch error (for example `fetch failed`), exits 1, and never reaches the loopback part. An HTTP error on the pointer prints `failed to read pointer: HTTP <status> (HF unreachable?)`.
- **Failure messages name the broken property:** `object did not chunk — dedup would be trivial`, `dedup mismatch: moved <n>, expected <m>`, `a pre-seeded chunk was re-transferred`, `xet reconstruction failed verification`, `basic fallback unexpectedly used chunk-level transfer`.
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

`@statewalker/vcs-transport-xet` (`serveXet`, `xetDownload`), `@statewalker/vcs-transport-lfs` (`lfsDownload`, `serveLfs`, `sha256Hex`), `@statewalker/webrun-content-store` (content store), `@statewalker/webrun-storage` (`memBlobStore`).
