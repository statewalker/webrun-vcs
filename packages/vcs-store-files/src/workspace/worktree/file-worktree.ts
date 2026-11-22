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
  createHistoryFromStores,
  FileMode,
  isBeyondSymlinkError,
  joinPath,
  type LinkStats,
  normalizePath,
  type PosixFilesApi,
  readFile,
} from "@statewalker/vcs-core";
import { decodeGitPath, decodeGitPatternFile } from "@statewalker/vcs-utils/encoding";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { computeObjectIdFromStream } from "@statewalker/vcs-utils/pack";
import { collect } from "@statewalker/vcs-utils/streams";
import type {
  AttributesIndex,
  GitHostEnvironment,
  GitlinkHeadState,
  IgnoreManager,
  NestedRepositoryState,
  NewHasher,
  OpenedRepository,
  OpenRepositoryOptions,
  UntrackedScanHost,
  Worktree,
  WorktreeCapabilities,
  WorktreeCheckoutOptions,
  WorktreeCheckoutResult,
  WorktreeContentFilter,
  WorktreeEntry,
  WorktreeRemoveOptions,
  WorktreeWalkOptions,
  WorktreeWriteOptions,
} from "@statewalker/vcs-working-tree";
import {
  attributesIndexOfTree,
  createIgnoreManager,
  hashWorktreeFile,
  MemoryCheckout,
  MemoryWorkingCopy,
  smudgeContent,
  type WorkingCopy,
} from "@statewalker/vcs-working-tree";
import { createGitFilesBackend } from "../../create-git-files-backend.js";
import { assertValidOwnership, hostPathOf } from "../../safety/index.js";
import { parseGitfile } from "../git-dir/index.js";
import { openGitLinkedWorktrees } from "../linked-worktrees/index.js";
import { FileStagingStore } from "../staging/index.js";
import { configFilesApiOf, createWorkingCopyConfig } from "../working-copy/index.js";
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
  /**
   * The user's environment: a submodule opened with `openGitlink` reads the system and
   * global config files through it (its commit-graph settings among them), as git does
   */
  environment?: GitHostEnvironment;
}

/** How many `getEntry` calls {@link FileWorktree.getEntries} keeps in flight without `lstatMany`. */
const GET_ENTRIES_IN_FLIGHT = 48;

/**
 * File-based Worktree implementation
 */
export class FileWorktree implements Worktree {
  private filter?: WorktreeContentFilter;
  /** Reads the global excludes file when no `globalExcludesFile` was given */
  private excludesReader?: () => Promise<string | undefined>;
  /** Reads `core.ignoreCase` for the ignore rules (set by the working copy) */
  private ignoreCaseReader?: () => boolean;
  /** Reads a `.gitignore` the worktree lacks from its skip-worktree index entry */
  private skipWorktreeIgnoreReader?: (path: string) => Promise<string | undefined>;
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
  private readonly environment?: GitHostEnvironment;
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
    if (options.environment) this.environment = options.environment;
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

  /**
   * Whether the worktree's storage folds case, seen without writing anything: an entry of the
   * worktree's root with a letter in its name looked up in another case (else the git
   * directory, only when it lies inside the root: a separate git directory, a linked
   * worktree's or a submodule's, may be on another filesystem). Undefined when there is no
   * such entry to look at.
   */
  async foldsCase(): Promise<boolean | undefined> {
    const swapCase = (name: string) =>
      [...name].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
    const kind = (path: string) => this.kindOf(path).catch(() => undefined);
    const candidates: string[] = [];
    try {
      let seen = 0;
      for await (const info of this.rootFiles.list(this.rootPath)) {
        candidates.push(info.path);
        if (++seen >= 16) break;
      }
    } catch {
      // no root to list
    }
    if (this.gitDir !== undefined && isInside(this.gitDir, this.rootPath)) {
      candidates.push(this.gitDir);
    }
    for (const path of candidates) {
      const slash = path.lastIndexOf("/");
      const name = path.slice(slash + 1);
      const other = swapCase(name);
      if (other === name || !(await kind(path))) continue;
      return (await kind(`${path.slice(0, slash + 1)}${other}`)) !== undefined;
    }
    return undefined;
  }

  /** The FilesApi operations go through: the batch view while a batch runs. */
  private get files(): WorktreeFilesApi {
    return this.scoped ?? this.rootFiles;
  }

  /**
   * Runs `fn` as one batch: over a FilesApi with `withLstatCache`, its operations share a
   * cache of directories verified not to be links, dropped when the batch ends (git's
   * per-command lstat cache), and the ignore rules are read once for the whole batch, as
   * are the content filter's configuration and attributes files. Nested batches join the
   * outer one.
   */
  async batch<T>(fn: () => Promise<T>): Promise<T> {
    if (this.batchIgnores) return fn();
    this.batchIgnores = new Set();
    if (this.rootFiles.withLstatCache) this.scoped = this.rootFiles.withLstatCache();
    try {
      const filter = this.filter;
      return await (filter?.batch ? filter.batch(fn) : fn());
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
        skipFile: options?.skipFile,
      },
    );
  }

  async untrackedScanHost(): Promise<UntrackedScanHost> {
    const files = this.files;
    // the batch's rules: a .gitignore read here serves later checks of the batch
    const loaded = this.batchIgnores ?? new Set<string>();
    if (!loaded.has("<excludes>")) {
      loaded.add("<excludes>");
      await this.loadRepositoryExcludes();
    }
    const full = (path: string) => (path ? this.fullPathOf(path) : this.rootPath || "/");
    const lstat = async (path: string): Promise<LinkStats | undefined> => {
      try {
        return await files.lstat?.(full(path));
      } catch (error) {
        if (isBeyondSymlinkError(error)) return undefined;
        throw error;
      }
    };
    const gitDir = this.gitDir;
    return {
      worktreePath: this.hostPath,
      listDirectory: async (path, readdirOrder) => {
        const dirPath = full(path);
        if (files.listKinds) return files.listKinds(dirPath, { readdirOrder });
        const out: Array<{ name: string; kind?: LinkStats["kind"] }> = [];
        for await (const entry of files.list(dirPath)) {
          out.push({
            name: entry.name,
            kind: entry.kind === "directory" ? "directory" : undefined,
          });
        }
        return out;
      },
      lstat: files.lstat ? lstat : async (path) => this.statsAsLink(full(path)),
      loadIgnoreFile: async (dir) => {
        const result = await this.readIgnoreFile(dir, files);
        loaded.add(dir);
        return result;
      },
      isExcluded: (path, isDirectory) => this.ignoreManager.isIgnored(path, isDirectory),
      isNestedRepository: (path) => this.hasGitDirectory(path),
      readInfoExclude: async () => {
        if (!gitDir) return undefined;
        const path = joinPath(gitDir, "info", "exclude");
        try {
          const stat = files.lstat ? await files.lstat(path) : await this.statsAsLink(path);
          if (stat?.kind !== "file") return undefined;
          return { bytes: await readFile(files, path), stat };
        } catch {
          return undefined;
        }
      },
    };
  }

  /** `stats` as a `LinkStats` (a FilesApi without `lstat`). */
  private async statsAsLink(fullPath: string): Promise<LinkStats | undefined> {
    const stats = await this.files.stats(fullPath).catch(() => undefined);
    if (!stats) return undefined;
    return {
      kind: stats.kind === "directory" ? "directory" : "file",
      size: stats.size ?? 0,
      lastModified: stats.lastModified ?? 0,
    };
  }

  /**
   * Reads `<dir>/.gitignore` for the untracked scan and makes its rules `dir`'s (git's
   * `add_patterns` with PATTERN_NOFOLLOW): a link or anything but a file is not opened, and
   * one git cannot open is read from its skip-worktree index entry.
   */
  private async readIgnoreFile(
    dir: string,
    files: WorktreeFilesApi,
  ): Promise<{ kind: "missing" } | { kind: "file"; bytes: Uint8Array; stat: LinkStats }> {
    const path = dir ? `${dir}/.gitignore` : ".gitignore";
    const fullPath = this.fullPathOf(path);
    let result: { kind: "missing" } | { kind: "file"; bytes: Uint8Array; stat: LinkStats } = {
      kind: "missing",
    };
    try {
      const stat = files.lstat
        ? await files.lstat(fullPath)
        : (await files.exists(fullPath))
          ? await this.statsAsLink(fullPath)
          : undefined;
      if (stat?.kind === "file") {
        result = { kind: "file", bytes: await readFile(files, fullPath), stat };
      }
    } catch {
      result = { kind: "missing" };
    }
    let text: string | undefined;
    if (result.kind === "file") text = decodeGitPatternFile(result.bytes);
    else if (this.skipWorktreeIgnoreReader) {
      text = await this.skipWorktreeIgnoreReader(path).catch(() => undefined);
    }
    if (this.ignoreManager.setIgnoreFile) this.ignoreManager.setIgnoreFile(dir, text);
    else if (text !== undefined) this.ignoreManager.addIgnoreFile(dir, text);
    return result;
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
    extra: {
      enterNonRepositoryGitDirs: boolean;
      onUnreadable?: (path: string, error?: unknown) => void;
      skipFile?: (path: string) => boolean;
    } = {
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

    // the entries with what the listing tells of them: `listKinds` gives each one's kind
    // without a stat (git's d_type), so a file the caller skips is never stat'ed
    let entries: Array<{ name: string; kind?: LinkStats["kind"] | "file" | "directory" }>;
    const listed = !!files.listKinds;
    try {
      if (files.listKinds) entries = await files.listKinds(dirPath);
      else {
        entries = [];
        for await (const entry of files.list(dirPath)) entries.push(entry);
      }
    } catch (error) {
      // unreadable: its content is unknown (reported, so nothing is removed on a guess)
      extra.onUnreadable?.(relativePath, error);
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    const skipFile = extra.skipFile;
    const dirPrefix = dirPath === "/" ? "/" : `${dirPath}/`;

    for (const entry of entries) {
      const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      // a tracked file of an untracked-file scan: passed over before any stat
      if (listed && skipFile && entry.kind !== undefined && entry.kind !== "directory") {
        if (skipFile(entryPath)) continue;
      }
      const fullPath = listed ? dirPrefix + entry.name : joinPath(dirPath, entry.name);

      if (entry.name === ".git") {
        // the worktree's own repository, or a nested one: never listed; a `.git` in a
        // directory that holds no repository is listed on request (git clean removes it)
        if (!extra.enterNonRepositoryGitDirs || relativePath === "") continue;
        if (await this.isRepository(relativePath)) continue;
      }

      // the entry itself: a symbolic link is a file of its own, never descended into (a
      // directory `listKinds` reported is one already: not stat'ed again)
      const link =
        listed && entry.kind === "directory" ? DIRECTORY_STATS : await files.lstat?.(fullPath);
      // a FIFO, socket or device is not content git tracks (git skips it too)
      if (link?.kind === "other") continue;
      const isDirectory = link ? link.kind === "directory" : entry.kind === "directory";
      if (!isDirectory && skipFile && !(listed && entry.kind !== undefined)) {
        if (skipFile(entryPath)) continue;
      }

      const isIgnored = this.ignoreManager.isIgnored(entryPath, isDirectory);

      if (isIgnored && !includeIgnored) {
        continue;
      }

      let hasGitDir = false;
      if (isDirectory) {
        hasGitDir = await this.hasGitDirectory(entryPath);
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

  /**
   * {@link getEntry} of every path: one `lstatMany` where the FilesApi has it (synchronous
   * lstats, leading directories checked once), else one `getEntry` per path, at most
   * {@link GET_ENTRIES_IN_FLIGHT} at a time (a slow asynchronous FilesApi, OPFS or one over
   * `fetch`, is not handed thousands of requests at once).
   */
  async getEntries(paths: readonly string[]): Promise<Array<WorktreeEntry | undefined>> {
    const files = this.files;
    if (!files.lstatMany) {
      const out = new Array<WorktreeEntry | undefined>(paths.length);
      let next = 0;
      const worker = async () => {
        while (next < paths.length) {
          const i = next++;
          try {
            out[i] = await this.getEntry(paths[i] as string);
          } catch (error) {
            // the first failure rejects the batch: the other workers stop taking paths
            next = paths.length;
            throw error;
          }
        }
      };
      const workers = Math.min(GET_ENTRIES_IN_FLIGHT, paths.length);
      await Promise.all(Array.from({ length: workers }, worker));
      return out;
    }
    const links = await files.lstatMany(paths.map((path) => this.fullPathOf(path)));
    const out = new Array<WorktreeEntry | undefined>(paths.length);
    for (let i = 0; i < paths.length; i++) {
      const link = links[i];
      if (!link || link.kind === "other") continue;
      const path = paths[i] as string;
      if (link.kind === "directory") {
        out[i] = await this.getEntry(path); // a gitlink's directory: asked as one
        continue;
      }
      out[i] = this.fileEntry(path, link);
    }
    return out;
  }

  /** The FilesApi path of a worktree path. */
  private fullPathOf(path: string): string {
    const root = this.rootPath;
    return root === "" || root === "/" ? `/${path}` : joinPath(root, path);
  }

  /**
   * The entry of a file or symbolic link at `path`, from its `lstat`; whether it is ignored
   * is worked out when asked (a stat pass over tracked files never asks).
   */
  private fileEntry(path: string, link: LinkStats): WorktreeEntry {
    // one object of a fixed shape per file, its name and ignore state worked out when asked
    // (a stat pass over tens of thousands of tracked files asks for neither)
    return new StatEntry(path, this.modeOf(link, false), link, this.ignoreManager);
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
      const hasGitDir = isDirectory && (await this.hasGitDirectory(path));
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
        hasGitDir = await this.hasGitDirectory(path);
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

  /**
   * The worktree's root as the host names it (an absolute path on Node), from the FilesApi's
   * `rootDirectory`; undefined when the FilesApi does not say
   */
  get hostPath(): string | undefined {
    const root = this.rootFiles.rootDirectory;
    if (!root) return undefined;
    const sub = this.rootPath.replace(/^\/+|\/+$/g, "");
    return sub ? `${root.replace(/\/+$/, "")}/${sub}` : root;
  }

  get contentFilter(): WorktreeContentFilter | undefined {
    return this.filter;
  }

  setContentFilter(filter: WorktreeContentFilter | undefined): void {
    this.filter = filter;
  }

  setExcludesFileReader(read: (() => Promise<string | undefined>) | undefined): void {
    this.excludesReader = read;
  }

  setIgnoreCaseReader(read: (() => boolean) | undefined): void {
    this.ignoreCaseReader = read;
  }

  setSkipWorktreeIgnoreReader(
    read: ((path: string) => Promise<string | undefined>) | undefined,
  ): void {
    this.skipWorktreeIgnoreReader = read;
  }

  /** A file of the git directory (`info/attributes`), never through a symbolic link. */
  async readGitDirFile(path: string): Promise<Uint8Array | undefined> {
    if (!this.gitDir) return undefined;
    const fullPath = joinPath(this.gitDir, path);
    try {
      if ((await this.files.lstat?.(fullPath))?.kind === "symlink") return undefined;
      const stats = await this.files.stats(fullPath);
      if (stats?.kind !== "file") return undefined;
      return await readFile(this.files, fullPath);
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
    // the content as the content filter cleans it (what `git add` would store); a link
    // held as a file (`raw`) as it is
    const conversion = this.filter ? await this.filter.checkin(path) : undefined;
    if (conversion) {
      const stats = await this.files.stats(fullPath);
      if (stats?.kind === "directory") throw new Error(`Is a directory: ${path}`);
      if (stats?.kind !== "file") throw new Error(`File not found: ${path}`);
      const cleaned = await conversion.apply(await collect(this.files.read(fullPath)));
      return computeObjectIdFromStream("blob", cleaned.length, [cleaned], this.newHasher);
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

  async isIgnored(path: string, asDirectory = false): Promise<boolean> {
    // the .gitignore files of the path's directories and the exclude files, read for this
    // check (once per batch), never through a link
    await this.loadIgnoresFor(path, this.batchIgnores ?? new Set<string>());
    if (asDirectory) return this.ignoreManager.isIgnored(path, true);

    // a directory (an empty one too), never a link to one: as git's lstat decides
    const kind = await this.kindOrError(joinPath(this.rootPath, path));
    return this.ignoreManager.isIgnored(path, kind === "directory");
  }

  // ========== Writing ==========

  async writeContent(
    path: string,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array,
    options?: WorktreeWriteOptions,
  ): Promise<void> {
    assertValidWorktreePath(path, options?.mode, this.pathRules);
    // a regular file is smudged by the content filter (git's convert_to_working_tree)
    if (!options?.raw) {
      content = await smudgeContent(this.filter, path, content, options?.mode, options?.attributes);
    }
    try {
      await this.writeFile(path, content, options);
    } finally {
      // what the filter read from this file (a `.gitattributes`) is read again
      this.filter?.noteChanged?.(path);
    }
  }

  private async writeFile(
    path: string,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array,
    options?: WorktreeWriteOptions,
  ): Promise<void> {
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
      if (!options.discardUntracked) await this.assertExpendableDirectory(path);
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
   * Refuses (throws) where removing the directory at `path` would lose work: an untracked
   * file or link that is not ignored, or a nested repository (git's
   * `verify_clean_subdirectory`). Ignored files and empty directories are expendable.
   */
  private async assertExpendableDirectory(path: string): Promise<void> {
    const lost = async () => {
      if ((await this.repositoryState(path)) !== "none") return true;
      for await (const inside of this.walk({ pathPrefix: path, includeDirectories: true })) {
        if (!inside.isDirectory || inside.mode === FileMode.GITLINK) return true;
      }
      return false;
    };
    if (await lost()) {
      throw new Error(`Updating '${path}' would lose untracked files in it`);
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
    const removed = await this.files.remove(fullPath);
    // a removed directory takes its attributes files (and its subdirectories') with it
    if (removed) this.filter?.noteChanged?.(kind === "directory" ? `${path}/.gitattributes` : path);
    return removed;
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
    // the path as its bytes: a gitdir that is no UTF-8 names the same directory; only the
    // line end is stripped (read_gitfile_gently)
    return parseGitfile(decodeGitPath(await readFile(this.files, dotGit)));
  }

  async isRepository(path: string): Promise<boolean> {
    // anything that might be a repository is one here, so nothing is removed on a guess
    return (await this.repositoryState(path)) !== "none";
  }

  /**
   * Whether the directory at `path` holds a repository of its own, as git's
   * `is_nonbare_repository_dir` decides: `"repository"`, `"none"`, or `"unknown"` when its
   * `.git` cannot be checked through this FilesApi (a gitfile, link or commondir naming a
   * place beyond its root, a path reached through a link, an unreadable entry).
   *
   * @throws Error with git's "fatal: failed to read <gitdir>/commondir" for an empty
   * `commondir` (git's `get_common_dir` dies)
   */
  async repositoryState(path: string): Promise<NestedRepositoryState> {
    return (await this.nestedGitDir(path)).state;
  }

  /**
   * git's `is_nonbare_repository_dir` of the directory at `path`, with the git directory it
   * finds (and its common directory) when it is a repository: a `.git` directory, the
   * directory a `gitdir:` file names, or what a `.git` link points to (a directory, or a
   * gitfile, as git's `stat` follows it).
   */
  private async nestedGitDir(path: string): Promise<NestedGitDir> {
    const dotGit = joinPath(this.rootPath, path, ".git");
    const display = path ? `${path}/.git` : ".git";
    const kind = await this.kindOrError(dotGit);
    if (kind === undefined) return { state: "none" };
    if (kind === "error") return { state: "unknown" };
    if (kind === "directory") return this.gitDirectoryAt(dotGit, display);
    if (kind === "file") return this.gitfileRepository(path, dotGit);
    if (kind !== "symlink") return { state: "none" };
    // a `.git` link (git follows it): its target, when this FilesApi can name it
    const bytes = await this.files.readlink?.(dotGit).catch(() => undefined);
    const resolved = bytes ? this.gitfileTarget(path, decodeGitPath(bytes)) : undefined;
    if (resolved === undefined) return { state: "unknown" };
    const target = await this.kindOrError(resolved);
    // dangling: git's stat fails, and so does is_git_directory
    if (target === undefined) return { state: "none" };
    if (target === "directory") return this.gitDirectoryAt(resolved, display);
    // a link to a gitfile is read as one (its gitdir relative to the link's directory)
    if (target === "file") return this.gitfileRepository(path, resolved);
    if (target === "error" || target === "symlink") return { state: "unknown" };
    return { state: "none" };
  }

  /** git's `read_gitfile_gently` of the gitfile `file` (the `.git` of `path`). */
  private async gitfileRepository(path: string, file: string): Promise<NestedGitDir> {
    let target: string | undefined;
    try {
      target = await this.readGitfile(file);
    } catch {
      // git's READ_GITFILE_ERR_OPEN_FAILED / READ_FAILED: taken for a repository
      return { state: "unknown" };
    }
    if (!target) return { state: "none" };
    const resolved = this.gitfileTarget(path, target);
    if (resolved === undefined) return { state: "unknown" };
    // the name git gives it: relative to the gitfile's directory, as written
    const display = this.isAbsoluteGitPath(target) || !path ? target : `${path}/${target}`;
    return this.gitDirectoryAt(resolved, display);
  }

  /**
   * git's `is_git_directory` of the directory at `dir` (a path in this FilesApi, `display`
   * its name in git's messages): a valid HEAD ({@link headState}: a file, or a link as
   * core.preferSymlinkRefs writes it), then objects and refs (directories) in its common
   * directory (a linked worktree's gitdir has none of its own: its `commondir` names them).
   */
  private async gitDirectoryAt(dir: string, display: string): Promise<NestedGitDir> {
    const head = await this.headState(dir);
    if (head !== "repository") return { state: head };
    const commonDir = await this.commonDirOf(dir, display);
    if (commonDir === undefined) return { state: "unknown" };
    let unknown = false;
    for (const name of ["objects", "refs"]) {
      const k = await this.kindOrError(joinPath(commonDir, name));
      if (k === "error" || k === "symlink") unknown = true;
      else if (k !== "directory") return { state: "none" };
    }
    return unknown ? { state: "unknown" } : { state: "repository", gitDir: dir, commonDir };
  }

  /**
   * git's `get_common_dir_noenv` of the git directory `dir`: the directory its `commondir`
   * file names (relative to `dir`, or absolute), `dir` itself without one. Undefined when it
   * cannot be read here (beyond this FilesApi's root, unreadable, through a link chain).
   *
   * @throws Error with git's "fatal: failed to read <display>/commondir" for an empty one
   * (or one that is no file)
   */
  private async commonDirOf(dir: string, display: string): Promise<string | undefined> {
    let file = joinPath(dir, "commondir");
    let kind = await this.kindOrError(file);
    if (kind === "symlink") {
      // git's file_exists and read follow a link
      const bytes = await this.files.readlink?.(file).catch(() => undefined);
      const target = bytes ? decodeGitPath(bytes) : undefined;
      const resolved = !target
        ? undefined
        : this.isAbsoluteGitPath(target)
          ? this.gitfileTarget("", target)
          : resolveDots(joinPath(dir, target));
      if (resolved === undefined) return undefined;
      file = resolved;
      kind = await this.kindOrError(file);
      if (kind === "symlink") return undefined;
    }
    if (kind === undefined) return dir;
    if (kind === "error" || kind === "other") return undefined;
    const fatal = () => new Error(`fatal: failed to read ${display}/commondir`);
    if (kind !== "file") throw fatal();
    let bytes: Uint8Array;
    try {
      bytes = await readFile(this.files, file);
    } catch {
      return undefined;
    }
    if (bytes.length === 0) throw fatal();
    let end = bytes.length;
    while (end > 0 && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end--;
    const common = decodeGitPath(bytes.subarray(0, end));
    if (this.isAbsoluteGitPath(common)) return this.gitfileTarget("", common);
    return resolveDots(joinPath(dir, common));
  }

  /** Whether a path git reads from a file is absolute (a drive letter only on Windows). */
  private isAbsoluteGitPath(target: string): boolean {
    return target.startsWith("/") || (this.windowsPaths && /^[A-Za-z]:[\\/]/.test(target));
  }

  /**
   * Whether the directory at `dir` has a valid HEAD (git's `validate_headref`): a link into
   * `refs/`, or a file holding a symbolic ref into `refs/` or an object id.
   */
  private async headState(dir: string): Promise<NestedRepositoryState> {
    const path = joinPath(dir, "HEAD");
    const kind = await this.kindOrError(path);
    if (kind === "error") return "unknown";
    if (kind === "symlink") {
      const target = await this.files.readlink?.(path).catch(() => undefined);
      if (!target) return "unknown";
      return decodeGitPath(target).startsWith("refs/") ? "repository" : "none";
    }
    // anything but a regular file fails git's open/read (and a FIFO would block)
    if (kind !== "file") return "none";
    let text: string;
    try {
      text = decodeGitPath((await readFile(this.files, path)).subarray(0, 255));
    } catch {
      return "unknown";
    }
    if (text.startsWith("ref:") && text.slice(4).replace(/^\s+/, "").startsWith("refs/")) {
      return "repository";
    }
    return /^([0-9a-fA-F]{64}|[0-9a-fA-F]{40})/.test(text) ? "repository" : "none";
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

  async gitlinkRepository(path: string): Promise<string | null | undefined> {
    const dotGit = joinPath(this.rootPath, path, ".git");
    const kind = await this.kindOf(dotGit).catch(() => undefined);
    if (kind === "directory") return dotGit;
    if (kind !== "file") return undefined;
    const target = await this.readGitfile(dotGit).catch(() => undefined);
    if (!target) return undefined;
    // the place the gitfile names, a repository there or not (git connects it anyway)
    return this.gitfileTarget(path, target) ?? null;
  }

  async connectGitlink(path: string, gitDir: string): Promise<void> {
    assertValidWorktreePath(path, undefined, this.pathRules);
    const workTree = joinPath(this.rootPath, path);
    const encoder = new TextEncoder();
    await this.files.write(joinPath(workTree, ".git"), [
      encoder.encode(`gitdir: ${relativeFilesPath(gitDir, workTree)}\n`),
    ]);
    const files = this.rootFiles;
    const config = await createWorkingCopyConfig(
      {
        read: async (p) => ((await files.exists(p)) ? readFile(files, p) : undefined),
        write: (p, content) => files.write(p, [content]),
      },
      gitDir,
      undefined,
      this.environment ? { environment: this.environment } : {},
    );
    config.set("core.worktree", relativeFilesPath(workTree, gitDir));
    await config.save();
  }

  async readGitlinkHead(path: string): Promise<ObjectId | undefined> {
    const state = await this.gitlinkHeadState(path);
    return state.state === "commit" ? state.head : undefined;
  }

  /**
   * git's `resolve_gitlink_ref(path, "HEAD")`: the repository at `path` found as
   * {@link repositoryState} finds it, then its HEAD resolved (a link into `refs/` as
   * `ref: <target>`, as core.preferSymlinkRefs writes it), loose refs in its git directory
   * then its common directory, then `packed-refs`. `"none"` when there is no repository or
   * no commit there, `"unknown"` when it cannot be read here.
   */
  async gitlinkHeadState(path: string): Promise<GitlinkHeadState> {
    const repo = await this.nestedGitDir(path);
    if (repo.state !== "repository") return { state: repo.state };
    const { gitDir, commonDir } = repo;
    let head = await this.readRefFile(joinPath(gitDir, "HEAD"));
    for (let depth = 0; typeof head === "string" && head.startsWith("ref:"); depth++) {
      if (depth >= 5) return { state: "unknown" };
      const ref = head.slice(4).trim();
      let loose = await this.readRefFile(joinPath(gitDir, ref));
      if (loose === undefined && commonDir !== gitDir) {
        loose = await this.readRefFile(joinPath(commonDir, ref));
      }
      if (loose !== undefined) {
        head = loose;
        continue;
      }
      const packed = await this.readRefFile(joinPath(commonDir, "packed-refs"));
      if (packed === UNREADABLE) return { state: "unknown" };
      const line = packed?.split("\n").find((l) => l.endsWith(` ${ref}`));
      head = line?.split(" ")[0];
    }
    if (head === UNREADABLE) return { state: "unknown" };
    // an id in either case (git's get_oid_hex), kept lowercase
    if (!head || !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(head) || /^0+$/.test(head)) {
      return { state: "none" };
    }
    return { state: "commit", head: head.toLowerCase() };
  }

  /**
   * A ref file of a nested repository, trimmed: a link into `refs/` read as `ref: <target>`
   * (git's files backend), undefined when absent (or a directory), {@link UNREADABLE} when it
   * cannot be read here (a FIFO would block).
   */
  private async readRefFile(full: string): Promise<string | typeof UNREADABLE | undefined> {
    const kind = await this.kindOrError(full);
    if (kind === undefined || kind === "directory") return undefined;
    if (kind === "symlink") {
      const target = await this.files.readlink?.(full).catch(() => undefined);
      const name = target ? decodeGitPath(target) : "";
      return name.startsWith("refs/") ? `ref: ${name}` : UNREADABLE;
    }
    if (kind !== "file") return UNREADABLE;
    try {
      return decodeGitPath(await readFile(this.files, full)).trim();
    } catch {
      return UNREADABLE;
    }
  }

  /**
   * Whether the entry at `path` is a FIFO, socket or device: present, but no content git
   * can add (`getEntry` gives undefined for it, as for a missing path).
   */
  async isSpecialFile(path: string): Promise<boolean> {
    if (!this.files.lstat) return false;
    const link = await this.files.lstat(joinPath(this.rootPath, path)).catch(() => undefined);
    return link?.kind === "other";
  }

  /** Whether `dir` holds a repository: HEAD, objects and refs (git's `is_git_directory`). */
  private async isRepositoryDir(dir: string): Promise<boolean> {
    const kindAt = (name: string) => this.kindOf(joinPath(dir, name)).catch(() => undefined);
    // a HEAD that is a file (or a link, core.preferSymlinkRefs): never a FIFO, which
    // would block the read
    const headKind = await kindAt("HEAD");
    return (
      (headKind === "file" || headKind === "symlink") &&
      (await kindAt("objects")) === "directory" &&
      (await kindAt("refs")) === "directory"
    );
  }

  /**
   * The repository checked out at the gitlink `path` (a populated submodule) as a working
   * copy over the same FilesApi: its objects, refs, index, config and worktree. Undefined
   * when it is not populated (no git directory with HEAD, objects and refs) or its
   * repository lies beyond this FilesApi's root. With `options.name`, a path without a
   * repository opens `<gitdir>/modules/<name>` instead (git's `submodule_to_gitdir`).
   */
  async openGitlink(
    path: string,
    options: { name?: string } = {},
  ): Promise<WorkingCopy | undefined> {
    let gitDir = await this.gitlinkDir(path);
    if (gitDir !== undefined && !(await this.isRepositoryDir(gitDir))) gitDir = undefined;
    if (gitDir === undefined) {
      // submodule_to_gitdir: no repository at the path, the one kept under modules/<name>
      const name = options.name;
      if (
        name === undefined ||
        this.gitDir === undefined ||
        name === "" ||
        name.split(/[/\\]/).some((part) => part === "..")
      ) {
        return undefined;
      }
      gitDir = joinPath(this.gitDir, "modules", name);
      if (!(await this.isRepositoryDir(gitDir))) return undefined;
    }
    const files = this.rootFiles;
    const environment = this.environment ? { environment: this.environment } : {};
    // only the superproject's object database honours $GIT_ALTERNATE_OBJECT_DIRECTORIES (git
    // opens a submodule's without ODB_NEW_HONOR_ENV)
    const { history } = await createGitFilesBackend({
      files,
      gitDir,
      ...environment,
      alternatesFromEnvironment: false,
    });
    const staging = new FileStagingStore(files, joinPath(gitDir, "index"));
    await staging.read();
    const config = await createWorkingCopyConfig(
      {
        read: async (p) => ((await files.exists(p)) ? readFile(files, p) : undefined),
        write: (p, content) => files.write(p, [content]),
      },
      gitDir,
      undefined,
      environment,
    );
    const worktree = new FileWorktree({
      files,
      rootPath: joinPath(this.rootPath, path),
      gitDir,
      blobs: history.blobs,
      trees: history.trees,
      newHasher: this.newHasher,
      ...environment,
    });
    return new MemoryWorkingCopy({
      history,
      checkout: new MemoryCheckout({ staging }),
      worktree,
      config,
    });
  }

  async openRepository(
    location: string,
    options: OpenRepositoryOptions = {},
  ): Promise<OpenedRepository | undefined> {
    const base = this.locate(location);
    if (base === undefined) return undefined;
    // enter_repo (strict = 0): each suffix in turn, a gitfile followed
    for (const suffix of ["/.git", "", ".git/.git", ".git"]) {
      const candidate = resolveDots(`${base}${suffix}`);
      if (candidate === undefined) continue;
      let gitDir: string | undefined = candidate;
      let gitfileTarget: string | undefined;
      const kind = await this.kindOf(gitDir).catch(() => undefined);
      if (kind === "file") {
        const target = await this.readGitfile(gitDir).catch(() => undefined);
        if (!target) continue;
        const parent = gitDir.slice(0, Math.max(gitDir.lastIndexOf("/"), 0));
        gitDir = target.startsWith("/") ? this.locate(target) : resolveDots(`${parent}/${target}`);
        if (gitDir === undefined) continue;
        gitfileTarget = gitDir;
      } else if (kind !== "directory") continue;
      // is_git_directory: HEAD here, objects and refs here or in the `commondir` named
      const found = await this.gitDirectoryAt(gitDir, gitDir).catch(() => undefined);
      if (found?.state !== "repository") continue;
      const opened = await this.openRepositoryAt(found.gitDir, found.commonDir, options);
      // enter_repo: die_upon_dubious_ownership(gitfile, NULL, used_path), the gitfile's
      // target and the path entered (the gitfile itself when there is one)
      const files = this.rootFiles;
      const environment = this.environment;
      const cwd = hostPathOf(files, this.rootPath || "/");
      const compatibility = options.compatibility ?? "2.56";
      opened.checkOwnership = async (check = {}) => {
        if (check.gitDirOnly) {
          // clone.c's copy_or_link_directory: ensure_valid_ownership(NULL, NULL, src_repo)
          const dir = gitfileTarget ?? candidate;
          await assertValidOwnership({
            files,
            ...(environment ? { environment } : {}),
            gitDir: dir,
            reportPath: check.path ?? hostPathOf(files, dir),
            cwd,
            compatibility,
          });
          return;
        }
        await assertValidOwnership({
          files,
          ...(environment ? { environment } : {}),
          ...(gitfileTarget !== undefined ? { gitfile: gitfileTarget } : {}),
          gitDir: candidate,
          reportPath: check.path ?? hostPathOf(files, gitfileTarget ?? candidate),
          cwd,
          compatibility,
        });
      };
      if (options.checkOwnership !== false) await opened.checkOwnership();
      return opened;
    }
    return undefined;
  }

  /**
   * The repository whose git directory is `gitDir` and repository directory `commonDir`
   * (the same, unless `gitDir` is a linked worktree's): its history (HEAD the git
   * directory's own), configuration and worktrees.
   */
  private async openRepositoryAt(
    gitDir: string,
    commonDir: string,
    options: OpenRepositoryOptions,
  ): Promise<OpenedRepository> {
    const files = this.rootFiles;
    const environment = this.environment ? { environment: this.environment } : {};
    const includes =
      options.configIncludes === undefined ? {} : { includes: options.configIncludes };
    const backend = await createGitFilesBackend({
      files,
      gitDir: commonDir,
      ...environment,
      ...(options.configIncludes === undefined ? {} : { configIncludes: options.configIncludes }),
      // another repository: git runs its upload-pack/receive-pack without local_repo_env
      alternatesFromEnvironment: false,
      ...(options.alternates === false ? { alternates: false } : {}),
    });
    const worktrees = await openGitLinkedWorktrees({
      files,
      gitDir,
      history: backend.history,
      ...environment,
      ...includes,
    });
    let history = backend.history;
    if (gitDir !== commonDir) {
      // a linked worktree's git directory: its own HEAD over the repository's refs
      const current = (await worktrees.list().catch(() => [])).find((wt) => wt.current);
      if (current) {
        const base = backend.history;
        history = createHistoryFromStores({
          blobs: base.blobs,
          trees: base.trees,
          commits: base.commits,
          tags: base.tags,
          refs: await worktrees.refsOf(current),
          objects: base.objects,
          packs: base.packs,
        });
      }
    }
    // the storage's root directory and links, for includes (git's host rule, or confined);
    // the git directory opened as the host names it (includeIf.gitdir), its own HEAD
    // (includeIf.onbranch) and, for a linked worktree's, its config.worktree
    const root = files.rootDirectory?.replace(/\/+$/, "");
    const gitDirHost = root !== undefined ? `${root}/${gitDir.replace(/^\/+/, "")}` : undefined;
    const config = await createWorkingCopyConfig(configFilesApiOf(files), commonDir, undefined, {
      ...environment,
      ...includes,
      ...(gitDirHost !== undefined ? { gitDirPath: gitDirHost.replace(/\/+$/, "") } : {}),
      ...(gitDir !== commonDir
        ? {
            worktreeConfigPath: `${gitDir}/config.worktree`,
            readHead: async () => {
              const head = (await files.exists(`${gitDir}/HEAD`))
                ? decodeGitPath(await readFile(files, `${gitDir}/HEAD`)).trim()
                : undefined;
              return head?.startsWith("ref: ") ? head.slice(5).trim() : undefined;
            },
          }
        : {}),
    });
    const textOf = (o: { text: string | undefined }) => o.text ?? null;
    return {
      history,
      gitDir,
      commonDir,
      // a linked worktree's git directory has a working tree (git runs there as non-bare)
      bare: gitDir === commonDir && (await this.isBareRepository(gitDir)),
      config: {
        getAll: (key) => config.getAllWithOrigin(key).map(textOf),
        list: () => config.listWithOrigin().map((e) => ({ key: e.key, value: textOf(e) })),
        listWithOrigin: () =>
          config.listWithOrigin().map((e) => ({
            key: e.key,
            value: textOf(e),
            ...(e.file !== undefined ? { file: e.file } : {}),
            ...(e.line !== undefined ? { line: e.line } : {}),
            ...(e.scope !== undefined ? { scope: e.scope } : {}),
          })),
      },
      worktrees,
      files,
    };
  }

  /**
   * A local remote's location in this FilesApi: relative to the worktree top, absolute in
   * the real directory the FilesApi is rooted at (`rootDirectory`; from its root when that
   * is unknown). Undefined beyond the root.
   */
  private locate(location: string): string | undefined {
    const windows = this.windowsPaths;
    const path = windows ? location.replace(/\\/g, "/") : location;
    const absolute = path.startsWith("/") || (windows && /^[A-Za-z]:\//.test(path));
    if (!absolute) return resolveDots(joinPath(this.rootPath || "/", path));
    const root = this.rootFiles.rootDirectory;
    if (!root) return resolveDots(path);
    const realTarget = resolveDots(path);
    const realRoot = resolveDots(windows ? root.replace(/\\/g, "/") : root);
    if (realTarget === undefined || realRoot === undefined) return undefined;
    const same = (a: string, b: string) =>
      windows ? a.toLowerCase() === b.toLowerCase() : a === b;
    const top = realRoot.endsWith("/") ? realRoot.slice(0, -1) : realRoot;
    if (same(realTarget, top)) return "/";
    if (!same(realTarget.slice(0, top.length + 1), `${top}/`)) return undefined;
    return realTarget.slice(top.length);
  }

  /** git's `is_bare_repository` of another repository: `core.bare`, else no `.git` name. */
  private async isBareRepository(gitDir: string): Promise<boolean> {
    const configPath = joinPath(gitDir, "config");
    if ((await this.kindOf(configPath).catch(() => undefined)) === "file") {
      const text = new TextDecoder().decode(await readFile(this.rootFiles, configPath));
      let core = false;
      for (const raw of text.split("\n")) {
        const line = raw.replace(/[#;].*$/, "").trim();
        const section = /^\[\s*([^\]\s"]+)/.exec(line);
        if (section) {
          core = section[1]?.toLowerCase() === "core";
          continue;
        }
        const bare = core ? /^bare\s*(?:=\s*(.*))?$/i.exec(line) : null;
        if (bare) {
          const value = (bare[1] ?? "true").trim().toLowerCase();
          if (["true", "yes", "on", "1"].includes(value)) return true;
          if (["false", "no", "off", "0", ""].includes(value)) return false;
        }
      }
    }
    return !/(^|\/)\.git$/.test(gitDir);
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
    if (await this.files.move(fullOldPath, fullNewPath)) return;
    // the FilesApi says only that nothing moved: its errno is told where it can be found
    const code = !(await this.kindOf(fullOldPath).catch(() => undefined)) ? "ENOENT" : "EPERM";
    throw Object.assign(new Error(`${code}: cannot move '${oldPath}' to '${newPath}'`), { code });
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

    // the files are smudged with the tree's attributes (git's read-tree -u)
    const attributes = attributesIndexOfTree(this.trees, treeId);
    await this.batch(() =>
      this.checkoutTreeRecursive(treeEntries, "", result, options, attributes),
    );

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

    const attributes = attributesIndexOfTree(this.trees, treeId);
    await this.batch(() =>
      this.checkoutTreeRecursive(treeEntries, "", result, { ...options, paths }, attributes),
    );

    return result;
  }

  private async checkoutTreeRecursive(
    tree: AsyncIterable<{ name: string; mode: number; id: ObjectId }>,
    prefix: string,
    result: WorktreeCheckoutResult,
    options: WorktreeCheckoutOptions | undefined,
    attributes: AttributesIndex,
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
          await this.checkoutTreeRecursive(subtree, path, result, options, attributes);
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
              attributes: { direction: "checkout", index: attributes },
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

  getGitDir(): string | undefined {
    return this.gitDir;
  }

  getFiles(): WorktreeFilesApi {
    return this.rootFiles;
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

  /**
   * Whether the directory at `path` (a worktree path) is a nested repository, as git's
   * `treat_directory` decides: `is_nonbare_repository_dir` ({@link nestedGitDir}: a `.git`
   * directory with a valid HEAD, objects and refs, or a gitfile or link naming one), unless
   * its `.git` resolves to the superproject's own git directory (git compares the real
   * paths: a `.git` link to it). An empty `.git` directory, a gitfile holding garbage or
   * naming no repository is not one: the directory is walked as any other. What cannot be
   * checked here (a place beyond the FilesApi's root, an unreadable entry) counts as one,
   * so nothing is added or removed on a guess.
   */
  private async hasGitDirectory(path: string): Promise<boolean> {
    let repo: NestedGitDir;
    try {
      repo = await this.nestedGitDir(path);
    } catch {
      // an empty commondir (git dies there): what may be a repository
      return true;
    }
    if (repo.state === "none") return false;
    if (repo.state === "repository" && this.gitDir !== undefined) {
      const real = await this.realDotGit(path);
      const own = resolveDots(joinPath("/", this.gitDir));
      if (real !== undefined && real === own) return false;
    }
    return true;
  }

  /**
   * The path the `.git` of `path` resolves to (git's `real_pathdup`), its last component
   * followed where it is a link; undefined when it lies beyond this FilesApi.
   */
  private async realDotGit(path: string): Promise<string | undefined> {
    const dotGit = joinPath(this.rootPath, path, ".git");
    if ((await this.kindOrError(dotGit)) !== "symlink") return resolveDots(dotGit);
    const bytes = await this.files.readlink?.(dotGit).catch(() => undefined);
    const target = bytes ? this.gitfileTarget(path, decodeGitPath(bytes)) : undefined;
    return target === undefined ? undefined : resolveDots(joinPath("/", target));
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
    if (this.ignoreCaseReader) {
      let ignoreCase = false;
      try {
        ignoreCase = this.ignoreCaseReader();
      } catch {
        // an unreadable configuration: case-sensitive, git's default
      }
      this.ignoreManager.setIgnoreCase?.(ignoreCase);
    }
    if (this.ignoreManager.setExcludeFile) {
      const read = async (path: string) => {
        try {
          if ((await this.files.lstat?.(path))?.kind === "symlink") return undefined;
          if (!(await this.files.exists(path))) return undefined;
          return decodeGitPatternFile(await readFile(this.files, path));
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
        this.globalExcludesFile
          ? await read(this.globalExcludesFile)
          : await this.excludesReader?.().catch(() => undefined),
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
    let opened = false;
    try {
      if ((await files.lstat?.(gitignorePath))?.kind !== "symlink") {
        if (await files.exists(gitignorePath)) {
          opened = true;
          text = decodeGitPatternFile(await readFile(files, gitignorePath));
        }
      }
    } catch {
      text = undefined;
    }
    // a file git cannot open (absent, or a link it never follows) is read from the index
    // when its entry is skip-worktree (add_patterns' read_skip_worktree_file_from_index)
    if (!opened && this.skipWorktreeIgnoreReader) {
      const indexPath = relativePath ? `${relativePath}/.gitignore` : ".gitignore";
      text = await this.skipWorktreeIgnoreReader(indexPath).catch(() => undefined);
    }
    if (this.ignoreManager.setIgnoreFile) this.ignoreManager.setIgnoreFile(relativePath, text);
    else if (text !== undefined) this.ignoreManager.addIgnoreFile(relativePath, text);
  }

  private async tryLoadInfoExclude(gitDir: string): Promise<void> {
    const excludePath = joinPath(gitDir, "info", "exclude");

    try {
      if (await this.files.exists(excludePath)) {
        const content = await readFile(this.files, excludePath);
        const text = decodeGitPatternFile(content);
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
        const text = decodeGitPatternFile(content);
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
/** A ref file of a nested repository that cannot be read here. */
const UNREADABLE = Symbol("unreadable");

/** What git's `is_nonbare_repository_dir` finds at a directory, its git directories with it. */
type NestedGitDir =
  | { state: "repository"; gitDir: string; commonDir: string }
  | { state: "none" | "unknown"; gitDir?: undefined; commonDir?: undefined };

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

/** What a walk takes of a directory `listKinds` reported (it stats none). */
const DIRECTORY_STATS: LinkStats = { kind: "directory", size: 0, lastModified: 0 };

/**
 * The worktree entry of a file or link a stat pass found: plain fields, with `name` and
 * `isIgnored` computed on first use (getters on the prototype, not a closure per entry).
 */
class StatEntry implements WorktreeEntry {
  readonly size: number;
  readonly mtime: number;
  readonly ctime: number | undefined;
  readonly mtimeNs: number | undefined;
  readonly ctimeNs: number | undefined;
  readonly dev: number | undefined;
  readonly ino: number | undefined;
  readonly uid: number | undefined;
  readonly gid: number | undefined;
  readonly isDirectory = false;
  // ES private fields: no own enumerable properties beyond the entry's (a spread or a deep
  // comparison sees only those)
  #ignored: boolean | undefined;
  readonly #ignoreManager: IgnoreManager;

  constructor(
    readonly path: string,
    readonly mode: number,
    link: LinkStats,
    ignoreManager: IgnoreManager,
  ) {
    this.#ignoreManager = ignoreManager;
    this.size = link.size;
    this.mtime = link.lastModified;
    this.ctime = link.ctime;
    this.mtimeNs = link.mtimeNs;
    this.ctimeNs = link.ctimeNs;
    this.dev = link.dev;
    this.ino = link.ino;
    this.uid = link.uid;
    this.gid = link.gid;
  }

  get name(): string {
    const slash = this.path.lastIndexOf("/");
    return slash < 0 ? this.path : this.path.slice(slash + 1);
  }

  get isIgnored(): boolean {
    this.#ignored ??= this.#ignoreManager.isIgnored(this.path, false);
    return this.#ignored;
  }

  /**
   * Every field as a plain object, the getters included: `{ ...entry }` copies only the own
   * fields and drops the prototype getters `name` and `isIgnored`, so serialise or copy an
   * entry through this.
   */
  toJSON(): WorktreeEntry {
    return {
      path: this.path,
      name: this.name,
      mode: this.mode,
      size: this.size,
      mtime: this.mtime,
      ctime: this.ctime,
      mtimeNs: this.mtimeNs,
      ctimeNs: this.ctimeNs,
      dev: this.dev,
      ino: this.ino,
      uid: this.uid,
      gid: this.gid,
      isDirectory: false,
      isIgnored: this.isIgnored,
    };
  }
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

/** Whether `path` lies below `root` (both FilesApi paths; "" or "/" is the whole tree). */
function isInside(path: string, root: string): boolean {
  const norm = (p: string) => p.replace(/^(\.?\/)+/, "").replace(/\/+$/, "");
  const p = norm(path);
  const r = norm(root);
  if (p.split("/").includes("..")) return false;
  if (r === "") return true;
  return p.startsWith(`${r}/`);
}

/** git's `relative_path(path, base)` for two paths of one FilesApi. */
function relativeFilesPath(path: string, base: string): string {
  const a = path.split("/").filter((p) => p && p !== ".");
  const b = base.split("/").filter((p) => p && p !== ".");
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  const rel = [...b.slice(k).map(() => ".."), ...a.slice(k)].join("/");
  return rel || ".";
}
