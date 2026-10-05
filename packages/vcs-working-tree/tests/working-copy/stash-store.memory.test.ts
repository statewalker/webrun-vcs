import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStashStore } from "../../src/working-copy/stash-store.memory.js";

describe("MemoryStashStore", () => {
  let stash: MemoryStashStore;

  beforeEach(() => {
    stash = new MemoryStashStore();
  });

  describe("push", () => {
    it("should push a stash entry and return commit ID", async () => {
      const commitId = await stash.push("WIP: test changes");

      expect(commitId).toBeDefined();
      expect(commitId).toHaveLength(40);
    });

    it("should create entry with correct message", async () => {
      await stash.push("My stash message");

      const entries = [];
      for await (const entry of stash.list()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe("My stash message");
    });

    it("should use default message when none provided", async () => {
      await stash.push();

      const entries = [];
      for await (const entry of stash.list()) {
        entries.push(entry);
      }

      expect(entries[0].message).toBe("WIP on branch");
    });

    it("should increment indices of existing entries", async () => {
      await stash.push("First");
      await stash.push("Second");
      await stash.push("Third");

      const entries = [];
      for await (const entry of stash.list()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(3);
      expect(entries[0].index).toBe(0);
      expect(entries[0].message).toBe("Third");
      expect(entries[1].index).toBe(1);
      expect(entries[1].message).toBe("Second");
      expect(entries[2].index).toBe(2);
      expect(entries[2].message).toBe("First");
    });
  });

  describe("list", () => {
    it("should return empty for new stash", async () => {
      const entries = [];
      for await (const entry of stash.list()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(0);
    });

    it("should list entries in order (newest first)", async () => {
      await stash.push("First");
      await stash.push("Second");

      const entries = [];
      for await (const entry of stash.list()) {
        entries.push(entry);
      }

      expect(entries[0].message).toBe("Second");
      expect(entries[1].message).toBe("First");
    });
  });

  describe("drop", () => {
    it("should drop entry at index 0", async () => {
      await stash.push("First");
      await stash.push("Second");

      await stash.drop(0);

      const entries = [];
      for await (const entry of stash.list()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe("First");
      expect(entries[0].index).toBe(0);
    });

    it("should drop entry at specific index", async () => {
      await stash.push("First");
      await stash.push("Second");
      await stash.push("Third");

      await stash.drop(1);

      const entries = [];
      for await (const entry of stash.list()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(2);
      expect(entries[0].message).toBe("Third");
      expect(entries[1].message).toBe("First");
    });

    it("should throw for invalid index", async () => {
      await stash.push("First");

      await expect(stash.drop(5)).rejects.toThrow("No stash entry at index 5");
    });
  });

  describe("apply", () => {
    it("should not throw for valid index", async () => {
      await stash.push("First");

      await expect(stash.apply(0)).resolves.not.toThrow();
    });

    it("should throw for invalid index", async () => {
      await expect(stash.apply(0)).rejects.toThrow("No stash entry at index 0");
    });

    it("should not remove entry", async () => {
      await stash.push("First");

      await stash.apply(0);

      expect(stash.size).toBe(1);
    });
  });

  describe("pop", () => {
    it("should apply and drop top entry", async () => {
      await stash.push("First");
      await stash.push("Second");

      await stash.pop();

      const entries = [];
      for await (const entry of stash.list()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe("First");
    });
  });

  describe("clear", () => {
    it("should remove all entries", async () => {
      await stash.push("First");
      await stash.push("Second");
      await stash.push("Third");

      await stash.clear();

      expect(stash.size).toBe(0);
    });
  });

  describe("size", () => {
    it("should return 0 for empty stash", () => {
      expect(stash.size).toBe(0);
    });

    it("should return correct count", async () => {
      await stash.push("First");
      expect(stash.size).toBe(1);

      await stash.push("Second");
      expect(stash.size).toBe(2);

      await stash.drop(0);
      expect(stash.size).toBe(1);
    });
  });
});
