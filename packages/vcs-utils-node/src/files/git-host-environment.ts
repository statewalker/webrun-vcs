/**
 * The user's git environment on Node: where `~/.gitconfig`, `$XDG_CONFIG_HOME/git/*` and the
 * system files are, and how to read them. Hosts pass it to the configuration
 * (`GitWorkingCopyConfig`'s `environment`) and to working copies, so global settings
 * (`core.autocrlf`, `core.attributesFile`, includes with `~/`) apply as in git. Its shape is
 * `GitHostEnvironment` of `@statewalker/vcs-working-tree`.
 */
import { homedir, type as osType } from "node:os";

import { type FilesApi, readFile } from "@statewalker/vcs-utils/files";

import { NodeFilesApi } from "@statewalker/webrun-files-node";

import type { NodeHookRunner } from "./node-hook-runner.js";
import { statHostFile } from "./posix-node-files-api.js";

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
}

/** The environment as `GitHostEnvironment` describes it. */
export interface NodeGitHostEnvironment {
  readFile(path: string): Promise<Uint8Array | undefined>;
  statFile?(path: string): Promise<import("@statewalker/vcs-utils/files").LinkStats | undefined>;
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
  protocolFromUser?: boolean;
  allowProtocol?: string;
  replaceRefBase?: string;
  graftFile?: string;
  printSha1Ellipsis?: boolean;
  notesRef?: string;
  notesDisplayRef?: string;
  notesRewriteRef?: string;
  notesRewriteMode?: string;
  pathspecs?: { literal?: string; glob?: string; noglob?: string; icase?: string };
  hookRunner?: NodeHookRunner;
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
 * The user's git environment read from the process (`HOME`, `XDG_CONFIG_HOME`,
 * `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_ATTR_NOSYSTEM`, and
 * `GIT_COMMITTER_NAME` / `_EMAIL` / `_DATE` for the committer and the reflog identity,
 * `GIT_AUTHOR_NAME` / `_EMAIL` / `_DATE` for the author, `EMAIL` for git's `$EMAIL`,
 * `GIT_ATTR_SOURCE` for the tree attributes are read from, `GIT_NO_REPLACE_OBJECTS` and
 * `GIT_REPLACE_REF_BASE` for replace refs, `GIT_GRAFT_FILE` for the grafts file,
 * `GIT_PRINT_SHA1_ELLIPSIS` for the `...` after abbreviated ids, `GIT_NOTES_REF`,
 * `GIT_NOTES_DISPLAY_REF`, `GIT_NOTES_REWRITE_REF`, `GIT_NOTES_REWRITE_MODE` for notes),
 * files read by absolute path. The system files default to `/etc/gitconfig` and
 * `/etc/gitattributes`.
 *
 * @example
 * ```typescript
 * const environment = createNodeGitHostEnvironment();
 * const config = new GitWorkingCopyConfig(io, ".git/config", { environment });
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
  return {
    readFile: async (path: string) => {
      try {
        const [files, relative] = options.files ? [options.files, path] : hostFiles(path);
        // A FilesApi reads a missing file as empty: only read what is a file.
        if ((await files.stats(relative))?.kind !== "file") return undefined;
        return await readFile(files, relative);
      } catch {
        return undefined;
      }
    },
    // the host's own files only (an injected FilesApi has no stat of them)
    ...(options.files
      ? {}
      : {
          statFile: async (path: string) =>
            statHostFile(path.startsWith("/") ? path : `${process.cwd()}/${path}`),
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
  };
}
