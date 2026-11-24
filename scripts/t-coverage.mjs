#!/usr/bin/env node
// How much of git's own test suite (t/) webrun-vcs has ported, per script and per family.
//
// git's t/ scripts are a source of scenarios, ported by hand as native twins (statewalker/webrun-vcs#218):
// no t/ script runs here. A ported case names its source in the test file, as the script and the
// test's title:
//
//   it('t0008-ignores.sh: "local ignore inside a sub-directory"', ...)
//   // t7700-repack 'objects in packs marked .keep are not in new packs'
//   /** t7509 "--author", "--date" and t7501 "commit --date" */
//
// This script reads every `test_expect_success`/`test_expect_failure` title of git's t/ at a pinned
// version, reads those citations from the test files under packages/ and apps/, and reports how
// many upstream tests each script has ported. A citation names one test when its text is the
// title, or a part only that title holds (case and spacing aside, a trailing "..." dropped); a
// script named without a title counts the script as cited but ports no test. Citations that name
// no test, several, or an unknown script are listed so they can be fixed.
//
// Counts are of test blocks in the source: a test inside a loop or a helper function counts once,
// and tests declared through wrappers (test_expect_success_multi) are not counted.
// scripts/t-coverage-scope.json lists the scripts outside the scope of a library; they are
// reported apart and left out of the shares.
//
//   node scripts/t-coverage.mjs                    Markdown report on stdout
//        [--git-src <dir>]                         a git checkout holding t/ (default: a sparse
//                                                  clone of --git-version, cached under
//                                                  node_modules/.cache/t-coverage)
//        [--git-version <tag>]                     default below (CI's git)
//        [--format md|json] [--all] [--out <file>] --all lists every in-scope script

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_GIT_VERSION = "v2.56.1";

const EXPECT = /^\s*test_expect_(success|failure)(?=[\s\\])/;

/** Titles of the tests a t/ script declares, in order. */
export function parseTitles(source) {
  const lines = source.split("\n");
  const titles = [];
  for (let i = 0; i < lines.length; i++) {
    const m = EXPECT.exec(lines[i]);
    if (!m) continue;
    let text = lines[i].slice(m[0].length);
    let j = i;
    while (/\\\s*$/.test(text) && j + 1 < lines.length) {
      text = `${text.replace(/\\\s*$/, " ")}${lines[++j]}`;
    }
    const all = shellWords(text);
    const heredoc = all.findIndex((w) => !w.single && w.text.startsWith("<<"));
    const words = heredoc < 0 ? all : all.slice(0, heredoc);
    // The body is the last word: a quoted one left open on the line, `-` (a here-document), or the
    // last complete word. The title is the word before it, a prerequisite the one before that.
    const body = words.length - 1;
    const title = words[body - 1] ?? words[body];
    if (title === undefined) continue;
    titles.push({
      title: title.text,
      line: i + 1,
      dynamic: !title.single && /\$/.test(title.text),
      expectFailure: m[1] === "failure",
    });
  }
  return titles;
}

/** Shell words of one line: quoted parts joined, an unterminated quote ending the list. */
function shellWords(text) {
  const words = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length || text[i] === "#") break;
    let word = "";
    let single = false;
    let open = false;
    while (i < text.length && !/\s/.test(text[i])) {
      const c = text[i];
      if (c === "'" || c === '"') {
        const end = findClose(text, i + 1, c);
        if (end < 0) {
          word += text.slice(i + 1);
          open = true;
          i = text.length;
          break;
        }
        const part = text.slice(i + 1, end);
        word += c === '"' ? part.replace(/\\(["\\$`])/g, "$1") : part;
        single ||= c === "'";
        i = end + 1;
      } else if (c === "\\" && i + 1 < text.length) {
        word += text[i + 1];
        i += 2;
      } else {
        word += c;
        i++;
      }
    }
    words.push({ text: word, single, open });
    if (open) break;
  }
  return words;
}

function findClose(text, from, quote) {
  for (let i = from; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") i++;
    else if (text[i] === quote) return i;
  }
  return -1;
}

// A script reference: t<4 digits>, its name and `.sh` optional, not inside a longer word or number.
const SCRIPT_REF = /(?<![\w$-])t(\d{4})(?:-[A-Za-z0-9_.+-]*[A-Za-z0-9_+])?(?![\w])/g;
// A quoted title right after it (`:` or spaces between, so `t4202's` is no title), maybe
// JavaScript-escaped: \" or \'.
const QUOTED = /^[\s:]+(\\?)(["'“`])/;
// Between two titles of one script: `,`, `/`, `;`, `and`, `or`.
const CHAIN = /^\s*(?:[,/;]|\band\b|\bor\b)\s*(?:\band\b\s*)?/;

/** Citations of t/ scripts and their test titles in a test file. */
export function extractCitations(source, file) {
  const citations = [];
  source.split("\n").forEach((text, index) => {
    for (const m of text.matchAll(SCRIPT_REF)) {
      const script = `t${m[1]}`;
      let rest = text.slice(m.index + m[0].length);
      const titles = [];
      for (;;) {
        const q = QUOTED.exec(rest);
        if (!q) break;
        const close = q[2] === "“" ? "”" : q[2];
        const start = q[0].length;
        const end = rest.indexOf(q[1] + close, start);
        if (end < 0) break;
        const title = rest.slice(start, end);
        if (title.trim().length < 2) break;
        titles.push(title.replace(/\\(["'`\\])/g, "$1"));
        rest = rest.slice(end + q[1].length + close.length);
        const chain = CHAIN.exec(rest);
        if (!chain) break;
        rest = ` ${rest.slice(chain[0].length)}`;
      }
      if (titles.length === 0) citations.push({ script, title: null, file, line: index + 1 });
      for (const title of titles) citations.push({ script, title, file, line: index + 1 });
    }
  });
  return citations;
}

const normalize = (s) =>
  s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*(?:\.\.\.|…)$/, "");

/** Which of a script's tests a cited title names. */
export function matchCitation(titles, citation) {
  const want = normalize(citation);
  const exact = indexesWhere(titles, (t) => normalize(t.title) === want);
  if (exact.length > 0) return { status: "matched", indexes: exact };
  if (want.length === 0) return { status: "unresolved", indexes: [] };
  const holding = indexesWhere(titles, (t) => normalize(t.title).includes(want));
  if (holding.length === 1) return { status: "matched", indexes: holding };
  if (holding.length > 1) return { status: "ambiguous", indexes: holding };
  const instances = indexesWhere(titles, (t) => t.dynamic && dynamicPattern(t.title).test(want));
  if (instances.length === 1) return { status: "matched", indexes: instances };
  if (instances.length > 1) return { status: "ambiguous", indexes: instances };
  return { status: "unresolved", indexes: [] };
}

function indexesWhere(list, predicate) {
  const out = [];
  list.forEach((item, i) => {
    if (predicate(item)) out.push(i);
  });
  return out;
}

/** A title holding shell variables, as a pattern its instances match. */
function dynamicPattern(title) {
  const parts = normalize(title).split(
    /\$(?:\{[^}]*\}|\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*|\d|[@*#?])/,
  );
  return new RegExp(`^${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*?")}$`);
}

/**
 * The report: per script, per family, totals, and the citations to fix.
 * `upstream` maps a script number (`t0008`) to its name and titles.
 */
export function buildReport({ upstream, citations, scope, gitVersion, testFiles }) {
  const outOfScope = (name) =>
    scope.outOfScope.find((entry) => name.startsWith(entry.prefix))?.reason ?? null;
  const rows = new Map();
  for (const [script, { name, titles }] of [...upstream].sort(([a], [b]) => a.localeCompare(b))) {
    rows.set(script, {
      script,
      name,
      family: script.slice(0, 2),
      tests: titles.length,
      titles,
      ported: 0,
      portedTitles: [],
      portedIndexes: new Set(),
      files: new Set(),
      outOfScope: outOfScope(name),
    });
  }
  const problems = [];
  for (const citation of citations) {
    const row = rows.get(citation.script);
    if (!row) {
      problems.push({ kind: "unknown-script", ...citation });
      continue;
    }
    row.files.add(citation.file);
    if (citation.title === null) continue;
    const match = matchCitation(row.titles, citation.title);
    if (match.status === "matched") {
      for (const i of match.indexes) row.portedIndexes.add(i);
    } else {
      problems.push({
        kind: match.status,
        ...citation,
        candidates: match.indexes.map((i) => row.titles[i].title),
      });
    }
  }
  const scripts = [...rows.values()].map(({ titles, portedIndexes, files, ...row }) => ({
    ...row,
    ported: portedIndexes.size,
    portedTitles: [...portedIndexes].sort((a, b) => a - b).map((i) => titles[i].title),
    files: [...files].sort(),
  }));

  const inScope = scripts.filter((s) => !s.outOfScope);
  const sum = (list, key) => list.reduce((n, s) => n + s[key], 0);
  const totals = {
    scripts: scripts.length,
    tests: sum(scripts, "tests"),
    inScopeScripts: inScope.length,
    inScopeTests: sum(inScope, "tests"),
    citedScripts: inScope.filter((s) => s.files.length > 0).length,
    citedScriptTests: sum(
      inScope.filter((s) => s.files.length > 0),
      "tests",
    ),
    portedTests: sum(inScope, "ported"),
    outOfScopeScripts: scripts.length - inScope.length,
    outOfScopeTests: sum(scripts, "tests") - sum(inScope, "tests"),
  };
  const families = [...new Set(scripts.map((s) => s.family))].map((family) => {
    const own = inScope.filter((s) => s.family === family);
    return {
      family,
      scripts: scripts.filter((s) => s.family === family).length,
      inScopeScripts: own.length,
      inScopeTests: sum(own, "tests"),
      citedScripts: own.filter((s) => s.files.length > 0).length,
      portedTests: sum(own, "ported"),
    };
  });
  problems.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { gitVersion, testFiles, totals, families, scripts, problems };
}

const pct = (part, whole) => (whole === 0 ? "-" : `${((100 * part) / whole).toFixed(1)}%`);

const FAMILY_NAMES = {
  t0: "basic, setup, config, refs backends",
  t1: "plumbing: objects, refs, index, config, rev-parse",
  t2: "checkout, worktree, index update",
  t3: "ls-files, branch, rebase, cherry-pick, add, rm, mv, stash",
  t4: "diff, apply, am, format-patch",
  t5: "packs, fetch, push, clone, protocols",
  t6: "rev-list, merge, bisect, for-each-ref, gc",
  t7: "porcelain: status, commit, reset, tag, submodule, grep, repack",
  t8: "blame",
  t9: "foreign SCM, tools, contrib",
};

/** The report as Markdown. `all` lists every in-scope script, not only the cited ones. */
export function formatMarkdown(report, { all = false, largest = 25 } = {}) {
  const { totals } = report;
  const out = [];
  out.push(`# git t/ coverage of webrun-vcs (git ${report.gitVersion})`, "");
  out.push(
    `**Ported:** ${totals.portedTests} of ${totals.inScopeTests} in-scope upstream tests (${pct(totals.portedTests, totals.inScopeTests)}), from ${totals.citedScripts} of ${totals.inScopeScripts} in-scope scripts cited in ${report.testFiles} test files.`,
    "",
    `**Cited scripts hold** ${totals.citedScriptTests} in-scope tests (${pct(totals.citedScriptTests, totals.inScopeTests)}): the most the cited scripts could port. A citation that names no title of the pinned version (below) ports nothing until it is fixed.`,
    "",
    `Out of scope (scripts/t-coverage-scope.json): ${totals.outOfScopeScripts} scripts, ${totals.outOfScopeTests} tests. Counts are test blocks in the scripts' source; a test is ported when a test file cites its title (scripts/t-coverage.mjs).`,
    "",
    "## By family",
    "",
    "| Family | Area | In-scope scripts | Cited | Tests | Ported | Share |",
    "|---|---|---:|---:|---:|---:|---:|",
  );
  for (const f of report.families) {
    out.push(
      `| ${f.family} | ${FAMILY_NAMES[f.family] ?? ""} | ${f.inScopeScripts} | ${f.citedScripts} | ${f.inScopeTests} | ${f.portedTests} | ${pct(f.portedTests, f.inScopeTests)} |`,
    );
  }
  out.push(
    `| **all** | | ${totals.inScopeScripts} | ${totals.citedScripts} | ${totals.inScopeTests} | ${totals.portedTests} | ${pct(totals.portedTests, totals.inScopeTests)} |`,
  );

  const listed = report.scripts.filter((s) => !s.outOfScope && (all || s.files.length > 0));
  out.push(
    "",
    all ? "## Every in-scope script" : "## Cited scripts",
    "",
    "A script cited without titles ported scenarios from it that no title names: its share is 0.",
    "",
    "| Script | Tests | Ported | Share | Citing files |",
    "|---|---:|---:|---:|---:|",
  );
  for (const s of listed) {
    out.push(
      `| ${s.name} | ${s.tests} | ${s.ported} | ${pct(s.ported, s.tests)} | ${s.files.length} |`,
    );
  }

  const uncited = report.scripts
    .filter((s) => !s.outOfScope && s.files.length === 0)
    .sort((a, b) => b.tests - a.tests || a.script.localeCompare(b.script))
    .slice(0, largest);
  out.push(
    "",
    `## The ${uncited.length} largest scripts no test cites`,
    "",
    "| Script | Tests |",
    "|---|---:|",
  );
  for (const s of uncited) out.push(`| ${s.name} | ${s.tests} |`);

  out.push("", `## Citations to fix (${report.problems.length})`, "");
  if (report.problems.length === 0) out.push("None.");
  for (const p of report.problems) {
    const what =
      p.kind === "unknown-script"
        ? `no such script in git ${report.gitVersion}`
        : p.kind === "ambiguous"
          ? `ambiguous, ${p.candidates.length} titles hold it`
          : "unresolved";
    out.push(`- \`${p.file}:${p.line}\` ${p.script} "${p.title ?? ""}": ${what}`);
  }
  return `${out.join("\n")}\n`;
}

/** git's t/ scripts: number → name and titles. */
export function readUpstream(gitSrc) {
  const dir = join(gitSrc, "t");
  const upstream = new Map();
  for (const file of readdirSync(dir).sort()) {
    const m = /^(t\d{4})-.*\.sh$/.exec(file);
    if (!m) continue;
    upstream.set(m[1], {
      name: file.slice(0, -3),
      titles: parseTitles(readFileSync(join(dir, file), "utf8")),
    });
  }
  return upstream;
}

/** Test sources under packages/ and apps/: files under a `tests` directory. */
export function listTestFiles(root) {
  const files = [];
  const walk = (dir, inTests) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, inTests || entry.name === "tests");
      else if (inTests && /\.(?:[cm]?[jt]s)$/.test(entry.name)) files.push(path);
    }
  };
  for (const top of ["packages", "apps"]) {
    if (existsSync(join(root, top))) walk(join(root, top), false);
  }
  return files.sort();
}

/** A sparse, blobless clone of git's t/ scripts at `version`, made once per version. */
function cachedGitSource(root, version) {
  const dir = join(root, "node_modules", ".cache", "t-coverage", version);
  if (existsSync(join(dir, "t"))) return dir;
  const git = (...args) => execFileSync("git", args, { stdio: ["ignore", "ignore", "inherit"] });
  git(
    "clone",
    "--quiet",
    "--depth=1",
    "--filter=blob:none",
    "--no-checkout",
    `--branch=${version}`,
    "https://github.com/git/git",
    dir,
  );
  git("-C", dir, "sparse-checkout", "set", "--no-cone", "/t/t[0-9]*.sh");
  git("-C", dir, "checkout", "--quiet");
  return dir;
}

function parseArgs(argv) {
  const options = { gitVersion: DEFAULT_GIT_VERSION, format: "md", all: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === "--git-src") options.gitSrc = value();
    else if (arg === "--git-version") options.gitVersion = value();
    else if (arg === "--format") options.format = value();
    else if (arg === "--out") options.out = value();
    else if (arg === "--all") options.all = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!["md", "json"].includes(options.format)) throw new Error("--format is md or json");
  return options;
}

function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const options = parseArgs(argv);
  const gitSrc = options.gitSrc ?? cachedGitSource(root, options.gitVersion);
  const testFiles = listTestFiles(root);
  const citations = testFiles.flatMap((file) =>
    extractCitations(readFileSync(file, "utf8"), relative(root, file)),
  );
  const report = buildReport({
    upstream: readUpstream(gitSrc),
    citations,
    scope: JSON.parse(readFileSync(join(root, "scripts", "t-coverage-scope.json"), "utf8")),
    gitVersion: options.gitSrc ? `at ${options.gitSrc}` : options.gitVersion,
    testFiles: new Set(citations.map((c) => c.file)).size,
  });
  const text =
    options.format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatMarkdown(report, { all: options.all });
  if (options.out) writeFileSync(options.out, text);
  else {
    // `| head` closes the pipe early: that is no failure.
    process.stdout.on("error", (error) => {
      if (error.code !== "EPIPE") throw error;
    });
    process.stdout.write(text);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
