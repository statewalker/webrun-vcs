/**
 * The server half of protocol v2's packfile URIs: git's `uploadpack.blobPackfileUri` values
 * (pack-objects.c's `configured_exclusions`) and which listed objects they take out of a pack.
 */

import { PackObjectsError } from "../fetch/pack-objects-error.js";

/** One `uploadpack.blobPackfileUri` value: `<object-hash> <pack-hash> <uri>`. */
export interface BlobPackfileUri {
  /** The object left out of the pack (lowercase hex) */
  objectId: string;
  /** The checksum of the pack at `uri`, as configured */
  packHash: string;
  uri: string;
}

/**
 * Parses the values as git's pack-objects reads its config, which it does for every pack it
 * writes: a malformed value or an object named twice is its death ({@link PackObjectsError}).
 *
 * @example
 * ```ts
 * parseBlobPackfileUris([`${blob} ${pack} https://cdn.example.com/p.pack`], 40);
 * // Map { blob => { objectId: blob, packHash: pack, uri: "https://cdn.example.com/p.pack" } }
 * ```
 */
export function parseBlobPackfileUris(
  values: readonly string[],
  hexLength: number,
): Map<string, BlobPackfileUri> {
  const out = new Map<string, BlobPackfileUri>();
  const hex = `[0-9a-fA-F]{${hexLength}}`;
  const pattern = new RegExp(`^(${hex}) (${hex}) `);
  for (const value of values) {
    const m = pattern.exec(value);
    if (!m) {
      throw new PackObjectsError(
        `value of uploadpack.blobpackfileuri must be of the form '<object-hash> <pack-hash> <uri>' (got '${value}')`,
      );
    }
    const objectId = (m[1] as string).toLowerCase();
    if (out.has(objectId)) {
      throw new PackObjectsError(
        `object already configured in another uploadpack.blobpackfileuri (got '${value}')`,
      );
    }
    out.set(objectId, { objectId, packHash: m[2] as string, uri: value.slice(m[0].length) });
  }
  return out;
}

/**
 * pack-objects' `want_object_in_pack` under `--uri-protocol`: whether the configured URI of
 * an object is of one of the client's protocols (`<protocol>:` starts it).
 */
export function offloadedByUri(entry: BlobPackfileUri, protocols: readonly string[]): boolean {
  return protocols.some((p) => entry.uri.startsWith(`${p}:`));
}
