#!/usr/bin/env node
// Big-repository parity prototype: loads a native bare repository (git.git) into one webrun-vcs
// backend, reads it back through the History API and compares every step with native git.
//
//   node parity.mjs <backend> <work-dir> <source.git> [--steps load,refs,walk,trees,blobs,write,roundtrip]
//
// backends: sqlite (vcs-store-sql over node:sqlite, on disk), s3 (vcs-store-files over
// S3FilesApi against RustFS), fsbare (vcs-store-files over the Node FilesApi).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VCS = resolve(import.meta.dirname, "../../../..");
const dist = (pkg, entry = "index.js") =>
  import(pathToFileURL(join(VCS, "packages", pkg, "dist", entry)).href);

const [backend, workArg, sourceArg, ...rest] = process.argv.slice(2);
const stepsArg = rest[rest.indexOf("--steps") + 1];
const STEPS = (
  rest.includes("--steps") ? stepsArg : "load,refs,walk,trees,blobs,write,roundtrip"
).split(",");
const work = resolve(workArg);
const source = resolve(sourceArg);
mkdirSync(work, { recursive: true });

const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Parity",
  GIT_AUTHOR_EMAIL: "parity@example.com",
  GIT_COMMITTER_NAME: "Parity",
  GIT_COMMITTER_EMAIL: "parity@example.com",
  GIT_AUTHOR_DATE: "1764000000 +0000",
  GIT_COMMITTER_DATE: "1764000000 +0000",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};
const git = (cwd, args, input) =>
  execFileSync("git", args, { cwd, env: ENV, input, maxBuffer: 2 ** 31 }).toString();

const results = [];
const mb = () => Math.round(process.memoryUsage().rss / 1048576);
async function step(name, fn) {
  if (!STEPS.includes(name)) return;
  const t0 = performance.now();
  const s3Before = s3Requests;
  let status = "ok";
  let detail = "";
  try {
    detail = (await fn()) ?? "";
  } catch (e) {
    status = "FAIL";
    detail = `${e?.name}: ${e?.message}`.slice(0, 2000);
    if (process.env.PARITY_STACK) console.error(e);
  }
  const ms = Math.round(performance.now() - t0);
  const requests = s3Requests - s3Before;
  if (backend === "s3") detail = `${detail} [${requests} S3 requests]`;
  const row = {
    backend,
    step: name,
    status,
    ms,
    rssMB: mb(),
    detail,
    ...(backend === "s3" ? { s3Requests: requests } : {}),
  };
  results.push(row);
  console.log(
    `[${backend}] ${name.padEnd(10)} ${status.padEnd(4)} ${String(ms).padStart(8)} ms  rss ${row.rssMB} MB  ${detail}`,
  );
}
const fail = (msg) => {
  throw new Error(msg);
};

// ---------- native facts -------------------------------------------------------------------
const nativeRefs = new Map(
  git(source, ["for-each-ref", "--format=%(refname) %(objectname)"])
    .trim()
    .split("\n")
    .map((l) => l.split(" ")),
);
const peeled = git(source, [
  "for-each-ref",
  "--format=%(objectname) %(*objectname) %(objecttype) %(*objecttype)",
])
  .trim()
  .split("\n")
  .map((l) => l.split(" "));
const commitTips = [
  ...new Set(
    peeled
      .map(([o, p, t, pt]) => (t === "commit" ? o : pt === "commit" ? p : undefined))
      .filter(Boolean),
  ),
];
const headTarget = git(source, ["symbolic-ref", "HEAD"]).trim();
const tags = git(source, ["tag", "--sort=-creatordate"])
  .trim()
  .split("\n")
  .filter((t) => !t.includes("-rc"));
const SAMPLE_TAGS = [tags[0], "v2.30.0", "v1.7.0"].filter(
  (t) => t && nativeRefs.has(`refs/tags/${t}`),
);
if (!SAMPLE_TAGS.length) SAMPLE_TAGS.push("HEAD");

// ---------- backends -----------------------------------------------------------------------
async function openSqlite() {
  const { DatabaseSync } = await import("node:sqlite");
  const sql = await dist("vcs-store-sql");
  const file = join(work, "repo.sqlite");
  if (STEPS.includes("load")) rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  const conv = (ps = []) =>
    ps.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));
  let tail = Promise.resolve();
  const idle = async () => {
    for (let t = tail; ; t = tail) {
      await t;
      if (t === tail) return;
    }
  };
  const runQ = (s, p) => db.prepare(s).all(...conv(p));
  const runE = (s, p) => {
    const r = db.prepare(s).run(...conv(p));
    return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
  };
  const client = {
    query: async (s, p) => {
      await idle();
      return runQ(s, p);
    },
    execute: async (s, p) => {
      await idle();
      return runE(s, p);
    },
    async transaction(fn) {
      const prev = tail;
      let release;
      tail = new Promise((r) => (release = r));
      await prev;
      const tx = {
        query: async (s, p) => runQ(s, p),
        execute: async (s, p) => runE(s, p),
        transaction: (f) => f(tx),
        close: async () => {},
      };
      db.exec("BEGIN");
      try {
        const r = await fn(tx);
        db.exec("COMMIT");
        return r;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw e;
      } finally {
        release();
      }
    },
    close: async () => db.close(),
  };
  const history = await new sql.SQLHistoryFactory().createHistory({ db: client });
  await history.initialize();
  return { history, serialization: history.serialization, close: () => history.close() };
}

async function openFiles(files, gitDir) {
  const [{ createGitFilesBackend }, core] = await Promise.all([
    dist("vcs-store-files"),
    dist("vcs-core", "serialization/index.js"),
  ]);
  const { history } = await createGitFilesBackend({ files, gitDir });
  return { history, serialization: core.createSerializationApi(history), close: async () => {} };
}

function skeleton() {
  const skel = join(work, "skel.git");
  rmSync(skel, { recursive: true, force: true });
  git(work, ["init", "-q", "--bare", "-b", "master", skel]);
  rmSync(join(skel, "hooks"), { recursive: true, force: true });
  return skel;
}

// S3: vcs-store-files over webrun-files' S3FilesApi against RustFS (`docker run -p 9000:9000
// -e RUSTFS_ACCESS_KEY=rustfsadmin -e RUSTFS_SECRET_KEY=rustfsadmin rustfs/rustfs`); the
// repository lives under the key prefix `<work dir name>/repo.git` of bucket `vcs`.
async function openS3() {
  const { S3Client, CreateBucketCommand } = await import("@aws-sdk/client-s3");
  const { S3FilesApi } = await import("@statewalker/webrun-files-s3");
  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
    region: "us-east-1",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? "rustfsadmin",
      secretAccessKey: process.env.S3_SECRET_KEY ?? "rustfsadmin",
    },
    forcePathStyle: true,
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: "vcs" }));
  } catch {}
  const files = new S3FilesApi({
    client,
    bucket: "vcs",
    prefix: process.env.S3_PREFIX ?? basename(work),
  });
  if (STEPS.includes("load")) {
    await files.remove("repo.git");
    const skel = skeleton();
    const walk = (d) =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
      );
    for (const f of walk(skel))
      await files.write(`repo.git/${relative(skel, f)}`, [readFileSync(f)]);
  }
  // count the S3 requests each step makes
  client.middlewareStack.add(
    (next) => async (args) => {
      s3Requests++;
      return next(args);
    },
    { step: "initialize" },
  );
  return openFiles(files, "repo.git");
}
let s3Requests = 0;

async function openFsBare() {
  const nodeFiles = await dist("vcs-utils-node", "files/index.js");
  if (STEPS.includes("load")) {
    rmSync(join(work, "repo.git"), { recursive: true, force: true });
    git(work, ["init", "-q", "--bare", "-b", "master", "repo.git"]);
  }
  const files = nodeFiles.createNodeFilesApi({ rootDir: work });
  return openFiles(files, "repo.git");
}

const opener =
  { sqlite: openSqlite, s3: openS3, fsbare: openFsBare }[backend] ??
  fail(`unknown backend ${backend}`);
const { history: h, serialization: ser, close } = await opener();

// ---------- helpers ------------------------------------------------------------------------
const modeStr = (m) => (typeof m === "number" ? m.toString(8).padStart(6, "0") : String(m));
const typeOf = (m) => (m === "040000" ? "tree" : m === "160000" ? "commit" : "blob");
async function lsTree(treeId, prefix, out) {
  const entries = await h.trees.load(treeId);
  if (!entries) fail(`tree ${treeId} missing`);
  for await (const e of entries) {
    const mode = modeStr(e.mode);
    const path = prefix + e.name;
    if (mode === "040000") await lsTree(e.id, `${path}/`, out);
    else out.push(`${mode} ${typeOf(mode)} ${e.id}\t${path}`);
  }
  return out;
}
async function readAll(it) {
  const parts = [];
  for await (const c of it) parts.push(c);
  return Buffer.concat(parts);
}
const firstDiff = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i]) return `#${i}: ours=${a[i]} native=${b[i]}`;
  return "";
};

// ---------- steps --------------------------------------------------------------------------
await step("load", async () => {
  const pack = readdirSync(join(source, "objects/pack")).find((f) => f.endsWith(".pack"));
  const stream = createReadStream(join(source, "objects/pack", pack), { highWaterMark: 1 << 16 });
  const r = await ser.importPack(
    (async function* () {
      for await (const c of stream) yield new Uint8Array(c);
    })(),
    { keepPack: true },
  );
  const cmds = [...nativeRefs].map(([name, id]) => ({ type: "update", name, newValue: id }));
  let batched = false;
  try {
    const br = await h.refs.batch(cmds, {});
    batched = br?.ok !== false;
  } catch {}
  if (!batched) for (const [name, id] of nativeRefs) await h.refs.set(name, id);
  await h.refs.setSymbolic("HEAD", headTarget);
  return `objects=${r.objectsImported ?? r.objects ?? JSON.stringify(Object.keys(r))} refs=${nativeRefs.size} batched=${batched}`;
});

await step("refs", async () => {
  const ours = new Map();
  for await (const ref of h.refs.list("refs/")) {
    const id = ref.objectId ?? (await h.refs.resolve(ref.name))?.objectId;
    ours.set(ref.name, id);
  }
  const missing = [...nativeRefs].filter(([n, id]) => ours.get(n) !== id).map(([n]) => n);
  const extra = [...ours.keys()].filter(
    (n) => !nativeRefs.has(n) && n !== "refs/heads/parity-test",
  );
  const head = await h.refs.resolve("HEAD");
  if (head?.objectId !== nativeRefs.get(headTarget)) fail(`HEAD resolves to ${head?.objectId}`);
  if (missing.length || extra.length)
    fail(`mismatch missing=${missing.slice(0, 5)} extra=${extra.slice(0, 5)}`);
  return `${ours.size} refs equal`;
});

await step("walk", async () => {
  const native = git(source, ["rev-list", "--all"]).trim().split("\n");
  const ours = new Set();
  for await (const id of h.commits.walkAncestry(commitTips)) ours.add(id);
  const missing = native.filter((id) => !ours.has(id));
  if (missing.length || ours.size !== native.length)
    fail(`ours=${ours.size} native=${native.length} missing e.g. ${missing.slice(0, 3)}`);
  // parent/tree parity on a sample
  const sample = native.filter((_, i) => i % 997 === 0);
  const fmt = git(source, ["show", "-s", "--format=%H %T %P", ...sample])
    .trim()
    .split("\n");
  for (const line of fmt) {
    const [id, tree, ...parents] = line.split(" ").filter(Boolean);
    const c = await h.commits.load(id);
    if (c.tree !== tree || c.parents.join(" ") !== parents.join(" ")) fail(`commit ${id} differs`);
  }
  return `${ours.size} commits, ${sample.length} sampled headers equal`;
});

await step("trees", async () => {
  const out = [];
  for (const tag of SAMPLE_TAGS) {
    const native = git(source, ["ls-tree", "-r", `${tag}^{tree}`])
      .trim()
      .split("\n");
    const commit = git(source, ["rev-parse", `${tag}^{commit}`]).trim();
    const c = await h.commits.load(commit);
    const ours = await lsTree(c.tree, "", []);
    const d = firstDiff(ours, native);
    if (d) fail(`${tag}: ${d}`);
    out.push(`${tag}:${ours.length}`);
  }
  return out.join(" ");
});

await step("blobs", async () => {
  const tag = SAMPLE_TAGS[0];
  const lines = git(source, ["ls-tree", "-r", `${tag}^{tree}`])
    .trim()
    .split("\n");
  let bytes = 0;
  let n = 0;
  for (const line of lines) {
    const [meta] = line.split("\t");
    const [mode, type, id] = meta.split(" ");
    if (type !== "blob") continue;
    const data = await readAll(await h.blobs.load(id));
    const sha = createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
    if (sha !== id) fail(`blob ${id} (${mode}) hashes to ${sha}`);
    bytes += data.length;
    n++;
  }
  return `${tag}: ${n} blobs, ${(bytes / 1048576).toFixed(1)} MB re-hashed`;
});

// write: a commit made through the History API must get the id native git gives the same commit
await step("write", async () => {
  const base = nativeRefs.get(headTarget);
  const content = Buffer.from("parity test file\n");
  const blobId = await h.blobs.store([content]);
  const nativeBlob = git(source, ["hash-object", "--stdin"], content).trim();
  if (blobId !== nativeBlob) fail(`blob id ${blobId} != ${nativeBlob}`);
  const baseCommit = await h.commits.load(base);
  const entries = [];
  for await (const e of await h.trees.load(baseCommit.tree)) entries.push(e);
  entries.push({ mode: 0o100644, name: "PARITY.txt", id: blobId });
  const treeId = await h.trees.store(entries);
  const ident = {
    name: "Parity",
    email: "parity@example.com",
    timestamp: 1764000000,
    tzOffset: "+0000",
  };
  const commitId = await h.commits.store({
    tree: treeId,
    parents: [base],
    author: ident,
    committer: ident,
    message: "parity commit\n",
  });
  await h.refs.set("refs/heads/parity-test", commitId);
  // native: same tree and commit
  const tmpIndex = join(work, "native-index");
  rmSync(tmpIndex, { force: true });
  const env = { ...ENV, GIT_INDEX_FILE: tmpIndex };
  const g = (args, input) =>
    execFileSync("git", args, { cwd: source, env, input }).toString().trim();
  g(["read-tree", base]);
  execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: source, env, input: content });
  g(["update-index", "--add", "--cacheinfo", `100644,${nativeBlob},PARITY.txt`]);
  const nativeTree = g(["write-tree"]);
  const nativeCommit = g(["commit-tree", nativeTree, "-p", base], "parity commit\n");
  if (treeId !== nativeTree) fail(`tree ${treeId} != native ${nativeTree}`);
  if (commitId !== nativeCommit) fail(`commit ${commitId} != native ${nativeCommit}`);
  return `commit ${commitId.slice(0, 12)} equals native`;
});

// roundtrip: export every ref tip as a pack, index it with native git, fsck --strict, compare objects
await step("roundtrip", async () => {
  const wants = new Set(nativeRefs.values());
  const extra = await h.refs.resolve("refs/heads/parity-test");
  if (extra?.objectId) wants.add(extra.objectId);
  const rt = join(work, "roundtrip.git");
  rmSync(rt, { recursive: true, force: true });
  git(work, ["init", "-q", "--bare", rt]);
  const packPath = join(rt, "objects/pack/export.pack");
  const ws = createWriteStream(packPath);
  let bytes = 0;
  for await (const chunk of ser.exportPack(wants, [], { ofsDelta: true })) {
    bytes += chunk.length;
    if (!ws.write(chunk)) await new Promise((r) => ws.once("drain", r));
  }
  await new Promise((r) => ws.end(r));
  git(rt, ["index-pack", "objects/pack/export.pack"]);
  const updates = [...nativeRefs].map(([n, id]) => `update ${n} ${id}\n`).join("");
  git(
    rt,
    ["update-ref", "--stdin"],
    updates + (extra?.objectId ? `update refs/heads/parity-test ${extra.objectId}\n` : ""),
  );
  const fsck = (dir) => {
    const r = spawnSync("git", ["fsck", "--strict", "--no-dangling", "--no-progress"], {
      cwd: dir,
      env: ENV,
      maxBuffer: 2 ** 31,
    });
    return { code: r.status, lines: r.stderr.toString().split("\n").filter(Boolean).sort() };
  };
  const fr = fsck(rt);
  const fs0 = fsck(source);
  const unexpected = fr.lines.filter((l) => !fs0.lines.includes(l));
  if (unexpected.length) fail(`fsck of exported pack: ${unexpected.slice(0, 5).join(" | ")}`);
  const count = (dir) => Number(git(dir, ["rev-list", "--objects", "--all", "--count"]).trim());
  const nativeCount = count(source);
  const oursCount = count(rt);
  const packed = Number(/in-pack: (\d+)/.exec(git(rt, ["count-objects", "-v"]))[1]);
  // ours has the parity commit, its tree and blob on top of what native has (unless written to source too)
  return `pack ${(bytes / 1048576).toFixed(0)} MB, ${packed} objects; rev-list --objects: rt=${oursCount} native=${nativeCount}; fsck --strict = native's (${fr.lines.length} known warnings)`;
});

await close?.();
writeFileSync(join(work, `results-${backend}.json`), JSON.stringify(results, null, 2));
process.exit(results.some((r) => r.status !== "ok") ? 1 : 0);
