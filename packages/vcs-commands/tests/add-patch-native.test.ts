/**
 * git's interactive patch modes (add-patch.c) against native git: each case builds the
 * same repository twice, runs native `git add -p` / `reset -p` / `checkout -p` /
 * `restore -p` / `stash push -p` with scripted answers on standard input (and a scripted
 * editor for `e`), runs ours with a selector giving the same answers, and compares the
 * index, worktree, refs and stash, and the transcript git printed (headers, hunks,
 * prompts, help, errors). Prompts differ between 2.43 and 2.5x: ours runs in the version's
 * compatibility.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PatchRequest, PatchResult } from "../src/commands/add-patch/index.js";
import type { Git } from "../src/index.js";
import { gitOk, git as gitRun, openOurs, put, snapshot } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;
let modern = true;
let compat: "2.43" | "2.56" = "2.56";

/** The same repository in two directories, built by `build` with native git. */
function twins(build: (dir: string) => void): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `n${n}`);
  const ours = join(root, `o${n}`);
  for (const dir of [native, ours]) {
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    build(dir);
  }
  return { native, ours };
}

/** An edit of the hunk buffer: a sed expression for git's editor, and the same in JS. */
interface Edit {
  sed: string;
  js: (text: string) => string;
}

/** Native git with the answers on stdin; the editor applies `edits` in turn. */
function native(
  dir: string,
  args: string[],
  answers: string[],
  edits: Edit[] = [],
): { stdout: string; stderr: string; status: number; buffers: string[] } {
  const editor = join(root, `editor-${counter}.sh`);
  const state = join(root, `editor-${counter}.n`);
  const copies = join(root, `editor-${counter}.buf`);
  writeFileSync(state, "0");
  const lines = edits.map(
    (e, i) => `if [ "$n" = ${i} ]; then sed -i '${e.sed.replace(/'/g, "'\\''")}' "$1"; fi`,
  );
  writeFileSync(
    editor,
    `#!/bin/sh\nn=$(cat '${state}')\ncat "$1" >> '${copies}'\nprintf '\\0' >> '${copies}'\n${lines.join("\n")}\necho $((n+1)) > '${state}'\n`,
  );
  chmodSync(editor, 0o755);
  const r = spawnSync(
    "git",
    ["-c", "color.ui=false", "-c", "interactive.singleKey=false", ...args],
    {
      cwd: dir,
      env: { ...nativeGitEnv(root), GIT_PAGER: "cat", GIT_EDITOR: editor },
      input: answers.map((a) => `${a}\n`).join(""),
      encoding: "utf8",
    },
  );
  let buffers: string[] = [];
  try {
    buffers = readFileSync(copies, "utf8").split("\0").slice(0, -1);
    unlinkSync(copies);
  } catch {
    // no edit
  }
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1, buffers };
}

/** A selector answering as the scripted stdin does; edits as the scripted editor. */
function selector(answers: string[], edits: Edit[] = [], buffers: string[] = []) {
  const queue = [...answers];
  const editQueue = [...edits];
  return (request: PatchRequest): string | undefined => {
    if (request.type === "edit") {
      buffers.push(request.text);
      const edit = editQueue.shift();
      return edit ? edit.js(request.text) : request.text;
    }
    return queue.shift();
  };
}

/** Index, worktree, HEAD, refs and the stash's trees. */
function view(dir: string) {
  const shot = snapshot(root, dir);
  const stash = spawnSync("git", ["log", "-g", "--format=%T %s", "refs/stash"], {
    cwd: dir,
    env: nativeGitEnv(root),
    encoding: "utf8",
  }).stdout;
  const stashIndex = spawnSync("git", ["rev-parse", "-q", "--verify", "stash^2^{tree}"], {
    cwd: dir,
    env: nativeGitEnv(root),
    encoding: "utf8",
  }).stdout;
  return { ...shot, stash, stashIndex };
}

async function compare(
  dirs: { native: string; ours: string },
  args: string[],
  answers: string[],
  run: (git: Git, select: ReturnType<typeof selector>) => Promise<PatchResult | undefined>,
  edits: Edit[] = [],
): Promise<{ n: ReturnType<typeof native>; ours: PatchResult | undefined }> {
  const n = native(dirs.native, args, answers, edits);
  const git = await openOurs(dirs.ours);
  const buffers: string[] = [];
  const ours = await run(git, selector(answers, edits, buffers));
  // stash push's own "Saved working directory ..." line is the host's to print
  expect(ours?.output ?? "").toBe(
    n.stdout.replace(/^Saved working directory and index state .*\n/m, ""),
  );
  expect(ours?.errors ?? "").toBe(n.stderr);
  expect(buffers).toEqual(n.buffers);
  expect(view(dirs.ours)).toEqual(view(dirs.native));
  return { n, ours };
}

const twenty = Array.from({ length: 20 }, (_, i) => `${i + 1}\n`).join("");

/** A committed file `f` of 20 lines and `g`, then three changes in `f`. */
function threeHunks(dir: string): void {
  put(dir, "f", twenty);
  put(dir, "g", "x\n");
  gitOk(root, dir, "add", ".");
  gitOk(root, dir, "commit", "-qm", "base");
  put(
    dir,
    "f",
    twenty.replace("2\n", "two\n").replace("4\n", "four\n").replace("18\n", "eighteen\n"),
  );
  put(dir, "g", "x\ny\n");
}

const add =
  (answers: string[], paths: string[] = []) =>
  async (git: Git, select: ReturnType<typeof selector>) => {
    const cmd = git.add().setPatch(true).setPatchSelector(select).setCompatibility(compat);
    for (const p of paths) cmd.addFilepattern(p);
    void answers;
    return (await cmd.call()).patch;
  };

describeGit("add -p as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "add-patch-native-"));
    modern = gitAtLeast(gitOk(root, root, "--version"), 2, 50);
    compat = modern ? "2.56" : "2.43";
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("stages some hunks of several files, splitting one", async () => {
    const answers = ["n", "s", "y", "n", "y", "y"];
    await compare(twins(threeHunks), ["add", "-p"], answers, add(answers));
  });

  it("answers a, d, q, help, unknown letters and navigation", async () => {
    const answers = ["J", "?", "K", "k", "j", "yes", "foo", "a", "d"];
    await compare(twins(threeHunks), ["add", "-p"], answers, add(answers));
    const more = ["g", "2", "/eigh", "n", "q"];
    await compare(twins(threeHunks), ["add", "-p"], more, add(more));
  });

  it("stops at the end of input", async () => {
    const answers = ["y"];
    await compare(twins(threeHunks), ["add", "-p"], answers, add(answers));
  });

  it("takes a pathspec, and says No changes", async () => {
    const answers = ["y", "y"];
    await compare(twins(threeHunks), ["add", "-p", "--", "g"], answers, add(answers, ["g"]));
    await compare(twins(threeHunks), ["add", "-p", "--", "nothing"], [], add([], ["nothing"]));
  });

  it("edits a hunk (a valid edit, an invalid one given up, an emptied one)", async () => {
    const good: Edit = { sed: "s/^+four/+FOUR/", js: (t) => t.replace(/^\+four$/m, "+FOUR") };
    const bad: Edit = { sed: "s/^ 3$/ X3/", js: (t) => t.replace(/^ 3$/m, " X3") };
    const empty: Edit = { sed: "/^[^#]/d", js: (t) => t.replace(/^[^#].*\n/gm, "") };
    await compare(twins(threeHunks), ["add", "-p"], ["s", "y", "e", "n", "q"], add([]), [good]);
    await compare(twins(threeHunks), ["add", "-p"], ["e", "n", "n", "q"], add([]), [bad]);
    await compare(twins(threeHunks), ["add", "-p"], ["e", "y", "q"], add([]), [bad, good]);
    await compare(twins(threeHunks), ["add", "-p"], ["e", "y", "q"], add([]), [empty]);
  });

  it("offers deletions, additions (intent-to-add), mode changes and passes binary files", async () => {
    const build = (dir: string) => {
      put(dir, "d", "gone\n");
      put(dir, "m", "x\n");
      put(dir, "b", Buffer.from([0, 1, 2, 3]));
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "base");
      unlinkSync(join(dir, "d"));
      chmodSync(join(dir, "m"), 0o755);
      put(dir, "m", "x\ny\n");
      put(dir, "b", Buffer.from([0, 9, 2, 3]));
      put(dir, "new", "fresh\nlines\n");
      put(dir, "empty", "");
      gitOk(root, dir, "add", "-N", "new", "empty");
    };
    const answers = ["y", "y", "n", "y", "y"];
    await compare(twins(build), ["add", "-p"], answers, add(answers));
    const second = ["n", "n", "y", "n", "e", "q"];
    await compare(twins(build), ["add", "-p"], second, add(second));
    const onlyBinary = (dir: string) => {
      put(dir, "b", Buffer.from([0, 1, 2, 3]));
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "base");
      put(dir, "b", Buffer.from([0, 9, 2, 3]));
    };
    await compare(twins(onlyBinary), ["add", "-p"], [], add([]));
  });
});

/** threeHunks, with the changes staged and `f` changed once more in the worktree. */
function stagedAndMore(dir: string): void {
  threeHunks(dir);
  gitOk(root, dir, "add", ".");
  put(dir, "f", readFileSync(join(dir, "f"), "utf8").replace("10\n", "ten\n"));
}

/** Two commits: `f` changed in the second, so HEAD~1 differs from HEAD in two hunks. */
function twoCommits(dir: string): void {
  threeHunks(dir);
  put(dir, "n", "new\n");
  gitOk(root, dir, "add", ".");
  gitOk(root, dir, "commit", "-qm", "second");
  put(dir, "f", readFileSync(join(dir, "f"), "utf8").replace("10\n", "ten\n"));
}

describeGit("reset -p, checkout -p, restore -p, stash -p as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "add-patch-native-"));
    modern = gitAtLeast(gitOk(root, root, "--version"), 2, 50);
    compat = modern ? "2.56" : "2.43";
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reset -p unstages hunks (HEAD), applies another commit's to the index", async () => {
    const answers = ["y", "n", "s", "n", "y", "y"];
    await compare(twins(stagedAndMore), ["reset", "-p"], answers, async (git, select) => {
      const reset = git.reset().setPatch(true).setPatchSelector(select).setCompatibility(compat);
      await reset.call();
      return reset.getPatchResult();
    });
    const more = ["y", "n", "y", "y"];
    await compare(twins(twoCommits), ["reset", "-p", "HEAD~1"], more, async (git, select) => {
      const reset = git
        .reset()
        .setRef("HEAD~1")
        .setPatch(true)
        .setPatchSelector(select)
        .setCompatibility(compat);
      await reset.call();
      return reset.getPatchResult();
    });
    const edit: Edit = { sed: "s/^-4$/ 4/", js: (t) => t.replace(/^-4$/m, " 4") };
    await compare(
      twins(stagedAndMore),
      ["reset", "-p", "--", "f"],
      ["s", "y", "e", "q"],
      async (git, select) => {
        const reset = git
          .reset()
          .addPath("f")
          .setPatch(true)
          .setPatchSelector(select)
          .setCompatibility(compat);
        await reset.call();
        return reset.getPatchResult();
      },
      [edit],
    );
  });

  it("checkout -p discards from the worktree, from the index and worktree, applies a commit", async () => {
    const answers = ["y", "n", "y", "q"];
    await compare(twins(stagedAndMore), ["checkout", "-p"], answers, async (git, select) => {
      const r = await git
        .checkout()
        .setPatch(true)
        .setPatchSelector(select)
        .setCompatibility(compat)
        .call();
      return r.patch;
    });
    const head = ["n", "y", "n", "y", "y"];
    await compare(twins(stagedAndMore), ["checkout", "-p", "HEAD"], head, async (git, select) => {
      const r = await git
        .checkout()
        .setStartPoint("HEAD")
        .setPatch(true)
        .setPatchSelector(select)
        .setCompatibility(compat)
        .call();
      return r.patch;
    });
    const older = ["y", "n", "y", "y", "y"];
    await compare(
      twins(twoCommits),
      ["checkout", "-p", "HEAD~1", "--", "f", "n"],
      older,
      async (git, select) => {
        const r = await git
          .checkout()
          .setStartPoint("HEAD~1")
          .addPath("f")
          .addPath("n")
          .setPatch(true)
          .setPatchSelector(select)
          .setCompatibility(compat)
          .call();
        return r.patch;
      },
    );
  });

  it("checkout -p of hunks that no longer apply to the index", async () => {
    // the worktree's change sits where the index differs from HEAD: index check fails
    const build = (dir: string) => {
      threeHunks(dir);
      gitOk(root, dir, "add", ".");
      put(
        dir,
        "f",
        twenty.replace("2\n", "TWO\n").replace("4\n", "four\n").replace("18\n", "eighteen\n"),
      );
    };
    const answers = ["y", "n", "n", "y"];
    await compare(twins(build), ["checkout", "-p", "HEAD~0"], answers, async (git, select) => {
      const r = await git
        .checkout()
        .setStartPoint("HEAD~0")
        .setPatch(true)
        .setPatchSelector(select)
        .setCompatibility(compat)
        .call();
      return r.patch;
    });
  });

  it("restore -p with --staged, --worktree and --source", async () => {
    const cases: {
      args: string[];
      answers: string[];
      setup: (g: Git) => ReturnType<Git["restore"]>;
    }[] = [
      { args: ["restore", "-p"], answers: ["y", "n"], setup: (g) => g.restore() },
      {
        args: ["restore", "-p", "--staged"],
        answers: ["n", "y", "y", "n"],
        setup: (g) => g.restore().setStaged(true),
      },
      {
        args: ["restore", "-p", "--staged", "--worktree"],
        answers: ["y", "n", "y", "y"],
        setup: (g) => g.restore().setStaged(true).setWorktree(true),
      },
      {
        args: ["restore", "-p", "--source=HEAD"],
        answers: ["y", "y", "n", "y"],
        setup: (g) => g.restore().setSource("HEAD"),
      },
      {
        args: ["restore", "-p", "--source=HEAD~1", "--", "f"],
        answers: ["n", "y", "y"],
        setup: (g) => g.restore().setSource("HEAD~1").addPath("f"),
      },
    ];
    for (const c of cases) {
      const build = c.args.some((a) => a.startsWith("--source=HEAD~1"))
        ? twoCommits
        : stagedAndMore;
      await compare(twins(build), c.args, c.answers, async (git, select) => {
        const r = await c
          .setup(git)
          .setPatch(true)
          .setPatchSelector(select)
          .setCompatibility(compat)
          .call();
        return r.patch;
      });
    }
  });

  it("stash push -p stashes the selected hunks, with and without --keep-index", async () => {
    const stash =
      (keep?: boolean, paths: string[] = []) =>
      async (git: Git, select: ReturnType<typeof selector>) => {
        const cmd = git
          .stashCreate()
          .setPatch(true)
          .setPatchSelector(select)
          .setCompatibility(compat);
        if (keep !== undefined) cmd.setKeepIndex(keep);
        for (const p of paths) cmd.addPath(p);
        await cmd.call();
        return cmd.getPatchResult();
      };
    await compare(
      twins(stagedAndMore),
      ["stash", "push", "-p"],
      ["y", "n", "s", "y", "n", "n"],
      stash(),
    );
    await compare(
      twins(stagedAndMore),
      ["stash", "push", "-p", "--no-keep-index"],
      ["n", "y", "n", "n", "y"],
      stash(false),
    );
    await compare(
      twins(stagedAndMore),
      ["stash", "push", "-p", "--keep-index", "--", "f"],
      ["y", "y", "y", "n"],
      stash(true, ["f"]),
    );
    await compare(
      twins(stagedAndMore),
      ["stash", "push", "-p", "--no-keep-index", "--", "f"],
      ["y", "n", "y", "n"],
      stash(false, ["f"]),
    );
  });

  it("stash push -p with nothing selected", async () => {
    const dirs = twins(stagedAndMore);
    const n = native(dirs.native, ["stash", "push", "-p"], ["n", "n", "n", "n"]);
    // 2.5x exits 128 (do_create_stash fails), 2.43 exits 1
    expect(n.status).toBe(modern ? 128 : 1);
    const git = await openOurs(dirs.ours);
    const cmd = git
      .stashCreate()
      .setPatch(true)
      .setPatchSelector(selector(["n", "n", "n", "n"]))
      .setCompatibility(compat);
    await expect(cmd.call()).rejects.toThrow("No changes selected");
    expect(cmd.getPatchResult()?.output).toBe(n.stdout);
    expect(n.stderr).toContain("No changes selected");
    expect(view(dirs.ours)).toEqual(view(dirs.native));
  });
});

describeGit("patch mode details as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "add-patch-native-"));
    modern = gitAtLeast(gitOk(root, root, "--version"), 2, 50);
    compat = modern ? "2.56" : "2.43";
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("edits a split hunk and merges it with its neighbour", async () => {
    const good: Edit = { sed: "s/^+four/+FOUR/", js: (t) => t.replace(/^\+four$/m, "+FOUR") };
    await compare(twins(threeHunks), ["add", "-p"], ["s", "y", "e", "n", "y"], add([]), [good]);
  });

  it("goes to a hunk from the list, prints, searches with a bad pattern", async () => {
    const answers = ["g", "2", "p", "/(", "/a{1", "/zzz", "g9", "gx", "y", "q"];
    await compare(twins(threeHunks), ["add", "-p"], answers, add(answers));
  });

  it("reads diff.context and diff.algorithm", async () => {
    const build = (dir: string) => {
      threeHunks(dir);
      gitOk(root, dir, "config", "diff.context", "1");
      gitOk(root, dir, "config", "diff.algorithm", "histogram");
    };
    const answers = ["y", "n", "y", "y"];
    await compare(twins(build), ["add", "-p"], answers, add(answers));
  });

  it("reset -p on an unborn branch", async () => {
    const build = (dir: string) => {
      put(dir, "f", "a\nb\n");
      put(dir, "g", "c\n");
      gitOk(root, dir, "add", ".");
    };
    await compare(twins(build), ["reset", "-p"], ["y", "n"], async (git, select) => {
      const reset = git.reset().setPatch(true).setPatchSelector(select).setCompatibility(compat);
      await reset.call();
      return reset.getPatchResult();
    });
  });

  it("--no-auto-advance moves between files (2.5x)", async () => {
    if (!modern) return;
    const answers = [">", "y", "<", "J", "y", "?", ">", "q"];
    await compare(
      twins(threeHunks),
      ["add", "-p", "--no-auto-advance"],
      answers,
      async (git, select) =>
        (
          await git
            .add()
            .setPatch(true)
            .setPatchOptions({ autoAdvance: false })
            .setPatchSelector(select)
            .call()
        ).patch,
    );
  });
});

describeGit("patch mode refreshes, conflicts and errors as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "add-patch-native-"));
    modern = gitAtLeast(gitOk(root, root, "--version"), 2, 50);
    compat = modern ? "2.56" : "2.43";
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A merge stopped on a conflict in `f`, and an unstaged change of `g`. */
  const conflicted = (dir: string) => {
    put(dir, "f", "a\nb\nc\n");
    put(dir, "g", "1\n2\n3\n4\n5\n6\n7\n8\n9\n");
    gitOk(root, dir, "add", ".");
    gitOk(root, dir, "commit", "-qm", "base");
    gitOk(root, dir, "checkout", "-qb", "side");
    put(dir, "f", "a\nSIDE\nc\n");
    gitOk(root, dir, "commit", "-qam", "side");
    gitOk(root, dir, "checkout", "-q", "main");
    put(dir, "f", "a\nMAIN\nc\n");
    gitOk(root, dir, "commit", "-qam", "main");
    expect(gitRun(root, dir, "merge", "side").status).toBe(1);
    put(dir, "g", "1\n2\nthree\n4\n5\n6\n7\n8\nnine\n");
  };

  it("refreshes the index (needs merge) and passes over unmerged paths", async () => {
    // diff-files shows the conflicted path as a combined diff: no hunk to offer
    const answers = ["y", "s", "y", "y", "y"];
    await compare(twins(conflicted), ["add", "-p"], answers, add(answers));
    await compare(
      twins(conflicted),
      ["checkout", "-p"],
      answers,
      async (git, select) =>
        (
          await git
            .checkout()
            .setPatch(true)
            .setPatchSelector(select)
            .setCompatibility(compat)
            .call()
        ).patch,
    );
    // diff-index against HEAD offers the conflicted file as it is in the worktree
    await compare(
      twins(conflicted),
      ["checkout", "-p", "HEAD"],
      ["n", "y"],
      async (git, select) =>
        (
          await git
            .checkout()
            .setStartPoint("HEAD")
            .setPatch(true)
            .setPatchSelector(select)
            .setCompatibility(compat)
            .call()
        ).patch,
    );
    // reset -p is index-only: no refresh before the diff
    const staged = (dir: string) => {
      conflicted(dir);
      gitOk(root, dir, "add", "g");
    };
    await compare(twins(staged), ["reset", "-p"], ["y"], async (git, select) => {
      const reset = git.reset().setPatch(true).setPatchSelector(select).setCompatibility(compat);
      await reset.call();
      return reset.getPatchResult();
    });
  });

  it("stash push -p diffs HEAD's paths only (a path removed from the index alone)", async () => {
    const build = (dir: string) => {
      put(dir, "f", "a\nb\nc\n");
      put(dir, "g", "x\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "base");
      // f stays in the worktree, unchanged
      gitOk(root, dir, "rm", "-q", "--cached", "f");
      put(dir, "g", "x\ny\n");
    };
    await compare(twins(build), ["stash", "push", "-p"], ["y", "y", "y"], async (git, select) => {
      const cmd = git
        .stashCreate()
        .setPatch(true)
        .setPatchSelector(select)
        .setCompatibility(compat);
      await cmd.call();
      return cmd.getPatchResult();
    });
  });

  it("splits a decided hunk (2.43 keeps the decision, 2.5x asks again)", async () => {
    await compare(twins(threeHunks), ["add", "-p"], ["y", "K", "s", "q"], add([]));
    await compare(twins(threeHunks), ["add", "-p"], ["y", "K", "s", "n", "y", "q"], add([]));
  });

  it("reports hunks that fail to merge and still runs git apply --check", async () => {
    const build = (dir: string) => {
      put(dir, "f", "1\n2\n3\n4\n5\n6\n7\n8\n9\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "base");
      put(dir, "f", "1\nTWO\n3\n4\n5\n6\n7\n8\nNINE\n");
      gitOk(root, dir, "add", "f");
    };
    const resetRun = async (git: Git, select: ReturnType<typeof selector>) => {
      const reset = git.reset().setPatch(true).setPatchSelector(select).setCompatibility(compat);
      await reset.call();
      return reset.getPatchResult();
    };
    const addLine: Edit = {
      sed: "s/^ 3$/+extra\\n 3/",
      js: (t) => t.replace(/^ 3$/m, "+extra\n 3"),
    };
    await compare(twins(build), ["reset", "-p"], ["s", "e", "n"], resetRun, [addLine]);
    // the edited first part no longer ends with the second's leading context
    const delCtx: Edit = { sed: "/^ 4$/d", js: (t) => t.replace(/^ 4\n/m, "") };
    const { n } = await compare(twins(build), ["reset", "-p"], ["s", "e", "y", "y"], resetRun, [
      delCtx,
      addLine,
    ]);
    expect(n.stderr).toContain("error: hunks do not overlap");
    expect(n.stderr).toContain("error: patch failed: f:1");
  });

  it("stash push -p hides skip-worktree and assume-unchanged paths (2.5x), 2.43 offers them", async () => {
    // 2.5x builds the temporary index by a one-way merge from the index (keep_entry copies
    // a same-id entry with its flags, merged_entry carries skip-worktree), 2.43 by read-tree
    const base = (dir: string) => {
      put(dir, "f", "x\n");
      put(dir, "g", "1\n2\n3\n");
      put(dir, "h", "h\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "base");
      // a normal change elsewhere, so that the stash goes ahead
      put(dir, "f", "x\ny\n");
    };
    const scenarios: Record<string, (dir: string) => void> = {
      "skip-worktree, file deleted": (dir) => {
        base(dir);
        gitOk(root, dir, "update-index", "--skip-worktree", "h");
        unlinkSync(join(dir, "h"));
      },
      "assume-unchanged, file edited": (dir) => {
        base(dir);
        gitOk(root, dir, "update-index", "--assume-unchanged", "g");
        put(dir, "g", "1\n2\n3\nG\n");
      },
      "a staged change marked skip-worktree, file deleted": (dir) => {
        base(dir);
        put(dir, "g", "1\nS\n3\n");
        gitOk(root, dir, "add", "g");
        gitOk(root, dir, "update-index", "--skip-worktree", "g");
        unlinkSync(join(dir, "g"));
      },
    };
    for (const [name, build] of Object.entries(scenarios)) {
      const { n } = await compare(
        twins(build),
        ["stash", "push", "-p"],
        ["y", "y", "y"],
        async (git, select) => {
          const cmd = git
            .stashCreate()
            .setPatch(true)
            .setPatchSelector(select)
            .setCompatibility(compat);
          await cmd.call();
          return cmd.getPatchResult();
        },
      );
      expect(n.status, name).toBe(0);
      expect(n.stdout.includes("diff --git a/f b/f"), name).toBe(true);
      expect(/diff --git a\/[gh] /.test(n.stdout), name).toBe(!modern);
    }
  });

  it("stash push -p refuses a replaced flagged entry whose file changed (2.5x)", async () => {
    const base = (dir: string) => {
      put(dir, "f", "x\n");
      put(dir, "g", "1\n2\n3\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "base");
      put(dir, "f", "x\ny\n");
      put(dir, "g", "1\nS\n3\n");
      gitOk(root, dir, "add", "g");
    };
    const scenarios: Record<string, (dir: string) => void> = {
      "assume-unchanged": (dir) => {
        base(dir);
        gitOk(root, dir, "update-index", "--assume-unchanged", "g");
        put(dir, "g", "1\nS\n3\nW\n");
      },
      "skip-worktree": (dir) => {
        base(dir);
        gitOk(root, dir, "update-index", "--skip-worktree", "g");
        put(dir, "g", "zz\n");
      },
    };
    for (const [name, build] of Object.entries(scenarios)) {
      const run = async (git: Git, select: ReturnType<typeof selector>) => {
        const cmd = git
          .stashCreate()
          .setPatch(true)
          .setPatchSelector(select)
          .setCompatibility(compat);
        await cmd.call();
        return cmd.getPatchResult();
      };
      if (!modern) {
        // read-tree HEAD: no flags, the file's change is offered
        await compare(twins(build), ["stash", "push", "-p"], ["y", "y"], run);
        continue;
      }
      const dirs = twins(build);
      const n = native(dirs.native, ["stash", "push", "-p"], ["y", "y"]);
      expect(n.status, name).toBe(128);
      expect(n.stdout, name).toBe("");
      const git = await openOurs(dirs.ours);
      await expect(run(git, selector(["y", "y"])), name).rejects.toThrow(n.stderr.trimEnd());
      expect(view(dirs.ours), name).toEqual(view(dirs.native));
    }
  });

  it("refuses --pathspec-from-file with -p, and restore -p --staged on an unborn branch", async () => {
    const dir = join(root, `refuse${counter++}`);
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    put(dir, "f", "a\n");
    put(dir, "list", "f\n");
    gitOk(root, dir, "add", "f");
    const fatal = (...args: string[]) => {
      const r = gitRun(root, dir, ...args);
      expect(r.status).toBe(128);
      return r.stderr.trim();
    };
    const git = await openOurs(dir);
    const never = () => undefined;
    await expect(
      git
        .restore()
        .setStaged(true)
        .setPatch(true)
        .setPatchSelector(never)
        .setCompatibility(compat)
        .call(),
    ).rejects.toThrow(fatal("restore", "-p", "--staged"));
    await expect(
      git.reset().setPathspecFromFile("f\n").setPatch(true).setPatchSelector(never).call(),
    ).rejects.toThrow(fatal("reset", "-p", "--pathspec-from-file=list"));
    await expect(
      git.checkout().setPathspecFromFile("f\n").setPatch(true).setPatchSelector(never).call(),
    ).rejects.toThrow(fatal("checkout", "-p", "--pathspec-from-file=list"));
    await expect(
      git
        .checkout()
        .setPathspecFromFile("f\n")
        .addPath("f")
        .setPatch(true)
        .setPatchSelector(never)
        .call(),
    ).rejects.toThrow(fatal("checkout", "-p", "--pathspec-from-file=list", "f"));
    await expect(
      git.restore().setPathspecFromFile("f\n").setPatch(true).setPatchSelector(never).call(),
    ).rejects.toThrow(fatal("restore", "-p", "--pathspec-from-file=list"));
  });
});
