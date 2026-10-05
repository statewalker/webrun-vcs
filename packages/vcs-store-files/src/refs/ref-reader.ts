/**
 * Reference reader
 *
 * Reads Git refs from loose files and packed-refs.
 * Loose refs take precedence over packed refs.
 *
 * Based on:
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/RefDirectory.java
 */

import {
  createRef,
  createSymbolicRef,
  type FilesApi,
  HEAD,
  isSymbolicRef,
  joinPath,
  OBJECT_ID_STRING_LENGTH,
  type ObjectId,
  R_REFS,
  type Ref,
  RefStorage,
  readFile,
  SYMREF_PREFIX,
  type SymbolicRef,
} from "@statewalker/vcs-core";
import { findPackedRef, readPackedRefs } from "./packed-refs-reader.js";

/** Maximum depth for resolving symbolic refs */
const MAX_SYMBOLIC_REF_DEPTH = 5;

/**
 * Read a single ref by name
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param refName Name of ref to read (e.g., "refs/heads/main" or "HEAD")
 * @returns The ref if found, undefined otherwise
 */
export async function readRef(
  files: FilesApi,
  gitDir: string,
  refName: string,
): Promise<Ref | SymbolicRef | undefined> {
  // Try reading as loose ref first
  const looseRef = await readLooseRef(files, gitDir, refName);
  if (looseRef !== undefined) {
    return looseRef;
  }

  // Fall back to packed-refs
  return findPackedRef(files, gitDir, refName);
}

/**
 * Read a loose ref from its file
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param refName Name of ref to read
 * @returns The ref if found, undefined otherwise
 */
export async function readLooseRef(
  files: FilesApi,
  gitDir: string,
  refName: string,
): Promise<Ref | SymbolicRef | undefined> {
  const refPath = joinPath(gitDir, refName);

  let content: Uint8Array;
  try {
    content = await readFile(files, refPath);
  } catch {
    return undefined;
  }

  if (content.length === 0) {
    return undefined;
  }

  return parseRefContent(refName, content);
}

/**
 * Parse ref file content
 *
 * @param refName Name of the ref
 * @param content File content as bytes
 * @returns Parsed ref or symbolic ref
 */
export function parseRefContent(refName: string, content: Uint8Array): Ref | SymbolicRef {
  // Check for symbolic ref (starts with "ref: ")
  if (isSymbolicRefContent(content)) {
    // Decode and extract target
    const str = new TextDecoder().decode(content);
    const target = str.substring(SYMREF_PREFIX.length).trim();
    return createSymbolicRef(refName, target, RefStorage.LOOSE);
  }

  // Parse as object ID
  const str = new TextDecoder().decode(content);
  const objectId = str.trim().toLowerCase() as ObjectId;

  if (objectId.length < OBJECT_ID_STRING_LENGTH) {
    throw new Error(`Invalid ref content in ${refName}: too short`);
  }

  return createRef(refName, objectId.substring(0, 40) as ObjectId, RefStorage.LOOSE);
}

/**
 * Check if content starts with "ref: "
 */
function isSymbolicRefContent(buf: Uint8Array): boolean {
  if (buf.length < 6) return false;
  return (
    buf[0] === 0x72 && // 'r'
    buf[1] === 0x65 && // 'e'
    buf[2] === 0x66 && // 'f'
    buf[3] === 0x3a && // ':'
    buf[4] === 0x20 // ' '
  );
}

/**
 * Resolve a ref to its final target
 *
 * Follows symbolic refs until reaching a non-symbolic ref.
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param refOrName Ref object or name to resolve
 * @returns The resolved ref, or undefined if it can't be resolved
 */
export async function resolveRef(
  files: FilesApi,
  gitDir: string,
  refOrName: string | Ref | SymbolicRef,
): Promise<Ref | undefined> {
  let current: Ref | SymbolicRef | undefined;

  if (typeof refOrName === "string") {
    current = await readRef(files, gitDir, refOrName);
  } else {
    current = refOrName;
  }

  let depth = 0;

  while (current !== undefined && isSymbolicRef(current)) {
    if (depth >= MAX_SYMBOLIC_REF_DEPTH) {
      throw new Error(`Symbolic ref depth exceeded for ${current.name}`);
    }
    current = await readRef(files, gitDir, current.target);
    depth++;
  }

  return current as Ref | undefined;
}

/**
 * Read all refs under a prefix
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param prefix Optional prefix to filter refs (e.g., "refs/heads/")
 * @returns Array of refs
 */
export async function readAllRefs(
  files: FilesApi,
  gitDir: string,
  prefix: string = R_REFS,
): Promise<(Ref | SymbolicRef)[]> {
  const refs: (Ref | SymbolicRef)[] = [];

  // Read HEAD if no prefix or prefix matches
  if (prefix === "" || HEAD.startsWith(prefix)) {
    const headRef = await readRef(files, gitDir, HEAD);
    if (headRef !== undefined) {
      refs.push(headRef);
    }
  }

  // When prefix is empty, read from refs/ to avoid reading the entire git directory
  const refsPrefix = prefix === "" ? R_REFS : prefix;

  // Read loose refs from directory tree
  await readLooseRefsRecursive(files, gitDir, refsPrefix, refs);

  // Read packed refs and add any not already found as loose
  const { refs: packedRefs } = await readPackedRefs(files, gitDir);
  const looseNames = new Set(refs.map((r) => r.name));

  for (const packedRef of packedRefs) {
    if (!looseNames.has(packedRef.name) && packedRef.name.startsWith(prefix)) {
      refs.push(packedRef);
    }
  }

  return refs;
}

/**
 * Recursively read loose refs from a directory
 */
async function readLooseRefsRecursive(
  files: FilesApi,
  gitDir: string,
  prefix: string,
  refs: (Ref | SymbolicRef)[],
): Promise<void> {
  const dirPath = joinPath(gitDir, prefix);

  try {
    for await (const entry of files.list(dirPath)) {
      // Don't use joinPath for ref names - it normalizes to absolute paths
      // Ref names should be relative (e.g., "refs/heads/main" not "/refs/heads/main")
      const entryPath = prefix.endsWith("/") ? `${prefix}${entry.name}` : `${prefix}/${entry.name}`;

      try {
        if (entry.kind === "directory") {
          // Recurse into subdirectory
          await readLooseRefsRecursive(files, gitDir, entryPath, refs);
        } else {
          // Read ref file
          const ref = await readLooseRef(files, gitDir, entryPath);
          if (ref !== undefined) {
            refs.push(ref);
          }
        }
      } catch {
        // Skip unreadable entries
      }
    }
  } catch {
    return; // Directory doesn't exist
  }
}

/**
 * Check if a loose ref exists
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param refName Name of ref to check
 * @returns True if the loose ref exists
 */
export async function hasLooseRef(
  files: FilesApi,
  gitDir: string,
  refName: string,
): Promise<boolean> {
  const refPath = joinPath(gitDir, refName);
  return files.exists(refPath);
}

/**
 * Get refs by prefix
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param prefix Prefix to filter refs
 * @returns Array of refs matching the prefix
 */
export async function getRefsByPrefix(
  files: FilesApi,
  gitDir: string,
  prefix: string,
): Promise<(Ref | SymbolicRef)[]> {
  return readAllRefs(files, gitDir, prefix);
}
