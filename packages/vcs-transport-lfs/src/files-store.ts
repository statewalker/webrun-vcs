import { type FilesApi, moveCompleting } from "@statewalker/vcs-utils/files";
import { bytesToHex, createSha256 } from "@statewalker/vcs-utils/hash";
import type { ByteStream } from "@statewalker/webrun-content-store";
import { type ByteSource, chunksOf } from "./sha256.js";
import { type LfsObjectStore, type LfsPutResult, LfsTooLargeError } from "./store.js";
import type { LfsPointer } from "./types.js";

const OID = /^[0-9a-f]{64}$/;

/** Thrown inside a stream that runs past the size it was promised. */
class SizeExceeded extends Error {}

/** The held bytes of a partial changed (removed, rewritten) while they were copied. */
export class LfsPartialChangedError extends Error {
  constructor(oid: string) {
    super(`lfs partial ${oid} changed while it was being appended to`);
    this.name = "LfsPartialChangedError";
  }
}

function randomId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
}

/**
 * Per FilesApi instance, per `<root>\0<oid>`: the tail of the queue of
 * `partial.exclusive` calls. Module-level, so every store over the same FilesApi
 * instance and root shares it.
 */
const queues = new WeakMap<FilesApi, Map<string, Promise<unknown>>>();

/**
 * An {@link LfsObjectStore} on any `FilesApi`, in git-lfs's own layout under
 * `root` (a repository's `.git` directory, say), so native git-lfs and this
 * store share their objects:
 *
 * - objects at `lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>`;
 * - partial downloads at `lfs/incomplete/<oid>.part`, where git-lfs keeps its
 *   own (and resumes them with `Range` as this package's client does);
 * - writes in progress under `lfs/tmp/`.
 *
 * Every write streams into a temporary file, hashed (SHA-256) and counted on
 * the way, and is moved into place (FilesApi `move`, atomic where the backend
 * is) only when it matches what was expected; a mismatch removes the
 * temporary file and leaves nothing visible. Appending to a partial download
 * writes the held bytes and the new ones into a temporary file and moves it
 * over the `.part` (FilesApi has no append), so each resume copies what was
 * held once — streamed, never buffered; if the held bytes change while they
 * are copied, the append fails with `LfsPartialChangedError` before it reads
 * any new byte, and the client starts over. Moves go through `moveCompleting`
 * (a copy-then-delete backend's half-done move is finished), and a temporary
 * file is removed whenever a write or move throws. An invalid oid is never
 * turned into a path: it reads as absent and its writes are refused.
 *
 * `partial.exclusive` excludes calls for one object across every store over
 * the same FilesApi INSTANCE and root (trailing slashes ignored) in this
 * process; not across processes, nor across two FilesApi instances over one
 * directory.
 *
 * @example
 * ```typescript
 * const store = createFilesLfsStore(createNodeFilesApi({ rootDir: repoDir }), ".git");
 * await store.put(file, { oid, size }); // lands in .git/lfs/objects/aa/bb/<oid>
 * ```
 */
export function createFilesLfsStore(files: FilesApi, root = ""): LfsObjectStore {
  const base = root.replace(/\/+$/, "");
  const at = (path: string) => (base ? `${base}/${path}` : path);
  const objectPath = (oid: string) =>
    at(`lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`);
  const partPath = (oid: string) => at(`lfs/incomplete/${oid}.part`);
  const tmpPath = (oid: string) => at(`lfs/tmp/${oid}-${randomId()}`);

  async function fileSize(path: string): Promise<number | undefined> {
    const stats = await files.stats(path);
    return stats?.kind === "file" ? stats.size : undefined;
  }

  async function discard(path: string): Promise<void> {
    await files.remove(path).catch(() => false);
  }

  /**
   * Moves a verified file into the object's place. A temporary `source` is
   * removed whenever this fails or throws; a `.part` (`keepOnFailure`) stays
   * for the next attempt, which verifies it again.
   */
  async function publish(
    source: string,
    oid: string,
    size: number,
    keepOnFailure = false,
  ): Promise<void> {
    const target = objectPath(oid);
    let done = false;
    try {
      if ((await fileSize(target)) === size) {
        await discard(source); // stored already (by another writer, or native git-lfs)
      } else if (
        !(await moveCompleting(files, source, target)) &&
        (await fileSize(target)) !== size
      ) {
        throw new Error(`lfs object ${oid}: could not be moved into place`);
      }
      done = true;
    } finally {
      if (!done && !keepOnFailure) await discard(source);
    }
  }

  /** Hashes `content` as it is written into `path`; the oid and size once written. */
  async function writeHashed(
    path: string,
    content: ByteSource,
    limits: { size?: number; maxSize?: number },
  ): Promise<{ oid: string; size: number }> {
    const hash = createSha256();
    let size = 0;
    async function* hashed(): ByteStream {
      for await (const chunk of chunksOf(content)) {
        size += chunk.length;
        if (limits.maxSize !== undefined && size > limits.maxSize)
          throw new LfsTooLargeError(limits.maxSize);
        if (limits.size !== undefined && size > limits.size) throw new SizeExceeded();
        hash.update(chunk);
        yield chunk;
      }
    }
    await files.write(path, hashed());
    return { oid: bytesToHex(hash.digest()), size };
  }

  /** Writes `content` to `path`, hashed, then publishes it as `expected` or removes it. */
  async function verifyInto(
    path: string,
    content: ByteSource,
    expected: { oid: string; size?: number },
    maxSize?: number,
  ): Promise<LfsPutResult> {
    let actual: { oid: string; size: number };
    try {
      actual = await writeHashed(path, content, { size: expected.size, maxSize });
    } catch (error) {
      await discard(path);
      if (error instanceof SizeExceeded) return { ok: false, reason: "size mismatch" };
      if (error instanceof LfsTooLargeError) return { ok: false, reason: "too large" };
      throw error;
    }
    const reason =
      expected.size !== undefined && actual.size !== expected.size
        ? "size mismatch"
        : actual.oid !== expected.oid
          ? "sha256 mismatch"
          : undefined;
    if (reason) {
      await discard(path);
      return { ok: false, reason };
    }
    await publish(path, actual.oid, actual.size);
    return { ok: true, size: actual.size };
  }

  async function partialSize(oid: string): Promise<number> {
    if (!OID.test(oid)) return 0;
    return (await fileSize(partPath(oid))) ?? 0;
  }

  return {
    async size(oid) {
      return OID.test(oid) ? fileSize(objectPath(oid)) : undefined;
    },

    async *read(oid, range = {}) {
      if (!OID.test(oid)) return;
      yield* files.read(objectPath(oid), { start: range.offset, length: range.length });
    },

    async put(content, expected, opts = {}) {
      if (!OID.test(expected.oid)) return { ok: false, reason: "sha256 mismatch" };
      return verifyInto(tmpPath(expected.oid), content, expected, opts.maxSize);
    },

    partial: {
      size: partialSize,

      async append(oid, content) {
        if (!OID.test(oid)) throw new Error(`invalid lfs oid ${JSON.stringify(oid)}`);
        const part = partPath(oid);
        const held = await partialSize(oid);
        const tmp = tmpPath(oid);
        // the source's failure ends the write normally, so what arrived is kept
        let failure: { error: unknown } | undefined;
        let added = 0;
        async function* arriving(): ByteStream {
          try {
            for await (const chunk of chunksOf(content)) {
              added += chunk.length;
              yield chunk;
            }
          } catch (error) {
            failure = { error };
          }
        }
        async function* all(): ByteStream {
          if (held > 0) {
            let copied = 0;
            for await (const chunk of files.read(part)) {
              copied += chunk.length;
              yield chunk;
            }
            // removed or rewritten under us: never write the new bytes after the wrong ones
            if (copied !== held || (await fileSize(part)) !== held)
              throw new LfsPartialChangedError(oid);
          }
          yield* arriving();
        }
        let moved = false;
        try {
          await files.write(tmp, all());
          if (added > 0) {
            if (!(await moveCompleting(files, tmp, part)))
              throw new Error(`lfs partial ${oid}: could not be moved into place`);
            moved = true;
          }
        } finally {
          if (!moved) await discard(tmp);
        }
        if (failure) throw failure.error;
        return held + added;
      },

      async complete(pointer: LfsPointer) {
        if (!OID.test(pointer.oid)) return { ok: false, reason: "sha256 mismatch" };
        const part = partPath(pointer.oid);
        const size = await fileSize(part);
        if (size === undefined) return { ok: false, reason: "size mismatch" };
        const hash = createSha256();
        for await (const chunk of files.read(part)) hash.update(chunk);
        const reason =
          size !== pointer.size
            ? "size mismatch"
            : bytesToHex(hash.digest()) !== pointer.oid
              ? "sha256 mismatch"
              : undefined;
        if (reason) {
          await discard(part);
          return { ok: false, reason };
        }
        await publish(part, pointer.oid, size, true);
        return { ok: true, size };
      },

      async remove(oid) {
        if (OID.test(oid)) await discard(partPath(oid));
      },

      async exclusive(oid, fn) {
        let queue = queues.get(files);
        if (!queue) {
          queue = new Map();
          queues.set(files, queue);
        }
        const key = `${base}\0${oid}`;
        const before = queue.get(key) ?? Promise.resolve();
        const run = before.then(fn, fn);
        const tail = run.catch(() => undefined);
        queue.set(key, tail);
        try {
          return await run;
        } finally {
          if (queue.get(key) === tail) queue.delete(key);
        }
      },
    },
  };
}
