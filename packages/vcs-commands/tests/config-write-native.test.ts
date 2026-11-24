/**
 * `git config`'s write side (`ConfigCommand`) against native git: set, `--add`,
 * `--replace-all`, unset, `--unset-all` with value patterns and `--fixed-value`,
 * `--rename-section`, `--remove-section`, `--comment`, and get, on `.git/config`,
 * `config.worktree`, the global and system files and `--file`. Each step runs in native git
 * and in ours on twin repositories; their exit status, stdout, stderr and the bytes of every
 * config file must be equal after each step.
 *
 * Steps are written in git's legacy syntax and run again in 2.46's subcommands
 * (`toSubcommands`) where native git has them. Run with the system git (2.43) and with
 * 2.56.1 first on `PATH`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

/** One twin's environment: its own global and system files, never /dev/null. */
function envOf(dir: string, extra: Record<string, string | undefined> = {}) {
  const e: Record<string, string> = {
    ...nativeGitEnv(join(dir, "home")),
    GIT_CONFIG_GLOBAL: join(dir, "global"),
    GIT_CONFIG_SYSTEM: join(dir, "system"),
  };
  delete e.GIT_CONFIG_NOSYSTEM;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete e[k];
    else e[k] = v.replaceAll("{dir}", dir);
  }
  return e;
}

/** A step: git's legacy argv (after `config`), and when it runs. */
interface Step {
  args: string[];
  /** The oldest git that has the options (`--comment`: 2.45) */
  min?: [number, number];
  /** Not run again as subcommands */
  legacyOnly?: boolean;
  /** Done to both twins before the step */
  before?: (dir: string) => void;
}

interface Scenario {
  title: string;
  /** Files written into both twins before the first step (`.git/config` replaced) */
  files?: Record<string, string>;
  /** Native git run in both twins before the first step */
  setup?: string[][];
  /** Extra environment (`{dir}` is the twin's directory; undefined removes a variable) */
  env?: Record<string, string | undefined>;
  /** The files compared after each step, besides `.git/config`, global and system */
  watch?: string[];
  steps: (string[] | Step)[];
}

const COMMENTED = `[beta] ; silly comment # another comment
noIndent= sillyValue ; 'nother silly comment

# empty line
		; comment
		haha   ="beta" # last silly comment
haha = hello
	haha = bello
[nextSection] noNewline = ouch
`;

const BRANCHES = `# Hallo
	#Bello
[branch "eins"]
	x = 1
[branch.eins]
	y = 1
	[branch "1 234 blabl/a"]
weird
`;

const scenarios: Scenario[] = [
  {
    title: "t1300 initial .. append comments: new sections, mixed case, value patterns",
    watch: ["cfg"],
    steps: [
      ["--file=cfg", "section.penguin", "little blue"],
      ["--file=cfg", "Section.Movie", "BadPhysics"],
      ["--file=cfg", "Sections.WhatEver", "Second"],
      ["--file=cfg", "SECTION.UPPERCASE", "true"],
      ["--file=cfg", "section.penguin", "kingpin", "!blue"],
      ["--file=cfg", "section.penguin", "very blue", "!kingpin"],
      {
        args: [
          "--file=cfg",
          "--replace-all",
          "--comment=Pygoscelis papua",
          "section.penguin",
          "gentoo",
        ],
        min: [2, 45],
      },
      {
        args: ["--file=cfg", "--comment=find fish", "section.disposition", "peckish"],
        min: [2, 45],
      },
      { args: ["--file=cfg", "--comment=#abc", "section.foo", "bar"], min: [2, 45] },
      { args: ["--file=cfg", "--comment=and comment", "section.spsp", "value"], min: [2, 45] },
      { args: ["--file=cfg", "--comment=\t# and comment", "section.htsp", "value"], min: [2, 45] },
      { args: ["--file=cfg", "--comment=a\nb", "section.k", "v"], min: [2, 45] },
      ["--file=cfg", "--get", "sections.whatever"],
      ["--file=cfg", "--get", "SeCtIoNs.WhAtEvEr"],
      ["--file=cfg", "--get", "missingsection.missingkey"],
      ["--file=cfg", "--get", "section.MissingSubSection.key"],
    ],
  },
  {
    title: "t1300 unset with cont. lines",
    files: { cfg: "[alpha]\nbar = foo\n[beta]\nbaz = multiple \\\nlines\nfoo = bar\n" },
    watch: ["cfg"],
    steps: [["--file=cfg", "--unset", "beta.baz"]],
  },
  {
    title: "t1300 multiple unset: comments, a variable on a header line",
    files: { cfg: COMMENTED },
    watch: ["cfg"],
    steps: [["--file=cfg", "--unset-all", "beta.haha"]],
  },
  {
    title: "t1300 --replace-all, really mean test, multivar, ambiguous and invalid unset",
    files: { cfg: COMMENTED },
    watch: ["cfg"],
    steps: [
      ["--file=cfg", "--replace-all", "beta.haha", "gamma"],
      ["--file=cfg", "beta.haha", "alpha"],
      ["--file=cfg", "nextsection.nonewline", "wow"],
      ["--file=cfg", "--get", "beta.haha"],
      ["--file=cfg", "--unset", "beta.haha"],
      ["--file=cfg", "nextsection.NoNewLine", "wow2 for me", "for me$"],
      ["--file=cfg", "--get", "nextsection.nonewline", "!for"],
      ["--file=cfg", "--get", "nextsection.nonewline"],
      ["--file=cfg", "--get-all", "nextsection.nonewline"],
      ["--file=cfg", "nextsection.nonewline", "wow3", "wow$"],
      ["--file=cfg", "--unset", "nextsection.nonewline"],
      ["--file=cfg", "--unset", "somesection.nonewline"],
      ["--file=cfg", "--unset", "nextsection.nonewline", "wow3$"],
      ["--file=cfg", "inval.2key", "blabla"],
      ["--file=cfg", "123456.a123", "987"],
      ["--file=cfg", "Version.1.2.3eX.Alpha", "beta"],
      ["--file=cfg", "--add", "nextsection.nonewline", "wow4 for you"],
      ["--file=cfg", "--get-all", "nextsection.nonewline"],
      ["--file=cfg", "nextsection.nonewline", "x"],
      ["--file=cfg", "nokey", "x"],
      ["--file=cfg", "--unset", "nextsection."],
      ["--file=cfg", "nextsection.nonewline", "x", "["],
    ],
  },
  {
    title: "t1300 get variable with no value / empty value",
    files: { cfg: "[novalue]\n\tvariable\n[emptyvalue]\n\tvariable =\n" },
    watch: ["cfg"],
    steps: [
      ["--file=cfg", "--get", "novalue.variable", "^$"],
      ["--file=cfg", "--get", "emptyvalue.variable", "^$"],
      ["--file=cfg", "--get", "novalue.variable"],
    ],
  },
  {
    title: "t1300 new section is partial match of another; new variable into proper section",
    files: { cfg: "[a.b]\n\tc = d\n" },
    watch: ["cfg"],
    steps: [
      ["--file=cfg", "a.x", "y"],
      ["--file=cfg", "b.x", "y"],
      ["--file=cfg", "a.b", "c"],
    ],
  },
  {
    title: "t1300 rename section, rename non-existing, var on the header line, bogus names",
    files: { cfg: BRANCHES },
    watch: ["cfg"],
    steps: [
      ["--file=cfg", "--rename-section", "branch.eins", "branch.zwei"],
      ["--file=cfg", "--rename-section", 'branch."world domination"', "branch.drei"],
      ["--file=cfg", "--rename-section", "branch.1 234 blabl/a", "branch.drei"],
      {
        args: ["--file=cfg", "--rename-section", "branch.vier", "branch.zwei"],
        before: (dir) => writeFileSync(join(dir, "cfg"), '[branch "vier"] z = 1\n', { flag: "a" }),
      },
      ["--file=cfg", "--rename-section", "branch.zwei", ""],
      ["--file=cfg", "--rename-section", "branch.zwei", "bogus name"],
      {
        args: ["--file=cfg", "--remove-section", "branch.zwei"],
        before: (dir) =>
          writeFileSync(join(dir, "cfg"), '  [branch "zwei"] a = 1 [branch "vier"]\n', {
            flag: "a",
          }),
      },
      ["--file=cfg", "--remove-section", "branch.nothere"],
    ],
  },
  {
    title: "t1300 renaming a section with a long line, an overly-long line",
    files: {
      y: `[b]\n  c = d ${" ".repeat(1024)} [a] e = f\n[a] g = h\n`,
      z: `[b]\n  c = d ${" ".repeat(525000)} e[a] g = h\n`,
    },
    watch: ["y", "z"],
    steps: [
      ["--file=y", "--rename-section", "a", "xyz"],
      ["--file=y", "--get", "b.e"],
      ["--file=z", "--rename-section", "a", "xyz"],
    ],
  },
  {
    title: "t1300 section ending: subsections after the plain section",
    watch: ["cfg"],
    steps: [
      ["--file=cfg", "gitcvs.enabled", "true"],
      ["--file=cfg", "gitcvs.ext.dbname", "%Ggitcvs1.%a.%m.sqlite"],
      ["--file=cfg", "gitcvs.dbname", "%Ggitcvs2.%a.%m.sqlite"],
      ["--file=cfg", "bool.false2", ""],
      ["--file=cfg", "quote.lead", " x"],
      ["--file=cfg", "quote.trail", "x "],
      ["--file=cfg", "quote.hash", "a#b;c"],
      ["--file=cfg", "quote.esc", 'tab\there "q" back\\slash\nnl'],
      ["--file=cfg", "--get", "quote.esc"],
      ["--file=cfg", "core.foo", "bar\r"],
      ["--file=cfg", "--get", "core.foo"],
    ],
  },
  {
    title: "t1300 setting different case sensitive subsections",
    files: { cfg: '[V "A"]\nR = v1\n[K "E"]\nY = v1\n[a "b"]\nc = v1\n[d "e"]\nf = v1\n' },
    watch: ["cfg"],
    steps: [
      ["--file=cfg", "a.b.c", "v2"],
      ["--file=cfg", "K.E.y", "v2"],
      ["--file=cfg", "v.A.r", "v2"],
      ["--file=cfg", "d.E.f", "v2"],
    ],
  },
  {
    title: "t1300 subsections are not canonicalized; old-style headers",
    files: { cfg: '[section.SubSection]\nkey = one\n[section "SubSection"]\nkey = two\n' },
    watch: ["cfg"],
    steps: [
      ["--file=cfg", "--get", "section.subsection.key"],
      ["--file=cfg", "--get", "section.SubSection.key"],
      ["--file=cfg", "section.subsection.other", "x"],
      ["--file=cfg", "section.SUBSECTION.key", "y"],
      ["--file=cfg", "--unset", "section.subsection.key"],
    ],
  },
  {
    title: "t1300 --unset last key removes section (except if commented)",
    watch: ["cfg"],
    steps: [
      {
        args: ["--file=cfg", "--unset", "section.key"],
        before: (dir) =>
          writeFileSync(
            join(dir, "cfg"),
            '# some generic comment on the configuration file itself\n# a comment specific to this "section" section.\n[section]\n# some intervening lines\n# that should also be dropped\n\nkey = value\n# please be careful when you update the above variable\n',
          ),
      },
      {
        args: ["--file=cfg", "--unset", "section.key"],
        before: (dir) =>
          writeFileSync(join(dir, "cfg"), "[section]\nkey = value\n[next-section]\n"),
      },
      {
        args: ["--file=cfg", "--unset", "two.key"],
        before: (dir) =>
          writeFileSync(
            join(dir, "cfg"),
            '[one]\n\tkey = "multiline \\\n\t\t# with comment"\n[two]\nkey = true\n',
          ),
      },
      {
        args: ["--file=cfg", "--unset-all", "one.key"],
        before: (dir) =>
          writeFileSync(
            join(dir, "cfg"),
            '[one]\n\tkey = "multiline \\\n\t\t# with comment"\n[one]\nkey = true\n',
          ),
      },
      {
        args: ["--file=cfg", "--unset", "two.key"],
        before: (dir) =>
          writeFileSync(
            join(dir, "cfg"),
            "[one]\n\tkey = true\n\t# a comment not at the start\n[two]\n\tkey = true\n",
          ),
      },
      {
        args: ["--file=cfg", "--unset", "two.subsection.key"],
        before: (dir) =>
          writeFileSync(
            join(dir, "cfg"),
            '[one]\n\tkey = not [two "subsection"]\n[two "subsection"]\n[two "subsection"]\n\tkey = true\n[TWO "subsection"]\n[one]\n',
          ),
      },
      ["--file=cfg", "--get", "one.key"],
      {
        args: ["--file=cfg", "--unset-all", "section.key"],
        before: (dir) => writeFileSync(join(dir, "cfg"), "[section]\nkey = value1\nkey = value2\n"),
      },
      {
        args: ["--file=cfg", "section.key", "value"],
        before: (dir) => writeFileSync(join(dir, "cfg"), "[section]\n"),
      },
    ],
  },
  {
    title: "t1300 set all config with value-pattern, --replace-all and value-pattern",
    watch: ["cfg", "config"],
    steps: [
      ["--file=cfg", "abc.key", "one"],
      ["--file=cfg", "abc.key", "two", "a+"],
      ["--file=cfg", "abc.key", "three", "o+"],
      ["--file=cfg", "abc.key", "three", "a+"],
      ["--file=cfg", "abc.key", "four", "h+"],
      ["--file=config", "--add", "abc.key", "one"],
      ["--file=config", "--add", "abc.key", "two"],
      ["--file=config", "--add", "abc.key", "three"],
      ["--file=config", "--replace-all", "abc.key", "four", "o+"],
      ["--file=config", "--unset-all", "abc.key", "!^four$"],
    ],
  },
  {
    title: "t1300 --fixed-value uses exact string matching; refuse it for incompatible actions",
    files: { cfg: "[fixed]\n\ttest = a+b*c?d[e]f.g\n" },
    watch: ["cfg"],
    steps: [
      ["--file=cfg", "fixed.test", "bogus", "a+b*c?d[e]f.g"],
      ["--file=cfg", "--fixed-value", "fixed.test", "bogus2", "a+b*c?d[e]f.g"],
      ["--file=cfg", "--get", "--fixed-value", "fixed.test", "a+b*c?d[e]f.g"],
      ["--file=cfg", "--get-all", "--fixed-value", "fixed.test", "bogus"],
      ["--file=cfg", "--unset", "fixed.test", "a+b*c?d[e]f.g"],
      ["--file=cfg", "--fixed-value", "--unset", "fixed.test", "bogus"],
      ["--file=cfg", "--fixed-value", "--replace-all", "fixed.test", "new", "bogus2"],
      { args: ["--file=cfg", "--fixed-value", "--add", "fixed.test", "bogus"], legacyOnly: true },
      ["--file=cfg", "--fixed-value", "fixed.test", "bogus"],
      ["--file=cfg", "--fixed-value", "--unset", "fixed.test"],
      ["--file=cfg", "--fixed-value", "--get", "fixed.test"],
      {
        args: ["--file=cfg", "--fixed-value", "--rename-section", "dev", "null"],
        legacyOnly: true,
      },
    ],
  },
  {
    title: "t1300 --fixed-value with value-less configuration",
    files: { cfg: "[section]\n\tkey\n" },
    watch: ["cfg"],
    // git 2.43 crashes on it (a NULL value compared with strcmp)
    steps: [
      { args: ["--file=cfg", "--fixed-value", "section.key", "value", "pattern"], min: [2, 46] },
    ],
  },
  {
    title:
      "t1300-config parser cases (CRLF, BOM, a variable on a header line, [b][c] on one line; webrun-vcs#266)",
    files: {
      cfg: "﻿[a] x = 1\r\n[b][c]\r\ny = 2\r\n\t[d]  z = 3 ; trailing\r\n",
    },
    watch: ["cfg"],
    steps: [
      ["--file=cfg", "a.x", "10"],
      ["--file=cfg", "c.y", "20"],
      ["--file=cfg", "d.new", "4"],
      ["--file=cfg", "--unset", "d.z"],
      ["--file=cfg", "--unset", "c.y"],
      ["--file=cfg", "--rename-section", "a", "e"],
      ["--file=cfg", "--unset", "e.x"],
      ["--file=cfg", "--add", "c.y", "21"],
    ],
  },
  {
    title: "t1300 bad config files: invalid section name (3), bad config line (128)",
    files: { f2: "[abc\n", f3: "[a]\nx=1\n!\n", f4: '[ab "x\n', f5: "[]\n" },
    watch: ["f2", "f3", "f4", "f5"],
    steps: [
      ["--file=f2", "a.b", "c"],
      ["--file=f3", "a.b", "c"],
      ["--file=f4", "a.b", "c"],
      ["--file=f5", "a.b", "c"],
      ["--file=f3", "--get", "a.x"],
      ["--file=f3", "--rename-section", "a", "b"],
    ],
  },
  {
    title:
      "t1300 writing config retries until lock is released (no timeout here): a held lock is 255, the file left alone; missing files",
    files: { cfg: "[a]\n\tx = 1\n" },
    watch: ["cfg", "cfg.lock", "none"],
    steps: [
      {
        args: ["--file=cfg", "a.y", "2"],
        before: (dir) => writeFileSync(join(dir, "cfg.lock"), ""),
      },
      ["--file=cfg", "--unset", "a.x"],
      ["--file=cfg", "--rename-section", "a", "b"],
      {
        args: ["--file=cfg", "--remove-section", "a"],
        before: (dir) => rmSync(join(dir, "cfg.lock")),
      },
      ["--file=none", "--unset", "a.x"],
      ["--file=none", "--rename-section", "a", "b"],
      ["--file=nodir/cfg", "a.b", "c"],
      ["--file=none", "--get", "a.b"],
    ],
  },
  {
    title: "t1300 symlinked configuration: the link is written through, not replaced",
    files: { real: "[a]\n\tx = 1\n" },
    watch: ["real", "notyet"],
    steps: [
      {
        args: ["--file=cfg", "a.y", "2"],
        before: (dir) => symlinkSync("real", join(dir, "cfg")),
      },
      ["--file=cfg", "--rename-section", "a", "b"],
      ["--file=cfg", "--get", "b.y"],
      {
        args: ["--file=myconfig", "test.frotz", "nitfol"],
        before: (dir) => symlinkSync("notyet", join(dir, "myconfig")),
      },
      ["--file=myconfig", "test.xyzzy", "rezrov"],
      ["--file=notyet", "--get", "test.xyzzy"],
      {
        args: ["--file=linktolinktonada", "--get", "a.b"],
        before: (dir) => {
          symlinkSync("doesnotexist", join(dir, "linktonada"));
          symlinkSync("linktonada", join(dir, "linktolinktonada"));
        },
      },
    ],
  },
  {
    title:
      "t1300 --local and the default file (JGit pgm ConfigTest): .git/config edited in place, get through the chain",
    steps: [
      ["core.editor", "vim"],
      ["--local", "remote.origin.url", "https://example.com/x.git"],
      ["--add", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      ["--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"],
      ["--get-all", "remote.origin.fetch"],
      ["--unset", "remote.origin.fetch", "tags"],
      ["--rename-section", "remote.origin", "remote.upstream"],
      ["--get", "gc.auto"],
      ["--local", "--get", "gc.auto"],
      ["--get", "remote.upstream.url"],
      ["--remove-section", "remote.upstream"],
      ["--unset", "core.editor"],
    ],
  },
  {
    title:
      "t1300 write to overridden global and system config (GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM)",
    files: { global: "# mine\n[user]\n\tname = A\n" },
    steps: [
      ["--global", "user.email", "a@example.com"],
      ["--global", "--unset", "user.name"],
      ["--system", "core.pager", "less"],
      ["--system", "--get", "core.pager"],
      ["--get", "core.pager"],
      ["--global", "--rename-section", "user", "person"],
      {
        args: ["--global", "x.y", "z"],
        before: (dir) => writeFileSync(join(dir, "global.lock"), ""),
      },
    ],
  },
  {
    title: "t1300 xdg config: --global writes $XDG_CONFIG_HOME/git/config when only it exists",
    env: { GIT_CONFIG_GLOBAL: undefined, HOME: "{dir}/home", XDG_CONFIG_HOME: "{dir}/xdg" },
    files: { "xdg/git/config": "[x]\n\ta = 1\n" },
    watch: ["xdg/git/config", "home/.gitconfig"],
    steps: [
      ["--global", "x.b", "2"],
      {
        args: ["--global", "y.c", "3"],
        before: (dir) => writeFileSync(join(dir, "home/.gitconfig"), ""),
      },
      ["--global", "--get", "x.b"],
    ],
  },
  {
    title: "t1300 alternative --file, an absolute path written through the host",
    watch: ["abs"],
    steps: [
      ["--file={dir}/abs", "a.b", "c"],
      ["--file={dir}/abs", "--unset", "a.b"],
    ],
  },
  {
    title:
      "t1300 --worktree scope: config.worktree under extensions.worktreeConfig, else .git/config",
    watch: [".git/config.worktree"],
    steps: [
      ["--worktree", "a.b", "c"],
      ["extensions.worktreeConfig", "true"],
      ["--worktree", "core.sparseCheckout", "true"],
      ["--worktree", "--get", "core.sparseCheckout"],
      ["--get", "core.sparseCheckout"],
      ["--worktree", "--unset", "core.sparseCheckout"],
    ],
  },
  {
    title: "t1300 --worktree with a linked worktree: refused unless extensions.worktreeConfig",
    watch: [".git/config.worktree"],
    setup: [
      ["commit", "-q", "--allow-empty", "-m", "x"],
      ["worktree", "add", "-q", "../{name}-wt"],
    ],
    steps: [
      ["--worktree", "a.b", "c"],
      ["extensions.worktreeConfig", "true"],
      ["--worktree", "a.b", "c"],
    ],
  },
];

/** git's legacy argv as git 2.46's subcommands write it. */
function toSubcommands(args: string[]): string[] {
  const opts: string[] = [];
  const pos: string[] = [];
  let action: string | undefined;
  for (const a of args) {
    if (
      [
        "--add",
        "--replace-all",
        "--unset",
        "--unset-all",
        "--rename-section",
        "--remove-section",
        "--get",
        "--get-all",
      ].includes(a)
    ) {
      action = a;
    } else if (a.startsWith("--") && pos.length === 0) opts.push(a);
    else pos.push(a);
  }
  if (action === undefined) action = pos.length === 1 ? "--get" : "--set";
  const [key, second, third] = pos;
  switch (action) {
    case "--get":
    case "--get-all":
      return [
        "get",
        ...(action === "--get-all" ? ["--all"] : []),
        ...opts,
        ...(second !== undefined ? [`--value=${second}`] : []),
        key,
      ];
    case "--set":
    case "--replace-all":
      return [
        "set",
        ...(action === "--replace-all" ? ["--all"] : []),
        ...opts,
        ...(third !== undefined ? [`--value=${third}`] : []),
        key,
        second,
      ];
    case "--add":
      return ["set", "--append", ...opts, key, second];
    case "--unset":
    case "--unset-all":
      return [
        "unset",
        ...(action === "--unset-all" ? ["--all"] : []),
        ...opts,
        ...(second !== undefined ? [`--value=${second}`] : []),
        key,
      ];
    case "--rename-section":
      return ["rename-section", ...opts, key, second];
    default:
      return ["remove-section", ...opts, key];
  }
}

/** Our command for `git config <args>` (either syntax). */
function configure(git: Git, args: string[]): ConfigCommand {
  const command = git.config();
  const subcommands = ["get", "set", "unset", "rename-section", "remove-section"];
  const sub = subcommands.includes(args[0]) ? args[0] : undefined;
  command.setLegacySyntax(sub === undefined);
  let action = sub;
  let scopes = 0;
  const pos: string[] = [];
  for (const a of sub ? args.slice(1) : args) {
    if (pos.length > 0 || !a.startsWith("--")) pos.push(a);
    else if (a.startsWith("--file=")) command.setFile(a.slice(7));
    else if (["--local", "--worktree", "--global", "--system"].includes(a)) {
      // a second scope: git's "only one config file at a time"
      if (scopes++ > 0) command.setFile("/both");
      command.setScope(a.slice(2) as "local");
    } else if (a.startsWith("--comment=")) command.setComment(a.slice(10));
    else if (a === "--fixed-value") command.setFixedValue(true);
    else if (a.startsWith("--value=")) command.setValuePattern(a.slice(8));
    else if (a === "--all") command.setAll(true);
    else if (a === "--append") action = "--add";
    else if (a === "--replace-all" || a === "--unset-all" || a === "--get-all") {
      command.setAll(true);
      action = a;
    } else action = a;
  }
  if (action === undefined) action = pos.length === 1 ? "get" : "set";
  const [key, second, third] = pos;
  switch (action) {
    case "get":
    case "--get":
    case "--get-all":
      if (sub === undefined && second !== undefined) command.setValuePattern(second);
      return command.get(key);
    case "set":
    case "--replace-all":
      if (sub === undefined && third !== undefined) command.setValuePattern(third);
      return command.set(key, second);
    case "--add":
      if (third !== undefined) command.setValuePattern(third);
      return command.add(key, second);
    case "unset":
    case "--unset":
    case "--unset-all":
      if (sub === undefined && second !== undefined) command.setValuePattern(second);
      return command.unset(key);
    case "rename-section":
    case "--rename-section":
      return command.renameSection(key, second);
    default:
      return command.removeSection(key);
  }
}

async function openOurs(dir: string, env: Record<string, string>): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const environment = createNodeGitHostEnvironment({ env });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** The bytes of the config files of a twin (absent as null). */
function snapshot(dir: string, watch: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of [".git/config", "global", "system", ...watch]) {
    const path = join(dir, name);
    out[name] = existsSync(path) ? readFileSync(path).toString("latin1") : null;
  }
  // no lock left behind but the ones a step made
  out.locks = readdirSync(dir)
    .concat(readdirSync(join(dir, ".git")).map((n) => `.git/${n}`))
    .filter((n) => n.endsWith(".lock"))
    .sort()
    .join(",");
  return out;
}

describeGit("git config writes against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "config-write-native-"));
    version = execFileSync("git", ["--version"], { encoding: "utf8" });
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  let n = 0;
  for (const scenario of scenarios) {
    for (const mode of ["legacy", "subcommands"] as const) {
      it(`${scenario.title} (${mode})`, async () => {
        if (mode === "subcommands" && !gitAtLeast(version, 2, 46)) return;
        const base = join(root, `s${n++}`);
        const twins = { native: join(base, "native"), ours: join(base, "ours") };
        for (const [name, dir] of Object.entries(twins)) {
          mkdirSync(join(dir, "home"), { recursive: true });
          const env = envOf(dir, scenario.env);
          execFileSync("git", ["init", "-q", "."], { cwd: dir, env });
          for (const args of scenario.setup ?? []) {
            execFileSync(
              "git",
              args.map((a) => a.replaceAll("{name}", name)),
              { cwd: dir, env },
            );
          }
          for (const [path, content] of Object.entries(scenario.files ?? {})) {
            mkdirSync(join(dir, path, ".."), { recursive: true });
            writeFileSync(join(dir, path), Buffer.from(content, "utf8"));
          }
        }
        const watch = scenario.watch ?? [];
        for (const raw of scenario.steps) {
          const step: Step = Array.isArray(raw) ? { args: raw } : raw;
          if (step.min && !gitAtLeast(version, ...step.min)) continue;
          if (mode === "subcommands" && step.legacyOnly) continue;
          const args = mode === "subcommands" ? toSubcommands(step.args) : step.args;
          const label = `git config ${JSON.stringify(args)}`;
          const outcome: Record<string, unknown> = {};
          for (const [name, dir] of Object.entries(twins)) {
            step.before?.(dir);
            const env = envOf(dir, scenario.env);
            const argv = args.map((a) => a.replaceAll("{dir}", dir));
            // git's option-parsing refusals (129) add its usage, which ours leaves to the caller
            const normalize = (text: string) =>
              text.replaceAll(dir, "<dir>").replace(/usage: git config[\s\S]*$/, "");
            if (name === "native") {
              const r = spawnSync("git", ["config", ...argv], { cwd: dir, env });
              outcome[name] = {
                exitCode: r.status,
                stdout: normalize(r.stdout.toString()),
                stderr: normalize(r.stderr.toString()),
                files: snapshot(dir, watch),
              };
            } else {
              const git = await openOurs(dir, env);
              const result = await configure(git, argv).call();
              outcome[name] = {
                exitCode: result.exitCode,
                stdout: normalize(result.stdout),
                stderr: normalize(result.stderr),
                files: snapshot(dir, watch),
              };
            }
          }
          expect(outcome.ours, label).toEqual(outcome.native);
        }
      });
    }
  }
});
