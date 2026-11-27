import assert from "node:assert/strict";
import { test } from "node:test";
import { manifestTargets, missingTargets, testPaths } from "./check-pack-contents.mjs";

test("testPaths finds test directories and test files", () => {
  const files = [
    "package.json",
    "src/index.ts",
    "src/__tests__/fixtures/index.ts",
    "src/tests/unit/fsm.test.ts",
    "src/fixtures/a.ts",
    "src/test/b.ts",
    "dist/x.spec.js",
    "dist/x.test.js.map",
    "src/vitest.setup.ts",
    "src/testing/helpers.ts",
    "src/contest.ts",
    "src/latest-test.ts",
  ];
  assert.deepEqual(testPaths(files), [
    "src/__tests__/fixtures/index.ts",
    "src/tests/unit/fsm.test.ts",
    "src/fixtures/a.ts",
    "src/test/b.ts",
    "dist/x.spec.js",
    "dist/x.test.js.map",
    "src/vitest.setup.ts",
  ]);
});

test("manifestTargets collects exports leaves, main, types and bin", () => {
  const pkg = {
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    bin: { tool: "./dist/cli.js" },
    exports: {
      ".": { source: "./src/index.ts", types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./files": { import: ["./dist/files/index.js"] },
      "./*": "./dist/*.js",
      "./package.json": "./package.json",
    },
  };
  assert.deepEqual(manifestTargets(pkg), [
    "dist/cli.js",
    "dist/files/index.js",
    "dist/index.d.ts",
    "dist/index.js",
    "package.json",
    "src/index.ts",
  ]);
});

test("missingTargets skips dist/ targets before a build", () => {
  const pkg = { exports: { ".": { source: "./src/index.ts", import: "./dist/index.js" } } };
  assert.deepEqual(missingTargets(pkg, [], { built: false }), ["src/index.ts"]);
  assert.deepEqual(missingTargets(pkg, ["src/index.ts"], { built: true }), ["dist/index.js"]);
  assert.deepEqual(missingTargets(pkg, ["src/index.ts", "dist/index.js"], { built: true }), []);
});
