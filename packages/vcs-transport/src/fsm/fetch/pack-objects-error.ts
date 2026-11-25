/**
 * upload-pack's pack-objects dying while it builds the pack (a `sparse:oid` filter naming no
 * blob, ...): git relays its `fatal: <message>` on the progress band, then sends the abort on
 * the error band, as create_pack_file does.
 *
 * ```typescript
 * throw new PackObjectsError("unable to access sparse blob in 'main:nope'");
 * // client: "remote: fatal: unable to access sparse blob in 'main:nope'"
 * //         "remote: aborting due to possible repository corruption on the remote side."
 * ```
 */
export class PackObjectsError extends Error {
  override name = "PackObjectsError";
  /** What pack-objects printed before it died (`warning: ...` lines), relayed first */
  readonly lines: readonly string[];
  /**
   * Only the abort reaches the client (the death is upload-pack's own `error()`, on the
   * server's stderr: a pack-objects hook that failed)
   */
  readonly abortOnly: boolean;

  constructor(message: string, options: { lines?: readonly string[]; abortOnly?: boolean } = {}) {
    super(message);
    this.lines = options.lines ?? [];
    this.abortOnly = options.abortOnly ?? false;
  }
}

/** What upload-pack sends on band 3 when pack-objects fails (create_pack_file's abort_msg). */
export const PACK_OBJECTS_ABORT =
  "aborting due to possible repository corruption on the remote side.";
