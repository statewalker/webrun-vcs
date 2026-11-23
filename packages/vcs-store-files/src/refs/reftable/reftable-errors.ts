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
