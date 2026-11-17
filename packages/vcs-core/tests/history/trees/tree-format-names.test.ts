import { describe, expect, it } from "vitest";
import { decodeTreeEntries, objectIdToBytes } from "../../../src/index.js";

const ID = "ce013625030ba8dba906f756967f9e9ca394464a";

/** Raw tree bytes for one entry, bypassing the encoder's name checks (as a fetched object would). */
function rawTree(name: string, mode = "100644"): Uint8Array {
  const head = new TextEncoder().encode(`${mode} ${name}\0`);
  const id = objectIdToBytes(ID);
  const out = new Uint8Array(head.length + id.length);
  out.set(head);
  out.set(id, head.length);
  return out;
}

async function decodeAll(bytes: Uint8Array) {
  const entries = [];
  for await (const entry of decodeTreeEntries([bytes])) entries.push(entry);
  return entries;
}

describe("decodeTreeEntries refuses names that would leave the tree's directory", () => {
  // A fetched tree is untrusted. Its names become worktree paths at checkout, and
  // webrun-files 0.12 resolves `..` itself, so `sub/../.git/config` would land in .git.
  for (const name of ["..", ".", "", "a/../b", "../x"]) {
    it(`throws on ${JSON.stringify(name)}`, async () => {
      await expect(decodeAll(rawTree(name, "40000"))).rejects.toThrow(/Tree entry name/);
    });
  }

  it("still decodes ordinary names, dotfiles included", async () => {
    expect((await decodeAll(rawTree(".gitignore")))[0]).toMatchObject({
      name: ".gitignore",
      id: ID,
    });
    expect((await decodeAll(rawTree("..hidden")))[0]).toMatchObject({ name: "..hidden" });
  });
});

describe("serializeTree refuses names that stand for no bytes", () => {
  it("throws on a lone surrogate decodeGitPath never makes, keeps its escapes", async () => {
    const { serializeTree } = await import("../../../src/index.js");
    const entry = (name: string) => ({ mode: 0o100644, name, id: ID });
    // "\udcc3\udca9" would encode to C3 A9, the bytes of "é": two entries of one name
    for (const name of ["\udcc3\udca9", "\ud800", "a\udc00"]) {
      expect(() => serializeTree([entry(name)])).toThrow(/lone surrogate/);
    }
    // a decoded latin-1 byte (U+DC00 + 0xE9) is its byte
    const bytes = serializeTree([entry("caf\udce9")]);
    expect(bytes.subarray(7, 11)).toEqual(new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
  });
});
