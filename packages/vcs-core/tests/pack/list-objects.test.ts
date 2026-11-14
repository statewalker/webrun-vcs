/**
 * listObjects (git rev-list --objects) over hand-built histories in the object kernel.
 */
import { describe, expect, it } from "vitest";
import type { GitObjects } from "../../src/history/objects/git-objects.js";
import { type ListedObject, listObjects } from "../../src/pack/index.js";
import { blob, commit, memObjects, tag, tree } from "./history-builder.js";

async function list(
  objects: GitObjects,
  options: Parameters<typeof listObjects>[1],
): Promise<ListedObject[]> {
  const out: ListedObject[] = [];
  for await (const o of listObjects(objects, options)) out.push(o);
  return out;
}

/** c1 <- c2 <- c3, sharing a subtree and a blob; c3 adds a file in the shared directory. */
async function linear(objects: GitObjects) {
  const shared = await blob(objects, "shared\n");
  const v1 = await blob(objects, "v1\n");
  const v2 = await blob(objects, "v2\n");
  const v3 = await blob(objects, "v3\n");
  const lib = await tree(objects, [["100644", "util.js", shared]]);
  const t1 = await tree(objects, [
    ["40000", "lib", lib],
    ["100644", "a.txt", v1],
  ]);
  const t2 = await tree(objects, [
    ["40000", "lib", lib],
    ["100644", "a.txt", v2],
  ]);
  const extra = await blob(objects, "extra\n");
  const lib3 = await tree(objects, [
    ["100644", "util.js", shared],
    ["100644", "more.js", extra],
  ]);
  const t3 = await tree(objects, [
    ["40000", "lib", lib3],
    ["100644", "a.txt", v3],
  ]);
  const c1 = await commit(objects, t1, [], 1000);
  const c2 = await commit(objects, t2, [c1], 2000);
  const c3 = await commit(objects, t3, [c2], 3000);
  return { shared, v1, v2, v3, lib, lib3, extra, t1, t2, t3, c1, c2, c3 };
}

describe("listObjects", () => {
  it("lists every object reachable from the wants, commits first, with types and paths", async () => {
    const objects = memObjects();
    const h = await linear(objects);
    const out = await list(objects, { wants: [h.c2] });
    expect(out.slice(0, 2)).toEqual([
      { id: h.c2, type: "commit" },
      { id: h.c1, type: "commit" },
    ]);
    const rest = new Map(out.slice(2).map((o) => [o.id, o]));
    expect(rest.size).toBe(out.length - 2);
    expect(rest.get(h.t2)).toEqual({ id: h.t2, type: "tree", path: "" });
    expect(rest.get(h.t1)).toEqual({ id: h.t1, type: "tree", path: "" });
    expect(rest.get(h.lib)).toEqual({ id: h.lib, type: "tree", path: "lib" });
    expect(rest.get(h.shared)).toEqual({ id: h.shared, type: "blob", path: "lib/util.js" });
    expect(rest.get(h.v1)?.path).toBe("a.txt");
    expect(rest.get(h.v2)?.type).toBe("blob");
    expect(rest.size).toBe(6);
  });

  it("excludes commits, trees and blobs reachable from the haves", async () => {
    const objects = memObjects();
    const h = await linear(objects);
    const out = await list(objects, { wants: [h.c3], haves: [h.c2] });
    expect(out.map((o) => o.id).sort()).toEqual([h.c3, h.t3, h.lib3, h.extra, h.v3].sort());
    // the shared blob is in a tree the receiver lacks (lib3) but reachable from c2
    expect(out.find((o) => o.id === h.shared)).toBeUndefined();
  });

  it("accepts `excludes` as an alias of haves, and an excluded want lists nothing", async () => {
    const objects = memObjects();
    const h = await linear(objects);
    expect(await list(objects, { wants: [h.c2], excludes: [h.c3] })).toEqual([]);
  });

  it("stops at merges reaching the haves, also with clock skew", async () => {
    const objects = memObjects();
    const h = await linear(objects);
    // a side branch from c1 whose commit claims to be older than c1 (skewed clock)
    const side = await blob(objects, "side\n");
    const ts = await tree(objects, [["100644", "side.txt", side]]);
    const s1 = await commit(objects, ts, [h.c1], 500);
    const m = await commit(objects, h.t3, [h.c3, s1], 4000);
    const out = await list(objects, { wants: [m], haves: [h.c3] });
    expect(out.map((o) => o.id).sort()).toEqual([m, s1, ts, side].sort());
  });

  it("peels tags: lists a wanted tag and its target, and haves may be tags", async () => {
    const objects = memObjects();
    const h = await linear(objects);
    const t = await tag(objects, h.c3, "commit", "v3");
    const t2 = await tag(objects, h.c2, "commit", "v2");
    const out = await list(objects, { wants: [t], haves: [t2] });
    expect(out.map((o) => o.id).sort()).toEqual([t, h.c3, h.t3, h.lib3, h.extra, h.v3].sort());
    expect(out.find((o) => o.id === t)?.type).toBe("tag");
  });

  it("lists wanted trees and blobs directly, and excludes haves that are trees", async () => {
    const objects = memObjects();
    const h = await linear(objects);
    const out = await list(objects, { wants: [h.t3], haves: [h.lib] });
    expect(out.map((o) => o.id).sort()).toEqual([h.t3, h.lib3, h.extra, h.v3].sort());
  });

  it("ignores haves the store does not have, and fails on a missing want", async () => {
    const objects = memObjects();
    const h = await linear(objects);
    const unknown = "1".repeat(40);
    const out = await list(objects, { wants: [h.c1], haves: [unknown] });
    expect(out.length).toBe(5);
    await expect(list(objects, { wants: [unknown] })).rejects.toThrow(/missing/);
  });

  it("stops at shallow commits: their parents are not walked", async () => {
    const objects = memObjects();
    const h = await linear(objects);
    const out = await list(objects, { wants: [h.c3], shallow: [h.c2] });
    const ids = out.map((o) => o.id);
    expect(ids).toContain(h.c2);
    expect(ids).not.toContain(h.c1);
    expect(ids).not.toContain(h.v1);
  });
});

describe("listObjects: the boundary", () => {
  it("reports the receiver's trees and blobs with their paths, for thin packs", async () => {
    const objects = memObjects();
    const h = await linear(objects);
    const boundary: ListedObject[] = [];
    await list(objects, { wants: [h.c3], haves: [h.c2], onBoundary: (o) => boundary.push(o) });
    const byId = new Map(boundary.map((o) => [o.id, o]));
    expect(byId.get(h.t2)).toEqual({ id: h.t2, type: "tree", path: "" });
    expect(byId.get(h.v2)).toEqual({ id: h.v2, type: "blob", path: "a.txt" });
    expect(byId.get(h.shared)).toEqual({ id: h.shared, type: "blob", path: "lib/util.js" });
    expect(byId.has(h.v3)).toBe(false);
  });
});
