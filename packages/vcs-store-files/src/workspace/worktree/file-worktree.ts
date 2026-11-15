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
  WorktreeWalkOptions,
  WorktreeWriteOptions,
} from "@statewalker/vcs-working-tree";
import { createIgnoreManager, hashWorktreeFile } from "@statewalker/vcs-working-tree";
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
  private readonly files: WorktreeFilesApi;
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
    this.files = options.files;
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

  // ========== Reading ==========

  async *walk(options?: WorktreeWalkOptions): AsyncIterable<WorktreeEntry> {
    const includeIgnored = options?.includeIgnored ?? false;
    const includeDirectories = options?.includeDirectories ?? false;
    const pathPrefix = options?.pathPrefix ?? "";

    await this.loadRepositoryExcludes();

    if (options?.ignorePatterns?.length) {
      this.ignoreManager.addGlobalPatterns(options.ignorePatterns);
    }

    const startPath = pathPrefix ? joinPath(this.rootPath, pathPrefix) : this.rootPath;
    yield* this.walkDirectory(
      startPath,
      pathPrefix,
      includeIgnored,
      includeDirectories,
      options?.maxDepth,
    );
  }

  private async *walkDirectory(
    dirPath: string,
    relativePath: string,
    includeIgnored: boolean,
    includeDirectories: boolean,
    maxDepth?: number,
    currentDepth = 0,
  ): AsyncIterable<WorktreeEntry> {
    if (maxDepth !== undefined && currentDepth > maxDepth) {
      return;
    }

    if (this.autoLoadGitignore) {
      await this.tryLoadGitignore(dirPath, relativePath);
    }

    const entries: FileInfo[] = [];
    try {
      for await (const entry of this.files.list(dirPath)) {
        entries.push(entry);
      }
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const fullPath = joinPath(dirPath, entry.name);

      if (entry.name === ".git") {
        continue;
      }

      // the entry itself: a symbolic link is a file of its own, never descended into
      const link = await this.files.lstat?.(fullPath);
      // a FIFO, socket or device is not content git tracks (git skips it too)
      if (link?.kind === "other") continue;
      const isDirectory = link ? link.kind === "directory" : entry.kind === "directory";

      const isIgnored = this.ignoreManager.isIgnored(entryPath, isDirectory);

      if (isIgnored && !includeIgnored) {
        continue;
      }

      let hasGitDir = false;
      if (isDirectory) {
        hasGitDir = await this.hasGitDirectory(fullPath);
      }

      const stats = link
        ? { size: isDirectory ? 0 : link.size, mtime: isDirectory ? 0 : link.lastModified }
        : await this.getFileStats(fullPath, isDirectory);

      const worktreeEntry: WorktreeEntry = {
        path: entryPath,
        name: entry.name,
        mode: link
          ? this.modeOf(link, hasGitDir)
          : this.getFileMode({ kind: isDirectory ? "directory" : "file" }, hasGitDir),
        size: stats.size,
        mtime: stats.mtime,
        ...(link?.ctime !== undefined && !isDirectory ? { ctime: link.ctime } : {}),
        isDirectory,
        isIgnored,
      };

      if (isDirectory && includeDirectories) {
        yield worktreeEntry;
      }

      if (!isDirectory) {
        yield worktreeEntry;
      }

      if (isDirectory && !hasGitDir) {
        yield* this.walkDirectory(
          fullPath,
          entryPath,
          includeIgnored,
          includeDirectories,
          maxDepth,
          currentDepth + 1,
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
        ...(link.ctime !== undefined && !isDirectory ? { ctime: link.ctime } : {}),
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
    await this.loadRepositoryExcludes();

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
  async remove(path: string, options?: { recursive?: boolean }): Promise<boolean> {
    assertValidWorktreePath(path, undefined, this.pathRules);
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

  private async hasGitDirectory(dirPath: string): Promise<boolean> {
    const gitPath = joinPath(dirPath, ".git");
    try {
      return await this.files.exists(gitPath);
    } catch {
      return false;
    }
  }

  private async getFileStats(
    fullPath: string,
    isDirectory: boolean,
  ): Promise<{ size: number; mtime: number }> {
    if (isDirectory) {
      return { size: 0, mtime: 0 };
    }

    try {
      const stats = await this.files.stats(fullPath);
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

  private async loadRepositoryExcludes(): Promise<void> {
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

  private async tryLoadGitignore(dirPath: string, relativePath: string): Promise<void> {
    const gitignorePath = joinPath(dirPath, ".gitignore");

    try {
      // git (2.32+) never follows a symbolic link to a .gitignore inside the worktree
      if ((await this.files.lstat?.(gitignorePath))?.kind === "symlink") return;
      if (await this.files.exists(gitignorePath)) {
        const content = await readFile(this.files, gitignorePath);
        const text = new TextDecoder().decode(content);
        this.ignoreManager.addIgnoreFile(relativePath, text);
      }
    } catch {
      // Ignore errors
    }
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
export function createFileWorktree(options: FileWorktreeOptions): Worktree {
  return new FileWorktree(options);
}
