// node --test scripts/tested.test.mjs: the selection options of scripts/tested.mjs, run against
// this repository (CI's shard jobs depend on them: `status --package=... --json`, `run --exclude`).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "tested.mjs");
const COMMANDS = "packages/vcs-commands";

function tested(...args) {
  const run = spawnSync(process.execPath, [script, ...args, "--source=head"], {
    encoding: "utf8",
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}
const json = (...args) => JSON.parse(tested("status", "--json", ...args).stdout);

test("status --package --json reports that package alone", () => {
  const { pending, packages } = json(`--package=${COMMANDS}`);
  assert.equal(packages.length, 1);
  assert.equal(packages[0].dir, COMMANDS);
  assert.equal(packages[0].test, ["changed", "new", "forced"].includes(packages[0].state));
  assert.equal(pending, packages[0].test ? 1 : 0);
});

test("--all forces the package, whatever its records say", () => {
  const { pending, packages } = json(`--package=${COMMANDS}/`, "--all");
  assert.deepEqual(packages, [{ dir: COMMANDS, state: "forced", test: true }]);
  assert.equal(pending, 1);
});

test("--exclude leaves the package out and keeps the others", () => {
  const all = json().packages.map((p) => p.dir);
  const rest = json(`--exclude=${COMMANDS}`).packages.map((p) => p.dir);
  assert.ok(all.includes(COMMANDS));
  assert.deepEqual(
    rest,
    all.filter((d) => d !== COMMANDS),
  );
});

test("--exclude and --package take several values", () => {
  const two = json("--package=packages/vcs-core,packages/vcs-utils").packages.map((p) => p.dir);
  assert.deepEqual(two, ["packages/vcs-core", "packages/vcs-utils"]);
  const one = json(
    "--package=packages/vcs-core",
    "--package=packages/vcs-utils",
    "--exclude=packages/vcs-utils",
  ).packages.map((p) => p.dir);
  assert.deepEqual(one, ["packages/vcs-core"]);
});

test("run --exclude tests nothing it excludes", () => {
  // docs has no tests: with vcs-commands excluded, nothing is left to run.
  const run = tested(
    "run",
    "--package=docs",
    `--package=${COMMANDS}`,
    `--exclude=${COMMANDS}`,
    "--all",
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`skip  ${COMMANDS} \\(excluded\\)`));
  assert.match(run.stdout, /nothing to test/);
});

test("a directory that is no workspace package is refused", () => {
  const run = tested("status", "--exclude=packages/vcs-comands");
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no workspace package at packages\/vcs-comands/);
});
