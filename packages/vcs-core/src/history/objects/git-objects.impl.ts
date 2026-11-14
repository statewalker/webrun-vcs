/**
 * The object kernel over a `StagingBlobStore` (see `git-objects.ts`).
 *
 * Writes are one pass: each chunk updates SHA-1 and goes to the zlib deflater,
 * the deflated stream is staged, and the id is supplied after the last byte.
 * Reads inflate with a pooled inflater that reports the exact end of the zlib
 * stream, so truncation and trailing bytes are errors (git: "garbage at end of
 * loose object").
 */
import { createInflaterPool, deflate } from "@statewalker/vcs-utils/compression";
import { createSha1, type Hasher } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { SizeMismatchError } from "@statewalker/vcs-utils/pack";
import type { StagingBlobStore } from "../../storage/adapters/staging-blob-store.js";
import {
  CorruptObjectError,
  DEFAULT_SPOOL_THRESHOLD,
  type GitObjects,
  type GitObjectsOptions,
  InvalidObjectIdError,
  ObjectIdMismatchError,
} from "./git-objects.js";
import type { ObjectTypeString } from "./object-types.js";

type Header = { type: ObjectTypeString; size: number };

const TYPES = new Set<string>(["blob", "tree", "commit", "tag"]);
const OID = /^[0-9a-f]{40}$/;
/** "commit " plus 16 digits plus NUL fits; git's MAX_HEADER_LEN is similar. */
const MAX_HEADER = 32;
/**
 * Stored bytes fed to the inflater per push. zlib expands at most about 1032:1,
 * so one push yields at most about 1 MiB whatever block size the store returns.
 */
const INFLATE_SLICE = 1024;
const enc = new TextEncoder();

const isId = (id: unknown): id is string => typeof id === "string" && OID.test(id);

function checkId(id: string): void {
  if (!isId(id)) throw new InvalidObjectIdError(`not an object id: ${String(id)}`);
}

/** Parse `"<type> <size>"` (without the NUL) as git does: a known type, a canonical decimal size. */
function parseHeader(bytes: Uint8Array): Header {
  const text = String.fromCharCode(...bytes);
  const m = /^([a-z]+) (0|[1-9][0-9]{0,15})$/.exec(text);
  if (!m || !TYPES.has(m[1] as string)) throw new CorruptObjectError(`bad object header "${text}"`);
  const size = Number(m[2]);
  if (!Number.isSafeInteger(size)) throw new CorruptObjectError(`object size too large: ${m[2]}`);
  return { type: m[1] as ObjectTypeString, size };
}

interface CheckOptions {
  /** Feeds every byte (header included) to this hasher. */
  hasher?: Hasher;
  /** The error for a body that is not as long as its header says. */
  sizeError?: (declared: number, actual: number) => Error;
  /** True when an empty input means "absent" rather than a missing header. */
  emptyIsAbsent?: () => boolean;
}

const corruptSize = (declared: number, actual: number) =>
  new CorruptObjectError(
    actual > declared
      ? `object body longer than its declared ${declared} bytes`
      : `object body is ${actual} bytes, header says ${declared}`,
  );

/**
 * Wraps a raw-object stream: parses the header from the first bytes, counts body
 * bytes against the declared size and hashes everything. Yields the header
 * (with its NUL) as one chunk, then the body.
 */
async function* checkedRaw(
  raw: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  { hasher, sizeError = corruptSize, emptyIsAbsent = () => false }: CheckOptions,
): AsyncGenerator<Uint8Array> {
  let header: Header | undefined;
  let pending: Uint8Array | undefined; // header bytes seen so far
  let seen = 0;
  for await (const chunk of raw) {
    let body = chunk;
    if (!header) {
      const joined = pending ? concat(pending, chunk.subarray(0, MAX_HEADER + 1)) : chunk;
      const nul = joined.indexOf(0);
      if (nul < 0) {
        if (joined.length > MAX_HEADER) throw new CorruptObjectError("object header has no NUL");
        pending = joined.slice();
        continue;
      }
      if (nul > MAX_HEADER) throw new CorruptObjectError("object header has no NUL");
      header = parseHeader(joined.subarray(0, nul));
      const used = nul + 1 - (pending?.length ?? 0); // bytes of this chunk in the header
      hasher?.update(joined.subarray(0, nul + 1));
      yield joined.slice(0, nul + 1);
      body = chunk.subarray(used);
      pending = undefined;
    }
    if (body.length === 0) continue;
    seen += body.length;
    if (seen > header.size) throw sizeError(header.size, seen);
    hasher?.update(body);
    yield body;
  }
  if (!header) {
    if (!pending && emptyIsAbsent()) return;
    throw new CorruptObjectError(pending ? "object header has no NUL" : "object has no header");
  }
  if (seen !== header.size) throw sizeError(header.size, seen);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Git objects over `store`: SHA-1 ids, zlib loose-object bytes.
 *
 * @example
 * ```typescript
 * const objects = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
 * const id = await objects.put("blob", 6, [new TextEncoder().encode("hello\n")]);
 * ```
 */
export function createGitObjects(
  store: StagingBlobStore,
  options: GitObjectsOptions = {},
): GitObjects {
  const spoolThreshold = options.spoolThreshold ?? DEFAULT_SPOOL_THRESHOLD;
  // Ids are SHA-1 (git's default object format); SHA-256 repositories are not supported.
  const newHasher = createSha1;
  const pool = createInflaterPool();
  const hex = (h: Hasher) => bytesToHex(h.digest());

  /** Inflates a stored object, failing on truncation and on bytes after the zlib stream. */
  async function* inflate(
    id: string,
    state: { absent: boolean },
    retried = false,
  ): AsyncGenerator<Uint8Array> {
    const inflater = pool.acquire();
    let done = false;
    let any = false;
    try {
      for await (const chunk of store.get(id)) {
        for (let off = 0; off < chunk.length; off += INFLATE_SLICE) {
          const slice = chunk.subarray(off, off + INFLATE_SLICE);
          any = true;
          if (done) throw new CorruptObjectError(`${id}: bytes after the end of the zlib stream`);
          let r: ReturnType<typeof inflater.push>;
          try {
            r = inflater.push(slice);
          } catch (e) {
            throw new CorruptObjectError(`${id}: ${(e as Error).message}`);
          }
          yield* r.out;
          if (r.done) {
            done = true;
            if (r.consumed < slice.length) {
              throw new CorruptObjectError(`${id}: bytes after the end of the zlib stream`);
            }
          }
        }
      }
      if (!any) {
        if (!(await store.has(id))) {
          state.absent = true;
          return;
        }
        // Read nothing, yet it exists: a concurrent first put may have landed in
        // between. Read once more; an object that is still empty is corrupt.
        if (retried) throw new CorruptObjectError(`${id}: empty object file`);
        yield* inflate(id, state, true);
        return;
      }
      if (!done) throw new CorruptObjectError(`${id}: truncated zlib stream`);
    } finally {
      // An unfinished stream (stopped early, failed or truncated) returns its state to the pool.
      if (!done) inflater.abort();
    }
  }

  async function* raw(id: string, verify: boolean): AsyncGenerator<Uint8Array> {
    if (!isId(id)) return;
    const hasher = verify ? newHasher() : undefined;
    const state = { absent: false };
    yield* checkedRaw(inflate(id, state), { hasher, emptyIsAbsent: () => state.absent });
    // An absent object ends the stream with nothing to verify.
    if (hasher && !state.absent) {
      const actual = hex(hasher);
      if (actual !== id) throw new ObjectIdMismatchError(`object ${id} hashes to ${actual}`);
    }
  }

  async function put(
    type: ObjectTypeString,
    size: number,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<string> {
    if (!TYPES.has(type)) throw new TypeError(`unknown object type ${type}`);
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`bad object size ${size}`);
    const hasher = newHasher();
    async function* framed() {
      yield enc.encode(`${type} ${size}\0`);
      yield* content;
    }
    const sizeError = (declared: number, actual: number) => new SizeMismatchError(declared, actual);
    const r = await store.putStaged(deflate(checkedRaw(framed(), { hasher, sizeError })), () =>
      hex(hasher),
    );
    return r.id;
  }

  return {
    put,

    async putUnsized(type, content) {
      if (!TYPES.has(type)) throw new TypeError(`unknown object type ${type}`);
      // Read up to the threshold; content that ends there is put from memory.
      const it =
        Symbol.asyncIterator in Object(content)
          ? (content as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
          : (content as Iterable<Uint8Array>)[Symbol.iterator]();
      const head: Uint8Array[] = [];
      let size = 0;
      let ended = false;
      while (size <= spoolThreshold) {
        const r = await it.next();
        if (r.done) {
          ended = true;
          break;
        }
        head.push(r.value);
        size += r.value.length;
      }
      if (ended) return put(type, size, head);
      async function* rest() {
        let done = false;
        try {
          yield* head.splice(0);
          for (let r = await it.next(); !r.done; r = await it.next()) yield r.value;
          done = true;
        } finally {
          // stopped early (a failing spool): release the source
          if (!done) await it.return?.();
        }
      }
      if (!store.spool) {
        // No temporary storage: collect the rest in memory.
        const all: Uint8Array[] = [];
        let total = 0;
        for await (const c of rest()) {
          all.push(c);
          total += c.length;
        }
        return put(type, total, all);
      }
      const spooled = await store.spool(rest());
      try {
        return await put(type, spooled.size, spooled.read());
      } finally {
        await spooled.dispose();
      }
    },
    async putRaw(id, rawBytes) {
      checkId(id);
      const hasher = newHasher();
      await store.putStaged(deflate(checkedRaw(rawBytes, { hasher })), () => {
        const actual = hex(hasher);
        if (actual !== id) {
          throw new ObjectIdMismatchError(`supplied id ${id}, content hashes to ${actual}`);
        }
        return id;
      });
    },

    getRaw(id) {
      return raw(id, false);
    },

    async get(id, opts) {
      if (!isId(id)) return undefined;
      const it = raw(id, opts?.verify === true);
      const first = await it.next(); // the header chunk, or the end if absent
      if (first.done) return undefined;
      const { type, size } = parseHeader(first.value.subarray(0, first.value.length - 1));
      let used = false;
      return {
        type,
        size,
        // Single-use, like the stream it wraps; a second iteration throws instead of
        // silently yielding nothing.
        content: {
          [Symbol.asyncIterator]: () => {
            if (used) throw new Error(`content of ${id} was already iterated`);
            used = true;
            return it;
          },
        },
      };
    },

    async has(id) {
      return isId(id) && store.has(id);
    },

    async *list() {
      for await (const id of store.list()) if (isId(id)) yield id;
    },

    async remove(id) {
      checkId(id);
      return store.remove(id);
    },

    ...(store.sweepStale
      ? { sweepStale: (o: { olderThanMs: number }) => store.sweepStale?.(o) ?? Promise.resolve(0) }
      : {}),
  };
}
