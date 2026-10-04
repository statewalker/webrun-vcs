# @statewalker/vcs-transport-xet

A Git LFS custom transfer agent: chunk-dedup large-file transfer that stays LFS-interoperable, with a basic-LFS fallback.

## Overview

`vcs-transport-xet` is the chunk-aware, resumable, deduplicated large-file transfer path of Axis B — exposed as a Git LFS **custom transfer agent** (the "Xet" model). It is a **thin adapter** over two existing pieces: `@statewalker/vcs-transport-lfs` for batch negotiation and the basic whole-object fallback, and `@statewalker/webrun-content-transfer` for the chunk-dedup engine. It negotiates over the standard LFS batch API advertising a `xet` custom transfer alongside `basic`; when the peer agrees it moves only the missing chunks, otherwise it falls back to whole-object basic LFS.

The whole-file SHA-256 (the LFS oid) remains the interop identity either way. It owns no chunking/CDC (`content-store`), no batch/basic internals (`vcs-transport-lfs`), no chunk protocol (`content-transfer`), and no pointers.

## Installation

```bash
pnpm add @statewalker/vcs-transport-xet
```

## Quick Start

```typescript
import { serveXet, xetDownload, xetUpload } from "@statewalker/vcs-transport-xet";

// Server advertises `xet` (and `basic`) in the LFS batch, and serves chunk negotiation.
const handler = serveXet(serverStore, serverResolver);

const ptr = { oid: /* whole-file sha256 hex */ oid, size: bytes.length };

// Upload against a xet-capable server sends only the chunks the server is missing.
for await (const event of xetUpload(clientStore, clientResolver, "http://xet.host", [ptr], {
  fetchImpl: handler,
  hashContent: csHash, // chunk-integrity hasher, forwarded to content-transfer
})) {
  if (event.type === "chunk-sent") console.log("chunk", event.chunkId);
  if (event.type === "object-uploaded") console.log("uploaded", event.oid);
}

// Against a basic-only peer, the same call transparently falls back to whole-object LFS.
await drain(xetDownload(localStore, localResolver, "http://xet.host", [ptr], { fetchImpl: handler }));
```

## API

- **`serveXet(store, resolver): HttpHandler`** — server: advertises `xet` in the LFS batch and serves the chunk-dedup negotiation, reusing `serveLfs` for basic.
- **`xetUpload(store, resolver, url, oids, opts?): AsyncIterable<XetTransportEvent>`** — upload via chunk dedup when the peer speaks `xet`, else basic LFS.
- **`xetDownload(store, resolver, url, oids, opts?): AsyncIterable<XetTransportEvent>`** — the download counterpart.
- Transfer constants + shapes: `XET_TRANSFER`, `BASIC_TRANSFER`, `XET_TRANSFERS`, `XetBatchResponse` / `XetBatchObjectResponse` / `XetBatchAction`.

`XetOptions` (all optional, forwarded to `content-transfer` on the xet path, ignored on the basic path): `fetchImpl` (defaults to global `fetch`), `hashContent`, `checkpoint` (`TransferCheckpoint`), `limits` (`TransferLimits`). Re-exports `LfsPointer`, `LfsResolver`-facing types, `TransportEvent`, `XetTransportEvent`, `ChunkId`, `ObjectId`.

## Notes

- **Thin adapter.** It composes `vcs-transport-lfs` (batch + basic) with `content-transfer` (chunks); it holds no engine of its own.
- **Negotiate then route.** When `transfer: xet` is agreed, bytes go through `content-transfer` over a chunk channel bridged onto the HTTP surface (dedup + resumable); otherwise it defers to basic LFS. The `chunk-sent` events let a caller build a resume checkpoint.
- **LFS-interoperable.** The whole-file SHA-256 oid is the shared identity, so a xet client and a basic host still exchange the right object.
- Built red/green TDD (dedup / fallback / interop / resume suites).
