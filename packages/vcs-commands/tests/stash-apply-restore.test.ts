/**
 * What `stash apply` actually puts back.
 *
 * The sibling suite `stash-apply-three-way-merge.test.ts` pins the *merge
 * semantics* - which paths conflict and which merge cleanly. It deliberately
 * asserts nothing about the working tree, because the command used to compute
 * a merged tree and throw it away.
 *
 * This suite asserts the consequence instead: after a successful apply the
 * stashed content is in the working tree, and - when `restoreIndex` is set -
 * in the staging area. Every assertion reads back through the `Worktree` /
 * `Staging` interfaces the command writes through, never through the result
 * object, so a command that reports OK and restores nothing fails here.
 *
 * Fixture shape:
 *
 *     stashBase (real files)   <- the commit the stash was taken from
 *      |\
 *      | \
 *   branch  stash             <- HEAD may advance to `branch`
 *
 * The stash base carries real file content on purpose: the initial commit's
 * tree is the well-known EMPTY tree, which a content-addressed store answers
 * for without ever having received it, so a fixture anchored on it asserts
 * nothing.
 */

import type { FilesApi, ObjectId } from "@statewalker/vcs-core";
import { createInMemoryFilesApi, FileMode } from "@statewalker/vcs-core";
import { createFileWorktree } from "@statewalker/vcs-store-files";
import {
  createMemoryObjectStores,
  MemoryRefStore,
  MemoryStagingStore,
} from "@statewalker/vcs-store-mem";
import type { WorkingCopy, Worktree } from "@statewalker/vcs-working-tree";
import { MemoryCheckout, MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";

import { Git, StashApplyStatus } from "../src/index.js";
import { createSimpleHistory } from "./simple-history-store.js";
import {
  addFile,
  backends,
  createCommit,
  createInitializedGitFromFactory,
  removeFile,
  testAuthor,
} from "./test-helper.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe.each(backends)("StashApplyCommand restore ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  // ---------------------------------------------------------------- helpers

  /** The worktree of a test WorkingCopy, which the fixtures always provide. */
  function wt(wc: WorkingCopy): Worktree {
    const worktree = wc.worktree;
    if (!worktree) throw new Error("test fixture has no worktree");
    return worktree;
  }

  /** Write a file straight into the working tree, below the command layer. */
  async function putFile(wc: WorkingCopy, path: string, content: string): Promise<void> {
    await wt(wc).writeContent(path, [encoder.encode(content)], {
      mode: FileMode.REGULAR_FILE,
      createParents: true,
    });
  }

  /** Read a file straight out of the working tree. */
  async function getFile(wc: WorkingCopy, path: string): Promise<string> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of wt(wc).readContent(path)) {
      chunks.push(chunk);
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return decoder.decode(joined);
  }

  /** Is the path present in the working tree? */
  async function hasFile(wc: WorkingCopy, path: string): Promise<boolean> {
    return wt(wc).exists(path);
  }

  /** Every staged path, mapped to the blob it is staged at. */
  async function stagedBlobs(wc: WorkingCopy): Promise<Map<string, ObjectId>> {
    const staged = new Map<string, ObjectId>();
    for await (const entry of wc.checkout.staging.entries()) {
      staged.set(entry.path, entry.objectId);
    }
    return staged;
  }

  /** The blob id a given string hashes to in this repository. */
  async function blobOf(wc: WorkingCopy, content: string): Promise<ObjectId> {
    return wc.history.blobs.store([encoder.encode(content)]);
  }

  type Changes = {
    add?: Record<string, string>;
    remove?: string[];
    /** path -> [content, mode]: stage real content with an explicit file mode. */
    withMode?: Record<string, [string, number]>;
    /** path -> [objectId, mode]: stage a raw entry, e.g. a symlink or a gitlink. */
    raw?: Record<string, [ObjectId, number]>;
  };

  /** Stage a raw (objectId, mode) pair, bypassing blob creation. */
  async function addRawEntry(
    wc: WorkingCopy,
    path: string,
    objectId: ObjectId,
    mode: number,
  ): Promise<void> {
    const editor = wc.checkout.staging.createEditor();
    editor.add({
      path,
      apply: () => ({ path, mode, objectId, stage: 0, size: 0, mtime: Date.now() }),
    });
    await editor.finish();
  }

  interface StashFixture {
    baseFiles: Record<string, string>;
    /** What the branch did after the stash was taken; omit to leave HEAD at base. */
    branch?: Changes;
    /** The stash's working tree. */
    stash: Changes;
    /** The stash's index tree; defaults to the working tree. */
    stashIndex?: Changes;
    /** Untracked files recorded alongside the stash (third parent). */
    untracked?: Record<string, string>;
    /** Seed for the working tree; defaults to the HEAD state. */
    worktree?: Record<string, string>;
  }

  /**
   * Build the diamond above, seed the working tree, and leave `refs/stash`
   * and HEAD in place ready for an apply.
   */
  async function buildStash(opts: StashFixture) {
    const init = await createInitializedGitFromFactory(factory);
    const { git, workingCopy, repository, initialCommitId } = init;
    cleanup = init.cleanup;

    const baseCommit = await createCommit(workingCopy, "stash base", opts.baseFiles, [
      initialCommitId,
    ]);
    const baseTree = (await repository.commits.load(baseCommit))?.tree as ObjectId;

    /** Apply `changes` on top of the base tree and write the result out. */
    async function treeFrom(changes: Changes): Promise<ObjectId> {
      await workingCopy.checkout.staging.readTree(repository.trees, baseTree);
      for (const path of changes.remove ?? []) {
        await removeFile(workingCopy, path);
      }
      for (const [path, content] of Object.entries(changes.add ?? {})) {
        await addFile(workingCopy, path, content);
      }
      for (const [path, [content, mode]] of Object.entries(changes.withMode ?? {})) {
        await addRawEntry(workingCopy, path, await blobOf(workingCopy, content), mode);
      }
      for (const [path, [objectId, mode]] of Object.entries(changes.raw ?? {})) {
        await addRawEntry(workingCopy, path, objectId, mode);
      }
      return workingCopy.checkout.staging.writeTree(repository.trees);
    }

    const stashWorkingTree = await treeFrom(opts.stash);
    const stashIndexTree = opts.stashIndex ? await treeFrom(opts.stashIndex) : stashWorkingTree;

    const indexCommit = await repository.commits.store({
      tree: stashIndexTree,
      parents: [baseCommit],
      author: testAuthor(),
      committer: testAuthor(),
      message: "index on main: stash",
    });

    const parents: ObjectId[] = [baseCommit, indexCommit];

    if (opts.untracked) {
      // Untracked files live in their own parentless commit, holding ONLY
      // those files - not a delta on the base tree.
      const emptyTree = await repository.trees.store([]);
      await workingCopy.checkout.staging.readTree(repository.trees, emptyTree);
      for (const [path, content] of Object.entries(opts.untracked)) {
        await addFile(workingCopy, path, content);
      }
      const untrackedTree = await workingCopy.checkout.staging.writeTree(repository.trees);
      parents.push(
        await repository.commits.store({
          tree: untrackedTree,
          parents: [],
          author: testAuthor(),
          committer: testAuthor(),
          message: "untracked files on main: stash",
        }),
      );
    }

    const stashCommit = await repository.commits.store({
      tree: stashWorkingTree,
      parents,
      author: testAuthor(),
      committer: testAuthor(),
      message: "WIP on main: stash",
    });
    await repository.refs.set("refs/stash", stashCommit);

    // Where HEAD ends up, and the working tree that goes with it.
    let headTree = baseTree;
    let headFiles = opts.baseFiles;
    if (opts.branch) {
      headTree = await treeFrom(opts.branch);
      headFiles = { ...opts.baseFiles, ...(opts.branch.add ?? {}) };
      for (const path of opts.branch.remove ?? []) {
        delete (headFiles as Record<string, string>)[path];
      }
      const branchCommit = await repository.commits.store({
        tree: headTree,
        parents: [baseCommit],
        author: testAuthor(),
        committer: testAuthor(),
        message: "branch moved on",
      });
      await repository.refs.set("refs/heads/main", branchCommit);
    }

    // The index and the working tree both start clean at HEAD.
    await workingCopy.checkout.staging.readTree(repository.trees, headTree);
    for (const [path, content] of Object.entries(opts.worktree ?? headFiles)) {
      await putFile(workingCopy, path, content);
    }

    return { git, workingCopy, repository, stashCommit, headTree };
  }

  // ------------------------------------------------------- the working tree

  it("writes a stashed modification into the working tree", async () => {
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep", "data.txt": "base content" },
      stash: { add: { "data.txt": "stashed content" } },
    });
    expect(await getFile(workingCopy, "data.txt")).toBe("base content");

    const result = await git.stashApply().call();

    expect(result.status).toBe(StashApplyStatus.OK);
    expect(await getFile(workingCopy, "data.txt")).toBe("stashed content");
    expect(await getFile(workingCopy, "keep.txt")).toBe("keep");
  });

  it("writes a file the stash added into the working tree", async () => {
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep" },
      stash: { add: { "new.txt": "brand new" } },
    });
    expect(await hasFile(workingCopy, "new.txt")).toBe(false);

    await git.stashApply().call();

    expect(await getFile(workingCopy, "new.txt")).toBe("brand new");
  });

  it("creates parent directories for a nested stashed file", async () => {
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep" },
      stash: { add: { "src/deep/nested.ts": "export const x = 1;" } },
    });

    await git.stashApply().call();

    expect(await getFile(workingCopy, "src/deep/nested.ts")).toBe("export const x = 1;");
  });

  it("deletes from the working tree a file the stash deleted", async () => {
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep", "doomed.txt": "goodbye" },
      stash: { remove: ["doomed.txt"] },
    });
    expect(await hasFile(workingCopy, "doomed.txt")).toBe(true);

    await git.stashApply().call();

    expect(await hasFile(workingCopy, "doomed.txt")).toBe(false);
    expect(await getFile(workingCopy, "keep.txt")).toBe("keep");
  });

  it("keeps a branch-only change the stash never touched", async () => {
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep", "data.txt": "base content" },
      branch: { add: { "branch-only.txt": "from the branch" } },
      stash: { add: { "data.txt": "stashed content" } },
    });

    await git.stashApply().call();

    expect(await getFile(workingCopy, "data.txt")).toBe("stashed content");
    expect(await getFile(workingCopy, "branch-only.txt")).toBe("from the branch");
  });

  it("restores a stashed file's executable bit", async () => {
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep", "script.sh": "#!/bin/sh" },
      stash: { withMode: { "script.sh": ["#!/bin/sh\necho hi", FileMode.EXECUTABLE_FILE] } },
    });

    await git.stashApply().call();

    expect(await getFile(workingCopy, "script.sh")).toBe("#!/bin/sh\necho hi");
    expect((await wt(workingCopy).getEntry("script.sh"))?.mode).toBe(FileMode.EXECUTABLE_FILE);
  });

  it("leaves the working tree untouched when the apply conflicts", async () => {
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep", "contested.txt": "v1" },
      branch: { add: { "contested.txt": "branch version" } },
      stash: { add: { "contested.txt": "stash version" } },
      // Uncommitted local work, which a conflicting apply must not overwrite
      // with HEAD's content on its way out.
      worktree: { "keep.txt": "keep", "contested.txt": "LOCAL WORK IN PROGRESS" },
    });

    const result = await git.stashApply().call();

    expect(result.status).toBe(StashApplyStatus.CONFLICTS);
    expect(await getFile(workingCopy, "contested.txt")).toBe("LOCAL WORK IN PROGRESS");
  });

  it("leaves the working tree untouched on a conflict even with restoreIndex off", async () => {
    // With restoreIndex on, the index merge conflicts too and aborts second.
    // With it off there is only one guard left, so this is what actually pins
    // the working-tree merge's own abort.
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep", "contested.txt": "v1" },
      branch: { add: { "contested.txt": "branch version" } },
      stash: { add: { "contested.txt": "stash version" } },
      worktree: { "keep.txt": "keep", "contested.txt": "LOCAL WORK IN PROGRESS" },
    });

    const result = await git.stashApply().setRestoreIndex(false).call();

    expect(result.status).toBe(StashApplyStatus.CONFLICTS);
    expect(await getFile(workingCopy, "contested.txt")).toBe("LOCAL WORK IN PROGRESS");
  });

  // -------------------------------------------------------------- the index

  it("stages the merged index tree when restoreIndex is on (the default)", async () => {
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep", "data.txt": "base content" },
      stash: { add: { "data.txt": "stashed content" } },
    });

    await git.stashApply().call();

    const staged = await stagedBlobs(workingCopy);
    expect(staged.get("data.txt")).toBe(await blobOf(workingCopy, "stashed content"));
  });

  it("stages the stash's INDEX tree, not its working tree", async () => {
    // The stash recorded "staged content" in the index and "working content"
    // in the working tree. Restoring the working tree into the index would
    // lose the distinction the index commit exists to preserve.
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep", "data.txt": "base content" },
      stash: { add: { "data.txt": "working content" } },
      stashIndex: { add: { "data.txt": "staged content" } },
    });

    await git.stashApply().call();

    const staged = await stagedBlobs(workingCopy);
    expect(staged.get("data.txt")).toBe(await blobOf(workingCopy, "staged content"));
    expect(await getFile(workingCopy, "data.txt")).toBe("working content");
  });

  it("stages a path the stash deleted as deleted", async () => {
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep", "doomed.txt": "goodbye" },
      stash: { remove: ["doomed.txt"] },
    });

    await git.stashApply().call();

    const staged = await stagedBlobs(workingCopy);
    expect(staged.has("doomed.txt")).toBe(false);
    expect(staged.has("keep.txt")).toBe(true);
  });

  it("leaves the index at HEAD when restoreIndex is off, but still restores the working tree", async () => {
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep", "data.txt": "base content" },
      stash: { add: { "data.txt": "stashed content" } },
    });
    const before = await stagedBlobs(workingCopy);

    await git.stashApply().setRestoreIndex(false).call();

    expect(await stagedBlobs(workingCopy)).toEqual(before);
    expect(await getFile(workingCopy, "data.txt")).toBe("stashed content");
  });

  // ---------------------------------------------------------- untracked files

  it("writes the stashed untracked files when restoreUntracked is on (the default)", async () => {
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep" },
      stash: { add: { "data.txt": "stashed content" } },
      untracked: { "scratch.log": "untracked scratch", "tmp/notes.md": "untracked notes" },
    });

    await git.stashApply().call();

    expect(await getFile(workingCopy, "scratch.log")).toBe("untracked scratch");
    expect(await getFile(workingCopy, "tmp/notes.md")).toBe("untracked notes");
  });

  it("does not stage restored untracked files - they stay untracked", async () => {
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep" },
      stash: { add: { "data.txt": "stashed content" } },
      untracked: { "scratch.log": "untracked scratch" },
    });

    await git.stashApply().call();

    const staged = await stagedBlobs(workingCopy);
    expect(staged.has("scratch.log")).toBe(false);
  });

  it("does not write the stashed untracked files when restoreUntracked is off", async () => {
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep" },
      stash: { add: { "data.txt": "stashed content" } },
      untracked: { "scratch.log": "untracked scratch" },
    });

    await git.stashApply().setRestoreUntracked(false).call();

    expect(await hasFile(workingCopy, "scratch.log")).toBe(false);
    // The tracked half still lands.
    expect(await getFile(workingCopy, "data.txt")).toBe("stashed content");
  });

  it("refuses to overwrite an existing file with a stashed untracked one", async () => {
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep" },
      stash: { add: { "data.txt": "stashed content" } },
      untracked: { "scratch.log": "untracked scratch" },
      worktree: { "keep.txt": "keep", "scratch.log": "PRECIOUS LOCAL DATA" },
    });

    await expect(git.stashApply().call()).rejects.toThrow(/scratch\.log/);

    expect(await getFile(workingCopy, "scratch.log")).toBe("PRECIOUS LOCAL DATA");
    // Nothing else was written either - the refusal comes before any write.
    expect(await hasFile(workingCopy, "data.txt")).toBe(false);
  });

  // -------------------------------------------------- what it will not do

  it("refuses to restore a symlink rather than writing it as a regular file", async () => {
    // The symlink target's blob id is irrelevant: the mode is rejected before
    // any blob is looked up.
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep" },
      stash: { raw: { link: ["1234abcd".repeat(5), FileMode.SYMLINK] } },
    });

    await expect(git.stashApply().call()).rejects.toThrow(/symbolic links/);
    expect(await hasFile(workingCopy, "link")).toBe(false);
  });

  it("neither writes nor deletes a gitlink", async () => {
    // A submodule's contents are not the stash's to restore - but the path is
    // still accounted for, so it must not be mistaken for one the stash deleted.
    const gitlink = "abcd1234".repeat(5);
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep" },
      stash: {
        add: { "data.txt": "stashed content" },
        raw: { sub: [gitlink, FileMode.GITLINK] },
      },
      worktree: { "keep.txt": "keep", sub: "submodule working copy" },
    });
    // `sub` is tracked, so a restore that forgot about gitlinks would remove it.
    await addRawEntry(workingCopy, "sub", gitlink, FileMode.GITLINK);

    await git.stashApply().call();

    expect(await getFile(workingCopy, "sub")).toBe("submodule working copy");
    expect(await getFile(workingCopy, "data.txt")).toBe("stashed content");
  });

  it("refuses to restore a tree whose blob is missing, before touching the working tree", async () => {
    const missing = "deadbeef".repeat(5);
    const { git, workingCopy } = await buildStash({
      baseFiles: { "keep.txt": "keep", "data.txt": "base content" },
      stash: {
        add: { "data.txt": "stashed content" },
        raw: { "ghost.txt": [missing, FileMode.REGULAR_FILE] },
      },
    });

    await expect(git.stashApply().call()).rejects.toThrow(/ghost\.txt/);

    expect(await getFile(workingCopy, "data.txt")).toBe("base content");
  });

  it("refuses to apply a stash in a repository with no working tree", async () => {
    const init = await createInitializedGitFromFactory(factory);
    cleanup = init.cleanup;
    const { workingCopy, repository, initialCommitId } = init;

    const baseCommit = await createCommit(workingCopy, "stash base", { "keep.txt": "keep" }, [
      initialCommitId,
    ]);
    const baseTree = (await repository.commits.load(baseCommit))?.tree as ObjectId;
    await addFile(workingCopy, "data.txt", "stashed content");
    const stashTree = await workingCopy.checkout.staging.writeTree(repository.trees);
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
    await workingCopy.checkout.staging.readTree(repository.trees, baseTree);

    // Same history and index, but no worktree at all.
    const bare = new MemoryWorkingCopy({
      history: repository,
      checkout: new MemoryCheckout({ staging: workingCopy.checkout.staging }),
    });

    await expect(Git.fromWorkingCopy(bare).stashApply().call()).rejects.toThrow(/working tree/i);
  });
});

/**
 * The same restore against a REAL worktree implementation.
 *
 * The suite above drives MockWorktree, whose storage is a flat map: it cannot
 * tell a missing parent directory from a present one. This one runs an apply
 * through `createFileWorktree` over a real `FilesApi` and reads the result
 * back below the Worktree layer, so the evidence is not an artifact of the
 * double.
 */
describe("StashApplyCommand restore on a real FileWorktree", () => {
  const ROOT = "/repo";

  /** Read a file straight out of the FilesApi, under the worktree root. */
  async function readFile(files: FilesApi, path: string): Promise<string> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of files.read(`${ROOT}/${path}`)) {
      chunks.push(chunk);
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return decoder.decode(joined);
  }

  it("writes, nests, deletes and restores untracked files on the filesystem", async () => {
    const files = createInMemoryFilesApi();
    const stores = createMemoryObjectStores();
    const refs = new MemoryRefStore();
    const staging = new MemoryStagingStore();
    const repository = createSimpleHistory({
      blobs: stores.blobs,
      trees: stores.trees,
      commits: stores.commits,
      tags: stores.tags,
      refs,
    });
    const workingCopy = new MemoryWorkingCopy({
      history: repository,
      checkout: new MemoryCheckout({ staging }),
      worktree: createFileWorktree({
        files,
        rootPath: ROOT,
        gitDir: ".git",
        blobs: stores.blobs,
        trees: stores.trees,
      }),
    });
    const git = Git.fromWorkingCopy(workingCopy);

    const emptyTree = await repository.trees.store([]);
    const initialCommit = await repository.commits.store({
      tree: emptyTree,
      parents: [],
      author: testAuthor(),
      committer: testAuthor(),
      message: "Initial commit",
    });
    await repository.refs.set("refs/heads/main", initialCommit);
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    await staging.readTree(repository.trees, emptyTree);

    const baseFiles = { "data.txt": "base content", "doomed.txt": "goodbye" };
    const baseCommit = await createCommit(workingCopy, "stash base", baseFiles, [initialCommit]);
    const baseTree = (await repository.commits.load(baseCommit))?.tree as ObjectId;

    // The stash: data.txt edited, a nested file added, doomed.txt deleted.
    await staging.readTree(repository.trees, baseTree);
    await removeFile(workingCopy, "doomed.txt");
    await addFile(workingCopy, "data.txt", "stashed content");
    await addFile(workingCopy, "src/deep/nested.ts", "export const x = 1;");
    const stashTree = await staging.writeTree(repository.trees);

    // ...plus one untracked file, in its own parentless commit.
    await staging.readTree(repository.trees, emptyTree);
    await addFile(workingCopy, "logs/scratch.log", "untracked scratch");
    const untrackedTree = await staging.writeTree(repository.trees);

    const indexCommit = await repository.commits.store({
      tree: stashTree,
      parents: [baseCommit],
      author: testAuthor(),
      committer: testAuthor(),
      message: "index on main: stash",
    });
    const untrackedCommit = await repository.commits.store({
      tree: untrackedTree,
      parents: [],
      author: testAuthor(),
      committer: testAuthor(),
      message: "untracked files on main: stash",
    });
    const stashCommit = await repository.commits.store({
      tree: stashTree,
      parents: [baseCommit, indexCommit, untrackedCommit],
      author: testAuthor(),
      committer: testAuthor(),
      message: "WIP on main: stash",
    });
    await repository.refs.set("refs/stash", stashCommit);

    // The index and the filesystem both start clean at the stash base.
    await staging.readTree(repository.trees, baseTree);
    for (const [path, content] of Object.entries(baseFiles)) {
      await files.write(`${ROOT}/${path}`, [encoder.encode(content)]);
    }

    await git.stashApply().call();

    expect(await readFile(files, "data.txt")).toBe("stashed content");
    expect(await readFile(files, "src/deep/nested.ts")).toBe("export const x = 1;");
    expect(await files.exists(`${ROOT}/doomed.txt`)).toBe(false);
    expect(await readFile(files, "logs/scratch.log")).toBe("untracked scratch");
  });
});
