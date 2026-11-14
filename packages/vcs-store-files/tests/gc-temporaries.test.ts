/**
 * Native git writes objects/ab/tmp_obj_* while it works: gc and repack must not
 * take such a file for an object (or remove a write in flight).
 */
import { createInMemoryFilesApi } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";
import { createGitFilesBackend, gc, repack } from "../src/index.js";

describe("gc and repack skip temporaries in fan-out directories", () => {
  it("leaves objects/ab/tmp_obj_* alone", async () => {
    const files = createInMemoryFilesApi();
    const backend = await createGitFilesBackend({ files, create: true });
    const content = new TextEncoder().encode("loose\n");
    const blob = await backend.history.blobs.store([content], content.length);
    const tmp = `.git/objects/${blob.slice(0, 2)}/tmp_obj_inflight`;
    await files.write(tmp, [new TextEncoder().encode("partial")]);

    const gcResult = await gc({ history: backend.history, files, dryRun: true });
    expect(gcResult).toBeDefined();
    await gc({ history: backend.history, files });
    expect(await files.exists(tmp)).toBe(true);

    const result = await repack({
      looseStorage: backend.looseStorage,
      packDirectory: backend.packDirectory,
    });
    expect(result?.objectCount ?? 0).toBeLessThanOrEqual(1);
    expect(await files.exists(tmp)).toBe(true);
  });
});

describe("gc removes stale temporaries, as git prune does", () => {
  it("removes tmp_obj_* older than the expiry, keeps fresh ones, none in a dry run", async () => {
    const { mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createNodeFilesApi } = await import("@statewalker/vcs-utils-node/files");
    const dir = mkdtempSync(join(tmpdir(), "gc-tmp-"));
    try {
      const files = createNodeFilesApi({ rootDir: dir });
      const backend = await createGitFilesBackend({ files, create: true });
      const stale = join(dir, ".git/objects/tmp_obj_crashed");
      const fresh = join(dir, ".git/objects/tmp_obj_writing");
      writeFileSync(stale, "partial");
      writeFileSync(fresh, "partial");
      const old = new Date(Date.now() - 15 * 24 * 3600_000);
      utimesSync(stale, old, old);

      const dry = await gc({ history: backend.history, files, dryRun: true });
      expect(dry.removedTemporaries).toBe(0);
      expect(existsSync(stale)).toBe(true);

      const result = await gc({ history: backend.history, files });
      expect(result.removedTemporaries).toBe(1);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
