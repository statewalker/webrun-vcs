/**
 * Shared pieces of the `git blame` native twins of ignored revisions and `--reverse`: a
 * repository opened by ours, native git run in it, and one `git blame` argv applied to both
 * and compared byte for byte in the output formats asked for.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
  GitCheckout,
  type GitCheckoutFilesApi,
  GitWorkingCopyConfig,
} from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { MemoryWorkingCopy } from "@statewalker/vcs-working-tree";

import { type BlameCommand, formatBlame, formatBlamePorcelain, Git } from "../src/index.js";
import { nativeGitEnv } from "./native-git-http-backend.js";

const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "";
const [major, minor] = (/(\d+)\.(\d+)/.exec(version) ?? ["", "0", "0"]).slice(1).map(Number);
export const atLeast = (ma: number, mi: number) => major > ma || (major === ma && minor >= mi);
export const compatibility = {
  histogramRediff: atLeast(2, 54),
  legacyMinimal: !atLeast(2, 50),
  renameCountLastSpan: atLeast(2, 50),
  optionalPaths: atLeast(2, 52),
};
/** git before 2.5x widened the abbreviated ids by one even without a boundary commit */
export const alwaysWidenAbbrev = !atLeast(2, 50);

/** Native git in `cwd`, its stdout trimmed */
export function git(
  home: string,
  cwd: string,
  args: string[],
  input?: string | Uint8Array,
  env: Record<string, string> = {},
): string {
  return execFileSync("git", args, {
    cwd,
    input,
    env: { ...nativeGitEnv(home), ...env },
    stdio: ["pipe", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

/** The environment of a commit made at `tick` (test-lib's test_tick) by `name` */
export const tickEnv = (name: string, tick: number): Record<string, string> => ({
  GIT_AUTHOR_NAME: name,
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_AUTHOR_DATE: `${1112911993 + tick * 60} -0700`,
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_COMMITTER_DATE: `${1112911993 + tick * 60} -0700`,
});

/** The repository in `dir` opened by ours (its config read now) */
export async function open(dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const { history } = await createGitFilesBackend({ files });
  const io = {
    read: async (path: string) => {
      try {
        return new Uint8Array(readFileSync(join(dir, path)));
      } catch {
        return undefined;
      }
    },
    write: async (path: string, content: Uint8Array) => writeFileSync(join(dir, path), content),
  };
  const config = new GitWorkingCopyConfig(io, ".git/config");
  await config.load();
  const staging = new FileStagingStore(files, ".git/index");
  const checkout = new GitCheckout({
    staging,
    refs: history.refs,
    files: {
      read: io.read,
      write: (p: string, c: Uint8Array) => files.write(p, [c]),
      stats: async () => undefined,
      remove: async () => {},
    } as unknown as GitCheckoutFilesApi,
    gitDir: ".git",
  });
  const worktree = createFileWorktree({
    files,
    rootPath: "",
    gitDir: ".git",
    blobs: history.blobs,
    trees: history.trees,
  });
  return Git.fromWorkingCopy(new MemoryWorkingCopy({ history, checkout, worktree, config }));
}

/**
 * The options of a `git blame` argv applied to our command; revisions (`--reverse A..B`,
 * the start) resolved by native git
 */
export function applyArgs(
  cmd: BlameCommand,
  args: string[],
  resolve: (rev: string) => string,
): void {
  let copies = 0;
  let copyScore: number | undefined;
  const ignoreRevs: string[] = [];
  const ignoreFiles: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let m = /^-M(\d*)$/.exec(a);
    if (m) cmd.setDetectMoves(true, m[1] ? Number(m[1]) : undefined);
    m = /^-C(\d*)$/.exec(a);
    if (m) {
      copies++;
      if (m[1]) copyScore = Number(m[1]);
    }
    if (a === "--root") cmd.setShowRoot(true);
    if (a === "-w") cmd.setIgnoreWhitespace(true);
    if (a === "--first-parent") cmd.setFirstParent(true);
    m = /^-L(\d+),(\d+)$/.exec(a);
    if (m) cmd.setLineRanges([[Number(m[1]), Number(m[2])]]);
    if (a === "--ignore-rev") ignoreRevs.push(args[++i]);
    if (a === "--ignore-revs-file") ignoreFiles.push(args[++i]);
    if (a === "--reverse") {
      const range = args[++i];
      const dots = range.indexOf("..");
      if (dots < 0) cmd.setReverse(resolve(range));
      else {
        cmd.setReverse(resolve(range.slice(0, dots)));
        cmd.setStartCommit(resolve(range.slice(dots + 2)));
      }
    }
  }
  if (copies) cmd.setDetectCopies(copies, copyScore);
  if (ignoreRevs.length) cmd.setIgnoreRevs(ignoreRevs);
  if (ignoreFiles.length) cmd.setIgnoreRevsFiles(ignoreFiles);
}

export interface CompareOptions {
  /** The start commit (`git blame <rev> -- <path>`); none with `--reverse` (in `args`) */
  rev?: string;
  /** The output formats compared (default `--porcelain` and the default output) */
  formats?: string[][];
}

/** Our output and native git's of `git blame <format> <args> [<rev>] -- <path>` */
export async function compareBlame(
  home: string,
  dir: string,
  ours: Git,
  path: string,
  args: string[],
  options: CompareOptions = {},
): Promise<string[]> {
  const formats = options.formats ?? [["--porcelain"], []];
  const resolve = (rev: string) => git(home, dir, ["rev-parse", `${rev}^{commit}`]);
  const cmd = ours.blame().setFilePath(path).setCompatibility(compatibility);
  if (options.rev) cmd.setStartCommit(resolve(options.rev));
  applyArgs(cmd, args, resolve);
  if (!atLeast(2, 50)) cmd.setAlgorithm("myers");
  const result = await cmd.call();
  const autoAbbrev = await result.autoAbbrev?.();
  const mismatches: string[] = [];
  for (const format of formats) {
    const mine =
      format[0] === "--porcelain"
        ? formatBlamePorcelain(result, { lineMarks: atLeast(2, 50) })
        : format[0] === "--line-porcelain"
          ? formatBlamePorcelain(result, { linePorcelain: true, lineMarks: atLeast(2, 50) })
          : formatBlame(result, {
              alwaysWidenAbbrev,
              autoAbbrev,
              showName: format.includes("-f"),
              showNumber: format.includes("-n"),
              longObjectName: format.includes("-l"),
              blankBoundary: format.includes("-b"),
            });
    const argv = ["blame", ...format, ...args, ...(options.rev ? [options.rev] : []), "--", path];
    const res = spawnSync("git", argv, { cwd: dir, env: nativeGitEnv(home), maxBuffer: 1 << 26 });
    if (res.status !== 0) throw new Error(`git ${argv.join(" ")}: ${res.stderr}`);
    if (!res.stdout.equals(Buffer.from(mine))) {
      mismatches.push(
        `git ${argv.join(" ")}\n--- git\n${res.stdout}\n--- ours\n${Buffer.from(mine)}`,
      );
    }
  }
  return mismatches;
}

/** A small deterministic random generator */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
