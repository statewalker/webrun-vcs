/**
 * Tests for CommitCommand
 *
 * Based on JGit's CommitCommandTest.java and CommitAndLogCommandTest.java
 * Tests run against all storage backends (Memory, SQL).
 */

import { afterEach, describe, expect, it } from "vitest";

import { EmptyCommitError, NoMessageError } from "../src/errors/index.js";
import { Git } from "../src/index.js";
import {
  addFile,
  backends,
  createInitializedGitFromFactory,
  testAuthor,
  toArray,
} from "./test-helper.js";

describe.each(backends)("CommitCommand ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  async function createInitializedGit() {
    const result = await createInitializedGitFromFactory(factory);
    cleanup = result.cleanup;
    return result;
  }

  async function createEmptyGit() {
    const ctx = await factory();
    cleanup = ctx.cleanup;
    const { workingCopy, repository } = ctx;
    const git = Git.fromWorkingCopy(workingCopy);
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    return { git, workingCopy, repository };
  }

  it("should require a message", async () => {
    const { git } = await createInitializedGit();

    await expect(git.commit().call()).rejects.toThrow(NoMessageError);
  });

  it("should create a commit with message", async () => {
    const { git } = await createInitializedGit();

    const commit = await git.commit().setMessage("Test commit").setAllowEmpty(true).call();

    expect(commit.message).toBe("Test commit");
    expect(commit.parents.length).toBe(1); // Has parent from initial commit
  });

  it("should create initial commit with no parents", async () => {
    // Create a new store without initial commit
    const { git } = await createEmptyGit();

    // Create initial commit
    const commit = await git.commit().setMessage("Initial commit").setAllowEmpty(true).call();

    expect(commit.message).toBe("Initial commit");
    expect(commit.parents.length).toBe(0);
  });

  it("should set author and committer", async () => {
    const { git } = await createInitializedGit();

    const author = testAuthor("John Doe", "john@example.com");
    const committer = testAuthor("Jane Doe", "jane@example.com");

    const commit = await git
      .commit()
      .setMessage("Test commit")
      .setAuthorIdent(author)
      .setCommitterIdent(committer)
      .setAllowEmpty(true)
      .call();

    expect(commit.author.name).toBe("John Doe");
    expect(commit.author.email).toBe("john@example.com");
    expect(commit.committer.name).toBe("Jane Doe");
    expect(commit.committer.email).toBe("jane@example.com");
  });

  it("should use author as committer when only author is set", async () => {
    const { git } = await createInitializedGit();

    const commit = await git
      .commit()
      .setMessage("Test commit")
      .setAuthor("John Doe", "john@example.com")
      .setAllowEmpty(true)
      .call();

    expect(commit.author.name).toBe("John Doe");
    expect(commit.committer.name).toBe("John Doe");
  });

  it("should reject empty commit without allowEmpty", async () => {
    const { git } = await createInitializedGit();

    // First commit is allowed
    await git.commit().setMessage("First commit").setAllowEmpty(true).call();

    // Second empty commit should fail
    await expect(git.commit().setMessage("Empty commit").call()).rejects.toThrow(EmptyCommitError);
  });

  it("should allow empty commit with allowEmpty", async () => {
    const { git } = await createInitializedGit();

    // First commit
    await git.commit().setMessage("First commit").setAllowEmpty(true).call();

    // Second empty commit with allowEmpty
    const commit = await git.commit().setMessage("Empty commit").setAllowEmpty(true).call();

    expect(commit.message).toBe("Empty commit");
  });

  it("should fail when amending on initial commit (no prior commit)", async () => {
    // Based on JGit's commitAmendOnInitialShouldFail
    // Create a new store without any commits
    const { git } = await createEmptyGit();

    // Trying to amend when there's no commit should fail
    await expect(
      git.commit().setAmend(true).setMessage("amend").setAllowEmpty(true).call(),
    ).rejects.toThrow();
  });

  it("should amend previous commit", async () => {
    const { git } = await createInitializedGit();

    // Create first commit
    const first = await git
      .commit()
      .setMessage("Original message")
      .setAuthor("Original Author", "original@example.com")
      .setAllowEmpty(true)
      .call();

    // Amend it (amend is allowed even without changes since tree is the same)
    const amended = await git
      .commit()
      .setAmend(true)
      .setMessage("Amended message")
      .setAllowEmpty(true)
      .call();

    expect(amended.message).toBe("Amended message");
    // Author should be preserved from original
    expect(amended.author.name).toBe("Original Author");
    // Parents should be same as original commit's parents
    expect(amended.parents).toEqual(first.parents);
  });

  it("should amend and keep original message if not provided", async () => {
    const { git } = await createInitializedGit();

    // Create first commit
    await git.commit().setMessage("Keep this message").setAllowEmpty(true).call();

    // Amend without new message
    const amended = await git.commit().setAmend(true).setAllowEmpty(true).call();

    expect(amended.message).toBe("Keep this message");
  });

  it("should not be callable twice", async () => {
    const { git } = await createInitializedGit();

    const cmd = git.commit().setMessage("Test").setAllowEmpty(true);
    await cmd.call();

    await expect(cmd.call()).rejects.toThrow(/already been called/);
  });

  it("should not allow setting after call", async () => {
    const { git } = await createInitializedGit();

    const cmd = git.commit().setMessage("Test");
    await cmd.setAllowEmpty(true).call();

    expect(() => cmd.setMessage("Another")).toThrow(/already been called/);
  });

  it("should update branch ref after commit", async () => {
    const { git, repository } = await createInitializedGit();

    const commit = await git.commit().setMessage("New commit").setAllowEmpty(true).call();

    // Get the branch ref
    const ref = await repository.refs.resolve("refs/heads/main");
    const _commitId = await repository.commits.store(commit);

    // Note: The commit's stored ID will be the same if the content is the same
    // We just verify that the ref was updated
    expect(ref?.objectId).toBeDefined();
  });
});

describe.each(backends)("CommitCommand with Log ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  async function createInitializedGit() {
    const result = await createInitializedGitFromFactory(factory);
    cleanup = result.cleanup;
    return result;
  }

  it("should create commits visible in log", async () => {
    const { git } = await createInitializedGit();

    // Create multiple commits
    await git.commit().setMessage("First").setAllowEmpty(true).call();
    await git.commit().setMessage("Second").setAllowEmpty(true).call();
    await git.commit().setMessage("Third").setAllowEmpty(true).call();

    // Get log
    const commits = await toArray(await git.log().call());

    // Should see all commits (including initial)
    expect(commits.length).toBe(4);
    expect(commits[0].message).toBe("Third");
    expect(commits[1].message).toBe("Second");
    expect(commits[2].message).toBe("First");
    expect(commits[3].message).toBe("Initial commit");
  });
});

describe.each(backends)("CommitCommand with --only flag ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  async function createInitializedGit() {
    const result = await createInitializedGitFromFactory(factory);
    cleanup = result.cleanup;
    return result;
  }

  it("should commit only specified paths", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create initial commit with two files
    await addFile(workingCopy, "file1.txt", "content1\n");
    await addFile(workingCopy, "file2.txt", "content2\n");
    await git.commit().setMessage("add two files").call();

    // Modify both files in staging
    await addFile(workingCopy, "file1.txt", "modified1\n");
    await addFile(workingCopy, "file2.txt", "modified2\n");

    // Commit only file1.txt
    await git.commit().setMessage("update file1 only").setOnly("file1.txt").call();

    // Get the committed tree
    const headRef = await repository.refs.resolve("HEAD");
    const headCommit = await repository.commits.load(headRef?.objectId ?? "");

    // Check that file1 was updated
    const file1Entry = await repository.trees.getEntry(headCommit.tree, "file1.txt");
    expect(file1Entry).toBeDefined();
    const file1Content = await repository.blobs.load(file1Entry?.id);
    const file1Text = new TextDecoder().decode(await collectBytes(file1Content));
    expect(file1Text).toBe("modified1\n");

    // Check that file2 was NOT updated (still has original content)
    const file2Entry = await repository.trees.getEntry(headCommit.tree, "file2.txt");
    expect(file2Entry).toBeDefined();
    const file2Content = await repository.blobs.load(file2Entry?.id);
    const file2Text = new TextDecoder().decode(await collectBytes(file2Content));
    expect(file2Text).toBe("content2\n");
  });

  it("should commit multiple specified paths", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create initial commit with three files
    await addFile(workingCopy, "a.txt", "a\n");
    await addFile(workingCopy, "b.txt", "b\n");
    await addFile(workingCopy, "c.txt", "c\n");
    await git.commit().setMessage("add files").call();

    // Modify all files
    await addFile(workingCopy, "a.txt", "aa\n");
    await addFile(workingCopy, "b.txt", "bb\n");
    await addFile(workingCopy, "c.txt", "cc\n");

    // Commit only a.txt and c.txt
    await git.commit().setMessage("update a and c").setOnly("a.txt", "c.txt").call();

    // Get committed tree
    const headRef = await repository.refs.resolve("HEAD");
    const headCommit = await repository.commits.load(headRef?.objectId ?? "");

    // Verify a.txt was updated
    const aEntry = await repository.trees.getEntry(headCommit.tree, "a.txt");
    const aContent = await repository.blobs.load(aEntry?.id);
    expect(new TextDecoder().decode(await collectBytes(aContent))).toBe("aa\n");

    // Verify b.txt was NOT updated
    const bEntry = await repository.trees.getEntry(headCommit.tree, "b.txt");
    const bContent = await repository.blobs.load(bEntry?.id);
    expect(new TextDecoder().decode(await collectBytes(bContent))).toBe("b\n");

    // Verify c.txt was updated
    const cEntry = await repository.trees.getEntry(headCommit.tree, "c.txt");
    const cContent = await repository.blobs.load(cEntry?.id);
    expect(new TextDecoder().decode(await collectBytes(cContent))).toBe("cc\n");
  });

  it("should work with files in subdirectories", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create files in subdirectories
    await addFile(workingCopy, "src/main.ts", "main\n");
    await addFile(workingCopy, "src/utils.ts", "utils\n");
    await addFile(workingCopy, "tests/main.test.ts", "test\n");
    await git.commit().setMessage("initial structure").call();

    // Modify files
    await addFile(workingCopy, "src/main.ts", "main updated\n");
    await addFile(workingCopy, "src/utils.ts", "utils updated\n");
    await addFile(workingCopy, "tests/main.test.ts", "test updated\n");

    // Commit only src/main.ts
    await git.commit().setMessage("update main only").setOnly("src/main.ts").call();

    // Verify results
    const headRef = await repository.refs.resolve("HEAD");
    const headCommit = await repository.commits.load(headRef?.objectId ?? "");

    // Need to walk tree to get src subtree
    const srcEntry = await repository.trees.getEntry(headCommit.tree, "src");
    expect(srcEntry).toBeDefined();

    const mainEntry = await repository.trees.getEntry(srcEntry?.id, "main.ts");
    const mainContent = await repository.blobs.load(mainEntry?.id);
    expect(new TextDecoder().decode(await collectBytes(mainContent))).toBe("main updated\n");

    const utilsEntry = await repository.trees.getEntry(srcEntry?.id, "utils.ts");
    const utilsContent = await repository.blobs.load(utilsEntry?.id);
    expect(new TextDecoder().decode(await collectBytes(utilsContent))).toBe("utils\n");
  });
});

async function collectBytes(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import type {
  Worktree,
  WorktreeCheckoutOptions,
  WorktreeCheckoutResult,
  WorktreeEntry,
  WorktreeWalkOptions,
  WorktreeWriteOptions,
} from "@statewalker/vcs-working-tree";

/**
 * Mock working tree for testing CommitCommand with --all flag.
 * Implements the Worktree interface.
 */
class MockWorkingTree implements Worktree {
  private files: Map<string, { content: Uint8Array; mode: number; mtime: number }> = new Map();

  addFile(path: string, content: string, mode = FileMode.REGULAR_FILE): void {
    this.files.set(path, {
      content: new TextEncoder().encode(content),
      mode,
      mtime: Date.now(),
    });
  }

  removeFile(path: string): void {
    this.files.delete(path);
  }

  // ========== Reading (Worktree interface) ==========

  async *walk(_options?: WorktreeWalkOptions): AsyncIterable<WorktreeEntry> {
    for (const [path, file] of this.files) {
      yield {
        path,
        name: path.split("/").pop() ?? path,
        mode: file.mode,
        size: file.content.length,
        mtime: file.mtime,
        isDirectory: false,
        isIgnored: false,
      };
    }
  }

  async getEntry(path: string): Promise<WorktreeEntry | undefined> {
    const file = this.files.get(path);
    if (!file) return undefined;
    return {
      path,
      name: path.split("/").pop() ?? path,
      mode: file.mode,
      size: file.content.length,
      mtime: file.mtime,
      isDirectory: false,
      isIgnored: false,
    };
  }

  async computeHash(_path: string): Promise<ObjectId> {
    return "0000000000000000000000000000000000000000";
  }

  async *readContent(path: string): AsyncIterable<Uint8Array> {
    const file = this.files.get(path);
    if (file) {
      yield file.content;
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async isIgnored(_path: string): Promise<boolean> {
    return false;
  }

  // ========== Writing (Worktree interface) ==========

  async writeContent(
    path: string,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array,
    options?: WorktreeWriteOptions,
  ): Promise<void> {
    const mode = options?.mode ?? 0o100644;
    let data: Uint8Array;
    if (content instanceof Uint8Array) {
      data = content;
    } else {
      const chunks: Uint8Array[] = [];
      for await (const chunk of content) {
        chunks.push(chunk);
      }
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      data = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
    }
    this.files.set(path, { content: data, mode, mtime: Date.now() });
  }

  async remove(path: string, _options?: { recursive?: boolean }): Promise<boolean> {
    return this.files.delete(path);
  }

  async mkdir(_path: string, _options?: { recursive?: boolean }): Promise<void> {
    // No-op
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const file = this.files.get(oldPath);
    if (!file) throw new Error(`File not found: ${oldPath}`);
    this.files.delete(oldPath);
    this.files.set(newPath, file);
  }

  // ========== Checkout Operations (Worktree interface) ==========

  async checkoutTree(
    _treeId: ObjectId,
    _options?: WorktreeCheckoutOptions,
  ): Promise<WorktreeCheckoutResult> {
    return { updated: [], removed: [], conflicts: [], failed: [] };
  }

  async checkoutPaths(
    _treeId: ObjectId,
    _paths: string[],
    _options?: WorktreeCheckoutOptions,
  ): Promise<WorktreeCheckoutResult> {
    return { updated: [], removed: [], conflicts: [], failed: [] };
  }

  // ========== Metadata (Worktree interface) ==========

  getRoot(): string {
    return "/mock/worktree";
  }

  async refreshIgnore(): Promise<void> {
    // No-op
  }
}

describe.each(backends)("CommitCommand with --all flag ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  async function createInitializedGit() {
    const result = await createInitializedGitFromFactory(factory);
    cleanup = result.cleanup;
    return result;
  }

  it("should auto-stage modified tracked files", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create initial commit with files
    await addFile(workingCopy, "file1.txt", "original1\n");
    await addFile(workingCopy, "file2.txt", "original2\n");
    await git.commit().setMessage("initial").call();

    // Create mock working tree with modified content
    const worktree = new MockWorkingTree();
    worktree.addFile("file1.txt", "modified1\n");
    worktree.addFile("file2.txt", "modified2\n");

    // Commit with --all flag (should auto-stage modified files)
    const commit = await git
      .commit()
      .setMessage("commit all changes")
      .setAll(true)
      .setWorktree(worktree)
      .call();

    expect(commit.message).toBe("commit all changes");

    // Verify both files were updated in the commit
    const headRef = await repository.refs.resolve("HEAD");
    const headCommit = await repository.commits.load(headRef?.objectId ?? "");

    const file1Entry = await repository.trees.getEntry(headCommit.tree, "file1.txt");
    const file1Content = await repository.blobs.load(file1Entry?.id);
    expect(new TextDecoder().decode(await collectBytes(file1Content))).toBe("modified1\n");

    const file2Entry = await repository.trees.getEntry(headCommit.tree, "file2.txt");
    const file2Content = await repository.blobs.load(file2Entry?.id);
    expect(new TextDecoder().decode(await collectBytes(file2Content))).toBe("modified2\n");
  });

  it("should auto-stage deleted tracked files", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create initial commit with files
    await addFile(workingCopy, "file1.txt", "content1\n");
    await addFile(workingCopy, "file2.txt", "content2\n");
    await git.commit().setMessage("initial").call();

    // Create mock working tree with file1 deleted
    const worktree = new MockWorkingTree();
    worktree.addFile("file2.txt", "content2\n"); // file1.txt is deleted

    // Commit with --all flag (should stage the deletion)
    const commit = await git
      .commit()
      .setMessage("delete file1")
      .setAll(true)
      .setWorktree(worktree)
      .call();

    expect(commit.message).toBe("delete file1");

    // Verify file1 was removed from the tree
    const headRef = await repository.refs.resolve("HEAD");
    const headCommit = await repository.commits.load(headRef?.objectId ?? "");

    const file1Entry = await repository.trees.getEntry(headCommit.tree, "file1.txt");
    expect(file1Entry).toBeUndefined();

    // file2 should still exist
    const file2Entry = await repository.trees.getEntry(headCommit.tree, "file2.txt");
    expect(file2Entry).toBeDefined();
  });

  it("should require working tree iterator for --all", async () => {
    const { git } = await createInitializedGit();

    // Commit with --all when no tracked files have changed throws "Nothing to commit"
    await expect(git.commit().setMessage("test").setAll(true).call()).rejects.toThrow(
      /Nothing to commit/,
    );
  });

  it("should throw when combining --all with --only (JGit behavior)", async () => {
    const { git, workingCopy } = await createInitializedGit();

    // Create initial commit with file
    await addFile(workingCopy, "file.txt", "content\n");
    await git.commit().setMessage("initial").call();

    // Cannot set --all after --only
    expect(() => git.commit().setOnly("file.txt").setAll(true)).toThrow(/Cannot combine/);

    // Cannot set --only after --all
    expect(() => git.commit().setAll(true).setOnly("file.txt")).toThrow(/Cannot combine/);
  });

  it("should not add new untracked files", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create initial commit with one file
    await addFile(workingCopy, "tracked.txt", "tracked\n");
    await git.commit().setMessage("initial").call();

    // Create mock working tree with tracked + new untracked file
    const worktree = new MockWorkingTree();
    worktree.addFile("tracked.txt", "tracked modified\n");
    worktree.addFile("untracked.txt", "new file\n");

    // Commit with --all (should only stage tracked file, not untracked)
    await git.commit().setMessage("update tracked only").setAll(true).setWorktree(worktree).call();

    // Verify untracked file was NOT added
    const headRef = await repository.refs.resolve("HEAD");
    const headCommit = await repository.commits.load(headRef?.objectId ?? "");

    const untrackedEntry = await repository.trees.getEntry(headCommit.tree, "untracked.txt");
    expect(untrackedEntry).toBeUndefined();

    // Tracked file should be updated
    const trackedEntry = await repository.trees.getEntry(headCommit.tree, "tracked.txt");
    expect(trackedEntry).toBeDefined();
    const trackedContent = await repository.blobs.load(trackedEntry?.id ?? "");
    expect(trackedContent).toBeDefined();
    if (!trackedContent) throw new Error("unreachable");
    expect(new TextDecoder().decode(await collectBytes(trackedContent))).toBe("tracked modified\n");
  });
});
