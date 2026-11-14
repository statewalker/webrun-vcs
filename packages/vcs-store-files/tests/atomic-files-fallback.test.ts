import { createAtomicFilesTests } from "@statewalker/vcs-testing";
import { atomicFilesOver, createInMemoryFilesApi } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";

createAtomicFilesTests("FilesApi fallback (in memory)", async () => ({
  files: atomicFilesOver(createInMemoryFilesApi(), "/repo/.git"),
}));

createAtomicFilesTests("FilesApi fallback (relative root)", async () => ({
  files: atomicFilesOver(createInMemoryFilesApi(), ".git"),
}));

describe("atomicFilesOver: removeEmptyDir against a concurrent createExclusive", () => {
  it("never removes a lock created while it checks the directory", async () => {
    const enc = new TextEncoder();
    const base = createInMemoryFilesApi();
    // A remove that starts late, so a create can land between "empty" and "remove".
    let slowRemove = false;
    const slow = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "remove" && slowRemove) {
          return async (path: string) => {
            await new Promise((r) => setTimeout(r, 20));
            return target.remove(path);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const files = atomicFilesOver(slow, "/repo/.git");
    await files.write("refs/heads/x/keep", enc.encode("1"));
    await files.remove("refs/heads/x/keep"); // refs/heads/x is now an empty directory
    slowRemove = true;
    const [, created] = await Promise.all([
      files.removeEmptyDir("refs/heads/x"),
      files.createExclusive("refs/heads/x/y.lock", enc.encode("lock")),
    ]);
    expect(created).toBe(true);
    expect(await files.exists("refs/heads/x/y.lock")).toBe(true);
  });
});
