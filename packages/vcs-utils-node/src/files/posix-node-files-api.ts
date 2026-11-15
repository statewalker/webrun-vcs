/**
 * A Node.js FilesApi with the optional POSIX operations of `PosixFilesApi` (`chmod`,
 * `symlink`, `lstat`, `readlink`) that never follows a symbolic link.
 *
 * Every operation — read, write, createExclusive, mkdir, list (recursive too), stats,
 * exists, remove, move, copy and the POSIX ones — resolves its path under `rootDir` (a
 * `..` that would climb out refused, the result checked to stay inside) and refuses a path
 * beneath a symbolic link with `BeyondSymlinkError` (git's `has_symlink_leading_path`), so
 * a link inside the root can never take an operation outside it. A link at the path itself
 * is handled as a link: listed and stat'ed with its own size, read as nothing, replaced by
 * a write (the new file is written next to it and renamed over the link, never into its
 * target), unlinked by remove, and copied or moved as a link. On Windows a `\` in a path
 * is refused, as it would be read as a separator.
 *
 * A link the user made on purpose (a `.git` linked to a repository elsewhere, which git
 * follows) is reached through {@link PosixNodeFilesApi.openLinkTarget}: a FilesApi of its
 * own, rooted at the link's target, which the caller opts into.
 */

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import {
  BeyondSymlinkError,
  type LinkStats,
  type PosixFilesApi,
} from "@statewalker/vcs-utils/files";
import { listInPathOrder } from "@statewalker/webrun-files";
import { NodeFilesApi } from "@statewalker/webrun-files-node";

import { replaceFile, writeBatched } from "./replace-file.js";

/** What `NodeFilesApi` takes and yields (webrun-files' own types). */
type ListOptions = Parameters<NodeFilesApi["list"]>[1];
type FileInfo = ReturnType<NodeFilesApi["list"]> extends AsyncIterable<infer T> ? T : never;
type FileStats = Awaited<ReturnType<NodeFilesApi["stats"]>>;
type ReadOptions = Parameters<NodeFilesApi["read"]>[1];
type Content = Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

/** Temporaries of writes in flight, hidden from `list` (the names `NodeFilesApi` uses). */
const TMP_PREFIX = ".webrun-tmp-";
const TMP_NAME = /^\.webrun-tmp-[0-9a-f]{16}$/;
const tmpName = () =>
  TMP_PREFIX +
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** `open` flags that refuse to follow a symbolic link at the path, where the OS has one. */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
/** `open` flag that never blocks on a FIFO swapped in at the path. */
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

/** Options of {@link PosixNodeFilesApi}. */
export interface PosixNodeFilesApiOptions {
  /** Root directory of every path (default: the current directory) */
  rootDir?: string;
  /**
   * The platform whose path rules apply (default: `process.platform`). On `"win32"` a
   * `\` in a path is refused, since Windows reads it as a separator.
   */
  platform?: NodeJS.Platform;
}

/**
 * A Node.js FilesApi with modes and symbolic links that never follows a link.
 *
 * @example
 * ```typescript
 * const files = new PosixNodeFilesApi({ rootDir: "/path/to/repo" });
 * await files.symlink(new TextEncoder().encode("target.txt"), "/link");
 * (await files.lstat("/link"))?.kind; // "symlink"
 * await files.write("/link/x", [bytes]); // throws BeyondSymlinkError
 * ```
 */
export class PosixNodeFilesApi extends NodeFilesApi implements PosixFilesApi {
  private readonly root: string;
  private readonly windows: boolean;
  /** `"/\\"` on Windows (a `\` splits a name there), else `"/"`. */
  readonly pathSeparators: string;
  /** Every operation refuses a path beneath a link itself (`PosixFilesApi` contract). */
  readonly refusesBeyondLinks = true;
  /**
   * Real directories this instance found (or made) to be directories, not links, so a
   * leading component is checked once rather than on every operation. Forgotten whenever
   * this instance removes or moves anything; a link swapped in behind its back by another
   * process is seen only after that (as git's lstat cache).
   */
  private readonly verified = new Set<string>();

  constructor(options?: PosixNodeFilesApiOptions) {
    super(options);
    this.root = nodePath.resolve(options?.rootDir ?? process.cwd());
    this.windows = (options?.platform ?? process.platform) === "win32";
    this.pathSeparators = this.windows ? "/\\" : "/";
  }

  // ========== Path resolution ==========

  /** The path's components below the root, `..` and (on Windows) `\` refused. */
  private segments(virtualPath: string): string[] {
    const segments = virtualPath.split("/").filter((s) => s !== "" && s !== ".");
    for (const segment of segments) {
      if (segment === "..") throw new Error(`PosixNodeFilesApi: '..' in path: ${virtualPath}`);
      if (this.windows && segment.includes("\\")) {
        throw new Error(`PosixNodeFilesApi: '\\' in path: ${virtualPath}`);
      }
    }
    return segments;
  }

  /** The real path of a virtual one, checked to stay inside the root. */
  private real(virtualPath: string): string {
    const real = nodePath.resolve(this.root, ...this.segments(virtualPath));
    const prefix = this.root.endsWith(nodePath.sep) ? this.root : this.root + nodePath.sep;
    if (real !== this.root && !real.startsWith(prefix)) {
      throw new Error(`PosixNodeFilesApi: path is outside rootDir: ${virtualPath}`);
    }
    return real;
  }

  /**
   * The real path, after checking that no leading component below the root is a symbolic
   * link: `BeyondSymlinkError` if one is. A missing component ends the check.
   */
  private async realNoLinks(virtualPath: string): Promise<string> {
    const segments = this.segments(virtualPath);
    const real = this.real(virtualPath);
    let current = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      current = nodePath.join(current, segments[i]);
      if (this.verified.has(current)) continue;
      const stat = await lstatOrUndefined(current);
      if (!stat) return real;
      if (stat.isSymbolicLink()) {
        throw new BeyondSymlinkError(virtualPath, `/${segments.slice(0, i + 1).join("/")}`);
      }
      if (stat.isDirectory()) this.verified.add(current);
    }
    return real;
  }

  /** Creates `real` and its missing parents below the root, never through a link. */
  private async mkdirs(real: string, virtualPath: string): Promise<void> {
    const relative = nodePath.relative(this.root, real);
    if (relative === "") return;
    let current = this.root;
    for (const part of relative.split(nodePath.sep)) {
      current = nodePath.join(current, part);
      if (this.verified.has(current)) continue;
      let stat = await this.entryStat(current);
      if (!stat) {
        try {
          await fs.mkdir(current);
          this.verified.add(current);
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          stat = await fs.lstat(current);
        }
      }
      if (stat.isSymbolicLink()) {
        throw new BeyondSymlinkError(virtualPath, current.slice(this.root.length) || "/");
      }
      if (!stat.isDirectory()) {
        throw Object.assign(new Error(`ENOTDIR: not a directory: ${virtualPath}`), {
          code: "ENOTDIR",
        });
      }
      this.verified.add(current);
    }
  }

  /** The entry at a real path itself (`lstat`). */
  private async entryStat(real: string): Promise<import("node:fs").Stats | undefined> {
    return lstatOrUndefined(real);
  }

  // ========== FilesApi ==========

  /**
   * A regular file's content; nothing for a link, a directory, a FIFO or a missing path.
   * The file is opened without following a link and without blocking, then checked to be a
   * regular file on the open descriptor (so nothing swapped in after the check is read).
   */
  override async *read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
    const real = await this.realNoLinks(path);
    const stat = await lstatOrUndefined(real);
    if (!stat?.isFile()) return;
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(real, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch {
      return;
    }
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return;
      const size = opened.size;
      const start = options?.start ?? 0;
      const end = Math.min(options?.length !== undefined ? start + options.length : size, size);
      let position = start;
      while (position < end) {
        const buffer = new Uint8Array(Math.min(64 * 1024, end - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        yield buffer.subarray(0, bytesRead);
        position += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }

  /**
   * Writes a new file next to the path and moves it over the path itself, as `NodeFilesApi`
   * does (`replaceFile`: a rename, retried on Windows, copied in place over a mount point or
   * across devices): a link there is replaced, never written through. A regular file it
   * replaces passes on its permission bits; a new file gets the default mode (the umask
   * applies).
   */
  override async write(path: string, content: Content): Promise<void> {
    const real = await this.realNoLinks(path);
    if (real === this.root) {
      throw Object.assign(new Error(`EISDIR: cannot write the root directory: ${path}`), {
        code: "EISDIR",
      });
    }
    await this.mkdirs(nodePath.dirname(real), path);
    const existing = await lstatOrUndefined(real);
    if (existing?.isDirectory()) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory: ${path}`), {
        code: "EISDIR",
      });
    }
    const tmp = nodePath.join(nodePath.dirname(real), tmpName());
    const handle = await fs.open(tmp, "wx", 0o666);
    let done = false;
    try {
      // a regular file keeps its permission bits (as NodeFilesApi); a link is replaced
      // by a new file of the default mode
      if (existing?.isFile()) await handle.chmod(existing.mode & 0o777);
      await writeBatched(handle, content);
      await handle.close();
      await replaceFile(tmp, real, { platform: this.windows ? "win32" : "linux" });
      done = true;
    } finally {
      if (!done) {
        await handle.close().catch(() => {});
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
    }
  }

  /** `open(path, "wx")`: false when anything (a dangling link too) is at the path. */
  override async createExclusive(path: string, content: Content): Promise<boolean> {
    const real = await this.realNoLinks(path);
    if (real === this.root) return false;
    await this.mkdirs(nodePath.dirname(real), path);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(real, "wx", 0o666);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    let done = false;
    try {
      await writeBatched(handle, content);
      await handle.close();
      done = true;
      return true;
    } finally {
      if (!done) {
        await handle.close().catch(() => {});
        await fs.unlink(real).catch(() => {});
      }
    }
  }

  override async mkdir(path: string): Promise<void> {
    const real = await this.realNoLinks(path);
    await this.mkdirs(real, path);
  }

  /**
   * Entries in path order, a symbolic link listed as a file of its own size (its target's
   * length), a dangling one included; a linked directory is never descended into.
   */
  override async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    const dir = await this.realNoLinks(path);
    // a link is not a directory here: listing it would follow it
    if ((await this.entryStat(dir))?.isSymbolicLink()) return;
    const base = `/${this.segments(path).join("/")}`;
    // streamed in path order, one directory read at a time (webrun-files' listInPathOrder)
    yield* listInPathOrder(base, (virtualDir) => this.children(virtualDir), options);
  }

  /** A directory's direct entries, read without following links. */
  private async children(virtualDir: string): Promise<FileInfo[]> {
    const dir = nodePath.resolve(this.root, ...this.segments(virtualDir));
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const prefix = virtualDir === "/" ? "" : virtualDir;
    const infos: FileInfo[] = [];
    for (const entry of entries) {
      if (entry.isFile() && TMP_NAME.test(entry.name)) continue;
      const entryPath = `${prefix}/${entry.name}`;
      // Dirent reports the entry itself: a link to a directory is not a directory
      if (entry.isDirectory()) {
        this.verified.add(nodePath.join(dir, entry.name));
        infos.push({ name: entry.name, path: entryPath, kind: "directory" });
        continue;
      }
      const stat = await lstatOrUndefined(nodePath.join(dir, entry.name));
      if (!stat) continue;
      infos.push({
        name: entry.name,
        path: entryPath,
        kind: "file",
        size: stat.size,
        lastModified: stat.mtimeMs,
      });
    }
    return infos;
  }

  /** The entry itself: a symbolic link is a file of its own size. */
  override async stats(path: string): Promise<FileStats> {
    const stat = await this.entryStat(await this.realNoLinks(path));
    if (!stat) return undefined;
    if (stat.isDirectory()) return { kind: "directory" };
    return { kind: "file", size: stat.size, lastModified: stat.mtimeMs };
  }

  /** Whether anything (a dangling link too) is at the path; false beneath a link. */
  override async exists(path: string): Promise<boolean> {
    try {
      return (await this.entryStat(await this.realNoLinks(path))) !== undefined;
    } catch {
      return false;
    }
  }

  /** A link is unlinked (a dangling one too), a directory removed with what is in it. */
  override async remove(path: string): Promise<boolean> {
    const real = await this.realNoLinks(path);
    this.verified.clear();
    const stat = await lstatOrUndefined(real);
    if (!stat) return false;
    if (stat.isDirectory()) await fs.rm(real, { recursive: true, force: true });
    else await fs.unlink(real);
    return true;
  }

  /** `rename(2)` of the entry itself (a link moves as a link). */
  override async move(source: string, target: string): Promise<boolean> {
    const from = await this.realNoLinks(source);
    const to = await this.realNoLinks(target);
    if (!(await lstatOrUndefined(from))) return false;
    this.verified.clear();
    try {
      await this.mkdirs(nodePath.dirname(to), target);
      await fs.rename(from, to);
      return true;
    } catch (error) {
      if (error instanceof BeyondSymlinkError) throw error;
      return false;
    }
  }

  /** A copy in which symbolic links stay links (never their targets' contents). */
  override async copy(source: string, target: string): Promise<boolean> {
    const from = await this.realNoLinks(source);
    const to = await this.realNoLinks(target);
    if (!(await lstatOrUndefined(from))) return false;
    try {
      await this.mkdirs(nodePath.dirname(to), target);
      await fs.cp(from, to, { recursive: true, verbatimSymlinks: true, dereference: false });
      return true;
    } catch (error) {
      if (error instanceof BeyondSymlinkError) throw error;
      return false;
    }
  }

  // ========== PosixFilesApi ==========

  /**
   * Sets the permission bits (`mode & 0o777`: never setuid, setgid or sticky) on a
   * descriptor opened without following a link, so a link swapped in is never chmod'ed
   * through.
   */
  async chmod(path: string, mode: number): Promise<void> {
    const real = await this.realNoLinks(path);
    if ((await fs.lstat(real)).isSymbolicLink()) {
      throw new Error(`PosixNodeFilesApi: will not chmod through a symbolic link: ${path}`);
    }
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(real, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error(`PosixNodeFilesApi: will not chmod through a symbolic link: ${path}`);
      }
      throw error;
    }
    try {
      await handle.chmod(mode & 0o777);
    } finally {
      await handle.close();
    }
  }

  /**
   * A FilesApi rooted at the directory the symbolic link at `path` points to, wherever it
   * is (outside this root too), or undefined when `path` is no link to a directory. For a
   * link the user chose to follow (a `.git` linked elsewhere, as git follows it); leading
   * components of `path` are still never followed.
   */
  async openLinkTarget(path: string): Promise<PosixNodeFilesApi | undefined> {
    const real = await this.realNoLinks(path);
    if (!(await lstatOrUndefined(real))?.isSymbolicLink()) return undefined;
    let target: string;
    try {
      target = await fs.realpath(real);
      if (!(await fs.stat(target)).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
    return new PosixNodeFilesApi({ rootDir: target, platform: this.windows ? "win32" : "linux" });
  }

  async symlink(target: Uint8Array, path: string): Promise<void> {
    const real = await this.realNoLinks(path);
    await this.mkdirs(nodePath.dirname(real), path);
    await fs.symlink(Buffer.from(target), real);
  }

  /** The entry itself; `BeyondSymlinkError` beneath a link, never "absent". */
  async lstat(path: string): Promise<LinkStats | undefined> {
    const stat = await this.entryStat(await this.realNoLinks(path));
    if (!stat) return undefined;
    const kind = stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : "other";
    return {
      kind,
      size: kind === "directory" ? 0 : stat.size,
      lastModified: stat.mtimeMs,
      ctime: stat.ctimeMs,
      mode: stat.mode & 0o7777,
    };
  }

  async readlink(path: string): Promise<Uint8Array | undefined> {
    const real = await this.realNoLinks(path);
    try {
      return new Uint8Array(await fs.readlink(real, { encoding: "buffer" }));
    } catch {
      return undefined;
    }
  }
}

async function lstatOrUndefined(real: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fs.lstat(real);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}
