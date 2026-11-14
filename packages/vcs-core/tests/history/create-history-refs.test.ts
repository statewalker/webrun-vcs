import { describe, expect, it } from "vitest";
import {
  createGitObjectStore,
  createHistoryFromComponents,
  MemoryRawStorage,
  MemoryRefs,
} from "../../src/index.js";

describe("createHistoryFromComponents refs", () => {
  it("uses a given Refs implementation as is", async () => {
    const refs = new MemoryRefs();
    await refs.set("refs/heads/main", "a".repeat(40));
    const history = createHistoryFromComponents({
      objects: createGitObjectStore(new MemoryRawStorage()),
      refs,
    });
    expect(history.refs).toBe(refs);
    expect((await history.refs.resolve("refs/heads/main"))?.objectId).toBe("a".repeat(40));
  });

  it("creates in-memory refs for { type: 'memory' }", async () => {
    const history = createHistoryFromComponents({
      objects: createGitObjectStore(new MemoryRawStorage()),
      refs: { type: "memory" },
    });
    expect(await history.refs.batch([{ name: "refs/heads/x", new: "b".repeat(40) }])).toEqual({
      ok: true,
      rejected: [],
    });
  });

  it("refuses an unknown refs type instead of silently using memory refs", () => {
    expect(() =>
      createHistoryFromComponents({
        objects: createGitObjectStore(new MemoryRawStorage()),
        refs: { type: "adapter", refStore: {} } as never,
      }),
    ).toThrow(/unknown refs type "adapter"/);
  });
});
