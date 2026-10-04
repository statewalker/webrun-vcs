/**
 * Public contract for the Git LFS transport skin.
 *
 * This package speaks the STANDARD Git LFS batch protocol + basic (whole-object)
 * transfer, client and server, so it interoperates with real Git LFS hosts. The
 * LFS object id (`oid`) is the whole-file SHA-256 (bare lowercase hex) — the
 * authoritative LFS identity. Bytes live in a `@statewalker/webrun-content-store`,
 * whose object ids are OPAQUE and unrelated to the LFS oid; an injected
 * {@link LfsResolver} maps between the two. This module knows nothing of git
 * objects, chunk-aware dedup, pointers, or sync.
 */

import type { ObjectId } from "@statewalker/webrun-content-store";

/** A Git LFS pointer: `oid` is the whole-object SHA-256 (bare hex), `size` in bytes. */
export interface LfsPointer {
  oid: string;
  size: number;
}

/**
 * Maps an LFS oid (SHA-256 hex) to/from a content-store object id. Injected —
 * this package never persists the map (the working-tree LFS skin owns that);
 * tests use a `Map`-backed resolver.
 */
export interface LfsResolver {
  /** The content-store id for `lfsOid`, or `undefined` if unknown here. */
  toObject(lfsOid: string): Promise<ObjectId | undefined>;
  /** Record that `lfsOid`'s whole bytes are stored under content-store `obj`. */
  record(lfsOid: string, obj: ObjectId): Promise<void>;
}

/** Minimal progress union emitted by {@link import("./client.js").lfsUpload}/`lfsDownload`. */
export type TransportEvent =
  | { type: "batch"; operation: "upload" | "download"; count: number }
  | { type: "object-uploaded"; oid: string }
  | { type: "object-downloaded"; oid: string }
  | { type: "error"; oid: string; reason: string };

/** A fetch-like transport: exactly the `HttpHandler` shape, so a `serveLfs`
 * handler can be injected directly as an in-process loopback in tests. */
export type FetchLike = (request: Request) => Response | Promise<Response>;
