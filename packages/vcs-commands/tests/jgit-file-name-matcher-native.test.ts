/**
 * JGit's `FileNameMatcherTest` (org.eclipse.jgit.test, `fnmatch/`) as native twins
 * (statewalker/webrun-vcs#218). JGit's `FileNameMatcher` matches a whole name against a
 * glob; git has no such command, so only JGit's inputs are taken and native git decides
 * through the three places git matches such patterns:
 *
 * - `git check-ignore --no-index -v -n` with the pattern as a `.gitignore` line (dir.c's
 *   `match_basename` for a pattern without `/`, `match_pathname` with `WM_PATHNAME`
 *   otherwise);
 * - `git ls-files -- <pattern>`: a plain pathspec (`fnmatch` without `WM_PATHNAME`, so `*`
 *   crosses `/`, plus the literal prefix match);
 * - `git ls-files -- ':(glob)<pattern>'`: `WM_PATHNAME`, JGit's matcher with `/` excluded.
 *
 * Every input of a pattern is an index entry (the empty name excepted) and every one is
 * asked of check-ignore; native git's and our outputs are compared byte for byte.
 * `canAppendMatch`, JGit's streaming state, has no git counterpart and is not ported.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import {
  git,
  nativeCompatibility,
  type Outcome,
  outcomeOf,
  plumbingEnv,
  writeFiles,
} from "./plumbing-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

/**
 * JGit's cases: `[method without "test", pattern, input, excludes "/"]`. The excluded `/`
 * of `assertFileNameMatch(..., '/', ...)` is JGit's `WM_PATHNAME`.
 */
const CASES: [string, string, string, true?][] = [
  ["VerySimplePatternCase0", "", ""],
  ["VerySimplePatternCase1", "ab", "a"],
  ["VerySimplePatternCase2", "ab", "ab"],
  ["VerySimplePatternCase3", "ab", "ac"],
  ["VerySimplePatternCase4", "ab", "abc"],
  ["VerySimpleWirdcardCase0", "?", "a"],
  ["VerySimpleWildCardCase1", "??", "a"],
  ["VerySimpleWildCardCase2", "??", "ab"],
  ["VerySimpleWildCardCase3", "??", "abc"],
  ["VerySimpleStarCase0", "*", ""],
  ["VerySimpleStarCase1", "*", "a"],
  ["VerySimpleStarCase2", "*", "ab"],
  ["SimpleStarCase0", "a*b", "a"],
  ["SimpleStarCase1", "a*c", "ac"],
  ["SimpleStarCase2", "a*c", "ab"],
  ["SimpleStarCase3", "a*c", "abc"],
  ["ManySolutionsCase0", "a*a*a", "aaa"],
  ["ManySolutionsCase1", "a*a*a", "aaaa"],
  ["ManySolutionsCase2", "a*a*a", "ababa"],
  ["ManySolutionsCase3", "a*a*a", "aaaaaaaa"],
  ["ManySolutionsCase4", "a*a*a", "aaaaaaab"],
  ["VerySimpleGroupCase0", "[ab]", "a"],
  ["VerySimpleGroupCase1", "[ab]", "b"],
  ["VerySimpleGroupCase2", "[ab]", "ab"],
  ["VerySimpleGroupRangeCase0", "[b-d]", "a"],
  ["VerySimpleGroupRangeCase1", "[b-d]", "b"],
  ["VerySimpleGroupRangeCase2", "[b-d]", "c"],
  ["VerySimpleGroupRangeCase3", "[b-d]", "d"],
  ["VerySimpleGroupRangeCase4", "[b-d]", "e"],
  ["VerySimpleGroupRangeCase5", "[b-d]", "-"],
  ["TwoGroupsCase0", "[b-d][ab]", "bb"],
  ["TwoGroupsCase1", "[b-d][ab]", "ca"],
  ["TwoGroupsCase2", "[b-d][ab]", "fa"],
  ["TwoGroupsCase3", "[b-d][ab]", "bc"],
  ["TwoRangesInOneGroupCase0", "[b-ce-e]", "a"],
  ["TwoRangesInOneGroupCase1", "[b-ce-e]", "b"],
  ["TwoRangesInOneGroupCase2", "[b-ce-e]", "c"],
  ["TwoRangesInOneGroupCase3", "[b-ce-e]", "d"],
  ["TwoRangesInOneGroupCase4", "[b-ce-e]", "e"],
  ["TwoRangesInOneGroupCase5", "[b-ce-e]", "f"],
  ["IncompleteRangesInOneGroupCase0", "a[b-]", "ab"],
  ["IncompleteRangesInOneGroupCase1", "a[b-]", "ac"],
  ["IncompleteRangesInOneGroupCase2", "a[b-]", "a-"],
  ["CombinedRangesInOneGroupCase0", "[a-c-e]", "b"],
  ["CombinedRangesInOneGroupCase1", "[a-c-e]", "d"],
  ["CombinedRangesInOneGroupCase2", "[a-c-e]", "e"],
  ["InversedGroupCase0", "[!b-c]", "a"],
  ["InversedGroupCase1", "[!b-c]", "b"],
  ["InversedGroupCase2", "[!b-c]", "c"],
  ["InversedGroupCase3", "[!b-c]", "d"],
  ["AlphaGroupCase0", "[[:alpha:]]", "d"],
  ["AlphaGroupCase1", "[[:alpha:]]", ":"],
  ["AlphaGroupCase2", "[[:alpha:]]", "\u00f6"],
  ["2AlphaGroupsCase0", "[[:alpha:]][[:alpha:]]", "a\u00f6"],
  ["2AlphaGroupsCase0", "[[:alpha:]][[:alpha:]]", "a1"],
  ["AlnumGroupCase0", "[[:alnum:]]", "a"],
  ["AlnumGroupCase1", "[[:alnum:]]", "1"],
  ["AlnumGroupCase2", "[[:alnum:]]", ":"],
  ["BlankGroupCase0", "[[:blank:]]", " "],
  ["BlankGroupCase1", "[[:blank:]]", "\t"],
  ["BlankGroupCase2", "[[:blank:]]", "\r"],
  ["BlankGroupCase3", "[[:blank:]]", "\n"],
  ["BlankGroupCase4", "[[:blank:]]", "a"],
  ["CntrlGroupCase0", "[[:cntrl:]]", "a"],
  ["DigitGroupCase0", "[[:digit:]]", "0"],
  ["DigitGroupCase1", "[[:digit:]]", "5"],
  ["DigitGroupCase2", "[[:digit:]]", "9"],
  ["DigitGroupCase3", "[[:digit:]]", "\u06f9"],
  ["DigitGroupCase4", "[[:digit:]]", "a"],
  ["DigitGroupCase5", "[[:digit:]]", "]"],
  ["GraphGroupCase0", "[[:graph:]]", "]"],
  ["GraphGroupCase1", "[[:graph:]]", "a"],
  ["GraphGroupCase2", "[[:graph:]]", "."],
  ["GraphGroupCase3", "[[:graph:]]", "0"],
  ["GraphGroupCase4", "[[:graph:]]", " "],
  ["GraphGroupCase5", "[[:graph:]]", "\u00f6"],
  ["LowerGroupCase0", "[[:lower:]]", "a"],
  ["LowerGroupCase1", "[[:lower:]]", "h"],
  ["LowerGroupCase2", "[[:lower:]]", "A"],
  ["LowerGroupCase3", "[[:lower:]]", "H"],
  ["LowerGroupCase4", "[[:lower:]]", "\u00e4"],
  ["LowerGroupCase5", "[[:lower:]]", "."],
  ["PrintGroupCase0", "[[:print:]]", "]"],
  ["PrintGroupCase1", "[[:print:]]", "a"],
  ["PrintGroupCase2", "[[:print:]]", "."],
  ["PrintGroupCase3", "[[:print:]]", "0"],
  ["PrintGroupCase4", "[[:print:]]", " "],
  ["PrintGroupCase5", "[[:print:]]", "\u00f6"],
  ["PunctGroupCase0", "[[:punct:]]", "."],
  ["PunctGroupCase1", "[[:punct:]]", "@"],
  ["PunctGroupCase2", "[[:punct:]]", " "],
  ["PunctGroupCase3", "[[:punct:]]", "a"],
  ["SpaceGroupCase0", "[[:space:]]", " "],
  ["SpaceGroupCase1", "[[:space:]]", "\t"],
  ["SpaceGroupCase2", "[[:space:]]", "\r"],
  ["SpaceGroupCase3", "[[:space:]]", "\n"],
  ["SpaceGroupCase4", "[[:space:]]", "a"],
  ["UpperGroupCase0", "[[:upper:]]", "a"],
  ["UpperGroupCase1", "[[:upper:]]", "h"],
  ["UpperGroupCase2", "[[:upper:]]", "A"],
  ["UpperGroupCase3", "[[:upper:]]", "H"],
  ["UpperGroupCase4", "[[:upper:]]", "\u00c4"],
  ["UpperGroupCase5", "[[:upper:]]", "."],
  ["XDigitGroupCase0", "[[:xdigit:]]", "a"],
  ["XDigitGroupCase1", "[[:xdigit:]]", "d"],
  ["XDigitGroupCase2", "[[:xdigit:]]", "f"],
  ["XDigitGroupCase3", "[[:xdigit:]]", "0"],
  ["XDigitGroupCase4", "[[:xdigit:]]", "5"],
  ["XDigitGroupCase5", "[[:xdigit:]]", "9"],
  ["XDigitGroupCase6", "[[:xdigit:]]", "\u06f9"],
  ["XDigitGroupCase7", "[[:xdigit:]]", "."],
  ["WordroupCase0", "[[:word:]]", "g"],
  ["WordroupCase1", "[[:word:]]", "\u00f6"],
  ["WordroupCase2", "[[:word:]]", "5"],
  ["WordroupCase3", "[[:word:]]", "_"],
  ["WordroupCase4", "[[:word:]]", " "],
  ["WordroupCase5", "[[:word:]]", "."],
  ["MixedGroupCase0", "[A[:lower:]C3-5]", "A"],
  ["MixedGroupCase1", "[A[:lower:]C3-5]", "C"],
  ["MixedGroupCase2", "[A[:lower:]C3-5]", "e"],
  ["MixedGroupCase3", "[A[:lower:]C3-5]", "3"],
  ["MixedGroupCase4", "[A[:lower:]C3-5]", "4"],
  ["MixedGroupCase5", "[A[:lower:]C3-5]", "5"],
  ["MixedGroupCase6", "[A[:lower:]C3-5]", "B"],
  ["MixedGroupCase7", "[A[:lower:]C3-5]", "2"],
  ["MixedGroupCase8", "[A[:lower:]C3-5]", "6"],
  ["MixedGroupCase9", "[A[:lower:]C3-5]", "."],
  ["SpecialGroupCase0", "[[]", "["],
  ["SpecialGroupCase1", "[]]", "]"],
  ["SpecialGroupCase2", "[]a]", "]"],
  ["SpecialGroupCase3", "[a[]", "["],
  ["SpecialGroupCase4", "[a[]", "a"],
  ["SpecialGroupCase5", "[!]]", "]"],
  ["SpecialGroupCase6", "[!]]", "x"],
  ["SpecialGroupCase7", "[:]]", ":]"],
  ["SpecialGroupCase8", "[:]]", ":"],
  ["SpecialGroupCase9", "[[:]", ":"],
  ["UnsupportedGroupCase0", "[[=a=]]", "b"],
  ["UnsupportedGroupCase1", "[[.a.]]", "b"],
  ["EscapedBracket1", "\\[", "["],
  ["EscapedBracket2", "\\[[a]", "["],
  ["EscapedBracket3", "\\[[a]", "a"],
  ["EscapedBracket4", "\\[[a]", "[a"],
  ["EscapedBracket5", "[a\\]]", "]"],
  ["EscapedBracket6", "[a\\]]", "a"],
  ["EscapedBackslash", "a\\\\b", "a\\b"],
  ["MultipleEscapedCharacters1", "\\]a?c\\*\\[d\\?\\]", "]abc*[d?]"],
  ["FilePathSimpleCase", "a/b", "a/b", true],
  ["FilePathCase0", "a*b", "a/b", true],
  ["FilePathCase1", "a?b", "a/b", true],
  ["Reset", "helloworld", "helloworld"],
  ["Reset", "helloworld", "hello"],
  ["Reset", "helloworld", "helloworldto much"],
  ["CreateMatcherForSuffix", "helloworld", "helloworld"],
  ["CopyConstructor", "helloworld", "helloworld"],
];

let root = "";
let counter = 0;

const utf8 = (s: string) => Buffer.from(s, "utf8");

function nativeRun(dir: string, args: string[], input: string[]): Outcome {
  const r = spawnSync("git", args, {
    cwd: dir,
    env: plumbingEnv(root),
    encoding: "latin1",
    input: Buffer.concat(input.map((p) => utf8(`${p}\0`))),
  });
  return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
}

/** The pattern's repository: its inputs as index entries, the pattern as `.gitignore`. */
function repository(pattern: string, inputs: string[]): string {
  const dir = join(root, `r${counter++}`);
  mkdirSync(dir);
  git(root, dir, ["init", "-q", "-b", "main"]);
  writeFiles(dir, { ".gitignore": utf8(`${pattern}\n`).toString("latin1") });
  const entries = inputs.filter((p) => p !== "").map((p) => `100644 ${EMPTY_BLOB}\t${p}`);
  const r = nativeRun(dir, ["update-index", "-z", "--index-info"], entries);
  if (r.status !== 0) throw new Error(`update-index: ${r.err}`);
  return dir;
}

async function checkIgnoreTwin(dir: string, inputs: string[], label: string) {
  const native = nativeRun(
    dir,
    ["check-ignore", "--no-index", "-v", "-n", "--stdin", "-z"],
    inputs,
  );
  const g = await openOurs(dir, createNodeGitHostEnvironment({ env: plumbingEnv(root) }));
  const cmd = g
    .checkIgnore()
    .setNoIndex(true)
    .setVerbose(true)
    .setNonMatching(true)
    .setNulTerminated(true)
    .setStdin(Buffer.concat(inputs.map((p) => utf8(`${p}\0`))));
  expect(outcomeOf(await cmd.call()), `check-ignore: ${label}`).toEqual(native);
}

async function lsFilesTwin(dir: string, pathspec: string, label: string) {
  const native = nativeRun(dir, ["ls-files", "-z", "--", pathspec], []);
  const g = await openOurs(dir, createNodeGitHostEnvironment({ env: plumbingEnv(root) }));
  const out = await g
    .lsFiles()
    .setNulTerminated(true)
    .setCompatibility(nativeCompatibility())
    .addPathspec(pathspec)
    .callOutput();
  const ours = {
    status: out.exitCode,
    out: Buffer.from(out.stdout).toString("latin1"),
    err: out.stderr,
  };
  expect(ours, `ls-files -- ${pathspec}: ${label}`).toEqual(native);
}

/** The cases grouped by pattern and excluded `/` (one repository each). */
function groups(): Map<string, { pattern: string; names: string[]; inputs: string[] }> {
  const out = new Map<string, { pattern: string; names: string[]; inputs: string[] }>();
  for (const [name, pattern, input, excluded] of CASES) {
    const key = `${excluded ? "/" : ""}\0${pattern}`;
    let g = out.get(key);
    if (!g) {
      g = { pattern, names: [], inputs: [] };
      out.set(key, g);
    }
    if (!g.names.includes(name)) g.names.push(name);
    if (!g.inputs.includes(input)) g.inputs.push(input);
  }
  return out;
}

describeGit("JGit FileNameMatcherTest against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "jgit-fnmatch-"));
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  for (const { pattern, names, inputs } of groups().values()) {
    const title = names.map((n) => `JGit FileNameMatcherTest#test${n}`).join(", ");
    it(title, async () => {
      const dir = repository(pattern, inputs);
      const label = `${JSON.stringify(pattern)} ${JSON.stringify(inputs)}`;
      await checkIgnoreTwin(dir, inputs, label);
      await lsFilesTwin(dir, pattern, label);
      await lsFilesTwin(dir, `:(glob)${pattern}`, label);
    });
  }
});
