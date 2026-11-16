/**
 * Abbreviated object ids against native git: `git diff` index lines (and the combined
 * diff's) and `git blame`'s default output take git's length, from `core.abbrev` (auto,
 * a number, `no`), the approximate object count (a repository of more than 16384 packed
 * objects, built with `git fast-import`, gets 8 digits) and uniqueness (an object sharing
 * a prefix lengthens the id).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { afterAll, describe, expect, it } from "vitest";

import { type DiffOutputFormat, formatBlame, Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "";
const [major, minor] = (/(\d+)\.(\d+)/.exec(version) ?? ["", "0", "0"]).slice(1).map(Number);
const atLeast = (ma: number, mi: number) => major > ma || (major === ma && minor >= mi);
/** git before 2.5x widened the abbreviated ids of blame by one even without a boundary */
const alwaysWidenAbbrev = !atLeast(2, 50);

let root: string | undefined;
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
const tmp = () => {
  root ??= mkdtempSync(join(tmpdir(), "abbrev-native-"));
  return root;
};

const run = (cwd: string, args: string[], input?: string | Uint8Array) =>
  execFileSync("git", args, {
    cwd,
    input,
    env: nativeGitEnv(tmp()),
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 1 << 28,
  })
    .toString()
    .trim();

const native = (cwd: string, args: string[]): string => {
  const res = spawnSync("git", args, { cwd, env: nativeGitEnv(tmp()), maxBuffer: 1 << 28 });
  if (res.status !== 0 && res.status !== 1) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.toString();
};

async function open(dir: string): Promise<Git> {
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
  await staging.read();
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

const lines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag} line ${i}\n`).join("");

/** A blob whose id starts with the first `digits` hex digits of `id` (found by trying) */
function collidingBlob(id: string, digits: number, tag: string): string {
  for (let i = 0; ; i++) {
    const content = `${tag} ${i}\n`;
    const h = createHash("sha1")
      .update(`blob ${Buffer.byteLength(content)}\0`)
      .update(content)
      .digest("hex");
    if (h.startsWith(id.slice(0, digits)) && h !== id) return content;
  }
}

const FORMATS: DiffOutputFormat[] = ["patch"];

async function compareAll(dir: string, label: string): Promise<string[]> {
  const mismatches: string[] = [];
  const log = run(dir, ["rev-list", "--reverse", "HEAD"]).split("\n");
  const [first, , last] = log;
  const cases: Array<[string, string[], (g: Git) => ReturnType<Git["diff"]>]> = [
    ["A B", [first, last], (g) => g.diff().setOldTree(first).setNewTree(last)],
    ["worktree", [], (g) => g.diff()],
    ["cached", ["--cached"], (g) => g.diff().setCached(true)],
    ["A", [first], (g) => g.diff().setOldTree(first)],
  ];
  for (const [mode, args, make] of cases) {
    for (const format of FORMATS) {
      const ours = await make(await open(dir)).callText(format);
      const theirs = native(dir, ["diff", ...args]);
      if (ours !== theirs)
        mismatches.push(`${label} diff ${mode}\n--- git\n${theirs}\n--- ours\n${ours}`);
    }
  }
  for (const blameArgs of [[], ["--root"]]) {
    const cmd = (await open(dir)).blame().setFilePath("f.txt");
    if (blameArgs.length) cmd.setShowRoot(true);
    if (!atLeast(2, 50)) cmd.setAlgorithm("myers");
    const result = await cmd.call();
    const ours = Buffer.from(
      formatBlame(result, { alwaysWidenAbbrev, autoAbbrev: await result.autoAbbrev?.() }),
    ).toString();
    const theirs = native(dir, ["blame", ...blameArgs, "HEAD", "--", "f.txt"]);
    if (ours !== theirs) {
      mismatches.push(
        `${label} blame ${blameArgs.join(" ")}\n--- git\n${theirs}\n--- ours\n${ours}`,
      );
    }
  }
  return mismatches;
}

describeGit("abbreviated ids against native git", () => {
  it("takes 8 digits in a repository of more than 16384 packed objects", async () => {
    const dir = join(tmp(), "big");
    mkdirSync(dir, { recursive: true });
    run(dir, ["init", "-q", "-b", "main"]);
    // fast-import packs everything it is given: 17000 blobs and three commits
    const parts: string[] = [];
    for (let i = 0; i < 17000; i++) {
      const content = `filler ${i}\n`;
      parts.push(`blob\ndata ${Buffer.byteLength(content)}\n${content}`);
    }
    const versions = [
      lines(20, "one"),
      `${lines(10, "one")}two\n${lines(9, "x")}`,
      lines(15, "three"),
    ];
    for (const [k, v] of versions.entries()) {
      const msg = `commit ${k}\n`;
      parts.push(
        `commit refs/heads/main\ncommitter T <t@example.com> ${1112911993 + k} +0000\ndata ${msg.length}\n${msg}` +
          `M 100644 inline f.txt\ndata ${Buffer.byteLength(v)}\n${v}\n` +
          `M 100644 inline g.txt\ndata 2\ng${k}\n`,
      );
    }
    run(dir, ["fast-import", "--quiet"], `${parts.join("\n")}\n`);
    run(dir, ["checkout", "-q", "-f", "main"]);
    writeFileSync(join(dir, "f.txt"), `${lines(15, "three")}worktree\n`);
    writeFileSync(join(dir, "g.txt"), "staged\n");
    run(dir, ["add", "g.txt"]);
    const diff = native(dir, ["diff", "HEAD~2", "HEAD"]);
    expect(diff).toMatch(/^index [0-9a-f]{8}\.\.[0-9a-f]{8} /m);
    const mismatches: string[] = [];
    for (const abbrev of [undefined, "auto", "10", "no", "4"]) {
      if (abbrev) run(dir, ["config", "core.abbrev", abbrev]);
      mismatches.push(...(await compareAll(dir, `core.abbrev=${abbrev}`)));
    }
    for (const m of mismatches.slice(0, 3)) console.log(m);
    expect(mismatches).toEqual([]);
  }, 300_000);

  it("lengthens an id another object shares a prefix with", async () => {
    const dir = join(tmp(), "collide");
    mkdirSync(dir, { recursive: true });
    run(dir, ["init", "-q", "-b", "main"]);
    run(dir, ["config", "core.abbrev", "4"]);
    for (const [k, v] of [
      lines(8, "a"),
      `${lines(4, "a")}b\n${lines(3, "a")}`,
      lines(6, "c"),
    ].entries()) {
      writeFileSync(join(dir, "f.txt"), v);
      writeFileSync(join(dir, "g.txt"), `g${k}\n`);
      run(dir, ["add", "-A"]);
      run(dir, ["commit", "-q", "-m", `c${k}`]);
    }
    writeFileSync(join(dir, "f.txt"), `${lines(6, "c")}worktree\n`);
    // loose objects sharing 4 digits with the newest blob of f.txt, a commit and a worktree id
    const targets = [
      run(dir, ["rev-parse", "HEAD:f.txt"]),
      run(dir, ["rev-parse", "HEAD~1"]),
      run(dir, ["hash-object", "f.txt"]),
    ];
    for (const [k, id] of targets.entries()) {
      const content = collidingBlob(id, 4, `collide${k}`);
      run(dir, ["hash-object", "-w", "--stdin"], content);
    }
    const mismatches: string[] = [];
    for (const abbrev of ["4", "auto"]) {
      run(dir, ["config", "core.abbrev", abbrev]);
      mismatches.push(...(await compareAll(dir, `core.abbrev=${abbrev}`)));
    }
    for (const m of mismatches.slice(0, 3)) console.log(m);
    expect(mismatches).toEqual([]);
    // the index line shows a longer prefix than core.abbrev for the colliding blob
    expect(native(dir, ["-c", "core.abbrev=4", "diff", "HEAD~1", "HEAD"])).toMatch(
      new RegExp(`\\.\\.${targets[0].slice(0, 5)}`),
    );
  }, 120_000);

  it("abbreviates the combined diff of a conflict as git does", async () => {
    const dir = join(tmp(), "conflict");
    mkdirSync(dir, { recursive: true });
    run(dir, ["init", "-q", "-b", "main"]);
    run(dir, ["config", "core.abbrev", "5"]);
    writeFileSync(join(dir, "f.txt"), lines(5, "base"));
    run(dir, ["add", "-A"]);
    run(dir, ["commit", "-q", "-m", "base"]);
    run(dir, ["checkout", "-q", "-b", "side"]);
    writeFileSync(join(dir, "f.txt"), `${lines(2, "base")}side\n`);
    run(dir, ["commit", "-q", "-am", "side"]);
    run(dir, ["checkout", "-q", "main"]);
    writeFileSync(join(dir, "f.txt"), `${lines(2, "base")}main\n`);
    run(dir, ["commit", "-q", "-am", "main"]);
    spawnSync("git", ["merge", "side"], { cwd: dir, env: nativeGitEnv(tmp()) });
    const ours = run(dir, ["rev-parse", ":2:f.txt"]);
    run(dir, ["hash-object", "-w", "--stdin"], collidingBlob(ours, 5, "cc"));
    const theirs = native(dir, ["diff"]);
    expect(theirs).toMatch(/^diff --cc f\.txt$/m);
    expect(await (await open(dir)).diff().callText()).toBe(theirs);
  }, 120_000);
});
