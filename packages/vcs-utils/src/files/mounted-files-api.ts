/**
 * Portable FilesApi composition: one FilesApi seen from a subdirectory
 * ({@link createSubtreeFilesApi}), and FilesApis mounted at paths of another
 * ({@link createMountedFilesApi}). Both pass the optional `PosixFilesApi` members (links,
 * modes, separators) through to the FilesApi that holds the path, so a mounted or
 * sub-rooted link-aware storage keeps its no-follow guarantees. A path with `..` is refused
 * (it could leave a subtree). `openLinkTarget` (which may reach beyond a root) is passed
 * through only when asked for (`forwardOpenLinkTarget`).
 */

import { mergeInPathOrder } from "@statewalker/webrun-files";

import { BeyondSymlinkError } from "./beyond-symlink-error.js";
import type {
  FileInfo,
  FileStats,
  FilesApi,
  LinkStats,
  ListOptions,
  PosixFilesApi,
  ReadOptions,
} from "./files-api.js";
import { normalizePath } from "./path-utils.js";

type Content = Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

/** Where a path lands: the FilesApi holding it, the path there, and how to map back. */
interface Route {
  files: PosixFilesApi;
  path: string;
  /** The path in the composed view of a path of `files` */
  outer: (inner: string) => string;
}

const join = (prefix: string, rest: string) =>
  prefix === "/" ? rest : rest === "/" ? prefix : `${prefix}${rest}`;

/** Options of the composing wrappers. */
export interface ComposedFilesApiOptions {
  /** Pass `openLinkTarget` through (it may reach beyond a root; default off). */
  forwardOpenLinkTarget?: boolean;
}

interface RoutedConfig {
  route: (path: string) => Route;
  separators?: string;
  refusesBeyondLinks?: boolean;
  /** Mount points (outer paths) and their FilesApis, for listings and removals */
  mounts?: { point: string; files: PosixFilesApi }[];
  forwardOpenLinkTarget?: boolean;
}

class RoutedFilesApi implements PosixFilesApi {
  readonly pathSeparators?: string;
  readonly refusesBeyondLinks?: boolean;
  private readonly route: (path: string) => Route;
  private readonly mounts: { point: string; files: PosixFilesApi }[];

  constructor(private readonly config: RoutedConfig) {
    this.route = config.route;
    this.mounts = config.mounts ?? [];
    if (config.separators) this.pathSeparators = config.separators;
    if (config.refusesBeyondLinks) this.refusesBeyondLinks = true;
  }

  private at(path: string): Route {
    if (path.split("/").includes("..")) throw new Error(`'..' in path: ${path}`);
    return this.route(normalizePath(path));
  }

  /** Rethrows a `BeyondSymlinkError` of the inner FilesApi with the outer paths. */
  private outerError(error: unknown, route: Route, asked: string): never {
    if (error instanceof BeyondSymlinkError) {
      throw new BeyondSymlinkError(asked, route.outer(error.link));
    }
    throw error;
  }

  async *read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
    const r = this.at(path);
    try {
      yield* r.files.read(r.path, options);
    } catch (error) {
      this.outerError(error, r, path);
    }
  }

  async write(path: string, content: Content): Promise<void> {
    const r = this.at(path);
    await r.files.write(r.path, content).catch((e) => this.outerError(e, r, path));
  }

  async createExclusive(path: string, content: Content): Promise<boolean> {
    const r = this.at(path);
    if (r.files.createExclusive) {
      return r.files.createExclusive(r.path, content).catch((e) => this.outerError(e, r, path));
    }
    if (await r.files.exists(r.path)) return false;
    await r.files.write(r.path, content);
    return true;
  }

  async mkdir(path: string): Promise<void> {
    const r = this.at(path);
    await r.files.mkdir(r.path).catch((e) => this.outerError(e, r, path));
  }

  /** Refuses to remove a mount point or a directory holding one (it would empty a mount). */
  async remove(path: string): Promise<boolean> {
    const r = this.at(path);
    const outer = normalizePath(path);
    const held = this.mounts.find(
      (m) => m.point === outer || outer === "/" || m.point.startsWith(`${outer}/`),
    );
    if (held) throw new Error(`cannot remove ${outer}: ${held.point} is a mount point`);
    return r.files.remove(r.path).catch((e) => this.outerError(e, r, path));
  }

  async stats(path: string): Promise<FileStats | undefined> {
    const r = this.at(path);
    return r.files.stats(r.path).catch((e) => this.outerError(e, r, path));
  }

  /**
   * The entries of the FilesApi holding `path`, with the mount points below it (as
   * directories) and, recursively, what is mounted there, in path order.
   */
  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    const r = this.at(path);
    const outer = normalizePath(path);
    const below = this.mounts.filter(
      (m) => m.point !== outer && (outer === "/" || m.point.startsWith(`${outer}/`)),
    );
    const own = async function* (this: RoutedFilesApi) {
      try {
        for await (const entry of r.files.list(r.path, options)) {
          const p = r.outer(entry.path);
          if (below.some((m) => p === m.point || p.startsWith(`${m.point}/`))) continue;
          yield { ...entry, path: p };
        }
      } catch (error) {
        this.outerError(error, r, path);
      }
    }.call(this);
    if (below.length === 0) {
      yield* own;
      return;
    }
    const recursive = options?.recursive === true;
    const mounted = below
      .filter((m) => recursive || m.point.slice(0, m.point.lastIndexOf("/") || 1) === outer)
      .map((m) =>
        (async function* () {
          const name = m.point.slice(m.point.lastIndexOf("/") + 1);
          yield { name, path: m.point, kind: "directory" as const };
          if (!recursive) return;
          for await (const entry of m.files.list("/", { recursive: true })) {
            yield { ...entry, path: join(m.point, normalizePath(entry.path)) };
          }
        })(),
      );
    type Info =
      Parameters<typeof mergeInPathOrder>[0][number] extends AsyncIterable<infer T> ? T : never;
    for await (const entry of mergeInPathOrder([
      ...(mounted as unknown as AsyncIterable<Info>[]),
      own as unknown as AsyncIterable<Info>,
    ])) {
      if (options?.after !== undefined && entry.path <= options.after) continue;
      yield entry as unknown as FileInfo;
    }
  }

  async exists(path: string): Promise<boolean> {
    const r = this.at(path);
    return r.files.exists(r.path);
  }

  async move(source: string, target: string): Promise<boolean> {
    const from = this.at(source);
    const to = this.at(target);
    if (from.files === to.files) return from.files.move(from.path, to.path);
    // across mounts: a copy, then the source removed (files only)
    if ((await from.files.stats(from.path))?.kind !== "file") return false;
    await to.files.write(to.path, from.files.read(from.path));
    await from.files.remove(from.path);
    return true;
  }

  async copy(source: string, target: string): Promise<boolean> {
    const from = this.at(source);
    const to = this.at(target);
    if (from.files === to.files) return from.files.copy(from.path, to.path);
    if ((await from.files.stats(from.path))?.kind !== "file") return false;
    await to.files.write(to.path, from.files.read(from.path));
    return true;
  }

  async lstat(path: string): Promise<LinkStats | undefined> {
    const r = this.at(path);
    if (r.files.lstat) return r.files.lstat(r.path).catch((e) => this.outerError(e, r, path));
    const stats = await r.files.stats(r.path);
    return (
      stats && { kind: stats.kind, size: stats.size ?? 0, lastModified: stats.lastModified ?? 0 }
    );
  }

  async readlink(path: string): Promise<Uint8Array | undefined> {
    const r = this.at(path);
    return r.files.readlink?.(r.path).catch((e) => this.outerError(e, r, path));
  }

  async symlink(target: Uint8Array, path: string): Promise<void> {
    const r = this.at(path);
    if (!r.files.symlink) throw new Error(`symlink is not supported at ${path}`);
    await r.files.symlink(target, r.path).catch((e) => this.outerError(e, r, path));
  }

  async chmod(path: string, mode: number): Promise<void> {
    const r = this.at(path);
    if (!r.files.chmod) throw new Error(`chmod is not supported at ${path}`);
    await r.files.chmod(r.path, mode).catch((e) => this.outerError(e, r, path));
  }

  async openLinkTarget(path: string): Promise<PosixFilesApi | undefined> {
    if (!this.config.forwardOpenLinkTarget) return undefined;
    const r = this.at(path);
    return r.files.openLinkTarget?.(r.path);
  }
}

/**
 * `base` seen from its directory `root`: `/x` here is `<root>/x` there.
 *
 * @example
 * ```typescript
 * const gitFiles = createSubtreeFilesApi(files, "/repo/.git");
 * await gitFiles.read("/HEAD"); // reads /repo/.git/HEAD of `files`
 * ```
 */
export function createSubtreeFilesApi(
  base: FilesApi,
  root: string,
  options: ComposedFilesApiOptions = {},
): PosixFilesApi {
  if (root.split("/").includes("..")) throw new Error(`'..' in path: ${root}`);
  const prefix = normalizePath(root);
  const posix = base as PosixFilesApi;
  return new RoutedFilesApi({
    route: (path) => ({
      files: posix,
      path: join(prefix, path),
      outer: (inner) => {
        const rest = prefix === "/" ? inner : inner.slice(prefix.length) || "/";
        return normalizePath(rest);
      },
    }),
    separators: posix.pathSeparators,
    refusesBeyondLinks: posix.refusesBeyondLinks,
    forwardOpenLinkTarget: options.forwardOpenLinkTarget,
  });
}

/**
 * `base`, with other FilesApis mounted at some of its paths: a path at or below a mount
 * point is served by the mounted FilesApi (the longest mount point wins), any other by
 * `base`. Moves and copies across mounts copy files (directories are not carried).
 *
 * @example
 * ```typescript
 * const files = createMountedFilesApi(worktreeFiles, { "/.git": repositoryFiles });
 * ```
 */
export function createMountedFilesApi(
  base: FilesApi,
  mounts: Record<string, FilesApi>,
  options: ComposedFilesApiOptions = {},
): PosixFilesApi {
  const points = Object.entries(mounts)
    .map(([point, files]) => {
      if (point.split("/").includes("..")) throw new Error(`'..' in path: ${point}`);
      return [normalizePath(point), files as PosixFilesApi] as const;
    })
    .sort((a, b) => b[0].length - a[0].length);
  return new RoutedFilesApi({
    route: (path) => {
      for (const [point, files] of points) {
        if (path === point || path.startsWith(`${point}/`)) {
          const inner = normalizePath(path.slice(point.length));
          return { files, path: inner, outer: (p) => join(point, normalizePath(p)) };
        }
      }
      return { files: base as PosixFilesApi, path, outer: (p) => p };
    },
    separators: (base as PosixFilesApi).pathSeparators,
    refusesBeyondLinks: [base, ...Object.values(mounts)].every(
      (f) => (f as PosixFilesApi).refusesBeyondLinks,
    ),
    mounts: points.map(([point, files]) => ({ point, files })),
    forwardOpenLinkTarget: options.forwardOpenLinkTarget,
  });
}
