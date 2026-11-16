/**
 * In-memory FilesApi implementation
 *
 * Provides an in-memory filesystem for tests and temporary storage.
 * Uses the @statewalker/webrun-files-mem package directly.
 */

import { MemFilesApi as BaseMemFilesApi } from "@statewalker/webrun-files-mem";
import { appendByRewrite } from "./file-utils.js";
import type { FilesApi } from "./files-api.js";

/** webrun-files' in-memory FilesApi, with `append` (a rewrite: memory writes are cheap). */
class MemFilesApi extends BaseMemFilesApi {
  append(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void> {
    return appendByRewrite(this, path, content);
  }
}

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
