#!/usr/bin/env node
// Porcelain benchmark against native git, on the built bundles (`dist/`, never tsx: its
// keepNames wrapping skews hot closures). Builds two repositories with native git in a work
// directory, then times each operation in a fresh Node process per run (the time printed
// excludes module loading, which is reported apart) and the same operation by native git,
// printing the median of the runs.
//
//   node scripts/bench-porcelain.mjs <work-dir> [--files 40000] [--commits 3000] [--runs 5]
//                                    [--only status,log-p] [--keep]
//
// `wide`: <files> small files in two directory levels, one commit, packed (status, commit -a).
// `history`: <commits> commits over 200 files of 40 to 400 lines, a few hunks each, packed with
// deltas (log -p, log --stat). The work directory is removed afterwards unless --keep is given.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (pkg, entry) => pathToFileURL(join(ROOT, "packages", pkg, "dist", entry)).href;

const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Bench",
  GIT_AUTHOR_EMAIL: "bench@example.com",
  GIT_COMMITTER_NAME: "Bench",
  GIT_COMMITTER_EMAIL: "bench@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};

const git = (cwd, args, input) =>
  execFileSync("git", args, { cwd, env: ENV, input, maxBuffer: 1 << 30 });

/** mulberry32 */
function rng(seed) {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

function buildWide(dir, files) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  const perDir = 200;
  for (let i = 0; i < files; i++) {
    const sub = join(
      dir,
      `d${String(Math.floor(i / perDir / 20)).padStart(3, "0")}`,
      `s${Math.floor(i / perDir) % 20}`,
    );
    if (i % perDir === 0) mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, `f${i}.txt`), `file ${i}\n`);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "wide"]);
  git(dir, ["gc", "-q", "--prune=now"]);
  // a second status settles the index (racily clean entries), as a long-lived checkout has
  git(dir, ["status", "--porcelain"]);
}

function buildHistory(dir, commits) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  const r = rng(42);
  const files = [];
  for (let f = 0; f < 200; f++) {
    const lines = [];
    const n = 40 + r(360);
    for (let l = 0; l < n; l++) lines.push(`line ${l} of file ${f}: ${"word ".repeat(1 + r(8))}`);
    files.push(lines);
  }
  const chunks = [];
  const blob = (lines) => {
    const data = Buffer.from(`${lines.join("\n")}\n`);
    return `data ${data.length}\n${data.toString("latin1")}\n`;
  };
  for (let c = 0; c < commits; c++) {
    const touched = new Set();
    const count = c === 0 ? files.length : 1 + r(4);
    while (touched.size < count) touched.add(c === 0 ? touched.size : r(files.length));
    for (const f of touched) {
      const lines = files[f];
      if (c > 0) {
        for (let h = 0, hunks = 1 + r(3); h < hunks; h++) {
          const at = r(lines.length);
          const op = r(3);
          if (op === 0) lines.splice(at, 1);
          else if (op === 1) lines.splice(at, 0, `added in ${c}: ${"text ".repeat(1 + r(6))}`);
          else lines[at] = `changed in ${c}: ${"edit ".repeat(1 + r(6))}`;
        }
      }
    }
    const message = `commit ${c}\n`;
    chunks.push(
      `commit refs/heads/main\ncommitter Bench <bench@example.com> ${1700000000 + c * 60} +0000\n`,
      `data ${message.length}\n${message}`,
    );
    for (const f of touched)
      chunks.push(`M 100644 inline src/d${f % 10}/file${f}.txt\n${blob(files[f])}`);
    chunks.push("\n");
  }
  git(dir, ["fast-import", "--quiet"], Buffer.from(chunks.join(""), "latin1"));
  git(dir, ["repack", "-adq"]);
  git(dir, ["prune-packed"]);
  git(dir, ["checkout", "-q", "-f", "main"]);
}

// ---- one run, in a child process --------------------------------------------------------

async function child(op, repo) {
  const t0 = performance.now();
  const [{ Git }, { createGitFilesBackend, openGitLinkedWorktrees }, nodeFiles] = await Promise.all(
    [
      import(dist("vcs-commands", "index.js")),
      import(dist("vcs-store-files", "index.js")),
      import(dist("vcs-utils-node", "files/index.js")),
    ],
  );
  const t1 = performance.now();
  const files = nodeFiles.createNodeFilesApi({ rootDir: repo });
  const environment = nodeFiles.createNodeGitHostEnvironment({ env: ENV });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  const g = Git.fromWorkingCopy(await worktrees.openCurrent());
  let bytes = 0;
  if (op === "status") {
    const s = await g.status().call();
    bytes = s.modified?.size ?? 0;
  } else if (op === "commit-a") {
    await g.commit().setAll(true).setMessage("bench").call();
  } else if (op.startsWith("log")) {
    const log = g.log();
    const options = {};
    if (op === "log-stat") options.stat = true;
    else options.patch = true;
    if (op === "log-p-200") log.setMaxCount(200);
    bytes = (await log.callBytes(options)).length;
  }
  const t2 = performance.now();
  process.stdout.write(JSON.stringify({ load: t1 - t0, op: t2 - t1, bytes }));
}

// ---- driver -----------------------------------------------------------------------------

const OPS = {
  status: { repo: "wide", native: ["status", "--porcelain"] },
  "status-1": { repo: "wide", native: ["status", "--porcelain"], ours: "status", change: 1 },
  "commit-a": { repo: "wide", native: ["commit", "-qam", "bench"], change: 3 },
  "log-p-200": { repo: "history", native: ["log", "-p", "-n", "200"] },
  "log-p": { repo: "history", native: ["log", "-p"] },
  "log-stat": { repo: "history", native: ["log", "--stat"] },
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--child") return child(argv[1], argv[2]);
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const work = argv[0] && !argv[0].startsWith("--") ? resolve(argv[0]) : undefined;
  if (!work) throw new Error("usage: bench-porcelain.mjs <work-dir> [options]");
  const runs = Number(opt("runs", "5"));
  const only = opt("only", Object.keys(OPS).join(",")).split(",");
  const repos = { wide: join(work, "wide"), history: join(work, "history") };
  const need = new Set(only.map((o) => OPS[o].repo));
  if (need.has("wide") && !existsSync(repos.wide))
    buildWide(repos.wide, Number(opt("files", "40000")));
  if (need.has("history") && !existsSync(repos.history))
    buildHistory(repos.history, Number(opt("commits", "3000")));
  const devNull = openSync("/dev/null", "w");
  let edit = 0;
  const change = (repo, n) => {
    for (let k = 0; k < n; k++) {
      edit++;
      writeFileSync(join(repo, "d000", `s${k}`, `f${k * 200}.txt`), `edit ${edit}\n`);
    }
  };
  const rows = [];
  for (const name of only) {
    const spec = OPS[name];
    const repo = repos[spec.repo];
    const ours = [];
    const loads = [];
    const native = [];
    for (let i = 0; i < runs; i++) {
      if (spec.change) change(repo, spec.change);
      const r = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "--child", spec.ours ?? name, repo],
        {
          env: ENV,
          maxBuffer: 1 << 26,
        },
      );
      if (r.status !== 0) throw new Error(`${name}: ${r.stderr}`);
      const out = JSON.parse(r.stdout.toString());
      ours.push(out.op);
      loads.push(out.load);
      if (spec.change) change(repo, spec.change);
      const t = performance.now();
      const n = spawnSync("git", spec.native, {
        cwd: repo,
        env: ENV,
        stdio: ["ignore", devNull, "pipe"],
      });
      native.push(performance.now() - t);
      if (n.status !== 0) throw new Error(`git ${spec.native.join(" ")}: ${n.stderr}`);
    }
    if (spec.change === 1) git(repo, ["reset", "-q", "--hard"]);
    rows.push({ name, ours: median(ours), native: median(native), load: median(loads) });
  }
  console.log(
    `runs: ${runs} (median), node ${process.version}, ${git(ROOT, ["--version"]).toString().trim()}`,
  );
  console.log("operation    |   ours ms | native ms |  ratio | module load ms");
  for (const r of rows)
    console.log(
      `${r.name.padEnd(12)} | ${r.ours.toFixed(0).padStart(9)} | ${r.native.toFixed(0).padStart(9)} | ${(r.ours / r.native).toFixed(2).padStart(6)} | ${r.load.toFixed(0).padStart(6)}`,
    );
  if (!argv.includes("--keep")) rmSync(work, { recursive: true, force: true });
}

await main();
