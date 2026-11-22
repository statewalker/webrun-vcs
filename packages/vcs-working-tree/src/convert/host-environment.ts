/**
 * What a host tells the repository about the user's environment: where git's global and
 * system files are (`~/.gitconfig`, `$XDG_CONFIG_HOME/git/*`, `$(prefix)/etc/gitconfig`) and
 * how to read them. Opt-in: a browser passes nothing, and only the repository's own files
 * are read; a Node app passes the user's (`createNodeGitHostEnvironment` in
 * `@statewalker/vcs-utils-node`).
 */

import type { LinkStats } from "@statewalker/vcs-utils/files";

/** The user's environment, as a host provides it. */
export interface GitHostEnvironment {
  /** Reads a file of the host by its path (as the paths below name it); undefined when absent */
  readFile(path: string): Promise<Uint8Array | undefined>;
  /**
   * The stat of a host file (links followed), for what git records of it: the untracked
   * cache keeps the stat of `core.excludesFile`. Absent: recorded as zeros.
   */
  statFile?(path: string): Promise<LinkStats | undefined>;
  /**
   * The real path of a host path, its symbolic links followed (`realpath(3)`): the git
   * directory as git exports it to hooks (`GIT_DIR`). Absent: paths are taken as given.
   */
  realPath?(path: string): Promise<string | undefined>;
  /**
   * The operating system's name as `uname` gives it (`Linux`, `Darwin`): git's untracked
   * cache is valid only for the worktree location and system it names. Absent: no untracked
   * cache is used.
   */
  systemName?: string;
  /** `$GIT_DISABLE_UNTRACKED_CACHE` is true: the untracked cache is never used */
  disableUntrackedCache?: boolean;
  /**
   * `$GIT_FORCE_UNTRACKED_CACHE`: true writes a changed untracked cache even without
   * `core.untrackedCache=true`; false never writes one
   */
  forceUntrackedCache?: boolean;
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
  /**
   * `$GIT_NO_LAZY_FETCH` as a boolean (git's `git_env_bool`, default false; git 2.45+): a
   * partial clone fetches no absent object on a read (`fetch_if_missing = 0`), and a batch
   * asked for is refused with "lazy fetching disabled; some objects may not be available"
   */
  noLazyFetch?: boolean;
  /**
   * `$GIT_INDEX_VERSION` as given: the version a new index is written in, before
   * `index.version` and `feature.manyFiles` (read-cache.c `get_index_format_default`; a
   * value that is not 2, 3 or 4 falls back to 3 with a warning)
   */
  indexVersion?: string;
  /**
   * `$GIT_PROTOCOL_FROM_USER` as a boolean (git's `git_env_bool`, default true): whether
   * transports whose `protocol.<name>.allow` is `user` may be used (false when git runs a
   * command on the user's behalf, as for submodules)
   */
  protocolFromUser?: boolean;
  /**
   * `$GIT_ALLOW_PROTOCOL`: a colon-separated list of the only transports allowed, overriding
   * every `protocol.*.allow` setting (git's `protocol_allow_list`)
   */
  allowProtocol?: string;
  /**
   * `$GIT_REPLACE_REF_BASE`: where replace refs live (default `refs/replace/`); set but empty,
   * every ref is a candidate replace ref, as in git
   */
  replaceRefBase?: string;
  /**
   * `$GIT_GRAFT_FILE`: the grafts file read in place of `info/grafts`, as given; a relative
   * path names a file in the worktree top (the git directory when bare), where git reads it
   * (see `graftFileReader` of vcs-core)
   */
  graftFile?: string;
  /**
   * `$GIT_PRINT_SHA1_ELLIPSIS` is `yes` (any case): abbreviated ids are followed by `...`
   * where git's `print_sha1_ellipsis` asks for it (checkout's "HEAD is now at <abbrev>...")
   */
  printSha1Ellipsis?: boolean;
  /**
   * `$GIT_ALTERNATE_OBJECT_DIRECTORIES` as set: the alternates a quarantined push's
   * pre-receive gets the repository's objects appended to (tmp-objdir.c's `env_append`)
   */
  alternateObjectDirectories?: string;
  /** `$GIT_NOTES_REF`: the notes ref of `git notes` and of `git log` (over `core.notesRef`) */
  notesRef?: string;
  /** `$GIT_NOTES_DISPLAY_REF`: the notes refs `git log` shows (colon-separated globs) */
  notesDisplayRef?: string;
  /** `$GIT_NOTES_REWRITE_REF`: the notes refs rewritten commits carry notes over in */
  notesRewriteRef?: string;
  /** `$GIT_NOTES_REWRITE_MODE`: how such a note combines with one there */
  notesRewriteMode?: string;
  /**
   * The global pathspec magic as set, unparsed (pathspec.c reads each with `git_env_bool`
   * when it parses a pathspec, so a bad value fails only then): `$GIT_LITERAL_PATHSPECS`,
   * `$GIT_GLOB_PATHSPECS`, `$GIT_NOGLOB_PATHSPECS` and `$GIT_ICASE_PATHSPECS`
   */
  pathspecs?: { literal?: string; glob?: string; noglob?: string; icase?: string };
  /**
   * Runs the repository's hooks (githooks(5)): the commands find a hook through the
   * repository's files (`core.hooksPath`, else `$GIT_DIR/hooks`) and hand it to this runner
   * to execute. Absent: no hook runs, as in a browser (`createNodeHookRunner` of
   * `@statewalker/vcs-utils-node` spawns them on Node).
   */
  hookRunner?: HookRunner;
  /**
   * The process's effective user id (POSIX `geteuid`): what git compares the owner of a
   * repository with before it uses one (`safe.directory`, "detected dubious ownership").
   * Absent (a browser, Windows), or with a FilesApi whose `lstat` reports no `uid`, the
   * ownership checks pass, as on systems without file owners.
   */
  effectiveUid?: number;
  /**
   * `$SUDO_UID` as set: when {@link effectiveUid} is root, a repository owned by this user
   * counts as the user's own (git's `extract_id_from_env`)
   */
  sudoUid?: string;
  /** `$GIT_TEST_ASSUME_DIFFERENT_OWNER` is true: every repository fails the ownership check */
  assumeDifferentOwner?: boolean;
  /**
   * The configuration given on git's command line (`git -c`), as git passes it to its child
   * processes in `$GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` and then
   * `$GIT_CONFIG_PARAMETERS`, in that order; keys canonical (section and variable in lower
   * case), a value undefined for a key given without `=`. git reads it last, in scope
   * `command` (`git config --show-origin`: `command line:`), on every config read: the
   * configuration chain of a working copy, of a submodule (git's `prepare_other_repo_env`
   * keeps it) and of a repository opened for serving, and the protected configuration
   * (`safe.directory`, `safe.bareRepository`). The remote side of a local transport never
   * sees it (`local_repo_env` clears it: `Worktree.openRepository`'s `commandLineConfig:
   * false`).
   */
  commandLineConfig?: Array<{ key: string; value: string | undefined }>;
  /**
   * The command-line configuration could not be parsed (a bogus `$GIT_CONFIG_PARAMETERS` or
   * `$GIT_CONFIG_COUNT`, a missing `GIT_CONFIG_KEY_<n>`): git's lines, `error: <reason>` and
   * `fatal: unable to parse command-line config`. git dies at its first config read, so every
   * config read that includes the command line refuses with it (`CommandLineConfigError`,
   * exit 128).
   */
  commandLineConfigError?: string;
  /**
   * `$GIT_CEILING_DIRECTORIES` as set: a colon-separated list of absolute host paths
   * repository discovery does not climb to (each canonicalised with {@link realPath} until an
   * empty entry, relative entries ignored; setup.c's `canonicalize_ceiling_entry`)
   */
  ceilingDirectories?: string;
  /**
   * `$GIT_DISCOVERY_ACROSS_FILESYSTEM` is true: repository discovery climbs past a file
   * system boundary (default: it stops where the device id of the FilesApi's `lstat`
   * changes, "Stopping at filesystem boundary")
   */
  discoveryAcrossFilesystem?: boolean;
  /**
   * The home directory of user `name`, for `~name/` in path settings (git's `getpwnam`):
   * undefined when there is no such user (git then dies "failed to expand user dir").
   * Absent, `~name/` cannot be expanded here: the ownership checks skip such a
   * `safe.directory` entry.
   */
  expandUserHome?(name: string): Promise<string | undefined>;
  /**
   * git's runtime prefix (`system_path`, `/usr` for a distribution's git): what `%(prefix)/`
   * in a path setting expands to. Absent, such a relative path names nothing.
   */
  prefix?: string;
}

/**
 * One hook to run, as git's `run_hooks_opt` starts it: the script, its arguments, what it
 * reads on stdin, the variables git sets for it, and the directory it runs in (the worktree
 * top; the git directory of a bare repository).
 *
 * @example
 * ```typescript
 * // pre-commit of `git commit`
 * { name: "pre-commit", path: ".git/hooks/pre-commit", args: [],
 *   env: { GIT_INDEX_FILE: ".git/index", GIT_EDITOR: ":", GIT_PREFIX: "" },
 *   cwd: "", stdoutToStderr: true }
 * ```
 */
export interface HookInvocation {
  /** The hook's name (`pre-commit`) */
  name: string;
  /**
   * The script as git names it, its `argv[0]`: relative to {@link cwd} (`.git/hooks/pre-commit`,
   * `hooks/pre-commit` of a relative `core.hooksPath`) or absolute
   */
  path: string;
  /** The script's absolute path on the host, where the repository's files have one */
  hostPath?: string;
  /** The arguments after the script */
  args: string[];
  /** What the hook reads on stdin; absent: nothing (git's `no_stdin`, /dev/null) */
  stdin?: Uint8Array;
  /** The variables git sets for this hook (added to the host's own) */
  env: Record<string, string>;
  /**
   * Variables removed from the host's own for this hook (git's `opt.env` entries without a
   * value: `worktree add` unsets `GIT_DIR` and `GIT_WORK_TREE` for post-checkout)
   */
  unsetEnv?: string[];
  /** The directory the hook runs in, as a path of the repository's files ("" for the root) */
  cwd: string;
  /** That directory on the host, where the repository's files have one */
  hostCwd?: string;
  /** The hook's stdout is sent to its stderr (git's default for hooks, `stdout_to_stderr`) */
  stdoutToStderr: boolean;
  /**
   * A hook the configuration defines (git 2.5x's `hook.<name>.command`): a shell command run
   * as git's `use_shell` runs it (`sh -c '<command> "$@"' '<command>' <args>...`) rather than
   * a script file; {@link path} then holds the command too
   */
  command?: string;
}

/** What a hook did: its exit code and what it wrote. */
export interface HookOutcome {
  /** The exit code (128 + the signal for a hook a signal killed) */
  exitCode: number;
  /** What it wrote on stdout (empty when sent to stderr) */
  stdout: Uint8Array;
  /** What it wrote on stderr (its stdout too, with `stdoutToStderr`), in order */
  stderr: Uint8Array;
}

/**
 * Executes hooks for the repository's commands. The commands find the hook (an executable
 * file) themselves and call {@link run}; a runner that cannot start the script answers
 * `undefined` ("no hook"), and the command goes on as without it.
 */
export interface HookRunner {
  run(invocation: HookInvocation): Promise<HookOutcome | undefined>;
  /**
   * Starts the hook and hands back the running process, its stdin and stdout piped to the
   * caller (git's `start_command` with `in = out = -1`: receive-pack talks to proc-receive
   * while it runs); undefined when the script cannot be started ("no hook"). Without it such
   * a hook is given its whole stdin at once through {@link run}.
   */
  start?(invocation: HookInvocation, options?: HookStartOptions): Promise<HookProcess | undefined>;
  /**
   * The git version whose wording and order the hooks follow where versions differ (the
   * `advice.ignoredHook` hint, reference-transaction's states); default `2.56`
   */
  compatibility?: "2.43" | "2.56";
}

/** How {@link HookRunner.start} hands back a started hook's stderr. */
export interface HookStartOptions {
  /**
   * Called with each chunk of the hook's stderr as it writes it (git's `copy_to_sideband`);
   * the outcome of `wait()` then has no stderr. A runner calls it for every chunk before
   * `wait()` resolves.
   */
  onStderr?(chunk: Uint8Array): void;
}

/** A hook running, talked to while it runs (see {@link HookRunner.start}). */
export interface HookProcess {
  /** Writes to its stdin; rejects once it closed it (it exited) */
  write(data: Uint8Array): Promise<void>;
  /** Closes its stdin */
  closeStdin(): Promise<void>;
  /** Its stdout, as it writes it */
  readonly stdout: AsyncIterable<Uint8Array>;
  /** Stops reading its stdout, closing the pipe (its later writes fail, as after git's `close`) */
  closeStdout(): void;
  /** Waits for it to exit: its exit code and stderr (`stdout` empty: read through {@link stdout}) */
  wait(): Promise<HookOutcome>;
  /** Stops it (receive-pack gave up on it: `hookTimeoutMs`); optional */
  kill?(): void;
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

/**
 * `environment` as git's `local_repo_env` leaves it for the remote side of a local transport
 * (`git-upload-pack '<path>'`, `git-receive-pack '<path>'` started by `connect.c`): without
 * the command-line configuration ({@link GitHostEnvironment.commandLineConfig} and its
 * error), everything else kept. Undefined stays undefined.
 *
 * @example
 * ```typescript
 * const remote = withoutCommandLineConfig(environment); // `git -c x.y=1 push ../r`: r sees no x.y
 * ```
 */
export function withoutCommandLineConfig<T extends GitHostEnvironment | undefined>(
  environment: T,
): T {
  if (!environment) return environment;
  if (
    environment.commandLineConfig === undefined &&
    environment.commandLineConfigError === undefined
  ) {
    return environment;
  }
  const proto = Object.getPrototypeOf(environment);
  if (proto === Object.prototype || proto === null) {
    const { commandLineConfig: _c, commandLineConfigError: _e, ...rest } = environment;
    return rest as T;
  }
  // a class instance: its methods stay reachable through the prototype chain
  return Object.create(environment, {
    commandLineConfig: { value: undefined, enumerable: true },
    commandLineConfigError: { value: undefined, enumerable: true },
  }) as T;
}
