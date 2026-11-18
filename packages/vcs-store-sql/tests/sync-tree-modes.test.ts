/**
 * A tree holding a blob stored with mode 100664 (older git wrote it) keeps its id through
 * importToNative and exportToGit: the native store gives its rows back as stored (`raw`),
 * since `load` reads the modes canonical (100644), which would store another tree.
 */
import { createMemoryHistory } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import { initializeSchema } from "../src/migrations/index.js";
import { createSqlNativeStores } from "../src/native/index.js";
import { exportToGit, importToNative, type SyncObject } from "../src/sync.js";

async function* objects(...list: SyncObject[]): AsyncIterable<SyncObject> {
  yield* list;
}

describe("SQL sync of a tree with a 100664 blob", () => {
  let db: SqlJsAdapter;
  beforeEach(async () => {
    db = await SqlJsAdapter.create();
    await initializeSchema(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("exports the tree it imported under the same id", async () => {
    const src = createMemoryHistory();
    const blob = await src.blobs.store([new TextEncoder().encode("a\n")]);
    const treeId = await src.trees.store([{ mode: 0o100664, name: "f", id: blob }]);
    const native = createSqlNativeStores(db);
    await importToNative(
      src,
      native,
      objects({ id: blob, type: "blob" }, { id: treeId, type: "tree" }),
    );
    expect(await native.trees.has(treeId)).toBe(true);
    // the native store reads the mode canonical, and gives the stored bytes back
    const loaded = [];
    for await (const e of (await native.trees.load(treeId)) ?? []) loaded.push(e);
    expect(loaded.map((e) => e.mode)).toEqual([0o100644]);
    expect(new TextDecoder().decode((await native.trees.raw?.(treeId))?.subarray(0, 7))).toBe(
      "100664 ",
    );

    const dst = createMemoryHistory();
    await exportToGit(
      native,
      dst,
      objects({ id: blob, type: "blob" }, { id: treeId, type: "tree" }),
    );
    expect(await dst.trees.has(treeId)).toBe(true);
  });
});
