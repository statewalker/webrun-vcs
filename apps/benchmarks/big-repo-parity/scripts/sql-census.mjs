#!/usr/bin/env node
// Which objects of a repository the native SQL stores (vcs-store-sql) can hold byte for byte.
//
//   node sql-census.mjs <source.git> [--types commit,tag,tree] [--limit N]
//
// Every commit, tag and tree of the source goes through the SQL backend's `importObject` one at a
// time (in-memory node:sqlite databases); the id it returns must be the object's id, and the
// object read back (`exportObject`) must be the original bytes. Objects that come back changed are
// classified by what differs and listed with an example each.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const VCS = resolve(import.meta.dirname, "../../../..");
const dist = (pkg, entry = "index.js") =>
  import(pathToFileURL(join(VCS, "packages", pkg, "dist", entry)).href);
const args = process.argv.slice(2);
const source = resolve(args[0]);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const TYPES = new Set(opt("--types", "commit,tag,tree").split(","));
const LIMIT = Number(opt("--limit", "Infinity"));

// ---- SQL backend over node:sqlite (in memory) -------------------------------------------------
const sql = await dist("vcs-store-sql");
// a fresh database every RESET objects: each object is checked on its own, and one database
// holding every tree of git.git (millions of tree_entry rows) does not fit in memory
const RESET = 20000;
let db;
let ser;
async function openDb() {
  db?.close();
  db = new DatabaseSync(":memory:");
  const conv = (ps = []) =>
    ps.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));
  const runQ = (s, p) => db.prepare(s).all(...conv(p));
  const runE = (s, p) => {
    const r = db.prepare(s).run(...conv(p));
    return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
  };
  const client = {
    query: async (s, p) => runQ(s, p),
    execute: async (s, p) => runE(s, p),
    async transaction(fn) {
      db.exec("BEGIN");
      try {
        const r = await fn(client);
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    close: async () => {},
  };
  const history = await new sql.SQLHistoryFactory().createHistory({ db: client });
  await history.initialize();
  ser = history.serialization;
}
await openDb();

// ---- the objects, streamed from git cat-file --batch -----------------------------------------
async function* objects() {
  const list = spawn(
    "git",
    ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
    {
      cwd: source,
    },
  );
  const ids = [];
  let rest = "";
  for await (const chunk of list.stdout) {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop();
    for (const l of lines) {
      const [id, type] = l.split(" ");
      if (TYPES.has(type)) ids.push(id);
    }
  }
  const batch = spawn("git", ["cat-file", "--batch"], { cwd: source });
  batch.stdin.end(`${ids.slice(0, LIMIT).join("\n")}\n`);
  let buf = Buffer.alloc(0);
  for await (const chunk of batch.stdout) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const nl = buf.indexOf(10);
      if (nl < 0) break;
      const [id, type, size] = buf.subarray(0, nl).toString().split(" ");
      const n = Number(size);
      if (buf.length < nl + 1 + n + 1) break;
      yield { id, type, data: buf.subarray(nl + 1, nl + 1 + n) };
      buf = buf.subarray(nl + 1 + n + 1);
    }
  }
}

// ---- classification of a changed object -------------------------------------------------------
const isUtf8 = (b) => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
};
const headerOf = (b) => {
  const end = b.indexOf("\n\n");
  return (end < 0 ? b : b.subarray(0, end)).toString("latin1");
};
function classify(type, orig, back) {
  const why = [];
  if (type === "tree") {
    const modes = new Set();
    for (let i = 0; i < orig.length; ) {
      const sp = orig.indexOf(32, i);
      const mode = orig.subarray(i, sp).toString();
      if (!["100644", "100755", "40000", "120000", "160000"].includes(mode)) modes.add(mode);
      i = orig.indexOf(0, sp) + 21;
    }
    if (modes.size) why.push(`tree: non-canonical mode ${[...modes].join(",")}`);
    return why.length ? why : ["tree: other"];
  }
  const h = headerOf(orig);
  const keys = h
    .split("\n")
    .filter((l) => !l.startsWith(" "))
    .map((l) => l.split(" ")[0]);
  const known =
    type === "commit"
      ? ["tree", "parent", "author", "committer"]
      : ["object", "type", "tag", "tagger"];
  const extra = [...new Set(keys.filter((k) => !known.includes(k)))];
  if (extra.length) why.push(`${type}: extra header ${extra.join(",")}`);
  if (!isUtf8(orig)) why.push(`${type}: not UTF-8`);
  if (type === "tag" && !keys.includes("tagger")) why.push("tag: no tagger");
  const identLines = h.split("\n").filter((l) => /^(author|committer|tagger) /.test(l));
  for (const l of identLines) {
    if (!/^\S+ [^<>\n]*<[^<>\n]*> \d+ [+-]\d{4}$/.test(l)) why.push(`${type}: unusual ident line`);
  }
  const body = orig.subarray(orig.indexOf("\n\n") + 2);
  if (orig.indexOf("\n\n") < 0) why.push(`${type}: no message separator`);
  else if (body.length && body[body.length - 1] !== 10)
    why.push(`${type}: message without final newline`);
  if (body.includes(0)) why.push(`${type}: NUL in message`);
  if (!why.length) {
    // name the first differing line
    const a = orig.toString("latin1").split("\n");
    const b = back.toString("latin1").split("\n");
    let i = 0;
    while (a[i] === b[i] && i < a.length) i++;
    why.push(
      `${type}: other (line ${i + 1}: ${JSON.stringify(a[i])?.slice(0, 80)} -> ${JSON.stringify(b[i])?.slice(0, 80)})`,
    );
  }
  return why;
}

// ---- run ----------------------------------------------------------------------------------------
const counts = {};
const bad = new Map(); // reason -> { n, example }
const errors = new Map();
const t0 = performance.now();
let n = 0;
const gitId = (type, data) =>
  createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex");
for await (const { id, type, data } of objects()) {
  n++;
  counts[type] = (counts[type] ?? 0) + 1;
  if (n % RESET === 0) {
    await openDb();
    console.error(`${n} objects, ${Math.round(performance.now() - t0)} ms`);
  }
  let back;
  let storedId;
  try {
    storedId = await ser.importObject(type, [data], data.length);
    const out = await ser.exportObject(storedId);
    const parts = [];
    for await (const c of out.content) parts.push(c);
    back = Buffer.concat(parts);
  } catch (e) {
    const key = `${type}: ${e.name}: ${String(e.message)
      .replace(/[0-9a-f]{40}/g, "<id>")
      .slice(0, 120)}`;
    const entry = errors.get(key) ?? { n: 0, example: id };
    entry.n++;
    errors.set(key, entry);
    continue;
  }
  if (storedId === id && back.equals(data)) continue;
  const reasons =
    storedId === id ? [`${type}: same id, different bytes read back`] : classify(type, data, back);
  if (gitId(type, back) !== storedId)
    reasons.push(`${type}: read-back bytes do not hash to the stored id`);
  for (const r of reasons) {
    const entry = bad.get(r) ?? { n: 0, example: id };
    entry.n++;
    bad.set(r, entry);
  }
  counts[`${type} changed`] = (counts[`${type} changed`] ?? 0) + 1;
}
const report = {
  source,
  seconds: Math.round((performance.now() - t0) / 1000),
  counts,
  changed: Object.fromEntries([...bad].sort((a, b) => b[1].n - a[1].n)),
  errors: Object.fromEntries(errors),
};
console.log(JSON.stringify(report, null, 2));
