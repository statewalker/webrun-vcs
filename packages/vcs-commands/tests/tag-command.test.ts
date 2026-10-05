/**
 * Tests for TagCommand (create, delete, list)
 *
 * Based on JGit's TagCommandTest.java
 * Tests run against all storage backends (Memory, SQL).
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  InvalidTagNameError,
  RefAlreadyExistsError,
  RefNotFoundError,
} from "../src/errors/index.js";
import { backends, createInitializedGitFromFactory } from "./test-helper.js";

describe.each(backends)("TagCommand ($name backend)", ({ factory }) => {
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

  describe("TagCommand", () => {
    it("should create lightweight tag at HEAD", async () => {
      const { git, initialCommitId } = await createInitializedGit();

      const ref = await git.tag().setName("v1.0.0").call();

      expect(ref.name).toBe("refs/tags/v1.0.0");
      expect(ref.objectId).toBe(initialCommitId);
    });

    it("should create lightweight tag at specific commit", async () => {
      const { git, initialCommitId } = await createInitializedGit();

      // Create more commits
      await git.commit().setMessage("Second").setAllowEmpty(true).call();

      // Tag the initial commit
      const ref = await git.tag().setName("v0.0.1").setObjectId(initialCommitId).call();

      expect(ref.objectId).toBe(initialCommitId);
    });

    it("should create annotated tag", async () => {
      const { git, repository } = await createInitializedGit();

      const ref = await git
        .tag()
        .setName("v1.0.0")
        .setAnnotated(true)
        .setMessage("Release version 1.0.0")
        .setTagger("Release Bot", "release@example.com")
        .call();

      expect(ref.name).toBe("refs/tags/v1.0.0");

      // Annotated tag should point to a tag object, not directly to commit
      const tagId = ref.objectId;
      expect(tagId).toBeDefined();

      // The tag object should exist
      const tag = await repository.tags?.load(tagId ?? "");
      expect(tag?.message).toBe("Release version 1.0.0");
      expect(tag?.tagger?.name).toBe("Release Bot");
    });

    it("should create annotated tag when message is provided", async () => {
      const { git, repository } = await createInitializedGit();

      const ref = await git.tag().setName("v1.0.0").setMessage("Release").call();

      // Should be annotated (stored as tag object)
      const tagId = ref.objectId;
      const tag = await repository.tags?.load(tagId ?? "");
      expect(tag).toBeDefined();
    });

    it("should reject invalid tag names", async () => {
      const { git } = await createInitializedGit();

      await expect(git.tag().setName("v1..0").call()).rejects.toThrow(InvalidTagNameError);
      await expect(git.tag().setName("-v1.0").call()).rejects.toThrow(InvalidTagNameError);
      await expect(git.tag().setName("v1.0.lock").call()).rejects.toThrow(InvalidTagNameError);
    });

    it("should reject duplicate tag without force", async () => {
      const { git } = await createInitializedGit();

      await git.tag().setName("v1.0.0").call();

      await expect(git.tag().setName("v1.0.0").call()).rejects.toThrow(RefAlreadyExistsError);
    });

    it("should overwrite tag with force", async () => {
      const { git, repository } = await createInitializedGit();

      // Create tag at initial commit
      await git.tag().setName("v1.0.0").call();

      // Create new commit
      const commit = await git.commit().setMessage("New").setAllowEmpty(true).call();
      const _commitId = await repository.commits.store(commit);

      // Force re-tag at new commit
      const ref = await git.tag().setName("v1.0.0").setForce(true).call();

      // Should point to latest HEAD
      const headRef = await repository.refs.resolve("HEAD");
      expect(ref.objectId).toBe(headRef?.objectId);
    });

    it("should require tag name", async () => {
      const { git } = await createInitializedGit();

      await expect(git.tag().call()).rejects.toThrow(InvalidTagNameError);
    });
  });

  describe("DeleteTagCommand", () => {
    it("should delete tag", async () => {
      const { git, repository } = await createInitializedGit();

      await git.tag().setName("v1.0.0").call();
      expect(await repository.refs.has("refs/tags/v1.0.0")).toBe(true);

      const deleted = await git.tagDelete().setTags("v1.0.0").call();

      expect(deleted).toEqual(["refs/tags/v1.0.0"]);
      expect(await repository.refs.has("refs/tags/v1.0.0")).toBe(false);
    });

    it("should delete multiple tags", async () => {
      const { git } = await createInitializedGit();

      await git.tag().setName("v1.0.0").call();
      await git.tag().setName("v1.0.1").call();

      const deleted = await git.tagDelete().setTags("v1.0.0", "v1.0.1").call();

      expect(deleted.length).toBe(2);
    });

    it("should reject deleting non-existent tag", async () => {
      const { git } = await createInitializedGit();

      await expect(git.tagDelete().setTags("nonexistent").call()).rejects.toThrow(RefNotFoundError);
    });
  });

  describe("ListTagCommand", () => {
    it("should list tags", async () => {
      const { git } = await createInitializedGit();

      await git.tag().setName("v1.0.0").call();
      await git.tag().setName("v1.1.0").call();
      await git.tag().setName("v2.0.0").call();

      const tags = await git.tagList().call();

      const names = tags.map((t) => t.name);
      expect(names).toContain("refs/tags/v1.0.0");
      expect(names).toContain("refs/tags/v1.1.0");
      expect(names).toContain("refs/tags/v2.0.0");
    });

    it("should return tags in sorted order", async () => {
      const { git } = await createInitializedGit();

      await git.tag().setName("z-tag").call();
      await git.tag().setName("a-tag").call();
      await git.tag().setName("m-tag").call();

      const tags = await git.tagList().call();
      const names = tags.map((t) => t.name);

      expect(names.indexOf("refs/tags/a-tag")).toBeLessThan(names.indexOf("refs/tags/m-tag"));
      expect(names.indexOf("refs/tags/m-tag")).toBeLessThan(names.indexOf("refs/tags/z-tag"));
    });

    it("should return empty array when no tags", async () => {
      const { git } = await createInitializedGit();

      const tags = await git.tagList().call();

      expect(tags).toEqual([]);
    });
  });
});
