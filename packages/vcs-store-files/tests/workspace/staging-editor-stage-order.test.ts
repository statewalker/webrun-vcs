/**
 * FileStagingStore's editor over an index whose entries are out of order (a malformed index
 * file, read as it is): the fast in-place merge of a few edits gives way to the full
 * regroup and sort, so the untouched paths come out in git's order, stages ascending.
 */
import { createInMemoryFilesApi } from "@statewalker/vcs-core";
import { FileStagingStore } from "@statewalker/vcs-store-files";
import type { StagingEntry } from "@statewalker/vcs-working-tree";
import { describe, expect, it } from "vitest";

const BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const entry = (path: string, stage: 0 | 1 | 2 | 3): StagingEntry =>
  ({ path, stage, mode: 0o100644, objectId: BLOB, size: 0, mtime: 0 }) as StagingEntry;

describe("FileStagingStore editor over out-of-order conflict stages", () => {
  it("sorts the stages of an untouched conflicted path", async () => {
    const store = new FileStagingStore(createInMemoryFilesApi(), ".git/index");
    // stages 3, 1, 2 of c.txt, as a malformed index file holds them
    store._replaceEntries([
      entry("a.txt", 0),
      entry("c.txt", 3),
      entry("c.txt", 1),
      entry("c.txt", 2),
    ]);
    const editor = store.createEditor();
    editor.upsert({ path: "b.txt", objectId: BLOB, mode: 0o100644, stage: 0, size: 0, mtime: 0 });
    await editor.finish();
    const out: Array<[string, number]> = [];
    for await (const e of store.entries()) out.push([e.path, e.stage]);
    expect(out).toEqual([
      ["a.txt", 0],
      ["b.txt", 0],
      ["c.txt", 1],
      ["c.txt", 2],
      ["c.txt", 3],
    ]);
  });

  it("keeps ordered stages through the fast path", async () => {
    const store = new FileStagingStore(createInMemoryFilesApi(), ".git/index");
    store._replaceEntries([entry("c.txt", 1), entry("c.txt", 2), entry("c.txt", 3)]);
    const editor = store.createEditor();
    editor.upsert({ path: "d.txt", objectId: BLOB, mode: 0o100644, stage: 0, size: 0, mtime: 0 });
    await editor.finish();
    const out: Array<[string, number]> = [];
    for await (const e of store.entries()) out.push([e.path, e.stage]);
    expect(out).toEqual([
      ["c.txt", 1],
      ["c.txt", 2],
      ["c.txt", 3],
      ["d.txt", 0],
    ]);
  });
});
