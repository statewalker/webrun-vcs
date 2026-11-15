/**
 * An LFS download from every peer that holds the object: byte ranges of one object fetched from
 * several sources at once, written in order, verified as a whole, with fallback between sources.
 */

import {
  BASIC_TRANSFER,
  type BatchObjectResponse,
  type BatchResponse,
  type FetchLike,
  LFS_CONTENT_TYPE,
  type LfsObjectStore,
  type LfsPointer,
} from "@statewalker/vcs-transport-lfs";
import { bytesToHex, createSha256 } from "@statewalker/vcs-utils/hash";
import { RANGED_TRANSFER } from "./mesh-lfs-handler.js";

/** One peer an object may be downloaded from. */
export interface LfsSource {
  /** Names the source in `received` and `bad` (one entry per name) */
  name: string;
  /** The peer's LFS endpoint (`…/repo.git/info/lfs`) */
  url: string;
  /** How requests reach the peer (`meshRemoteFetch({ call, token })`); default global `fetch` */
  fetchImpl?: FetchLike;
  /** Headers for the batch, and for transfers of objects the server did not mark `authenticated` */
  headers?: Record<string, string>;
}

/** Options of {@link lfsSwarmDownload}. */
export interface LfsSwarmOptions {
  /** Bytes per ranged request (default 4 MiB) */
  chunkSize?: number;
  /**
   * Bytes received ahead of the write position at most (default: two chunks per source). A slow
   * source holds back the others only by this much memory.
   */
  windowBytes?: number;
  /** Aborts every request */
  signal?: AbortSignal;
}

/** What {@link lfsSwarmDownload} did. */
export interface LfsSwarmResult {
  /** The objects stored by this call (verified) */
  downloaded: string[];
  /** The objects that could not be stored, and why */
  failed: { oid: string; reason: string }[];
  /** Sources that sent bytes differing from the verified object, or a copy that failed to verify */
  bad: string[];
  /** Bytes received from each source */
  received: Record<string, number>;
}

const DEFAULT_CHUNK = 4 * 1024 * 1024;

/** A piece of the object as one source delivers it, read in order by the writer. */
interface Piece {
  start: number;
  /** Bytes received so far */
  length: number;
  chunks: Uint8Array[];
  done: boolean;
}

/** A piece received, for finding whose bytes were wrong. */
interface Received {
  source: string;
  start: number;
  end: number;
  hash: string;
}

interface Holder {
  source: LfsSource;
  answer: BatchObjectResponse;
}

class Mismatch extends Error {
  constructor(oid: string, reason: string) {
    super(`lfs object ${oid}: ${reason}`);
    this.name = "LfsSwarmMismatch";
  }
}

/** Resolves every waiting promise on `notify`. */
function signal() {
  let waiters: (() => void)[] = [];
  return {
    wait: () => new Promise<void>((resolve) => waiters.push(resolve)),
    notify() {
      const ready = waiters;
      waiters = [];
      for (const w of ready) w();
    },
  };
}

/** Per store, per oid: the tail of the downloads queued for it, when the store has no `exclusive`. */
const queues = new WeakMap<LfsObjectStore, Map<string, Promise<unknown>>>();

async function exclusive<T>(store: LfsObjectStore, oid: string, fn: () => Promise<T>): Promise<T> {
  if (store.partial?.exclusive) return store.partial.exclusive(oid, fn);
  let queue = queues.get(store);
  if (!queue) {
    queue = new Map();
    queues.set(store, queue);
  }
  const before = queue.get(oid) ?? Promise.resolve();
  const run = before.then(fn, fn);
  const tail = run.catch(() => undefined);
  queue.set(oid, tail);
  try {
    return await run;
  } finally {
    if (queue.get(oid) === tail) queue.delete(oid);
  }
}

/** One batch `download` at a source, offering `ranged` then `basic`. */
async function batchAt(
  source: LfsSource,
  pointers: LfsPointer[],
  signal_: AbortSignal | undefined,
): Promise<BatchObjectResponse[]> {
  const fetchImpl = source.fetchImpl ?? ((request: Request) => fetch(request));
  const headers = new Headers(source.headers);
  headers.set("content-type", LFS_CONTENT_TYPE);
  headers.set("accept", LFS_CONTENT_TYPE);
  const res = await fetchImpl(
    new Request(`${source.url.replace(/\/+$/, "")}/objects/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operation: "download",
        transfers: [RANGED_TRANSFER, BASIC_TRANSFER],
        objects: pointers.map(({ oid, size }) => ({ oid, size })),
        hash_algo: "sha256",
      }),
      signal: signal_,
    }),
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`batch failed: ${res.status}`);
  }
  const json = (await res.json()) as BatchResponse;
  if (
    json.transfer !== undefined &&
    json.transfer !== BASIC_TRANSFER &&
    json.transfer !== RANGED_TRANSFER
  )
    throw new Error(`the server chose transfer ${json.transfer}`);
  return Array.isArray(json.objects) ? json.objects : [];
}

/** Gathers [from, size) of one object from `holders`, as a stream in object order. */
function gather(
  holders: Holder[],
  pointer: LfsPointer,
  from: number,
  opts: LfsSwarmOptions,
  received: Received[],
  counts: Record<string, number>,
): { bytes: AsyncGenerator<Uint8Array>; stop(): void } {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0)
    throw new Error(`chunkSize must be a positive integer, not ${chunkSize}`);
  const windowBytes = Math.max(opts.windowBytes ?? chunkSize * 2 * holders.length, chunkSize);
  const queue: [number, number][] = [];
  for (let s = from; s < pointer.size; s += chunkSize)
    queue.push([s, Math.min(s + chunkSize, pointer.size)]);
  const pieces = new Map<number, Piece>();
  const changed = signal();
  const controller = new AbortController();
  const onAbort = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const errors: string[] = [];
  let frontier = from;
  let inFlight = 0;
  let workers = holders.length;
  let stopped = false;

  const requeue = (range: [number, number]) => {
    let i = 0;
    while (i < queue.length && (queue[i] as [number, number])[0] < range[0]) i++;
    queue.splice(i, 0, range);
  };

  /** Fetches [start, end) from `h` into `piece`; the error, if it stopped early. */
  async function fetchPiece(h: Holder, piece: Piece, end: number): Promise<unknown> {
    const action = h.answer.actions?.download;
    if (!action) return new Error("no download action");
    const hash = createSha256();
    const start = piece.start;
    try {
      const headers = new Headers(h.answer.authenticated ? undefined : h.source.headers);
      for (const [k, v] of Object.entries(action.header ?? {})) headers.set(k, v);
      headers.set("range", `bytes=${start}-${end - 1}`);
      const fetchImpl = h.source.fetchImpl ?? ((request: Request) => fetch(request));
      const res = await fetchImpl(new Request(action.href, { headers, signal: controller.signal }));
      const at = /^bytes (\d+)-/.exec(res.headers.get("content-range") ?? "")?.[1];
      // 206 for the range asked, or 200 (a source ignoring Range): read from `start`
      let skip: number;
      if (res.status === 206 && Number(at) === start) skip = 0;
      else if (res.status === 200) skip = start;
      else {
        await res.body?.cancel().catch(() => {});
        return new Error(`HTTP ${res.status} for [${start}, ${end})`);
      }
      if (!res.body) return new Error("empty body");
      const reader = res.body.getReader();
      try {
        while (piece.length < end - start && !stopped) {
          const r = await reader.read();
          if (r.done) break;
          let c = r.value;
          if (skip > 0) {
            const drop = Math.min(skip, c.length);
            skip -= drop;
            c = c.subarray(drop);
          }
          c = c.subarray(0, end - start - piece.length);
          if (c.length === 0) continue;
          hash.update(c);
          piece.chunks.push(c);
          piece.length += c.length;
          counts[h.source.name] = (counts[h.source.name] ?? 0) + c.length;
          changed.notify();
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (piece.length < end - start)
        return new Error(`ended at ${start + piece.length} of [${start}, ${end})`);
      return undefined;
    } catch (error) {
      return error;
    } finally {
      if (piece.length > 0)
        received.push({
          source: h.source.name,
          start,
          end: start + piece.length,
          hash: bytesToHex(hash.digest()),
        });
    }
  }

  async function work(h: Holder): Promise<void> {
    try {
      for (;;) {
        if (stopped) return;
        const next = queue[0];
        if (!next) {
          if (inFlight === 0) return;
          await changed.wait();
          continue;
        }
        if (next[0] >= frontier + windowBytes) {
          await changed.wait();
          continue;
        }
        queue.shift();
        const [start, end] = next;
        const piece: Piece = { start, length: 0, chunks: [], done: false };
        pieces.set(start, piece);
        inFlight++;
        const error = await fetchPiece(h, piece, end);
        piece.done = true;
        if (start + piece.length < end) requeue([start + piece.length, end]);
        inFlight--;
        changed.notify();
        if (error !== undefined) {
          errors.push(
            `${h.source.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return; // this source is done
        }
      }
    } finally {
      workers--;
      changed.notify();
    }
  }

  const stop = () => {
    stopped = true;
    controller.abort();
    opts.signal?.removeEventListener("abort", onAbort);
    changed.notify();
  };

  async function* bytes(): AsyncGenerator<Uint8Array> {
    const running = holders.map((h) => work(h));
    try {
      while (frontier < pointer.size) {
        const piece = pieces.get(frontier);
        if (!piece) {
          if (workers === 0)
            throw new Error(
              `no source could serve [${frontier}, ${pointer.size}): ${errors.join("; ")}`,
            );
          await changed.wait();
          continue;
        }
        for (;;) {
          const chunk = piece.chunks.shift();
          if (chunk) {
            yield chunk;
            continue;
          }
          if (piece.done) break;
          await changed.wait();
        }
        if (pieces.get(frontier) === piece) pieces.delete(frontier);
        frontier += piece.length;
        changed.notify();
      }
    } finally {
      stop();
      await Promise.all(running);
    }
  }

  return { bytes: bytes(), stop };
}

/** Stores the gathered bytes: appended to the partial (resumable) or put whole; verified. */
async function runOnce(
  store: LfsObjectStore,
  holders: Holder[],
  pointer: LfsPointer,
  opts: LfsSwarmOptions,
  received: Received[],
  counts: Record<string, number>,
): Promise<void> {
  const partial = store.partial;
  let from = 0;
  if (partial) {
    from = await partial.size(pointer.oid);
    if (from > pointer.size) {
      await partial.remove(pointer.oid);
      from = 0;
    }
  }
  const { bytes } = gather(holders, pointer, from, opts, received, counts);
  if (partial) {
    if (from < pointer.size) await partial.append(pointer.oid, bytes);
    const done = await partial.complete(pointer);
    if (!done.ok) throw new Mismatch(pointer.oid, done.reason);
    return;
  }
  const done = await store.put(bytes, pointer);
  if (!done.ok) throw new Mismatch(pointer.oid, done.reason);
}

/** SHA-256 (hex) of [start, end) of a stored object. */
async function storedRangeHash(
  store: LfsObjectStore,
  oid: string,
  start: number,
  end: number,
): Promise<string> {
  const hash = createSha256();
  for await (const chunk of store.read(oid, { offset: start, length: end - start }))
    hash.update(chunk);
  return bytesToHex(hash.digest());
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Downloads LFS objects from every source that holds them. One batch per source says who holds
 * what (offering the `ranged` transfer, which `meshLfsHandler` answers; `basic` sources are
 * read with `Range` too, and a source ignoring it is read from the chunk's start). The ranges
 * still missing are cut into chunks; one worker per holder takes the lowest chunk from a shared
 * queue, and the chunks are written in object order as they arrive, so at most `windowBytes`
 * wait in memory. A source that fails is dropped and the rest of its chunk goes back to the
 * queue: no byte is received twice. Into a store with partials (`createFilesLfsStore`), what
 * arrived stays when every source fails, and the next call resumes from there.
 *
 * Once the last byte is in, the object is verified as a whole (SHA-256 and size) before it
 * becomes visible. When that fails (a source sent wrong bytes), or no source is left, the
 * holders are tried one at a time, each from what is held, until a copy verifies. The sources
 * whose bytes differ from the verified object, and those whose own copy failed to verify, are
 * reported in `bad`.
 *
 * @example
 * ```ts
 * const result = await lfsSwarmDownload(pointers, [
 *   { name: "b", url: "http://b/repo.git/info/lfs", fetchImpl: meshRemoteFetch({ call: toB, token }) },
 *   { name: "c", url: "http://c/repo.git/info/lfs", fetchImpl: meshRemoteFetch({ call: toC, token }) },
 * ], createFilesLfsStore(files, ".git"));
 * result.bad; // ["c"] when c served corrupt bytes
 * ```
 */
export async function lfsSwarmDownload(
  pointers: LfsPointer[],
  sources: LfsSource[],
  store: LfsObjectStore,
  opts: LfsSwarmOptions = {},
): Promise<LfsSwarmResult> {
  const result: LfsSwarmResult = { downloaded: [], failed: [], bad: [], received: {} };
  const bad = new Set<string>();
  const unique = [...new Map(pointers.map((p) => [p.oid, p])).values()];
  const wanted: LfsPointer[] = [];
  for (const p of unique) if ((await store.size(p.oid)) !== p.size) wanted.push(p);
  if (wanted.length === 0) return result;

  const named = [...new Map(sources.map((s) => [s.name, s])).values()];
  const batchErrors: string[] = [];
  const answers = await Promise.all(
    named.map(async (source) => {
      try {
        return { source, objects: await batchAt(source, wanted, opts.signal) };
      } catch (e) {
        batchErrors.push(`${source.name}: ${message(e)}`);
        return { source, objects: [] as BatchObjectResponse[] };
      }
    }),
  );

  for (const pointer of wanted) {
    const holders: Holder[] = [];
    for (const a of answers) {
      const answer = a.objects.find((o) => o?.oid === pointer.oid);
      if (answer && !answer.error && answer.size === pointer.size && answer.actions?.download)
        holders.push({ source: a.source, answer });
    }
    if (holders.length === 0) {
      result.failed.push({
        oid: pointer.oid,
        reason: `not found on any source${batchErrors.length ? ` (${batchErrors.join("; ")})` : ""}`,
      });
      continue;
    }
    try {
      await exclusive(store, pointer.oid, async () => {
        if ((await store.size(pointer.oid)) === pointer.size) return;
        const received: Received[] = [];
        let mismatch = false;
        try {
          await runOnce(store, holders, pointer, opts, received, result.received);
          return;
        } catch (e) {
          if (opts.signal?.aborted) throw e;
          mismatch = e instanceof Mismatch;
        }
        // one holder at a time, from what is held, until a copy verifies
        const failures: string[] = [];
        let good = false;
        for (const h of holders) {
          try {
            await runOnce(store, [h], pointer, opts, received, result.received);
            good = true;
            break;
          } catch (e) {
            if (opts.signal?.aborted) throw e;
            failures.push(`${h.source.name}: ${message(e)}`);
            if (e instanceof Mismatch) {
              mismatch = true;
              bad.add(h.source.name);
            }
          }
        }
        if (!good)
          throw new Error(`no source served it whole and verified (${failures.join("; ")})`);
        // whose bytes differ from the verified object
        if (mismatch)
          for (const r of received)
            if ((await storedRangeHash(store, pointer.oid, r.start, r.end)) !== r.hash)
              bad.add(r.source);
      });
      result.downloaded.push(pointer.oid);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      result.failed.push({ oid: pointer.oid, reason: message(e) });
    }
  }
  result.bad = [...bad];
  return result;
}
