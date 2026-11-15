/**
 * Reflog edge cases of the git-files ref store: a log line that cannot be written fails
 * the update before the commit (as git's files backend), deleteReflogEntry numbers the
 * entries the reader lists (lines with a broken ident are no entry), a ref without a log
 * leaves no directories behind, and the ref itself is locked before the log-only refs.
 */
import { createInMemoryFilesApi, type FilesApi, readFile } from "@statewalker/vcs-core";
import { type AtomicFiles, atomicFilesOver } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";
import { createRefsStructure, FileRefStore } from "../../src/refs/index.js";

const oid = (n: number) => n.toString(16).padStart(40, "a");
const IDENT = "A U Thor <author@example.com> 1700000000 +0000";

async function setup(wrap: (base: AtomicFiles) => AtomicFiles = (b) => b) {
  const files: FilesApi = createInMemoryFilesApi();
  await files.mkdir("/.git");
  await createRefsStructure(files, "/.git");
  const atomicFiles = wrap(atomicFilesOver(files, "/.git"));
  const refs = new FileRefStore(files, "/.git", { atomicFiles });
  const text = async (path: string) =>
    (await files.exists(`/.git/${path}`))
      ? new TextDecoder().decode(await readFile(files, `/.git/${path}`))
      : undefined;
  return { files, refs, text };
}

const failingAppend =
  (path: string) =>
  (base: AtomicFiles): AtomicFiles => ({
    ...base,
    append: async (p, content) => {
      if (p === path) throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
      return base.append(p, content);
    },
  });

describe("reflog writes of the git-files ref store", () => {
  it("a log line that cannot be written fails a single-ref update; the ref keeps its value", async () => {
    const { refs, text } = await setup(failingAppend("logs/refs/stash"));
    await expect(
      refs.batch([{ name: "refs/stash", new: oid(1) }], {
        ident: IDENT,
        message: "On main: s1",
        createReflog: true,
      }),
    ).rejects.toThrow("ENOSPC");
    expect(await refs.get("refs/stash")).toBeUndefined();
    expect(await text("refs/stash.lock")).toBeUndefined();
  });

  it("a log line that cannot be written fails a multi-ref batch before its commit", async () => {
    const { refs } = await setup(failingAppend("logs/refs/heads/b"));
    await refs.batch([{ name: "refs/heads/a", new: oid(1) }]);
    await expect(
      refs.batch([
        { name: "refs/heads/a", old: oid(1), new: oid(2) },
        { name: "refs/heads/b", new: oid(3) },
      ]),
    ).rejects.toThrow("ENOSPC");
    expect((await refs.resolve("refs/heads/a"))?.objectId).toBe(oid(1));
    expect(await refs.get("refs/heads/b")).toBeUndefined();
    // the locks are gone: the next batch goes through
    expect((await refs.batch([{ name: "refs/heads/a", old: oid(1), new: oid(4) }])).ok).toBe(true);
  });

  it("deleteReflogEntry counts the entries the reader lists; broken lines are dropped", async () => {
    const { refs, files, text } = await setup();
    for (const n of [1, 2, 3, 4]) {
      await refs.batch([{ name: "refs/stash", new: oid(n) }], {
        ident: IDENT,
        message: `On main: s${n}`,
        createReflog: true,
      });
    }
    // break the ident of stash@{1} (the third line): git and our reader skip it
    const lines = ((await text("logs/refs/stash")) ?? "").split("\n");
    lines[2] = (lines[2] ?? "").replace(IDENT, "garbage");
    await files.write("/.git/logs/refs/stash", [new TextEncoder().encode(lines.join("\n"))]);
    const log = await refs.getReflog("refs/stash");
    expect((await log?.getReverseEntries())?.map((e) => e.newId)).toEqual([oid(4), oid(2), oid(1)]);
    expect((await log?.getReverseEntry(1))?.newId).toBe(oid(2));

    // stash@{1} is what the reader lists as stash@{1}: oid(2); the broken line goes too
    expect(await refs.deleteReflogEntry("refs/stash", 1, { rewrite: true })).toBe(2);
    const after = await refs.getReflog("refs/stash");
    expect((await after?.getReverseEntries())?.map((e) => e.newId)).toEqual([oid(4), oid(1)]);
    expect(((await text("logs/refs/stash")) ?? "").includes("garbage")).toBe(false);
  });

  it("deleteReflogEntry of a ref without a log leaves no directories behind", async () => {
    const { refs, files } = await setup();
    await expect(refs.deleteReflogEntry("refs/heads/topic/none", 0)).rejects.toMatchObject({
      name: "ReflogEntryNotFoundError",
    });
    expect(await files.exists("/.git/logs")).toBe(false);
    expect(await files.exists("/.git/refs/heads/topic")).toBe(false);
  });

  it("an update through HEAD locks the ref first, then HEAD (as git)", async () => {
    const order: string[] = [];
    const { refs } = await setup((base) => ({
      ...base,
      createExclusive: async (path, content) => {
        order.push(path);
        return base.createExclusive(path, content);
      },
    }));
    await refs.setSymbolic("HEAD", "refs/heads/main");
    order.length = 0;
    expect((await refs.batch([{ name: "HEAD", new: oid(1) }], { ident: IDENT })).ok).toBe(true);
    expect(order).toEqual(["refs/heads/main.lock", "HEAD.lock"]);
  });
});
