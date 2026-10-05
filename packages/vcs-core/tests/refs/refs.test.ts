/**
 * Tests for reference types and parsing
 *
 * Based on JGit RefTest and storage-git ref tests
 */

import { describe, expect, it } from "vitest";
import {
  createPeeledRef,
  createPeeledTagRef,
  createRef,
  createSymbolicRef,
  FETCH_HEAD,
  HEAD,
  isSymbolicRef,
  MERGE_HEAD,
  ORIG_HEAD,
  R_HEADS,
  R_REFS,
  R_REMOTES,
  R_TAGS,
  RefStorage,
  SYMREF_PREFIX,
} from "../../src/history/refs/ref-types.js";

describe("ref-types", () => {
  describe("createRef", () => {
    it("creates a basic ref", () => {
      const ref = createRef("refs/heads/main", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

      expect(ref.name).toBe("refs/heads/main");
      expect(ref.objectId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(ref.storage).toBe(RefStorage.LOOSE);
      expect(ref.peeled).toBe(false);
    });

    it("creates ref with custom storage", () => {
      const ref = createRef(
        "refs/heads/main",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        RefStorage.PACKED,
      );

      expect(ref.storage).toBe(RefStorage.PACKED);
    });

    it("creates ref with undefined objectId (unborn)", () => {
      const ref = createRef("refs/heads/main", undefined);

      expect(ref.objectId).toBeUndefined();
    });
  });

  describe("createPeeledRef", () => {
    it("creates a peeled non-tag ref", () => {
      const ref = createPeeledRef("refs/heads/main", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

      expect(ref.name).toBe("refs/heads/main");
      expect(ref.objectId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(ref.peeled).toBe(true);
      expect(ref.peeledObjectId).toBeUndefined();
    });
  });

  describe("createPeeledTagRef", () => {
    it("creates a peeled tag ref with target", () => {
      const ref = createPeeledTagRef(
        "refs/tags/v1.0",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // tag object
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", // target commit
      );

      expect(ref.name).toBe("refs/tags/v1.0");
      expect(ref.objectId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(ref.peeled).toBe(true);
      expect(ref.peeledObjectId).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    });
  });

  describe("createSymbolicRef", () => {
    it("creates a symbolic ref", () => {
      const ref = createSymbolicRef("HEAD", "refs/heads/main");

      expect(ref.name).toBe("HEAD");
      expect(ref.target).toBe("refs/heads/main");
      expect(ref.storage).toBe(RefStorage.LOOSE);
    });
  });

  describe("isSymbolicRef", () => {
    it("returns true for symbolic refs", () => {
      const ref = createSymbolicRef("HEAD", "refs/heads/main");
      expect(isSymbolicRef(ref)).toBe(true);
    });

    it("returns false for regular refs", () => {
      const ref = createRef("refs/heads/main", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(isSymbolicRef(ref)).toBe(false);
    });
  });

  describe("constants", () => {
    it("defines ref prefixes", () => {
      expect(R_REFS).toBe("refs/");
      expect(R_HEADS).toBe("refs/heads/");
      expect(R_TAGS).toBe("refs/tags/");
      expect(R_REMOTES).toBe("refs/remotes/");
    });

    it("defines special refs", () => {
      expect(HEAD).toBe("HEAD");
      expect(FETCH_HEAD).toBe("FETCH_HEAD");
      expect(ORIG_HEAD).toBe("ORIG_HEAD");
      expect(MERGE_HEAD).toBe("MERGE_HEAD");
    });

    it("defines symref prefix", () => {
      expect(SYMREF_PREFIX).toBe("ref: ");
    });
  });

  describe("RefStore enum", () => {
    it("has expected values", () => {
      expect(RefStorage.NEW).toBe("new");
      expect(RefStorage.LOOSE).toBe("loose");
      expect(RefStorage.PACKED).toBe("packed");
      expect(RefStorage.LOOSE_PACKED).toBe("loose_packed");
    });
  });
});
