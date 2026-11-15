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

/** A pointer extension line, `ext-<priority>-<name> sha256:<oid>` (spec v1). */
export interface LfsPointerExtension {
  /** 0 to 9: the order the extensions run in. */
  priority: number;
  name: string;
  /** The SHA-256 (bare hex) of the extension's input. */
  oid: string;
}

/** A Git LFS pointer: `oid` is the whole-object SHA-256 (bare hex), `size` in bytes. */
export interface LfsPointer {
  oid: string;
  size: number;
  /** Extension lines, by priority; only present when the pointer has any. */
  extensions?: LfsPointerExtension[];
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

/** A fetch-like transport: exactly the `FetchHandler` shape, so a `serveLfs`
 * handler can be injected directly as an in-process loopback in tests. */
export type FetchLike = (request: Request) => Response | Promise<Response>;

/** Options for {@link import("./client.js").lfsUpload} and `lfsDownload`. */
export interface LfsTransferOptions {
  /**
   * Whether an upload streams its request body (`duplex: "half"`). Default:
   * stream outside browsers where the runtime supports it, collect in browsers
   * (see `shouldStreamRequestBody` in `@statewalker/vcs-utils/streams`). A
   * streamed body that the browser refuses before reading it is sent once more,
   * collected. Browsers drop `content-length` (a forbidden header), so a
   * streamed browser upload goes out without a length, which presigned
   * S3-style URLs may reject; a collected body gets its length from the browser.
   */
  streamRequestBody?: boolean;
  /**
   * Headers sent with the batch request, and with each transfer unless the
   * server marked the object `authenticated` (its action headers then carry
   * the authorization). Names are case-insensitive: an action header replaces
   * a client header of the same name.
   */
  headers?: Record<string, string>;
  /** Shorthand for an `Authorization: Basic …` header (applied like `headers`). */
  credentials?: { username: string; password: string };
}
