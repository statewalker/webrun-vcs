import type { FileModeValue, ObjectId } from "@statewalker/vcs-core";

/**
 * Type of change in a diff entry.
 */
export enum ChangeType {
  /** File was added */
  ADD = "ADD",

  /** File was modified */
  MODIFY = "MODIFY",

  /** File was deleted */
  DELETE = "DELETE",

  /** File was renamed */
  RENAME = "RENAME",

  /** File was copied */
  COPY = "COPY",
}

/**
 * Represents a change to a single file between two trees/commits.
 *
 * Based on JGit's DiffEntry class.
 *
 * @example
 * ```typescript
 * for (const entry of diffEntries) {
 *   switch (entry.changeType) {
 *     case ChangeType.ADD:
 *       console.log(`Added: ${entry.newPath}`);
 *       break;
 *     case ChangeType.DELETE:
 *       console.log(`Deleted: ${entry.oldPath}`);
 *       break;
 *     case ChangeType.MODIFY:
 *       console.log(`Modified: ${entry.newPath}`);
 *       break;
 *   }
 * }
 * ```
 */
export interface DiffEntry {
  /** Type of change */
  changeType: ChangeType;

  /** Path in the old tree (null for ADD) */
  oldPath?: string;

  /** Path in the new tree (null for DELETE) */
  newPath?: string;

  /** Object ID in the old tree (null for ADD) */
  oldId?: ObjectId;

  /** Object ID in the new tree (null for DELETE) */
  newId?: ObjectId;

  /** File mode in the old tree (null for ADD) */
  oldMode?: FileModeValue;

  /** File mode in the new tree (null for DELETE) */
  newMode?: FileModeValue;

  /** Similarity score for RENAME/COPY (0-100) */
  score?: number;
}

/**
 * Create a DiffEntry for an added file.
 */
export function createAddEntry(path: string, id: ObjectId, mode: FileModeValue): DiffEntry {
  return {
    changeType: ChangeType.ADD,
    newPath: path,
    newId: id,
    newMode: mode,
  };
}

/**
 * Create a DiffEntry for a deleted file.
 */
export function createDeleteEntry(path: string, id: ObjectId, mode: FileModeValue): DiffEntry {
  return {
    changeType: ChangeType.DELETE,
    oldPath: path,
    oldId: id,
    oldMode: mode,
  };
}

/**
 * Create a DiffEntry for a modified file.
 */
export function createModifyEntry(
  path: string,
  oldId: ObjectId,
  newId: ObjectId,
  oldMode: FileModeValue,
  newMode: FileModeValue,
): DiffEntry {
  return {
    changeType: ChangeType.MODIFY,
    oldPath: path,
    newPath: path,
    oldId,
    newId,
    oldMode,
    newMode,
  };
}

/**
 * Create a DiffEntry for a renamed file.
 */
export function createRenameEntry(
  oldPath: string,
  newPath: string,
  oldId: ObjectId,
  newId: ObjectId,
  oldMode: FileModeValue,
  newMode: FileModeValue,
  score: number,
): DiffEntry {
  return {
    changeType: ChangeType.RENAME,
    oldPath,
    newPath,
    oldId,
    newId,
    oldMode,
    newMode,
    score,
  };
}

/**
 * Create a DiffEntry for a copied file.
 */
export function createCopyEntry(
  oldPath: string,
  newPath: string,
  oldId: ObjectId,
  newId: ObjectId,
  oldMode: FileModeValue,
  newMode: FileModeValue,
  score: number,
): DiffEntry {
  return {
    changeType: ChangeType.COPY,
    oldPath,
    newPath,
    oldId,
    newId,
    oldMode,
    newMode,
    score,
  };
}
