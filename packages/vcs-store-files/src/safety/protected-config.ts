/**
 * git's protected configuration (config.c's `read_protected_config`): the system file, the
 * global files and the command line, never a repository's own `config`. Settings that decide
 * whether a repository may be used at all (`safe.directory`, `safe.bareRepository`) are read
 * only from here, so a repository cannot vouch for itself.
 */

import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";

import { GitWorkingCopyConfig } from "../workspace/working-copy/index.js";

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
  // the chain around a repository config that does not exist: only the system and global
  // files (with their includes) are read, as git's config_with_options with ignore_repo
  const config = new GitWorkingCopyConfig(
    {
      read: async () => undefined,
      write: async () => {
        throw new Error("the protected configuration is read-only");
      },
    },
    "/\u0000protected/config",
    { environment, includes: true },
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
  for (const { key, value } of environment.commandLineConfig ?? []) {
    out.push({ key, value, scope: "command" });
  }
  return out;
}
