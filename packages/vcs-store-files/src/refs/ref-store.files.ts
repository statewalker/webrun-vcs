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
import { isUpdatableRefName, SYMREF_PREFIX } from "@statewalker/vcs-core";
import { type AtomicFiles, atomicFilesOver } from "@statewalker/vcs-utils/files";

import {
  createFilesRefOps,
  type FilesRefBatchOptions,
  type FilesRefOps,
  RefUpdateRejectedError,
} from "./files-ref-batch.js";
import { readAllRefs, readRef, resolveRef } from "./ref-reader.js";
import { createRefsStructure } from "./ref-writer.js";
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
  private readonly ops: FilesRefOps;

  constructor(
    private readonly files: FilesApi,
    private readonly gitDir: string,
    options: FileRefStoreOptions = {},
  ) {
    this.ops = createFilesRefOps(options.atomicFiles ?? atomicFilesOver(files, gitDir), options);
  }

  /**
   * Apply all commands atomically, or none, with git's lock-file protocol:
   * `<ref>.lock` files, and for several refs a two-phase packed-refs commit.
   * Writes reflog lines in git's format (`options.ident`, `options.message`).
   */
  batch(commands: RefCommand[], options?: BatchOptions): Promise<BatchResult> {
    return this.ops.batch(commands, options);
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
   * Set a ref to point to an object ID, replacing a symbolic ref of that name (git
   * `update-ref --no-deref`). A one-command batch without an old-value check: under
   * `<ref>.lock`, with D/F checks and reflog lines. Names outside `refs/` other than HEAD
   * (`ORIG_HEAD`) are written under their lock without a reflog. Throws
   * `RefUpdateRejectedError` (`code` "ELOCKED" when the lock stays held past
   * `refLockTimeoutMs`) with the ref unchanged.
   */
  async set(refName: string, objectId: ObjectId): Promise<void> {
    if (!isUpdatableRefName(refName)) return this.ops.writeLoose(refName, `${objectId}\n`);
    const r = await this.ops.batch([{ name: refName, new: objectId, noDeref: true }]);
    if (!r.ok) throw new RefUpdateRejectedError(r.rejected);
  }

  /**
   * Set a symbolic ref: `ref: <target>` written into `<ref>.lock` and renamed over the
   * ref. Throws `RefUpdateRejectedError` with the ref unchanged when the lock stays held
   * or on a D/F conflict.
   */
  async setSymbolic(refName: string, target: string): Promise<void> {
    await this.ops.writeLoose(refName, `${SYMREF_PREFIX}${target}\n`);
  }

  /**
   * Remove a ref (loose and packed) and its reflog, as a batch delete does: under
   * `<ref>.lock`, then in one pass under `packed-refs.lock`, packed-refs is rewritten and
   * the loose file removed before the lock is released. Throws `RefUpdateRejectedError`
   * or `PackedRefsLockedError` with nothing changed when a lock stays held.
   */
  async remove(refName: string): Promise<boolean> {
    return this.ops.removeRef(refName);
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
    const r = await this.ops.batch([{ name: refName, old: expectedOld ?? null, new: newValue }]);
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
   * Pack every loose ref into packed-refs (`git pack-refs --all`), under packed-refs.lock
   */
  async optimize(): Promise<void> {
    await this.ops.packRefs([], { all: true, prune: true });
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
   * Pack loose refs into packed-refs, as `git pack-refs`: packed-refs is written under
   * packed-refs.lock (waiting up to `packedLockTimeoutMs`, then throwing
   * `PackedRefsLockedError`), and only then is each packed loose ref removed, under its
   * own lock and only if it still holds the packed value.
   */
  async packRefs(
    refNames: string[],
    options?: { all?: boolean; deleteLoose?: boolean },
  ): Promise<void> {
    await this.ops.packRefs(refNames, {
      all: options?.all === true,
      prune: options?.deleteLoose ?? true,
    });
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
