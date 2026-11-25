/**
 * `git stripspace` against native git: the inputs of git's t0030-stripspace.sh (long lines,
 * blank lines at the start, the end and inside, trailing spaces, a missing final newline),
 * `-s` and `-c` with `core.commentChar` / `core.commentString` from the command line and from
 * `.git/config`, the values git refuses (empty, a newline, more than one character in 2.43),
 * and bytes that are no UTF-8. Run with the system git (2.43) and with 2.56.1 first on `PATH`.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { stripspace } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import {
  git,
  native,
  nativeCompatibility,
  type Outcome,
  outcomeOf,
} from "./plumbing-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root = "";
let repo = "";

/** `git [-c k=v]... stripspace <args>` with `input` on stdin, through ours. */
async function ours(args: string[], input: string, config: [string, string][]): Promise<Outcome> {
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([k, v], i) => [
        [`GIT_CONFIG_KEY_${i}`, k],
        [`GIT_CONFIG_VALUE_${i}`, v],
      ]),
    ),
  };
  const { createNodeGitHostEnvironment } = await import("@statewalker/vcs-utils-node/files");
  const g = await openOurs(repo, createNodeGitHostEnvironment({ env: { HOME: root, ...env } }));
  const cmd = g.stripspace().setCompatibility(nativeCompatibility());
  cmd.setInput(Buffer.from(input, "latin1"));
  for (const a of args) {
    if (a === "-s" || a === "--strip-comments") cmd.setMode("strip-comments");
    else if (a === "-c" || a === "--comment-lines") cmd.setMode("comment-lines");
    else throw new Error(`unknown option ${a}`);
  }
  return outcomeOf(await cmd.call());
}

async function twin(
  input: string,
  args: string[] = [],
  config: [string, string][] = [],
): Promise<Outcome> {
  const n = native(root, repo, [...config.flatMap(([k, v]) => ["-c", `${k}=${v}`]), "stripspace", ...args], {
    stdin: input,
  });
  expect(await ours(args, input, config), JSON.stringify([input.slice(0, 40), args, config])).toEqual(n);
  return n;
}

const t40 = "A quick brown fox jumps over the lazy do";
const s40 = " ".repeat(40);
const sss = s40.repeat(10);
const ttt = t40.repeat(10);

describeGit("git stripspace against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "stripspace-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(root, repo, ["init", "-q", "-b", "main"]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t0030-stripspace.sh: "long lines without spaces should be unchanged", "lines with spaces at the beginning should be unchanged", "lines with intermediate spaces should be unchanged"', async () => {
    for (const input of [
      `${ttt}\n`,
      `${ttt}${ttt}\n`,
      `${ttt}${ttt}${ttt}${ttt}\n`,
      `${sss}${ttt}\n`,
      `${ttt}${sss}${ttt}\n`,
      `${sss}${sss}${ttt}\n`,
      `${ttt}${sss}${ttt}${sss}${ttt}\n`,
    ]) {
      await twin(input);
    }
  });

  it('t0030-stripspace.sh: "consecutive blank lines should be unified", "only consecutive blank lines should be completely removed"', async () => {
    for (const a of [ttt, ttt + ttt, ttt + ttt + ttt]) {
      for (const b of [ttt, ttt + ttt, ttt + ttt + ttt]) {
        await twin(`${a}\n\n\n\n\n${b}\n`);
        await twin(`${a}\n\t\n \n\n  \t\t\n${b}\n`);
      }
    }
    for (const input of [
      "\n",
      "\n\n\n",
      `${sss}\n${sss}\n${sss}\n`,
      `${sss}${sss}\n${sss}\n\n`,
      `\n${sss}\n${sss}${sss}\n`,
      `${sss}${sss}${sss}${sss}\n\n\n`,
      `\n${sss}${sss}${sss}${sss}\n\n`,
      `\n\n${sss}${sss}${sss}${sss}\n`,
    ]) {
      expect((await twin(input)).out).toBe("");
    }
  });

  it('t0030-stripspace.sh: "consecutive blank lines at the beginning should be removed", "consecutive blank lines at the end should be removed"', async () => {
    for (const t of [ttt, ttt + ttt, ttt + ttt + ttt, `${ttt}${sss}`]) {
      await twin(`\n${t}\n`);
      await twin(`\n\n\n${t}\n`);
      await twin(`${sss}\n${sss}\n${sss}\n${t}\n`);
      await twin(`\n${sss}\n${sss}${sss}\n${t}\n`);
      await twin(`${t}\n\n`);
      await twin(`${t}\n\n\n`);
      await twin(`${t}\n${sss}\n${sss}\n${sss}\n`);
      await twin(`${t}\n\n${sss}\n${sss}${sss}\n`);
    }
  });

  it('t0030-stripspace.sh: "text without newline at end should end with newline", "text plus spaces without newline at end should end with newline", "spaces with newline at end should be replaced with empty string", "consecutive text lines should be unchanged"', async () => {
    for (const input of [
      ttt,
      ttt + ttt,
      `${ttt}${sss}`,
      `${ttt}${ttt}${sss}`,
      `${ttt}${sss}${sss}`,
      `${ttt} `,
      `${ttt}\t\t`,
      `${ttt}${sss}\n`,
      `${ttt}${sss}${sss}\n`,
      `${sss}\n`,
      sss,
      `${sss}${sss}`,
      `${ttt}\n${ttt}\n`,
      `${ttt}\n${ttt}\n\n${ttt}\n${ttt}\n`,
      `${ttt}\n${ttt}\n\n\n${ttt}\n${ttt}\n`,
      "a\r\nb \r\n\r\n\r\nc\r",
    ]) {
      await twin(input);
    }
  });

  it('t0030-stripspace.sh: "strip comments, too", "strip comments with changed comment char", "strip comments with changed comment string"', async () => {
    await twin("# comment\n");
    await twin("# comment\n", ["-s"]);
    await twin("; comment\n", [], [["core.commentchar", ";"]]);
    await twin("; comment\n", ["-s"], [["core.commentchar", ";"]]);
    await twin("// comment\n#x\n", ["-s"], [["core.commentchar", "//"]]);
    await twin("// comment\n#x\n", ["-s"], [["core.commentString", "//"]]);
    await twin("a\n# one\n\n\n#two\nb\n#\n", ["-s"]);
    await twin("#x\n", ["-s"], [["core.commentchar", "auto"]]);
  });

  it('t0030-stripspace.sh: "newline as commentchar is forbidden", "empty commentchar is forbidden"', async () => {
    // 2.43 takes a newline as the comment character (one ASCII character)
    await twin("x\n\n", ["-s"], [["core.commentChar", "\n"]]);
    expect((await twin("x\n", ["-s"], [["core.commentchar", ""]])).status).toBe(128);
    await twin("x\n", ["-c"], [["core.commentString", ""]]);
    await twin("x\n", ["-c"], [["core.commentchar", "é"]]);
    // the default mode reads no configuration
    await twin("x\n", [], [["core.commentchar", ""]]);
  });

  it('t0030-stripspace.sh: "-c with single line", "-c with single line followed by empty line", "-c with newline only", "--comment-lines with single line", "-c with changed comment char", "avoid SP-HT sequence in commented line"', async () => {
    await twin("foo", ["-c"]);
    await twin("foo\n\n", ["-c"]);
    await twin("\n", ["-c"]);
    await twin("foo", ["--comment-lines"]);
    await twin("foo", ["-c"], [["core.commentchar", ";"]]);
    await twin("\tone\n\ntwo\n", ["-c"]);
    await twin("", ["-c"]);
    await twin("", []);
  });

  it('t0030-stripspace.sh: "-c with comment char defined in .git/config"', async () => {
    git(root, repo, ["config", "core.commentchar", "="]);
    try {
      await twin("foo", ["-c"]);
      git(root, repo, ["config", "--add", "core.commentchar", ""]);
      await twin("foo", ["-c"]);
    } finally {
      git(root, repo, ["config", "--unset-all", "core.commentchar"]);
    }
  });

  it("bytes that are no UTF-8 pass as they are", async () => {
    await twin("\xff\xfe  \n\n\xc3\n", []);
    await twin("\xff\n", ["-c"]);
  });

  it("stripspace: git's strbuf_stripspace", () => {
    expect(stripspace("  \n\nsubject  \n# note\n\n\nbody\n\n")).toBe("subject\n# note\n\nbody\n");
  });
});
