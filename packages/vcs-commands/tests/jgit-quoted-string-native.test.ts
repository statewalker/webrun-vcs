/**
 * JGit's `QuotedStringGitPathStyleTest`, `QuotedStringBourneStyleTest` and
 * `QuotedStringBourneUserPathStyleTest` (org.eclipse.jgit.test, `util/`) as native twins
 * (statewalker/webrun-vcs#218). Only JGit's inputs are taken; native git decides:
 *
 * - C-quoting of paths (JGit's `GIT_PATH`, and `GIT_PATH_MINIMAL` for `core.quotePath=false`):
 *   each name JGit quotes is an index entry, listed by `git ls-files` under both settings;
 * - C-dequoting: each text JGit dequotes (wrapped in `"` as its `assertDequote` does, or bare)
 *   is a `git check-attr --stdin` input line, which git unquotes (`unquote_c_style`);
 * - Bourne quoting: `git rev-parse --sq-quote` (quote.c's `sq_quote_buf`) against our
 *   `sqQuoteArgv`;
 * - Bourne dequoting: each text is a value of `GIT_CONFIG_PARAMETERS` (`'a.b'=<text>`, read
 *   with `sq_dequote_step`), asked with `git config --get a.b`.
 *
 * Paths and texts are bytes (latin1 strings here), as JGit's `ISO_8859_1` inputs are.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sqQuoteArgv } from "../src/commands/bisect/bisect-quote.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import {
  git,
  nativeCompatibility,
  type Outcome,
  outcomeOf,
  plumbingEnv,
} from "./plumbing-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

/** A Java string's UTF-8 bytes, as a latin1 string (JGit's `Constants.encode`). */
const utf8 = (s: string) => Buffer.from(s, "utf8").toString("latin1");

/** The names JGit's GIT_PATH and GIT_PATH_MINIMAL quote, as UTF-8 bytes. */
const QUOTED_NAMES: [string, string[]][] = [
  ["QuotedStringGitPathStyleTest#testQuote_BareA", ["a"]],
  [
    "QuotedStringGitPathStyleTest#testQuote_NamedEscapes",
    ["\u0007", "\b", "\f", "\n", "\r", "\t", "\u000b", "\\", '"'],
  ],
  ["QuotedStringGitPathStyleTest#testQuote_OctalAll", ["\u0001", "\u007f", "ÿ"]],
  ["QuotedStringGitPathStyleTest#testQuote_Ang", ["Ångström"]],
  ["QuotedStringGitPathStyleTest#testQuoteAtAndNumber", ["abc@2x.png"]],
  ["QuotedStringGitPathStyleTest#testNoQuote", ["Ångström"]],
  ["QuotedStringGitPathStyleTest#testQuoteMinimal", ["Ån\\ström"]],
];

const octal = (i: number) => `\\${i.toString(8).padStart(3, "0")}`;

/** The texts JGit's GIT_PATH dequotes, as bytes: `"`-wrapped (assertDequote) or bare. */
const DEQUOTED: [string, string[]][] = [
  ["QuotedStringGitPathStyleTest#testDequote_Empty1", [""]],
  ["QuotedStringGitPathStyleTest#testDequote_Empty2", ['""']],
  ["QuotedStringGitPathStyleTest#testDequote_SoleDq", ['"']],
  ["QuotedStringGitPathStyleTest#testDequote_BareA", ["a"]],
  ["QuotedStringGitPathStyleTest#testDequote_BareABCZ_OnlyBC", ["abcz", "bc"]],
  ["QuotedStringGitPathStyleTest#testDequote_LoneBackslash", ['"\\"']],
  [
    "QuotedStringGitPathStyleTest#testDequote_NamedEscapes",
    ["\\a", "\\b", "\\f", "\\n", "\\r", "\\t", "\\v", "\\\\", '\\"'].map((s) => `"${s}"`),
  ],
  [
    "QuotedStringGitPathStyleTest#testDequote_OctalAll",
    [
      ...Array.from({ length: 127 }, (_, i) => octal(i)),
      ...Array.from({ length: 128 }, (_, k) => {
        const i = 128 + k;
        return octal(0xc0 | (i >> 6)) + octal(0x80 | (i & 0x3f));
      }),
    ].map((s) => `"${s}"`),
  ],
  ["QuotedStringGitPathStyleTest#testDequote_UnknownEscapeQ", ['"\\q"']],
  ["QuotedStringGitPathStyleTest#testDequote_FooTabBar", ['"foo\\tbar"']],
  ["QuotedStringGitPathStyleTest#testDequote_Latin1", ['"\\305ngstr\\366m"']],
  ["QuotedStringGitPathStyleTest#testDequote_UTF8", ['"\\303\\205ngstr\\303\\266m"']],
  ["QuotedStringGitPathStyleTest#testDequote_RawUTF8", ['"Ã\u0085ngstrÃ¶m"']],
  ["QuotedStringGitPathStyleTest#testDequote_RawLatin1", ['"Ångström"']],
  ["QuotedStringGitPathStyleTest#testQuoteAtAndNumber", ['"abc\\1002x.png"']],
  [
    "QuotedStringGitPathStyleTest#testDequoteMinimal, #testQuoteNormalDequoteMinimal",
    [`"${utf8("Ån")}\\\\str${utf8("öm")}"`, '"\\303\\205n\\\\str\\303\\266m"'],
  ],
  [
    "QuotedStringGitPathStyleTest#testRoundtripMinimal, #testRoundtripNormalDequoteMinimal",
    [utf8("Ångström"), '"\\303\\205ngstr\\303\\266m"'],
  ],
];

/** The texts JGit's BOURNE and BOURNE_USER_PATH quote. */
const SQ_QUOTED: [string, string[]][] = [
  ["QuotedStringBourneStyleTest#testQuote_Empty", [""]],
  ["QuotedStringBourneStyleTest#testQuote_BareA", ["a"]],
  ["QuotedStringBourneStyleTest#testQuote_NamedEscapes", ["'", "!", "a'b", "a!b"]],
  ["QuotedStringBourneUserPathStyleTest#testQuote_User", ["~foo", "~foo/", "~/", "~foo/a", "~/a"]],
];

/** The texts JGit's BOURNE and BOURNE_USER_PATH dequote. */
const SQ_DEQUOTED: [string, string[]][] = [
  ["QuotedStringBourneStyleTest#testDequote_Empty1", [""]],
  ["QuotedStringBourneStyleTest#testDequote_Empty2", ["''"]],
  ["QuotedStringBourneStyleTest#testDequote_SoleSq", ["'"]],
  ["QuotedStringBourneStyleTest#testDequote_BareA", ["a"]],
  ["QuotedStringBourneStyleTest#testDequote_BareABCZ_OnlyBC", ["abcz", "bc"]],
  ["QuotedStringBourneStyleTest#testDequote_LoneBackslash", ["\\"]],
  [
    "QuotedStringBourneStyleTest#testDequote_NamedEscapes",
    ["'\\''", "'\\!'", "a'\\''b", "a'\\!'b"],
  ],
  [
    "QuotedStringBourneUserPathStyleTest#testDequote_User",
    ["~foo", "~foo/", "~/", "~foo/'a'", "~/'a'"],
  ],
];

let root = "";
let counter = 0;

function nativeRun(dir: string, args: string[], stdin = "", env: Record<string, string> = {}) {
  const r = spawnSync("git", args, {
    cwd: dir,
    env: plumbingEnv(root, env),
    encoding: "latin1",
    input: Buffer.from(stdin, "latin1"),
  });
  return { status: r.status ?? -1, out: r.stdout, err: r.stderr } satisfies Outcome;
}

function repository(): string {
  const dir = join(root, `r${counter++}`);
  git(root, root, ["init", "-q", "-b", "main", dir]);
  return dir;
}

/** `-c core.quotePath=<value>` as the environment's command-line configuration. */
const quotePathEnv = (value: string): Record<string, string> => {
  const base: Record<string, string> = plumbingEnv(root);
  const n = Number(base.GIT_CONFIG_COUNT ?? "0");
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: "core.quotePath",
    [`GIT_CONFIG_VALUE_${n}`]: value,
  };
};

describeGit("JGit QuotedString*Test against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "jgit-quoted-"));
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  for (const [source, names] of QUOTED_NAMES) {
    it(`JGit ${source}: ls-files quotes as git`, async () => {
      const dir = repository();
      const entries = names.map((n) => `100644 ${EMPTY_BLOB}\t${utf8(n)}\0`).join("");
      const added = nativeRun(dir, ["update-index", "-z", "--index-info"], entries);
      expect(added.status, added.err).toBe(0);
      for (const value of ["true", "false"]) {
        const env = quotePathEnv(value);
        const native = nativeRun(dir, ["ls-files"], "", env);
        const g = await openOurs(
          dir,
          createNodeGitHostEnvironment({ env: plumbingEnv(root, env) }),
        );
        const out = await g.lsFiles().setCompatibility(nativeCompatibility()).callOutput();
        expect(
          {
            status: out.exitCode,
            out: Buffer.from(out.stdout).toString("latin1"),
            err: out.stderr,
          },
          `core.quotePath=${value}`,
        ).toEqual(native);
      }
    });
  }

  for (const [source, texts] of DEQUOTED) {
    it(`JGit ${source}: check-attr --stdin unquotes as git`, async () => {
      const dir = repository();
      for (const text of texts) {
        for (const value of ["true", "false"]) {
          const env = quotePathEnv(value);
          const args = ["check-attr", "--stdin", "test"];
          const native = nativeRun(dir, args, `${text}\n`, env);
          const g = await openOurs(
            dir,
            createNodeGitHostEnvironment({ env: plumbingEnv(root, env) }),
          );
          const cmd = g
            .checkAttr()
            .setCompatibility(nativeCompatibility())
            .addAttribute("test")
            .setStdin(Buffer.from(`${text}\n`, "latin1"));
          expect(outcomeOf(await cmd.call()), `${JSON.stringify(text)} quotePath=${value}`).toEqual(
            native,
          );
        }
      }
    });
  }

  for (const [source, texts] of SQ_QUOTED) {
    it(`JGit ${source}: rev-parse --sq-quote`, () => {
      for (const text of texts) {
        const native = nativeRun(root, ["rev-parse", "--sq-quote", utf8(text)]);
        expect(native.status).toBe(0);
        expect(`${sqQuoteArgv([text])}\n`, JSON.stringify(text)).toBe(
          Buffer.from(native.out, "latin1").toString("utf8"),
        );
      }
    });
  }

  for (const [source, texts] of SQ_DEQUOTED) {
    it(`JGit ${source}: GIT_CONFIG_PARAMETERS dequotes as git`, async () => {
      const dir = repository();
      for (const text of texts) {
        const env = { GIT_CONFIG_PARAMETERS: `'a.b'=${text}` };
        const native = nativeRun(dir, ["config", "--get", "a.b"], "", env);
        let ours: Outcome;
        try {
          const g = await openOurs(
            dir,
            createNodeGitHostEnvironment({ env: plumbingEnv(root, env) }),
          );
          const r = await g.config().setCompatibility(nativeCompatibility()).get("a.b").call();
          ours = { status: r.exitCode, out: r.stdout, err: r.stderr };
        } catch (error) {
          const e = error as { exitCode?: number; message: string };
          ours = {
            status: e.exitCode ?? -1,
            out: "",
            err: e.message.endsWith("\n") ? e.message : `${e.message}\n`,
          };
        }
        expect(ours, JSON.stringify(text)).toEqual(native);
      }
    });
  }
});
