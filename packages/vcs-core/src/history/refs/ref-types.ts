/**
 * Reference types
 *
 * Based on:
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/lib/Ref.java
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/lib/ObjectIdRef.java
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/lib/SymbolicRef.java
 */

import type { ObjectId } from "../../common/id/index.js";

/**
 * Storage location of a reference
 */
export enum RefStorage {
  /** The ref does not exist yet */
  NEW = "new",
  /** Stored as a loose file in refs/ */
  LOOSE = "loose",
  /** Stored in packed-refs file */
  PACKED = "packed",
  /** Both loose and packed (loose takes precedence) */
  LOOSE_PACKED = "loose_packed",
}

/**
 * A Git reference pointing to an object
 */
export interface Ref {
  /** Reference name (e.g., "refs/heads/main") */
  readonly name: string;
  /** ObjectId the ref points to, or undefined for unborn refs */
  readonly objectId: ObjectId | undefined;
  /** Storage location */
  readonly storage: RefStorage;
  /** Is this reference peeled? */
  readonly peeled: boolean;
  /** For annotated tags, the commit/tree/blob the tag points to */
  readonly peeledObjectId?: ObjectId;
}

/**
 * A symbolic reference pointing to another ref
 */
export interface SymbolicRef {
  /** Reference name (e.g., "HEAD") */
  readonly name: string;
  /** Target ref name (e.g., "refs/heads/main") */
  readonly target: string;
  /** Storage location */
  readonly storage: RefStorage;
}

/**
 * Check if a reference is symbolic
 */
export function isSymbolicRef(ref: Ref | SymbolicRef): ref is SymbolicRef {
  return "target" in ref && typeof ref.target === "string";
}

/**
 * Create a new unpeeled ref
 */
export function createRef(
  name: string,
  objectId: ObjectId | undefined,
  storage: RefStorage = RefStorage.LOOSE,
): Ref {
  return {
    name,
    objectId,
    storage,
    peeled: false,
  };
}

/**
 * Create a peeled non-tag ref
 */
export function createPeeledRef(
  name: string,
  objectId: ObjectId,
  storage: RefStorage = RefStorage.LOOSE,
): Ref {
  return {
    name,
    objectId,
    storage,
    peeled: true,
  };
}

/**
 * Create a peeled tag ref
 */
export function createPeeledTagRef(
  name: string,
  objectId: ObjectId,
  peeledObjectId: ObjectId,
  storage: RefStorage = RefStorage.PACKED,
): Ref {
  return {
    name,
    objectId,
    storage,
    peeled: true,
    peeledObjectId,
  };
}

/**
 * Create a symbolic ref
 */
export function createSymbolicRef(
  name: string,
  target: string,
  storage: RefStorage = RefStorage.LOOSE,
): SymbolicRef {
  return {
    name,
    target,
    storage,
  };
}

/** Magic string denoting symbolic reference */
export const SYMREF_PREFIX = "ref: ";

/** SHA-1 hex string length */
export const OBJECT_ID_STRING_LENGTH = 40;

/** Common ref prefixes */
export const R_REFS = "refs/";
export const R_HEADS = "refs/heads/";
export const R_TAGS = "refs/tags/";
export const R_REMOTES = "refs/remotes/";

/** Special refs */
export const HEAD = "HEAD";
export const FETCH_HEAD = "FETCH_HEAD";
export const ORIG_HEAD = "ORIG_HEAD";
export const MERGE_HEAD = "MERGE_HEAD";
export const CHERRY_PICK_HEAD = "CHERRY_PICK_HEAD";

/** Packed refs file name */
export const PACKED_REFS = "packed-refs";

/** Packed refs header */
export const PACKED_REFS_HEADER = "# pack-refs with:";

/** Packed refs peeled trait */
export const PACKED_REFS_PEELED = " peeled";
