/**
 * The errors of the reftable reader: a table or `tables.list` that is not well formed, a
 * format we do not read (SHA-256 tables), and a write to a reftable repository, which this
 * implementation does not do yet.
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
 * A ref write (an update, a deletion, a reflog change, packing) asked of a repository whose
 * refs are stored in the reftable format: this implementation reads such repositories but
 * does not write them yet. Thrown before anything is changed. `refName` names the first ref
 * the write would have changed, when there is one.
 */
export class ReftableWriteUnsupportedError extends Error {
  readonly code = "EREFTABLE_READONLY";
  constructor(readonly refName?: string) {
    super(
      refName === undefined
        ? "unable to write refs: writing the reftable ref storage (extensions.refStorage = reftable) is not supported"
        : `cannot lock ref '${refName}': writing the reftable ref storage (extensions.refStorage = reftable) is not supported`,
    );
    this.name = "ReftableWriteUnsupportedError";
  }
}
