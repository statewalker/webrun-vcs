/**
 * The user's git environment on Node: where `~/.gitconfig`, `$XDG_CONFIG_HOME/git/*` and the
 * system files are, and how to read them. Hosts pass it to the configuration
 * (`GitWorkingCopyConfig`'s `environment`) and to working copies, so global settings
 * (`core.autocrlf`, `core.attributesFile`, includes with `~/`) apply as in git. Its shape is
 * `GitHostEnvironment` of `@statewalker/vcs-working-tree`.
 */
import { homedir } from "node:os";

import { type FilesApi, readFile } from "@statewalker/vcs-utils/files";

import { NodeFilesApi } from "@statewalker/webrun-files-node";

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
}

/** The environment as `GitHostEnvironment` describes it. */
export interface NodeGitHostEnvironment {
  readFile(path: string): Promise<Uint8Array | undefined>;
  home?: string;
  xdgConfigHome?: string;
  systemConfig?: string;
  systemAttributes?: string;
  globalConfig?: string;
  committer?: { name?: string; email?: string; date?: string };
  author?: { name?: string; email?: string; date?: string };
  defaultEmail?: string;
}

/**
 * One Node FilesApi per file-system root: `/`, a Windows drive such as `C:/`, or a UNC share
 * such as `//server/share`. It is the plain `NodeFilesApi`, which follows symbolic links (a
 * linked `~/.gitconfig`, macOS's `/etc` -> `/private/etc`), as git's reads of these files do.
 */
const hostRoots = new Map<string, FilesApi>();

/**
 * The host FilesApi that holds a path, and the path inside it. A relative path is read from
 * the current directory, as git's `fopen` reads it.
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
 * `GIT_AUTHOR_NAME` / `_EMAIL` / `_DATE` for the author, `EMAIL` for git's `$EMAIL`), files
 * read by absolute path. The system files default to `/etc/gitconfig` and
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
    ...(home ? { home } : {}),
    ...(xdgConfigHome ? { xdgConfigHome } : {}),
    ...(systemConfig ? { systemConfig } : {}),
    ...(systemAttributes ? { systemAttributes } : {}),
    ...(globalConfig ? { globalConfig } : {}),
    ...(Object.keys(committer).length > 0 ? { committer } : {}),
    ...(Object.keys(author).length > 0 ? { author } : {}),
    ...(env.EMAIL ? { defaultEmail: env.EMAIL } : {}),
  };
}
