/**
 * In-memory FilesApi implementation
 *
 * Provides an in-memory filesystem for tests and temporary storage.
 * Uses the @statewalker/webrun-files-mem package directly.
 */

import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { FilesApi } from "./files-api.js";

/**
 * Create an in-memory FilesApi instance.
 * Useful for tests and temporary storage.
 *
 * @param initialFiles - Optional initial file contents
 * @returns FilesApi instance
 *
 * @example
 * ```typescript
 * // Empty filesystem
 * const files = createInMemoryFilesApi();
 *
 * // With initial files
 * const files = createInMemoryFilesApi({
 *   "/test/file.txt": "content",
 *   "/test/binary.bin": new Uint8Array([1, 2, 3]),
 * });
 * ```
 */
export function createInMemoryFilesApi(
  initialFiles?: Record<string, string | Uint8Array>,
): FilesApi {
  return new MemFilesApi({ initialFiles });
}

// Re-export for direct access if needed
export { MemFilesApi };
