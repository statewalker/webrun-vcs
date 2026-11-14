import { describe, expect, it } from "vitest";
import {
  collectTreeBytes,
  FileMode,
  InvalidObjectIdError,
  objectIdToBytes,
  serializeTree,
} from "../../../src/index.js";

const ID = "ce013625030ba8dba906f756967f9e9ca394464a";

describe("tree entries require a full object id", () => {
  const bad = [
    "ce01362", // short
    `${ID}0`, // too long, odd
    `${ID}00`, // too long, even
    "ze013625030ba8dba906f756967f9e9ca394464a", // non-hex
    ID.toUpperCase(), // ids are lowercase
  ];

  it("encodeTreeEntries throws InvalidObjectIdError", async () => {
    for (const id of bad) {
      await expect(
        collectTreeBytes([{ mode: FileMode.REGULAR_FILE, name: "a", id }]),
        id,
      ).rejects.toBeInstanceOf(InvalidObjectIdError);
    }
  });

  it("serializeTree throws InvalidObjectIdError", () => {
    for (const id of bad) {
      expect(() => serializeTree([{ mode: FileMode.REGULAR_FILE, name: "a", id }]), id).toThrow(
        InvalidObjectIdError,
      );
    }
  });

  it("objectIdToBytes converts a valid id", () => {
    const bytes = objectIdToBytes(ID);
    expect(bytes.length).toBe(20);
    expect(bytes[0]).toBe(0xce);
    expect(bytes[19]).toBe(0x4a);
  });
});
