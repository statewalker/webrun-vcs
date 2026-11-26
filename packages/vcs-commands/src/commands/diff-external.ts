/**
 * External diff programs, as diff.c's `run_external_diff` runs them: `GIT_EXTERNAL_DIFF` or
 * `diff.external` (any path), `diff.<driver>.command` (the paths of a driver, winning over
 * both), each called once per file pair with git's seven arguments
 *
 *     <path> <old-file> <old-hex> <old-mode> <new-file> <new-hex> <new-mode>
 *
 * plus `<new-path> <extended header lines>` for a rename or copy, and only `<path>` for an
 * unmerged path. An absent side is `/dev/null . .`; a side that is the worktree's file is
 * that file, named from the worktree's top (its id the null id when git has not hashed it);
 * any other side is a temporary file `$TMPDIR/git-blob-XXXXXX/<basename>` holding the blob as
 * checkout writes it. The program runs through the host's hook runner (portable code starts
 * no process); the temporary files are written through the host's FilesApi of that
 * directory and removed after the program ends.
 *
 * @example
 * ```ts
 * // GIT_EXTERNAL_DIFF=echo git diff
 * const env = createNodeGitHostEnvironment({ env: { GIT_EXTERNAL_DIFF: "echo" } });
 * const text = await git.diff().callText(); // "file /tmp/git-blob-AbC123/file <id> 100644 file 0000... 100644\n"
 * ```
 */
import type { FilesApi } from "@statewalker/vcs-utils/files";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";

import { GitApiError } from "../errors/index.js";

/** A program git runs instead of its builtin patch */
export interface ExternalDiffProgram {
  /** The command, run through the shell with the arguments after it */
  command: string;
  /** `trustExitCode` (git 2.46+): exit code 0 means the pair shows no change, 1 a change */
  trustExitCode: boolean;
}

/** git's `git_parse_maybe_bool` of a variable (`git_env_bool`), false when unset or not one */
function envBool(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "false" || v === "no" || v === "off") return false;
  if (v === "true" || v === "yes" || v === "on") return true;
  const n = Number(v);
  return Number.isFinite(n) ? n !== 0 : false;
}

/**
 * diff.c's `external_diff()`: `$GIT_EXTERNAL_DIFF` (with
 * `$GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE`), else `diff.external` (with `diff.trustExitCode`),
 * which only git's UI configuration reads (`config` undefined for plumbing).
 */
export function externalDiffProgramOf(
  environment: Pick<GitHostEnvironment, "diffVariables"> | undefined,
  config: ((key: string) => string | undefined) | undefined,
): ExternalDiffProgram | undefined {
  const vars = environment?.diffVariables ?? {};
  const fromEnv = vars.GIT_EXTERNAL_DIFF;
  if (fromEnv !== undefined) {
    return { command: fromEnv, trustExitCode: envBool(vars.GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE) };
  }
  const command = config?.("diff.external");
  if (command === undefined) return undefined;
  return { command, trustExitCode: envBool(config?.("diff.trustexitcode")) };
}

const TEMP_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * The temporary files of one external diff call (tempfile.c's `mks_tempfile_dt`): each side
 * in a directory `git-blob-XXXXXX` of the host's temporary directory, named as the file's
 * basename (an external program then sees a "pretty" name), removed by {@link removeAll}.
 */
export class ExternalDiffTempFiles {
  private readonly made: Array<{ files: FilesApi; dir: string }> = [];

  constructor(
    private readonly environment: Pick<GitHostEnvironment, "hostFilesOf" | "tempDirectory">,
  ) {}

  /** Whether files can be written for a program to read (a host FilesApi of the directory) */
  get available(): boolean {
    return this.environment.hostFilesOf !== undefined;
  }

  /** Writes `content` as `<tmp>/git-blob-XXXXXX/<basename of path>`; its host path */
  async write(path: string, content: Uint8Array): Promise<string> {
    const top = (this.environment.tempDirectory ?? "/tmp").replace(/\/+$/, "") || "/";
    const host = await this.environment.hostFilesOf?.(top);
    if (!host) throw new Error("unable to create temp-file");
    const base = path.slice(path.lastIndexOf("/") + 1);
    for (let attempt = 0; attempt < 100; attempt++) {
      let suffix = "";
      for (let i = 0; i < 6; i++) {
        suffix += TEMP_LETTERS[Math.floor(Math.random() * TEMP_LETTERS.length)];
      }
      const name = `git-blob-${suffix}`;
      const dir = host.path ? `${host.path.replace(/\/+$/, "")}/${name}` : name;
      if (await host.files.stats(dir)) continue;
      await host.files.mkdir(dir);
      this.made.push({ files: host.files, dir });
      await host.files.write(`${dir}/${base}`, [content]);
      return `${top === "/" ? "" : top}/${name}/${base}`;
    }
    throw new Error("unable to create temp-file");
  }

  /** Removes every directory {@link write} made (git's `remove_tempfile`) */
  async removeAll(): Promise<void> {
    for (const { files, dir } of this.made.splice(0)) {
      try {
        await files.remove(dir);
      } catch {
        // a temporary file the program removed itself
      }
    }
  }
}

/**
 * Thrown where git dies after an external diff program failed (`fatal: external diff died,
 * stopping at <path>`, exit status 128): an exit code other than 0 (or 1 under
 * `trustExitCode`), or a program the host could not run.
 */
export class ExternalDiffDiedError extends GitApiError {
  /** What git wrote on stdout before it died (the programs' output, earlier patches) */
  output: Uint8Array = new Uint8Array(0);

  constructor(readonly path: string) {
    super(`external diff died, stopping at ${path}`, { exitCode: 128 });
    this.name = "ExternalDiffDiedError";
  }
}
