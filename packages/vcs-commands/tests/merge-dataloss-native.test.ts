/**
 * Regressions found reviewing merge, cherry-pick, revert, rebase and stash apply against
 * native git: untracked work they must never lose (an abort over an untracked file or a
 * nested repository, a rebase that drops a commit, an autostash left hidden), results that
 * differ from git's (rebase order, `-n` of several commits, rename/add, stash labels), and
 * `add` / `commit` finishing what a merge or pick stopped at, in both directions with
 * native git. Each case builds the same history twice, runs native git on one twin and
 * ours on the other, and compares HEAD, status, index, every worktree file and git's state
 * files.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileMode } from "@statewalker/vcs-core";
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

import {
  Git,
  MergeOperation,
  RebaseOperation,
  RebaseStatus,
  SequencerOperation,
} from "../src/index.js";
import {
  git,
  gitOk,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  put,
  type Snapshot,
  snapshot,
} from "./merge-native-helpers.js";
import { buildHistory, type History, text } from "./merge-native-scenarios.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

/** The history built twice (never copied); `after` runs in each twin. */
function twins(history: History, after?: (dir: string) => void) {
  const n = counter++;
  const native = join(root, `n${n}`);
  const ours = join(root, `o${n}`);
  for (const dir of [native, ours]) {
    buildHistory(root, dir, history);
    after?.(dir);
  }
  return { native, ours };
}

const snap = (dir: string) => snapshot(root, dir, normalizeState);

/** What differs between the twins, per compared part. */
function differences(label: string, ours: Snapshot, native: Snapshot): string[] {
  const out: string[] = [];
  for (const k of ["head", "status", "index", "files", "state"] as const) {
    if (JSON.stringify(ours[k]) !== JSON.stringify(native[k])) {
      out.push(
        `[${label}] ${k}:\n  ours   ${JSON.stringify(ours[k])}\n  native ${JSON.stringify(native[k])}`,
      );
    }
  }
  return out;
}

const same = (label: string, ours: string, native: string) =>
  expect(differences(label, snap(ours), snap(native))).toEqual([]);

const conflictA: History = {
  base: { "a.txt": text() },
  main: { "a.txt": text({ 5: "main" }) },
  side: { "a.txt": text({ 5: "side" }) },
};

async function oursMerge(dir: string, autostash = false) {
  return (await openOurs(dir))
    .merge()
    .include("side")
    .setAutoStash(autostash)
    .setCommitter(INTEROP_IDENT)
    .setAuthor(INTEROP_IDENT)
    .call();
}

async function oursRebase(dir: string, upstream = "main", autostash = false) {
  return (await openOurs(dir))
    .rebase()
    .setCommitter(INTEROP_IDENT)
    .setAutoStash(autostash)
    .setUpstreamBranch(upstream)
    .then((c) => c.call());
}

describeGit("merge, pick, rebase and stash keep untracked work as git does", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-dataloss-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("merge --abort refuses to replace a directory holding an untracked file", async () => {
    const { native, ours } = twins({
      base: { ...conflictA.base, d: "file d\n" },
      main: conflictA.main,
      side: { ...conflictA.side, d: null, "d/x": "x\n" },
    });
    git(root, native, "merge", "side");
    await oursMerge(ours);
    same("merge", ours, native);
    for (const dir of [native, ours]) put(dir, "d/precious.txt", "my work\n");
    const na = git(root, native, "merge", "--abort");
    const oa = await (await openOurs(ours)).merge().setOperation(MergeOperation.ABORT).call();
    expect(na.status).not.toBe(0);
    expect(na.stderr).toContain("Updating 'd' would lose untracked files in it");
    expect(oa.message).toContain("Updating 'd' would lose untracked files in it");
    same("abort", ours, native);
  });

  it("merge --abort refuses an untracked file on a leading path of a file it restores", async () => {
    const { native, ours } = twins({
      base: { ...conflictA.base, "d/x": "x\n" },
      main: conflictA.main,
      side: { ...conflictA.side, "d/x": null },
    });
    git(root, native, "merge", "side");
    await oursMerge(ours);
    for (const dir of [native, ours]) put(dir, "d", "my untracked file d\n");
    const na = git(root, native, "merge", "--abort");
    const oa = await (await openOurs(ours)).merge().setOperation(MergeOperation.ABORT).call();
    expect(na.stderr).toContain("Untracked working tree file 'd' would be overwritten by merge.");
    expect(oa.message).toContain("Untracked working tree file 'd' would be overwritten by merge.");
    same("abort", ours, native);
  });

  it("cherry-pick --abort and --skip refuse to lose an untracked file in the way", async () => {
    const history: History = {
      base: { ...conflictA.base, d: "file d\n" },
      main: conflictA.main,
      side: { ...conflictA.side, d: null, "d/x": "x\n" },
    };
    for (const step of ["--abort", "--skip"] as const) {
      const { native, ours } = twins(history);
      git(root, native, "cherry-pick", "side");
      await (await openOurs(ours)).cherryPick().include("side").setCommitter(INTEROP_IDENT).call();
      for (const dir of [native, ours]) put(dir, "d/precious.txt", "my work\n");
      const nr = git(root, native, "cherry-pick", step);
      const g = await openOurs(ours);
      const operation = step === "--abort" ? SequencerOperation.ABORT : SequencerOperation.SKIP;
      const or = await g.cherryPick().setOperation(operation).call();
      expect(nr.status, step).not.toBe(0);
      expect(or.status, step).toBe("failed");
      same(`cherry-pick ${step}`, ours, native);
    }
  });

  for (const nested of ["n", "n/sub"]) {
    it(`merge and fast-forward refuse to replace an untracked nested repository at ${nested}`, async () => {
      for (const ff of [false, true]) {
        const { native, ours } = twins(
          ff
            ? { base: { "a.txt": text() }, side: { n: "theirs n\n" } }
            : {
                base: { "a.txt": text() },
                main: { "a.txt": text({ 1: "main" }) },
                side: { n: "theirs n\n" },
              },
          (dir) => {
            mkdirSync(join(dir, nested), { recursive: true });
            gitOk(root, join(dir, nested), "init", "-q");
            put(dir, `${nested}/work.txt`, "nested work\n");
          },
        );
        const nm = git(root, native, "merge", "side");
        const om = await oursMerge(ours);
        expect(nm.status).not.toBe(0);
        expect(om.status).toBe("failed");
        same(`merge ff=${ff}`, ours, native);
      }
    });
  }

  it("rebase reschedules a pick an untracked file refused; --continue applies it", async () => {
    const { native, ours } = twins(
      {
        base: { "a.txt": text() },
        main: { "m.txt": "m\n" },
        side: { "c.txt": "c\n" },
        sideMore: [{ "tmp.txt": "added by side 2\n" }, { "tmp.txt": null, "e.txt": "e\n" }],
      },
      (dir) => {
        gitOk(root, dir, "checkout", "-q", "side");
        put(dir, "tmp.txt", "untracked precious\n");
      },
    );
    const nr = git(root, native, "rebase", "main");
    const or = await oursRebase(ours);
    expect(nr.stderr).toContain("It has been rescheduled");
    expect(or.message).toContain("It has been rescheduled");
    same("rebase", ours, native);
    for (const dir of [native, ours]) unlinkSync(join(dir, "tmp.txt"));
    git(root, native, "rebase", "--continue");
    const oc = await (await openOurs(ours))
      .rebase()
      .setCommitter(INTEROP_IDENT)
      .setOperation(RebaseOperation.CONTINUE)
      .call();
    expect(oc.status).toBe(RebaseStatus.OK);
    same("continue", ours, native);
    expect(gitOk(root, ours, "log", "--format=%s")).toBe(gitOk(root, native, "log", "--format=%s"));
  });

  it("merge --autostash of an unrelated history refuses before stashing anything", async () => {
    const { native, ours } = twins(
      { base: { "a.txt": text() }, main: { "a.txt": text({ 1: "main" }) } },
      (dir) => {
        gitOk(root, dir, "checkout", "-q", "--orphan", "other");
        gitOk(root, dir, "rm", "-rfq", ".");
        put(dir, "o.txt", "other\n");
        gitOk(root, dir, "add", "-A");
        gitOk(root, dir, "commit", "-qm", "other");
        gitOk(root, dir, "checkout", "-q", "main");
        put(dir, "a.txt", "precious uncommitted\n");
      },
    );
    const nm = git(root, native, "merge", "--autostash", "other");
    expect(nm.stderr).toContain("refusing to merge unrelated histories");
    await expect(
      (await openOurs(ours)).merge().include("other").setAutoStash(true).call(),
    ).rejects.toThrow();
    same("merge", ours, native);
    expect(gitOk(root, ours, "stash", "list")).toBe("");
  });

  it("cherry-pick -n and revert -n of several commits merge into the index, as git", async () => {
    const pick = twins({
      base: { "a.txt": text() },
      side: { "a.txt": text({ 2: "side2" }) },
      sideMore: [{ "a.txt": text({ 2: "side2", 8: "side8" }) }],
    });
    git(root, pick.native, "cherry-pick", "-n", "side~1", "side");
    await (await openOurs(pick.ours))
      .cherryPick()
      .include("side~1")
      .include("side")
      .setNoCommit(true)
      .setCommitter(INTEROP_IDENT)
      .call();
    same("cherry-pick -n", pick.ours, pick.native);

    const revert = twins(
      { base: { "a.txt": text() }, main: { "a.txt": text({ 2: "m2" }) }, side: {} },
      (dir) => {
        put(dir, "a.txt", text({ 2: "m2", 8: "m8" }));
        gitOk(root, dir, "commit", "-qam", "m8");
      },
    );
    git(root, revert.native, "revert", "-n", "HEAD", "HEAD~1");
    await (await openOurs(revert.ours))
      .revert()
      .include("HEAD")
      .include("HEAD~1")
      .setNoCommit(true)
      .setCommitter(INTEROP_IDENT)
      .call();
    same("revert -n", revert.ours, revert.native);
  });

  it("rebase of a branch with a merge picks in git's topological order", async () => {
    const { native, ours } = twins(
      { base: { "a.txt": text() }, main: { "m.txt": "m\n" } },
      (dir) => {
        const run = (...a: string[]) => gitOk(root, dir, ...a);
        run("checkout", "-q", "-b", "topic", "main~1");
        put(dir, "x.txt", "x1\n");
        run("add", "-A");
        run("commit", "-qm", "X");
        run("checkout", "-q", "-b", "z");
        put(dir, "z.txt", "z\n");
        run("add", "-A");
        run("commit", "-qm", "Z");
        run("checkout", "-q", "topic");
        put(dir, "x.txt", "x1\nx2\n");
        run("add", "-A");
        run("commit", "-qm", "Y");
        run("merge", "-q", "--no-edit", "z");
        put(dir, "w.txt", "w\n");
        run("add", "-A");
        run("commit", "-qm", "W");
      },
    );
    git(root, native, "rebase", "main");
    await oursRebase(ours);
    expect(gitOk(root, ours, "log", "--format=%s")).toBe(gitOk(root, native, "log", "--format=%s"));
    same("rebase", ours, native);
  });

  it("rebase --abort restores a tracked file deleted during the stop; a deletion refuses a rebase", async () => {
    const stopped = twins(
      {
        base: { "a.txt": text(), "keep.txt": "keep\n" },
        main: { "a.txt": text({ 5: "main" }) },
        side: { "a.txt": text({ 5: "side" }) },
      },
      (dir) => gitOk(root, dir, "checkout", "-q", "side"),
    );
    git(root, stopped.native, "rebase", "main");
    await oursRebase(stopped.ours);
    for (const dir of [stopped.native, stopped.ours]) unlinkSync(join(dir, "keep.txt"));
    git(root, stopped.native, "rebase", "--abort");
    await (await openOurs(stopped.ours)).rebase().setOperation(RebaseOperation.ABORT).call();
    same("abort", stopped.ours, stopped.native);

    const history: History = {
      base: { "a.txt": text(), "b.txt": text() },
      main: { "b.txt": text({ 3: "main" }) },
      side: { "c.txt": "c\n" },
    };
    const deleted = (dir: string) => {
      gitOk(root, dir, "checkout", "-q", "side");
      unlinkSync(join(dir, "b.txt"));
    };
    const refused = twins(history, deleted);
    const nr = git(root, refused.native, "rebase", "main");
    const or = await oursRebase(refused.ours);
    expect(nr.stderr).toContain("You have unstaged changes");
    expect(or.status).toBe(RebaseStatus.UNCOMMITTED_CHANGES);
    same("rebase", refused.ours, refused.native);

    // --autostash stashes the deletion and applies it back
    const stashed = twins(history, deleted);
    git(root, stashed.native, "rebase", "--autostash", "main");
    await oursRebase(stashed.ours, "main", true);
    same("rebase --autostash", stashed.ours, stashed.native);
  });

  it("merge stages rename/add as git's merge-ort: an add/add at the new path", async () => {
    const lines = (word: string) => Array.from({ length: 10 }, (_, i) => `${word} ${i}\n`).join("");
    for (const modified of [false, true]) {
      const { native, ours } = twins({
        base: { from: lines("line"), keep: "k\n" },
        main: { from: null, to: lines("line").replace("line 9", "line 9 main") },
        side: {
          to: lines("other"),
          ...(modified ? { from: lines("line").replace("line 2", "line 2 side") } : {}),
        },
      });
      const nm = git(root, native, "merge", "side");
      const om = await oursMerge(ours);
      expect(nm.stdout).toContain("CONFLICT (add/add): Merge conflict in to");
      expect(om.output).toContain("CONFLICT (add/add): Merge conflict in to");
      same(`rename/add modified=${modified}`, ours, native);
    }
  });

  it("revert of an empty commit stops without REVERT_HEAD", async () => {
    const { native, ours } = twins({ base: { "a.txt": text() } }, (dir) =>
      gitOk(root, dir, "commit", "-q", "--allow-empty", "-m", "empty"),
    );
    git(root, native, "revert", "--no-edit", "HEAD");
    await (await openOurs(ours)).revert().include("HEAD").setCommitter(INTEROP_IDENT).call();
    same("revert", ours, native);
  });

  it("stash apply labels the diff3 base 'Stash base'; an up-to-date apply leaves no AUTO_MERGE", async () => {
    const { native, ours } = twins(
      {
        base: { "a.txt": text(), "b.txt": "b\n" },
        config: { "merge.conflictStyle": "diff3" },
      },
      (dir) => {
        put(dir, "a.txt", text({ 2: "stashed" }));
        gitOk(root, dir, "stash", "-q");
        put(dir, "a.txt", text({ 2: "committed" }));
        gitOk(root, dir, "commit", "-qam", "c");
      },
    );
    git(root, native, "stash", "apply");
    await (await openOurs(ours)).stashApply().call();
    same("stash apply", ours, native);
    expect(snap(ours).files["a.txt"]).toContain("||||||| Stash base");

    const upToDate = twins({ base: { "a.txt": text() } }, (dir) => {
      put(dir, "u.txt", "untracked\n");
      gitOk(root, dir, "stash", "-q", "-u");
    });
    git(root, upToDate.native, "stash", "apply");
    await (await openOurs(upToDate.ours)).stashApply().call();
    same("stash apply -u", upToDate.ours, upToDate.native);
    expect(snap(upToDate.ours).state.AUTO_MERGE).toBeUndefined();
  });

  it("stash apply writes the tracked changes, then restores what untracked files it can", async () => {
    const { native, ours } = twins({ base: { "a.txt": text() } }, (dir) => {
      put(dir, "a.txt", text({ 3: "stashed" }));
      put(dir, "u1.txt", "untracked 1\n");
      put(dir, "u2.txt", "untracked 2\n");
      gitOk(root, dir, "stash", "-q", "-u");
      put(dir, "u2.txt", "in the way\n");
    });
    const na = git(root, native, "stash", "apply");
    let message = "";
    try {
      await (await openOurs(ours)).stashApply().call();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(na.stderr).toContain("u2.txt already exists, no checkout");
    expect(message).toContain("u2.txt already exists, no checkout");
    same("stash apply", ours, native);
  });

  it("add resolves a conflict native git left (stages removed, resolve-undo recorded)", async () => {
    const { native, ours } = twins(conflictA);
    for (const dir of [native, ours]) {
      git(root, dir, "merge", "side");
      put(dir, "a.txt", text({ 5: "resolved" }));
    }
    git(root, native, "add", "a.txt");
    await (await openOurs(ours)).add().addFilepattern("a.txt").call();
    same("add", ours, native);
    expect(gitOk(root, ours, "ls-files", "--resolve-undo")).toBe(
      gitOk(root, native, "ls-files", "--resolve-undo"),
    );
    expect(gitOk(root, ours, "ls-files", "--resolve-undo")).not.toBe("");

    // a conflicted file deleted from disk: add -A removes its stages
    const deleted = twins(conflictA);
    for (const dir of [deleted.native, deleted.ours]) {
      git(root, dir, "merge", "side");
      unlinkSync(join(dir, "a.txt"));
    }
    git(root, deleted.native, "add", "-A");
    await (await openOurs(deleted.ours)).add().addFilepattern(".").call();
    same("add -A", deleted.ours, deleted.native);
  });

  it("commit finishes a merge either side stopped at (MERGE_HEAD, MERGE_MSG), as git commit", async () => {
    // native stops, ours commits
    const a = twins(conflictA);
    for (const dir of [a.native, a.ours]) {
      git(root, dir, "merge", "side");
      put(dir, "a.txt", text({ 5: "resolved" }));
      git(root, dir, "add", "a.txt");
    }
    git(root, a.native, "commit", "--no-edit", "--cleanup=strip");
    await (await openOurs(a.ours))
      .commit()
      .setAuthorIdent(INTEROP_IDENT)
      .setCommitterIdent(INTEROP_IDENT)
      .call();
    same("commit", a.ours, a.native);
    expect(gitOk(root, a.ours, "log", "-1", "--format=%P").trim().split(" ")).toHaveLength(2);

    // ours stops, native commits
    const b = twins(conflictA);
    git(root, b.native, "merge", "side");
    await oursMerge(b.ours);
    for (const dir of [b.native, b.ours]) {
      put(dir, "a.txt", text({ 5: "resolved" }));
      git(root, dir, "add", "a.txt");
      git(root, dir, "commit", "--no-edit");
    }
    same("native commit", b.ours, b.native);

    // committing with unmerged files is refused
    const c = twins(conflictA);
    await oursMerge(c.ours);
    await expect(
      (await openOurs(c.ours)).commit().setMessage("x").setCommitterIdent(INTEROP_IDENT).call(),
    ).rejects.toThrow("Committing is not possible because you have unmerged files.");
  });

  it("commit after a stopped cherry-pick keeps the picked author and ends the pick", async () => {
    const { native, ours } = twins(conflictA);
    for (const dir of [native, ours]) {
      git(root, dir, "cherry-pick", "side");
      put(dir, "a.txt", text({ 5: "resolved" }));
      git(root, dir, "add", "a.txt");
    }
    git(root, native, "commit", "--no-edit", "--cleanup=strip");
    await (await openOurs(ours)).commit().setCommitterIdent(INTEROP_IDENT).call();
    same("commit", ours, native);
    expect(gitOk(root, ours, "log", "-1", "--format=%an <%ae> %ad")).toBe(
      gitOk(root, native, "log", "-1", "--format=%an <%ae> %ad"),
    );
  });

  it("commit applies MERGE_AUTOSTASH once the merge it finishes is committed", async () => {
    const { native, ours } = twins(
      { ...conflictA, base: { ...conflictA.base, "b.txt": "b\n" } },
      (dir) => put(dir, "b.txt", "local change\n"),
    );
    git(root, native, "merge", "--autostash", "side");
    await oursMerge(ours, true);
    same("merge --autostash", ours, native);
    for (const dir of [native, ours]) {
      put(dir, "a.txt", text({ 5: "resolved" }));
      git(root, dir, "add", "a.txt");
    }
    git(root, native, "commit", "--no-edit", "--cleanup=strip");
    await (await openOurs(ours))
      .commit()
      .setAuthorIdent(INTEROP_IDENT)
      .setCommitterIdent(INTEROP_IDENT)
      .call();
    same("commit", ours, native);
    expect(snap(ours).files["b.txt"]).toBe("local change\n");
  });

  it("cherry-pick --abort of a sequence keeps an unrelated dirty file and an untracked file", async () => {
    const { native, ours } = twins(
      {
        base: { "a.txt": text(), "u.txt": "u\n" },
        main: { "a.txt": text({ 5: "main" }) },
        side: { "c.txt": "c\n" },
        sideMore: [{ "a.txt": text({ 5: "side" }) }],
      },
      (dir) => {
        put(dir, "u.txt", "dirty u\n");
        put(dir, "untracked.txt", "untracked\n");
      },
    );
    git(root, native, "cherry-pick", "side~1", "side");
    await (await openOurs(ours))
      .cherryPick()
      .include("side~1")
      .include("side")
      .setCommitter(INTEROP_IDENT)
      .call();
    same("pick", ours, native);
    git(root, native, "cherry-pick", "--abort");
    await (await openOurs(ours)).cherryPick().setOperation(SequencerOperation.ABORT).call();
    same("abort", ours, native);
  });
});

/** Our working copy over `dir`, its checkout unable to keep state files (no writeStateFile). */
async function openWithoutStateFiles(dir: string): Promise<Git> {
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
  const full = new GitCheckout({
    staging,
    refs: history.refs,
    files: {
      read: io.read,
      write: (p: string, c: Iterable<Uint8Array>) => files.write(p, c),
      stats: async (p: string) => {
        const s = await files.stats(p);
        return s ? { isDirectory: s.kind === "directory" } : undefined;
      },
      remove: async (p: string) => {
        await files.remove(p);
      },
      removeDir: async (p: string) => {
        await files.remove(p);
      },
      mkdir: (p: string) => files.mkdir(p),
      list: (p: string) => files.list(p),
    } as unknown as GitCheckoutFilesApi,
    gitDir: ".git",
  });
  const checkout = new Proxy(full, {
    get(target, property) {
      if (property === "writeStateFile") return undefined;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
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

describeGit("autostash and directory replacement never strand or lose work", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-dataloss-wt-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a merge or rebase with autostash refuses where the checkout keeps no state files", async () => {
    const { ours } = twins({ ...conflictA, base: { ...conflictA.base, "b.txt": "b\n" } }, (dir) =>
      put(dir, "b.txt", "local change\n"),
    );
    const before = snap(ours);
    const g = await openWithoutStateFiles(ours);
    await expect(
      g.merge().include("side").setAutoStash(true).setCommitter(INTEROP_IDENT).call(),
    ).rejects.toThrow("keeps state files");
    const r = await openWithoutStateFiles(ours);
    await expect(
      r
        .rebase()
        .setAutoStash(true)
        .setCommitter(INTEROP_IDENT)
        .setUpstreamBranch("side")
        .then((c) => c.call()),
    ).rejects.toThrow("keeps state files");
    // nothing stashed away, nothing changed (the merge records ORIG_HEAD first, as git)
    const after = snap(ours);
    expect({ ...after, state: {} }).toEqual({ ...before, state: {} });
    expect(gitOk(root, ours, "stash", "list")).toBe("");
  });

  it("a file never replaces a directory holding an untracked file or a nested repository", async () => {
    const dir = join(root, "replace");
    mkdirSync(dir);
    gitOk(root, dir, "init", "-q");
    put(dir, "d/untracked.txt", "work\n");
    put(dir, "n/work.txt", "nested work\n");
    gitOk(root, join(dir, "n"), "init", "-q");
    mkdirSync(join(dir, "e/empty"), { recursive: true });
    const files = createNodeFilesApi({ rootDir: dir });
    const { history } = await createGitFilesBackend({ files });
    const worktree = createFileWorktree({
      files,
      rootPath: "",
      gitDir: ".git",
      blobs: history.blobs,
      trees: history.trees,
    });
    const write = (path: string, discardUntracked = false) =>
      worktree.writeContent(path, new TextEncoder().encode("file\n"), {
        mode: FileMode.REGULAR_FILE,
        replaceInTheWay: true,
        discardUntracked,
      });
    await expect(write("d")).rejects.toThrow("would lose untracked files");
    await expect(write("n")).rejects.toThrow("would lose untracked files");
    expect(readFileSync(join(dir, "d/untracked.txt"), "utf8")).toBe("work\n");
    expect(readFileSync(join(dir, "n/work.txt"), "utf8")).toBe("nested work\n");
    // nothing but empty directories: replaced
    await write("e");
    // git's reset --hard (discardUntracked) replaces whatever is there
    await write("d", true);
    expect((await worktree.getEntry("d"))?.isDirectory).toBe(false);
  });
});

describeGit("a refused merge over a symbolic link among the leading directories", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-dataloss-link-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // d/f assume-unchanged, d then replaced by a link: save_state's `stash create` passes the
  // entry over (refresh_index marks it up to date), the merge is refused and git's reset
  // writes d/f into a real directory where the link was, its target left as it is
  const history = (staged: boolean, target: string): History => ({
    base: { "d/f": "base\n", k: "k\n" },
    side: { "d/f": "side\n", k: "side\n" },
    main: { "d/f": "main\n" },
    dirty: { k: "local\n", d: { link: target } },
    ...(staged ? { stage: ["k"] } : {}),
  });
  for (const staged of [true, false]) {
    for (const target of ["e", "../outside-e"]) {
      it(`returns FAILED and resets (k ${staged ? "staged" : "changed"}, d -> ${target})`, async () => {
        const fill = (dir: string) => {
          put(join(dir, target, ".."), `${target.split("/").pop()}/f`, "elsewhere\n");
          gitOk(root, dir, "update-index", "--assume-unchanged", "d/f");
        };
        const { native, ours } = twins(history(staged, target), fill);
        const n = git(root, native, "merge", "side");
        expect(n.status).toBe(2);
        const result = await oursMerge(ours);
        expect(result.status).toBe("failed");
        expect(result.message).toBe(n.stderr.trim());
        same("merge", ours, native);
        expect(gitOk(root, ours, "ls-files", "-v")).toBe(gitOk(root, native, "ls-files", "-v"));
        const left = target === "e" ? join(ours, "e/f") : join(root, "outside-e/f");
        expect(readFileSync(left, "utf8")).toBe("elsewhere\n");
      });
    }
  }
});
