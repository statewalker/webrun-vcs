/**
 * The files backend's linked worktrees on an in-memory FilesApi (no host root: the paths
 * written are the FilesApi's own), and the refs a linked worktree sees.
 */
import { createInMemoryFilesApi, type FilesApi } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";

import { createGitFilesBackend } from "../../../src/create-git-files-backend.js";
import { createWorktreeRefs, isPerWorktreeRef } from "../../../src/refs/index.js";
import { openGitLinkedWorktrees } from "../../../src/workspace/linked-worktrees/index.js";

const text = async (files: FilesApi, path: string) => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of files.read(path)) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
};
const write = (files: FilesApi, path: string, content: string) =>
  files.write(path, [new TextEncoder().encode(content)]);

async function repository() {
  const files = createInMemoryFilesApi();
  const { history } = await createGitFilesBackend({
    files,
    gitDir: "/repo/.git",
    create: true,
    reflogIdentity: { name: "T", email: "t@e" },
  });
  const blob = await history.blobs.store([new TextEncoder().encode("a\n")]);
  const tree = await history.trees.store([{ mode: 0o100644, name: "a.txt", id: blob }]);
  const who = { name: "T", email: "t@e", timestamp: 1, tzOffset: "+0000" };
  const commit = await history.commits.store({
    tree,
    parents: [],
    author: who,
    committer: who,
    message: "c1\n",
  });
  await history.refs.set("refs/heads/main", commit);
  await history.refs.set("refs/heads/feat", commit);
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: "/repo/.git", history });
  return { files, history, worktrees, commit };
}

describe("GitLinkedWorktrees on files", () => {
  it("creates the admin directory git writes, under a sanitized and numbered name", async () => {
    const { files, worktrees, commit } = await repository();
    const created = await worktrees.create({
      path: "/x/a b.lock",
      head: { ref: "refs/heads/feat" },
      ident: "T <t@e> 5 +0000",
    });
    expect(created).toEqual({ id: "a-b", createdDirectory: true });
    expect(await text(files, "/repo/.git/worktrees/a-b/HEAD")).toBe("ref: refs/heads/feat\n");
    expect(await text(files, "/repo/.git/worktrees/a-b/commondir")).toBe("../..\n");
    expect(await text(files, "/repo/.git/worktrees/a-b/gitdir")).toBe("/x/a b.lock/.git\n");
    expect(await text(files, "/x/a b.lock/.git")).toBe("gitdir: /repo/.git/worktrees/a-b\n");
    expect(await text(files, "/repo/.git/worktrees/a-b/locked")).toBe("initializing\n");
    expect(await text(files, "/repo/.git/worktrees/a-b/logs/HEAD")).toBe(
      `${"0".repeat(40)} ${commit} T <t@e> 5 +0000\n`,
    );
    await worktrees.finishCreate(created.id, false);
    expect(await files.exists("/repo/.git/worktrees/a-b/locked")).toBe(false);

    const second = await worktrees.create({ path: "/y/a b", head: { id: commit } });
    expect(second.id).toBe("a-b1");
    await worktrees.finishCreate(second.id, true);

    const list = await worktrees.list();
    expect(list.map((w) => [w.id, w.path, w.headRef, w.detached, w.lockReason])).toEqual([
      [undefined, "/repo", "refs/heads/main", false, undefined],
      ["a-b", "/x/a b.lock", "refs/heads/feat", false, undefined],
      ["a-b1", "/y/a b", undefined, true, "initializing"],
    ]);
    expect((await worktrees.find("a b"))?.id).toBe("a-b1");
    expect((await worktrees.find("/x/a b.lock"))?.id).toBe("a-b");
    expect(await worktrees.validate(list[1])).toBeUndefined();
  });

  it("prune checks: gone, invalid and locked admin directories", async () => {
    const { files, worktrees, commit } = await repository();
    for (const name of ["gone", "locked", "empty"]) {
      const c = await worktrees.create({ path: `/${name}`, head: { id: commit } });
      await worktrees.finishCreate(c.id, name === "locked");
      await files.remove(`/${name}`);
    }
    await write(files, "/repo/.git/worktrees/empty/gitdir", "");
    expect(await worktrees.pruneCheck("gone", Number.POSITIVE_INFINITY)).toEqual({
      reason: "gitdir file points to non-existent location",
    });
    expect(await worktrees.pruneCheck("locked", Number.POSITIVE_INFINITY)).toEqual({});
    expect(await worktrees.pruneCheck("empty", 0)).toEqual({ reason: "invalid gitdir file" });
    expect(await worktrees.pruneCheck("nothing", 0)).toEqual({ reason: "not a valid directory" });
  });

  it("a linked worktree's HEAD, reflog and pseudo refs are its own; branches are shared", async () => {
    const { files, history, worktrees, commit } = await repository();
    const created = await worktrees.create({
      path: "/wt",
      head: { ref: "refs/heads/feat" },
      ident: "T <t@e> 5 +0000",
    });
    const refs = createWorktreeRefs({
      common: history.refs,
      files,
      gitDir: `/repo/.git/worktrees/${created.id}`,
    });
    expect(isPerWorktreeRef("HEAD")).toBe(true);
    expect(isPerWorktreeRef("refs/worktree/x")).toBe(true);
    expect(isPerWorktreeRef("refs/heads/x")).toBe(false);
    expect((await refs.resolve("HEAD"))?.objectId).toBe(commit);
    expect((await history.refs.get("HEAD")) as unknown).toMatchObject({
      target: "refs/heads/main",
    });

    // an update through HEAD moves the branch and logs the worktree's HEAD
    const blob = await history.blobs.store([new TextEncoder().encode("b\n")]);
    const tree = await history.trees.store([{ mode: 0o100644, name: "b.txt", id: blob }]);
    const who = { name: "T", email: "t@e", timestamp: 2, tzOffset: "+0000" };
    const next = await history.commits.store({
      tree,
      parents: [commit],
      author: who,
      committer: who,
      message: "c2\n",
    });
    const r = await refs.batch([{ name: "HEAD", new: next }], {
      ident: "T <t@e> 6 +0000",
      message: "commit: c2",
    });
    expect(r.ok).toBe(true);
    expect((await history.refs.resolve("refs/heads/feat"))?.objectId).toBe(next);
    expect((await history.refs.resolve("refs/heads/main"))?.objectId).toBe(commit);
    const log = await text(files, `/repo/.git/worktrees/${created.id}/logs/HEAD`);
    expect(log.split("\n")[1]).toBe(`${commit} ${next} T <t@e> 6 +0000\tcommit: c2`);
    // the main worktree's HEAD log is untouched
    expect(await text(files, "/repo/.git/logs/HEAD")).not.toContain("commit: c2");

    await refs.set("ORIG_HEAD", commit);
    expect(await text(files, `/repo/.git/worktrees/${created.id}/ORIG_HEAD`)).toBe(`${commit}\n`);
    expect(await history.refs.has("ORIG_HEAD")).toBe(false);
    const names: string[] = [];
    for await (const ref of refs.list("refs/heads/")) names.push(ref.name);
    expect(names).toEqual(["refs/heads/feat", "refs/heads/main"]);
  });
});

describe("GitLinkedWorktrees: review fixes", () => {
  it("a worktree beyond the FilesApi's root is never prunable, and not reachable", async () => {
    const { files, history } = await repository();
    // the FilesApi's root is /host on the host: /elsewhere cannot be named
    const worktrees = await openGitLinkedWorktrees({
      files,
      gitDir: "/repo/.git",
      history,
      rootPath: "/host",
    });
    await files.mkdir("/repo/.git/worktrees/out");
    await write(files, "/repo/.git/worktrees/out/gitdir", "/elsewhere/out/.git\n");
    await write(files, "/repo/.git/worktrees/out/HEAD", "ref: refs/heads/feat\n");
    await write(files, "/repo/.git/worktrees/out/commondir", "../..\n");
    expect(await worktrees.pruneCheck("out", Number.POSITIVE_INFINITY)).toEqual({
      gitdirPath: "/elsewhere/out/.git",
    });
    const entry = (await worktrees.list()).find((wt) => wt.id === "out");
    expect(entry?.path).toBe("/elsewhere/out");
    expect(entry && worktrees.reachable(entry)).toBe(false);
    await expect(worktrees.open(entry as NonNullable<typeof entry>)).rejects.toThrow(
      "beyond this storage",
    );
    // a missing worktree inside the root is still pruned
    await files.mkdir("/repo/.git/worktrees/gone");
    await write(files, "/repo/.git/worktrees/gone/gitdir", "/host/gone/.git\n");
    expect((await worktrees.pruneCheck("gone", Number.POSITIVE_INFINITY)).reason).toBe(
      "gitdir file points to non-existent location",
    );
  });

  it("openCurrent refuses a bare repository and an unlisted linked worktree", async () => {
    const { files, history, worktrees } = await repository();
    await write(files, "/repo/.git/config", "[core]\n\tbare = true\n");
    const bare = await openGitLinkedWorktrees({ files, gitDir: "/repo/.git", history });
    await expect(bare.openCurrent()).rejects.toThrow("this operation must be run in a work tree");
    await write(files, "/repo/.git/config", "[core]\n\tbare = false\n");

    const created = await worktrees.create({ path: "/wt", head: { ref: "refs/heads/feat" } });
    await worktrees.finishCreate(created.id, false);
    await write(files, "/wt/a.txt", "a\n");
    // its gitdir file emptied: not listed, so its directory is unknown
    await write(files, `/repo/.git/worktrees/${created.id}/gitdir`, "");
    const gitDir = `/repo/.git/worktrees/${created.id}`;
    const unlisted = await openGitLinkedWorktrees({ files, gitDir, history });
    await expect(unlisted.openCurrent()).rejects.toThrow("gitdir file is missing or empty");
    // the caller names it (git: the directory holding the .git file)
    const named = await openGitLinkedWorktrees({ files, gitDir, history, workTree: "/wt" });
    const wc = await named.openCurrent();
    expect(wc.worktree.getRoot()).toBe("/wt");
    expect(await wc.getCurrentBranch()).toBe("feat");
  });

  it("list: the lock reason trimmed of ASCII white space only; rebase-apply before rebase-merge", async () => {
    const { files, worktrees } = await repository();
    const created = await worktrees.create({ path: "/wt", head: { ref: "refs/heads/feat" } });
    const admin = `/repo/.git/worktrees/${created.id}`;
    await write(files, `${admin}/locked`, "\u00a0on a disk\u00a0\t\r\n");
    // an `am` in rebase-apply: no rebase, whatever rebase-merge holds (wt_status_check_rebase)
    await files.mkdir(`${admin}/rebase-apply`);
    await write(files, `${admin}/rebase-apply/applying`, "");
    await files.mkdir(`${admin}/rebase-merge`);
    await write(files, `${admin}/rebase-merge/head-name`, "refs/heads/feat\n");
    const entry = (await worktrees.list()).find((wt) => wt.id === created.id);
    expect(entry?.lockReason).toBe("\u00a0on a disk\u00a0");
    expect(entry?.rebasing).toBeUndefined();
  });

  it("a noDeref update of the worktree's symbolic HEAD logs the branch's id as old value", async () => {
    const { files, history, worktrees, commit } = await repository();
    const created = await worktrees.create({
      path: "/wt",
      head: { ref: "refs/heads/feat" },
      ident: "T <t@e> 5 +0000",
    });
    const gitDir = `/repo/.git/worktrees/${created.id}`;
    const refs = createWorktreeRefs({ common: history.refs, files, gitDir });
    // `checkout --detach`: HEAD replaced by the id it resolved to, old value checked
    const r = await refs.batch([{ name: "HEAD", old: commit, new: commit, noDeref: true }], {
      ident: "T <t@e> 6 +0000",
      message: "checkout: moving from feat to HEAD",
    });
    expect(r.ok).toBe(true);
    expect(await text(files, `${gitDir}/HEAD`)).toBe(`${commit}\n`);
    expect((await text(files, `${gitDir}/logs/HEAD`)).split("\n")[1]).toBe(
      `${commit} ${commit} T <t@e> 6 +0000\tcheckout: moving from feat to HEAD`,
    );
  });
});

describe("GitLinkedWorktrees: directories that cannot be listed or removed", () => {
  /** `files` whose listing of `unreadable` fails (EACCES) and whose rmdir always fails. */
  const failing = (files: FilesApi, unreadable: string): FilesApi =>
    new Proxy(files, {
      get(target, key, receiver) {
        if (key === "list" || key === "listKinds") {
          const original = Reflect.get(target, key, receiver) as (
            path: string,
            ...rest: unknown[]
          ) => AsyncIterable<unknown>;
          return (path: string, ...rest: unknown[]) => {
            if (path.replace(/\/+$/, "") !== unreadable)
              return original.call(target, path, ...rest);
            return (async function* () {
              yield* [];
              throw Object.assign(new Error(`EACCES: permission denied, scandir '${path}'`), {
                code: "EACCES",
              });
            })();
          };
        }
        if (key === "rmdir") {
          return async () => {
            throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });

  it("pathState: a directory that cannot be listed is not empty (git's is_empty_dir)", async () => {
    const { files, history } = await repository();
    await files.mkdir("/u");
    const worktrees = await openGitLinkedWorktrees({
      files: failing(files, "/u"),
      gitDir: "/repo/.git",
      history,
    });
    expect(await worktrees.pathState("/u")).toBe("directory");
  });

  it("deleteAdminRootIfEmpty: a failed removal is ignored (git's delete_worktrees_dir_if_empty)", async () => {
    const { files, history } = await repository();
    await files.mkdir("/repo/.git/worktrees");
    const worktrees = await openGitLinkedWorktrees({
      files: failing(files, "/repo/.git/worktrees"),
      gitDir: "/repo/.git",
      history,
    });
    await expect(worktrees.deleteAdminRootIfEmpty()).resolves.toBeUndefined();
    expect((await files.stats("/repo/.git/worktrees"))?.kind).toBe("directory");
  });
});

describe("WorktreeRefs and the reference-transaction hook", () => {
  type Hook = (
    state: string,
    updates: readonly { name: string; requested: string }[],
  ) => Promise<boolean | string | undefined>;
  interface HookedRefs {
    setTransactionHook(hook: Hook | undefined): void;
    removeAll(names: string[]): Promise<void>;
  }

  async function linked() {
    const { files, history, worktrees, commit } = await repository();
    const created = await worktrees.create({
      path: "/wt",
      head: { ref: "refs/heads/feat" },
      ident: "T <t@e> 5 +0000",
    });
    const refs = createWorktreeRefs({
      common: history.refs,
      files,
      gitDir: `/repo/.git/worktrees/${created.id}`,
    });
    return { files, history, refs, commit };
  }

  it("concurrent batches each tell their updates as they asked for them", async () => {
    const { history, refs, commit } = await linked();
    await history.refs.set("refs/heads/other", commit);
    const seen: string[] = [];
    // each state waits a little, so the batches overlap
    (refs as unknown as HookedRefs).setTransactionHook(async (state, updates) => {
      seen.push(`${state} ${updates.map((u) => u.requested).join(",")}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return undefined;
    });
    const results = await Promise.all([
      refs.batch([{ name: "HEAD", new: commit }]),
      refs.batch([{ name: "refs/heads/other", new: commit }]),
      refs.batch([{ name: "HEAD", new: commit }]),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const told = (requested: string) =>
      ["committed", "prepared", "preparing"].map((state) => `${state} ${requested}`);
    expect(seen.sort()).toEqual(
      [...told("HEAD"), ...told("HEAD"), ...told("refs/heads/other")].sort(),
    );
  });

  it("removeAll: a refusal of the repository's transaction deletes none of the worktree's", async () => {
    const { history, refs, commit } = await linked();
    await history.refs.set("refs/heads/gone", commit);
    await refs.set("refs/worktree/kept", commit);
    (refs as unknown as HookedRefs).setTransactionHook(async (state, updates) =>
      state === "preparing" && updates.some((u) => u.name.startsWith("refs/heads/"))
        ? "refused"
        : undefined,
    );
    await expect(
      (refs as unknown as HookedRefs).removeAll(["refs/heads/gone", "refs/worktree/kept"]),
    ).rejects.toThrow();
    (refs as unknown as HookedRefs).setTransactionHook(undefined);
    expect((await history.refs.resolve("refs/heads/gone"))?.objectId).toBe(commit);
    expect((await refs.resolve("refs/worktree/kept"))?.objectId).toBe(commit);
  });
});
