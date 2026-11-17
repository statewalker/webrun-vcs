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
import { createGitFilesHistoryFromFiles } from "@statewalker/vcs-store-files";
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

      expect(commit.message).toBe("First commit\n");
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

    // Regression (webrun-vcs#88): init with a FilesApi kept the repository in memory, so
    // nothing reached `.git` and a browser-filesystem repository vanished on reload.
    it("should write the repository to the provided FilesApi", async () => {
      const files = createInMemoryFilesApi();
      const result = await Git.init().setFilesApi(files).setGitDir(".git").call();

      const commit = await result.git
        .commit()
        .setMessage("Persisted")
        .setAuthor("Test", "test@example.com")
        .setAllowEmpty(true)
        .call();

      const head = new TextDecoder().decode(await collect(files.read(".git/HEAD")));
      expect(head).toBe("ref: refs/heads/main\n");
      const branch = new TextDecoder().decode(await collect(files.read(".git/refs/heads/main")));
      expect(branch.trim()).toBe(commit.id);

      // Reopening the same files finds the commit.
      const reopened = await createGitFilesHistoryFromFiles({ files, gitDir: ".git" });
      await reopened.initialize();
      expect((await reopened.refs.resolve("HEAD"))?.objectId).toBe(commit.id);
    });

    it("should keep an existing repository's HEAD when initialized again", async () => {
      const files = createInMemoryFilesApi();
      const first = await Git.init().setFilesApi(files).setGitDir(".git").call();
      const commit = await first.git
        .commit()
        .setMessage("First")
        .setAuthor("Test", "test@example.com")
        .setAllowEmpty(true)
        .call();
      await files.write(".git/HEAD", [new TextEncoder().encode("ref: refs/heads/topic\n")]);
      await files.write(".git/refs/heads/topic", [new TextEncoder().encode(`${commit.id}\n`)]);

      const again = await Git.init().setFilesApi(files).setGitDir(".git").call();

      expect(await again.workingCopy.getCurrentBranch()).toBe("topic");
      expect((await again.repository.refs.resolve("HEAD"))?.objectId).toBe(commit.id);
    });

    it("should keep staged files across a reopen, so the next commit keeps them", async () => {
      const files = createInMemoryFilesApi();
      const enc = new TextEncoder();
      const first = await Git.init().setFilesApi(files).setGitDir(".git").setWorktree(true).call();
      await files.write("a.txt", [enc.encode("a")]);
      await first.git.add().addFilepattern("a.txt").call();
      await first.git.commit().setMessage("a").setAuthor("T", "t@t").call();

      const again = await Git.init().setFilesApi(files).setGitDir(".git").setWorktree(true).call();
      await files.write("b.txt", [enc.encode("b")]);
      await again.git.add().addFilepattern("b.txt").call();
      const second = await again.git.commit().setMessage("b").setAuthor("T", "t@t").call();

      const tree = await again.repository.trees.load(second.tree);
      if (!tree) throw new Error("tree not found");
      const names = (await toArray(tree)).map((e) => e.name);
      expect(names.sort()).toEqual(["a.txt", "b.txt"]);
    });

    it("should keep an existing config when HEAD is missing", async () => {
      const files = createInMemoryFilesApi();
      const config = '[core]\n\tbare = false\n[remote "origin"]\n\turl = keep\n';
      await files.write(".git/config", [new TextEncoder().encode(config)]);

      await Git.init().setFilesApi(files).setGitDir(".git").call();

      const after = new TextDecoder().decode(await collect(files.read(".git/config")));
      expect(after).toContain('[remote "origin"]');
      const head = new TextDecoder().decode(await collect(files.read(".git/HEAD")));
      expect(head.trim()).toBe("ref: refs/heads/main");
    });

    it("should write core.bare = true for a bare repository", async () => {
      const files = createInMemoryFilesApi();
      await Git.init().setFilesApi(files).setDirectory("repo.git").setBare(true).call();

      const config = new TextDecoder().decode(await collect(files.read("repo.git/config")));
      expect(config).toMatch(/bare = true/);
    });

    it("keeps bytes that are no UTF-8 when it sets core.bare in the config", async () => {
      const files = createInMemoryFilesApi();
      // a config line in latin-1 (a template's, say): "# caf\xe9" stays those bytes
      const write = files.write.bind(files);
      files.write = async (path, content) => {
        if (path.replace(/^\/+/, "") !== "repo.git/config") return write(path, content);
        const bytes = await collect(content as AsyncIterable<Uint8Array>);
        const head = new TextDecoder().decode(bytes);
        if (head.includes("caf")) return write(path, [bytes]);
        return write(path, [bytes, new Uint8Array([0x23, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a])]);
      };
      await Git.init().setFilesApi(files).setDirectory("repo.git").setBare(true).call();

      const config = await collect(files.read("repo.git/config"));
      expect(new TextDecoder().decode(config)).toMatch(/bare = true/);
      expect([...config.slice(-7)]).toEqual([0x23, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a]);
    });
  });

  describe("Custom staging store", () => {
    it("should use provided staging store", async () => {
      const staging = new MemoryStagingStore();
      const result = await Git.init().setStagingStore(staging).call();

      // The store should be using our staging store
      expect(result.workingCopy.checkout.staging).toBe(staging);
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
      expect(commits[0].message).toBe("Second commit\n");
      expect(commits[1].message).toBe("First commit\n");
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

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
