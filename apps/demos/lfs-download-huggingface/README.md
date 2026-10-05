# LFS Download from HuggingFace

## What it is

A Node script that downloads one real HuggingFace model file over the standard Git-LFS batch API with the `basic` (whole-object) transfer, using `lfsDownload()` from `@statewalker/vcs-transport-lfs`, stores it in a `@statewalker/webrun-content-store`, and verifies it by its whole-file SHA-256. It runs live against `huggingface.co`; there are no mocks or fixtures.

## Layout

Everything is in `src/main.ts`:

```
GET  https://huggingface.co/<model>/raw/main/pytorch_model.bin      -> LFS pointer text
       parsePointer() -> { oid, size }
lfsDownload(store, resolver, "https://huggingface.co/<model>.git/info/lfs", [{ oid, size }])
  POST <lfs>/objects/batch   { operation: "download", transfers: ["basic"] }
  GET  <download action href>          (whole object, SHA-256 checked == oid)
  store.put(bytes) -> content-store id;  resolver.record(oid, id)
verify: resolver.toObject(oid) -> store.read(id) -> sha256Hex == oid, length == size
```

The model is `hf-internal-testing/tiny-random-gpt2`. Its `pytorch_model.bin` is a real LFS object:

- `oid = sha256:4fab47c129967e0db58e8faf8494e4bd04f2ea79bbe287ac2f90c4183c0194be`
- `size = 3561811` bytes (about 3.5 MB)

## How to run it

1. `pnpm install && pnpm build` at the repository root (Node 24); `@statewalker/vcs-transport-lfs` resolves to its built `dist/`.
2. With internet access to `huggingface.co`:

   ```bash
   pnpm --filter @statewalker/vcs-demo-lfs-huggingface start
   ```

It prints the three steps and ends with:

```
=== SUCCESS ===
model=hf-internal-testing/tiny-random-gpt2 file=pytorch_model.bin
oid=sha256:<oid> size=3561811 verified=true
```

and exit code 0.

## The code that matters

```typescript
import { type LfsResolver, lfsDownload, sha256Hex } from "@statewalker/vcs-transport-lfs";
import { createContentStore } from "@statewalker/webrun-content-store";
import { memBlobStore } from "@statewalker/webrun-storage";

const store = createContentStore(
  { chunks: memBlobStore(), manifests: memBlobStore(), hashContent: contentHash },
  { chunkThreshold: 1024 },
);

const map = new Map<string, string>();
const resolver: LfsResolver = {
  async toObject(oid) { return map.get(oid); },
  async record(oid, id) { map.set(oid, id); },
};

for await (const event of lfsDownload(store, resolver, LFS_BASE_URL, [pointer])) {
  if (event.type === "batch") console.log(`${event.count} object action(s)`);
  else if (event.type === "object-downloaded") console.log(`verified ${event.oid}`);
  else if (event.type === "error") throw new Error(`${event.oid}: ${event.reason}`);
}
```

`lfsDownload` takes an optional fifth argument, `fetchImpl`, which defaults to the global `fetch`.

## Why it is the way it is

- **Standard LFS, whole objects.** The batch request asks only for the `basic` transfer and objects are identified by their whole-file SHA-256, so the same client works against any Git-LFS host. Chunk-level deduplication is a different transfer and is shown by the `xet-transfer-huggingface` demo.
- **LFS oid and content-store id are kept apart.** The content store has its own identity (`contentHash` prefixes ids with `cs-sha256:` so they never collide with a bare LFS oid); the `LfsResolver` maps one to the other. Here the resolver is a `Map`, so nothing persists.
- **Verification twice.** `lfsDownload` rejects an object whose SHA-256 does not match the oid before storing it, as the LFS spec requires. The demo then reads the stored bytes back and checks the hash and the size again, so a store that loses or reorders chunks would also be caught.
- **`chunkThreshold: 1024`** forces even this small file through the content store's chunking path.
- **In memory.** Both blob stores are `memBlobStore()`. To keep the bytes on disk, use `filesBlobStore(files)` from `@statewalker/webrun-storage` over a `FilesApi`; the transport code does not change.

## What will surprise you

- **No network, no run.** Without access to `huggingface.co`, `fetch` fails and the script prints `=== FAILED ===` followed by the error (for example `fetch failed`) and exits 1. It never fakes the download.
- **An HTTP error on the pointer** prints `failed to read pointer: HTTP <status> (HF unreachable?)`. A response that is not an LFS pointer prints `not a Git-LFS pointer:` with the text received.
- **The batch response is not status-checked.** `lfsDownload` parses the batch reply as JSON without looking at the HTTP status, so a rejected batch request shows up as a JSON parse error or a `TypeError` about `objects`, not as an HTTP status.
- **The object is buffered whole.** The download is read with `arrayBuffer()` before hashing, so memory use equals the object size. Fine for 3.5 MB; not for multi-gigabyte weights.
- **Per-object failures** are reported as `LFS transfer failed for <oid>: <reason>`, with reasons such as `download failed: <status>`, `no download action` or `sha256 mismatch`.

## Reference

### Commands

| Command | What it does |
|---|---|
| `pnpm --filter @statewalker/vcs-demo-lfs-huggingface start` | Run the download (`tsx src/main.ts`) |
| `pnpm --filter @statewalker/vcs-demo-lfs-huggingface typecheck` | `tsc --noEmit` |

### Constants (`src/main.ts`)

| Name | Value |
|---|---|
| `MODEL` | `hf-internal-testing/tiny-random-gpt2` |
| `FILE` | `pytorch_model.bin` |
| `POINTER_URL` | `https://huggingface.co/<MODEL>/raw/main/<FILE>` |
| `LFS_BASE_URL` | `https://huggingface.co/<MODEL>.git/info/lfs` (`lfsDownload` appends `/objects/batch`) |

### Dependencies

`@statewalker/vcs-transport-lfs` (batch client, `sha256Hex`), `@statewalker/webrun-content-store` (content store), `@statewalker/webrun-storage` (`memBlobStore`).
