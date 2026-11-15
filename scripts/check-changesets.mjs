#!/usr/bin/env node
// Fails when a changeset in .changeset/ names a package that `changeset version` will refuse:
// a private package (privatePackages.version is false, so changesets treats it as ignored and
// rejects a changeset that mixes it with public ones) or a name that is not a workspace package.
// Such a changeset passes pull-request CI but breaks the `version` job on main, which then stops
// updating the "chore: version packages" pull request. Also fails a `major` bump of a 0.x package:
// the ecosystem's convention (statewalker/statewalker-ci README) is minor for a breaking change on
// 0.x, and a `major` there publishes 1.0.0, which only the human decides (raise it on purpose by
// setting the version to 1.0.0 in the package's package.json). Run by the root `lint:check`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? process.cwd();
const workspaceDirs = ["packages", "apps/examples", "apps/demos", "apps/benchmarks"];

const packages = new Map();
const addPackage = (dir) => {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return;
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  if (pkg.name) packages.set(pkg.name, { private: pkg.private === true, version: pkg.version });
};
for (const parent of workspaceDirs) {
  const abs = join(root, parent);
  if (!existsSync(abs)) continue;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) addPackage(join(abs, entry.name));
  }
}
addPackage(join(root, "docs"));

const changesetDir = join(root, ".changeset");
const problems = [];
const files = existsSync(changesetDir)
  ? readdirSync(changesetDir).filter((f) => f.endsWith(".md") && f !== "README.md")
  : [];
for (const file of files) {
  const text = readFileSync(join(changesetDir, file), "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) continue;
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^\s*["']?([^"':]+)["']?\s*:\s*["']?(\w+)["']?\s*$/.exec(line);
    if (!entry) continue;
    const name = entry[1].trim();
    const pkg = packages.get(name);
    if (!pkg) problems.push(`${file}: ${name} is not a workspace package`);
    else if (pkg.private) problems.push(`${file}: ${name} is private and is never versioned`);
    else if (entry[2] === "major" && /^0\./.test(pkg.version ?? ""))
      problems.push(`${file}: ${name} is ${pkg.version}: a breaking change on 0.x is "minor"`);
  }
}

if (problems.length > 0) {
  console.error("Changesets the release would refuse or misversion:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`Changesets: ${files.length} checked, all name public workspace packages.`);
