/**
 * DefaultSerializationApi.importObject takes the content's size, so a blob is
 * stored in one pass without collecting it.
 */
import { describe, expect, it } from "vitest";
import { createMemoryHistory } from "../src/index.js";
import { DefaultSerializationApi } from "../src/serialization/serialization-api.impl.js";

describe("importObject with a size", () => {
  it("passes the size of a blob to blobs.store", async () => {
    const history = createMemoryHistory();
    const sizes: (number | undefined)[] = [];
    const store = history.blobs.store.bind(history.blobs);
    history.blobs.store = (content, size) => {
      sizes.push(size);
      return store(content, size);
    };
    const api = new DefaultSerializationApi({ history });
    const id = await api.importObject(
      "blob",
      (async function* () {
        yield new TextEncoder().encode("hello\n");
      })(),
      6,
    );
    expect(id).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(sizes).toEqual([6]);
  });
});
