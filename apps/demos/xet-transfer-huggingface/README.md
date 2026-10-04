# @statewalker/vcs-demo-xet-huggingface

Chunk-dedup transfer of **real HuggingFace model bytes** over our `xet`
custom-transfer agent (`@statewalker/vcs-transport-xet`), run as a **loopback**,
plus the **basic-LFS fallback** path.

## Our xet vs. HuggingFace Xet — read this first

`@statewalker/vcs-transport-xet` is a Git-LFS **custom transfer agent** using
**our** protocol: it negotiates a `xet` transfer inside the standard LFS batch,
then moves only the **missing chunks** through `@statewalker/webrun-content-transfer`
(content-defined chunk dedup). If the peer does not speak our `xet`, it falls
back to whole-object basic LFS.

HuggingFace's production **Xet** uses a **different CAS protocol** on the wire —
we cannot negotiate our `xet` against `huggingface.co`. So this demo:

- fetches the **real** `pytorch_model.bin` bytes from HF **once** using the
  standard LFS basic transfer (same path as the `lfs-download-huggingface`
  demo), then
- transfers those real bytes between **two local content-stores** over **our**
  xet **loopback** (`serveXet` server <-> `xetDownload` client).

The chunk dedup is genuine; only the transport peers are local. No live Xet
server is needed to run this.

## What it shows

1. **Real HF bytes** — download `pytorch_model.bin` via standard LFS, SHA-256
   verified.
2. **CDC chunking** — put the bytes into a source content-store; the ~3.5 MB
   object splits into hundreds of content-defined chunks.
3. **Dedup** — pre-seed the destination store with ~60% of the object's chunks,
   then `xetDownload` from `serveXet(source)`. A `putChunk` spy on the
   destination proves **only the missing chunks moved** (transferred ==
   total − pre-seeded), yet the destination reconstructs the exact object
   (whole-file SHA-256 == the HF oid).
4. **Fallback** — the same `xetDownload` against a non-xet `serveLfs` server
   transparently moves the whole object and verifies SHA-256.

## Model used

`hf-internal-testing/tiny-random-gpt2`, `pytorch_model.bin`
(`oid = sha256:4fab47c129967e0db58e8faf8494e4bd04f2ea79bbe287ac2f90c4183c0194be`,
`size = 3561811`).

## Run

```bash
pnpm --filter @statewalker/vcs-demo-xet-huggingface start
```

Exits `0` after printing the chunk-dedup stats (total vs. transferred) and both
verifications. It fetches the real HF object once (needs network for step 1);
the xet transfer and fallback run entirely loopback.
