import { describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import { initializeSchema } from "../src/migrations/index.js";
import { createSqlNativeStores } from "../src/native/index.js";
import { fromSqlPath, toSqlPath } from "../src/sql-path.js";
import { SQLStaging } from "../src/staging-store.js";

describe("toSqlPath / fromSqlPath", () => {
  it("keeps UTF-8 paths as they are", () => {
    for (const path of ["a.txt", "dir/café.txt", "文件.txt", "emoji-😀.txt", ""]) {
      expect(toSqlPath(path)).toBe(path);
      expect(fromSqlPath(path)).toBe(path);
    }
  });

  it("escapes lone surrogates and the escape character reversibly", () => {
    const paths = ["caf\udce9.txt", "\udcff/\udc80", "a\u0001b", "\u0001dce9", "x\u0001\udce9"];
    for (const path of paths) {
      const stored = toSqlPath(path);
      expect(stored).not.toMatch(/[\uD800-\uDFFF]/);
      expect(fromSqlPath(stored)).toBe(path);
    }
    expect(toSqlPath("caf\udce9.txt")).toBe("caf\u0001dce9.txt");
    // a prefix stays a prefix, so LIKE 'dir/%' finds the paths under a directory
    expect(toSqlPath("d\udce9/x").startsWith(toSqlPath("d\udce9/"))).toBe(true);
  });

  it("keeps a U+0001 it did not write", () => {
    expect(fromSqlPath("a\u0001zz")).toBe("a\u0001zz");
  });

  it("round-trips through sql.js, which turns a raw lone surrogate into U+FFFD", async () => {
    const db = await SqlJsAdapter.create();
    await db.execute("CREATE TABLE t (name TEXT)");
    const path = "caf\udce9.txt";
    await db.execute("INSERT INTO t VALUES (?)", [path]);
    await db.execute("INSERT INTO t VALUES (?)", [toSqlPath(path)]);
    const rows = await db.query<{ name: string }>("SELECT name FROM t ORDER BY rowid");
    expect(rows[0].name).not.toBe(path);
    expect(fromSqlPath(rows[1].name)).toBe(path);
    await db.close();
  });
});

describe("path queries take paths literally, case-sensitive and in byte order", () => {
  const BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

  it("listEntriesUnder: no LIKE case folding or wildcards, escaped paths included", async () => {
    const db = await SqlJsAdapter.create();
    await initializeSchema(db);
    const staging = new SQLStaging(db);
    const paths = [
      "src",
      "src/a.txt",
      "src/sub/b.txt",
      "SRC/upper.txt",
      "Src/mixed.txt",
      "srcx/no.txt",
      "src0",
      "a_b/in.txt",
      "aXb/not.txt",
      "p%/in.txt",
      "pzz/not.txt",
      "d\udce9/in.txt",
      "d\udce9x/not.txt",
      "d\u0001/not.txt",
    ];
    for (const path of paths) await staging.setEntry({ path, mode: 0o100644, objectId: BLOB });
    const under = async (prefix: string) => {
      const out: string[] = [];
      for await (const entry of staging.listEntriesUnder(prefix)) out.push(entry.path);
      return out;
    };
    expect(await under("src")).toEqual(["src", "src/a.txt", "src/sub/b.txt"]);
    expect(await under("src/")).toEqual(["src/a.txt", "src/sub/b.txt"]);
    expect(await under("a_b")).toEqual(["a_b/in.txt"]);
    expect(await under("p%")).toEqual(["p%/in.txt"]);
    expect(await under("d\udce9")).toEqual(["d\udce9/in.txt"]);
    expect(await under("SRC")).toEqual(["SRC/upper.txt"]);
    await db.close();
  });

  it("searchMessage takes % and _ literally", async () => {
    const db = await SqlJsAdapter.create();
    await initializeSchema(db);
    const { commits } = createSqlNativeStores(db);
    const person = { name: "A", email: "a@example.com", timestamp: 1700000000, tzOffset: "+0000" };
    const commit = (message: string) =>
      commits.store({
        tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        parents: [],
        author: person,
        committer: person,
        message,
      });
    const withUnderscore = await commit("fix a_b parsing");
    await commit("fix aXb parsing");
    const withPercent = await commit("raise to 100% coverage");
    await commit("raise to 1000 coverage");
    const search = async (text: string) => {
      const out: string[] = [];
      for await (const id of commits.searchMessage(text)) out.push(id);
      return out;
    };
    expect(await search("a_b")).toEqual([withUnderscore]);
    expect(await search("100%")).toEqual([withPercent]);
    await db.close();
  });

  it("findByNamePattern returns names in git's byte order, escaped ones included", async () => {
    const db = await SqlJsAdapter.create();
    await initializeSchema(db);
    const { trees } = createSqlNativeStores(db);
    const names = ["caf\udce9", "caf\u00e9", "cafz"];
    const treeId = await trees.store(names.map((name) => ({ mode: 0o100644, name, id: BLOB })));
    const found: string[] = [];
    for await (const result of trees.findByNamePattern("caf%")) {
      expect(result.treeId).toBe(treeId);
      found.push(result.entry.name);
    }
    // bytes: "cafz" (7a) < "caf\u00e9" (c3 a9) < "caf\xe9" (e9); the stored escape sorts first
    expect(found).toEqual(["cafz", "caf\u00e9", "caf\udce9"]);
    await db.close();
  });
});
