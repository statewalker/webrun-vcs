/**
 * git's repository discovery (setup.c's `setup_git_directory_gently` and
 * `repo_discovery_find_dir`) with its safety checks: from a directory up to the storage's
 * root, the first `.git` gitfile or directory, or a bare repository, is the repository, and
 * it is used only when its owner is the current user or `safe.directory` lists it, and (a
 * bare one) when `safe.bareRepository` allows it.
 */

import { decodeGitPath, parseGitBool } from "@statewalker/vcs-utils/encoding";
import {
  type FilesApi,
  joinPath,
  normalizePath,
  type PosixFilesApi,
  readFile,
} from "@statewalker/vcs-utils/files";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";

import { parseGitfile } from "../workspace/git-dir/index.js";
import { readProtectedConfig } from "./protected-config.js";
import {
  allowedBareRepository,
  assertValidOwnership,
  hostPathOf,
  isImplicitBareRepository,
  type RepositorySafetyCompatibility,
  UnsafeBareRepositoryError,
} from "./repository-ownership.js";

/** Options of {@link discoverRepository}. */
export interface DiscoverRepositoryOptions {
  /** The storage to look in */
  files: FilesApi;
  /** The directory discovery starts from (git's current directory), a path of `files` */
  cwd?: string;
  /** The host: the user's protected configuration, effective uid, `realPath` */
  environment?: GitHostEnvironment;
  /**
   * The git directory given explicitly (`$GIT_DIR`, `--git-dir`): no discovery and, as in
   * git, neither the ownership nor the bare-repository check
   */
  gitDir?: string;
  /**
   * Check the repository's owner as git does (default true; a no-op where owners cannot be
   * told). False for a library that opens repositories it knows to be its own.
   */
  checkOwnership?: boolean;
  /** The rules of this git version where they differ (default 2.56) */
  compatibility?: RepositorySafetyCompatibility;
}

/** The repository {@link discoverRepository} found. */
export interface DiscoveredRepository {
  /** Its git directory, a path of the storage */
  gitDir: string;
  /** Its worktree top (the directory holding `.git`); undefined for a bare repository */
  workTree?: string;
  /** The gitfile it was reached through */
  gitfile?: string;
  /** Found as a bare repository */
  bare: boolean;
  /** git's warnings on the way (`safe.directory '<x>' not absolute`) */
  warnings: string[];
  /**
   * With `$GIT_DIR`/`$GIT_WORK_TREE` in the environment ({@link setupGitDirectory}): the
   * common directory, index file and objects directory the variables give. Opening a backend
   * or staging at them is the caller's: `createGitFilesBackend` still takes `gitDir` alone.
   */
  commonDir?: string;
  indexFile?: string;
  objectDirectory?: string;
}

/** No repository at or above the directory (git's exit 128). */
export class NotAGitRepositoryError extends Error {
  readonly exitCode = 128;
  constructor(message = "fatal: not a git repository (or any of the parent directories): .git") {
    super(message);
    this.name = "NotAGitRepositoryError";
  }
}

/**
 * Discovery stopped at a file system boundary (git's `GIT_DIR_HIT_MOUNT_POINT`, exit 128):
 * the parent of the mount point lies on another device, and `$GIT_DISCOVERY_ACROSS_FILESYSTEM`
 * is not set.
 */
export class FilesystemBoundaryError extends NotAGitRepositoryError {
  constructor(
    /** The directory git names: the first one above the boundary, as the host names it */
    readonly mountPoint: string,
  ) {
    super(
      `fatal: not a git repository (or any parent up to mount point ${mountPoint})\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).`,
    );
    this.name = "FilesystemBoundaryError";
  }
}

/**
 * Finds the repository `cwd` is in, as git's setup does: in each directory from `cwd` up to
 * the storage's root, a `.git` gitfile (its target must be a git directory), a `.git`
 * directory that is one, then the directory itself as a bare repository. A found
 * repository whose worktree, git directory or gitfile another user owns is refused with
 * git's `DubiousOwnershipError` unless the protected `safe.directory` lists it (its worktree,
 * or a bare repository's directory); a bare one is refused with `UnsafeBareRepositoryError`
 * while `safe.bareRepository` is `explicit`, unless it is a `.git` directory or a linked
 * worktree's or submodule's git directory inside one (2.44+). An explicit `gitDir` is used
 * as given.
 *
 * Discovery climbs no higher than the environment's `ceilingDirectories`
 * (`$GIT_CEILING_DIRECTORIES`: the directories below the longest ceiling above `cwd` are
 * searched, the ceiling itself not; `NotAGitRepositoryError` past it) and, unless
 * `discoveryAcrossFilesystem`, stops where the device id of the FilesApi's `lstat` changes
 * (`FilesystemBoundaryError`; no check where the storage reports no device). As git's
 * `strbuf_getcwd`, it climbs the physical directory: `cwd` is resolved to its real path
 * (the environment's `realPath`) and mapped back into the FilesApi first, so a `cwd` reached
 * through a symbolic link is searched, and counted against the ceiling, where it really is.
 *
 * The protection is opt-in: a library caller gets git's local checks only by discovering the
 * repository here first. Constructing a `FileWorktree` or calling `createGitFilesBackend`
 * directly opens whatever it is given, unchecked. The owner checks need an `environment`
 * with `effectiveUid` (the Node host sets it from `process.geteuid()`) and a FilesApi whose
 * `lstat` reports owners; without either they pass. The protected configuration is read
 * only when an owner check fails or a bare repository is found, as git reads it.
 *
 * @example
 * ```typescript
 * const files = createNodeFilesApi({ rootDir: "/" });
 * const found = await discoverRepository({ files, cwd: process.cwd(), environment });
 * const { history } = await createGitFilesBackend({ files, gitDir: found.gitDir, environment });
 * ```
 */
export async function discoverRepository(
  options: DiscoverRepositoryOptions,
): Promise<DiscoveredRepository> {
  const { environment } = options;
  if (options.gitDir !== undefined) {
    const gitDir = normalizePath(options.gitDir);
    return { gitDir, bare: !/\/\.git$/.test(gitDir), warnings: [] };
  }
  // $GIT_DIR / $GIT_WORK_TREE: git's whole setup (setup_explicit_git_dir and the worktree
  // settings of a discovered repository)
  if (environment?.gitDir !== undefined || environment?.workTree !== undefined) {
    const setup = await setupGitDirectory(options);
    return {
      gitDir: setup.gitDir,
      ...(setup.workTree !== undefined ? { workTree: setup.workTree } : {}),
      ...(setup.gitfile !== undefined ? { gitfile: setup.gitfile } : {}),
      bare: setup.workTree === undefined,
      warnings: setup.warnings,
      commonDir: setup.commonDir,
      indexFile: setup.indexFile,
      objectDirectory: setup.objectDirectory,
    };
  }
  const found = await discoverFrom(options);
  return {
    gitDir: found.gitDir,
    ...(found.kind === "discovered" ? { workTree: found.dir } : {}),
    ...(found.gitfile !== undefined ? { gitfile: found.gitfile } : {}),
    bare: found.kind === "bare",
    warnings: found.warnings,
  };
}

/** What setup.c's `setup_git_directory_gently_1` found by climbing. */
interface DiscoveryFind {
  /** GIT_DIR_DISCOVERED (a `.git` in `dir`) or GIT_DIR_BARE (`dir` is the repository) */
  kind: "discovered" | "bare";
  /** The directory the repository was found in */
  dir: string;
  /** The git directory: `dir/.git`, a gitfile's target, or `dir` itself */
  gitDir: string;
  gitfile?: string;
  warnings: string[];
  /** The physical current directory discovery started from (a FilesApi path) */
  cwd: string;
}

/**
 * The climb of {@link discoverRepository} (`setup_git_directory_gently_1` without `$GIT_DIR`):
 * the first directory from `cwd` up holding a `.git` (gitfile or git directory) or being a
 * bare repository, its ownership and `safe.bareRepository` checked, ceilings and file system
 * boundaries obeyed.
 */
async function discoverFrom(options: DiscoverRepositoryOptions): Promise<DiscoveryFind> {
  const { files, environment } = options;
  const compatibility = options.compatibility ?? "2.56";
  const check = options.checkOwnership !== false;
  // strbuf_getcwd: git climbs the physical directory (a cwd reached through a symbolic link
  // is searched where it really is, its ceiling and device counted there)
  const start = await physicalPath(files, environment, normalizePath(options.cwd ?? "/"));
  let dir = start;
  const cwdHost = hostPathOf(files, dir);
  // GIT_CEILING_DIRECTORIES: how many directories above cwd may be searched
  const levels = await ceilingLevels(environment, cwdHost);
  // one_filesystem: the device of cwd, compared with each directory climbed to (lstat is
  // stat here: no component of the physical path is a link)
  const deviceOf = async (path: string) =>
    (await (files as PosixFilesApi).lstat?.(path).catch(() => undefined))?.dev;
  const device = environment?.discoveryAcrossFilesystem ? undefined : await deviceOf(dir);
  let level = 0;
  for (;;) {
    const dotGit = joinPath(dir, ".git");
    const kind = (await files.stats(dotGit).catch(() => undefined))?.kind;
    let gitDir: string | undefined;
    let gitfile: string | undefined;
    if (kind === "file") {
      const text = decodeGitPath(await readFile(files, dotGit));
      const target = parseGitfile(text);
      if (target === undefined) {
        throw new Error(`fatal: invalid gitfile format: ${hostPathOf(files, dotGit)}`);
      }
      const resolved = gitfileTarget(files, dir, target);
      if (resolved === undefined || !(await isGitDirectory(files, resolved))) {
        throw new Error(`fatal: not a git repository: ${target}`);
      }
      gitDir = resolved;
      gitfile = dotGit;
    } else if (kind === "directory" && (await isGitDirectory(files, dotGit))) {
      gitDir = dotGit;
    }
    if (gitDir !== undefined) {
      const warnings = check
        ? await assertValidOwnership({
            files,
            ...(environment ? { environment } : {}),
            ...(gitfile !== undefined ? { gitfile } : {}),
            worktree: dir,
            gitDir,
            reportPath: hostPathOf(files, dir),
            cwd: cwdHost,
            compatibility,
            // read only once the owners do not match, as git reads it
          })
        : [];
      return {
        kind: "discovered",
        dir,
        gitDir,
        ...(gitfile !== undefined ? { gitfile } : {}),
        warnings,
        cwd: start,
      };
    }
    if (await isGitDirectory(files, dir)) {
      const host = hostPathOf(files, dir);
      // the protected configuration, read here for safe.bareRepository (get_allowed_bare_repo)
      const entries = await readProtectedConfig(environment);
      if (
        allowedBareRepository(entries, environment?.breakingChanges) === "explicit" &&
        !isImplicitBareRepository(host, compatibility)
      ) {
        throw new UnsafeBareRepositoryError(host);
      }
      const warnings = check
        ? await assertValidOwnership({
            files,
            ...(environment ? { environment } : {}),
            gitDir: dir,
            reportPath: host,
            cwd: cwdHost,
            compatibility,
            protectedConfig: entries,
          })
        : [];
      return { kind: "bare", dir, gitDir: dir, warnings, cwd: start };
    }
    if (dir === "/") throw new NotAGitRepositoryError();
    if (levels !== undefined && level >= levels) throw new NotAGitRepositoryError();
    dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
    level++;
    if (device !== undefined) {
      const dev = await deviceOf(dir);
      if (dev !== undefined && dev !== device) {
        throw new FilesystemBoundaryError(hostPathOf(files, dir));
      }
    }
  }
}

/** The repository setup.c's `setup_git_directory_gently` arrives at. */
export interface GitDirectorySetup {
  /** The git directory (a FilesApi path; a gitfile `$GIT_DIR` names is followed) */
  gitDir: string;
  /** The common git directory: `$GIT_COMMON_DIR`, else `commondir`'s, else {@link gitDir} */
  commonDir: string;
  /** The worktree top; undefined without one (a bare repository, or `core.bare`) */
  workTree?: string;
  /**
   * git's current directory after the setup: the worktree top when the original directory is
   * inside it (git's `chdir_to_toplevel`), else the original (physical) directory
   */
  cwd: string;
  /**
   * The original directory relative to the worktree top with a trailing `/` (`sub/dir/`);
   * undefined at the top, outside the worktree, or without one (git's `(null)` prefix)
   */
  prefix?: string;
  /** The index file: `$GIT_INDEX_FILE` (relative to {@link cwd}), else `<git dir>/index` */
  indexFile: string;
  /** The objects: `$GIT_OBJECT_DIRECTORY` (relative to {@link cwd}), else `<common dir>/objects` */
  objectDirectory: string;
  /** The gitfile the repository was reached through (`.git` file, or `$GIT_DIR` naming one) */
  gitfile?: string;
  /** `git rev-parse --is-inside-git-dir` */
  insideGitDir: boolean;
  /** `git rev-parse --is-inside-work-tree` */
  insideWorkTree: boolean;
  /**
   * `git rev-parse --is-bare-repository`: no worktree, and `core.bare` not false
   * (`is_bare_repository`)
   */
  bare: boolean;
  /**
   * Both `core.bare` and `core.worktree` are set for an explicit or settings-driven setup:
   * git warns and has no worktree (`work_tree_config_is_bogus`); a command needing the
   * worktree then dies "unable to set up work tree using invalid config"
   */
  workTreeConfigIsBogus?: boolean;
  /** git's warnings on the way (`safe.directory`, `core.bare and core.worktree do not make sense`) */
  warnings: string[];
}

/** A failure of setup git reports with `fatal:` and exit 128 (a bad `$GIT_DIR` or worktree). */
export class GitSetupError extends Error {
  readonly exitCode = 128;
  constructor(message: string) {
    super(message);
    this.name = "GitSetupError";
  }
}

/**
 * git's repository setup (setup.c's `setup_git_directory_gently`) honouring the
 * repository-location variables of the environment: `$GIT_DIR` (`setup_explicit_git_dir`,
 * relative to `cwd`, a gitfile followed; no discovery, so neither ownership nor ceiling
 * checks), `$GIT_WORK_TREE` (relative to `cwd`, it overrides `core.worktree` and `core.bare`),
 * `core.worktree` (relative to the git directory; it takes effect with `$GIT_DIR`, and with a
 * discovered repository too), `core.bare`, `$GIT_IMPLICIT_WORK_TREE`, `$GIT_COMMON_DIR`,
 * `$GIT_INDEX_FILE` and `$GIT_OBJECT_DIRECTORY` (the last three relative to the directory
 * git ends up in), with t1510-repo-setup.sh's rules: an explicit git directory without a
 * worktree setting takes `cwd` as its worktree, a discovered repository found as a bare one
 * has none, and git moves to the worktree top when `cwd` lies inside it (the `prefix` is
 * the way back). Without `$GIT_DIR` the repository is found as {@link discoverRepository}
 * finds it (ownership, `safe.bareRepository`, ceilings, file system boundaries). Linked
 * worktrees (`commondir`) ignore `core.bare` and `core.worktree` unless
 * `extensions.worktreeConfig` points them at `config.worktree`, as git's
 * `check_repository_format_gently`.
 *
 * `options.gitDir` wins over the environment's `$GIT_DIR`.
 *
 * @example
 * ```typescript
 * const environment = createNodeGitHostEnvironment(); // GIT_DIR=../repo.git GIT_WORK_TREE=..
 * const files = createNodeFilesApi({ rootDir: "/" });
 * const setup = await setupGitDirectory({ files, cwd: process.cwd(), environment });
 * // setup.gitDir, setup.workTree, setup.prefix ("sub/"), setup.indexFile, ...
 * ```
 */
export async function setupGitDirectory(
  options: DiscoverRepositoryOptions,
): Promise<GitDirectorySetup> {
  const { files, environment } = options;
  const cwd = await physicalPath(files, environment, normalizePath(options.cwd ?? "/"));
  const paths = new SetupPaths(files, environment);
  const explicit = options.gitDir ?? environment?.gitDir;
  const workTreeEnv = environment?.workTree;
  let core: Omit<GitDirectorySetup, "commonDir" | "indexFile" | "objectDirectory" | "bare">;
  let bareConfig: boolean | undefined;
  if (explicit !== undefined) {
    const r = await setupExplicit(paths, cwd, explicit, workTreeEnv, environment?.implicitWorkTree);
    core = r.setup;
    bareConfig = r.bareConfig;
  } else {
    const found = await discoverFrom(options);
    const format = await worktreeSettings(files, found.gitDir);
    bareConfig = format.bare;
    if (workTreeEnv !== undefined || format.workTree !== undefined) {
      // --work-tree without --git-dir (or core.worktree): the discovered one made explicit
      const r = await setupExplicit(
        paths,
        cwd,
        hostPathOf(files, found.gitDir),
        workTreeEnv,
        found.kind === "bare" ? false : environment?.implicitWorkTree,
        format,
      );
      core = { ...r.setup, warnings: [...found.warnings, ...r.setup.warnings] };
    } else if (found.kind === "bare" || format.bare === true) {
      // #16.2, #17.2, ...: no worktree; git comes back to cwd
      core = {
        gitDir: found.gitDir,
        cwd,
        insideGitDir: found.kind === "bare" || isInside(cwd, found.gitDir),
        insideWorkTree: false,
        ...(found.gitfile !== undefined ? { gitfile: found.gitfile } : {}),
        warnings: found.warnings,
      };
    } else {
      // #0, #1, #5, #8, ...: the directory holding .git is the worktree, git moves there
      const top = found.dir;
      const rest = cwd === top ? "" : cwd.slice(top === "/" ? 1 : top.length + 1);
      core = {
        gitDir: found.gitDir,
        workTree: top,
        cwd: top,
        ...(rest ? { prefix: `${rest}/` } : {}),
        insideGitDir: false,
        insideWorkTree: true,
        ...(found.gitfile !== undefined ? { gitfile: found.gitfile } : {}),
        warnings: found.warnings,
      };
    }
  }
  // setup_git_env: the variables read as given, relative to where git now is
  const at = (value: string) => paths.resolve(core.cwd, value);
  const commonDir =
    environment?.commonDir !== undefined
      ? at(environment.commonDir)
      : await commonDirOf(files, core.gitDir);
  return {
    ...core,
    commonDir,
    indexFile:
      environment?.indexFile !== undefined
        ? at(environment.indexFile)
        : joinPath(core.gitDir, "index"),
    objectDirectory:
      environment?.objectDirectory !== undefined
        ? at(environment.objectDirectory)
        : joinPath(commonDir, "objects"),
    bare: core.workTree === undefined && bareConfig !== false,
  };
}

/** core.bare and core.worktree as git's `check_repository_format_gently` takes them. */
interface WorktreeSettings {
  bare?: boolean;
  workTree?: string;
}

/**
 * `core.bare` and `core.worktree` of the repository's own config file (no includes, as
 * `read_repository_format`), from the common directory's; a linked worktree's git directory
 * (`commondir`) ignores both unless `extensions.worktreeConfig` is set, when its
 * `config.worktree` may set them.
 */
async function worktreeSettings(files: FilesApi, gitDir: string): Promise<WorktreeSettings> {
  const commonDir = await commonDirOf(files, gitDir);
  const read = async (path: string) => {
    if ((await files.stats(path).catch(() => undefined))?.kind !== "file") return undefined;
    return parseConfigText(decodeGitPath(await readFile(files, path)));
  };
  const main = (await read(joinPath(commonDir, "config"))) ?? new Map<string, ConfigValue>();
  let hasCommon = commonDir !== gitDir;
  const settings: WorktreeSettings = {};
  const apply = (entries: Map<string, ConfigValue>) => {
    const bare = entries.get("core.bare");
    if (bare !== undefined) {
      const value = bare === null ? true : parseGitBool(bare);
      if (value !== undefined) settings.bare = value;
    }
    const workTree = entries.get("core.worktree");
    if (typeof workTree === "string") settings.workTree = workTree;
  };
  const worktreeConfig = main.get("extensions.worktreeconfig");
  if (
    worktreeConfig !== undefined &&
    (worktreeConfig === null || parseGitBool(worktreeConfig) === true)
  ) {
    apply(main);
    const own = await read(joinPath(gitDir, "config.worktree"));
    if (own) apply(own);
    hasCommon = false;
  } else if (!hasCommon) apply(main);
  return settings;
}

/** A config value: the text after `=`, or null for a key without one (true). */
type ConfigValue = string | null;

/**
 * The last value of each key of a config file's text (section and key lower-cased, a
 * subsection kept): enough for the `core.*` and `extensions.*` setup reads.
 */
function parseConfigText(text: string): Map<string, ConfigValue> {
  const out = new Map<string, ConfigValue>();
  let section = "";
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (header) {
      section = header[1].toLowerCase();
      if (header[2] !== undefined) section += `.${header[2].replace(/\\(.)/g, "$1")}`;
      line = line.slice(header[0].length).trim();
      if (line === "") continue;
    }
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const m = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!m || section === "") continue;
    const key = `${section}.${m[1].toLowerCase()}`;
    out.set(key, m[2] === undefined ? null : configValueText(m[2]));
  }
  return out;
}

/** A config value's text: quotes removed, escapes applied, a trailing comment dropped. */
function configValueText(value: string): string {
  let out = "";
  let quoted = false;
  let pendingSpace = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (!quoted && (c === "#" || c === ";")) break;
    if (!quoted && (c === " " || c === "\t")) {
      pendingSpace += c;
      continue;
    }
    if (pendingSpace) {
      if (out !== "") out += pendingSpace;
      pendingSpace = "";
    }
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (c === "\\" && i + 1 < value.length) {
      const n = value[++i];
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === "b" ? "\b" : n;
      continue;
    }
    out += c;
  }
  return out;
}

/** git's `get_common_dir_noenv`: `commondir`, relative to the git directory unless absolute. */
async function commonDirOf(files: FilesApi, gitDir: string): Promise<string> {
  const path = joinPath(gitDir, "commondir");
  if ((await files.stats(path).catch(() => undefined))?.kind !== "file") return gitDir;
  const value = decodeGitPath(await readFile(files, path)).replace(/[\r\n]+$/, "");
  if (value === "") return gitDir;
  return gitfileTarget(files, gitDir, value) ?? gitDir;
}

/** Host paths of a setup: resolution against a directory, real paths, FilesApi mapping. */
class SetupPaths {
  constructor(
    readonly files: FilesApi,
    readonly environment: GitHostEnvironment | undefined,
  ) {}

  /** `value` (a host path, or relative to the FilesApi directory `dir`) as a FilesApi path */
  resolve(dir: string, value: string): string {
    const host = value.startsWith("/") ? value : `${hostPathOf(this.files, dir)}/${value}`;
    return this.filesPath(resolveDots(host) ?? "/");
  }

  /** A host path as a FilesApi path; a path outside the storage cannot be reached */
  filesPath(host: string): string {
    const root = (this.files as { rootDirectory?: string }).rootDirectory?.replace(/\/+$/, "");
    if (root === undefined || root === "") return normalizePath(host);
    if (host === root) return "/";
    if (host.startsWith(`${root}/`)) return normalizePath(host.slice(root.length));
    throw new GitSetupError(`fatal: '${host}' is outside the repository's storage`);
  }

  /**
   * git's `strbuf_realpath(..., die_on_error = 1)` of a FilesApi path: links resolved; the
   * last component may be missing, a missing directory above it dies "Invalid path"
   */
  async realPath(path: string): Promise<string> {
    const realPath = this.environment?.realPath;
    const host = hostPathOf(this.files, path);
    const exists = async (p: string) =>
      (await this.files.stats(p).catch(() => undefined)) !== undefined;
    if (path !== "/" && !(await exists(path))) {
      const parent = path.slice(0, path.lastIndexOf("/")) || "/";
      if (!(await exists(parent))) {
        // the first missing component, as git names it
        let missing = parent;
        for (;;) {
          const up = missing.slice(0, missing.lastIndexOf("/")) || "/";
          if (up === missing || (await exists(up))) break;
          missing = up;
        }
        throw new GitSetupError(
          `fatal: Invalid path '${hostPathOf(this.files, missing)}': No such file or directory`,
        );
      }
      const base = path.slice(path.lastIndexOf("/") + 1);
      return joinPath(await this.realPath(parent), base);
    }
    if (!realPath) return path;
    const real = await realPath(host).catch(() => undefined);
    if (real === undefined) return path;
    try {
      return this.filesPath(real);
    } catch {
      return path;
    }
  }
}

/** Whether FilesApi path `path` is `dir` or below it (git's `is_inside_dir`). */
function isInside(path: string, dir: string): boolean {
  return dir === "/" || path === dir || path.startsWith(`${dir}/`);
}

/**
 * setup.c's `setup_explicit_git_dir`: `gitDirValue` (`$GIT_DIR` as set, relative to `cwd`)
 * followed through a gitfile and checked; the worktree from `$GIT_WORK_TREE`, `core.bare`,
 * `core.worktree`, `$GIT_IMPLICIT_WORK_TREE` or `cwd`, in that order.
 */
async function setupExplicit(
  paths: SetupPaths,
  cwd: string,
  gitDirValue: string,
  workTreeEnv: string | undefined,
  implicitWorkTree: boolean | undefined,
  known?: WorktreeSettings,
): Promise<{
  setup: Omit<GitDirectorySetup, "commonDir" | "indexFile" | "objectDirectory" | "bare">;
  bareConfig: boolean | undefined;
}> {
  const { files } = paths;
  let gitDir = paths.resolve(cwd, gitDirValue);
  let gitfile: string | undefined;
  // read_gitfile: a regular file is a gitfile (its errors fatal); anything else is not
  if ((await files.stats(gitDir).catch(() => undefined))?.kind === "file") {
    const text = decodeGitPath(await readFile(files, gitDir));
    const shown = hostPathOf(files, gitDir);
    if (!text.startsWith("gitdir: "))
      throw new GitSetupError(`fatal: invalid gitfile format: ${shown}`);
    const target = parseGitfile(text);
    if (target === undefined || target === "")
      throw new GitSetupError(`fatal: no path in gitfile: ${shown}`);
    const dir = gitDir.slice(0, gitDir.lastIndexOf("/")) || "/";
    const resolved = target.startsWith("/")
      ? paths.resolve("/", target)
      : paths.resolve(dir, target);
    if (!(await isGitDirectory(files, resolved, paths.environment?.objectDirectory, paths, cwd))) {
      throw new GitSetupError(`fatal: not a git repository: ${target}`);
    }
    gitfile = gitDir;
    gitDir = await paths.realPath(resolved);
  }
  if (!(await isGitDirectory(files, gitDir, paths.environment?.objectDirectory, paths, cwd))) {
    throw new GitSetupError(`fatal: not a git repository: '${gitDirValue}'`);
  }
  const settings = known ?? (await worktreeSettings(files, gitDir));
  const warnings: string[] = [];
  const base = {
    gitDir,
    ...(gitfile !== undefined ? { gitfile } : {}),
  };
  const noWorkTree = (bogus = false) => ({
    setup: {
      ...base,
      cwd,
      insideGitDir: isInside(cwd, gitDir),
      insideWorkTree: false,
      ...(bogus ? { workTreeConfigIsBogus: true } : {}),
      warnings,
    },
    bareConfig: settings.bare,
  });
  let workTree: string;
  if (workTreeEnv !== undefined) {
    workTree = await paths.realPath(paths.resolve(cwd, workTreeEnv));
  } else if (settings.bare === true) {
    if (settings.workTree !== undefined) {
      // #22.2, #30
      warnings.push("warning: core.bare and core.worktree do not make sense");
      return noWorkTree(true);
    }
    // #18, #26
    return noWorkTree();
  } else if (settings.workTree !== undefined) {
    // #6, #14: relative to the git directory (chdir there, then to it)
    const value = settings.workTree;
    const from = value.startsWith("/") ? "/" : await paths.realPath(gitDir);
    const target = paths.resolve(from, value);
    if ((await files.stats(target).catch(() => undefined))?.kind !== "directory") {
      throw new GitSetupError(`fatal: cannot chdir to '${value}': No such file or directory`);
    }
    workTree = await paths.realPath(target);
  } else if (implicitWorkTree === false) {
    // #16d
    return noWorkTree();
  } else {
    // #2, #10: the current directory
    workTree = cwd;
  }
  const inside = isInside(cwd, workTree);
  // cwd inside the worktree: git moves to its top, the prefix leads back
  const finalCwd = inside ? workTree : cwd;
  const rest =
    !inside || cwd === workTree ? "" : cwd.slice(workTree === "/" ? 1 : workTree.length + 1);
  return {
    setup: {
      ...base,
      workTree,
      cwd: finalCwd,
      ...(rest ? { prefix: `${rest}/` } : {}),
      insideGitDir: isInside(finalCwd, await paths.realPath(gitDir)),
      insideWorkTree: inside,
      warnings,
    },
    bareConfig: settings.bare,
  };
}

/**
 * `path` of `files` as the host's real path names it, mapped back into `files` (git's
 * `strbuf_getcwd`, a physical directory); `path` itself without the environment's `realPath`,
 * for a storage that is no host directory, or where the real path lies outside the storage.
 */
async function physicalPath(
  files: FilesApi,
  environment: GitHostEnvironment | undefined,
  path: string,
): Promise<string> {
  const realPath = environment?.realPath;
  const root = (files as { rootDirectory?: string }).rootDirectory?.replace(/\/+$/, "");
  if (!realPath || root === undefined) return path;
  const real = await realPath(hostPathOf(files, path)).catch(() => undefined);
  if (real === undefined) return path;
  const roots = [root];
  const realRoot = await realPath(root || "/").catch(() => undefined);
  if (realRoot !== undefined && realRoot !== root) roots.push(realRoot.replace(/\/+$/, ""));
  for (const base of roots) {
    if (real === base || (base === "" && real === "/")) return "/";
    if (real.startsWith(`${base}/`)) return normalizePath(real.slice(base.length));
  }
  return path;
}

/**
 * setup.c's ceiling: the entries of `$GIT_CEILING_DIRECTORIES` canonicalised
 * (`canonicalize_ceiling_entry`: a relative entry dropped, `realPath` until an empty entry,
 * an entry that does not resolve dropped), then `longest_ancestor_length` against the real
 * path of `cwd`: the number of directories above `cwd` discovery may search, undefined
 * without a ceiling above it.
 */
async function ceilingLevels(
  environment: GitHostEnvironment | undefined,
  cwdHost: string,
): Promise<number | undefined> {
  const value = environment?.ceilingDirectories;
  if (value === undefined) return undefined;
  const ceilings: string[] = [];
  let emptyFound = false;
  for (const entry of value.split(":")) {
    if (entry === "") {
      emptyFound = true;
      continue;
    }
    if (!entry.startsWith("/")) continue;
    if (emptyFound || !environment?.realPath) {
      ceilings.push(entry);
      continue;
    }
    const real = await environment.realPath(entry).catch(() => undefined);
    if (real !== undefined) ceilings.push(real);
  }
  // getcwd: the physical directory
  const cwd = (await environment?.realPath?.(cwdHost).catch(() => undefined)) ?? cwdHost;
  if (cwd === "/") return undefined;
  let longest = -1;
  for (const ceiling of ceilings) {
    let len = ceiling.length;
    if (len > 0 && ceiling.endsWith("/")) len--;
    if (!cwd.startsWith(ceiling.slice(0, len)) || cwd[len] !== "/" || cwd.length === len + 1) {
      continue;
    }
    if (len > longest) longest = len;
  }
  if (longest < 0) return undefined;
  // the components of cwd below the ceiling, less cwd itself
  const below = cwd
    .slice(longest)
    .split("/")
    .filter((part) => part !== "").length;
  return below - 1;
}

/** A gitfile's `gitdir:` as a path of `files`: relative to `dir`, or absolute in its root. */
function gitfileTarget(files: FilesApi, dir: string, target: string): string | undefined {
  if (!target.startsWith("/")) return resolveDots(`${dir}/${target}`);
  const root = (files as { rootDirectory?: string }).rootDirectory?.replace(/\/+$/, "");
  if (root === undefined || root === "") return resolveDots(target);
  const normalized = resolveDots(target);
  if (normalized === undefined) return undefined;
  if (normalized === root) return "/";
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length) : undefined;
}

/**
 * git's `is_git_directory`: a valid HEAD (a symbolic ref into `refs/`, or an object id),
 * and `objects` and `refs` directories in its common directory (`commondir`).
 */
export async function isGitDirectory(
  files: FilesApi,
  dir: string,
  /** `$GIT_OBJECT_DIRECTORY` as set: it must exist in place of the objects directory */
  objectDirectory?: string,
  /** Resolves a relative `objectDirectory` (from `cwd`) */
  paths?: { resolve(dir: string, value: string): string },
  cwd = "/",
): Promise<boolean> {
  const kindOf = async (path: string) => (await files.stats(path).catch(() => undefined))?.kind;
  const head = joinPath(dir, "HEAD");
  if ((await kindOf(head)) !== "file") return false;
  let text: string;
  try {
    text = decodeGitPath((await readFile(files, head)).subarray(0, 255));
  } catch {
    return false;
  }
  const symbolic = text.startsWith("ref:") && text.slice(4).replace(/^\s+/, "").startsWith("refs/");
  if (!symbolic && !/^([0-9a-fA-F]{64}|[0-9a-fA-F]{40})/.test(text)) return false;
  let common = dir;
  const commondir = joinPath(dir, "commondir");
  if ((await kindOf(commondir)) === "file") {
    const value = decodeGitPath(await readFile(files, commondir)).replace(/[\r\n]+$/, "");
    if (value === "") return false;
    const resolved = gitfileTarget(files, dir, value);
    if (resolved === undefined) return false;
    common = resolved;
  }
  // is_git_directory: $GIT_OBJECT_DIRECTORY replaces the objects directory's check
  const objects =
    objectDirectory !== undefined
      ? paths
        ? paths.resolve(cwd, objectDirectory)
        : normalizePath(objectDirectory)
      : joinPath(common, "objects");
  return (
    (await kindOf(objects)) === "directory" &&
    (await kindOf(joinPath(common, "refs"))) === "directory"
  );
}

/** An absolute path with `.` and `..` resolved; undefined when it climbs above the root. */
function resolveDots(path: string): string | undefined {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  return `/${out.join("/")}`;
}
