/**
 * git's `upload-archive--writer` (builtin/upload-archive.c, archive.c's `write_archive` with
 * `remote = 1`): `git archive` run in a served repository with the arguments a
 * `git archive --remote` client sent, its stdout, stderr and exit status handed to the
 * upload-archive protocol (vcs-transport `serveUploadArchive`).
 */

import type { UploadArchiveOutput, UploadArchiveWriter } from "@statewalker/vcs-transport";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { OpenedRepository, WorkingCopy } from "@statewalker/vcs-working-tree";
import { GitApiError } from "../../errors/index.js";
import { worktreeAdminWorkingCopy } from "../worktree-support.js";
import { ArchiveCommand } from "./archive-command.js";

const encoder = new TextEncoder();

/** Options of {@link runArchiveWriter}. */
export interface ArchiveWriterOptions {
  /** `uploadarchive.allowUnreachable`: any tree-ish, not only one a ref names (default false) */
  allowUnreachable?: boolean;
  /** Prepares the command before it runs (a tar filter runner, the git version followed) */
  configure?: (command: ArchiveCommand) => void;
}

/**
 * Runs `git archive <args>` as upload-archive's writer runs it in `workingCopy` (a
 * repository's, its worktree never read): git's options parsed from `args`, only formats
 * served remotely, a tree-ish only by ref unless `allowUnreachable`. Never throws: git's
 * deaths are its stderr and exit status.
 *
 * @example
 * ```ts
 * const { stdout, exitCode } = await runArchiveWriter(workingCopy, ["--format=zip", "HEAD"]);
 * ```
 */
export async function runArchiveWriter(
  workingCopy: WorkingCopy,
  args: readonly string[],
  options: ArchiveWriterOptions = {},
): Promise<UploadArchiveOutput> {
  let command: ArchiveCommand | undefined;
  try {
    command = new ArchiveCommand(workingCopy).setUploadArchive({
      allowUnreachable: options.allowUnreachable === true,
    });
    options.configure?.(command);
    const list = applyArchiveArgs(command, args);
    if (list) {
      const lines = command.listFormats().map((name) => `${name}\n`);
      return { exitCode: 0, stdout: encoder.encode(lines.join("")), stderr: "" };
    }
    const archive = await command.call();
    return { exitCode: 0, stdout: archive, stderr: messagesOf(command) };
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    const exitCode = error instanceof GitApiError ? error.exitCode : 128;
    const text = /^(fatal|error|usage|warning):/.test(message) ? message : `fatal: ${message}`;
    return {
      exitCode,
      stdout: new Uint8Array(0),
      stderr: `${command ? messagesOf(command) : ""}${text}\n`,
    };
  }
}

function messagesOf(command: ArchiveCommand): string {
  return command
    .getMessages()
    .map((m) => `${m}\n`)
    .join("");
}

/**
 * {@link runArchiveWriter} for an opened repository (`Worktree.openRepository`), as git's
 * upload-archive serves it: in its git directory (no worktree), `uploadarchive.allowUnreachable`
 * read from its configuration. Undefined for a repository without worktrees to open (a
 * key-value or SQL store).
 *
 * @example
 * ```ts
 * const writer = uploadArchiveWriterOf(opened);
 * if (writer) await serveUploadArchive(duplex, writer);
 * ```
 */
export function uploadArchiveWriterOf(
  repository: OpenedRepository,
  options: Pick<ArchiveWriterOptions, "configure"> = {},
): UploadArchiveWriter | undefined {
  const worktrees = repository.worktrees;
  if (!worktrees) return undefined;
  return async (args) => {
    const value = repository.config?.getAll("uploadarchive.allowUnreachable").at(-1);
    const allowUnreachable = value === undefined ? false : (parseGitBool(value ?? "true") ?? false);
    const admin = await worktrees.openAdmin();
    return runArchiveWriter(withoutWorktree(worktreeAdminWorkingCopy(admin)), args, {
      allowUnreachable,
      ...options,
    });
  };
}

/** `workingCopy` read as git's upload-archive reads it: a git directory, no worktree. */
function withoutWorktree(workingCopy: WorkingCopy): WorkingCopy {
  if (!("worktree" in workingCopy)) return workingCopy;
  return new Proxy(workingCopy, {
    get: (target, key) => {
      if (key === "worktree") return undefined;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has: (target, key) => key !== "worktree" && key in target,
  });
}

/** archive.c's options (`parse_archive_args`). */
const VALUE_OPTIONS = new Set(["format", "prefix", "add-file", "add-virtual-file", "mtime"]);

/**
 * Applies `git archive`'s arguments to `command` as archive.c's `parse_archive_args` reads
 * them in a writer (`--remote`, `--exec` and `--output` refused): options anywhere before
 * `--`, the first other argument the tree-ish, the rest paths. True for `--list`.
 */
export function applyArchiveArgs(command: ArchiveCommand, args: readonly string[]): boolean {
  const positional: string[] = [];
  let list = false;
  let format: string | undefined;
  let extraFiles = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    if (/^-\d+$/.test(arg)) {
      command.setCompressionLevel(Number(arg.slice(1)));
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      let value = eq < 0 ? undefined : arg.slice(eq + 1);
      if (VALUE_OPTIONS.has(name) || name === "output" || name === "remote" || name === "exec") {
        if (value === undefined) {
          if (i + 1 >= args.length) {
            throw new GitApiError(`error: option \`${name}' requires a value`, { exitCode: 129 });
          }
          value = args[++i] as string;
        }
      } else if (value !== undefined) {
        throw new GitApiError(`error: option \`${name}' takes no value`, { exitCode: 129 });
      }
      switch (name) {
        case "format":
          format = value as string;
          break;
        case "prefix":
          command.setPrefix(value as string);
          break;
        case "add-file":
          // add_file_cb stats the file while parsing, in the server's git directory: no
          // host file is read here, every one reads as missing (git, finding one, would
          // die on --remote below)
          throw new GitApiError(`fatal: File not found: ${value}`);
        case "add-virtual-file":
          // refused below, once parsing is done, as parse_archive_args refuses it
          extraFiles = true;
          break;
        case "mtime":
          command.setMtime(value as string);
          break;
        case "worktree-attributes":
          command.setWorktreeAttributes(true);
          break;
        case "verbose":
          command.setVerbose(true);
          break;
        case "list":
          list = true;
          break;
        case "output":
          throw new GitApiError("fatal: Unexpected option --output");
        case "remote":
          throw new GitApiError("fatal: Unexpected option --remote");
        case "exec":
          throw new GitApiError("fatal: the option '--exec' requires '--remote'");
        default:
          throw new GitApiError(`error: unknown option \`${name}'`, { exitCode: 129 });
      }
      continue;
    }
    // short options, bundled (`-lv`), `-o <file>` taking the rest or the next argument
    for (let j = 1; j < arg.length; j++) {
      const c = arg[j];
      if (c === "v") command.setVerbose(true);
      else if (c === "l") list = true;
      else if (c === "o") throw new GitApiError("fatal: Unexpected option --output");
      else throw new GitApiError(`error: unknown switch \`${c}'`, { exitCode: 129 });
    }
  }
  if (extraFiles) {
    throw new GitApiError("fatal: options '--add-file' and '--remote' cannot be used together");
  }
  if (format !== undefined) command.setFormat(format);
  if (list) return true;
  const [tree, ...paths] = positional;
  if (tree !== undefined) command.setTree(tree);
  for (const path of paths) command.addPath(path);
  return false;
}
