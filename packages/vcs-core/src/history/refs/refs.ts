/**
 * Refs - New interface for reference storage
 *
 * and consistent method names (remove instead of delete).
 *
 * Unlike Blobs, Trees, Commits, and Tags, Refs does NOT extend ObjectStorage<V>
 * because refs have fundamentally different semantics:
 * - Use names as keys (not content-addressed hashes)
 * - Support symbolic references (refs pointing to other refs)
 * - Support atomic compare-and-swap updates
 * - Maintain reflogs for history tracking
 */

import type { ObjectId } from "../../common/index.js";
import type {
  BatchOptions,
  BatchResult,
  RefCommand,
  RefLogOptions,
  RefRemoveAllOptions,
  RefRemoveOptions,
  SymbolicRefLogOptions,
} from "./ref-batch.js";
import type { Ref, SymbolicRef } from "./ref-types.js";
import type { ReflogDeleteOptions } from "./reflog-lines.js";
import type { ReflogEntry, ReflogReader } from "./reflog-types.js";

/**
 * Result of a compare-and-swap update operation
 */
export interface RefUpdateResult {
  success: boolean;
  previousValue?: ObjectId;
  errorMessage?: string;
}

// Re-export types from existing modules for convenience
export type { Ref, ReflogEntry, ReflogReader, SymbolicRef };

/**
 * Reference value - either a direct reference or symbolic reference
 */
export type RefValue = Ref | SymbolicRef;

/**
 * Reference entry for listing
 */
export type RefEntry = Ref | SymbolicRef;

/**
 * Reference store for branch and tag pointers
 *
 * Refs are named pointers to objects. Unlike object stores, refs:
 * - Use names as keys (not content-addressed hashes)
 * - Support symbolic references (refs pointing to other refs)
 * - Support atomic compare-and-swap updates
 * - Maintain reflogs for history tracking
 *
 * This interface does NOT extend ObjectStorage<V> because refs have
 * fundamentally different semantics.
 */
/** Options of {@link Refs.packRefs}. */
export interface PackRefsOptions {
  all?: boolean;
  deleteLoose?: boolean;
  prefixes?: string[];
  auto?: boolean;
  onError?: (line: string) => void;
}

export interface Refs {
  /**
   * Get a reference value
   *
   * Returns the raw value (direct or symbolic).
   * Use resolve() to get the final object ID.
   *
   * @param name Reference name (e.g., "refs/heads/main")
   * @returns Reference value if exists, undefined otherwise
   */
  get(name: string): Promise<RefValue | undefined>;

  /**
   * Resolve a reference to its final object ID
   *
   * Follows symbolic references until reaching a direct ref.
   * Returns undefined if ref doesn't exist or chain is broken.
   *
   * @param name Reference name
   * @returns Resolved Ref object, or undefined if not found
   */
  resolve(name: string): Promise<Ref | undefined>;

  /**
   * Check if a reference exists
   *
   * @param name Reference name
   * @returns True if reference exists
   */
  has(name: string): Promise<boolean>;

  /**
   * List references
   *
   * @param prefix Optional prefix filter (e.g., "refs/heads/")
   * @returns AsyncIterable of reference entries
   */
  list(prefix?: string): AsyncIterable<RefEntry>;

  /**
   * Set a direct reference
   *
   * @param name Reference name
   * @param objectId Object ID to point to
   * @param log The reflog line's message and identity, on a store that keeps reflogs
   */
  set(name: string, objectId: ObjectId, log?: RefLogOptions): Promise<void>;

  /**
   * Set a symbolic reference
   *
   * With a `log` message, a store that keeps reflogs logs the change in `name`'s reflog as
   * git's `create_symref` does: from the id `name` resolved to before (zeros when it did
   * not) to the id `target` resolves to, also when the two are the same id; nothing is
   * logged when `target` does not resolve (an unborn branch). `git checkout <branch>` is
   * `setSymbolic("HEAD", "refs/heads/<branch>", { message: "checkout: moving from a to b" })`.
   *
   * With `log.reflog`, those lines are written instead (the log created whatever the name),
   * as `git remote rename` carries a symbolic ref's log over.
   *
   * @param name Reference name
   * @param target Target reference name
   * @param log The reflog line's message and identity; without a message nothing is logged
   */
  setSymbolic(name: string, target: string, log?: SymbolicRefLogOptions): Promise<void>;

  /**
   * Remove a reference
   *
   * Named 'remove' instead of 'delete' to match other store interfaces.
   *
   * @param name Reference name
   * @param options How git's command removes it, where a store tells hooks about it
   * @returns True if removed, false if didn't exist
   */
  remove(name: string, options?: RefRemoveOptions): Promise<boolean>;

  /**
   * Remove several references whatever their values, as git's `delete_refs` (branch -d,
   * tag -d, remote prune): one transaction for all of them (git 2.5x), or with `legacy` as
   * git 2.43's files backend. Optional: without it, callers remove them one by one.
   *
   * @throws when a reference could not be removed
   */
  removeAll?(names: string[], options?: RefRemoveAllOptions): Promise<void>;

  /**
   * Apply all `commands` atomically, or none of them.
   *
   * Commands naming a symbolic ref apply to its target unless `noDeref` is set.
   * The batch is checked as `git update-ref --stdin` checks it: valid names
   * (`HEAD` or under `refs/`), no duplicates, no directory/file conflicts, and
   * each `old` value as expected. Beyond git, a detached HEAD cannot join a
   * multi-ref batch (`not-atomic`, a project policy). On refusal, `rejected`
   * says which commands failed and why, and no ref changed.
   *
   * @example
   * ```typescript
   * const r = await refs.batch([
   *   { name: "refs/heads/main", old: oldId, new: newId },
   *   { name: "refs/tags/v1", old: null, new: tagId },
   * ]);
   * if (!r.ok) console.log(r.rejected); // [{ name, reason: "mismatch" }, ...]
   * ```
   */
  batch(commands: RefCommand[], options?: BatchOptions): Promise<BatchResult>;

  /**
   * Atomic compare-and-swap update
   *
   * Updates the reference only if its current value matches expected.
   * Used for safe concurrent updates.
   *
   * @param name Reference name
   * @param expected Expected current value (undefined for new refs)
   * @param newValue New value to set
   * @returns Result of the update operation
   */
  compareAndSwap(
    name: string,
    expected: ObjectId | undefined,
    newValue: ObjectId,
  ): Promise<RefUpdateResult>;

  /**
   * The repository's shallow commits (git's `shallow` file): commits whose parents are not
   * here, the boundary of a shallow clone. Empty for a complete repository.
   *
   * Optional: a store without it cannot hold a shallow repository, and a shallow fetch into
   * it is refused.
   */
  getShallow?(): Promise<ObjectId[]>;

  /**
   * The text of the repository's grafts file (git's `info/grafts`: `<commit> <parent>...`
   * per line, deprecated in favour of replace refs); undefined when there is none. History
   * walks read commits with these parents (see `loadObjectReplacements`).
   *
   * Optional: a store without it has no grafts.
   */
  readGrafts?(): Promise<string | undefined>;

  /**
   * Replace the shallow commits (an empty list makes the repository complete again: git
   * removes the `shallow` file). With `expected` (the list the caller read), a store whose
   * shallow commits changed meanwhile refuses the write, as git's
   * check_shallow_file_for_update: a concurrent fetch's boundary is not overwritten.
   *
   * @example
   * ```typescript
   * await refs.setShallow?.([...(await refs.getShallow?.()) ?? [], boundary]);
   * ```
   */
  setShallow?(commits: Iterable<ObjectId>, expected?: Iterable<ObjectId>): Promise<void>;

  /**
   * Initialize the refs store
   *
   * Creates necessary structures (e.g., HEAD pointing to refs/heads/main).
   * Optional - implementations that don't need initialization can omit.
   */
  initialize?(): Promise<void>;

  /**
   * Optimize storage
   *
   * Implementation-specific optimization (e.g., pack loose refs).
   * Optional - implementations that don't need optimization can omit.
   */
  optimize?(): Promise<void>;

  /**
   * Get reflog reader for a ref
   *
   * @param name Reference name (e.g., "HEAD", "refs/heads/main")
   * @returns ReflogReader or undefined if no reflog exists
   */
  getReflog?(name: string): Promise<ReflogReader | undefined>;

  /**
   * Delete reflog entry `name@{index}` (0 = newest), as `git reflog delete`: on git
   * files under `<name>.lock` and `logs/<name>.lock`, the log rewritten into its lock
   * and renamed, then (with `updateRef`) the ref committed from its lock. `git stash
   * drop` is `deleteReflogEntry("refs/stash", n, { rewrite: true, updateRef: true })`,
   * followed by deleting `refs/stash` once no entry is left.
   *
   * Throws `ReflogEntryNotFoundError` when there is no such entry, and the store's lock
   * error when another writer holds a lock, with nothing changed.
   *
   * @returns How many entries the log keeps.
   *
   * @example
   * ```typescript
   * const left = await refs.deleteReflogEntry?.("refs/stash", 1, { rewrite: true, updateRef: true });
   * ```
   */
  deleteReflogEntry?(name: string, index: number, options?: ReflogDeleteOptions): Promise<number>;

  /**
   * Pack loose refs
   *
   * Git-specific optimization to consolidate refs.
   * Optional - non-Git implementations can omit.
   *
   * @param refNames Specific refs to pack (empty array with all=true packs all)
   * @param options Pack options: `all` every loose ref, `prefixes` the loose refs under
   *   them (`["refs/tags/"]`: `git pack-refs` without `--all`), `deleteLoose` prune them,
   *   `auto` only when enough loose refs wait (git 2.5x `pack-refs --auto`), `onError` told
   *   each error line git prints meanwhile (a ref whose object is missing, a ref changed
   *   before its prune)
   * @returns How many refs were packed
   */
  packRefs?(refNames: string[], options?: PackRefsOptions): Promise<number>;
}
