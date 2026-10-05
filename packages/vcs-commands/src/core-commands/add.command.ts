/**
 * Add command interface for staging files.
 *
 * Adds files from the working tree to the staging area (index).
 * Similar to `git add` command.
 *
 * Reference: jgit/org.eclipse.jgit/src/org/eclipse/jgit/api/AddCommand.java
 */

/**
 * Options for adding files.
 */
export interface AddOptions {
  /**
   * Update only files already tracked in the index.
   * Default: false (add new files too)
   */
  update?: boolean;

  /**
   * Also remove deleted files from index.
   * Default: false
   */
  all?: boolean;

  /**
   * Only add intent-to-add entries (placeholders).
   * Default: false
   */
  intentToAdd?: boolean;

  /**
   * Force adding ignored files.
   * Default: false
   */
  force?: boolean;

  /**
   * Progress callback.
   */
  onProgress?: (path: string, current: number, total: number) => void;
}

/**
 * Result of add operation.
 */
export interface AddResult {
  /** Paths that were added or updated */
  added: string[];

  /** Paths that were skipped (ignored) */
  skipped: string[];

  /** Paths that were removed (deleted from worktree, all mode) */
  removed: string[];

  /** Total files processed */
  totalProcessed: number;
}

/**
 * Add command interface.
 */
export interface Add {
  /**
   * Add files matching patterns to staging area.
   *
   * @param filePatterns File patterns (globs or exact paths)
   * @param options Add options
   * @returns Add result
   */
  add(filePatterns: string[], options?: AddOptions): Promise<AddResult>;

  /**
   * Add all files in working tree to staging area.
   *
   * @param options Add options
   * @returns Add result
   */
  addAll(options?: AddOptions): Promise<AddResult>;
}
