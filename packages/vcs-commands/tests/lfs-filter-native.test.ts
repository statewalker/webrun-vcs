/**
 * Git LFS as a filter driver against native git and git-lfs: the same repository (built
 * twice) is added with `filter=lfs`, by native git running `git-lfs` and by our add with
 * `createLfsFilterDriver` over `.git/lfs/objects`; the pointer blobs and stored objects must
 * match, and a checkout writes the same content back. Skipped where git-lfs is missing.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
import { createFilesLfsStore, createLfsFilterDriver } from "@statewalker/vcs-transport-lfs";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { formatStatusPorcelain, Git, ResetMode } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const hasGitLfs = nativeGitAvailable() && spawnSync("git", ["lfs", "version"]).status === 0;
const describeLfs = hasGitLfs && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(home),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

async function open(dir: string) {
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
  const lfs = createLfsFilterDriver(createFilesLfsStore(files, ".git"));
  const wc = new MemoryWorkingCopy({
    history,
    checkout,
    worktree,
    config,
    filterDrivers: { lfs },
  });
  return Git.fromWorkingCopy(wc);
}

describeLfs("git-lfs as a filter driver against native git-lfs", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lfs-filter-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("stores the same pointers and objects, and checks the content out again", async () => {
    const big = new Uint8Array(70_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7919 + (i >> 5)) & 0xff;
    const dirs = [join(root, "native"), join(root, "ours")];
    for (const dir of dirs) {
      mkdirSync(dir);
      run(dir, "init", "-q", "-b", "main");
      run(dir, "config", "filter.lfs.clean", "git-lfs clean -- %f");
      run(dir, "config", "filter.lfs.smudge", "git-lfs smudge -- %f");
      run(dir, "config", "filter.lfs.required", "true");
      writeFileSync(join(dir, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
      writeFileSync(join(dir, "big.bin"), big);
      writeFileSync(join(dir, "empty.bin"), "");
      writeFileSync(join(dir, "plain.txt"), "not lfs\n");
    }
    const [native, ours] = dirs;
    run(native, "add", ".");
    await (await open(ours)).add().addFilepattern(".").call();
    expect(run(ours, "ls-files", "-s")).toBe(run(native, "ls-files", "-s"));
    const pointer = run(native, "cat-file", "-p", ":big.bin");
    const oid = /oid sha256:([0-9a-f]{64})/.exec(pointer)?.[1] ?? "";
    const object = join(".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
    expect(existsSync(join(native, object))).toBe(true);
    expect(readFileSync(join(ours, object)).equals(readFileSync(join(native, object)))).toBe(true);

    for (const dir of dirs) {
      run(dir, "commit", "-q", "-m", "c1");
      unlinkSync(join(dir, "big.bin"));
    }
    run(native, "reset", "-q", "--hard");
    await (await open(ours)).reset().setMode(ResetMode.HARD).setRef("HEAD").call();
    expect(readFileSync(join(ours, "big.bin")).equals(readFileSync(join(native, "big.bin")))).toBe(
      true,
    );
    expect(formatStatusPorcelain(await (await open(ours)).status().call(), 1)).toBe(
      run(native, "status", "--porcelain=v1", "-uall"),
    );
  });
});
