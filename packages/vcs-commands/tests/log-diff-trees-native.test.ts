/**
 * `git log -p --stat` and `git log --name-status` over histories whose trees change shape
 * (a file becoming a directory and back, names that sort around a directory's `/`, modes,
 * symbolic links, non-ASCII names), with packed and loose objects, byte for byte against
 * native git; and the reads `log` makes: each loose fan-out directory listed once for the
 * abbreviated ids, however many ids it abbreviates.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type DiffTextOptions, Git } from "../src/index.js";
import { put } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let clock = 1600000000;

function git(dir: string, args: string[]): Buffer {
  const env = {
    ...nativeGitEnv(root),
    TZ: "UTC",
    GIT_AUTHOR_DATE: `${clock} +0000`,
    GIT_COMMITTER_DATE: `${clock} +0000`,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "maintenance.auto",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "gc.auto",
    GIT_CONFIG_VALUE_1: "0",
  };
  const r = spawnSync("git", args, { cwd: dir, env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout as Buffer;
}

function commit(dir: string, message: string): void {
  clock += 3600;
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", message]);
}

/** Our Git over `dir`, counting the directory listings of the FilesApi by path */
async function openCounting(dir: string): Promise<{ g: Git; lists: Map<string, number> }> {
  const base = createNodeFilesApi({ rootDir: dir });
  const lists = new Map<string, number>();
  const files = new Proxy(base, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "list" && typeof value === "function") {
        return (path: string, ...rest: unknown[]) => {
          lists.set(path, (lists.get(path) ?? 0) + 1);
          return value.call(target, path, ...rest);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { history } = await createGitFilesBackend({ files });
  const io = {
    read: async (path: string) => {
      try {
        return new Uint8Array(readFileSync(join(dir, path)));
      } catch {
        return undefined;
      }
    },
    write: async () => {},
  };
  const config = new GitWorkingCopyConfig(io, ".git/config", {});
  await config.load();
  const staging = new FileStagingStore(files, ".git/index");
  await staging.read();
  const checkout = new GitCheckout({
    staging,
    refs: history.refs,
    files: {
      read: io.read,
      list: (p: string) => files.list(p),
      stats: async (p: string) => {
        const s = await files.stats(p);
        return s ? { isDirectory: s.kind === "directory" } : undefined;
      },
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
  const g = Git.fromWorkingCopy(new MemoryWorkingCopy({ history, checkout, worktree, config }));
  return { g, lists };
}

describeGit("git log over trees that change shape, native", () => {
  let dir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-diff-trees-native-"));
    dir = join(root, "repo");
    git(root, ["init", "-q", "-b", "main", dir]);
    put(dir, "foo", "a file\n");
    put(dir, "foo.c", "int x;\n");
    put(dir, "foo-bar/x", "x\n");
    put(dir, "foo0", "zero\n");
    put(dir, "a/b/c.txt", "one\ntwo\nthree\n");
    put(dir, "é/ü.txt", "unicode\n");
    put(dir, "z", "#!/bin/sh\n");
    commit(dir, "start");
    // a file becomes a directory, a neighbour sorting around its "/" goes, another comes
    rmSync(join(dir, "foo"));
    put(dir, "foo/inner", "inside\n");
    rmSync(join(dir, "foo.c"));
    put(dir, "a/b/c.txt", "one\n2\nthree\n");
    commit(dir, "foo is a directory");
    // everything so far packed, what follows loose
    git(dir, ["repack", "-adq"]);
    // a directory becomes a file, a mode changes, a symbolic link, a rename
    rmSync(join(dir, "a/b"), { recursive: true });
    put(dir, "a/b", "now a file\n");
    git(dir, ["update-index", "--chmod=+x", "z"]);
    symlinkSync("foo/inner", join(dir, "link"));
    git(dir, ["mv", "é/ü.txt", "é/moved.txt"]);
    commit(dir, "shapes");
    put(dir, "foo-bar/x", "x\ny\n");
    put(dir, "foo/inner", "inside\nmore\n");
    put(dir, "foo.c", "int y;\n");
    commit(dir, "back again");
    rmSync(join(dir, "foo"), { recursive: true });
    put(dir, "foo", "a file again\n");
    commit(dir, "foo is a file");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("prints log -p --stat and --name-status as git does", async () => {
    const { g } = await openCounting(dir);
    const native = git(dir, ["log", "--stat", "-p"]);
    const ours = Buffer.from(await g.log().callBytes({ stat: true, patch: true }));
    expect(ours.toString()).toBe(native.toString());
    const { g: g2 } = await openCounting(dir);
    const nativeNames = git(dir, ["log", "--name-status"]);
    const oursNames = Buffer.from(await g2.log().callBytes({ nameStatus: true }));
    expect(oursNames.toString()).toBe(nativeNames.toString());
  });

  it("diffs distant commits as git does", async () => {
    const { g } = await openCounting(dir);
    const native = git(dir, ["diff", "--stat", "-p", "HEAD~4", "HEAD"]);
    const stat = await g.diff().setOldTree("HEAD~4").setNewTree("HEAD").callBytes("stat");
    const { g: g2 } = await openCounting(dir);
    const patch = await g2.diff().setOldTree("HEAD~4").setNewTree("HEAD").callBytes("patch");
    expect(`${Buffer.from(stat)}\n${Buffer.from(patch)}`).toBe(native.toString());
  });

  it("lists each loose fan-out directory once for the abbreviated ids of a log", async () => {
    const { g, lists } = await openCounting(dir);
    await g.log().callBytes({ patch: true, oneline: true });
    const loose = [...lists].filter(([path]) => /objects\/[0-9a-f]{2}$/.test(path));
    expect(loose.length).toBeGreaterThan(0);
    for (const [path, count] of loose) expect([path, count]).toEqual([path, 1]);
  });
});

describeGit("git log --cc and tree modes, native", () => {
  let dir: string;

  /** The diff options of `args` as `setDiffOptions` takes them */
  const diffOptionsOf = (args: string[]): DiffTextOptions => {
    const o: DiffTextOptions = {};
    for (const a of args) {
      if (a === "-w") o.ignoreWhitespace = true;
      else if (a === "-b") o.ignoreWhitespaceChange = true;
      else if (a === "--ignore-space-at-eol") o.ignoreWhitespaceAtEol = true;
      else if (a === "--ignore-cr-at-eol") o.ignoreCrAtEol = true;
      else if (a === "--ignore-blank-lines") o.ignoreBlankLines = true;
      else if (a === "--no-indent-heuristic") o.indentHeuristic = false;
      else if (a.startsWith("--diff-algorithm=")) {
        o.algorithm = a.slice("--diff-algorithm=".length) as DiffTextOptions["algorithm"];
      }
    }
    return o;
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-cc-native-"));
    dir = join(root, "repo");
    git(root, ["init", "-q", "-b", "main", dir]);
    const block = (name: string) => `${name} {\n  one\n  two\n}\n\n`;
    put(dir, "f", "a\nb\nc\nd\ne\n");
    put(dir, "g", `${block("x")}${block("y")}${block("z")}`);
    put(dir, "h", "1\n2\n3\n4\n5\nx\n7\n8\n9\n10\n11\n12\n");
    put(dir, "i", "}\nf {\n    z\nf {\n}\nx\n  x\n");
    put(dir, "other", "o\n");
    commit(dir, "base");
    git(dir, ["checkout", "-q", "-b", "side"]);
    put(dir, "f", "a\nb\nc\nD\ne\n");
    put(dir, "other", "o\nside\n");
    commit(dir, "side");
    git(dir, ["checkout", "-q", "main"]);
    put(dir, "f", "a\nb  \nc\nd\ne\n");
    put(dir, "other", "main\no\n");
    commit(dir, "main");
    git(dir, ["merge", "-q", "--no-commit", "side"]);
    put(dir, "other", "main\no\nside\n");
    // whitespace-only changes against both parents, a CR, a blank line
    put(dir, "f", " a\nb\nc\r\nD\n\ne\n");
    // g, h and i are the same blob in both parents: the merge alone changes them, where the
    // indent heuristic and the slide of an inserted line decide the hunks
    put(dir, "g", `${block("x")}${block("new")}${block("y")}${block("z")}`);
    put(dir, "h", "1\n2\n3\n4\n5\nx\nx\n7\n8\n9\n10\n11\n12\n");
    // the indent heuristic moves this insertion up a line (git diffs with it by default)
    put(dir, "i", "}\nf {\n    z\nf {\nf {\n\nf {\n}\nx\n  x\n");
    commit(dir, "merge");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const CASES: string[][] = [
    ["--cc"],
    ["-c"],
    ["--cc", "-w"],
    ["--cc", "-b"],
    ["--cc", "--ignore-space-at-eol"],
    ["--cc", "--ignore-cr-at-eol"],
    ["--cc", "--ignore-blank-lines"],
    ["-c", "-w"],
    ["--cc", "--no-indent-heuristic"],
    ["--cc", "--diff-algorithm=patience"],
    ["--cc", "--diff-algorithm=histogram"],
  ];
  for (const args of CASES) {
    it(`prints log -p ${args.join(" ")} of a merge as git does`, async () => {
      const { g } = await openCounting(dir);
      const native = git(dir, ["log", "-p", "-1", ...args]);
      const ours = Buffer.from(
        await g
          .log()
          .setMaxCount(1)
          .setDiffOptions(diffOptionsOf(args))
          .callBytes({ patch: true, ...(args[0] === "-c" ? { c: true } : { cc: true }) }),
      );
      expect(ours.toString()).toBe(native.toString());
    });
  }

  it("compares tree entry modes canonically, as git does (100664 is 100644)", async () => {
    // a tree with a 100664 entry (older git wrote group-writable modes): the same blob under
    // 100644 in the next tree is no change to git
    const run = (args: string[], input: string) => {
      const env = { ...nativeGitEnv(root), GIT_AUTHOR_DATE: `${clock} +0000` };
      const r = spawnSync("git", args, {
        cwd: dir,
        input,
        env: { ...env, GIT_COMMITTER_DATE: env.GIT_AUTHOR_DATE },
      });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
      return r.stdout.toString().trim();
    };
    const blob = run(["hash-object", "-w", "--stdin"], "group writable\n");
    const other = run(["hash-object", "-w", "--stdin"], "other\n");
    const t1 = run(["mktree"], `100664 blob ${blob}\tfile\n100664 blob ${other}\tchanged\n`);
    const t2 = run(
      ["mktree"],
      `100644 blob ${blob}\tfile\n100755 blob ${other}\tchanged\n100644 blob ${other}\tnew\n`,
    );
    for (const format of ["name-status", "patch", "stat"] as const) {
      const native = git(dir, ["diff", `--${format === "patch" ? "patch" : format}`, t1, t2]);
      const { g } = await openCounting(dir);
      const ours = await g.diff().setOldTree(t1).setNewTree(t2).callBytes(format);
      expect(Buffer.from(ours).toString()).toBe(native.toString());
    }
    // and a log over commits of those trees
    const c1 = run(["commit-tree", t1, "-m", "664"], "");
    const c2 = run(["commit-tree", t2, "-p", c1, "-m", "644"], "");
    const native = git(dir, ["log", "--stat", "-p", c2]);
    const { g } = await openCounting(dir);
    const ours = await g.log().add(c2).callBytes({ stat: true, patch: true });
    expect(Buffer.from(ours).toString()).toBe(native.toString());
    // limited to the file: the commit that only rewrote its mode to 100644 is TREESAME
    const nativeLimited = git(dir, ["log", "--oneline", c2, "--", "file"]);
    const { g: g2 } = await openCounting(dir);
    const limited = await g2.log().add(c2).addPath("file").callBytes({ oneline: true });
    expect(Buffer.from(limited).toString()).toBe(nativeLimited.toString());
  });
});
