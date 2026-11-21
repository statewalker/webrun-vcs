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

/** A file of the git directory, as `send_local_file` sends it. */
export interface ServedGitFile {
  /** Its size in bytes (`Content-Length`) */
  size: number;
  /** Its modification time (ms since the epoch; `Last-Modified`), when known */
  lastModified?: number;
  /** Its bytes */
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
  /**
   * The repository's own packs (not its alternates'), as http-backend's `get_info_packs`
   * lists them: `pack-<hex>.pack` names, the youngest first (git's `sort_pack`)
   */
  localPacks(): Promise<string[]>;
}

function streamOf(chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/**
 * {@link ServedGitFiles} of the git directory `gitDir` in `files` (the repository directory,
 * where `objects/` is: a linked worktree's common directory). A file is served only when its
 * path, symbolic links followed where `files` can read them, stays inside the git directory
 * (http-backend opens whatever a link names).
 */
export function servedGitFilesOf(files: FilesApi, gitDir: string): ServedGitFiles {
  const dir = gitDir.replace(/\/+$/, "");
  const confined = async (path: string): Promise<string | undefined> => {
    const [real, realDir] = await Promise.all([
      realPath(files, `${dir}/${path}`),
      realPath(files, dir),
    ]);
    if (real === null || realDir === null || !inside(real, realDir) || real === realDir) {
      return undefined;
    }
    return real;
  };
  const fileStats = async (path: string) => {
    const stats = await files.stats(path).catch(() => undefined);
    return stats?.kind === "file" ? stats : undefined;
  };
  return {
    async read(path) {
      const real = await confined(path);
      if (real === undefined) return undefined;
      const stats = await fileStats(real);
      if (!stats) return undefined;
      return {
        size: stats.size ?? 0,
        ...(stats.lastModified !== undefined ? { lastModified: stats.lastModified } : {}),
        content: streamOf(files.read(real)),
      };
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
