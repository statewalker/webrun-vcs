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
import { bytesToHex, createSha256, type Hasher } from "@statewalker/vcs-utils/hash";
import { RANGED_TRANSFER } from "./mesh-lfs-handler.js";

/** One peer an object may be downloaded from. */
export interface LfsSource {
  /** Names the source in `received` and `bad` (one entry per name) */
  name: string;
  /** The peer's LFS endpoint (`…/repo.git/info/lfs`) */
  url: string;
  /**
   * How requests reach the peer (`meshRemoteFetch({ call, token })`, which keeps the token on
   * the endpoint's origin); default global `fetch`
   */
  fetchImpl?: FetchLike;
  /**
   * Headers for the batch, and for transfers on the endpoint's origin of objects the server did
   * not mark `authenticated`. They never go to another origin.
   */
  headers?: Record<string, string>;
}

/** Options of {@link lfsSwarmDownload}. */
export interface LfsSwarmOptions {
  /** Bytes per ranged request (default 4 MiB) */
  chunkSize?: number;
  /**
   * Bytes received ahead of the write position at most (default: two chunks per source, never
   * less than one chunk). A slow source holds back the others only by this much memory.
   */
  windowBytes?: number;
  /**
   * A request that brings no byte for this long (ms) fails and its source is dropped
   * (default 30000).
   */
  idleTimeoutMs?: number;
  /**
   * A source with nothing to do takes over a chunk another source has sent nothing for this
   * long (ms); the stalled source is dropped (default: half of `idleTimeoutMs`, at most 5000).
   */
  reassignAfterMs?: number;
  /** Aborts every request */
  signal?: AbortSignal;
}

/** What {@link lfsSwarmDownload} did. */
export interface LfsSwarmResult {
  /** The objects stored by this call (verified) */
  downloaded: string[];
  /** The objects that could not be stored, and why */
  failed: { oid: string; reason: string }[];
  /**
   * Sources that sent bytes differing from the verified object, or whose own copy (downloaded
   * from it alone, from the first byte) failed to verify
   */
  bad: string[];
  /** Bytes received from each source */
  received: Record<string, number>;
}

const DEFAULT_CHUNK = 4 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT = 30_000;

/** A piece of the object as one source delivers it, read in order by the writer. */
interface Piece {
  start: number;
  end: number;
  /** Bytes received so far */
  length: number;
  chunks: Uint8Array[];
  done: boolean;
  source: string;
  /** When a byte last arrived (or the request started) */
  lastProgress: number;
  hash: Hasher;
  /** Aborts the request this piece is read from */
  controller: AbortController;
  /** Taken over by another source */
  stolen: boolean;
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
  constructor(
    oid: string,
    reason: string,
    /** Where this attempt started: 0 means every byte came from its own sources */
    readonly from: number,
  ) {
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

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

/** The validated sizes and timeouts of a swarm. */
function settings(opts: LfsSwarmOptions, holders: number) {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0)
    throw new Error(`chunkSize must be a positive integer, not ${chunkSize}`);
  if (
    opts.windowBytes !== undefined &&
    (!Number.isFinite(opts.windowBytes) || opts.windowBytes <= 0)
  )
    throw new Error(`windowBytes must be a positive number, not ${opts.windowBytes}`);
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0)
    throw new Error(`idleTimeoutMs must be a positive number, not ${idleTimeoutMs}`);
  const reassignAfterMs = opts.reassignAfterMs ?? Math.min(5000, idleTimeoutMs / 2);
  if (!Number.isFinite(reassignAfterMs) || reassignAfterMs <= 0)
    throw new Error(`reassignAfterMs must be a positive number, not ${reassignAfterMs}`);
  return {
    chunkSize,
    windowBytes: Math.max(opts.windowBytes ?? chunkSize * 2 * Math.max(1, holders), chunkSize),
    idleTimeoutMs,
    reassignAfterMs,
    /** How often an idle source looks for a stalled chunk */
    tick: Math.max(5, Math.min(reassignAfterMs / 2, 1000)),
  };
}

/**
 * Gathers [from, size) of one object from `holders`, as a stream in object order. Nothing runs
 * until the stream is read.
 */
function gather(
  holders: Holder[],
  pointer: LfsPointer,
  from: number,
  opts: LfsSwarmOptions,
  received: Received[],
  counts: Record<string, number>,
  dropped?: Set<string>,
): AsyncGenerator<Uint8Array> {
  const { chunkSize, windowBytes, idleTimeoutMs, reassignAfterMs, tick } = settings(
    opts,
    holders.length,
  );
  const queue: [number, number][] = [];
  for (let s = from; s < pointer.size; s += chunkSize)
    queue.push([s, Math.min(s + chunkSize, pointer.size)]);
  /** Pieces by start, until the writer has passed them */
  const pieces = new Map<number, Piece>();
  /** Pieces being received */
  const active = new Set<Piece>();
  const changed = signal();
  const controller = new AbortController();
  const errors: string[] = [];
  let frontier = from;
  let inFlight = 0;
  let workers = holders.length;
  let stopped = false;

  /** Resolves on the next change, or after `ms`. */
  const waitFor = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      void changed.wait().then(() => {
        clearTimeout(timer);
        resolve();
      });
    });

  const requeue = (range: [number, number]) => {
    let i = 0;
    while (i < queue.length && (queue[i] as [number, number])[0] < range[0]) i++;
    queue.splice(i, 0, range);
  };

  const newPiece = (start: number, end: number, h: Holder, pieceCtl: AbortController): Piece => {
    const piece: Piece = {
      start,
      end,
      length: 0,
      chunks: [],
      done: false,
      source: h.source.name,
      lastProgress: Date.now(),
      hash: createSha256(),
      controller: pieceCtl,
      stolen: false,
    };
    pieces.set(start, piece);
    active.add(piece);
    inFlight++;
    return piece;
  };

  const finishPiece = (piece: Piece) => {
    if (piece.done) return;
    piece.done = true;
    active.delete(piece);
    if (piece.length > 0)
      received.push({
        source: piece.source,
        start: piece.start,
        end: piece.start + piece.length,
        hash: bytesToHex(piece.hash.digest()),
      });
    if (piece.start + piece.length < piece.end) requeue([piece.start + piece.length, piece.end]);
    inFlight--;
    changed.notify();
  };

  /** Takes over the lowest chunk another source has sent nothing for `reassignAfterMs`. */
  const stealStalled = (h: Holder) => {
    const now = Date.now();
    let victim: Piece | undefined;
    for (const p of active) {
      if (p.source === h.source.name || p.stolen || now - p.lastProgress < reassignAfterMs)
        continue;
      if (!victim || p.start < victim.start) victim = p;
    }
    if (!victim) return;
    victim.stolen = true;
    victim.controller.abort(
      new Error(`stalled: nothing for ${now - victim.lastProgress} ms, reassigned`),
    );
  };

  /**
   * Fetches [start, end) from `h`. A source answering 206 serves this range only. A source
   * ignoring Range (200) is read on from `start` through every following range nobody else has
   * taken, from the same response, and then does no more ranged work.
   */
  async function run(
    h: Holder,
    [start, end]: [number, number],
  ): Promise<{ error?: unknown; sequential?: boolean }> {
    const pieceCtl = new AbortController();
    const onStop = () => pieceCtl.abort(controller.signal.reason ?? new Error("stopped"));
    if (controller.signal.aborted) onStop();
    else controller.signal.addEventListener("abort", onStop, { once: true });
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(pieceCtl.signal.reason ?? new Error("aborted"));
      if (pieceCtl.signal.aborted) fail();
      else pieceCtl.signal.addEventListener("abort", fail, { once: true });
    });
    aborted.catch(() => {});
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => pieceCtl.abort(new Error(`stalled: nothing for ${idleTimeoutMs} ms`)),
        idleTimeoutMs,
      );
    };
    let piece = newPiece(start, end, h, pieceCtl);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      arm();
      const action = h.answer.actions?.download;
      if (!action) throw new Error("no download action");
      // the source's own headers belong to its endpoint: never to another origin
      const sameOrigin =
        originOf(action.href) !== undefined && originOf(action.href) === originOf(h.source.url);
      const headers = new Headers(
        !h.answer.authenticated && sameOrigin ? h.source.headers : undefined,
      );
      for (const [k, v] of Object.entries(action.header ?? {})) headers.set(k, v);
      headers.set("range", `bytes=${start}-${end - 1}`);
      const fetchImpl = h.source.fetchImpl ?? ((request: Request) => fetch(request));
      const res = await Promise.race([
        fetchImpl(new Request(action.href, { headers, signal: pieceCtl.signal })),
        aborted,
      ]);
      arm();
      const at = /^bytes (\d+)-(\d+)\//.exec(res.headers.get("content-range") ?? "");
      let skip: number;
      let sequential = false;
      if (res.status === 206 && Number(at?.[1]) === start && Number(at?.[2]) <= end - 1) skip = 0;
      else if (res.status === 200) {
        skip = start;
        sequential = true;
      } else {
        void res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status}${at ? ` (${at[0]})` : ""} for [${start}, ${end})`);
      }
      if (!res.body) throw new Error("empty body");
      const body = res.body.getReader();
      reader = body;
      let leftover: Uint8Array | undefined;
      const read = async (): Promise<Uint8Array | undefined> => {
        for (;;) {
          if (leftover) {
            const c = leftover;
            leftover = undefined;
            return c;
          }
          const r = await Promise.race([body.read(), aborted]);
          if (r.done) return undefined;
          arm();
          let c = r.value;
          if (skip > 0) {
            const drop = Math.min(skip, c.length);
            skip -= drop;
            c = c.subarray(drop);
          }
          if (c.length > 0) return c;
        }
      };
      const fill = async (p: Piece) => {
        while (p.length < p.end - p.start) {
          const c = await read();
          if (!c) throw new Error(`ended at ${p.start + p.length} of [${p.start}, ${p.end})`);
          const want = p.end - p.start - p.length;
          const part = c.length > want ? c.subarray(0, want) : c;
          if (c.length > want) leftover = c.subarray(want);
          p.hash.update(part);
          p.chunks.push(part);
          p.length += part.length;
          p.lastProgress = Date.now();
          counts[p.source] = (counts[p.source] ?? 0) + part.length;
          changed.notify();
        }
      };
      await fill(piece);
      finishPiece(piece);
      if (!sequential) return {};
      // a source ignoring Range: read on through the ranges that follow, never again from 0
      for (;;) {
        const next = queue[0];
        if (stopped || !next || next[0] !== piece.end) return { sequential: true };
        if (next[0] >= frontier + windowBytes) {
          arm(); // waiting for the writer is not the source's fault
          await Promise.race([waitFor(tick), aborted]);
          continue;
        }
        queue.shift();
        piece = newPiece(next[0], next[1], h, pieceCtl);
        await fill(piece);
        finishPiece(piece);
      }
    } catch (error) {
      finishPiece(piece);
      return { error };
    } finally {
      clearTimeout(idle);
      controller.signal.removeEventListener("abort", onStop);
      // not awaited: cancelling a stalled body may never settle
      if (reader) void reader.cancel().catch(() => {});
    }
  }

  async function work(h: Holder): Promise<void> {
    try {
      for (;;) {
        if (stopped) return;
        const next = queue[0];
        if (next && next[0] < frontier + windowBytes) {
          queue.shift();
          const outcome = await run(h, next);
          if (outcome.error !== undefined) {
            if (!stopped) {
              errors.push(`${h.source.name}: ${message(outcome.error)}`);
              dropped?.add(h.source.name);
            }
            return; // this source is dropped
          }
          if (outcome.sequential) return; // no more ranged work from a source ignoring Range
          continue;
        }
        if (!next && inFlight === 0) return;
        stealStalled(h);
        await waitFor(tick);
      }
    } finally {
      workers--;
      changed.notify();
    }
  }

  const stop = () => {
    stopped = true;
    controller.abort(opts.signal?.reason ?? new Error("stopped"));
    changed.notify();
  };

  return (async function* bytes(): AsyncGenerator<Uint8Array> {
    const onAbort = () => stop();
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const running = holders.map((h) => work(h));
    try {
      while (frontier < pointer.size) {
        if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
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
      opts.signal?.removeEventListener("abort", onAbort);
      stop();
      await Promise.all(running);
    }
  })();
}

/** Stores the gathered bytes: appended to the partial (resumable) or put whole; verified. */
async function runOnce(
  store: LfsObjectStore,
  holders: Holder[],
  pointer: LfsPointer,
  opts: LfsSwarmOptions,
  received: Received[],
  counts: Record<string, number>,
  dropped?: Set<string>,
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
  const bytes = gather(holders, pointer, from, opts, received, counts, dropped);
  if (partial) {
    if (from < pointer.size) await partial.append(pointer.oid, bytes);
    const done = await partial.complete(pointer);
    if (!done.ok) {
      await partial.remove(pointer.oid).catch(() => {});
      throw new Mismatch(pointer.oid, done.reason, from);
    }
    return;
  }
  const done = await store.put(bytes, pointer);
  if (!done.ok) throw new Mismatch(pointer.oid, done.reason, 0);
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

/**
 * Downloads LFS objects from every source that holds them. One batch per source says who holds
 * what (offering the `ranged` transfer, which `meshLfsHandler` answers; `basic` sources are
 * read with `Range` too). The ranges still missing are cut into chunks; one worker per holder
 * takes the lowest chunk from a shared queue, and the chunks are written in object order as
 * they arrive, so at most `windowBytes` wait in memory. A source that fails, or sends nothing
 * for `idleTimeoutMs`, is dropped and the rest of its chunk goes back to the queue: no byte is
 * received twice. A source with nothing to do takes over a chunk another source has stalled on
 * for `reassignAfterMs`. A source ignoring `Range` is read sequentially from one response, never
 * from the start once per chunk. Into a store with partials (`createFilesLfsStore`), what
 * arrived stays when every source fails, and the next call resumes from there.
 *
 * Once the last byte is in, the object is verified as a whole (SHA-256 and size) before it
 * becomes visible. When that fails, or no source is left, the holders are tried one at a time
 * until a copy verifies; a copy that fails after resuming from held bytes (which another source
 * may have written) is dropped and that holder is tried again from the first byte. Sources are
 * blamed (`bad`) only for bytes they sent: a range whose hash differs from the verified object,
 * or a copy they sent whole that failed to verify.
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
  settings(opts, sources.length); // invalid options throw before any request
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
        if (opts.signal?.aborted) throw e;
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
        /** Sources that failed (or stalled) during the parallel attempt: tried last */
        const dropped = new Set<string>();
        let mismatch = false;
        try {
          await runOnce(store, holders, pointer, opts, received, result.received, dropped);
          return;
        } catch (e) {
          if (opts.signal?.aborted) throw e;
          mismatch = e instanceof Mismatch;
        }
        // one holder at a time, from what is held, until a copy verifies
        const failures: string[] = [];
        let good = false;
        const order = [
          ...holders.filter((h) => !dropped.has(h.source.name)),
          ...holders.filter((h) => dropped.has(h.source.name)),
        ];
        for (const h of order) {
          for (let attempt = 0; attempt < 2 && !good; attempt++) {
            try {
              await runOnce(store, [h], pointer, opts, received, result.received);
              good = true;
            } catch (e) {
              if (opts.signal?.aborted) throw e;
              if (!(e instanceof Mismatch)) {
                failures.push(`${h.source.name}: ${message(e)}`);
                break;
              }
              mismatch = true;
              // resumed from held bytes another source may have sent: the copy (dropped) says
              // nothing about this holder; try it again from the first byte
              if (e.from > 0) continue;
              failures.push(`${h.source.name}: ${message(e)}`);
              bad.add(h.source.name);
              break;
            }
          }
          if (good) break;
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
