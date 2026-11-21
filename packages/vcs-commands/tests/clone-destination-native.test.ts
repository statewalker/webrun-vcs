/**
 * `git clone` into a destination that is not empty, of an empty repository and of a corrupt
 * one, against native git. Ours clones into a working copy `git init` made: one that has
 * refs, index entries or worktree files, or that the source resolves to, is git's existing
 * non-empty directory, refused before anything is written.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git, GitApiError } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitHttpBackend } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

async function ours(name: string): Promise<Git> {
  return openOurs(root, createNodeGitHostEnvironment({ env: testEnv(root) }), undefined, name);
}

/** What a directory holds, `.git` included (its refs and config as text). */
function state(dir: string) {
  const at = join(root, dir);
  return {
    files: readdirSync(at).sort(),
    refs: git(at, "for-each-ref", "--format=%(refname) %(objectname)"),
    config: gitRun(root, at, ["config", "--get-regexp", "^(remote|branch)\\."]).stdout,
    index: git(at, "ls-files", "-s"),
  };
}

/** Our clone's failure, or undefined. */
async function ourClone(
  dir: string,
  url: string,
  local?: boolean,
): Promise<GitApiError | undefined> {
  try {
    const clone = (await ours(dir)).clone().setURI(url);
    if (local !== undefined) clone.setLocal(local);
    await clone.call();
  } catch (e) {
    return e as GitApiError;
  }
  return undefined;
}

describeGit("clone into a destination that is not empty, as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "clone-dest-"));
    const src = join(root, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    putFile(src, "a.txt", "a\n");
    git(src, "add", "a.txt");
    git(src, "commit", "-qm", "one");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A destination made by `prepare` in a repository `git init` made, for each twin. */
  const destinations = (prepare: (dir: string) => void): [string, string] => {
    const names: [string, string] = [`n${counter}`, `o${counter}`];
    counter++;
    for (const name of names) {
      mkdirSync(join(root, name));
      git(join(root, name), "init", "-q", "-b", "main");
      prepare(join(root, name));
    }
    return names;
  };

  const cases: Array<[string, (dir: string) => void]> = [
    ["a worktree file", (dir) => putFile(dir, "mine.txt", "my work\n")],
    [
      "an ignored file",
      (dir) => {
        putFile(dir, ".git/info/exclude", "*.log\n");
        putFile(dir, "build.log", "log\n");
      },
    ],
    ["a directory", (dir) => mkdirSync(join(dir, "sub"))],
    [
      "a commit",
      (dir) => {
        putFile(dir, "c.txt", "c\n");
        git(dir, "add", "c.txt");
        git(dir, "commit", "-qm", "mine");
        rmSync(join(dir, "c.txt"));
        git(dir, "rm", "-q", "--cached", "c.txt");
      },
    ],
    [
      "an index entry",
      (dir) => {
        const blob = git(dir, "hash-object", "-w", "--stdin").trim();
        git(dir, "update-index", "--add", "--cacheinfo", `100644,${blob},staged.txt`);
      },
    ],
  ];
  for (const [what, prepare] of cases) {
    it(`refuses a destination with ${what}, writing nothing`, async () => {
      const [n, o] = destinations(prepare);
      const before = state(o);
      // native git: the directory exists and is not empty
      const native = gitRun(root, root, ["clone", "src", n]);
      expect(native.status).toBe(128);
      const error = await ourClone(o, "../src");
      expect(error?.message).toBe(native.stderr.trim().replace(`'${n}'`, `'${o}'`));
      expect(error?.exitCode).toBe(native.status);
      expect(state(o)).toEqual(before);
    });
  }

  it("refuses an http(s) source the same way, before connecting", async () => {
    const [n, o] = destinations((dir) => putFile(dir, "mine.txt", "x\n"));
    const url = "http://127.0.0.1:9/nowhere.git";
    const native = gitRun(root, root, ["clone", url, n]);
    const error = await ourClone(o, url);
    expect(error?.message).toBe(native.stderr.trim().replace(`'${n}'`, `'${o}'`));
    expect(error?.exitCode).toBe(128);
  });

  it("refuses a source that is the destination itself", async () => {
    const [n, o] = destinations(() => {});
    const native = gitRun(root, root, ["clone", n, n]);
    expect(native.status).toBe(128);
    const error = await ourClone(o, ".");
    expect(error?.message).toBe(native.stderr.trim().replace(`'${n}'`, `'${o}'`));
    expect(error?.exitCode).toBe(128);
    expect(state(o).refs).toBe("");
  });

  it("names the directory as setDirectory gives it", async () => {
    const [, o] = destinations((dir) => putFile(dir, "mine.txt", "x\n"));
    let error: GitApiError | undefined;
    try {
      await (await ours(o)).clone().setURI("../src").setDirectory("some/dir").call();
    } catch (e) {
      error = e as GitApiError;
    }
    expect(error?.message).toBe(
      "fatal: destination path 'some/dir' already exists and is not an empty directory.",
    );
  });

  for (const [how, init] of [
    ["a bare repository (HEAD trunk)", ["init", "-q", "--bare", "-b", "trunk"]],
    ["a repository with git's default branch", ["init", "-q"]],
  ] as const) {
    for (const scheme of ["path", "file://"] as const) {
      it(`clone of an empty ${how} by ${scheme} writes the branch's remote and merge`, async () => {
        const name = `empty${counter}`;
        const n = `nempty${counter}`;
        const o = `oempty${counter}`;
        counter++;
        git(root, ...init, name);
        const url = scheme === "path" ? join(root, name) : `file://${join(root, name)}`;
        expect(gitRun(root, root, ["clone", "-q", url, n]).status).toBe(0);
        mkdirSync(join(root, o));
        git(join(root, o), "init", "-q", "-b", "main");
        expect(await ourClone(o, url)).toBeUndefined();
        for (const args of [
          ["config", "--get-regexp", "^(remote|branch)\\."],
          ["symbolic-ref", "HEAD"],
        ]) {
          expect(git(join(root, o), ...args), args.join(" ")).toBe(git(join(root, n), ...args));
        }
      });
    }
  }

  for (const single of [false, true]) {
    it(`clone --single-branch=${single} of an empty repository: git's configuration`, async () => {
      const name = `empty${counter}.git`;
      const n = `nempty${counter}`;
      const o = `oempty${counter}`;
      counter++;
      git(root, "init", "-q", "--bare", "-b", "trunk", name);
      const args = single ? ["--single-branch"] : ["--no-single-branch"];
      expect(gitRun(root, root, ["clone", "-q", ...args, join(root, name), n]).status).toBe(0);
      mkdirSync(join(root, o));
      git(join(root, o), "init", "-q", "-b", "main");
      await (await ours(o)).clone().setURI(join(root, name)).setSingleBranch(single).call();
      const config = ["config", "--get-regexp", "^(remote|branch)\\."];
      expect(git(join(root, o), ...config)).toBe(git(join(root, n), ...config));
    });
  }

  it("clone --branch of an empty repository fails as git", async () => {
    const name = `empty${counter}.git`;
    const o = `oempty${counter}`;
    counter++;
    git(root, "init", "-q", "--bare", "-b", "trunk", name);
    const native = gitRun(root, root, ["clone", "--branch", "trunk", join(root, name), `n${o}`]);
    mkdirSync(join(root, o));
    git(join(root, o), "init", "-q", "-b", "main");
    let error: GitApiError | undefined;
    try {
      await (await ours(o)).clone().setURI(join(root, name)).setBranch("trunk").call();
    } catch (e) {
      error = e as GitApiError;
    }
    const lines = native.stderr.trim().split("\n");
    expect(error?.message).toBe(lines.filter((l) => !l.startsWith("Cloning into")).join("\n"));
    expect(error?.exitCode).toBe(native.status);
  });

  it("clone of an empty repository over smart HTTP writes the branch's remote and merge", async () => {
    const name = `empty${counter}.git`;
    const n = `nempty${counter}`;
    const o = `oempty${counter}`;
    counter++;
    git(root, "init", "-q", "--bare", "-b", "trunk", name);
    expect(gitRun(root, root, ["clone", "-q", join(root, name), n]).status).toBe(0);
    mkdirSync(join(root, o));
    git(join(root, o), "init", "-q", "-b", "main");
    const backend = nativeGitHttpBackend(root, root);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = backend.fetch;
    const url = `http://localhost/${name}`;
    try {
      expect(await ourClone(o, url)).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      backend.close();
    }
    const config = (dir: string) =>
      git(join(root, dir), "config", "--get-regexp", "^(remote|branch)\\.")
        .split("\n")
        .filter((l) => !l.startsWith("remote.origin.url "));
    expect(config(o)).toEqual(config(n));
    expect(git(join(root, o), "symbolic-ref", "HEAD")).toBe(
      git(join(root, n), "symbolic-ref", "HEAD"),
    );
  });

  it("clone of a corrupt repository aborts as git: possible repository corruption", async () => {
    const bad = join(root, "bad");
    mkdirSync(bad);
    git(bad, "init", "-q", "-b", "main");
    putFile(bad, "h.txt", "hello\n");
    git(bad, "add", "h.txt");
    git(bad, "commit", "-qm", "one");
    const blob = git(bad, "rev-parse", "HEAD:h.txt").trim();
    const file = join(bad, ".git/objects", blob.slice(0, 2), blob.slice(2));
    rmSync(file, { force: true });
    writeFileSync(file, "garbage");
    const n = `nbad${counter}`;
    const o = `obad${counter}`;
    counter++;
    const native = gitRun(root, root, ["clone", "--no-local", "bad", n]);
    expect(native.status).toBe(128);
    mkdirSync(join(root, o));
    git(join(root, o), "init", "-q", "-b", "main");
    const error = await ourClone(o, "../bad", false);
    // git's lines but pack-objects' own (its reading errors, forwarded as "remote: ...")
    const lines = native.stderr
      .split("\n")
      // git 2.43 sends the abort message's NUL on band 3
      .map((l) => l.replace(/[\s\0]+$/, ""))
      .filter((l) => l && !l.startsWith("Cloning into") && !/^remote: (error|fatal): /.test(l));
    expect(lines).toContain(
      "fatal: git upload-pack: aborting due to possible repository corruption on the remote side.",
    );
    // upload-pack's stderr and the client's interleave as the processes race: the same
    // lines, in either order
    expect(error?.message.split("\n").sort()).toEqual([...lines].sort());
    expect(error?.exitCode).toBe(native.status);
    expect(state(o).refs).toBe("");
  });
});
