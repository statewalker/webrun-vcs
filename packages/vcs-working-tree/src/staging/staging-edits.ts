import type { FileModeValue, ObjectId } from "@statewalker/vcs-core";
import type { MergeStageValue, StagingEdit, StagingEntry } from "./types.js";
import { MergeStage } from "./types.js";

/**
 * Update or create an entry.
 *
 * If entry exists, replaces it with new values.
 * If entry doesn't exist, creates new entry at stage 0.
 */
export class UpdateStagingEntry implements StagingEdit {
  constructor(
    readonly path: string,
    readonly objectId: ObjectId,
    readonly mode: FileModeValue | number,
    readonly stats?: { size: number; mtime: number },
  ) {}

  apply(_entry: StagingEntry | undefined): StagingEntry {
    return {
      path: this.path,
      objectId: this.objectId,
      mode: this.mode,
      stage: MergeStage.MERGED,
      size: this.stats?.size ?? 0,
      mtime: this.stats?.mtime ?? Date.now(),
    };
  }
}

/**
 * Delete an entry by path.
 *
 * Removes the entry at stage 0. Does not affect conflict stages.
 */
export class DeleteStagingEntry implements StagingEdit {
  constructor(readonly path: string) {}

  apply(_entry: StagingEntry | undefined): undefined {
    return undefined;
  }
}

/**
 * Delete an entire directory tree.
 *
 * Removes all entries whose path starts with the given prefix.
 * Path is treated as a directory - deletes all entries under path/.
 */
export class DeleteStagingTree implements StagingEdit {
  constructor(readonly path: string) {}

  apply(entry: StagingEntry | undefined): StagingEntry | undefined {
    if (!entry) return undefined;
    // Delete if entry path matches exactly or is under this directory
    if (entry.path === this.path || entry.path.startsWith(`${this.path}/`)) {
      return undefined;
    }
    return entry;
  }
}

/**
 * Resolve a conflict by choosing a specific stage.
 *
 * Takes the entry at the chosen stage and promotes it to stage 0,
 * removing all other stages for this path.
 */
export class ResolveStagingConflict implements StagingEdit {
  constructor(
    readonly path: string,
    readonly chooseStage: MergeStageValue,
  ) {}

  apply(entry: StagingEntry | undefined): StagingEntry | undefined {
    // The actual conflict resolution logic is handled specially by the editor
    // since it needs to look at multiple entries for the same path.
    // This apply method is a placeholder - the editor handles it directly.
    return entry;
  }
}

/**
 * Set intent-to-add flag on an entry.
 *
 * Creates a placeholder entry for a file that will be added later.
 * The entry has an empty blob ID and intent-to-add flag set.
 */
export class SetIntentToAdd implements StagingEdit {
  /** SHA-1 of empty blob */
  static readonly EMPTY_BLOB_ID = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

  constructor(
    readonly path: string,
    readonly mode: FileModeValue | number,
  ) {}

  apply(_entry: StagingEntry | undefined): StagingEntry {
    return {
      path: this.path,
      objectId: SetIntentToAdd.EMPTY_BLOB_ID,
      mode: this.mode,
      stage: MergeStage.MERGED,
      size: 0,
      mtime: Date.now(),
      intentToAdd: true,
    };
  }
}

/**
 * Set assume-valid flag on an entry.
 *
 * Tells Git to assume the working tree file has not changed,
 * skipping expensive stat() calls. Used for performance on
 * slow filesystems.
 */
export class SetAssumeValid implements StagingEdit {
  constructor(
    readonly path: string,
    readonly assumeValid: boolean,
  ) {}

  apply(entry: StagingEntry | undefined): StagingEntry | undefined {
    if (!entry) return undefined;
    return {
      ...entry,
      assumeValid: this.assumeValid,
    };
  }
}

/**
 * Set skip-worktree flag on an entry.
 *
 * Used for sparse checkout - marks entry as not checked out
 * to working tree.
 */
export class SetSkipWorktree implements StagingEdit {
  constructor(
    readonly path: string,
    readonly skipWorktree: boolean,
  ) {}

  apply(entry: StagingEntry | undefined): StagingEntry | undefined {
    if (!entry) return undefined;
    return {
      ...entry,
      skipWorktree: this.skipWorktree,
    };
  }
}
