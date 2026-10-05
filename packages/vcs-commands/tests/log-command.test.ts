/**
 * Tests for LogCommand
 *
 * Based on JGit's LogCommandTest.java and LogFilterTest.java
 * Tests run against all storage backends (Memory, SQL).
 */

import { afterEach, describe, expect, it } from "vitest";

import { RevFilter } from "../src/commands/log-command.js";
import { backends, createInitializedGitFromFactory, toArray } from "./test-helper.js";

describe.each(backends)("LogCommand ($name backend)", ({ factory }) => {
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

  describe("LogCommand", () => {
    it("should return commits from HEAD", async () => {
      const { git } = await createInitializedGit();

      // Create some commits
      await git.commit().setMessage("Second").setAllowEmpty(true).call();
      await git.commit().setMessage("Third").setAllowEmpty(true).call();

      const commits = await toArray(await git.log().call());

      expect(commits.length).toBe(3);
      expect(commits[0].message).toBe("Third");
      expect(commits[1].message).toBe("Second");
      expect(commits[2].message).toBe("Initial commit");
    });

    it("should limit commits with setMaxCount", async () => {
      const { git } = await createInitializedGit();

      await git.commit().setMessage("Second").setAllowEmpty(true).call();
      await git.commit().setMessage("Third").setAllowEmpty(true).call();
      await git.commit().setMessage("Fourth").setAllowEmpty(true).call();

      const commits = await toArray(await git.log().setMaxCount(2).call());

      expect(commits.length).toBe(2);
      expect(commits[0].message).toBe("Fourth");
      expect(commits[1].message).toBe("Third");
    });

    it("should skip commits with setSkip", async () => {
      const { git } = await createInitializedGit();

      await git.commit().setMessage("Second").setAllowEmpty(true).call();
      await git.commit().setMessage("Third").setAllowEmpty(true).call();
      await git.commit().setMessage("Fourth").setAllowEmpty(true).call();

      const commits = await toArray(await git.log().setSkip(1).call());

      expect(commits.length).toBe(3);
      expect(commits[0].message).toBe("Third");
      expect(commits[1].message).toBe("Second");
      expect(commits[2].message).toBe("Initial commit");
    });

    it("should combine skip and maxCount", async () => {
      const { git } = await createInitializedGit();

      await git.commit().setMessage("Second").setAllowEmpty(true).call();
      await git.commit().setMessage("Third").setAllowEmpty(true).call();
      await git.commit().setMessage("Fourth").setAllowEmpty(true).call();
      await git.commit().setMessage("Fifth").setAllowEmpty(true).call();

      const commits = await toArray(await git.log().setSkip(1).setMaxCount(2).call());

      expect(commits.length).toBe(2);
      expect(commits[0].message).toBe("Fourth");
      expect(commits[1].message).toBe("Third");
    });

    it("should start from specific commit", async () => {
      const { git, repository } = await createInitializedGit();

      const second = await git.commit().setMessage("Second").setAllowEmpty(true).call();
      const secondId = await repository.commits.store(second);

      await git.commit().setMessage("Third").setAllowEmpty(true).call();
      await git.commit().setMessage("Fourth").setAllowEmpty(true).call();

      // Start from second commit
      const commits = await toArray(await git.log().add(secondId).call());

      expect(commits.length).toBe(2);
      expect(commits[0].message).toBe("Second");
      expect(commits[1].message).toBe("Initial commit");
    });

    it("should not be callable twice", async () => {
      const { git } = await createInitializedGit();

      const cmd = git.log();
      await cmd.call();

      await expect(cmd.call()).rejects.toThrow(/already been called/);
    });

    it("should follow first parent only when set", async () => {
      const { git, repository } = await createInitializedGit();

      // Create two branches
      const main1 = await git.commit().setMessage("Main 1").setAllowEmpty(true).call();
      const _main1Id = await repository.commits.store(main1);

      // Create feature branch commit
      await git.branchCreate().setName("feature").call();

      // Make commits on main
      const main2 = await git.commit().setMessage("Main 2").setAllowEmpty(true).call();
      const _main2Id = await repository.commits.store(main2);

      // Checkout feature and make commit (simulated - we'd need checkout command)
      // For now just test that firstParent option works with linear history
      const commits = await toArray(await git.log().setFirstParent(true).call());

      // Should follow linear history
      expect(commits.length).toBeGreaterThan(0);
    });
  });

  describe("LogCommand with all refs", () => {
    it("should include commits from all refs when all() is called", async () => {
      const { git, repository } = await createInitializedGit();

      // Create commit on main
      const main1 = await git.commit().setMessage("Main commit").setAllowEmpty(true).call();
      const main1Id = await repository.commits.store(main1);

      // Create branch with different commit history
      await git.branchCreate().setName("feature").setStartPoint(main1Id).call();

      // Commits on main branch should be visible with all()
      const commits = await toArray(await git.log().all().call());

      // Should include all reachable commits
      expect(commits.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("LogCommand date filtering", () => {
    it("should filter commits by setSince", async () => {
      const { git } = await createInitializedGit();

      // Create commits with different timestamps
      const now = Math.floor(Date.now() / 1000);

      await git
        .commit()
        .setMessage("Old commit")
        .setAllowEmpty(true)
        .setCommitterIdent({
          name: "Test",
          email: "test@example.com",
          timestamp: now - 3600,
          tzOffset: "+0000",
        })
        .call();

      await git
        .commit()
        .setMessage("Recent commit")
        .setAllowEmpty(true)
        .setCommitterIdent({
          name: "Test",
          email: "test@example.com",
          timestamp: now - 60,
          tzOffset: "+0000",
        })
        .call();

      // Only get commits from last 30 minutes
      const commits = await toArray(
        await git
          .log()
          .setSince(now - 1800)
          .call(),
      );

      expect(commits.length).toBe(1);
      expect(commits[0].message).toBe("Recent commit");
    });

    it("should filter commits by setUntil", async () => {
      const { git } = await createInitializedGit();

      const now = Math.floor(Date.now() / 1000);

      await git
        .commit()
        .setMessage("Old commit")
        .setAllowEmpty(true)
        .setCommitterIdent({
          name: "Test",
          email: "test@example.com",
          timestamp: now - 3600,
          tzOffset: "+0000",
        })
        .call();

      await git
        .commit()
        .setMessage("Recent commit")
        .setAllowEmpty(true)
        .setCommitterIdent({
          name: "Test",
          email: "test@example.com",
          timestamp: now,
          tzOffset: "+0000",
        })
        .call();

      // Only get commits older than 30 minutes
      const commits = await toArray(
        await git
          .log()
          .setUntil(now - 1800)
          .call(),
      );

      // Should include old commit and initial commit
      expect(commits.some((c) => c.message === "Old commit")).toBe(true);
      expect(commits.every((c) => c.message !== "Recent commit")).toBe(true);
    });

    it("should combine setSince and setUntil", async () => {
      const { git } = await createInitializedGit();

      const now = Math.floor(Date.now() / 1000);

      await git
        .commit()
        .setMessage("Very old")
        .setAllowEmpty(true)
        .setCommitterIdent({
          name: "Test",
          email: "test@example.com",
          timestamp: now - 7200,
          tzOffset: "+0000",
        })
        .call();

      await git
        .commit()
        .setMessage("Middle")
        .setAllowEmpty(true)
        .setCommitterIdent({
          name: "Test",
          email: "test@example.com",
          timestamp: now - 3600,
          tzOffset: "+0000",
        })
        .call();

      await git
        .commit()
        .setMessage("Recent")
        .setAllowEmpty(true)
        .setCommitterIdent({
          name: "Test",
          email: "test@example.com",
          timestamp: now,
          tzOffset: "+0000",
        })
        .call();

      // Get commits between 2 hours ago and 30 minutes ago
      const commits = await toArray(
        await git
          .log()
          .setSince(now - 7200)
          .setUntil(now - 1800)
          .call(),
      );

      // Should include "Very old" and "Middle" but not "Recent"
      expect(commits.some((c) => c.message === "Very old")).toBe(true);
      expect(commits.some((c) => c.message === "Middle")).toBe(true);
      expect(commits.every((c) => c.message !== "Recent")).toBe(true);
    });
  });

  describe("LogCommand author filtering", () => {
    it("should filter by author name", async () => {
      const { git } = await createInitializedGit();

      await git
        .commit()
        .setMessage("By Alice")
        .setAllowEmpty(true)
        .setAuthor("Alice Smith", "alice@example.com")
        .call();

      await git
        .commit()
        .setMessage("By Bob")
        .setAllowEmpty(true)
        .setAuthor("Bob Jones", "bob@example.com")
        .call();

      const commits = await toArray(await git.log().setAuthorFilter("alice").call());

      expect(commits.length).toBe(1);
      expect(commits[0].message).toBe("By Alice");
    });

    it("should filter by author email", async () => {
      const { git } = await createInitializedGit();

      await git
        .commit()
        .setMessage("By Alice")
        .setAllowEmpty(true)
        .setAuthor("Alice Smith", "alice@example.com")
        .call();

      await git
        .commit()
        .setMessage("By Bob")
        .setAllowEmpty(true)
        .setAuthor("Bob Jones", "bob@example.com")
        .call();

      const commits = await toArray(await git.log().setAuthorFilter("bob@example.com").call());

      expect(commits.length).toBe(1);
      expect(commits[0].message).toBe("By Bob");
    });

    it("should filter by committer", async () => {
      const { git } = await createInitializedGit();

      await git
        .commit()
        .setMessage("Committed by Carol")
        .setAllowEmpty(true)
        .setCommitter("Carol Davis", "carol@example.com")
        .call();

      await git
        .commit()
        .setMessage("Committed by Dave")
        .setAllowEmpty(true)
        .setCommitter("Dave Wilson", "dave@example.com")
        .call();

      const commits = await toArray(await git.log().setCommitterFilter("carol").call());

      expect(commits.length).toBe(1);
      expect(commits[0].message).toBe("Committed by Carol");
    });
  });

  describe("LogCommand RevFilter", () => {
    it("should only return merge commits with ONLY_MERGES filter", async () => {
      const { git, repository } = await createInitializedGit();

      // Create base commit
      await git.commit().setMessage("m0").setAllowEmpty(true).call();

      // Create branch
      await git.branchCreate().setName("side").call();

      // Make commit on main
      await git.commit().setMessage("m1").setAllowEmpty(true).call();

      // Get current HEAD as main branch head
      const mainRef = await repository.refs.resolve("HEAD");
      const mainId = mainRef?.objectId ?? "";

      // Switch to side branch by updating HEAD
      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideId = sideRef?.objectId ?? "";
      await repository.refs.set("HEAD", sideId);

      // Make commit on side
      await git.commit().setMessage("s0").setAllowEmpty(true).call();
      const sideHeadRef = await repository.refs.resolve("HEAD");
      const sideHeadId = sideHeadRef?.objectId ?? "";

      // Switch back to main
      await repository.refs.set("HEAD", mainId);

      // Merge side into main
      await git.merge().include(sideHeadId).setMessage("merge s0 with m1").call();

      // Get all commits
      const allCommits = await toArray(await git.log().all().call());
      expect(allCommits.some((c) => c.message === "merge s0 with m1")).toBe(true);
      expect(allCommits.some((c) => c.message === "s0")).toBe(true);
      expect(allCommits.some((c) => c.message === "m1")).toBe(true);
      expect(allCommits.some((c) => c.message === "m0")).toBe(true);

      // Only merge commits
      const mergeCommits = await toArray(
        await git.log().setRevFilter(RevFilter.ONLY_MERGES).call(),
      );
      expect(mergeCommits.length).toBe(1);
      expect(mergeCommits[0].message).toBe("merge s0 with m1");
    });

    it("should exclude merge commits with NO_MERGES filter", async () => {
      const { git, repository } = await createInitializedGit();

      // Create base commit
      await git.commit().setMessage("m0").setAllowEmpty(true).call();

      // Create branch
      await git.branchCreate().setName("side").call();

      // Make commit on main
      await git.commit().setMessage("m1").setAllowEmpty(true).call();

      // Get current HEAD as main branch head
      const mainRef = await repository.refs.resolve("HEAD");
      const mainId = mainRef?.objectId ?? "";

      // Switch to side branch
      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideId = sideRef?.objectId ?? "";
      await repository.refs.set("HEAD", sideId);

      // Make commit on side
      await git.commit().setMessage("s0").setAllowEmpty(true).call();
      const sideHeadRef = await repository.refs.resolve("HEAD");
      const sideHeadId = sideHeadRef?.objectId ?? "";

      // Switch back to main
      await repository.refs.set("HEAD", mainId);

      // Merge side into main
      await git.merge().include(sideHeadId).setMessage("merge s0 with m1").call();

      // No merge commits (excludes merge)
      const nonMergeCommits = await toArray(
        await git.log().setRevFilter(RevFilter.NO_MERGES).call(),
      );

      // Should not contain the merge commit
      expect(nonMergeCommits.every((c) => c.message !== "merge s0 with m1")).toBe(true);
      // Should contain the non-merge commits
      expect(nonMergeCommits.some((c) => c.message === "m1")).toBe(true);
      expect(nonMergeCommits.some((c) => c.message === "s0")).toBe(true);
      expect(nonMergeCommits.some((c) => c.message === "m0")).toBe(true);
    });
  });

  describe("LogCommand addRange", () => {
    it("should return commits in range (since..until)", async () => {
      const { git, repository } = await createInitializedGit();

      // Create: A - B - C - M
      //              \     /
      //               - D (side)

      // A (initial already exists)
      // B
      await git.commit().setMessage("commit b").setAllowEmpty(true).call();
      const bRef = await repository.refs.resolve("HEAD");
      const bId = bRef?.objectId ?? "";

      // C
      await git.commit().setMessage("commit c").setAllowEmpty(true).call();
      const cRef = await repository.refs.resolve("HEAD");
      const cId = cRef?.objectId ?? "";

      // Create side branch at B
      await repository.refs.set("refs/heads/side", bId);
      await repository.refs.set("HEAD", bId);

      // D on side
      await git.commit().setMessage("commit d").setAllowEmpty(true).call();
      const dRef = await repository.refs.resolve("HEAD");
      const dId = dRef?.objectId ?? "";

      // Switch back to main (at C)
      await repository.refs.set("HEAD", cId);

      // Merge D into main
      const mergeResult = await git.merge().include(dId).call();
      const mergeHeadId = mergeResult.newHead ?? "";

      // Range from B to merge head (should include M, C, D but not B or A)
      const rangeCommits = await toArray(await git.log().addRange(bId, mergeHeadId).call());

      // Should include merge commit, C, and D
      expect(rangeCommits.length).toBe(3);

      const messages = rangeCommits.map((c) => c.message);
      expect(messages).toContain("commit c");
      expect(messages).toContain("commit d");

      // Should not include B or Initial
      expect(messages.every((m) => m !== "commit b")).toBe(true);
      expect(messages.every((m) => m !== "Initial commit")).toBe(true);
    });
  });

  describe("LogCommand not() exclusion", () => {
    it("should exclude commits reachable from not() target", async () => {
      const { git, repository } = await createInitializedGit();

      // Create base commit
      await git.commit().setMessage("Base").setAllowEmpty(true).call();
      const baseRef = await repository.refs.resolve("HEAD");
      const baseId = baseRef?.objectId ?? "";

      // Create more commits
      await git.commit().setMessage("Feature 1").setAllowEmpty(true).call();
      await git.commit().setMessage("Feature 2").setAllowEmpty(true).call();

      // Get commits excluding base and its ancestors
      const commits = await toArray(await git.log().not(baseId).call());

      expect(commits.length).toBe(2);
      expect(commits[0].message).toBe("Feature 2");
      expect(commits[1].message).toBe("Feature 1");
      // Base and Initial should be excluded
      expect(commits.every((c) => c.message !== "Base")).toBe(true);
      expect(commits.every((c) => c.message !== "Initial commit")).toBe(true);
    });

    it("should support multiple not() calls", async () => {
      const { git, repository } = await createInitializedGit();

      // Create commit chain
      await git.commit().setMessage("C1").setAllowEmpty(true).call();
      const c1Ref = await repository.refs.resolve("HEAD");
      const c1Id = c1Ref?.objectId ?? "";

      await git.commit().setMessage("C2").setAllowEmpty(true).call();
      const c2Ref = await repository.refs.resolve("HEAD");
      const c2Id = c2Ref?.objectId ?? "";

      await git.commit().setMessage("C3").setAllowEmpty(true).call();

      // Exclude both C1 and C2 explicitly
      const commits = await toArray(await git.log().not(c1Id).not(c2Id).call());

      expect(commits.length).toBe(1);
      expect(commits[0].message).toBe("C3");
    });
  });

  /**
   * JGit-ported tests: excludePath
   */
  describe("LogCommand excludePath (JGit parity)", () => {
    it("should support excludePath method", async () => {
      const { git } = await createInitializedGit();

      // Just test that the method exists and is chainable
      const command = git.log().excludePath("some/path").excludePath("another/path");
      expect(command).toBeDefined();
    });
  });
});
