/**
 * The user's git environment on Node: where `~/.gitconfig`, `$XDG_CONFIG_HOME/git/*` and the
 * system configuration are, and how to read them. Hosts pass it to the configuration
 * (`GitWorkingCopyConfig`'s `environment`) and to working copies, so global settings
 * (`core.autocrlf`, `core.attributesFile`, includes with `~/`) apply as in git. Its shape is
 * `GitHostEnvironment` of `@statewalker/vcs-working-tree`.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

/** Where the files are; each defaults to the process environment, as git reads it. */
export interface NodeGitHostEnvironmentOptions {
  /** `$HOME` (default: `process.env.HOME`, else the OS home directory) */
  home?: string;
  /** `$XDG_CONFIG_HOME` (default: `process.env.XDG_CONFIG_HOME`) */
  xdgConfigHome?: string;
  /**
   * The system configuration file (`$(prefix)/etc/gitconfig`, for example
   * `/etc/gitconfig`); not read when absent or when `GIT_CONFIG_NOSYSTEM` is set
   */
  systemConfig?: string;
  /** The system attributes file (`$(prefix)/etc/gitattributes`); not read when absent */
  systemAttributes?: string;
}

/** The environment as `GitHostEnvironment` describes it. */
export interface NodeGitHostEnvironment {
  readFile(path: string): Promise<Uint8Array | undefined>;
  home?: string;
  xdgConfigHome?: string;
  systemConfig?: string;
  systemAttributes?: string;
}

/**
 * The user's git environment read from the process (`HOME`, `XDG_CONFIG_HOME`,
 * `GIT_CONFIG_NOSYSTEM`), files read by absolute path.
 *
 * @example
 * ```typescript
 * const environment = createNodeGitHostEnvironment({ systemConfig: "/etc/gitconfig" });
 * const config = new GitWorkingCopyConfig(io, ".git/config", { environment });
 * ```
 */
export function createNodeGitHostEnvironment(
  options: NodeGitHostEnvironmentOptions = {},
): NodeGitHostEnvironment {
  const home = options.home ?? process.env.HOME ?? homedir();
  const xdgConfigHome = options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
  const noSystem = !!process.env.GIT_CONFIG_NOSYSTEM;
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
    ...(options.systemConfig && !noSystem ? { systemConfig: options.systemConfig } : {}),
    ...(options.systemAttributes ? { systemAttributes: options.systemAttributes } : {}),
  };
}
