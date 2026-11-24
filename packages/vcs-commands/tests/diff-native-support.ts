/**
 * What the native-twin tests of diffcore's options (copies, breaks, dirstat, anchored) share:
 * repositories set up by shell scripts with test-lib's helpers, native git run in them, and
 * our DiffCommand over the same repository, compared byte for byte.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";

import type { DiffCommand, DiffOutputFormat, DiffTextOptions, Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitEnv } from "./native-git-http-backend.js";

const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "";
const [major, minor] = (/(\d+)\.(\d+)/.exec(version) ?? ["", "0", "0"]).slice(1).map(Number);

/** Whether native git is at least `ma.mi` */
export const gitAtLeast = (ma: number, mi: number): boolean =>
  major > ma || (major === ma && minor >= mi);

/** Behaviour that changed between git 2.43 (sandbox) and 2.5x (CI) */
export const versionOptions: DiffTextOptions = {
  histogramRediff: gitAtLeast(2, 54),
  legacyMinimal: !gitAtLeast(2, 50),
  renameCountLastSpan: gitAtLeast(2, 50),
  namesFromContents: gitAtLeast(2, 50),
  quietDetectsRenames: !gitAtLeast(2, 50),
  exitCodeFromContents: gitAtLeast(2, 50),
};

/** A scratch directory removed by {@link cleanupScratch} */
export class Scratch {
  private root?: string;
  private count = 0;

  constructor(private readonly prefix: string) {}

  /** The scratch root (HOME of native git) */
  get home(): string {
    this.root ??= mkdtempSync(join(tmpdir(), this.prefix));
    return this.root;
  }

  /** A new directory name below the root */
  next(): string {
    return join(this.home, `repo-${++this.count}`);
  }

  cleanup(): void {
    if (this.root) rmSync(this.root, { recursive: true, force: true });
  }
}

/** lib-diff-data.sh's COPYING_test_data */
export const COPYING_TEST_DATA = `
 Note that the only valid version of the GPL as far as this project
 is concerned is _this_ particular version of the license (ie v2, not
 v2.2 or v3.x or whatever), unless explicitly otherwise stated.

 HOWEVER, in order to allow a migration to GPLv3 if that seems like
 a good idea, I also ask that people involved with the project make
 their preferences known. In particular, if you trust me to make that
 decision, you might note so in your copyright message, ie something
 like

\tThis file is licensed under the GPL v2, or a later version
\tat the discretion of Linus.

  might avoid issues. But we can also just decide to synchronize and
  contact all copyright holders on record if/when the occasion arises.

\t\t\tLinus Torvalds
`;

/** test-lib.sh's helpers, a clock that ticks per commit */
const PRELUDE = `
tick=1112911993
test_tick () { tick=$((tick + 60)); export GIT_COMMITTER_DATE="$tick +0000" GIT_AUTHOR_DATE="$tick +0000"; }
test_write_lines () { printf "%s\\n" "$@"; }
commit () { test_tick; git commit -q "$@"; }
COPYING_test_data () { printf '%s' '${COPYING_TEST_DATA.replace(/'/g, "'\\''")}'; }
`;

/** Runs a shell script (with test-lib's helpers) in `dir`, making it first. */
export function sh(scratch: Scratch, dir: string, script: string): string {
  execFileSync("mkdir", ["-p", dir]);
  return execFileSync("bash", ["-ec", PRELUDE + script], {
    cwd: dir,
    env: nativeGitEnv(scratch.home),
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

/** A new repository on `main`, set up by `script` */
export function repo(scratch: Scratch, script: string): string {
  const dir = scratch.next();
  sh(scratch, dir, `git init -q -b main .\n${script}`);
  return dir;
}

export interface Outcome {
  status: number;
  stdout: Buffer;
  /** The `fatal:`, `error:` and `warning:` lines of stderr */
  messages: string[];
}

const messageLines = (text: string): string[] =>
  text.split("\n").filter((l) => /^(fatal|error|warning): /.test(l));

/** Native git's outcome of `args` in `dir` */
export function native(scratch: Scratch, dir: string, args: string[]): Outcome {
  const res = spawnSync("git", args, {
    cwd: dir,
    env: { ...nativeGitEnv(scratch.home), COLUMNS: "80" },
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout,
    messages: messageLines(res.stderr.toString()),
  };
}

/** Our working copy over the repository at `dir` */
export function openGit(scratch: Scratch, dir: string): Promise<Git> {
  return openOurs(dir, createNodeGitHostEnvironment({ env: nativeGitEnv(scratch.home) }));
}

/** Our DiffCommand's outcome in `format` */
export async function oursDiff(
  scratch: Scratch,
  dir: string,
  build: (d: DiffCommand) => DiffCommand,
  format: DiffOutputFormat,
): Promise<Outcome> {
  const git = await openGit(scratch, dir);
  try {
    const d = build(git.diff().setOptions(versionOptions));
    const bytes = await d.callBytes(format);
    return {
      status: d.exitCode,
      stdout: Buffer.from(bytes),
      messages: messageLines(d.warnings.join("\n")),
    };
  } catch (e) {
    const err = e as { exitCode?: number; message: string };
    return {
      status: err.exitCode ?? -1,
      stdout: Buffer.alloc(0),
      messages: messageLines(err.message),
    };
  }
}

/** The difference between two outcomes, described; undefined when they agree */
export function differs(label: string, theirs: Outcome, mine: Outcome): string | undefined {
  const problems: string[] = [];
  if (theirs.status !== mine.status) problems.push(`status ${theirs.status} vs ${mine.status}`);
  if (!theirs.stdout.equals(mine.stdout)) {
    problems.push(`stdout\n--- git\n${theirs.stdout}\n--- ours\n${mine.stdout}`);
  }
  if (theirs.messages.join("\n") !== mine.messages.join("\n")) {
    problems.push(
      `stderr\n--- git\n${theirs.messages.join("\n")}\n--- ours\n${mine.messages.join("\n")}`,
    );
  }
  return problems.length > 0 ? `${label}: ${problems.join("\n")}` : undefined;
}

/** The command-line options of each output format */
export const FORMAT_ARGS: Record<DiffOutputFormat, string[]> = {
  patch: [],
  stat: ["--stat"],
  numstat: ["--numstat"],
  shortstat: ["--shortstat"],
  summary: ["--summary"],
  "name-only": ["--name-only"],
  "name-status": ["--name-status"],
  check: ["--check"],
  dirstat: ["--dirstat"],
};

/**
 * Runs `git <args>` with the format's options and our diff in that format, adding a mismatch
 * to `out`.
 */
export async function twin(
  scratch: Scratch,
  out: string[],
  dir: string,
  args: string[],
  build: (d: DiffCommand) => DiffCommand,
  format: DiffOutputFormat = "patch",
): Promise<void> {
  const dash = args.indexOf("--");
  const nativeArgs =
    dash < 0
      ? [...args, ...FORMAT_ARGS[format]]
      : [...args.slice(0, dash), ...FORMAT_ARGS[format], ...args.slice(dash)];
  const theirs = native(scratch, dir, nativeArgs);
  const mine = await oursDiff(scratch, dir, build, format);
  const m = differs(`git ${nativeArgs.join(" ")}`, theirs, mine);
  if (m) out.push(m);
}

/** Each of the formats, as {@link twin} */
export async function twinFormats(
  scratch: Scratch,
  out: string[],
  dir: string,
  args: string[],
  build: (d: DiffCommand) => DiffCommand,
  formats: DiffOutputFormat[] = ["patch", "stat", "numstat", "name-status", "summary"],
): Promise<void> {
  for (const f of formats) await twin(scratch, out, dir, args, build, f);
}
