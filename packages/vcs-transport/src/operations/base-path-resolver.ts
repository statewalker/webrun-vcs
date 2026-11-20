/**
 * git-daemon's path rules as a `resolveRepository` for `serveGitConnection` /
 * `serveGitService`: the path a client sends mapped onto a directory below a base, as
 * daemon.c's `path_ok` and setup.c's `enter_repo` map it, and refused wherever git-daemon
 * refuses it.
 *
 * @example
 * ```ts
 * const resolveRepository = createBasePathResolver({
 *   files,                    // the storage the repositories are in
 *   basePath: "/srv/git",     // git-daemon's --base-path
 *   openRepository: async (gitDir) => {
 *     const opened = await worktree.openRepository?.(gitDir);
 *     return opened && servedRepositoryOf(opened); // vcs-commands
 *   },
 * });
 * // "/r" → /srv/git/r/.git, /srv/git/r, /srv/git/r.git/.git or /srv/git/r.git (the first
 * // git directory), served when it has a git-daemon-export-ok file
 * ```
 */

import type { FilesApi, PosixFilesApi } from "@statewalker/vcs-utils/files";
import {
  type GitServiceRequest,
  isUnsafeServicePath,
  type ServedRepository,
} from "./serve-git-connection.js";

/** Options of {@link createBasePathResolver}. */
export interface BasePathResolverOptions {
  /**
   * The storage the repositories are in. Its `stats` finds them; with `lstat` and `readlink`
   * (a `PosixFilesApi`) symbolic links on the way are followed and checked to stay inside the
   * base, without them the check is lexical only (the storage itself must then not follow
   * links out of the base)
   */
  files: FilesApi;
  /**
   * The directory of the served repositories in `files` (git-daemon's `--base-path`): a
   * request's absolute path is read below it, and whatever it resolves to must stay inside
   * it. Default `/`, the storage's root
   */
  basePath?: string;
  /**
   * Opens the repository at `gitDir` (a path in `files`: the git directory found, inside the
   * base, a gitfile followed): undefined when it cannot be served
   */
  openRepository(gitDir: string, request: GitServiceRequest): Promise<ServedRepository | undefined>;
  /**
   * Serve every repository found (git-daemon's `--export-all`); default false: only one with
   * a `git-daemon-export-ok` file in its git directory
   */
  exportAll?: boolean;
  /**
   * `~user` paths (git-daemon's `--user-path`): the directory in `files` that `~<user>/...`
   * is read below (git-daemon's `~user/<user-path>`), undefined to refuse that user. Without
   * it every `~` path is refused ("User-path not allowed"). An implicit session's `~/x` asks
   * with `user` empty.
   */
  userPath?(user: string, request: GitServiceRequest): string | undefined;
  /**
   * Match the path exactly (git-daemon's `--strict-paths`): no `.git` suffix tried, and a
   * `whitelist` entry names a repository, not a directory of them. With it and no whitelist
   * nothing is served, as git-daemon denies by default then
   */
  strictPaths?: boolean;
  /**
   * The directories served from (git-daemon's directory list), paths in `files` compared with
   * the git directory found (before a gitfile is followed): an entry or (unless
   * `strictPaths`) a path below one. Default: every directory inside the base
   */
  whitelist?: readonly string[];
}

/** Most symbolic links followed while resolving one path (as the kernel's ELOOP). */
const MAX_LINKS = 40;

/** `path`'s components, `.` and empty ones dropped, `..` applied; null when it climbs above the root. */
function normalize(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(part);
    }
  }
  return `/${out.join("/")}`;
}

/** Whether `path` is `dir` or below it (both normalized). */
function inside(path: string, dir: string): boolean {
  return dir === "/" || path === dir || path.startsWith(`${dir}/`);
}

/**
 * The path with the symbolic links on it followed through `files.lstat` / `readlink`;
 * null when one cannot be followed inside the storage (an absolute target names the host's
 * filesystem, not the storage's), or there are too many. Lexical when `files` cannot tell.
 */
async function realPath(files: FilesApi, path: string): Promise<string | null> {
  const posix = files as PosixFilesApi;
  if (!posix.lstat || !posix.readlink) return normalize(path);
  const pending = path.split("/").filter((p) => p !== "" && p !== ".");
  const out: string[] = [];
  let links = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
    const current = `/${out.join("/")}`;
    const stat = await posix.lstat(current).catch(() => undefined);
    if (stat?.kind !== "symlink") continue;
    if (++links > MAX_LINKS) return null;
    const target = await posix.readlink(current).catch(() => undefined);
    if (!target) return null;
    const text = new TextDecoder().decode(target);
    if (text.startsWith("/")) return null;
    out.pop();
    pending.unshift(...text.split("/").filter((p) => p !== "" && p !== "."));
  }
  return `/${out.join("/")}`;
}

/** setup.c's `is_git_directory`: HEAD, objects/ and refs/. */
async function isGitDirectory(files: FilesApi, dir: string): Promise<boolean> {
  const [head, objects, refs] = await Promise.all([
    files.stats(`${dir}/HEAD`).catch(() => undefined),
    files.stats(`${dir}/objects`).catch(() => undefined),
    files.stats(`${dir}/refs`).catch(() => undefined),
  ]);
  return head?.kind === "file" && objects?.kind === "directory" && refs?.kind === "directory";
}

/** A gitfile's `gitdir: <path>`, resolved against its directory; undefined when it is not one. */
async function readGitfile(files: FilesApi, file: string): Promise<string | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of files.read(file)) {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 4096) return undefined;
    }
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  const text = new TextDecoder().decode(bytes).replace(/\r?\n$/, "");
  if (!text.startsWith("gitdir: ")) return undefined;
  const target = text.slice(8);
  if (target.startsWith("/")) return undefined; // a host path, not one in the storage
  return `${file.slice(0, file.lastIndexOf("/"))}/${target}`;
}

/**
 * A `resolveRepository` applying git-daemon's path rules (daemon.c's `path_ok`, setup.c's
 * `enter_repo`, the `git-daemon-export-ok` check of `run_service`):
 *
 * - aliases refused (`isUnsafeServicePath`: `..`, `//`, `/./`, NUL, backslash), as the
 *   servers check before calling it;
 * - `~user[/path]` read below `userPath(user)`, refused without that option;
 * - any other path read below `basePath` (an implicit session's relative path too, as if
 *   absolute);
 * - unless `strictPaths`, trailing slashes dropped and the first git directory of
 *   `<path>/.git`, `<path>`, `<path>.git/.git`, `<path>.git` taken (a gitfile there followed);
 *   with it, `<path>` only;
 * - the `whitelist`, then `git-daemon-export-ok` unless `exportAll`;
 * - every step checked to stay inside the base (or the user's directory), symbolic links
 *   followed where `files` can read them.
 *
 * Undefined (not served) whenever a rule refuses; `serveGitService` then answers as for a
 * missing repository.
 */
export function createBasePathResolver(
  options: BasePathResolverOptions,
): (path: string, request: GitServiceRequest) => Promise<ServedRepository | undefined> {
  const { files } = options;
  const base = normalize(options.basePath ?? "/");
  const whitelist = options.whitelist?.map(normalize);
  return async (path, request) => {
    if (base === null) return undefined;
    if (isUnsafeServicePath(path, { implicit: true })) return undefined;
    let root: string | null;
    let dir: string;
    if (path.startsWith("~")) {
      if (!options.userPath) return undefined;
      const slash = path.indexOf("/");
      const user = slash < 0 ? path.slice(1) : path.slice(1, slash);
      const home = options.userPath(user, request);
      if (home === undefined) return undefined;
      root = normalize(home);
      dir = `${root}${slash < 0 ? "" : path.slice(slash)}`;
    } else {
      root = base;
      dir = `${base}/${path}`;
    }
    if (root === null) return undefined;
    const realRoot = await realPath(files, root);
    if (realRoot === null) return undefined;
    // lexical containment first: a path that leaves the root by its own `..` is never looked at
    const lexical = normalize(dir);
    if (lexical === null || !inside(lexical, root)) return undefined;

    // enter_repo: the git directory the path names
    let found: string | undefined;
    let gitfileAt: string | undefined;
    const candidates = options.strictPaths
      ? [lexical]
      : [".git", "", ".git/.git", ".git"].map((suffix, i) =>
          i === 0 ? `${lexical === "/" ? "" : lexical}/${suffix}` : `${lexical}${suffix}`,
        );
    // each candidate looked at where its links lead, never outside the root
    let real: string | undefined;
    for (const candidate of candidates) {
      const at = await realPath(files, candidate);
      if (at === null || !inside(at, realRoot)) return undefined;
      const stats = await files.stats(at).catch(() => undefined);
      if (stats?.kind === "file") {
        found = candidate;
        real = at;
        gitfileAt = at;
        break;
      }
      if (stats?.kind === "directory" && (await isGitDirectory(files, at))) {
        found = candidate;
        real = at;
        break;
      }
    }
    if (found === undefined) return undefined;
    if (
      whitelist &&
      !whitelist.some(
        (entry) =>
          entry !== null &&
          (found === entry || (!options.strictPaths && inside(found as string, entry))),
      )
    ) {
      return undefined;
    }
    if (!whitelist && options.strictPaths) return undefined;

    let gitDir = real as string;
    if (gitfileAt !== undefined) {
      const target = await readGitfile(files, gitfileAt);
      const followed = target === undefined ? null : await realPath(files, target);
      if (followed === null || !inside(followed, realRoot)) return undefined;
      if (!(await isGitDirectory(files, followed))) return undefined;
      gitDir = followed;
    }
    if (!options.exportAll) {
      const ok = await files.stats(`${gitDir}/git-daemon-export-ok`).catch(() => undefined);
      if (!ok) return undefined;
    }
    return options.openRepository(gitDir, request);
  };
}
