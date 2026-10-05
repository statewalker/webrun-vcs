/**
 * Reflog writer implementation
 *
 * Writes reflog entries to .git/logs/<refname> files.
 *
 * Reflog file format (each line):
 * <old-sha> <new-sha> <name> <email> <timestamp> <timezone>\t<message>
 *
 * Reference: jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/RefDirectory.java (log method)
 */

import {
  dirname,
  type FilesApi,
  formatPersonIdent,
  joinPath,
  type ObjectId,
  type PersonIdent,
} from "@statewalker/vcs-core";

const LOGS_DIR = "logs";
const ZERO_ID = "0".repeat(40);

/**
 * Append entry to reflog
 *
 * Creates the log file and parent directories if they don't exist.
 *
 * @param files FilesApi for filesystem access
 * @param gitDir Path to .git directory
 * @param refName Ref name (e.g., "HEAD", "refs/heads/main")
 * @param oldId SHA before the change (undefined for new refs)
 * @param newId SHA after the change
 * @param who Person making the change
 * @param message Reason for the change
 */
export async function appendReflog(
  files: FilesApi,
  gitDir: string,
  refName: string,
  oldId: ObjectId | undefined,
  newId: ObjectId,
  who: PersonIdent,
  message: string,
): Promise<void> {
  const logPath =
    refName === "HEAD" ? joinPath(gitDir, LOGS_DIR, "HEAD") : joinPath(gitDir, LOGS_DIR, refName);

  // Ensure parent directory exists
  const parentDir = dirname(logPath);
  await ensureDirectory(files, parentDir);

  // Format entry line
  const old = oldId ?? ZERO_ID;
  const identStr = formatPersonIdent(who);
  const line = `${old} ${newId} ${identStr}\t${message}\n`;
  const lineBytes = new TextEncoder().encode(line);

  // Read existing content and append
  let existingContent: Uint8Array | undefined;
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of files.read(logPath)) {
      chunks.push(chunk);
    }
    if (chunks.length > 0) {
      existingContent = concatUint8Arrays(chunks);
    }
  } catch {
    // File doesn't exist yet, that's fine
  }

  // Write combined content
  if (existingContent) {
    const combined = new Uint8Array(existingContent.length + lineBytes.length);
    combined.set(existingContent, 0);
    combined.set(lineBytes, existingContent.length);
    await files.write(logPath, [combined]);
  } else {
    await files.write(logPath, [lineBytes]);
  }
}

/**
 * Delete reflog for a ref
 *
 * @param files FilesApi for filesystem access
 * @param gitDir Path to .git directory
 * @param refName Ref name
 */
export async function deleteReflog(
  files: FilesApi,
  gitDir: string,
  refName: string,
): Promise<void> {
  const logPath =
    refName === "HEAD" ? joinPath(gitDir, LOGS_DIR, "HEAD") : joinPath(gitDir, LOGS_DIR, refName);

  try {
    await files.remove(logPath);
  } catch {
    // File doesn't exist, that's fine
  }
}

/**
 * Check if reflog exists for a ref
 *
 * @param files FilesApi for filesystem access
 * @param gitDir Path to .git directory
 * @param refName Ref name
 * @returns True if reflog exists
 */
export async function hasReflog(
  files: FilesApi,
  gitDir: string,
  refName: string,
): Promise<boolean> {
  const logPath =
    refName === "HEAD" ? joinPath(gitDir, LOGS_DIR, "HEAD") : joinPath(gitDir, LOGS_DIR, refName);

  try {
    // Try to read the file - if it succeeds, the reflog exists
    for await (const _chunk of files.read(logPath)) {
      return true;
    }
    return true; // Empty file also counts as existing
  } catch {
    return false;
  }
}

/**
 * Ensure directory exists, creating parent directories as needed
 */
async function ensureDirectory(files: FilesApi, path: string): Promise<void> {
  // Split path into segments and create each level
  const segments = path.split("/").filter(Boolean);
  let currentPath = path.startsWith("/") ? "" : "";

  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    if (path.startsWith("/")) {
      currentPath = `/${currentPath}`;
    }
    try {
      await files.mkdir(currentPath);
    } catch {
      // Directory might already exist
    }
  }
}

/**
 * Concatenate Uint8Array chunks
 */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
