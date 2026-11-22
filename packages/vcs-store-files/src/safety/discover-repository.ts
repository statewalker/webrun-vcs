/**
 * git's repository discovery (setup.c's `setup_git_directory_gently` and
 * `repo_discovery_find_dir`) with its safety checks: from a directory up to the storage's
 * root, the first `.git` gitfile or directory, or a bare repository, is the repository, and
 * it is used only when its owner is the current user or `safe.directory` lists it, and (a
 * bare one) when `safe.bareRepository` allows it.
 */

import { decodeGitPath } from "@statewalker/vcs-utils/encoding";
import { type FilesApi, joinPath, normalizePath, readFile } from "@statewalker/vcs-utils/files";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";

import { parseGitfile } from "../workspace/git-dir/index.js";
import { type ProtectedConfigEntry, readProtectedConfig } from "./protected-config.js";
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
  const { files, environment } = options;
  const compatibility = options.compatibility ?? "2.56";
  if (options.gitDir !== undefined) {
    const gitDir = normalizePath(options.gitDir);
    return { gitDir, bare: !/\/\.git$/.test(gitDir), warnings: [] };
  }
  const check = options.checkOwnership !== false;
  let protectedConfig: ProtectedConfigEntry[] | undefined;
  const config = async () => {
    protectedConfig ??= await readProtectedConfig(environment);
    return protectedConfig;
  };
  const cwdHost = hostPathOf(files, normalizePath(options.cwd ?? "/"));
  let dir = normalizePath(options.cwd ?? "/");
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
            protectedConfig: await config(),
          })
        : [];
      return {
        gitDir,
        workTree: dir,
        ...(gitfile !== undefined ? { gitfile } : {}),
        bare: false,
        warnings,
      };
    }
    if (await isGitDirectory(files, dir)) {
      const host = hostPathOf(files, dir);
      const entries = await config();
      if (
        allowedBareRepository(entries) === "explicit" &&
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
      return { gitDir: dir, bare: true, warnings };
    }
    if (dir === "/") throw new NotAGitRepositoryError();
    dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
  }
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
export async function isGitDirectory(files: FilesApi, dir: string): Promise<boolean> {
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
  return (
    (await kindOf(joinPath(common, "objects"))) === "directory" &&
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
