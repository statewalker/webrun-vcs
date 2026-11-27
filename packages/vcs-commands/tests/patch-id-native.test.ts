/**
 * `git patch-id` against native git: the histories and patches of git's t4204-patch-id.sh
 * (`git log -p` with `-O` and `--full-index`, `git format-patch` with and without
 * `--attach`, trailing whitespace stripped from a footer, whitespace changes, binary diffs,
 * `\ No newline at end of file` markers, one-line hunks), `--stable`, `--unstable`,
 * `--verbatim` and `patchid.stable` / `patchid.verbatim`, and malformed input (a hunk header
 * git cannot read, NUL bytes, a commit id inside a message, CRLF lines, several commits).
 * Native git reads each input; ours must print the same lines. Run with the system git (2.43)
 * and with 2.56.1 first on `PATH`.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { git, native, type Outcome, outcomeOf, writeFiles } from "./plumbing-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root = "";
let repo = "";

async function ours(args: string[], input: string, config: [string, string][]): Promise<Outcome> {
  for (const [k, v] of config) git(root, repo, ["config", k, v]);
  try {
    const g = await openOurs(repo);
    const cmd = g.patchId().setInput(Buffer.from(input, "latin1"));
    for (const a of args) {
      if (a === "--stable") cmd.setMode("stable");
      else if (a === "--unstable") cmd.setMode("unstable");
      else if (a === "--verbatim") cmd.setMode("verbatim");
      else throw new Error(`unknown option ${a}`);
    }
    return outcomeOf(await cmd.call());
  } finally {
    for (const [k] of config) git(root, repo, ["config", "--unset", k]);
  }
}

async function twin(input: string, args: string[] = [], config: [string, string][] = []) {
  const n = native(
    root,
    repo,
    [...config.flatMap(([k, v]) => ["-c", `${k}=${v}`]), "patch-id", ...args],
    {
      stdin: input,
    },
  );
  expect(
    await ours(args, input, config),
    JSON.stringify([args, config, input.slice(0, 80)]),
  ).toEqual(n);
  return n;
}

/** Every mode and configuration t4204 tries. */
const MODES: Array<[string[], [string, string][]]> = [
  [[], []],
  [["--stable"], []],
  [["--unstable"], []],
  [["--verbatim"], []],
  [[], [["patchid.stable", "true"]]],
  [[], [["patchid.stable", "false"]]],
  [[], [["patchid.verbatim", "true"]]],
  [[], [["patchid.verbatim", "false"]]],
  [["--unstable"], [["patchid.stable", "true"]]],
  [["--stable"], [["patchid.stable", "false"]]],
  [["--verbatim"], [["patchid.stable", "false"]]],
];

async function allModes(input: string): Promise<void> {
  for (const [args, config] of MODES) await twin(input, args, config);
}

const lines = (...l: string[]) => `${l.join("\n")}\n`;

describeGit("git patch-id against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "patch-id-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    const g = (...args: string[]) => git(root, repo, args);
    g("init", "-q", "-b", "main");
    // t4204's setup
    const str = "ab cd ef gh ij kl mn op".split(" ");
    writeFiles(repo, { foo: lines(...str), bar: lines(...str) });
    g("add", "foo", "bar");
    g("commit", "-q", "-a", "-m", "initial");
    writeFiles(repo, { foo: lines(...str, "b"), bar: lines(...str, "b") });
    g("commit", "-q", "-a", "-m", "first");
    g("checkout", "-q", "-b", "same", "main");
    g("commit", "-q", "--amend", "-m", "same-msg");
    g("checkout", "-q", "-b", "notsame", "main");
    writeFiles(repo, { foo: "c\n", bar: "c\n" });
    g("commit", "-q", "--amend", "-a", "-m", "notsame-msg");
    g("checkout", "-q", "-b", "with_space", "main~");
    const spaced = lines("a  b", "c d", "e    f", "  g   h", "    i   j", "k l", "m   n", "op");
    writeFiles(repo, { foo: spaced, bar: spaced });
    g("add", "foo", "bar");
    g("commit", "-q", "--amend", "-m", "with spaces");
    writeFiles(repo, { "bar-then-foo": lines("bar", "foo"), "foo-then-bar": lines("foo", "bar") });
    // a binary change
    g("checkout", "-q", "-b", "binary", "main");
    writeFiles(repo, { bin: "\x00\x01\x02binary\n", foo: lines(...str, "b", "z") });
    g("add", "bin", "foo");
    g("commit", "-q", "-m", "binary");
    g("checkout", "-q", "main");
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  const top = (rev: string, ...extra: string[]) =>
    git(root, repo, ["log", "-p", "-1", rev, "-O", "bar-then-foo", "--full-index", ...extra, "--"]);
  const formatPatch = (rev: string, ...extra: string[]) =>
    git(root, repo, ["format-patch", "-1", "--stdout", ...extra, rev]);

  it('t4204-patch-id.sh: "patch-id output is well-formed", "patch-id detects equality", "patch-id detects inequality"', async () => {
    await allModes(git(root, repo, ["log", "-p", "-1"]));
    for (const rev of ["main", "same", "notsame", "with_space", "main~"]) await allModes(top(rev));
  });

  it('t4204-patch-id.sh: "patch-id detects equality binary", "patch-id detects inequality binary"', async () => {
    await allModes(top("binary"));
    await allModes(top("binary", "--binary"));
    await allModes(git(root, repo, ["log", "-p", "-1", "binary"]));
  });

  it('t4204-patch-id.sh: "patch-id supports git-format-patch output", "whitespace is irrelevant in footer", "patch-id supports git-format-patch MIME output"', async () => {
    await allModes(formatPatch("same"));
    await allModes(formatPatch("same").replace(/ $/gm, ""));
    await allModes(formatPatch("same", "--attach"));
    await allModes(formatPatch("same", "-O", "foo-then-bar"));
  });

  it('t4204-patch-id.sh: "file order is irrelevant with --stable", "whitespace is relevant with --verbatim", "default is unstable"', async () => {
    await allModes(git(root, repo, ["log", "-p", "--all"]));
    await allModes(git(root, repo, ["format-patch", "--stdout", "--root", "with_space"]));
  });

  it('t4204-patch-id.sh: "patch-id handles no-nl-at-eof markers", "patch-id handles diffs with one line of before/after", "patch-id without repository"', async () => {
    const nonl = lines(
      "diff --git i/a w/a",
      "index e69de29..2e65efe 100644",
      "--- i/a",
      "+++ w/a",
      "@@ -0,0 +1 @@",
      "+a",
      "\\ No newline at end of file",
      "diff --git i/b w/b",
      "index e69de29..6178079 100644",
      "--- i/b",
      "+++ w/b",
      "@@ -0,0 +1 @@",
      "+b",
    );
    await allModes(nonl);
    await allModes(nonl.replace("\\ No newline at end of file\n", ""));
    const diffu1 = lines(
      "diff --git a/bar b/bar",
      "index bdaf90f..31051f6 100644",
      "--- a/bar",
      "+++ b/bar",
      "@@ -2 +2,2 @@",
      " b",
      "+c",
      "diff --git a/car b/car",
      "index 00750ed..2ae5e34 100644",
      "--- a/car",
      "+++ b/car",
      "@@ -1 +1,2 @@",
      " 3",
      "+d",
      "diff --git a/foo b/foo",
      "index e439850..7146eb8 100644",
      "--- a/foo",
      "+++ b/foo",
      "@@ -2 +2,2 @@",
      " a",
      "+e",
    );
    await allModes(diffu1);
    // malformed and unusual input
    await allModes(diffu1.replace("@@ -2 +2,2 @@", "@@ -2,x +2 @@"));
    await allModes(diffu1.replace("@@ -1 +1,2 @@", "@@ -1"));
    await allModes(diffu1.replace(" b\n", " b\x00junk\n"));
    await allModes(diffu1.replace(/\n/g, "\r\n"));
    await allModes(diffu1.slice(0, -1));
    await allModes(`commit ${"a".repeat(40)}\nmessage\n${"B".repeat(40)} in it\n${diffu1}`);
    await allModes(
      `From ${"c".repeat(40)} Mon Sep 17 00:00:00 2001\n${diffu1}\n-- \n2.0\n\n${diffu1}`,
    );
    await allModes(
      lines(
        "diff --git a/x b/x",
        "index 1234567..89abcde",
        "Binary files a/x and b/x differ",
        "diff --git a/y b/y",
        "index 1111111..2222222 100644",
        "GIT binary patch",
        "literal 3",
        "zcmZ",
        "",
        "diff --git a/z b/z",
        "--- a/z",
        "+++ b/z",
        "@@ -1 +1 @@",
        "-p",
        "+q",
      ),
    );
    await allModes("");
    await allModes("just a message\n\nno diff\n");
  });
});
