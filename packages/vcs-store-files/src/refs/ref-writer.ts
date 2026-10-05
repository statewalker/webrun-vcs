/**
 * Reference writer
 *
 * Writes Git refs as loose files in the refs/ directory.
 * Handles both regular refs and symbolic refs.
 *
 * Based on:
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/RefDirectory.java
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/RefDirectoryUpdate.java
 */

import {
  dirname,
  type FilesApi,
  isSymbolicRef,
  joinPath,
  type ObjectId,
  type Ref,
  readFile,
  SYMREF_PREFIX,
  type SymbolicRef,
} from "@statewalker/vcs-core";

/**
 * Write a loose ref to disk
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param ref The ref to write (can be regular or symbolic)
 */
export async function writeRef(
  files: FilesApi,
  gitDir: string,
  ref: Ref | SymbolicRef,
): Promise<void> {
  const refPath = joinPath(gitDir, ref.name);

  // Ensure parent directories exist
  const parentDir = dirname(refPath);
  await files.mkdir(parentDir);

  let content: string;
  if (isSymbolicRef(ref)) {
    content = `${SYMREF_PREFIX}${ref.target}\n`;
  } else {
    if (ref.objectId === undefined) {
      throw new Error(`Cannot write ref ${ref.name} without objectId`);
    }
    content = `${ref.objectId}\n`;
  }

  await files.write(refPath, [new TextEncoder().encode(content)]);
}

/**
 * Write a regular ref with an object ID
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param refName Name of the ref
 * @param objectId Object ID to point to
 */
export async function writeObjectRef(
  files: FilesApi,
  gitDir: string,
  refName: string,
  objectId: ObjectId,
): Promise<void> {
  const refPath = joinPath(gitDir, refName);

  // Ensure parent directories exist
  const parentDir = dirname(refPath);
  await files.mkdir(parentDir);

  const content = `${objectId}\n`;
  await files.write(refPath, [new TextEncoder().encode(content)]);
}

/**
 * Write a symbolic ref
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param refName Name of the symbolic ref
 * @param target Name of the target ref
 */
export async function writeSymbolicRef(
  files: FilesApi,
  gitDir: string,
  refName: string,
  target: string,
): Promise<void> {
  const refPath = joinPath(gitDir, refName);

  // Ensure parent directories exist
  const parentDir = dirname(refPath);
  if (parentDir !== gitDir) {
    await files.mkdir(parentDir);
  }

  const content = `${SYMREF_PREFIX}${target}\n`;
  await files.write(refPath, [new TextEncoder().encode(content)]);
}

/**
 * Delete a loose ref
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param refName Name of the ref to delete
 * @returns True if deleted, false if it didn't exist
 */
export async function deleteRef(
  files: FilesApi,
  gitDir: string,
  refName: string,
): Promise<boolean> {
  const refPath = joinPath(gitDir, refName);

  const deleted = await files.remove(refPath);
  if (deleted) {
    // Clean up empty parent directories
    await cleanupEmptyRefDirs(files, gitDir, refName);
  }
  return deleted;
}

/**
 * Remove empty parent directories up to refs/
 */
async function cleanupEmptyRefDirs(
  files: FilesApi,
  gitDir: string,
  refName: string,
): Promise<void> {
  // Only clean up within refs/ hierarchy
  if (!refName.startsWith("refs/")) {
    return;
  }

  let current = refName;
  while (current.includes("/")) {
    current = current.substring(0, current.lastIndexOf("/"));
    if (current === "refs") {
      break;
    }

    const dirPath = joinPath(gitDir, current);
    try {
      let isEmpty = true;
      for await (const _ of files.list(dirPath)) {
        isEmpty = false;
        break;
      }
      if (isEmpty) {
        await files.remove(dirPath);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

/**
 * Update a ref atomically (using lock file pattern)
 *
 * Note: This implementation uses basic write which may not be atomic
 * on all file systems. For production use, consider implementing
 * proper lock file support.
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param refName Name of the ref
 * @param oldValue Expected current value (for CAS), or undefined to skip check
 * @param newValue New value to set
 * @returns True if update succeeded, false if CAS failed
 */
export async function updateRef(
  files: FilesApi,
  gitDir: string,
  refName: string,
  oldValue: ObjectId | undefined,
  newValue: ObjectId,
): Promise<boolean> {
  // Read current value if CAS check is needed
  if (oldValue !== undefined) {
    const refPath = joinPath(gitDir, refName);
    try {
      const content = await readFile(files, refPath);
      const currentValue = new TextDecoder().decode(content).trim();
      if (currentValue !== oldValue) {
        return false;
      }
    } catch {
      // Ref doesn't exist - oldValue should be undefined for new refs
      return false;
    }
  }

  await writeObjectRef(files, gitDir, refName, newValue);
  return true;
}

/**
 * Create refs directory structure
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 */
export async function createRefsStructure(files: FilesApi, gitDir: string): Promise<void> {
  await files.mkdir(joinPath(gitDir, "refs"));
  await files.mkdir(joinPath(gitDir, "refs", "heads"));
  await files.mkdir(joinPath(gitDir, "refs", "tags"));
}
