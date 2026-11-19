/**
 * git's "warning: could not open directory '<dir>/': Permission denied" for directories its
 * scan cannot list, in `status`, `add` and `clean`, and `clean`'s "failed to remove". The
 * repository is made by native git; the unreadable directories are simulated by a FilesApi
 * whose listing of them fails with EACCES (the tests may run as root, which reads any
 * directory). The expected lines are native git's (2.43 and 2.56 agree), from a run as an
 * unprivileged user over the same layout with `chmod 000` directories, sorted (git prints
 * them in readdir order).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
} from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { MemoryCheckout, MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type AddCommand, formatStatusPorcelain, Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: nativeGitEnv(root), encoding: "utf8" }).trim();
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const LOCKED = ["t/v", "ign/w", "u/x", "u2"];
const warn = (dir: string) => `warning: could not open directory '${dir}/': Permission denied`;

/** t/a tracked, `ign/` ignored; t/v, ign/w, u/x (each holding a file) and u2 (empty) locked. */
function layout(): string {
  const d = join(root, "r");
  mkdirSync(d, { recursive: true });
  run(d, "init", "-q", "-b", "main");
  put(d, "t/a", "a\n");
  put(d, ".gitignore", "ign/\n");
  run(d, "add", ".");
  run(d, "commit", "-q", "-m", "c1");
  put(d, "t/v/x", "x\n");
  put(d, "ign/w/y", "y\n");
  put(d, "u/x/z", "z\n");
  put(d, "u/f", "f\n");
  mkdirSync(join(d, "u2"));
  return d;
}

/** Our Git over `dir`, the LOCKED directories unreadable. */
async function open(dir: string) {
  const base = createNodeFilesApi({ rootDir: dir });
  const locked = (path: string) => LOCKED.some((l) => path === `/${l}`);
  const denied = (path: string) =>
    Object.assign(new Error(`EACCES: permission denied, scandir '${path}'`), { code: "EACCES" });
  const files = new Proxy(base, {
    get(target, key, receiver) {
      if (key === "withLstatCache") return undefined;
      if (key === "list") {
        return (path: string) => {
          if (locked(path)) throw denied(path);
          return target.list(path);
        };
      }
      if (key === "listKinds") {
        return async (path: string) => {
          if (locked(path)) throw denied(path);
          return target.listKinds?.(path);
        };
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { history } = await createGitFilesBackend({ files });
  const staging = new FileStagingStore(files, ".git/index");
  await staging.read();
  const worktree = createFileWorktree({
    files,
    rootPath: "",
    gitDir: ".git",
    blobs: history.blobs,
    trees: history.trees,
  });
  const wc = new MemoryWorkingCopy({
    history,
    checkout: new MemoryCheckout({ staging }),
    worktree,
  });
  return Git.fromWorkingCopy(wc);
}

describeGit("unreadable directories: git's warnings", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "unreadable-warnings-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("status: one warning per directory the untracked scan opens", async () => {
    const d = layout();
    const git = await open(d);
    // ours reports untracked files as --untracked-files=all
    const all = await git.status().call();
    expect(formatStatusPorcelain(all)).toBe("?? u/f\n");
    expect([...all.warnings].sort()).toEqual([warn("t/v"), warn("u/x"), warn("u2")]);
    const ignored = await (await open(d)).status().setIgnored(true).call();
    expect([...ignored.warnings].sort()).toEqual([
      warn("ign/w"),
      warn("t/v"),
      warn("u/x"),
      warn("u2"),
    ]);
    const some = await (await open(d)).status().addPath("t").call();
    expect(some.warnings).toEqual([warn("t/v")]);
    const none = await (await open(d)).status().setUntracked(false).call();
    expect(none.warnings).toEqual([]);
  });

  it("add: the scan's warnings, the ignored directories only with -f", async () => {
    const d = layout();
    const dry = async (configure: (c: AddCommand) => AddCommand) =>
      configure((await open(d)).add().setDryRun(true)).call();
    const all = await dry((c) => c.setAll(true));
    expect(all.output).toEqual(["add 'u/f'"]);
    expect([...all.warnings].sort()).toEqual([warn("t/v"), warn("u/x"), warn("u2")]);
    expect((await dry((c) => c.addFilepattern("t"))).warnings).toEqual([warn("t/v")]);
    expect((await dry((c) => c.addFilepattern("u"))).warnings).toEqual([warn("u/x")]);
    expect((await dry((c) => c.addFilepattern("ign").setForce(true))).warnings).toEqual([
      warn("ign/w"),
    ]);
    expect([...(await dry((c) => c.addFilepattern("."))).warnings].sort()).toEqual([
      warn("t/v"),
      warn("u/x"),
      warn("u2"),
    ]);
    expect((await dry((c) => c.setUpdate(true))).warnings).toEqual([]);
  });

  it("clean -n: the warnings of the directories git's scan opens, by flag", async () => {
    const d = layout();
    const clean = async (configure: (c: ReturnType<Git["clean"]>) => ReturnType<Git["clean"]>) =>
      configure((await open(d)).clean().setDryRun(true)).call();
    const sorted = (r: { warnings: string[] }) => [...r.warnings].sort();
    const three = [warn("t/v"), warn("u/x"), warn("u2")];
    expect(sorted(await clean((c) => c))).toEqual([]);
    const dRun = await clean((c) => c.setCleanDirectories(true));
    expect(sorted(dRun)).toEqual(three);
    expect([...dRun.cleaned].sort()).toEqual(["t/v/", "u/", "u2/"]);
    expect(sorted(await clean((c) => c.setCleanDirectories(true).setIgnore(false)))).toEqual([
      warn("ign/w"),
      ...three,
    ]);
    expect(sorted(await clean((c) => c.setCleanDirectories(true).setIgnoredOnly(true)))).toEqual(
      three,
    );
    expect(sorted(await clean((c) => c.setIgnoredOnly(true)))).toEqual(three);
    expect(sorted(await clean((c) => c.setIgnore(false)))).toEqual([]);
    expect(sorted(await clean((c) => c.setPaths(new Set(["u"]))))).toEqual([warn("u/x")]);
    expect(
      sorted(await clean((c) => c.setCleanDirectories(true).setPaths(new Set(["t"])))),
    ).toEqual([warn("t/v")]);
  });

  it("clean -fd: an empty unreadable directory goes, the others stay with a warning", async () => {
    const d = layout();
    const result = await (await open(d)).clean().setCleanDirectories(true).setDryRun(false).call();
    expect(result.warnings.slice(0, 3).sort()).toEqual([warn("t/v"), warn("u/x"), warn("u2")]);
    expect(result.warnings.slice(3)).toEqual([
      "warning: failed to remove t/v/: Directory not empty",
      "warning: failed to remove u/x: Directory not empty",
    ]);
    expect([...result.cleaned].sort()).toEqual(["u/f", "u2/"]);
    expect(existsSync(join(d, "u2"))).toBe(false);
    expect(existsSync(join(d, "u/x/z"))).toBe(true);
    expect(existsSync(join(d, "t/v/x"))).toBe(true);
    expect(existsSync(join(d, "u/f"))).toBe(false);
  });
});
