/**
 * ObjectIdFlags: flag bits per object id, asked by hex string or by the raw bytes of an id
 * inside a tree, with growth past the initial table and strings that are not ids.
 */
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { describe, expect, it } from "vitest";
import { ObjectIdFlags } from "../../src/pack/object-id-flags.js";

/** A deterministic 20-byte id: the SHA-1 of `n`. */
function idBytes(n: number): Uint8Array {
  return createSha1()
    .update(new TextEncoder().encode(String(n)))
    .digest();
}

describe("ObjectIdFlags", () => {
  it("keeps the bits set on an id, by hex or by raw bytes", () => {
    const flags = new ObjectIdFlags();
    const id = idBytes(1);
    const hex = bytesToHex(id);
    expect(flags.get(hex)).toBe(0);
    flags.add(hex, 1);
    flags.addAt(id, 0, 4);
    expect(flags.get(hex)).toBe(5);
    // the id found inside a larger buffer (a tree entry)
    const tree = new Uint8Array(30);
    tree.set(id, 7);
    expect(flags.getAt(tree, 7)).toBe(5);
    expect(flags.getAt(tree, 6)).toBe(0);
    expect(flags.size).toBe(1);
  });

  it("grows past its initial table without losing an id", () => {
    const flags = new ObjectIdFlags(4);
    for (let n = 0; n < 5000; n++) flags.addAt(idBytes(n), 0, (n % 7) + 1);
    expect(flags.size).toBe(5000);
    for (let n = 0; n < 5000; n++) expect(flags.get(bytesToHex(idBytes(n)))).toBe((n % 7) + 1);
    expect(flags.get(bytesToHex(idBytes(5000)))).toBe(0);
  });

  it("keeps strings that are not lowercase ids apart, as they are", () => {
    const flags = new ObjectIdFlags();
    const hex = bytesToHex(idBytes(2));
    flags.add(hex.toUpperCase(), 2);
    flags.add("not an id", 8);
    expect(flags.get(hex)).toBe(0);
    expect(flags.get(hex.toUpperCase())).toBe(2);
    expect(flags.get("not an id")).toBe(8);
    expect(flags.size).toBe(2);
  });
});
