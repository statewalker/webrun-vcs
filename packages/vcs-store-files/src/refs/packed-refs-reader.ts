/**
 * Packed refs reader
 *
 * Reads the packed-refs file which stores multiple refs in a single file.
 * Format:
 * - Lines starting with '#' are comments
 * - First line may be "# pack-refs with: peeled"
 * - Regular lines: "<SHA-1> <ref-name>"
 * - Peeled tag lines: "^<SHA-1>" (immediately follows the tag ref)
 *
 * Based on:
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/RefDirectory.java
 */

import {
  createPeeledRef,
  createPeeledTagRef,
  createRef,
  type FilesApi,
  joinPath,
  OBJECT_ID_STRING_LENGTH,
  type ObjectId,
  PACKED_REFS,
  PACKED_REFS_HEADER,
  PACKED_REFS_PEELED,
  type Ref,
  RefStorage,
  readFile,
} from "@statewalker/vcs-core";

/**
 * Parsed packed-refs result
 */
export interface PackedRefs {
  /** All refs from packed-refs file */
  readonly refs: Ref[];
  /** Whether the file has peeled data */
  readonly peeled: boolean;
}

/**
 * Read and parse the packed-refs file
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @returns Parsed refs and metadata
 */
export async function readPackedRefs(files: FilesApi, gitDir: string): Promise<PackedRefs> {
  const packedRefsPath = joinPath(gitDir, PACKED_REFS);

  let content: string;
  try {
    const data = await readFile(files, packedRefsPath);
    content = new TextDecoder().decode(data);
  } catch {
    // File doesn't exist or can't be read
    return { refs: [], peeled: false };
  }

  return parsePackedRefs(content);
}

/**
 * Parse packed-refs file content
 *
 * @param content File content as string
 * @returns Parsed refs and metadata
 */
export function parsePackedRefs(content: string): PackedRefs {
  const refs: Ref[] = [];
  let peeled = false;
  let lastRef: Ref | undefined;

  // Normalize line endings and split
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  for (let line of lines) {
    // Trim any remaining whitespace
    line = line.trim();
    if (line.length === 0) continue;

    const firstChar = line.charAt(0);

    // Comment or header line
    if (firstChar === "#") {
      if (line.startsWith(PACKED_REFS_HEADER)) {
        const traits = line.substring(PACKED_REFS_HEADER.length);
        peeled = traits.includes(PACKED_REFS_PEELED);
      }
      continue;
    }

    // Peeled tag line (starts with ^)
    if (firstChar === "^") {
      if (lastRef === undefined) {
        throw new Error("Peeled line before ref in packed-refs");
      }
      if (lastRef.objectId === undefined) {
        throw new Error("Peeled line for ref without objectId");
      }

      const peeledId = line.substring(1).trim().toLowerCase() as ObjectId;
      // Replace the last ref with a peeled tag version
      refs[refs.length - 1] = createPeeledTagRef(
        lastRef.name,
        lastRef.objectId,
        peeledId,
        RefStorage.PACKED,
      );
      continue;
    }

    // Regular ref line: "<SHA-1> <ref-name>"
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx < 0) {
      throw new Error(`Invalid packed-refs line: ${line}`);
    }

    const objectId = line.substring(0, spaceIdx).toLowerCase() as ObjectId;
    const name = line.substring(spaceIdx + 1);

    // Validate object ID length (should be 40 hex chars)
    if (objectId.length !== OBJECT_ID_STRING_LENGTH) {
      throw new Error(
        `Invalid object ID in packed-refs: "${objectId}" (length ${objectId.length}, expected ${OBJECT_ID_STRING_LENGTH})`,
      );
    }

    // If the file is marked as peeled, refs without ^ lines are non-tags
    const ref = peeled
      ? createPeeledRef(name, objectId, RefStorage.PACKED)
      : createRef(name, objectId, RefStorage.PACKED);

    refs.push(ref);
    lastRef = ref;
  }

  return { refs, peeled };
}

/**
 * Find a specific ref in packed-refs
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param refName Name of ref to find
 * @returns The ref if found, undefined otherwise
 */
export async function findPackedRef(
  files: FilesApi,
  gitDir: string,
  refName: string,
): Promise<Ref | undefined> {
  const { refs } = await readPackedRefs(files, gitDir);
  return refs.find((r) => r.name === refName);
}

/**
 * Check if a ref exists in packed-refs
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param refName Name of ref to check
 * @returns True if the ref exists
 */
export async function hasPackedRef(
  files: FilesApi,
  gitDir: string,
  refName: string,
): Promise<boolean> {
  const ref = await findPackedRef(files, gitDir, refName);
  return ref !== undefined;
}
