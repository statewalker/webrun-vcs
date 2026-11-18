/**
 * The config file as git's `config.c` parses it, against native git: backslash line
 * continuations (inside and outside quotes), quoted values, the escapes `\n` `\t` `\b` `\"`
 * `\\`, comments after values, a value without `=`; `git config --local --list
 * --show-origin -z` compared with `listWithOrigin`, line numbers through git's errors
 * (`bad config line <n>`, `bad config variable ... at line <n>`), a value written back
 * keeping every other byte. And `core.disambiguate` checked as every command loads the
 * configuration (`git status` dies too).
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitFilesBackend,
  type GitWorkingCopyConfig,
  openGitLinkedWorktrees,
} from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, ResetMode } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";
let counter = 0;

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: nativeGitEnv(home), encoding: "latin1" });
const native = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, env: nativeGitEnv(home), encoding: "latin1" });

async function openCopy(repo: string): Promise<WorkingCopy> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: nativeGitEnv(home) });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return worktrees.openCurrent();
}

/** Native git's version as major + minor / 100 (2.43 for git 2.43). */
function nativeVersion(): number {
  const match = /(\d+)\.(\d+)/.exec(run(root || tmpdir(), "--version"));
  return match ? Number(match[1]) + Number(match[2]) / 100 : 0;
}

/** A repository with one commit, `extra` appended to its `.git/config`. */
function repoWith(extra: string): string {
  const repo = join(root, `r${counter++}`);
  run(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  run(repo, "add", ".");
  run(repo, "commit", "-qm", "c1");
  appendFileSync(join(repo, ".git", "config"), extra);
  return repo;
}

/** Every file under `dir` (`.git` included) with its content, for "nothing was written". */
function snapshotTree(dir: string, base = dir, out: Record<string, string> = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) snapshotTree(path, base, out);
    else out[path.slice(base.length + 1)] = readFileSync(path, "latin1");
  }
  return out;
}

/** What our configuration lists, as `git config --local --list --show-origin -z` prints it. */
function ourList(wc: WorkingCopy): string {
  const config = wc.config as unknown as GitWorkingCopyConfig;
  return config
    .listWithOrigin()
    .filter((e) => e.file === ".git/config")
    .map((e) => `file:${e.file}\0${e.text === undefined ? e.key : `${e.key}\n${e.text}`}\0`)
    .join("");
}

/** Values git and ours read the same way, line numbers through a bad core.disambiguate. */
const TRICKY = [
  "[t]",
  "\tplain = value ; comment",
  "\thash = value# comment",
  '\tquoted = "  spaced  ; not a comment # nor this  "',
  '\tmixed = a"b c"d  ; end',
  '\tesc = "tab\\there\\nnewline \\"q\\" back\\\\slash \\bbs"',
  "\tcont = first \\",
  "second",
  '\tcontq = "in \\',
  'quote"',
  "\tcontcomment = a ; comment \\",
  "\tafter = x",
  "\ttrail = value   \\",
  "",
  "\tnovalue",
  "\tempty =",
  '\temptyq = ""',
  "\tspaces =    lead and trail   ",
  "\tcrlf = dos\r",
  "\tmulti = one \\",
  "  two \\",
  "   three",
  "\tkeep = 1",
  '[t "Sub Section"]',
  "\tKey = v",
  "[t.Dotted]",
  "\tk = v",
  "[x] inline = 1 ; after the header",
  "",
].join("\n");

describeGit("config parsing as git's config.c", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "config-parse-native-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("continuations, quotes, escapes and comments: --list --show-origin", async () => {
    const repo = repoWith(TRICKY);
    const expected = run(repo, "config", "--local", "--list", "--show-origin", "-z");
    expect(ourList(await openCopy(repo))).toBe(expected);
  });

  // git before 2.5x wrote each blank of an unquoted value as a space
  it.runIf(nativeVersion() >= 2.5)(
    "blanks inside an unquoted value kept as written (2.5x)",
    async () => {
      const repo = repoWith("[t]\n\tm = one \\\n  two \\\n\tthree\n\tn = a\tb \t c\n");
      const expected = run(repo, "config", "--local", "--list", "--show-origin", "-z");
      expect(expected).toContain("t.n\na\tb \t c\0");
      expect(ourList(await openCopy(repo))).toBe(expected);
    },
  );

  it("line numbers follow continuation lines (bad config variable ... at line <n>)", async () => {
    const repo = repoWith(`${TRICKY}[core]\n\tdisambiguate = "no\\\nsuch"\n`);
    const n = native(repo, "status");
    expect(n.status).toBe(128);
    const git = Git.fromWorkingCopy(await openCopy(repo));
    await expect(git.status().call()).rejects.toThrow(n.stderr.trimEnd());
  });

  it("git's errors: unknown escapes, an open quote, bad names (bad config line <n>)", async () => {
    for (const bad of [
      "\tx = a\\qb\n",
      "\tx = one \\\n two \\q\n",
      '\tx = "open \\\nstill open\n',
      '\tx = "open\n\ty = 1\n',
      "\tx ; no value\n",
      "\t1x = y\n",
      "\tx.y = z\n",
      "[sec\n",
      '[sec "sub" ]\n',
      "[ sec]\n",
      "[]\n",
      '[sec "sub\\\n"]\n',
    ]) {
      const repo = repoWith(`[t]\n\tok = "a \\\nb"\n${bad}`);
      const n = native(repo, "status");
      expect([bad, n.status]).toEqual([bad, 128]);
      let message = "";
      try {
        await openCopy(repo);
      } catch (error) {
        message = `fatal: ${(error as Error).message}\n`;
      }
      expect([bad, message]).toEqual([bad, n.stderr]);
    }
  });

  it("a value written back: the other lines kept byte for byte", async () => {
    for (const [key, value] of [
      ["t.plain", "new"],
      ["t.multi", "replaced"],
      ["t.cont", "a b"],
      ["t.keep", "2"],
    ] as const) {
      const theirs = repoWith(TRICKY);
      const ours = repoWith(TRICKY);
      run(theirs, "config", key, value);
      const wc = await openCopy(ours);
      const config = wc.config as unknown as GitWorkingCopyConfig;
      config.set(key, value);
      await config.save();
      const read = (dir: string) => readFileSync(join(dir, ".git", "config"), "latin1");
      expect([key, read(ours)]).toEqual([key, read(theirs)]);
    }
  });

  it("core.disambiguate is checked by every command, status included", async () => {
    const repo = repoWith("[core]\n\tdisambiguate = foo\n");
    const git = Git.fromWorkingCopy(await openCopy(repo));
    for (const [args, call] of [
      [["status"], () => git.status().call()],
      [["log"], async () => git.log().call()],
      [["add", "a.txt"], () => git.add().addFilepattern("a.txt").call()],
      [["branch", "x"], () => git.branchCreate().setName("x").call()],
    ] as const) {
      const n = native(repo, ...args);
      expect([args, n.status]).toEqual([args, 128]);
      let message = "";
      try {
        await call();
      } catch (error) {
        message = `${(error as Error).message}\n`;
      }
      expect([args, message]).toEqual([args, n.stderr]);
    }
  });

  it("a bad core.disambiguate stops writing commands before they write anything", async () => {
    const repo = repoWith("");
    run(repo, "checkout", "-qb", "feat");
    writeFileSync(join(repo, "b.txt"), "b\n");
    run(repo, "add", ".");
    run(repo, "commit", "-qm", "c2");
    run(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "a.txt"), "dirty\n");
    appendFileSync(join(repo, ".git", "config"), "[core]\n\tdisambiguate = foo\n");
    const git = Git.fromWorkingCopy(await openCopy(repo));
    const before = snapshotTree(repo);
    for (const [args, call] of [
      [["commit", "-qam", "m"], () => git.commit().setAll(true).setMessage("m").call()],
      [["tag", "t1"], () => git.tag().setName("t1").call()],
      [["merge", "feat"], () => git.merge().include("feat").call()],
      [["rebase", "feat"], () => git.rebase().setUpstreamName("feat").call()],
      [["cherry-pick", "feat"], () => git.cherryPick().include("feat").call()],
      [["stash"], () => git.stashCreate().call()],
      [["branch", "x"], () => git.branchCreate().setName("x").call()],
      [
        ["reset", "--hard", "feat"],
        () => git.reset().setRef("feat").setMode(ResetMode.HARD).call(),
      ],
      [["checkout", "feat"], () => git.checkout().setName("feat").call()],
    ] as const) {
      const n = native(repo, ...args);
      expect([args, n.status]).toEqual([args, 128]);
      let message = "";
      try {
        await call();
      } catch (error) {
        message = `${(error as Error).message}\n`;
      }
      expect([args, message]).toEqual([args, n.stderr]);
      expect([args, snapshotTree(repo)]).toEqual([args, before]);
    }
  });

  it("\\v and \\f are no blanks, a NUL ends a value, a variable before any section", async () => {
    const repo = repoWith("");
    const config = join(repo, ".git", "config");
    const original = readFileSync(config, "latin1");
    for (const text of [
      // a value keeps \v and \f at its ends; a line starting with one is refused
      `${original}[t]\n\tx = a\vb\f\n\ty = \f\n`,
      `${original}\v[t]\n`,
      `${original}[t]\n\v\tx = 1\n`,
      `${original}[t\f]\n`,
      // git reads a value as a C string: it ends at the NUL
      `${original}[t]\n\tv = a\0b\n\tw = x\n\tq = "c\0d"\n`,
      // listed under its bare name, out of reach of any key with a section
      `top = 1\ncont = a \\\nb\n${original}`,
    ]) {
      writeFileSync(config, text, "latin1");
      const n = native(repo, "config", "--local", "--list", "--show-origin", "-z");
      let ours = "";
      let status = 0;
      try {
        ours = ourList(await openCopy(repo));
      } catch (error) {
        status = 128;
        ours = `fatal: ${(error as Error).message}\n`;
      }
      const theirs = n.status === 0 ? n.stdout : n.stderr;
      expect([JSON.stringify(text), status, ours]).toEqual([
        JSON.stringify(text),
        n.status,
        theirs,
      ]);
    }
    writeFileSync(config, `top = 1\n${original}`, "latin1");
    const wc = await openCopy(repo);
    expect((wc.config as unknown as GitWorkingCopyConfig).get("top")).toBeUndefined();
    expect(native(repo, "config", "top").status).toBe(1);
  });

  it("core.abbrev written as a number or a boolean sets the stash store's ids", async () => {
    for (const value of ["12", "false", "no", "auto"]) {
      const repo = repoWith(`[core]\n\tabbrev = ${value}\n`);
      writeFileSync(join(repo, "a.txt"), "dirty\n");
      const short = run(repo, "rev-parse", "--short", "HEAD").trim();
      // the working copy's own stash (GitStashStore.push), as the stash command's
      const wc = await openCopy(repo);
      await wc.stash.push();
      const subjects = [
        run(repo, "log", "-1", "--format=%s", "refs/stash"),
        run(repo, "log", "-1", "--format=%s", "refs/stash^2"),
        run(repo, "stash", "list"),
      ];
      expect([value, subjects]).toEqual([
        value,
        [
          `WIP on main: ${short} c1\n`,
          `index on main: ${short} c1\n`,
          `stash@{0}: WIP on main: ${short} c1\n`,
        ],
      ]);
    }
  });
});
