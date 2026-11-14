import { createAtomicFilesTests } from "@statewalker/vcs-testing";
import {
  atomicFilesOver,
  createInMemoryFilesApi as createMemFilesApi,
  type FilesApi,
} from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";

/**
 * An in-memory FilesApi without `createExclusive`, so these suites exercise the
 * in-process fallback (webrun-files-mem 0.11 has its own `createExclusive`).
 */
function createInMemoryFilesApi(): FilesApi {
  return new Proxy(createMemFilesApi(), {
    has(target, prop) {
      return prop !== "createExclusive" && Reflect.has(target, prop);
    },
    get(target, prop) {
      if (prop === "createExclusive") return undefined;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

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

describe("replace after a half-done move (MoveIncompleteError)", () => {
  /** A FilesApi whose `move` writes the target, then fails to remove the source, as
   * webrun-files' copy-then-delete backends report with MoveIncompleteError. */
  function halfMovingFiles(removeWorks: { value: boolean }): FilesApi {
    const base = createInMemoryFilesApi();
    return new Proxy(base, {
      get(target, prop) {
        if (prop === "move") {
          return async (from: string, to: string) => {
            const chunks: Uint8Array[] = [];
            for await (const c of target.read(from)) chunks.push(c);
            await target.write(to, chunks);
            const error = new Error(
              `move ${from} -> ${to}: the target was replaced, but the source could not be removed`,
            );
            error.name = "MoveIncompleteError";
            throw error;
          };
        }
        if (prop === "remove") {
          return async (path: string) => (removeWorks.value ? target.remove(path) : false);
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  const enc = new TextEncoder();

  it("counts the move as done once the source is removed", async () => {
    const files = halfMovingFiles({ value: true });
    const atomic = atomicFilesOver(files, "/repo/.git");
    await files.write("/repo/.git/index.lock", [enc.encode("new")]);
    await atomic.replace("index.lock", "index");
    expect(await files.exists("/repo/.git/index.lock")).toBe(false);
    const parts: Uint8Array[] = [];
    for await (const c of files.read("/repo/.git/index")) parts.push(c);
    expect(new TextDecoder().decode(parts[0])).toBe("new");
  });

  it("still fails when the source cannot be removed (a lock would stay behind)", async () => {
    const files = halfMovingFiles({ value: false });
    const atomic = atomicFilesOver(files, "/repo/.git");
    await files.write("/repo/.git/index.lock", [enc.encode("new")]);
    await expect(atomic.replace("index.lock", "index")).rejects.toMatchObject({
      name: "MoveIncompleteError",
    });
  });
});
