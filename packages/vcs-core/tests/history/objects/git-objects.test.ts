import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CorruptObjectError,
  createGitObjects,
  MemoryRawStorage,
  ObjectIdMismatchError,
  rawStorageStaging,
} from "../../../src/index.js";

const enc = new TextEncoder();

async function text(s: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<string> {
  let out = "";
  for await (const c of s) out += new TextDecoder().decode(c, { stream: true });
  return out;
}

// The full contract runs from the store packages (createGitObjectsTests in vcs-testing).
describe("createGitObjects over rawStorageStaging", () => {
  it("stores a blob under git's id and reads it back", async () => {
    const objects = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
    const id = await objects.put("blob", 6, [enc.encode("hello\n")]);
    expect(id).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    const obj = await objects.get(id, { verify: true });
    expect(obj).toMatchObject({ type: "blob", size: 6 });
    expect(await text(obj?.content ?? [])).toBe("hello\n");
    expect(await text(objects.getRaw(id))).toBe("blob 6\0hello\n");
  });

  it("keeps an existing object (stored: false) and refuses a raw object under a wrong id", async () => {
    const raw = new MemoryRawStorage();
    const objects = createGitObjects(rawStorageStaging(raw));
    const id = await objects.put("blob", 6, [enc.encode("hello\n")]);
    expect(await objects.put("blob", 6, [enc.encode("hello\n")])).toBe(id);
    await expect(
      objects.putRaw("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", [enc.encode("blob 6\0hello\n")]),
    ).rejects.toBeInstanceOf(ObjectIdMismatchError);
    const keys: string[] = [];
    for await (const k of raw.keys()) keys.push(k);
    expect(keys).toEqual([id]);
  });
});

describe("createGitObjects: small loose objects in one read", () => {
  async function* one(bytes: Uint8Array) {
    yield bytes;
  }
  const deflated = (raw: Uint8Array) => new Uint8Array(deflateSync(raw));
  /** a store whose loads are counted */
  function counted() {
    const raw = new MemoryRawStorage();
    let loads = 0;
    const load = raw.load.bind(raw);
    raw.load = (key, o) => {
      loads++;
      return load(key, o);
    };
    return { raw, loads: () => loads };
  }

  it("reads a small object's file once and hands out the whole content", async () => {
    const { raw, loads } = counted();
    const objects = createGitObjects(rawStorageStaging(raw));
    const data = enc.encode("tree 1\nparent 2\n\nmessage\n".repeat(10));
    const id = await objects.put("commit", data.length, [data]);
    const before = loads();
    const obj = await objects.get(id);
    expect(loads() - before).toBe(1);
    expect(obj).toMatchObject({ type: "commit", size: data.length });
    expect(new TextDecoder().decode(obj?.bytes)).toBe(new TextDecoder().decode(data));
    expect(await text(obj?.content ?? [])).toBe(new TextDecoder().decode(data));
    // a verified read streams (its end checks the id)
    expect((await objects.get(id, { verify: true }))?.bytes).toBeUndefined();
  });

  it("streams an object whose file is larger than 64 KiB", async () => {
    const objects = createGitObjects(rawStorageStaging(new MemoryRawStorage()));
    const data = new Uint8Array(200_000);
    let x = 7; // xorshift: incompressible, so the file is about as large
    for (let i = 0; i < data.length; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      data[i] = x & 255;
    }
    const id = await objects.put("blob", data.length, [data]);
    const obj = await objects.get(id);
    expect(obj?.bytes).toBeUndefined();
    let n = 0;
    for await (const c of obj?.content ?? []) n += c.length;
    expect(n).toBe(data.length);
  });

  it("reports damaged files as the streaming read does: from the content, CorruptObjectError", async () => {
    const id = "0123456789abcdef0123456789abcdef01234567";
    const cases: [string, Uint8Array][] = [
      ["bytes after the zlib stream", concat(deflated(enc.encode("blob 3\0abc")), enc.encode("x"))],
      ["a body shorter than its header", deflated(enc.encode("blob 4\0abc"))],
      ["a body longer than its header", deflated(enc.encode("blob 2\0abc"))],
      ["a truncated stream", deflated(enc.encode("blob 3\0abc")).subarray(0, 12)],
    ];
    for (const [what, bytes] of cases) {
      const raw = new MemoryRawStorage();
      await raw.store(id, one(bytes));
      const objects = createGitObjects(rawStorageStaging(raw));
      const obj = await objects.get(id);
      expect(obj?.bytes, what).toBeUndefined();
      await expect(text(obj?.content ?? []), what).rejects.toBeInstanceOf(CorruptObjectError);
    }
    // a header that cannot be read fails get() itself
    const raw = new MemoryRawStorage();
    await raw.store(id, one(deflated(enc.encode("blub 3\0abc"))));
    await expect(createGitObjects(rawStorageStaging(raw)).get(id)).rejects.toBeInstanceOf(
      CorruptObjectError,
    );
  });

  function concat(a: Uint8Array, b: Uint8Array) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }
});
