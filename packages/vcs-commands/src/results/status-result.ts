/**
 * Status of the staging area compared to HEAD.
 *
 * This is a simplified version for repositories without working trees,
 * focusing on staged changes and conflicts.
 *
 * Based on JGit's Status but without working tree operations.
 */
export interface Status {
  /**
   * Files added to staging (not in HEAD).
   */
  readonly added: Set<string>;

  /**
   * Files modified in staging (different from HEAD).
   */
  readonly changed: Set<string>;

  /**
   * Files removed from staging (in HEAD but not in staging).
   */
  readonly removed: Set<string>;

  /**
   * Files with merge conflicts.
   */
  readonly conflicting: Set<string>;

  /**
   * Check if the staging area is clean (no changes, no conflicts).
   */
  isClean(): boolean;

  /**
   * Check if there are uncommitted changes.
   * True if any files are added, changed, removed, or conflicting.
   */
  hasUncommittedChanges(): boolean;
}

/**
 * Implementation of Status interface.
 */
export class StatusImpl implements Status {
  constructor(
    public readonly added: Set<string>,
    public readonly changed: Set<string>,
    public readonly removed: Set<string>,
    public readonly conflicting: Set<string>,
  ) {}

  isClean(): boolean {
    return (
      this.added.size === 0 &&
      this.changed.size === 0 &&
      this.removed.size === 0 &&
      this.conflicting.size === 0
    );
  }

  hasUncommittedChanges(): boolean {
    return !this.isClean();
  }
}
