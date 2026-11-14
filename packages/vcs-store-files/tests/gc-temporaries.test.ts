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
