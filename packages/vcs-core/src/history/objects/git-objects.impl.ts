/**
 * The object kernel over a `StagingBlobStore` (see `git-objects.ts`).
 *
 * Writes are one pass: each chunk updates SHA-1 and goes to the zlib deflater,
 * the deflated stream is staged, and the id is supplied after the last byte.
 * Reads inflate with a pooled inflater that reports the exact end of the zlib
 * stream, so truncation and trailing bytes are errors (git: "garbage at end of
 * loose object"). A small object file (at most 64 KiB) is read whole and inflated in one pass
 * (`inflateWhole`), its content handed out in memory (`GitObject.bytes`); one that is not plainly
 * sound goes through the streaming read, which reports it as before.
 */
import {
  createInflaterPool,
  deflate,
  deflateSync,
  inflateWhole,
  LOOSE_OBJECT_COMPRESSION_LEVEL,
} from "@statewalker/vcs-utils/compression";
import { createSha1, type Hasher } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { SizeMismatchError } from "@statewalker/vcs-utils/pack";
import type { StagingBlobStore } from "../../storage/adapters/staging-blob-store.js";
import {
  CorruptObjectError,
  DEFAULT_SPOOL_THRESHOLD,
  type GitObject,
  type GitObjects,
  type GitObjectsOptions,
  InvalidObjectIdError,
  ObjectIdMismatchError,
  type ObjectQuarantine,
} from "./git-objects.js";
import { overlayObjects } from "./object-quarantine.js";
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

/** Releases a source that will not be read (`return()` on its iterator). */
function closeSource(content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): void {
  try {
    const it =
      Symbol.asyncIterator in Object(content)
        ? (content as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
        : (content as Iterable<Uint8Array>)[Symbol.iterator]();
    const r = it.return?.();
    if (r && typeof (r as Promise<unknown>).then === "function") {
      (r as Promise<unknown>).then(undefined, () => {});
    }
  } catch {
    // nothing to close
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Stored files up to this size are read and inflated in one pass (`wholeObject`). */
const LOOSE_WHOLE_MAX = 64 * 1024;
/** Objects (header included) inflated at once from a file of at most `PROBE_BYTES` (`smallObject`). */
const SMALL_MAX = 64 * 1024;
/** Stored bytes from which a loose object's header is read (`probeHead`). */
const PROBE_BYTES = 4096;
/**
 * Objects held in memory up to this size are compressed with one synchronous call
 * (`deflateSync`), at git's level for loose objects; larger ones stream through `deflate`.
 */
const SYNC_DEFLATE_MAX = 64 * 1024;
/** git's zlib level for loose objects (`core.looseCompression` unset: `Z_BEST_SPEED`). */
const LOOSE_LEVEL = LOOSE_OBJECT_COMPRESSION_LEVEL;
/** Objects up to this size are handed out whole; larger ones stream. */
const WHOLE_MAX = 1024 * 1024;

/**
 * Receives the start of a loose object (`wholeObject`): its header, at most `MAX_HEADER + 1`
 * bytes, fits whatever symbol comes next (a match is at most 258 bytes).
 */
const headProbe = new Uint8Array(MAX_HEADER + 1 + 258);

/**
 * A loose object of at most `SMALL_MAX` bytes inflated at once from its whole file (the output
 * grows: the size is in the header), or undefined (larger, or not plainly sound).
 */
function smallObject(stored: Uint8Array): GitObject | undefined {
  let r: ReturnType<typeof inflateWhole>;
  try {
    r = inflateWhole(stored, { maxSize: SMALL_MAX });
  } catch {
    return undefined;
  }
  if (r.consumed !== stored.length) return undefined;
  const out = r.data;
  const nul = out.subarray(0, Math.min(r.length, MAX_HEADER + 1)).indexOf(0);
  if (nul < 0) return undefined;
  let header: Header;
  try {
    header = parseHeader(out.subarray(0, nul));
  } catch {
    return undefined;
  }
  if (r.length - nul - 1 !== header.size) return undefined;
  const bytes = out.subarray(nul + 1, r.length);
  return { type: header.type, size: header.size, bytes, content: once(bytes) };
}

/** A loose object's header, read from the start of its file (`probeHead`). */
interface ProbedHead {
  header: Header;
  /** where the content starts in the inflated bytes (after the header's NUL) */
  bodyAt: number;
  /**
   * the whole object when it fit in `headProbe` (its zlib stream ended there): its content copied
   * out of the shared probe buffer, which a concurrent read may overwrite
   */
  whole?: { length: number; consumed: number; body: Uint8Array };
}

/**
 * The header of a loose object from the first bytes of its file (a partial inflate), or
 * undefined if they do not hold a sound one.
 */
function probeHead(start: Uint8Array): ProbedHead | undefined {
  let head: ReturnType<typeof inflateWhole>;
  try {
    head = inflateWhole(start, { into: headProbe, partial: true });
  } catch {
    return undefined; // corrupt, or the chunk ends inside the header
  }
  const nul = headProbe.subarray(0, Math.min(head.length, MAX_HEADER + 1)).indexOf(0);
  if (nul < 0) return undefined;
  let header: Header;
  try {
    header = parseHeader(headProbe.subarray(0, nul));
  } catch {
    return undefined;
  }
  return {
    header,
    bodyAt: nul + 1,
    ...(head.ended
      ? {
          whole: {
            length: head.length,
            consumed: head.consumed,
            body: headProbe.slice(nul + 1, head.length),
          },
        }
      : {}),
  };
}

/**
 * A small loose object inflated in one pass from its whole file, into a buffer of the size its
 * header declares. Undefined when it is not plainly sound (an error, bytes after the zlib
 * stream, a body longer or shorter than its header says), so the streaming read reports it.
 */
function wholeObject(stored: Uint8Array, head: ProbedHead): GitObject | undefined {
  const { header, bodyAt } = head;
  const total = bodyAt + header.size;
  let bytes: Uint8Array;
  if (head.whole) {
    // the whole object was in the probe: `stored` is the chunk it was probed from
    if (head.whole.consumed !== stored.length || head.whole.length !== total) return undefined;
    bytes = head.whole.body;
  } else {
    let r: ReturnType<typeof inflateWhole>;
    try {
      r = inflateWhole(stored, { size: total });
    } catch {
      return undefined;
    }
    if (r.consumed !== stored.length || r.length !== total) return undefined;
    bytes = r.data.subarray(bodyAt);
  }
  return { type: header.type, size: header.size, bytes, content: once(bytes) };
}

async function* once(b: Uint8Array): AsyncGenerator<Uint8Array> {
  yield b;
}

/** The first `n` bytes of `chunks` (all of them if shorter), copied only if they span chunks. */
function prefix(chunks: Uint8Array[], n: number): Uint8Array {
  const first = chunks[0] as Uint8Array;
  if (first.length >= n || chunks.length === 1)
    return first.length > n ? first.subarray(0, n) : first;
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(Math.min(n, total));
  let at = 0;
  for (const c of chunks) {
    if (at >= out.length) break;
    const part = c.subarray(0, out.length - at);
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function joined(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** `chunks`, then what is left of `rest`. */
async function* replay(
  chunks: Uint8Array[],
  rest: AsyncIterator<Uint8Array> | undefined,
): AsyncGenerator<Uint8Array> {
  let done = false;
  try {
    yield* chunks;
    if (rest) for (let r = await rest.next(); !r.done; r = await rest.next()) yield r.value;
    done = true;
  } finally {
    if (!done) await rest?.return?.();
  }
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
    source: AsyncIterable<Uint8Array> = store.get(id),
  ): AsyncGenerator<Uint8Array> {
    const inflater = pool.acquire();
    let done = false;
    let any = false;
    try {
      for await (const chunk of source) {
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

  async function* raw(
    id: string,
    verify: boolean,
    source?: AsyncIterable<Uint8Array>,
  ): AsyncGenerator<Uint8Array> {
    if (!isId(id)) return;
    const hasher = verify ? newHasher() : undefined;
    const state = { absent: false };
    yield* checkedRaw(inflate(id, state, false, source), {
      hasher,
      emptyIsAbsent: () => state.absent,
    });
    // An absent object ends the stream with nothing to verify.
    if (hasher && !state.absent) {
      const actual = hex(hasher);
      if (actual !== id) throw new ObjectIdMismatchError(`object ${id} hashes to ${actual}`);
    }
  }

  /**
   * The chunks of `content` while they total at most `size` bytes plus one chunk: an array
   * when the content ended there, else those chunks followed by the rest of the content,
   * with `close` to end the source when the rest may not be read to its end. Each gathered
   * chunk is copied: a source may refill one buffer for every chunk it yields.
   */
  async function gatherSmall(
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    size: number,
  ): Promise<Uint8Array[] | { rest: AsyncIterable<Uint8Array>; close: () => Promise<void> }> {
    const it =
      Symbol.asyncIterator in Object(content)
        ? (content as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
        : (content as Iterable<Uint8Array>)[Symbol.iterator]();
    const head: Uint8Array[] = [];
    let total = 0;
    while (total <= size) {
      const r = await it.next();
      if (r.done) return head;
      head.push(r.value.slice());
      total += r.value.length;
    }
    let ended = false;
    const close = async () => {
      if (ended) return;
      ended = true;
      await it.return?.();
    };
    async function* rest() {
      try {
        yield* head;
        for (let r = await it.next(); !r.done; r = await it.next()) yield r.value;
        ended = true;
      } finally {
        await close();
      }
    }
    return { rest: rest(), close };
  }

  async function put(
    type: ObjectTypeString,
    size: number,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<string> {
    if (!TYPES.has(type)) throw new TypeError(`unknown object type ${type}`);
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`bad object size ${size}`);
    // Content held in memory is hashed first, and an object already stored is not written
    // again (git's write_object_file: odb_freshen_object before writing). The write that
    // follows uses that id: the content is not hashed twice, and the store need not look
    // for the object again. A small one is compressed in one synchronous call, at git's
    // level for loose objects.
    let known: string | undefined;
    let closeSource: (() => Promise<void>) | undefined;
    if (!Array.isArray(content) && size <= SYNC_DEFLATE_MAX) {
      // a small object read from a stream (a worktree file): gathered first, at most one chunk
      // past its declared size, so it is hashed and compressed in memory as below (a
      // compression stream per small file costs more than the file); a size that does not
      // match is reported by the streaming path, as before
      const gathered = await gatherSmall(content, size);
      if (Array.isArray(gathered)) content = gathered;
      else {
        content = gathered.rest;
        closeSource = gathered.close;
      }
    }
    if (Array.isArray(content)) {
      const chunks = content as Uint8Array[];
      let total = 0;
      for (const chunk of chunks) total += chunk.length;
      if (total === size) {
        const header = enc.encode(`${type} ${size}\0`);
        const first = newHasher();
        first.update(header);
        for (const chunk of chunks) first.update(chunk);
        const id = hex(first);
        if (store.isFresh && (await store.isFresh(id))) return id;
        const checked = store.isFresh ? { notFresh: true } : undefined;
        if (size <= SYNC_DEFLATE_MAX) {
          const stored = deflateSync([header, ...chunks], { level: LOOSE_LEVEL });
          return (await store.putStaged(once(stored), () => id, checked)).id;
        }
        known = id;
      }
    }
    const hasher = known === undefined ? newHasher() : undefined;
    // a streamed source may refill one buffer for every chunk, while the compressor can still
    // hold the previous one: such chunks are copied (an array's chunks are the caller's to keep)
    const streamed = !Array.isArray(content);
    async function* framed() {
      yield enc.encode(`${type} ${size}\0`);
      if (!streamed) yield* content;
      else for await (const chunk of content) yield chunk.slice();
    }
    const sizeError = (declared: number, actual: number) => new SizeMismatchError(declared, actual);
    const id = known;
    try {
      const r = await store.putStaged(
        deflate(checkedRaw(framed(), { hasher, sizeError })),
        () => id ?? hex(hasher as Hasher),
        id !== undefined && store.isFresh ? { notFresh: true } : undefined,
      );
      return r.id;
    } finally {
      // a store that fails (or stops reading) before the end leaves the source open
      await closeSource?.();
    }
  }

  const objects: GitObjects = {
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
      // the id is known up front: an object already stored is only freshened, its bytes not
      // read (git's write_object_file, which hashes the buffer first; index-pack and
      // unpack-objects skip what the repository has)
      if (store.isFresh && (await store.isFresh(id))) {
        closeSource(rawBytes);
        return;
      }
      const hasher = newHasher();
      const checked = store.isFresh ? { notFresh: true } : undefined;
      if (Array.isArray(rawBytes)) {
        // held in memory (an unpacked object): checked and hashed, then compressed at once
        let total = 0;
        for (const chunk of rawBytes as Uint8Array[]) total += chunk.length;
        if (total <= SYNC_DEFLATE_MAX + MAX_HEADER) {
          const framed: Uint8Array[] = [];
          for await (const chunk of checkedRaw(rawBytes, { hasher })) framed.push(chunk);
          const actual = hex(hasher);
          if (actual !== id) {
            throw new ObjectIdMismatchError(`supplied id ${id}, content hashes to ${actual}`);
          }
          const stored = deflateSync(framed, { level: LOOSE_LEVEL });
          await store.putStaged(once(stored), () => id, checked);
          return;
        }
      }
      await store.putStaged(
        deflate(checkedRaw(rawBytes, { hasher })),
        () => {
          const actual = hex(hasher);
          if (actual !== id) {
            throw new ObjectIdMismatchError(`supplied id ${id}, content hashes to ${actual}`);
          }
          return id;
        },
        checked,
      );
    },

    getRaw(id) {
      return raw(id, false);
    },

    async get(id, opts) {
      if (!isId(id)) return undefined;
      const verify = opts?.verify === true;
      let source: AsyncIterable<Uint8Array> | undefined;
      if (!verify) {
        // A small object file is read whole (usually one chunk), inflated in one pass and
        // handed out whole. Anything else (a larger file, an error, bytes after the stream)
        // goes through the streaming read below, over the chunks already read, which reports
        // it as ever.
        const stored = store.get(id)[Symbol.asyncIterator]();
        const read: Uint8Array[] = [];
        let total = 0;
        let ended = false;
        const more = async (until: number) => {
          while (!ended && total < until) {
            const r = await stored.next();
            if (r.done) ended = true;
            else {
              read.push(r.value);
              total += r.value.length;
            }
          }
        };
        // the header from the first bytes (a store may give the zlib header as a chunk of its
        // own): a large object is not read whole
        await more(PROBE_BYTES);
        if (ended && total > 0) {
          // all of it in hand (most loose objects): inflated at once, its header read after
          const obj = smallObject(
            read.length === 1 ? (read[0] as Uint8Array) : joined(read, total),
          );
          if (obj) return obj;
        }
        const probed =
          total > 0 && total <= LOOSE_WHOLE_MAX ? prefix(read, PROBE_BYTES) : undefined;
        const head = probed ? probeHead(probed) : undefined;
        if (head && head.header.size <= WHOLE_MAX) {
          await more(LOOSE_WHOLE_MAX + 1);
          if (ended && total <= LOOSE_WHOLE_MAX) {
            const all = read.length === 1 ? (read[0] as Uint8Array) : joined(read, total);
            const obj = wholeObject(
              all,
              probed?.length === total ? head : { ...head, whole: undefined },
            );
            if (obj) return obj;
          }
        }
        // nothing read (absent, or a concurrent write): the streaming read looks again
        if (total > 0) source = replay(read, ended ? undefined : stored);
      }
      const it = raw(id, verify, source);
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

    async *listPrefix(prefix) {
      if (store.listPrefix) {
        for await (const id of store.listPrefix(prefix)) if (isId(id)) yield id;
      } else {
        for await (const id of store.list()) if (isId(id) && id.startsWith(prefix)) yield id;
      }
    },

    async approximateCount() {
      let n = 0;
      for await (const id of store.list()) if (isId(id)) n++;
      return n;
    },

    async remove(id) {
      checkId(id);
      return store.remove(id);
    },

    ...(store.sweepStale
      ? { sweepStale: (o: { olderThanMs: number }) => store.sweepStale?.(o) ?? Promise.resolve(0) }
      : {}),
  };
  const begin = store.beginQuarantine?.bind(store);
  if (begin) {
    // the quarantine's own kernel, read through an overlay that falls back to this one
    objects.beginQuarantine = async (): Promise<ObjectQuarantine> => {
      const q = await begin();
      return {
        objects: overlayObjects(createGitObjects(q.store, options), objects),
        commit: () => q.commit(),
        discard: () => q.discard(),
      };
    };
  }
  return objects;
}
