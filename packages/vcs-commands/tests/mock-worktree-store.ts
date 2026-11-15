/**
 * Mock Worktree for testing
 *
 * Provides a simple in-memory implementation of the Worktree interface
 * for creating WorkingCopy instances in tests.
 */

import type { ObjectId } from "@statewalker/vcs-core";
import type {
  Worktree,
  WorktreeCheckoutOptions,
  WorktreeCheckoutResult,
  WorktreeEntry,
  WorktreeWalkOptions,
  WorktreeWriteOptions,
} from "@statewalker/vcs-working-tree";

/**
 * Simple mock Worktree for testing.
 *
 * Provides basic implementation that stores files in memory.
 * Use this when you need a Worktree for MemoryWorkingCopy.
 */
export class MockWorktree implements Worktree {
  private files = new Map<string, { content: Uint8Array; mode: number; mtime: number }>();
  private ignoredPaths = new Set<string>();

  // ========== Reading (Worktree interface) ==========

  async *walk(_options?: WorktreeWalkOptions): AsyncIterable<WorktreeEntry> {
    const paths = Array.from(this.files.keys()).sort();
    for (const path of paths) {
      const file = this.files.get(path);
      if (file) {
        yield {
          path,
          name: path.split("/").pop() ?? path,
          isDirectory: false,
          isIgnored: this.ignoredPaths.has(path),
          size: file.content.length,
          mtime: file.mtime,
          mode: file.mode,
        };
      }
    }
  }

  async getEntry(path: string): Promise<WorktreeEntry | undefined> {
    const file = this.files.get(path);
    if (!file) return undefined;
    return {
      path,
      name: path.split("/").pop() ?? path,
      isDirectory: false,
      isIgnored: this.ignoredPaths.has(path),
      size: file.content.length,
      mtime: file.mtime,
      mode: file.mode,
    };
  }

  async computeHash(path: string): Promise<ObjectId> {
    const file = this.files.get(path);
    if (!file) throw new Error(`File not found: ${path}`);
    // Return a placeholder hash - for full implementation, compute SHA-1
    const size = file.content.length;
    return `placeholder-${size}-${path.replace(/[^a-z0-9]/gi, "")}`
      .substring(0, 40)
      .padEnd(40, "0");
  }

  async *readContent(path: string): AsyncIterable<Uint8Array> {
    const file = this.files.get(path);
    if (!file) throw new Error(`File not found: ${path}`);
    yield file.content;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async isIgnored(path: string): Promise<boolean> {
    return this.ignoredPaths.has(path);
  }

  // ========== Writing (Worktree interface) ==========

  async writeContent(
    path: string,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array,
    options?: WorktreeWriteOptions,
  ): Promise<void> {
    const mode = options?.mode ?? 0o100644;
    let data: Uint8Array;

    if (content instanceof Uint8Array) {
      data = content;
    } else {
      // Collect chunks
      const chunks: Uint8Array[] = [];
      for await (const chunk of content) {
        chunks.push(chunk);
      }
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      data = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
    }

    this.files.set(path, { content: data, mode, mtime: Date.now() });
  }

  async remove(path: string, _options?: { recursive?: boolean }): Promise<boolean> {
    return this.files.delete(path);
  }

  async mkdir(_path: string, _options?: { recursive?: boolean }): Promise<void> {
    // No-op for flat file storage mock
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const file = this.files.get(oldPath);
    if (!file) throw new Error(`File not found: ${oldPath}`);
    this.files.delete(oldPath);
    this.files.set(newPath, file);
  }

  // ========== Checkout Operations (Worktree interface) ==========

  async checkoutTree(
    _treeId: ObjectId,
    _options?: WorktreeCheckoutOptions,
  ): Promise<WorktreeCheckoutResult> {
    // Stub implementation - tests should set up files directly
    return { updated: [], removed: [], conflicts: [], failed: [] };
  }

  async checkoutPaths(
    _treeId: ObjectId,
    _paths: string[],
    _options?: WorktreeCheckoutOptions,
  ): Promise<WorktreeCheckoutResult> {
    // Stub implementation - tests should set up files directly
    return { updated: [], removed: [], conflicts: [], failed: [] };
  }

  // ========== Metadata (Worktree interface) ==========

  getRoot(): string {
    return "/mock/worktree";
  }

  async refreshIgnore(): Promise<void> {
    // No-op for mock
  }

  // ========== Test Helpers ==========

  /** Set a file in the mock worktree */
  setFile(path: string, content: Uint8Array | string, mode = 0o100644): void {
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.files.set(path, { content: data, mode, mtime: Date.now() });
  }

  /** Delete a file from the mock worktree */
  deleteFile(path: string): boolean {
    return this.files.delete(path);
  }

  /** Clear all files from the mock worktree */
  clear(): void {
    this.files.clear();
    this.ignoredPaths.clear();
  }

  /** Mark a path as ignored */
  setIgnored(path: string, ignored = true): void {
    if (ignored) {
      this.ignoredPaths.add(path);
    } else {
      this.ignoredPaths.delete(path);
    }
  }
}

/**
 * Create a mock Worktree for testing
 */
export function createMockWorktree(): MockWorktree {
  return new MockWorktree();
}
