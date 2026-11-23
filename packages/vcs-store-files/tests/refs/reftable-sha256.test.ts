/**
 * SHA-256 reftables (version 2, hash id `s256`): the writer writes them as git does (28-byte
 * header, 72-byte footer, 32-byte ids in ref and log records and obj keys), the reader reads
 * them, and a table whose hash differs from the repository's is refused (git's
 * `REFTABLE_FORMAT_ERROR`, "corrupt reftable file"). The native twins are vcs-commands'
 * `sha256-reftable-git3-native.test.ts`.
 */
import { createHash } from "node:crypto";
import { createInMemoryFilesApi } from "@statewalker/vcs-core";
import { SHA1_OBJECT_FORMAT, SHA256_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";
import { describe, expect, it } from "vitest";

import { createGitFilesBackend } from "../../src/index.js";
import {
  createReftableRefStore,
  createReftableStackReader,
  openReftable,
  ReftableFormatError,
  type ReftableLogWrite,
  type ReftableRefWrite,
  ReftableWriteError,
  writeReftable,
} from "../../src/refs/reftable/index.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
/** A realistic SHA-256 id (ids that share 31 bytes would overflow obj_id_len's 5 bits) */
const id64 = (n: number) => createHash("sha256").update(String(n)).digest("hex");
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const ZERO64 = "0".repeat(64);
const IDENT = "T <t@example.com> 1700000000 +0100";
const dec = new TextDecoder();

async function read(files: ReturnType<typeof createInMemoryFilesApi>, path: string) {
  let text = "";
  for await (const chunk of files.read(path)) text += dec.decode(chunk, { stream: true });
  return text + dec.decode();
}

async function readBytes(files: ReturnType<typeof createInMemoryFilesApi>, path: string) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of files.read(path)) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

describe("SHA-256 reftables: writer and reader", () => {
  it("writes git init's SHA-256 table byte for byte (version 2, hash id s256)", () => {
    const bytes = writeReftable(
      {
        minUpdateIndex: 1,
        maxUpdateIndex: 1,
        refs: [
          { name: "HEAD", updateIndex: 1, value: { type: "symref", target: "refs/heads/main" } },
        ],
      },
      { objectFormat: SHA256_OBJECT_FORMAT },
    ) as Uint8Array;
    // `git init --object-format=sha256` with a git 3.0 build
    expect(hex(bytes)).toBe(
      "52454654020010000000000000000001000000000000000173323536" +
        "7200003c002348454144000f726566732f68656164732f6d61696e00002000015245465402001000000000000000000100000000000000017332353600" +
        "0".repeat(78) +
        "4258be0d",
    );
    const table = openReftable(bytes, "init.ref");
    expect(table.version).toBe(2);
    expect(table.objectFormat.name).toBe("sha256");
    expect(table.getRef("HEAD")?.value).toEqual({ type: "symref", target: "refs/heads/main" });
  });

  it("SHA-1 tables stay version 1", () => {
    const bytes = writeReftable(
      {
        minUpdateIndex: 1,
        maxUpdateIndex: 1,
        refs: [{ name: "refs/heads/a", updateIndex: 1, value: { type: "id", id: "a".repeat(40) } }],
      },
      { objectFormat: SHA1_OBJECT_FORMAT },
    ) as Uint8Array;
    expect(bytes[4]).toBe(1);
    expect(openReftable(bytes).objectFormat.name).toBe("sha1");
  });

  it("reads back 32-byte values, peeled values and log ids over many blocks with an obj index", () => {
    const refs: ReftableRefWrite[] = [];
    const logs: ReftableLogWrite[] = [];
    for (let i = 0; i < 2000; i++) {
      const name = `refs/tags/t-${String(i).padStart(5, "0")}`;
      refs.push({
        name,
        updateIndex: 5,
        value:
          i % 3 ? { type: "id", id: id64(i + 1) } : { type: "peeled", id: id64(i + 1), peeled: A },
      });
      logs.push({
        refName: name,
        updateIndex: 5,
        update: {
          oldId: ZERO64,
          newId: id64(i + 1),
          name: "A U Thor",
          email: "author@example.com",
          time: 1700000000 + i,
          tzOffset: -480,
          message: `tag ${i}`,
        },
      });
    }
    const bytes = writeReftable(
      { minUpdateIndex: 5, maxUpdateIndex: 5, refs, logs },
      { objectFormat: SHA256_OBJECT_FORMAT },
    ) as Uint8Array;
    const table = openReftable(bytes, "big.ref", { objectFormat: SHA256_OBJECT_FORMAT });
    const { blocks } = table.verify();
    expect(blocks.ref).toBeGreaterThan(3);
    expect(blocks.index).toBeGreaterThan(0);
    expect(blocks.obj).toBeGreaterThan(0);
    // git's obj_id_len: the longest common prefix of the sorted ids plus one, at least 2
    const sorted = [...new Set([A, ...refs.map((r) => (r.value as { id: string }).id)])].sort();
    let common = 1;
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1] as string;
      const b = sorted[i] as string;
      let n = 0;
      while (n < 32 && a.slice(2 * n, 2 * n + 2) === b.slice(2 * n, 2 * n + 2)) n++;
      common = Math.max(common, n);
    }
    expect(table.objectIdLength).toBe(common + 1);
    expect(table.getRef("refs/tags/t-00003")?.value).toEqual({
      type: "peeled",
      id: id64(4),
      peeled: A,
    });
    expect(table.getRef("refs/tags/t-00004")?.value).toEqual({ type: "id", id: id64(5) });
    expect([...table.refs()].length).toBe(2000);
    const log = [...table.logs("refs/tags/t-01999")];
    expect(log.map((l) => [l.update?.oldId, l.update?.newId, l.update?.message])).toEqual([
      [ZERO64, id64(2000), "tag 1999\n"],
    ]);
  });

  it("computes obj_id_len from the 32-byte ids as git does (common prefix + 1, at least 2)", () => {
    const refs: ReftableRefWrite[] = [];
    for (let i = 0; i < 400; i++) {
      // distinct in the third byte: obj_id_len 3
      const first = (i * 7919) % 65536;
      refs.push({
        name: `refs/heads/b-${String(i).padStart(4, "0")}`,
        updateIndex: 1,
        value: { type: "id", id: `ab${first.toString(16).padStart(4, "0")}${"5".repeat(58)}` },
      });
    }
    const bytes = writeReftable(
      { minUpdateIndex: 1, maxUpdateIndex: 1, refs },
      { objectFormat: SHA256_OBJECT_FORMAT, blockSize: 1024 },
    ) as Uint8Array;
    const table = openReftable(bytes, "obj.ref");
    expect(table.verify().blocks.obj).toBeGreaterThan(0);
    expect(table.objectIdLength).toBe(3);
  });

  it("refuses ids of the other width", () => {
    const write = (format: typeof SHA1_OBJECT_FORMAT, value: string) => () =>
      writeReftable(
        {
          minUpdateIndex: 1,
          maxUpdateIndex: 1,
          refs: [{ name: "refs/heads/a", updateIndex: 1, value: { type: "id", id: value } }],
        },
        { objectFormat: format },
      );
    expect(write(SHA256_OBJECT_FORMAT, "a".repeat(40))).toThrow(ReftableWriteError);
    expect(write(SHA1_OBJECT_FORMAT, A)).toThrow(ReftableWriteError);
    expect(write(SHA1_OBJECT_FORMAT, "a".repeat(40))).not.toThrow();
  });

  it("refuses a table of another hash than the repository's (git's REFTABLE_FORMAT_ERROR)", () => {
    const sha256Table = writeReftable(
      {
        minUpdateIndex: 1,
        maxUpdateIndex: 1,
        refs: [{ name: "refs/heads/a", updateIndex: 1, value: { type: "id", id: A } }],
      },
      { objectFormat: SHA256_OBJECT_FORMAT },
    ) as Uint8Array;
    const sha1Table = writeReftable({
      minUpdateIndex: 1,
      maxUpdateIndex: 1,
      refs: [{ name: "refs/heads/a", updateIndex: 1, value: { type: "id", id: "a".repeat(40) } }],
    }) as Uint8Array;
    expect(() => openReftable(sha256Table, "x.ref", { objectFormat: SHA1_OBJECT_FORMAT })).toThrow(
      ReftableFormatError,
    );
    expect(() => openReftable(sha1Table, "x.ref", { objectFormat: SHA256_OBJECT_FORMAT })).toThrow(
      /corrupt reftable file|hash/,
    );
  });
});

describe("SHA-256 reftable stacks and ref store", () => {
  async function store() {
    const files = createInMemoryFilesApi();
    const refs = createReftableRefStore({
      files,
      gitDir: ".git",
      objectFormat: SHA256_OBJECT_FORMAT,
    });
    await refs.initialize();
    await refs.setSymbolic("HEAD", "refs/heads/main");
    return { files, refs };
  }

  it("writes and reads 32-byte refs and reflogs, null ids 64 zeros", async () => {
    const { files, refs } = await store();
    await refs.batch([{ name: "HEAD", new: A }], { ident: IDENT, message: "one" });
    await refs.batch([{ name: "refs/heads/main", old: A, new: B }], {
      ident: IDENT,
      message: "two",
    });
    await refs.set("refs/tags/v1", C);
    const main = await refs.resolve("HEAD");
    expect(main && "objectId" in main ? main.objectId : undefined).toBe(B);
    const head = await refs.getReflog("HEAD");
    expect((await head?.getReverseEntries())?.map((e) => [e.oldId, e.newId, e.comment])).toEqual([
      [A, B, "two"],
      [ZERO64, A, "one"],
    ]);
    const names = (await read(files, ".git/reftable/tables.list")).split("\n").filter(Boolean);
    for (const name of names) {
      const bytes = await readBytes(files, `.git/reftable/${name}`);
      expect(bytes[4]).toBe(2);
      expect(hex(bytes.subarray(24, 28))).toBe("73323536");
    }
    // compaction keeps the format (pack-refs: one table)
    await refs.packRefs?.([], { all: true });
    const after = (await read(files, ".git/reftable/tables.list")).split("\n").filter(Boolean);
    expect(after.length).toBe(1);
    const only = openReftable(await readBytes(files, `.git/reftable/${after[0]}`), "only.ref");
    expect(only.objectFormat.name).toBe("sha256");
    expect(only.getRef("refs/tags/v1")?.value).toEqual({ type: "id", id: C });
  });

  it("refuses 40-digit ids in a SHA-256 store", async () => {
    const { refs } = await store();
    const result = await refs.batch([{ name: "refs/heads/x", new: "a".repeat(40) }]);
    expect(result.ok).toBe(false);
    await expect(refs.set("refs/heads/y", "a".repeat(40))).rejects.toThrow();
  });

  it("a stack holding a table of the other hash is refused", async () => {
    const files = createInMemoryFilesApi();
    const sha1 = createReftableRefStore({ files, gitDir: ".git" });
    await sha1.initialize();
    await sha1.setSymbolic("HEAD", "refs/heads/main");
    const reader = createReftableStackReader(files, ".git/reftable", {
      objectFormat: SHA256_OBJECT_FORMAT,
    });
    await expect(reader.read()).rejects.toThrow(ReftableFormatError);
    const sha256 = createReftableRefStore({
      files,
      gitDir: ".git",
      objectFormat: SHA256_OBJECT_FORMAT,
    });
    await expect(sha256.get("HEAD")).rejects.toThrow(/corrupt reftable file/);
  });
});

describe("SHA-256 reftable repositories", () => {
  it("creates and reopens one (extensions.objectFormat=sha256, refStorage=reftable)", async () => {
    const files = createInMemoryFilesApi();
    const created = await createGitFilesBackend({
      files,
      create: true,
      refFormat: "reftable",
      objectFormat: SHA256_OBJECT_FORMAT,
    });
    await created.history.initialize();
    expect(await read(files, ".git/config")).toBe(
      "[extensions]\n\tobjectformat = sha256\n\trefstorage = reftable\n[core]\n\trepositoryformatversion = 1\n\tfilemode = true\n\tbare = false\n",
    );
    const blob = await created.history.blobs.store([new TextEncoder().encode("x")]);
    expect(blob).toHaveLength(64);
    const reopened = await createGitFilesBackend({ files });
    expect(reopened.history.objectFormat?.name).toBe("sha256");
    const head = await reopened.history.refs.get("HEAD");
    expect(head && "target" in head ? head.target : undefined).toBe("refs/heads/main");
  });
});
