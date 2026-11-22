/**
 * git's protected configuration (config.c's `read_protected_config`): the system file, the
 * global files and the command line, never a repository's own `config`. Settings that decide
 * whether a repository may be used at all (`safe.directory`, `safe.bareRepository`) are read
 * only from here, so a repository cannot vouch for itself.
 */

import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";

import { GitWorkingCopyConfig } from "../workspace/working-copy/index.js";

/**
 * The command-line configuration git cannot parse (exit 128): its message is git's two lines,
 * `error: <reason>` and `fatal: unable to parse command-line config`.
 */
export class CommandLineConfigError extends Error {
  readonly exitCode = 128;
  constructor(message: string) {
    super(message);
    this.name = "CommandLineConfigError";
  }
}

/** One value of the protected configuration, in the order git reads them. */
export interface ProtectedConfigEntry {
  /** The canonical key (`safe.directory`) */
  key: string;
  /** The value as written; undefined for a key without `=` (git's NULL value) */
  value: string | undefined;
  /** Where it comes from: the system file, a global file, the command line */
  scope: "system" | "global" | "command";
  /** The file it was read from (absent for the command line) */
  file?: string;
  /** Its line in that file */
  line?: number;
}

/**
 * The protected configuration of `environment`: the system file, then the global files
 * (`$GIT_CONFIG_GLOBAL`, else `$XDG_CONFIG_HOME/git/config` and `~/.gitconfig`), their
 * includes followed, then the command line ({@link GitHostEnvironment.commandLineConfig}).
 * Empty without an environment.
 *
 * @example
 * ```typescript
 * const entries = await readProtectedConfig(createNodeGitHostEnvironment());
 * entries.filter((e) => e.key === "safe.directory").map((e) => e.value);
 * ```
 */
export async function readProtectedConfig(
  environment: GitHostEnvironment | undefined,
): Promise<ProtectedConfigEntry[]> {
  if (!environment) return [];
  // config_with_options: the files are read first, then git dies on the command line
  const unparseable = environment.commandLineConfigError;
  const commandLine = environment.commandLineConfig ?? [];
  // the chain around a repository config that does not exist: only the system and global
  // files (with their includes) are read, as git's config_with_options with ignore_repo;
  // and, as git passes no git directory there, `gitdir:` / `onbranch:` conditions are false
  // (the placeholder path never counts as one), `hasconfig:remote.*.url:` matched against
  // the remote URLs of these files and of the command line
  const config = new GitWorkingCopyConfig(
    {
      read: async () => undefined,
      write: async () => {
        throw new Error("the protected configuration is read-only");
      },
    },
    "/\u0000protected/config",
    {
      environment,
      includes: true,
      withoutGitDir: true,
      extraRemoteUrls: commandLine.flatMap(({ key, value }) =>
        /^remote\..*\.url$/i.test(key) && value !== undefined ? [value] : [],
      ),
    },
  );
  await config.load();
  const out: ProtectedConfigEntry[] = [];
  for (const entry of config.listWithOrigin()) {
    if (entry.scope !== "system" && entry.scope !== "global") continue;
    out.push({
      key: entry.key,
      value: entry.text,
      scope: entry.scope,
      ...(entry.file !== undefined ? { file: entry.file } : {}),
      ...(entry.line !== undefined ? { line: entry.line } : {}),
    });
  }
  if (unparseable !== undefined) throw new CommandLineConfigError(unparseable);
  for (const { key, value } of commandLine) {
    out.push({ key, value, scope: "command" });
  }
  return out;
}
