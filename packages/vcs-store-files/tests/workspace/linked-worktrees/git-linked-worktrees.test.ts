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
