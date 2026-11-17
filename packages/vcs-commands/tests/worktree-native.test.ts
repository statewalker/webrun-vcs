/**
 * `git worktree` against native git: add, list, prune, lock/unlock, remove, move, repair,
 * and the commands that respect other worktrees (branch -d/-D/-f/-m, checkout).
 *
 * Every repository is built twice by native git with fixed dates (same ids); one twin is
 * changed by native git, the other by our commands, and their admin directories, files,
 * outputs and messages are compared with the twin's directory replaced by `<base>`. The
 * interop tests let each side manage worktrees the other made.
 *
 * Version notes (the sandbox runs git 2.43, CI 2.5x): 2.5x creates an empty `refs/`
 * directory in `.git/worktrees/<id>` (only files are compared); the messages and the list
 * formats compared here are the same in both.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersonIdent } from "@statewalker/vcs-core";
import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
  GitCheckout,
  type GitCheckoutFilesApi,
  GitWorkingCopyFactory,
  openGitLinkedWorktrees,
} from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const IDENT: PersonIdent = {
  name: "Interop Tester",
  email: "interop@example.com",
  timestamp: 1112911993,
  tzOffset: "+0000",
};

let root = "";
let home = "";
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(home),
    encoding: "latin1",
    stdio: ["ignore", "pipe", "pipe"],
  });
const runResult = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, env: nativeGitEnv(home), encoding: "latin1" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/** The repository both twins start from: two commits on main, a branch `feat`. */
function build(base: string): string {
  mkdirSync(base, { recursive: true });
  const repo = join(base, "repo");
  run(base, "init", "-q", "-b", "main", "repo");
  put(repo, "a.txt", "a\n");
  put(repo, "dir/b.txt", "b\n");
  run(repo, "add", ".");
  run(repo, "commit", "-qm", "c1");
  run(repo, "branch", "feat");
  put(repo, "a.txt", "a\nmore\n");
  run(repo, "commit", "-qam", "c2");
  return repo;
}

let counter = 0;
/** The same repository built twice: `native` and `ours` (the bases holding `repo`). */
function twins(): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `t${n}-native`);
  const ours = join(root, `t${n}-ours`);
  build(native);
  build(ours);
  return { native, ours };
}

/** Our working copy of the worktree whose git directory is `gitDir` (relative to `base`). */
async function open(base: string, gitDir = "repo/.git") {
  const files = createNodeFilesApi({ rootDir: base });
  const { history } = await createGitFilesBackend({ files, gitDir: "repo/.git" });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir, history });
  const wc = await worktrees.openCurrent();
  return { git: Git.fromWorkingCopy(wc), wc, worktrees };
}

/** The files under `dir` (recursively, `index` aside) with `base` written `<base>`. */
function snapshot(dir: string, base: string, skip: (path: string) => boolean = () => false) {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    const at = join(dir, rel);
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip(path)) continue;
      if (entry.isDirectory()) walk(path);
      else out[path] = readFileSync(join(dir, path), "latin1").split(base).join("<base>");
    }
  };
  walk("");
  return out;
}

const adminFiles = (base: string) =>
  snapshot(join(base, "repo", ".git", "worktrees"), base, (p) => p.endsWith("/index"));
const workFiles = (base: string, name: string) =>
  snapshot(join(base, name), base, (p) => p === ".git");
const norm = (text: string, base: string) => text.split(base).join("<base>");

/** The native git's version as [major, minor]. */
function gitVersion(): [number, number] {
  const m = /(\d+)\.(\d+)/.exec(run(root, "--version")) ?? ["", "0", "0"];
  return [Number(m[1]), Number(m[2])];
}
/** git before 2.53 prints `worktree list` paths unquoted, one column wider. */
const legacyColumns = () => {
  const [major, minor] = gitVersion();
  return major < 2 || (major === 2 && minor < 53);
};
/** Wording that changed after 2.43, as current git words it. */
const currentWording = (text: string) =>
  text
    .replace("options '--orphan', and '--detach'", "options '--orphan' and '--detach'")
    .replace(
      "'--orphan' and '--no-checkout' cannot",
      "options '--orphan' and '--no-checkout' cannot",
    );

/** The message our command threw, as git prints it (`fatal: ...`). */
async function fatal(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return `fatal: ${(error as Error).message}\n`;
  }
  return "(no error)";
}
/** git's stderr without its progress lines. */
const gitError = (stderr: string) =>
  stderr
    .split("\n")
    .filter((l) => !l.startsWith("Preparing worktree"))
    .join("\n");

describeGit("git worktree, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "wt-native-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("add: branch, detached, -b, -B, --orphan, --no-checkout, --lock, the name from the path", async () => {
    const { native, ours } = twins();
    const { git } = await open(ours);
    const cases: Array<{ args: string[]; ours: (g: Git, at: string) => Promise<unknown> }> = [
      {
        args: ["w-feat", "feat"],
        ours: (g, at) => g.worktreeAdd().setPath(at).setCommitish("feat").setIdent(IDENT).call(),
      },
      {
        args: ["--detach", "w-det"],
        ours: (g, at) => g.worktreeAdd().setPath(at).setDetach(true).setIdent(IDENT).call(),
      },
      {
        args: ["-b", "nb", "w-nb", "feat"],
        ours: (g, at) =>
          g
            .worktreeAdd()
            .setPath(at)
            .setNewBranch("nb")
            .setCommitish("feat")
            .setIdent(IDENT)
            .call(),
      },
      {
        args: ["-B", "feat2", "w-B"],
        ours: (g, at) =>
          g.worktreeAdd().setPath(at).setNewBranch("feat2", true).setIdent(IDENT).call(),
      },
      {
        args: ["--orphan", "w-orph"],
        ours: (g, at) => g.worktreeAdd().setPath(at).setOrphan(true).setIdent(IDENT).call(),
      },
      {
        args: ["--no-checkout", "-b", "nc", "w-nc"],
        ours: (g, at) =>
          g.worktreeAdd().setPath(at).setNewBranch("nc").setCheckout(false).setIdent(IDENT).call(),
      },
      {
        args: ["--lock", "--reason", "on usb", "--detach", "w-lock"],
        ours: (g, at) =>
          g
            .worktreeAdd()
            .setPath(at)
            .setDetach(true)
            .setLock(true)
            .setLockReason("on usb")
            .setIdent(IDENT)
            .call(),
      },
      // no commit-ish: the branch named after the path, created
      { args: ["w-dwim"], ours: (g, at) => g.worktreeAdd().setPath(at).setIdent(IDENT).call() },
      // a name to sanitize, and one taken already (numbered)
      {
        args: ["--detach", "x/a b.lock"],
        ours: (g, at) => g.worktreeAdd().setPath(at).setDetach(true).setIdent(IDENT).call(),
      },
      {
        args: ["--detach", "y/a b"],
        ours: (g, at) => g.worktreeAdd().setPath(at).setDetach(true).setIdent(IDENT).call(),
      },
    ];
    for (const c of cases) {
      const path = c.args[c.args.findIndex((a) => a.startsWith("w-") || a.includes("/"))];
      const r = runResult(
        join(native, "repo"),
        "worktree",
        "add",
        ...c.args.map((a) => (a === path ? join(native, a) : a)),
      );
      expect([c.args, r.status, r.stderr]).toEqual([c.args, 0, r.stderr]);
      const result = (await c.ours(git, join(ours, path))) as {
        messages: string[];
        output: string[];
      };
      // the messages git prints, on stderr and stdout
      const lines = (l: string[]) => l.map((m) => `${m}\n`).join("");
      expect([c.args, norm(lines(result.messages), ours)]).toEqual([
        c.args,
        norm(r.stderr, native),
      ]);
      expect([c.args, norm(lines(result.output), ours)]).toEqual([c.args, norm(r.stdout, native)]);
    }
    expect(adminFiles(ours)).toEqual(adminFiles(native));
    for (const name of ["w-feat", "w-det", "w-nb", "w-B", "w-orph", "w-nc", "w-lock", "w-dwim"]) {
      expect([name, workFiles(ours, name)]).toEqual([name, workFiles(native, name)]);
      // the index: what native git reads in each twin
      expect([
        name,
        run(join(ours, name), "ls-files", "-s", "--debug").replace(
          / {2}(ctime|mtime|dev|uid|size|flags).*\n/g,
          "",
        ),
      ]).toEqual([
        name,
        run(join(native, name), "ls-files", "-s", "--debug").replace(
          / {2}(ctime|mtime|dev|uid|size|flags).*\n/g,
          "",
        ),
      ]);
      expect([name, run(join(ours, name), "status", "--porcelain")]).toEqual([
        name,
        run(join(native, name), "status", "--porcelain"),
      ]);
    }
    expect(snapshot(join(ours, "repo/.git/logs"), ours)).toEqual(
      snapshot(join(native, "repo/.git/logs"), native),
    );
    expect(norm(run(join(ours, "repo"), "worktree", "list", "--porcelain"), ours)).toBe(
      norm(run(join(native, "repo"), "worktree", "list", "--porcelain"), native),
    );
  });

  it("add refuses as git does", async () => {
    const { native, ours } = twins();
    run(join(native, "repo"), "worktree", "add", "-q", join(native, "w1"), "feat");
    const { git } = await open(ours);
    await git.worktreeAdd().setPath(join(ours, "w1")).setCommitish("feat").setQuiet(true).call();
    for (const d of [native, ours]) put(d, "full/x", "x");
    const cases: Array<[string[], (g: Git, b: string) => Promise<unknown>]> = [
      [
        ["w2", "feat"],
        (g, b) => g.worktreeAdd().setPath(join(b, "w2")).setCommitish("feat").call(),
      ],
      [
        ["w2", "main"],
        (g, b) => g.worktreeAdd().setPath(join(b, "w2")).setCommitish("main").call(),
      ],
      [
        ["-B", "feat", "w2"],
        (g, b) => g.worktreeAdd().setPath(join(b, "w2")).setNewBranch("feat", true).call(),
      ],
      [
        ["-b", "feat", "w2"],
        (g, b) => g.worktreeAdd().setPath(join(b, "w2")).setNewBranch("feat").call(),
      ],
      [["full"], (g, b) => g.worktreeAdd().setPath(join(b, "full")).call()],
      [
        ["w3", "nosuch"],
        (g, b) => g.worktreeAdd().setPath(join(b, "w3")).setCommitish("nosuch").call(),
      ],
      [
        ["--orphan", "--detach", "w3"],
        (g, b) => g.worktreeAdd().setPath(join(b, "w3")).setOrphan(true).setDetach(true).call(),
      ],
      [
        ["--reason", "x", "w3"],
        (g, b) => g.worktreeAdd().setPath(join(b, "w3")).setLockReason("x").call(),
      ],
    ];
    for (const [args, ours_] of cases) {
      const absolute = args.map((a) => (/^(w\d|full)$/.test(a) ? join(native, a) : a));
      const r = runResult(join(native, "repo"), "worktree", "add", ...absolute);
      expect(r.status).not.toBe(0);
      const mine = await fatal(() => ours_(git, ours));
      // git branch's own refusal reaches stderr the same way
      expect([args, norm(mine, ours)]).toEqual([
        args,
        currentWording(norm(gitError(r.stderr), native)),
      ]);
    }
    // a missing but registered worktree: refused, then taken over with -f
    for (const d of [native, ours]) rmSync(join(d, "w1"), { recursive: true });
    const r = runResult(join(native, "repo"), "worktree", "add", "--detach", join(native, "w1"));
    const mine = await fatal(() =>
      git.worktreeAdd().setPath(join(ours, "w1")).setDetach(true).call(),
    );
    expect(norm(mine, ours)).toBe(norm(gitError(r.stderr), native));
    run(join(native, "repo"), "worktree", "add", "-q", "-f", "--detach", join(native, "w1"));
    await git
      .worktreeAdd()
      .setPath(join(ours, "w1"))
      .setDetach(true)
      .setForce(true)
      .setIdent(IDENT)
      .call();
    expect(adminFiles(ours)).toEqual(adminFiles(native));
  });

  it("list: default, verbose, porcelain and -z, on worktrees native git made", async () => {
    const base = join(root, "list");
    const repo = build(base);
    for (const n of ["gone", "locked-gone", "detached", "kept"]) {
      run(repo, "worktree", "add", "-q", "--detach", join(base, n));
    }
    run(repo, "worktree", "add", "-q", join(base, "on-feat"), "feat");
    run(repo, "worktree", "add", "-q", "--orphan", join(base, "orph"));
    rmSync(join(base, "gone"), { recursive: true });
    rmSync(join(base, "locked-gone"), { recursive: true });
    run(repo, "worktree", "lock", "--reason", 'two\nlines "q"', join(base, "locked-gone"));
    run(repo, "worktree", "lock", join(base, "kept"));
    writeFileSync(join(repo, ".git/worktrees/afile"), "");
    mkdirSync(join(repo, ".git/worktrees/nogitdir"));
    const { git } = await open(base);
    const nativeOut = (...args: string[]) => run(repo, "worktree", "list", ...args);
    const legacy = legacyColumns();
    expect((await git.worktreeList().setLegacyColumns(legacy).call()).output).toBe(nativeOut());
    expect(
      (await git.worktreeList().setFormat("verbose").setLegacyColumns(legacy).call()).output,
    ).toBe(nativeOut("-v"));
    expect((await git.worktreeList().setFormat("porcelain").call()).output).toBe(
      nativeOut("--porcelain"),
    );
    expect(
      (await git.worktreeList().setFormat("porcelain").setNulTerminated(true).call()).output,
    ).toBe(nativeOut("--porcelain", "-z"));
    // --expire: a gone worktree whose index is newer than the date is not prunable
    const future = Math.floor(Date.now() / 1000) + 3600;
    utimesSync(join(repo, ".git/worktrees/gone/index"), future, future);
    expect(
      (await git.worktreeList().setFormat("porcelain").setExpire("1.day.ago").call()).output,
    ).toBe(nativeOut("--porcelain", "--expire", "1.day.ago"));
    // from a linked worktree: that one is current, the list is the same
    const linked = await open(base, "repo/.git/worktrees/on-feat");
    expect((await linked.git.worktreeList().setLegacyColumns(legacy).call()).output).toBe(
      run(join(base, "on-feat"), "worktree", "list"),
    );
    const listed = (await linked.git.worktreeList().call()).worktrees;
    expect(listed.filter((w) => w.current).map((w) => w.id)).toEqual(["on-feat"]);
    expect(await fatal(() => git.worktreeList().setNulTerminated(true).call())).toBe(
      runResult(repo, "worktree", "list", "-z").stderr,
    );
  });

  it("prune: dry run, verbose, expire, locked kept, duplicates", async () => {
    const { native, ours } = twins();
    for (const base of [native, ours]) {
      const repo = join(base, "repo");
      for (const n of ["gone", "nogitdir", "emptygd", "locked-gone", "fresh", "alive", "dup"]) {
        run(repo, "worktree", "add", "-q", "--detach", join(base, n));
      }
      for (const n of ["gone", "locked-gone", "fresh"]) rmSync(join(base, n), { recursive: true });
      rmSync(join(repo, ".git/worktrees/nogitdir/gitdir"));
      writeFileSync(join(repo, ".git/worktrees/emptygd/gitdir"), "");
      writeFileSync(join(repo, ".git/worktrees/afile"), "");
      run(repo, "worktree", "lock", join(base, "locked-gone"));
      // dup points where alive is
      writeFileSync(join(repo, ".git/worktrees/dup/gitdir"), `${join(base, "alive")}/.git\n`);
      const future = Math.floor(Date.now() / 1000) + 3600;
      utimesSync(join(repo, ".git/worktrees/fresh/index"), future, future);
    }
    const nrepo = join(native, "repo");
    const { git } = await open(ours);
    const sorted = (lines: string) => lines.split("\n").filter(Boolean).sort().join("\n");
    const dry = await git.worktreePrune().setDryRun(true).setExpire("1.hour.ago").call();
    expect(sorted(norm(dry.messages.join("\n"), ours))).toBe(
      sorted(
        norm(runResult(nrepo, "worktree", "prune", "-n", "--expire", "1.hour.ago").stderr, native),
      ),
    );
    expect(adminFiles(ours)).toEqual(adminFiles(native));
    const done = await git.worktreePrune().setVerbose(true).setExpire("1.hour.ago").call();
    expect(sorted(norm(done.messages.join("\n"), ours))).toBe(
      sorted(
        norm(runResult(nrepo, "worktree", "prune", "-v", "--expire", "1.hour.ago").stderr, native),
      ),
    );
    expect(Object.keys(adminFiles(ours)).sort()).toEqual(Object.keys(adminFiles(native)).sort());
    expect(readdirSync(join(ours, "repo/.git/worktrees")).sort()).toEqual(
      readdirSync(join(nrepo, ".git/worktrees")).sort(),
    );
    // without --expire every gone one goes; the empty worktrees directory too
    for (const base of [native, ours]) {
      run(join(base, "repo"), "worktree", "unlock", "locked-gone");
      rmSync(join(base, "alive"), { recursive: true });
    }
    runResult(nrepo, "worktree", "prune");
    await (await open(ours)).git.worktreePrune().call();
    expect(existsSync(join(ours, "repo/.git/worktrees"))).toBe(
      existsSync(join(nrepo, ".git/worktrees")),
    );
  });

  it("lock and unlock: the locked file, and git's refusals", async () => {
    const { native, ours } = twins();
    for (const base of [native, ours]) {
      run(join(base, "repo"), "worktree", "add", "-q", "--detach", join(base, "w1"));
    }
    const nrepo = join(native, "repo");
    const { git } = await open(ours);
    const steps: Array<[string[], () => Promise<unknown>]> = [
      [["lock", "."], () => git.worktreeLock().setWorktree(join(ours, "repo")).call()],
      [
        ["lock", "--reason", "on usb", "w1"],
        () => git.worktreeLock().setWorktree("w1").setReason("on usb").call(),
      ],
      [["lock", "w1"], () => git.worktreeLock().setWorktree("w1").call()],
      [["unlock", "w1"], () => git.worktreeUnlock().setWorktree("w1").call()],
      [["unlock", "w1"], () => git.worktreeUnlock().setWorktree("w1").call()],
      [["lock", "nope"], () => git.worktreeLock().setWorktree("nope").call()],
      [["lock", "w1"], () => git.worktreeLock().setWorktree("w1").call()],
    ];
    for (const [args, mine] of steps) {
      const r = runResult(nrepo, "worktree", ...args);
      const message = await fatal(mine);
      if (r.status === 0) expect([args, message]).toEqual([args, "(no error)"]);
      // "." from the main worktree names it by its path here
      else
        expect([args, message.replace(`'${join(ours, "repo")}'`, "'.'")]).toEqual([args, r.stderr]);
      expect([args, adminFiles(ours)]).toEqual([args, adminFiles(native)]);
    }
  });

  it("remove: dirty, untracked, locked and missing worktrees, with and without force", async () => {
    const { native, ours } = twins();
    for (const base of [native, ours]) {
      const repo = join(base, "repo");
      for (const n of ["dirty", "untracked", "locked", "missing", "clean"]) {
        run(repo, "worktree", "add", "-q", "--detach", join(base, n));
      }
      put(join(base, "dirty"), "a.txt", "changed\n");
      put(join(base, "untracked"), "new.txt", "new\n");
      run(repo, "worktree", "lock", "--reason", "keep me", join(base, "locked"));
      rmSync(join(base, "missing"), { recursive: true });
    }
    const nrepo = join(native, "repo");
    const { git } = await open(ours);
    const steps: Array<[string[], () => Promise<unknown>]> = [
      [["remove", "dirty"], () => git.worktreeRemove().setWorktree("dirty").call()],
      [["remove", "untracked"], () => git.worktreeRemove().setWorktree("untracked").call()],
      [["remove", "locked"], () => git.worktreeRemove().setWorktree("locked").call()],
      [
        ["remove", "-f", "locked"],
        () => git.worktreeRemove().setWorktree("locked").setForce(1).call(),
      ],
      [["remove", "."], () => git.worktreeRemove().setWorktree(join(ours, "repo")).call()],
      [["remove", "missing"], () => git.worktreeRemove().setWorktree("missing").call()],
      [["remove", "clean"], () => git.worktreeRemove().setWorktree("clean").call()],
      [
        ["remove", "-f", "dirty"],
        () => git.worktreeRemove().setWorktree("dirty").setForce(true).call(),
      ],
      [
        ["remove", "--force", "--force", "locked"],
        () => git.worktreeRemove().setWorktree("locked").setForce(2).call(),
      ],
    ];
    for (const [args, mine] of steps) {
      const r = runResult(nrepo, "worktree", ...args);
      const message = await fatal(mine);
      if (r.status === 0) expect([args, message]).toEqual([args, "(no error)"]);
      else
        expect([args, message.replace(`'${join(ours, "repo")}'`, "'.'")]).toEqual([args, r.stderr]);
      expect([args, adminFiles(ours)]).toEqual([args, adminFiles(native)]);
      for (const n of ["dirty", "untracked", "locked", "clean"]) {
        expect([args, n, existsSync(join(ours, n))]).toEqual([
          args,
          n,
          existsSync(join(native, n)),
        ]);
      }
    }
    expect(norm(run(join(ours, "repo"), "worktree", "list", "--porcelain"), ours)).toBe(
      norm(run(nrepo, "worktree", "list", "--porcelain"), native),
    );
  });

  it("move: into a directory, to a new path, and git's refusals", async () => {
    const { native, ours } = twins();
    for (const base of [native, ours]) {
      const repo = join(base, "repo");
      run(repo, "worktree", "add", "-q", join(base, "w1"), "feat");
      run(repo, "worktree", "add", "-q", "--lock", "--detach", join(base, "w2"));
      mkdirSync(join(base, "into"));
      put(base, "occupied/x", "x");
    }
    const nrepo = join(native, "repo");
    const { git } = await open(ours);
    const steps: Array<[string[], (b: string) => string[], () => Promise<unknown>]> = [
      [
        ["move", "w2", "<b>/w9"],
        (b) => [join(b, "w9")],
        () => git.worktreeMove().setWorktree("w2").setDestination(join(ours, "w9")).call(),
      ],
      [
        ["move", ".", "<b>/w9"],
        (b) => [join(b, "w9")],
        () =>
          git
            .worktreeMove()
            .setWorktree(join(ours, "repo"))
            .setDestination(join(ours, "w9"))
            .call(),
      ],
      [
        ["move", "w1", "<b>/occupied"],
        (b) => [join(b, "occupied", "w1")],
        () => git.worktreeMove().setWorktree("w1").setDestination(join(ours, "occupied")).call(),
      ],
      [
        ["move", "w1", "<b>/into"],
        (b) => [join(b, "into")],
        () => git.worktreeMove().setWorktree("w1").setDestination(join(ours, "into")).call(),
      ],
      [
        ["move", "-f", "-f", "w2", "<b>/moved"],
        (b) => [join(b, "moved")],
        () =>
          git
            .worktreeMove()
            .setWorktree("w2")
            .setDestination(join(ours, "moved"))
            .setForce(2)
            .call(),
      ],
    ];
    for (const [args, dest, mine] of steps) {
      const nativeArgs = [...args.slice(0, -1).map((a) => (a === "." ? "." : a)), ...dest(native)];
      const r = runResult(nrepo, "worktree", ...nativeArgs);
      const message = await fatal(mine);
      if (r.status === 0) expect([args, message]).toEqual([args, "(no error)"]);
      else {
        expect([args, norm(message.replace(`'${join(ours, "repo")}'`, "'.'"), ours)]).toEqual([
          args,
          norm(r.stderr.replace("occupied/w1", "occupied"), native),
        ]);
      }
      expect([args, adminFiles(ours)]).toEqual([args, adminFiles(native)]);
    }
    expect(norm(run(join(ours, "repo"), "worktree", "list", "--porcelain"), ours)).toBe(
      norm(run(nrepo, "worktree", "list", "--porcelain"), native),
    );
    expect(run(join(ours, "into/w1"), "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feat");
    expect(run(join(ours, "into/w1"), "status", "--porcelain")).toBe("");
  });

  it("repair: a moved worktree's gitdir, a broken .git file", async () => {
    const { native, ours } = twins();
    for (const base of [native, ours]) {
      const repo = join(base, "repo");
      run(repo, "worktree", "add", "-q", "--detach", join(base, "w1"));
      run(repo, "worktree", "add", "-q", "--detach", join(base, "w2"));
      // w1 moved by hand; w2's .git file damaged
      execFileSync("mv", [join(base, "w1"), join(base, "w1-moved")]);
      writeFileSync(join(base, "w2", ".git"), "gitdir: /nowhere\n");
    }
    const r = runResult(join(native, "repo"), "worktree", "repair", join(native, "w1-moved"));
    const { git } = await open(ours);
    const mine = await git.worktreeRepair().addPath(join(ours, "w1-moved")).call();
    expect(norm(mine.messages.map((m) => `${m}\n`).join(""), ours)).toBe(norm(r.stderr, native));
    expect(mine.ok).toBe(r.status === 0);
    expect(adminFiles(ours)).toEqual(adminFiles(native));
    expect(norm(readFileSync(join(ours, "w2/.git"), "latin1"), ours)).toBe(
      norm(readFileSync(join(native, "w2/.git"), "latin1"), native),
    );
    expect(run(join(ours, "w1-moved"), "status", "--porcelain")).toBe("");
  });

  it("branch -d/-D/-f/-m and checkout respect other worktrees", async () => {
    const { native, ours } = twins();
    for (const base of [native, ours]) {
      run(join(base, "repo"), "worktree", "add", "-q", join(base, "w1"), "feat");
    }
    const nrepo = join(native, "repo");
    const { git } = await open(ours);
    const error = async (action: () => Promise<unknown>, prefix: string) => {
      try {
        await action();
      } catch (e) {
        return `${prefix}: ${(e as Error).message}\n`;
      }
      return "(no error)";
    };
    expect(
      norm(await error(() => git.branchDelete().setBranchNames("feat").call(), "error"), ours),
    ).toBe(norm(runResult(nrepo, "branch", "-d", "feat").stderr, native));
    expect(
      norm(
        await error(() => git.branchDelete().setBranchNames("feat").setForce(true).call(), "error"),
        ours,
      ),
    ).toBe(norm(runResult(nrepo, "branch", "-D", "feat").stderr, native));
    expect(
      norm(await error(() => git.branchDelete().setBranchNames("main").call(), "error"), ours),
    ).toBe(norm(runResult(nrepo, "branch", "-d", "main").stderr, native));
    expect(
      norm(
        await error(() => git.branchCreate().setName("feat").setForce(true).call(), "fatal"),
        ours,
      ),
    ).toBe(norm(runResult(nrepo, "branch", "-f", "feat", "HEAD").stderr, native));
    expect(norm(await error(() => git.checkout().setName("feat").call(), "fatal"), ours)).toBe(
      norm(runResult(nrepo, "checkout", "feat").stderr, native),
    );
    // from the linked worktree: main is the main worktree's
    const linked = await open(ours, "repo/.git/worktrees/w1");
    expect(
      norm(await error(() => linked.git.checkout().setName("main").call(), "fatal"), ours),
    ).toBe(norm(runResult(join(native, "w1"), "checkout", "main").stderr, native));
    // --ignore-other-worktrees switches anyway; the linked worktree's HEAD only
    run(join(native, "w1"), "checkout", "-q", "--ignore-other-worktrees", "main");
    await (await open(ours, "repo/.git/worktrees/w1")).git
      .checkout()
      .setName("main")
      .setIgnoreOtherWorktrees(true)
      .call();
    expect(readFileSync(join(ours, "repo/.git/worktrees/w1/HEAD"), "latin1")).toBe(
      "ref: refs/heads/main\n",
    );
    expect(readFileSync(join(ours, "repo/.git/HEAD"), "latin1")).toBe("ref: refs/heads/main\n");
    run(join(native, "w1"), "checkout", "-q", "feat");
    await (await open(ours, "repo/.git/worktrees/w1")).git.checkout().setName("feat").call();
    // a rename updates the other worktree's HEAD
    run(nrepo, "branch", "-m", "feat", "renamed");
    await (await open(ours)).git.branchRename().setOldName("feat").setNewName("renamed").call();
    expect(readFileSync(join(ours, "repo/.git/worktrees/w1/HEAD"), "latin1")).toBe(
      readFileSync(join(nrepo, ".git/worktrees/w1/HEAD"), "latin1"),
    );
    expect(run(join(ours, "w1"), "status", "--porcelain")).toBe("");
  });

  it("interop: native git manages our worktrees, we manage git's", async () => {
    const base = join(root, "interop");
    const repo = build(base);
    const { git } = await open(base);
    // ours, then native git uses, locks, lists and removes it
    await git
      .worktreeAdd()
      .setPath(join(base, "ours-wt"))
      .setNewBranch("ob")
      .setIdent(IDENT)
      .call();
    expect(run(join(base, "ours-wt"), "status", "--porcelain")).toBe("");
    put(join(base, "ours-wt"), "n.txt", "n\n");
    run(join(base, "ours-wt"), "add", "n.txt");
    run(join(base, "ours-wt"), "commit", "-qm", "on ob");
    run(repo, "worktree", "lock", "--reason", "native", join(base, "ours-wt"));
    expect(run(repo, "worktree", "list", "--porcelain")).toContain("locked native\n");
    run(repo, "worktree", "unlock", join(base, "ours-wt"));
    run(repo, "worktree", "remove", join(base, "ours-wt"));
    expect(existsSync(join(base, "ours-wt"))).toBe(false);
    expect(existsSync(join(repo, ".git/worktrees"))).toBe(false);

    // git's, then ours: status in it, lock, move, remove
    run(repo, "worktree", "add", "-q", join(base, "git-wt"), "feat");
    const theirs = await open(base, "repo/.git/worktrees/git-wt");
    expect((await theirs.git.status().call()).isClean()).toBe(true);
    expect(await theirs.wc.getCurrentBranch()).toBe("feat");
    await git.worktreeLock().setWorktree("git-wt").call();
    expect(statSync(join(repo, ".git/worktrees/git-wt/locked")).size).toBe(0);
    await git.worktreeUnlock().setWorktree("git-wt").call();
    await git.worktreeMove().setWorktree("git-wt").setDestination(join(base, "git-wt2")).call();
    expect(run(join(base, "git-wt2"), "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feat");
    expect(run(repo, "worktree", "list", "--porcelain")).toContain(
      `worktree ${join(base, "git-wt2")}\n`,
    );
    await git.worktreeRemove().setWorktree("git-wt2").call();
    expect(existsSync(join(base, "git-wt2"))).toBe(false);
    expect(run(repo, "worktree", "list", "--porcelain").split("worktree ").length).toBe(2);
    // gc keeps what only another worktree's HEAD reaches, and prunes the gone ones
    run(repo, "worktree", "add", "-q", "--detach", join(base, "gone"));
    rmSync(join(base, "gone"), { recursive: true });
    const gc = await (await open(base)).git.gc().setPackRefs(false).call();
    expect(gc.worktreesPruned).toEqual([]); // the index is newer than 3 months
    run(repo, "config", "gc.worktreePruneExpire", "now");
    const gc2 = await (await open(base)).git.gc().setPackRefs(false).call();
    expect(gc2.worktreesPruned).toEqual(["gone"]);
  });

  it("our worktree's own HEAD, reflog and pseudo refs live in its admin directory", async () => {
    const base = join(root, "own-refs");
    const repo = build(base);
    const { git } = await open(base);
    await git.worktreeAdd().setPath(join(base, "wt")).setNewBranch("wb").setIdent(IDENT).call();
    const wt = await open(base, "repo/.git/worktrees/wt");
    put(join(base, "wt"), "w.txt", "w\n");
    await wt.git.add().addFilepattern("w.txt").call();
    await wt.git.commit().setMessage("in wt").setAuthorIdent(IDENT).setCommitterIdent(IDENT).call();
    // the branch moved, main's HEAD did not
    expect(run(repo, "rev-parse", "wb").trim()).toBe(
      run(join(base, "wt"), "rev-parse", "HEAD").trim(),
    );
    expect(run(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(readFileSync(join(repo, ".git/HEAD"), "latin1")).toBe("ref: refs/heads/main\n");
    expect(run(join(base, "wt"), "status", "--porcelain")).toBe("");
    // the commit is logged in the worktree's HEAD reflog, not the main one
    const wtLog = readFileSync(join(repo, ".git/worktrees/wt/logs/HEAD"), "latin1")
      .trim()
      .split("\n");
    expect(wtLog.length).toBe(3);
    expect(readFileSync(join(repo, ".git/logs/HEAD"), "latin1").trim().split("\n").length).toBe(2);
  });
});

/** A reflog's lines without their identity: `<old> <new>\t<message>`. */
function reflog(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "latin1")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const tab = l.indexOf("\t");
      return `${l.slice(0, 81)}${tab < 0 ? "" : l.slice(tab)}`;
    });
}
/** A reflog's ids only (`<old> <new>`): for lines whose messages name different arguments. */
const reflogIds = (path: string) => reflog(path).map((l) => l.slice(0, 81));

describeGit("git worktree: storage roots, bare repositories, renames and HEAD reflogs", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "wt-native2-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("a FilesApi rooted at / maps linked worktrees: list, prune and openCurrent", async () => {
    const base = join(root, "slash");
    const repo = build(base);
    run(repo, "worktree", "add", "-q", join(base, "wt"), "feat");
    const files = createNodeFilesApi({ rootDir: "/" });
    const gitDir = `${repo.slice(1)}/.git`;
    const { history } = await createGitFilesBackend({ files, gitDir });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir, history });
    expect((await worktrees.list()).map((wt) => wt.path)).toEqual([repo, join(base, "wt")]);
    const wc = await worktrees.openCurrent();
    const prune = await Git.fromWorkingCopy(wc).worktreePrune().setDryRun(true).call();
    expect(prune.messages.join("")).toBe(runResult(repo, "worktree", "prune", "-n").stderr);
    expect(prune.pruned).toEqual([]);
    const linked = await openGitLinkedWorktrees({
      files,
      gitDir: `${gitDir}/worktrees/wt`,
      history,
    });
    const lwc = await linked.openCurrent();
    expect(await lwc.getCurrentBranch()).toBe("feat");
    expect((await Git.fromWorkingCopy(lwc).status().call()).isClean()).toBe(true);
    await Git.fromWorkingCopy(wc).worktreePrune().call();
    expect(existsSync(join(repo, ".git/worktrees/wt"))).toBe(true);
  });

  it("worktrees beyond the root (elsewhere, or through a symbolic link) are kept and refused", async () => {
    // the FilesApi's root is reached through a symbolic link: git writes the real path
    const real = join(root, "real");
    mkdirSync(real);
    const link = join(root, "link");
    symlinkSync(real, link);
    const repo = build(join(link, "b"));
    run(repo, "worktree", "add", "-q", join(link, "b", "wt"), "feat");
    expect(readFileSync(join(repo, ".git/worktrees/wt/gitdir"), "latin1")).toBe(
      `${join(real, "b", "wt", ".git")}\n`,
    );
    // and one outside the root
    const outside = join(root, "outside");
    run(repo, "worktree", "add", "-q", "--detach", join(outside, "out"));
    const files = createNodeFilesApi({ rootDir: join(link, "b") });
    const { history } = await createGitFilesBackend({ files, gitDir: "repo/.git" });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir: "repo/.git", history });
    const git = Git.fromWorkingCopy(await worktrees.openCurrent());
    // native git keeps both
    expect(runResult(repo, "worktree", "prune", "-n", "-v").stderr).toBe("");
    const dry = await git.worktreePrune().setDryRun(true).setVerbose(true).call();
    expect(dry.messages).toEqual([]);
    await git.worktreePrune().call();
    run(repo, "config", "gc.worktreePruneExpire", "now");
    const gc = await Git.fromWorkingCopy(
      await (await openGitLinkedWorktrees({ files, gitDir: "repo/.git", history })).openCurrent(),
    )
      .gc()
      .setPackRefs(false)
      .call();
    expect(gc.worktreesPruned).toEqual([]);
    expect(readdirSync(join(repo, ".git/worktrees")).sort()).toEqual(["out", "wt"]);
    // remove and move refuse what they cannot check
    for (const [name, path] of [
      ["wt", join(real, "b", "wt")],
      ["out", join(outside, "out")],
    ]) {
      put(path, "dirty.txt", "untracked\n");
      expect(await fatal(() => git.worktreeRemove().setWorktree(name).setForce(2).call())).toBe(
        `fatal: cannot remove '${path}': it is beyond this storage\n`,
      );
      expect(
        await fatal(() =>
          git
            .worktreeMove()
            .setWorktree(name)
            .setDestination(join(link, "b", "moved"))
            .call(),
        ),
      ).toBe(`fatal: cannot move '${path}': it is beyond this storage\n`);
    }
    expect(readdirSync(join(repo, ".git/worktrees")).sort()).toEqual(["out", "wt"]);
    expect(existsSync(join(outside, "out", "dirty.txt"))).toBe(true);
  });

  it("a bare repository: no working copy of its own; its linked worktrees log as git does", async () => {
    const { native, ours } = twins();
    for (const base of [native, ours]) {
      run(base, "clone", "-q", "--bare", "repo", "bare.git");
      run(join(base, "bare.git"), "worktree", "add", "-q", join(base, "bwt"), "main");
    }
    // git status in a bare repository: no work tree
    const files = createNodeFilesApi({ rootDir: ours });
    const { history } = await createGitFilesBackend({ files, gitDir: "bare.git" });
    const bare = await openGitLinkedWorktrees({ files, gitDir: "bare.git", history });
    expect(await fatal(() => bare.openCurrent())).toBe(
      runResult(join(native, "bare.git"), "status").stderr,
    );
    // a commit in the linked worktree logs its HEAD and the branch (logAllRefUpdates default)
    put(join(native, "bwt"), "n.txt", "n\n");
    run(join(native, "bwt"), "add", "n.txt");
    run(join(native, "bwt"), "commit", "-qm", "in bwt");
    put(join(ours, "bwt"), "n.txt", "n\n");
    const linked = await openGitLinkedWorktrees({
      files,
      gitDir: "bare.git/worktrees/bwt",
      history,
    });
    const git = Git.fromWorkingCopy(await linked.openCurrent());
    await git.add().addFilepattern("n.txt").call();
    await git.commit().setMessage("in bwt\n").setAuthorIdent(IDENT).setCommitterIdent(IDENT).call();
    expect(run(join(ours, "bwt"), "rev-parse", "HEAD")).toBe(
      run(join(native, "bwt"), "rev-parse", "HEAD"),
    );
    for (const log of ["worktrees/bwt/logs/HEAD", "logs/refs/heads/main", "logs/HEAD"]) {
      expect([log, reflog(join(ours, "bare.git", log))]).toEqual([
        log,
        reflog(join(native, "bare.git", log)),
      ]);
    }
    expect(reflog(join(ours, "bare.git/logs/refs/heads/main")).length).toBe(1);
  });

  it("openCurrent of a linked worktree whose gitdir file is empty: refused unless named", async () => {
    const base = join(root, "unlisted");
    const repo = build(base);
    run(repo, "worktree", "add", "-q", join(base, "wt"), "feat");
    writeFileSync(join(repo, ".git/worktrees/wt/gitdir"), "");
    const files = createNodeFilesApi({ rootDir: base });
    const { history } = await createGitFilesBackend({ files, gitDir: "repo/.git" });
    const gitDir = "repo/.git/worktrees/wt";
    const refused = await openGitLinkedWorktrees({ files, gitDir, history });
    await expect(refused.openCurrent()).rejects.toThrow("gitdir file is missing or empty");
    // as git, from the directory holding the .git file
    const named = await openGitLinkedWorktrees({ files, gitDir, history, workTree: "wt" });
    const git = Git.fromWorkingCopy(await named.openCurrent());
    const status = await git.status().call();
    expect(status.isClean()).toBe(true);
    expect(await (await named.openCurrent()).getCurrentBranch()).toBe("feat");
    expect(run(join(base, "wt"), "status", "--porcelain")).toBe("");
  });

  it("branch -m refuses a branch being rebased or bisected elsewhere, and logs the rename", async () => {
    // rebasing: feat's own commit conflicts with main's
    const rb = twins();
    for (const base of [rb.native, rb.ours]) {
      run(join(base, "repo"), "worktree", "add", "-q", join(base, "w1"), "feat");
      put(join(base, "w1"), "a.txt", "feat\n");
      run(join(base, "w1"), "commit", "-qam", "on feat");
      runResult(join(base, "w1"), "rebase", "main"); // stops on the conflict, HEAD detached
    }
    const native = runResult(join(rb.native, "repo"), "branch", "-m", "feat", "f2");
    const mine = await fatal(async () =>
      (await open(rb.ours)).git.branchRename().setOldName("feat").setNewName("f2").call(),
    );
    expect(norm(mine, rb.ours)).toBe(norm(native.stderr, rb.native));
    expect(run(join(rb.ours, "repo"), "branch", "--list", "feat").trim()).toBe("feat");

    // bisecting: HEAD detached at the midpoint, BISECT_START names feat
    const bs = twins();
    for (const base of [bs.native, bs.ours]) {
      run(join(base, "repo"), "worktree", "add", "-q", join(base, "w1"), "feat");
      for (const n of ["1", "2"]) {
        put(join(base, "w1"), `f${n}.txt`, `${n}\n`);
        run(join(base, "w1"), "add", ".");
        run(join(base, "w1"), "commit", "-qm", `f${n}`);
      }
      run(join(base, "w1"), "bisect", "start", "feat", "feat~2");
    }
    const nb = runResult(join(bs.native, "repo"), "branch", "-m", "feat", "f2");
    const mb = await fatal(async () =>
      (await open(bs.ours)).git.branchRename().setOldName("feat").setNewName("f2").call(),
    );
    expect(norm(mb, bs.ours)).toBe(norm(nb.stderr, bs.native));

    // the rename: the other worktree's HEAD follows, with git's line in its reflog
    const rn = twins();
    for (const base of [rn.native, rn.ours]) {
      run(join(base, "repo"), "worktree", "add", "-q", join(base, "w1"), "feat");
    }
    run(join(rn.native, "repo"), "branch", "-m", "feat", "renamed");
    await (await open(rn.ours)).git.branchRename().setOldName("feat").setNewName("renamed").call();
    const log = "repo/.git/worktrees/w1/logs/HEAD";
    expect(reflog(join(rn.ours, log))).toEqual(reflog(join(rn.native, log)));
    expect(readFileSync(join(rn.ours, "repo/.git/worktrees/w1/HEAD"), "latin1")).toBe(
      "ref: refs/heads/renamed\n",
    );
  });

  it("checkout --detach and a rebase's start in a linked worktree log HEAD's old id", async () => {
    const { native, ours } = twins();
    for (const base of [native, ours]) {
      run(join(base, "repo"), "worktree", "add", "-q", join(base, "w1"), "feat");
      put(join(base, "w1"), "a.txt", "feat\n");
      run(join(base, "w1"), "commit", "-qam", "on feat");
    }
    const log = "repo/.git/worktrees/w1/logs/HEAD";
    const feat = run(join(native, "w1"), "rev-parse", "HEAD").trim();
    run(join(native, "w1"), "checkout", "-q", "--detach");
    let wt = await open(ours, "repo/.git/worktrees/w1");
    await wt.git.checkout().setName(feat).call();
    expect(reflogIds(join(ours, log))).toEqual(reflogIds(join(native, log)));
    expect(reflogIds(join(ours, log)).at(-1)).toBe(`${feat} ${feat}`);

    // (native `checkout --detach` logs "moving from feat to HEAD", ours names the id: the
    // ids are compared) back on feat, then a rebase onto main stops on the conflict: its
    // start logs feat's id to main's
    run(join(native, "w1"), "checkout", "-q", "feat");
    await wt.git.checkout().setName("feat").call();
    runResult(join(native, "w1"), "rebase", "main");
    wt = await open(ours, "repo/.git/worktrees/w1");
    await (await wt.git.rebase().setUpstreamBranch("main")).call();
    const main = run(join(native, "repo"), "rev-parse", "main").trim();
    expect(reflogIds(join(ours, log)).at(-1)).toBe(`${feat} ${main}`);
    expect(reflog(join(ours, log)).slice(-2)).toEqual(reflog(join(native, log)).slice(-2));
    expect(
      reflog(join(ours, log))
        .slice(-2)
        .map((l) => l.slice(82)),
    ).toEqual([
      "checkout: moving from <id> to feat".replace("<id>", feat),
      "rebase (start): checkout main",
    ]);
    expect(readFileSync(join(ours, "repo/.git/HEAD"), "latin1")).toBe("ref: refs/heads/main\n");
  });

  it("checkout -B refuses a branch another worktree uses, unless told to ignore it", async () => {
    const base = join(root, "checkout-B");
    const repo = build(base);
    run(repo, "worktree", "add", "-q", join(base, "w1"), "feat");
    const { git } = await open(base);
    // git 2.44 and later: 'feat' is already used by worktree at '<path>'
    expect(await fatal(() => git.checkout().setName("feat").setCreateBranch(true).call())).toBe(
      `fatal: 'feat' is already used by worktree at '${join(base, "w1")}'\n`,
    );
    expect(run(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    await (await open(base)).git
      .checkout()
      .setName("feat")
      .setCreateBranch(true)
      .setIgnoreOtherWorktrees(true)
      .call();
    expect(run(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feat");
  });

  it("the factory's addWorktree: the worktree's own working copy, logAllRefUpdates respected", async () => {
    const base = join(root, "factory");
    const repo = build(base);
    const files = createNodeFilesApi({ rootDir: base });
    const { history } = await createGitFilesBackend({ files, gitDir: "repo/.git" });
    const at = (p: string) => join(base, p);
    const factoryFiles = {
      rootDirectory: base,
      read: async (p: string) =>
        existsSync(at(p)) ? new Uint8Array(readFileSync(at(p))) : undefined,
      write: async (p: string, content: Uint8Array) => {
        mkdirSync(join(at(p), ".."), { recursive: true });
        writeFileSync(at(p), content);
      },
      exists: async (p: string) => existsSync(at(p)),
      stats: async (p: string) =>
        existsSync(at(p)) ? { isDirectory: statSync(at(p)).isDirectory() } : undefined,
      mkdir: async (p: string) => {
        mkdirSync(at(p), { recursive: true });
      },
      writeFile: async (p: string, content: string) => writeFileSync(at(p), content),
      remove: async (p: string) => {
        rmSync(at(p), { recursive: true, force: true });
        return true;
      },
    };
    const factory = new GitWorkingCopyFactory(factoryFiles, async () => ({
      history,
      files,
      createCheckout: async (gitDir: string) => {
        const staging = new FileStagingStore(files, `${gitDir}/index`);
        await staging.read();
        return new GitCheckout({
          staging,
          refs: history.refs,
          files: factoryFiles as unknown as GitCheckoutFilesApi,
          gitDir,
        });
      },
      createWorktree: (path: string) =>
        createFileWorktree({
          files,
          rootPath: path,
          gitDir: "repo/.git",
          blobs: history.blobs,
          trees: history.trees,
        }),
    }));
    const main = run(repo, "rev-parse", "main").trim();
    const wc = await factory.addWorktree(history, "repo/.git", "wt", { branch: "feat" });
    expect(wc.worktrees).toBeDefined();
    expect(await wc.getCurrentBranch()).toBe("feat");
    const git = Git.fromWorkingCopy(wc);
    put(at("wt"), "n.txt", "n\n");
    await git.add().addFilepattern("n.txt").call();
    await git.commit().setMessage("in wt").setAuthorIdent(IDENT).setCommitterIdent(IDENT).call();
    // only the worktree's branch and HEAD moved
    expect(run(repo, "rev-parse", "main").trim()).toBe(main);
    expect(readFileSync(join(repo, ".git/HEAD"), "latin1")).toBe("ref: refs/heads/main\n");
    expect(readFileSync(join(repo, ".git/worktrees/wt/HEAD"), "latin1")).toBe(
      "ref: refs/heads/feat\n",
    );
    expect(run(at("wt"), "rev-parse", "HEAD").trim()).toBe(run(repo, "rev-parse", "feat").trim());
    expect(reflog(join(repo, ".git/worktrees/wt/logs/HEAD")).length).toBe(2);
    expect(
      (await (await factory.openWorkingCopy("repo", "repo/.git")).worktrees?.list())?.length,
    ).toBe(2);
    // core.logAllRefUpdates=false: no HEAD reflog for a new worktree
    run(repo, "config", "core.logAllRefUpdates", "false");
    await factory.addWorktree(history, "repo/.git", "wt2", { branch: "main" });
    expect(existsSync(join(repo, ".git/worktrees/wt2/logs/HEAD"))).toBe(false);
  });
});

describeGit("git worktree from inside a bare repository, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "wt-bare-native-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** Our Git for `git worktree` in the bare repository `base/bare.git`. */
  async function openBare(base: string) {
    const files = createNodeFilesApi({ rootDir: base });
    const { history } = await createGitFilesBackend({ files, gitDir: "bare.git" });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir: "bare.git", history });
    return Git.fromWorktreeAdmin(await worktrees.openAdmin());
  }
  /** The bare repository's administrative files, `base` written `<base>`. */
  const bareAdmin = (base: string) =>
    snapshot(join(base, "bare.git", "worktrees"), base, (p) => p.endsWith("/index"));

  it("clone --bare, then add, list, lock, prune, unlock and remove as native git does there", async () => {
    const { native, ours } = twins();
    for (const base of [native, ours]) run(base, "clone", "-q", "--bare", "repo", "bare.git");
    const nb = join(native, "bare.git");
    const git = await openBare(ours);
    const compare = (label: string) => {
      expect([label, bareAdmin(ours)]).toEqual([label, bareAdmin(native)]);
      for (const name of ["w1", "w2", "w3"]) {
        expect([label, name, workFiles(ours, name)]).toEqual([
          label,
          name,
          workFiles(native, name),
        ]);
      }
      expect([label, existsSync(join(ours, "bare.git/logs"))]).toEqual([
        label,
        existsSync(join(nb, "logs")),
      ]);
    };

    // add: a branch, a new branch, a detached HEAD
    run(nb, "worktree", "add", "-q", join(native, "w1"), "feat");
    run(nb, "worktree", "add", "-q", "-b", "topic", join(native, "w2"), "main");
    run(nb, "worktree", "add", "-q", "--detach", join(native, "w3"), "main");
    await git.worktreeAdd().setPath(join(ours, "w1")).setCommitish("feat").setIdent(IDENT).call();
    await git
      .worktreeAdd()
      .setPath(join(ours, "w2"))
      .setNewBranch("topic")
      .setCommitish("main")
      .setIdent(IDENT)
      .call();
    await git
      .worktreeAdd()
      .setPath(join(ours, "w3"))
      .setDetach(true)
      .setCommitish("main")
      .setIdent(IDENT)
      .call();
    compare("add");
    expect(run(join(ours, "w2"), "rev-parse", "topic")).toBe(
      run(join(native, "w2"), "rev-parse", "topic"),
    );

    // list: the bare main worktree first, `(bare)`, in each format
    const legacy = legacyColumns();
    const nativeList = (...args: string[]) => norm(run(nb, "worktree", "list", ...args), native);
    const ourList = (out: string) => norm(out, ours);
    expect(ourList((await git.worktreeList().setLegacyColumns(legacy).call()).output)).toBe(
      nativeList(),
    );
    expect(
      ourList(
        (await git.worktreeList().setFormat("verbose").setLegacyColumns(legacy).call()).output,
      ),
    ).toBe(nativeList("-v"));
    expect(ourList((await git.worktreeList().setFormat("porcelain").call()).output)).toBe(
      nativeList("--porcelain"),
    );
    expect(nativeList()).toContain("(bare)");

    // lock with a reason; a gone worktree pruned, the locked one kept
    run(nb, "worktree", "lock", "--reason", "on a stick", join(native, "w1"));
    await git.worktreeLock().setWorktree(join(ours, "w1")).setReason("on a stick").call();
    compare("lock");
    for (const base of [native, ours]) rmSync(join(base, "w3"), { recursive: true });
    run(nb, "worktree", "prune");
    await git.worktreePrune().call();
    compare("prune");

    // unlock, then remove
    run(nb, "worktree", "unlock", join(native, "w1"));
    await git.worktreeUnlock().setWorktree(join(ours, "w1")).call();
    run(nb, "worktree", "remove", join(native, "w2"));
    await git.worktreeRemove().setWorktree(join(ours, "w2")).call();
    compare("remove");
    expect(ourList((await git.worktreeList().setFormat("porcelain").call()).output)).toBe(
      nativeList("--porcelain"),
    );

    // what needs a working tree is still refused there, as git refuses it
    expect(await fatal(() => git.status().call())).toBe(runResult(nb, "status").stderr);
  });
});
