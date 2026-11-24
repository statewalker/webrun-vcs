/**
 * `git clean -i` against native git (builtin/clean.c's `interactive_main_loop`): t7301's
 * worktree is built twice, native `git clean -i[d]` reads its answers from stdin, ours gets
 * them from a selector; the transcript (menus, listings in columns, prompts, help, then the
 * "Removing" lines), the exit status and the worktree are compared. Inputs from git's
 * t/t7301-clean-interactive.sh.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { quotePath } from "../src/results/quote-path.js";
import {
  gitOk,
  native,
  openOurs,
  put,
  selector,
  view,
} from "./interactive-extras-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let counter = 0;
let compat: "2.43" | "2.56" = "2.56";

const touch = (dir: string, ...paths: string[]) => {
  for (const p of paths) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), "");
  }
};

/** t7301's "setup", then the untracked files each test touches. */
function setup(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  touch(dir, "src/part1.c", "Makefile");
  put(dir, ".gitignore", "build\n*.o\n");
  gitOk(root, dir, ["add", "."]);
  gitOk(root, dir, ["commit", "-qm", "setup"]);
  touch(dir, "src/part2.c", "README");
  gitOk(root, dir, ["add", "."]);
  mkdirSync(join(dir, "build"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  touch(
    dir,
    "a.out",
    "src/part3.c",
    "src/part3.h",
    "src/part4.c",
    "src/part4.h",
    "docs/manual.txt",
    "obj.o",
    "build/lib.so",
  );
}

function twins(build: (dir: string) => void = setup): { native: string; ours: string } {
  const n = counter++;
  const dirs = { native: join(root, `n${n}`), ours: join(root, `o${n}`) };
  for (const dir of [dirs.native, dirs.ours]) {
    gitOk(root, root, ["init", "-q", "-b", "main", dir]);
    build(dir);
  }
  return dirs;
}

async function compare(
  args: string[],
  answers: string[],
  options: { build?: (dir: string) => void; columns?: number } = {},
) {
  const dirs = twins(options.build);
  const env = options.columns !== undefined ? { COLUMNS: String(options.columns) } : {};
  const n = native(root, dirs.native, ["clean", ...args], answers, [], env);
  const git = await openOurs(root, dirs.ours);
  const dryRun = args.some((a) => /^-[a-z]*n/.test(a));
  const cmd = git
    .clean()
    .setDryRun(dryRun)
    .setCleanDirectories(args.some((a) => /^-[a-z]*d/.test(a)))
    .setInteractive(selector(answers))
    .setCompatibility(compat);
  if (options.columns !== undefined) cmd.setColumns(options.columns);
  const result = await cmd.call();
  const verb = dryRun ? "Would remove" : "Removing";
  const removed = [...result.cleaned].map((p) => `${verb} ${quotePath(p)}\n`).join("");
  expect(`${result.interactive?.output ?? ""}${removed}`).toBe(n.stdout);
  expect(n.stderr).toBe("");
  expect(n.status).toBe(0);
  expect(view(root, dirs.ours)).toEqual(view(root, dirs.native));
}

describeGit("clean -i as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "clean-interactive-native-"));
    compat = gitAtLeast(gitOk(root, root, ["--version"]), 2, 50) ? "2.56" : "2.43";
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t7301-clean-interactive.sh: "git clean -i (c: clean hotkey)"', async () => {
    await compare(["-i"], ["c"]);
  });

  it('t7301-clean-interactive.sh: "git clean -i (cl: clean prefix)"', async () => {
    await compare(["-i"], ["cl"]);
  });

  it('t7301-clean-interactive.sh: "git clean -i (quit)"', async () => {
    await compare(["-i"], ["quit"]);
  });

  it('t7301-clean-interactive.sh: "git clean -i (Ctrl+D)"', async () => {
    await compare(["-i"], ["\x04"]);
    await compare(["-i"], []);
  });

  it('t7301-clean-interactive.sh: "git clean -id (filter all)"', async () => {
    await compare(["-id"], ["f", "*", "", "c"]);
  });

  it('t7301-clean-interactive.sh: "git clean -id (filter patterns)"', async () => {
    await compare(["-id"], ["f", "part3.* *.out", "", "c"]);
  });

  it('t7301-clean-interactive.sh: "git clean -id (filter patterns 2)"', async () => {
    await compare(["-id"], ["f", "* !*.out", "", "c"]);
  });

  it('t7301-clean-interactive.sh: "git clean -id (select - all)"', async () => {
    await compare(["-id"], ["s", "*", "", "c"]);
  });

  it('t7301-clean-interactive.sh: "git clean -id (select - none)"', async () => {
    await compare(["-id"], ["s", "", "c"]);
  });

  it('t7301-clean-interactive.sh: "git clean -id (select - number)"', async () => {
    await compare(["-id"], ["s", "3", "", "c"]);
  });

  it('t7301-clean-interactive.sh: "git clean -id (select - number 2)"', async () => {
    await compare(["-id"], ["s", "2 3", "5", "", "c"]);
  });

  it('t7301-clean-interactive.sh: "git clean -id (select - number 3)"', async () => {
    await compare(["-id"], ["s", "3,4 5", "", "c"]);
  });

  it('t7301-clean-interactive.sh: "git clean -id (select - filenames)"', async () => {
    await compare(["-id"], ["s", "a.out fo ba bar", "", "c"], {
      build: (dir) => {
        setup(dir);
        touch(dir, "a.out", "foo.txt", "bar.txt", "baz.txt");
      },
    });
  });

  it('t7301-clean-interactive.sh: "git clean -id (select - range)"', async () => {
    await compare(["-id"], ["s", "1,3-4", "2", "", "c"]);
  });

  it('t7301-clean-interactive.sh: "git clean -id (select - range 2)"', async () => {
    await compare(["-id"], ["s", "4- 1", "", "c"]);
  });

  it('t7301-clean-interactive.sh: "git clean -id (inverse select)"', async () => {
    await compare(["-id"], ["s", "*", "-5- 1 -2", "", "c"]);
  });

  it('t7301-clean-interactive.sh: "git clean -id (ask)"', async () => {
    await compare(["-id"], ["a", "Y", "y", "no", "yes", "bad", ""]);
  });

  it('t7301-clean-interactive.sh: "git clean -id (ask - Ctrl+D)"', async () => {
    await compare(["-id"], ["a", "Y", "no", "yes", "\x04"]);
  });

  it("help, prompt help, unknown commands and selections, patterns matching nothing", async () => {
    await compare(["-id"], ["h", "?", "x", "f", "*.c src/", "", "", "zz1 zz2", "  zz3 ", "", "c"]);
    await compare(["-id"], ["s", "?", "2 3", "5", "-1", "zz", "9", "3-2", "", "q"]);
    await compare(["-id"], ["s"]);
    await compare(["-idn"], ["f", "docs/ src/*.h", "", "a", "yes"]);
    await compare(["-id"], ["s", "1", "", "f", "*", "c"]);
  });

  it("lays the items out as column.ui says, in the terminal's width", async () => {
    const many = (layout?: string) => (dir: string) => {
      setup(dir);
      for (let i = 0; i < 14; i++) touch(dir, `file-${"x".repeat(i)}.txt`);
      if (layout) gitOk(root, dir, ["config", "column.ui", layout]);
    };
    await compare(["-id"], ["q"], { build: many(), columns: 60 });
    await compare(["-id"], ["q"], { build: many("row"), columns: 100 });
    await compare(["-id"], ["q"], { build: many("column,dense"), columns: 70 });
    await compare(["-id"], ["q"], { build: many("plain") });
    await compare(["-i"], ["q"], {
      build: (dir) => {
        setup(dir);
        touch(dir, "only.txt");
        for (const p of ["a.out", "obj.o"]) rmSync(join(dir, p));
        for (const p of ["src/part3.c", "src/part3.h", "src/part4.c", "src/part4.h"])
          rmSync(join(dir, p));
      },
    });
  });
});
