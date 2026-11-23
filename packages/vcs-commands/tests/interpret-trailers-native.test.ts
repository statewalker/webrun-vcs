/**
 * `git interpret-trailers` against native git: the scenarios of git's
 * t/t7513-interpret-trailers.sh (placement, `--if-exists`/`--if-missing` and their
 * `trailer.*` keys, `trailer.separators`, `--trim-empty`, `--only-trailers`, `--only-input`,
 * `--unfold`, `--parse`, `--no-divider`, comments, cut lines, `---` dividers, URLs,
 * `trailer.<key>.cmd`/`.command`, `--in-place`), JGit's FooterLineTest messages through
 * `--parse`, and the sign-off of `git commit -s` (sequencer.c's append_signoff) through
 * `appendSignoff`. Each scenario runs on native git and on `git.interpretTrailers()` in the
 * same repository, stdout and stderr compared byte for byte.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  amendWithTrailers,
  appendSignoff,
  GitApiError,
  type InterpretTrailersCommand,
  ignoredLogMessageBytes,
  parseTrailerIfExists,
  parseTrailerIfMissing,
  parseTrailerWhere,
  signoffLine,
  trailerConfigOf,
} from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;

// t7513's fixtures
const BASIC_MESSAGE = "subject\n\nbody\n";
const COMPLEX_BODY =
  "my subject\n\nmy body which is long\nand contains some special\nchars like : = ? !\n\n";
const COMPLEX_TRAILERS = "Fixes: \nAcked-by: \nReviewed-by: \nSigned-off-by: \n";
const COMPLEX_MESSAGE = COMPLEX_BODY + COMPLEX_TRAILERS;
const BASIC_PATCH =
  "---\n foo.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n\n" +
  "diff --git a/foo.txt b/foo.txt\nindex 0353767..1d91aa1 100644\n--- a/foo.txt\n" +
  "+++ b/foo.txt\n@@ -1,3 +1,3 @@\n\n-bar\n+baz\n\n--\n1.9.rc0.11.ga562ddc\n\n";
const WITH_COMMENTS =
  BASIC_MESSAGE +
  "# comment\n\n# other comment\nCc: \n# yet another comment\nReviewed-by: Johan\nReviewed-by: \n" +
  "# last comment\n\n";

/** One run of `git interpret-trailers`: configuration, arguments, input. */
interface Scenario {
  /** The test it comes from (t7513's title, or another source) */
  name: string;
  /** `git config --add` lines, in order */
  config?: [string, string][];
  /** `git -c` settings (through `GIT_CONFIG_*`) */
  commandLine?: [string, string][];
  args: string[];
  /** stdin */
  input?: string;
  /** files in the worktree */
  files?: Record<string, string>;
  /** Only for one version: 2.5x (URLs, comment strings) or 2.43 */
  only?: "2.5x" | "2.43";
}

const SEP3 = ["trailer.separators", ":=#"] as [string, string];
const SEP2 = ["trailer.separators", ":="] as [string, string];
const ACK = ["trailer.ack.key", "Acked-by= "] as [string, string];
const BUG = ["trailer.bug.key", "Bug #"] as [string, string];
const REVIEW = ["trailer.review.key", "Reviewed-by:"] as [string, string];
const tr = (...values: string[]) => values.flatMap((v) => ["--trailer", v]);

const SCENARIOS: Scenario[] = [
  {
    name: "with cmd",
    config: [
      ["trailer.bug.key", "Bug-maker: "],
      ["trailer.bug.ifExists", "add"],
      ["trailer.bug.cmd", 'echo "maybe is"'],
    ],
    args: tr("bug: him", "bug:me"),
    input: "",
  },
  {
    name: "with cmd and $1",
    config: [
      ["trailer.bug.key", "Bug-maker: "],
      ["trailer.bug.ifExists", "add"],
      ["trailer.bug.cmd", 'echo "$1" is'],
    ],
    args: tr("bug: him", "bug:me"),
    input: "",
  },
  {
    name: "with cmd and $1 with sh -c",
    config: [
      ["trailer.bug.key", "Bug-maker: "],
      ["trailer.bug.ifExists", "replace"],
      ["trailer.bug.cmd", 'sh -c "echo who is "$1""'],
    ],
    args: tr("bug: him", "bug:me"),
    input: "",
  },
  {
    name: "with cmd and $1 with shell script",
    config: [
      ["trailer.bug.key", "Bug-maker: "],
      ["trailer.bug.ifExists", "replace"],
      ["trailer.bug.cmd", "./echoscript"],
    ],
    args: tr("bug: him", "bug:me"),
    input: "",
    files: { echoscript: '#!/bin/sh\necho who is "$1"\n' },
  },
  {
    name: "without config",
    args: [...tr("ack = Peff", "Reviewed-by", "Acked-by: Johan"), "empty"],
    files: { empty: "" },
  },
  {
    name: "without config in another order",
    args: [...tr("Acked-by: Johan", "Reviewed-by", "ack = Peff"), "empty"],
    files: { empty: "" },
  },
  {
    name: "--trim-empty without config",
    args: ["--trim-empty", ...tr("ack=Peff", "Reviewed-by", "Acked-by: Johan", "sob:"), "empty"],
    files: { empty: "" },
  },
  {
    name: "with config option on the command line",
    commandLine: [["trailer.Acked-by.ifexists", "addifdifferent"]],
    args: tr("Reviewed-by: Peff", "Acked-by: Johan"),
    input: "\nAcked-by: Johan\n",
  },
  {
    name: "with only a title in the message",
    args: tr("Reviewed-by: Peff", "Acked-by: Johan"),
    input: "area: change\n",
  },
  {
    name: "with a bodiless message that lacks a trailing newline after the subject",
    args: tr("Reviewed-by: Peff", "Acked-by: Johan"),
    input: "area: change",
  },
  {
    name: "with a bodied message that lacks a trailing newline after the body",
    args: tr("Reviewed-by: Peff", "Acked-by: Johan"),
    input: "area: change\n\ndetails about the change.",
  },
  {
    name: "with a message that lacks a trailing newline after the trailers",
    args: tr("Acked-by: Johan"),
    input: "area: change\n\nReviewed-by: Peff",
  },
  {
    name: "with multiline title in the message",
    args: tr("Reviewed-by: Peff", "Acked-by: Johan"),
    input: "place of\ncode: change\n",
  },
  {
    name: "with non-trailer lines mixed with Signed-off-by",
    args: tr("token: value"),
    input:
      "\nthis is not a trailer\nthis is not a trailer\nSigned-off-by: a <a@example.com>\nthis is not a trailer\n",
  },
  {
    name: "with non-trailer lines mixed with cherry picked from",
    args: tr("token: value"),
    input:
      "\nthis is not a trailer\nthis is not a trailer\n(cherry picked from commit x)\nthis is not a trailer\n",
  },
  {
    name: "with non-trailer lines mixed with a configured trailer",
    config: [["trailer.my.key", "My-trailer: "]],
    args: tr("token: value"),
    input: "\nthis is not a trailer\nthis is not a trailer\nMy-trailer: x\nthis is not a trailer\n",
  },
  {
    name: "with non-trailer lines mixed with a non-configured trailer",
    config: [["trailer.my.key", "My-trailer: "]],
    args: tr("token: value"),
    input:
      "\nthis is not a trailer\nthis is not a trailer\nI-am-not-configured: x\nthis is not a trailer\n",
  },
  {
    name: "with all non-configured trailers",
    config: [["trailer.my.key", "My-trailer: "]],
    args: tr("token: value"),
    input: "\nI-am-not-configured: x\nI-am-also-not-configured: x\n",
  },
  {
    name: "with non-trailer lines only",
    args: tr("token: value"),
    input: "\nthis is not a trailer\n",
  },
  {
    name: "line with leading whitespace is not trailer",
    args: tr("token: value"),
    input: "\n\ttoken: value\n",
  },
  {
    name: "multiline field treated as one trailer for 25% check",
    args: tr("name: value"),
    input: `\nSigned-off-by: a <a@example.com>\nname: value on\n\tmultiple lines\n${"this is not a trailer\n".repeat(6)}`,
  },
  {
    name: "multiline field treated as atomic for placement",
    config: [["trailer.name.where", "after"]],
    args: tr("name: value"),
    input: "\nanother: trailer\nname: value on\n\tmultiple lines\nanother: trailer\n",
  },
  {
    name: "multiline field treated as atomic for replacement",
    config: [["trailer.name.ifexists", "replace"]],
    args: tr("name: value"),
    input: "\nanother: trailer\nname: value on\n\tmultiple lines\nanother: trailer\n",
  },
  ...[
    "name: first line\n\tsecond line",
    "name: first line\n\t\t\t\t\tsecond line",
    "name: first line *DIFFERENT*\n\tsecond line",
  ].map((t, i) => ({
    name: `multiline field treated as atomic for difference check (${i + 1})`,
    config: [["trailer.name.ifexists", "addIfDifferent"]] as [string, string][],
    args: tr(t),
    input: "\nanother: trailer\nname: first line\n\tsecond line\nanother: trailer\n",
  })),
  ...["name: first line\n\tsecond line", "name: first line\n\t\t\t\t\tsecond line"].map((t, i) => ({
    name: `multiline field treated as atomic for neighbor check (${i + 1})`,
    config: [
      ["trailer.name.where", "after"],
      ["trailer.name.ifexists", "addIfDifferentNeighbor"],
    ] as [string, string][],
    args: tr(t),
    input: "\nanother: trailer\nname: first line\n\tsecond line\nanother: trailer\n",
  })),
  ...["ack = Peff", "Acked-by = Peff", "Acked-by :Peff"].map((t) => ({
    name: `with config setup (${t})`,
    config: [["trailer.ack.key", "Acked-by: "]] as [string, string][],
    args: ["--trim-empty", ...tr(t)],
    input: "",
  })),
  ...["ack = Peff", "Acked-by= Peff", "Acked-by : Peff"].map((t) => ({
    name: `with config setup and ":=" as separators (${t})`,
    config: [SEP2, ACK],
    args: ["--trim-empty", ...tr(t)],
    input: "",
  })),
  {
    name: 'with config setup and "%" as separators',
    config: [["trailer.separators", "%"]],
    args: ["--trim-empty", ...tr("bug = 42", "count%10", "test: stuff", "bug % 422")],
    input: "",
  },
  {
    name: 'with "%" as separators and a message with trailers',
    config: [["trailer.separators", "%"]],
    args: tr("count%100"),
    input: "Special Message\n\nbug% 42\ncount% 10\nbug% 422\n",
  },
  {
    name: 'with config setup and ":=#" as separators',
    config: [SEP3, BUG],
    args: ["--trim-empty", ...tr("bug = 42")],
    input: "",
  },
  { name: "with commit basic message", args: [], input: BASIC_MESSAGE },
  { name: "with basic patch", args: [], input: BASIC_MESSAGE + BASIC_PATCH },
  {
    name: "with commit complex message as argument",
    config: [SEP2, ACK],
    args: ["complex_message"],
    files: { complex_message: COMPLEX_MESSAGE },
  },
  {
    name: "with 2 files arguments",
    config: [SEP2, ACK],
    args: ["complex_message", "input"],
    files: { complex_message: COMPLEX_MESSAGE, input: BASIC_MESSAGE + BASIC_PATCH },
  },
  {
    name: "with message that has comments (#)",
    args: ["--trim-empty", ...tr("Cc: Peff"), "message_with_comments"],
    files: { message_with_comments: WITH_COMMENTS + BASIC_PATCH },
  },
  {
    name: "with message that has comments (;)",
    commandLine: [["core.commentChar", ";"]],
    args: ["--trim-empty", ...tr("Cc: Peff"), "message_with_comments"],
    files: { message_with_comments: WITH_COMMENTS.replaceAll("#", ";") + BASIC_PATCH },
  },
  {
    name: "with message that has comments (a comment string)",
    only: "2.5x",
    commandLine: [["core.commentString", "//"]],
    args: ["--trim-empty", ...tr("Cc: Peff"), "m"],
    files: { m: WITH_COMMENTS.replaceAll("#", "//") + BASIC_PATCH },
  },
  {
    name: "with message that has an old style conflict block",
    args: ["--trim-empty", ...tr("Cc: Peff"), "m"],
    files: { m: `${WITH_COMMENTS}Conflicts:\n\n` },
  },
  {
    name: "with commit complex message and trailer args",
    config: [SEP3, ACK, BUG],
    args: tr("ack: Peff", "bug: 42"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: "with complex patch, args and --trim-empty",
    config: [SEP3, ACK, BUG],
    args: ["--trim-empty", ...tr("ack: Peff", "bug: 42")],
    input: COMPLEX_MESSAGE + BASIC_PATCH,
  },
  {
    name: 'using "where = before"',
    config: [SEP3, ACK, BUG, ["trailer.bug.where", "before"]],
    args: [...tr("ack: Peff", "bug: 42"), "complex_message"],
    files: { complex_message: COMPLEX_MESSAGE },
  },
  {
    name: 'overriding configuration with "--where after"',
    config: [SEP2, ACK, ["trailer.ack.where", "before"]],
    args: ["--where", "after", ...tr("ack: Peff")],
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "--where after" with "--no-where"',
    config: [ACK, ["trailer.ack.where", "before"], BUG, ["trailer.bug.where", "before"], SEP3],
    args: ["--where", "after", "--no-where", ...tr("ack: Peff", "bug: 42")],
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "--where after" with "--no-where" defaults to configuration',
    config: [ACK, BUG, SEP3, ["trailer.where", "start"]],
    args: ["--where", "after", "--no-where", ...tr("ack: Peff", "bug: 42")],
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "--no-where" defaults to hardcoded default if nothing configured',
    config: [ACK, BUG, SEP3],
    args: ["--where", "after", ...tr("ack: Peff"), "--no-where", ...tr("bug: 42")],
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "where = after"',
    config: [ACK, ["trailer.ack.where", "after"], BUG, ["trailer.bug.where", "before"], SEP3],
    args: tr("ack: Peff", "bug: 42"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "where = end"',
    config: [
      ["trailer.review.key", "Reviewed-by"],
      ["trailer.review.where", "end"],
      ACK,
      ["trailer.ack.where", "after"],
      SEP2,
    ],
    args: tr("ack: Peff", "Reviewed-by: Junio", "Reviewed-by: Johannes"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "where = start"',
    config: [
      ["trailer.review.key", "Reviewed-by"],
      ["trailer.review.where", "start"],
      ACK,
      ["trailer.ack.where", "after"],
      SEP2,
    ],
    args: tr("ack: Peff", "Reviewed-by: Junio", "Reviewed-by: Johannes"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "where = before" for a token in the middle of the message',
    config: [
      ["trailer.review.key", "Reviewed-by:"],
      ["trailer.review.where", "before"],
      ACK,
      ["trailer.ack.where", "after"],
      BUG,
      ["trailer.bug.where", "before"],
      SEP3,
    ],
    args: tr("ack: Peff", "bug: 42", "review: Johan"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "where = before" and --trim-empty',
    config: [
      ACK,
      ["trailer.ack.where", "after"],
      BUG,
      ["trailer.bug.where", "before"],
      REVIEW,
      SEP3,
    ],
    args: ["--trim-empty", ...tr("ack: Peff", "bug: 42", "review: Johan", "Bug: 46")],
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'the default is "ifExists = addIfDifferentNeighbor"',
    config: [
      ACK,
      ["trailer.ack.where", "after"],
      BUG,
      ["trailer.bug.where", "before"],
      REVIEW,
      ["trailer.review.where", "before"],
      SEP3,
    ],
    args: tr("ack: Peff", "review:", "ack: Junio", "bug: 42", "ack: Peff", "ack: Peff"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'default "ifExists" is now "addIfDifferent"',
    config: [
      ["trailer.ifexists", "addIfDifferent"],
      ACK,
      ["trailer.ack.where", "after"],
      BUG,
      ["trailer.bug.where", "before"],
      REVIEW,
      SEP3,
    ],
    args: tr("ack: Peff", "review:", "ack: Junio", "bug: 42", "ack: Peff", "ack: Peff"),
    input: COMPLEX_MESSAGE,
  },
  ...(["end", "before"] as const).map((where) => ({
    name: `using "ifExists = addIfDifferent" with "where = ${where}"`,
    config: [
      ["trailer.ack.ifExists", "addIfDifferent"],
      ACK,
      ["trailer.ack.where", where],
      BUG,
      ["trailer.bug.where", "before"],
      REVIEW,
      ["trailer.ifexists", "addIfDifferent"],
      SEP3,
    ] as [string, string][],
    args: tr("ack: Peff", "review:", "bug: 42", "ack: Peff"),
    input: COMPLEX_MESSAGE,
  })),
  ...(["end", "after"] as const).map((where) => ({
    name: `using "ifExists = addIfDifferentNeighbor" with "where = ${where}"`,
    config: [
      ["trailer.ack.ifExists", "addIfDifferentNeighbor"],
      ACK,
      ["trailer.ack.where", where],
      BUG,
      ["trailer.bug.where", "before"],
      REVIEW,
      ["trailer.ifexists", "addIfDifferent"],
      SEP3,
    ] as [string, string][],
    args: tr(
      "ack: Peff",
      "review:",
      "ack: Junio",
      "bug: 42",
      "Tested-by: Jakub",
      "ack: Junio",
      "ack: Junio",
      "ack: Peff",
    ),
    input: COMPLEX_MESSAGE,
  })),
  {
    name: 'using "ifExists = addIfDifferentNeighbor" and --trim-empty',
    config: [
      ["trailer.ack.ifExists", "addIfDifferentNeighbor"],
      ACK,
      BUG,
      ["trailer.bug.where", "before"],
      SEP3,
    ],
    args: [
      "--trim-empty",
      ...tr("ack: Peff", "Acked-by= Peff", "review:", "ack: Junio", "bug: 42", "ack: Peff"),
    ],
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "ifExists = add" with "where = end"',
    config: [
      ["trailer.ack.ifExists", "add"],
      ACK,
      ["trailer.ack.where", "end"],
      BUG,
      ["trailer.bug.where", "before"],
      REVIEW,
      ["trailer.ifexists", "addIfDifferent"],
      SEP3,
    ],
    args: tr(
      "ack: Peff",
      "Acked-by= Peff",
      "review:",
      "Tested-by: Jakub",
      "ack: Junio",
      "bug: 42",
      "Tested-by: Johannes",
      "ack: Peff",
    ),
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "ifExists = add" with "where = after"',
    config: [
      ["trailer.ack.ifExists", "add"],
      ACK,
      ["trailer.ack.where", "after"],
      BUG,
      ["trailer.bug.where", "before"],
      REVIEW,
      ["trailer.ifexists", "addIfDifferent"],
      SEP3,
    ],
    args: tr("ack: Peff", "Acked-by= Peff", "review:", "ack: Junio", "bug: 42", "ack: Peff"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'overriding configuration with "--if-exists replace"',
    config: [
      ["trailer.fix.key", "Fixes: "],
      ["trailer.fix.ifExists", "add"],
      ACK,
      ["trailer.ack.where", "after"],
      BUG,
      ["trailer.bug.where", "before"],
      REVIEW,
      ["trailer.review.where", "before"],
      SEP3,
    ],
    args: ["--if-exists", "replace", ...tr("review:", "fix=53", "fix=22", "bug: 42")],
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "--if-exists replace" with "--no-if-exists" defaults to configuration',
    config: [["trailer.ifexists", "doNothing"]],
    args: ["--if-exists", "replace", "--no-if-exists", ...tr("Fixes: 53")],
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "--no-if-exists" defaults to hardcoded default if nothing configured',
    args: [
      "--if-exists",
      "replace",
      ...tr("Fixes: 53"),
      "--no-if-exists",
      ...tr("Signed-off-by: addme"),
    ],
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "--no-if-exists" defaults to hardcoded default if nothing configured (no addition)',
    args: ["--if-exists", "replace", ...tr("Fixes: 53"), "--no-if-exists", ...tr("Fixes: 53")],
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "ifExists = replace"',
    config: [
      ["trailer.fix.key", "Fixes: "],
      ["trailer.fix.ifExists", "replace"],
      ACK,
      ["trailer.ack.where", "after"],
      BUG,
      ["trailer.bug.where", "before"],
      REVIEW,
      ["trailer.ifexists", "addIfDifferent"],
      SEP3,
    ],
    args: tr("review:", "fix=53", "ack: Junio", "fix=22", "bug: 42", "ack: Peff"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "ifExists = replace" with "where = after"',
    config: [
      ACK,
      ["trailer.ack.where", "after"],
      BUG,
      ["trailer.bug.where", "before"],
      ["trailer.fix.key", "Fixes: "],
      ["trailer.fix.ifExists", "replace"],
      ["trailer.fix.where", "after"],
      REVIEW,
      ["trailer.ifexists", "addIfDifferent"],
      SEP3,
    ],
    args: tr("review:", "fix=53", "ack: Junio", "fix=22", "bug: 42", "ack: Peff"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "ifExists = doNothing"',
    config: [
      ["trailer.fix.ifExists", "doNothing"],
      ACK,
      ["trailer.ack.where", "after"],
      BUG,
      ["trailer.bug.where", "before"],
      ["trailer.fix.key", "Fixes: "],
      REVIEW,
      ["trailer.ifexists", "addIfDifferent"],
      SEP3,
    ],
    args: tr("review:", "fix=53", "ack: Junio", "fix=22", "bug: 42", "ack: Peff"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'the default is "ifMissing = add"',
    config: [
      ACK,
      ["trailer.ack.where", "after"],
      BUG,
      ["trailer.bug.where", "before"],
      ["trailer.cc.key", "Cc: "],
      ["trailer.cc.where", "before"],
      ["trailer.fix.key", "Fixes: "],
      ["trailer.fix.ifExists", "doNothing"],
      REVIEW,
      ["trailer.ifexists", "addIfDifferent"],
      SEP3,
    ],
    args: tr("review:", "fix=53", "cc=Linus", "ack: Junio", "fix=22", "bug: 42", "ack: Peff"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'overriding configuration with "--if-missing doNothing"',
    config: [
      ACK,
      ["trailer.ack.where", "after"],
      ["trailer.fix.key", "Fixes: "],
      ["trailer.fix.ifExists", "doNothing"],
      REVIEW,
      ["trailer.ifexists", "addIfDifferent"],
      ["trailer.ifmissing", "add"],
      SEP2,
    ],
    args: [
      "--if-missing",
      "doNothing",
      ...tr("review:", "fix=53", "cc=Linus", "ack: Junio", "fix=22", "bug: 42", "ack: Peff"),
    ],
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'when default "ifMissing" is "doNothing"',
    config: [
      ACK,
      ["trailer.ack.where", "after"],
      ["trailer.fix.ifExists", "doNothing"],
      REVIEW,
      ["trailer.ifexists", "addIfDifferent"],
      ["trailer.ifmissing", "doNothing"],
      SEP2,
    ],
    args: tr("review:", "fix=53", "cc=Linus", "ack: Junio", "fix=22", "bug: 42", "ack: Peff"),
    input: COMPLEX_MESSAGE,
  },
  ...(["end", "before"] as const).map((where) => ({
    name: `using "ifMissing = add" with "where = ${where}"`,
    config: [
      ACK,
      ["trailer.ack.where", "after"],
      BUG,
      ["trailer.bug.where", "before"],
      ["trailer.cc.key", "Cc: "],
      ["trailer.cc.ifMissing", "add"],
      ["trailer.cc.where", where],
      ["trailer.fix.ifExists", "doNothing"],
      REVIEW,
      ["trailer.ifexists", "addIfDifferent"],
      SEP3,
    ] as [string, string][],
    args: tr("review:", "fix=53", "ack: Junio", "fix=22", "bug: 42", "cc=Linus", "ack: Peff"),
    input: COMPLEX_MESSAGE,
  })),
  {
    name: 'using "ifMissing = doNothing"',
    config: [
      ACK,
      ["trailer.ack.where", "after"],
      BUG,
      ["trailer.bug.where", "before"],
      ["trailer.cc.ifMissing", "doNothing"],
      ["trailer.fix.ifExists", "doNothing"],
      REVIEW,
      ["trailer.ifexists", "addIfDifferent"],
      SEP3,
    ],
    args: tr("review:", "fix=53", "cc=Linus", "ack: Junio", "fix=22", "bug: 42", "ack: Peff"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "--no-if-missing" defaults to configuration',
    config: [["trailer.ifMissing", "doNothing"]],
    args: [
      "--if-missing",
      "doNothing",
      ...tr("IgnoredTrailer: ignoreme"),
      "--no-if-missing",
      ...tr("StillIgnoredTrailer: ignoreme"),
    ],
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'using "--no-if-missing" defaults to hardcoded default if nothing configured',
    args: [
      "--if-missing",
      "doNothing",
      ...tr("IgnoredTrailer: ignoreme"),
      "--no-if-missing",
      ...tr("AddedTrailer: addme"),
    ],
    input: COMPLEX_MESSAGE,
  },
  {
    name: 'default "where" is now "after"',
    config: [
      ["trailer.where", "after"],
      ["trailer.ack.ifExists", "add"],
      ACK,
      ["trailer.ack.where", "after"],
      BUG,
      ["trailer.bug.where", "before"],
      ["trailer.fix.ifExists", "doNothing"],
      REVIEW,
      ["trailer.ifexists", "addIfDifferent"],
      SEP3,
    ],
    args: tr(
      "ack: Peff",
      "Acked-by= Peff",
      "review:",
      "Tested-by: Jakub",
      "ack: Junio",
      "bug: 42",
      "Tested-by: Johannes",
      "ack: Peff",
    ),
    input: COMPLEX_MESSAGE,
  },
  {
    name: "with simple command",
    config: [
      ACK,
      ["trailer.fix.ifExists", "doNothing"],
      REVIEW,
      ["trailer.sign.command", 'echo "A U Thor <author@example.com>"'],
      ["trailer.sign.key", "Signed-off-by: "],
      ["trailer.sign.ifExists", "addIfDifferentNeighbor"],
      ["trailer.sign.where", "after"],
      ["trailer.ifexists", "addIfDifferent"],
      SEP2,
    ],
    args: tr("review:", "fix=22"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: "with command using committer information",
    config: [
      ACK,
      ["trailer.fix.ifExists", "doNothing"],
      REVIEW,
      ["trailer.sign.command", 'echo "$GIT_COMMITTER_NAME <$GIT_COMMITTER_EMAIL>"'],
      ["trailer.sign.key", "Signed-off-by: "],
      ["trailer.sign.ifExists", "addIfDifferent"],
      ["trailer.ifexists", "addIfDifferent"],
      SEP2,
    ],
    args: tr("review:", "fix=22"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: "with command using author information",
    config: [
      ACK,
      ["trailer.fix.ifExists", "doNothing"],
      REVIEW,
      ["trailer.sign.command", 'echo "$GIT_AUTHOR_NAME <$GIT_AUTHOR_EMAIL>"'],
      ["trailer.sign.key", "Signed-off-by: "],
      ["trailer.sign.ifExists", "addIfDifferentNeighbor"],
      ["trailer.sign.where", "after"],
      ["trailer.ifexists", "addIfDifferent"],
      SEP2,
    ],
    args: tr("review:", "fix=22"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: "cmd takes precedence over command",
    config: [
      ACK,
      [
        "trailer.fix.command",
        'git log -1 --oneline --format="%h (%s)" --abbrev-commit --abbrev=14 $ARG',
      ],
      [
        "trailer.fix.cmd",
        'test -n "$1" && git log -1 --oneline --format="%h (%aN)" --abbrev-commit --abbrev=14 "$1" || true',
      ],
      ["trailer.fix.key", "Fixes: "],
      ["trailer.fix.ifExists", "replace"],
      ["trailer.fix.where", "after"],
      REVIEW,
      ["trailer.sign.command", 'echo "$GIT_AUTHOR_NAME <$GIT_AUTHOR_EMAIL>"'],
      ["trailer.sign.key", "Signed-off-by: "],
      ["trailer.ifexists", "addIfDifferent"],
      SEP2,
    ],
    args: tr("review:", "fix=HEAD"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: "with command using $ARG",
    config: [
      ACK,
      [
        "trailer.fix.command",
        'git log -1 --oneline --format="%h (%s)" --abbrev-commit --abbrev=14 $ARG',
      ],
      ["trailer.fix.key", "Fixes: "],
      ["trailer.fix.ifExists", "replace"],
      ["trailer.fix.where", "after"],
      REVIEW,
      ["trailer.sign.command", 'echo "$GIT_AUTHOR_NAME <$GIT_AUTHOR_EMAIL>"'],
      ["trailer.sign.key", "Signed-off-by: "],
      ["trailer.ifexists", "addIfDifferent"],
      SEP2,
    ],
    args: tr("review:", "fix=HEAD"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: "with failing command using $ARG",
    config: [
      ACK,
      ["trailer.fix.command", "false $ARG"],
      ["trailer.fix.key", "Fixes: "],
      ["trailer.fix.ifExists", "replace"],
      ["trailer.fix.where", "after"],
      REVIEW,
      ["trailer.sign.command", 'echo "$GIT_AUTHOR_NAME <$GIT_AUTHOR_EMAIL>"'],
      ["trailer.sign.key", "Signed-off-by: "],
      ["trailer.ifexists", "addIfDifferent"],
      SEP2,
    ],
    args: tr("review:", "fix=HEAD"),
    input: COMPLEX_MESSAGE,
  },
  {
    name: "with empty tokens",
    config: [
      ["trailer.sign.command", 'echo "$GIT_AUTHOR_NAME <$GIT_AUTHOR_EMAIL>"'],
      ["trailer.sign.key", "Signed-off-by: "],
      ["trailer.ifexists", "addIfDifferent"],
    ],
    args: tr(":", ":test"),
    input: "",
  },
  {
    name: "with command but no key",
    config: [
      ["trailer.sign.command", 'echo "$GIT_AUTHOR_NAME <$GIT_AUTHOR_EMAIL>"'],
      ["trailer.ifexists", "addIfDifferent"],
    ],
    args: [],
    input: "",
  },
  {
    name: "with no command and no key",
    config: [
      ["trailer.review.where", "before"],
      ["trailer.sign.command", 'echo "$GIT_AUTHOR_NAME <$GIT_AUTHOR_EMAIL>"'],
      ["trailer.ifexists", "addIfDifferent"],
    ],
    args: tr("review:Junio"),
    input: "",
  },
  {
    name: "with cut line",
    config: [
      ["trailer.review.where", "before"],
      ["trailer.sign.command", 'echo "$GIT_AUTHOR_NAME <$GIT_AUTHOR_EMAIL>"'],
    ],
    args: tr("review:Brian"),
    input: "my subject\n# ------------------------ >8 ------------------------\nignore this\n",
  },
  {
    name: "only trailers",
    config: [
      ["trailer.sign.command", "echo config-value"],
      ["trailer.ifexists", "addIfDifferent"],
    ],
    args: [...tr("added:added-value"), "--only-trailers"],
    input: "my subject\n\nmy body\n\nexisting: existing-value\n",
  },
  {
    name: "only-trailers omits non-trailer in middle of block",
    config: [["trailer.sign.command", "echo config-value"]],
    args: ["--only-trailers"],
    input:
      'subject\n\nit is important that the trailers below are signed-off-by\nso that they meet the "25% trailers Git knows about" heuristic\n\nSigned-off-by: nobody <nobody@nowhere>\nthis is not a trailer\nSigned-off-by: somebody <somebody@somewhere>\n',
  },
  {
    name: "only input",
    config: [["trailer.sign.command", "echo config-value"]],
    args: ["--only-trailers", "--only-input"],
    input: "my subject\n\nmy body\n\nexisting: existing-value\n",
  },
  {
    name: "unfold",
    args: ["--only-trailers", "--only-input", "--unfold"],
    input: "my subject\n\nmy body\n\nfoo: \n  continued\n   across\n    several\n     lines\n   \n",
  },
  {
    name: "handling of --- lines in input",
    args: ["--parse"],
    input:
      "subject\n\nbody\n\nnot-a-trailer: too soon\n------ this is just a line in the commit message with a bunch of\n------ dashes; it does not have any syntactic meaning.\n\nreal-trailer: just right\n---\nbelow the dashed line may be a patch, etc.\n\nnot-a-trailer: too late\n",
  },
  {
    name: "suppress --- handling",
    args: ["--parse", "--no-divider"],
    input:
      'subject\n\nThis commit message has a "---" in it, but because we tell\ninterpret-trailers not to respect that, it has no effect.\n\nnot-a-trailer: too soon\n---\n\nThis is still the commit message body.\n\nreal-trailer: just right\n',
  },
  {
    name: "suppressing --- does not disable cut-line handling",
    args: ["--parse", "--no-divider"],
    input:
      "subject\n\nThis input has a cut-line in it; we should stop parsing when we see it\nand consider only trailers before that line.\n\nreal-trailer: before the cut\n\n# ------------------------ >8 ------------------------\n# Nothing below this line counts as part of the commit message.\nnot-a-trailer: too late\n",
  },
  // git 2.43 loops forever on this input (fixed in 2.44's find_end_of_log_message)
  {
    name: "handling of --- lines in conjunction with cut-lines",
    only: "2.5x",
    args: ["--parse"],
    input:
      "subject\n\nmy-trailer: here\n---\n# ------------------------ >8 ------------------------\n",
  },
  {
    name: "URLs and lines that are not quite URLs",
    only: "2.5x",
    args: ["--only-trailers"],
    input:
      "subject\n\nbody\n\nhttps://www.not-a-trailer.org\nhttps ://www.a-trailer.org\nhttps: //www.another-trailer.org\nSigned-off-by: somebody <somebody@somewhere>\n",
  },
  {
    name: "URLs and lines that are not quite URLs (2.43 takes URLs for trailers)",
    only: "2.43",
    args: ["--only-trailers"],
    input:
      "subject\n\nbody\n\nhttps://www.not-a-trailer.org\nhttps ://www.a-trailer.org\nSigned-off-by: somebody <somebody@somewhere>\n",
  },
  // beyond t7513: the corners of trailer.c
  {
    name: "unknown values warn, a key twice warns",
    config: [
      ["trailer.where", "nowhere"],
      ["trailer.ack.key", "Acked-by"],
      ["trailer.ack.key", "Ack"],
      ["trailer.ack.ifexists", "sometimes"],
      ["trailer.ifmissing", "maybe"],
    ],
    args: tr("ack: x"),
    input: "s\n",
  },
  {
    name: "item names without case, the first spelling kept",
    config: [
      ["trailer.Ack.key", "Acked-by"],
      ["trailer.ACK.where", "start"],
    ],
    args: tr("ack: x", "acK: y"),
    input: "s\n\nZ: z\n",
  },
  {
    name: "--trim-empty drops empty values (and 2.43 blank block lines)",
    config: [["trailer.sign.key", "Signed-off-by"]],
    args: ["--trim-empty"],
    input: "s\n\nSigned-off-by: a <a@b>\nCc:\nnot a trailer\n",
  },
  {
    name: "--trim-empty with a blank continuation",
    args: ["--trim-empty"],
    input: "s\n\nKey: v\n \nOther:\n",
  },
  { name: "an empty token warns", args: [...tr("=x", " :y", "z")], input: "s\n" },
  {
    name: "--only-trailers with --where start and --if-exists add",
    args: [
      "--only-trailers",
      "--where",
      "start",
      "--if-exists",
      "add",
      ...tr("A: 1", "A: 1", "B: 2"),
    ],
    input: "s\n\nA: 1\nC: 3\n",
  },
  {
    name: "--where before/after onto the first or last match",
    args: [
      "--where",
      "before",
      ...tr("A: x"),
      "--where",
      "after",
      ...tr("A: y"),
      "--if-exists",
      "addIfDifferent",
      ...tr("a: X"),
    ],
    input: "s\n\nA: 1\nB: 2\nA: 3\n",
  },
  {
    name: "replace with where start removes the first match",
    args: ["--where", "start", "--if-exists", "replace", ...tr("A: n")],
    input: "s\n\nB: 0\nA: 1\nA: 2\n",
  },
  {
    name: "a key ending in a separator, a key with blanks",
    config: [
      ["trailer.separators", ":#"],
      ["trailer.tick.key", "Ticket #"],
      ["trailer.ref.key", "Ref: "],
    ],
    args: tr("tick: 7", "ref=a", "Bug #42"),
    input: "s\n",
  },
  {
    name: "a value-less trailer and a trailer with only blanks after its key",
    args: tr("Key", "Other:   ", "Third=\t"),
    input: "s\n\nX: y\n",
  },
  {
    name: "messages without a trailing blank line before the block",
    args: tr("A: 1"),
    input: "s\nbody\nKey: v\n",
  },
  { name: "a block of comments only", args: tr("A: 1"), input: "s\n\n# c1\n# c2\n" },
  {
    name: "Conflicts block and comments after the trailers",
    args: tr("A: 1"),
    input: "s\n\nKey: v\n\nConflicts:\n\tfile\n# comment\n",
  },
  {
    name: "--in-place",
    args: ["--in-place", ...tr("Reviewed-by: Alice"), "message"],
    files: { message: BASIC_MESSAGE + BASIC_PATCH },
  },
  {
    name: "in-place editing on stdin disallowed",
    args: ["--in-place", ...tr("Reviewed-by: Alice")],
    input: BASIC_MESSAGE,
  },
  {
    name: "in-place editing on non-existing file",
    args: ["--in-place", ...tr("Reviewed-by: Alice"), "nonexisting"],
  },
  {
    name: "--trailer with --only-input",
    args: ["--only-input", ...tr("A: b")],
    input: BASIC_MESSAGE,
  },
  {
    name: "--parse of a cherry-pick block",
    args: ["--parse"],
    input: "s\n\nbody\n\n(cherry picked from commit 0123)\nnot one\nnot two\nnot three\n",
  },
  {
    name: "--no-trailer forgets the trailers given before",
    args: [...tr("A: 1"), "--no-trailer", ...tr("B: 2")],
    input: "s\n",
  },
];

/** JGit's FooterLineTest messages (after its fake headers), parsed with `--parse`. */
const JGIT_FOOTER_MESSAGES: [string, string][] = [
  ["testNoFooters_EmptyBody", ""],
  ["testNoFooters_NewlineOnlyBody1", "\n"],
  ["testNoFooters_NewlineOnlyBody5", "\n\n\n\n\n"],
  ["testNoFooters_OneLineBodyNoLF", "this is a commit"],
  ["testNoFooters_OneLineBodyWithLF", "this is a commit\n"],
  ["testNoFooters_ShortBodyNoLF", "subject\n\nbody of commit"],
  ["testNoFooters_ShortBodyWithLF", "subject\n\nbody of commit\n"],
  ["testNoFooters_noRawMsg_SingleLineNoHeaders", "commit message with no header lines\n"],
  ["testNoFooters_noRawMsg_ParagraphsWithoutFooter", "subject\n\nNot: footer\n\nFooter: value\n"],
  [
    "testFooters_noRawMsg_SingleLineNoHeaders",
    "50+ chars loooooooooooooong custom commit message.\n\nFooter: value\n",
  ],
  [
    "testSignedOffBy_OneUserNoLF",
    "subject\n\nbody of commit\n\nSigned-off-by: A. U. Thor <a@example.com>",
  ],
  [
    "testSignedOffBy_OneUserWithLF",
    "subject\n\nbody of commit\n\nSigned-off-by: A. U. Thor <a@example.com>\n",
  ],
  [
    "testSignedOffBy_IgnoreWhitespace",
    "subject\n\nbody of commit\n\nSigned-off-by:   A. U. Thor <a@example.com>  \n",
  ],
  ["testEmptyValueNoLF", "subject\n\nbody of commit\n\nSigned-off-by:"],
  ["testEmptyValueWithLF", "subject\n\nbody of commit\n\nSigned-off-by:\n"],
  ["testShortKey", "subject\n\nbody of commit\n\nK:V\n"],
  ["testNonDelimtedEmail", "subject\n\nbody of commit\n\nAcked-by: re@example.com\n"],
  ["testNotEmail", "subject\n\nbody of commit\n\nAcked-by: Main Tain Er\n"],
  [
    "testSignedOffBy_ManyUsers",
    "subject\n\nbody of commit\nNot-A-Footer-Line: this line must not be read as a footer\n\nSigned-off-by: A. U. Thor <a@example.com>\nCC:            <some.mailing.list@example.com>\nAcked-by: Some Reviewer <sr@example.com>\nSigned-off-by: Main Tain Er <mte@example.com>\n",
  ],
  [
    "testSignedOffBy_SkipNonFooter",
    "subject\n\nbody of commit\nNot-A-Footer-Line: this line must not be read as a footer\n\nSigned-off-by: A. U. Thor <a@example.com>\nCC:            <some.mailing.list@example.com>\nnot really a footer line but we'll skip it anyway\nAcked-by: Some Reviewer <sr@example.com>\nSigned-off-by: Main Tain Er <mte@example.com>\n",
  ],
  [
    "testFilterFootersIgnoreCase",
    "subject\n\nbody of commit\nNot-A-Footer-Line: this line must not be read as a footer\n\nSigned-Off-By: A. U. Thor <a@example.com>\nCC:            <some.mailing.list@example.com>\nAcked-by: Some Reviewer <sr@example.com>\nsigned-off-by: Main Tain Er <mte@example.com>\n",
  ],
  ["testMatchesBugId", "this is a commit subject for test\n\nSimple-Bug-Id: 42\n"],
  [
    "testMultilineFooters",
    "subject\n\nbody of commit\nNot-A-Footer-Line: this line must not be read as a footer\n\nNotes: The change must not be merged until dependency ABC is\n updated.\nCC:            <some.mailing.list@example.com>\nnot really a footer line but we'll skip it anyway\nAcked-by: Some Reviewer <sr@example.com>\n",
  ],
  [
    "testMultilineFooters_multipleWhitespaceAreAllowed",
    "subject\n\nbody of commit\nNot-A-Footer-Line: this line must not be read as a footer\n\nNotes: The change must not be merged until dependency ABC is\n    updated.\n",
  ],
  ["testFirstLineNeverFooter", "First-Line: is never a footer\nFoo: ter\n1-is: also a footer"],
  [
    "testLineAfterFooters",
    "Subject line: is never a footer\nFoo: ter\n1-is: also a footer\nthis is not a footer",
  ],
];

const env = () => nativeGitEnv(root);

function commandLineEnv(settings: [string, string][] = []): Record<string, string> {
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(2 + settings.length) };
  settings.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${i + 2}`] = key;
    out[`GIT_CONFIG_VALUE_${i + 2}`] = value;
  });
  return out;
}

function git(dir: string, args: string[], extra: Record<string, string> = {}, input?: string) {
  const r = spawnSync("git", args, {
    cwd: dir,
    env: { ...env(), ...extra },
    ...(input !== undefined ? { input: Buffer.from(input, "latin1") } : {}),
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout.toString("latin1"),
    stderr: r.stderr.toString("latin1"),
  };
}

/** A repository with one commit (the `git log` of trailer commands) and the scenario's config. */
function repository(config: [string, string][] = []): string {
  const dir = join(root, `r${counter++}`);
  mkdirSync(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.txt"), "Content of the first commit.\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-qm", "Add file a.txt"]);
  for (const [key, value] of config) git(dir, ["config", "--add", key, value]);
  return dir;
}

/** The arguments of `git interpret-trailers` given to our command. */
function applyArgs(command: InterpretTrailersCommand, args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const next = () => args[++i] as string;
    const value = (parse: (v: string) => unknown, v: string) => {
      const parsed = parse(v);
      if (parsed === undefined) throw new Error(`bad value ${v}`);
      return parsed as never;
    };
    if (arg === "--trailer") command.addTrailer(next());
    else if (arg === "--no-trailer") command.clearTrailers();
    else if (arg === "--where") command.setWhere(value(parseTrailerWhere, next()));
    else if (arg === "--no-where") command.setWhere(undefined);
    else if (arg === "--if-exists") command.setIfExists(value(parseTrailerIfExists, next()));
    else if (arg === "--no-if-exists") command.setIfExists(undefined);
    else if (arg === "--if-missing") command.setIfMissing(value(parseTrailerIfMissing, next()));
    else if (arg === "--no-if-missing") command.setIfMissing(undefined);
    else if (arg === "--trim-empty") command.setTrimEmpty(true);
    else if (arg === "--only-trailers") command.setOnlyTrailers(true);
    else if (arg === "--only-input") command.setOnlyInput(true);
    else if (arg === "--unfold") command.setUnfold(true);
    else if (arg === "--parse") command.setParse(true);
    else if (arg === "--no-divider") command.setNoDivider(true);
    else if (arg === "--in-place") command.setInPlace(true);
    else command.addFile(arg);
  }
}

async function ours(dir: string, scenario: Scenario) {
  const extra = commandLineEnv(scenario.commandLine);
  const hostEnv = { ...env(), ...extra };
  const g = await openOurs(
    dir,
    createNodeGitHostEnvironment({
      env: hostEnv,
      hookRunner: createNodeHookRunner({
        env: hostEnv,
        compatibility: nativeIs25x ? "2.56" : "2.43",
      }),
    }),
  );
  const command = g.interpretTrailers();
  applyArgs(command, scenario.args);
  if (scenario.input !== undefined) command.setInput(scenario.input);
  try {
    const r = await command.call();
    return { status: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (error) {
    if (!(error instanceof GitApiError)) throw error;
    return { status: error.exitCode, stdout: "", stderr: `${error.message}\n` };
  }
}

/** git's usage text after a usage error: compare its first line only. */
const firstLines = (stderr: string, status: number) =>
  status === 129 ? (stderr.split("\n")[0] ?? "") : stderr;

describeGit("git interpret-trailers against native git (t7513, JGit FooterLineTest)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "interpret-trailers-native-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  for (const scenario of SCENARIOS) {
    const skip =
      scenario.only === "2.5x" ? !nativeIs25x : scenario.only === "2.43" ? nativeIs25x : false;
    it.skipIf(skip)(`t7513: ${scenario.name}`, async () => {
      const dir = repository(scenario.config);
      const files = Object.entries(scenario.files ?? {});
      const writeFiles = () => {
        for (const [name, content] of files) {
          writeFileSync(join(dir, name), Buffer.from(content, "latin1"));
          if (name === "echoscript") chmodSync(join(dir, name), 0o755);
        }
      };
      writeFiles();
      const native = git(
        dir,
        ["interpret-trailers", ...scenario.args],
        commandLineEnv(scenario.commandLine),
        scenario.input ?? "",
      );
      const nativeFiles = files.map(([name]) => readFileSync(join(dir, name), "latin1"));
      writeFiles();
      const mine = await ours(dir, scenario);
      const label = JSON.stringify(scenario);
      expect(mine.status, label).toBe(native.status);
      expect(mine.stdout, label).toBe(native.stdout);
      expect(firstLines(mine.stderr, mine.status), label).toBe(
        firstLines(native.stderr, native.status),
      );
      expect(
        files.map(([name]) => readFileSync(join(dir, name), "latin1")),
        label,
      ).toEqual(nativeFiles);
    });
  }

  it("JGit FooterLineTest messages through --parse (and --only-trailers, a trailer added)", async () => {
    const dir = repository();
    const g = await openOurs(dir, createNodeGitHostEnvironment({ env: env() }));
    for (const [name, message] of JGIT_FOOTER_MESSAGES) {
      for (const args of [
        ["--parse"],
        ["--only-trailers"],
        ["--trailer", "Signed-off-by: X <x@y>"],
      ]) {
        const native = git(dir, ["interpret-trailers", ...args], {}, message);
        const command = g
          .interpretTrailers()
          .setInput(message)
          .setCompatibility(nativeIs25x ? "2.56" : "2.43");
        applyArgs(command, args);
        const mine = await command.call();
        expect(mine.stdout, `${name} ${args.join(" ")}`).toBe(native.stdout);
      }
    }
  });

  it("trailer commands without a hook runner are not run", async () => {
    const dir = repository([
      ["trailer.sign.command", "echo should-not-run"],
      ["trailer.fix.cmd", "echo should-not-run"],
    ]);
    const g = await openOurs(dir, createNodeGitHostEnvironment({ env: env() }));
    const r = await g.interpretTrailers().setInput("s\n").addTrailer("fix: 42").call();
    expect(r.stdout).toBe("s\n\nfix: 42\n");
    expect(r.stderr).toBe("");
  });

  // sequencer.c's append_signoff, as `git commit -s --cleanup=verbatim -F <message>` runs it
  // (ignored_log_message_bytes as the footer to keep after the sign-off)
  const SOB = signoffLine({ name: "Interop Tester", email: "interop@example.com" });
  const SIGNOFF_MESSAGES: string[] = [
    "subject",
    "subject\n",
    "subject\n\nbody\n",
    "subject\n\nbody\n\n",
    `subject\n\n${SOB}`,
    `subject\n\n${SOB}Acked-by: a\n`,
    `subject\n\nAcked-by: a\n${SOB}`,
    `subject\n\n${SOB.slice(0, -1)}`,
    "subject\n\nAcked-by: a\n",
    "subject\n\nAcked-by: a\nnot a trailer\n",
    "subject\n\nsome text\nmore text\nSigned-off-by: Other <o@x>\n",
    "subject\n\n(cherry picked from commit 0123)\n",
    "subject\n\nKey: v\n# a comment\n\n# trailing\n",
    "subject\n\nbody\n# ------------------------ >8 ------------------------\ndiff\n",
    `subject\n\n${SOB}\n# comment\n`,
    "subject\n\nKey: v\n\nConflicts:\n\ta.txt\n",
    "subject\n\nhttps://example.com/x\nKey: v\n",
  ];
  it("append_signoff against git commit -s (duplicate and last-line rules)", async () => {
    const dir = repository();
    for (const message of SIGNOFF_MESSAGES) {
      if (!nativeIs25x && message.includes("https://")) continue;
      writeFileSync(join(root, "msg"), message);
      const r = git(dir, [
        "commit",
        "-q",
        "--allow-empty",
        "-s",
        "--cleanup=verbatim",
        "-F",
        join(root, "msg"),
      ]);
      expect(r.status, r.stderr).toBe(0);
      const raw = git(dir, ["cat-file", "commit", "HEAD"]).stdout;
      const native = raw.slice(raw.indexOf("\n\n") + 2);
      const g = await openOurs(dir, createNodeGitHostEnvironment({ env: env() }));
      const config = trailerConfigOf(g.workingCopy);
      const mine = appendSignoff(message, SOB, config, false, ignoredLogMessageBytes(message));
      expect(mine, JSON.stringify(message)).toBe(native);
    }
  });

  // trailer.c's amend_strbuf_with_trailers (2.5x; 2.43 runs `interpret-trailers --in-place
  // --no-divider` on the message file), as `git commit --trailer` applies it
  it("amendWithTrailers against git commit --trailer (t7502's --trailer, config applied)", async () => {
    const dir = repository([
      ["trailer.ack.key", "Acked-by"],
      ["trailer.ack.ifexists", "replace"],
      ["trailer.fix.where", "start"],
    ]);
    const cases: [string, string[]][] = [
      ["subject\n", ["Acked-by: A"]],
      ["subject", ["Acked-by: A"]],
      ["subject\n\nbody\n\nAcked-by: old\nFix: 1\n", ["ack: new", "fix=2", "Cc: c"]],
      ["subject\n\nbody\n---\nnot a divider here\n\nKey: v\n", ["Key: w"]],
      ["subject\n\nKey: v\n", ["Key: v"]],
    ];
    const g = await openOurs(dir, createNodeGitHostEnvironment({ env: env() }));
    const config = {
      ...trailerConfigOf(g.workingCopy),
      compatibility: nativeIs25x ? "2.56" : "2.43",
    } as const;
    for (const [message, args] of cases) {
      writeFileSync(join(root, "msg"), message);
      const r = git(dir, [
        "commit",
        "-q",
        "--allow-empty",
        "--cleanup=verbatim",
        "-F",
        join(root, "msg"),
        ...args.flatMap((a) => ["--trailer", a]),
      ]);
      expect(r.status, r.stderr).toBe(0);
      const raw = git(dir, ["cat-file", "commit", "HEAD"]).stdout;
      const native = raw.slice(raw.indexOf("\n\n") + 2);
      const mine = await amendWithTrailers(message, args, config);
      expect(mine.output, JSON.stringify([message, args])).toBe(native);
    }
  });
});
