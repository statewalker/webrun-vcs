/**
 * importToNative and exportToGit pass each blob's size to the target store, so
 * a blob is copied in one pass instead of being collected to learn its size.
 */
import { createMemoryHistory } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import { createSqlNativeStores } from "../src/native/index.js";
import { exportToGit, importToNative, type SyncObject } from "../src/sync.js";

const HELLO = "ce013625030ba8dba906f756967f9e9ca394464a";
const hello = () => [new TextEncoder().encode("hello\n")];

async function* one(id: string): AsyncIterable<SyncObject> {
  yield { id, type: "blob" };
}

function recordSizes(blobs: { store(c: never, size?: number): Promise<string> }) {
  const sizes: (number | undefined)[] = [];
  const store = blobs.store.bind(blobs);
  blobs.store = ((content: never, size?: number) => {
    sizes.push(size);
    return store(content, size);
  }) as typeof blobs.store;
  return sizes;
}

describe("SQL sync blob sizes", () => {
  let db: SqlJsAdapter;
  beforeEach(async () => {
    db = await SqlJsAdapter.create();
  });
  afterEach(async () => {
    await db.close();
  });

  it("importToNative stores a blob with its size", async () => {
    const git = createMemoryHistory();
    await git.blobs.store(hello());
    const native = createSqlNativeStores(db);
    const sizes = recordSizes(native.blobs as never);
    expect(await importToNative(git, native, one(HELLO))).toBe(1);
    expect(sizes).toEqual([6]);
    expect(await native.blobs.has(HELLO)).toBe(true);
  });

  it("exportToGit stores a blob with its size", async () => {
    const native = createSqlNativeStores(db);
    await native.blobs.store(
      (async function* () {
        yield* hello();
      })(),
    );
    const git = createMemoryHistory();
    const sizes = recordSizes(git.blobs as never);
    expect(await exportToGit(native, git, one(HELLO))).toBe(1);
    expect(sizes).toEqual([6]);
    expect(await git.blobs.has(HELLO)).toBe(true);
  });
});
