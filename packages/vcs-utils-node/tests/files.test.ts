import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createNodeFilesApi, NodeFilesApi } from "../src/files/index.js";

describe("Node.js Files API", () => {
  describe("createNodeFilesApi", () => {
    it("should create a FilesApi instance", () => {
      const files = createNodeFilesApi({ rootDir: tmpdir() });
      expect(files).toBeDefined();
      expect(files.read).toBeDefined();
      expect(files.write).toBeDefined();
      expect(files.list).toBeDefined();
    });
  });

  describe("NodeFilesApi export", () => {
    it("should export NodeFilesApi class", () => {
      expect(NodeFilesApi).toBeDefined();
      expect(typeof NodeFilesApi).toBe("function");
    });
  });
});

describe("NodeFilesApi from webrun-files-node 0.11", () => {
  const enc = new TextEncoder();
  const read = async (files: ReturnType<typeof createNodeFilesApi>, path: string) => {
    let out = "";
    for await (const c of files.read(path)) out += new TextDecoder().decode(c, { stream: true });
    return out;
  };

  it("rooted at / accepts absolute paths", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "root-slash-"));
    try {
      const files = createNodeFilesApi({ rootDir: "/" });
      await files.write(`${dir}/a/b.txt`, [enc.encode("hello")]);
      expect(await files.exists(`${dir}/a/b.txt`)).toBe(true);
      expect(await read(files, `${dir}/a/b.txt`)).toBe("hello");
      expect(await files.remove(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write streams: the old content stays until the new one is complete", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "stream-write-"));
    try {
      const files = createNodeFilesApi({ rootDir: dir });
      await files.write("f.txt", [enc.encode("old")]);
      let release = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let pulled = 0;
      const writing = files.write(
        "f.txt",
        (async function* () {
          pulled++;
          yield enc.encode("new-");
          await gate;
          pulled++;
          yield enc.encode("content");
        })(),
      );
      // the first chunk is taken while the source is still open: nothing is collected first
      while (pulled === 0) await new Promise((r) => setTimeout(r, 1));
      expect(await read(files, "f.txt")).toBe("old");
      release();
      await writing;
      expect(await read(files, "f.txt")).toBe("new-content");
      // a temporary file was renamed over the target; none is left behind
      const names: string[] = [];
      for await (const e of files.list("/")) names.push(e.name);
      expect(names).toEqual(["f.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has createExclusive (open 'wx')", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "excl-"));
    try {
      const files = createNodeFilesApi({ rootDir: dir });
      expect(typeof files.createExclusive).toBe("function");
      expect(await files.createExclusive?.("x/y.lock", [enc.encode("1")])).toBe(true);
      expect(await files.createExclusive?.("x/y.lock", [enc.encode("2")])).toBe(false);
      expect(await read(files, "x/y.lock")).toBe("1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
