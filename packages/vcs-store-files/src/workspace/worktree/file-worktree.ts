/**
 * File-based Worktree implementation
 *
 * Implements the new Worktree interface using FilesApi.
 * Extends FileTreeIterator's read capabilities with:
 * - Write operations (writeContent, remove, mkdir, rename)
 * - Checkout operations (checkoutTree, checkoutPaths)
 *
 * This is the primary Worktree implementation for file-based repositories.
 *
 * Over a FilesApi with `lstat` (a local filesystem, `createNodeFilesApi`), the worktree
 * never follows a symbolic link, as git does: a symbolic link is listed, hashed and read
 * as a link (mode 120000, its target as content), a write or remove beneath a link is
 * refused (git's `has_symlink_leading_path`), and a link at the path written is
 * unlinked, not written through.
 */

import type { Blobs, ObjectId, Trees } from "@statewalker/vcs-core";
import {
  assertValidWorktreePath,
  basename,
  type FileInfo,
  FileMode,
  isBeyondSymlinkError,
  joinPath,
  type LinkStats,
  normalizePath,
  type PosixFilesApi,
  readFile,
} from "@statewalker/vcs-core";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { collect } from "@statewalker/vcs-utils/streams";
import type {
  IgnoreManager,
  NewHasher,
  Worktree,
  WorktreeCapabilities,
  WorktreeCheckoutOptions,
  WorktreeCheckoutResult,
  WorktreeEntry,
  WorktreeRemoveOptions,
  WorktreeWalkOptions,
  WorktreeWriteOptions,
} from "@statewalker/vcs-working-tree";
import {
  createIgnoreManager,
  hashWorktreeFile,
  MemoryCheckout,
  MemoryWorkingCopy,
  type WorkingCopy,
} from "@statewalker/vcs-working-tree";
import { createGitFilesBackend } from "../../create-git-files-backend.js";
import { FileStagingStore } from "../staging/index.js";
import { createWorkingCopyConfig } from "../working-copy/index.js";
import { type CaseFolding, probeCaseFolding } from "./probe-case-folding.js";

/**
 * The FilesApi a FileWorktree works over: a FilesApi, with the optional `chmod`,
 * `symlink`, `lstat` and `readlink` of `PosixFilesApi`. Without them (browsers, object
 * stores) executables are written as plain files and symlinks as files holding the link
 * target, as git does with `core.filemode` / `core.symlinks` false.
 */
export type WorktreeFilesApi = PosixFilesApi;

/**
 * Options for creating a FileWorktree
 */
export interface FileWorktreeOptions {
  /** FilesApi for filesystem operations */
  files: WorktreeFilesApi;
  /** Root path of the worktree */
  rootPath: string;
  /** Blobs interface for content access (needed for checkout) */
  blobs: Blobs;
  /** Trees interface for tree access (needed for checkout) */
  trees: Trees;
  /** Pre-configured IgnoreManager */
  ignoreManager?: IgnoreManager;
  /** Auto-load .gitignore files (default: true) */
  autoLoadGitignore?: boolean;
  /** Path to .git directory */
  gitDir?: string;
  /** Path to global excludes file */
  globalExcludesFile?: string;
  /**
   * Makes the incremental hasher `computeHash` streams a file through
   * (default: SHA-1, `createSha1`).
   */
  newHasher?: NewHasher;
}

/**
 * File-based Worktree implementation
 */
export class FileWorktree implements Worktree {
  private readonly rootFiles: WorktreeFilesApi;
  /** The FilesApi of the batch in progress (`withLstatCache` view), if any */
  private scoped?: WorktreeFilesApi;
  /**
   * The ignore sources read during the batch in progress (directories, and `<excludes>`):
   * read once per batch; outside a batch every walk and ignore check reads its own.
   */
  private batchIgnores?: Set<string>;
  private readonly rootPath: string;
  private readonly blobs: Blobs;
  private readonly trees: Trees;
  private readonly ignoreManager: IgnoreManager;
  private readonly autoLoadGitignore: boolean;
  private readonly gitDir?: string;
  private readonly globalExcludesFile?: string;
  private readonly newHasher: NewHasher;
  private repositoryExcludesLoaded = false;

  constructor(options: FileWorktreeOptions) {
    this.rootFiles = options.files;
    this.rootPath = options.rootPath;
    this.blobs = options.blobs;
    this.trees = options.trees;
    this.ignoreManager = options.ignoreManager ?? createIgnoreManager();
    this.autoLoadGitignore = options.autoLoadGitignore ?? true;
    this.gitDir = options.gitDir;
    this.globalExcludesFile = options.globalExcludesFile;
    this.newHasher = options.newHasher ?? createSha1;
  }

  /**
   * Executables where the FilesApi can chmod and lstat (to read the bit back), symlinks
   * where it can make, lstat and read links (so they are never followed).
   */
  get capabilities(): WorktreeCapabilities {
    const files = this.files;
    return {
      executable: !!(files.chmod && files.lstat),
      symlinks: !!(files.symlink && files.lstat && files.readlink),
      windowsPaths: this.windowsPaths,
      // reserved names of the storage's root apply only to a worktree rooted there
      ...(this.rootFiles.reservedNames && normalizePath(this.rootPath) === "/"
        ? { reservedNames: this.rootFiles.reservedNames }
        : {}),
    };
  }

  /** The FilesApi reads `\` as a separator (Windows): git's Windows path rules apply. */
  private get windowsPaths(): boolean {
    return this.files.pathSeparators?.includes("\\") ?? false;
  }

  /** The path rules of this worktree's platform (verify_path). */
  private get pathRules(): { windows: boolean } {
    return { windows: this.windowsPaths };
  }

  /** git init's case and Unicode folding probe, under the repository's `gitDir`. */
  async probeCaseFolding(): Promise<CaseFolding> {
    if (this.gitDir === undefined) return { ignoreCase: false, precomposeUnicode: false };
    return probeCaseFolding(this.files, this.gitDir);
  }

  /** The FilesApi operations go through: the batch view while a batch runs. */
  private get files(): WorktreeFilesApi {
    return this.scoped ?? this.rootFiles;
  }

  /**
   * Runs `fn` as one batch: over a FilesApi with `withLstatCache`, its operations share a
   * cache of directories verified not to be links, dropped when the batch ends (git's
   * per-command lstat cache), and the ignore rules are read once for the whole batch.
   * Nested batches join the outer one.
   */
  async batch<T>(fn: () => Promise<T>): Promise<T> {
    if (this.batchIgnores) return fn();
    this.batchIgnores = new Set();
    if (this.rootFiles.withLstatCache) this.scoped = this.rootFiles.withLstatCache();
    try {
      return await fn();
    } finally {
      this.scoped = undefined;
      this.batchIgnores = undefined;
    }
  }

  /**
   * Reads, once per operation (`loaded`), the ignore rules that apply to `path`: the exclude
   * files and the `.gitignore` of every directory from the root down to `path`'s parent
   * (its own too when `inclusive`). No rule read by an earlier operation is relied on.
   */
  private async loadIgnoresFor(
    path: string,
    loaded: Set<string>,
    files = this.files,
    inclusive = false,
  ): Promise<void> {
    if (!loaded.has("<excludes>")) {
      loaded.add("<excludes>");
      await this.loadRepositoryExcludes();
    }
    if (!this.autoLoadGitignore) return;
    const parts = path ? path.split("/") : [];
    const last = inclusive ? parts.length : parts.length - 1;
    for (let i = 0; i <= last; i++) {
      const dir = parts.slice(0, i).join("/");
      if (loaded.has(dir)) continue;
      loaded.add(dir);
      await this.tryLoadGitignore(dir ? joinPath(this.rootPath, dir) : this.rootPath, dir, files);
    }
  }

  // ========== Reading ==========

  async *walk(options?: WorktreeWalkOptions): AsyncIterable<WorktreeEntry> {
    const includeIgnored = options?.includeIgnored ?? false;
    const includeDirectories = options?.includeDirectories ?? false;
    const pathPrefix = options?.pathPrefix ?? "";
    // the rules of this walk: read now (the prefix's ancestors included), or once per batch
    const loaded = this.batchIgnores ?? new Set<string>();

    if (options?.ignorePatterns?.length) {
      this.ignoreManager.addGlobalPatterns(options.ignorePatterns);
    }

    const startPath = pathPrefix ? joinPath(this.rootPath, pathPrefix) : this.rootPath;
    // one walk is one batch: its lstat-caching view stays local to this walk (an abandoned
    // iterator leaves nothing behind for other operations)
    const files = this.scoped ?? this.rootFiles.withLstatCache?.() ?? this.rootFiles;
    await this.loadIgnoresFor(pathPrefix, loaded, files);
    yield* this.walkDirectory(
      loaded,
      files,
      startPath,
      pathPrefix,
      includeIgnored,
      includeDirectories,
      options?.maxDepth,
      0,
      {
        enterNonRepositoryGitDirs: options?.enterNonRepositoryGitDirs === true,
        onUnreadable: options?.onUnreadable,
      },
    );
  }

  private async *walkDirectory(
    loaded: Set<string>,
    files: WorktreeFilesApi,
    dirPath: string,
    relativePath: string,
    includeIgnored: boolean,
    includeDirectories: boolean,
    maxDepth?: number,
    currentDepth = 0,
    extra: { enterNonRepositoryGitDirs: boolean; onUnreadable?: (path: string) => void } = {
      enterNonRepositoryGitDirs: false,
    },
  ): AsyncIterable<WorktreeEntry> {
    if (maxDepth !== undefined && currentDepth > maxDepth) {
      return;
    }

    if (this.autoLoadGitignore && !loaded.has(relativePath)) {
      loaded.add(relativePath);
      await this.tryLoadGitignore(dirPath, relativePath, files);
    }

    const entries: FileInfo[] = [];
    try {
      for await (const entry of files.list(dirPath)) {
        entries.push(entry);
      }
    } catch {
      // unreadable: its content is unknown (reported, so nothing is removed on a guess)
      extra.onUnreadable?.(relativePath);
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const fullPath = joinPath(dirPath, entry.name);

      if (entry.name === ".git") {
        // the worktree's own repository, or a nested one: never listed; a `.git` in a
        // directory that holds no repository is listed on request (git clean removes it)
        if (!extra.enterNonRepositoryGitDirs || relativePath === "") continue;
        if (await this.isRepository(relativePath)) continue;
      }

      // the entry itself: a symbolic link is a file of its own, never descended into
      const link = await files.lstat?.(fullPath);
      // a FIFO, socket or device is not content git tracks (git skips it too)
      if (link?.kind === "other") continue;
      const isDirectory = link ? link.kind === "directory" : entry.kind === "directory";

      const isIgnored = this.ignoreManager.isIgnored(entryPath, isDirectory);

      if (isIgnored && !includeIgnored) {
        continue;
      }

      let hasGitDir = false;
      if (isDirectory) {
        hasGitDir = await this.hasGitDirectory(fullPath, files);
      }

      const stats = link
        ? { size: isDirectory ? 0 : link.size, mtime: isDirectory ? 0 : link.lastModified }
        : await this.getFileStats(fullPath, isDirectory, files);

      const worktreeEntry: WorktreeEntry = {
        path: entryPath,
        name: entry.name,
        mode: link
          ? this.modeOf(link, hasGitDir)
          : this.getFileMode({ kind: isDirectory ? "directory" : "file" }, hasGitDir),
        size: stats.size,
        mtime: stats.mtime,
        ...(link && !isDirectory ? statData(link) : {}),
        isDirectory,
        isIgnored,
      };

      if (isDirectory && includeDirectories) {
        yield worktreeEntry;
      }

      if (!isDirectory) {
        yield worktreeEntry;
      }

      const enter =
        !hasGitDir || (extra.enterNonRepositoryGitDirs && !(await this.isRepository(entryPath)));
      if (isDirectory && enter) {
        yield* this.walkDirectory(
          loaded,
          files,
          fullPath,
          entryPath,
          includeIgnored,
          includeDirectories,
          maxDepth,
          currentDepth + 1,
          extra,
        );
      }
    }
  }

  async getEntry(path: string): Promise<WorktreeEntry | undefined> {
    const fullPath = joinPath(this.rootPath, path);

    if (this.files.lstat) {
      // beneath a symbolic link a path is absent, as git's lstat cache has it; a FIFO,
      // socket or device is no content either
      const link = await this.files.lstat(fullPath).catch((error: unknown) => {
        if (isBeyondSymlinkError(error)) return undefined;
        throw error;
      });
      if (!link || link.kind === "other") return undefined;
      const isDirectory = link.kind === "directory";
      const hasGitDir = isDirectory && (await this.hasGitDirectory(fullPath));
      return {
        path,
        name: basename(path),
        mode: this.modeOf(link, hasGitDir),
        size: isDirectory ? 0 : link.size,
        mtime: isDirectory ? 0 : link.lastModified,
        ...(!isDirectory ? statData(link) : {}),
        isDirectory,
        isIgnored: this.ignoreManager.isIgnored(path, isDirectory),
      };
    }

    try {
      const stats = await this.files.stats(fullPath);
      if (!stats) {
        return undefined;
      }

      let isDirectory = false;
      try {
        for await (const _ of this.files.list(fullPath)) {
          isDirectory = true;
          break;
        }
      } catch {
        // Not a directory
      }

      const isIgnored = this.ignoreManager.isIgnored(path, isDirectory);

      let hasGitDir = false;
      if (isDirectory) {
        hasGitDir = await this.hasGitDirectory(fullPath);
      }

      const mode = this.getFileMode({ kind: isDirectory ? "directory" : "file" }, hasGitDir);

      return {
        path,
        name: basename(path),
        mode,
        size: stats.size ?? 0,
        mtime: stats.lastModified ?? 0,
        isDirectory,
        isIgnored,
      };
    } catch {
      return undefined;
    }
  }

  async computeHash(path: string): Promise<ObjectId> {
    if (!this.files.refusesBeyondLinks) await this.checkLeadingPath(path);
    const fullPath = joinPath(this.rootPath, path);
    const target = await this.linkTarget(fullPath);
    if (target) {
      // a symbolic link hashes as its target, as git stores it (never the file it names)
      return hashWorktreeFile(
        path,
        { size: async () => target.length, read: () => [target] },
        this.newHasher,
      );
    }
    return hashWorktreeFile(
      path,
      {
        size: async () => {
          const stats = await this.files.stats(fullPath);
          if (stats?.kind === "directory") throw new Error(`Is a directory: ${path}`);
          return stats?.kind === "file" ? stats.size : undefined;
        },
        read: () => this.files.read(fullPath),
      },
      this.newHasher,
    );
  }

  async *readContent(path: string): AsyncIterable<Uint8Array> {
    // never a file beneath a link: that would read wherever the link points (a FilesApi
    // that refuses such paths itself is not asked twice)
    if (!this.files.refusesBeyondLinks) await this.checkLeadingPath(path);
    const fullPath = joinPath(this.rootPath, path);
    const target = await this.linkTarget(fullPath);
    if (target) {
      yield target;
      return;
    }
    yield* this.files.read(fullPath);
  }

  async exists(path: string): Promise<boolean> {
    const fullPath = joinPath(this.rootPath, path);
    try {
      if (this.files.lstat) {
        return (await this.files.lstat(fullPath).catch(() => undefined)) !== undefined;
      }
      return await this.files.exists(fullPath);
    } catch {
      return false;
    }
  }

  async isIgnored(path: string): Promise<boolean> {
    // the .gitignore files of the path's directories and the exclude files, read for this
    // check (once per batch), never through a link
    await this.loadIgnoresFor(path, this.batchIgnores ?? new Set<string>());

    // Check if it's a directory
    let isDir = false;
    try {
      const fullPath = joinPath(this.rootPath, path);
      for await (const _ of this.files.list(fullPath)) {
        isDir = true;
        break;
      }
    } catch {
      // Not a directory
    }

    return this.ignoreManager.isIgnored(path, isDir);
  }

  // ========== Writing ==========

  async writeContent(
    path: string,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array,
    options?: WorktreeWriteOptions,
  ): Promise<void> {
    assertValidWorktreePath(path, options?.mode, this.pathRules);
    if (!this.files.refusesBeyondLinks || options?.replaceInTheWay) {
      await this.checkLeadingPath(path, options?.replaceInTheWay === true);
    }
    const fullPath = joinPath(this.rootPath, path);
    const existing = await this.kindOf(fullPath);

    // Check if file exists and overwrite is false
    if (options?.overwrite === false && existing) {
      throw new Error(`File already exists: ${path}`);
    }
    // a directory in the way is removed only by a forced checkout (`reset --hard`), as git
    // removes untracked directories where a file must go; never otherwise
    if (existing === "directory" && options?.replaceInTheWay) {
      await this.files.remove(fullPath);
      if (await this.kindOf(fullPath)) throw new Error(`Cannot replace directory ${path}`);
    } else if (existing === "directory") {
      throw new Error(`Cannot write ${path}: a directory is in the way`);
    }
    const asLink = options?.mode === FileMode.SYMLINK && !!this.files.symlink;
    // a link at the path is replaced, never written through; a file makes way for a link
    if (existing === "symlink" || (existing && asLink)) {
      await this.files.remove(fullPath);
      if (await this.kindOf(fullPath)) throw new Error(`Cannot replace ${path}`);
    }

    // Create parent directories if needed
    if (options?.createParents !== false) {
      const parentPath = this.getParentPath(fullPath);
      if (parentPath) {
        try {
          await this.files.mkdir(parentPath);
        } catch {
          // Directory may already exist
        }
      }
    }

    // Convert content to iterable if it's a Uint8Array
    const iterable = content instanceof Uint8Array ? [content] : content;

    // A symlink's content is its target: a link where the FilesApi makes one,
    // else a plain file holding the target (git with core.symlinks=false)
    if (asLink && this.files.symlink) {
      // the target as bytes, as the tree holds it (not necessarily UTF-8)
      await this.files.symlink(await collect(iterable), fullPath);
      return;
    }

    // Write content
    await this.files.write(fullPath, iterable);

    // The executable bit, as git sets it: from the file's own mode (the umask kept), x
    // added where r is set, or taken away for a regular file
    const mode = options?.mode;
    if ((mode === FileMode.REGULAR_FILE || mode === FileMode.EXECUTABLE_FILE) && this.files.chmod) {
      const current = (await this.files.lstat?.(fullPath))?.mode;
      if (current !== undefined) {
        const wanted =
          mode === FileMode.EXECUTABLE_FILE ? current | ((current & 0o444) >> 2) : current & ~0o111;
        if (wanted !== current) await this.files.chmod(fullPath, wanted);
      }
    }
  }

  /**
   * Removes a file, or a symbolic link itself (never what it points to, a dangling one
   * included). A directory is removed only with `recursive`; without it, it is left in
   * place and `false` returned.
   */
  async remove(path: string, options?: WorktreeRemoveOptions): Promise<boolean> {
    await this.assertRemovablePath(path, options?.nonRepositoryGitDirs === true);
    // beneath a link or a file the path is absent (git's has_symlink_or_noent_leading_path)
    if (!this.files.refusesBeyondLinks && (await this.hasLinkOrFileLeading(path))) return false;
    const fullPath = joinPath(this.rootPath, path);
    const kind = await this.kindOf(fullPath).catch((error: unknown) => {
      if (isBeyondSymlinkError(error)) return undefined;
      throw error;
    });
    if (!kind) return false;
    if (kind === "directory" && !options?.recursive) return false;
    return this.files.remove(fullPath);
  }

  /**
   * Removes the directory at `path` only if its listing is empty (git's `rmdir`): a
   * directory holding anything, a nested repository's `.git` or a FIFO included, stays.
   * Never follows a link: a link (or anything else) at `path` is not removed.
   */
  async removeEmptyDirectory(
    path: string,
    options?: Pick<WorktreeRemoveOptions, "nonRepositoryGitDirs">,
  ): Promise<boolean> {
    await this.assertRemovablePath(path, options?.nonRepositoryGitDirs === true);
    if (!this.files.refusesBeyondLinks && (await this.hasLinkOrFileLeading(path))) return false;
    const fullPath = joinPath(this.rootPath, path);
    const kind = await this.kindOf(fullPath).catch((error: unknown) => {
      if (isBeyondSymlinkError(error)) return undefined;
      throw error;
    });
    if (kind !== "directory") return false;
    // rmdir(2) where the FilesApi has it: a file created meanwhile makes it fail
    if (this.files.rmdir) return this.files.rmdir(fullPath);
    for await (const _ of this.files.list(fullPath)) return false;
    return this.files.remove(fullPath);
  }

  /**
   * Refuses a path git's `verify_path` refuses, except (on request) `.git` components that
   * name no repository: each must be exactly `.git` in a directory {@link isRepository}
   * finds no repository in (anything it cannot check counts as one).
   */
  private async assertRemovablePath(path: string, nonRepositoryGitDirs: boolean): Promise<void> {
    if (!nonRepositoryGitDirs || !path.split("/").includes(".git")) {
      assertValidWorktreePath(path, undefined, this.pathRules);
      return;
    }
    const parts = path.split("/");
    const checked: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === ".git") {
        const dir = parts.slice(0, i).join("/");
        if (i === 0 || (await this.isRepository(dir))) {
          throw new Error(`Invalid worktree path: ${JSON.stringify(path)}`);
        }
        checked.push("_");
      } else checked.push(parts[i]);
    }
    assertValidWorktreePath(checked.join("/"), undefined, this.pathRules);
  }

  /**
   * The path in this FilesApi a gitfile's `gitdir:` names: relative to the gitlink's
   * directory (`../.git/modules/sub`, as git submodule writes it), or absolute (older git,
   * `--separate-git-dir`) when it lies inside the real directory this FilesApi is rooted at
   * (`rootDirectory`). Undefined when it lies beyond what this FilesApi can name: outside
   * its root, or absolute where the root's real directory is unknown.
   */
  private gitfileTarget(path: string, target: string): string | undefined {
    const windows = this.windowsPaths;
    const absolute = target.startsWith("/") || (windows && /^[A-Za-z]:[\\/]/.test(target));
    if (!absolute) return resolveDots(joinPath(this.rootPath, path, target));
    const root = this.rootFiles.rootDirectory;
    if (!root) return undefined;
    const slashes = (p: string) => (windows ? p.replace(/\\/g, "/") : p);
    const realTarget = resolveDots(slashes(target));
    const realRoot = resolveDots(slashes(root));
    if (realTarget === undefined || realRoot === undefined) return undefined;
    const same = (a: string, b: string) =>
      windows ? a.toLowerCase() === b.toLowerCase() : a === b;
    const base = realRoot.endsWith("/") ? realRoot.slice(0, -1) : realRoot;
    if (same(realTarget, base)) return "/";
    if (!same(realTarget.slice(0, base.length + 1), `${base}/`)) return undefined;
    return realTarget.slice(base.length);
  }

  /** The `gitdir:` a `.git` file names, if it is a regular file starting so. */
  private async readGitfile(dotGit: string): Promise<string | undefined> {
    // a regular file only: never a link, and never a FIFO (reading one would block)
    if (this.files.lstat) {
      if ((await this.files.lstat(dotGit))?.kind !== "file") return undefined;
    } else if ((await this.files.stats(dotGit))?.kind !== "file") return undefined;
    return new TextDecoder()
      .decode(await readFile(this.files, dotGit))
      .trim()
      .match(/^gitdir: (.+)$/)?.[1];
  }

  async isRepository(path: string): Promise<boolean> {
    const dotGit = joinPath(this.rootPath, path, ".git");
    const kind = await this.kindOrError(dotGit);
    if (kind === "file") {
      // a gitdir: file names a repository when its target is one; a target beyond this
      // FilesApi's root cannot be checked here and is taken as one, so nothing is removed
      // on a guess
      let target: string | undefined;
      try {
        target = await this.readGitfile(dotGit);
      } catch {
        return true;
      }
      if (!target) return false;
      const resolved = this.gitfileTarget(path, target);
      if (resolved === undefined) return true;
      // any HEAD (a file, or a link as core.preferSymlinkRefs writes it) makes it one,
      // as git's validate_headref; only a target confirmed to have no HEAD is not. One that
      // cannot be checked (reached through a link, unreadable) is taken as one, so nothing
      // is removed on a guess
      return (await this.kindOrError(joinPath(resolved, "HEAD"))) !== undefined;
    }
    // a `.git` link (to a repository elsewhere, which git follows): kept, unless it is
    // certainly dangling (its target, inside this FilesApi, confirmed absent)
    if (kind === "symlink") return !(await this.isDanglingLink(dotGit, path));
    if (kind === "error") return true;
    if (kind !== "directory") return false;
    const kindAt = (name: string) => this.kindOrError(joinPath(dotGit, name));
    // git's is_git_directory: a HEAD (file or link), objects and refs (directories, or links
    // to them); anything that might be a repository (or cannot be checked) is kept rather
    // than removed
    const dirLike = (k: string | undefined) =>
      k === "directory" || k === "symlink" || k === "error";
    return (
      (await kindAt("HEAD")) !== undefined &&
      dirLike(await kindAt("objects")) &&
      dirLike(await kindAt("refs"))
    );
  }

  /**
   * The repository directory of the gitlink at `path` (in this FilesApi): its `.git`
   * directory, or the directory its `gitdir:` file names. Undefined when the submodule is
   * not populated or its repository lies beyond this FilesApi's root; a gitfile naming a
   * place without a HEAD is git's fatal error.
   */
  private async gitlinkDir(path: string): Promise<string | undefined> {
    const dotGit = joinPath(this.rootPath, path, ".git");
    const kind = await this.kindOf(dotGit).catch(() => undefined);
    if (kind === "directory") return dotGit;
    if (kind !== "file") return undefined;
    const target = await this.readGitfile(dotGit).catch(() => undefined);
    if (!target) return undefined;
    // refused when it climbs above the FilesApi's root or lies outside it
    const resolved = this.gitfileTarget(path, target);
    if (resolved === undefined) return undefined;
    const head = await this.kindOrError(joinPath(resolved, "HEAD"));
    // confirmed absent: git's fatal error; reached through a link, unreadable or not a
    // regular file: the submodule cannot be read here (no change reported)
    if (head === undefined) {
      throw new Error(`fatal: gitfile does not point to a valid repository: ${path}/.git`);
    }
    return head === "file" ? resolved : undefined;
  }

  async readGitlinkHead(path: string): Promise<ObjectId | undefined> {
    const text = async (full: string) => {
      try {
        // a regular file only: never a link, and never a FIFO (reading one would block)
        if (this.files.lstat) {
          if ((await this.files.lstat(full))?.kind !== "file") return undefined;
        } else if ((await this.files.stats(full))?.kind !== "file") return undefined;
        return new TextDecoder().decode(await readFile(this.files, full)).trim();
      } catch {
        return undefined;
      }
    };
    const gitDir = await this.gitlinkDir(path);
    if (gitDir === undefined) return undefined;
    let head = await text(joinPath(gitDir, "HEAD"));
    for (let depth = 0; head?.startsWith("ref: ") && depth < 5; depth++) {
      const ref = head.slice(5).trim();
      const loose = await text(joinPath(gitDir, ref));
      if (loose) {
        head = loose;
        continue;
      }
      const packed = await text(joinPath(gitDir, "packed-refs"));
      const line = packed?.split("\n").find((l) => l.endsWith(` ${ref}`));
      head = line?.split(" ")[0];
    }
    return head && /^[0-9a-f]{40,64}$/.test(head) ? head : undefined;
  }

  /**
   * The repository checked out at the gitlink `path` (a populated submodule) as a working
   * copy over the same FilesApi: its objects, refs, index, config and worktree. Undefined
   * when it is not populated (no git directory with HEAD, objects and refs) or its
   * repository lies beyond this FilesApi's root.
   */
  async openGitlink(path: string): Promise<WorkingCopy | undefined> {
    const gitDir = await this.gitlinkDir(path);
    if (gitDir === undefined) return undefined;
    const kindAt = (name: string) => this.kindOf(joinPath(gitDir, name)).catch(() => undefined);
    // a HEAD that is a file (or a link, core.preferSymlinkRefs): never a FIFO, which
    // would block the read
    const headKind = await kindAt("HEAD");
    if (
      (headKind !== "file" && headKind !== "symlink") ||
      (await kindAt("objects")) !== "directory" ||
      (await kindAt("refs")) !== "directory"
    ) {
      return undefined;
    }
    const files = this.rootFiles;
    const { history } = await createGitFilesBackend({ files, gitDir });
    const staging = new FileStagingStore(files, joinPath(gitDir, "index"));
    await staging.read();
    const config = await createWorkingCopyConfig(
      {
        read: async (p) => ((await files.exists(p)) ? readFile(files, p) : undefined),
        write: (p, content) => files.write(p, [content]),
      },
      gitDir,
    );
    const worktree = new FileWorktree({
      files,
      rootPath: joinPath(this.rootPath, path),
      gitDir,
      blobs: history.blobs,
      trees: history.trees,
      newHasher: this.newHasher,
    });
    return new MemoryWorkingCopy({
      history,
      checkout: new MemoryCheckout({ staging }),
      worktree,
      config,
    });
  }

  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    assertValidWorktreePath(path, undefined, this.pathRules);
    if (!this.files.refusesBeyondLinks) await this.checkLeadingPath(path);
    const fullPath = joinPath(this.rootPath, path);
    const kind = await this.kindOf(fullPath);
    if (kind === "directory") return;
    if (kind) throw new Error(`Cannot create directory ${path}: a ${kind} is in the way`);
    await this.files.mkdir(fullPath);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    assertValidWorktreePath(oldPath, undefined, this.pathRules);
    assertValidWorktreePath(newPath, undefined, this.pathRules);
    if (!this.files.refusesBeyondLinks) {
      await this.checkLeadingPath(oldPath);
      await this.checkLeadingPath(newPath);
    }
    const fullOldPath = joinPath(this.rootPath, oldPath);
    const fullNewPath = joinPath(this.rootPath, newPath);
    await this.files.move(fullOldPath, fullNewPath);
  }

  // ========== Checkout Operations ==========

  async checkoutTree(
    treeId: ObjectId,
    options?: WorktreeCheckoutOptions,
  ): Promise<WorktreeCheckoutResult> {
    const result: WorktreeCheckoutResult = {
      updated: [],
      removed: [],
      conflicts: [],
      failed: [],
    };

    const treeEntries = await this.trees.load(treeId);
    if (!treeEntries) {
      throw new Error(`Tree not found: ${treeId}`);
    }

    await this.checkoutTreeRecursive(treeEntries, "", result, options);

    return result;
  }

  async checkoutPaths(
    treeId: ObjectId,
    paths: string[],
    options?: WorktreeCheckoutOptions,
  ): Promise<WorktreeCheckoutResult> {
    const result: WorktreeCheckoutResult = {
      updated: [],
      removed: [],
      conflicts: [],
      failed: [],
    };

    const treeEntries = await this.trees.load(treeId);
    if (!treeEntries) {
      throw new Error(`Tree not found: ${treeId}`);
    }

    await this.checkoutTreeRecursive(treeEntries, "", result, { ...options, paths });

    return result;
  }

  private async checkoutTreeRecursive(
    tree: AsyncIterable<{ name: string; mode: number; id: ObjectId }>,
    prefix: string,
    result: WorktreeCheckoutResult,
    options?: WorktreeCheckoutOptions,
  ): Promise<void> {
    for await (const entry of tree) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Filter by paths if specified
      if (options?.paths) {
        const matchesPath = options.paths.some(
          (p) => path === p || path.startsWith(`${p}/`) || p.startsWith(`${path}/`),
        );
        if (!matchesPath) {
          continue;
        }
      }

      if (entry.mode === FileMode.TREE) {
        // Directory - recurse
        const subtree = await this.trees.load(entry.id);
        if (subtree) {
          await this.checkoutTreeRecursive(subtree, path, result, options);
        }
      } else if (entry.mode === FileMode.GITLINK) {
        // Submodule: an empty directory, as git checks out an unpopulated submodule
        if (options?.dryRun) {
          result.updated.push(path);
          continue;
        }
        try {
          await this.mkdir(path);
          result.updated.push(path);
        } catch (error) {
          result.failed.push({ path, error: String(error) });
        }
      } else {
        // File - checkout content
        if (options?.dryRun) {
          result.updated.push(path);
          continue;
        }

        try {
          // Check for conflicts (file modified but not force)
          if (!options?.force && (await this.exists(path))) {
            const currentHash = await this.computeHash(path);
            if (currentHash !== entry.id) {
              result.conflicts.push(path);
              continue;
            }
          }

          // Stream the blob straight into the file
          const content = await this.blobs.load(entry.id);
          if (content) {
            await this.writeContent(path, content, {
              mode: entry.mode,
              createParents: true,
            });
            result.updated.push(path);
          } else {
            result.failed.push({ path, error: "Blob not found" });
          }
        } catch (error) {
          result.failed.push({ path, error: String(error) });
        }
      }
    }
  }

  // ========== Metadata ==========

  getRoot(): string {
    return this.rootPath;
  }

  async refreshIgnore(): Promise<void> {
    this.repositoryExcludesLoaded = false;
    await this.loadRepositoryExcludes();
  }

  // ========== Internal Helpers ==========

  /** The git mode of an entry as `lstat` reports it. */
  private modeOf(link: LinkStats, hasGitDir: boolean): number {
    if (link.kind === "symlink") return FileMode.SYMLINK;
    if (link.kind === "directory") return hasGitDir ? FileMode.GITLINK : FileMode.TREE;
    if (this.capabilities.executable && ((link.mode ?? 0) & 0o100) !== 0) {
      return FileMode.EXECUTABLE_FILE;
    }
    return FileMode.REGULAR_FILE;
  }

  /** The target of the symbolic link at `fullPath`, or undefined when it is not a link. */
  private async linkTarget(fullPath: string): Promise<Uint8Array | undefined> {
    if (!this.files.lstat || !this.files.readlink) return undefined;
    if ((await this.files.lstat(fullPath))?.kind !== "symlink") return undefined;
    return (await this.files.readlink(fullPath)) ?? new Uint8Array(0);
  }

  /** What is at `fullPath`: `lstat` where the FilesApi has it, else `stats`. */
  /**
   * Whether the link at `link` (the `.git` of the directory `dir`) certainly points nowhere:
   * its target, relative or absolute inside this FilesApi's root, is confirmed absent. A
   * target that cannot be checked is not dangling.
   */
  private async isDanglingLink(link: string, dir: string): Promise<boolean> {
    try {
      const bytes = await this.files.readlink?.(link);
      if (!bytes) return false;
      const target = this.gitfileTarget(dir, new TextDecoder().decode(bytes));
      if (target === undefined) return false;
      return (await this.kindOrError(target)) === undefined;
    } catch {
      return false;
    }
  }

  /**
   * The kind of entry at `fullPath`, undefined only when it is confirmed absent, `"error"`
   * when it cannot be checked (beneath a link, unreadable).
   */
  private async kindOrError(fullPath: string): Promise<LinkStats["kind"] | "error" | undefined> {
    try {
      return await this.kindOf(fullPath);
    } catch {
      return "error";
    }
  }

  private async kindOf(fullPath: string): Promise<LinkStats["kind"] | undefined> {
    if (this.files.lstat) return (await this.files.lstat(fullPath))?.kind;
    return (await this.files.stats(fullPath))?.kind;
  }

  /** Whether a leading component of `path` is a symbolic link or not a directory. */
  private async hasLinkOrFileLeading(path: string): Promise<boolean> {
    try {
      await this.checkLeadingPath(path);
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Refuses a path beneath a symbolic link or a file (git's `has_symlink_leading_path`):
   * a write there would land outside the worktree, or wherever the link points. With
   * `replace` (a forced checkout: `reset --hard`) a link or file standing where a
   * directory must go is unlinked instead, as git's `create_directories` does with
   * `state->force`; what it pointed to is never touched.
   */
  private async checkLeadingPath(path: string, replace = false): Promise<void> {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const full = joinPath(this.rootPath, prefix);
      const kind = await this.kindOf(full);
      if (!kind) return;
      if (replace && kind !== "directory") {
        await this.files.remove(full);
        if (await this.kindOf(full)) throw new Error(`Cannot replace ${prefix}`);
        return;
      }
      if (kind === "symlink") {
        throw new Error(`Refusing to touch ${path}: beyond a symbolic link at ${prefix}`);
      }
      if (kind !== "directory") {
        throw new Error(`Refusing to touch ${path}: ${prefix} is not a directory`);
      }
    }
  }

  private getFileMode(info: { kind: "file" | "directory" }, hasGitDir: boolean): number {
    if (info.kind === "directory") {
      if (hasGitDir) {
        return FileMode.GITLINK;
      }
      return FileMode.TREE;
    }
    return FileMode.REGULAR_FILE;
  }

  private async hasGitDirectory(dirPath: string, files = this.files): Promise<boolean> {
    const gitPath = joinPath(dirPath, ".git");
    try {
      return await files.exists(gitPath);
    } catch {
      return false;
    }
  }

  private async getFileStats(
    fullPath: string,
    isDirectory: boolean,
    files = this.files,
  ): Promise<{ size: number; mtime: number }> {
    if (isDirectory) {
      return { size: 0, mtime: 0 };
    }

    try {
      const stats = await files.stats(fullPath);
      if (stats) {
        return {
          size: stats.size ?? 0,
          mtime: stats.lastModified ?? 0,
        };
      }
    } catch {
      // Fall through to defaults
    }

    return { size: 0, mtime: 0 };
  }

  /**
   * The exclude files (`info/exclude`, `core.excludesFile`): read afresh for every walk and
   * ignore check where the ignore manager can replace them, so a change is always seen.
   */
  private async loadRepositoryExcludes(): Promise<void> {
    if (this.ignoreManager.setExcludeFile) {
      const read = async (path: string) => {
        try {
          if ((await this.files.lstat?.(path))?.kind === "symlink") return undefined;
          if (!(await this.files.exists(path))) return undefined;
          return new TextDecoder().decode(await readFile(this.files, path));
        } catch {
          return undefined;
        }
      };
      this.ignoreManager.setExcludeFile(
        "info/exclude",
        this.gitDir ? await read(joinPath(this.gitDir, "info", "exclude")) : undefined,
      );
      this.ignoreManager.setExcludeFile(
        "core.excludesFile",
        this.globalExcludesFile ? await read(this.globalExcludesFile) : undefined,
      );
      return;
    }
    if (this.repositoryExcludesLoaded) {
      return;
    }
    this.repositoryExcludesLoaded = true;

    if (this.globalExcludesFile) {
      await this.tryLoadGlobalExcludes(this.globalExcludesFile);
    }

    if (this.gitDir) {
      await this.tryLoadInfoExclude(this.gitDir);
    }
  }

  /**
   * Reads the `.gitignore` of a directory afresh and replaces that directory's rules (none
   * when the file is gone, or is a symbolic link, which git 2.32+ never follows).
   */
  private async tryLoadGitignore(
    dirPath: string,
    relativePath: string,
    files = this.files,
  ): Promise<void> {
    const gitignorePath = joinPath(dirPath, ".gitignore");
    let text: string | undefined;
    try {
      if ((await files.lstat?.(gitignorePath))?.kind !== "symlink") {
        if (await files.exists(gitignorePath)) {
          text = new TextDecoder().decode(await readFile(files, gitignorePath));
        }
      }
    } catch {
      text = undefined;
    }
    if (this.ignoreManager.setIgnoreFile) this.ignoreManager.setIgnoreFile(relativePath, text);
    else if (text !== undefined) this.ignoreManager.addIgnoreFile(relativePath, text);
  }

  private async tryLoadInfoExclude(gitDir: string): Promise<void> {
    const excludePath = joinPath(gitDir, "info", "exclude");

    try {
      if (await this.files.exists(excludePath)) {
        const content = await readFile(this.files, excludePath);
        const text = new TextDecoder().decode(content);
        const patterns = text.split("\n").filter((line) => line.trim() !== "");
        this.ignoreManager.addGlobalPatterns(patterns);
      }
    } catch {
      // Ignore errors
    }
  }

  private async tryLoadGlobalExcludes(excludesFilePath: string): Promise<void> {
    try {
      if (await this.files.exists(excludesFilePath)) {
        const content = await readFile(this.files, excludesFilePath);
        const text = new TextDecoder().decode(content);
        this.ignoreManager.addGlobalPatterns(text.split("\n").filter((line) => line.trim() !== ""));
      }
    } catch {
      // Ignore errors
    }
  }

  private getParentPath(path: string): string | undefined {
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash > 0) {
      return path.substring(0, lastSlash);
    }
    return undefined;
  }
}

/**
 * Factory function to create a FileWorktree
 */
/** The stat data of an entry the FilesApi reports (what git's index records of it). */
/** `path` with `.` and `..` resolved; undefined when it climbs above the root. */
function resolveDots(path: string): string | undefined {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  return `${path.startsWith("/") ? "/" : ""}${out.join("/")}`;
}

function statData(link: LinkStats): Partial<WorktreeEntry> {
  const out: Partial<WorktreeEntry> = {};
  if (link.ctime !== undefined) out.ctime = link.ctime;
  if (link.mtimeNs !== undefined) out.mtimeNs = link.mtimeNs;
  if (link.ctimeNs !== undefined) out.ctimeNs = link.ctimeNs;
  if (link.dev !== undefined) out.dev = link.dev;
  if (link.ino !== undefined) out.ino = link.ino;
  if (link.uid !== undefined) out.uid = link.uid;
  if (link.gid !== undefined) out.gid = link.gid;
  return out;
}

export function createFileWorktree(options: FileWorktreeOptions): Worktree {
  return new FileWorktree(options);
}
