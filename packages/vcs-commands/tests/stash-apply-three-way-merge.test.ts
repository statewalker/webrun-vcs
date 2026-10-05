/**
 * Path-level three-way merge semantics of StashApplyCommand.
 *
 * Fixture shape:
 *
 *     stashBase (real files)   <- the commit the stash was taken from
 *      |\
 *      | \
 *   branch  stash             <- HEAD advanced to `branch`; stash still on stashBase
 *
 * so `mergeTreesThreeWay` sees base = stashBase's tree, ours = the stash's
 * working tree, theirs = HEAD's tree.
 *
 * The stash base is committed with real file content on purpose: the tree of
 * `createInitializedGit()`'s initial commit is the well-known EMPTY tree, which
 * a content-addressed store answers for without ever having received it, so a
 * fixture anchored on it asserts nothing.
 *
 * These tests assert only the reported status/conflicts. What the command then
 * puts back into the working tree and the index is pinned separately, in
 * stash-apply-restore.test.ts.
 */

import type { History, ObjectId } from "@statewalker/vcs-core";
import { FileMode } from "@statewalker/vcs-core";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";

import { StashApplyStatus } from "../src/index.js";
import {
  addFile,
  backends,
  createCommit,
  createInitializedGitFromFactory,
  removeFile,
  testAuthor,
} from "./test-helper.js";

describe.each(backends)("StashApplyCommand three-way merge ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  type Changes = {
    add?: Record<string, string>;
    remove?: string[];
    /** path -> [content, mode]: re-stage a path with an explicit file mode. */
    chmod?: Record<string, [string, number]>;
  };

  /** Stage `path` with the given content and an explicit file mode. */
  async function addFileWithMode(
    wc: WorkingCopy,
    path: string,
    content: string,
    mode: number,
  ): Promise<void> {
    const data = new TextEncoder().encode(content);
    const objectId = await wc.history.blobs.store([data]);
    const editor = wc.checkout.staging.createEditor();
    editor.add({
      path,
      apply: () => ({ path, mode, objectId, stage: 0, size: data.length, mtime: Date.now() }),
    });
    await editor.finish();
  }

  /**
   * Build the diamond above and leave `refs/stash` and HEAD in place.
   */
  async function buildStashDiamond(opts: {
    baseFiles: Record<string, string>;
    /** What the branch did after the stash was taken. */
    branch: Changes;
    /** What was stashed (the stash's own working tree). */
    stash: Changes;
  }) {
    const init = await createInitializedGitFromFactory(factory);
    const { git, workingCopy, repository, initialCommitId } = init;
    cleanup = init.cleanup;

    const baseCommit = await createCommit(workingCopy, "stash base", opts.baseFiles, [
      initialCommitId,
    ]);
    const baseTree = (await repository.commits.load(baseCommit))?.tree as ObjectId;

    async function treeFrom(changes: Changes, wc: WorkingCopy): Promise<ObjectId> {
      await wc.checkout.staging.readTree(repository.trees, baseTree);
      for (const path of changes.remove ?? []) {
        await removeFile(wc, path);
      }
      for (const [path, content] of Object.entries(changes.add ?? {})) {
        await addFile(wc, path, content);
      }
      for (const [path, [content, mode]] of Object.entries(changes.chmod ?? {})) {
        await addFileWithMode(wc, path, content, mode);
      }
      return wc.checkout.staging.writeTree(repository.trees);
    }

    // The stash's working tree, hung off `baseCommit` as git does.
    const stashTree = await treeFrom(opts.stash, workingCopy);
    const indexCommit = await repository.commits.store({
      tree: stashTree,
      parents: [baseCommit],
      author: testAuthor(),
      committer: testAuthor(),
      message: "index on main: stash",
    });
    const stashCommit = await repository.commits.store({
      tree: stashTree,
      parents: [baseCommit, indexCommit],
      author: testAuthor(),
      committer: testAuthor(),
      message: "WIP on main: stash",
    });
    await repository.refs.set("refs/stash", stashCommit);

    // Advance the branch past the stash base.
    const branchTree = await treeFrom(opts.branch, workingCopy);
    const branchCommit = await repository.commits.store({
      tree: branchTree,
      parents: [baseCommit],
      author: testAuthor(),
      committer: testAuthor(),
      message: "branch moved on",
    });
    await repository.refs.set("refs/heads/main", branchCommit);
    await workingCopy.checkout.staging.readTree(repository.trees, branchTree);

    return { git, repository: repository as History, stashCommit, branchCommit };
  }

  it("does not conflict when the stash and the branch made the identical change", async () => {
    const { git } = await buildStashDiamond({
      baseFiles: { "keep.txt": "keep", "shared.txt": "v1" },
      branch: { add: { "shared.txt": "v2", "branch-only.txt": "b" } },
      stash: { add: { "shared.txt": "v2", "stash-only.txt": "s" } },
    });

    const result = await git.stashApply().call();

    expect(result.conflicts).toBeUndefined();
    expect(result.status).toBe(StashApplyStatus.OK);
  });

  it("does not conflict when the stash and the branch deleted the same path", async () => {
    const { git } = await buildStashDiamond({
      baseFiles: { "keep.txt": "keep", "doomed.txt": "gone" },
      branch: { remove: ["doomed.txt"], add: { "branch-only.txt": "b" } },
      stash: { remove: ["doomed.txt"], add: { "stash-only.txt": "s" } },
    });

    const result = await git.stashApply().call();

    expect(result.conflicts).toBeUndefined();
    expect(result.status).toBe(StashApplyStatus.OK);
  });

  it("conflicts when the stash and the branch changed a path differently", async () => {
    const { git } = await buildStashDiamond({
      baseFiles: { "keep.txt": "keep", "shared.txt": "v1" },
      branch: { add: { "shared.txt": "branch-version" } },
      stash: { add: { "shared.txt": "stash-version" } },
    });

    const result = await git.stashApply().call();

    expect(result.status).toBe(StashApplyStatus.CONFLICTS);
    expect(result.conflicts).toEqual(["shared.txt"]);
  });

  it("conflicts on delete/modify between the stash and the branch", async () => {
    const { git } = await buildStashDiamond({
      baseFiles: { "keep.txt": "keep", "contested.txt": "v1" },
      branch: { add: { "contested.txt": "v2" } },
      stash: { remove: ["contested.txt"] },
    });

    const result = await git.stashApply().call();

    expect(result.status).toBe(StashApplyStatus.CONFLICTS);
    expect(result.conflicts).toEqual(["contested.txt"]);
  });

  it("does not conflict on add/add of identical content", async () => {
    const { git } = await buildStashDiamond({
      baseFiles: { "keep.txt": "keep" },
      branch: { add: { "added.txt": "same", "branch-only.txt": "b" } },
      stash: { add: { "added.txt": "same", "stash-only.txt": "s" } },
    });

    const result = await git.stashApply().call();

    expect(result.conflicts).toBeUndefined();
    expect(result.status).toBe(StashApplyStatus.OK);
  });

  it("conflicts when the stash changed only a path's mode and the branch changed its content", async () => {
    const { git } = await buildStashDiamond({
      baseFiles: { "keep.txt": "keep", "script.sh": "#!/bin/sh" },
      branch: { add: { "script.sh": "#!/bin/bash" } },
      // Content byte-identical to base; the only stashed change is the mode.
      // A blob-id-only comparison reads this as "the stash changed nothing
      // here", silently drops the exec bit and reports a clean apply.
      stash: { chmod: { "script.sh": ["#!/bin/sh", FileMode.EXECUTABLE_FILE] } },
    });

    const result = await git.stashApply().call();

    expect(result.status).toBe(StashApplyStatus.CONFLICTS);
    expect(result.conflicts).toEqual(["script.sh"]);
  });

  it("conflicts on add/add of different content", async () => {
    const { git } = await buildStashDiamond({
      baseFiles: { "keep.txt": "keep" },
      branch: { add: { "added.txt": "branch-version" } },
      stash: { add: { "added.txt": "stash-version" } },
    });

    const result = await git.stashApply().call();

    expect(result.status).toBe(StashApplyStatus.CONFLICTS);
    expect(result.conflicts).toEqual(["added.txt"]);
  });

  // A path cannot be a file and a directory at once. When the stash adds the
  // file `a` and the branch adds `a/b` (or the other way round), both take the
  // "only one side changed" branch and land in the merged entry set together;
  // building a tree from that set writes `a` as a file and then overwrites it
  // with the `a/` subtree. The apply then reports OK, so the stash looks
  // applied and is safe to drop while its content is gone. Native git reports
  // `CONFLICT (file/directory)` and preserves the stash.
  describe("file/directory collisions", () => {
    it("conflicts when the stash adds the file `a` and the branch adds `a/b`", async () => {
      const { git } = await buildStashDiamond({
        baseFiles: { "keep.txt": "keep" },
        branch: { add: { "a/b": "directory side" } },
        stash: { add: { a: "file side" } },
      });

      const result = await git.stashApply().call();

      // Before the fix: OK, with "file side" dropped from the restored tree.
      expect(result.status).toBe(StashApplyStatus.CONFLICTS);
      expect(result.conflicts).toEqual(["a"]);
    });

    it("conflicts when the branch adds the file `a` and the stash adds `a/b`", async () => {
      const { git } = await buildStashDiamond({
        baseFiles: { "keep.txt": "keep" },
        branch: { add: { a: "file side" } },
        stash: { add: { "a/b": "directory side" } },
      });

      const result = await git.stashApply().call();

      expect(result.status).toBe(StashApplyStatus.CONFLICTS);
      expect(result.conflicts).toEqual(["a"]);
    });

    it("conflicts when the colliding directory is nested several levels deep", async () => {
      const { git } = await buildStashDiamond({
        baseFiles: { "keep.txt": "keep" },
        branch: { add: { "a/b/c/d": "deep" } },
        stash: { add: { a: "file side" } },
      });

      const result = await git.stashApply().call();

      expect(result.status).toBe(StashApplyStatus.CONFLICTS);
      expect(result.conflicts).toEqual(["a"]);
    });

    it("reports every colliding path when one merge has several", async () => {
      const { git } = await buildStashDiamond({
        baseFiles: { "keep.txt": "keep" },
        branch: { add: { "x/1": "x dir", "y/2": "y dir" } },
        stash: { add: { x: "x file", y: "y file" } },
      });

      const result = await git.stashApply().call();

      expect(result.status).toBe(StashApplyStatus.CONFLICTS);
      expect(result.conflicts).toEqual(["x", "y"]);
    });

    it("reports collisions contributed by either side in a stable order", async () => {
      const { git } = await buildStashDiamond({
        baseFiles: { "keep.txt": "keep" },
        // `d` is a file on the branch and a directory in the stash; `m` is the
        // other way round. The merged set therefore reaches the collision
        // check as `d/1, m, d, m/1`, so reporting it in encounter order would
        // give `["m", "d"]`.
        branch: { add: { d: "d file", "m/1": "m dir" } },
        stash: { add: { "d/1": "d dir", m: "m file" } },
      });

      const result = await git.stashApply().call();

      expect(result.status).toBe(StashApplyStatus.CONFLICTS);
      expect(result.conflicts).toEqual(["d", "m"]);
    });

    it("does not conflict when a file merely shares a name prefix with a directory", async () => {
      const { git } = await buildStashDiamond({
        baseFiles: { "keep.txt": "keep" },
        // `ab` starts with the directory name `a` but is not inside `a/`:
        // matching merged paths against directory names by bare `startsWith`
        // would wrongly report `ab` as colliding.
        branch: { add: { "a/b": "inside a" } },
        stash: { add: { ab: "not inside a" } },
      });

      const result = await git.stashApply().call();

      expect(result.conflicts).toBeUndefined();
      expect(result.status).toBe(StashApplyStatus.OK);
    });

    it("does not conflict when a file merely shares a name prefix with another file", async () => {
      const { git } = await buildStashDiamond({
        baseFiles: { "keep.txt": "keep" },
        // `ab` starts with the file name `a`, but `a` is not a directory
        // prefix of it: asking only whether some other merged path starts
        // with `a`, without requiring the `/`, would wrongly report `a` as
        // colliding. `c/d` keeps a genuine directory in the merged set.
        branch: { add: { ab: "sibling", "c/d": "in a directory" } },
        stash: { add: { a: "file" } },
      });

      const result = await git.stashApply().call();

      expect(result.conflicts).toBeUndefined();
      expect(result.status).toBe(StashApplyStatus.OK);
    });
  });
});
