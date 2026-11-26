import { describe, expect, it } from "vitest";
import {
  offloadedByUri,
  PackObjectsError,
  parseBlobPackfileUris,
  withPackfileUrisFeature,
} from "../../src/index.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("uploadpack.blobPackfileUri", () => {
  it("parses <object-hash> <pack-hash> <uri> as pack-objects does", () => {
    const parsed = parseBlobPackfileUris([`${A.toUpperCase()} ${B} https://cdn/p x.pack`], 40);
    expect(parsed.get(A)).toEqual({ objectId: A, packHash: B, uri: "https://cdn/p x.pack" });
  });

  it("dies on a malformed value and on an object named twice", () => {
    expect(() => parseBlobPackfileUris(["anything"], 40)).toThrow(PackObjectsError);
    expect(() => parseBlobPackfileUris([`${A} ${B}`], 40)).toThrow(
      "value of uploadpack.blobpackfileuri must be of the form '<object-hash> <pack-hash> <uri>' (got",
    );
    expect(() => parseBlobPackfileUris([`${A} ${B} http://x`, `${A} ${B} http://y`], 40)).toThrow(
      `object already configured in another uploadpack.blobpackfileuri (got '${A} ${B} http://y')`,
    );
  });

  it("offloads an object only for a protocol its URI starts with", () => {
    const entry = { objectId: A, packHash: B, uri: "https://cdn/p.pack" };
    expect(offloadedByUri(entry, ["http"])).toBe(false);
    expect(offloadedByUri(entry, ["http", "https"])).toBe(true);
  });

  it("advertises packfile-uris last in fetch=", () => {
    expect(withPackfileUrisFeature(["fetch=shallow sideband-all", "ls-refs"], true)).toEqual([
      "fetch=shallow sideband-all packfile-uris",
      "ls-refs",
    ]);
    expect(withPackfileUrisFeature(["fetch=shallow"], false)).toEqual(["fetch=shallow"]);
  });
});
