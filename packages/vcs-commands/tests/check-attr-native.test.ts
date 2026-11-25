/**
 * `git check-attr` against native git: the scenarios of git's t0003-attributes.sh (quoted
 * patterns, macros, nested `.gitattributes`, `core.ignorecase`, unnormalized and relative
 * paths, `core.attributesFile`, `--stdin`, `--all`, `--cached`, `--source`, `attr.tree` and
 * `GIT_ATTR_SOURCE`, bare repositories and `info/attributes`, the `binary` macro under `-a`,
 * `builtin_objectmode` in git 2.5x, argument errors), plus `-z`. Each runs on native git and
 * on ours in the same repository. Run with the system git (2.43) and with 2.56.1 first on
 * `PATH`.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
  openBare,
  outcomeOf,
  plumbingEnv,
  writeFiles,
} from "./plumbing-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root = "";
let repo = "";

interface Run {
  /** check-attr's arguments */
  args: string[];
  /** stdin (latin1) */
  stdin?: string;
  /** `git -c` settings */
  config?: [string, string][];
  /** more variables */
  env?: Record<string, string>;
  /** the directory git runs in, below the repository */
  cwd?: string;
  /** the repository (default the test's) */
  dir?: string;
  bare?: boolean;
}

function envOf(run: Run): Record<string, string> {
  const base: Record<string, string> = plumbingEnv(root, run.env);
  const config = run.config ?? [];
  const count = Number(base.GIT_CONFIG_COUNT ?? "0");
  const env: Record<string, string> = { ...base, GIT_CONFIG_COUNT: String(count + config.length) };
  config.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${count + i}`] = k;
    env[`GIT_CONFIG_VALUE_${count + i}`] = v;
  });
  return env;
}

function nativeRun(run: Run): Outcome {
  const dir = run.dir ?? repo;
  const r = spawnSync("git", ["check-attr", ...run.args], {
    cwd: run.cwd ? join(dir, run.cwd) : dir,
    env: envOf(run),
    encoding: "latin1",
    input: Buffer.from(run.stdin ?? "", "latin1"),
  });
  return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
}

async function oursRun(run: Run): Promise<Outcome> {
  const dir = run.dir ?? repo;
  const environment = createNodeGitHostEnvironment({ env: envOf(run) });
  const g = run.bare ? await openBare(dir, environment) : await openOurs(dir, environment);
  const cmd = g.checkAttr().setCompatibility(nativeCompatibility());
  if (run.cwd) cmd.setCurrentDirectory(run.cwd);
  const args = run.args;
  const dash = args.indexOf("--");
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (dash >= 0 && i > dash) break;
    if (a === "--") continue;
    if (a === "-a" || a === "--all") cmd.setAll(true);
    else if (a === "--cached") cmd.setCached(true);
    else if (a === "--stdin") cmd.setStdin(Buffer.from(run.stdin ?? "", "latin1"));
    else if (a === "-z") cmd.setNulTerminated(true);
    else if (a === "--source") cmd.setSource(args[++i]);
    else positional.push(a);
  }
  const files = dash >= 0 ? args.slice(dash + 1) : [];
  const all = args.includes("-a") || args.includes("--all");
  if (dash >= 0) for (const a of positional) cmd.addAttribute(a);
  else if (args.includes("--stdin") || all) {
    for (const a of all ? [] : positional) cmd.addAttribute(a);
    if (all) files.push(...positional);
  } else {
    // exactly one attribute, then the files
    if (positional[0] !== undefined) cmd.addAttribute(positional[0]);
    files.push(...positional.slice(1));
  }
  for (const f of files) cmd.addPath(f);
  return outcomeOf(await cmd.call());
}

async function twin(run: Run): Promise<Outcome> {
  const n = nativeRun(run);
  expect(await oursRun(run), JSON.stringify(run)).toEqual(n);
  return n;
}

const check = (path: string, extra: Partial<Run> = {}) =>
  twin({ args: ["test", "--", path], ...extra });

/** The paths of t0003's expect-all. */
const ALL_PATHS = [
  "f",
  "a/f",
  "a/c/f",
  "a/g",
  "a/b/g",
  "b/g",
  "a/b/h",
  "a/b/d/g",
  "onoff",
  "offon",
  "no",
  "a/b/d/no",
  "a/b/d/yes",
];

describeGit("git check-attr against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "check-attr-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    const g = (...args: string[]) => git(root, repo, args);
    g("init", "-q", "-b", "main");
    mkdirSync(join(repo, "a/b/d"), { recursive: true });
    mkdirSync(join(repo, "a/c"), { recursive: true });
    mkdirSync(join(repo, "b"), { recursive: true });
    writeFiles(repo, {
      ".gitattributes": [
        "[attr]notest !test",
        '" d "\ttest=d',
        " e\ttest=e",
        ' e"\ttest=e',
        "f\ttest=f",
        "a/i test=a/i",
        "onoff test -test",
        "offon -test test",
        "no notest",
        "A/e/F test=A/e/F",
        "",
      ].join("\n"),
      "a/.gitattributes": "g test=a/g\nb/g test=a/b/g\n",
      "a/b/.gitattributes": "h test=a/b/h\nd/* test=a/b/d/*\nd/yes notest\n",
    });
    writeFiles(root, { "global-gitattributes": "global test=global\n" });
    // setup branches
    mkdirSync(join(repo, "foo/bar"), { recursive: true });
    writeFiles(repo, { "foo/bar/.gitattributes": "f test=f\na/i test=n\n" });
    g("add", "foo/bar/.gitattributes");
    g("commit", "-q", "-m", "add .gitattributes");
    g("tag", "tag-1");
    writeFiles(repo, { "foo/bar/.gitattributes": "g test=g\na/i test=m\n" });
    g("commit", "-q", "-a", "-m", "add .gitattributes");
    g("tag", "tag-2");
    rmSync(join(repo, "foo/bar/.gitattributes"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t0003-attributes.sh: "command line checks"', async () => {
    for (const args of [
      [],
      ["--"],
      ["test"],
      ["test", "--"],
      ["--", "f"],
      ["--source", "not-a-valid-ref", "test", "--", "f"],
    ]) {
      await twin({ args });
    }
    await twin({ args: ["--stdin"], stdin: "f\n" });
    await twin({ args: ["--stdin", "--", "f"], stdin: "f\n" });
    await twin({ args: ["--stdin", "test", "--", "f"], stdin: "f\n" });
    await twin({ args: ["", "--", "f"] });
    await twin({ args: ["-a", "test", "--", "f"] });
  });

  it('t0003-attributes.sh: "attribute test", "prefixes are not confused with leading directories", "root subdir attribute test"', async () => {
    for (const p of [" d ", "e", 'e"', ...ALL_PATHS, "a_plus/g", "a/i", "subdir/a/i"])
      await check(p);
    await twin({ args: ["test", "a/g", "a_plus/g"] });
    await twin({ args: ["test", "notest", "--", "no", "a/b/d/yes", "a/b/d/no"] });
  });

  it('t0003-attributes.sh: "attribute matching is case sensitive when core.ignorecase=0", "attribute matching is case insensitive when core.ignorecase=1"', async () => {
    const paths = [
      "F",
      "a/F",
      "a/c/F",
      "a/G",
      "a/B/g",
      "a/b/G",
      "a/b/H",
      "a/b/D/g",
      "oNoFf",
      "oFfOn",
      "NO",
      "a/b/D/NO",
      "a/b/d/YES",
      "a/E/f",
    ];
    for (const ic of ["0", "1"]) {
      for (const p of paths) await check(p, { config: [["core.ignorecase", ic]] });
    }
  });

  it('t0003-attributes.sh: "unnormalized paths", "relative paths"', async () => {
    for (const p of ["./f", "./a/g", "a/./g", "a/c/../b/g"]) await check(p);
    for (const p of ["../f", "f", "i", "g", "b/g"]) await check(p, { cwd: "a" });
    for (const p of ["../a/f", "../a/g", "../a/b/g"]) await check(p, { cwd: "b" });
  });

  it('t0003-attributes.sh: "core.attributesfile"', async () => {
    await check("global");
    await check("global", { config: [["core.attributesfile", `${root}/global-gitattributes`]] });
    await check("global", { config: [["core.attributesfile", "~/global-gitattributes"]] });
  });

  it('t0003-attributes.sh: "attribute test: read paths from stdin", "attribute test: --all option", "attribute test: --cached option"', async () => {
    const stdin = `${ALL_PATHS.join("\n")}\n`;
    await twin({ args: ["--stdin", "test"], stdin });
    await twin({ args: ["--stdin", "test", "notest"], stdin });
    await twin({ args: ["--stdin", "--all"], stdin });
    await twin({ args: ["-z", "--stdin", "test"], stdin: `${ALL_PATHS.join("\0")}\0` });
    await twin({ args: ["-z", "--stdin", "--all"], stdin: ALL_PATHS.join("\0") });
    await twin({ args: ["--stdin", "test"], stdin: '"a/\\146"\n"bad\\q"\nf\n' });
    await twin({ args: ["--cached", "--stdin", "--all"], stdin });
    git(root, repo, ["add", ".gitattributes", "a/.gitattributes", "a/b/.gitattributes"]);
    try {
      await twin({ args: ["--cached", "--stdin", "--all"], stdin });
      await twin({ args: ["--cached", "test", "--", "a/b/d/g"] });
    } finally {
      git(root, repo, [
        "rm",
        "-q",
        "--cached",
        ".gitattributes",
        "a/.gitattributes",
        "a/b/.gitattributes",
      ]);
    }
  });

  it('t0003-attributes.sh: "using --source"', async () => {
    for (const [path, source] of [
      ["foo/bar/f", "tag-1"],
      ["foo/bar/a/i", "tag-1"],
      ["foo/bar/f", "tag-2"],
      ["foo/bar/a/i", "tag-2"],
      ["foo/bar/g", "tag-2"],
      ["foo/bar/g", "tag-1"],
    ] as const) {
      await twin({ args: ["--source", source, "test", "--", path] });
      await check(path, { config: [["attr.tree", source]] });
      await check(path, { env: { GIT_ATTR_SOURCE: source } });
    }
    await twin({ args: ["--source", "HEAD:foo", "test", "--", "foo/bar/f"] });
  });

  it('t0003-attributes.sh: "bare repository: check that .gitattribute is ignored", "bare repository: with --source", "bare repository: test info/attributes"', async () => {
    const bare = join(root, "bare.git");
    git(root, root, ["clone", "-q", "--template=", "--bare", repo, bare]);
    writeFiles(bare, { ".gitattributes": "f\ttest=f\na/i test=a/i\n" });
    for (const p of ["f", "a/f", "a/c/f", "a/i", "subdir/a/i"])
      await check(p, { dir: bare, bare: true });
    for (const source of ["tag-1", "tag-2"]) {
      for (const p of ["foo/bar/f", "foo/bar/a/i", "foo/bar/g"]) {
        await twin({ args: ["--source", source, "test", "--", p], dir: bare, bare: true });
        await check(p, { dir: bare, bare: true, config: [["attr.tree", source]] });
      }
    }
    writeFiles(bare, { "info/attributes": "f\ttest=f\na/i test=a/i\n" });
    for (const p of ["f", "a/f", "a/c/f", "a/i", "subdir/a/i"])
      await check(p, { dir: bare, bare: true });
  });

  it('t0003-attributes.sh: "attr.tree when HEAD is unborn", "bad attr source defaults to reading .gitattributes file", "--attr-source is bad", "precedence of --attr-source, GIT_ATTR_SOURCE, then attr.tree"', async () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    git(root, empty, ["init", "-q"]);
    await check("f/path", { dir: empty, config: [["attr.tree", "HEAD"]] });
    await check("f/path", { dir: empty, env: { GIT_ATTR_SOURCE: "HEAD" } });
    writeFiles(empty, { ".gitattributes": "f/path test=val\n" });
    await check("f/path", { dir: empty, config: [["attr.tree", "HEAD"]] });
    git(root, empty, ["checkout", "-q", "-b", "attr-source"]);
    git(root, empty, ["add", ".gitattributes"]);
    git(root, empty, ["commit", "-q", "-m", "val"]);
    writeFiles(empty, { ".gitattributes": "f/path test=val1\n" });
    git(root, empty, ["commit", "-q", "-a", "-m", "val1"]);
    git(root, empty, ["checkout", "-q", "-b", "attr-tree"]);
    writeFiles(empty, { ".gitattributes": "f/path test=val2\n" });
    git(root, empty, ["commit", "-q", "-a", "-m", "val2"]);
    git(root, empty, ["checkout", "-q", "attr-source"]);
    await check("f/path", {
      dir: empty,
      config: [["attr.tree", "attr-tree"]],
      env: { GIT_ATTR_SOURCE: "attr-source" },
    });
  });

  // t0003-attributes.sh '"**" test', '"**" with no slashes test'
  it('t0003-attributes.sh: "negative patterns", "patterns starting with exclamation"', async () => {
    const other = join(root, "other");
    mkdirSync(other);
    git(root, other, ["init", "-q"]);
    writeFiles(other, { ".gitattributes": "!f test=bar\n" });
    await check("!f", { dir: other });
    writeFiles(other, { ".gitattributes": "\\!f test=foo\n" });
    await check("!f", { dir: other });
    writeFiles(other, { ".gitattributes": "**/f foo=bar\n" });
    for (const p of ["f", "a/f", "a/b/f", "a/b/c/f"])
      await twin({ args: ["foo", "--", p], dir: other });
    writeFiles(other, { ".gitattributes": "a**f foo=bar\n" });
    for (const p of ["f", "af", "axf", "a/f", "a/b/f", "a/b/c/f"]) {
      await twin({ args: ["foo", "--", p], dir: other });
    }
  });

  it('t0003-attributes.sh: "binary macro expanded by -a", "query binary macro directly"', async () => {
    const other = join(root, "binary");
    mkdirSync(other);
    git(root, other, ["init", "-q"]);
    writeFiles(other, { ".gitattributes": "file binary\n" });
    await twin({ args: ["-a", "file"], dir: other });
    await twin({ args: ["binary", "--", "file"], dir: other });
    writeFiles(other, { ".gitattributes": "[attr]m z y -x\nfile m b=1 a\nfi* c !b\n" });
    await twin({ args: ["-a", "file", "fi"], dir: other });
  });

  it('t0003-attributes.sh: "builtin object mode attributes work (dir and regular paths)", "builtin object mode attributes work (executable)", "builtin object mode attributes work (symlinks)", "native object mode attributes work with --cached", "user defined builtin_objectmode values are ignored"', async () => {
    const other = join(root, "modes");
    mkdirSync(other);
    git(root, other, ["init", "-q"]);
    writeFiles(other, { normal: "", exec: "" });
    chmodSync(join(other, "exec"), 0o755);
    mkdirSync(join(other, "dir"));
    symlinkSync("to_sym", join(other, "sym"));
    const mode = (path: string, extra: string[] = []) =>
      twin({ args: [...extra, "builtin_objectmode", "--", path], dir: other });
    for (const p of ["normal", "exec", "dir", "sym", "missing"]) await mode(p);
    git(root, other, ["add", "normal"]);
    const empty = git(root, other, ["rev-parse", ":normal"]).trim();
    git(
      root,
      other,
      ["update-index", "--index-info"],
      `100755 ${empty} 0\texec\n120000 ${empty} 0\tsymlink\n`,
    );
    for (const p of ["normal", "exec", "symlink", "dir"]) await mode(p, ["--cached"]);
    if (nativeCompatibility() !== "2.43") {
      writeFiles(other, { ".gitattributes": "foo* builtin_objectmode=12345\n", foo_1: "" });
      await mode("foo_1");
    }
  });
});
