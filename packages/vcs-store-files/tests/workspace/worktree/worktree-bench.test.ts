/**
 * A rough benchmark of the link-safe worktree over a real directory: 10 000 files five
 * directories deep, written, walked and hashed through FileWorktree over createNodeFilesApi.
 * It asserts only that the work completes within a generous bound; the timings are printed
 * (BENCH lines) to compare implementations.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Blobs, Trees } from "@statewalker/vcs-core";
import { createFileWorktree } from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";

const FILES = 10_000;
const enc = new TextEncoder();

describe("FileWorktree benchmark (10k files, depth 5)", () => {
  const root = mkdtempSync(join(tmpdir(), "worktree-bench-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const worktree = createFileWorktree({
    files: createNodeFilesApi({ rootDir: root }),
    rootPath: "",
    blobs: {} as Blobs,
    trees: {} as Trees,
  });
  const pathOf = (i: number) =>
    `d${i % 10}/e${Math.floor(i / 10) % 10}/f${Math.floor(i / 100) % 10}/g${Math.floor(i / 1000) % 10}/file${i}.txt`;

  it("writes, walks and hashes", { timeout: 600_000 }, async () => {
    let start = performance.now();
    for (let i = 0; i < FILES; i++) await worktree.writeContent(pathOf(i), enc.encode(`${i}\n`));
    const write = performance.now() - start;

    start = performance.now();
    let walked = 0;
    for await (const _ of worktree.walk()) walked++;
    const walk = performance.now() - start;

    start = performance.now();
    for (let i = 0; i < FILES; i += 10) await worktree.computeHash(pathOf(i));
    const hash = performance.now() - start;

    console.log(
      `BENCH write=${write.toFixed(0)}ms walk=${walk.toFixed(0)}ms hash(1k)=${hash.toFixed(0)}ms`,
    );
    expect(walked).toBe(FILES);
  });
});
