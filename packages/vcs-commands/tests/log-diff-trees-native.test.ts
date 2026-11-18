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

import { Git } from "../src/index.js";
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
