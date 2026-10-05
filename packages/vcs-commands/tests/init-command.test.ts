/**
 * Tests for InitCommand
 *
 * Tests repository initialization including:
 * - In-memory and file-based initialization
 * - Bare repository creation
 * - Custom initial branch configuration
 * - Worktree support
 * - Callable-once enforcement
 * - Integration with Git facade
 */

import { createInMemoryFilesApi } from "@statewalker/vcs-core";
import { MemoryStagingStore } from "@statewalker/vcs-store-mem";
import { describe, expect, it } from "vitest";

import { InitCommand } from "../src/commands/init-command.js";
import { Git } from "../src/index.js";
import { toArray } from "./test-helper.js";

describe("InitCommand", () => {
  describe("Basic initialization", () => {
    it("should create repository with default settings", async () => {
      const result = await Git.init().call();

      expect(result.git).toBeInstanceOf(Git);
      expect(result.workingCopy).toBeDefined();
      expect(result.repository).toBeDefined();
      expect(result.initialBranch).toBe("main");
      expect(result.bare).toBe(false);
      expect(result.gitDir).toBe(".git");
    });

    it("should create repository with Git.init() static factory", async () => {
      const command = Git.init();
      expect(command).toBeInstanceOf(InitCommand);

      const result = await command.call();
      expect(result.git).toBeDefined();
    });

    it("should return valid Git instance that can execute commands", async () => {
      const result = await Git.init().call();

      // Should be able to create commits
      const commit = await result.git
        .commit()
        .setMessage("First commit")
        .setAuthor("Test", "test@example.com")
        .setAllowEmpty(true)
        .call();

      expect(commit.message).toBe("First commit");
      expect(commit.parents.length).toBe(0); // Initial commit has no parents
    });

    it("should set HEAD pointing to initial branch", async () => {
      const result = await Git.init().call();

      const head = await result.repository.refs.get("HEAD");
      expect(head).toBeDefined();
      expect(head && "target" in head && head.target).toBe("refs/heads/main");
    });
  });

  describe("Custom initial branch", () => {
    it("should use specified branch name", async () => {
      const result = await Git.init().setInitialBranch("master").call();

      expect(result.initialBranch).toBe("master");

      const head = await result.repository.refs.get("HEAD");
      expect(head && "target" in head && head.target).toBe("refs/heads/master");
    });

    it("should use custom branch name for commits", async () => {
      const result = await Git.init().setInitialBranch("develop").call();

      // Create a commit
      await result.git
        .commit()
        .setMessage("Test commit")
        .setAuthor("Test", "test@example.com")
        .setAllowEmpty(true)
        .call();

      // Verify branch ref exists
      const branchRef = await result.repository.refs.get("refs/heads/develop");
      expect(branchRef).toBeDefined();
      expect(branchRef && "objectId" in branchRef).toBe(true);
    });
  });

  describe("Bare repository", () => {
    it("should create bare repository when setBare(true)", async () => {
      const result = await Git.init().setBare(true).call();

      expect(result.bare).toBe(true);
    });

    it("should set gitDir as directory for bare repositories", async () => {
      const result = await Git.init().setDirectory("/path/to/repo.git").setBare(true).call();

      expect(result.gitDir).toBe("/path/to/repo.git");
    });

    it("should not create worktree for bare repositories", async () => {
      const result = await Git.init()
        .setBare(true)
        .setWorktree(true) // Should be ignored
        .call();

      expect(result.bare).toBe(true);
      // Worktree should not be set for bare repos
      expect(result.workingCopy.worktree).toBeUndefined();
    });
  });

  describe("Directory resolution", () => {
    it("should use .git inside directory for non-bare repos", async () => {
      const result = await Git.init().setDirectory("/path/to/project").call();

      expect(result.gitDir).toBe("/path/to/project/.git");
    });

    it("should use explicit gitDir when specified", async () => {
      const result = await Git.init().setGitDir("/custom/.git").call();

      expect(result.gitDir).toBe("/custom/.git");
    });

    it("should prefer explicit gitDir over derived path", async () => {
      const result = await Git.init()
        .setDirectory("/path/to/project")
        .setGitDir("/custom/location/.git")
        .call();

      expect(result.gitDir).toBe("/custom/location/.git");
    });
  });

  describe("Custom FilesApi", () => {
    it("should use provided FilesApi", async () => {
      const files = createInMemoryFilesApi();
      const result = await Git.init().setFilesApi(files).call();

      expect(result.repository).toBeDefined();

      // Should be able to create commits
      const commit = await result.git
        .commit()
        .setMessage("Test")
        .setAuthor("Test", "test@example.com")
        .setAllowEmpty(true)
        .call();

      expect(commit).toBeDefined();
    });
  });

  describe("Custom staging store", () => {
    it("should use provided staging store", async () => {
      const staging = new MemoryStagingStore();
      const result = await Git.init().setStagingStore(staging).call();

      // The store should be using our staging store
      expect(result.workingCopy.staging).toBe(staging);
    });
  });

  describe("Worktree support", () => {
    it("should enable worktree when setWorktree(true)", async () => {
      const files = createInMemoryFilesApi();
      const result = await Git.init().setFilesApi(files).setWorktree(true).call();

      // Store should have worktree
      expect(result.workingCopy.worktree).toBeDefined();
    });

    it("should not enable worktree by default", async () => {
      const result = await Git.init().call();

      expect(result.workingCopy.worktree).toBeUndefined();
    });
  });

  describe("Callable-once enforcement", () => {
    it("should throw when calling call() twice", async () => {
      const command = Git.init();
      await command.call();

      await expect(command.call()).rejects.toThrow(/only be called once/);
    });

    it("should throw when modifying after call", async () => {
      const command = Git.init();
      await command.call();

      expect(() => command.setInitialBranch("other")).toThrow(/only be called once/);
      expect(() => command.setDirectory("/path")).toThrow(/only be called once/);
      expect(() => command.setBare(true)).toThrow(/only be called once/);
    });
  });

  describe("Integration with Git commands", () => {
    it("should support commit workflow after init", async () => {
      const result = await Git.init().call();
      const { git } = result;

      // Create first commit
      await git
        .commit()
        .setMessage("First commit")
        .setAuthor("Test", "test@example.com")
        .setAllowEmpty(true)
        .call();

      // Create second commit
      await git
        .commit()
        .setMessage("Second commit")
        .setAuthor("Test", "test@example.com")
        .setAllowEmpty(true)
        .call();

      // Verify commits via log
      const commits = await toArray(await git.log().call());
      expect(commits.length).toBe(2);
      expect(commits[0].message).toBe("Second commit");
      expect(commits[1].message).toBe("First commit");
    });

    it("should support branch operations after init", async () => {
      const result = await Git.init().call();
      const { git } = result;

      // Create initial commit first
      await git
        .commit()
        .setMessage("Initial")
        .setAuthor("Test", "test@example.com")
        .setAllowEmpty(true)
        .call();

      // Create a branch
      await git.branchCreate().setName("feature").call();

      // List branches
      const branches = await git.branchList().call();
      const branchNames = branches.map((b) => b.name);

      // Branch names may include full ref path or just the name depending on implementation
      const hasMain = branchNames.some((n) => n === "main" || n.endsWith("/main"));
      const hasFeature = branchNames.some((n) => n === "feature" || n.endsWith("/feature"));
      expect(hasMain).toBe(true);
      expect(hasFeature).toBe(true);
    });

    it("should support tag operations after init", async () => {
      const result = await Git.init().call();
      const { git } = result;

      // Create initial commit
      await git
        .commit()
        .setMessage("Initial")
        .setAuthor("Test", "test@example.com")
        .setAllowEmpty(true)
        .call();

      // Create a tag
      await git.tag().setName("v1.0.0").call();

      // List tags
      const tags = await git.tagList().call();
      const tagNames = tags.map((t) => t.name);

      // Tag names may include full ref path or just the name depending on implementation
      const hasTag = tagNames.some((n) => n === "v1.0.0" || n.endsWith("/v1.0.0"));
      expect(hasTag).toBe(true);
    });
  });

  describe("Method chaining", () => {
    it("should support fluent API", async () => {
      const result = await Git.init()
        .setDirectory("/path/to/project")
        .setInitialBranch("develop")
        .setBare(false)
        .call();

      expect(result.initialBranch).toBe("develop");
      expect(result.bare).toBe(false);
      expect(result.gitDir).toBe("/path/to/project/.git");
    });
  });
});
