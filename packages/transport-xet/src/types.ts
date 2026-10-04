/**
 * Public contract for the Xet custom LFS transfer agent.
 *
 * This package is a THIN ADAPTER: it negotiates over the STANDARD Git LFS batch
 * API (reusing `@statewalker/vcs-transport-lfs`), advertising a `xet` custom
 * transfer alongside `basic`. When the peer agrees to `xet` it routes bytes
 * through `@statewalker/webrun-content-transfer` (chunk dedup, resumable) over a chunk
 * channel bridged onto the HTTP surface; when the peer is basic-only it falls
 * back to the reused whole-object LFS transfer. Either way the whole-file
 * SHA-256 (the LFS oid) is the interop identity. It knows nothing of git
 * objects, chunking/CDC, the LFS batch/basic internals, or pointers.
 */

import type { FetchLike, LfsPointer, TransportEvent } from "@statewalker/vcs-transport-lfs";
import type { ChunkId, ObjectId } from "@statewalker/webrun-content-store";
import type { TransferCheckpoint, TransferLimits } from "@statewalker/webrun-content-transfer";

export type { FetchLike, LfsPointer, TransportEvent };

/** A chunk-level integrity hasher — the SAME function the content stores use.
 * Forwarded to `content-transfer` so every received chunk is re-hash verified. */
export type HashContent = (
  bytes: import("@statewalker/webrun-content-store").ByteStream,
) => Promise<string>;

/**
 * Options for {@link import("./client.js").xetUpload}/`xetDownload`. All optional
 * and simply forwarded to `content-transfer` on the xet path (ignored on the
 * basic-fallback path, which moves whole objects).
 */
export interface XetOptions {
  /** Injected loopback/HTTP transport; defaults to global `fetch`. */
  fetchImpl?: FetchLike;
  /** Chunk-integrity hasher forwarded to content-transfer. */
  hashContent?: HashContent;
  /** Resume point forwarded to content-transfer (objectIds are content-store ids). */
  checkpoint?: TransferCheckpoint;
  /** Pipeline bounds forwarded to content-transfer. */
  limits?: TransferLimits;
}

/**
 * Progress union emitted by the xet client. Reuses the LFS {@link TransportEvent}
 * (`batch` / `object-uploaded` / `object-downloaded` / `error`) and adds a
 * per-chunk `chunk-sent` so a caller can build a resume checkpoint.
 */
export type XetTransportEvent =
  | TransportEvent
  | { type: "chunk-sent"; oid: string; chunkId: ChunkId; size: number };

/** Re-exported so callers can name the content-store id a checkpoint carries. */
export type { ChunkId, ObjectId };
