#!/usr/bin/env node
// Incremental tests: a package is tested again only when its inputs changed since it last passed.
//
// The inputs of a package are hashed together:
//   - its own files (git blob ids, so content only; names in `ignore` are left out),
//   - the external packages it resolves to in pnpm-lock.yaml, with their whole dependency closure,
//   - the same two for every workspace package it reaches: its own dependencies (dev included),
//     packages its vitest/vite config aliases to, `links` of the config; then runtime ones only,
//   - the files of `link:`/`file:` targets that are no workspace package,
//   - the global inputs: pnpm settings of pnpm-workspace.yaml (not its catalogs), the root
//     package.json's packageManager/engines/pnpm, and from .tested/config.json the root files,
//     root dependencies, runtime versions and environment variables it lists, and itself,
//   - its test command.
//
// A package is skipped when its hash is one of those recorded in .tested/<package dir> (committed,
// written by CI only; a few recent hashes, newest first, so a revert finds its earlier pass) or in
// the local cache (node_modules/.cache/tested, written by local runs).
//
//   node scripts/tested.mjs status            which packages need testing, and why
//   node scripts/tested.mjs run [--all]       test those packages (locally: caches the passes)
//        [--no-bail]
//   node scripts/tested.mjs run --record      CI: also write .tested/<dir> for each pass
//   node scripts/tested.mjs record            CI, after a green run: write the current hashes
//   node scripts/tested.mjs hash [dir]        print the hashes
//
//   --records-unchanged-from=<commit>         fail if .tested/ records differ from that commit's
//
// --source=worktree (default outside CI) hashes the working tree, uncommitted changes included;
// --source=head (default when CI is set) hashes the HEAD commit.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const RECORDS = join(root, ".tested");
const DEFAULT_COMMAND = "pnpm run test";
const LOCAL = join(root, "node_modules/.cache/tested");

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("--")) ?? "status";
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const source = option("source", process.env.CI ? "head" : "worktree");

const config = {
  globalFiles: [],
  globalDeps: [],
  ignore: [],
  commands: {},
  links: {},
  skip: [],
  runtime: [],
  globalEnv: [],
  ...readJson(join(RECORDS, "config.json"), {}),
};

function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
}

function git(gitArgs, env) {
  return execFileSync("git", gitArgs, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function sha(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// The tree to hash: HEAD, or the working tree written to a scratch copy of the index
// (`git add -A` there honours .gitignore and reuses the index's stat cache).
function sourceTree() {
  if (source === "head") return "HEAD";
  const scratch = mkdtempSync(join(tmpdir(), "tested-"));
  try {
    const index = join(scratch, "index");
    const real = git(["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
    // Keep the index's mtime: git rechecks the entries written in its last second ("racily
    // clean"), which a fresh mtime on the copy would hide.
    if (existsSync(real)) {
      copyFileSync(real, index);
      const { atime, mtime } = statSync(real);
      utimesSync(index, atime, mtime);
    }
    git(["add", "-A"], { GIT_INDEX_FILE: index });
    return git(["write-tree"], { GIT_INDEX_FILE: index }).trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// path -> "mode blob-id" for every file of the tree.
function listFiles(tree) {
  const files = new Map();
  for (const line of git(["ls-tree", "-r", "--full-tree", tree]).split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    const [mode, , id] = line.slice(0, tab).split(" ");
    files.set(line.slice(tab + 1), `${mode} ${id}`);
  }
  return files;
}

// --- pnpm-lock.yaml (v9), read line by line: importers and snapshots are all we need.
// Dependencies stay `{ name, version }` pairs until `resolveKey` turns them into snapshot keys.

function parseLockfile(text) {
  const importers = new Map(); // dir -> [{ name, version, dev }]
  const snapshots = new Map(); // key -> [{ name, version }]
  let section = "";
  let current = null;
  let depName = null;
  let kind = "";
  const unquote = (s) => s.replace(/^'(.*)'$/, "$1");
  // `name:` or `name: {}` (an entry without dependencies).
  const entryKey = (body) => unquote(body.replace(/:( \{\})?$/, ""));
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*/, "");
      current = null;
      continue;
    }
    const indent = line.search(/\S/);
    if (indent < 0) continue;
    const body = line.trim();
    if (indent === 2) {
      current = [];
      if (section === "importers") importers.set(entryKey(body), current);
      else if (section === "snapshots") snapshots.set(entryKey(body), current);
      else current = null;
    } else if (indent === 4) {
      kind = body.replace(/:.*$/, "");
    } else if (!current || !/^(dev|optional)?[dD]ependencies$/.test(kind)) {
      // transitivePeerDependencies, dependenciesMeta, ...
    } else if (section === "importers") {
      if (indent === 6) depName = unquote(body.replace(/:$/, ""));
      else if (indent === 8 && body.startsWith("version:")) {
        const version = unquote(body.slice(8).trim());
        current.push({ name: depName, version, dev: kind === "devDependencies" });
      }
    } else if (section === "snapshots" && indent === 6) {
      const colon = body.indexOf(": ");
      current.push({
        name: unquote(body.slice(0, colon)),
        version: unquote(body.slice(colon + 2)),
      });
    }
  }
  return { importers, snapshots };
}

// A dependency `name: version` points at the snapshot `name@version` (`file:`, `git+`, tarball
// and peer-suffixed versions included); an alias (`name: other@1.0.0`) at its value.
function resolveKey({ name, version }, snapshots) {
  if (version.startsWith("link:")) return version;
  const direct = `${name}@${version}`;
  if (snapshots.has(direct) || /^\d/.test(version)) return direct;
  return snapshots.has(version) ? version : direct;
}

function closure(deps, snapshots) {
  const seen = new Set();
  const stack = deps.map((d) => resolveKey(d, snapshots));
  while (stack.length) {
    const key = stack.pop();
    if (seen.has(key) || key.startsWith("link:")) continue;
    seen.add(key);
    for (const dep of snapshots.get(key) ?? []) stack.push(resolveKey(dep, snapshots));
  }
  return [...seen].sort();
}

// The workspace-relative paths a vitest/vite config names (`"../vcs-store-mem/src"`): its
// aliases to other packages' sources.
const TEST_CONFIG = /^(vitest|vite)\.(config|workspace)\.[cm]?[jt]s$/;
function configPaths(dir, text) {
  const paths = [];
  for (const [, path] of text.matchAll(/["'`](\.\.?\/[^"'`\n]*)["'`]/g))
    paths.push(posix.normalize(posix.join(dir, path)));
  return paths;
}

// pnpm-workspace.yaml without what is no setting: its packages and catalogs (the lockfile
// carries what the catalogs resolve to, package by package).
function pnpmSettings(text) {
  const kept = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) skipping = /^(packages|catalog|catalogs):/.test(line);
    if (!skipping && line.trim() && !line.trim().startsWith("#")) kept.push(line);
  }
  return sha(kept.join("\n"));
}

// `node`: its major version; `git`: major.minor.
function runtimeVersion(name) {
  if (name === "node") return process.versions.node.split(".")[0];
  if (name === "git") return (/(\d+\.\d+)/.exec(git(["--version"])) ?? [])[1];
  throw new Error(`unknown runtime in .tested/config.json: ${name}`);
}

// --- packages and their hashes

function computeHashes() {
  const tree = sourceTree();
  const files = listFiles(tree);
  const readBlob = (path) =>
    files.has(path) ? git(["cat-file", "blob", files.get(path).split(" ")[1]]) : "";
  const lock = parseLockfile(readBlob("pnpm-lock.yaml"));

  // A package's own tests see all its dependencies; as a dependency of another package only its
  // runtime ones count, not its devDependencies nor its `links`.
  const packages = new Map();
  for (const [dir, deps] of lock.importers) {
    if (dir === ".") continue;
    const manifestText = readBlob(`${dir}/package.json`);
    if (!manifestText) continue;
    const manifest = JSON.parse(manifestText);
    const custom = config.commands[dir] ?? config.commands[manifest.name];
    const command = custom ?? (manifest.scripts?.test ? DEFAULT_COMMAND : null);
    const links = [];
    const runtimeLinks = [];
    const external = [];
    const runtimeExternal = [];
    const localPaths = []; // link:/file: targets, kept if they turn out to be no workspace package
    for (const dep of deps) {
      const local = /^(link|file):/.exec(dep.version);
      // link: is relative to the package, file: to the workspace root.
      if (local) {
        const target = dep.version.slice(5);
        localPaths.push(posix.normalize(local[1] === "link" ? posix.join(dir, target) : target));
      }
      if (dep.version.startsWith("link:")) {
        links.push(localPaths.at(-1));
        if (!dep.dev) runtimeLinks.push(localPaths.at(-1));
      } else {
        external.push(dep);
        if (!dep.dev) runtimeExternal.push(dep);
      }
    }
    // Workspace packages its tests reach without declaring them: aliases of its test config,
    // and the config's `links`.
    const testConfigs = [...files.keys()].filter(
      (f) => f.startsWith(`${dir}/`) && TEST_CONFIG.test(f.slice(dir.length + 1)),
    );
    const aliased = testConfigs.flatMap((f) => configPaths(dir, readBlob(f)));
    links.push(...(config.links[dir] ?? config.links[manifest.name] ?? []));
    const pkg = {
      dir,
      name: manifest.name,
      command,
      links,
      runtimeLinks,
      external,
      runtimeExternal,
      localPaths,
      aliased,
    };
    packages.set(dir, pkg);
  }
  // An aliased path counts when it lies in another workspace package.
  const dirsByLength = [...packages.keys()].sort((x, y) => y.length - x.length);
  const packageOf = (path) => dirsByLength.find((d) => path === d || path.startsWith(`${d}/`));
  for (const pkg of packages.values()) {
    for (const path of pkg.aliased) {
      const target = packageOf(path);
      if (target && target !== pkg.dir) pkg.links.push(target);
    }
  }

  const rootDeps = (lock.importers.get(".") ?? []).filter((d) =>
    config.globalDeps.includes(d.name),
  );
  const rootManifest = JSON.parse(readBlob("package.json") || "{}");
  const globalHash = sha(
    [
      `config ${files.get(".tested/config.json") ?? ""}`,
      `pnpm ${pnpmSettings(readBlob("pnpm-workspace.yaml"))}`,
      `root ${JSON.stringify([rootManifest.packageManager, rootManifest.engines, rootManifest.pnpm])}`,
      ...config.globalFiles.map((f) => `file ${f} ${files.get(f) ?? "missing"}`),
      ...closure(rootDeps, lock.snapshots).map((k) => `dep ${k}`),
      ...config.runtime.map((r) => `runtime ${r} ${runtimeVersion(r)}`),
      ...config.globalEnv.map((v) => `env ${v} ${process.env[v] ?? ""}`),
    ].join("\n"),
  );

  // The files of a package: those under its directory, minus nested packages and ignored names.
  const dirs = [...packages.keys()];
  const ownFiles = new Map(dirs.map((d) => [d, []]));
  for (const [path, entry] of files) {
    let owner = null;
    for (const d of dirs)
      if (path.startsWith(`${d}/`) && (!owner || d.length > owner.length)) owner = d;
    if (!owner || config.ignore.includes(posix.basename(path))) continue;
    ownFiles.get(owner).push(`${path.slice(owner.length + 1)} ${entry}`);
  }

  // link:/file: targets outside the workspace packages: their files count as the package's.
  const localFiles = (pkg) =>
    pkg.localPaths
      .filter((p) => !packages.has(p))
      .flatMap((p) =>
        [...files]
          .filter(([f]) => f === p || f.startsWith(`${p}/`))
          .map(([f, e]) => `local ${f} ${e}`),
      );
  const shallow = (pkg, external) =>
    sha(
      [
        ...ownFiles.get(pkg.dir).sort(),
        ...localFiles(pkg).sort(),
        ...closure(external, lock.snapshots).map((k) => `dep ${k}`),
      ].join("\n"),
    );
  const asDependency = new Map(
    [...packages.values()].map((pkg) => [pkg.dir, shallow(pkg, pkg.runtimeExternal)]),
  );

  const result = new Map();
  for (const pkg of packages.values()) {
    const reached = new Set();
    const stack = [...pkg.links];
    while (stack.length) {
      const d = stack.pop();
      if (reached.has(d) || d === pkg.dir || !packages.has(d)) continue;
      reached.add(d);
      stack.push(...packages.get(d).runtimeLinks);
    }
    const parts = [
      `self ${shallow(pkg, pkg.external)}`,
      ...[...reached].sort().map((d) => `ws ${d} ${asDependency.get(d)}`),
      `global ${globalHash}`,
      `command ${pkg.command}`,
    ];
    result.set(pkg.dir, { ...pkg, hash: sha(parts.join("\n")), reached: [...reached].sort() });
  }
  return result;
}

// A record holds the hashes of the last passes, newest first. Two branches recording the same
// package merge line by line (.gitattributes: merge=union); the next write trims the list.
const KEPT = 4;
const recordPath = (base, dir) => join(base, dir);
const readRecord = (base, dir) => {
  const path = recordPath(base, dir);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
};
const hasPass = (base, pkg) => readRecord(base, pkg.dir)?.includes(pkg.hash) ?? false;
function writeRecord(base, dir, hash) {
  const path = recordPath(base, dir);
  const kept = [hash, ...(readRecord(base, dir) ?? []).filter((h) => h !== hash)].slice(0, KEPT);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${kept.join("\n")}\n`);
}
const isSkipped = (pkg) => config.skip.includes(pkg.dir) || config.skip.includes(pkg.name);

function classify(pkg) {
  if (!pkg.command) return "no-tests";
  if (isSkipped(pkg)) return "skipped";
  if (flag("all")) return "forced";
  if (hasPass(RECORDS, pkg)) return "tested";
  if (hasPass(LOCAL, pkg)) return "tested-locally";
  return readRecord(RECORDS, pkg.dir) ? "changed" : "new";
}

// --- commands

// CI on a pull request from a fork: its records must be the base's, as only CI writes records
// (a fork could otherwise commit matching hashes and skip its tests).
const recordsBase = option("records-unchanged-from", "");
if (recordsBase) {
  if (!/^[0-9a-f]{7,64}$/.test(recordsBase)) throw new Error(`not a commit id: ${recordsBase}`);
  try {
    git(["cat-file", "-e", `${recordsBase}^{commit}`]);
  } catch {
    git(["fetch", "-q", "--depth=1", "origin", recordsBase]);
  }
  const changed = git([
    "diff",
    "--name-only",
    recordsBase,
    "HEAD",
    "--",
    ".tested",
    ":!.tested/config.json",
    ":!.tested/README.md",
  ]).trim();
  if (changed) {
    console.error(`a pull request from a fork may not change test records:\n${changed}`);
    process.exit(1);
  }
}

const hashes = computeHashes();

if (command === "hash") {
  const only = args.filter((a) => !a.startsWith("--"))[1];
  for (const pkg of hashes.values())
    if (!only || only === pkg.dir) console.log(`${pkg.hash}  ${pkg.dir}`);
} else if (command === "status") {
  const rows = [...hashes.values()].map((pkg) => [classify(pkg), pkg.dir]);
  for (const [state, dir] of rows.sort()) console.log(`${state.padEnd(15)} ${dir}`);
  const pending = rows.filter(([s]) => s === "changed" || s === "new" || s === "forced").length;
  console.log(`\n${pending} of ${rows.length} packages to test (source: ${source})`);
} else if (command === "record") {
  let written = 0;
  for (const pkg of hashes.values()) {
    if (!pkg.command || isSkipped(pkg) || hasPass(RECORDS, pkg)) continue;
    writeRecord(RECORDS, pkg.dir, pkg.hash);
    written++;
  }
  // Records of packages that are gone (renamed, removed, no tests any more).
  let pruned = 0;
  const testable = new Set([...hashes.values()].filter((p) => p.command).map((p) => p.dir));
  for (const file of git(["ls-files", "--", ".tested"]).split("\n").filter(Boolean)) {
    const dir = file.slice(".tested/".length);
    if (dir === "config.json" || dir === "README.md" || testable.has(dir)) continue;
    rmSync(join(root, file), { force: true });
    pruned++;
  }
  console.log(`recorded ${written} package(s), pruned ${pruned}`);
} else if (command === "run") {
  const todo = [...hashes.values()].filter((pkg) =>
    ["changed", "new", "forced"].includes(classify(pkg)),
  );
  for (const pkg of hashes.values()) {
    const state = classify(pkg);
    if (state === "tested" || state === "tested-locally")
      console.log(`skip  ${pkg.dir} (${state})`);
  }
  if (todo.length === 0) {
    console.log("nothing to test");
    process.exit(0);
  }
  console.log(`testing ${todo.length} package(s): ${todo.map((p) => p.dir).join(", ")}`);
  const passed = (pkg) => {
    writeRecord(LOCAL, pkg.dir, pkg.hash);
    if (flag("record")) writeRecord(RECORDS, pkg.dir, pkg.hash);
  };
  const failed = [];
  // Packages with the default command run through `pnpm -r`, so its ordering and concurrency
  // apply as for `pnpm test`; its summary file tells which passed.
  const viaPnpm = todo.filter((pkg) => pkg.command === DEFAULT_COMMAND);
  if (viaPnpm.length) {
    const summary = join(root, "pnpm-exec-summary.json");
    rmSync(summary, { force: true });
    spawnSync(
      "pnpm",
      [
        "-r",
        "--report-summary",
        ...(flag("no-bail") ? ["--no-bail"] : []),
        ...viaPnpm.flatMap((pkg) => ["--filter", `./${pkg.dir}`]),
        "run",
        "test",
      ],
      { cwd: root, stdio: "inherit" },
    );
    const status = readJson(summary, { executionStatus: {} }).executionStatus;
    rmSync(summary, { force: true });
    for (const pkg of viaPnpm) {
      if (status[join(root, pkg.dir)]?.status === "passed") passed(pkg);
      else failed.push(pkg.dir);
    }
  }
  for (const pkg of todo.filter((p) => p.command !== DEFAULT_COMMAND)) {
    if (failed.length && !flag("no-bail")) break;
    console.log(`\n> ${pkg.dir}: ${pkg.command}`);
    const run = spawnSync(pkg.command, { cwd: join(root, pkg.dir), stdio: "inherit", shell: true });
    if (run.status === 0) passed(pkg);
    else failed.push(pkg.dir);
  }
  if (failed.length) {
    console.error(`\nfailed or not run: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log(`\nall ${todo.length} package(s) passed`);
} else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
