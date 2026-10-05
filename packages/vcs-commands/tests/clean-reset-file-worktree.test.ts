/**
 * `clean` and `reset --hard` against a REAL worktree implementation.
 *
 * The clean-command / reset-command suites drive MockWorktree. This file runs
 * the same destructive operations through `createFileWorktree` over a real
 * FilesApi, so the evidence is not an artifact of the test double: assertions
 * here read the filesystem back through FilesApi, below the Worktree layer the
 * commands write through.
 */

import { createInMemoryFilesApi, type FilesApi } from "@statewalker/vcs-core";
import { createFileWorktree } from "@statewalker/vcs-store-files";
import {
  createMemoryObjectStores,
  MemoryRefStore,
  MemoryStagingStore,
} from "@statewalker/vcs-store-mem";
import { MemoryCheckout, MemoryWorkingCopy, type WorkingCopy } from "@statewalker/vcs-working-tree";
import { describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { ResetMode } from "../src/types.js";
import { createSimpleHistory } from "./simple-history-store.js";
import { createCommit, testAuthor } from "./test-helper.js";

const ROOT = "/repo";

/** Build a WorkingCopy whose worktree is a real FileWorktree over `files`. */
function createFileBackedWorkingCopy(files: FilesApi): WorkingCopy {
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

  const worktree = createFileWorktree({
    files,
    rootPath: ROOT,
    gitDir: ".git",
    blobs: stores.blobs,
    trees: stores.trees,
  });

  return new MemoryWorkingCopy({
    history: repository,
    checkout: new MemoryCheckout({ staging }),
    worktree,
  });
}

/** Write a file directly through FilesApi, under the worktree root. */
async function putFile(files: FilesApi, path: string, content: string): Promise<void> {
  await files.write(`${ROOT}/${path}`, [new TextEncoder().encode(content)]);
}

/** Read a file directly through FilesApi, under the worktree root. */
async function getFile(files: FilesApi, path: string): Promise<string> {
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
  return new TextDecoder().decode(joined);
}

/** Does the file exist on the real filesystem? */
async function hasFile(files: FilesApi, path: string): Promise<boolean> {
  return files.exists(`${ROOT}/${path}`);
}

/** Initialize HEAD -> refs/heads/main with a real (non-empty) first commit. */
async function initRepo(workingCopy: WorkingCopy): Promise<void> {
  const emptyTreeId = await workingCopy.history.trees.store([]);
  const initialCommitId = await workingCopy.history.commits.store({
    tree: emptyTreeId,
    parents: [],
    author: testAuthor(),
    committer: testAuthor(),
    message: "Initial commit",
  });
  await workingCopy.history.refs.set("refs/heads/main", initialCommitId);
  await workingCopy.history.refs.setSymbolic("HEAD", "refs/heads/main");
  await workingCopy.checkout.staging.readTree(workingCopy.history.trees, emptyTreeId);
}

describe("clean / reset --hard on a real FileWorktree", () => {
  it("clean with dryRun:false should delete the untracked file from the filesystem", async () => {
    const files = createInMemoryFilesApi();
    const workingCopy = createFileBackedWorkingCopy(files);
    const git = Git.fromWorkingCopy(workingCopy);
    await initRepo(workingCopy);

    await createCommit(workingCopy, "Add tracked", { "tracked.txt": "tracked content" });
    await putFile(files, "tracked.txt", "tracked content");
    await putFile(files, "junk.log", "untracked garbage");
    expect(await hasFile(files, "junk.log")).toBe(true);

    const result = await git.clean().setDryRun(false).call();

    expect(await hasFile(files, "junk.log")).toBe(false);
    expect(await hasFile(files, "tracked.txt")).toBe(true);
    expect(result.dryRun).toBe(false);
  });

  it("clean with dryRun:true should leave the untracked file on the filesystem", async () => {
    const files = createInMemoryFilesApi();
    const workingCopy = createFileBackedWorkingCopy(files);
    const git = Git.fromWorkingCopy(workingCopy);
    await initRepo(workingCopy);

    await createCommit(workingCopy, "Add tracked", { "tracked.txt": "tracked content" });
    await putFile(files, "tracked.txt", "tracked content");
    await putFile(files, "junk.log", "untracked garbage");

    const result = await git.clean().setDryRun(true).call();

    expect(result.cleaned.has("junk.log")).toBe(true);
    expect(await hasFile(files, "junk.log")).toBe(true);
    expect(result.dryRun).toBe(true);
  });

  it("reset --hard should overwrite a modified file's content on the filesystem", async () => {
    const files = createInMemoryFilesApi();
    const workingCopy = createFileBackedWorkingCopy(files);
    const git = Git.fromWorkingCopy(workingCopy);
    await initRepo(workingCopy);

    const commitId = await createCommit(workingCopy, "Add data", {
      "data.txt": "committed content",
    });
    await putFile(files, "data.txt", "LOCAL GARBAGE");
    expect(await getFile(files, "data.txt")).toBe("LOCAL GARBAGE");

    await git.reset().setRef(commitId).setMode(ResetMode.HARD).call();

    expect(await getFile(files, "data.txt")).toBe("committed content");
  });

  it("reset --hard should delete a tracked file absent from the target commit", async () => {
    const files = createInMemoryFilesApi();
    const workingCopy = createFileBackedWorkingCopy(files);
    const git = Git.fromWorkingCopy(workingCopy);
    await initRepo(workingCopy);

    const baseId = await createCommit(workingCopy, "Base", { "keep.txt": "base content" });
    await createCommit(workingCopy, "Add extra", { "extra.txt": "extra content" });
    await putFile(files, "keep.txt", "base content");
    await putFile(files, "extra.txt", "extra content");

    await git.reset().setRef(baseId).setMode(ResetMode.HARD).call();

    expect(await hasFile(files, "extra.txt")).toBe(false);
    expect(await getFile(files, "keep.txt")).toBe("base content");
  });

  it("reset --hard should recreate nested files the user deleted", async () => {
    const files = createInMemoryFilesApi();
    const workingCopy = createFileBackedWorkingCopy(files);
    const git = Git.fromWorkingCopy(workingCopy);
    await initRepo(workingCopy);

    const commitId = await createCommit(workingCopy, "Add nested", {
      "src/deep/nested.ts": "export const x = 1;",
    });
    expect(await hasFile(files, "src/deep/nested.ts")).toBe(false);

    await git.reset().setRef(commitId).setMode(ResetMode.HARD).call();

    expect(await getFile(files, "src/deep/nested.ts")).toBe("export const x = 1;");
  });
});
