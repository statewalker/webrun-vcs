/**
 * FileWorktree's stat pass: `getEntries` answers as `getEntry` path by path (one `lstatMany`
 * over a Node FilesApi, `getEntry` per path over any other), and a walk with `skipFile`
 * passes the skipped files over without a stat, yielding the same entries otherwise.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Blobs, createInMemoryFilesApi, type Trees } from "@statewalker/vcs-core";
import { createFileWorktree } from "@statewalker/vcs-store-files";
import { createSymlinkFilesApi } from "@statewalker/vcs-utils/files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import type { Worktree, WorktreeEntry } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const noStores = { blobs: {} as Blobs, trees: {} as Trees };

/** An entry as plain data (an ignored flag worked out when asked included). */
const plain = (e: WorktreeEntry | undefined) =>
  e === undefined ? undefined : JSON.parse(JSON.stringify({ ...e }));

describe("FileWorktree getEntries and walk skipFile", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "worktree-stat-batch-"));
    mkdirSync(join(root, "d/sub"), { recursive: true });
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "d/b.log"), "bb");
    writeFileSync(join(root, "d/sub/c.sh"), "ccc");
    chmodSync(join(root, "d/sub/c.sh"), 0o755);
    writeFileSync(join(root, ".gitignore"), "*.log\n");
    symlinkSync("d", join(root, "link"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const paths = ["a.txt", "d/b.log", "d/sub/c.sh", "link", "link/b.log", "d", "missing"];

  it("getEntries answers as getEntry over a Node FilesApi", async () => {
    const files = createNodeFilesApi({ rootDir: root });
    const worktree = createFileWorktree({ files, rootPath: "", gitDir: ".git", ...noStores });
    const many = await (worktree.getEntries?.(paths) ?? []);
    const one = await Promise.all(paths.map((p) => worktree.getEntry(p)));
    expect(many.map(plain)).toEqual(one.map(plain));
    expect(many[4]).toBeUndefined();
  });

  it("getEntries falls back to getEntry where the FilesApi has no lstatMany", async () => {
    const mem = createSymlinkFilesApi(createInMemoryFilesApi());
    await mem.write("/a.txt", [new TextEncoder().encode("a")]);
    await mem.write("/d/b.txt", [new TextEncoder().encode("b")]);
    const worktree: Worktree = createFileWorktree({
      files: mem,
      rootPath: "",
      gitDir: ".git",
      ...noStores,
    });
    const asked = ["a.txt", "d/b.txt", "nope"];
    const many = await (worktree.getEntries?.(asked) ?? []);
    const one = await Promise.all(asked.map((p) => worktree.getEntry(p)));
    expect(many.map(plain)).toEqual(one.map(plain));
  });

  it("a walk with skipFile yields the other entries alike and stats no skipped file", async () => {
    const files = createNodeFilesApi({ rootDir: root });
    const worktree = createFileWorktree({ files, rootPath: "", gitDir: ".git", ...noStores });
    const all: WorktreeEntry[] = [];
    for await (const e of worktree.walk({ includeDirectories: true, includeIgnored: true })) {
      all.push(e);
    }
    const skipped = new Set(["a.txt", "d/sub/c.sh"]);
    const batch = files.withLstatCache?.() ?? files;
    const lstat = vi.spyOn(batch, "lstat");
    const scoped = vi.spyOn(files, "withLstatCache").mockReturnValue(batch);
    const some: WorktreeEntry[] = [];
    for await (const e of worktree.walk({
      includeDirectories: true,
      includeIgnored: true,
      skipFile: (p) => skipped.has(p),
    })) {
      some.push(e);
    }
    scoped.mockRestore();
    expect(some.map(plain)).toEqual(all.filter((e) => !skipped.has(e.path)).map(plain));
    const statted = lstat.mock.calls.map((c) => c[0]);
    expect(statted).not.toContain("/a.txt");
    expect(statted).not.toContain("/d/sub/c.sh");
  });
});

describe("FileWorktree getEntries without lstatMany: bounded concurrency", () => {
  it("keeps a bounded number of FilesApi calls in flight over a slow FilesApi", async () => {
    const mem = createSymlinkFilesApi(createInMemoryFilesApi());
    const asked: string[] = [];
    for (let i = 0; i < 600; i++) {
      const path = `d${i % 7}/f${i}.txt`;
      asked.push(path);
      if (i % 3 !== 0) await mem.write(`/${path}`, [new TextEncoder().encode(`${i}`)]);
    }
    asked.push("nope", "d1/nope");
    let inFlight = 0;
    let most = 0;
    // every asynchronous call takes a timer tick, as over OPFS or fetch
    const slow = new Proxy(mem, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function" || key === "lstatMany") return value;
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          if (!(result instanceof Promise)) return result;
          inFlight++;
          most = Math.max(most, inFlight);
          return new Promise((resolve) => setTimeout(resolve, 1)).then(async () => {
            try {
              return await result;
            } finally {
              inFlight--;
            }
          });
        };
      },
    });
    const worktree: Worktree = createFileWorktree({
      files: slow,
      rootPath: "",
      gitDir: ".git",
      ...noStores,
    });
    const many = await (worktree.getEntries?.(asked) ?? []);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(64);
    const plainWorktree = createFileWorktree({
      files: mem,
      rootPath: "",
      gitDir: ".git",
      ...noStores,
    });
    const one = await Promise.all(asked.map((p) => plainWorktree.getEntry(p)));
    expect(many.map(plain)).toEqual(one.map(plain));
    expect(many.filter(Boolean)).toHaveLength(400);
  });
});
