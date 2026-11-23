/**
 * The errors of the reftable reader: a table or `tables.list` that is not well formed, and a
 * format we do not read (SHA-256 tables).
 */

/**
 * A reftable file that is not well formed: truncated, a bad magic or CRC, a block or record
 * that runs past its bounds (git's `REFTABLE_FORMAT_ERROR`). `table` names the file.
 */
export class ReftableFormatError extends Error {
  constructor(
    readonly table: string,
    readonly detail: string,
  ) {
    super(`reftable: corrupt table '${table}': ${detail}`);
    this.name = "ReftableFormatError";
  }
}

/** A reftable we do not read: a SHA-256 table (version 2 with hash id `s256`). */
export class ReftableUnsupportedError extends Error {
  constructor(
    readonly table: string,
    readonly detail: string,
  ) {
    super(`reftable: unsupported table '${table}': ${detail}`);
    this.name = "ReftableUnsupportedError";
  }
}

/**
 * A transaction over several stacks (a linked worktree's and the repository's) whose tables
 * were listed in some of them when listing them in the next failed: the update is applied
 * to `committed` stacks only (git's reftable backend commits stack after stack too). The
 * other stacks' tables and locks are removed; `cause` is the failure.
 */
export class ReftablePartialCommitError extends Error {
  readonly code = "EPARTIAL";
  constructor(
    readonly committed: readonly string[],
    readonly failed: string,
    options?: { cause?: unknown },
  ) {
    super(
      `reftable: transaction failure: committed in ${committed.join(", ")} but not in ${failed}`,
      options,
    );
    this.name = "ReftablePartialCommitError";
  }
}
