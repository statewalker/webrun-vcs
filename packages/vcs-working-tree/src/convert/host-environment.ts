/**
 * What a host tells the repository about the user's environment: where git's global and
 * system files are (`~/.gitconfig`, `$XDG_CONFIG_HOME/git/*`, `$(prefix)/etc/gitconfig`) and
 * how to read them. Opt-in: a browser passes nothing, and only the repository's own files
 * are read; a Node app passes the user's (`createNodeGitHostEnvironment` in
 * `@statewalker/vcs-utils-node`).
 */

/** The user's environment, as a host provides it. */
export interface GitHostEnvironment {
  /** Reads a file of the host by its path (as the paths below name it); undefined when absent */
  readFile(path: string): Promise<Uint8Array | undefined>;
  /** The user's home directory (`$HOME`): `~/.gitconfig`, `~/` in paths */
  home?: string;
  /** `$XDG_CONFIG_HOME` (default `<home>/.config`) */
  xdgConfigHome?: string;
  /** The system configuration file (`$(prefix)/etc/gitconfig`); not read when absent */
  systemConfig?: string;
  /**
   * The one global configuration file (`$GIT_CONFIG_GLOBAL`), read instead of
   * `$XDG_CONFIG_HOME/git/config` and `~/.gitconfig`
   */
  globalConfig?: string;
  /** The system attributes file (`$(prefix)/etc/gitattributes`); not read when absent */
  systemAttributes?: string;
  /**
   * `$GIT_ATTR_SOURCE` (which `git --attr-source=<tree-ish>` sets): the tree-ish the in-tree
   * attributes files are read from, over the `attr.tree` setting
   */
  attrSource?: string;
  /**
   * git's committer variables (`GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`,
   * `GIT_COMMITTER_DATE`), as `git_committer_info` reads them ahead of `user.name`,
   * `user.email` and the clock: the identity and time of the reflog lines commands write.
   * Also the committer of the commits commands make and the tagger of their tags. `date`
   * in any form git's `parse_date` reads (`1700000000 +0000`, `@1700000000`, RFC 2822,
   * ISO 8601).
   */
  committer?: { name?: string; email?: string; date?: string };
  /**
   * git's author variables (`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_AUTHOR_DATE`), as
   * `git_author_info` reads them ahead of `author.*`, `user.*` and the clock: the author of
   * the commits commands make. `date` in any form git's `parse_date` reads.
   */
  author?: { name?: string; email?: string; date?: string };
  /**
   * `$EMAIL`: the email of an identity configured nowhere else (git's `ident_default_email`,
   * read after `user.email`). git then guesses `user@host`; a portable host does not.
   */
  defaultEmail?: string;
  /**
   * `$GIT_NO_REPLACE_OBJECTS` is set (to anything): replace refs are not applied, as with
   * `core.useReplaceRefs=false` (git's `disable_replace_refs`)
   */
  noReplaceObjects?: boolean;
  /** `$GIT_REPLACE_REF_BASE`: where replace refs live (default `refs/replace/`) */
  replaceRefBase?: string;
}

const join = (dir: string, name: string) =>
  dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;

/**
 * A path from the configuration as git's `interpolate_path` reads it: `~/x` in the home
 * directory, others as they are. Undefined for `~/x` without a home, and for `~user/x`.
 */
export function expandUserPath(
  path: string,
  environment: GitHostEnvironment | undefined,
): string | undefined {
  if (path === "~" || path.startsWith("~/")) {
    if (!environment?.home) return undefined;
    return path === "~" ? environment.home : join(environment.home, path.slice(2));
  }
  if (path.startsWith("~")) return undefined;
  return path;
}

/** git's `xdg_config_home(name)`: `$XDG_CONFIG_HOME/git/<name>` or `~/.config/git/<name>`. */
export function xdgConfigPath(
  environment: GitHostEnvironment | undefined,
  name: string,
): string | undefined {
  if (environment?.xdgConfigHome) return join(join(environment.xdgConfigHome, "git"), name);
  if (environment?.home) return join(join(join(environment.home, ".config"), "git"), name);
  return undefined;
}
