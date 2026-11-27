/**
 * External diff programs (diff.c's `run_external_diff`) against native git: the program a
 * pair goes to (`diff.<driver>.command` over `GIT_EXTERNAL_DIFF` over `diff.external`), the
 * arguments it gets (a recording script prints them, its directory, its
 * `GIT_DIFF_PATH_COUNTER`/`GIT_DIFF_PATH_TOTAL` and the files it is given), where its output
 * goes and how its exit code counts (`trustExitCode`, git 2.46+). Also `GIT_DIFF_OPTS` (the
 * builtin patch's context) and `GIT_MERGE_VERBOSITY` (merge-ort's messages). Scenarios from
 * t4020-diff-external.sh; native git and ours each run in their own copy of one repository.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DiffCommand, Git } from "../src/index.js";
import { type HookTwin, hookTwins, nativeIn, oursIn } from "./hooks-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, putFile } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() ? describe : describe.skip;

const version = (() => {
  if (!nativeGitAvailable()) return [0, 0];
  const m = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"]).toString());
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
})();
/** `trustExitCode` is git 2.46+ */
const hasTrustExitCode = version[0] > 2 || (version[0] === 2 && version[1] >= 46);

let root: string;
let record: string;

/** Prints its arguments, directory, counters and the files it is given (`cat -A`). */
const RECORD = String.raw`#!/bin/sh
echo "argc $#"
for a in "$@"; do printf '<%s>\n' "$a"; done
echo "pwd $(pwd) counter $GIT_DIFF_PATH_COUNTER/$GIT_DIFF_PATH_TOTAL"
if [ $# -ge 7 ]; then
  [ "$2" = /dev/null ] || { echo "old:"; cat -A "$2"; }
  [ "$5" = /dev/null ] || { echo "new:"; cat -A "$5"; }
fi
`;

/** A temporary file's directory and a twin's path as placeholders. */
function normalize(text: string, twin: HookTwin): string {
  return text
    .replaceAll(twin.dir, "<twin>")
    .replace(/\/[^\s<>]*\/git-blob-[A-Za-z0-9]{6}\//g, "<tmp>/");
}

/**
 * t4020's setup: `file` committed as "initial" then "second", the worktree's "third".
 */
function setup(name: string): [HookTwin, HookTwin] {
  const dir = join(root, name);
  gitOut(root, root, ["init", "-q", "-b", "main", dir]);
  putFile(dir, "file", "initial\n");
  gitOut(root, dir, ["add", "file"]);
  gitOut(root, dir, ["commit", "-q", "-m", "initial"]);
  putFile(dir, "file", "second\n");
  gitOut(root, dir, ["commit", "-q", "-am", "second"]);
  putFile(dir, "file", "third\n");
  return hookTwins(root, dir);
}

/** Native `git diff <args>` and ours (`configure` sets the same options), compared whole. */
async function twinDiff(
  [native, ours]: [HookTwin, HookTwin],
  args: string[],
  configure: (diff: DiffCommand) => DiffCommand,
  env: Record<string, string> = {},
) {
  const r = nativeIn(native, root, ["diff", ...args], env);
  const git = await oursIn(ours, env);
  const diff = configure(git.diff());
  let stdout = "";
  let exitCode = 0;
  let stderr = "";
  try {
    stdout = await diff.callText();
    exitCode = diff.exitCode;
  } catch (e) {
    exitCode = (e as { exitCode?: number }).exitCode ?? -1;
    stdout = new TextDecoder().decode((e as { output?: Uint8Array }).output);
    stderr = `fatal: ${(e as Error).message}\n`;
  }
  stderr = new TextDecoder().decode(diff.programStderr) + stderr;
  expect({ exitCode, stdout: normalize(stdout, ours), stderr }).toEqual({
    exitCode: r.status,
    stdout: normalize(r.stdout, native),
    // the CRLF warnings of the worktree's hashing are no part of this
    stderr: r.stderr.replace(/^warning: in the working copy of .*\n/gm, ""),
  });
  return { native: r, ours: { stdout, exitCode }, git };
}

const inBoth = (twins: HookTwin[], args: string[]) => {
  for (const twin of twins) gitOut(root, twin.dir, args);
};

describeGit("external diff twins (t4020-diff-external.sh)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "diff-external-twins-"));
    record = join(root, "record.sh");
    writeFileSync(record, RECORD);
    chmodSync(record, 0o755);
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it('t4020-diff-external.sh: "GIT_EXTERNAL_DIFF environment"', async () => {
    const twins = setup("env");
    const { ours } = await twinDiff(twins, [], (d) => d, { GIT_EXTERNAL_DIFF: record });
    expect(ours.stdout).toContain("<file>\n<0000000000000000000000000000000000000000>\n");
    // the program saw the index's blob in a temporary file named after the path
    expect(normalize(ours.stdout, twins[1])).toContain("<<tmp>/file>\n");
  });

  it('t4020-diff-external.sh: "GIT_EXTERNAL_DIFF environment and --no-ext-diff"', async () => {
    const twins = setup("no-ext");
    const { ours } = await twinDiff(
      twins,
      ["--no-ext-diff"],
      (d) => d.setOptions({ extDiff: false }),
      { GIT_EXTERNAL_DIFF: record },
    );
    expect(ours.stdout).toContain("diff --git a/file b/file");
  });

  it('t4020-diff-external.sh: "GIT_EXTERNAL_DIFF environment should apply only to diff"', async () => {
    const [native, ours] = setup("log");
    const env = { GIT_EXTERNAL_DIFF: record };
    const git: Git = await oursIn(ours, env);
    const plain = nativeIn(native, root, ["log", "-p", "-1", "HEAD"], env).stdout;
    expect(await git.log().setMaxCount(1).callText({ patch: true })).toBe(plain);
    expect(plain).toContain("diff --git a/file b/file");
    // `git log --ext-diff` runs it
    const ext = nativeIn(native, root, ["log", "--ext-diff", "-p", "-1", "HEAD"], env).stdout;
    const mine = await git
      .log()
      .setMaxCount(1)
      .setDiffOptions({ extDiff: true })
      .callText({ patch: true });
    expect(normalize(mine, ours)).toBe(normalize(ext, native));
    expect(ext).not.toContain("diff --git");
  });

  it('t4020-diff-external.sh: "diff.external should apply only to diff", "diff attribute should apply only to diff"', async () => {
    const [native, ours] = setup("log-config");
    for (const twin of [native, ours]) {
      gitOut(root, twin.dir, ["config", "diff.external", record]);
      gitOut(root, twin.dir, ["config", "diff.parrot.command", record]);
      putFile(twin.dir, ".gitattributes", "file diff=parrot\n");
    }
    const git: Git = await oursIn(ours);
    const plain = nativeIn(native, root, ["log", "-p", "-1", "HEAD"]).stdout;
    expect(await git.log().setMaxCount(1).callText({ patch: true })).toBe(plain);
    expect(plain).toContain("diff --git a/file b/file");
  });

  it('t4020-diff-external.sh: "no diff with -diff"', async () => {
    const twins = setup("no-diff");
    for (const twin of twins) putFile(twin.dir, ".gitattributes", "file -diff\n");
    const { ours } = await twinDiff(twins, [], (d) => d);
    expect(ours.stdout).toContain("Binary");
  });

  it("t4020-diff-external.sh: 'force diff with \"diff\"'", async () => {
    const twins = setup("force-diff");
    for (const twin of twins) {
      putFile(twin.dir, "file", "NUL\0between\0words\n");
      putFile(twin.dir, ".gitattributes", "file diff\n");
    }
    const { ours } = await twinDiff(twins, [], (d) => d);
    expect(ours.stdout).toContain("+NUL");
  });

  it('t4020-diff-external.sh: "typechange diff"', async () => {
    const twins = setup("typechange");
    for (const twin of twins) {
      unlinkSync(join(twin.dir, "file"));
      symlinkSync("elif", join(twin.dir, "file"));
    }
    await twinDiff(twins, [], (d) => d, { GIT_EXTERNAL_DIFF: record });
    await twinDiff(twins, ["--no-ext-diff"], (d) => d.setOptions({ extDiff: false }), {
      GIT_EXTERNAL_DIFF: record,
    });
  });

  it('t4020-diff-external.sh: "diff.external", "diff.external and --no-ext-diff"', async () => {
    const twins = setup("config");
    inBoth(twins, ["config", "diff.external", record]);
    const { ours } = await twinDiff(twins, [], (d) => d);
    expect(ours.stdout).toContain("argc 7");
    await twinDiff(twins, ["--no-ext-diff"], (d) => d.setOptions({ extDiff: false }));
  });

  it('t4020-diff-external.sh: "diff attribute", "diff attribute and --no-ext-diff"', async () => {
    const twins = setup("attribute");
    inBoth(twins, ["config", "diff.parrot.command", record]);
    for (const twin of twins) putFile(twin.dir, ".gitattributes", "file diff=parrot\n");
    const { ours } = await twinDiff(twins, [], (d) => d);
    expect(ours.stdout).toContain("argc 7");
    await twinDiff(twins, ["--no-ext-diff"], (d) => d.setOptions({ extDiff: false }));
  });

  it('t4020-diff-external.sh: "GIT_EXTERNAL_DIFF trumps diff.external"', async () => {
    const twins = setup("trumps");
    inBoth(twins, ["config", "diff.external", "echo ext-global"]);
    const { ours } = await twinDiff(twins, [], (d) => d, { GIT_EXTERNAL_DIFF: "echo ext-env" });
    expect(ours.stdout.startsWith("ext-env file ")).toBe(true);
  });

  it('t4020-diff-external.sh: "attributes trump GIT_EXTERNAL_DIFF and diff.external"', async () => {
    const twins = setup("attributes-trump");
    inBoth(twins, ["config", "diff.external", "echo ext-global"]);
    inBoth(twins, ["config", "diff.foo.command", "echo ext-attribute"]);
    for (const twin of twins) putFile(twin.dir, ".gitattributes", "file diff=foo\n");
    const { ours } = await twinDiff(twins, [], (d) => d, { GIT_EXTERNAL_DIFF: "echo ext-env" });
    expect(ours.stdout.startsWith("ext-attribute file ")).toBe(true);
  });

  // check_external_diff: each row via the attribute, diff.external and GIT_EXTERNAL_DIFF
  const rows: Array<[code: number, trust: "on" | "off", options: string[]]> = [
    // t4020-diff-external.sh: "external diff 'echo output; exit 0;' with trustExitCode=off via attribute", "external diff 'echo output; exit 0;' with trustExitCode=off via diff.external", "external diff 'echo output; exit 0;' with trustExitCode=off via GIT_EXTERNAL_DIFF"
    [0, "off", []],
    // t4020-diff-external.sh: "external diff 'echo output; exit 1;' with trustExitCode=off via attribute", "external diff 'echo output; exit 1;' with trustExitCode=off via diff.external", "external diff 'echo output; exit 1;' with trustExitCode=off via GIT_EXTERNAL_DIFF"
    [1, "off", []],
    // t4020-diff-external.sh: "external diff 'echo output; exit 0;' with trustExitCode=on via attribute", "external diff 'echo output; exit 0;' with trustExitCode=on via diff.external", "external diff 'echo output; exit 0;' with trustExitCode=on via GIT_EXTERNAL_DIFF"
    [0, "on", []],
    // t4020-diff-external.sh: "external diff 'echo output; exit 1;' with trustExitCode=on via attribute", "external diff 'echo output; exit 1;' with trustExitCode=on via diff.external", "external diff 'echo output; exit 1;' with trustExitCode=on via GIT_EXTERNAL_DIFF"
    [1, "on", []],
    // t4020-diff-external.sh: "external diff 'echo output; exit 2;' with trustExitCode=on via attribute", "external diff 'echo output; exit 2;' with trustExitCode=on via diff.external", "external diff 'echo output; exit 2;' with trustExitCode=on via GIT_EXTERNAL_DIFF"
    [2, "on", []],
    // t4020-diff-external.sh: "external diff 'echo output; exit 0;' with trustExitCode=off via attribute with --exit-code", "external diff 'echo output; exit 0;' with trustExitCode=off via diff.external with --exit-code", "external diff 'echo output; exit 0;' with trustExitCode=off via GIT_EXTERNAL_DIFF with --exit-code"
    [0, "off", ["--exit-code"]],
    // t4020-diff-external.sh: "external diff 'echo output; exit 1;' with trustExitCode=off via attribute with --exit-code", "external diff 'echo output; exit 1;' with trustExitCode=off via diff.external with --exit-code", "external diff 'echo output; exit 1;' with trustExitCode=off via GIT_EXTERNAL_DIFF with --exit-code"
    [1, "off", ["--exit-code"]],
    // t4020-diff-external.sh: "external diff 'echo output; exit 0;' with trustExitCode=on via attribute with --exit-code", "external diff 'echo output; exit 0;' with trustExitCode=on via diff.external with --exit-code", "external diff 'echo output; exit 0;' with trustExitCode=on via GIT_EXTERNAL_DIFF with --exit-code"
    [0, "on", ["--exit-code"]],
    // t4020-diff-external.sh: "external diff 'echo output; exit 1;' with trustExitCode=on via attribute with --exit-code", "external diff 'echo output; exit 1;' with trustExitCode=on via diff.external with --exit-code", "external diff 'echo output; exit 1;' with trustExitCode=on via GIT_EXTERNAL_DIFF with --exit-code"
    [1, "on", ["--exit-code"]],
    // t4020-diff-external.sh: "external diff 'echo output; exit 2;' with trustExitCode=on via attribute with --exit-code", "external diff 'echo output; exit 2;' with trustExitCode=on via diff.external with --exit-code", "external diff 'echo output; exit 2;' with trustExitCode=on via GIT_EXTERNAL_DIFF with --exit-code"
    [2, "on", ["--exit-code"]],
    // t4020-diff-external.sh: "external diff 'echo output; exit 0;' with trustExitCode=off via attribute with --quiet", "external diff 'echo output; exit 0;' with trustExitCode=off via diff.external with --quiet", "external diff 'echo output; exit 0;' with trustExitCode=off via GIT_EXTERNAL_DIFF with --quiet"
    [0, "off", ["--quiet"]],
    // t4020-diff-external.sh: "external diff 'echo output; exit 1;' with trustExitCode=off via attribute with --quiet", "external diff 'echo output; exit 1;' with trustExitCode=off via diff.external with --quiet", "external diff 'echo output; exit 1;' with trustExitCode=off via GIT_EXTERNAL_DIFF with --quiet"
    [1, "off", ["--quiet"]],
    // t4020-diff-external.sh: "external diff 'echo output; exit 0;' with trustExitCode=on via attribute with --quiet", "external diff 'echo output; exit 0;' with trustExitCode=on via diff.external with --quiet", "external diff 'echo output; exit 0;' with trustExitCode=on via GIT_EXTERNAL_DIFF with --quiet"
    [0, "on", ["--quiet"]],
    // t4020-diff-external.sh: "external diff 'echo output; exit 1;' with trustExitCode=on via attribute with --quiet", "external diff 'echo output; exit 1;' with trustExitCode=on via diff.external with --quiet", "external diff 'echo output; exit 1;' with trustExitCode=on via GIT_EXTERNAL_DIFF with --quiet"
    [1, "on", ["--quiet"]],
    // t4020-diff-external.sh: "external diff 'echo output; exit 2;' with trustExitCode=on via attribute with --quiet", "external diff 'echo output; exit 2;' with trustExitCode=on via diff.external with --quiet", "external diff 'echo output; exit 2;' with trustExitCode=on via GIT_EXTERNAL_DIFF with --quiet"
    [2, "on", ["--quiet"]],
  ];
  for (const [code, trust, options] of rows) {
    const command = `echo output; exit ${code};`;
    const run = trust === "off" || hasTrustExitCode ? it : it.skip;
    // each row: t4020's check_external_diff, its three tests cited above the row
    run(`external diff '${command}' with trustExitCode=${trust} ${options.join(" ")}`, async () => {
      const configure = (d: DiffCommand) =>
        d.setExitCode(options.includes("--exit-code")).setQuiet(options.includes("--quiet"));
      const twins = setup(`trust-${code}-${trust}-${options.join("")}`);
      // via attribute
      inBoth(twins, ["config", "diff.foo.command", command]);
      inBoth(twins, ["config", "diff.foo.trustExitCode", trust]);
      for (const twin of twins) putFile(twin.dir, ".gitattributes", "file diff=foo\n");
      await twinDiff(twins, options, configure);
      // via diff.external
      inBoth(twins, ["config", "--unset", "diff.foo.command"]);
      inBoth(twins, ["config", "diff.external", command]);
      inBoth(twins, ["config", "diff.trustExitCode", trust]);
      await twinDiff(twins, options, configure);
      // via GIT_EXTERNAL_DIFF
      inBoth(twins, ["config", "--unset", "diff.external"]);
      await twinDiff(twins, options, configure, {
        GIT_EXTERNAL_DIFF: command,
        GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE: trust,
      });
    });
  }

  // t4020-diff-external.sh: "GIT_EXTERNAL_DIFF with more than one changed files"
  it('t4020-diff-external.sh: "GIT_EXTERNAL_DIFF path counter/total"', async () => {
    const twins = setup("counter");
    for (const twin of twins) {
      putFile(twin.dir, "file2", "anotherfile\n");
      gitOut(root, twin.dir, ["add", "file2"]);
      gitOut(root, twin.dir, ["commit", "-q", "-m", "added 2nd file"]);
      putFile(twin.dir, "file2", "modified\n");
    }
    const { ours } = await twinDiff(twins, [], (d) => d, { GIT_EXTERNAL_DIFF: record });
    expect(ours.stdout).toContain("counter 1/2");
    expect(ours.stdout).toContain("counter 2/2");
  });

  it('t4020-diff-external.sh: "GIT_EXTERNAL_DIFF generates pretty paths"', async () => {
    const twins = setup("pretty");
    for (const twin of twins) {
      putFile(twin.dir, "file.ext", "");
      gitOut(root, twin.dir, ["add", "file.ext"]);
      putFile(twin.dir, "file.ext", "with extension\n");
    }
    const { ours } = await twinDiff(twins, ["file.ext"], (d) => d.setPathspec(["file.ext"]), {
      GIT_EXTERNAL_DIFF: record,
    });
    expect(normalize(ours.stdout, twins[1])).toContain("<<tmp>/file.ext>");
  });

  it('t4020-diff-external.sh: "external diff with autocrlf = true"', async () => {
    const twins = setup("autocrlf");
    inBoth(twins, ["config", "core.autocrlf", "true"]);
    const { ours } = await twinDiff(twins, [], (d) => d, { GIT_EXTERNAL_DIFF: record });
    // the index's blob as checkout writes it: CRLF
    expect(ours.stdout).toContain("second^M$");
  });

  it('t4020-diff-external.sh: "submodule diff"', async () => {
    const dir = join(root, "submodule");
    gitOut(root, root, ["init", "-q", "-b", "main", dir]);
    putFile(dir, "file", "x\n");
    gitOut(root, dir, ["add", "file"]);
    gitOut(root, dir, ["commit", "-q", "-m", "initial"]);
    gitOut(root, dir, ["init", "-q", "-b", "main", "sub"]);
    putFile(join(dir, "sub"), "sub1.t", "sub1\n");
    gitOut(root, join(dir, "sub"), ["add", "."]);
    gitOut(root, join(dir, "sub"), ["commit", "-q", "-m", "sub1"]);
    gitOut(root, dir, ["add", "sub"]);
    gitOut(root, dir, ["commit", "-q", "-m", "add submodule"]);
    putFile(join(dir, "sub"), "sub2.t", "sub2\n");
    gitOut(root, join(dir, "sub"), ["add", "."]);
    gitOut(root, join(dir, "sub"), ["commit", "-q", "-m", "sub2"]);
    const twins = hookTwins(root, dir);
    const { ours } = await twinDiff(twins, [], (d) => d, { GIT_EXTERNAL_DIFF: record });
    expect(ours.stdout).toContain("<160000>");
    expect(ours.stdout).toContain("Subproject commit ");
  });

  // Not ported from git's t/ (t4020 has no such case): argument shapes checked against native git
  it("a rename gets the new path and the extended header lines", async () => {
    const twins = setup("rename");
    for (const twin of twins) {
      putFile(twin.dir, "file", `${Array.from({ length: 20 }, (_, i) => i).join("\n")}\n`);
      gitOut(root, twin.dir, ["commit", "-q", "-am", "long"]);
      gitOut(root, twin.dir, ["mv", "file", "moved"]);
      putFile(twin.dir, "moved", `${Array.from({ length: 21 }, (_, i) => i).join("\n")}\n`);
      gitOut(root, twin.dir, ["add", "moved"]);
    }
    const { ours } = await twinDiff(
      twins,
      ["--cached", "-M"],
      (d) => d.setCached(true).setRenames(true),
      { GIT_EXTERNAL_DIFF: record },
    );
    expect(ours.stdout).toContain("argc 9");
    expect(ours.stdout).toContain("rename from file\nrename to moved\n");
  });

  it("--cached passes a staged file the worktree still matches as that file", async () => {
    const twins = setup("cached");
    for (const twin of twins) gitOut(root, twin.dir, ["add", "file"]);
    const { ours } = await twinDiff(twins, ["--cached"], (d) => d.setCached(true), {
      GIT_EXTERNAL_DIFF: record,
    });
    // the new side: the worktree's file (stat-clean against the index), named by its path
    expect(ours.stdout).toMatch(/<100644>\n<file>\n<[0-9a-f]{40}>\n/);
  });

  it("additions and deletions pass /dev/null for the absent side", async () => {
    const twins = setup("add-delete");
    for (const twin of twins) {
      putFile(twin.dir, "added", "new\n");
      gitOut(root, twin.dir, ["add", "added"]);
      gitOut(root, twin.dir, ["rm", "-q", "--cached", "file"]);
    }
    const { ours } = await twinDiff(twins, ["--cached"], (d) => d.setCached(true), {
      GIT_EXTERNAL_DIFF: record,
    });
    expect(ours.stdout).toContain("</dev/null>\n<.>\n<.>");
  });

  it("an unmerged path gets its name alone", async () => {
    const [native, ours] = setup("unmerged");
    for (const twin of [native, ours]) {
      gitOut(root, twin.dir, ["checkout", "-q", "-f", "-b", "side", "HEAD~"]);
      putFile(twin.dir, "file", "side\n");
      gitOut(root, twin.dir, ["commit", "-q", "-am", "side"]);
      gitOut(root, twin.dir, ["checkout", "-q", "main"]);
      nativeIn(twin, root, ["merge", "side"]);
    }
    // (`git diff` shows a conflicted path as a combined diff; diff-index lists it unmerged)
    const { ours: out } = await twinDiff([native, ours], ["--cached"], (d) => d.setCached(true), {
      GIT_EXTERNAL_DIFF: record,
    });
    expect(out.stdout).toContain("argc 1\n<file>\n");
  });
});

// Not ported from git's t/: no t/ test checks what GIT_DIFF_OPTS or GIT_MERGE_VERBOSITY change
// (t/ scripts only set them); native git decides each case.
describeGit("GIT_DIFF_OPTS and GIT_MERGE_VERBOSITY twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "diff-opts-twins-"));
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  const lines = (n: number) => `${Array.from({ length: n }, (_, i) => `line ${i}`).join("\n")}\n`;

  for (const value of ["-u0", "--unified=1", "-u", "-u 2", "-U5", "--unified"]) {
    it(`GIT_DIFF_OPTS=${value} sets the patch's context`, async () => {
      const twins = setup(`diff-opts-${value.replace(/\W/g, "")}`);
      for (const twin of twins) {
        putFile(twin.dir, "file", lines(20));
        gitOut(root, twin.dir, ["commit", "-q", "-am", "lines"]);
        putFile(twin.dir, "file", lines(20).replace("line 10\n", "ten\n"));
      }
      await twinDiff(twins, [], (d) => d, { GIT_DIFF_OPTS: value });
      await twinDiff(twins, ["-U7"], (d) => d.setOptions({ context: 7 }), {
        GIT_DIFF_OPTS: value,
      });
    });
  }

  for (const [label, env, config] of [
    ["GIT_MERGE_VERBOSITY=0", { GIT_MERGE_VERBOSITY: "0" }, undefined],
    ["GIT_MERGE_VERBOSITY=1", { GIT_MERGE_VERBOSITY: "1" }, undefined],
    ["merge.verbosity=0", {}, "0"],
    ["GIT_MERGE_VERBOSITY=3 over merge.verbosity=0", { GIT_MERGE_VERBOSITY: "3" }, "0"],
  ] as const) {
    it(`${label}: git merge's messages`, async () => {
      const dir = join(root, `verbosity-${label.replace(/\W/g, "")}`);
      gitOut(root, root, ["init", "-q", "-b", "main", dir]);
      putFile(dir, "a", "a\n");
      putFile(dir, "b", "b\n");
      gitOut(root, dir, ["add", "."]);
      gitOut(root, dir, ["commit", "-q", "-m", "base"]);
      gitOut(root, dir, ["checkout", "-q", "-b", "side"]);
      putFile(dir, "a", "side a\n");
      putFile(dir, "b", "b\nside\n");
      gitOut(root, dir, ["commit", "-q", "-am", "side"]);
      gitOut(root, dir, ["checkout", "-q", "main"]);
      putFile(dir, "a", "main a\n");
      putFile(dir, "b", "main\nb\n");
      gitOut(root, dir, ["commit", "-q", "-am", "main"]);
      if (config !== undefined) gitOut(root, dir, ["config", "merge.verbosity", config]);
      const [native, ours] = hookTwins(root, dir);
      const r = nativeIn(native, root, ["merge", "side"], env);
      const git = await oursIn(ours, env);
      const result = await git.merge().include("side").call();
      const said = (result.output ?? []).join("\n");
      const nativeSaid = (r.stdout + r.stderr)
        .split("\n")
        .filter((l) => l.startsWith("Auto-merging") || l.startsWith("CONFLICT"))
        .join("\n");
      expect(
        said
          .split("\n")
          .filter((l) => /^(Auto-merging|CONFLICT)/.test(l))
          .join("\n"),
      ).toBe(nativeSaid);
    });
  }
});
