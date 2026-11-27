/**
 * Host drivers that run git's configured commands as git runs them, for the native twins of
 * `filter.<driver>.*`, `diff.<driver>.textconv` and `merge.<driver>.driver`: portable code
 * runs no processes, so a host registers callbacks; these are the callbacks a Node host
 * would register to behave as native git.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { type FilterDriver, FilterDriverRunError } from "@statewalker/vcs-working-tree";

import { createMergeDriver, type MergeDriver, type TextconvRunner } from "../src/index.js";

/** git's sq_quote_buf: `'...'` with each `'` as `'\''` (and `!` as `'\!'`). */
export function sqQuote(text: string): string {
  return `'${text.replace(/['!]/g, (c) => `'\\${c}'`)}'`;
}

/** The exit status run_command reports: the code, or 128 plus the signal's number. */
function statusOf(res: ReturnType<typeof spawnSync>): number {
  if (res.status !== null) return res.status;
  const signals: Record<string, number> = { SIGKILL: 9, SIGTERM: 15, SIGPIPE: 13, SIGINT: 2 };
  return 128 + (signals[res.signal ?? ""] ?? 1);
}

/**
 * A filter driver running `filter.<driver>.clean` / `.smudge` as convert.c's
 * apply_single_file_filter: the command (`%f` the path, quoted) through the shell in the
 * worktree's top, the content on stdin, its stdout the result; a failure throws (the
 * required check then dies as git does). A direction without a command fails too, as a
 * driver git has no command for.
 */
export function shellFilterDriver(top: string, env: Record<string, string>): FilterDriver {
  const run = async (
    content: Uint8Array,
    context: { path: string; command?: string },
  ): Promise<Uint8Array> => {
    const command = context.command;
    if (!command) throw new Error("no command");
    const expanded = command.replace(/%(.)/g, (m, c: string) =>
      c === "f" ? sqQuote(context.path) : c === "%" ? "%" : m,
    );
    const res = spawnSync("sh", ["-c", expanded], { cwd: top, input: content, env });
    const status = statusOf(res);
    if (status !== 0)
      throw new FilterDriverRunError([`external filter '${command}' failed ${status}`]);
    return new Uint8Array(res.stdout);
  };
  return { clean: run, smudge: run };
}

/**
 * A textconv runner as diff.c's run_textconv: the command through the shell in the
 * worktree's top, with a temporary file named after the path as its one argument.
 */
export function shellTextconvRunner(top: string, env: Record<string, string>): TextconvRunner {
  return async ({ command, path, content }) => {
    const dir = mkdtempSync(join(top, ".textconv-"));
    try {
      const file = join(dir, `XXXXXX_${basename(path)}`);
      writeFileSync(file, content);
      const res = spawnSync("sh", ["-c", `${command} "$@"`, command, file], { cwd: top, env });
      if (statusOf(res) !== 0) throw new Error(`error running textconv command '${command}'`);
      return new Uint8Array(res.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

let tempCounter = 0;

const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "";
const [major, minor] = (/(\d+)\.(\d+)/.exec(gitVersion) ?? ["", "0", "0"]).slice(1).map(Number);
/** `%S`, `%X` and `%Y` exist from git 2.44 on (older versions keep them as they are) */
const revisionNames = (major ?? 0) > 2 || ((major ?? 0) === 2 && (minor ?? 0) >= 44);

/**
 * A merge driver running `merge.<driver>.driver` as merge-ll.c's ll_ext_merge: the three
 * versions in temporary files (`%O`, `%A`, `%B`), `%L` the marker size, `%P`/`%S`/`%X`/`%Y`
 * quoted, the command through the shell in the worktree's top; `%A` read back as the
 * result, a non-zero status up to 128 a conflict, a signal an error.
 */
export function shellMergeDriver(top: string, env: Record<string, string>): MergeDriver {
  return createMergeDriver(async (input) => {
    const command = input.command;
    if (command === undefined) throw new Error("no command");
    const temps = [input.base, input.ours, input.theirs].map((content) => {
      const name = `.merge_file_${process.pid.toString(36)}${(tempCounter++).toString(36)}`;
      writeFileSync(join(top, name), content);
      return name;
    });
    const values: Record<string, string> = {
      O: temps[0] as string,
      A: temps[1] as string,
      B: temps[2] as string,
      L: String(input.markerSize),
      P: sqQuote(input.path),
      ...(revisionNames
        ? {
            S: sqQuote(input.baseLabel),
            X: sqQuote(input.oursLabel),
            Y: sqQuote(input.theirsLabel),
          }
        : {}),
      "%": "%",
    };
    const expanded = command.replace(/%(.)/g, (_m, c: string) => values[c] ?? `%${c}`);
    const res = spawnSync("sh", ["-c", expanded], {
      cwd: top,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const status = statusOf(res);
    let content = new Uint8Array(0);
    try {
      content = new Uint8Array(readFileSync(join(top, temps[1] as string)));
    } catch {
      // gone: an empty result
    }
    for (const t of temps) {
      try {
        unlinkSync(join(top, t));
      } catch {
        // already gone
      }
    }
    if (status > 128) return { content, conflict: true, error: true };
    return { content, conflict: status !== 0 };
  });
}
