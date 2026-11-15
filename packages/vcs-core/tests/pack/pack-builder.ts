/**
 * A tiny pack builder for tests: vcs-core cannot depend on vcs-testing, so the packs
 * installed by the index-pack and pack-set tests are built here.
 */
import { compressBlockPako } from "@statewalker/vcs-utils/compression";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex, hexToBytes } from "@statewalker/vcs-utils/hash/utils";

const enc = new TextEncoder();

export interface Entry {
  kind: number; // 1-4 whole object, 6 OFS_DELTA, 7 REF_DELTA
  data: Uint8Array;
  baseOid?: string;
  baseIdx?: number;
  back?: number;
  sizeOverride?: number;
}

export const oidOf = (type: string, data: Uint8Array) =>
  bytesToHex(
    createSha1()
      .update(enc.encode(`${type} ${data.length}\0`))
      .update(data)
      .digest(),
  );
export const varint = (n: number) => {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
export const delta = (baseLen: number, resultLen: number, ops: number[]) =>
  Uint8Array.from([...varint(baseLen), ...varint(resultLen), ...ops]);
export const copyAll = (n: number) => [0xf0, n & 255, (n >> 8) & 255, (n >> 16) & 255];
/** `base` followed by `tail`, and the delta producing it */
export const extend = (base: Uint8Array, tail: string) => {
  const t = enc.encode(tail);
  const data = new Uint8Array(base.length + t.length);
  data.set(base);
  data.set(t, base.length);
  return { data, d: delta(base.length, data.length, [...copyAll(base.length), t.length, ...t]) };
};

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A pack with a valid trailer, and where each entry starts and ends. */
export function buildPack(entries: Entry[], opts: { count?: number; version?: number } = {}) {
  const head = new Uint8Array(12);
  head.set(enc.encode("PACK"));
  const v = new DataView(head.buffer);
  v.setUint32(4, opts.version ?? 2);
  v.setUint32(8, opts.count ?? entries.length);
  const parts: Uint8Array[] = [head];
  const offsets: number[] = [];
  const ends: number[] = [];
  let pos = 12;
  for (const e of entries) {
    offsets.push(pos);
    const h: number[] = [];
    let size = e.sizeOverride ?? e.data.length;
    let b = (e.kind << 4) | (size & 15);
    size = Math.floor(size / 16);
    while (size) {
      h.push(b | 0x80);
      b = size & 127;
      size = Math.floor(size / 128);
    }
    h.push(b);
    if (e.kind === 6) {
      let back = e.back ?? pos - (offsets[e.baseIdx as number] as number);
      const bs = [back & 127];
      back = Math.floor(back / 128);
      while (back) {
        back--;
        bs.unshift(0x80 | (back & 127));
        back = Math.floor(back / 128);
      }
      h.push(...bs);
    }
    if (e.kind === 7) h.push(...hexToBytes(e.baseOid as string));
    const entry = concat([Uint8Array.from(h), compressBlockPako(e.data)]);
    parts.push(entry);
    pos += entry.length;
    ends.push(pos);
  }
  const body = concat(parts);
  const bytes = concat([body, createSha1().update(body).digest()]);
  return { bytes, offsets, ends };
}
export const pack = (entries: Entry[], opts?: { count?: number; version?: number }) =>
  buildPack(entries, opts).bytes;

export async function* chunks(bytes: Uint8Array, size = 4096) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
export async function collect(s: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const c of s) parts.push(c);
  return concat(parts);
}
