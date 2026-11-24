/**
 * `git config`'s read side (`ConfigCommand`) against native git: `--type` canonicalisation on
 * get and set, `--default`, `--get-regexp`, `--list`, `--name-only`, `-z`, `--get-urlmatch`,
 * `--get-color`/`--get-colorbool`, `--show-origin`, `--show-scope` and `--blob`, in the legacy
 * option syntax and in 2.46's `get`/`list`/`set` subcommands. Each step runs in native git and
 * in ours on twin repositories; their exit status, stdout, stderr and `.git/config` must be
 * equal after each step.
 *
 * Run with the system git (2.43) and with 2.56.1 first on `PATH`; ours takes the version's
 * compatibility from `git --version`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type ConfigCommand, Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let version = "";

/** A step: git's argv after `config`, and when it runs. */
interface Step {
  args: string[];
  /** The oldest git that has the options (subcommands: 2.46) */
  min?: [number, number];
  /** Extra environment of this step (`{dir}` is the twin's directory; undefined removes) */
  env?: Record<string, string | undefined>;
}

interface Scenario {
  /** The t/ script and the titles of the tests ported */
  title: string;
  /** Files written into both twins (`.git/config` replaced; `{dir}` is the twin's directory) */
  files?: Record<string, string>;
  /** Native git run in both twins first (after `files`) */
  setup?: string[][];
  /** Extra environment of every step */
  env?: Record<string, string | undefined>;
  steps: (string[] | Step)[];
}

const SUB: [number, number] = [2, 46];

const T1300_LIST = `[beta] ; silly comment # another comment
noIndent= sillyValue ; 'nother silly comment

# empty line
		; comment
[nextSection]
	NoNewLine = wow2 for me
[123456]
	a123 = 987
[Version "1.2.3eX"]
	Alpha = beta
`;

const T1300_TYPES = `[section]
foo = True
number = 10
big = 1M
path = ~/dir
red = red
blue = Blue
date = Fri Jun 4 15:46:55 2010
missing=:(optional)no-such-path
exists=:(optional)expect
`;

const SHOW_ORIGIN_FILES = {
  "home/include/absolute.include": "[user]\n\tabsolute = include\n",
  "home/include/relative.include": "[user]\n\trelative = include\n",
  "home/.gitconfig":
    '[user]\n\tglobal = true\n\toverride = global\n[include]\n\tpath = "{dir}/home/include/absolute.include"\n',
  ".git/config":
    "[user]\n\tlocal = true\n\toverride = local\n[include]\n\tpath = ../include/relative.include\n",
  "include/relative.include": "[user]\n\trelative = include\n",
  "custom.conf": "[user]\n\tcustom = true\n",
  'file" (dq) and spaces.conf': "[user]\n\tcustom = true\n",
};

const COMMIT_CUSTOM = [
  ["add", "custom.conf"],
  ["commit", "-q", "-m", "new config file"],
];

const URLMATCH_SPECIFIC = `[http "https://example.com/"]
	cookieFile = /tmp/root.txt
[http "https://example.com/subdirectory"]
	cookieFile = /tmp/subdirectory.txt
[http "https://user@example.com/"]
	cookieFile = /tmp/user.txt
[http "https://averylonguser@example.com/"]
	cookieFile = /tmp/averylonguser.txt
[http "https://preceding.example.com"]
	cookieFile = /tmp/preceding.txt
[http "https://*.example.com"]
	cookieFile = /tmp/wildcard.txt
[http "https://*.example.com/wildcardwithsubdomain"]
	cookieFile = /tmp/wildcardwithsubdomain.txt
[http "https://*.example.*"]
	cookieFile = /tmp/multiwildcard.txt
[http "https://trailing.example.com"]
	cookieFile = /tmp/trailing.txt
[http "https://user@*.example.com/"]
	cookieFile = /tmp/wildcardwithuser.txt
[http "https://sub.example.com/"]
	cookieFile = /tmp/sub.txt
`;

/** Both syntaxes of one `--get-urlmatch HTTP <url>`. */
const urlmatchHttp = (url: string): (string[] | Step)[] => [
  ["--get-urlmatch", "HTTP", url],
  { args: ["get", `--url=${url}`, "HTTP"], min: SUB },
];

const scenarios: Scenario[] = [
  {
    title:
      't1300-config.sh: "working --list", "--name-only --list", "--get-regexp", "--name-only --get-regexp"',
    files: { ".git/config": T1300_LIST },
    steps: [
      ["--list"],
      ["--list", "--name-only"],
      ["--get-regexp", "in"],
      ["--get-regexp", "--name-only", "in"],
      ["--get-regexp", "IN"],
      ["--get-regexp", "Version.1.2.3eX"],
      ["--get-regexp", "(["],
      ["--get-regexp", "in", "!wow"],
      ["--get-regexp", "--fixed-value", "in", "wow2 for me"],
      { args: ["list"], min: SUB },
      { args: ["list", "--name-only"], min: SUB },
      { args: ["get", "--regexp", "--all", "--show-names", "in"], min: SUB },
      { args: ["get", "--regexp", "--all", "--show-names", "--name-only", "in"], min: SUB },
      { args: ["get", "--regexp", "in"], min: SUB },
      { args: ["get", "--show-names", "beta.noindent"], min: SUB },
    ],
  },
  {
    title:
      't1300-config.sh: "get-regexp variable with no value", "get-regexp --bool variable with no value", "get-regexp variable with empty value", "get bool variable with no value", "get bool variable with empty value"',
    files: { ".git/config": "[novalue]\n\tvariable\n[emptyvalue]\n\tvariable =\n" },
    steps: [
      ["--get-regexp", "novalue"],
      ["--get-regexp", "--bool", "novalue"],
      ["--get-regexp", "emptyvalue"],
      ["--bool", "novalue.variable"],
      ["--bool", "emptyvalue.variable"],
      ["--int", "novalue.variable"],
      ["--bool-or-int", "novalue.variable"],
      ["--bool-or-str", "novalue.variable"],
      ["--path", "novalue.variable"],
      ["--expiry-date", "novalue.variable"],
      ["--type=color", "novalue.variable"],
      ["--list", "--type=bool"],
      ["--list", "--type=bool-or-int"],
      ["--list", "--type=int"],
      ["--list", "--type=path"],
      ["--null", "--get-regexp", "value"],
    ],
  },
  {
    title:
      't1300-config.sh: "numbers", "--int is at least 64 bits", "invalid unit", "invalid unit boolean"',
    steps: [
      ["kilo.gram", "1k"],
      ["mega.ton", "1m"],
      ["--int", "--get", "kilo.gram"],
      ["--int", "--get", "mega.ton"],
      ["giga.watts", "121g"],
      ["--int", "--get", "giga.watts"],
      ["aninvalid.unit", "1auto"],
      ["aninvalid.unit"],
      ["--int", "--get", "aninvalid.unit"],
      ["commit.gpgsign", "1true"],
      ["--bool", "--get", "commit.gpgsign"],
      ["big.number", "9223372036854775807"],
      ["--int", "big.number"],
      ["huge.number", "9223372036854775808"],
      ["--int", "huge.number"],
      ["--bool-or-int", "big.number"],
      ["hex.number", "0x1F"],
      ["--int", "hex.number"],
      ["octal.number", "010"],
      ["--int", "octal.number"],
      ["--bool", "octal.number"],
      ["spaced.number", " 12"],
      ["--int", "spaced.number"],
      ["trailing.number", "12 "],
      ["--int", "trailing.number"],
      { args: ["get", "--type=int", "kilo.gram"], min: SUB },
      { args: ["get", "--type=int", "aninvalid.unit"], min: SUB },
    ],
  },
  {
    title:
      't1300-config.sh: "bool", "invalid bool (--get)", "invalid bool (set)", "set --bool", "set --int"',
    steps: [
      ["bool.true1", "01"],
      ["bool.true2", "-1"],
      ["bool.true3", "YeS"],
      ["bool.true4", "true"],
      ["bool.false1", "000"],
      ["bool.false2", ""],
      ["bool.false3", "nO"],
      ["bool.false4", "FALSE"],
      ["--bool", "--get", "bool.true1"],
      ["--bool", "--get", "bool.true2"],
      ["--bool", "--get", "bool.true3"],
      ["--bool", "--get", "bool.true4"],
      ["--bool", "--get", "bool.false1"],
      ["--bool", "--get", "bool.false2"],
      ["--bool", "--get", "bool.false3"],
      ["--bool", "--get", "bool.false4"],
      ["--get-regexp", "--bool", "bool"],
      ["bool.nobool", "foobar"],
      ["--bool", "--get", "bool.nobool"],
      ["--bool", "bool.nobool", "foobar"],
      ["--bool", "bool.true1", "01"],
      ["--bool", "bool.true2", "-1"],
      ["--bool", "bool.true3", "YeS"],
      ["--bool", "bool.false2", ""],
      ["--bool", "bool.false3", "nO"],
      ["--int", "int.val1", "01"],
      ["--int", "int.val2", "-1"],
      ["--int", "int.val3", "5m"],
      ["--int", "int.val4", "lots"],
      ["--bool", "--add", "bool.added", "on"],
      ["--int", "--replace-all", "int.val1", "2k"],
      { args: ["set", "--type=bool", "bool.sub", "off"], min: SUB },
      { args: ["set", "--type=int", "int.sub", "3g"], min: SUB },
      { args: ["set", "--type=int", "int.sub", "x"], min: SUB },
      { args: ["set", "--bool", "--append", "bool.sub", "1"], min: SUB },
    ],
  },
  {
    title: 't1300-config.sh: "get --bool-or-int", "set --bool-or-int"',
    files: {
      ".git/config":
        "[bool]\ntrue1\ntrue2 = true\nfalse = false\n[int]\nint1 = 0\nint2 = 1\nint3 = -1\nbig = 5000000000\n",
    },
    steps: [
      ["--bool-or-int", "bool.true1"],
      ["--bool-or-int", "bool.true2"],
      ["--bool-or-int", "bool.false"],
      ["--bool-or-int", "int.int1"],
      ["--bool-or-int", "int.int2"],
      ["--bool-or-int", "int.int3"],
      ["--bool-or-int", "int.big"],
      ["--bool-or-str", "int.int2"],
      ["--bool-or-str", "int.big"],
      ["--bool-or-int", "bool.true3", "true"],
      ["--bool-or-int", "bool.false1", "false"],
      ["--bool-or-int", "bool.true4", "yes"],
      ["--bool-or-int", "bool.false2", "no"],
      ["--bool-or-int", "int.int4", "0"],
      ["--bool-or-int", "int.int5", "1k"],
      ["--bool-or-int", "int.int6", "-1"],
      ["--bool-or-int", "int.int7", "4g"],
      ["--bool-or-str", "str.s1", "On"],
      ["--bool-or-str", "str.s2", "words"],
    ],
  },
  {
    title:
      't1300-config.sh: "set --path", "get --path", "get --path copes with unset $HOME", "get --path barfs on boolean variable"',
    steps: [
      ["--path", "path.home", "~/"],
      ["--path", "path.normal", "/dev/null"],
      ["--path", "path.trailingtilde", "foo~"],
      ["--path", "path.sub", "~/sub/dir"],
      ["--get", "--path", "path.home"],
      ["--get", "--path", "path.normal"],
      ["--get", "--path", "path.trailingtilde"],
      ["--get", "--path", "path.sub"],
      { args: ["--get", "--path", "path.home"], env: { HOME: undefined } },
      { args: ["--get", "--path", "path.normal"], env: { HOME: undefined } },
      ["--path", "path.bool"],
      ["--get-regexp", "--path", "path"],
      ["--list", "--path"],
      { args: ["get", "--type=path", "--all", "--regexp", "path"], min: SUB },
    ],
  },
  {
    title:
      't1300-config.sh: "get --path barfs on boolean variable", "get --expiry-date", "get --type=color", "get --type=color with default value only", "set --type=color", "get --type=color barfs on non-color", "set --type=color barfs on non-color"',
    files: {
      ".git/config":
        '[path]bool\n[date]\nvalid1 = "3.weeks.5.days 00:00"\nvalid2 = "Fri Jun 4 15:46:55 2010"\nvalid3 = "2017/11/11 11:11:11PM"\nvalid4 = "2017/11/10 09:08:07 PM"\nvalid5 = "never"\nvalid6 = now\nvalid7 = 1700000000 +0200\ninvalid1 = "abc"\n[foo]\nbar=not-a-color\n',
    },
    steps: [
      ["--get", "--path", "path.bool"],
      ["--expiry-date", "date.valid1"],
      ["--expiry-date", "date.valid2"],
      ["--expiry-date", "date.valid3"],
      ["--expiry-date", "date.valid4"],
      ["--expiry-date", "date.valid5"],
      ["--expiry-date", "date.valid6"],
      ["--expiry-date", "date.valid7"],
      ["--expiry-date", "date.invalid1"],
      ["--get", "--type=color", "foo.bar"],
      ["--type=color", "foo.color", "red"],
      ["--get", "--type=color", "foo.color"],
      { args: ["get", "--type=color", "foo.color"], min: SUB },
      ["--get-color", "", "red"],
      ["--get-color", "foo.color"],
      ["--get-color", "foo.missing", "bold blue reverse"],
      ["--get-color", "foo.missing", "#ff0000 #00ff00"],
      ["--get-color", "foo.missing", "#f00"],
      ["--get-color", "foo.missing", "bogus"],
      ["--get-color", "foo.bar", "red"],
      ["--get-color", "--bool", "foo.color"],
      { args: ["get", "--type=color", "--default=red", ""], min: SUB },
      { args: ["get", "--type=color", "--default=bogus", ""], min: SUB },
      ["--type=color", "foo.color", "not-a-color"],
      ["--type=color", "foo.color2", "brightred ul"],
      ["--type=color", "foo.color3", "#abc"],
      ["--type=color", "--get", "foo.color2"],
    ],
  },
  {
    title: 't1300-config.sh: "--null --list", "--null --get-regexp"',
    files: {
      ".git/config":
        '[section "sub=section"]\n\tval1 = foo=bar\n\tval2 = foo\\nbar\n\tval3 = \\n\\n\n\tval4 =\n\tval5\n',
    },
    steps: [
      ["--list", "--null"],
      ["--get-regexp", "--null", "val[0-9]"],
      ["--null", "--get-all", "section.sub=section.val1"],
      ["--null", "--name-only", "--list"],
      { args: ["list", "--null"], min: SUB },
      { args: ["get", "--regexp", "--all", "--show-names", "--null", "val[0-9]"], min: SUB },
    ],
  },
  {
    title: 't1300-config.sh: "urlmatch", "urlmatch with --show-scope"',
    files: {
      ".git/config":
        '[http]\n\tsslVerify\n[http "https://weak.example.com"]\n\tsslVerify = false\n\tcookieFile = /tmp/cookie.txt\n',
    },
    steps: [
      ["--bool", "--get-urlmatch", "doesnt.exist", "https://good.example.com"],
      { args: ["get", "--url=https://good.example.com", "--bool", "doesnt.exist"], min: SUB },
      ["--bool", "--get-urlmatch", "http.SSLverify", "https://good.example.com"],
      { args: ["get", "--bool", "--url=https://good.example.com", "http.SSLverify"], min: SUB },
      ["--bool", "--get-urlmatch", "http.sslverify", "https://weak.example.com"],
      { args: ["get", "--bool", "--url=https://weak.example.com", "http.sslverify"], min: SUB },
      ...urlmatchHttp("https://weak.example.com"),
      ["--get-urlmatch", "--show-scope", "HTTP", "https://weak.example.com"],
      { args: ["get", "--url=https://weak.example.com", "--show-scope", "HTTP"], min: SUB },
      ["--get-urlmatch", "http.sslverify", "https://weak.example.com"],
      ["--get-urlmatch", "http.sslverify", "not-a-url"],
      ["--get-urlmatch", "http.sslverify", "https://"],
      ["--get-urlmatch", "http.sslverify", "https://bad host/"],
      ["--get-urlmatch", "http.sslverify", "https://x:0/"],
      ["--get-urlmatch", "http.sslverify", "https://x/%zz"],
      ["--get-urlmatch", "http.sslverify", "https://x/.."],
      ["--get-urlmatch", "http.sslverify", "file://h:22/x"],
      ["--get-urlmatch", "--show-origin", "http", "https://weak.example.com"],
      ["--get-urlmatch", "--null", "http", "https://weak.example.com"],
      { args: ["get", "--url=https://x", "--all", "http"], min: SUB },
      { args: ["get", "--url=https://x", "--default=1", "http"], min: SUB },
    ],
  },
  {
    title: 't1300-config.sh: "urlmatch favors more specific URLs"',
    files: { ".git/config": URLMATCH_SPECIFIC },
    steps: [
      ...urlmatchHttp("https://example.com"),
      ...urlmatchHttp("https://example.com/subdirectory"),
      ...urlmatchHttp("https://example.com/subdirectory/nested"),
      ...urlmatchHttp("https://user@example.com/"),
      ...urlmatchHttp("https://averylonguser@example.com/subdirectory"),
      ...urlmatchHttp("https://preceding.example.com"),
      ...urlmatchHttp("https://wildcard.example.com"),
      ...urlmatchHttp("https://sub.example.com/wildcardwithsubdomain"),
      ...urlmatchHttp("https://trailing.example.com"),
      ...urlmatchHttp("https://user@sub.example.com"),
      ...urlmatchHttp("https://wildcard.example.org"),
      ["--get-urlmatch", "HTTP", "HTTPS://EXAMPLE.COM:443/a/./b/../subdirectory/%7e"],
      ["--get-urlmatch", "HTTP", "https://example.com:0443/subdirectory"],
      ["--get-urlmatch", "HTTP", "https://example.com:8443/subdirectory"],
      ["--get-urlmatch", "HTTP", "https://user:pw@example.com/subdirectoryx"],
      ["--get-urlmatch", "HTTP", "https://example.com/sub%64irectory"],
      ["--get-urlmatch", "HTTP", "http://example.com/"],
    ],
  },
  {
    title: 't1300-config.sh: "urlmatch with wildcard"',
    files: {
      ".git/config":
        '[http]\n\tsslVerify\n[http "https://*.example.com"]\n\tsslVerify = false\n\tcookieFile = /tmp/cookie.txt\n[http "https://*.example.com:8080/a"]\n\tcookieFile = /tmp/port.txt\n[http "not a url"]\n\tcookieFile = /tmp/bad.txt\n',
    },
    steps: [
      ["--bool", "--get-urlmatch", "doesnt.exist", "https://good.example.com"],
      ["--bool", "--get-urlmatch", "http.SSLverify", "https://example.com"],
      ["--bool", "--get-urlmatch", "http.SSLverify", "https://good-example.com"],
      ["--bool", "--get-urlmatch", "http.sslverify", "https://deep.nested.example.com"],
      ["--bool", "--get-urlmatch", "http.sslverify", "https://good.example.com"],
      ["--get-urlmatch", "HTTP", "https://good.example.com"],
      ["--get-urlmatch", "HTTP", "https://more.example.com.au"],
      ["--get-urlmatch", "HTTP", "https://x.example.com:8080/a/b"],
      ["--get-urlmatch", "HTTP", "https://x.example.com:8080/ab"],
      ["--int", "--get-urlmatch", "http.sslverify", "https://good.example.com"],
      ["--type=color", "--get-urlmatch", "http", "https://good.example.com"],
    ],
  },
  {
    title:
      't1300-config.sh: "--show-origin with --list", "--show-origin with --list --null", "--show-origin with single file", "--show-origin with --get-regexp", "--show-origin getting a single key", "--show-origin escape special file name characters", "--show-origin with --default"',
    files: SHOW_ORIGIN_FILES,
    env: { GIT_CONFIG_GLOBAL: undefined },
    steps: [
      {
        args: ["--list", "--show-origin"],
        env: {
          GIT_CONFIG_PARAMETERS: "'user.cmdline'='true'",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "user.environ",
          GIT_CONFIG_VALUE_0: "true",
        },
      },
      {
        args: ["list", "--show-origin"],
        min: SUB,
        env: { GIT_CONFIG_PARAMETERS: "'user.cmdline'='true'" },
      },
      {
        args: ["--list", "--null", "--show-origin"],
        env: { GIT_CONFIG_PARAMETERS: "'user.cmdline'='true'" },
      },
      ["--list", "--local", "--show-origin"],
      { args: ["list", "--local", "--show-origin"], min: SUB },
      ["--get-regexp", "--show-origin", "user\\.[g|l].*"],
      ["--get", "--show-origin", "user.override"],
      ["--get-all", "--show-origin", "user.override"],
      { args: ["get", "--show-origin", "user.override"], min: SUB },
      ["--list", '--file=file" (dq) and spaces.conf', "--show-origin"],
      ["--list", "--file=custom.conf", "--show-origin", "--show-scope"],
      ["--list", "--global", "--show-origin"],
      ["--list", "--global", "--includes", "--show-origin"],
      ["--show-origin", "--default", "foo", "some.key"],
      ["--show-origin", "--default", "foo", "--bool", "user.local"],
      ["--show-origin", "--get-urlmatch", "user", "https://x"],
      ["--show-origin", "--name-only", "--get", "user.local"],
    ],
  },
  {
    title:
      't1300-config.sh: "--show-origin blob", "--show-origin blob ref", "--show-scope with --blob"',
    files: SHOW_ORIGIN_FILES,
    setup: COMMIT_CUSTOM,
    env: { GIT_CONFIG_GLOBAL: undefined },
    steps: [
      ["--list", "--blob=HEAD:custom.conf", "--show-origin"],
      ["--list", "--blob=main:custom.conf", "--show-origin"],
      ["--list", "--blob=HEAD:custom.conf", "--show-scope"],
      { args: ["list", "--blob=HEAD:custom.conf", "--show-origin"], min: SUB },
      ["--blob=HEAD:custom.conf", "--show-origin", "--show-scope", "user.custom"],
    ],
  },
  {
    title:
      't1300-config.sh: "--show-scope with --list", "--show-scope with --local", "--show-scope getting a single value", "--show-scope with --show-origin", "--show-scope with --default"',
    files: SHOW_ORIGIN_FILES,
    setup: [
      ...COMMIT_CUSTOM,
      ["worktree", "add", "-q", "wt1"],
      ["config", "core.repositoryformatversion", "1"],
      ["config", "extensions.worktreeConfig", "true"],
      ["config", "--worktree", "user.worktree", "true"],
    ],
    env: { GIT_CONFIG_GLOBAL: undefined },
    steps: [
      {
        args: ["--list", "--show-scope"],
        env: { GIT_CONFIG_PARAMETERS: "'user.cmdline'='true'" },
      },
      { args: ["list", "--show-scope"], min: SUB },
      ["--list", "--local", "--show-scope"],
      ["--list", "--worktree", "--show-scope", "--show-origin"],
      ["--get", "--show-scope", "user.local"],
      { args: ["get", "--show-scope", "user.local"], min: SUB },
      {
        args: ["--list", "--show-origin", "--show-scope"],
        env: { GIT_CONFIG_PARAMETERS: "'user.cmdline'='true'" },
      },
      ["--show-scope", "--default", "foo", "some.key"],
      ["--get-regexp", "--show-scope", "--show-origin", "--name-only", "^user"],
    ],
  },
  {
    title:
      't1300-config.sh: "identical modern --type specifiers are allowed", "--type allows valid type specifiers", "--no-type unsets type specifiers", "list --type=int shows only canonicalizable int values", "list --type=bool shows only canonicalizable bool values", "list --type=bool-or-int shows only canonicalizable values", "list --type=path shows only canonicalizable path values", "list --type=expiry-date shows only canonicalizable dates", "list --type=color shows only canonicalizable color values", "--type rejects unknown specifiers", "--type=int requires at least one digit"',
    files: { ".git/config": T1300_TYPES, expect: "" },
    steps: [
      ["--type=int", "section.big"],
      ["--type=bool", "section.foo"],
      ["--type=bool", "--no-type", "section.number"],
      ["--list", "--type=int"],
      ["--list", "--type=bool"],
      ["--list", "--type=bool-or-int"],
      ["--list", "--type=path"],
      ["--list", "--type=color"],
      ["--list", "--type=bool-or-str"],
      { args: ["list", "--type=int"], min: SUB },
      { args: ["list", "--type=path"], min: SUB },
      ["--type=nonsense", "section.foo"],
      ["--type", "int", "--default", "m", "some.key"],
      ["--type=path", "section.missing"],
      ["--type=path", "section.exists"],
      ["--type=expiry-date", "section.date"],
      ["--get-regexp", "--type=path", "section.(missing|exists|path)"],
    ],
  },
  {
    title:
      't1310-config-default.sh: "uses --default when entry missing", "does not use --default when entry present", "canonicalizes --default with appropriate type", "dies when --default cannot be parsed", "does not allow --default without --get"',
    steps: [
      ["-f", "config", "--default=quux", "core.foo"],
      { args: ["--default=baz", "core.foo"], env: { GIT_CONFIG_PARAMETERS: "'core.foo'='bar'" } },
      ["-f", "config", "--default=yes", "--bool", "core.foo"],
      ["-f", "config", "--type=expiry-date", "--default=x", "--get", "not.a.section"],
      ["--default=quux", "--unset", "a.section"],
      ["--default=quux", "--get-all", "a.section"],
      ["--default=quux", "--get-regexp", "a.section"],
      ["--default=x", "--type=color", "a.b"],
      ["--default=~/x", "--type=path", "a.b"],
      ["--default=on", "--type=bool-or-int", "a.b"],
      ["--default=12k", "--type=int", "A.B"],
      ["--default=", "--type=bool", "a.b"],
      ["--default=quux", "core.foo", "^q"],
      { args: ["get", "--default=quux", "core.foo"], min: SUB },
      { args: ["get", "--default=yes", "--type=bool", "core.foo"], min: SUB },
      { args: ["get", "--default=quux", "--all", "core.foo"], min: SUB },
      { args: ["get", "--type=expiry-date", "--default=x", "not.a.section"], min: SUB },
    ],
  },
  {
    title:
      't1307-config-blob.sh: "list config blob contents", "fetch value from blob", "reading non-existing value from blob is an error", "reading from blob and file is an error", "reading from missing ref is an error", "reading from non-blob is an error", "setting a value in a blob is an error", "deleting a value in a blob is an error", "parse errors in blobs are properly attributed", "can parse blob ending with CR"',
    files: {
      config: "[some]\n\tvalue = 1\n",
      broken: '[some]\n\tvalue = "\n',
      cr: "[some]key = value\r",
    },
    setup: [
      ["add", "config", "broken", "cr"],
      ["commit", "-q", "-m", "foo"],
    ],
    steps: [
      ["--blob=HEAD:config", "--list"],
      ["--blob=HEAD:config", "--bool", "some.value"],
      ["--blob=HEAD:config", "non.existing"],
      ["--blob=HEAD:config", "--system", "--list"],
      ["--blob=HEAD:config", "--file=x", "some.value"],
      ["--blob=HEAD:doesnotexist", "--list"],
      ["--blob=HEAD:doesnotexist", "some.value"],
      ["--blob=HEAD", "--list"],
      ["--blob=HEAD", "some.value"],
      ["--blob=HEAD:config", "some.value", "foo"],
      ["--blob=HEAD:config", "--unset", "some.value"],
      ["--blob=HEAD:config", "--rename-section", "some", "other"],
      ["--blob=HEAD:broken", "some.value"],
      ["--blob=HEAD:broken", "--list"],
      ["--blob=HEAD:cr", "some.key"],
      ["--blob=HEAD:config", "--get-regexp", "some"],
      ["--blob=HEAD:config", "--int", "--get-urlmatch", "some", "https://x"],
      { args: ["get", "--blob=HEAD:config", "--type=bool", "some.value"], min: SUB },
      { args: ["list", "--blob=HEAD:config"], min: SUB },
      { args: ["set", "--blob=HEAD:config", "some.value", "2"], min: SUB },
    ],
  },
  {
    title: "--get-colorbool: color.ui, diff.color and the slot, with and without a terminal",
    files: {
      ".git/config":
        "[color]\n\tui = auto\n\tbranch = always\n\tstatus = false\n\tbad = maybe\n[diff]\n\tcolor = never\n",
    },
    env: { TERM: "xterm" },
    steps: [
      ["--get-colorbool", "color.branch"],
      ["--get-colorbool", "color.branch", "false"],
      ["--get-colorbool", "color.status", "true"],
      ["--get-colorbool", "color.diff", "true"],
      ["--get-colorbool", "color.other", "true"],
      ["--get-colorbool", "color.other", "false"],
      ["--get-colorbool", "color.other"],
      { args: ["--get-colorbool", "color.other", "true"], env: { TERM: "dumb" } },
      ["--get-colorbool", "color.bad", "true"],
      ["--get-colorbool", "color.other", "sometimes"],
      ["--get-colorbool", "--int", "color.other"],
    ],
  },
];

/** Our command for `git config <args>` (either syntax). */
function configure(
  git: Git,
  args: string[],
  compatibility: "2.43" | "2.56",
  env: Record<string, string>,
): ConfigCommand {
  const command = git.config().setCompatibility(compatibility);
  command.setDumbTerminal(!env.TERM || env.TERM === "dumb");
  const subcommands = ["get", "set", "unset", "rename-section", "remove-section", "list"];
  const sub = subcommands.includes(args[0] as string) ? args[0] : undefined;
  command.setLegacySyntax(sub === undefined);
  let action = sub;
  let regexp = false;
  let url: string | undefined;
  const pos: string[] = [];
  const rest = sub ? args.slice(1) : [...args];
  const types: Record<string, string> = {
    "--bool": "bool",
    "--int": "int",
    "--bool-or-int": "bool-or-int",
    "--bool-or-str": "bool-or-str",
    "--path": "path",
    "--expiry-date": "expiry-date",
  };
  while (rest.length > 0) {
    const a = rest.shift() as string;
    // both syntaxes stop at the first non-option (PARSE_OPT_STOP_AT_NON_OPTION)
    if (pos.length > 0 || !a.startsWith("-")) {
      pos.push(a);
    } else if (a === "-f") command.setFile(rest.shift());
    else if (a.startsWith("--file=")) command.setFile(a.slice(7));
    else if (a.startsWith("--blob=")) command.setBlob(a.slice(7));
    else if (["--local", "--worktree", "--global", "--system"].includes(a)) {
      command.setScope(a.slice(2) as "local");
    } else if (a in types) command.setType(types[a]);
    else if (a.startsWith("--type=")) command.setType(a.slice(7));
    else if (a === "--type") command.setType(rest.shift());
    else if (a === "--no-type") command.setType(undefined);
    else if (a.startsWith("--default=")) command.setDefault(a.slice(10));
    else if (a === "--default") command.setDefault(rest.shift());
    else if (a === "--show-origin") command.setShowOrigin(true);
    else if (a === "--show-scope") command.setShowScope(true);
    else if (a === "--name-only") command.setNameOnly(true);
    else if (a === "--show-names") command.setShowNames(true);
    else if (a === "--null" || a === "-z") command.setNullTerminated(true);
    else if (a === "--includes") command.setIncludes(true);
    else if (a === "--fixed-value") command.setFixedValue(true);
    else if (a.startsWith("--value=")) command.setValuePattern(a.slice(8));
    else if (a.startsWith("--url=")) url = a.slice(6);
    else if (a === "--regexp") regexp = true;
    else if (a === "--all") command.setAll(true);
    else if (a === "--append") action = "--add";
    else if (a === "--replace-all" || a === "--unset-all" || a === "--get-all") {
      command.setAll(true);
      action = a;
    } else action = a;
  }
  // the legacy syntax infers the action from the argument count
  if (action === undefined) action = pos.length === 1 ? "--get" : "set";
  const [first = "", second, third] = pos;
  const legacyPattern = (p: string | undefined) => {
    if (sub === undefined && p !== undefined) command.setValuePattern(p);
  };
  switch (action) {
    case "list":
    case "--list":
      return command.list();
    case "get":
      if (url !== undefined) return command.getUrlmatch(first, url);
      return regexp ? command.getRegexp(first) : command.get(first);
    case "--get":
    case "--get-all":
      legacyPattern(second);
      return command.get(first);
    case "--get-regexp":
      legacyPattern(second);
      return command.getRegexp(first);
    case "--get-urlmatch":
      return command.getUrlmatch(first, second ?? "");
    case "--get-color":
      return command.getColor(first, second);
    case "--get-colorbool":
      return command.getColorBool(first, second);
    case "set":
    case "--replace-all":
      legacyPattern(third);
      return command.set(first, second ?? "");
    case "--add":
      return command.add(first, second ?? "");
    case "unset":
    case "--unset":
    case "--unset-all":
      legacyPattern(second);
      return command.unset(first);
    case "--rename-section":
      return command.renameSection(first, second ?? "");
    default:
      return command.removeSection(first);
  }
}

/** One twin's environment: no command-line config, its own global file. */
function envOf(dir: string, extra: Record<string, string | undefined> = {}) {
  const e: Record<string, string> = {
    ...nativeGitEnv(join(dir, "home")),
    GIT_CONFIG_GLOBAL: join(dir, "global"),
  };
  for (const k of Object.keys(e))
    if (k.startsWith("GIT_CONFIG_KEY_") || k.startsWith("GIT_CONFIG_VALUE_")) delete e[k];
  delete e.GIT_CONFIG_COUNT;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete e[k];
    else e[k] = v.replaceAll("{dir}", dir);
  }
  return e;
}

async function openOurs(dir: string, env: Record<string, string>): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const environment = createNodeGitHostEnvironment({ env, ...(env.HOME ? {} : { home: "" }) });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** The twin's `.git/config`, as bytes in latin-1 (null when absent). */
function config(dir: string): string | null {
  try {
    return readFileSync(join(dir, ".git/config")).toString("latin1");
  } catch {
    return null;
  }
}

describeGit("git config queries against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "config-query-native-"));
    version = execFileSync("git", ["--version"], { encoding: "utf8" });
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  let n = 0;
  for (const scenario of scenarios) {
    it(scenario.title, async () => {
      const compatibility = gitAtLeast(version, 2, 45) ? "2.56" : "2.43";
      const base = join(root, `s${n++}`);
      const twins = { native: join(base, "native"), ours: join(base, "ours") };
      for (const dir of Object.values(twins)) {
        mkdirSync(join(dir, "home"), { recursive: true });
        const env = envOf(dir, scenario.env);
        execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir, env });
        for (const [path, content] of Object.entries(scenario.files ?? {})) {
          mkdirSync(join(dir, path, ".."), { recursive: true });
          writeFileSync(join(dir, path), Buffer.from(content.replaceAll("{dir}", dir), "utf8"));
        }
        for (const args of scenario.setup ?? []) execFileSync("git", args, { cwd: dir, env });
      }
      for (const raw of scenario.steps) {
        const step: Step = Array.isArray(raw) ? { args: raw } : raw;
        if (step.min && !gitAtLeast(version, ...step.min)) continue;
        const label = `git config ${JSON.stringify(step.args)}`;
        const outcome: Record<string, unknown> = {};
        for (const [name, dir] of Object.entries(twins)) {
          const env = envOf(dir, { ...scenario.env, ...step.env });
          const argv = step.args.map((a) => a.replaceAll("{dir}", dir));
          // git's option-parsing refusals (129) add its usage, which ours leaves to the caller
          const normalize = (text: string) =>
            text.replaceAll(dir, "<dir>").replace(/usage: git config[\s\S]*$/, "");
          if (name === "native") {
            const r = spawnSync("git", ["config", ...argv], { cwd: dir, env });
            outcome[name] = {
              exitCode: r.status,
              stdout: normalize(r.stdout.toString("latin1")),
              stderr: normalize(r.stderr.toString("latin1")),
              config: config(dir),
            };
          } else {
            const git = await openOurs(dir, env);
            const result = await configure(git, argv, compatibility, env).call();
            outcome[name] = {
              exitCode: result.exitCode,
              stdout: normalize(Buffer.from(result.stdout, "utf8").toString("latin1")),
              stderr: normalize(Buffer.from(result.stderr, "utf8").toString("latin1")),
              config: config(dir),
            };
          }
        }
        expect(outcome.ours, label).toEqual(outcome.native);
      }
    });
  }
});
