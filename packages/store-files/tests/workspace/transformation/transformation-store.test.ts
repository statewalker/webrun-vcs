import { createInMemoryFilesApi, type FilesApi } from "@statewalker/vcs-core";
import { GitTransformationStore } from "@statewalker/vcs-store-files";
import type { TransformationStore } from "@statewalker/vcs-working-tree/transformation";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("TransformationStore", () => {
  let files: FilesApi;
  let store: TransformationStore;
  const gitDir = "/.git";

  beforeEach(async () => {
    files = createInMemoryFilesApi();
    await files.mkdir(gitDir);
    store = new GitTransformationStore(files, gitDir);
  });

  afterEach(async () => {
    // Clean up
  });

  describe("getState()", () => {
    it("returns undefined when no operation in progress", async () => {
      expect(await store.getState()).toBeUndefined();
    });

    it("returns merge state when merge in progress", async () => {
      await store.merge.begin({
        mergeHead: "abc123def456789012345678901234567890abcd",
        origHead: "def456789012345678901234567890abcdef1234",
        squash: false,
        noFastForward: false,
      });

      const state = await store.getState();
      expect(state?.type).toBe("merge");
    });

    it("prioritizes rebase over merge", async () => {
      await store.merge.begin({
        mergeHead: "abc123",
        origHead: "def456",
        squash: false,
        noFastForward: false,
      });

      await store.rebase.begin({
        rebaseType: "rebase-merge",
        headName: "refs/heads/feature",
        onto: "abc123",
        origHead: "def456",
        currentStep: 1,
        totalSteps: 3,
        interactive: false,
      });

      const state = await store.getState();
      expect(state?.type).toBe("rebase");
    });

    it("prioritizes merge over cherry-pick", async () => {
      await store.cherryPick.begin({
        cherryPickHead: "abc123",
        origHead: "def456",
        noCommit: false,
      });

      await store.merge.begin({
        mergeHead: "xyz789",
        origHead: "def456",
        squash: false,
        noFastForward: false,
      });

      const state = await store.getState();
      expect(state?.type).toBe("merge");
    });

    it("prioritizes cherry-pick over revert", async () => {
      await store.revert.begin({
        revertHead: "abc123",
        origHead: "def456",
        noCommit: false,
      });

      await store.cherryPick.begin({
        cherryPickHead: "xyz789",
        origHead: "def456",
        noCommit: false,
      });

      const state = await store.getState();
      expect(state?.type).toBe("cherry-pick");
    });
  });

  describe("MergeStateStore", () => {
    it("begins and reads merge state", async () => {
      await store.merge.begin({
        mergeHead: "abc123def456789012345678901234567890abcd",
        origHead: "def456789012345678901234567890abcdef1234",
        message: "Merge branch 'feature'",
        squash: false,
        noFastForward: true,
      });

      const state = await store.merge.read();
      expect(state?.mergeHead).toBe("abc123def456789012345678901234567890abcd");
      expect(state?.noFastForward).toBe(true);
      expect(state?.message).toContain("Merge branch");
    });

    it("isInProgress returns true during merge", async () => {
      expect(await store.merge.isInProgress()).toBe(false);

      await store.merge.begin({
        mergeHead: "abc123",
        origHead: "def456",
        squash: false,
        noFastForward: false,
      });

      expect(await store.merge.isInProgress()).toBe(true);
    });

    it("completes merge and cleans up state", async () => {
      await store.merge.begin({
        mergeHead: "abc123",
        origHead: "def456",
        squash: false,
        noFastForward: false,
      });

      expect(await store.merge.isInProgress()).toBe(true);

      await store.merge.complete();

      expect(await store.merge.isInProgress()).toBe(false);
      expect(await store.merge.read()).toBeUndefined();
    });

    it("aborts merge and cleans up state", async () => {
      await store.merge.begin({
        mergeHead: "abc123",
        origHead: "def456",
        squash: false,
        noFastForward: false,
      });

      await store.merge.abort();

      expect(await store.merge.isInProgress()).toBe(false);
    });

    it("updates merge message", async () => {
      await store.merge.begin({
        mergeHead: "abc123",
        origHead: "def456",
        message: "Original message",
        squash: false,
        noFastForward: false,
      });

      await store.merge.updateMessage("Updated message");

      const state = await store.merge.read();
      expect(state?.message).toBe("Updated message");
    });

    it("handles squash merge mode", async () => {
      await store.merge.begin({
        mergeHead: "abc123",
        origHead: "def456",
        squash: true,
        noFastForward: false,
      });

      const state = await store.merge.read();
      expect(state?.squash).toBe(true);
    });
  });

  describe("RebaseStateStore", () => {
    it("begins and reads rebase-merge state", async () => {
      await store.rebase.begin({
        rebaseType: "rebase-merge",
        headName: "refs/heads/feature",
        onto: "abc123",
        origHead: "def456",
        currentStep: 1,
        totalSteps: 5,
        interactive: false,
      });

      const state = await store.rebase.read();
      expect(state?.rebaseType).toBe("rebase-merge");
      expect(state?.currentStep).toBe(1);
      expect(state?.totalSteps).toBe(5);
    });

    it("begins and reads rebase-apply state", async () => {
      await store.rebase.begin({
        rebaseType: "rebase-apply",
        headName: "refs/heads/feature",
        onto: "abc123",
        origHead: "def456",
        currentStep: 2,
        totalSteps: 4,
        interactive: false,
      });

      const state = await store.rebase.read();
      expect(state?.rebaseType).toBe("rebase-apply");
      expect(state?.currentStep).toBe(2);
      expect(state?.totalSteps).toBe(4);
    });

    it("handles interactive rebase with todo list", async () => {
      await store.rebase.begin({
        rebaseType: "rebase-merge",
        headName: "refs/heads/feature",
        onto: "abc123",
        origHead: "def456",
        currentStep: 1,
        totalSteps: 2,
        interactive: true,
        todoList: [
          { action: "pick", commit: "commit1", message: "First commit" },
          { action: "squash", commit: "commit2", message: "Second commit" },
        ],
      });

      const state = await store.rebase.read();
      expect(state?.rebaseType).toBe("rebase-interactive");
      expect(state?.interactive).toBe(true);
      expect(state?.todoList).toHaveLength(2);
      expect(state?.todoList?.[0].action).toBe("pick");
      expect(state?.todoList?.[1].action).toBe("squash");
    });

    it("advances step", async () => {
      await store.rebase.begin({
        rebaseType: "rebase-merge",
        headName: "feature",
        onto: "abc123",
        origHead: "def456",
        currentStep: 1,
        totalSteps: 3,
        interactive: false,
      });

      await store.rebase.nextStep();

      const state = await store.rebase.read();
      expect(state?.currentStep).toBe(2);
    });

    it("updates todo list", async () => {
      await store.rebase.begin({
        rebaseType: "rebase-merge",
        headName: "feature",
        onto: "abc123",
        origHead: "def456",
        currentStep: 1,
        totalSteps: 3,
        interactive: true,
        todoList: [
          { action: "pick", commit: "c1", message: "Msg 1" },
          { action: "pick", commit: "c2", message: "Msg 2" },
          { action: "pick", commit: "c3", message: "Msg 3" },
        ],
      });

      await store.rebase.updateTodoList([
        { action: "squash", commit: "c2", message: "Msg 2" },
        { action: "fixup", commit: "c3", message: "Msg 3" },
      ]);

      const state = await store.rebase.read();
      expect(state?.todoList).toHaveLength(2);
      expect(state?.todoList?.[0].action).toBe("squash");
      expect(state?.todoList?.[1].action).toBe("fixup");
    });

    it("completes rebase and cleans up", async () => {
      await store.rebase.begin({
        rebaseType: "rebase-merge",
        headName: "feature",
        onto: "abc123",
        origHead: "def456",
        currentStep: 1,
        totalSteps: 1,
        interactive: false,
      });

      expect(await store.rebase.isInProgress()).toBe(true);

      await store.rebase.complete();

      expect(await store.rebase.isInProgress()).toBe(false);
    });

    it("getRebaseType returns correct type", async () => {
      expect(await store.rebase.getRebaseType()).toBeUndefined();

      await store.rebase.begin({
        rebaseType: "rebase-merge",
        headName: "feature",
        onto: "abc123",
        origHead: "def456",
        currentStep: 1,
        totalSteps: 1,
        interactive: false,
      });

      expect(await store.rebase.getRebaseType()).toBe("rebase-merge");
    });
  });

  describe("CherryPickStateStore", () => {
    it("begins and reads cherry-pick state", async () => {
      await store.cherryPick.begin({
        cherryPickHead: "abc123def456789012345678901234567890abcd",
        origHead: "def456789012345678901234567890abcdef1234",
        message: "Cherry-pick commit",
        noCommit: false,
      });

      const state = await store.cherryPick.read();
      expect(state?.cherryPickHead).toBe("abc123def456789012345678901234567890abcd");
      expect(state?.message).toContain("Cherry-pick");
    });

    it("isInProgress returns correct value", async () => {
      expect(await store.cherryPick.isInProgress()).toBe(false);

      await store.cherryPick.begin({
        cherryPickHead: "abc123",
        origHead: "def456",
        noCommit: false,
      });

      expect(await store.cherryPick.isInProgress()).toBe(true);
    });

    it("completes cherry-pick and cleans up", async () => {
      await store.cherryPick.begin({
        cherryPickHead: "abc123",
        origHead: "def456",
        noCommit: false,
      });

      await store.cherryPick.complete();

      expect(await store.cherryPick.isInProgress()).toBe(false);
    });

    it("updates message", async () => {
      await store.cherryPick.begin({
        cherryPickHead: "abc123",
        origHead: "def456",
        message: "Original",
        noCommit: false,
      });

      await store.cherryPick.updateMessage("Updated");

      const state = await store.cherryPick.read();
      expect(state?.message).toBe("Updated");
    });
  });

  describe("RevertStateStore", () => {
    it("begins and reads revert state", async () => {
      await store.revert.begin({
        revertHead: "abc123def456789012345678901234567890abcd",
        origHead: "def456789012345678901234567890abcdef1234",
        message: 'Revert "Original commit"',
        noCommit: false,
      });

      const state = await store.revert.read();
      expect(state?.revertHead).toBe("abc123def456789012345678901234567890abcd");
      expect(state?.message).toContain("Revert");
    });

    it("isInProgress returns correct value", async () => {
      expect(await store.revert.isInProgress()).toBe(false);

      await store.revert.begin({
        revertHead: "abc123",
        origHead: "def456",
        noCommit: false,
      });

      expect(await store.revert.isInProgress()).toBe(true);
    });

    it("completes revert and cleans up", async () => {
      await store.revert.begin({
        revertHead: "abc123",
        origHead: "def456",
        noCommit: false,
      });

      await store.revert.complete();

      expect(await store.revert.isInProgress()).toBe(false);
    });
  });

  describe("SequencerStore", () => {
    it("tracks multi-commit cherry-pick", async () => {
      await store.sequencer.begin({
        operation: "cherry-pick",
        head: "original-head",
        todo: [
          { action: "pick", commit: "commit1", message: "First" },
          { action: "pick", commit: "commit2", message: "Second" },
          { action: "pick", commit: "commit3", message: "Third" },
        ],
        options: { noCommit: false },
      });

      const state = await store.sequencer.read();
      expect(state?.operation).toBe("cherry-pick");
      expect(state?.todo).toHaveLength(3);
      expect(state?.done).toHaveLength(0);
      expect(state?.current?.commit).toBe("commit1");
    });

    it("advances to next item", async () => {
      await store.sequencer.begin({
        operation: "cherry-pick",
        head: "original-head",
        todo: [
          { action: "pick", commit: "commit1", message: "First" },
          { action: "pick", commit: "commit2", message: "Second" },
        ],
        options: {},
      });

      await store.sequencer.advance();

      const state = await store.sequencer.read();
      expect(state?.todo).toHaveLength(1);
      expect(state?.done).toHaveLength(1);
      expect(state?.done?.[0].commit).toBe("commit1");
      expect(state?.current?.commit).toBe("commit2");
    });

    it("skips current item", async () => {
      await store.sequencer.begin({
        operation: "cherry-pick",
        head: "original-head",
        todo: [
          { action: "pick", commit: "commit1", message: "First" },
          { action: "pick", commit: "commit2", message: "Second" },
        ],
        options: {},
      });

      await store.sequencer.skip();

      const state = await store.sequencer.read();
      expect(state?.todo).toHaveLength(1);
      expect(state?.done).toHaveLength(0); // Skipped items don't go to done
      expect(state?.current?.commit).toBe("commit2");
    });

    it("tracks multi-commit revert", async () => {
      await store.sequencer.begin({
        operation: "revert",
        head: "original-head",
        todo: [
          { action: "revert", commit: "commit1", message: "First" },
          { action: "revert", commit: "commit2", message: "Second" },
        ],
        options: { mainlineParent: 1 },
      });

      const state = await store.sequencer.read();
      expect(state?.operation).toBe("revert");
      expect(state?.options.mainlineParent).toBe(1);
    });

    it("completes and cleans up", async () => {
      await store.sequencer.begin({
        operation: "cherry-pick",
        head: "original-head",
        todo: [{ action: "pick", commit: "commit1", message: "First" }],
        options: {},
      });

      expect(await store.sequencer.isInProgress()).toBe(true);

      await store.sequencer.complete();

      expect(await store.sequencer.isInProgress()).toBe(false);
    });
  });

  describe("hasOperationInProgress()", () => {
    it("returns false when no operation", async () => {
      expect(await store.hasOperationInProgress()).toBe(false);
    });

    it("returns true during merge", async () => {
      await store.merge.begin({
        mergeHead: "abc123",
        origHead: "def456",
        squash: false,
        noFastForward: false,
      });

      expect(await store.hasOperationInProgress()).toBe(true);
    });

    it("returns true during rebase", async () => {
      await store.rebase.begin({
        rebaseType: "rebase-merge",
        headName: "feature",
        onto: "abc123",
        origHead: "def456",
        currentStep: 1,
        totalSteps: 1,
        interactive: false,
      });

      expect(await store.hasOperationInProgress()).toBe(true);
    });

    it("returns true during cherry-pick", async () => {
      await store.cherryPick.begin({
        cherryPickHead: "abc123",
        origHead: "def456",
        noCommit: false,
      });

      expect(await store.hasOperationInProgress()).toBe(true);
    });

    it("returns true during revert", async () => {
      await store.revert.begin({
        revertHead: "abc123",
        origHead: "def456",
        noCommit: false,
      });

      expect(await store.hasOperationInProgress()).toBe(true);
    });
  });

  describe("getCapabilities()", () => {
    it("returns empty capabilities when no operation", async () => {
      const caps = await store.getCapabilities();

      expect(caps.canContinue).toBe(false);
      expect(caps.canSkip).toBe(false);
      expect(caps.canAbort).toBe(false);
      expect(caps.canQuit).toBe(false);
      expect(caps.hasConflicts).toBe(false);
    });

    it("returns merge capabilities", async () => {
      await store.merge.begin({
        mergeHead: "abc123",
        origHead: "def456",
        squash: false,
        noFastForward: false,
      });

      const caps = await store.getCapabilities();

      expect(caps.canContinue).toBe(true);
      expect(caps.canSkip).toBe(false);
      expect(caps.canAbort).toBe(true);
      expect(caps.canQuit).toBe(false);
      expect(caps.hasConflicts).toBe(true);
    });

    it("returns rebase capabilities", async () => {
      await store.rebase.begin({
        rebaseType: "rebase-merge",
        headName: "feature",
        onto: "abc123",
        origHead: "def456",
        currentStep: 1,
        totalSteps: 3,
        interactive: false,
      });

      const caps = await store.getCapabilities();

      expect(caps.canContinue).toBe(true);
      expect(caps.canSkip).toBe(true);
      expect(caps.canAbort).toBe(true);
      expect(caps.canQuit).toBe(false); // Only for interactive
    });

    it("returns interactive rebase capabilities with canQuit", async () => {
      await store.rebase.begin({
        rebaseType: "rebase-merge",
        headName: "feature",
        onto: "abc123",
        origHead: "def456",
        currentStep: 1,
        totalSteps: 3,
        interactive: true,
      });

      const caps = await store.getCapabilities();
      expect(caps.canQuit).toBe(true);
    });

    it("returns cherry-pick capabilities without sequencer", async () => {
      await store.cherryPick.begin({
        cherryPickHead: "abc123",
        origHead: "def456",
        noCommit: false,
      });

      const caps = await store.getCapabilities();

      expect(caps.canContinue).toBe(true);
      expect(caps.canSkip).toBe(false);
      expect(caps.canAbort).toBe(true);
      expect(caps.canQuit).toBe(false);
    });

    it("returns cherry-pick capabilities with sequencer", async () => {
      await store.cherryPick.begin({
        cherryPickHead: "abc123",
        origHead: "def456",
        noCommit: false,
      });

      await store.sequencer.begin({
        operation: "cherry-pick",
        head: "def456",
        todo: [
          { action: "pick", commit: "abc123", message: "First" },
          { action: "pick", commit: "xyz789", message: "Second" },
        ],
        options: {},
      });

      const caps = await store.getCapabilities();

      expect(caps.canSkip).toBe(true);
      expect(caps.canQuit).toBe(true);
    });
  });

  describe("abortCurrent()", () => {
    it("does nothing when no operation", async () => {
      await store.abortCurrent();
      expect(await store.hasOperationInProgress()).toBe(false);
    });

    it("aborts merge", async () => {
      await store.merge.begin({
        mergeHead: "abc123",
        origHead: "def456",
        squash: false,
        noFastForward: false,
      });

      await store.abortCurrent();

      expect(await store.hasOperationInProgress()).toBe(false);
    });

    it("aborts rebase", async () => {
      await store.rebase.begin({
        rebaseType: "rebase-merge",
        headName: "feature",
        onto: "abc123",
        origHead: "def456",
        currentStep: 1,
        totalSteps: 1,
        interactive: false,
      });

      await store.abortCurrent();

      expect(await store.hasOperationInProgress()).toBe(false);
    });

    it("aborts cherry-pick and sequencer", async () => {
      await store.cherryPick.begin({
        cherryPickHead: "abc123",
        origHead: "def456",
        noCommit: false,
      });

      await store.sequencer.begin({
        operation: "cherry-pick",
        head: "def456",
        todo: [{ action: "pick", commit: "abc123", message: "First" }],
        options: {},
      });

      await store.abortCurrent();

      expect(await store.cherryPick.isInProgress()).toBe(false);
      expect(await store.sequencer.isInProgress()).toBe(false);
    });

    it("aborts revert and sequencer", async () => {
      await store.revert.begin({
        revertHead: "abc123",
        origHead: "def456",
        noCommit: false,
      });

      await store.sequencer.begin({
        operation: "revert",
        head: "def456",
        todo: [{ action: "revert", commit: "abc123", message: "First" }],
        options: {},
      });

      await store.abortCurrent();

      expect(await store.revert.isInProgress()).toBe(false);
      expect(await store.sequencer.isInProgress()).toBe(false);
    });
  });
});
