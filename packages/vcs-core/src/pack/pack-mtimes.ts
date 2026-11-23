/**
 * Cruft pack object times (`pack-<id>.mtimes`), as git's pack-write.c writes them and
 * pack-mtimes.c reads them: a 12-byte header (`MTME`, version 1, hash id 1 for SHA-1, 2 for
 * SHA-256), one big-endian uint32 per object in idx (object id) order, the seconds since the
 * epoch gc expires the object by, then the pack's checksum and the hash of everything before
 * it (both of the object format's width).
 * A pack with a `.mtimes` file is a cruft pack.
 */

import { type ObjectFormat, SHA1_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";
import { hexToBytes } from "@statewalker/vcs-utils/hash/utils";

/** `MTME` */
const MTIMES_SIGNATURE = 0x4d544d45;
const MTIMES_HEADER_SIZE = 12;

/** A `.mtimes` file git would refuse; the message is git's error (without `error: `). */
export class PackMtimesError extends Error {
  override name = "PackMtimesError";
}

/**
 * Encodes a `.mtimes` file: `mtimes[i]` is the time of the object at idx position `i`
 * (seconds, clamped to uint32), `packChecksum` the pack's trailer (bytes or hex).
 *
 * @example
 * ```typescript
 * const bytes = encodePackMtimes(Uint32Array.from(ids, (id) => times.get(id) ?? 0), packId);
 * ```
 */
export function encodePackMtimes(
  mtimes: ArrayLike<number>,
  packChecksum: Uint8Array | string,
  /** the repository's object format (default SHA-1): the hash id, hash and checksum width */
  format: ObjectFormat = SHA1_OBJECT_FORMAT,
): Uint8Array {
  const n = mtimes.length;
  const checksum = typeof packChecksum === "string" ? hexToBytes(packChecksum) : packChecksum;
  const HASH_SIZE = format.rawLength;
  if (checksum.length !== HASH_SIZE) {
    throw new Error(`pack checksum must be ${HASH_SIZE} bytes in a ${format.name} repository`);
  }
  const out = new Uint8Array(MTIMES_HEADER_SIZE + n * 4 + 2 * HASH_SIZE);
  const v = new DataView(out.buffer);
  v.setUint32(0, MTIMES_SIGNATURE);
  v.setUint32(4, 1);
  v.setUint32(8, format.version);
  let p = MTIMES_HEADER_SIZE;
  for (let i = 0; i < n; i++) {
    const t = Math.max(0, Math.min(0xffffffff, Math.floor(mtimes[i] as number)));
    v.setUint32(p, t);
    p += 4;
  }
  out.set(checksum, p);
  p += HASH_SIZE;
  out.set(format.createHasher().update(out.subarray(0, p)).digest(), p);
  return out;
}

/**
 * Reads a `.mtimes` file of a pack of `count` objects with git's checks
 * (`load_pack_mtimes_file`): the times in idx order. Its hash id must be that of the
 * repository's object format (`format`, default SHA-1), whose hash sizes it.
 */
export function parsePackMtimes(
  bytes: Uint8Array,
  count: number,
  name: string,
  format: ObjectFormat = SHA1_OBJECT_FORMAT,
): Uint32Array {
  if (bytes.length < MTIMES_HEADER_SIZE)
    throw new PackMtimesError(`mtimes file ${name} is too small`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0) !== MTIMES_SIGNATURE)
    throw new PackMtimesError(`mtimes file ${name} has unknown signature`);
  const version = v.getUint32(4);
  if (version !== 1)
    throw new PackMtimesError(`mtimes file ${name} has unsupported version ${version}`);
  const hashId = v.getUint32(8);
  if (hashId !== format.version)
    throw new PackMtimesError(`mtimes file ${name} has unsupported hash id ${hashId}`);
  const raw = format.rawLength;
  if (bytes.length !== MTIMES_HEADER_SIZE + count * 4 + 2 * raw)
    throw new PackMtimesError(`mtimes file ${name} is corrupt`);
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = v.getUint32(MTIMES_HEADER_SIZE + i * 4);
  return out;
}
