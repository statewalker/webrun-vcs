// Tests of scripts/t-coverage.mjs: node --test scripts/t-coverage.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildReport,
  cachedGitSource,
  extractCitations,
  formatMarkdown,
  matchCitation,
  parseTitles,
} from "./t-coverage.mjs";

describe("parseTitles", () => {
  it("reads titles with and without prerequisites, quoted either way", () => {
    const src = [
      "test_expect_success 'setup' '",
      "\tgit init",
      "'",
      'test_expect_success SYMLINKS,!MINGW "symlinked file" \'',
      "'",
      "test_expect_failure 'known breakage' 'false'",
      "test_expect_success setup '",
      "'",
      'test_expect_success $REQUIRE_64BIT_TIME "parse date ($1) -> $2" "',
      '"',
      'test_expect_success lazy "test_have_prereq LAZY && echo trace"',
      "test_expect_success 'heredoc body' - <<\\EOF",
      "EOF",
      "test_expect_success 'it'\\''s quoted' '",
      "'",
      "test_expect_success_multi 'a wrapper' '' '",
      "'",
    ].join("\n");
    assert.deepEqual(
      parseTitles(src).map(({ title, line, dynamic, expectFailure }) => [
        title,
        line,
        dynamic,
        expectFailure,
      ]),
      [
        ["setup", 1, false, false],
        ["symlinked file", 4, false, false],
        ["known breakage", 6, false, true],
        ["setup", 7, false, false],
        ["parse date ($1) -> $2", 9, true, false],
        ["lazy", 11, false, false],
        ["heredoc body", 12, false, false],
        ["it's quoted", 14, false, false],
      ],
    );
  });

  it("joins a title continued on the next line", () => {
    const src = ["\ttest_expect_success \\", "\t\t'continued title' '", "\t'"].join("\n");
    assert.deepEqual(
      parseTitles(src).map((t) => t.title),
      ["continued title"],
    );
  });
});

describe("extractCitations", () => {
  it("reads a script reference and the quoted titles that follow it", () => {
    const src = [
      "it('t0008-ignores.sh: \"local ignore inside a sub-directory\"', async () => {",
      "  // t7700-repack 'objects in packs marked .keep are not in new packs'",
      '  it("t5325 \\"fsck catches invalid row position\\"", () => {});',
      '/** t7509 "--author", "--date" and t7501 "commit --date" */',
      'it("t3200: --track and branch.autoSetupMerge", () => run(["branch", "--track"]));',
      '// t7513 "commit --trailer with -c and ..."',
      "/** t4202's six commits, t7810's 'authors' */",
    ].join("\n");
    assert.deepEqual(
      extractCitations(src, "x.test.ts").map(({ script, title, line }) => [script, title, line]),
      [
        ["t0008", "local ignore inside a sub-directory", 1],
        ["t7700", "objects in packs marked .keep are not in new packs", 2],
        ["t5325", "fsck catches invalid row position", 3],
        ["t7509", "--author", 4],
        ["t7509", "--date", 4],
        ["t7501", "commit --date", 4],
        ["t3200", null, 5],
        ["t7513", "commit --trailer with -c and ...", 6],
        ["t4202", null, 7],
        ["t7810", null, 7],
      ],
    );
  });

  it("ignores numbers that are not script references", () => {
    const src = 'const t = 1700000000; expect("t12345").toBe(at1234); // st1234 ut0000x';
    assert.deepEqual(extractCitations(src, "x.test.ts"), []);
  });
});

describe("matchCitation", () => {
  const titles = [
    'commit --trailer with -c and "replace" as ifexists',
    'commit --trailer with -c and "add" as ifexists',
    "--signoff",
    "--signoff with -F",
    "parse date ($1) -> $2",
  ].map((title, i) => ({ title, line: i + 1, dynamic: title.includes("$") }));

  it("prefers an exact title", () => {
    assert.deepEqual(matchCitation(titles, "--signoff"), { status: "matched", indexes: [2] });
  });

  it("matches a unique substring, case and spacing aside", () => {
    assert.deepEqual(matchCitation(titles, "SIGNOFF  with"), { status: "matched", indexes: [3] });
  });

  it("reports a citation several titles hold as ambiguous", () => {
    assert.deepEqual(matchCitation(titles, "commit --trailer with -c and ..."), {
      status: "ambiguous",
      indexes: [0, 1],
    });
  });

  it("matches a dynamic title's variables as anything", () => {
    assert.deepEqual(matchCitation(titles, "parse date (2006-07-03) -> 1151884800"), {
      status: "matched",
      indexes: [4],
    });
  });

  it("never takes a title made of variables alone as matching anything", () => {
    const loose = [
      { title: "$title", line: 1, dynamic: true },
      { title: "$1 ($2)", line: 2, dynamic: true },
    ];
    assert.deepEqual(matchCitation(loose, "zzqq a paraphrased title"), {
      status: "unresolved",
      indexes: [],
    });
  });

  it("reports what matches nothing", () => {
    assert.deepEqual(matchCitation(titles, "no such test"), { status: "unresolved", indexes: [] });
  });
});

describe("buildReport", () => {
  const upstream = new Map([
    ["t0008", { name: "t0008-ignores", titles: titled(["setup", "one", "two", "three"]) }],
    ["t1000", { name: "t1000-read-tree-m-3way", titles: titled(["a", "b"]) }],
    ["t9100", { name: "t9100-git-svn-basic", titles: titled(["svn"]) }],
  ]);
  const scope = { outOfScope: [{ prefix: "t91", reason: "git-svn bridge" }] };
  const citations = [
    { script: "t0008", title: "one", file: "a.test.ts", line: 1 },
    { script: "t0008", title: "one", file: "b.test.ts", line: 9 },
    { script: "t0008", title: "TWO", file: "a.test.ts", line: 2 },
    { script: "t0008", title: "missing", file: "a.test.ts", line: 3 },
    { script: "t0008", title: null, file: "c.test.ts", line: 1 },
    { script: "t4242", title: "x", file: "a.test.ts", line: 4 },
    { script: "t9100", title: "svn", file: "a.test.ts", line: 5 },
  ];
  const report = buildReport({ upstream, citations, scope, gitVersion: "v0", testFiles: 3 });

  it("counts each upstream test once, however often it is cited", () => {
    const t0008 = report.scripts.find((s) => s.script === "t0008");
    assert.equal(t0008.tests, 4);
    assert.equal(t0008.ported, 2);
    assert.deepEqual(t0008.portedTitles, ["one", "two"]);
    assert.deepEqual(t0008.files, ["a.test.ts", "b.test.ts", "c.test.ts"]);
  });

  it("keeps out-of-scope scripts out of the in-scope totals", () => {
    assert.deepEqual(report.totals, {
      scripts: 3,
      tests: 7,
      inScopeScripts: 2,
      inScopeTests: 6,
      citedScripts: 1,
      citedScriptTests: 4,
      portedTests: 2,
      outOfScopeScripts: 1,
      outOfScopeTests: 1,
    });
    assert.equal(report.scripts.find((s) => s.script === "t9100").outOfScope, "git-svn bridge");
  });

  it("groups by family", () => {
    assert.deepEqual(
      report.families.map((f) => [f.family, f.inScopeTests, f.portedTests, f.citedScripts]),
      [
        ["t0", 4, 2, 1],
        ["t1", 2, 0, 0],
        ["t9", 0, 0, 0],
      ],
    );
  });

  it("lists the citations to fix", () => {
    assert.deepEqual(
      report.problems.map((p) => [p.kind, p.script, p.title, `${p.file}:${p.line}`]),
      [
        ["unresolved", "t0008", "missing", "a.test.ts:3"],
        ["unknown-script", "t4242", "x", "a.test.ts:4"],
      ],
    );
  });

  it("renders a Markdown report", () => {
    const md = formatMarkdown(report);
    assert.match(md, /2 of 6 in-scope upstream tests \(33\.3%\)/);
    assert.match(md, /\*\*Cited scripts hold\*\* 4 in-scope tests \(66\.7%\)/);
    assert.match(md, /\| t0008-ignores \| 4 \| 2 \| 50\.0% \| 3 \|/);
    assert.match(md, /`a\.test\.ts:3` t0008 "missing": unresolved/);
  });
});

describe("cachedGitSource", () => {
  it("recovers from a clone interrupted before its checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "t-coverage-"));
    try {
      const dir = join(root, "v1");
      let failCheckout = true;
      const git = (...args) => {
        const target = args[0] === "-C" ? args[1] : args.at(-1);
        if (args[0] === "clone") mkdirSync(join(target, ".git"), { recursive: true });
        if (args.includes("checkout")) {
          if (failCheckout) throw new Error("network dropped");
          mkdirSync(join(target, "t"));
          writeFileSync(join(target, "t", "t0000-basic.sh"), "");
        }
      };
      assert.throws(() => cachedGitSource(dir, "v1", git), /network dropped/);
      assert.equal(existsSync(join(dir, "t")), false);
      failCheckout = false;
      assert.equal(cachedGitSource(dir, "v1", git), dir);
      assert.equal(existsSync(join(dir, "t", "t0000-basic.sh")), true);
      assert.equal(existsSync(`${dir}.partial`), false);
      // Made once: a later call clones nothing.
      assert.equal(
        cachedGitSource(dir, "v1", () => assert.fail("cloned again")),
        dir,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function titled(list) {
  return list.map((title, i) => ({ title, line: i + 1, dynamic: false, expectFailure: false }));
}
