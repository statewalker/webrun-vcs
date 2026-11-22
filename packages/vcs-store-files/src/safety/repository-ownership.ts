/**
 * git's repository ownership check (setup.c's `ensure_valid_ownership`, `safe_directory_cb`,
 * git-compat-util.h's `is_path_owned_by_current_uid`) and its bare-repository rule
 * (`safe.bareRepository`, `is_implicit_bare_repo`).
 *
 * git refuses a repository whose worktree, git directory or gitfile another user owns,
 * unless the protected configuration lists it in `safe.directory`: another user's
 * repository could run that user's hooks, filters and pagers as you. The owners come from
 * the FilesApi's `lstat` (`LinkStats.uid`) and the current user from the host
 * (`GitHostEnvironment.effectiveUid`); where either is missing (a browser, in-memory or
 * remote storage, Windows) every repository counts as the user's own and the check passes,
 * as git's does on systems that have no file owners.
 */

import type { FilesApi, LinkStats } from "@statewalker/vcs-utils/files";
import { expandUserPath, type GitHostEnvironment } from "@statewalker/vcs-working-tree";

import type { ProtectedConfigEntry } from "./protected-config.js";
import { readProtectedConfig } from "./protected-config.js";

/** The git version whose rules apply where 2.43 and 2.5x differ (default 2.56). */
export type RepositorySafetyCompatibility = "2.43" | "2.56";

/**
 * A repository another user owns, refused as git refuses it (exit 128). Its message is git's
 * text, `fatal: detected dubious ownership in repository at '<path>'` and the hint naming
 * the `safe.directory` exception.
 */
export class DubiousOwnershipError extends Error {
  readonly exitCode = 128;
  constructor(
    /** The path git names (host path) */
    readonly path: string,
    /** git's warnings printed before the refusal (`safe.directory '<x>' not absolute`) */
    readonly warnings: string[] = [],
  ) {
    super(
      `fatal: detected dubious ownership in repository at '${path}'\n` +
        "To add an exception for this directory, call:\n" +
        "\n" +
        `\tgit config --global --add safe.directory ${sqQuotePretty(path)}`,
    );
    this.name = "DubiousOwnershipError";
  }
}

/**
 * A bare repository found by discovery while `safe.bareRepository` is `explicit` (exit 128):
 * `fatal: cannot use bare repository '<path>' (safe.bareRepository is 'explicit')`.
 */
export class UnsafeBareRepositoryError extends Error {
  readonly exitCode = 128;
  constructor(readonly path: string) {
    super(`fatal: cannot use bare repository '${path}' (safe.bareRepository is 'explicit')`);
    this.name = "UnsafeBareRepositoryError";
  }
}

/**
 * A protected setting git cannot parse (exit 128): `fatal: bad config variable '<key>' in
 * file '<file>' at line <n>`, or `fatal: unable to parse '<key>' from command-line config`.
 */
export class ProtectedConfigError extends Error {
  readonly exitCode = 128;
  constructor(entry: ProtectedConfigEntry) {
    super(
      entry.file === undefined
        ? `fatal: unable to parse '${entry.key}' from command-line config`
        : `fatal: bad config variable '${entry.key}' in file '${entry.file}' at line ${entry.line ?? 0}`,
    );
    this.name = "ProtectedConfigError";
  }
}

/** git's `sq_quote_buf_pretty`: as it is when it needs no quoting, else single-quoted. */
export function sqQuotePretty(text: string): string {
  if (text === "") return "''";
  if (/^[A-Za-z0-9+,\-./:=@_^]+$/.test(text)) return text;
  return `'${text.replace(/['!]/g, (c) => `'\\${c}'`)}'`;
}

/** The FilesApi reads git's ownership check needs: an `lstat` with owners. */
type OwnerFilesApi = FilesApi & {
  lstat?(path: string): Promise<LinkStats | undefined>;
  rootDirectory?: string;
};

/** git's ROOT_UID */
const ROOT_UID = 0;

/**
 * `$SUDO_UID` as git's `extract_id_from_env` reads it: `strtoul` in base 10 of a non-empty
 * value with nothing after the digits (leading blanks and a sign taken, a negative number
 * wrapping), stored in a 32-bit `uid_t`; undefined when git ignores it.
 */
export function sudoUidOf(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^[ \t\n\v\f\r]*([+-]?)(\d+)$/.exec(value);
  if (!match) return undefined;
  const digits = BigInt(match[2] as string);
  const max = (1n << 64n) - 1n;
  // ERANGE: git keeps the effective uid
  if (digits > max) return undefined;
  const unsigned = match[1] === "-" ? (max + 1n - digits) & max : digits;
  return Number(unsigned & 0xffffffffn);
}

/**
 * Whether the current user owns `path` (git's `is_path_owned_by_current_uid`): the entry
 * itself (`lstat`), owned by the effective user, or by `$SUDO_UID` when root runs it on
 * someone's behalf (a root-owned entry stays root's). Undefined when this cannot be told
 * (no effective uid, no `lstat`, no owner in its stats): the check then passes.
 */
export async function isOwnedByCurrentUser(
  files: FilesApi,
  path: string,
  environment: GitHostEnvironment | undefined,
): Promise<boolean | undefined> {
  const euid = environment?.effectiveUid;
  const lstat = (files as OwnerFilesApi).lstat;
  if (euid === undefined || !lstat) return undefined;
  let stats: LinkStats | undefined;
  try {
    stats = await lstat.call(files, path);
  } catch {
    return false;
  }
  if (!stats) return false;
  if (stats.uid === undefined) return undefined;
  let uid = euid;
  if (euid === ROOT_UID) {
    if (stats.uid === ROOT_UID) return true;
    uid = sudoUidOf(environment?.sudoUid) ?? euid;
  }
  return stats.uid === uid;
}

/** A path of `files` as the host names it (`rootDirectory` joined), or as it is. */
export function hostPathOf(files: FilesApi, path: string): string {
  const root = (files as OwnerFilesApi).rootDirectory?.replace(/\/+$/, "");
  const inner = path.startsWith("/") ? path : `/${path}`;
  if (root === undefined) return inner;
  return inner === "/" ? root || "/" : `${root}${inner}`;
}

/** What {@link ensureValidOwnership} checks. */
export interface OwnershipCheck {
  /** The storage the paths below name */
  files: FilesApi;
  /** The host: effective uid, `$SUDO_UID`, the protected configuration, `realPath` */
  environment?: GitHostEnvironment;
  /** The gitfile, when the repository was reached through one (its owner checked) */
  gitfile?: string;
  /** The worktree top (its owner checked) */
  worktree?: string;
  /** The git directory (its owner checked) */
  gitDir?: string;
  /**
   * The path `safe.directory` is matched against, as the host names it (default: the host
   * path of `worktree`, else of `gitDir`); 2.5x matches its real path
   */
  path?: string;
  /** The host directory `safe.directory=.` names (git's current directory) */
  cwd?: string;
  /** The rules of this git version where they differ (default 2.56) */
  compatibility?: RepositorySafetyCompatibility;
  /** The protected configuration, when already read ({@link readProtectedConfig}) */
  protectedConfig?: ProtectedConfigEntry[];
}

/** What {@link ensureValidOwnership} found. */
export interface OwnershipResult {
  /** The repository may be used: its user's own, or listed in `safe.directory` */
  safe: boolean;
  /** git's warnings while `safe.directory` was read (`safe.directory '<x>' not absolute`) */
  warnings: string[];
}

/**
 * git's `ensure_valid_ownership`: the gitfile, worktree and git directory given all belong
 * to the current user, or the repository's path is listed in the protected configuration's
 * `safe.directory` (`*` for every path, a path, 2.46's `<path>/*` for those below it; an
 * empty value forgets what came before). A no-op that passes where owners cannot be told.
 *
 * @example
 * ```typescript
 * const { safe } = await ensureValidOwnership({ files, environment, worktree: "/", gitDir: "/.git" });
 * ```
 */
export async function ensureValidOwnership(check: OwnershipCheck): Promise<OwnershipResult> {
  const { files, environment } = check;
  const warnings: string[] = [];
  if (!environment?.assumeDifferentOwner) {
    let owned = true;
    for (const path of [check.gitfile, check.worktree, check.gitDir]) {
      if (path === undefined) continue;
      if ((await isOwnedByCurrentUser(files, path, environment)) === false) {
        owned = false;
        break;
      }
    }
    if (owned) return { safe: true, warnings };
  }
  const named =
    check.path ??
    (check.worktree !== undefined
      ? hostPathOf(files, check.worktree)
      : check.gitDir !== undefined
        ? hostPathOf(files, check.gitDir)
        : undefined);
  if (named === undefined) return { safe: false, warnings };
  const compat = check.compatibility ?? "2.56";
  // 2.5x normalizes the repository's path (real_pathdup): one it cannot is unsafe; 2.43
  // compares the path as setup found it
  const path = compat === "2.43" ? named : await realPathOf(environment, named);
  if (path === undefined) return { safe: false, warnings };
  const entries = check.protectedConfig ?? (await readProtectedConfig(environment));
  let safe = false;
  for (const entry of entries) {
    if (entry.key !== "safe.directory") continue;
    const value = entry.value;
    if (value === undefined || value === "") {
      safe = false;
      continue;
    }
    if (value === "*") {
      safe = true;
      continue;
    }
    const allowed = await configPathname(value, environment, compat);
    if (allowed === undefined) continue;
    if (compat === "2.43") {
      if (allowed === path) safe = true;
      continue;
    }
    // a relative path makes no sense (it is not relative to the file it is in), except ".":
    // the current directory, when it is the repository's top
    if (!allowed.startsWith("/") && allowed !== ".") {
      warnings.push(`warning: safe.directory '${allowed}' not absolute`);
      continue;
    }
    const target = allowed === "." ? check.cwd : allowed;
    // a path that does not exist here is no error: a shared ~/.gitconfig names others' paths
    const normalized = target === undefined ? undefined : await realPathOf(environment, target);
    if (normalized === undefined) continue;
    if (normalized.endsWith("/*")) {
      if (path.startsWith(normalized.slice(0, -1))) safe = true;
    } else if (path === normalized) {
      safe = true;
    }
  }
  return { safe, warnings };
}

/**
 * {@link ensureValidOwnership}, refusing an unsafe repository with git's
 * {@link DubiousOwnershipError} naming `reportPath` (git: the gitfile's target when there is
 * one, else the git directory; discovery names the directory it found). Returns git's
 * warnings when it passes.
 */
export async function assertValidOwnership(
  check: OwnershipCheck & { reportPath: string },
): Promise<string[]> {
  const { safe, warnings } = await ensureValidOwnership(check);
  if (!safe) throw new DubiousOwnershipError(check.reportPath, warnings);
  return warnings;
}

/**
 * The protected `safe.bareRepository` (setup.c's `get_allowed_bare_repo`): `all` (the
 * default) or `explicit`; the last value wins, any other value is git's fatal config error.
 */
export function allowedBareRepository(entries: ProtectedConfigEntry[]): "all" | "explicit" {
  let allowed: "all" | "explicit" = "all";
  for (const entry of entries) {
    if (entry.key !== "safe.barerepository") continue;
    if (entry.value === "explicit" || entry.value === "all") allowed = entry.value;
    else throw new ProtectedConfigError(entry);
  }
  return allowed;
}

/**
 * git's `is_implicit_bare_repo` (2.44+, worktrees and modules 2.45+): a bare repository
 * found by discovery that `safe.bareRepository=explicit` still allows: a `.git` directory
 * (entered from its worktree), a linked worktree's or a submodule's git directory inside one.
 * 2.43 allows none.
 */
export function isImplicitBareRepository(
  path: string,
  compatibility: RepositorySafetyCompatibility = "2.56",
): boolean {
  if (compatibility === "2.43") return false;
  return (
    /(^|\/)\.git\/*$/.test(path) ||
    path.includes("/.git/worktrees/") ||
    path.includes("/.git/modules/")
  );
}

/**
 * A path setting as git's `git_config_pathname` reads it: 2.5x's `:(optional)` prefix (a
 * missing file then names nothing), `%(prefix)/` (git's runtime prefix; an absolute path
 * after it as it is), `~/` (the home directory), `~user/` (through the host's
 * `expandUserHome`; an unknown user is git's fatal "failed to expand user dir", and without
 * the hook the entry names nothing).
 */
async function configPathname(
  value: string,
  environment: GitHostEnvironment | undefined,
  compat: RepositorySafetyCompatibility,
): Promise<string | undefined> {
  let text = value;
  let optional = false;
  if (compat !== "2.43" && text.startsWith(":(optional)")) {
    optional = true;
    text = text.slice(":(optional)".length);
  }
  let path: string | undefined;
  if (text.startsWith("%(prefix)/")) {
    const rest = text.slice("%(prefix)/".length);
    if (rest.startsWith("/")) path = rest;
    else if (environment?.prefix) path = `${environment.prefix.replace(/\/+$/, "")}/${rest}`;
    else return undefined;
  } else if (text.startsWith("~") && !text.startsWith("~/") && text !== "~") {
    // interpolate_path's getpwnam: through the host, or (without one) not expandable here,
    // the entry skipped
    const slash = text.indexOf("/");
    const name = slash < 0 ? text.slice(1) : text.slice(1, slash);
    if (!environment?.expandUserHome) return undefined;
    const home = await environment.expandUserHome(name);
    if (home === undefined) throw new Error(`fatal: failed to expand user dir in: '${text}'`);
    path = `${home}${slash < 0 ? "" : text.slice(slash)}`;
  } else {
    path = expandUserPath(text, environment);
    if (path === undefined) throw new Error(`fatal: failed to expand user dir in: '${text}'`);
  }
  if (optional && (await realPathOf(environment, path)) === undefined) return undefined;
  return path;
}

/**
 * git's `real_pathdup(path, 0)`: the host's real path (its links followed), the last
 * component allowed to be missing; without the host's `realPath`, the path with its `.` and
 * `..` resolved.
 */
async function realPathOf(
  environment: GitHostEnvironment | undefined,
  path: string,
): Promise<string | undefined> {
  const absolute = path.startsWith("/");
  if (!environment?.realPath) return absolute ? lexicalPath(path) : undefined;
  const real = await environment.realPath(path).catch(() => undefined);
  if (real !== undefined) return real;
  // strbuf_realpath_1 allows only the last component to be missing: a missing one followed
  // by a slash (`<dir>/*/`) leaves a component to go, and fails
  if (path.endsWith("/")) return undefined;
  const slash = path.lastIndexOf("/");
  if (slash < 0) return undefined;
  const last = path.slice(slash + 1);
  if (last === "" || last === "." || last === "..") return undefined;
  const parent = await environment.realPath(path.slice(0, slash) || "/").catch(() => undefined);
  if (parent === undefined) return undefined;
  return parent === "/" ? `/${last}` : `${parent}/${last}`;
}

/** `path` with `.`, `..` and repeated slashes resolved, without a trailing slash. */
function lexicalPath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}
