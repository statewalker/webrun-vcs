/**
 * Installing git's content conversion on a working copy's worktree.
 */
import type { History } from "@statewalker/vcs-core";
import { decodeGitPatternFile } from "@statewalker/vcs-utils/encoding";
import type { Checkout } from "../checkout/checkout.js";
import type { WorkingCopyConfig } from "../working-copy.js";
import type { WorktreeContentFilter } from "../worktree/content-filter.js";
import type { Worktree } from "../worktree/worktree.js";
import type { FilterDriverRegistry } from "./filter-driver.js";
import {
  configValue,
  createGitContentFilter,
  GitContentFilter,
  gitBool,
} from "./git-content-filter.js";
import { expandUserPath, type GitHostEnvironment, xdgConfigPath } from "./host-environment.js";

/** How a working copy sets up its worktree's content conversion. */
export interface ContentFilterSetup {
  /**
   * The filter to install; `false` installs none (content passes as it is). Default: git's,
   * from the working copy's attributes and configuration.
   */
  contentFilter?: WorktreeContentFilter | false;
  /** The host's filter drivers (`filter=<name>`), for git's filter */
  filterDrivers?: FilterDriverRegistry;
  /** The user's environment (global attributes), for git's filter */
  environment?: GitHostEnvironment;
  /** Receives git's conversion warnings that no command collects */
  onWarning?: (message: string) => void;
}

/**
 * Lets the worktree read `core.ignoreCase` for its ignore rules, and the global excludes file
 * as git does: `core.excludesFile` from the configuration chain (`~/` in the home), else
 * `$XDG_CONFIG_HOME/git/ignore`, through the host's environment. Without an environment no
 * excludes file is read (the worktree's own `globalExcludesFile` option, if any, still
 * applies).
 */
export function installExcludesFile(
  parts: { worktree: Worktree; config?: WorkingCopyConfig },
  environment?: GitHostEnvironment,
): void {
  const { worktree, config } = parts;
  // the ignore rules fold ASCII case with core.ignoreCase, as git's do
  if (config) {
    worktree?.setIgnoreCaseReader?.(() => gitBool(configValue(config, "core.ignorecase")) ?? false);
  }
  if (!worktree?.setExcludesFileReader) return;
  const env =
    environment ?? (config as { environment?: GitHostEnvironment } | undefined)?.environment;
  if (!env) return;
  worktree.setExcludesFileReader(async () => {
    const configured = configValue(config, "core.excludesfile");
    const path =
      typeof configured === "string" && configured !== ""
        ? expandUserPath(configured, env)
        : xdgConfigPath(env, "ignore");
    if (!path) return undefined;
    const content = await env.readFile(path);
    return content ? decodeGitPatternFile(content) : undefined;
  });
}

/**
 * Installs a content filter on the worktree of a working copy. A filter the host set on the
 * worktree itself is kept; git's filter from an earlier working copy is replaced by one
 * reading this working copy's configuration and drivers.
 *
 * @example
 * ```typescript
 * installContentFilter({ history, checkout, worktree, config }, { filterDrivers: { lfs } });
 * ```
 */
export function installContentFilter(
  parts: { history: History; checkout: Checkout; worktree: Worktree; config?: WorkingCopyConfig },
  setup: ContentFilterSetup = {},
): void {
  const { worktree } = parts;
  installExcludesFile(parts, setup.environment);
  // a bare repository (no worktree) or a worktree without filter support
  if (!worktree?.setContentFilter) return;
  if (setup.contentFilter === false) {
    worktree.setContentFilter(undefined);
    return;
  }
  if (setup.contentFilter) {
    worktree.setContentFilter(setup.contentFilter);
    return;
  }
  // a filter the host installed itself is kept; git's (from an earlier opening of a working
  // copy on this worktree) is replaced, so the configuration and drivers given now apply
  if (worktree.contentFilter && !(worktree.contentFilter instanceof GitContentFilter)) return;
  worktree.setContentFilter(
    createGitContentFilter({
      worktree,
      staging: parts.checkout.staging,
      blobs: parts.history.blobs,
      trees: parts.history.trees,
      ...(parts.config ? { config: parts.config } : {}),
      ...(setup.filterDrivers ? { drivers: setup.filterDrivers } : {}),
      ...(setup.environment ? { environment: setup.environment } : {}),
      ...(setup.onWarning ? { onWarning: setup.onWarning } : {}),
    }),
  );
}
