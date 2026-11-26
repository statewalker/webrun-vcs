import { createInMemoryFilesApi } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";
import {
  encodeFsmonitorExtension,
  FsmonitorState,
  parseFsmonitorExtension,
} from "../../src/staging/fsmonitor.js";
import { IndexFile } from "../../src/staging/index-file.js";
import { parseIndexFile } from "../../src/staging/index-format.js";
import type { StagingEntry } from "../../src/staging/types.js";

const ID = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const entry = (path: string, mtime = 1000, mode = 0o100644): StagingEntry => ({
  path,
  mode,
  objectId: ID,
  stage: 0,
  size: 0,
  mtime,
});

describe("FSMN extension", () => {
  it("encodes git's version 2 layout and reads it back", () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const state = FsmonitorState.fromExtension({ token: "tok", dirty: [1], bitSize: 2 }, entries);
    const bytes = encodeFsmonitorExtension(state, entries);
    // version 2, "tok\0", the bitmap's size, then an EWAH bitmap with bit 1 set
    expect(Array.from(bytes.subarray(0, 8))).toEqual([0, 0, 0, 2, 0x74, 0x6f, 0x6b, 0]);
    expect(parseFsmonitorExtension(bytes, entries.length)).toEqual({
      token: "tok",
      dirty: [1],
      bitSize: 2,
    });
  });

  it("reads version 1 (a nanosecond time) and refuses what git refuses", () => {
    const v1 = new Uint8Array([
      0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0x30, 0x39, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(parseFsmonitorExtension(v1, 3)?.token).toBe("12345");
    expect(parseFsmonitorExtension(new Uint8Array([0, 0, 0, 3, 0, 0, 0, 0, 0]), 3)).toBeUndefined();
    expect(parseFsmonitorExtension(new Uint8Array([0, 0, 0, 2, 0x74]), 3)).toBeUndefined();
    // a bitmap naming more entries than the index has (git's BUG): ignored
    const entries = [entry("a"), entry("b"), entry("c")];
    const state = new FsmonitorState("t");
    const bytes = encodeFsmonitorExtension(state, entries);
    expect(parseFsmonitorExtension(bytes, 2)).toBeUndefined();
  });

  it("holds a bit only for the entry exactly as it was marked; gitlinks are never valid", () => {
    const state = new FsmonitorState("t");
    const a = entry("a");
    state.markValid(a);
    expect(state.changed).toBe(true);
    expect(state.isValid(a)).toBe(true);
    expect(state.isValid({ ...a })).toBe(true);
    expect(state.isValid({ ...a, mtime: 1001 })).toBe(false);
    expect(state.isValid({ ...a, size: 1 })).toBe(false);
    const link = entry("sub", 1000, 0o160000);
    state.markValid(link);
    expect(state.isValid(link)).toBe(false);
  });

  it("IndexFile writes the state with the index and reads it back; a changed entry is dirty", async () => {
    const files = createInMemoryFilesApi();
    const file = new IndexFile(files, ".git/index");
    await file.read();
    const entries = [entry("a"), entry("b")];
    const state = new FsmonitorState("token-1");
    file.setFsmonitor(state);
    state.markValid(entries[0] as StagingEntry);
    state.markValid(entries[1] as StagingEntry);
    expect(await file.wantsRewrite()).toBe(true); // git's FSMONITOR_CHANGED
    await file.write(entries);
    expect(state.changed).toBe(false);

    const again = new IndexFile(files, ".git/index");
    const read = await again.read();
    const back = again.getFsmonitor();
    expect(back?.token).toBe("token-1");
    expect(back?.isValid(read?.entries[0] as StagingEntry)).toBe(true);
    // an entry changed in memory is written dirty
    const changed = [{ ...(read?.entries[0] as StagingEntry), mtime: 2000 }, read?.entries[1]];
    await again.write(changed as StagingEntry[]);
    const bytes = (await files.read(".git/index")) as unknown as AsyncIterable<Uint8Array>;
    const chunks: Uint8Array[] = [];
    for await (const c of bytes) chunks.push(c);
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.length;
    }
    const parsed = await parseIndexFile(all);
    const ext = parsed.extensionData.find((e) => e.signature === "FSMN");
    expect(parseFsmonitorExtension(ext?.data as Uint8Array, 2)?.dirty).toEqual([0]);

    // removed: the index wants a rewrite, and the next write carries none
    again.setFsmonitor(undefined);
    expect(await again.wantsRewrite()).toBe(true);
    await again.write(changed as StagingEntry[]);
    const third = new IndexFile(files, ".git/index");
    await third.read();
    expect(third.getFsmonitor()).toBeUndefined();
  });
});
