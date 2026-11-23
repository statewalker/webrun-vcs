/**
 * The reftable ref store's writes over an in-memory FilesApi: one table per transaction,
 * the reference-transaction hook's states, refusals that change nothing, root and pseudo
 * refs, own reflog lines, reflog entry deletion, and stacks that stay readable (ascending
 * update indexes, geometric sizes) through many writes and compactions. Native twins are in
 * vcs-commands' `reftable-write-git3-native.test.ts`.
 */
import {
  createInMemoryFilesApi,
  RefTransactionAbortedError,
  type RefTransactionHook,
} from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";

import {
  createReftableRefStore,
  createReftableStackReader,
  openReftable,
  ReftablePartialCommitError,
  RefUpdateRejectedError,
} from "../../src/refs/index.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const IDENT = "T <t@example.com> 1700000000 +0100";
const dec = new TextDecoder();

async function read(files: ReturnType<typeof createInMemoryFilesApi>, path: string) {
  let text = "";
  for await (const chunk of files.read(path)) text += dec.decode(chunk, { stream: true });
  return text + dec.decode();
}

async function store(write: Parameters<typeof createReftableRefStore>[0]["write"] = {}) {
  const files = createInMemoryFilesApi();
  const refs = createReftableRefStore({ files, gitDir: ".git", write });
  await refs.initialize();
  await refs.setSymbolic("HEAD", "refs/heads/main");
  return { files, refs };
}

async function tableNames(files: ReturnType<typeof createInMemoryFilesApi>) {
  return (await read(files, ".git/reftable/tables.list")).split("\n").filter(Boolean);
}

describe("reftable ref store writes", () => {
  it("one table per transaction, its update index past the last, logs through HEAD", async () => {
    const { files, refs } = await store({ autoCompaction: false });
    await refs.batch([{ name: "HEAD", new: A }], {
      ident: IDENT,
      message: "commit (initial): one",
    });
    await refs.batch([{ name: "refs/heads/main", old: A, new: B }], {
      ident: IDENT,
      message: "commit: two",
    });
    const names = await tableNames(files);
    expect(names.map((n) => n.slice(0, 29))).toEqual([
      "0x000000000001-0x000000000001",
      "0x000000000002-0x000000000002",
      "0x000000000003-0x000000000003",
    ]);
    const head = await refs.getReflog("HEAD");
    expect((await head?.getReverseEntries())?.map((e) => [e.oldId, e.newId, e.comment])).toEqual([
      [A, B, "commit: two"],
      ["0".repeat(40), A, "commit (initial): one"],
    ]);
    const entry = await head?.getLastEntry();
    expect(entry?.who).toEqual({
      name: "T",
      email: "t@example.com",
      timestamp: 1700000000,
      tzOffset: "+0100",
    });
    // a no-op of HEAD's branch writes HEAD's line only, as git (`update-ref` to the same id)
    await refs.batch([{ name: "refs/heads/main", new: B }], { ident: IDENT, message: "same" });
    expect((await tableNames(files)).length).toBe(4);
    expect((await (await refs.getReflog("HEAD"))?.getLastEntry())?.comment).toBe("same");
    expect((await (await refs.getReflog("refs/heads/main"))?.getLastEntry())?.comment).toBe(
      "commit: two",
    );
    // a no-op of another ref writes nothing
    await refs.batch([{ name: "refs/heads/other", new: A }], { ident: IDENT, message: "o" });
    await refs.batch([{ name: "refs/heads/other", new: A }], { ident: IDENT, message: "o" });
    expect((await tableNames(files)).length).toBe(5);
  });

  it("refuses what git refuses, writing nothing: a mismatch, a D/F conflict, a bad name", async () => {
    const { files, refs } = await store({ autoCompaction: false });
    await refs.set("refs/heads/main", A);
    const before = await tableNames(files);
    expect(await refs.batch([{ name: "refs/heads/main", old: B, new: C }])).toEqual({
      ok: false,
      rejected: [{ name: "refs/heads/main", reason: "mismatch" }],
    });
    expect((await refs.batch([{ name: "refs/heads/main/x", new: C }])).ok).toBe(false);
    await expect(refs.set("refs/heads/a..b", A)).rejects.toBeInstanceOf(RefUpdateRejectedError);
    expect(await tableNames(files)).toEqual(before);
  });

  it("tells the hook preparing, prepared, committed; a refusal aborts with nothing written", async () => {
    const { files, refs } = await store({ autoCompaction: false });
    await refs.set("refs/heads/main", A);
    const heard: string[] = [];
    let refuse: string | undefined;
    const hook: RefTransactionHook = async (state, updates, context) => {
      for (const u of updates) {
        const name = state === "preparing" || context?.asAsked ? u.requested : u.name;
        heard.push(`${state} ${u.old ?? "-"} ${u.newTarget ?? u.new ?? "-"} ${name}`);
      }
      return state !== refuse;
    };
    refs.setTransactionHook(hook);
    await refs.batch([{ name: "HEAD", old: A, new: B }]);
    expect(heard).toEqual([
      `preparing ${A} ${B} HEAD`,
      `prepared ${A} ${B} refs/heads/main`,
      `committed ${A} ${B} refs/heads/main`,
    ]);
    heard.length = 0;
    refuse = "prepared";
    const before = await tableNames(files);
    await expect(refs.batch([{ name: "refs/heads/main", new: C }])).rejects.toBeInstanceOf(
      RefTransactionAbortedError,
    );
    expect(heard).toEqual([
      `preparing - ${C} refs/heads/main`,
      `prepared - ${C} refs/heads/main`,
      `aborted - ${C} refs/heads/main`,
    ]);
    expect(await tableNames(files)).toEqual(before);
    expect(await files.exists(".git/reftable/tables.list.lock")).toBe(false);
    expect((await refs.resolve("refs/heads/main"))?.objectId).toBe(B);
    heard.length = 0;
    refuse = undefined;
    await refs.setSymbolic("refs/heads/sym", "refs/heads/main");
    expect(heard).toEqual([
      "preparing - refs/heads/main refs/heads/sym",
      "prepared - refs/heads/main refs/heads/sym",
      "committed - refs/heads/main refs/heads/sym",
    ]);
  });

  it("root refs live in the stack, FETCH_HEAD and MERGE_HEAD in files", async () => {
    const { files, refs } = await store();
    await refs.set("ORIG_HEAD", A);
    await refs.set("FETCH_HEAD", B);
    expect((await refs.get("ORIG_HEAD")) && (await refs.resolve("ORIG_HEAD"))?.objectId).toBe(A);
    expect(await files.exists(".git/ORIG_HEAD")).toBe(false);
    expect(await read(files, ".git/FETCH_HEAD")).toBe(`${B}\n`);
    expect(await refs.remove("ORIG_HEAD")).toBe(true);
    expect(await refs.get("ORIG_HEAD")).toBeUndefined();
    expect(await refs.remove("FETCH_HEAD")).toBe(true);
    expect(await refs.remove("refs/heads/none")).toBe(false);
  });

  it("own reflog lines take update indexes of their own, oldest first", async () => {
    const { refs } = await store();
    await refs.batch(
      [
        {
          name: "refs/remotes/new/main",
          old: null,
          new: B,
          reflog: [
            { oldId: "0".repeat(40), newId: A, ident: IDENT, message: "first" },
            { oldId: A, newId: B, ident: IDENT, message: "second" },
          ],
        },
      ],
      { ident: IDENT },
    );
    const log = await refs.getReflog("refs/remotes/new/main");
    expect((await log?.getReverseEntries())?.map((e) => e.comment)).toEqual(["second", "first"]);
  });

  it("deletes reflog entries as git's reftable backend expires them", async () => {
    const { refs } = await store();
    await refs.batch([{ name: "refs/stash", new: A }], {
      ident: IDENT,
      message: "one",
      createReflog: true,
    });
    await refs.batch([{ name: "refs/stash", new: B }], { ident: IDENT, message: "two" });
    await refs.batch([{ name: "refs/stash", new: C }], { ident: IDENT, message: "three" });
    const kept = await refs.deleteReflogEntry("refs/stash", 0, { rewrite: true, updateRef: true });
    expect(kept).toBe(2);
    expect((await refs.resolve("refs/stash"))?.objectId).toBe(B);
    const entries = await (await refs.getReflog("refs/stash"))?.getReverseEntries();
    expect(entries?.map((e) => [e.oldId, e.newId, e.comment])).toEqual([
      [A, B, "two"],
      ["0".repeat(40), A, "one"],
    ]);
    await refs.deleteReflogEntry("refs/stash", 0, { rewrite: true });
    await refs.deleteReflogEntry("refs/stash", 0, { rewrite: true });
    // an existence marker keeps the (empty) reflog
    expect(await (await refs.getReflog("refs/stash"))?.getReverseEntries()).toEqual([]);
    await expect(refs.deleteReflogEntry("refs/stash", 0)).rejects.toThrow(/does not exist/);
  });

  it("many writes stay a short, geometric stack whose tables the reader accepts", async () => {
    const { files, refs } = await store();
    for (let i = 0; i < 200; i++) {
      await refs.set(`refs/heads/b${i}`, i % 2 ? A : B, { ident: IDENT, message: `m${i}` });
    }
    const names = await tableNames(files);
    expect(names.length).toBeLessThan(10);
    const view = await createReftableStackReader(files, ".git/reftable").read();
    let last = 0;
    for (const t of view.parts) {
      expect(t.minUpdateIndex).toBeGreaterThan(last);
      last = t.maxUpdateIndex;
      t.verify();
    }
    expect(last).toBe(201);
    await refs.packRefs([], { all: true });
    const [only] = await tableNames(files);
    const chunks: Uint8Array[] = [];
    for await (const c of files.read(`.git/reftable/${only}`)) chunks.push(c);
    const table = openReftable(Buffer.concat(chunks), only);
    expect(table.verify().blocks.ref).toBeGreaterThan(0);
    let count = 0;
    for await (const _ of refs.list("refs/heads/")) count++;
    expect(count).toBe(200);
    expect((await (await refs.getReflog("refs/heads/b7"))?.getLastEntry())?.comment).toBe("m7");
  });

  it("a clean running while a compaction writes never deletes the compacted table (C2)", async () => {
    const base = createInMemoryFilesApi();
    const other = createReftableRefStore({
      files: base,
      gitDir: ".git",
      write: { autoCompaction: false },
    });
    // a FilesApi whose next take of tables.list.lock after the compaction released it first
    // lets another writer clean the stack (git's reftable_stack_clean, or ours)
    let takes = 0;
    let armed = false;
    const files = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "createExclusive") {
          return async (path: string, content: Uint8Array[]) => {
            if (armed && path.endsWith("reftable/tables.list.lock") && ++takes === 2) {
              await other.cleanStack();
            }
            return (
              target.createExclusive as (p: string, c: Uint8Array[]) => Promise<boolean>
            ).call(target, path, content);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const refs = createReftableRefStore({
      files,
      gitDir: ".git",
      write: { autoCompaction: false },
    });
    await refs.initialize();
    await refs.setSymbolic("HEAD", "refs/heads/main");
    for (let i = 0; i < 3; i++) await refs.set(`refs/heads/b${i}`, A);
    armed = true;
    await refs.packRefs([], { all: true });
    expect(takes).toBeGreaterThanOrEqual(2);
    const [only, ...rest] = await tableNames(base);
    expect(rest).toEqual([]);
    expect(await base.exists(`.git/reftable/${only}`)).toBe(true);
    for (let i = 0; i < 3; i++) expect((await refs.resolve(`refs/heads/b${i}`))?.objectId).toBe(A);
  });

  it("a transaction over two stacks whose commit fails releases every lock and says so (H1)", async () => {
    for (const failing of ["worktrees/wt/reftable/tables.list", ".git/reftable/tables.list"]) {
      const base = createInMemoryFilesApi();
      const main = createReftableRefStore({ files: base, gitDir: ".git" });
      await main.initialize();
      await main.setSymbolic("HEAD", "refs/heads/main");
      await main.set("refs/heads/main", A);
      let fail = false;
      const files = new Proxy(base, {
        get(target, prop, receiver) {
          if (prop === "move") {
            return async (from: string, to: string) => {
              if (fail && to.endsWith(failing) && !to.endsWith(`worktrees/wt/${failing}`)) {
                throw new Error("injected");
              }
              return target.move(from, to);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const wt = createReftableRefStore({ files, gitDir: ".git/worktrees/wt", commonDir: ".git" });
      await wt.setSymbolic("HEAD", "refs/heads/main");
      fail = true;
      // HEAD (the worktree's stack, committed first as git does) and its branch (the
      // repository's stack)
      const attempt = wt.batch([{ name: "HEAD", old: A, new: B }], { message: "x" });
      if (failing.startsWith("worktrees")) {
        await expect(attempt).rejects.toThrow("injected");
        expect((await main.resolve("refs/heads/main"))?.objectId).toBe(A);
      } else {
        // the worktree's stack has the update, the repository's not: said, not hidden
        await expect(attempt).rejects.toBeInstanceOf(ReftablePartialCommitError);
      }
      fail = false;
      for (const lock of [
        ".git/reftable/tables.list.lock",
        ".git/worktrees/wt/reftable/tables.list.lock",
      ]) {
        expect(await base.exists(lock)).toBe(false);
      }
      expect((await wt.batch([{ name: "HEAD", new: C }], { message: "y" })).ok).toBe(true);
      expect((await main.resolve("refs/heads/main"))?.objectId).toBe(C);
    }
  });
});
