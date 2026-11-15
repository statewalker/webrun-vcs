import type { FilesApi } from "@statewalker/vcs-utils/files";
import { bytesToHex, createSha256 } from "@statewalker/vcs-utils/hash";
import type { ByteStream } from "@statewalker/webrun-content-store";
import { type ByteSource, chunksOf } from "./sha256.js";
import { type LfsObjectStore, type LfsPutResult, LfsTooLargeError } from "./store.js";
import type { LfsPointer } from "./types.js";

const OID = /^[0-9a-f]{64}$/;

/** Thrown inside a stream that runs past the size it was promised. */
class SizeExceeded extends Error {}

function randomId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
}

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
 * held once — streamed, never buffered. An invalid oid is never turned into a
 * path: it reads as absent and its writes are refused.
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

  /** Moves a verified file into the object's place; true when the object is there after. */
  async function publish(source: string, oid: string, size: number): Promise<void> {
    const target = objectPath(oid);
    if ((await fileSize(target)) === size) {
      await discard(source); // stored already (by another writer, or native git-lfs)
      return;
    }
    if (!(await files.move(source, target)) && (await fileSize(target)) !== size) {
      await discard(source);
      throw new Error(`lfs object ${oid}: could not be moved into place`);
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
          if (held > 0) yield* files.read(part);
          yield* arriving();
        }
        try {
          await files.write(tmp, all());
        } catch (error) {
          await discard(tmp);
          throw error;
        }
        if (added > 0) {
          if (!(await files.move(tmp, part))) {
            await discard(tmp);
            throw new Error(`lfs partial ${oid}: could not be moved into place`);
          }
        } else {
          await discard(tmp);
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
        await publish(part, pointer.oid, size);
        return { ok: true, size };
      },

      async remove(oid) {
        if (OID.test(oid)) await discard(partPath(oid));
      },
    },
  };
}
