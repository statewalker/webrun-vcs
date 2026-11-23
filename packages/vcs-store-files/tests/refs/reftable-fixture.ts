/**
 * Test-only: a minimal reftable writer, enough to build well-formed tables and then corrupt
 * them byte by byte. One unaligned ref block (a restart every `restartInterval` records, the
 * others prefix compressed) and one log block, version 1 (or 2 with a hash id), as
 * `Documentation/technical/reftable.adoc` lays them out.
 */
import { deflateSync } from "@statewalker/vcs-utils/compression";
import { crc32 } from "@statewalker/vcs-utils/hash/crc32";

export type FixtureRef =
  | { name: string; updateIndex: number; deleted: true }
  | { name: string; updateIndex: number; id: string; peeled?: string }
  | { name: string; updateIndex: number; target: string };

export interface FixtureLog {
  name: string;
  updateIndex: number;
  /** Absent: a deletion record */
  update?: {
    oldId: string;
    newId: string;
    who: string;
    email: string;
    time: number;
    tzMinutes: number;
    message: string;
  };
}

export interface FixtureTable {
  refs?: FixtureRef[];
  logs?: FixtureLog[];
  minUpdateIndex?: number;
  maxUpdateIndex?: number;
  version?: 1 | 2;
  /** Version 2's hash id (default "sha1") */
  hashId?: string;
  restartInterval?: number;
}

/** The layout of a built table, for tests that corrupt a field. */
export interface BuiltTable {
  bytes: Uint8Array;
  headerSize: number;
  /** Where the ref block starts its restart table (relative to the file) */
  refRestartsAt: number;
  /** The ref block's length, header included */
  refBlockLen: number;
  logPosition: number;
  footerStart: number;
}

const enc = new TextEncoder();

/** git's put_var_int. */
export function varint(value: number): number[] {
  const out = [value % 128];
  let n = Math.floor(value / 128);
  while (n > 0) {
    n -= 1;
    out.unshift(0x80 | (n % 128));
    n = Math.floor(n / 128);
  }
  return out;
}

function be(n: number | bigint, bytes: number): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  for (let i = 0; i < bytes; i++) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return out;
}

function hex(id: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < id.length; i += 2) out.push(Number.parseInt(id.slice(i, i + 2), 16));
  return out;
}

function common(a: number[], b: number[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Records with prefix compression and a restart table, from (key, type, value) triples. */
function records(
  start: number,
  entries: { key: number[]; type: number; value: number[] }[],
  restartInterval: number,
): number[] {
  const out: number[] = [];
  const restarts: number[] = [];
  let last: number[] = [];
  entries.forEach((e, i) => {
    const restart = i % restartInterval === 0;
    const prefix = restart ? 0 : common(last, e.key);
    if (restart) restarts.push(start + out.length);
    out.push(...varint(prefix), ...varint((e.key.length - prefix) * 8 + e.type));
    out.push(...e.key.slice(prefix), ...e.value);
    last = e.key;
  });
  for (const r of restarts) out.push(...be(r, 3));
  out.push(...be(restarts.length, 2));
  return out;
}

/** Builds a table; see {@link BuiltTable} for where its fields are. */
export function buildReftable(t: FixtureTable): BuiltTable {
  const version = t.version ?? 1;
  const min = t.minUpdateIndex ?? 1;
  const max = t.maxUpdateIndex ?? 1;
  const header = [
    ...enc.encode("REFT"),
    version,
    ...be(0, 3),
    ...be(min, 8),
    ...be(max, 8),
    ...(version === 2 ? [...enc.encode(t.hashId ?? "sha1")] : []),
  ];
  const headerSize = header.length;
  const file: number[] = [...header];
  let refRestartsAt = 0;
  let refBlockLen = 0;
  const refs = t.refs ?? [];
  if (refs.length > 0) {
    const entries = refs.map((r) => {
      const value = varint(r.updateIndex - min);
      let type = 0;
      if ("target" in r) {
        type = 3;
        const target = [...enc.encode(r.target)];
        value.push(...varint(target.length), ...target);
      } else if ("id" in r) {
        type = r.peeled ? 2 : 1;
        value.push(...hex(r.id), ...(r.peeled ? hex(r.peeled) : []));
      }
      return { key: [...enc.encode(r.name)], type, value };
    });
    const body = records(headerSize + 4, entries, t.restartInterval ?? 16);
    refBlockLen = headerSize + 4 + body.length;
    file.push(0x72, ...be(refBlockLen, 3), ...body);
    refRestartsAt = refBlockLen - 2 - 3 * (body[body.length - 2] * 256 + body[body.length - 1]);
  }
  const logs = t.logs ?? [];
  let logPosition = 0;
  if (logs.length > 0) {
    // a log-only table's log block is the first block: at position 0, after the header
    logPosition = file.length === headerSize ? 0 : file.length;
    const blockStart = logPosition === 0 ? headerSize : 0;
    const entries = logs.map((l) => {
      const key = [...enc.encode(l.name), 0, ...be(0xffffffffffffffffn - BigInt(l.updateIndex), 8)];
      if (!l.update) return { key, type: 0, value: [] };
      const u = l.update;
      const str = (s: string) => {
        const b = [...enc.encode(s)];
        return [...varint(b.length), ...b];
      };
      return {
        key,
        type: 1,
        value: [
          ...hex(u.oldId),
          ...hex(u.newId),
          ...str(u.who),
          ...str(u.email),
          ...varint(u.time),
          ...be(u.tzMinutes < 0 ? 0x10000 + u.tzMinutes : u.tzMinutes, 2),
          ...str(u.message),
        ],
      };
    });
    const body = records(blockStart + 4, entries, t.restartInterval ?? 16);
    const deflated = deflateSync([new Uint8Array(body)]);
    file.push(0x67, ...be(blockStart + 4 + body.length, 3), ...deflated);
  }
  const footerStart = file.length;
  const footer = [
    ...header,
    ...be(0, 8),
    ...be(0, 8),
    ...be(0, 8),
    ...be(logPosition, 8),
    ...be(0, 8),
  ];
  footer.push(...be(crc32(new Uint8Array(footer)), 4));
  file.push(...footer);
  return {
    bytes: new Uint8Array(file),
    headerSize,
    refRestartsAt,
    refBlockLen,
    logPosition,
    footerStart,
  };
}

/** Recomputes the footer's CRC-32 after a test changed a footer field. */
export function fixFooterCrc(bytes: Uint8Array, footerStart: number): void {
  const crcAt = bytes.length - 4;
  const crc = crc32(bytes.subarray(footerStart, crcAt));
  bytes.set(be(crc, 4), crcAt);
}
