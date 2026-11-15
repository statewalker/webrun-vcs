/**
 * git's `shallow` file through `FileRefStore.getShallow`/`setShallow`: written under
 * `shallow.lock`, removed when empty, and a writer that read an older version is refused
 * (git's check_shallow_file_for_update) instead of overwriting a concurrent change.
 */
import { createInMemoryFilesApi } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";
import { createRefsStructure, FileRefStore } from "../src/refs/index.js";

const oid = (n: number) => n.toString(16).padStart(40, "0");

async function store() {
  const files = createInMemoryFilesApi();
  await files.mkdir("/.git");
  await createRefsStructure(files, "/.git");
  return { files, refs: new FileRefStore(files, "/.git") };
}

async function text(files: ReturnType<typeof createInMemoryFilesApi>, path: string) {
  let out = "";
  const decoder = new TextDecoder();
  for await (const chunk of files.read(path)) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

describe("FileRefStore shallow file", () => {
  it("writes git's shallow file sorted, one id per line, and removes it when empty", async () => {
    const { files, refs } = await store();
    expect(await refs.getShallow()).toEqual([]);
    await refs.setShallow([oid(2), oid(1)]);
    expect(await text(files, "/.git/shallow")).toBe(`${oid(1)}\n${oid(2)}\n`);
    expect(await refs.getShallow()).toEqual([oid(1), oid(2)]);
    await refs.setShallow([]);
    expect(await files.exists("/.git/shallow")).toBe(false);
    expect(await files.exists("/.git/shallow.lock")).toBe(false);
  });

  it("refuses to replace a shallow file that changed since the writer read it", async () => {
    const { refs } = await store();
    await refs.setShallow([oid(1)]);
    const seen = await refs.getShallow();
    // another fetch moves the boundary meanwhile
    await refs.setShallow([oid(2)], seen);
    await expect(refs.setShallow([oid(3)], seen)).rejects.toThrow(/shallow file has changed/);
    expect(await refs.getShallow()).toEqual([oid(2)]);
  });

  it("refuses while another writer holds shallow.lock", async () => {
    const { files, refs } = await store();
    await files.write("/.git/shallow.lock", [new TextEncoder().encode("x")]);
    await expect(refs.setShallow([oid(1)])).rejects.toThrow(/shallow\.lock/);
  });
});
