import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeTempDir } from "./temp-dir-support.js";

describe("removeTempDir", () => {
  it("removes a tree holding read-only object files and a closed directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "temp-dir-support-"));
    const objects = join(root, "repo", ".git", "objects", "ab");
    mkdirSync(objects, { recursive: true });
    const loose = join(objects, "cdef");
    writeFileSync(loose, "x");
    chmodSync(loose, 0o444);
    const closed = join(root, "closed");
    mkdirSync(join(closed, "inner"), { recursive: true });
    writeFileSync(join(closed, "inner", "f"), "y");
    chmodSync(closed, 0o000);
    await removeTempDir(root);
    expect(existsSync(root)).toBe(false);
  });

  it("does nothing for a missing or empty path", async () => {
    await removeTempDir(undefined);
    await removeTempDir("");
    await removeTempDir(join(tmpdir(), "temp-dir-support-missing-0"));
  });
});
