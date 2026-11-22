/**
 * The user's git environment on Node: where `~/.gitconfig`, `$XDG_CONFIG_HOME/git/*` and the
 * system files are, and how to read them. Hosts pass it to the configuration
 * (`GitWorkingCopyConfig`'s `environment`) and to working copies, so global settings
 * (`core.autocrlf`, `core.attributesFile`, includes with `~/`) apply as in git. Its shape is
 * `GitHostEnvironment` of `@statewalker/vcs-working-tree`.
 */
import { homedir, type as osType, userInfo } from "node:os";

import { type FilesApi, readFile } from "@statewalker/vcs-utils/files";

import { NodeFilesApi } from "@statewalker/webrun-files-node";

import type { NodeHookRunner } from "./node-hook-runner.js";
import { realHostPath, statHostFile } from "./posix-node-files-api.js";

/** Where the files are; each defaults to the process environment, as git reads it. */
export interface NodeGitHostEnvironmentOptions {
  /** `$HOME` (default: `HOME` of {@link env}, else the OS home directory) */
  home?: string;
  /** `$XDG_CONFIG_HOME` (default: `XDG_CONFIG_HOME` of {@link env}) */
  xdgConfigHome?: string;
  /**
   * The system configuration file (default: `GIT_CONFIG_SYSTEM` of {@link env}, else
   * `/etc/gitconfig`, as git built with `prefix=/usr` reads it); not read when
   * `GIT_CONFIG_NOSYSTEM` is set
   */
  systemConfig?: string;
  /**
   * The system attributes file (default: `/etc/gitattributes`); not read when
   * `GIT_ATTR_NOSYSTEM` is set
   */
  systemAttributes?: string;
  /**
   * The one global configuration file, read instead of `$XDG_CONFIG_HOME/git/config` and
   * `~/.gitconfig` (default: `GIT_CONFIG_GLOBAL` of {@link env})
   */
  globalConfig?: string;
  /** The environment variables read (default: `process.env`) */
  env?: Record<string, string | undefined>;
  /**
   * The file system the files are read from, by their absolute paths (default: the host's,
   * through a Node FilesApi rooted at `/`, or at the drive of a Windows path). Pass a
   * composite or in-memory FilesApi to read them from elsewhere.
   */
  files?: FilesApi;
  /**
   * Runs the repository's hooks (`createNodeHookRunner`); absent: no hook runs, as before
   * hooks were supported
   */
  hookRunner?: NodeHookRunner;
  /**
   * The effective user id the ownership checks compare repository owners with (default:
   * `process.geteuid()`, absent on Windows); `null` turns the checks off
   */
  effectiveUid?: number | null;
  /** git's runtime prefix for `%(prefix)/` (default `/usr`, as a distribution's git) */
  prefix?: string;
}

/** The environment as `GitHostEnvironment` describes it. */
export interface NodeGitHostEnvironment {
  readFile(path: string): Promise<Uint8Array | undefined>;
  statFile?(path: string): Promise<import("@statewalker/vcs-utils/files").LinkStats | undefined>;
  realPath?(path: string): Promise<string | undefined>;
  systemName?: string;
  disableUntrackedCache?: boolean;
  forceUntrackedCache?: boolean;
  home?: string;
  xdgConfigHome?: string;
  systemConfig?: string;
  systemAttributes?: string;
  globalConfig?: string;
  committer?: { name?: string; email?: string; date?: string };
  author?: { name?: string; email?: string; date?: string };
  defaultEmail?: string;
  attrSource?: string;
  noReplaceObjects?: boolean;
  noLazyFetch?: boolean;
  indexVersion?: string;
  protocolFromUser?: boolean;
  allowProtocol?: string;
  replaceRefBase?: string;
  graftFile?: string;
  printSha1Ellipsis?: boolean;
  alternateObjectDirectories?: string;
  notesRef?: string;
  notesDisplayRef?: string;
  notesRewriteRef?: string;
  notesRewriteMode?: string;
  pathspecs?: { literal?: string; glob?: string; noglob?: string; icase?: string };
  hookRunner?: NodeHookRunner;
  effectiveUid?: number;
  sudoUid?: string;
  assumeDifferentOwner?: boolean;
  commandLineConfig?: Array<{ key: string; value: string | undefined }>;
  commandLineConfigError?: string;
  ceilingDirectories?: string;
  discoveryAcrossFilesystem?: boolean;
  prefix?: string;
  expandUserHome?(name: string): Promise<string | undefined>;
}

/**
 * One Node FilesApi per file-system root: `/`, a Windows drive such as `C:/`, or a UNC share
 * such as `//server/share`. It is the plain `NodeFilesApi`, which follows symbolic links (a
 * linked `~/.gitconfig`, macOS's `/etc` -> `/private/etc`), as git's reads of these files do.
 */
const hostRoots = new Map<string, FilesApi>();

/**
 * The host FilesApi that holds a path, and the path inside it. A relative path is read from
 * the process's current directory. That is not where git reads one from: git opens its files
 * after its setup has changed to the worktree top (the git directory when bare), so callers
 * that know the repository resolve a relative path there first (a relative `GIT_GRAFT_FILE`:
 * `graftFileReader` of vcs-core with its base).
 */
function hostFiles(path: string, windows = process.platform === "win32"): [FilesApi, string] {
  let full = path.replaceAll("\\", "/");
  const absolute = full.startsWith("/") || /^[A-Za-z]:\//.test(full);
  if (!absolute) full = `${process.cwd().replaceAll("\\", "/").replace(/\/$/, "")}/${full}`;
  const unc = windows ? /^\/\/[^/]+\/[^/]+/.exec(full) : null;
  const drive = /^[A-Za-z]:\//.exec(full);
  const prefix = unc ? unc[0] : drive ? full.slice(0, 2) : "";
  const root = `${prefix.toUpperCase()}/`;
  let files = hostRoots.get(root);
  if (!files) {
    files = new NodeFilesApi({ rootDir: unc ? prefix : root });
    hostRoots.set(root, files);
  }
  return [files, full.slice(prefix.length)];
}

/** git's `git_env_bool`: set to anything but a false value. */
function envBool(value: string | undefined): boolean {
  if (value === undefined) return false;
  const text = value.trim().toLowerCase();
  return !["", "0", "false", "no", "off"].includes(text);
}

/**
 * Command-line configuration git cannot parse (config.c's `git_config_from_parameters`
 * failing): git dies at its first config read, `error: <reason>` then `fatal: unable to
 * parse command-line config` (exit 128).
 */
export class CommandLineConfigError extends Error {
  readonly exitCode = 128;
  constructor(
    /** git's `error:` text (`bogus format in GIT_CONFIG_PARAMETERS`) */
    readonly reason: string,
  ) {
    super(`error: ${reason}\nfatal: unable to parse command-line config`);
    this.name = "CommandLineConfigError";
  }
}

/** git's `isspace` (sane_ctype's GIT_SPACE: space, tab, newline, carriage return). */
const isGitSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

/** git's `iskeychar`: an ASCII letter, digit or `-`. */
const isKeyChar = (c: string) => /^[A-Za-z0-9-]$/.test(c);

/**
 * A config key as git's `config_parse_pair` / `git_config_parse_key` takes it: section and
 * variable in lower case, a subsection as written; a key git refuses throws
 * {@link CommandLineConfigError} with its reason.
 */
function canonicalConfigKey(key: string): string {
  if (key === "") throw new CommandLineConfigError("empty config key");
  const last = key.lastIndexOf(".");
  if (last <= 0) throw new CommandLineConfigError(`key does not contain a section: ${key}`);
  if (last === key.length - 1) {
    throw new CommandLineConfigError(`key does not contain variable name: ${key}`);
  }
  let out = "";
  let dot = false;
  for (let i = 0; i < key.length; i++) {
    const c = key[i] as string;
    if (c === ".") dot = true;
    if (!dot || i > last) {
      if (!isKeyChar(c) || (i === last + 1 && !/^[A-Za-z]$/.test(c))) {
        throw new CommandLineConfigError(`invalid key: ${key}`);
      }
      out += c.toLowerCase();
    } else if (c === "\n") {
      throw new CommandLineConfigError(`invalid key (newline): ${key}`);
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * git's `sq_dequote_step` at `text[at]`: one shell-quoted word (`'...'`, with `'\''` and
 * `'\!'` for a quote and a bang), and where the text goes on after it (null at its end);
 * undefined when the text is not quoted so.
 */
function sqDequoteStep(
  text: string,
  at: number,
): { word: string; next: number | null } | undefined {
  if (text[at] !== "'") return undefined;
  let word = "";
  let src = at;
  for (;;) {
    src++;
    if (src >= text.length) return undefined;
    const c = text[src] as string;
    if (c !== "'") {
      word += c;
      continue;
    }
    src++;
    if (src >= text.length) return { word, next: null };
    if (
      text[src] === "\\" &&
      (text[src + 1] === "'" || text[src + 1] === "!") &&
      text[src + 2] === "'"
    ) {
      word += text[src + 1];
      src += 2;
      continue;
    }
    return { word, next: src };
  }
}

/**
 * `$GIT_CONFIG_COUNT` as `strtoul(..., 10)` with nothing after the digits: the count, or
 * git's reason to refuse it.
 */
function configCountOf(text: string): number {
  if (text === "") return 0;
  const match = /^[ \t\n\v\f\r]*([+-]?)(\d+)$/.exec(text);
  if (!match) throw new CommandLineConfigError("bogus count in GIT_CONFIG_COUNT");
  const digits = BigInt(match[2] as string);
  // a negative count wraps to a huge unsigned one, as does one past ULONG_MAX (ERANGE)
  if ((match[1] === "-" && digits !== 0n) || digits > 2147483647n) {
    throw new CommandLineConfigError("too many entries in GIT_CONFIG_COUNT");
  }
  return Number(digits);
}

/**
 * The command-line configuration git passes to its child processes (config.c's
 * `git_config_from_parameters`): `GIT_CONFIG_COUNT` pairs first, then the entries of
 * `GIT_CONFIG_PARAMETERS` (`'key=value'`, or 2.31's `'key'='value'`; a key alone, or
 * `'key'=`, has no value: git's NULL). Anything git cannot parse (a bogus count, a missing
 * `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`, an entry not quoted as git quotes it, a key
 * without a section) throws {@link CommandLineConfigError} with git's reason, as git dies.
 *
 * @example
 * ```typescript
 * commandLineConfigOf({ GIT_CONFIG_PARAMETERS: "'safe.directory'='*'" });
 * // [{ key: "safe.directory", value: "*" }]
 * ```
 */
export function commandLineConfigOf(
  env: Record<string, string | undefined>,
): Array<{ key: string; value: string | undefined }> {
  const out: Array<{ key: string; value: string | undefined }> = [];
  const add = (key: string, value: string | undefined) => {
    out.push({ key: canonicalConfigKey(key), value });
  };
  const count = env.GIT_CONFIG_COUNT;
  if (count !== undefined) {
    const n = configCountOf(count);
    for (let i = 0; i < n; i++) {
      const key = env[`GIT_CONFIG_KEY_${i}`];
      if (key === undefined)
        throw new CommandLineConfigError(`missing config key GIT_CONFIG_KEY_${i}`);
      const value = env[`GIT_CONFIG_VALUE_${i}`];
      if (value === undefined) {
        throw new CommandLineConfigError(`missing config value GIT_CONFIG_VALUE_${i}`);
      }
      add(key, value);
    }
  }
  const text = env.GIT_CONFIG_PARAMETERS;
  if (text !== undefined) {
    const bogus = () => new CommandLineConfigError("bogus format in GIT_CONFIG_PARAMETERS");
    // parse_config_env_list
    let cur: number | null = 0;
    while (cur !== null && cur < text.length) {
      const step = sqDequoteStep(text, cur);
      if (!step) throw bogus();
      const word = step.word;
      cur = step.next;
      if (cur === null || isGitSpace(text[cur])) {
        // old-style 'key=value' (git_config_parse_parameter)
        const eq = word.indexOf("=");
        const key = eq < 0 ? word : word.slice(0, eq);
        if (key === "") throw new CommandLineConfigError(`bogus config parameter: ${word}`);
        add(key, eq < 0 ? undefined : word.slice(eq + 1));
      } else if (text[cur] === "=") {
        // new-style 'key'='value', or 'key'= (no value)
        cur++;
        if (text[cur] === "'") {
          const value = sqDequoteStep(text, cur);
          if (!value || (value.next !== null && !isGitSpace(text[value.next]))) throw bogus();
          cur = value.next;
          add(word, value.word);
        } else if (cur >= text.length || isGitSpace(text[cur])) {
          add(word, undefined);
        } else {
          throw bogus();
        }
      } else {
        throw bogus();
      }
      if (cur !== null) while (cur < text.length && isGitSpace(text[cur])) cur++;
    }
  }
  return out;
}

/**
 * The user's git environment read from the process (`HOME`, `XDG_CONFIG_HOME`,
 * `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_ATTR_NOSYSTEM`, and
 * `GIT_COMMITTER_NAME` / `_EMAIL` / `_DATE` for the committer and the reflog identity,
 * `GIT_AUTHOR_NAME` / `_EMAIL` / `_DATE` for the author, `EMAIL` for git's `$EMAIL`,
 * `GIT_ATTR_SOURCE` for the tree attributes are read from, `GIT_NO_REPLACE_OBJECTS` and
 * `GIT_REPLACE_REF_BASE` for replace refs, `GIT_GRAFT_FILE` for the grafts file,
 * `GIT_PRINT_SHA1_ELLIPSIS` for the `...` after abbreviated ids, `GIT_NOTES_REF`,
 * `GIT_NOTES_DISPLAY_REF`, `GIT_NOTES_REWRITE_REF`, `GIT_NOTES_REWRITE_MODE` for notes,
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_PARAMETERS` for the command-line config every config read
 * applies last, `GIT_CEILING_DIRECTORIES` and `GIT_DISCOVERY_ACROSS_FILESYSTEM` for
 * repository discovery), files read by absolute path. The system files default to `/etc/gitconfig` and
 * `/etc/gitattributes`.
 *
 * @example
 * ```typescript
 * // without `env`, process.env: its GIT_CONFIG_COUNT / GIT_CONFIG_PARAMETERS (a parent
 * // git's `-c`, or the shell's own) apply last to every config read
 * const environment = createNodeGitHostEnvironment();
 * const config = new GitWorkingCopyConfig(io, ".git/config", { environment });
 * // a test or a server pins the variables instead
 * const pinned = createNodeGitHostEnvironment({ env: { HOME: "/home/u", PATH: "/usr/bin" } });
 * ```
 */
export function createNodeGitHostEnvironment(
  options: NodeGitHostEnvironmentOptions = {},
): NodeGitHostEnvironment {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const xdgConfigHome = options.xdgConfigHome ?? env.XDG_CONFIG_HOME;
  const systemConfig = envBool(env.GIT_CONFIG_NOSYSTEM)
    ? undefined
    : (options.systemConfig ?? env.GIT_CONFIG_SYSTEM ?? "/etc/gitconfig");
  const systemAttributes = envBool(env.GIT_ATTR_NOSYSTEM)
    ? undefined
    : (options.systemAttributes ?? "/etc/gitattributes");
  const globalConfig = options.globalConfig ?? env.GIT_CONFIG_GLOBAL;
  const committer = {
    ...(env.GIT_COMMITTER_NAME !== undefined ? { name: env.GIT_COMMITTER_NAME } : {}),
    ...(env.GIT_COMMITTER_EMAIL !== undefined ? { email: env.GIT_COMMITTER_EMAIL } : {}),
    ...(env.GIT_COMMITTER_DATE !== undefined ? { date: env.GIT_COMMITTER_DATE } : {}),
  };
  const author = {
    ...(env.GIT_AUTHOR_NAME !== undefined ? { name: env.GIT_AUTHOR_NAME } : {}),
    ...(env.GIT_AUTHOR_EMAIL !== undefined ? { email: env.GIT_AUTHOR_EMAIL } : {}),
    ...(env.GIT_AUTHOR_DATE !== undefined ? { date: env.GIT_AUTHOR_DATE } : {}),
  };
  const pathspecFlags = {
    ...(env.GIT_LITERAL_PATHSPECS !== undefined ? { literal: env.GIT_LITERAL_PATHSPECS } : {}),
    ...(env.GIT_GLOB_PATHSPECS !== undefined ? { glob: env.GIT_GLOB_PATHSPECS } : {}),
    ...(env.GIT_NOGLOB_PATHSPECS !== undefined ? { noglob: env.GIT_NOGLOB_PATHSPECS } : {}),
    ...(env.GIT_ICASE_PATHSPECS !== undefined ? { icase: env.GIT_ICASE_PATHSPECS } : {}),
  };
  const pathspecs = Object.keys(pathspecFlags).length > 0 ? pathspecFlags : undefined;
  const effectiveUid =
    options.effectiveUid === null
      ? undefined
      : (options.effectiveUid ??
        (typeof process.geteuid === "function" ? process.geteuid() : undefined));
  // git dies at its first config read on command-line config it cannot parse: kept as the
  // error for the readers of the protected configuration to throw
  let commandLineConfig: Array<{ key: string; value: string | undefined }> = [];
  let commandLineConfigError: string | undefined;
  try {
    commandLineConfig = commandLineConfigOf(env);
  } catch (error) {
    if (!(error instanceof CommandLineConfigError)) throw error;
    commandLineConfigError = error.message;
  }
  const readHostFile = async (path: string) => {
    try {
      const [files, relative] = options.files ? [options.files, path] : hostFiles(path);
      // A FilesApi reads a missing file as empty: only read what is a file.
      if ((await files.stats(relative))?.kind !== "file") return undefined;
      return await readFile(files, relative);
    } catch {
      return undefined;
    }
  };
  return {
    readFile: readHostFile,
    // `~user/` (git's getpwnam): the user's entry in /etc/passwd, read through the FilesApi,
    // else the current user's own home when the name is theirs (a directory service user)
    expandUserHome: async (name: string) => {
      const passwd = await readHostFile("/etc/passwd");
      if (passwd) {
        for (const line of new TextDecoder().decode(passwd).split("\n")) {
          const fields = line.split(":");
          if (fields.length >= 7 && fields[0] === name) return fields[5];
        }
      }
      try {
        const me = userInfo();
        if (me.username === name) return me.homedir;
      } catch {
        // no user entry for this process
      }
      return undefined;
    },
    // the host's own files only (an injected FilesApi has no stat of them)
    ...(options.files
      ? {}
      : {
          statFile: async (path: string) =>
            statHostFile(path.startsWith("/") ? path : `${process.cwd()}/${path}`),
          realPath: (path: string) =>
            realHostPath(path.startsWith("/") ? path : `${process.cwd()}/${path}`),
        }),
    // uname's sysname (the untracked cache's ident: "Linux", "Darwin", "Windows_NT")
    systemName: osType(),
    ...(env.GIT_DISABLE_UNTRACKED_CACHE !== undefined && envBool(env.GIT_DISABLE_UNTRACKED_CACHE)
      ? { disableUntrackedCache: true }
      : {}),
    ...(env.GIT_FORCE_UNTRACKED_CACHE !== undefined
      ? { forceUntrackedCache: envBool(env.GIT_FORCE_UNTRACKED_CACHE) }
      : {}),
    ...(home ? { home } : {}),
    ...(xdgConfigHome ? { xdgConfigHome } : {}),
    ...(systemConfig ? { systemConfig } : {}),
    ...(systemAttributes ? { systemAttributes } : {}),
    ...(globalConfig ? { globalConfig } : {}),
    ...(Object.keys(committer).length > 0 ? { committer } : {}),
    ...(Object.keys(author).length > 0 ? { author } : {}),
    ...(env.EMAIL ? { defaultEmail: env.EMAIL } : {}),
    ...(env.GIT_ATTR_SOURCE !== undefined ? { attrSource: env.GIT_ATTR_SOURCE } : {}),
    // git: set to anything (even empty) turns replace refs off
    ...(env.GIT_NO_REPLACE_OBJECTS !== undefined ? { noReplaceObjects: true } : {}),
    ...(env.GIT_NO_LAZY_FETCH !== undefined ? { noLazyFetch: envBool(env.GIT_NO_LAZY_FETCH) } : {}),
    // the version of a new index (get_index_format_default), as given
    ...(env.GIT_INDEX_VERSION !== undefined ? { indexVersion: env.GIT_INDEX_VERSION } : {}),
    // git_env_bool("GIT_PROTOCOL_FROM_USER", 1)
    ...(env.GIT_PROTOCOL_FROM_USER !== undefined
      ? { protocolFromUser: envBool(env.GIT_PROTOCOL_FROM_USER) }
      : {}),
    ...(env.GIT_ALLOW_PROTOCOL !== undefined ? { allowProtocol: env.GIT_ALLOW_PROTOCOL } : {}),
    // set but empty is a base too (git: every ref is then a candidate replace ref)
    ...(env.GIT_REPLACE_REF_BASE !== undefined ? { replaceRefBase: env.GIT_REPLACE_REF_BASE } : {}),
    ...(env.GIT_GRAFT_FILE !== undefined ? { graftFile: env.GIT_GRAFT_FILE } : {}),
    // git's print_sha1_ellipsis: "yes" in any case
    ...(env.GIT_PRINT_SHA1_ELLIPSIS?.toLowerCase() === "yes" ? { printSha1Ellipsis: true } : {}),
    ...(env.GIT_ALTERNATE_OBJECT_DIRECTORIES !== undefined
      ? { alternateObjectDirectories: env.GIT_ALTERNATE_OBJECT_DIRECTORIES }
      : {}),
    ...(env.GIT_NOTES_REF !== undefined ? { notesRef: env.GIT_NOTES_REF } : {}),
    ...(env.GIT_NOTES_DISPLAY_REF !== undefined
      ? { notesDisplayRef: env.GIT_NOTES_DISPLAY_REF }
      : {}),
    ...(env.GIT_NOTES_REWRITE_REF !== undefined
      ? { notesRewriteRef: env.GIT_NOTES_REWRITE_REF }
      : {}),
    ...(env.GIT_NOTES_REWRITE_MODE !== undefined
      ? { notesRewriteMode: env.GIT_NOTES_REWRITE_MODE }
      : {}),
    // the global pathspec magic, as given (git_env_bool reads them when a pathspec is parsed)
    ...(pathspecs ? { pathspecs } : {}),
    ...(options.hookRunner ? { hookRunner: options.hookRunner } : {}),
    // the ownership checks (safe.directory): the effective uid, sudo's, git's test switch
    ...(effectiveUid !== undefined ? { effectiveUid } : {}),
    ...(env.SUDO_UID !== undefined ? { sudoUid: env.SUDO_UID } : {}),
    ...(envBool(env.GIT_TEST_ASSUME_DIFFERENT_OWNER) ? { assumeDifferentOwner: true } : {}),
    ...(commandLineConfig.length > 0 ? { commandLineConfig } : {}),
    ...(commandLineConfigError !== undefined ? { commandLineConfigError } : {}),
    // repository discovery: where it stops climbing
    ...(env.GIT_CEILING_DIRECTORIES !== undefined
      ? { ceilingDirectories: env.GIT_CEILING_DIRECTORIES }
      : {}),
    ...(envBool(env.GIT_DISCOVERY_ACROSS_FILESYSTEM) ? { discoveryAcrossFilesystem: true } : {}),
    prefix: options.prefix ?? "/usr",
  };
}
