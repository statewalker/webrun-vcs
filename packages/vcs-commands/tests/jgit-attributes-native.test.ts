/**
 * JGit's attribute tests as native twins: the patterns and paths of JGit's
 * `AttributesMatcherTest` and `CGitAttributesTest` (org.eclipse.jgit.test, `attributes/`), with
 * native `git check-attr` deciding every expected result (statewalker/webrun-vcs#218). Only
 * JGit's inputs are taken: each pattern goes into a `.gitattributes` of a fresh repository and
 * each path is asked through `check-attr --stdin -z`, on native git and on ours.
 *
 * JGit's matcher asks paths with a leading `/` (its tree-walk form) and marks a directory by
 * a trailing `/`; `check-attr` takes a leading `/` as an absolute path, so the leading slash
 * is dropped and the trailing one kept (git's `check-attr` reads a path ending in `/` as a
 * directory, as JGit's `CGitAttributesTest` notes).
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

let root = "";
let counter = 0;

/** A fresh repository holding `files` (latin1 contents). */
function repository(files: Record<string, string>): string {
  const dir = join(root, `r${counter++}`);
  mkdirSync(dir);
  git(root, dir, ["init", "-q", "-b", "main"]);
  writeFiles(dir, files);
  return dir;
}

function nativeCheckAttr(dir: string, attrs: string[], paths: string[]): Outcome {
  const args = ["check-attr", "--stdin", "-z", ...(attrs.length ? attrs : ["-a"])];
  const r = spawnSync("git", args, {
    cwd: dir,
    env: plumbingEnv(root),
    encoding: "latin1",
    input: Buffer.from(paths.map((p) => `${p}\0`).join(""), "latin1"),
  });
  return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
}

async function oursCheckAttr(dir: string, attrs: string[], paths: string[]): Promise<Outcome> {
  const environment = createNodeGitHostEnvironment({ env: plumbingEnv(root) });
  const g = await openOurs(dir, environment);
  const cmd = g.checkAttr().setCompatibility(nativeCompatibility()).setNulTerminated(true);
  if (attrs.length === 0) cmd.setAll(true);
  for (const a of attrs) cmd.addAttribute(a);
  cmd.setStdin(Buffer.from(paths.map((p) => `${p}\0`).join(""), "latin1"));
  return outcomeOf(await cmd.call());
}

/** check-attr of `paths` on both, compared; native's outcome. */
async function twin(dir: string, attrs: string[], paths: string[], label: string) {
  const n = nativeCheckAttr(dir, attrs, paths);
  expect(await oursCheckAttr(dir, attrs, paths), label).toEqual(n);
  return n;
}

/** The attribute `test` set by `pattern` (no leading-slash path), on each path. */
async function matcherTwin(source: string, pattern: string, targets: string[]) {
  const dir = repository({ ".gitattributes": `${pattern} test\n` });
  const paths = targets.map((t) => (t.startsWith("/") ? t.slice(1) : t));
  const n = await twin(dir, ["test"], paths, `${source}: ${pattern}`);
  expect(n.status, `${source}: ${pattern}: ${n.err}`).toBe(0);
}

/** A tree of files and a `.gitattributes`, every file and directory asked with `-a`. */
async function cgitTwin(source: string, files: string[], attributes: Record<string, string>) {
  const content: Record<string, string> = { ...attributes };
  for (const f of files) content[f] = "x";
  const dir = repository(content);
  // every file and directory, directories with a trailing slash (JGit's tree walk)
  const paths = new Set<string>();
  for (const f of Object.keys(content)) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) paths.add(`${parts.slice(0, i).join("/")}/`);
    paths.add(f);
  }
  const sorted = [...paths].sort();
  const n = await twin(dir, [], sorted, source);
  expect(n.status, `${source}: ${n.err}`).toBe(0);
}

describeGit("JGit AttributesMatcherTest against native check-attr", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "jgit-attributes-"));
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it("JGit AttributesMatcherTest#testBasic", async () => {
    await matcherTwin("testBasic", "/test.stp", ["/test.stp"]);
    await matcherTwin("testBasic", "#/test.stp", ["/test.stp"]);
  });

  it("JGit AttributesMatcherTest#testFileNameWildcards", async () => {
    const src = "testFileNameWildcards";
    const stTargets = [
      "/test.stp",
      "/anothertest.stg",
      "/anothertest.st0",
      "/anothertest.sta1",
      "/another/test.sta1",
    ];
    await matcherTwin(src, "*.st?", stTargets);
    await matcherTwin(src, "/*.st?", stTargets);
    await matcherTwin(src, "*.sta[0-5]", [
      "/test.sta5",
      "/test.sta4",
      "/test.sta3",
      "/test.sta2",
      "/test.sta1",
      "/test.sta0",
      "/anothertest.sta2",
      "test.stag",
      "test.sta6",
    ]);
    await matcherTwin(src, "/[tv]est.sta[a-d]", [
      "/test.staa",
      "/test.stab",
      "/test.stac",
      "/test.stad",
      "/vest.stac",
      "test.stae",
      "test.sta9",
    ]);
    const neTargets = ["/src/new/", "/src/new", "/src/new/a.c", "/src/new/a/a.c", "/src/new.c"];
    await matcherTwin(src, "/src/ne?", neTargets);
    await matcherTwin(src, "ne?", [...neTargets, "/neb"]);
  });

  it("JGit AttributesMatcherTest#testTargetWithoutLeadingSlash", async () => {
    const src = "testTargetWithoutLeadingSlash";
    await matcherTwin(src, "/*.st?", [
      "test.stp",
      "anothertest.stg",
      "anothertest.st0",
      "anothertest.sta1",
      "another/test.sta1",
    ]);
    await matcherTwin(src, "/*.sta[0-5]", [
      "test.sta5",
      "test.sta4",
      "test.sta3",
      "test.sta2",
      "test.sta1",
      "test.sta0",
      "anothertest.sta2",
      "test.stag",
      "test.sta6",
    ]);
    await matcherTwin(src, "/[tv]est.sta[a-d]", [
      "test.staa",
      "test.stab",
      "test.stac",
      "test.stad",
      "vest.stac",
      "test.stae",
      "test.sta9",
    ]);
    const neTargets = ["src/new/", "src/new", "src/new/a.c", "src/new/a/a.c", "src/new.c"];
    await matcherTwin(src, "/src/ne?", neTargets);
    await matcherTwin(src, "ne?", [...neTargets, "neb"]);
  });

  it("JGit AttributesMatcherTest#testParentDirectoryGitAttributes", async () => {
    const src = "testParentDirectoryGitAttributes";
    await matcherTwin(src, "/*/*.c", ["/file/a.c", "/src/a.c", "/src/new/a.c"]);
    const newTargets = ["/src/new/", "/src/new", "/src/new/a.c", "/src/new/a/a.c", "/src/new.c"];
    await matcherTwin(src, "/src/new", newTargets);
    await matcherTwin(src, "/src/new/", newTargets);
    await matcherTwin(src, "b1", [
      "/src/new/a/b1/a.c",
      "/src/new/a/b2/file.c",
      "/src/new/a/bb1/file.c",
      "/src/new/a/file.c",
      "/src/new/a/bb1",
      "/src/new/a/b1",
    ]);
  });

  it("JGit AttributesMatcherTest#testTrailingSlash", async () => {
    const src = "testTrailingSlash";
    await matcherTwin(src, "/src/", [
      "/src/",
      "/src/new",
      "/src/new/a.c",
      "/src/a.c",
      "/src",
      "/srcA/",
    ]);
    await matcherTwin(src, "src/", [
      "src/",
      "/src/",
      "src",
      "/src/new",
      "/src/new/a.c",
      "/src/a.c",
      "foo/src/a.c",
      "foo/src/bar/a.c",
      "foo/src/bar/src",
      "foo/src/",
      "foo/src/bar/src/",
    ]);
  });

  it("JGit AttributesMatcherTest#testNameOnlyMatches", async () => {
    const src = "testNameOnlyMatches";
    await matcherTwin(src, "*.stp", [
      "/test.stp",
      "/src/test.stp",
      "/test.stp1",
      "/test.astp",
      "test.stp/foo.bar",
      "test.stp",
      "test.stp/",
      "test.stp/test.stp",
    ]);
    await matcherTwin(src, "src", [
      "/src",
      "/src/",
      "/src/a.c",
      "/src/new/a.c",
      "/new/src/a.c",
      "/file/src",
    ]);
    await matcherTwin(src, "src/", [
      "/src/a.c",
      "/src/new/a.c",
      "/new/src/a.c",
      "/src",
      "/file/src",
      "/file/src/",
    ]);
    await matcherTwin(src, "?rc", [
      "/src/a.c",
      "/src/new/a.c",
      "/new/src/a.c",
      "/new/src/",
      "/file/src",
      "/src/",
    ]);
    await matcherTwin(src, "?r[a-c]", [
      "/src/a.c",
      "/src/new/a.c",
      "/new/src/a.c",
      "/file/src",
      "/src/",
      "/srb/a.c",
      "/grb/new/a.c",
      "/new/crb/a.c",
      "/file/3rb",
      "/xrb/",
      "/3ra/a.c",
      "/5ra/new/a.c",
      "/new/1ra/a.c",
      "/new/1ra/a.c/",
      "/file/dra",
      "/file/dra/",
      "/era/",
      "/crg",
      "/cr3",
    ]);
  });

  it("JGit AttributesMatcherTest#testGetters", async () => {
    // JGit's rules as gitattributes lines: the attributes git reads from each
    const lines: [string, string][] = [
      ["/pattern/", ""],
      ["/patter?/", ""],
      ["patt*", ""],
      ["pattern", "attribute1"],
      ["pattern", "attribute1 -attribute2"],
      ["pattern", "attribute1 \t-attribute2 \t"],
      ["pattern", "attribute1\t-attribute2\t"],
      ["pattern", "attribute1\t -attribute2\t "],
      ["pattern", "attribute1 -attribute2  attribute3=value "],
    ];
    for (const [pattern, attrs] of lines) {
      const dir = repository({ ".gitattributes": `${pattern} ${attrs}\n` });
      const n = await twin(
        dir,
        [],
        ["pattern", "pattern/", "patterx/", "pattxyz"],
        `testGetters: ${pattern} ${attrs}`,
      );
      expect(n.status).toBe(0);
    }
  });

  it("JGit AttributesMatcherTest#testBracketsInGroup", async () => {
    const src = "testBracketsInGroup";
    const targets = ["[]", "][", "[\\[]", "[[]", "[[]]", "[\\[\\]]", "[", "]"];
    for (const pattern of ["[[\\]]", "[\\[\\]]", "[[]]", "[\\[]]"])
      await matcherTwin(src, pattern, targets);
    // JGit also asks the empty path: check-attr refuses it
    const dir = repository({ ".gitattributes": "[[\\]] test\n" });
    await twin(dir, ["test"], [""], `${src}: empty path`);
  });

  it("JGit AttributesMatcherTest#testFileNameWithLineTerminator", async () => {
    const src = "testFileNameWithLineTerminator";
    await matcherTwin(src, "a?", ["a\r", "dir/a\r"]);
    await matcherTwin(src, "*a", ["\ra"]);
    await matcherTwin(src, "dir/*a*", ["dir/\ra\r"]);
  });
});

describeGit("JGit CGitAttributesTest against native check-attr", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "jgit-cgit-attributes-"));
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  const cases: [string, string[], Record<string, string>][] = [
    [
      "testBug508568",
      ["foo.xml/bar.jar", "sub/foo.xml/bar.jar"],
      { ".gitattributes": "*.xml xml\n*.jar jar\n" },
    ],
    ["testRelativePath", ["sub/foo.txt"], { "sub/.gitattributes": "sub/** sub\n*.txt txt\n" }],
    [
      "testRelativePaths",
      ["sub/foo.txt", "sub/sub/bar", "foo/sub/a.txt", "foo/sub/bar/a.tmp"],
      { ".gitattributes": "sub/** sub\n*.txt txt\n" },
    ],
    [
      "testNestedMatchNot",
      ["foo.xml/bar.jar", "foo.xml/bar.xml", "sub/b.jar", "sub/b.xml"],
      { "sub/.gitattributes": "*.xml xml\n*.jar jar\n" },
    ],
    [
      "testNestedMatch",
      ["foo/bar.jar", "foo/bar.xml", "sub/b.jar", "sub/b.xml", "sub/foo/b.jar"],
      { ".gitattributes": "foo/ xml\nsub/foo/ sub\n*.jar jar\n" },
    ],
    [
      "testNestedMatchWithWildcard",
      ["foo/bar.jar", "foo/bar.xml", "sub/b.jar", "sub/b.xml", "sub/foo/b.jar"],
      { ".gitattributes": "**/foo/ xml\n*/foo/ sub\n*.jar jar\n" },
    ],
    [
      "testNestedMatchRecursive",
      ["foo/bar.jar", "foo/bar.xml", "sub/b.jar", "sub/b.xml", "sub/foo/b.jar"],
      { ".gitattributes": "foo/** xml\n*.jar jar\n" },
    ],
    [
      "testStarMatchOnSlashNot",
      ["sub/a.txt", "foo/sext", "foo/s.txt"],
      { ".gitattributes": "s*xt bar" },
    ],
    ["testPrefixMatchNot", ["src/new/foo.txt"], { ".gitattributes": "src/new bar\n" }],
    [
      "testComplexPathMatchNot",
      ["src/new/foo.txt", "src/ndw"],
      { ".gitattributes": "s[p-s]c/n[de]w bar\n" },
    ],
    ["testStarPathMatchNot", ["src/new/foo.txt", "src/ndw"], { ".gitattributes": "src/* bar\n" }],
    [
      "testDirectoryMatchSubSimple",
      ["src/new/foo.txt", "foo/src/new/foo.txt", "sub/src/new"],
      { ".gitattributes": "src/new/ bar\n" },
    ],
    [
      "testDirectoryMatchSubRecursive",
      ["src/new/foo.txt", "foo/src/new/foo.txt", "sub/src/new"],
      { ".gitattributes": "**/src/new/ bar\n" },
    ],
    [
      "testDirectoryMatchSubRecursiveBacktrack",
      ["src/new/foo.txt", "src/src/new/foo.txt"],
      { ".gitattributes": "**/src/new/ bar\n" },
    ],
    [
      "testDirectoryMatchSubRecursiveBacktrack2",
      ["src/new/foo.txt", "src/src/new/foo.txt"],
      { ".gitattributes": "**/**/src/new/ bar\n" },
    ],
    [
      "testDirectoryMatchSubRecursiveBacktrack3",
      ["src/new/src/new/foo.txt", "foo/src/new/bar/src/new/foo.txt"],
      { ".gitattributes": "**/src/new/ bar\n" },
    ],
    [
      "testDirectoryMatchSubRecursiveBacktrack4",
      ["src/src/src/new/foo.txt", "foo/src/src/bar/src/new/foo.txt"],
      { ".gitattributes": "**/src/ bar\n" },
    ],
    [
      "testDirectoryMatchSubRecursiveBacktrack5",
      [
        "x/a/a/b/foo.txt",
        "x/y/z/b/a/b/foo.txt",
        "x/y/a/a/a/a/b/foo.txt",
        "x/y/a/a/a/a/b/a/b/foo.txt",
      ],
      { ".gitattributes": "**/*/a/b bar\n" },
    ],
    [
      "testDirectoryMatchSubRecursiveBacktrack6",
      ["x/a/a/b/foo.txt", "x/y/a/b/a/b/foo.txt"],
      { ".gitattributes": "**/*/**/a/b bar\n" },
    ],
    [
      "testDirectoryWildmatchDoesNotMatchFiles1",
      ["a", "dir/b", "dir/sub/c"],
      { ".gitattributes": "**/ bar\n" },
    ],
    [
      "testDirectoryWildmatchDoesNotMatchFiles2",
      ["a", "dir/b", "dir/sub/c"],
      { ".gitattributes": "**/**/ bar\n" },
    ],
    [
      "testDirectoryWildmatchDoesNotMatchFiles3",
      ["a", "x/b", "sub/x/c", "sub/x/d/e"],
      { ".gitattributes": "x/**/ bar\n" },
    ],
    [
      "testDirectoryWildmatchDoesNotMatchFiles4",
      ["a", "dir/x", "dir/sub1/x", "dir/sub2/x/y"],
      { ".gitattributes": "x/**/ bar\n" },
    ],
    [
      "testDirectoryMatchSubComplex",
      ["src/new/foo.txt", "foo/src/new/foo.txt", "sub/src/new"],
      { ".gitattributes": "s[rs]c/n*/ bar\n" },
    ],
    [
      "testDirectoryMatch",
      ["src/new/foo.txt", "foo/src/new/foo.txt", "sub/src/new"],
      { ".gitattributes": "new/ bar\n" },
    ],
    [
      "testBracketsInGroup",
      ["[", "]", "[]", "][", "[[]", "[]]", "[[]]"],
      { ".gitattributes": "[[]] bar1\n[\\[]] bar2\n[[\\]] bar3\n[\\[\\]] bar4\n" },
    ],
  ];

  for (const [name, files, attributes] of cases) {
    it(`JGit CGitAttributesTest#${name}`, async () => {
      await cgitTwin(name, files, attributes);
    });
  }
});
