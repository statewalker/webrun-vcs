/**
 * The files backend's quarantine (git's receive-pack `tmp_objdir`): a received pack goes to
 * `objects/tmp_objdir-incoming-<id>/` (loose objects, or a kept pack under `pack/`) and is moved
 * into `objects/` on commit; gc removes the directory a crash left.
 */

import { type GitObjects, importPack, joinPath, writePack } from "@statewalker/vcs-core";
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

describe("files quarantine freshens objects the repository already has (git's freshen)", () => {
  const OLD = 3 * 24 * 3600_000;

  async function nodeRepo() {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createNodeFilesApi } = await import("@statewalker/vcs-utils-node/files");
    const dir = mkdtempSync(join(tmpdir(), "quarantine-freshen-"));
    const files = createNodeFilesApi({ rootDir: dir });
    const backend = await createGitFilesBackend({ files, create: true });
    // backend.files is the `files` passed in
    return { dir, ...backend, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  async function makeOld(path: string) {
    const { utimesSync } = await import("node:fs");
    const t = (Date.now() - OLD) / 1000;
    utimesSync(path, t, t);
  }

  async function ageHours(path: string) {
    const { statSync } = await import("node:fs");
    return (Date.now() - statSync(path).mtimeMs) / 3600_000;
  }

  async function packOf(objects: GitObjects, ids: string[]) {
    const chunks: Uint8Array[] = [];
    for await (const c of writePack(objects, ids)) chunks.push(c);
    return (async function* () {
      yield* chunks;
    })();
  }

  for (const unpackLimit of [1000, 1]) {
    const how = unpackLimit === 1 ? "kept pack" : "unpacked";
    it(`an old loose object re-pushed through the quarantine is renewed (${how})`, async () => {
      const { join } = await import("node:path");
      const repo = await nodeRepo();
      try {
        const bytes = new TextEncoder().encode("old unreachable object\n");
        const id = await repo.objects.put("blob", bytes.length, [bytes]);
        const loose = join(repo.dir, ".git/objects", id.slice(0, 2), id.slice(2));
        await makeOld(loose);
        const r = await importPack(repo.objects, await packOf(repo.objects, [id]), {
          quarantine: true,
          unpackLimit,
        });
        await r.quarantine?.commit();
        // a fresh loose copy, or a fresh pack holding it: either keeps gc away
        const renewed = (await ageHours(loose)) < 1 || (await repo.packs.freshen(id));
        expect(renewed).toBe(true);
      } finally {
        repo.cleanup();
      }
    });
  }

  it("an object only in an old pack, re-pushed, gets a fresh loose copy", async () => {
    const { join } = await import("node:path");
    const { rmSync } = await import("node:fs");
    const repo = await nodeRepo();
    try {
      const bytes = new TextEncoder().encode("packed long ago\n");
      const id = await repo.objects.put("blob", bytes.length, [bytes]);
      const installed = await repo.packs.install(await packOf(repo.objects, [id]));
      await makeOld(join(repo.dir, `.git/objects/pack/pack-${installed.packId}.pack`));
      const loose = join(repo.dir, ".git/objects", id.slice(0, 2), id.slice(2));
      rmSync(loose);
      expect(await repo.packs.freshen(id)).toBe(false);
      const r = await importPack(repo.objects, await packOf(repo.objects, [id]), {
        quarantine: true,
      });
      await r.quarantine?.commit();
      expect(await ageHours(loose)).toBeLessThan(1);
    } finally {
      repo.cleanup();
    }
  });

  it("an old pack received again under the same name is renewed on commit", async () => {
    const { join } = await import("node:path");
    const repo = await nodeRepo();
    try {
      const bytes = new TextEncoder().encode("same pack twice\n");
      const id = await repo.objects.put("blob", bytes.length, [bytes]);
      const installed = await repo.packs.install(await packOf(repo.objects, [id]));
      const packPath = join(repo.dir, `.git/objects/pack/pack-${installed.packId}.pack`);
      await makeOld(packPath);
      const q = await repo.objects.beginQuarantine?.();
      if (!q?.packs) throw new Error("no quarantine packs");
      const again = await q.packs.install(await packOf(repo.objects, [id]));
      expect(again.packId).toBe(installed.packId);
      await q.commit();
      expect(await ageHours(packPath)).toBeLessThan(1);
      expect(await repo.objects.has(id)).toBe(true);
    } finally {
      repo.cleanup();
    }
  });
});
