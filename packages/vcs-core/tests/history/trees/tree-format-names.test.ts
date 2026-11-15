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
