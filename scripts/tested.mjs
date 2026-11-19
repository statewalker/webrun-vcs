#!/usr/bin/env node
// Incremental tests: a package is tested again only when its inputs changed since it last passed.
//
// The inputs of a package are hashed together:
//   - its own files (git blob ids, so content only; names in `ignore` are left out),
//   - the external packages it resolves to in pnpm-lock.yaml, with their whole dependency closure,
//   - the same two for every workspace package it reaches through `link:` dependencies,
//   - the global inputs of .tested/config.json (root files, root dependencies, the config itself),
//   - its test command.
//
// A package whose hash equals the one recorded in .tested/<package dir> (committed, written by CI
// only) or in the local cache (node_modules/.cache/tested, written by local runs) is skipped.
//
//   node scripts/tested.mjs status            which packages need testing, and why
//   node scripts/tested.mjs run [--all]       test those packages (locally: caches the passes)
//        [--no-bail]
//   node scripts/tested.mjs run --record      CI: also write .tested/<dir> for each pass
//   node scripts/tested.mjs record            CI, after a green run: write the current hashes
//   node scripts/tested.mjs hash [dir]        print the hashes
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

function parseLockfile(text) {
  const importers = new Map(); // dir -> [{ name, version, dev }]
  const snapshots = new Map(); // key -> [key of each dependency]
  let section = "";
  let current = null;
  let depName = null;
  let kind = "";
  const unquote = (s) => s.replace(/^'(.*)'$/, "$1");
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*/, "");
      current = null;
      continue;
    }
    const indent = line.search(/\S/);
    if (indent < 0) continue;
    const body = line.trim();
    if (section === "importers") {
      if (indent === 2) {
        current = [];
        importers.set(unquote(body.slice(0, -1)), current);
      } else if (indent === 4) {
        kind = body.replace(/:$/, "");
      } else if (indent === 6 && current) {
        depName = unquote(body.replace(/:$/, ""));
      } else if (
        indent === 8 &&
        body.startsWith("version:") &&
        current &&
        kind.endsWith("ependencies")
      ) {
        const version = unquote(body.slice(8).trim());
        current.push({ name: depName, version, dev: kind === "devDependencies" });
      }
    } else if (section === "snapshots") {
      if (indent === 2) {
        current = [];
        snapshots.set(unquote(body.replace(/:( \{\})?$/, "")), current);
      } else if (indent === 6 && current) {
        const colon = body.indexOf(": ");
        current.push(snapshotKey(unquote(body.slice(0, colon)), unquote(body.slice(colon + 2))));
      }
    }
  }
  return { importers, snapshots };
}

// A dependency `name: version` points at the snapshot `name@version`; an alias or a tarball
// (`name: other@1.0.0`, `name: https://...`) at the snapshot named by its value.
function snapshotKey(name, version) {
  if (version.startsWith("link:")) return version;
  return /^\d/.test(version) ? `${name}@${version}` : version;
}

function closure(keys, snapshots) {
  const seen = new Set();
  const stack = [...keys];
  while (stack.length) {
    const key = stack.pop();
    if (seen.has(key) || key.startsWith("link:")) continue;
    seen.add(key);
    for (const dep of snapshots.get(key) ?? []) stack.push(dep);
  }
  return [...seen].sort();
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
    for (const { name, version, dev } of deps) {
      if (version.startsWith("link:")) {
        const target = posix.normalize(posix.join(dir, version.slice(5)));
        links.push(target);
        if (!dev) runtimeLinks.push(target);
      } else {
        external.push(snapshotKey(name, version));
        if (!dev) runtimeExternal.push(snapshotKey(name, version));
      }
    }
    // Workspace packages its tests reach without declaring them (an alias to their sources).
    links.push(...(config.links[dir] ?? config.links[manifest.name] ?? []));
    const pkg = {
      dir,
      name: manifest.name,
      command,
      links,
      runtimeLinks,
      external,
      runtimeExternal,
    };
    packages.set(dir, pkg);
  }

  const rootDeps = (lock.importers.get(".") ?? [])
    .filter((d) => config.globalDeps.includes(d.name))
    .map((d) => snapshotKey(d.name, d.version));
  const globalHash = sha(
    [
      `config ${files.get(".tested/config.json") ?? ""}`,
      ...config.globalFiles.map((f) => `file ${f} ${files.get(f) ?? "missing"}`),
      ...closure(rootDeps, lock.snapshots).map((k) => `dep ${k}`),
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

  const shallow = (pkg, external) =>
    sha(
      [
        ...ownFiles.get(pkg.dir).sort(),
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

const recordPath = (base, dir) => join(base, dir);
const readRecord = (base, dir) => {
  const path = recordPath(base, dir);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
};
function writeRecord(base, dir, hash) {
  const path = recordPath(base, dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${hash}\n`);
}

function classify(pkg) {
  if (!pkg.command) return "no-tests";
  if (config.skip.includes(pkg.dir) || config.skip.includes(pkg.name)) return "skipped";
  if (flag("all")) return "forced";
  if (readRecord(RECORDS, pkg.dir) === pkg.hash) return "tested";
  if (readRecord(LOCAL, pkg.dir) === pkg.hash) return "tested-locally";
  return readRecord(RECORDS, pkg.dir) ? "changed" : "new";
}

// --- commands

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
    if (!pkg.command || readRecord(RECORDS, pkg.dir) === pkg.hash) continue;
    writeRecord(RECORDS, pkg.dir, pkg.hash);
    written++;
  }
  console.log(`recorded ${written} package(s)`);
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
