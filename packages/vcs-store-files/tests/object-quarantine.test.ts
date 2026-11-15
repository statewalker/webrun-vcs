/**
 * The files backend's quarantine (git's receive-pack `tmp_objdir`): a received pack goes to
 * `objects/tmp_objdir-incoming-<id>/` (loose objects, or a kept pack under `pack/`) and is moved
 * into `objects/` on commit; gc removes the directory a crash left.
 */

import { joinPath } from "@statewalker/vcs-core";
import { createObjectQuarantineTests } from "@statewalker/vcs-testing";
import { timestampedId } from "@statewalker/vcs-utils";
import { createInMemoryFilesApi, type FilesApi } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";
import {
  createGitFilesBackend,
  gc,
  QUARANTINE_DIR_PREFIX,
  sweepQuarantines,
} from "../src/index.js";

const OBJECTS = ".git/objects";

async function quarantineDirs(files: FilesApi): Promise<string[]> {
  const dirs: string[] = [];
  for await (const e of files.list(OBJECTS)) {
    if (e.kind === "directory" && e.name.startsWith(QUARANTINE_DIR_PREFIX)) dirs.push(e.name);
  }
  return dirs;
}

async function plantLeftover(files: FilesApi, ageMs: number): Promise<string> {
  const dir = joinPath(OBJECTS, `${QUARANTINE_DIR_PREFIX}${timestampedId(Date.now() - ageMs)}`);
  await files.mkdir(joinPath(dir, "ab"));
  await files.mkdir(joinPath(dir, "pack"));
  await files.write(joinPath(dir, "ab", "cd".repeat(19)), [new Uint8Array([1, 2, 3])]);
  return dir;
}

createObjectQuarantineTests("Files", async () => {
  const files = createInMemoryFilesApi();
  const { objects } = await createGitFilesBackend({ files, create: true });
  return {
    objects,
    quarantines: async () => (await quarantineDirs(files)).length,
    plantLeftover: async (ageMs) => {
      await plantLeftover(files, ageMs);
    },
    sweep: (olderThanMs) => sweepQuarantines(files, OBJECTS, olderThanMs),
  };
});

describe("files quarantine layout", () => {
  it("a kept pack waits in the quarantine's pack/ and lands in objects/pack on commit", async () => {
    const files = createInMemoryFilesApi();
    const { objects, packs } = await createGitFilesBackend({ files, create: true });
    const q = await objects.beginQuarantine?.();
    if (!q?.packs) throw new Error("no quarantine packs");
    const bytes = new TextEncoder().encode("packed in quarantine\n");
    const scratch = await createGitFilesBackend({ files: createInMemoryFilesApi(), create: true });
    const id = await scratch.objects.put("blob", bytes.length, [bytes]);
    const { writePack } = await import("@statewalker/vcs-core");
    const installed = await q.packs.install(writePack(scratch.objects, [id]));
    const [dir] = await quarantineDirs(files);
    expect(await files.exists(`${OBJECTS}/${dir}/pack/pack-${installed.packId}.idx`)).toBe(true);
    expect(await files.exists(`${OBJECTS}/pack/pack-${installed.packId}.idx`)).toBe(false);
    expect(await objects.has(id)).toBe(false);
    expect(await q.objects.has(id)).toBe(true);
    await q.commit();
    expect(await files.exists(`${OBJECTS}/pack/pack-${installed.packId}.pack`)).toBe(true);
    expect(await files.exists(`${OBJECTS}/pack/pack-${installed.packId}.idx`)).toBe(true);
    expect((await packs.packs()).some((p) => p.packId === installed.packId)).toBe(true);
    expect(await objects.has(id)).toBe(true);
    expect(await quarantineDirs(files)).toEqual([]);
  });

  it("gc removes a stale quarantine directory, keeps a fresh one, none in a dry run", async () => {
    const files = createInMemoryFilesApi();
    const { history } = await createGitFilesBackend({ files, create: true });
    const stale = await plantLeftover(files, 15 * 24 * 3600_000);
    const fresh = await plantLeftover(files, 0);
    const dry = await gc({ history, files, dryRun: true });
    expect(dry.removedQuarantines).toBe(0);
    expect(await files.exists(stale)).toBe(true);
    const result = await gc({ history, files });
    expect(result.removedQuarantines).toBe(1);
    expect(await files.exists(stale)).toBe(false);
    expect(await files.exists(fresh)).toBe(true);
  });
});
