/**
 * The files of a served repository's git directory that git's `http-backend` hands a dumb
 * HTTP client (`objects/info/alternates`, loose objects, packs and their indexes), read
 * through a FilesApi, and the local packs it lists in `objects/info/packs`.
 *
 * @example
 * ```ts
 * const served: ServedRepository = {
 *   repository,
 *   refStore,
 *   // a files-backed repository: its git directory in the storage
 *   files: servedGitFilesOf(files, "/srv/git/r.git"),
 * };
 * ```
 */

import type { FilesApi } from "@statewalker/vcs-utils/files";
import { inside, realPath } from "./base-path-resolver.js";

/** What is known of a file of the git directory without opening it (a `HEAD` request). */
export interface ServedGitFileStats {
  /** Its size in bytes (`Content-Length`) */
  size: number;
  /** Its modification time (ms since the epoch; `Last-Modified`), when known */
  lastModified?: number;
}

/** A file of the git directory, as `send_local_file` sends it. */
export interface ServedGitFile extends ServedGitFileStats {
  /**
   * Its bytes; the file is opened at the first read of the stream (not before) and closed
   * when the stream is cancelled
   */
  content: ReadableStream<Uint8Array>;
}

/**
 * The git directory's files a dumb HTTP client asks for (`ServedRepository.files`). Without
 * it a served repository answers the dumb protocol's `HEAD` and `info/refs` from its refs
 * and every `objects/...` request 404, as for a missing file.
 */
export interface ServedGitFiles {
  /**
   * The file at `path` of the git directory (`objects/ab/cdef...`,
   * `objects/info/alternates`), undefined when there is none (http-backend's "Cannot open")
   */
  read(path: string): Promise<ServedGitFile | undefined>;
  /** The size and date of the file at `path`, as {@link read} would serve it, unopened */
  stat(path: string): Promise<ServedGitFileStats | undefined>;
  /**
   * The repository's own packs (not its alternates'), as http-backend's `get_info_packs`
   * lists them: `pack-<hex>.pack` names, the youngest first (git's `sort_pack`)
   */
  localPacks(): Promise<string[]>;
}

/**
 * The bytes of `open()` as a stream that opens them at its first read (a high-water mark of
 * 0: nothing is pulled before a reader asks) and closes them when cancelled.
 */
function lazyStreamOf(open: () => AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  let iterator: AsyncIterator<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        iterator ??= open()[Symbol.asyncIterator]();
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel() {
        await iterator?.return?.();
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * {@link ServedGitFiles} of the git directory `gitDir` in `files` (the repository directory,
 * where `objects/` is: a linked worktree's common directory). Only files of its object
 * directory are served (http-backend's routes are all under `objects/`), and only when their
 * path, symbolic links followed where `files` can read them, stays inside the object
 * directory's real path (http-backend opens whatever a link names): an alternates file
 * linked to `../config` is not served. An absolute link (an `objects` directory linked to
 * `/srv/shared/objects`) is followed when `files.rootDirectory` tells where the storage is on
 * the host and the target lies inside it; otherwise what it names is not served (404).
 */
export function servedGitFilesOf(files: FilesApi, gitDir: string): ServedGitFiles {
  const dir = gitDir.replace(/\/+$/, "");
  const hostRoot = (files as { rootDirectory?: string }).rootDirectory;
  const options = hostRoot ? { hostRoot } : {};
  const confined = async (path: string): Promise<string | undefined> => {
    if (!path.startsWith("objects/")) return undefined;
    const [real, realObjects] = await Promise.all([
      realPath(files, `${dir}/${path}`, options),
      realPath(files, `${dir}/objects`, options),
    ]);
    if (
      real === null ||
      realObjects === null ||
      !inside(real, realObjects) ||
      real === realObjects
    ) {
      return undefined;
    }
    return real;
  };
  const fileStats = async (path: string) => {
    const stats = await files.stats(path).catch(() => undefined);
    return stats?.kind === "file" ? stats : undefined;
  };
  const statOf = async (path: string) => {
    const real = await confined(path);
    if (real === undefined) return undefined;
    const stats = await fileStats(real);
    if (!stats) return undefined;
    return {
      real,
      size: stats.size ?? 0,
      ...(stats.lastModified !== undefined ? { lastModified: stats.lastModified } : {}),
    };
  };
  return {
    async read(path) {
      const found = await statOf(path);
      if (!found) return undefined;
      const { real, ...stats } = found;
      return { ...stats, content: lazyStreamOf(() => files.read(real)) };
    },
    async stat(path) {
      const found = await statOf(path);
      if (!found) return undefined;
      const { real: _real, ...stats } = found;
      return stats;
    },
    async localPacks() {
      const packDir = await confined("objects/pack");
      if (packDir === undefined) return [];
      const names: string[] = [];
      try {
        for await (const entry of files.list(packDir)) names.push(entry.name);
      } catch {
        return [];
      }
      // prepare_pack: each `.idx` whose `.pack` is there (add_packed_git), dated by the pack
      const packs: Array<{ name: string; mtime: number; order: number }> = [];
      for (const name of names) {
        if (!name.endsWith(".idx")) continue;
        const pack = `${name.slice(0, -4)}.pack`;
        const stats = await fileStats(`${packDir}/${pack}`);
        if (!stats) continue;
        packs.push({
          name: pack,
          mtime: Math.floor((stats.lastModified ?? 0) / 1000),
          order: packs.length,
        });
      }
      // sort_pack: the younger first (seconds, as `st_mtime`), the listing's order on a tie
      packs.sort((a, b) => b.mtime - a.mtime || a.order - b.order);
      return packs.map((p) => p.name);
    },
  };
}
