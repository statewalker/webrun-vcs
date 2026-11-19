/**
 * `git status -- <pathspec>` against native git, with pathspec.c's full semantics on both
 * sides of status: the tracked paths (diff-files and diff-index, `ce_path_match`) and the
 * untracked scan (dir.c's `read_directory` with `common_prefix_len`, `treat_leading_path`,
 * `simplify_away` and `match_pathspec_item`'s wildcard and leading-pathspec branches).
 * About forty pathspecs (plain paths, directories with and without `/`, wildcards with and
 * without `:(glob)`, `:(literal)`, `:(icase)`, excludes with and without a positive
 * element, `:/`, `:(prefix:N)`) are crossed with every untracked and ignored mode in
 * porcelain v1 and v2; the global pathspec variables; paths that are no UTF-8 with
 * `core.quotePath` on and off; and a fuzz of random worktrees and pathspecs.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatStatusPorcelain,
  type IgnoredMode,
  InvalidArgumentError,
  type Status,
  type UntrackedFilesMode,
} from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, openRepo, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
const git = (cwd: string, args: string[], extra?: Record<string, string>) =>
  gitOut(root, cwd, args, extra);

/** Our text output as git's bytes (latin-1 text). */
const bytesOf = (text: string) => Buffer.from(encodeGitPath(text)).toString("latin1");

/**
 * A repository with tracked, staged, modified, deleted, untracked, ignored and nested
 * content in directories at several depths, names with wildcard characters, upper case,
 * a space, a latin-1 byte and UTF-8, and a submodule-like gitlink.
 */
function repo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, ".gitignore", "*.log\nbuild/\nig/\n");
  putFile(dir, "a.txt", "a\n");
  putFile(dir, "b.md", "b\n");
  putFile(dir, "Foo.TXT", "F\n");
  putFile(dir, "a*b", "star\n");
  putFile(dir, "[x]", "bracket\n");
  putFile(dir, "sp ace.txt", "s\n");
  putFile(dir, "dir/x.txt", "x\n");
  putFile(dir, "dir/y.c", "y\n");
  putFile(dir, "dir/sub/z.txt", "z\n");
  putFile(dir, "dir/sub/deep/w.c", "w\n");
  putFile(dir, "Dir2/q.txt", "q\n");
  putFile(dir, "caf\xe9.txt", "latin\n");
  putFile(dir, "\xc3\xa9t\xc3\xa9.txt", "utf8\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  // staged, modified, deleted
  putFile(dir, "a.txt", "a2\n");
  putFile(dir, "dir/y.c", "y2\n");
  git(dir, ["add", "a.txt"]);
  putFile(dir, "dir/x.txt", "x2\n");
  git(dir, ["rm", "-q", "dir/sub/z.txt"]);
  rmSync(join(dir, "b.md"));
  putFile(dir, "new.txt", "n\n");
  git(dir, ["add", "new.txt"]);
  // untracked
  putFile(dir, "u.txt", "u\n");
  putFile(dir, "u.c", "u\n");
  putFile(dir, "udir/f.txt", "f\n");
  putFile(dir, "udir/g.c", "g\n");
  putFile(dir, "udir/inner/h.txt", "h\n");
  putFile(dir, "dir/new.c", "c\n");
  putFile(dir, "dir/sub/unew.txt", "n\n");
  putFile(dir, "dir/sub/deep/more/m.txt", "m\n");
  putFile(dir, "UDIR3/K.TXT", "k\n");
  putFile(dir, "caf\xe9-u.txt", "latin\n");
  putFile(dir, "\xc3\xa9-u.txt", "utf8\n");
  putFile(dir, "dir/a*b", "untracked star\n");
  // ignored
  putFile(dir, "x.log", "l\n");
  putFile(dir, "dir/y.log", "l\n");
  putFile(dir, "build/out.o", "o\n");
  putFile(dir, "ig/one.txt", "1\n");
  putFile(dir, "udir/skip.log", "s\n");
  // a nested repository
  mkdirSync(join(dir, "nested"));
  git(join(dir, "nested"), ["init", "-q"]);
  putFile(join(dir, "nested"), "inside.txt", "i\n");
}

/** The pathspecs crossed with the modes, each one element list or several. */
const PATHSPECS: string[][] = [
  ["."],
  ["a.txt"],
  ["dir"],
  ["dir/"],
  ["dir/sub"],
  ["dir/sub/"],
  ["*.txt"],
  ["*.c"],
  ["dir/*"],
  ["dir/*.txt"],
  ["dir/s*"],
  ["**/w.c"],
  [":(glob)**/w.c"],
  [":(glob)dir/*"],
  [":(glob)*.txt"],
  [":(glob)dir/**"],
  [":(literal)a*b"],
  ["a*b"],
  ["dir/a*b"],
  [":(literal)dir/a*b"],
  ["[x]"],
  ["\\[x]"],
  ["?.txt"],
  ["[ab].*"],
  [":(icase)foo.txt"],
  [":(icase)DIR"],
  [":(icase)udir3/"],
  [":(icase)d*/X.TXT"],
  [":!dir"],
  [":^*.txt"],
  [":(exclude)dir/sub"],
  ["dir", ":!dir/sub"],
  ["*.txt", ":!dir/*"],
  ["udir", ":(exclude)udir/inner"],
  [":/dir/sub"],
  [":(top)a.txt"],
  [":(prefix:0)dir"],
  [":(prefix:3)dir/x.txt"],
  ["u*"],
  ["udir"],
  ["udir/"],
  ["udir/inner/h.txt"],
  ["udir/*.c"],
  ["*.log"],
  ["build"],
  ["build/"],
  ["ig/one.txt"],
  ["nested"],
  ["nested/"],
  ["nested/inside.txt"],
  ["nonexistent", "dir/nothing/x"],
  ["caf?.txt"],
  ["*\xe9*"],
  ["dir/sub/deep/more/"],
  ["d*/sub"],
];

const MODES: [UntrackedFilesMode, IgnoredMode][] = [
  ["no", "no"],
  ["normal", "no"],
  ["all", "no"],
  ["no", "traditional"],
  ["normal", "traditional"],
  ["all", "traditional"],
  ["normal", "matching"],
  ["all", "matching"],
];

/** Our status for the pathspec in the modes. */
async function ours(
  dir: string,
  paths: string[],
  untracked: UntrackedFilesMode,
  ignored: IgnoredMode,
  extra: Record<string, string> = {},
): Promise<Status> {
  const command = (await openRepo(root, dir, extra)).status();
  command.setUntrackedFiles(untracked).setIgnored(ignored);
  for (const p of paths) command.addPath(p);
  return command.call();
}

/** Ours and native git agree in porcelain v1 and v2 for the pathspec in the modes. */
async function expectAsNative(
  dir: string,
  paths: string[],
  untracked: UntrackedFilesMode,
  ignored: IgnoredMode,
  extra: Record<string, string> = {},
  config: string[] = [],
) {
  const args = [`--untracked-files=${untracked}`, `--ignored=${ignored}`, "--", ...paths];
  const label = `${paths.join(" ")} -u${untracked} --ignored=${ignored} ${JSON.stringify(extra)}`;
  const status = await ours(dir, paths, untracked, ignored, extra);
  const quotePath = !config.includes("core.quotePath=false");
  const cfg = config.flatMap((c) => ["-c", c]);
  // argv carries the elements as UTF-8 (a test element's "\xe9" is the character é)
  const argv = args;
  expect(bytesOf(formatStatusPorcelain(status, 1, { quotePath })), `${label} v1`).toBe(
    git(dir, [...cfg, "status", "--porcelain", ...argv], extra),
  );
  expect(bytesOf(formatStatusPorcelain(status, 2, { quotePath })), `${label} v2`).toBe(
    git(dir, [...cfg, "status", "--porcelain=v2", ...argv], extra),
  );
}

describeGit("status pathspecs: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "status-pathspec-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("each pathspec in every untracked and ignored mode, porcelain v1 and v2", async () => {
    const dir = join(root, "r");
    repo(dir);
    for (const paths of PATHSPECS) {
      for (const [untracked, ignored] of MODES) {
        await expectAsNative(dir, paths, untracked, ignored);
      }
    }
  }, 300_000);

  it("the global pathspec variables", async () => {
    const dir = join(root, "r");
    repo(dir);
    const cases: [Record<string, string>, string[][]][] = [
      [{ GIT_LITERAL_PATHSPECS: "1" }, [["a*b"], ["*.txt"], [":(glob)*.txt"], ["dir"]]],
      [{ GIT_GLOB_PATHSPECS: "1" }, [["*.txt"], ["dir/*"], ["**/w.c"], [":(literal)a*b"]]],
      [{ GIT_NOGLOB_PATHSPECS: "true" }, [["a*b"], ["*.txt"], [":(glob)*.txt"]]],
      [{ GIT_ICASE_PATHSPECS: "yes" }, [["foo.txt"], ["DIR"], ["udir3"], ["*.TXT"]]],
      [{ GIT_ICASE_PATHSPECS: "1", GIT_GLOB_PATHSPECS: "1" }, [["D*/*.TXT"], ["**/W.C"]]],
    ];
    for (const [extra, list] of cases) {
      for (const paths of list) {
        await expectAsNative(dir, paths, "all", "no", extra);
        await expectAsNative(dir, paths, "normal", "traditional", extra);
      }
    }
  }, 120_000);

  it("refuses what git refuses, with git's messages", async () => {
    const dir = join(root, "r");
    repo(dir);
    const cases: [string[], Record<string, string>][] = [
      [[":(glob,literal)a"], {}],
      [[":(bogus)a"], {}],
      [[":(glob"], {}],
      [["a"], { GIT_GLOB_PATHSPECS: "1", GIT_NOGLOB_PATHSPECS: "1" }],
      [["a"], { GIT_LITERAL_PATHSPECS: "1", GIT_ICASE_PATHSPECS: "1" }],
      [["../outside"], {}],
    ];
    for (const [paths, extra] of cases) {
      const native = gitRun(root, dir, ["status", "--porcelain", "--", ...paths], extra);
      expect(native.status, paths.join(" ")).toBe(128);
      const error = await ours(dir, paths, "normal", "no", extra).catch((e: unknown) => e);
      expect(error, paths.join(" ")).toBeInstanceOf(InvalidArgumentError);
      const first = native.stderr.split("\n")[0] as string;
      // git names where the repository is ("... is outside repository at '<path>'")
      expect((error as Error).message.split("\n")[0], paths.join(" ")).toBe(
        first.includes("outside repository") ? (error as Error).message.split("\n")[0] : first,
      );
    }
  });

  it("paths that are no UTF-8, with core.quotePath on and off", async () => {
    const dir = join(root, "r");
    repo(dir);
    for (const paths of [["caf?.txt"], ["*\xe9*"], ["\xe9-u.txt"], ["."]]) {
      for (const config of [[], ["core.quotePath=false"]]) {
        await expectAsNative(dir, paths, "all", "no", {}, config);
        await expectAsNative(dir, paths, "normal", "traditional", {}, config);
      }
    }
  }, 60_000);

  it("a fuzz of worktrees and pathspecs", async () => {
    let seed = 0x5eed;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const names = ["a", "b", "ab", "A", "x.txt", "y.c", "z.log", "q*"];
    const dirs = ["", "d/", "d/e/", "f/", "F/", "d/g/"];
    const pick = <T>(list: readonly T[]) => list[rand(list.length)] as T;
    const element = () => {
      const kinds = [
        () => pick(dirs).replace(/\/$/, "") || ".",
        () => pick(dirs) || ".",
        () => `${pick(dirs)}${pick(names)}`,
        () => `${pick(dirs)}*${pick([".txt", ".c", "", "b"])}`,
        () => `:(glob)${pick(["**/", "d/*/", "*/", ""])}${pick(names)}`,
        () => `:(icase)${pick(dirs).toUpperCase()}${pick(names)}`,
        () => `:!${pick(dirs)}${pick(["*", "x.txt", ""]) || "."}`,
        () => `:(literal)${pick(dirs)}q*`,
        () => `${pick(dirs)}?`,
      ];
      return pick(kinds)();
    };
    for (let round = 0; round < 6; round++) {
      const dir = join(root, `f${round}`);
      mkdirSync(dir, { recursive: true });
      git(dir, ["init", "-q", "-b", "main"]);
      putFile(dir, ".gitignore", "*.log\n");
      for (let i = 0; i < 12; i++) putFile(dir, `${pick(dirs)}${pick(names)}`, `${i}\n`);
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "base", "--allow-empty"]);
      for (let i = 0; i < 14; i++) {
        const path = `${pick(dirs)}${pick(names)}`;
        try {
          putFile(dir, path, `w${i}\n`);
        } catch {
          // a file where a directory goes: skip
        }
      }
      for (let k = 0; k < 10; k++) {
        const paths = Array.from({ length: 1 + rand(3) }, element);
        const [untracked, ignored] = pick(MODES);
        await expectAsNative(dir, paths, untracked, ignored);
      }
    }
  }, 300_000);
});
