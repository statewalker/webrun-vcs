/**
 * Pack reverse indexes (`pack-<id>.rev`, RIDX version 1), as git's pack-write.c writes them
 * and pack-revindex.c reads them: a 12-byte header (`RIDX`, version 1, hash id 1 for SHA-1,
 * 2 for SHA-256), then for each object in pack order (by offset) its position in the `.idx`
 * (big-endian uint32), then the pack's checksum and the hash of everything before it (both of
 * the object format's width).
 *
 * git writes one beside every pack it writes while `pack.writeReverseIndex` is true (the
 * default since 2.41) and reads it in place of sorting the idx's offsets while
 * `pack.readReverseIndex` is true (default).
 */

import { type ObjectFormat, SHA1_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";
import { hexToBytes } from "@statewalker/vcs-utils/hash/utils";
import type { FilesApi } from "../common/files/index.js";

/** `RIDX` */
const RIDX_SIGNATURE = 0x52494458;
const RIDX_HEADER_SIZE = 12;

/** A `.rev` file git would refuse; the message is git's error (without `error: `). */
export class ReverseIndexError extends Error {
  override name = "ReverseIndexError";
}

/**
 * Encodes a `.rev` file: `packOrder[p]` is the idx position of the object at pack position
 * `p` (`PackFile.packOrder()`), `packChecksum` the pack's trailer (bytes, or its hex), of the
 * repository's object format `format` (default SHA-1), whose hash id and hash the file is
 * written with; a checksum of another width is refused.
 *
 * @example
 * ```typescript
 * const bytes = encodeReverseIndex(pack.packOrder(), pack.packId);
 * await files.write(`${packDir}/pack-${pack.packId}.rev`, [bytes]);
 * ```
 */
export function encodeReverseIndex(
  packOrder: ArrayLike<number>,
  packChecksum: Uint8Array | string,
  format: ObjectFormat = SHA1_OBJECT_FORMAT,
): Uint8Array {
  const n = packOrder.length;
  const checksum = typeof packChecksum === "string" ? hexToBytes(packChecksum) : packChecksum;
  const HASH_SIZE = format.rawLength;
  if (checksum.length !== HASH_SIZE) {
    throw new Error(`pack checksum must be ${HASH_SIZE} bytes in a ${format.name} repository`);
  }
  const out = new Uint8Array(RIDX_HEADER_SIZE + n * 4 + 2 * HASH_SIZE);
  const v = new DataView(out.buffer);
  v.setUint32(0, RIDX_SIGNATURE);
  v.setUint32(4, 1);
  v.setUint32(8, format.version);
  let p = RIDX_HEADER_SIZE;
  for (let i = 0; i < n; i++) {
    v.setUint32(p, packOrder[i] as number);
    p += 4;
  }
  out.set(checksum, p);
  p += HASH_SIZE;
  out.set(format.createHasher().update(out.subarray(0, p)).digest(), p);
  return out;
}

/**
 * Reads a `.rev` file of a pack of `count` objects, with git's checks of
 * `load_revindex_from_disk` (size, signature, version, hash id), each refusal git's message.
 * Returns the idx positions in pack order. `verify` adds what `verify_pack_revindex` (fsck)
 * checks first: the file's own checksum (`invalid checksum`). The file is read as one of the
 * repository's object format (`objectFormat`, default SHA-1): sized by its hash, and its hash
 * id must be that format's (a `.rev` of the other format is refused).
 */
export function parseReverseIndex(
  bytes: Uint8Array,
  count: number,
  name: string,
  options: { verify?: boolean; objectFormat?: ObjectFormat } = {},
): Uint32Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = options.objectFormat ?? SHA1_OBJECT_FORMAT;
  const HASH_SIZE = format.rawLength;
  const min = RIDX_HEADER_SIZE + 2 * HASH_SIZE;
  if (bytes.length < min) throw new ReverseIndexError(`reverse-index file ${name} is too small`);
  if (bytes.length - min !== count * 4)
    throw new ReverseIndexError(`reverse-index file ${name} is corrupt`);
  if (v.getUint32(0) !== RIDX_SIGNATURE)
    throw new ReverseIndexError(`reverse-index file ${name} has unknown signature`);
  const version = v.getUint32(4);
  if (version !== 1)
    throw new ReverseIndexError(`reverse-index file ${name} has unsupported version ${version}`);
  const hashId = v.getUint32(8);
  if (hashId !== format.version)
    throw new ReverseIndexError(`reverse-index file ${name} has unsupported hash id ${hashId}`);
  if (options.verify) {
    const end = bytes.length - HASH_SIZE;
    const sum = format.createHasher().update(bytes.subarray(0, end)).digest();
    for (let i = 0; i < HASH_SIZE; i++)
      if (sum[i] !== bytes[end + i]) throw new ReverseIndexError("invalid checksum");
  }
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = v.getUint32(RIDX_HEADER_SIZE + i * 4);
  return order;
}

/**
 * fsck's check of one pack's `.rev` (`verify_reverse_indices`: load_pack_revindex_from_disk,
 * then verify_pack_revindex): undefined when the pack has none, or when its checksum holds and
 * its positions are those `offsetAt` (the pack offset of each idx position) gives; else git's
 * error lines, ending with `unable to load rev-index for pack '<pack>'` (a file git refuses to
 * load) or `invalid rev-index for pack '<pack>'`.
 */
export async function verifyReverseIndexFile(
  files: FilesApi,
  packPath: string,
  count: number,
  offsetAt: (i: number) => number,
  /** the repository's object format (default SHA-1) */
  objectFormat: ObjectFormat = SHA1_OBJECT_FORMAT,
): Promise<string[] | undefined> {
  const revPath = `${packPath.replace(/\.pack$/, "")}.rev`;
  if ((await files.stats(revPath).catch(() => undefined))?.kind !== "file") return undefined;
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const c of files.read(revPath)) {
    parts.push(c);
    size += c.length;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of parts) {
    bytes.set(c, at);
    at += c.length;
  }
  let order: Uint32Array;
  try {
    order = parseReverseIndex(bytes, count, revPath, { objectFormat });
  } catch (e) {
    if (!(e instanceof ReverseIndexError)) throw e;
    return [`error: ${e.message}`, `error: unable to load rev-index for pack '${packPath}'`];
  }
  const errors: string[] = [];
  try {
    parseReverseIndex(bytes, count, revPath, { verify: true, objectFormat });
  } catch (e) {
    if (!(e instanceof ReverseIndexError)) throw e;
    errors.push(`error: ${e.message}`);
  }
  const offs = new Float64Array(count);
  for (let i = 0; i < count; i++) offs[i] = offsetAt(i);
  const expected = new Uint32Array(count);
  for (let i = 0; i < count; i++) expected[i] = i;
  expected.sort((a, b) => (offs[a] as number) - (offs[b] as number));
  for (let p = 0; p < count; p++) {
    if (order[p] !== expected[p])
      errors.push(`error: invalid rev-index position at ${p}: ${expected[p]} != ${order[p]}`);
  }
  if (errors.length > 0) errors.push(`error: invalid rev-index for pack '${packPath}'`);
  return errors.length > 0 ? errors : undefined;
}
