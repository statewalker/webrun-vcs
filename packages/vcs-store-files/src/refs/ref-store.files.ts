/**
 * File-based Refs implementation
 *
 * Stores refs as files in the .git/refs directory structure.
 * Supports both loose refs and packed-refs.
 */

import type {
  BatchOptions,
  BatchResult,
  FilesApi,
  ObjectId,
  Ref,
  RefCommand,
  ReflogReader,
  Refs,
  RefUpdateResult,
  SymbolicRef,
} from "@statewalker/vcs-core";
import { type AtomicFiles, atomicFilesOver } from "@statewalker/vcs-utils/files";

import { createFilesRefBatch, type FilesRefBatchOptions } from "./files-ref-batch.js";
import { packRefs, removePackedRef } from "./packed-refs-writer.js";
import { readAllRefs, readRef, resolveRef } from "./ref-reader.js";
import { createRefsStructure, deleteRef, writeObjectRef, writeSymbolicRef } from "./ref-writer.js";
import { createReflogReader } from "./reflog-reader.js";
import { hasReflog } from "./reflog-writer.js";

export interface FileRefStoreOptions extends FilesRefBatchOptions {
  /**
   * Lock-file primitives rooted at `gitDir`. Defaults to `atomicFilesOver(files, gitDir)`,
   * which excludes other processes when the FilesApi has `createExclusive`. Without it, it
   * is atomic only among users of the same FilesApi instance: share one FilesApi per
   * repository, and do not let another process (native git included) write it at the same time.
   */
  atomicFiles?: AtomicFiles;
}

/**
 * File-based Refs implementation
 *
 * Uses the standard Git refs directory structure:
 * - .git/refs/heads/* for branches
 * - .git/refs/tags/* for tags
 * - .git/refs/remotes/* for remote tracking branches
 * - .git/packed-refs for packed refs
 */
export class FileRefStore implements Refs {
  private readonly applyBatch: (
    commands: RefCommand[],
    options?: BatchOptions,
  ) => Promise<BatchResult>;

  constructor(
    private readonly files: FilesApi,
    private readonly gitDir: string,
    options: FileRefStoreOptions = {},
  ) {
    this.applyBatch = createFilesRefBatch(
      options.atomicFiles ?? atomicFilesOver(files, gitDir),
      options,
    );
  }

  /**
   * Apply all commands atomically, or none, with git's lock-file protocol:
   * `<ref>.lock` files, and for several refs a two-phase packed-refs commit.
   * Writes reflog lines in git's format (`options.ident`, `options.message`).
   */
  batch(commands: RefCommand[], options?: BatchOptions): Promise<BatchResult> {
    return this.applyBatch(commands, options);
  }

  /**
   * Read a ref by exact name
   */
  async get(refName: string): Promise<Ref | SymbolicRef | undefined> {
    return readRef(this.files, this.gitDir, refName);
  }

  /**
   * Resolve a ref to its final object ID (follows symbolic refs)
   */
  async resolve(refName: string): Promise<Ref | undefined> {
    return resolveRef(this.files, this.gitDir, refName);
  }

  /**
   * Check if a ref exists
   */
  async has(refName: string): Promise<boolean> {
    const ref = await this.get(refName);
    return ref !== undefined;
  }

  /**
   * List all refs matching a prefix
   */
  async *list(prefix?: string): AsyncIterable<Ref | SymbolicRef> {
    const allRefs = await readAllRefs(this.files, this.gitDir, prefix ?? "");
    for (const ref of allRefs) {
      yield ref;
    }
  }

  /**
   * Set a ref to point to an object ID
   */
  async set(refName: string, objectId: ObjectId): Promise<void> {
    await writeObjectRef(this.files, this.gitDir, refName, objectId);
  }

  /**
   * Set a symbolic ref
   */
  async setSymbolic(refName: string, target: string): Promise<void> {
    await writeSymbolicRef(this.files, this.gitDir, refName, target);
  }

  /**
   * Remove a ref (loose and packed). Not locked: prefer `batch` next to other writers.
   */
  async remove(refName: string): Promise<boolean> {
    // A ref may be loose, packed, or both (a loose ref shadows its packed copy).
    const loose = await deleteRef(this.files, this.gitDir, refName);
    const packed = await removePackedRef(this.files, this.gitDir, refName);
    return loose || packed;
  }

  /**
   * Compare-and-swap update (for concurrent safety)
   */
  async compareAndSwap(
    refName: string,
    expectedOld: ObjectId | undefined,
    newValue: ObjectId,
  ): Promise<RefUpdateResult> {
    // A one-command batch: locked, checked under the lock, committed by rename.
    const r = await this.applyBatch([{ name: refName, old: expectedOld ?? null, new: newValue }]);
    if (r.ok) return { success: true, previousValue: expectedOld };
    return {
      success: false,
      previousValue: (await this.resolve(refName))?.objectId,
      errorMessage: r.rejected.map((x) => `${x.name}: ${x.reason}`).join(", "),
    };
  }

  /**
   * Initialize storage structure
   */
  async initialize(): Promise<void> {
    await createRefsStructure(this.files, this.gitDir);
  }

  /**
   * Pack loose refs into packed-refs file
   */
  async optimize(): Promise<void> {
    // Get all loose refs to pack
    const refs = await readAllRefs(this.files, this.gitDir, "refs/");
    const refNames = refs.map((r) => r.name);
    if (refNames.length > 0) {
      await packRefs(this.files, this.gitDir, refNames, true);
    }
  }

  /**
   * Get reflog reader for a ref
   */
  async getReflog(refName: string): Promise<ReflogReader | undefined> {
    const exists = await hasReflog(this.files, this.gitDir, refName);
    if (!exists) {
      return undefined;
    }
    return createReflogReader(this.files, this.gitDir, refName);
  }

  /**
   * Pack loose refs into packed-refs file
   */
  async packRefs(
    refNames: string[],
    options?: { all?: boolean; deleteLoose?: boolean },
  ): Promise<void> {
    const deleteLoose = options?.deleteLoose ?? true;

    if (options?.all) {
      // Pack all refs
      const refs = await readAllRefs(this.files, this.gitDir, "refs/");
      const allRefNames = refs.map((r) => r.name);
      if (allRefNames.length > 0) {
        await packRefs(this.files, this.gitDir, allRefNames, deleteLoose);
      }
    } else if (refNames.length > 0) {
      // Pack specific refs
      await packRefs(this.files, this.gitDir, refNames, deleteLoose);
    }
  }
}

/**
 * Create a file-based ref store
 */
export function createFileRefStore(
  files: FilesApi,
  gitDir: string,
  options?: FileRefStoreOptions,
): FileRefStore {
  return new FileRefStore(files, gitDir, options);
}
