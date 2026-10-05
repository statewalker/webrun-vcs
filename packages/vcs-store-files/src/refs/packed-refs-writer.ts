/**
 * Packed refs writer
 *
 * Writes the packed-refs file which stores multiple refs in a single file.
 *
 * Based on:
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/lib/RefWriter.java
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/RefDirectory.java
 */

import {
  type FilesApi,
  isSymbolicRef,
  joinPath,
  PACKED_REFS,
  PACKED_REFS_HEADER,
  PACKED_REFS_PEELED,
  type Ref,
} from "@statewalker/vcs-core";
import { readPackedRefs } from "./packed-refs-reader.js";
import { readLooseRef } from "./ref-reader.js";
import { deleteRef } from "./ref-writer.js";

/**
 * Write packed-refs file
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param refs Refs to write (should be sorted by name)
 * @param peeled Whether to include peeled data
 */
export async function writePackedRefs(
  files: FilesApi,
  gitDir: string,
  refs: Ref[],
  peeled = true,
): Promise<void> {
  const packedRefsPath = joinPath(gitDir, PACKED_REFS);

  // Sort refs by name
  const sortedRefs = [...refs].sort((a, b) => a.name.localeCompare(b.name));

  // Build content
  const content = formatPackedRefs(sortedRefs, peeled);

  // Write atomically
  await files.write(packedRefsPath, [new TextEncoder().encode(content)]);
}

/**
 * Format refs for packed-refs file
 *
 * @param refs Refs to format (should be sorted)
 * @param peeled Whether to include peeled trait in header
 * @returns Formatted packed-refs content
 */
export function formatPackedRefs(refs: Ref[], peeled = true): string {
  const lines: string[] = [];

  // Write header
  if (peeled) {
    lines.push(`${PACKED_REFS_HEADER}${PACKED_REFS_PEELED}`);
  }

  // Write refs
  for (const ref of refs) {
    if (ref.objectId === undefined) {
      continue; // Skip refs without object IDs
    }

    lines.push(`${ref.objectId} ${ref.name}`);

    // Write peeled line for annotated tags
    if (peeled && ref.peeledObjectId !== undefined) {
      lines.push(`^${ref.peeledObjectId}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Add a ref to packed-refs
 *
 * Reads existing packed-refs, adds or updates the ref, and writes back.
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param ref Ref to add
 */
export async function addPackedRef(files: FilesApi, gitDir: string, ref: Ref): Promise<void> {
  const { refs, peeled } = await readPackedRefs(files, gitDir);

  // Find and update or add
  const index = refs.findIndex((r) => r.name === ref.name);
  if (index >= 0) {
    refs[index] = ref;
  } else {
    refs.push(ref);
  }

  await writePackedRefs(files, gitDir, refs, peeled);
}

/**
 * Remove a ref from packed-refs
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param refName Name of ref to remove
 * @returns True if ref was removed, false if it wasn't in packed-refs
 */
export async function removePackedRef(
  files: FilesApi,
  gitDir: string,
  refName: string,
): Promise<boolean> {
  const { refs, peeled } = await readPackedRefs(files, gitDir);

  const index = refs.findIndex((r) => r.name === refName);
  if (index < 0) {
    return false;
  }

  refs.splice(index, 1);

  if (refs.length > 0) {
    await writePackedRefs(files, gitDir, refs, peeled);
  } else {
    // Delete packed-refs file if empty
    const packedRefsPath = joinPath(gitDir, PACKED_REFS);
    try {
      await files.remove(packedRefsPath);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  return true;
}

/**
 * Pack loose refs into packed-refs
 *
 * Reads loose refs, adds them to packed-refs, and optionally deletes the loose files.
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param refNames Names of refs to pack
 * @param deleteLoose Whether to delete loose ref files after packing
 */
export async function packRefs(
  files: FilesApi,
  gitDir: string,
  refNames: string[],
  deleteLoose = true,
): Promise<void> {
  const { refs: existingRefs, peeled } = await readPackedRefs(files, gitDir);
  const refsMap = new Map(existingRefs.map((r) => [r.name, r]));

  // Read each loose ref and add to map
  for (const refName of refNames) {
    const looseRef = await readLooseRef(files, gitDir, refName);
    if (looseRef !== undefined && !isSymbolicRef(looseRef)) {
      refsMap.set(refName, looseRef as Ref);
    }
  }

  // Write packed refs
  await writePackedRefs(files, gitDir, Array.from(refsMap.values()), peeled);

  // Delete loose refs if requested
  if (deleteLoose) {
    for (const refName of refNames) {
      await deleteRef(files, gitDir, refName);
    }
  }
}
