import { describe, expect, it } from "vitest";
import {
  assertSha1ObjectFormat,
  bytesToHex,
  isHexObjectId,
  isNullObjectId,
  nullObjectIdLike,
  objectFormatByHexLength,
  objectFormatByName,
  SHA1_OBJECT_FORMAT,
  SHA256_OBJECT_FORMAT,
  sha256,
  UnsupportedObjectFormatError,
} from "../../../src/hash/index.js";
import { computeObjectId, computeObjectIdFromStream } from "../../../src/pack/index.js";

const enc = new TextEncoder();

describe("object formats", () => {
  it("names git's two formats", () => {
    expect(objectFormatByName("sha1")).toBe(SHA1_OBJECT_FORMAT);
    expect(objectFormatByName("sha256")).toBe(SHA256_OBJECT_FORMAT);
    expect(objectFormatByName("SHA256")).toBeUndefined();
    expect(objectFormatByName("sha512")).toBeUndefined();
    expect(objectFormatByHexLength(64)).toBe(SHA256_OBJECT_FORMAT);
    expect(SHA256_OBJECT_FORMAT.nullId).toBe("0".repeat(64));
  });

  // git hash-object -t tree /dev/null, -t blob /dev/null in a sha256 repository
  it("computes the SHA-256 empty tree and blob ids", async () => {
    for (const f of [SHA1_OBJECT_FORMAT, SHA256_OBJECT_FORMAT]) {
      expect(await computeObjectId("tree", new Uint8Array(0), f)).toBe(f.emptyTreeId);
      expect(await computeObjectId("blob", new Uint8Array(0), f)).toBe(f.emptyBlobId);
    }
  });

  it("hashes large and streamed content alike (Web Crypto and incremental)", async () => {
    const big = new Uint8Array(200_000).map((_, i) => i * 7);
    const oneShot = await computeObjectId("blob", big, SHA256_OBJECT_FORMAT);
    const streamed = await computeObjectIdFromStream(
      "blob",
      big.length,
      [big.subarray(0, 1000), big.subarray(1000)],
      SHA256_OBJECT_FORMAT.createHasher,
    );
    expect(oneShot).toBe(streamed);
    expect(oneShot).toHaveLength(64);
  });

  it("digests with Web Crypto", async () => {
    expect(bytesToHex(await sha256(enc.encode("hello")))).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("checks ids by format", () => {
    expect(isHexObjectId(SHA1_OBJECT_FORMAT.emptyTreeId)).toBe(true);
    expect(isHexObjectId(SHA256_OBJECT_FORMAT.emptyTreeId)).toBe(true);
    expect(isHexObjectId(SHA1_OBJECT_FORMAT.emptyTreeId, SHA256_OBJECT_FORMAT)).toBe(false);
    expect(isHexObjectId("A".repeat(40))).toBe(false);
    expect(isNullObjectId("0".repeat(64))).toBe(true);
    expect(isNullObjectId("0".repeat(41))).toBe(false);
    expect(nullObjectIdLike(SHA256_OBJECT_FORMAT.emptyBlobId)).toBe("0".repeat(64));
  });

  it("refuses what has no SHA-256 path with a typed error", () => {
    expect(() => assertSha1ObjectFormat(SHA256_OBJECT_FORMAT, "pack files")).toThrow(
      UnsupportedObjectFormatError,
    );
    expect(() => assertSha1ObjectFormat(SHA1_OBJECT_FORMAT, "pack files")).not.toThrow();
  });
});
