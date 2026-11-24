/**
 * Test-only: native twins of `git describe` and `git name-rev`. A repository is built with
 * native git (t/test-lib's `test_commit` and `test_tick`), then each command runs twice on
 * it, native git and ours, and stdout, stderr and the exit status are compared.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DescribeError, type Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitEnv } from "./native-git-http-backend.js";

/** What one side printed. */
export interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
}

/** t/test-lib's clock: 1112911993, 60 seconds per test_tick, `-0700`. */
export class Shell {
  private time = 1112911993;

  constructor(readonly home: string) {}

  /** test_tick */
  tick(): void {
    this.time += 60;
  }

  /** The dates of the current tick (author and committer). */
  dates(): Record<string, string> {
    const date = `${this.time} -0700`;
    return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  }

  /** Native git in `cwd` (`GIT_EDITOR=true`, the current tick's dates). */
  git(
    cwd: string,
    args: string[],
    options: { env?: Record<string, string>; input?: string } = {},
  ): Outcome {
    const r = spawnSync("git", args, {
      cwd,
      env: { ...nativeGitEnv(this.home), GIT_EDITOR: "true", ...this.dates(), ...options.env },
      encoding: "utf8",
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  /** Native git that must succeed; its stdout. */
  ok(cwd: string, ...args: string[]): string {
    const r = this.git(cwd, args);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  }

  /**
   * test_commit [--annotate] [--no-tag] [--date <d>] <message> [<file> [<contents> [<tag>]]]
   */
  commit(dir: string, ...argv: string[]): void {
    let annotate = false;
    let noTag = false;
    let date: string | undefined;
    const args: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i] as string;
      if (a === "--annotate") annotate = true;
      else if (a === "--no-tag") noTag = true;
      else if (a === "--date") date = argv[++i];
      else args.push(a);
    }
    const [message, file = `${message}.t`, contents = message, tag = message] = args as [
      string,
      string?,
      string?,
      string?,
    ];
    const path = join(dir, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${contents}\n`);
    this.ok(dir, "add", "--", file);
    if (!date) this.tick();
    const env: Record<string, string> = date
      ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      : {};
    const r = this.git(dir, ["commit", "-q", "-m", message], { env });
    if (r.status !== 0) throw new Error(`commit failed: ${r.stderr}`);
    if (!noTag) {
      this.ok(dir, ...(annotate ? ["tag", "-a", "-m", message, tag] : ["tag", tag]));
    }
  }
}

/** The git version (2.43 or 2.5x) the native side follows. */
export function compatibilityOf(shell: Shell): "2.43" | "2.56" {
  const v = shell.ok(shell.home, "--version").match(/(\d+)\.(\d+)/);
  return v && Number(v[1]) === 2 && Number(v[2]) < 50 ? "2.43" : "2.56";
}

const text = (lines: string[]) => lines.map((l) => `${l}\n`).join("");

async function outcomeOf(
  run: () => Promise<{ stdout: string; stderr: string[] }>,
): Promise<Outcome> {
  try {
    const r = await run();
    return { status: 0, stdout: r.stdout, stderr: text(r.stderr) };
  } catch (e) {
    if (e instanceof DescribeError) {
      return { status: e.exitCode, stdout: e.stdout, stderr: `${e.message}\n` };
    }
    throw e;
  }
}

/** `git describe <argv>` mapped onto our DescribeCommand. */
export function describeArgs(git: Git, argv: string[], compatibility: "2.43" | "2.56") {
  const command = git.describe().setCompatibility(compatibility);
  const match: string[] = [];
  const exclude: string[] = [];
  const revs: string[] = [];
  for (const arg of argv) {
    const [opt, value] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    switch (opt) {
      case "--tags":
        command.setTags(true);
        break;
      case "--all":
        command.setAll(true);
        break;
      case "--long":
        command.setLong(true);
        break;
      case "--no-long":
        command.setLong(false);
        break;
      case "--first-parent":
        command.setFirstParent(true);
        break;
      case "--exact-match":
        command.setExactMatch(true);
        break;
      case "--no-exact-match":
        command.setExactMatch(false);
        break;
      case "--contains":
        command.setContains(true);
        break;
      case "--always":
        command.setAlways(true);
        break;
      case "--debug":
        command.setDebug(true);
        break;
      case "--abbrev":
        command.setAbbrev(Number(value));
        break;
      case "--no-abbrev":
        command.setAbbrev(0);
        break;
      case "--candidates":
        command.setCandidates(Number(value));
        break;
      case "--match":
        match.push(value as string);
        break;
      case "--no-match":
        match.length = 0;
        break;
      case "--exclude":
        exclude.push(value as string);
        break;
      case "--dirty":
        command.setDirty(value ?? "-dirty");
        break;
      case "--broken":
        command.setBroken(value ?? "-broken");
        break;
      default:
        revs.push(arg);
    }
  }
  return command
    .setMatch(...match)
    .setExclude(...exclude)
    .setRevisions(...revs);
}

/** `git name-rev <argv>` mapped onto our NameRevCommand. */
export function nameRevArgs(git: Git, argv: string[], input?: string) {
  const command = git.nameRev();
  for (const arg of argv) {
    const [opt, value] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    switch (opt) {
      case "--name-only":
        command.setNameOnly(true);
        break;
      case "--tags":
        command.setTags(true);
        break;
      case "--refs":
        command.addRefs(value as string);
        break;
      case "--exclude":
        command.addExclude(value as string);
        break;
      case "--no-undefined":
        command.setUndefined(false);
        break;
      case "--always":
        command.setAlways(true);
        break;
      case "--all":
        command.setAll(true);
        break;
      case "--annotate-stdin":
        command.setAnnotateStdin(input ?? "");
        break;
      case "--peel-tag":
        command.setPeelTag(true);
        break;
      default:
        command.addRevisions(arg);
    }
  }
  return command;
}

/** `git describe <argv>` in `dir`, native and ours. */
export async function describeTwin(
  shell: Shell,
  dir: string,
  argv: string[],
): Promise<{ native: Outcome; ours: Outcome }> {
  const native = shell.git(dir, ["describe", ...argv]);
  const git = await openOurs(dir);
  const ours = await outcomeOf(() => describeArgs(git, argv, compatibilityOf(shell)).callText());
  return { native, ours };
}

/** `git name-rev <argv>` in `dir`, native and ours (`input` on stdin). */
export async function nameRevTwin(
  shell: Shell,
  dir: string,
  argv: string[],
  input?: string,
): Promise<{ native: Outcome; ours: Outcome }> {
  const native = shell.git(dir, ["name-rev", ...argv], input !== undefined ? { input } : {});
  const git = await openOurs(dir);
  const ours = await outcomeOf(() => nameRevArgs(git, argv, input).call());
  return { native, ours };
}
