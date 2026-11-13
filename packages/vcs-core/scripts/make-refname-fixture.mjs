// Regenerates tests/history/refs/fixtures/refname-git.json: git check-ref-format's
// verdict on a table of names plus seeded fuzzed names, with and without
// --allow-onelevel. Run with native git: node scripts/make-refname-fixture.mjs
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const table = [
  "refs/heads/main",
  "refs/heads/feature/x",
  "refs/tags/v1.0",
  "refs/heads/a-b_c",
  "refs/heads/UPPER",
  "refs/heads/naïve",
  "refs/heads/emoji-😀",
  "refs/heads/a.b",
  "refs/heads/.hidden",
  "refs/heads/a/.b",
  "refs/heads/a..b",
  "refs/heads/x.lock",
  "refs/heads/x.lock/y",
  "refs/heads/x.locked",
  "refs/heads/x.",
  "refs/heads/end/",
  "/refs/heads/a",
  "refs//heads",
  "refs/heads/sp ace",
  "refs/heads/tab\there",
  "refs/heads/col:on",
  "refs/heads/q?",
  "refs/heads/br[acket",
  "refs/heads/back\\slash",
  "refs/heads/car^et",
  "refs/heads/til~de",
  "refs/heads/st*r",
  "refs/heads/@{x}",
  "refs/heads/a@b",
  "refs/heads/@",
  "@",
  "HEAD",
  "main",
  "refs",
  "refs/",
  "refs/heads",
  "refs/heads/-dash",
  "refs/heads/a/-b",
  "refs/heads/\u0001ctl",
  "refs/heads/del\u007f",
  "refs/heads/a/b/c/d/e",
  "refs/heads/.",
  "refs/heads/..",
  "refs/heads/a/./b",
  "refs/heads/a/../b",
  "refs/heads/{brace}",
  "refs/heads/at@{",
  "refs/heads/dot.lock.x",
  "refs/remotes/origin/HEAD",
  "refs/notes/commits",
  "refs/heads/trailing.lock",
  ".refs/heads/a",
  "refs/heads/a.",
  "refs/heads/@{-1}",
  "",
];

// Deterministic fuzz: names built from an alphabet rich in the characters the rules care about.
let seed = 42;
const rand = (n) => {
  seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
  return seed % n;
};
// Ordinary characters weighted up so that more of the names are valid.
const ordinary = ["a", "b", "c", "Z", "0", "9", "-", "_", "é", "/"];
const alphabet = [
  ...ordinary,
  ...ordinary,
  ...ordinary,
  "a",
  "b",
  "Z",
  "0",
  "/",
  "/",
  ".",
  ".",
  "@",
  "{",
  "}",
  "-",
  "_",
  "~",
  "^",
  ":",
  "?",
  "*",
  "[",
  "\\",
  " ",
  "\u007f",
  "\u0001",
  "é",
  "lock",
  ".lock",
  "refs/",
  "heads/",
];
const fuzz = new Set();
while (fuzz.size < 1500) {
  let s = rand(3) === 0 ? "" : "refs/";
  const len = 1 + rand(8);
  for (let i = 0; i < len; i++) s += alphabet[rand(alphabet.length)];
  if (!s.startsWith("-")) fuzz.add(s); // git would read a leading "-" as an option
}

const verdict = (name, oneLevel) => {
  const args = ["check-ref-format", ...(oneLevel ? ["--allow-onelevel"] : []), name];
  return spawnSync("git", args).status === 0;
};
const cases = [...table, ...fuzz].map((name) => ({
  name,
  valid: verdict(name, false),
  validOneLevel: verdict(name, true),
}));
const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim();
writeFileSync(
  new URL("../tests/history/refs/fixtures/refname-git.json", import.meta.url),
  `${JSON.stringify({ source: `${gitVersion} check-ref-format`, cases }, null, 1)}\n`,
);
console.log(cases.length, "cases;", cases.filter((c) => c.valid).length, "valid");
