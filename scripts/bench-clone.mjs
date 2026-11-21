#!/usr/bin/env node
// Clone benchmark against native git, on the built bundles (`dist/`, never tsx: its keepNames
// wrapping skews hot closures). Builds a bare repository with native git (fast-import, then a
// full repack with deltas) in a work directory, then times each stage of a full clone in a
// fresh Node process per run and the same stage by native git, printing the median of the runs.
//
//   node scripts/bench-clone.mjs <work-dir> [--commits 20000] [--runs 3]
//                                [--only export,import,checkout,clone] [--keep]
//
// `export`: our upload-pack side, the pack of every ref (`exportPack`, stored entries reused);
// native `git pack-objects --all --stdout` (without bitmaps, as every native stage here).
// `import`: the native export's pack installed into an empty bare repository (`importPack` with `keepPack`
// and `onContent`, as a clone runs it); native `git index-pack --stdin`.
// `checkout`: a clone with no checkout, then `reset --hard` writing every file (git's checkout
// after `clone --no-checkout` populates the worktree, ours writes nothing there yet).
// `clone`: `clone().setLocal(false)` end to end; native `git clone --no-local`.
// Pass `--prof <dir>` to write one `--cpu-prof` profile per stage instead of timing.
// The work directory is removed afterwards unless --keep is given.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * A bare repository of `commits` commits over 2000 files in three directory levels, each
 * commit editing a few files (so a few trees per level), fully packed with deltas.
 */
function buildSource(dir, commits) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "--bare", "-b", "main"]);
  const r = rng(7);
  const files = [];
  for (let f = 0; f < 2000; f++) {
    const lines = [];
    const n = 10 + r(120);
    for (let l = 0; l < n; l++) lines.push(`line ${l} of ${f}: ${"word ".repeat(1 + r(8))}`);
    files.push(lines);
  }
  const path = (f) => `src/m${f % 8}/d${f % 40}/file${f}.txt`;
  const blob = (lines) => {
    const data = Buffer.from(`${lines.join("\n")}\n`);
    return `data ${data.length}\n${data.toString("latin1")}\n`;
  };
  const step = 2000;
  for (let from = 0; from < commits; from += step) {
    const chunks = [];
    for (let c = from; c < Math.min(commits, from + step); c++) {
      const touched = new Set();
      const count = c === 0 ? files.length : 1 + r(3);
      while (touched.size < count) touched.add(c === 0 ? touched.size : r(files.length));
      for (const f of touched) {
        const lines = files[f];
        if (c > 0) {
          const at = r(lines.length);
          if (r(2)) lines.splice(at, 0, `added in ${c}: ${"text ".repeat(1 + r(6))}`);
          else lines[at] = `changed in ${c}: ${"edit ".repeat(1 + r(6))}`;
        }
      }
      const message = `commit ${c}\n`;
      chunks.push(
        `commit refs/heads/main\ncommitter Bench <bench@example.com> ${1700000000 + c * 60} +0000\n`,
        `data ${message.length}\n${message}`,
      );
      if (c > 0 && c === from) chunks.push(`from refs/heads/main^0\n`);
      for (const f of touched) chunks.push(`M 100644 inline ${path(f)}\n${blob(files[f])}`);
      chunks.push("\n");
      if (c % 5000 === 4999) chunks.push(`tag v${c}\nfrom refs/heads/main\ndata 4\ntag\n`);
    }
    git(dir, ["fast-import", "--quiet"], Buffer.from(chunks.join(""), "latin1"));
  }
  git(dir, ["repack", "-adq"]);
  git(dir, ["prune-packed"]);
  const count = git(dir, ["count-objects", "-v"]).toString();
  return Number(/in-pack: (\d+)/.exec(count)?.[1]);
}

// ---- one run, in a child process --------------------------------------------------------

async function openRepo(repo, gitDir) {
  const [{ createGitFilesBackend }, core, nodeFiles] = await Promise.all([
    import(dist("vcs-store-files", "index.js")),
    import(dist("vcs-core", "serialization/index.js")),
    import(dist("vcs-utils-node", "files/index.js")),
  ]);
  const files = nodeFiles.createNodeFilesApi({ rootDir: repo });
  const { history } = await createGitFilesBackend({ files, gitDir });
  return { history, serialization: core.createSerializationApi(history), nodeFiles };
}

async function child(op, work) {
  const t0 = performance.now();
  let bytes = 0;
  if (op === "export") {
    const { history, serialization } = await openRepo(join(work, "src.git"), ".");
    const wants = new Set();
    for await (const ref of history.refs.list()) {
      const id = ref.objectId ?? (await history.refs.resolve(ref.name))?.objectId;
      if (id) wants.add(id);
    }
    const chunks = [];
    for await (const chunk of serialization.exportPack(wants, [], { ofsDelta: true })) {
      chunks.push(chunk);
      bytes += chunk.length;
    }
    writeFileSync(join(work, "ours.pack"), Buffer.concat(chunks));
  } else if (op === "import") {
    const dest = join(work, "imp.git");
    rmSync(dest, { recursive: true, force: true });
    git(work, ["init", "-q", "--bare", dest]);
    const { serialization } = await openRepo(dest, ".");
    const { createReadStream } = await import("node:fs");
    const stream = createReadStream(join(work, "native.pack"), { highWaterMark: 1 << 16 });
    const result = await serialization.importPack(
      (async function* () {
        for await (const chunk of stream) yield new Uint8Array(chunk);
      })(),
      { keepPack: true, onContent: () => {} },
    );
    bytes = result.objectsImported ?? result.objects ?? 0;
  } else if (op === "checkout" || op === "clone") {
    const dest = join(work, "dest");
    rmSync(dest, { recursive: true, force: true });
    git(work, ["init", "-q", "-b", "main", dest]);
    const [{ Git, ResetMode }, { createGitFilesBackend, openGitLinkedWorktrees }, nodeFiles] =
      await Promise.all([
        import(dist("vcs-commands", "index.js")),
        import(dist("vcs-store-files", "index.js")),
        import(dist("vcs-utils-node", "files/index.js")),
      ]);
    const files = nodeFiles.createNodeFilesApi({ rootDir: work });
    const environment = nodeFiles.createNodeGitHostEnvironment({ env: ENV });
    const { history } = await createGitFilesBackend({ files, gitDir: "dest/.git" });
    const worktrees = await openGitLinkedWorktrees({
      files,
      gitDir: "dest/.git",
      history,
      environment,
    });
    const g = Git.fromWorkingCopy(await worktrees.openCurrent());
    if (op === "checkout") {
      // a clone without checkout first, timed apart from the checkout
      await g.clone().setURI(join(work, "src.git")).setLocal(false).setNoCheckout(true).call();
      const t = performance.now();
      await g.reset().setMode(ResetMode.HARD).setRef("HEAD").call();
      process.stdout.write(JSON.stringify({ op: performance.now() - t, bytes }));
      return;
    }
    await g.clone().setURI(join(work, "src.git")).setLocal(false).call();
  }
  process.stdout.write(JSON.stringify({ op: performance.now() - t0, bytes }));
}

// ---- driver -----------------------------------------------------------------------------

// Native git without reachability bitmaps, which we do not write or read: with them (a bare
// repository's `repack -a` writes one) pack-objects sends the existing pack almost verbatim.
const NO_BITMAPS = ["-c", "pack.useBitmaps=false"];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function timeNative(op, work) {
  if (op === "export") {
    const t = performance.now();
    const r = spawnSync(
      "git",
      [...NO_BITMAPS, "pack-objects", "--all", "--stdout", "-q", "--delta-base-offset"],
      {
        cwd: join(work, "src.git"),
        env: ENV,
        input: "",
        maxBuffer: 1 << 30,
      },
    );
    const ms = performance.now() - t;
    writeFileSync(join(work, "native.pack"), r.stdout);
    return ms;
  }
  if (op === "import") {
    const dest = join(work, "nimp.git");
    rmSync(dest, { recursive: true, force: true });
    git(work, ["init", "-q", "--bare", dest]);
    const t = performance.now();
    execFileSync("sh", ["-c", `git index-pack --stdin --keep < ${join(work, "native.pack")}`], {
      cwd: dest,
      env: ENV,
    });
    return performance.now() - t;
  }
  if (op === "checkout") {
    const dest = join(work, "ndest");
    rmSync(dest, { recursive: true, force: true });
    git(work, ["clone", "-q", "--no-local", "--no-checkout", join(work, "src.git"), dest]);
    const t = performance.now();
    git(dest, ["reset", "-q", "--hard", "HEAD"]);
    return performance.now() - t;
  }
  rmSync(join(work, "ndest"), { recursive: true, force: true });
  const t = performance.now();
  git(work, [
    ...NO_BITMAPS,
    "clone",
    "-q",
    "--no-local",
    join(work, "src.git"),
    join(work, "ndest"),
  ]);
  return performance.now() - t;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--child") return child(argv[1], argv[2]);
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const work = argv[0] && !argv[0].startsWith("--") ? resolve(argv[0]) : undefined;
  if (!work) throw new Error("usage: bench-clone.mjs <work-dir> [options]");
  const runs = Number(opt("runs", "3"));
  const only = opt("only", "export,import,checkout,clone").split(",");
  const prof = opt("prof", undefined);
  if (!existsSync(join(work, "src.git"))) {
    const t = performance.now();
    const n = buildSource(join(work, "src.git"), Number(opt("commits", "20000")));
    console.log(`source: ${n} objects, built in ${((performance.now() - t) / 1000).toFixed(1)} s`);
  }
  // the import stage reads native.pack, written by the native export
  if (!existsSync(join(work, "native.pack"))) timeNative("export", work);
  const rows = [];
  for (const op of only) {
    const ours = [];
    const native = [];
    for (let i = 0; i < (prof ? 1 : runs); i++) {
      const flags = prof ? ["--cpu-prof", "--cpu-prof-dir", resolve(prof)] : [];
      const r = spawnSync(
        process.execPath,
        [
          ...flags,
          "--max-old-space-size=4096",
          fileURLToPath(import.meta.url),
          "--child",
          op,
          work,
        ],
        { env: ENV, maxBuffer: 1 << 26 },
      );
      if (r.status !== 0) throw new Error(`${op}: ${r.stderr}`);
      ours.push(JSON.parse(r.stdout.toString()).op);
      if (!prof) native.push(timeNative(op, work));
    }
    rows.push({ op, ours: median(ours), native: prof ? Number.NaN : median(native) });
    console.log(
      `${op.padEnd(9)} ours ${(median(ours) / 1000).toFixed(2).padStart(7)} s   native ${(
        median(native.length ? native : [Number.NaN]) / 1000
      )
        .toFixed(2)
        .padStart(7)} s`,
    );
  }
  if (!argv.includes("--keep")) rmSync(work, { recursive: true, force: true });
  return rows;
}

await main();
