import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git3Twins } from "./git3-twins.mjs";

test("selects test files reaching $GIT3 directly or through support modules", () => {
  const dir = mkdtempSync(join(tmpdir(), "git3-twins-"));
  try {
    const tests = join(dir, "tests");
    mkdirSync(join(tests, "sub"), { recursive: true });
    const files = {
      "native-git3.ts": "export const git3Binary = () => process.env.GIT3;\n",
      "a-git3-native.test.ts": 'import { git3Binary } from "./native-git3.js";\n',
      "b-native.test.ts": "const g = process.env.GIT3;\n",
      "c-native.test.ts": 'import { x } from "./c-support.js";\n',
      "c-support.ts": 'export { y as x } from "./sub/deep.js";\n',
      "sub/deep.ts": 'import { nativeGit3Env } from "../native-git3.js";\nexport const y = 1;\n',
      "d-native.test.ts": 'import { z } from "./d-support.js";\n// mentions $GIT3 only\n',
      "d-support.ts": 'import { c } from "./cycle.js";\nexport const z = c;\n',
      "cycle.ts": 'import { z } from "./d-support.js";\nexport const c = 1;\n',
      "e-sha1dc-native.test.ts": "const tool = process.env.GIT_TEST_TOOL;\n",
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(tests, name), text);
    assert.deepEqual(git3Twins(dir), [
      "tests/a-git3-native.test.ts",
      "tests/b-native.test.ts",
      "tests/c-native.test.ts",
      "tests/e-sha1dc-native.test.ts",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vcs-commands' selection keeps the known twins", () => {
  const twins = git3Twins("packages/vcs-commands");
  for (const file of [
    "tests/repo-native.test.ts",
    "tests/format-rev-native.test.ts",
    "tests/legacy-remotes-native.test.ts",
    "tests/receive-limits-native.test.ts",
    "tests/history-git3-native.test.ts",
    "tests/sha1dc-native.test.ts",
  ]) {
    assert.ok(twins.includes(file), file);
  }
});
