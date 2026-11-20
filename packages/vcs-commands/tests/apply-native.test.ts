/**
 * `git apply` against native git: each repository is built twice by native git (same ids),
 * the same patch applied to one twin by native `git apply` and to the other by our
 * ApplyCommand; then the exit status, stdout, stderr, the worktree (files, modes, links,
 * `.rej` files) and the index (`git ls-files -s`) are compared. Patches come from native
 * `git diff` (renames, copies, mode changes, binaries, -U0, quoted names), hand-written
 * traditional diffs and broken ones; random histories drift the target so hunks apply at
 * offsets, with reduced context or not at all.
 */
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type ApplyCommand, Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

type Env = Record<string, string | undefined>;

let root = "";
let home = "";
let counter = 0;
let modern = true;

function envOf(over: Env = {}): Record<string, string> {
  const env: Env = { ...nativeGitEnv(home), ...over };
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[], input?: Buffer | string): Run {
  const r = spawnSync("git", args, {
    cwd,
    env: envOf(),
    encoding: "utf8",
    input: input ?? "",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function gitOk(cwd: string, ...args: string[]): string {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function gitBytes(cwd: string, ...args: string[]): Buffer {
  const r = spawnSync("git", args, { cwd, env: envOf(), maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const put = (dir: string, path: string, content: string | Buffer, mode?: number) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  rmSync(join(dir, path), { force: true });
  writeFileSync(join(dir, path), content, mode !== undefined ? { mode } : {});
};

/** Seeded PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
    chance: (p: number) => next() < p,
  };
}

type Setup = (repo: string) => void;

/** Two repositories built by the same native commands. */
function twins(setup: Setup): { native: string; ours: string } {
  const n = counter++;
  const make = (name: string) => {
    const repo = join(root, `t${n}-${name}`);
    mkdirSync(repo, { recursive: true });
    gitOk(repo, "init", "-q", "-b", "main");
    setup(repo);
    return repo;
  };
  return { native: make("native"), ours: make("ours") };
}

async function open(repo: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: envOf() });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** The worktree (files, links, exec bits; `.git` left out) as one comparable text. */
function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      if (!rel && name === ".git") continue;
      const p = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, p));
      if (st.isSymbolicLink()) out.push(`L ${p} -> ${readlinkSync(join(dir, p))}`);
      else if (st.isDirectory()) {
        out.push(`D ${p}`);
        walk(p);
      } else
        out.push(
          `F ${p} ${st.mode & 0o100 ? "x" : "-"} ${readFileSync(join(dir, p)).toString("base64")}`,
        );
    }
  };
  walk("");
  return out.join("\n");
}

interface ApplyCase {
  args: string[];
  configure?: (cmd: ApplyCommand) => ApplyCommand;
  /** Read the patch from a file (named in messages) instead of stdin */
  file?: boolean;
}

/** Runs native `git apply` and ours on the twins with the same patch, compares all. */
async function compareApply(
  pair: { native: string; ours: string },
  patch: Buffer | string,
  c: ApplyCase,
  label = "",
): Promise<Run> {
  const bytes = typeof patch === "string" ? Buffer.from(patch) : patch;
  const patchName = c.file ? "../p.diff" : undefined;
  if (c.file) {
    writeFileSync(join(pair.native, "..", "p.diff"), bytes);
  }
  const native = c.file
    ? git(pair.native, ["apply", ...c.args, "../p.diff"])
    : git(pair.native, ["apply", ...c.args], bytes);
  const g = await open(pair.ours);
  let cmd = g.apply().addPatch(new Uint8Array(bytes), patchName);
  if (!modern) cmd = cmd.setLegacyMessages(true);
  cmd = (c.configure ?? ((x) => x))(cmd);
  const r = await cmd.call();
  g.close();
  const ours: Run = { status: r.exitCode, stdout: r.output, stderr: r.errors };
  expect({ label, ...ours }).toEqual({ label, ...native });
  expect(snapshot(pair.ours), label).toBe(snapshot(pair.native));
  expect(gitOk(pair.ours, "ls-files", "-s"), label).toBe(gitOk(pair.native, "ls-files", "-s"));
  // the stat data we wrote: native sees the same files as changed or not
  expect(gitOk(pair.ours, "status", "--porcelain")).toBe(
    gitOk(pair.native, "status", "--porcelain"),
  );
  return native;
}

/** A patch produced by native git between two states of `build` (worktree vs HEAD). */
function nativeDiff(
  build: Setup,
  change: Setup,
  diffArgs: string[] = [],
): { patch: Buffer; base: Setup } {
  const dir = join(root, `d${counter++}`);
  mkdirSync(dir, { recursive: true });
  gitOk(dir, "init", "-q", "-b", "main");
  build(dir);
  gitOk(dir, "add", "-A");
  gitOk(dir, "commit", "-q", "--allow-empty", "-m", "base");
  change(dir);
  gitOk(dir, "add", "-A");
  const patch = gitBytes(dir, "diff", "--cached", ...diffArgs);
  rmSync(dir, { recursive: true, force: true });
  const base: Setup = (repo) => {
    build(repo);
    gitOk(repo, "add", "-A");
    gitOk(repo, "commit", "-q", "--allow-empty", "-m", "base");
  };
  return { patch, base };
}

const lines = (n: number, prefix = "line") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join("");

describeGit("git apply as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "apply-native-"));
    home = join(root, "home");
    mkdirSync(home, { recursive: true });
    modern = gitAtLeast(gitOk(root, "--version"), 2, 46);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("applies a modification, a new file, a deletion, a rename and a mode change", async () => {
    const { patch, base } = nativeDiff(
      (d) => {
        put(d, "a.txt", lines(20));
        put(d, "gone.txt", "bye\n");
        put(d, "old/name.txt", lines(10, "keep"));
        put(d, "script.sh", "echo\n");
      },
      (d) => {
        put(d, "a.txt", lines(20).replace("line 7\n", "line seven\n").replace("line 15\n", ""));
        rmSync(join(d, "gone.txt"));
        put(d, "new/file.txt", "hello\nworld\n");
        rmSync(join(d, "old/name.txt"));
        put(d, "new/name.txt", lines(10, "keep").replace("keep 3\n", "kept 3\n"));
        put(d, "script.sh", "echo\n", 0o755);
      },
      ["-M"],
    );
    for (const args of [
      [],
      ["--index"],
      ["--cached"],
      ["--check"],
      ["-v"],
      ["--stat"],
      ["--numstat"],
      ["--summary"],
      ["--stat", "--summary", "--apply"],
    ]) {
      await compareApply(
        twins(base),
        patch,
        {
          args,
          configure: (c) => configureArgs(c, args),
        },
        args.join(" "),
      );
    }
    // and back: -R on the result
    const pair = twins(base);
    await compareApply(pair, patch, { args: [], configure: (c) => c });
    await compareApply(pair, patch, { args: ["-R"], configure: (c) => c.setReverse(true) });
  }, 180_000);

  it("applies binary patches, symlinks and quoted names", async () => {
    const bin = (seed: number, n: number) => {
      const r = rng(seed);
      return Buffer.from(Array.from({ length: n }, () => r.int(256)));
    };
    const { patch, base } = nativeDiff(
      (d) => {
        put(d, "img.bin", bin(1, 3000));
        put(d, "lit.bin", bin(2, 50));
        put(d, "tab\tname.txt", "x\n");
        put(d, "café.txt", "a\n");
        symlinkSync("a.txt", join(d, "link"));
        put(d, "a.txt", "a\n");
      },
      (d) => {
        const b = bin(1, 3000);
        b[100] = 7;
        b[2000] = 9;
        put(d, "img.bin", b);
        put(d, "lit.bin", bin(3, 70));
        put(d, "new.bin", bin(4, 20));
        put(d, "tab\tname.txt", "y\n");
        put(d, "café.txt", "b\n");
        rmSync(join(d, "link"));
        symlinkSync("b.txt", join(d, "link"));
      },
      ["--binary"],
    );
    for (const args of [[], ["--index"], ["--stat"], ["--numstat"], ["--summary"]]) {
      await compareApply(
        twins(base),
        patch,
        { args, configure: (c) => configureArgs(c, args) },
        args.join(" "),
      );
    }
    const pair = twins(base);
    await compareApply(pair, patch, { args: [], configure: (c) => c });
    await compareApply(pair, patch, {
      args: ["-R", "--index"],
      configure: (c) => c.setReverse(true).setIndex(true),
    });
    // without --binary: "Binary files differ" cannot be applied
    const plain = nativeDiff(
      (d) => put(d, "x.bin", bin(5, 30)),
      (d) => put(d, "x.bin", bin(6, 30)),
    );
    await compareApply(twins(plain.base), plain.patch, { args: [], configure: (c) => c });
  }, 180_000);

  it("reports what does not apply, with git's messages", async () => {
    const base: Setup = (d) => {
      put(d, "f", lines(10));
      put(d, "g", "g\n");
      gitOk(d, "add", "-A");
      gitOk(d, "commit", "-qm", "base");
    };
    const cases: [string, string][] = [
      ["wrong context", "--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n line 1\n-nope\n+yes\n line 3\n"],
      ["corrupt", "--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n line 1\nzz\n"],
      ["garbage", "just some text\nnothing here\n"],
      ["only header", "diff --git a/f b/f\nindex 1234567..89abcde 100644\n"],
      ["fragment without header", "@@ -1,2 +1,2 @@\n-line 1\n+x\n line 2\n"],
      [
        "new exists",
        "diff --git a/g b/g\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/g\n@@ -0,0 +1 @@\n+g\n",
      ],
      ["missing", "--- a/nothere\n+++ b/nothere\n@@ -1 +1 @@\n-a\n+b\n"],
      [
        "delete with contents",
        "diff --git a/g b/g\ndeleted file mode 100644\n--- a/g\n+++ /dev/null\n@@ -1 +1 @@\n-g\n+h\n",
      ],
      ["bad mode", "diff --git a/g b/g\nold mode 1x0644\nnew mode 100755\n"],
      ["inconsistent", "diff --git a/g b/g\n--- a/g\n+++ b/h\n@@ -1 +1 @@\n-g\n+h\n"],
      ["traditional p0", "--- f\n+++ f\n@@ -1,2 +1,2 @@\n-line 1\n+one\n line 2\n"],
      ["empty", ""],
    ];
    for (const [label, patch] of cases) {
      for (const args of [[], ["--check"], ["--index"]]) {
        await compareApply(
          twins(base),
          patch,
          { args, configure: (c) => configureArgs(c, args) },
          `${label} ${args}`,
        );
        await compareApply(
          twins(base),
          patch,
          { args, file: true, configure: (c) => configureArgs(c, args) },
          `${label} file ${args}`,
        );
      }
    }
    await compareApply(twins(base), "", {
      args: ["--allow-empty"],
      configure: (c) => c.setAllowEmpty(true),
    });
  }, 180_000);

  it("finds hunks at offsets, reduces context and leaves rejects", async () => {
    const { patch } = nativeDiff(
      (d) => put(d, "f", lines(40)),
      (d) => put(d, "f", lines(40).replace("line 10\n", "ten\n").replace("line 30\n", "thirty\n")),
    );
    const drifted: Setup = (d) => {
      put(
        d,
        "f",
        `${lines(5, "extra")}${lines(40).replace("line 12\n", "twelve\n").replace("line 31\n", "LINE 31\n")}`,
      );
      gitOk(d, "add", "-A");
      gitOk(d, "commit", "-qm", "base");
    };
    for (const args of [
      [],
      ["-v"],
      ["-C1", "-v"],
      ["-C0"],
      ["--reject"],
      ["--reject", "-q"],
      ["-C1", "--index", "-v"],
    ]) {
      await compareApply(
        twins(drifted),
        patch,
        { args, configure: (c) => configureArgs(c, args) },
        args.join(" "),
      );
    }
  }, 180_000);

  it("checks and fixes whitespace", async () => {
    const added = [
      "trailing \n",
      " \tspace before tab\n",
      "        eight spaces\n",
      "\ttab\n",
      "ok\n",
      "a\t\n",
      "b \n",
      "c  \n",
      "\n",
      "\n",
    ];
    const { patch, base } = nativeDiff(
      (d) => put(d, "w.txt", lines(5)),
      (d) => put(d, "w.txt", `${lines(5)}${added.join("")}`),
    );
    for (const args of [
      [],
      ["--whitespace=nowarn"],
      ["--whitespace=warn"],
      ["--whitespace=error"],
      ["--whitespace=error-all"],
      ["--whitespace=fix"],
      ["--whitespace=fix", "--index"],
      ["--check"],
      ["--whitespace=bogus"],
    ]) {
      await compareApply(
        twins(base),
        patch,
        { args, file: true, configure: (c) => configureArgs(c, args) },
        args.join(" "),
      );
    }
    // core.whitespace and apply.whitespace
    const configured: Setup = (d) => {
      base(d);
      gitOk(d, "config", "core.whitespace", "indent-with-non-tab,tabwidth=4,-blank-at-eof");
      gitOk(d, "config", "apply.whitespace", "fix");
    };
    await compareApply(twins(configured), patch, { args: [], configure: (c) => c });
  }, 180_000);

  it("applies -U0 patches, traditional diffs and options that change paths", async () => {
    const { patch, base } = nativeDiff(
      (d) => put(d, "sub/f", lines(20)),
      (d) =>
        put(d, "sub/f", lines(20).replace("line 3\n", "three\nthree b\n").replace("line 18\n", "")),
      ["-U0"],
    );
    await compareApply(twins(base), patch, { args: [], configure: (c) => c }, "U0 plain");
    await compareApply(twins(base), patch, {
      args: ["--unidiff-zero"],
      configure: (c) => c.setUnidiffZero(true),
    });
    const trad =
      "--- f.orig\t2024-01-01 10:00:00.000000000 +0100\n+++ f\t2024-01-02 10:00:00.000000000 +0100\n@@ -1,3 +1,3 @@\n line 1\n-line 2\n+two\n line 3\n";
    const atSub: Setup = (d) => {
      put(d, "sub/f", lines(5));
      put(d, "f", lines(5));
      gitOk(d, "add", "-A");
      gitOk(d, "commit", "-qm", "base");
    };
    await compareApply(twins(atSub), trad, { args: [], configure: (c) => c }, "traditional");
    await compareApply(twins(atSub), trad, {
      args: ["--directory=sub"],
      configure: (c) => c.setDirectory("sub"),
    });
    const p2 = "--- x/y/f\n+++ x/y/f\n@@ -1,2 +1,2 @@\n-line 1\n+one\n line 2\n";
    await compareApply(twins(atSub), p2, { args: ["-p2"], configure: (c) => c.setStrip(2) });
    await compareApply(twins(atSub), p2, {
      args: ["-p3", "--directory=sub/"],
      configure: (c) => c.setStrip(3).setDirectory("sub/"),
    });
    const two =
      "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-line 1\n+one\n--- a/sub/f\n+++ b/sub/f\n@@ -1 +1 @@\n-line 1\n+one\n";
    await compareApply(twins(atSub), two, {
      args: ["--include=sub/*", "-v"],
      configure: (c) => c.addInclude("sub/*").setVerbose(true),
    });
    await compareApply(twins(atSub), two, {
      args: ["--exclude=f"],
      configure: (c) => c.addExclude("f"),
    });
    // wrong counts fixed by --recount; a missing final newline by --inaccurate-eof
    const bad = "--- a/f\n+++ b/f\n@@ -1,9 +1,9 @@\n line 1\n-line 2\n+two\n line 3\n";
    await compareApply(twins(atSub), bad, { args: [], configure: (c) => c }, "bad counts");
    await compareApply(twins(atSub), bad, {
      args: ["--recount"],
      configure: (c) => c.setRecount(true),
    });
    const noeol =
      "--- a/f\n+++ b/f\n@@ -4,2 +4,2 @@\n line 4\n-line 5\n+five\n\\ No newline at end of file\n";
    await compareApply(twins(atSub), noeol, { args: [], configure: (c) => c }, "noeol");
  }, 180_000);

  it("falls back to a three-way merge", async () => {
    const { patch } = nativeDiff(
      (d) => put(d, "m.txt", lines(12)),
      (d) =>
        put(d, "m.txt", lines(12).replace("line 2\n", "two\n").replace("line 11\n", "eleven\n")),
      ["--full-index"],
    );
    const setup =
      (variant: string): Setup =>
      (d) => {
        put(d, "m.txt", lines(12));
        gitOk(d, "add", "-A");
        gitOk(d, "commit", "-qm", "base");
        if (variant === "clean") put(d, "m.txt", lines(12).replace("line 6\n", "six\n"));
        if (variant === "conflict") put(d, "m.txt", lines(12).replace("line 2\n", "TWO\n"));
        gitOk(d, "add", "-A");
        gitOk(d, "commit", "-q", "--allow-empty", "-m", "drift");
      };
    for (const variant of ["clean", "conflict"]) {
      for (const args of [["--3way"], ["-3", "--cached"], ["--3way", "--check"]]) {
        await compareApply(
          twins(setup(variant)),
          patch,
          { args, configure: (c) => configureArgs(c, args) },
          `${variant} ${args}`,
        );
      }
    }
  }, 180_000);

  it("applies random diffs to drifted trees as native git does", async () => {
    const r = rng(Number(process.env.APPLY_FUZZ_SEED ?? 20240611));
    const words = [
      "alpha",
      "beta",
      "gamma",
      "delta",
      "eps",
      "",
      "  indented",
      "\ttabbed",
      "trail ",
      "x",
    ];
    const randomFile = (n: number) =>
      Array.from({ length: n }, () => `${r.pick(words)} ${r.int(50)}\n`).join("");
    const edit = (text: string, edits: number) => {
      const ls = text.split(/(?<=\n)/);
      for (let k = 0; k < edits; k++) {
        const at = r.int(ls.length + 1);
        const op = r.int(3);
        if (op === 0) ls.splice(at, 1);
        else if (op === 1) ls.splice(at, 0, `${r.pick(words)} new ${r.int(99)}\n`);
        else if (at < ls.length) ls[at] = `${r.pick(words)} changed\n`;
      }
      let out = ls.join("");
      if (r.chance(0.1)) out = out.replace(/\n$/, "");
      return out;
    };
    const iterations = Number(process.env.APPLY_FUZZ_ITERATIONS ?? 30);
    for (let iter = 0; iter < iterations; iter++) {
      const names = Array.from({ length: 1 + r.int(4) }, (_, i) => `d${i % 2}/f${i}.txt`);
      const start = new Map(names.map((n) => [n, randomFile(8 + r.int(30))]));
      const after = new Map([...start].map(([n, t]) => [n, edit(t, 1 + r.int(4))]));
      const modes = new Map<string, number>();
      // renames, deletions, creations, mode changes, CRLF
      if (r.chance(0.3)) {
        const [n, t] = [...after][0] as [string, string];
        after.delete(n);
        after.set(`moved/${n}`, r.chance(0.5) ? t : edit(t, 1));
      }
      if (r.chance(0.2) && after.size > 1)
        after.delete([...after.keys()][after.size - 1] as string);
      if (r.chance(0.3)) after.set(`added${iter}.txt`, randomFile(1 + r.int(5)));
      if (r.chance(0.2)) modes.set([...after.keys()][0] as string, 0o755);
      if (r.chance(0.15)) {
        const k = [...after.keys()][0] as string;
        after.set(k, (after.get(k) as string).replace(/\n/g, "\r\n"));
      }
      const drift = new Map([...start].map(([n, t]) => [n, r.chance(0.5) ? edit(t, r.int(3)) : t]));
      if (r.chance(0.1)) drift.delete([...drift.keys()][0] as string);
      const diffArgs = r.pick([
        [],
        ["-U0"],
        ["-U1"],
        ["-U5"],
        ["--full-index"],
        ["-M"],
        ["-M", "--binary"],
      ]);
      const { patch } = nativeDiff(
        (d) => {
          for (const [n, t] of start) put(d, n, t);
        },
        (d) => {
          for (const n of start.keys()) rmSync(join(d, n), { force: true });
          for (const [n, t] of after) put(d, n, t, modes.get(n) ?? 0o644);
        },
        diffArgs,
      );
      const target: Setup = (d) => {
        for (const [n, t] of drift) put(d, n, t);
        gitOk(d, "add", "-A");
        gitOk(d, "commit", "-q", "--allow-empty", "-m", "drift");
      };
      const args = r.pick([
        [],
        ["-v"],
        ["--reject"],
        ["-C1"],
        ["-C1", "-v"],
        ["--whitespace=fix"],
        ["--whitespace=error-all"],
        ["--index"],
        ["-R"],
        ["--check", "-v"],
        ["--unidiff-zero"],
        ["--stat"],
        ["--numstat"],
        ["--summary"],
        ["--3way"],
      ]);
      await compareApply(
        twins(target),
        patch,
        { args, file: r.chance(0.5), configure: (c) => configureArgs(c, args) },
        `iter ${iter} ${diffArgs} ${args}`,
      );
    }
  }, 180_000);

  it("refuses an index with a path as both a file and a directory", async () => {
    const base: Setup = (d) => {
      put(d, "a.txt", "a\n");
      put(d, "dir/f", "f\n");
      gitOk(d, "add", "-A");
      gitOk(d, "commit", "-qm", "base");
    };
    const under =
      "diff --git a/a.txt/x b/a.txt/x\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt/x\n@@ -0,0 +1 @@\n+x\n";
    const over =
      "diff --git a/dir b/dir\nnew file mode 100644\n--- /dev/null\n+++ b/dir\n@@ -0,0 +1 @@\n+d\n";
    const rename =
      "diff --git a/a.txt b/a.txt/y\nsimilarity index 100%\nrename from a.txt\nrename to a.txt/y\n";
    const swap = `diff --git a/a.txt b/a.txt\ndeleted file mode 100644\n--- a/a.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n${under}`;
    for (const [label, patch] of [
      ["under", under],
      ["over", over],
      ["rename", rename],
      ["swap", swap],
    ] as const) {
      for (const args of [["--cached"], ["--cached", "-N"], ["--index"]]) {
        await compareApply(
          twins(base),
          patch,
          { args, configure: (c) => configureArgs(c, args) },
          `${label} ${args}`,
        );
      }
      // --index with the parent file gone from the worktree only
      await compareApply(
        twins((d) => {
          base(d);
          rmSync(join(d, "a.txt"));
        }),
        patch,
        { args: ["--index"], configure: (c) => c.setIndex(true) },
        `${label} --index without a.txt`,
      );
    }
  }, 180_000);

  it("reads the old file keeping CRLF when the patch context has CRLF", async () => {
    const crlf = "a\r\nb\r\nc\r\n";
    const crlfPatch = "--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\r\n-b\r\n+B\r\n c\r\n";
    const lfPatch = "--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
    const withAttributes =
      (attributes: string): Setup =>
      (d) => {
        put(d, "f", crlf);
        // f dated well before the index: once the attributes ask for eol conversion, the
        // CRLF blob no longer matches f's cleaned content, so whether native git trusts the
        // stat data (clean) or re-reads a racily clean f (smudged, " M f") would depend on
        // whether this setup crossed a second boundary, differently in each twin
        const past = new Date(Date.now() - 60_000);
        utimesSync(join(d, "f"), past, past);
        gitOk(d, "add", "-A");
        gitOk(d, "commit", "-qm", "base");
        put(d, ".gitattributes", attributes);
        gitOk(d, "add", ".gitattributes");
        gitOk(d, "commit", "-qm", "attributes");
      };
    for (const attributes of ["* text eol=lf\n", "* text=auto\n", "* text eol=crlf\n"]) {
      for (const [label, patch] of [
        ["crlf", crlfPatch],
        ["lf", lfPatch],
      ] as const) {
        for (const args of [[], ["--check"]]) {
          await compareApply(
            twins(withAttributes(attributes)),
            patch,
            { args, configure: (c) => configureArgs(c, args) },
            `${attributes.trim()} ${label} ${args}`,
          );
        }
      }
    }
  }, 180_000);

  it("applies submodule patches as native git does", async () => {
    const a = "1111111111111111111111111111111111111111";
    const b = "2222222222222222222222222222222222222222";
    const bump = `diff --git a/sub b/sub\nindex 1111111..2222222 160000\n--- a/sub\n+++ b/sub\n@@ -1 +1 @@\n-Subproject commit ${a}\n+Subproject commit ${b}\n`;
    const remove = `diff --git a/sub b/sub\ndeleted file mode 160000\nindex 1111111..0000000\n--- a/sub\n+++ /dev/null\n@@ -1 +0,0 @@\n-Subproject commit ${a}\n`;
    const toFile = `${remove}diff --git a/sub b/sub\nnew file mode 100644\nindex 0000000..f2ad6c7\n--- /dev/null\n+++ b/sub\n@@ -0,0 +1 @@\n+c\n`;
    const add = `diff --git a/sub2 b/sub2\nnew file mode 160000\nindex 0000000..2222222\n--- /dev/null\n+++ b/sub2\n@@ -0,0 +1 @@\n+Subproject commit ${b}\n`;
    const corrupt = `diff --git a/sub2 b/sub2\nnew file mode 160000\nindex 0000000..2222222\n--- /dev/null\n+++ b/sub2\n@@ -0,0 +1 @@\n+Subproject commit nothex\n`;
    const withSub =
      (worktree: "empty" | "populated" | "absent"): Setup =>
      (d) => {
        put(d, "f", "f\n");
        gitOk(d, "add", "f");
        gitOk(d, "update-index", "--add", "--cacheinfo", `160000,${a},sub`);
        gitOk(d, "commit", "-qm", "base");
        if (worktree === "empty") mkdirSync(join(d, "sub"));
        if (worktree === "populated") {
          mkdirSync(join(d, "sub"));
          gitOk(join(d, "sub"), "init", "-q");
          put(join(d, "sub"), "s", "s\n");
        }
      };
    for (const worktree of ["empty", "populated", "absent"] as const) {
      for (const [label, patch] of [
        ["bump", bump],
        ["remove", remove],
        ["to file", toFile],
        ["add", add],
        ["corrupt", corrupt],
      ] as const) {
        for (const args of [[], ["--index"], ["--cached"], ["-3"], ["-R"], ["--check"]]) {
          await compareApply(
            twins(withSub(worktree)),
            patch,
            { args, configure: (c) => configureArgs(c, args) },
            `${worktree} ${label} ${args}`,
          );
        }
      }
    }
  }, 300_000);

  it("reports messages as git's vreportf, binary hunk errors and rejects with --cached", async () => {
    const base: Setup = (d) => {
      put(d, "f", "a\r\nb\r\nc\r\n");
      put(d, "g", lines(3));
      put(d, "bin", Buffer.from([0, 1, 2, 3]));
      gitOk(d, "add", "-A");
      gitOk(d, "commit", "-qm", "base");
    };
    const long = `${lines(400, "a long line of context that does not match anything")}`;
    const cases: [string, string, string[]][] = [
      // control characters in the searched text become '?'
      [
        "control",
        "--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\r\n-x\u0001\u001b\r\n+B\r\n c\r\n",
        ["-v"],
      ],
      // the message cut at 4096 bytes
      [
        "long",
        `--- a/g\n+++ b/g\n@@ -1,401 +1,401 @@\n${long
          .split("\n")
          .filter(Boolean)
          .map((l) => ` ${l}\n`)
          .join("")}-x\n+y\n`,
        ["-v"],
      ],
      ["control name", "--- a/x\u0002y\n+++ b/x\u0002y\n@@ -1 +1 @@\n-a\n+b\n", []],
    ];
    for (const [label, patch, args] of cases) {
      await compareApply(
        twins(base),
        patch,
        { args, configure: (c) => configureArgs(c, args) },
        label,
      );
    }
    // binary hunks: a bad base85 character, a bad zlib stream, a wrong length
    const encode85 = (data: number[]) => {
      const en =
        "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
      const out: string[] = [];
      for (let i = 0; i < data.length; i += 52) {
        const chunk = data.slice(i, i + 52);
        let line =
          chunk.length <= 26
            ? String.fromCharCode(64 + chunk.length)
            : String.fromCharCode(96 + chunk.length - 26);
        for (let j = 0; j < chunk.length; j += 4) {
          let acc = 0;
          for (let k = 0; k < 4; k++) acc = acc * 256 + (chunk[j + k] ?? 0);
          let group = "";
          for (let k = 0; k < 5; k++) {
            group = en[acc % 85] + group;
            acc = Math.floor(acc / 85);
          }
          line += group;
        }
        out.push(line);
      }
      return out.join("\n");
    };
    const binary = (size: number, body: string) =>
      `diff --git a/bin b/bin\nindex 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644\nGIT binary patch\nliteral ${size}\n${body}\n\nliteral 0\nHcmV?d00001\n\n`;
    const binCases: [string, string][] = [
      [
        "base85",
        binary(4, `${encode85([0x78, 0x9c, 1, 2, 3, 4, 5, 6])}`.replace(/^(.{3})./, '$1"')),
      ],
      [
        "base85 nul",
        binary(4, `${encode85([0x78, 0x9c, 1, 2, 3, 4, 5, 6])}`.replace(/^(.{3})./, "$1\u0000")),
      ],
      ["zlib header", binary(4, encode85([0x78, 0x9d, 1, 2, 3, 4, 5, 6]))],
      ["zlib block", binary(4, encode85([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff, 0, 0]))],
      ["truncated", binary(4, encode85([0x78, 0x9c, 0x63, 0x60]))],
      [
        "length",
        binary(
          9,
          encode85([0x78, 0x9c, 0x63, 0x60, 0x60, 0x64, 0x62, 0x06, 0x00, 0x00, 0x0d, 0x00, 0x07]),
        ),
      ],
    ];
    for (const [label, patch] of binCases) {
      await compareApply(twins(base), patch, { args: [], configure: (c) => c }, label);
      await compareApply(
        twins(base),
        patch,
        { args: [], file: true, configure: (c) => c },
        `${label} file`,
      );
    }
    // --whitespace=error-all, then fix: every error is still reported
    const ws = "--- a/g\n+++ b/g\n@@ -3 +3,7 @@\n line 3\n+a \n+b \n+c \n+d \n+e \n+f \n";
    await compareApply(twins(base), ws, {
      args: ["--whitespace=error-all", "--whitespace=fix"],
      configure: (c) => c.setWhitespace("error-all").setWhitespace("fix"),
    });
    await compareApply(twins(base), ws, {
      args: ["--whitespace=error-all", "--whitespace=warn"],
      configure: (c) => c.setWhitespace("error-all").setWhitespace("warn"),
    });
    // --cached --reject: the applied hunks go to the index, the rejects to the worktree
    const partly =
      "--- a/g\n+++ b/g\n@@ -1,2 +1,2 @@\n-line 1\n+one\n line 2\n@@ -2,2 +2,2 @@\n line 2\n-nope\n+three\n";
    await compareApply(twins(base), partly, {
      args: ["--cached", "--reject"],
      configure: (c) => c.setCached(true).setReject(true),
    });
  }, 180_000);

  it("applies thousands of hunks at offsets, in linear time", async () => {
    const n = 20000;
    const base = lines(n);
    const changed = base
      .split(/(?<=\n)/)
      .map((l, i) => (i % 20 === 10 ? `changed ${i}\n` : i % 40 === 5 ? "" : l))
      .join("");
    const { patch } = nativeDiff(
      (d) => put(d, "big.txt", base),
      (d) => put(d, "big.txt", changed),
    );
    // the target drifted: lines added at the top, some hunks' context changed
    const drifted = `${lines(3, "top")}${base
      .split(/(?<=\n)/)
      .map((l, i) => (i % 2000 === 11 ? `drift ${i}\n` : l))
      .join("")}`;
    const target: Setup = (d) => {
      put(d, "big.txt", drifted);
      gitOk(d, "add", "-A");
      gitOk(d, "commit", "-qm", "drifted");
    };
    for (const args of [[], ["--reject"], ["-C1"], ["--index", "-C1"]]) {
      const started = performance.now();
      await compareApply(
        twins(target),
        patch,
        { args, configure: (c) => configureArgs(c, args) },
        `big ${args}`,
      );
      expect(performance.now() - started).toBeLessThan(60_000);
    }
  }, 300_000);

  it("keeps the bytes of postimage lines cut at the end, as git 2.5x", async () => {
    // git 2.43 aborts on this patch (its update_pre_post_images had a different splice)
    if (!gitAtLeast(gitOk(root, "--version"), 2, 50)) return;
    const patch = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,4 +1,5 @@\n a\n+X\n b\n c\n \n";
    await compareApply(
      twins((d) => put(d, "f", "a\nb\nc")),
      patch,
      {
        args: ["--whitespace=fix", "--ignore-whitespace"],
        configure: (c) => c.setWhitespace("fix").setIgnoreWhitespace(true),
      },
      "cut postimage",
    );
  });

  it("reports a path below a file as not a directory", async () => {
    const patch =
      "diff --git a/f/inner b/f/inner\ndeleted file mode 100644\n--- a/f/inner\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n";
    await compareApply(
      twins((d) => put(d, "f", "file\n")),
      patch,
      { args: [] },
      "below a file",
    );
    await compareApply(
      twins(() => {}),
      patch,
      { args: [] },
      "missing",
    );
  });

  it("smudges the racily clean entries an --cached write keeps (no refresh first)", async () => {
    // f is rewritten in place after `git add`, same size, same mtime second as the index:
    // apply.c writes the index without refreshing, so the write smudges f's entry (size 0)
    // and status then sees f modified in the worktree
    const build = (dir: string) => {
      gitOk(dir, "config", "core.trustctime", "false");
      put(dir, "f", "one\ntwo\n");
      put(dir, "g", "x\n");
      gitOk(dir, "add", ".");
      gitOk(dir, "commit", "-qm", "base");
      const t = Math.floor(Date.now() / 1000) - 100;
      put(dir, "f", "one\nTWO\n");
      utimesSync(join(dir, "f"), t, t);
      gitOk(dir, "add", "f");
      writeFileSync(join(dir, "f"), "one\nthr\n");
      utimesSync(join(dir, "f"), t, t);
      utimesSync(join(dir, ".git/index"), t, t);
    };
    const patch = "diff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -1 +1,2 @@\n x\n+y\n";
    const dirs = twins(build);
    expect(git(dirs.native, ["apply", "--cached"], patch).status).toBe(0);
    const ours = await (await open(dirs.ours))
      .apply()
      .addPatch(new TextEncoder().encode(patch))
      .setCached(true)
      .call();
    expect(ours.exitCode).toBe(0);
    const state = (dir: string) => ({
      size: /size: (\d+)/.exec(gitOk(dir, "ls-files", "--debug", "f"))?.[1],
      status: gitOk(dir, "status", "--porcelain"),
    });
    expect(state(dirs.native).status).toBe("MM f\nMM g\n");
    expect(state(dirs.ours)).toEqual(state(dirs.native));
  });
});

/** Our command configured as native `git apply <args>`. */
function configureArgs(c: ApplyCommand, args: string[]): ApplyCommand {
  for (const a of args) {
    if (a === "--index") c.setIndex(true);
    else if (a === "--cached") c.setCached(true);
    else if (a === "--check") c.setCheck(true);
    else if (a === "--stat") c.setStat(true);
    else if (a === "--numstat") c.setNumstat(true);
    else if (a === "--summary") c.setSummary(true);
    else if (a === "--apply") c.setApply(true);
    else if (a === "-v") c.setVerbose(true);
    else if (a === "-q") c.setVerbose(false);
    else if (a === "-R") c.setReverse(true);
    else if (a === "--reject") c.setReject(true);
    else if (a === "--3way" || a === "-3") c.setThreeWay(true);
    else if (a === "--unidiff-zero") c.setUnidiffZero(true);
    else if (a === "--recount") c.setRecount(true);
    else if (a === "-N") c.setIntentToAdd(true);
    else if (a.startsWith("-C")) c.setContext(Number(a.slice(2)));
    else if (a.startsWith("-p")) c.setStrip(Number(a.slice(2)));
    else if (a.startsWith("--whitespace=")) c.setWhitespace(a.slice(13));
    else throw new Error(`unmapped ${a}`);
  }
  return c;
}
