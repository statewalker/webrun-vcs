import {
  createGitObject,
  createInMemoryFilesApi,
  type FilesApi,
  PackObjectType,
  StreamingPackWriter,
  writePackIndexV2,
} from "@statewalker/vcs-core";
import { beforeEach, describe, expect, it } from "vitest";
import { PackDirectory } from "../../../src/pack/index.js";
import { PackDirectoryAdapter } from "../../../src/storage/raw/pack-directory-adapter.js";

async function collectBytes(iter: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iter) chunks.push(chunk);
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("PackDirectoryAdapter", () => {
  let files: FilesApi;
  let packDir: PackDirectory;
  let adapter: PackDirectoryAdapter;
  let blobId: string;
  let blobContent: Uint8Array;

  beforeEach(async () => {
    files = createInMemoryFilesApi();
    await files.mkdir("/objects/pack");

    // Create a pack file with one blob object
    blobContent = enc.encode("hello pack world");

    // Build the Git object to get its ID
    const gitObject = createGitObject("blob", blobContent);
    const { sha1 } = await import("@statewalker/vcs-utils/hash");
    const { bytesToHex } = await import("@statewalker/vcs-utils/hash/utils");
    blobId = bytesToHex(await sha1(gitObject));

    // Create a pack with this blob
    const writer = new StreamingPackWriter(1);
    const packChunks: Uint8Array[] = [];
    for await (const chunk of writer.addObject(blobId, PackObjectType.BLOB, blobContent)) {
      packChunks.push(chunk);
    }
    for await (const chunk of writer.finalize()) {
      packChunks.push(chunk);
    }

    const packData = await collectBytes(
      (async function* () {
        for (const c of packChunks) yield c;
      })(),
    );

    // Build index
    const packChecksum = packData.subarray(packData.length - 20);
    const indexData = await writePackIndexV2(writer.getIndexEntries(), packChecksum);

    // Add pack to pack directory
    packDir = new PackDirectory({ files, basePath: "/objects/pack" });
    await packDir.addPack("pack-test", packData, indexData);
    await packDir.scan();

    adapter = new PackDirectoryAdapter(packDir);
  });

  it("load() returns Git object with headers", async () => {
    const data = await collectBytes(adapter.load(blobId));
    const str = dec.decode(data);

    // Should have header "blob <size>\0" followed by content
    expect(str).toContain("blob ");
    expect(str).toContain("\0");
    expect(str).toContain("hello pack world");
  });

  it("load() throws for missing key", async () => {
    await expect(async () => {
      for await (const _ of adapter.load("0".repeat(40))) {
        // consume
      }
    }).rejects.toThrow("Key not found");
  });

  it("has() returns true for packed objects", async () => {
    expect(await adapter.has(blobId)).toBe(true);
  });

  it("has() returns false for missing objects", async () => {
    expect(await adapter.has("0".repeat(40))).toBe(false);
  });

  it("keys() lists all packed objects", async () => {
    const keys: string[] = [];
    for await (const key of adapter.keys()) keys.push(key);
    expect(keys).toContain(blobId);
    expect(keys).toHaveLength(1);
  });

  it("store() throws read-only error", async () => {
    await expect(
      adapter.store(
        "key",
        (async function* () {
          yield enc.encode("data");
        })(),
      ),
    ).rejects.toThrow("read-only");
  });

  it("remove() returns false", async () => {
    expect(await adapter.remove(blobId)).toBe(false);
  });

  it("size() returns object size for packed objects", async () => {
    const size = await adapter.size(blobId);
    expect(size).toBeGreaterThan(0);
  });

  it("size() returns -1 for missing objects", async () => {
    expect(await adapter.size("0".repeat(40))).toBe(-1);
  });
});
