#!/usr/bin/env node
// Fails when a published package's tarball would ship test code, or would miss a file its
// manifest points consumers at (statewalker/webrun-vcs#342: vcs-core shipped
// `src/__tests__/fixtures`, vcs-transport `src/tests/unit/*.test.ts`).
//
// Each non-private package under packages/ is listed with `npm pack --dry-run --json` (no
// tarball written; npm-packlist, which the release's `pnpm pack` also uses, so the list is the
// published one: `pnpm pack --json` gives the same paths, but gzips every file, minutes for all
// packages once built), and its file list is checked:
// - no test path: a `__tests__`, `__mocks__`, `__fixtures__`, `fixtures`, `tests` or `test`
//   directory, or a `*.test.*` / `*.spec.*` / `vitest.*` file;
// - every manifest target (`main`, `module`, `types`, `typings`, `bin`, each `exports` leaf) is in
//   the list. Targets under `dist/` are checked only once the package is built (dist/ exists), so
//   the check also runs before a build (the root `lint:check`); publint and attw check the built
//   tarballs in CI.
//
// Usage: node scripts/check-pack-contents.mjs [root]   (run by the root `lint:check`)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIRS = new Set(["__tests__", "__mocks__", "__fixtures__", "fixtures", "tests", "test"]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?(\.map)?$|^vitest\.[^/]*$/;

/** The paths of `files` that are test code. */
export function testPaths(files) {
  return files.filter((path) => {
    const parts = path.split("/");
    const name = parts.pop() ?? "";
    return parts.some((part) => TEST_DIRS.has(part)) || TEST_FILE.test(name);
  });
}

/** Every file path the manifest points at (`exports` leaves, `main`, `module`, `types`, `bin`). */
export function manifestTargets(pkg) {
  const targets = new Set();
  const add = (value) => {
    if (typeof value === "string") {
      // A subpath pattern (`./*`) names no one file.
      if (!value.includes("*")) targets.add(value.replace(/^\.\//, ""));
    } else if (Array.isArray(value)) {
      value.forEach(add);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(add);
    }
  };
  for (const key of ["main", "module", "types", "typings", "bin", "exports"]) add(pkg[key]);
  return [...targets].sort();
}

/** The manifest targets missing from `files`; `dist/` targets only when `built`. */
export function missingTargets(pkg, files, { built }) {
  const listed = new Set(files);
  return manifestTargets(pkg).filter(
    (target) => (built || !target.startsWith("dist/")) && !listed.has(target),
  );
}

function packedFiles(dir) {
  const json = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(json)[0].files.map((file) => file.path);
}

function main() {
  const root = process.argv[2] ?? process.cwd();
  const packagesDir = join(root, "packages");
  const problems = [];
  let checked = 0;
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    const dir = join(packagesDir, entry.name);
    const manifest = join(dir, "package.json");
    if (!entry.isDirectory() || !existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (pkg.private === true) continue;
    checked++;
    const files = packedFiles(dir);
    for (const path of testPaths(files)) problems.push(`${pkg.name}: ships test file ${path}`);
    const built = existsSync(join(dir, "dist"));
    for (const target of missingTargets(pkg, files, { built })) {
      problems.push(`${pkg.name}: manifest target ${target} is not in the tarball`);
    }
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(
      `\n${problems.length} problem(s). Exclude test code with negations in the package's "files" ` +
        `(e.g. "!**/__tests__", "!**/*.test.*").`,
    );
    process.exit(1);
  }
  console.log(`check-pack-contents: ${checked} published package(s), no test files shipped`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
