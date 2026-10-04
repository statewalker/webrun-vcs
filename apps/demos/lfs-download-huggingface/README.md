# @statewalker/vcs-demo-lfs-huggingface

Download a **real HuggingFace model object** over the **standard Git-LFS batch +
basic (whole-object) transfer**, using `@statewalker/vcs-transport-lfs`, and
verify it by its whole-file SHA-256.

This demo runs **live against `huggingface.co`** — no mocks, no fixtures.

## What it shows

1. Reads the Git-LFS **pointer** for `pytorch_model.bin` from the HF repo
   (`GET …/raw/main/pytorch_model.bin`) and parses its `oid` (whole-file
   SHA-256) and `size`.
2. Calls `lfsDownload(store, resolver, lfsBaseUrl, [{ oid, size }])`, which:
   - `POST`s the **standard Git-LFS batch** request
     (`…/info/lfs/objects/batch`, `transfers: ["basic"]`) to HF's real LFS
     endpoint,
   - follows the returned per-object `download` action `href`,
   - streams the bytes into a `@statewalker/webrun-content-store`, and
   - **verifies the whole-object SHA-256 == oid** before storing (as the LFS
     spec requires).
   The injected `fetchImpl` defaults to the global `fetch`, so this is real HTTP
   to HuggingFace.
3. Independently re-verifies: the stored object's SHA-256 equals the pointer
   `oid` and its byte length equals the pointer `size`, then reads the bytes
   back out of the content-store.

## Model used

`hf-internal-testing/tiny-random-gpt2` — its `pytorch_model.bin` is a real
Git-LFS object:

- `oid = sha256:4fab47c129967e0db58e8faf8494e4bd04f2ea79bbe287ac2f90c4183c0194be`
- `size = 3561811` bytes (~3.5 MB — small and fast).

## Run

```bash
pnpm --filter @statewalker/vcs-demo-lfs-huggingface start
```

Exits `0` after the object is downloaded and verified. If HuggingFace is
unreachable, it fails loudly with a clear message (it does not fake the
download).

## Notes

- The bytes are held in an in-memory content-store (`memBlobStore`). Swap in a
  `filesBlobStore` over a `NodeFilesApi` to persist to disk — the transport code
  is unchanged.
- This is the **standard** LFS path (whole objects, SHA-256 oids), which
  interoperates on the wire with real Git-LFS hosts. Chunk-aware **dedup**
  transfer is a separate skin — see the sibling
  `xet-transfer-huggingface` demo.
