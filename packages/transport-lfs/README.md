# @statewalker/vcs-transport-lfs

The standard Git LFS batch protocol plus basic (whole-object) transfer, client and server, over a content-store.

## Overview

`vcs-transport-lfs` speaks the **standard Git LFS batch protocol** (`POST /objects/batch`) plus basic whole-object transfer, both client and server, so the system interoperates on the wire with real Git LFS hosts. The LFS object id (`oid`) is the whole-file **SHA-256** (bare lowercase hex — the authoritative LFS identity); bytes live in a `@statewalker/webrun-content-store`, whose object ids are opaque and unrelated, and an injected `LfsResolver` maps between the two.

It is the LFS skin of Axis B. Its job is *standard* whole-object transfer; chunk-aware dedup transfer is `@statewalker/vcs-transport-xet`, and pointer clean/smudge is the working-tree LFS filter. This module knows nothing of git objects, chunks, pointers, or sync.

## Installation

```bash
pnpm add @statewalker/vcs-transport-lfs
```

## Quick Start

```typescript
import { lfsDownload, lfsUpload, serveLfs, sha256Hex } from "@statewalker/vcs-transport-lfs";

// Server side: a content-store + resolver, exposed as a fetch-like LFS handler.
const handler = serveLfs(serverStore, serverResolver); // (request: Request) => Response

// Client side: object present locally, its sha256 oid known via the resolver.
const ptr = { oid: sha256Hex(bytes), size: bytes.length };

for await (const event of lfsUpload(clientStore, clientResolver, "http://lfs.host", [ptr], handler)) {
  if (event.type === "object-uploaded") console.log("uploaded", event.oid);
}

// Download by sha256 oid into the local content-store; bytes are verified to hash to the oid.
for await (const event of lfsDownload(localStore, localResolver, "http://lfs.host", [ptr], handler)) {
  if (event.type === "object-downloaded") console.log("downloaded", event.oid);
}
```

The `fetchImpl` argument defaults to global `fetch`; passing a `serveLfs` handler gives an in-process loopback (as the tests do).

## API

- **`serveLfs(store, resolver): HttpHandler`** — server: a fetch-like handler answering the batch API + basic PUT/GET over a `ContentStore`.
- **`lfsUpload(store, resolver, url, oids, fetchImpl?): AsyncIterable<TransportEvent>`** — client upload of whole objects.
- **`lfsDownload(store, resolver, url, oids, fetchImpl?): AsyncIterable<TransportEvent>`** — client download; reassembled bytes are verified against the LFS oid.
- **`sha256Hex(bytes): string`** — the whole-object SHA-256 (bare hex) LFS oid.
- Batch protocol constants + shapes: `BASIC_TRANSFER`, `LFS_CONTENT_TYPE`, `BatchRequest` / `BatchResponse` / `BatchObjectRequest` / `BatchObjectResponse` / `BatchAction`.

Injected types: `LfsResolver` (`toObject(oid)` / `record(oid, objId)` — the package never persists the map), `LfsPointer` (`{ oid, size }`), `FetchLike`, `TransportEvent`.

## Notes

- **Wire-standard interop.** On the wire it moves whole objects with SHA-256 oids, so it talks to real Git LFS hosts; locally the content-store assembles the whole object on read and stores it on write.
- **Whole-object SHA-256 is verified** on transfer, as the LFS spec requires.
- **Injected resolver.** The oid ↔ content-store-id map is injected, not owned here (the working-tree LFS skin owns persistence); tests use a `Map`-backed resolver.
- No chunk dedup (see `@statewalker/vcs-transport-xet`), no pointer clean/smudge (working-tree filter). Built red/green TDD.
