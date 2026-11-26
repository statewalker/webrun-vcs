import { createInMemoryFilesApi } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";
import {
  createFileRefStore,
  createReftableRefStore,
  RefStoreRetiredError,
  refStoreRetirement,
  retireRefStore,
} from "../../src/refs/index.js";

const ID = "a".repeat(40);

describe("retireRefStore (#357)", () => {
  it("makes every method of a files store refuse, patched ones included", async () => {
    const files = createInMemoryFilesApi();
    const store = createFileRefStore(files, ".git");
    await store.set("refs/heads/main", ID);
    const { set } = store;
    store.set = (...args) => set.apply(store, args);
    expect(refStoreRetirement(store)).toBeUndefined();

    retireRefStore(store, "the ref storage was migrated to 'reftable'");
    expect(refStoreRetirement(store)).toBe("the ref storage was migrated to 'reftable'");
    await expect(async () => store.set("refs/heads/main", ID)).rejects.toThrow(
      RefStoreRetiredError,
    );
    await expect(async () => store.get("refs/heads/main")).rejects.toThrow(
      "the ref storage was migrated to 'reftable': open the repository again",
    );
    expect(() => store.list()).toThrow(RefStoreRetiredError);
    // the files are left alone
    expect(await createFileRefStore(files, ".git").get("refs/heads/main")).toMatchObject({
      objectId: ID,
    });
  });

  it("retires a reftable store", async () => {
    const store = createReftableRefStore({ files: createInMemoryFilesApi(), gitDir: ".git" });
    retireRefStore(store, "the ref storage was migrated to 'files'");
    await expect(async () => store.setSymbolic("HEAD", "refs/heads/main")).rejects.toThrow(
      RefStoreRetiredError,
    );
  });
});
