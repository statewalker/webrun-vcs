/**
 * Conformance suite for `AtomicFiles`: the primitives git's lock-file protocol
 * needs (exclusive create, replace by rename, append, remove-if-empty).
 */

import type { AtomicFiles } from "@statewalker/vcs-utils/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

export interface AtomicFilesTestContext {
  files: AtomicFiles;
  cleanup?: () => Promise<void>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function text(files: AtomicFiles, path: string): Promise<string | undefined> {
  if (!(await files.exists(path))) return undefined;
  let out = "";
  for await (const chunk of files.read(path)) out += dec.decode(chunk, { stream: true });
  return out + dec.decode();
}

async function paths(files: AtomicFiles, dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const p of files.list(dir)) out.push(p);
  return out;
}

/**
 * @param name Implementation name (e.g. "FilesApi fallback", "Node")
 * @param factory Creates an empty root per test
 * @param options `crossProcess`: whether exclusivity holds across processes (documented, not tested here)
 */
export function createAtomicFilesTests(
  name: string,
  factory: () => Promise<AtomicFilesTestContext>,
): void {
  describe(`AtomicFiles [${name}]`, () => {
    let ctx: AtomicFilesTestContext;
    let files: AtomicFiles;

    beforeEach(async () => {
      ctx = await factory();
      files = ctx.files;
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    it("createExclusive creates once, with its content and parent directories", async () => {
      expect(await files.createExclusive("refs/heads/main.lock", enc.encode("a\n"))).toBe(true);
      expect(await files.createExclusive("refs/heads/main.lock", enc.encode("b\n"))).toBe(false);
      expect(await text(files, "refs/heads/main.lock")).toBe("a\n");
    });

    it("exactly one of 20 concurrent createExclusive calls wins", async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => files.createExclusive("x.lock", enc.encode(`${i}`))),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results.indexOf(true);
      expect(await text(files, "x.lock")).toBe(`${winner}`);
    });

    it("replace moves a file over an existing target", async () => {
      await files.write("refs/heads/main", enc.encode("old\n"));
      await files.createExclusive("refs/heads/main.lock", enc.encode("new\n"));
      await files.replace("refs/heads/main.lock", "refs/heads/main");
      expect(await text(files, "refs/heads/main")).toBe("new\n");
      expect(await files.exists("refs/heads/main.lock")).toBe(false);
    });

    it("append creates the file and its directories, then appends", async () => {
      await files.append("logs/refs/heads/main", enc.encode("one\n"));
      await files.append("logs/refs/heads/main", enc.encode("two\n"));
      expect(await text(files, "logs/refs/heads/main")).toBe("one\ntwo\n");
    });

    it("removeEmptyDir removes only an empty directory", async () => {
      await files.write("refs/heads/a/b", enc.encode("x"));
      expect(await files.removeEmptyDir("refs/heads/a")).toBe(false);
      expect(await files.exists("refs/heads/a/b")).toBe(true);
      expect(await files.remove("refs/heads/a/b")).toBe(true);
      expect(await files.removeEmptyDir("refs/heads/a")).toBe(true);
      expect(await files.removeEmptyDir("refs/heads/missing")).toBe(false);
      expect(await files.removeEmptyDir("refs/heads/none-file")).toBe(false);
    });

    it("lists files (not directories) below a directory, recursively and sorted", async () => {
      await files.write("refs/heads/b", enc.encode("x"));
      await files.write("refs/heads/a/c", enc.encode("x"));
      await files.write("refs/tags/t", enc.encode("x"));
      expect(await paths(files, "refs/heads")).toEqual(["refs/heads/a/c", "refs/heads/b"]);
      expect(await paths(files, "refs/missing")).toEqual([]);
    });

    it("reads nothing and reports absence for a missing file; remove says whether it removed", async () => {
      expect(await text(files, "nope")).toBeUndefined();
      expect(await paths(files, "nope")).toEqual([]);
      expect(await files.remove("nope")).toBe(false);
      await files.write("yes", enc.encode("1"));
      expect(await files.remove("yes")).toBe(true);
    });
  });
}
