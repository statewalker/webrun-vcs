/**
 * `core.sharedRepository` as git applies it (path.c `calc_shared_perm`, `adjust_shared_perm`):
 * the files and directories a shared repository's commands create get their permission bits
 * widened for the group (or everybody), or replaced by an octal mode, whatever the umask.
 *
 * @example
 * ```typescript
 * const shared = parseSharedRepository("group"); // 0o660
 * calcSharedPerm(0o644, shared); // 0o664
 * const repoFiles = withSharedPerm(files, () => shared, ".git");
 * await repoFiles.write(".git/refs/heads/main", [bytes]); // 0664, its new directories 2775
 * ```
 *
 * @module
 */

import type { FilesApi, LinkStats } from "./files-api.js";
import { dirname, normalizePath } from "./path-utils.js";

/** `core.sharedRepository=umask` (or false): the umask decides. */
export const PERM_UMASK = 0;
/** `core.sharedRepository=group` (true, 1): group-writable. */
export const PERM_GROUP = 0o660;
/** `core.sharedRepository=all` (world, everybody, 2): readable by everybody. */
export const PERM_EVERYBODY = 0o664;

/** git dies on an octal `core.sharedRepository` that leaves the owner without read and write. */
export class SharedRepositoryModeError extends Error {
  override name = "SharedRepositoryModeError";
  readonly lines: string[];
  constructor(readonly mode: number) {
    const octal = `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
    const lines = [
      `fatal: problem with core.sharedRepository filemode value (${octal}).`,
      "The owner of files must always have read and write permissions.",
    ];
    super(lines.join("\n").replace(/^fatal: /, ""));
    this.lines = lines;
  }
}

/**
 * git's `git_config_perm` of a `core.sharedRepository` value (or a `--shared=<value>`):
 * 0 for `umask` (or false), `0660` for `group` (or true), `0664` for
 * `all`/`world`/`everybody`, the negated masked mode for an octal one (`0640` gives
 * `-0o640`; `0`, `1` and `2` are umask, group and everybody). `undefined` (no value) is 0.
 *
 * @throws SharedRepositoryModeError for an octal mode that leaves the owner without read
 *   and write
 */
export function parseSharedRepository(value: string | undefined): number {
  if (value === undefined) return PERM_UMASK;
  if (value === "umask") return PERM_UMASK;
  if (value === "group") return PERM_GROUP;
  if (value === "all" || value === "world" || value === "everybody") return PERM_EVERYBODY;
  // strtol(value, &end, 8) consuming the whole value (an empty one included: 0)
  if (/^[ \t\n\v\f\r]*[+-]?[0-7]*$/.test(value)) {
    const i = Number.parseInt(value.trim() || "0", 8) || 0;
    if (i === 0) return PERM_UMASK;
    if (i === 1) return PERM_GROUP;
    if (i === 2) return PERM_EVERYBODY;
    if ((i & 0o600) !== 0o600) throw new SharedRepositoryModeError(i);
    return -(i & 0o666);
  }
  const lower = value.toLowerCase();
  return ["true", "yes", "on"].includes(lower) ? PERM_GROUP : PERM_UMASK;
}

/**
 * The `core.sharedRepository` value `git init` writes for `shared` (init_db): an octal mode
 * as `0<mode>`, group as `1`, everybody as `2` (spellings older gits read); undefined for 0.
 */
export function sharedRepositoryConfigValue(shared: number): string | undefined {
  if (shared === PERM_UMASK) return undefined;
  if (shared < 0) return `0${(-shared).toString(8)}`;
  if (shared === PERM_GROUP) return "1";
  if (shared === PERM_EVERYBODY) return "2";
  throw new Error(`invalid value for shared_repository: ${shared}`);
}

/** git's `calc_shared_perm` of a mode (its permission bits) under `shared`. */
export function calcSharedPerm(mode: number, shared: number): number {
  let tweak = shared < 0 ? -shared : shared;
  if (!(mode & 0o200)) tweak &= ~0o222;
  // copy the read bits to the execute bits
  if (mode & 0o100) tweak |= (tweak & 0o444) >> 2;
  return shared < 0 ? (mode & ~0o777) | tweak : mode | tweak;
}

/** The new mode `adjust_shared_perm` gives an entry of `kind` with permission bits `mode`. */
export function sharedPermOf(kind: LinkStats["kind"], mode: number, shared: number): number {
  let next = calcSharedPerm(mode, shared);
  if (kind === "directory") {
    next |= (next & 0o444) >> 2;
    // g+s (FORCE_DIR_SET_GID) matters only when the group is granted something
    if (next & 0o060) next |= 0o2000;
  }
  return next;
}

type ModeFilesApi = FilesApi & {
  lstat?(path: string): Promise<LinkStats | undefined>;
  chmod?(path: string, mode: number): Promise<void>;
  withLstatCache?(options?: { maxAgeMs?: number }): FilesApi;
};

/**
 * git's `adjust_shared_perm` of the file or directory at `path` under `shared` (as
 * {@link parseSharedRepository} returns it; 0 leaves it alone): its permission bits widened
 * (or, for an octal value, replaced) as {@link calcSharedPerm} computes them, a directory's
 * read bits copied to its execute bits and, when the group gains access, setgid set. Nothing
 * where the FilesApi keeps no modes (no `lstat` mode or no `chmod`), or for a link.
 */
export async function adjustSharedPerm(
  files: FilesApi,
  path: string,
  shared: number,
): Promise<void> {
  if (!shared) return;
  const posix = files as ModeFilesApi;
  if (!posix.lstat || !posix.chmod) return;
  const stats = await posix.lstat(path);
  if (stats?.mode === undefined || stats.kind === "symlink") return;
  const old = stats.mode & 0o7777;
  const next = sharedPermOf(stats.kind, old, shared) & 0o7777;
  if (next !== old) await posix.chmod(path, next);
}

/**
 * The files git creates read-only (mode 0444) in a repository's object directory: loose
 * objects, packs and their indexes, bitmaps, reverse indexes and mtimes, multi-pack-indexes
 * and commit-graphs. A shared repository's are created so here too, then adjusted.
 */
export function isReadOnlyObjectFile(path: string): boolean {
  return (
    /\/objects\/[0-9a-f]{2}\/[0-9a-f]{38,62}$/.test(path) ||
    /\/objects\/pack\/(pack-[0-9a-f]+\.(pack|idx|rev|bitmap|mtimes)|multi-pack-index[^/]*)$/.test(
      path,
    ) ||
    /\/objects\/pack\/multi-pack-index\.d\/[^/]+$/.test(path) ||
    /\/objects\/info\/(commit-graph|commit-graphs\/[^/]+)$/.test(path)
  );
}

/**
 * `files` with git's shared-repository modes applied to what it creates below `scope` (the
 * repository's git directory): each new file and directory (the leading directories a write
 * or a move creates too) adjusted as {@link adjustSharedPerm} does, the object files git keeps
 * read-only ({@link isReadOnlyObjectFile}) made 0444 first (written, or renamed into place),
 * and each `chmod` adjusted as well.
 * `shared` is asked at every write (0: `files` behaves as it is). Everything else passes
 * through; where the FilesApi keeps no modes nothing changes.
 */
export function withSharedPerm(files: FilesApi, shared: () => number, scope = "/"): FilesApi {
  const posix = files as ModeFilesApi;
  if (!posix.lstat || !posix.chmod) return files;
  const root = normalizePath(scope);
  const inScope = (path: string) => {
    const p = normalizePath(path);
    return root === "/" || p === root || p.startsWith(`${root}/`);
  };
  // the directories below `scope` missing on the way to `dir`, created and adjusted (git's
  // safe_create_leading_directories with a repository)
  const ensureDirs = async (dir: string, mode: number): Promise<void> => {
    const p = normalizePath(dir);
    if (!inScope(p) || (await files.stats(p)) !== undefined) return;
    const parent = dirname(p);
    if (parent !== p) await ensureDirs(parent, mode);
    await files.mkdir(p);
    await adjustSharedPerm(files, p, mode);
  };
  const adjustNew = async (path: string, mode: number) => {
    if (isReadOnlyObjectFile(normalizePath(path))) {
      const stats = await posix.lstat?.(path);
      if (stats?.kind === "file" && stats.mode !== undefined) {
        await posix.chmod?.(path, (stats.mode & ~0o777) | 0o444);
      }
    }
    await adjustSharedPerm(files, path, mode);
  };
  type Content = Parameters<FilesApi["write"]>[1];
  return new Proxy(files, {
    get(target, prop) {
      switch (prop) {
        case "write":
          return async (path: string, content: Content) => {
            const mode = shared();
            if (!mode || !inScope(path)) return target.write(path, content);
            await ensureDirs(dirname(path), mode);
            const existed = await target.stats(path);
            await target.write(path, content);
            if (existed) await adjustSharedPerm(target, path, mode);
            else await adjustNew(path, mode);
          };
        case "createExclusive":
          if (!target.createExclusive) return undefined;
          return async (path: string, content: Content) => {
            const mode = shared();
            if (!mode || !inScope(path)) return target.createExclusive?.(path, content);
            await ensureDirs(dirname(path), mode);
            const created = await target.createExclusive?.(path, content);
            if (created) await adjustNew(path, mode);
            return created;
          };
        case "append":
          if (!target.append) return undefined;
          return async (path: string, content: Content) => {
            const mode = shared();
            if (!mode || !inScope(path)) return target.append?.(path, content);
            await ensureDirs(dirname(path), mode);
            const existed = await target.stats(path);
            await target.append?.(path, content);
            if (!existed) await adjustNew(path, mode);
          };
        case "mkdir":
          return async (path: string) => {
            const mode = shared();
            if (mode && inScope(path)) await ensureDirs(path, mode);
            return target.mkdir(path);
          };
        case "copy":
          return async (source: string, to: string) => {
            const mode = shared();
            if (!mode || !inScope(to)) return target.copy(source, to);
            await ensureDirs(dirname(to), mode);
            const copied = await target.copy(source, to);
            if (copied) await adjustSharedPerm(target, to, mode);
            return copied;
          };
        case "move":
          return async (source: string, to: string) => {
            const mode = shared();
            if (!mode || !inScope(to)) return target.move(source, to);
            await ensureDirs(dirname(to), mode);
            const moved = await target.move(source, to);
            // a temporary renamed into place: git made it read-only and adjusted it
            if (moved && isReadOnlyObjectFile(normalizePath(to))) await adjustNew(to, mode);
            return moved;
          };
        case "chmod":
          return async (path: string, bits: number) => {
            await posix.chmod?.(path, bits);
            const mode = shared();
            if (mode && inScope(path)) await adjustSharedPerm(target, path, mode);
          };
        case "withLstatCache":
          if (!posix.withLstatCache) return undefined;
          return (options?: { maxAgeMs?: number }) =>
            withSharedPerm(posix.withLstatCache?.(options) ?? target, shared, scope);
        default: {
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      }
    },
  });
}
