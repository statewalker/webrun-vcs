/**
 * FileRefStore.set, setSymbolic and remove take `<ref>.lock`, as git's lock_ref /
 * commit_ref: a held lock makes them wait for `refLockTimeoutMs` and then fail
 * with the ref unchanged; the new value is written into the lock and renamed
 * over the ref.
 */
import { createInMemoryFilesApi, type FilesApi, type ObjectId } from "@statewalker/vcs-core";
import { readText } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";
import { createRefsStructure, FileRefStore, readLooseRef } from "../../src/refs/index.js";

const oid = (n: number): ObjectId => n.toString(16).padStart(40, "a");

async function repo(): Promise<FilesApi> {
  const files = createInMemoryFilesApi();
  await files.mkdir("/.git");
  await createRefsStructure(files, "/.git");
  return files;
}

const text = async (files: FilesApi, path: string) =>
  (await files.exists(path)) ? readText(files, path) : undefined;

describe("set, setSymbolic and remove take <ref>.lock", () => {
  it("set waits for a held <ref>.lock, then fails after refLockTimeoutMs with the ref unchanged", async () => {
    const files = await repo();
    const refs = new FileRefStore(files, "/.git", { refLockTimeoutMs: 80 });
    await refs.set("refs/heads/main", oid(1));
    await files.write("/.git/refs/heads/main.lock", [new TextEncoder().encode("other")]);

    const started = Date.now();
    await expect(refs.set("refs/heads/main", oid(2))).rejects.toThrow(/main\.lock|locked/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(await text(files, "/.git/refs/heads/main")).toBe(`${oid(1)}\n`);
    expect(await text(files, "/.git/refs/heads/main.lock")).toBe("other"); // not ours
  });

  it("set proceeds once the holder releases <ref>.lock within the timeout", async () => {
    const files = await repo();
    const refs = new FileRefStore(files, "/.git", { refLockTimeoutMs: 1000 });
    await files.write("/.git/refs/heads/main.lock", [new Uint8Array(0)]);
    setTimeout(() => void files.remove("/.git/refs/heads/main.lock"), 50);
    await refs.set("refs/heads/main", oid(3));
    expect(await text(files, "/.git/refs/heads/main")).toBe(`${oid(3)}\n`);
    expect(await files.exists("/.git/refs/heads/main.lock")).toBe(false);
  });

  it("setSymbolic waits for a held <ref>.lock, then fails with the ref unchanged", async () => {
    const files = await repo();
    const refs = new FileRefStore(files, "/.git", { refLockTimeoutMs: 40 });
    await refs.setSymbolic("HEAD", "refs/heads/main");
    await files.write("/.git/HEAD.lock", [new Uint8Array(0)]);
    await expect(refs.setSymbolic("HEAD", "refs/heads/other")).rejects.toThrow(/HEAD\.lock|locked/);
    expect(await text(files, "/.git/HEAD")).toBe("ref: refs/heads/main\n");
  });

  it("remove waits for a held <ref>.lock, then fails with the ref unchanged", async () => {
    const files = await repo();
    const refs = new FileRefStore(files, "/.git", { refLockTimeoutMs: 40 });
    await refs.set("refs/heads/topic", oid(1));
    await files.write("/.git/refs/heads/topic.lock", [new Uint8Array(0)]);
    await expect(refs.remove("refs/heads/topic")).rejects.toThrow(/topic\.lock|locked/);
    expect(await text(files, "/.git/refs/heads/topic")).toBe(`${oid(1)}\n`);
  });

  it("set writes the value into <ref>.lock and renames it over the ref", async () => {
    const base = await repo();
    const moves: [string, string][] = [];
    const files = new Proxy(base, {
      get(target, prop) {
        if (prop === "move") {
          return async (source: string, dest: string) => {
            moves.push([source, dest]);
            return target.move(source, dest);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as FilesApi;
    const refs = new FileRefStore(files, "/.git");
    await refs.set("refs/heads/main", oid(1));
    await refs.setSymbolic("HEAD", "refs/heads/main");
    expect(moves).toContainEqual(["/.git/refs/heads/main.lock", "/.git/refs/heads/main"]);
    expect(moves).toContainEqual(["/.git/HEAD.lock", "/.git/HEAD"]);
    expect(await text(base, "/.git/HEAD")).toBe("ref: refs/heads/main\n");
  });

  it("keeps the public behaviour: set replaces a symbolic ref, remove reports existence, D/F throws", async () => {
    const files = await repo();
    const refs = new FileRefStore(files, "/.git");
    await refs.set("refs/heads/main", oid(1));
    await refs.setSymbolic("HEAD", "refs/heads/main");
    await refs.set("HEAD", oid(2)); // detaches HEAD, as before
    expect(await text(files, "/.git/HEAD")).toBe(`${oid(2)}\n`);
    expect((await refs.resolve("refs/heads/main"))?.objectId).toBe(oid(1));

    await expect(refs.set("refs/heads/main/sub", oid(3))).rejects.toThrow();
    await refs.set("refs/heads/a/b", oid(4));
    await expect(refs.set("refs/heads/a", oid(5))).rejects.toThrow();
    await expect(refs.setSymbolic("refs/heads/main/sym", "refs/heads/x")).rejects.toThrow();
    expect((await refs.resolve("refs/heads/a/b"))?.objectId).toBe(oid(4));

    expect(await refs.remove("refs/heads/a/b")).toBe(true);
    expect(await refs.remove("refs/heads/a/b")).toBe(false);
    expect(await refs.remove("refs/heads/main/sub")).toBe(false);
    // non-ref names outside refs/ are still written (under a lock)
    await refs.set("ORIG_HEAD", oid(6));
    expect(await text(files, "/.git/ORIG_HEAD")).toBe(`${oid(6)}\n`);
    expect(await refs.remove("ORIG_HEAD")).toBe(true);
    for await (const p of files.list("/.git", { recursive: true })) {
      expect(p.path.endsWith(".lock")).toBe(false);
    }
  });
});

describe("a ref another process creates while this one reads it", () => {
  it("is missing or has its new value, never an empty (broken) ref", async () => {
    // Another process renames refs/stash.lock over refs/stash just after this one found
    // refs/stash missing. Asked only after an empty read whether the file was there, the
    // reader saw the new file and took the missing ref for an empty one: "refs/stash is
    // broken" while three processes pushed their first stash at once.
    const base = await repo();
    let created = false;
    const files = new Proxy(base, {
      get(target, prop) {
        if (prop === "stats") {
          return async (path: string) => {
            const stats = await target.stats(path);
            if (!created && path === "/.git/refs/stash" && !stats) {
              created = true;
              await target.write(path, [new TextEncoder().encode(`${oid(1)}\n`)]);
            }
            return stats;
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as FilesApi;
    const refs = new FileRefStore(files, "/.git");

    await refs.set("refs/stash", oid(2));
    expect(created).toBe(true);
    expect(await text(base, "/.git/refs/stash")).toBe(`${oid(2)}\n`);
  });
});

describe("a ref another process deletes while a strict reader reads it", () => {
  it("is no ref, not an empty (invalid) one", async () => {
    // git's files_read_raw_ref goes back to its lstat when the open finds no file; a missing
    // file reads as no bytes, so a ref deleted between the stat and the read is no ref
    const base = await repo();
    await base.write("/.git/refs/heads/gone", [new TextEncoder().encode(`${oid(1)}\n`)]);
    let deleted = false;
    const files = new Proxy(base, {
      get(target, prop) {
        if (prop === "stats") {
          return async (path: string) => {
            const stats = await target.stats(path);
            if (!deleted && path === "/.git/refs/heads/gone" && stats) {
              deleted = true;
              await target.remove(path);
            }
            return stats;
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as FilesApi;

    expect(await readLooseRef(files, "/.git", "refs/heads/gone", { strict: true })).toBeUndefined();
    expect(deleted).toBe(true);
  });

  it("still reports a genuinely empty ref file as invalid", async () => {
    const files = await repo();
    await files.write("/.git/refs/heads/empty", [new Uint8Array(0)]);
    await expect(
      readLooseRef(files, "/.git", "refs/heads/empty", { strict: true }),
    ).rejects.toThrow("empty file");
  });
});
