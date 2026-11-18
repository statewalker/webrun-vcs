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

import { Git } from "../src/index.js";
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
});
