/**
 * Tests for binary-storage implementations (new architecture)
 *
 * Tests MemDeltaStore and MemBinStore.
 * Note: MemoryRawStorage is from core and tested there.
 */

import type { Delta } from "@statewalker/vcs-utils";
import { describe, expect, it } from "vitest";
import { createMemBinStore, MemBinStore, MemDeltaStore } from "../src/binary-storage/index.js";

const encoder = new TextEncoder();

async function* chunks(...strings: string[]): AsyncIterable<Uint8Array> {
  for (const s of strings) {
    yield encoder.encode(s);
  }
}

async function collect(input: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of input) {
    parts.push(chunk);
  }
  const result = new Uint8Array(parts.reduce((s, c) => s + c.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function toArray<T>(input: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of input) {
    result.push(item);
  }
  return result;
}

describe("MemDeltaStore", () => {
  function createSampleDelta(): Delta[] {
    return [
      { type: "start", targetLen: 100 },
      { type: "copy", start: 0, len: 50 },
      { type: "insert", data: encoder.encode("new content") },
      { type: "finish", checksum: 0 },
    ];
  }

  // Helper to store delta using new update pattern
  async function storeDelta(
    store: MemDeltaStore,
    info: { baseKey: string; targetKey: string },
    delta: Delta[],
  ): Promise<number> {
    const update = store.startUpdate();
    const size = await update.storeDelta(info, delta);
    await update.close();
    return size;
  }

  describe("storeDelta", () => {
    it("stores delta relationship", async () => {
      const store = new MemDeltaStore();
      const delta = createSampleDelta();

      const result = await storeDelta(store, { baseKey: "base1", targetKey: "target1" }, delta);

      expect(result).toBeGreaterThan(0);
      expect(await store.isDelta("target1")).toBe(true);
    });

    it("overwrites existing delta", async () => {
      const store = new MemDeltaStore();
      const delta1 = createSampleDelta();
      const delta2: Delta[] = [
        { type: "start", targetLen: 50 },
        { type: "copy", start: 10, len: 20 },
        { type: "finish", checksum: 0 },
      ];

      await storeDelta(store, { baseKey: "base1", targetKey: "target1" }, delta1);
      await storeDelta(store, { baseKey: "base2", targetKey: "target1" }, delta2);

      const loaded = await store.loadDelta("target1");
      expect(loaded?.baseKey).toBe("base2");
    });
  });

  describe("loadDelta", () => {
    it("loads stored delta", async () => {
      const store = new MemDeltaStore();
      const delta = createSampleDelta();

      await storeDelta(store, { baseKey: "base1", targetKey: "target1" }, delta);
      const loaded = await store.loadDelta("target1");

      expect(loaded).toBeDefined();
      expect(loaded?.baseKey).toBe("base1");
      expect(loaded?.targetKey).toBe("target1");
      expect(loaded?.delta).toEqual(delta);
    });

    it("returns undefined for non-existing target", async () => {
      const store = new MemDeltaStore();

      const loaded = await store.loadDelta("missing");

      expect(loaded).toBeUndefined();
    });
  });

  describe("isDelta", () => {
    it("returns true for existing delta", async () => {
      const store = new MemDeltaStore();
      await storeDelta(store, { baseKey: "base", targetKey: "target" }, createSampleDelta());

      expect(await store.isDelta("target")).toBe(true);
    });

    it("returns false for non-existing delta", async () => {
      const store = new MemDeltaStore();

      expect(await store.isDelta("missing")).toBe(false);
    });
  });

  describe("removeDelta", () => {
    it("removes existing delta", async () => {
      const store = new MemDeltaStore();
      await storeDelta(store, { baseKey: "base", targetKey: "target" }, createSampleDelta());

      const removed = await store.removeDelta("target");

      expect(removed).toBe(true);
      expect(await store.isDelta("target")).toBe(false);
    });

    it("returns false for non-existing delta", async () => {
      const store = new MemDeltaStore();

      const removed = await store.removeDelta("missing");

      expect(removed).toBe(false);
    });
  });

  describe("getDeltaChainInfo", () => {
    it("returns chain info for single delta", async () => {
      const store = new MemDeltaStore();
      await storeDelta(store, { baseKey: "base", targetKey: "target" }, createSampleDelta());

      const info = await store.getDeltaChainInfo("target");

      expect(info).toBeDefined();
      expect(info?.baseKey).toBe("base");
      expect(info?.targetKey).toBe("target");
      expect(info?.depth).toBe(1);
      expect(info?.chain).toEqual(["target", "base"]);
    });

    it("returns chain info for delta chain", async () => {
      const store = new MemDeltaStore();
      await storeDelta(store, { baseKey: "base", targetKey: "middle" }, createSampleDelta());
      await storeDelta(store, { baseKey: "middle", targetKey: "target" }, createSampleDelta());

      const info = await store.getDeltaChainInfo("target");

      expect(info).toBeDefined();
      expect(info?.baseKey).toBe("base");
      expect(info?.depth).toBe(2);
      expect(info?.chain).toEqual(["target", "middle", "base"]);
    });

    it("returns undefined for non-existing target", async () => {
      const store = new MemDeltaStore();

      const info = await store.getDeltaChainInfo("missing");

      expect(info).toBeUndefined();
    });
  });

  describe("listDeltas", () => {
    it("lists all delta relationships", async () => {
      const store = new MemDeltaStore();
      await storeDelta(store, { baseKey: "base1", targetKey: "target1" }, createSampleDelta());
      await storeDelta(store, { baseKey: "base2", targetKey: "target2" }, createSampleDelta());

      const deltas = await toArray(store.listDeltas());

      expect(deltas).toHaveLength(2);
      expect(deltas.map((d) => d.targetKey)).toContain("target1");
      expect(deltas.map((d) => d.targetKey)).toContain("target2");
    });

    it("returns empty for empty store", async () => {
      const store = new MemDeltaStore();

      const deltas = await toArray(store.listDeltas());

      expect(deltas).toHaveLength(0);
    });
  });

  describe("clear", () => {
    it("removes all deltas", async () => {
      const store = new MemDeltaStore();
      await storeDelta(store, { baseKey: "base1", targetKey: "target1" }, createSampleDelta());
      await storeDelta(store, { baseKey: "base2", targetKey: "target2" }, createSampleDelta());

      store.clear();

      expect(store.count).toBe(0);
      expect(await store.isDelta("target1")).toBe(false);
      expect(await store.isDelta("target2")).toBe(false);
    });
  });

  describe("count", () => {
    it("returns number of stored deltas", async () => {
      const store = new MemDeltaStore();
      expect(store.count).toBe(0);

      await storeDelta(store, { baseKey: "base1", targetKey: "target1" }, createSampleDelta());
      expect(store.count).toBe(1);

      await storeDelta(store, { baseKey: "base2", targetKey: "target2" }, createSampleDelta());
      expect(store.count).toBe(2);

      await store.removeDelta("target1");
      expect(store.count).toBe(1);
    });
  });
});

describe("MemBinStore", () => {
  describe("structure", () => {
    it("has raw and delta stores", () => {
      const store = new MemBinStore();

      expect(store.raw).toBeDefined();
      expect(store.delta).toBeDefined();
      expect(store.name).toBe("memory");
    });
  });

  describe("raw store integration", () => {
    it("stores and loads via raw store", async () => {
      const store = new MemBinStore();

      await store.raw.store("key", chunks("content"));
      const loaded = await collect(store.raw.load("key"));

      expect(new TextDecoder().decode(loaded)).toBe("content");
    });
  });

  describe("delta store integration", () => {
    it("stores and loads deltas via delta store", async () => {
      const store = new MemBinStore();
      const delta: Delta[] = [
        { type: "start", targetLen: 100 },
        { type: "copy", start: 0, len: 50 },
        { type: "finish", checksum: 0 },
      ];

      const update = store.delta.startUpdate();
      await update.storeDelta({ baseKey: "base", targetKey: "target" }, delta);
      await update.close();
      const loaded = await store.delta.loadDelta("target");

      expect(loaded).toBeDefined();
      expect(loaded?.baseKey).toBe("base");
    });
  });

  describe("lifecycle methods", () => {
    it("flush is no-op", async () => {
      const store = new MemBinStore();
      await store.raw.store("key", chunks("content"));

      await store.flush();

      expect(await store.raw.has("key")).toBe(true);
    });

    it("close is no-op", async () => {
      const store = new MemBinStore();
      await store.raw.store("key", chunks("content"));

      await store.close();

      expect(await store.raw.has("key")).toBe(true);
    });

    it("refresh is no-op", async () => {
      const store = new MemBinStore();
      await store.raw.store("key", chunks("content"));

      await store.refresh();

      expect(await store.raw.has("key")).toBe(true);
    });
  });

  describe("clear", () => {
    it("clears both raw and delta stores", async () => {
      const store = new MemBinStore();

      await store.raw.store("key", chunks("content"));
      const update = store.delta.startUpdate();
      await update.storeDelta({ baseKey: "base", targetKey: "target" }, [
        { type: "start", targetLen: 100 },
        { type: "finish", checksum: 0 },
      ]);
      await update.close();

      store.clear();

      expect(await store.raw.has("key")).toBe(false);
      expect(await store.delta.isDelta("target")).toBe(false);
    });
  });
});

describe("createMemBinStore", () => {
  it("creates a new MemBinStore instance", () => {
    const store = createMemBinStore();

    expect(store).toBeInstanceOf(MemBinStore);
    expect(store.name).toBe("memory");
  });
});
