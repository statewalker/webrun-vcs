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
  ReflogDeleteOptions,
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
import { createReflogReader, hasReflog } from "./reflog-reader.js";

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
/** git's shallow file, relative to the git directory */
const SHALLOW_FILE = "shallow";

export class FileRefStore implements Refs {
  private readonly ops: FilesRefOps;
  private readonly atomic: AtomicFiles;

  constructor(
    private readonly files: FilesApi,
    private readonly gitDir: string,
    options: FileRefStoreOptions = {},
  ) {
    this.atomic = options.atomicFiles ?? atomicFilesOver(files, gitDir);
    this.ops = createFilesRefOps(this.atomic, options);
  }

  /**
   * The shallow commits: git's `shallow` file (one id per line), empty when there is none.
   */
  async getShallow(): Promise<ObjectId[]> {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of this.atomic.read(SHALLOW_FILE)) {
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    return text
      .split("\n")
      .filter((line) => /^[0-9a-f]{40}$/.test(line))
      .sort();
  }

  /**
   * Replace the `shallow` file under `shallow.lock`, as git does; an empty list removes it.
   * Throws when another writer holds the lock, and, with `expected`, when the file no longer
   * holds what the caller read (git's check_shallow_file_for_update), checked under the lock.
   */
  async setShallow(commits: Iterable<ObjectId>, expected?: Iterable<ObjectId>): Promise<void> {
    const ids = [...new Set(commits)].sort();
    const lock = `${SHALLOW_FILE}.lock`;
    const content = new TextEncoder().encode(ids.map((id) => `${id}\n`).join(""));
    if (!(await this.atomic.createExclusive(lock, content))) {
      throw new Error(`Unable to lock ${SHALLOW_FILE}: ${lock} exists`);
    }
    try {
      if (expected) {
        const current = await this.getShallow();
        const want = [...new Set(expected)].sort();
        if (current.length !== want.length || current.some((id, i) => id !== want[i])) {
          throw new Error(`shallow file has changed since we read it (${SHALLOW_FILE})`);
        }
      }
      if (ids.length === 0) {
        await this.atomic.remove(SHALLOW_FILE);
        await this.atomic.remove(lock);
      } else {
        await this.atomic.replace(lock, SHALLOW_FILE);
      }
    } catch (error) {
      await this.atomic.remove(lock).catch(() => false);
      throw error;
    }
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
   * Delete reflog entry `refName@{index}`, as `git reflog delete` (and so `git stash
   * drop`): under `<ref>.lock` and `logs/<ref>.lock`, the log is rewritten into its lock
   * and renamed, then (`updateRef`) the ref is committed from its lock. Throws
   * `ReflogEntryNotFoundError`, or `RefUpdateRejectedError` (`code` "ELOCKED") when a
   * lock stays held past `refLockTimeoutMs`, with nothing changed.
   */
  deleteReflogEntry(
    refName: string,
    index: number,
    options?: ReflogDeleteOptions,
  ): Promise<number> {
    return this.ops.deleteReflogEntry(refName, index, options);
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
