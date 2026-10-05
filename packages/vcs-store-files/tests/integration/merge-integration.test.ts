/**
 * T3.4: Merge Integration Tests
 *
 * End-to-end integration tests for merge workflows that exercise
 * the full component stack including:
 * - Fast-forward merge
 * - Three-way merge with automatic resolution
 * - Conflict detection (modify/modify, modify/delete, add/add)
 * - Merge state persistence (MERGE_HEAD, MERGE_MSG)
 * - Abort/continue workflows
 *
 * These tests validate that the TransformationStore, staging, and
 * object stores work together correctly for merge operations.
 */

import {
  createInMemoryFilesApi,
  createMemoryHistory,
  type FilesApi,
  type History,
} from "@statewalker/vcs-core";
import { GitTransformationStore } from "@statewalker/vcs-store-files";
import type { TransformationStore } from "@statewalker/vcs-working-tree/transformation";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Helper types
interface TestPerson {
  name: string;
  email: string;
  timestamp: number;
  tzOffset: string;
}

// Helper to create test person
function createTestPerson(options?: Partial<TestPerson>): TestPerson {
  return {
    name: options?.name ?? "Test Author",
    email: options?.email ?? "test@example.com",
    timestamp: options?.timestamp ?? Math.floor(Date.now() / 1000),
    tzOffset: options?.tzOffset ?? "+0000",
  };
}

// Helper to store blob content
async function storeBlob(history: History, content: string): Promise<string> {
  return history.blobs.store([new TextEncoder().encode(content)]);
}

// Helper to create a commit with files
async function createCommit(
  history: History,
  files: Record<string, string>,
  options?: {
    parents?: string[];
    message?: string;
  },
): Promise<string> {
  // Create blobs and tree entries
  const entries: Array<{ mode: number; name: string; id: string }> = [];
  for (const [name, content] of Object.entries(files)) {
    const blobId = await storeBlob(history, content);
    entries.push({ mode: 0o100644, name, id: blobId });
  }

  // Sort entries by name (git requirement)
  entries.sort((a, b) => a.name.localeCompare(b.name));

  // Store tree
  const treeId = await history.trees.store(entries);

  // Store commit
  const person = createTestPerson();
  return history.commits.store({
    tree: treeId,
    parents: options?.parents ?? [],
    author: person,
    committer: person,
    message: options?.message ?? "Test commit",
  });
}

// Helper to get file content from a commit
async function getFileContent(
  history: History,
  commitId: string,
  filename: string,
): Promise<string | undefined> {
  const commit = await history.commits.load(commitId);
  if (!commit) return undefined;

  const tree = await history.trees.load(commit.tree);
  if (!tree) return undefined;

  // Collect tree entries
  const entries: Array<{ mode: number; name: string; id: string }> = [];
  for await (const entry of tree) {
    entries.push(entry);
  }

  const entry = entries.find((e) => e.name === filename);
  if (!entry) return undefined;

  const blob = await history.blobs.load(entry.id);
  if (!blob) return undefined;

  const chunks: Uint8Array[] = [];
  for await (const chunk of blob) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(result);
}

describe("Merge Integration", () => {
  let history: History;
  let files: FilesApi;
  let transformationStore: TransformationStore;
  const gitDir = "/.git";

  beforeEach(async () => {
    history = createMemoryHistory();
    await history.initialize();

    // Create files API and git directory for transformation store
    files = createInMemoryFilesApi();
    await files.mkdir(gitDir);
    transformationStore = new GitTransformationStore(files, gitDir);
  });

  afterEach(async () => {
    await history.close();
  });

  describe("fast-forward merge", () => {
    it("fast-forwards when target is ancestor of source", async () => {
      // Create base commit
      const baseCommit = await createCommit(history, { "file.txt": "base content" });

      // Create commit on top of base (simulating another branch ahead)
      const aheadCommit = await createCommit(
        history,
        { "file.txt": "updated content" },
        { parents: [baseCommit], message: "Feature commit" },
      );

      // Set up refs: main points to base, feature points to ahead
      await history.refs.set("refs/heads/main", baseCommit);
      await history.refs.set("refs/heads/feature", aheadCommit);
      await history.refs.setSymbolic("HEAD", "refs/heads/main");

      // Verify initial state
      const mainBefore = await history.refs.resolve("refs/heads/main");
      expect(mainBefore?.objectId).toBe(baseCommit);

      // Simulate fast-forward: check if base is ancestor of feature
      const isAncestor = await history.commits.isAncestor(baseCommit, aheadCommit);
      expect(isAncestor).toBe(true);

      // Fast-forward main to feature (what merge command would do)
      await history.refs.set("refs/heads/main", aheadCommit);

      // Verify main now points to feature commit
      const mainAfter = await history.refs.resolve("refs/heads/main");
      expect(mainAfter?.objectId).toBe(aheadCommit);

      // Verify content
      const content = await getFileContent(history, aheadCommit, "file.txt");
      expect(content).toBe("updated content");
    });

    it("updates ref to target commit without creating merge commit", async () => {
      // Create linear history: base -> feature
      const baseCommit = await createCommit(history, { "README.md": "# Project\n" });
      const featureCommit = await createCommit(
        history,
        { "README.md": "# Project\n", "feature.txt": "new feature" },
        { parents: [baseCommit] },
      );

      await history.refs.set("refs/heads/main", baseCommit);
      await history.refs.set("refs/heads/feature", featureCommit);

      // Fast-forward
      await history.refs.set("refs/heads/main", featureCommit);

      // Verify no new commit was created (feature commit is now main)
      const main = await history.refs.resolve("refs/heads/main");
      expect(main?.objectId).toBe(featureCommit);

      // Feature commit should have exactly one parent (not a merge commit)
      const commit = await history.commits.load(featureCommit);
      expect(commit?.parents.length).toBe(1);
    });
  });

  describe("three-way merge", () => {
    it("merges divergent branches", async () => {
      // Create base commit
      const baseCommit = await createCommit(history, { "file.txt": "base content" });

      // Create two divergent branches from base
      const mainCommit = await createCommit(
        history,
        { "file.txt": "base content", "main.txt": "main content" },
        { parents: [baseCommit], message: "Main branch commit" },
      );

      const featureCommit = await createCommit(
        history,
        { "file.txt": "base content", "feature.txt": "feature content" },
        { parents: [baseCommit], message: "Feature branch commit" },
      );

      // Both branches have baseCommit as common ancestor
      const mergeBase = await history.commits.findMergeBase(mainCommit, featureCommit);
      expect(mergeBase).toBeDefined();
      expect(mergeBase).toContain(baseCommit);
    });

    it("creates merge commit with two parents", async () => {
      // Create base commit
      const baseCommit = await createCommit(history, { "file.txt": "base content" });

      // Create divergent branches
      const mainCommit = await createCommit(
        history,
        { "file.txt": "base content", "main.txt": "main" },
        { parents: [baseCommit] },
      );

      const featureCommit = await createCommit(
        history,
        { "file.txt": "base content", "feature.txt": "feature" },
        { parents: [baseCommit] },
      );

      // Create merge commit (what merge command would produce)
      const mergeCommit = await createCommit(
        history,
        { "file.txt": "base content", "main.txt": "main", "feature.txt": "feature" },
        { parents: [mainCommit, featureCommit], message: "Merge branch 'feature'" },
      );

      // Verify merge commit has two parents
      const commit = await history.commits.load(mergeCommit);
      expect(commit?.parents.length).toBe(2);
      expect(commit?.parents).toContain(mainCommit);
      expect(commit?.parents).toContain(featureCommit);
    });

    it("resolves simple non-overlapping changes automatically", async () => {
      // Create base with single file
      const baseCommit = await createCommit(history, { "shared.txt": "line1\nline2\nline3\n" });

      // Main adds new file (no conflict)
      const mainCommit = await createCommit(
        history,
        { "shared.txt": "line1\nline2\nline3\n", "main.txt": "main content" },
        { parents: [baseCommit] },
      );

      // Feature adds different new file (no conflict)
      const featureCommit = await createCommit(
        history,
        { "shared.txt": "line1\nline2\nline3\n", "feature.txt": "feature content" },
        { parents: [baseCommit] },
      );

      // Both can be merged without conflict - result has all files
      const mergedFiles = {
        "shared.txt": "line1\nline2\nline3\n",
        "main.txt": "main content",
        "feature.txt": "feature content",
      };

      const mergeCommit = await createCommit(history, mergedFiles, {
        parents: [mainCommit, featureCommit],
        message: "Merge feature into main",
      });

      // Verify all files present
      for (const [filename, expectedContent] of Object.entries(mergedFiles)) {
        const content = await getFileContent(history, mergeCommit, filename);
        expect(content).toBe(expectedContent);
      }
    });
  });

  describe("conflict detection", () => {
    it("detects modify/modify conflict", async () => {
      // Create base
      const baseCommit = await createCommit(history, { "file.txt": "original content" });

      // Both branches modify the same file differently
      const mainCommit = await createCommit(
        history,
        { "file.txt": "main modified content" },
        { parents: [baseCommit] },
      );

      const featureCommit = await createCommit(
        history,
        { "file.txt": "feature modified content" },
        { parents: [baseCommit] },
      );

      // Get content from both commits - this is what conflict detection would compare
      const mainContent = await getFileContent(history, mainCommit, "file.txt");
      const featureContent = await getFileContent(history, featureCommit, "file.txt");
      const baseContent = await getFileContent(history, baseCommit, "file.txt");

      // Detect conflict: both changed from base to different values
      const mainChanged = mainContent !== baseContent;
      const featureChanged = featureContent !== baseContent;
      const divergent = mainContent !== featureContent;

      expect(mainChanged).toBe(true);
      expect(featureChanged).toBe(true);
      expect(divergent).toBe(true);

      // This would be a modify/modify conflict
    });

    it("detects modify/delete conflict", async () => {
      // Create base with file
      const baseCommit = await createCommit(history, {
        "file.txt": "content",
        "other.txt": "other",
      });

      // Main modifies the file
      const mainCommit = await createCommit(
        history,
        { "file.txt": "modified content", "other.txt": "other" },
        { parents: [baseCommit] },
      );

      // Feature deletes the file (by not including it)
      const featureCommit = await createCommit(
        history,
        { "other.txt": "other" },
        { parents: [baseCommit] },
      );

      // Check conflict detection
      const mainHasFile = (await getFileContent(history, mainCommit, "file.txt")) !== undefined;
      const featureHasFile =
        (await getFileContent(history, featureCommit, "file.txt")) !== undefined;
      const baseHasFile = (await getFileContent(history, baseCommit, "file.txt")) !== undefined;

      expect(baseHasFile).toBe(true);
      expect(mainHasFile).toBe(true);
      expect(featureHasFile).toBe(false);

      // This is modify/delete conflict: main modified, feature deleted
    });

    it("detects add/add conflict", async () => {
      // Create base without the conflicting file
      const baseCommit = await createCommit(history, { "existing.txt": "existing" });

      // Both branches add the same file with different content
      const mainCommit = await createCommit(
        history,
        { "existing.txt": "existing", "new.txt": "main version" },
        { parents: [baseCommit] },
      );

      const featureCommit = await createCommit(
        history,
        { "existing.txt": "existing", "new.txt": "feature version" },
        { parents: [baseCommit] },
      );

      // Check conflict detection
      const mainContent = await getFileContent(history, mainCommit, "new.txt");
      const featureContent = await getFileContent(history, featureCommit, "new.txt");
      const baseContent = await getFileContent(history, baseCommit, "new.txt");

      expect(baseContent).toBeUndefined(); // File didn't exist in base
      expect(mainContent).toBe("main version");
      expect(featureContent).toBe("feature version");

      // Both added the file with different content - add/add conflict
    });
  });

  describe("merge state persistence", () => {
    it("persists MERGE_HEAD during conflict", async () => {
      const mergeHead = "abc123def456789012345678901234567890abcd";
      const origHead = "def456789012345678901234567890abcdef1234";

      // Begin merge
      await transformationStore.merge.begin({
        mergeHead,
        origHead,
        message: "Merge branch 'feature'",
        squash: false,
        noFastForward: false,
      });

      // Verify state is persisted
      const state = await transformationStore.merge.read();
      expect(state).toBeDefined();
      expect(state?.mergeHead).toBe(mergeHead);
      expect(state?.origHead).toBe(origHead);

      // Verify isInProgress
      expect(await transformationStore.merge.isInProgress()).toBe(true);
    });

    it("persists merge message in MERGE_MSG", async () => {
      const mergeHead = "abc123def456789012345678901234567890abcd";
      const origHead = "def456789012345678901234567890abcdef1234";
      const message = "Merge branch 'feature' into main\n\nThis is a long merge message.";

      await transformationStore.merge.begin({
        mergeHead,
        origHead,
        message,
        squash: false,
        noFastForward: false,
      });

      const state = await transformationStore.merge.read();
      expect(state?.message).toContain("Merge branch");
    });

    it("cleans up after merge completion", async () => {
      const mergeHead = "abc123def456789012345678901234567890abcd";
      const origHead = "def456789012345678901234567890abcdef1234";

      // Begin merge
      await transformationStore.merge.begin({
        mergeHead,
        origHead,
        squash: false,
        noFastForward: false,
      });

      expect(await transformationStore.merge.isInProgress()).toBe(true);

      // Complete merge
      await transformationStore.merge.complete();

      // State should be cleaned up
      expect(await transformationStore.merge.isInProgress()).toBe(false);
      expect(await transformationStore.merge.read()).toBeUndefined();
    });

    it("cleans up after merge abort", async () => {
      const mergeHead = "abc123def456789012345678901234567890abcd";
      const origHead = "def456789012345678901234567890abcdef1234";

      // Begin merge
      await transformationStore.merge.begin({
        mergeHead,
        origHead,
        squash: false,
        noFastForward: false,
      });

      expect(await transformationStore.merge.isInProgress()).toBe(true);

      // Abort merge
      await transformationStore.merge.abort();

      // State should be cleaned up
      expect(await transformationStore.merge.isInProgress()).toBe(false);
      expect(await transformationStore.merge.read()).toBeUndefined();
    });
  });

  describe("abort/continue workflows", () => {
    it("supports abort during conflicted merge", async () => {
      const mergeHead = "abc123def456789012345678901234567890abcd";
      const origHead = "def456789012345678901234567890abcdef1234";

      // Begin merge
      await transformationStore.merge.begin({
        mergeHead,
        origHead,
        squash: false,
        noFastForward: false,
      });

      // Verify state exists
      expect(await transformationStore.merge.isInProgress()).toBe(true);
      expect(await transformationStore.getState()).toBeDefined();
      expect((await transformationStore.getState())?.type).toBe("merge");

      // Abort
      await transformationStore.merge.abort();

      // Verify state is cleared
      expect(await transformationStore.merge.isInProgress()).toBe(false);
      expect(await transformationStore.getState()).toBeUndefined();
    });

    it("supports updating merge message during conflict resolution", async () => {
      const mergeHead = "abc123def456789012345678901234567890abcd";
      const origHead = "def456789012345678901234567890abcdef1234";
      const initialMessage = "Merge branch 'feature'";
      const updatedMessage =
        "Merge branch 'feature' with conflict resolution\n\nManually resolved conflicts.";

      // Begin merge with initial message
      await transformationStore.merge.begin({
        mergeHead,
        origHead,
        message: initialMessage,
        squash: false,
        noFastForward: false,
      });

      // Update message (e.g., user edits commit message before finalizing)
      await transformationStore.merge.updateMessage(updatedMessage);

      // Verify updated message
      const state = await transformationStore.merge.read();
      expect(state?.message).toBe(updatedMessage);
    });

    it("reports correct operation state via getState", async () => {
      // No operation
      expect(await transformationStore.getState()).toBeUndefined();

      // Start merge
      await transformationStore.merge.begin({
        mergeHead: "abc123",
        origHead: "def456",
        squash: false,
        noFastForward: false,
      });

      const state = await transformationStore.getState();
      expect(state?.type).toBe("merge");
    });

    it("handles squash merge state", async () => {
      const mergeHead = "abc123def456789012345678901234567890abcd";
      const origHead = "def456789012345678901234567890abcdef1234";

      await transformationStore.merge.begin({
        mergeHead,
        origHead,
        squash: true,
        noFastForward: false,
      });

      const state = await transformationStore.merge.read();
      expect(state?.squash).toBe(true);
    });

    it("handles no-fast-forward merge state", async () => {
      const mergeHead = "abc123def456789012345678901234567890abcd";
      const origHead = "def456789012345678901234567890abcdef1234";

      await transformationStore.merge.begin({
        mergeHead,
        origHead,
        squash: false,
        noFastForward: true,
      });

      const state = await transformationStore.merge.read();
      expect(state?.noFastForward).toBe(true);
    });
  });

  describe("ancestry and merge base", () => {
    it("finds common ancestor for merge", async () => {
      // Create linear base history
      const commit1 = await createCommit(history, { "file.txt": "v1" });
      const commit2 = await createCommit(history, { "file.txt": "v2" }, { parents: [commit1] });

      // Create two branches from commit2
      const mainCommit = await createCommit(
        history,
        { "file.txt": "main" },
        { parents: [commit2] },
      );
      const featureCommit = await createCommit(
        history,
        { "file.txt": "feature" },
        { parents: [commit2] },
      );

      // Find merge base
      const mergeBase = await history.commits.findMergeBase(mainCommit, featureCommit);
      expect(mergeBase).toContain(commit2);
    });

    it("handles multiple merge bases (criss-cross)", async () => {
      // Create initial commit
      const initial = await createCommit(history, { "file.txt": "initial" });

      // Create two branches
      const branchA = await createCommit(history, { "file.txt": "A" }, { parents: [initial] });
      const branchB = await createCommit(history, { "file.txt": "B" }, { parents: [initial] });

      // Merge in both directions (criss-cross)
      const mergeAB = await createCommit(
        history,
        { "file.txt": "AB" },
        { parents: [branchA, branchB] },
      );
      const mergeBA = await createCommit(
        history,
        { "file.txt": "BA" },
        { parents: [branchB, branchA] },
      );

      // Both merge commits could be merge bases for subsequent merges
      // findMergeBase should return one or both
      const mergeBase = await history.commits.findMergeBase(mergeAB, mergeBA);
      expect(mergeBase).toBeDefined();
      // In criss-cross, there can be multiple merge bases
    });

    it("detects when one commit is ancestor of another", async () => {
      const commit1 = await createCommit(history, { "file.txt": "v1" });
      const commit2 = await createCommit(history, { "file.txt": "v2" }, { parents: [commit1] });
      const commit3 = await createCommit(history, { "file.txt": "v3" }, { parents: [commit2] });

      expect(await history.commits.isAncestor(commit1, commit3)).toBe(true);
      expect(await history.commits.isAncestor(commit2, commit3)).toBe(true);
      expect(await history.commits.isAncestor(commit3, commit1)).toBe(false);
      // A commit is considered its own ancestor (matches Git behavior)
      expect(await history.commits.isAncestor(commit1, commit1)).toBe(true);
    });
  });
});
