/**
 * Textconv (`diff.<driver>.textconv`): git runs the configured command on a file and diffs
 * its output instead of the file. Running a command is not portable, so the host registers
 * a runner, much as it registers filter and merge drivers; without one no textconv applies
 * (the patch shows the content as it is, "Binary files ... differ" for binary content),
 * where git would fail to run the command.
 *
 * @example
 * ```typescript
 * // `*.pdf diff=pdf` in .gitattributes, `diff.pdf.textconv = pdftotext -` in the config
 * installTextconvRunner(workingCopy, async ({ command, path, content }) => {
 *   return runShellCommand(command, path, content); // the host's way of running it
 * });
 * const patch = await git.diff().callText();
 * ```
 */

import type { WorkingCopy } from "@statewalker/vcs-working-tree";

/** What a textconv runner is asked to convert. */
export interface TextconvRequest {
  /** The diff driver's name (`diff=<driver>`) */
  driver: string;
  /**
   * The command (`diff.<driver>.textconv`); git runs it through the shell with the path of
   * a file holding `content` as its one argument, and diffs what it prints
   */
  command: string;
  /** The path of the file in the repository (git names its temporary file after it) */
  path: string;
  /** The content to convert: the blob's, or the worktree file's as `git add` would store it */
  content: Uint8Array;
  /** `diff.<driver>.cachetextconv`: git may keep the output; it does not change it */
  cache: boolean;
}

/** Runs a textconv command for the host; throws when the command fails. */
export type TextconvRunner = (request: TextconvRequest) => Promise<Uint8Array>;

const installed = new WeakMap<object, TextconvRunner>();

/** Registers the runner of textconv commands for the diffs of `workingCopy`. */
export function installTextconvRunner(workingCopy: WorkingCopy, runner: TextconvRunner): void {
  installed.set(workingCopy, runner);
}

/** The textconv runner registered for `workingCopy`, if any. */
export function textconvRunnerOf(workingCopy: WorkingCopy): TextconvRunner | undefined {
  return installed.get(workingCopy);
}
