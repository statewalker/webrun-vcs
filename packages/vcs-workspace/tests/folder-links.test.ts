/**
 * Workspace sync and symbolic links, as git: a link is recorded as a mode 120000 entry whose
 * content is its target (never followed: the file it names is never published, a linked
 * directory never descended into), and written back as a link where the folder can make
 * one, else as a file holding the target. An lstat error fails the walk instead of dropping
 * the file (which would sync as a deletion). Test-only code: `node:*` allowed.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInMemoryFilesApi, createMemoryHistoryWithOperations } from "@statewalker/vcs-core";
import {
  createMountedFilesApi,
  createSubtreeFilesApi,
  createSymlinkFilesApi,
  type PosixFilesApi,
} from "@statewalker/vcs-utils/files";
import { NodeFilesApi, PosixNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyFolderPath,
  MODE_SYMLINK,
  type SnapshotReport,
  snapshotFolder,
  walkFolder,
} from "../src/net/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("folder walks record symbolic links as links", () => {
  let base: string;
  let folder: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "folder-links-"));
    folder = join(base, "folder");
    mkdirSync(join(folder, "dir"), { recursive: true });
    writeFileSync(join(folder, "a.txt"), "a\n");
    writeFileSync(join(folder, "dir/b.txt"), "b\n");
    writeFileSync(join(base, "secret.txt"), "SECRET\n");
    mkdirSync(join(base, "outdir"));
    writeFileSync(join(base, "outdir/c.txt"), "c\n");
    symlinkSync("../secret.txt", join(folder, "leak"));
    symlinkSync("../outdir", join(folder, "out"));
    symlinkSync("..", join(folder, "dir/loop"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("lists links as link entries, never descending into them", async () => {
    const walk = await walkFolder(new PosixNodeFilesApi({ rootDir: folder }));
    expect(walk.files.map((f) => `${f.path}${f.link ? " ->" : ""}`).sort()).toEqual([
      "a.txt",
      "dir/b.txt",
      "dir/loop ->",
      "leak ->",
      "out ->",
    ]);
    expect(walk.special).toEqual([]);
  });

  it("snapshots a link's target as its content, never the file it names", async () => {
    const history = createMemoryHistoryWithOperations();
    const report: SnapshotReport = { nested: [], skipped: [] };
    const snapshot = await snapshotFolder(
      history,
      new PosixNodeFilesApi({ rootDir: folder }),
      {},
      report,
    );
    const leak = snapshot.get("leak");
    expect(leak?.link).toBe(true);
    const chunks: Uint8Array[] = [];
    for await (const chunk of (await history.blobs.load(leak?.id ?? "")) ?? []) chunks.push(chunk);
    expect(dec.decode(Buffer.concat(chunks))).toBe("../secret.txt");
    expect(snapshot.get("out")?.link).toBe(true);
    expect([...snapshot.keys()].filter((p) => p.startsWith("out/"))).toEqual([]);
  });

  it("writes a 120000 entry back as a link, or as a file of its target without links", async () => {
    const history = createMemoryHistoryWithOperations();
    const id = await history.blobs.store([enc.encode("a.txt")]);
    const entry = { id, mode: MODE_SYMLINK };
    const accept = () => true;

    await applyFolderPath(history, new PosixNodeFilesApi({ rootDir: folder }), "ln", entry, {
      accept,
    });
    expect(readlinkSync(join(folder, "ln"))).toBe("a.txt");

    await applyFolderPath(history, new NodeFilesApi({ rootDir: folder }), "plain", entry, {
      accept,
    });
    expect(lstatSync(join(folder, "plain")).isFile()).toBe(true);
    expect(readFileSync(join(folder, "plain"), "utf8")).toBe("a.txt");
  });

  it("writes links through a simulated link-aware FilesApi too", async () => {
    const history = createMemoryHistoryWithOperations();
    const files = createSymlinkFilesApi(createInMemoryFilesApi());
    const id = await history.blobs.store([enc.encode("../secret")]);
    await applyFolderPath(
      history,
      files as never,
      "ln",
      { id, mode: MODE_SYMLINK },
      {
        accept: () => true,
      },
    );
    expect((await files.lstat?.("/ln"))?.kind).toBe("symlink");
    const walk = await walkFolder(files as never);
    expect(walk.files.map((f) => `${f.path}${f.link ? " ->" : ""}`)).toEqual(["ln ->"]);
  });

  it("fails the walk on an lstat error instead of dropping the file", async () => {
    const files = createSymlinkFilesApi(createInMemoryFilesApi({ "/a.txt": "a" }));
    const failing = Object.assign(Object.create(files), {
      list: files.list.bind(files),
      lstat: async () => {
        throw new Error("EIO: lstat failed");
      },
    });
    await expect(walkFolder(failing)).rejects.toThrow(/EIO/);
  });
});

/** The workspace part of the symbolic-link suite, against every link-aware FilesApi. */
const linkAware: { name: string; create(): { files: PosixFilesApi; cleanup(): void } }[] = [
  {
    name: "PosixNodeFilesApi",
    create: () => {
      const dir = mkdtempSync(join(tmpdir(), "ws-links-"));
      return {
        files: new PosixNodeFilesApi({ rootDir: dir }),
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "createSymlinkFilesApi over memory",
    create: () => ({ files: createSymlinkFilesApi(createInMemoryFilesApi()), cleanup: () => {} }),
  },
  {
    name: "createSymlinkFilesApi over a mounted composite",
    create: () => ({
      files: createSymlinkFilesApi(
        createMountedFilesApi(createInMemoryFilesApi(), { "/folder": createInMemoryFilesApi() }),
      ),
      cleanup: () => {},
    }),
  },
];

for (const impl of linkAware) {
  describe(`workspace sync of symbolic links (${impl.name})`, () => {
    let files: PosixFilesApi;
    let cleanup: () => void;
    beforeEach(async () => {
      ({ files, cleanup } = impl.create());
      await files.write("/secret.txt", [enc.encode("SECRET\n")]);
      await files.write("/folder/a.txt", [enc.encode("a\n")]);
      await files.symlink?.(enc.encode("../secret.txt"), "/folder/leak");
      await files.symlink?.(enc.encode(".."), "/folder/loop");
    });
    afterEach(() => cleanup());

    it("records links as 120000 entries of their target and writes them back as links", async () => {
      const folder = createSubtreeFilesApi(files, "/folder") as never;
      const history = createMemoryHistoryWithOperations();
      const snapshot = await snapshotFolder(history, folder);
      expect([...snapshot.keys()].sort()).toEqual(["a.txt", "leak", "loop"]);
      const leak = snapshot.get("leak");
      expect(leak?.link).toBe(true);
      const chunks: Uint8Array[] = [];
      for await (const chunk of (await history.blobs.load(leak?.id ?? "")) ?? [])
        chunks.push(chunk);
      expect(dec.decode(Buffer.concat(chunks))).toBe("../secret.txt");

      await applyFolderPath(
        history,
        folder,
        "copy",
        { id: leak?.id ?? "", mode: MODE_SYMLINK },
        {
          accept: () => true,
        },
      );
      expect((await files.lstat?.("/folder/copy"))?.kind).toBe("symlink");
      expect(dec.decode(await files.readlink?.("/folder/copy"))).toBe("../secret.txt");
    });
  });
}
