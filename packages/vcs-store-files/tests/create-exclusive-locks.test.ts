/**
 * Lock files through `FilesApi.createExclusive`, when the FilesApi has one (webrun-files'
 * exclusive create: `open "wx"` on Node, Web Locks in the browser). The wrapper below adds
 * one to the in-memory FilesApi: every wrapper over one storage shares its reservations,
 * as every process shares the file system, so two wrappers stand for two processes. The
 * in-process fallback serializes per FilesApi instance and cannot exclude them.
 */
import { createAtomicFilesTests } from "@statewalker/vcs-testing";
import {
  atomicFilesOver,
  createInMemoryFilesApi,
  type FilesApi,
} from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";
import { createGitFilesBackend, gc } from "../src/index.js";
import { createRefsStructure, FileRefStore } from "../src/refs/index.js";

const enc = new TextEncoder();
const reservations = new WeakMap<FilesApi, Set<string>>();

/** `base` with a `createExclusive` that reserves the path synchronously; `calls` lists its paths. */
function withCreateExclusive(base: FilesApi): { files: FilesApi; calls: string[] } {
  let held = reservations.get(base);
  if (!held) {
    held = new Set();
    reservations.set(base, held);
  }
  const reserved = held;
  const calls: string[] = [];
  const createExclusive = async (
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<boolean> => {
    calls.push(path);
    const key = path.replace(/^\/+/, "");
    if (reserved.has(key)) return false;
    reserved.add(key);
    try {
      if (await base.exists(path)) return false;
      await base.write(path, content);
      return true;
    } finally {
      reserved.delete(key);
    }
  };
  const files = new Proxy(base, {
    get(target, prop) {
      if (prop === "createExclusive") return createExclusive;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { files, calls };
}

/**
 * `base` behind a second instance, without `createExclusive` (a FilesApi that has none;
 * webrun-files-mem 0.11 has one, so it is hidden here).
 */
function plainWrapper(base: FilesApi): FilesApi {
  return new Proxy(base, {
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

createAtomicFilesTests("FilesApi with createExclusive", async () => ({
  files: atomicFilesOver(withCreateExclusive(createInMemoryFilesApi()).files, "/repo/.git"),
}));

describe("atomicFilesOver with FilesApi.createExclusive", () => {
  it("delegates createExclusive to the FilesApi", async () => {
    const { files, calls } = withCreateExclusive(createInMemoryFilesApi());
    const atomic = atomicFilesOver(files, "/repo/.git");
    expect(await atomic.createExclusive("refs/heads/main.lock", enc.encode("x"))).toBe(true);
    expect(calls).toEqual(["/repo/.git/refs/heads/main.lock"]);
  });

  it("two FilesApi instances over one storage exclude each other", async () => {
    const base = createInMemoryFilesApi();
    const a = atomicFilesOver(withCreateExclusive(base).files, "/repo/.git");
    const b = atomicFilesOver(withCreateExclusive(base).files, "/repo/.git");
    for (let round = 0; round < 10; round++) {
      const path = `refs/heads/b${round}.lock`;
      const won = await Promise.all([
        a.createExclusive(path, enc.encode("a")),
        b.createExclusive(path, enc.encode("b")),
      ]);
      expect(won.filter(Boolean)).toHaveLength(1);
    }
  });

  it("still refuses a lock below a file (ENOTDIR)", async () => {
    const atomic = atomicFilesOver(withCreateExclusive(createInMemoryFilesApi()).files, ".git");
    await atomic.write("refs/heads/c", enc.encode("1"));
    await expect(atomic.createExclusive("refs/heads/c/d.lock", enc.encode("y"))).rejects.toThrow();
  });

  it("without createExclusive, writers on one instance exclude each other as before", async () => {
    const files = plainWrapper(createInMemoryFilesApi());
    expect("createExclusive" in files).toBe(false);
    const atomic = atomicFilesOver(files, "/repo/.git");
    const won = await Promise.all(
      Array.from({ length: 10 }, (_, i) => atomic.createExclusive("x.lock", enc.encode(`${i}`))),
    );
    expect(won.filter(Boolean)).toHaveLength(1);
  });
});

describe("ref batches and gc through FilesApi.createExclusive", () => {
  const oid = (n: number) => n.toString(16).padStart(40, "a");

  it("ref batches on two FilesApi instances: one wins the ref lock", async () => {
    const base = createInMemoryFilesApi();
    await base.mkdir("/.git");
    await createRefsStructure(base, "/.git");
    const one = withCreateExclusive(base);
    const two = withCreateExclusive(base);
    const refsA = new FileRefStore(one.files, "/.git");
    const refsB = new FileRefStore(two.files, "/.git");
    for (let round = 0; round < 5; round++) {
      const name = `refs/heads/r${round}`;
      const results = await Promise.all([
        refsA.batch([{ name, old: null, new: oid(1) }]),
        refsB.batch([{ name, old: null, new: oid(2) }]),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    }
    expect(one.calls.some((p) => p.endsWith("refs/heads/r0.lock"))).toBe(true);
    expect(two.calls.some((p) => p.endsWith("refs/heads/r0.lock"))).toBe(true);
  });

  it("a multi-ref batch takes packed-refs.lock through createExclusive", async () => {
    const base = createInMemoryFilesApi();
    await base.mkdir("/.git");
    await createRefsStructure(base, "/.git");
    const { files, calls } = withCreateExclusive(base);
    const refs = new FileRefStore(files, "/.git");
    const r = await refs.batch([
      { name: "refs/heads/a", new: oid(1) },
      { name: "refs/heads/b", new: oid(2) },
    ]);
    expect(r.ok).toBe(true);
    expect(calls).toContain("/.git/packed-refs.lock");
  });

  it("gcs on two FilesApi instances: one takes gc.pid, the other is skipped", async () => {
    const base = createInMemoryFilesApi();
    await createGitFilesBackend({ files: base, create: true });
    const one = withCreateExclusive(base);
    const two = withCreateExclusive(base);
    const a = await createGitFilesBackend({ files: one.files });
    const b = await createGitFilesBackend({ files: two.files });
    const [ra, rb] = await Promise.all([
      gc({ history: a.history, files: one.files }),
      gc({ history: b.history, files: two.files }),
    ]);
    expect([ra.skipped, rb.skipped].sort()).toEqual([false, true]);
    expect(one.calls.some((p) => p.endsWith(".git/gc.pid"))).toBe(true);
    expect(await base.exists(".git/gc.pid")).toBe(false);
  });
});

describe("createExclusive retries when the lock's directory vanishes (ENOENT)", () => {
  /**
   * `base` with a `createExclusive` that throws ENOENT on its first `failures` calls, as
   * webrun-files-node's does when another process (native git) prunes the empty directory
   * between its `mkdir -p` and its `open "wx"`.
   */
  function flaky(base: FilesApi, failures: number): { files: FilesApi; attempts: () => number } {
    let n = 0;
    const createExclusive = async (
      path: string,
      content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
    ): Promise<boolean> => {
      n++;
      if (n <= failures) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
          code: "ENOENT",
        });
      }
      if (await base.exists(path)) return false;
      await base.write(path, content);
      return true;
    };
    const files = new Proxy(base, {
      get(target, prop) {
        if (prop === "createExclusive") return createExclusive;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { files, attempts: () => n };
  }

  it("retries once after ENOENT and takes the lock", async () => {
    const base = createInMemoryFilesApi();
    const { files, attempts } = flaky(base, 1);
    const atomic = atomicFilesOver(files, "/repo/.git");
    expect(await atomic.createExclusive("refs/heads/main.lock", enc.encode("x"))).toBe(true);
    expect(attempts()).toBe(2);
    expect(await base.exists("/repo/.git/refs/heads/main.lock")).toBe(true);
  });

  it("gives up and rethrows when ENOENT persists", async () => {
    const { files, attempts } = flaky(createInMemoryFilesApi(), 1000);
    const atomic = atomicFilesOver(files, "/repo/.git");
    await expect(atomic.createExclusive("index.lock", enc.encode("x"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(attempts()).toBeGreaterThan(1);
    expect(attempts()).toBeLessThan(1000);
  });

  it("does not retry other errors", async () => {
    const base = createInMemoryFilesApi();
    let n = 0;
    const files = new Proxy(base, {
      get(target, prop) {
        if (prop === "createExclusive") {
          return async () => {
            n++;
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const atomic = atomicFilesOver(files, "/repo/.git");
    await expect(atomic.createExclusive("index.lock", enc.encode("x"))).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(n).toBe(1);
  });
});

createAtomicFilesTests("webrun-files-mem 0.11 createExclusive", async () => ({
  files: atomicFilesOver(createInMemoryFilesApi(), "/repo/.git"),
}));

describe("webrun-files-mem's own createExclusive", () => {
  it("is present, and two instances over one MemFilesApi exclude each other", async () => {
    const base = createInMemoryFilesApi();
    expect(typeof base.createExclusive).toBe("function");
    const a = atomicFilesOver(plainProxy(base), "/repo/.git");
    const b = atomicFilesOver(plainProxy(base), "/repo/.git");
    const won = await Promise.all([
      a.createExclusive("index.lock", enc.encode("a")),
      b.createExclusive("index.lock", enc.encode("b")),
    ]);
    expect(won.filter(Boolean)).toHaveLength(1);
  });
});

/** A second handle on `base` that keeps all its methods, `createExclusive` included. */
function plainProxy(base: FilesApi): FilesApi {
  return new Proxy(base, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
