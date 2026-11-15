/**
 * Helper functions for the HTTP server demo.
 */

import { basename, dirname, type FilesApi, joinPath } from "@statewalker/vcs-core";

/**
 * Resolve a path against a base directory (like `path.resolve`, POSIX style).
 * Absolute paths are returned normalized; `.` and `..` segments are resolved.
 */
export function resolvePath(base: string, target: string): string {
  const combined = target.startsWith("/") ? target : `${base}/${target}`;
  const segments: string[] = [];
  for (const segment of combined.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/**
 * Check if a directory exists.
 */
export async function directoryExists(files: FilesApi, dirPath: string): Promise<boolean> {
  try {
    const stat = await files.stats(dirPath);
    return stat?.kind === "directory";
  } catch {
    return false;
  }
}

/**
 * Remove a directory recursively.
 */
export async function removeDirectory(files: FilesApi, dirPath: string): Promise<void> {
  try {
    await files.remove(dirPath);
  } catch {
    // Ignore errors
  }
}

/**
 * Ensure a directory exists.
 */
export async function ensureDirectory(files: FilesApi, dirPath: string): Promise<void> {
  await files.mkdir(dirPath);
}

/**
 * Shorten an object ID for display.
 */
export function shortId(id: string): string {
  return id.slice(0, 7);
}

/**
 * Print a section header.
 */
export function printSection(title: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

/**
 * Print a step message.
 */
export function printStep(step: number, message: string): void {
  console.log(`\n[Step ${step}] ${message}`);
  console.log("-".repeat(40));
}

/**
 * Print info message.
 */
export function printInfo(message: string): void {
  console.log(`  ${message}`);
}

/**
 * Print success message.
 */
export function printSuccess(message: string): void {
  console.log(`  [OK] ${message}`);
}

/**
 * Print error message.
 */
export function printError(message: string): void {
  console.log(`  [ERROR] ${message}`);
}

/**
 * Create author/committer information.
 */
export function createAuthor(timestamp?: number) {
  return {
    name: "HTTP Server Demo",
    email: "demo@example.com",
    timestamp: timestamp ?? Math.floor(Date.now() / 1000),
    tzOffset: "+0000",
  };
}

/**
 * Concatenate byte arrays.
 */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Write a file atomically (via temp file + rename)
 */
export async function atomicWriteFile(
  files: FilesApi,
  path: string,
  content: Uint8Array,
): Promise<void> {
  const dir = dirname(path);
  const base = basename(path);
  const tempPath = joinPath(dir, `.${base}.tmp.${Date.now()}`);

  try {
    await files.write(tempPath, [content]);
    await files.move(tempPath, path);
  } catch (error) {
    try {
      await files.remove(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Ensure a directory exists using FilesApi
 */
export async function ensureDirFiles(files: FilesApi, path: string): Promise<void> {
  await files.mkdir(path);
}
