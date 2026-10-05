/**
 * Parametrized test suite for Tags implementations
 *
 * This suite tests the core Tags interface contract.
 * All storage implementations must pass these tests.
 */

import type { AnnotatedTag, ObjectTypeCode, PersonIdent, Tags } from "@statewalker/vcs-core";
import { ObjectType } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Context provided by the storage factory
 */
export interface TagStoreTestContext {
  tagStore: Tags;
  cleanup?: () => Promise<void>;
}

/**
 * Factory function to create a storage instance for testing
 */
export type TagStoreFactory = () => Promise<TagStoreTestContext>;

/**
 * Helper function to generate a fake object ID (for testing)
 */
function fakeObjectId(seed: string): string {
  return seed.padEnd(40, "0").slice(0, 40);
}

/**
 * Helper function to create a test person identity
 */
function createPerson(name: string, timestamp: number): PersonIdent {
  return {
    name,
    email: `${name.toLowerCase().replace(/\s/g, ".")}@example.com`,
    timestamp,
    tzOffset: "+0000",
  };
}

/**
 * Helper function to create a test annotated tag
 */
function createTag(options: {
  object?: string;
  objectType?: ObjectTypeCode;
  tag: string;
  message: string;
  tagger?: PersonIdent;
}): AnnotatedTag {
  return {
    object: options.object ?? fakeObjectId("commit"),
    objectType: options.objectType ?? ObjectType.COMMIT,
    tag: options.tag,
    tagger: options.tagger ?? createPerson("Test Tagger", Date.now()),
    message: options.message,
  };
}

/**
 * Create the Tags test suite with a specific factory
 *
 * @param name Name of the storage implementation (e.g., "Memory", "SQL", "KV")
 * @param factory Factory function to create storage instances
 */
export function createTagStoreTests(name: string, factory: TagStoreFactory): void {
  describe(`TagStore [${name}]`, () => {
    let ctx: TagStoreTestContext;

    beforeEach(async () => {
      ctx = await factory();
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    describe("Basic Operations", () => {
      it("stores and retrieves tags", async () => {
        const tag = createTag({ tag: "v1.0.0", message: "Version 1.0.0" });
        const id = await ctx.tagStore.store(tag);

        expect(id).toBeDefined();
        expect(typeof id).toBe("string");

        const loaded = await ctx.tagStore.load(id);
        expect(loaded).toBeDefined();
        expect(loaded?.tag).toBe("v1.0.0");
        expect(loaded?.message).toBe("Version 1.0.0");
      });

      it("returns consistent IDs for same tag", async () => {
        const tag = createTag({
          tag: "v1.0.0",
          message: "Test",
          tagger: createPerson("Tagger", 1000000),
        });

        const id1 = await ctx.tagStore.store(tag);
        const id2 = await ctx.tagStore.store(tag);
        expect(id1).toBe(id2);
      });

      it("returns different IDs for different tags", async () => {
        const tag1 = createTag({
          tag: "v1.0.0",
          message: "Version 1",
          tagger: createPerson("Tagger", 1000000),
        });
        const tag2 = createTag({
          tag: "v2.0.0",
          message: "Version 2",
          tagger: createPerson("Tagger", 1000001),
        });

        const id1 = await ctx.tagStore.store(tag1);
        const id2 = await ctx.tagStore.store(tag2);
        expect(id1).not.toBe(id2);
      });

      it("checks existence via has", async () => {
        const tag = createTag({ tag: "v1.0.0", message: "Test" });
        const id = await ctx.tagStore.store(tag);

        expect(await ctx.tagStore.has(id)).toBe(true);
        expect(await ctx.tagStore.has("nonexistent-tag-id-0000000000")).toBe(false);
      });
    });

    describe("Tag Properties", () => {
      it("preserves tagged object reference", async () => {
        const objectId = fakeObjectId("targetcommit");
        const tag = createTag({
          object: objectId,
          objectType: ObjectType.COMMIT,
          tag: "v1.0.0",
          message: "Test",
        });
        const id = await ctx.tagStore.store(tag);

        const loaded = await ctx.tagStore.load(id);
        expect(loaded?.object).toBe(objectId);
      });

      it("preserves object type", async () => {
        const tag = createTag({
          objectType: ObjectType.TREE,
          tag: "tree-tag",
          message: "Tag pointing to tree",
        });
        const id = await ctx.tagStore.store(tag);

        const loaded = await ctx.tagStore.load(id);
        expect(loaded?.objectType).toBe(ObjectType.TREE);
      });

      it("preserves tag name", async () => {
        const tag = createTag({ tag: "release-candidate-1", message: "Test" });
        const id = await ctx.tagStore.store(tag);

        const loaded = await ctx.tagStore.load(id);
        expect(loaded?.tag).toBe("release-candidate-1");
      });

      it("preserves tagger information", async () => {
        const tagger: PersonIdent = {
          name: "Jane Tagger",
          email: "jane@example.com",
          timestamp: 1234567890,
          tzOffset: "-0800",
        };
        const tag = createTag({ tag: "v1.0.0", message: "Test", tagger });
        const id = await ctx.tagStore.store(tag);

        const loaded = await ctx.tagStore.load(id);
        expect(loaded?.tagger).toBeDefined();
        expect(loaded?.tagger?.name).toBe("Jane Tagger");
        expect(loaded?.tagger?.email).toBe("jane@example.com");
        expect(loaded?.tagger?.timestamp).toBe(1234567890);
        expect(loaded?.tagger?.tzOffset).toBe("-0800");
      });

      it("preserves multi-line tag message", async () => {
        const message = "Release v1.0.0\n\nThis release includes:\n- Feature A\n- Feature B";
        const tag = createTag({ tag: "v1.0.0", message });
        const id = await ctx.tagStore.store(tag);

        const loaded = await ctx.tagStore.load(id);
        expect(loaded?.message).toBe(message);
      });
    });

    describe("Target Retrieval", () => {
      it("gets target object without peeling", async () => {
        const targetId = fakeObjectId("targetcommit");
        const tag = createTag({
          object: targetId,
          objectType: ObjectType.COMMIT,
          tag: "v1.0.0",
          message: "Test",
        });
        const id = await ctx.tagStore.store(tag);

        const target = await ctx.tagStore.getTarget(id);
        expect(target).toBe(targetId);
      });

      it("gets target with peeling for commit tag", async () => {
        const commitId = fakeObjectId("commit");
        const tag = createTag({
          object: commitId,
          objectType: ObjectType.COMMIT,
          tag: "v1.0.0",
          message: "Test",
        });
        const id = await ctx.tagStore.store(tag);

        // Peeling a tag pointing to a commit returns the commit
        const target = await ctx.tagStore.getTarget(id, true);
        expect(target).toBe(commitId);
      });

      it("follows tag chains when peeling", async () => {
        // Create nested tags: tag1 -> tag2 -> commit
        const commitId = fakeObjectId("commit");

        // Inner tag pointing to commit
        const innerTag = createTag({
          object: commitId,
          objectType: ObjectType.COMMIT,
          tag: "inner",
          message: "Inner tag",
        });
        const innerTagId = await ctx.tagStore.store(innerTag);

        // Outer tag pointing to inner tag
        const outerTag = createTag({
          object: innerTagId,
          objectType: ObjectType.TAG,
          tag: "outer",
          message: "Outer tag",
        });
        const outerTagId = await ctx.tagStore.store(outerTag);

        // Without peel - returns the inner tag
        const withoutPeel = await ctx.tagStore.getTarget(outerTagId, false);
        expect(withoutPeel).toBe(innerTagId);

        // With peel - follows chain to commit
        const withPeel = await ctx.tagStore.getTarget(outerTagId, true);
        expect(withPeel).toBe(commitId);
      });
    });

    describe("Optional Fields", () => {
      it("handles tag without tagger", async () => {
        const tag: AnnotatedTag = {
          object: fakeObjectId("commit"),
          objectType: ObjectType.COMMIT,
          tag: "v1.0.0",
          message: "Unsigned tag",
          // No tagger field
        };
        const id = await ctx.tagStore.store(tag);

        const loaded = await ctx.tagStore.load(id);
        expect(loaded?.tagger).toBeUndefined();
      });

      it("preserves encoding field", async () => {
        const tag = createTag({ tag: "v1.0.0", message: "Test" });
        (tag as AnnotatedTag & { encoding?: string }).encoding = "ISO-8859-1";
        const id = await ctx.tagStore.store(tag);

        const loaded = await ctx.tagStore.load(id);
        expect((loaded as (AnnotatedTag & { encoding?: string }) | undefined)?.encoding).toBe(
          "ISO-8859-1",
        );
      });

      it("preserves GPG signature", async () => {
        const tag = createTag({ tag: "v1.0.0", message: "Test" });
        (tag as AnnotatedTag & { gpgSignature?: string }).gpgSignature =
          "-----BEGIN PGP SIGNATURE-----\ntest\n-----END PGP SIGNATURE-----";
        const id = await ctx.tagStore.store(tag);

        const loaded = await ctx.tagStore.load(id);
        expect(
          (loaded as (AnnotatedTag & { gpgSignature?: string }) | undefined)?.gpgSignature,
        ).toBe((tag as AnnotatedTag & { gpgSignature?: string }).gpgSignature);
      });
    });

    describe("Different Object Types", () => {
      it("handles tag pointing to blob", async () => {
        const tag = createTag({
          object: fakeObjectId("blob"),
          objectType: ObjectType.BLOB,
          tag: "blob-tag",
          message: "Tag pointing to blob",
        });
        const id = await ctx.tagStore.store(tag);

        const loaded = await ctx.tagStore.load(id);
        expect(loaded?.objectType).toBe(ObjectType.BLOB);
      });

      it("handles tag pointing to tree", async () => {
        const tag = createTag({
          object: fakeObjectId("tree"),
          objectType: ObjectType.TREE,
          tag: "tree-tag",
          message: "Tag pointing to tree",
        });
        const id = await ctx.tagStore.store(tag);

        const loaded = await ctx.tagStore.load(id);
        expect(loaded?.objectType).toBe(ObjectType.TREE);
      });
    });

    describe("Not Found Handling", () => {
      it("returns undefined for non-existent tag", async () => {
        const result = await ctx.tagStore.load("nonexistent-tag-id-0000000000");
        expect(result).toBeUndefined();
      });
    });

    describe("Unicode Content", () => {
      it("handles unicode tag name", async () => {
        const tag = createTag({ tag: "версия-1.0", message: "Russian version tag" });
        const id = await ctx.tagStore.store(tag);

        const loaded = await ctx.tagStore.load(id);
        expect(loaded?.tag).toBe("версия-1.0");
      });

      it("handles unicode message", async () => {
        const message = "发布版本 1.0\n\n这是一个重要的版本";
        const tag = createTag({ tag: "v1.0.0", message });
        const id = await ctx.tagStore.store(tag);

        const loaded = await ctx.tagStore.load(id);
        expect(loaded?.message).toBe(message);
      });

      it("handles unicode tagger name", async () => {
        const tagger: PersonIdent = {
          name: "田中太郎",
          email: "tanaka@example.com",
          timestamp: 1234567890,
          tzOffset: "+0900",
        };
        const tag = createTag({ tag: "v1.0.0", message: "Test", tagger });
        const id = await ctx.tagStore.store(tag);

        const loaded = await ctx.tagStore.load(id);
        expect(loaded?.tagger?.name).toBe("田中太郎");
      });
    });
  });
}
