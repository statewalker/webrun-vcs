import { describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import { fromSqlPath, toSqlPath } from "../src/sql-path.js";

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
