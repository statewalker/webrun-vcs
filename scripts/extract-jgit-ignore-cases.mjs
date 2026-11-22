#!/usr/bin/env node
// Extracts (pattern, path, expected) cases from JGit's ignore rule tests.
// Usage: node extract-jgit-ignore-cases.mjs <jgit checkout> > cases.json
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: extract-jgit-ignore-cases.mjs <jgit checkout>");
const dir = join(root, "org.eclipse.jgit.test/tst/org/eclipse/jgit/ignore");
const FILES = [
  "IgnoreRuleSpecialCasesTest.java",
  "FastIgnoreRuleTest.java",
  "IgnoreMatcherParametrizedTest.java",
];
const lit = String.raw`"((?:[^"\\]|\\.)*)"`;
// the pattern is a literal, or the variable `pattern` (its latest `pattern = "..."` before the call)
const call = new RegExp(
  String.raw`\b(assertMatch|assertMatched|assertNotMatched)\(\s*(?:${lit}|pattern)\s*,\s*${lit}\s*(?:,\s*(true|false|Boolean\.TRUE|Boolean\.FALSE))?\s*\)`,
  "g",
);
const assign = new RegExp(String.raw`\bpattern\s*=\s*${lit}\s*;`, "g");
const javaUnescape = (s) =>
  s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) =>
    c[0] === "u" && c.length === 5
      ? String.fromCharCode(Number.parseInt(c.slice(1), 16))
      : ({ n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'" }[c] ?? c),
  );

const cases = [];
const seen = new Set();
for (const file of FILES) {
  const text = readFileSync(join(dir, file), "utf8");
  // the test method each call is in, for traceability
  const methods = [...text.matchAll(/public void (\w+)\(/g)].map((m) => ({
    at: m.index,
    name: m[1],
  }));
  const assigns = [...text.matchAll(assign)].map((m) => ({
    at: m.index,
    value: javaUnescape(m[1]),
  }));
  for (const m of text.matchAll(call)) {
    const [, fn, p, i, third] = m;
    const pattern =
      p !== undefined ? javaUnescape(p) : assigns.filter((a) => a.at < m.index).at(-1)?.value;
    if (pattern === undefined) continue;
    const path = javaUnescape(i);
    let expected;
    if (fn === "assertMatch") expected = third === "true" || third === "Boolean.TRUE";
    else expected = fn === "assertMatched";
    // assertMatched(p, path, true) in IgnoreMatcherParametrizedTest is an assumption, not a check
    const assumption = fn !== "assertMatch" && third !== undefined && /TRUE|true/.test(third);
    const method = methods.filter((x) => x.at < m.index).at(-1)?.name ?? "?";
    const key = JSON.stringify([pattern, path]);
    if (seen.has(key)) continue;
    seen.add(key);
    cases.push({
      source: `${file.replace(".java", "")}#${method}`,
      pattern,
      path,
      jgit: expected,
      ...(assumption ? { assumption } : {}),
    });
  }
}
process.stdout.write(`${JSON.stringify(cases, null, 1)}\n`);
process.stderr.write(
  `${cases.length} cases, ${new Set(cases.map((c) => c.pattern)).size} patterns\n`,
);
