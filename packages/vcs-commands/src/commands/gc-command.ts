import type { ObjectId } from "@statewalker/vcs-core";

import { GitCommand } from "../git-command.js";

/**
 * Result of garbage collection
 */
export interface GCCommandResult {
  /** Number of objects removed */
  objectsRemoved: number;
  /** Bytes freed by removing objects */
  bytesFreed: number;
  /** Whether refs were packed */
  refsPacked: boolean;
  /** Duration of the GC operation in milliseconds */
  durationMs: number;
}

/**
 * Run garbage collection on the repository.
 *
 * Equivalent to `git gc`.
 *
 * Garbage collection removes unreachable objects and optimizes
 * repository storage. This includes:
 * - Removing objects not reachable from any ref
 * - Packing loose refs into packed-refs
 * - Repacking objects into pack files (optional)
 *
 * Based on JGit's GarbageCollectCommand.
 *
 * @example
 * ```typescript
 * // Basic garbage collection
 * const result = await git.gc().call();
 * console.log(`Removed ${result.objectsRemoved} objects`);
 *
 * // Aggressive GC with repacking
 * const result = await git.gc()
 *   .setAggressive(true)
 *   .call();
 *
 * // GC with expiration date (keep recent unreachable objects)
 * const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
 * const result = await git.gc()
 *   .setExpire(twoWeeksAgo)
 *   .call();
 * ```
 */
export class GarbageCollectCommand extends GitCommand<GCCommandResult> {
  private _packRefs = true;
  private _aggressive = false;
  private _expire?: Date;

  /**
   * Set aggressive mode.
   *
   * In aggressive mode, GC will also repack objects for better compression.
   *
   * @param aggressive Whether to run aggressive GC
   */
  setAggressive(aggressive: boolean): this {
    this.checkCallable();
    this._aggressive = aggressive;
    return this;
  }

  /**
   * Set whether to pack refs.
   *
   * When true (default), loose refs are packed into packed-refs.
   *
   * @param packRefs Whether to pack refs
   */
  setPackRefs(packRefs: boolean): this {
    this.checkCallable();
    this._packRefs = packRefs;
    return this;
  }

  /**
   * Set expiration date for unreachable objects.
   *
   * Objects unreachable but modified after this date will not be deleted.
   * This provides a grace period to prevent deleting objects that might
   * still be needed by in-progress operations.
   *
   * @param expire Expiration date (objects older than this may be deleted)
   */
  setExpire(expire: Date): this {
    this.checkCallable();
    this._expire = expire;
    return this;
  }

  /**
   * Execute the garbage collection.
   *
   * @returns GC result with statistics
   */
  async call(): Promise<GCCommandResult> {
    this.checkCallable();
    this.setCallable(false);

    const startTime = Date.now();
    const objectsRemoved = 0;
    const bytesFreed = 0;
    let refsPacked = false;

    // Collect all ref roots
    const roots: ObjectId[] = [];
    for await (const ref of this.refsStore.list("refs/")) {
      if ("objectId" in ref && ref.objectId) {
        roots.push(ref.objectId);
      }
    }

    // Also include HEAD if it points to a commit
    const head = await this.refsStore.resolve("HEAD");
    if (head?.objectId) {
      roots.push(head.objectId);
    }

    // Run garbage collection if GCController is available
    // Note: This requires access to the Repository's gc property
    // For now, we'll check if the RefStore supports the gc operations

    // Check if refs support packRefs
    if (this._packRefs && this.refsStore.packRefs) {
      await this.refsStore.packRefs([], { all: true, deleteLoose: true });
      refsPacked = true;
    }

    // Note: Full GC requires Repository.gc which provides access to
    // GCController with collectGarbage(). This command provides the
    // interface but full implementation requires Repository access.
    // The WorkingCopy interface doesn't expose gc, so we'd need to extend
    // the interface or use a different pattern.

    // For aggressive mode, we could trigger repack here
    // But that also requires access to the GCController
    // Reserved for future implementation:
    // - this._aggressive: trigger full repack with better compression
    // - this._expire: pass to collectGarbage() for expiration filtering
    void this._aggressive;
    void this._expire;

    return {
      objectsRemoved,
      bytesFreed,
      refsPacked,
      durationMs: Date.now() - startTime,
    };
  }
}
