/**
 * `git blame --ignore-rev`, `--ignore-revs-file`, `blame.ignoreRevsFile`,
 * `blame.markIgnoredLines` and `blame.markUnblamableLines` against native git, byte for byte:
 * the scenarios of t8013-blame-ignore-revs.sh, t8014-blame-ignore-fuzzy.sh and JGit's
 * BlameGeneratorTest, then random histories with random commits ignored.
 *
 * `BLAME_IGN_SEEDS` sets the number of random histories (default 30), `BLAME_IGN_SHOW` how
 * many mismatches to print.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { formatBlame } from "../src/index.js";
import {
  atLeast,
  compareBlame,
  compatibility,
  git as nativeGit,
  open,
  prng,
  tickEnv,
} from "./blame-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;
const SEEDS = Number(process.env.BLAME_IGN_SEEDS ?? 30);
const SHOW = Number(process.env.BLAME_IGN_SHOW ?? 3);

let root: string | undefined;
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
const tmp = () => {
  root ??= mkdtempSync(join(tmpdir(), "blame-ignore-native-"));
  return root;
};
const git = (cwd: string, args: string[], input?: string, env?: Record<string, string>) =>
  nativeGit(tmp(), cwd, args, input, env);

/** A repository driven as test-lib drives one: each commit one tick later */
function scenario(name: string) {
  const dir = join(tmp(), name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  let tick = 0;
  const write = (path: string, text: string) => writeFileSync(join(dir, path), text);
  const commit = (message: string, author = "A U Thor") => {
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", message], undefined, tickEnv(author, ++tick));
    return git(dir, ["rev-parse", "HEAD"]);
  };
  const lines = (...ls: string[]) => ls.map((l) => `${l}\n`).join("");
  const compare = async (path: string, args: string[], formats?: string[][]) =>
    compareBlame(tmp(), dir, await open(dir), path, args, { rev: "HEAD", formats });
  return { dir, write, commit, lines, compare, git: (args: string[]) => git(dir, args) };
}

const ALL_FORMATS = [["--porcelain"], ["--line-porcelain"], [], ["-n", "-f"]];

function check(mismatches: string[]): void {
  for (const m of mismatches.slice(0, SHOW)) console.log(m);
  expect(mismatches).toEqual([]);
}

describeGit("git blame --ignore-rev against native git", () => {
  it('t8013-blame-ignore-revs.sh: "setup", "ignore_rev_changing_lines (X)", "ignore_rev_adding_unblamable_lines", "ignore_revs_from_files", "ignore_revs_from_configs_and_files", "override_ignore_revs_file", "mark_unblamable_lines", "mark_ignored_lines", "mark_unblamable_lines_intermediate"', async () => {
    const s = scenario("t8013");
    const m: string[] = [];
    // "setup"
    s.write("file", s.lines("line1"));
    s.commit("A");
    s.git(["tag", "A"]);
    s.write("file", s.lines("line1", "line2"));
    s.commit("B");
    s.git(["tag", "B"]);
    s.write("file", s.lines("line-one", "line-two"));
    s.commit("X");
    s.git(["tag", "X"]);
    s.git(["tag", "-a", "-m", "X (annotated)", "XT"]);
    m.push(...(await s.compare("file", [], ALL_FORMATS)));
    // "ignore_rev_changing_lines (X)", "ignore_rev_changing_lines (XT)"
    m.push(...(await s.compare("file", ["--ignore-rev", "X"], ALL_FORMATS)));
    m.push(...(await s.compare("file", ["--ignore-rev", "XT"], ALL_FORMATS)));
    // "ignore_rev_adding_unblamable_lines"
    s.write("file", s.lines("line-one-change", "line-two-changed", "y3", "y4"));
    s.commit("Y");
    s.git(["tag", "Y"]);
    m.push(...(await s.compare("file", ["--ignore-rev", "Y"], ALL_FORMATS)));
    // "ignore_revs_from_files"
    writeFileSync(join(s.dir, "ignore_x"), `${s.git(["rev-parse", "X"])}\n`);
    writeFileSync(join(s.dir, "ignore_y"), `${s.git(["rev-parse", "Y"])}\n`);
    m.push(
      ...(await s.compare(
        "file",
        ["--ignore-revs-file", "ignore_x", "--ignore-revs-file", "ignore_y"],
        ALL_FORMATS,
      )),
    );
    // "validate --ignore-revs-file": a tree in the file is silently skipped
    writeFileSync(join(s.dir, "ignore_tree"), `${s.git(["rev-parse", "X^{tree}"])}\n`);
    m.push(...(await s.compare("file", ["--ignore-revs-file", "ignore_tree"])));
    // comments, blank lines and whitespace, a tag peeled, an unknown id skipped
    writeFileSync(
      join(s.dir, "ignore_mixed"),
      `# ignored\n\n   ${s.git(["rev-parse", "XT"])}  # the tag\n${"1".repeat(40)}\r\n`,
    );
    m.push(...(await s.compare("file", ["--ignore-revs-file", "ignore_mixed"])));
    // "ignore_revs_from_configs_and_files"
    s.git(["config", "--add", "blame.ignoreRevsFile", "ignore_x"]);
    m.push(...(await s.compare("file", ["--ignore-revs-file", "ignore_y"], ALL_FORMATS)));
    // "override_ignore_revs_file"
    m.push(
      ...(await s.compare("file", ["--ignore-revs-file", "", "--ignore-revs-file", "ignore_y"])),
    );
    // "mark_unblamable_lines", "mark_unblamable_lines with --porcelain"
    s.git(["config", "--add", "blame.markUnblamableLines", "true"]);
    m.push(...(await s.compare("file", ["--ignore-rev", "Y"], ALL_FORMATS)));
    // "mark_ignored_lines", "mark_ignored_lines with --porcelain"
    s.git(["config", "--add", "blame.markIgnoredLines", "true"]);
    s.write("file", s.lines("line-one-Z", "line-two-Z", "y3", "y4"));
    s.commit("Z");
    s.git(["tag", "Z"]);
    m.push(...(await s.compare("file", ["--ignore-rev", "Z"], ALL_FORMATS)));
    // "mark_unblamable_lines_intermediate"
    m.push(...(await s.compare("file", ["--ignore-rev", "Y"], ALL_FORMATS)));
    m.push(...(await s.compare("file", ["--ignore-rev", "Y", "--ignore-rev", "Z"], ALL_FORMATS)));
    // the marks with a boundary commit, -b and -l
    m.push(
      ...(await s.compare(
        "file",
        ["--ignore-rev", "Y", "--ignore-revs-file", "ignore_x"],
        [[], ["-b"], ["-l"], ["-b", "-l"]],
      )),
    );
    check(m);
    // the marks as our formatter applies them by default
    const ours = await open(s.dir);
    const r = await ours.blame().setFilePath("file").setIgnoreRevs(["Z"]).call();
    expect(r.markIgnoredLines).toBe(true);
    expect(r.entries.filter((e) => e.ignored).map((e) => e.resultStart)).toEqual([1]);
    expect(Buffer.from(formatBlame(r)).toString().split("\n")[0][0]).toBe("?");
  }, 60_000);

  it('t8013-blame-ignore-revs.sh: "validate --ignore-rev", "bad_files_and_revs"', async () => {
    const s = scenario("t8013-bad");
    s.write("file", s.lines("line1"));
    s.commit("A");
    s.git(["tag", "X"]);
    const ours = await open(s.dir);
    await expect(
      ours.blame().setFilePath("file").setIgnoreRevs(["X^{tree}"]).call(),
    ).rejects.toThrow("cannot find revision X^{tree} to ignore");
    await expect(
      (await open(s.dir)).blame().setFilePath("file").setIgnoreRevs(["NOREV"]).call(),
    ).rejects.toThrow("cannot find revision NOREV to ignore");
    await expect(
      (await open(s.dir)).blame().setFilePath("file").setIgnoreRevsFiles(["NOFILE"]).call(),
    ).rejects.toThrow("could not open object name list: NOFILE");
    writeFileSync(join(s.dir, "ignore_norev"), "NOREV\n");
    await expect(
      (await open(s.dir)).blame().setFilePath("file").setIgnoreRevsFiles(["ignore_norev"]).call(),
    ).rejects.toThrow("invalid object name: NOREV");
    // a missing blame.ignoreRevsFile dies, unless marked `:(optional)` (git 2.52+)
    s.git(["config", "blame.ignoreRevsFile", ":(optional)nofile"]);
    const optional = (await open(s.dir))
      .blame()
      .setFilePath("file")
      .setCompatibility(compatibility);
    if (atLeast(2, 52)) {
      expect((await optional.call()).entries).toHaveLength(1);
      expect(git(s.dir, ["blame", "file"])).toContain("line1");
    } else {
      await expect(optional.call()).rejects.toThrow(
        "could not open object name list: :(optional)nofile",
      );
    }
    s.git(["config", "blame.ignoreRevsFile", "nofile"]);
    await expect(
      (await open(s.dir)).blame().setFilePath("file").setCompatibility(compatibility).call(),
    ).rejects.toThrow("could not open object name list: nofile");
  });

  it('t8013-blame-ignore-revs.sh: "ignored_chunk_negative_parent_size", "ignore_merge"', async () => {
    const s = scenario("t8013-chunks");
    const m: string[] = [];
    // "ignored_chunk_negative_parent_size"
    s.write("file", s.lines("L1", "L2", "L7", "L8", "L9"));
    s.commit("A");
    s.write("file", s.lines("L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9"));
    const b = s.commit("B");
    s.write("file", s.lines("L1", "L2", "L3", "L4", "xxx", "L6", "L7", "L8", "L9"));
    s.commit("C");
    s.git(["config", "blame.markUnblamableLines", "true"]);
    s.git(["config", "blame.markIgnoredLines", "true"]);
    m.push(...(await s.compare("file", ["--ignore-rev", b], ALL_FORMATS)));
    // "ignore_merge"
    const t = scenario("t8013-merge");
    t.write("file", t.lines("L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9"));
    const a = t.commit("A");
    t.write("file", t.lines("BB", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9"));
    const bb = t.commit("B");
    t.git(["checkout", "-q", "-b", "side", a]);
    t.write("file", t.lines("L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "CC"));
    t.commit("C");
    t.git(["checkout", "-q", "main"]);
    git(t.dir, ["merge", "-q", "-m", "M", "side"], undefined, tickEnv("A U Thor", 10));
    m.push(...(await t.compare("file", ["--ignore-rev", "HEAD"], ALL_FORMATS)));
    m.push(...(await t.compare("file", ["--ignore-rev", "HEAD", "--ignore-rev", bb])));
    check(m);
  }, 60_000);
});

/** The cases of t8014-blame-ignore-fuzzy.sh: the initial content (aN) and the final one (bN) */
const FUZZY_CASES: Array<{ n: number; title: string; a: string; b: string }> = [
  {
    n: 2,
    title: "Regression test for partially overlapping search ranges",
    a: "1\n2\n3\nabcdef\n5\n6\n7\nijkl\n9\n10\n11\npqrs\n13\n14\n15\nwxyz\n17\n18\n19\n",
    b: "abcde\nijk\npqr\nwxy\n",
  },
  {
    n: 3,
    title: "Combine 3 lines into 2",
    a: "if ((maxgrow==0) ||\n\t( single_line_field && (field->dcols < maxgrow)) ||\n\t(!single_line_field && (field->drows < maxgrow)))\n",
    b: "if ((maxgrow == 0) || (single_line_field && (field->dcols < maxgrow)) ||\n\t(!single_line_field && (field->drows < maxgrow))) {\n",
  },
  {
    n: 4,
    title: "Add curly brackets",
    a: "\tif (rows) *rows = field->rows;\n\tif (cols) *cols = field->cols;\n\tif (frow) *frow = field->frow;\n\tif (fcol) *fcol = field->fcol;\n",
    b: "\tif (rows) {\n\t\t*rows = field->rows;\n\t}\n\tif (cols) {\n\t\t*cols = field->cols;\n\t}\n\tif (frow) {\n\t\t*frow = field->frow;\n\t}\n\tif (fcol) {\n\t\t*fcol = field->fcol;\n\t}\n",
  },
  {
    n: 5,
    title: "Combine many lines and change case",
    a: "for(row=0,pBuffer=field->buf;\n\trow<height;\n\trow++,pBuffer+=width )\n{\n\tif ((len = (int)( After_End_Of_Data( pBuffer, width ) - pBuffer )) > 0)\n\t{\n\t\twmove( win, row, 0 );\n\t\twaddnstr( win, pBuffer, len );\n",
    b: "for (Row = 0, PBuffer = field->buf; Row < Height; Row++, PBuffer += Width) {\n\tif ((Len = (int)(afterEndOfData(PBuffer, Width) - PBuffer)) > 0) {\n\t\twmove(win, Row, 0);\n\t\twaddnstr(win, PBuffer, Len);\n",
  },
  {
    n: 6,
    title: "Rename and combine lines",
    a: "bool need_visual_update = ((form != (FORM *)0)      &&\n\t(form->status & _POSTED) &&\n\t(form->current==field));\n\nif (need_visual_update)\n\tSynchronize_Buffer(form);\n\nif (single_line_field)\n{\n\tgrowth = field->cols * amount;\n\tif (field->maxgrow)\n\t\tgrowth = Minimum(field->maxgrow - field->dcols,growth);\n\tfield->dcols += growth;\n\tif (field->dcols == field->maxgrow)\n",
    b: "bool NeedVisualUpdate = ((Form != (FORM *)0) && (Form->status & _POSTED) &&\n\t(Form->current == field));\n\nif (NeedVisualUpdate) {\n\tsynchronizeBuffer(Form);\n}\n\nif (SingleLineField) {\n\tGrowth = field->cols * amount;\n\tif (field->maxgrow) {\n\t\tGrowth = Minimum(field->maxgrow - field->dcols, Growth);\n\t}\n\tfield->dcols += Growth;\n\tif (field->dcols == field->maxgrow) {\n",
  },
  { n: 7, title: "Same line twice", a: "abc\nabc\n", b: "abcd\nabcd\n" },
  { n: 8, title: "Enforce line order", a: "abcdef\nghijkl\nab\n", b: "ghijk\nabcd\n" },
  {
    n: 9,
    title: "Expand lines and rename variables",
    a: "int myFunction(int ArgumentOne, Thing *ArgTwo, Blah XuglyBug) {\n\tSquiggle FabulousResult = squargle(ArgumentOne, *ArgTwo,\n\t\tXuglyBug) + EwwwGlobalWithAReallyLongNameYepTooLong;\n\treturn FabulousResult * 42;\n}\n",
    b: "int myFunction(int argument_one, Thing *arg_asdfgh,\n\tBlah xugly_bug) {\n\tSquiggle fabulous_result = squargle(argument_one,\n\t\t*arg_asdfgh, xugly_bug)\n\t\t+ g_ewww_global_with_a_really_long_name_yep_too_long;\n\treturn fabulous_result * 42;\n}\n",
  },
  {
    n: 10,
    title: "Two close matches versus one less close match",
    a: "abcdef\nabcdef\nghijkl\n",
    b: "gh\nabcdefx\n",
  },
  {
    n: 11,
    title: "Piggy in the middle",
    a: "abcdefg\nijklmn\nabcdefgh\n",
    b: "abcdefghx\nijklm\n",
  },
  { n: 12, title: "No trailing newline", a: "abc\ndef", b: "abx\nstu" },
  {
    n: 13,
    title: "Reorder includes",
    a: '#include "c.h"\n#include "b.h"\n#include "a.h"\n#include "e.h"\n#include "d.h"\n',
    b: '#include "a.h"\n#include "b.h"\n#include "c.h"\n#include "d.h"\n#include "e.h"\n',
  },
];

describeGit("git blame's fuzzy matching of ignored lines against native git", () => {
  it(`t8014-blame-ignore-fuzzy.sh: "setup", ${FUZZY_CASES.map((c) => JSON.stringify(c.title)).join(", ")}`, async () => {
    const s = scenario("t8014");
    // "setup": each line of aN appended in a commit of its own (`read` drops an
    // unterminated last line), then every file given its final content in one commit
    for (const c of FUZZY_CASES) {
      const complete = c.a.slice(0, c.a.lastIndexOf("\n") + 1);
      let text = "";
      let count = 0;
      for (const line of complete.split("\n").slice(0, -1)) {
        text += `${line}\n`;
        s.write(String(c.n), text);
        s.commit(String(++count), String(count));
      }
    }
    for (const c of FUZZY_CASES) s.write(String(c.n), c.b);
    s.commit("Final", "Final");
    const ignoreme = s.git(["rev-parse", "HEAD"]);
    const m: string[] = [];
    for (const c of FUZZY_CASES) {
      m.push(...(await s.compare(String(c.n), ["-M9", "--ignore-rev", ignoreme])));
      m.push(...(await s.compare(String(c.n), ["--ignore-rev", ignoreme])));
    }
    check(m);
  }, 120_000);

  it('t8014-blame-ignore-fuzzy.sh: "Diff chunks with no suspects", "position matching", "preserve order"', async () => {
    const s = scenario("t8014-extra");
    const m: string[] = [];
    // "Diff chunks with no suspects"
    s.write("file", s.lines("xy1", "A", "B", "C", "xy1"));
    s.commit("1", "1");
    s.write("file", s.lines("xy2", "A", "B", "xy2", "C", "xy2"));
    const rev2 = s.commit("2", "2");
    s.write("file", s.lines("xy3", "A"));
    const rev3 = s.commit("3", "3");
    m.push(...(await s.compare("file", ["--ignore-rev", rev2, "--ignore-rev", rev3])));
    // "position matching"
    s.write("file2", s.lines("abc", "def"));
    s.commit("1", "1");
    s.write("file2", s.lines("abc", "def", "abc", "def"));
    s.commit("2", "2");
    s.write("file2", s.lines("abcx", "defx", "abcx", "defx"));
    const p3 = s.commit("3", "3");
    s.write("file2", s.lines("abcy", "defy", "abcx", "defx"));
    const p4 = s.commit("4", "4");
    m.push(...(await s.compare("file2", ["--ignore-rev", p3, "--ignore-rev", p4])));
    // "preserve order"
    s.write("file3", s.lines("bcde"));
    s.commit("1", "1");
    s.write("file3", s.lines("bcde", "fghij"));
    s.commit("2", "2");
    s.write("file3", s.lines("bcde", "fghij", "abcd"));
    s.commit("3", "3");
    s.write("file3", s.lines("abcdx", "fghijx", "bcdex"));
    const o4 = s.commit("4", "4");
    s.write("file3", s.lines("abcdx", "fghijy", "bcdex"));
    const o5 = s.commit("5", "5");
    m.push(...(await s.compare("file3", ["--ignore-rev", o4, "--ignore-rev", o5])));
    check(m);
  }, 60_000);
});

describeGit("JGit BlameGeneratorTest ignore scenarios against native git", () => {
  const FILE = "file.txt";

  /** A history of FILE's versions (lines), one commit each, the commits' ids returned */
  function linear(name: string, versions: string[][]) {
    const s = scenario(name);
    const ids = versions.map((v, i) => {
      s.write(FILE, s.lines(...v));
      return s.commit(`c${i + 1}`);
    });
    return { s, ids };
  }

  it("BlameGeneratorTest: testBlameIgnoreSingleRevision, testBlameCommandWithIgnoreRevs, testBlameIgnoreMultipleRevisions, testBlameIgnoreNonModifyingRevision, testBlameIgnoreWithLineCountChange, testBlameIgnoreLargeInsertion, testBlameIgnoreRootCommit, testBlameIgnoreContiguousBlockReformat, testBlameIgnoreWithEmptySet", async () => {
    const m: string[] = [];
    const run = async (name: string, versions: string[][], ignored: number[][]) => {
      const { s, ids } = linear(name, versions);
      s.git(["config", "blame.markUnblamableLines", "true"]);
      s.git(["config", "blame.markIgnoredLines", "true"]);
      for (const set of ignored) {
        const args = set.flatMap((i) => ["--ignore-rev", ids[i]]);
        m.push(...(await s.compare(FILE, args, ALL_FORMATS)));
      }
    };
    await run("single", [["a"], ["a", "b"], ["a", "b", "c"]], [[1], []]);
    await run("multiple", [["1"], ["1", "2"], ["1", "2", "3"], ["1", "2", "3", "4"]], [[1, 2]]);
    await run("nonmodifying", [["A"], ["A", "B"], ["A prime", "B"]], [[1], [2]]);
    await run(
      "linecount",
      [
        ["body1", "body2"],
        ["// Header 1", "// Header 2", "// Header 3", "body1 formatted", "body2"],
        ["// Header 1", "// Header 2", "// Header 3", "body1 formatted", "body2", "footer"],
      ],
      [[1]],
    );
    const ins = Array.from({ length: 10 }, (_, i) => `ins${i + 1}`);
    await run(
      "large",
      [
        ["line1", "line2"],
        ["line1", ...ins, "line2"],
        ["line1", ...ins, "line2 modified"],
      ],
      [[1]],
    );
    await run("root", [["root line"]], [[0]]);
    const ten = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const reformatted = ten.map((l, i) => (i >= 2 && i <= 6 ? `  ${l} formatted` : l));
    await run(
      "reformat",
      [ten, reformatted, [...reformatted.slice(0, 9), "line 10 modified"]],
      [[1]],
    );
    check(m);
  }, 60_000);

  it("BlameGeneratorTest: testBlameIgnoreMergeCommit, testBlameIgnoreMergeCommitMultipleRegions, testBlameIgnoreMergeCommitBothBranches, testBlameIgnoreMergeCommitWithConflictResolution, testBlameIgnoreWithRename", async () => {
    const m: string[] = [];
    /** base, a side branch and a main change, merged with the given content */
    const merge = async (
      name: string,
      base: string[],
      side: string[],
      main: string[],
      merged: string[],
    ) => {
      const s = scenario(name);
      s.git(["config", "blame.markUnblamableLines", "true"]);
      s.git(["config", "blame.markIgnoredLines", "true"]);
      s.write(FILE, s.lines(...base));
      const c1 = s.commit("c1");
      s.git(["checkout", "-q", "-b", "a"]);
      s.write(FILE, s.lines(...side));
      const c2 = s.commit("c2");
      s.git(["checkout", "-q", "main"]);
      s.write(FILE, s.lines(...main));
      const c3 = s.commit("c3");
      git(s.dir, ["merge", "-q", "--no-commit", "-s", "ours", "a"], undefined, tickEnv("M", 20));
      s.write(FILE, s.lines(...merged));
      const c4 = s.commit("c4");
      for (const id of [c1, c2, c3, c4]) {
        m.push(...(await s.compare(FILE, ["--ignore-rev", id], ALL_FORMATS)));
      }
      m.push(...(await s.compare(FILE, ["--ignore-rev", c2, "--ignore-rev", c4])));
    };
    await merge("merge", ["base"], ["base", "a"], ["base", "b"], ["base", "a"]);
    await merge(
      "regions",
      ["1", "2", "3", "4", "5"],
      ["1_mod", "2", "3", "4", "5"],
      ["1", "2", "3", "4", "5_mod"],
      ["1_mod", "2", "3", "4", "5_mod"],
    );
    await merge(
      "both",
      ["header", "body", "footer"],
      ["header branch1", "body", "footer"],
      ["header", "body", "footer branch2"],
      ["header branch1", "body", "footer branch2"],
    );
    await merge(
      "conflict",
      ["line1", "line2"],
      ["line1 branch1", "line2"],
      ["line1 branch2", "line2"],
      ["line1 conflict resolved", "line2"],
    );
    // testBlameIgnoreWithRename
    const s = scenario("rename");
    s.write("OldFile.txt", s.lines("line1", "line2", "line3", "line4", "line5"));
    s.commit("c1: create OldFile");
    s.git(["rm", "-q", "OldFile.txt"]);
    s.write("NewFile.txt", s.lines("line1 formatted", "line2", "line3", "line4", "line5"));
    const c2 = s.commit("c2: rename and format");
    s.write("NewFile.txt", s.lines("line1 formatted", "line2 modified", "line3", "line4", "line5"));
    s.commit("c3: edit line2");
    m.push(...(await s.compare("NewFile.txt", ["--ignore-rev", c2], ALL_FORMATS)));
    check(m);
  }, 120_000);
});

/** A random history of one file, its lines edited, moved, reworded and re-indented */
function buildHistory(dir: string, seed: number): string[] {
  const r = prng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const words = ["alpha", "beta", "gamma", "delta", "value", "count", "index", "result"];
  let counter = 0;
  const line = () =>
    r() < 0.15
      ? pick(["}", "", "{", "return;"])
      : `${pick(["int", "let", "call"])} ${pick(words)}${counter++} = ${pick(words)}(${pick(words)});`;
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  const ids: string[] = [];
  let lines = Array.from({ length: 6 + Math.floor(r() * 10) }, line);
  let date = 1_600_000_000;
  const commit = (parents: string[], text: string[]) => {
    writeFileSync(join(dir, "f.c"), text.map((l) => `${l}\n`).join(""));
    const blob = git(dir, ["hash-object", "-w", "f.c"]);
    const tree = git(dir, ["mktree"], `100644 blob ${blob}\tf.c\n`);
    date += 60 + Math.floor(r() * 600);
    const env = {
      GIT_AUTHOR_NAME: pick(["Alice", "Bob", "Carol"]),
      GIT_AUTHOR_EMAIL: "a@example.com",
      GIT_AUTHOR_DATE: `${date} +0000`,
      GIT_COMMITTER_NAME: "C",
      GIT_COMMITTER_EMAIL: "c@example.com",
      GIT_COMMITTER_DATE: `${date} +0000`,
    };
    const id = git(
      dir,
      ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])],
      `c${ids.length}\n`,
      env,
    );
    ids.push(id);
    return id;
  };
  commit([], lines);
  const count = 4 + Math.floor(r() * 8);
  for (let k = 0; k < count; k++) {
    lines = [...lines];
    for (let o = 1 + Math.floor(r() * 4); o > 0; o--) {
      const at = Math.floor(r() * (lines.length + 1));
      const op = r();
      if (op < 0.3 && lines.length) {
        // reword a few lines (the fuzzy matcher's case)
        for (let i = at; i < Math.min(lines.length, at + 1 + Math.floor(r() * 3)); i++) {
          lines[i] = r() < 0.5 ? `  ${lines[i]}` : lines[i].replace(/[a-z]+/, pick(words));
        }
      } else if (op < 0.5)
        lines.splice(at, 0, ...Array.from({ length: 1 + Math.floor(r() * 3) }, line));
      else if (op < 0.65) lines.splice(at, 1 + Math.floor(r() * 2));
      else if (op < 0.8 && lines.length > 2) {
        // join two lines
        const i = Math.min(at, lines.length - 2);
        lines.splice(i, 2, `${lines[i]} ${lines[i + 1]}`);
      } else if (op < 0.9 && lines.length) {
        // split a line
        const i = Math.min(at, lines.length - 1);
        const half = Math.floor(lines[i].length / 2);
        lines.splice(i, 1, lines[i].slice(0, half), lines[i].slice(half));
      } else {
        const taken = lines.splice(at, 2);
        lines.splice(Math.floor(r() * (lines.length + 1)), 0, ...taken);
      }
    }
    const parent = ids[ids.length - 1];
    if (r() < 0.15 && ids.length > 2) {
      const other = pick(ids.slice(0, -1));
      commit([parent, other], lines);
    } else commit([parent], lines);
  }
  git(dir, ["update-ref", "refs/heads/main", ids[ids.length - 1]]);
  return ids;
}

describeGit("git blame --ignore-rev against native git on random histories", () => {
  it(`matches git blame on ${SEEDS} histories with random commits ignored`, async () => {
    const m: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const dir = join(tmp(), `h-${seed}`);
      const ids = buildHistory(dir, seed);
      const r = prng(seed * 7919);
      if (seed % 2) {
        git(dir, ["config", "blame.markUnblamableLines", "true"]);
        git(dir, ["config", "blame.markIgnoredLines", "true"]);
      }
      const ours = await open(dir);
      for (let k = 0; k < 4; k++) {
        const ignored = ids.filter(() => r() < 0.4);
        const args = ignored.flatMap((id) => ["--ignore-rev", id]);
        const extra = [[], ["-w"], ["-M"], ["-C", "-C"]][k];
        m.push(
          ...(
            await compareBlame(tmp(), dir, ours, "f.c", [...extra, ...args], {
              rev: "HEAD",
              formats: [["--porcelain"], []],
            })
          ).map((x) => `seed ${seed}: ${x}`),
        );
      }
      rmSync(dir, { recursive: true, force: true });
    }
    check(m);
  }, 600_000);
});
