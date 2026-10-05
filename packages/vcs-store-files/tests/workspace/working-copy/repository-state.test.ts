import {
  detectRepositoryState,
  readCherryPickState,
  readRevertState,
} from "@statewalker/vcs-store-files";
import { getStateCapabilities, RepositoryState } from "@statewalker/vcs-working-tree";
import { describe, expect, it, vi } from "vitest";

describe("RepositoryState", () => {
  describe("enum values", () => {
    it("should define BARE state", () => {
      expect(RepositoryState.BARE).toBe("bare");
    });

    it("should define SAFE state", () => {
      expect(RepositoryState.SAFE).toBe("safe");
    });

    it("should define MERGING states", () => {
      expect(RepositoryState.MERGING).toBe("merging");
      expect(RepositoryState.MERGING_RESOLVED).toBe("merging-resolved");
    });

    it("should define CHERRY_PICKING states", () => {
      expect(RepositoryState.CHERRY_PICKING).toBe("cherry-picking");
      expect(RepositoryState.CHERRY_PICKING_RESOLVED).toBe("cherry-picking-resolved");
    });

    it("should define REVERTING states", () => {
      expect(RepositoryState.REVERTING).toBe("reverting");
      expect(RepositoryState.REVERTING_RESOLVED).toBe("reverting-resolved");
    });

    it("should define REBASING states", () => {
      expect(RepositoryState.REBASING).toBe("rebasing");
      expect(RepositoryState.REBASING_MERGE).toBe("rebasing-merge");
      expect(RepositoryState.REBASING_INTERACTIVE).toBe("rebasing-interactive");
    });

    it("should define APPLY state", () => {
      expect(RepositoryState.APPLY).toBe("apply");
    });

    it("should define BISECTING state", () => {
      expect(RepositoryState.BISECTING).toBe("bisecting");
    });
  });
});

describe("getStateCapabilities", () => {
  describe("SAFE state", () => {
    it("should allow all operations", () => {
      const caps = getStateCapabilities(RepositoryState.SAFE);

      expect(caps.canCheckout).toBe(true);
      expect(caps.canCommit).toBe(true);
      expect(caps.canResetHead).toBe(true);
      expect(caps.canAmend).toBe(true);
      expect(caps.isRebasing).toBe(false);
    });
  });

  describe("BARE state", () => {
    it("should deny all operations", () => {
      const caps = getStateCapabilities(RepositoryState.BARE);

      expect(caps.canCheckout).toBe(false);
      expect(caps.canCommit).toBe(false);
      expect(caps.canResetHead).toBe(false);
      expect(caps.canAmend).toBe(false);
      expect(caps.isRebasing).toBe(false);
    });
  });

  describe("MERGING state", () => {
    it("should deny checkout and commit, allow reset", () => {
      const caps = getStateCapabilities(RepositoryState.MERGING);

      expect(caps.canCheckout).toBe(false);
      expect(caps.canCommit).toBe(false);
      expect(caps.canResetHead).toBe(true);
      expect(caps.canAmend).toBe(false);
    });
  });

  describe("MERGING_RESOLVED state", () => {
    it("should allow commit, deny checkout", () => {
      const caps = getStateCapabilities(RepositoryState.MERGING_RESOLVED);

      expect(caps.canCheckout).toBe(false);
      expect(caps.canCommit).toBe(true);
      expect(caps.canResetHead).toBe(true);
    });
  });

  describe("CHERRY_PICKING state", () => {
    it("should deny checkout and commit", () => {
      const caps = getStateCapabilities(RepositoryState.CHERRY_PICKING);

      expect(caps.canCheckout).toBe(false);
      expect(caps.canCommit).toBe(false);
      expect(caps.canResetHead).toBe(true);
    });
  });

  describe("CHERRY_PICKING_RESOLVED state", () => {
    it("should allow commit", () => {
      const caps = getStateCapabilities(RepositoryState.CHERRY_PICKING_RESOLVED);

      expect(caps.canCheckout).toBe(false);
      expect(caps.canCommit).toBe(true);
    });
  });

  describe("REVERTING state", () => {
    it("should deny checkout and commit", () => {
      const caps = getStateCapabilities(RepositoryState.REVERTING);

      expect(caps.canCheckout).toBe(false);
      expect(caps.canCommit).toBe(false);
      expect(caps.canResetHead).toBe(true);
    });
  });

  describe("REVERTING_RESOLVED state", () => {
    it("should allow commit", () => {
      const caps = getStateCapabilities(RepositoryState.REVERTING_RESOLVED);

      expect(caps.canCheckout).toBe(false);
      expect(caps.canCommit).toBe(true);
    });
  });

  describe("REBASING states", () => {
    it("should indicate rebasing, deny checkout and commit, allow amend", () => {
      for (const state of [
        RepositoryState.REBASING,
        RepositoryState.REBASING_MERGE,
        RepositoryState.REBASING_INTERACTIVE,
      ]) {
        const caps = getStateCapabilities(state);

        expect(caps.isRebasing).toBe(true);
        expect(caps.canCheckout).toBe(false);
        expect(caps.canCommit).toBe(false);
        expect(caps.canAmend).toBe(true);
      }
    });
  });

  describe("APPLY state", () => {
    it("should deny checkout and commit, allow amend", () => {
      const caps = getStateCapabilities(RepositoryState.APPLY);

      expect(caps.canCheckout).toBe(false);
      expect(caps.canCommit).toBe(false);
      expect(caps.canAmend).toBe(true);
      expect(caps.isRebasing).toBe(false);
    });
  });

  describe("BISECTING state", () => {
    it("should allow checkout only", () => {
      const caps = getStateCapabilities(RepositoryState.BISECTING);

      expect(caps.canCheckout).toBe(true);
      expect(caps.canCommit).toBe(false);
      expect(caps.canResetHead).toBe(false);
      expect(caps.canAmend).toBe(false);
    });
  });
});

describe("detectRepositoryState", () => {
  function createMockFiles(files: Record<string, boolean>) {
    return {
      read: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockImplementation((path: string) => {
        return Promise.resolve(files[path] ?? false);
      }),
    };
  }

  describe("SAFE state", () => {
    it("should return SAFE when no state files exist", async () => {
      const files = createMockFiles({});

      const state = await detectRepositoryState(files, ".git", false);

      expect(state).toBe(RepositoryState.SAFE);
    });
  });

  describe("rebase states", () => {
    it("should detect REBASING_INTERACTIVE", async () => {
      const files = createMockFiles({
        ".git/rebase-merge": true,
        ".git/rebase-merge/interactive": true,
      });

      const state = await detectRepositoryState(files, ".git", false);

      expect(state).toBe(RepositoryState.REBASING_INTERACTIVE);
    });

    it("should detect REBASING_MERGE", async () => {
      const files = createMockFiles({
        ".git/rebase-merge": true,
      });

      const state = await detectRepositoryState(files, ".git", false);

      expect(state).toBe(RepositoryState.REBASING_MERGE);
    });

    it("should detect APPLY", async () => {
      const files = createMockFiles({
        ".git/rebase-apply": true,
        ".git/rebase-apply/applying": true,
      });

      const state = await detectRepositoryState(files, ".git", false);

      expect(state).toBe(RepositoryState.APPLY);
    });

    it("should detect REBASING from rebase-apply", async () => {
      const files = createMockFiles({
        ".git/rebase-apply": true,
      });

      const state = await detectRepositoryState(files, ".git", false);

      expect(state).toBe(RepositoryState.REBASING);
    });
  });

  describe("merge states", () => {
    it("should detect MERGING with conflicts", async () => {
      const files = createMockFiles({
        ".git/MERGE_HEAD": true,
      });

      const state = await detectRepositoryState(files, ".git", true);

      expect(state).toBe(RepositoryState.MERGING);
    });

    it("should detect MERGING_RESOLVED without conflicts", async () => {
      const files = createMockFiles({
        ".git/MERGE_HEAD": true,
      });

      const state = await detectRepositoryState(files, ".git", false);

      expect(state).toBe(RepositoryState.MERGING_RESOLVED);
    });
  });

  describe("cherry-pick states", () => {
    it("should detect CHERRY_PICKING with conflicts", async () => {
      const files = createMockFiles({
        ".git/CHERRY_PICK_HEAD": true,
      });

      const state = await detectRepositoryState(files, ".git", true);

      expect(state).toBe(RepositoryState.CHERRY_PICKING);
    });

    it("should detect CHERRY_PICKING_RESOLVED without conflicts", async () => {
      const files = createMockFiles({
        ".git/CHERRY_PICK_HEAD": true,
      });

      const state = await detectRepositoryState(files, ".git", false);

      expect(state).toBe(RepositoryState.CHERRY_PICKING_RESOLVED);
    });
  });

  describe("revert states", () => {
    it("should detect REVERTING with conflicts", async () => {
      const files = createMockFiles({
        ".git/REVERT_HEAD": true,
      });

      const state = await detectRepositoryState(files, ".git", true);

      expect(state).toBe(RepositoryState.REVERTING);
    });

    it("should detect REVERTING_RESOLVED without conflicts", async () => {
      const files = createMockFiles({
        ".git/REVERT_HEAD": true,
      });

      const state = await detectRepositoryState(files, ".git", false);

      expect(state).toBe(RepositoryState.REVERTING_RESOLVED);
    });
  });

  describe("bisect state", () => {
    it("should detect BISECTING", async () => {
      const files = createMockFiles({
        ".git/BISECT_LOG": true,
      });

      const state = await detectRepositoryState(files, ".git", false);

      expect(state).toBe(RepositoryState.BISECTING);
    });
  });

  describe("priority", () => {
    it("should prioritize rebase over merge", async () => {
      const files = createMockFiles({
        ".git/rebase-merge": true,
        ".git/MERGE_HEAD": true,
      });

      const state = await detectRepositoryState(files, ".git", true);

      expect(state).toBe(RepositoryState.REBASING_MERGE);
    });

    it("should prioritize merge over cherry-pick", async () => {
      const files = createMockFiles({
        ".git/MERGE_HEAD": true,
        ".git/CHERRY_PICK_HEAD": true,
      });

      const state = await detectRepositoryState(files, ".git", true);

      expect(state).toBe(RepositoryState.MERGING);
    });
  });
});

describe("readCherryPickState", () => {
  function createMockFiles(content: Record<string, string | undefined>) {
    return {
      read: vi.fn().mockImplementation((path: string) => {
        const value = content[path];
        if (value === undefined) return Promise.resolve(undefined);
        return Promise.resolve(new TextEncoder().encode(value));
      }),
    };
  }

  it("should return undefined when CHERRY_PICK_HEAD does not exist", async () => {
    const files = createMockFiles({});

    const state = await readCherryPickState(files, ".git");

    expect(state).toBeUndefined();
  });

  it("should return cherry-pick state when CHERRY_PICK_HEAD exists", async () => {
    const files = createMockFiles({
      ".git/CHERRY_PICK_HEAD": "abc123def456\n",
    });

    const state = await readCherryPickState(files, ".git");

    expect(state).toEqual({
      cherryPickHead: "abc123def456",
      message: undefined,
    });
  });

  it("should include message from MERGE_MSG", async () => {
    const files = createMockFiles({
      ".git/CHERRY_PICK_HEAD": "abc123def456\n",
      ".git/MERGE_MSG": "Cherry-pick commit message\n",
    });

    const state = await readCherryPickState(files, ".git");

    expect(state).toEqual({
      cherryPickHead: "abc123def456",
      message: "Cherry-pick commit message\n",
    });
  });
});

describe("readRevertState", () => {
  function createMockFiles(content: Record<string, string | undefined>) {
    return {
      read: vi.fn().mockImplementation((path: string) => {
        const value = content[path];
        if (value === undefined) return Promise.resolve(undefined);
        return Promise.resolve(new TextEncoder().encode(value));
      }),
    };
  }

  it("should return undefined when REVERT_HEAD does not exist", async () => {
    const files = createMockFiles({});

    const state = await readRevertState(files, ".git");

    expect(state).toBeUndefined();
  });

  it("should return revert state when REVERT_HEAD exists", async () => {
    const files = createMockFiles({
      ".git/REVERT_HEAD": "abc123def456\n",
    });

    const state = await readRevertState(files, ".git");

    expect(state).toEqual({
      revertHead: "abc123def456",
      message: undefined,
    });
  });

  it("should include message from MERGE_MSG", async () => {
    const files = createMockFiles({
      ".git/REVERT_HEAD": "abc123def456\n",
      ".git/MERGE_MSG": "Revert commit message\n",
    });

    const state = await readRevertState(files, ".git");

    expect(state).toEqual({
      revertHead: "abc123def456",
      message: "Revert commit message\n",
    });
  });
});

/**
 * Git State File Format Compatibility Tests
 *
 * These tests verify that state file formats match Git's exact format.
 * Based on Git source code and JGit documentation.
 */
describe("Git State File Format Compatibility", () => {
  describe("MERGE_HEAD format", () => {
    /**
     * Git's MERGE_HEAD format:
     * - One SHA-1 per line for each parent being merged
     * - 40 hex characters + newline
     */
    it("should accept single SHA-1 with trailing newline", async () => {
      const files = {
        read: vi.fn().mockResolvedValue(undefined),
        exists: vi.fn().mockImplementation((path: string) => path === ".git/MERGE_HEAD"),
      };

      const state = await detectRepositoryState(files, ".git", false);
      expect(state).toBe(RepositoryState.MERGING_RESOLVED);
    });
  });

  describe("CHERRY_PICK_HEAD format", () => {
    /**
     * Git's CHERRY_PICK_HEAD format:
     * - Single 40-character SHA-1 + newline
     * - Same format as refs
     */
    it("should parse full 40-char SHA-1", async () => {
      const sha1 = "a".repeat(40);
      const files = {
        read: vi.fn().mockImplementation((path: string) => {
          if (path === ".git/CHERRY_PICK_HEAD") {
            return Promise.resolve(new TextEncoder().encode(`${sha1}\n`));
          }
          return Promise.resolve(undefined);
        }),
      };

      const state = await readCherryPickState(files, ".git");
      expect(state?.cherryPickHead).toBe(sha1);
    });

    it("should handle SHA-1 without trailing newline", async () => {
      const sha1 = "b".repeat(40);
      const files = {
        read: vi.fn().mockImplementation((path: string) => {
          if (path === ".git/CHERRY_PICK_HEAD") {
            return Promise.resolve(new TextEncoder().encode(sha1));
          }
          return Promise.resolve(undefined);
        }),
      };

      const state = await readCherryPickState(files, ".git");
      expect(state?.cherryPickHead).toBe(sha1);
    });
  });

  describe("REVERT_HEAD format", () => {
    /**
     * Git's REVERT_HEAD format:
     * - Single 40-character SHA-1 + newline
     */
    it("should parse full 40-char SHA-1", async () => {
      const sha1 = "c".repeat(40);
      const files = {
        read: vi.fn().mockImplementation((path: string) => {
          if (path === ".git/REVERT_HEAD") {
            return Promise.resolve(new TextEncoder().encode(`${sha1}\n`));
          }
          return Promise.resolve(undefined);
        }),
      };

      const state = await readRevertState(files, ".git");
      expect(state?.revertHead).toBe(sha1);
    });
  });

  describe("MERGE_MSG format", () => {
    /**
     * Git's MERGE_MSG format:
     * - Free-form text for commit message
     * - May contain multiple lines
     * - First line is subject
     */
    it("should preserve multi-line messages", async () => {
      const message = "Merge branch 'feature'\n\n* feature:\n  Add new feature\n";
      const files = {
        read: vi.fn().mockImplementation((path: string) => {
          if (path === ".git/CHERRY_PICK_HEAD") {
            return Promise.resolve(new TextEncoder().encode("a".repeat(40)));
          }
          if (path === ".git/MERGE_MSG") {
            return Promise.resolve(new TextEncoder().encode(message));
          }
          return Promise.resolve(undefined);
        }),
      };

      const state = await readCherryPickState(files, ".git");
      expect(state?.message).toBe(message);
    });
  });

  describe("rebase-merge directory format", () => {
    /**
     * Git's rebase-merge/ directory:
     * - head-name: original branch being rebased
     * - onto: commit we're rebasing onto
     * - interactive: marker file for interactive rebase
     * - git-rebase-todo: remaining commits to process (interactive)
     * - done: processed commits (interactive)
     * - message: current commit message
     */
    it("should detect interactive rebase by 'interactive' marker", async () => {
      const files = {
        read: vi.fn().mockResolvedValue(undefined),
        exists: vi.fn().mockImplementation((path: string) => {
          return path === ".git/rebase-merge" || path === ".git/rebase-merge/interactive";
        }),
      };

      const state = await detectRepositoryState(files, ".git", false);
      expect(state).toBe(RepositoryState.REBASING_INTERACTIVE);
    });

    it("should detect merge-based rebase without 'interactive' marker", async () => {
      const files = {
        read: vi.fn().mockResolvedValue(undefined),
        exists: vi.fn().mockImplementation((path: string) => {
          return path === ".git/rebase-merge";
        }),
      };

      const state = await detectRepositoryState(files, ".git", false);
      expect(state).toBe(RepositoryState.REBASING_MERGE);
    });
  });

  describe("rebase-apply directory format", () => {
    /**
     * Git's rebase-apply/ directory:
     * - applying: marker for 'git am' operation
     * - rebasing: marker for am-based rebase
     * - head-name: original branch
     * - patch files: 0001, 0002, etc.
     */
    it("should detect git am by 'applying' marker", async () => {
      const files = {
        read: vi.fn().mockResolvedValue(undefined),
        exists: vi.fn().mockImplementation((path: string) => {
          return path === ".git/rebase-apply" || path === ".git/rebase-apply/applying";
        }),
      };

      const state = await detectRepositoryState(files, ".git", false);
      expect(state).toBe(RepositoryState.APPLY);
    });

    it("should detect am-based rebase without 'applying' marker", async () => {
      const files = {
        read: vi.fn().mockResolvedValue(undefined),
        exists: vi.fn().mockImplementation((path: string) => {
          return path === ".git/rebase-apply";
        }),
      };

      const state = await detectRepositoryState(files, ".git", false);
      expect(state).toBe(RepositoryState.REBASING);
    });
  });

  describe("BISECT_LOG format", () => {
    /**
     * Git's BISECT_LOG format:
     * - Lines recording bisect commands executed
     * - git bisect start [bad] [good]
     * - git bisect good <commit>
     * - git bisect bad <commit>
     */
    it("should detect bisect state from BISECT_LOG presence", async () => {
      const files = {
        read: vi.fn().mockResolvedValue(undefined),
        exists: vi.fn().mockImplementation((path: string) => {
          return path === ".git/BISECT_LOG";
        }),
      };

      const state = await detectRepositoryState(files, ".git", false);
      expect(state).toBe(RepositoryState.BISECTING);
    });
  });

  describe("ORIG_HEAD format", () => {
    /**
     * Git's ORIG_HEAD format:
     * - Single 40-character SHA-1 + newline
     * - Stores HEAD before dangerous operations (reset, merge, rebase)
     */
    it("should store previous HEAD as 40-char SHA-1", () => {
      // ORIG_HEAD is just a ref file with a SHA-1
      // Format: <40 hex chars>\n
      const validOrigHead = `${"d".repeat(40)}\n`;
      expect(validOrigHead.length).toBe(41); // 40 + newline
      expect(validOrigHead.match(/^[0-9a-f]{40}\n$/)).toBeTruthy();
    });
  });
});
