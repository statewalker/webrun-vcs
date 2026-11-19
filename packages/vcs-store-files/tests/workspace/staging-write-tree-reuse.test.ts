/**
 * FileStagingStore.writeTree with a cache-tree (git's cache_tree_update): a valid node is
 * skipped over by its entry count, so a write after one edit stores only the trees on the
 * edited path, whatever the size of the index; entries out of order are grouped by name and
 * give the same trees.
 */
import { createInMemoryFilesApi } from "@statewalker/vcs-core";
import { createGitFilesBackend, FileStagingStore } from "@statewalker/vcs-store-files";
import { cacheTreeOfTree, type StagingEntry } from "@statewalker/vcs-working-tree";
import { describe, expect, it, vi } from "vitest";

const id = (n: number) => n.toString(16).padStart(40, "0");
const entry = (path: string, n: number): StagingEntry =>
  ({ path, stage: 0, mode: 0o100644, objectId: id(n), size: 1, mtime: 1 }) as StagingEntry;

/** 40 directories of 50 files, one level deeper for every fifth directory. */
function entries(): StagingEntry[] {
  const out: StagingEntry[] = [];
  let n = 1;
  for (let d = 0; d < 40; d++) {
    for (let f = 0; f < 50; f++) {
      out.push(entry(d % 5 === 0 ? `d${d}/sub/f${f}` : `d${d}/f${f}`, n++));
    }
  }
  out.push(entry("top.txt", n++));
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

describe("FileStagingStore.writeTree reuses valid cache-tree nodes", () => {
  it("stores only the trees of the edited path", async () => {
    const files = createInMemoryFilesApi();
    const { history } = await createGitFilesBackend({ files });
    const store = new FileStagingStore(files, ".git/index");
    store._replaceEntries(entries().map(counting));
    const full = await store.writeTree(history.trees);
    store.setCacheTree(await cacheTreeOfTree(history.trees, full));

    const editor = store.createEditor();
    editor.upsert({ ...entry("d10/sub/f7", 99_999) });
    await editor.finish();

    const stored = vi.spyOn(history.trees, "store");
    const asked = vi.spyOn(history.trees, "has");
    reads = 0;
    const written = await store.writeTree(history.trees);
    // d10/sub, d10 and the root; every other directory taken from its valid node
    expect(stored).toHaveBeenCalledTimes(3);
    expect(asked.mock.calls.length).toBeLessThanOrEqual(41);
    // each path read once by the clash check (plus its lookup of each directory), then only
    // where a directory starts or ends and in the edited directory: not again per entry and
    // directory level (about 6,000 reads when each level grouped every entry below it)
    expect(reads).toBeLessThan(3_200);

    // the same tree as one built without a cache-tree
    const plain = new FileStagingStore(createInMemoryFilesApi(), ".git/index");
    plain._replaceEntries([...(await collect(store))]);
    expect(await plain.writeTree(history.trees)).toBe(written);
    expect(written).not.toBe(full);
  });

  it("groups entries out of order by directory, as before", async () => {
    const files = createInMemoryFilesApi();
    const { history } = await createGitFilesBackend({ files });
    const sorted = entries();
    const store = new FileStagingStore(files, ".git/index");
    store._replaceEntries(sorted);
    const expected = await store.writeTree(history.trees);

    // d1's entries split by another directory's
    const shuffled = sorted.slice();
    const moved = shuffled.splice(
      shuffled.findIndex((e) => e.path.startsWith("d1/")),
      3,
    );
    shuffled.push(...moved);
    const other = new FileStagingStore(createInMemoryFilesApi(), ".git/index");
    other._replaceEntries(shuffled);
    expect(await other.writeTree(history.trees)).toBe(expected);
  });
});

/** How many times the entries made by {@link counting} had their path read. */
let reads = 0;

/** The entry with its path behind a getter counting the reads. */
function counting(e: StagingEntry): StagingEntry {
  const { path, ...rest } = e;
  const out = { ...rest } as StagingEntry;
  Object.defineProperty(out, "path", {
    enumerable: true,
    get: () => {
      reads++;
      return path;
    },
  });
  return out;
}

async function collect(store: FileStagingStore): Promise<StagingEntry[]> {
  const out: StagingEntry[] = [];
  for await (const e of store.entries()) out.push(e);
  return out;
}
