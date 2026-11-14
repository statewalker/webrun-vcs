import { describe, expect, it } from "vitest";
import {
  createGitObjects,
  MemoryRawStorage,
  ObjectIdMismatchError,
  rawStorageStaging,
} from "../../../src/index.js";

const enc = new TextEncoder();

async function text(s: AsyncIterable<Uint8Array>): Promise<string> {
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
