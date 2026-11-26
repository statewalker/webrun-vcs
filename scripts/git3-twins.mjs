#!/usr/bin/env node
/**
 * Lists the test files of the git 3.0 oracle (`.github/workflows/git3-oracle.yml`): every
 * `*.test.ts` of a package's `tests/` that reaches `$GIT3` or `$GIT_TEST_TOOL`, directly
 * (`process.env.GIT3`, `process.env.GIT_TEST_TOOL`, an import of `native-git3.js`) or through
 * the test-support modules it imports, at any depth. A twin is therefore selected by what it
 * uses, not by its name, so a file mixing git 2.x and git master twins runs there too.
 *
 * ```sh
 * node scripts/git3-twins.mjs packages/vcs-commands   # paths relative to that package
 * ```
 *
 * Prints one path per line (`tests/<file>.test.ts`), sorted; exits 1 when it finds none, so
 * a broken selection fails the job instead of running nothing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const DIRECT = [
  /process\.env\.GIT3\b/,
  /process\.env\.GIT_TEST_TOOL\b/,
  /from\s+["'][^"']*\/native-git3\.js["']/,
];

/** Relative `.js`/`.ts` imports of a source, as absolute `.ts` paths. */
function localImports(file, text) {
  const out = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    out.push(resolve(dirname(file), m[1].replace(/\.js$/, ".ts")));
  }
  return out;
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...listFiles(path));
    } else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

export function git3Twins(packageDir) {
  const root = resolve(packageDir);
  const files = listFiles(join(root, "tests"));
  const sources = new Map(files.map((f) => [normalize(f), readFileSync(f, "utf8")]));
  const memo = new Map();
  const uses = (file) => {
    if (memo.has(file)) return memo.get(file);
    memo.set(file, false); // import cycles
    const text = sources.get(file);
    if (text === undefined) return false;
    const result =
      DIRECT.some((re) => re.test(text)) ||
      localImports(file, text).some((dep) => uses(normalize(dep)));
    memo.set(file, result);
    return result;
  };
  return files
    .filter((f) => f.endsWith(".test.ts") && uses(normalize(f)))
    .map((f) => relative(root, f))
    .sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const twins = git3Twins(process.argv[2] ?? ".");
  if (twins.length === 0) {
    console.error("git3-twins: no test file uses $GIT3");
    process.exit(1);
  }
  console.log(twins.join("\n"));
}
