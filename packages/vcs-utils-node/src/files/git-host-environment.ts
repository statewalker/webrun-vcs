/**
 * The user's git environment on Node: where `~/.gitconfig`, `$XDG_CONFIG_HOME/git/*` and the
 * system files are, and how to read them. Hosts pass it to the configuration
 * (`GitWorkingCopyConfig`'s `environment`) and to working copies, so global settings
 * (`core.autocrlf`, `core.attributesFile`, includes with `~/`) apply as in git. Its shape is
 * `GitHostEnvironment` of `@statewalker/vcs-working-tree`.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

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
}

/** The environment as `GitHostEnvironment` describes it. */
export interface NodeGitHostEnvironment {
  readFile(path: string): Promise<Uint8Array | undefined>;
  home?: string;
  xdgConfigHome?: string;
  systemConfig?: string;
  systemAttributes?: string;
  globalConfig?: string;
}

/** git's `git_env_bool`: set to anything but a false value. */
function envBool(value: string | undefined): boolean {
  if (value === undefined) return false;
  const text = value.trim().toLowerCase();
  return !["", "0", "false", "no", "off"].includes(text);
}

/**
 * The user's git environment read from the process (`HOME`, `XDG_CONFIG_HOME`,
 * `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_ATTR_NOSYSTEM`), files
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
  return {
    readFile: async (path: string) => {
      try {
        return new Uint8Array(await readFile(path));
      } catch {
        return undefined;
      }
    },
    ...(home ? { home } : {}),
    ...(xdgConfigHome ? { xdgConfigHome } : {}),
    ...(systemConfig ? { systemConfig } : {}),
    ...(systemAttributes ? { systemAttributes } : {}),
    ...(globalConfig ? { globalConfig } : {}),
  };
}
