/**
 * `isIndexUnborn` (git's `is_index_unborn`) over file-backed stagings: born-ness comes from
 * whether the last read found an index file or one was written, not from the index file's
 * mtime, so a FilesApi that reports no `lastModified` does not make an existing (empty)
 * index look unborn. Stores without an index file keep the update-time rule.
 */
import { createInMemoryFilesApi } from "@statewalker/vcs-core";
import { FileStagingStore } from "@statewalker/vcs-store-files";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import { GitStaging, isIndexUnborn, type Staging } from "@statewalker/vcs-working-tree";
import { describe, expect, it } from "vitest";

/** A FilesApi whose `stats` never reports a modification time. */
function withoutLastModified(files: FilesApi): FilesApi {
  return new Proxy(files, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "stats") {
        return async (path: string) => {
          const stats = await (value as FilesApi["stats"]).call(target, path);
          return stats ? { ...stats, lastModified: undefined } : stats;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const makers: Array<[string, (files: FilesApi) => Staging]> = [
  ["FileStagingStore", (files) => new FileStagingStore(files, ".git/index")],
  ["GitStaging", (files) => new GitStaging(files, ".git/index")],
];

describe.each(makers)("isIndexUnborn over %s", (_name, make) => {
  it("is unborn while no index file exists, born once one is written", async () => {
    const files = withoutLastModified(createInMemoryFilesApi());
    const staging = make(files);
    await staging.read();
    expect(staging.getUpdateTime()).toBe(0);
    expect(await isIndexUnborn(staging)).toBe(true);

    // an empty index written: no entries, still no mtime, but no longer unborn
    await staging.write();
    expect(staging.getUpdateTime()).toBe(0);
    expect(await isIndexUnborn(staging)).toBe(false);

    // a fresh instance reading the existing empty index file
    const again = make(files);
    await again.read();
    expect(again.getUpdateTime()).toBe(0);
    expect(await isIndexUnborn(again)).toBe(false);
  });

  it("an index file removed and read again is unborn", async () => {
    const files = withoutLastModified(createInMemoryFilesApi());
    const staging = make(files);
    await staging.write();
    await files.remove(".git/index");
    await staging.read();
    expect(await isIndexUnborn(staging)).toBe(true);
  });
});

describe("isIndexUnborn without isUnborn", () => {
  it("falls back to the update time", async () => {
    const base = { getUpdateTime: () => 0, getEntryCount: async () => 0 };
    expect(await isIndexUnborn(base as unknown as Staging)).toBe(true);
    const created = { getUpdateTime: () => 1, getEntryCount: async () => 0 };
    expect(await isIndexUnborn(created as unknown as Staging)).toBe(false);
  });
});
