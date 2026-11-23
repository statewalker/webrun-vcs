/**
 * `git.forEachRef()` against native `git for-each-ref`, byte for byte: every atom of
 * t6300-for-each-ref.sh (for-each-ref-tests.sh) over the refs its setup makes, its sorting,
 * quoting, patterns, dates, trailers, describe and error cases; the filters of
 * t6302-for-each-ref-filter.sh (`--points-at`, `--merged`, `--contains`, alignment,
 * `%(if)`, version sort, `--start-after`, `%(worktreepath)`); the error messages of
 * t6301-for-each-ref-errors.sh; and the reachability filters over t6600-test-reach.sh's
 * grid, with and without a commit-graph. Each case runs the same arguments through native
 * git and through ours and compares stdout (or the exit status and stderr of a refusal).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type ForEachRefCommand, Git, GitApiError, type RefQuoteStyle } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

/** GIT_TEST_DATE_NOW of both: relative dates are compared too. */
const NOW = 1700000000;
let root: string;
let version = "";

const env = (): Record<string, string> => ({
  ...nativeGitEnv(root),
  GIT_TEST_DATE_NOW: String(NOW),
  TZ: "UTC",
});

function run(cwd: string, args: string[], input?: string) {
  const r = spawnSync("git", args, { cwd, env: env(), input: input ?? "" });
  return {
    status: r.status ?? 1,
    stdout: r.stdout as Buffer,
    stderr: (r.stderr as Buffer).toString("utf8"),
  };
}

/** Runs a setup script (bash, t/test-lib.sh's helpers defined) in `dir`. */
function sh(dir: string, script: string): void {
  const prelude = `
set -e
export GIT_AUTHOR_NAME="A U Thor" GIT_AUTHOR_EMAIL=author@example.com
export GIT_COMMITTER_NAME="C O Mitter" GIT_COMMITTER_EMAIL=committer@example.com
test_tick () {
  if test -z "\${test_tick+set}"; then test_tick=1112911993; else test_tick=$((test_tick + 60)); fi
  export GIT_COMMITTER_DATE="$test_tick -0700" GIT_AUTHOR_DATE="$test_tick -0700"
}
test_commit () {
  notag=; if test "$1" = "--no-tag"; then notag=1; shift; fi
  echo "$1" >"$1.t" && git add "$1.t" && test_tick && git commit -q -m "$1"
  if test -z "$notag"; then git tag "$1"; fi
}
`;
  const r = spawnSync("bash", ["-c", prelude + script], { cwd: dir, env: env() });
  if (r.status !== 0) throw new Error(`setup failed: ${r.stderr.toString()}`);
}

async function openOurs(dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const environment = createNodeGitHostEnvironment({ env: env() });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** The command for `for-each-ref <args>` (patterns read from `stdin` with `--stdin`). */
function configure(command: ForEachRefCommand, args: string[], stdin?: string): void {
  const patterns: string[] = [];
  const exclude: string[] = [];
  const sort: string[] = [];
  const lists: Record<string, string[]> = {};
  let noSort = false;
  let fromStdin = false;
  let quote: RefQuoteStyle = "none";
  for (const arg of args) {
    const eq = arg.indexOf("=");
    const [name, value] =
      arg.startsWith("--") && eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    switch (name) {
      case "--format":
        command.setFormat(value as string);
        break;
      case "--sort":
        if (noSort) {
          command.setNoSort();
          noSort = false;
        }
        sort.push(value as string);
        command.setSort(...sort);
        break;
      case "--no-sort":
        sort.length = 0;
        command.setNoSort();
        break;
      case "--count":
        command.setCount(Number(value));
        break;
      case "--shell":
      case "-s":
        quote = "shell";
        break;
      case "--perl":
        quote = "perl";
        break;
      case "--python":
        quote = "python";
        break;
      case "--tcl":
        quote = "tcl";
        break;
      case "--omit-empty":
        command.setOmitEmpty(true);
        break;
      case "--color":
        command.setColor(true);
        break;
      case "--ignore-case":
        command.setIgnoreCase(true);
        break;
      case "--include-root-refs":
        command.setIncludeRootRefs(true);
        break;
      case "--stdin":
        fromStdin = true;
        break;
      case "--exclude":
        exclude.push(value as string);
        break;
      case "--start-after":
        command.setStartAfter(value as string);
        break;
      case "--points-at":
      case "--contains":
      case "--no-contains":
      case "--merged":
      case "--no-merged":
        if (!lists[name]) lists[name] = [];
        if (value !== undefined) (lists[name] as string[]).push(value);
        else (lists[name] as string[]).push("HEAD");
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        patterns.push(arg);
    }
  }
  command.setQuoteStyle(quote);
  if (fromStdin)
    patterns.push(...(stdin ?? "").split("\n").filter((l, i, all) => l || i < all.length - 1));
  if (patterns.length) command.setPatterns(...patterns);
  if (exclude.length) command.setExclude(...exclude);
  if (lists["--points-at"]) command.setPointsAt(...lists["--points-at"]);
  if (lists["--contains"]) command.setContains(...lists["--contains"]);
  if (lists["--no-contains"]) command.setNoContains(...lists["--no-contains"]);
  if (lists["--merged"]) command.setMerged(...lists["--merged"]);
  if (lists["--no-merged"]) command.setNoMerged(...lists["--no-merged"]);
  command.setNow(NOW);
}

/** A case: arguments, the git version it needs, a script run before it (and one after). */
interface Case {
  args: string[];
  /** [major, minor] native git must be at least */
  since?: [number, number];
  stdin?: string;
  before?: string;
  after?: string;
}

/** Runs `c` through native git and ours in `dir` and compares the results. */
async function twin(dir: string, c: Case): Promise<void> {
  if (c.since && !gitAtLeast(version, c.since[0], c.since[1])) return;
  if (c.before) sh(dir, c.before);
  try {
    const native = run(dir, ["for-each-ref", ...c.args], c.stdin);
    const label = `for-each-ref ${c.args.join(" ")}`;
    const git = await openOurs(dir);
    const command = git.forEachRef();
    try {
      configure(command, c.args, c.stdin);
      command.setCompatibility(gitAtLeast(version, 2, 45) ? "2.56" : "2.43");
      const result = await command.call();
      expect({ label, status: 0 }).toEqual({ label, status: native.status });
      expect(Buffer.from(encodeGitPath(result.output)).toString("latin1"), label).toBe(
        native.stdout.toString("latin1"),
      );
      const warnings = result.warnings.map((w) => `${w}\n`).join("");
      expect(warnings, `${label} (stderr)`).toBe(native.stderr);
    } catch (e) {
      if (!(e instanceof GitApiError)) throw e;
      expect({ label, status: e.exitCode, message: e.message }).toEqual({
        label,
        status: native.status,
        message: e.exitCode === 129 ? e.message : native.stderr.replace(/\n$/, ""),
      });
      if (e.exitCode === 129) expect(native.stderr.startsWith(`${e.message}\n`), label).toBe(true);
    }
  } finally {
    if (c.after) sh(dir, c.after);
  }
}

/** t6300's setup and the refs its later tests add (signed tags left out: no gpg). */
const T6300_SETUP = `
datestamp=1151968723
setdate_and_increment () {
  GIT_COMMITTER_DATE="$datestamp +0200"; datestamp=$((datestamp + 1))
  GIT_AUTHOR_DATE="$datestamp +0200"; datestamp=$((datestamp + 1))
  export GIT_COMMITTER_DATE GIT_AUTHOR_DATE
}
git init -q -b master .
cat >.mailmap <<EOF
A Thor <athor@example.com> A U Thor <author@example.com>
C Mitter <cmitter@example.com> C O Mitter <committer@example.com>
EOF
setdate_and_increment
echo "Using $datestamp" >one
git add one
git commit -q -m "Initial"
git branch -M main
setdate_and_increment
git tag -a -m "Tagging at $datestamp" testtag
git update-ref refs/remotes/origin/main main
git remote add origin nowhere
git config branch.main.remote origin
git config branch.main.merge refs/heads/main
git remote add myfork elsewhere
git config remote.pushdefault myfork
git config push.default current
test_commit two
test_commit third
git update-ref refs/remotes/myfork/main main
git reset -q main~1
# ambiguous names
git checkout -q -b newtag
echo "Using $datestamp" >one
git add one
git commit -q -m "Branch"
setdate_and_increment
git tag -m "Tagging at $datestamp" main
git checkout -q main
git tag ambiguous testtag^0
git branch ambiguous testtag^0
# a tag without a tagger
git tag -a -m "Broken tag" taggerless
git tag -f taggerless $(git cat-file tag taggerless | sed -e "/^tagger /d" | git hash-object --literally --stdin -w -t tag) >/dev/null
git tag -m "bogo" bogo
bogo=$(git cat-file tag bogo)
bogo=$(printf "%s" "$bogo" | git mktag)
git tag -f bogo "$bogo" >/dev/null
printf 'the subject line\\n\\nfirst body line\\nsecond body line\\n' >msg
git tag -F msg subject-body
printf 'first subject line\\nsecond subject line\\n\\nfirst body line\\nsecond body line\\n' >msg
git tag -F msg multiline
git update-ref refs/mytrees/first refs/heads/main^{tree}
git update-ref refs/myblobs/first refs/heads/main:one
printf "a\\0b\\0c" >blob1
printf "a\\0c\\0b" >blob2
printf "\\0a\\0b\\0c" >blob3
printf "abc" >blob4
printf "\\0 \\0 \\0 " >blob5
printf "\\0 \\0a\\0 " >blob6
printf "  " >blob7
: >blob8
for i in 1 2 3 4 5 6 7 8; do git update-ref refs/myblobs/blob$i $(git hash-object -w blob$i); done
for when in 100000 200000; do
  for email in user1 user2; do
    for ref in ref1 ref2; do
      GIT_COMMITTER_DATE="@$when +0000" GIT_COMMITTER_EMAIL="$email@example.com" \\
        git tag -m "tag $ref-$when-$email" multi-$ref-$when-$email
    done
  done
done
i=1
for when in 1707341660 945129922 1622806011 1169484241; do
  GIT_COMMITTER_DATE="@$when +0000" GIT_COMMITTER_EMAIL="user@example.com" git tag -m "tag $when" custom-dates-$i
  i=$((i + 1))
done
# trailers, on a branch of their own
git checkout -q -b trailers
echo "Some contents" >two
git add two
git commit -q -F - <<EOF
trailers: this commit message has trailers

Some message contents

Reviewed-by: A U Thor <author@example.com>
Signed-off-by: A U Thor <author@example.com>
[ v2 updated patch description ]
Acked-by: A U Thor
  <author@example.com>
EOF
git checkout -q -b dashes
git commit -q --allow-empty -F - <<\\EOF
this is the subject

This is the body. The message has a "---" line which would confuse a
message+patch parser. But here we know we have only a commit message,
so we get it right.

trailer: wrong
---
This is more body.

trailer: right
EOF
git checkout -q main
git symbolic-ref refs/heads/sym refs/heads/main
git tag -F - tag-with-trailers <<\\EOF
body

one: foo
one: bar
two: baz
two: qux
EOF
git tag -F - fake-sig-no-blanks <<\\EOF
this is the subject
-----BEGIN PGP SIGNATURE-----
not a real signature, but we just care about the
subject/body parsing. It is important here that
there are no blank lines in the signature.
-----END PGP SIGNATURE-----
EOF
printf 'this is the subject\\r\\n-----BEGIN PGP SIGNATURE-----\\r\\n\\r\\nnot a real signature, but we just care about\\r\\nthe subject/body parsing.\\r\\n-----END PGP SIGNATURE-----\\r\\n' |
  git tag -F - --cleanup=verbatim fake-sig-crlf
git tag -F - fake-sig-trailer <<\\EOF
this is the subject

this is the body

My-Trailer: foo
-----BEGIN PGP SIGNATURE-----

not a real signature, but we just care about the
subject/body/trailer parsing.
-----END PGP SIGNATURE-----
EOF
nr=0
for email in a A b B; do
  for subject in a A b B; do
    GIT_COMMITTER_EMAIL="$email@example.com" git tag -m "tag $subject" icase-$(printf %02d $nr)
    nr=$((nr + 1))
  done
done
git tag -am "Normal tag" nested/base HEAD
git tag -am "Nested tag" nested/nest1 refs/tags/nested/base
git tag -am "Double nested tag" nested/nest2 refs/tags/nested/nest1
git tag -m "a tag in another zone" zoned HEAD
`;

/** Every atom t6300's test_atom checks (`contents:size` follows `contents`). */
const T6300_ATOMS = [
  "refname",
  "refname:",
  "refname:short",
  "refname:lstrip=1",
  "refname:lstrip=2",
  "refname:lstrip=-1",
  "refname:lstrip=-2",
  "refname:rstrip=1",
  "refname:rstrip=2",
  "refname:rstrip=-1",
  "refname:rstrip=-2",
  "refname:strip=1",
  "refname:strip=2",
  "refname:strip=-1",
  "refname:strip=-2",
  "upstream",
  "upstream:short",
  "upstream:lstrip=2",
  "upstream:lstrip=-2",
  "upstream:rstrip=2",
  "upstream:rstrip=-2",
  "upstream:strip=2",
  "upstream:strip=-2",
  "push",
  "push:short",
  "push:lstrip=1",
  "push:lstrip=-1",
  "push:rstrip=1",
  "push:rstrip=-1",
  "push:strip=1",
  "push:strip=-1",
  "objecttype",
  "objectsize",
  "objectname",
  "objectname:short",
  "objectname:short=1",
  "objectname:short=10",
  "tree",
  "tree:short",
  "tree:short=1",
  "tree:short=10",
  "parent",
  "parent:short",
  "parent:short=1",
  "parent:short=10",
  "numparent",
  "object",
  "type",
  "raw",
  "raw:size",
  "*objectname",
  "*objecttype",
  "*objectsize",
  "*raw",
  "author",
  "authorname",
  "authorname:mailmap",
  "authoremail",
  "authoremail:trim",
  "authoremail:localpart",
  "authoremail:trim,localpart",
  "authoremail:mailmap",
  "authoremail:mailmap,trim",
  "authoremail:trim,mailmap",
  "authoremail:mailmap,localpart",
  "authoremail:localpart,mailmap",
  "authoremail:mailmap,trim,localpart,mailmap,trim",
  "authordate",
  "committer",
  "committername",
  "committername:mailmap",
  "committeremail",
  "committeremail:trim",
  "committeremail:localpart",
  "committeremail:localpart,trim",
  "committeremail:mailmap",
  "committeremail:mailmap,trim",
  "committeremail:trim,mailmap",
  "committeremail:mailmap,localpart",
  "committeremail:localpart,mailmap",
  "committeremail:trim,mailmap,trim,trim,localpart",
  "committerdate",
  "tag",
  "tagger",
  "taggername",
  "taggername:mailmap",
  "taggeremail",
  "taggeremail:trim",
  "taggeremail:localpart",
  "taggeremail:trim,localpart",
  "taggeremail:mailmap",
  "taggeremail:mailmap,trim",
  "taggeremail:trim,mailmap",
  "taggeremail:mailmap,localpart",
  "taggeremail:localpart,mailmap",
  "taggeremail:trim,mailmap,trim,localpart,localpart",
  "taggerdate",
  "creator",
  "creatordate",
  "subject",
  "subject:sanitize",
  "contents:subject",
  "body",
  "contents:body",
  "contents:signature",
  "contents",
  "contents:size",
  "contents:lines=1",
  "contents:lines=0",
  "contents:lines=99999",
  "contents:lines=2",
  "HEAD",
  "symref",
  "symref:short",
  "symref:lstrip=2",
  "symref:lstrip=-2",
  "symref:strip=2",
  "symref:rstrip=2",
  "symref:rstrip=-2",
  "flag",
  "*refname",
  "*subject",
  "*authorname",
  "*committerdate",
  "*contents",
  "*tag",
  "trailers",
  "trailers:only",
  "trailers:only=no,only=true",
  "trailers:only=yes",
  "trailers:only=no",
  "trailers:unfold",
  "trailers:only,unfold",
  "trailers:unfold,only",
  "trailers:key=Signed-off-by",
  "trailers:key=SiGned-oFf-bY",
  "trailers:key=Signed-off-by:",
  "trailers:key=Reviewed-by:,key=Signed-off-by",
  "trailers:key=Shined-off-by:",
  "trailers:key=Acked-by",
  "trailers:key=Signed-Off-by,unfold",
  "trailers:key=Signed-off-by,only=no",
  "trailers:key=Signed-off-by,valueonly",
  "trailers:separator=%x2C,key=Reviewed-by,key=Signed-off-by:",
  "trailers:key_value_separator=%x2C,key=Reviewed-by,key=Signed-off-by:",
  "trailers:separator=%x2C,key_value_separator=%x2C,key=Reviewed-by,key=Signed-off-by:",
  "trailers:separator=",
  "trailers:keyonly",
  "contents:trailers",
  "contents:trailers:only",
  "contents:trailers:key=Signed-off-by,valueonly",
  "describe",
  "describe:tags",
  "describe:abbrev=14",
  "describe:tags=no,abbrev=4",
  "*describe",
  "signature",
  "signature:grade",
  "signature:trustlevel",
  "signature:key",
];

const DATE_FORMATS = [
  "",
  "default",
  "default-local",
  "relative",
  "relative-local",
  "short",
  "short-local",
  "local",
  "iso8601",
  "iso8601-local",
  "rfc2822",
  "rfc2822-local",
  "raw",
  "raw-local",
  "unix",
  "human",
  "format:my date is %Y-%m-%d",
  "format-local:my date is %Y-%m-%d",
  "format:",
  "format:%H:%M:%S %z %Z",
];

/** t6300's other cases (sorting, quoting, patterns, colors, errors, ...). */
const T6300_CASES: Case[] = [
  { args: [] },
  { args: ["--format=%(refname)", "--sort=refname"] },
  { args: ["--format=%(refname)", "--sort=-refname"] },
  { args: ["--format=%(refname)", "refs/tags/testtag", "refs/tags/two"] },
  { args: ["--format=%(refname)", "refs/tags/testtag", "refs/tags/multi-*"] },
  { args: ["--format=%(refname)", "refs/tags/", "--exclude=refs/tags/multi"], since: [2, 42] },
  {
    args: [
      "--format=%(refname)",
      "refs/tags/",
      "--exclude=refs/tags/multi-ref1*",
      "--exclude=refs/tags/icase-0*",
    ],
    since: [2, 42],
  },
  { args: ["--shell", "--format=%(refname) %(subject)"] },
  { args: ["--perl", "--format=%(refname) %(subject) %(raw:size)"] },
  { args: ["--python", "--format=%(refname) %(contents)"] },
  { args: ["--tcl", "--format=%(refname) %(contents) %(*objectname)"] },
  { args: ["--perl", "--format=%(raw)", "refs/myblobs/"] },
  { args: ["--shell", "--format=%(raw)"] },
  { args: ["--python", "--format=%(raw)"] },
  { args: ["--tcl", "--format=%(raw)"] },
  { args: ["--shell", "--format=%(raw)", "--sort=raw"] },
  { args: ["--shell", "--format=%(raw:size)"] },
  { args: ["--format=%(INVALID)", "refs/heads"] },
  { args: ["--format=%(authordate:INVALID)", "refs/heads"] },
  { args: ["--format=%(authordate:INVALID)", "refs/mytrees"] },
  { args: ["--format=%(objectname:short=0)"] },
  { args: ["--format=%(objectname:short=-1)"] },
  { args: ["--format=%(objectname:short=foo)"] },
  { args: ["--format=%(refname:track)"] },
  { args: ["--format=%(refname:INVALID)"] },
  { args: ["--format=%(rest)", "refs/heads/main"] },
  { args: ["--format=%(HEAD:foo)"] },
  { args: ["--format=%(subject:foo)"] },
  { args: ["--format=%(refname:foo)"] },
  { args: ["--format=%(trailers:unsupported)", "refs/heads/trailers"] },
  { args: ["--format=%(contents:trailers:unsupported)", "refs/heads/trailers"] },
  { args: ["--format=%(trailers:key)", "refs/heads/trailers"] },
  { args: ["--format=%(contents:trailersonly)"] },
  { args: ["--format=%(contents:lines=-1)"] },
  { args: ["--format=%(describe:baz)", "refs/heads/main"] },
  { args: ["--format=%(describe:tags,qux=1,abbrev=14)", "refs/heads/main"] },
  { args: ["--format=%(describe:abbrev=)", "refs/heads/main"] },
  { args: ["--format=%(describe:abbrev=-1)", "refs/heads/main"] },
  { args: ["--format=%(describe:abbrev=3x)", "refs/heads/main"] },
  { args: ["--format=%(describe:match=)", "refs/heads/main"] },
  { args: ["--format=%(describe:match=*-2,exclude=multi*)", "refs/heads/"] },
  { args: ["--format=%(color)%(refname)"] },
  { args: ["--format=%(color:bogus)%(refname)"] },
  { args: ["--format=%(objectname:short) %(color:green)%(refname:short)"] },
  { args: ["--color", "--format=%(objectname:short) %(color:green)%(refname:short)"] },
  { args: ["--color", "--format=%(color:bold red)%(refname)%(color:reset) %(color:#aa22ac)x"] },
  { args: ["--color", "--shell", "--format=%(color:green)%(refname)"] },
  { args: ["--format=%(authoremail:foo)", "refs/heads/main"] },
  { args: ["--format=%(authoremail:mailmap,trim,bar)", "refs/heads/main"] },
  { args: ["--format=%(authoremail:trim,)", "refs/heads/main"] },
  { args: ["--format=%(authoremail:mailmaptrim)", "refs/heads/main"] },
  { args: ["--format=%(committeremail: )", "refs/heads/main"] },
  { args: ["--format=%(committeremail: trim,foo)", "refs/heads/main"] },
  { args: ["--format=%(committeremail:mailmap,localpart )", "refs/heads/main"] },
  { args: ["--format=%(committeremail:trim_localpart)", "refs/heads/main"] },
  { args: ["--format=%(committeremail:localpart,,,trim)", "refs/heads/main"] },
  { args: ["--format=%(taggeremail:mailmap,trim, foo )", "refs/tags/testtag"] },
  { args: ["--format=%(taggeremail:trim,localpart,)", "refs/tags/testtag"] },
  { args: ["--format=%(taggeremail:mailmap;localpart trim)", "refs/tags/testtag"] },
  { args: ["--format=%(taggeremail:localpart trim)", "refs/tags/testtag"] },
  {
    args: ["--format=%(taggeremail:mailmap,mailmap,trim,qux,localpart,trim)", "refs/tags/testtag"],
  },
  {
    args: [
      "--format=%(refname)",
      "--sort=raw",
      "refs/heads/main",
      "refs/myblobs/",
      "refs/mytrees/first",
    ],
  },
  {
    args: [
      "--format=%(refname)",
      "--sort=raw:size",
      "refs/heads/main",
      "refs/myblobs/",
      "refs/mytrees/first",
    ],
  },
  {
    args: [
      "--format=%(if:equals=abc)%(raw)%(then)%(refname)%(else)not equals%(end)",
      "refs/myblobs/",
      "refs/heads/",
    ],
  },
  {
    args: [
      "--format=%(if:notequals=abc)%(raw)%(then)%(refname)%(else)equals%(end)",
      "refs/myblobs/",
      "refs/heads/",
    ],
  },
  { args: ["--format=%(refname) %(if)%(raw)%(then)not empty%(else)empty%(end)", "refs/myblobs/"] },
  { args: ["--format=%(objectname) %(objecttype) %(objectsize)\n%(raw)", "refs/mytrees/first"] },
  { args: ["--format=%(refname)", "--sort=contents:size", "refs/heads/"] },
  {
    args: [
      "--format=%(taggerdate:unix) %(taggeremail) %(refname)",
      "--sort=-refname",
      "--sort=taggeremail",
      "--sort=taggerdate",
      "refs/tags/multi-*",
    ],
  },
  {
    args: [
      "--format=%(taggerdate:unix) %(taggeremail) %(refname)",
      "--sort=taggerdate",
      "refs/tags/multi-*",
    ],
  },
  {
    args: [
      "--format=%(taggerdate:unix) %(taggeremail) %(refname)",
      "--sort=-refname",
      "--sort=taggeremail",
      "--no-sort",
      "--sort=taggerdate",
      "refs/tags/multi-*",
    ],
    since: [2, 45],
  },
  { args: ["--format=%(refname)", "--no-sort", "refs/tags/multi-*"] },
  {
    args: [
      "--format=%(creatordate:unix) %(refname)",
      "--sort=creatordate",
      "refs/tags/custom-dates-*",
    ],
  },
  {
    args: [
      "--format=%(creatordate:format:%H:%M:%S) %(refname)",
      "--sort=creatordate:format:%H:%M:%S",
      "refs/tags/custom-dates-*",
    ],
  },
  { args: ["--format=%(refname)", "--sort=-creatordate", "--sort=objecttype"] },
  { args: ["--format=%(refname)", "--sort=numparent", "--sort=-objectsize"] },
  { args: ["--format=%(refname)", "--sort=*subject", "--sort=-*objectname"] },
  { args: ["--format=%(refname)", "--sort=bogus"] },
  { args: ["--format=%(refname:short)", "refs/heads/main", "refs/tags/main"] },
  {
    args: ["--format=%(refname:short)", "refs/heads/main", "refs/tags/main"],
    before: "git config core.warnambiguousrefs false",
    after: "git config --unset core.warnambiguousrefs",
  },
  {
    args: ["--format=%(refname:short)", "refs/heads/ambiguous", "refs/tags/ambiguous"],
    before: "git config core.warnambiguousrefs false",
    after: "git config --unset core.warnambiguousrefs",
  },
  { args: ["--format=%(body)", "refs/tags/bogo"] },
  { args: ["--format=%(upstream:track)", "refs/heads"] },
  { args: ["--format=%(upstream:trackshort)", "refs/heads"] },
  { args: ["--format=%(upstream:track,nobracket)", "refs/heads"] },
  { args: ["--format=%(upstream:nobracket,track)", "refs/heads"] },
  { args: ["--format=%(push:track)", "refs/heads"] },
  { args: ["--format=%(push:trackshort)", "refs/heads"] },
  {
    args: [
      "--format=%(upstream:remotename) %(upstream:remoteref) %(push:remotename) %(push:remoteref)",
      "refs/heads",
    ],
  },
  {
    args: ["--format=%(upstream:track)%0a%(upstream:trackshort)", "refs/heads"],
    before: "git config branch.main.merge refs/heads/does-not-exist",
    after: "git config branch.main.merge refs/heads/main",
  },
  {
    args: ["--format=%(refname) %(push)", "refs/heads/main"],
    before: "git config push.default simple",
    after: "git config push.default current",
  },
  { args: ["--format=%(refname)", "refs/heads/MAIN"] },
  { args: ["--format=%(refname)", "--ignore-case", "refs/heads/MAIN"] },
  {
    args: [
      "--format=%(if:equals=refs/heads/main)%(refname)%(then)%(refname)%(end)",
      "--omit-empty",
    ],
    since: [2, 42],
  },
  { args: ["--format=%(if:equals=refs/heads/main)%(refname)%(then)%(refname)%(end)"] },
  {
    args: [
      "--ignore-case",
      "--format=%(taggeremail) %(subject) %(refname)",
      "--sort=refname",
      "--sort=subject",
      "--sort=taggeremail",
      "refs/tags/icase-*",
    ],
  },
  {
    args: [
      "--format=%(taggeremail) %(subject) %(refname)",
      "--sort=refname",
      "--sort=subject",
      "--sort=taggeremail",
      "refs/tags/icase-*",
    ],
  },
  { args: ["--format=%(refname)", "--stdin"], stdin: "" },
  { args: ["--format=%(refname)", "--stdin"], stdin: "refs/tags/multi*\nrefs/heads/amb*\n" },
  {
    args: ["--format=%(refname)", "--stdin"],
    stdin: "refs/heads/this-ref-does-not-exist\nrefs/tags/bogus\n",
  },
  {
    args: [
      "--format=%(refname) %(objectname) %(objecttype) %(*objectname) %(*objecttype)",
      "refs/tags/nested/",
    ],
  },
  { args: ["--format=%(refname)", "--count=3"] },
  { args: ["--format=%(refname)", "--count=3", "--sort=-refname"] },
  { args: ["--format=%(refname)", "--count=0"] },
  { args: ["--format=%(refname)", "--count=-1"] },
  { args: ["--format=%%(refname) %x %%%41%4a%(refname:short)%25%zz%"] },
  { args: ["--format=%(refname"] },
  { args: ["--format=%(*)"] },
  { args: ["--format=%()"] },
  { args: ["--format=%(refname) %(ahead-behind:main)"], since: [2, 41] },
  {
    args: [
      "--format=%(refname) %(ahead-behind:HEAD) %(ahead-behind:trailers)",
      "refs/heads/",
      "--sort=ahead-behind:HEAD",
    ],
    since: [2, 41],
  },
  { args: ["--format=%(ahead-behind)"], since: [2, 41] },
  { args: ["--format=%(ahead-behind:nope)"], since: [2, 41] },
  { args: ["--format=%(is-base:dashes) %(refname)", "refs/heads/"], since: [2, 47] },
  {
    args: ["--format=%(is-base:HEAD) %(is-base:dashes) %(refname)", "refs/heads/", "refs/remotes/"],
    since: [2, 47],
  },
  { args: ["--format=%(refname) %(worktreepath)", "refs/heads/"] },
  { args: ["--format=%(refname)", "--sort=version:refname", "refs/tags/"] },
  {
    args: [
      "--format=%(align:20,right)%(refname:short)%(end)|%(align:middle,9)%(objecttype)%(end)|",
    ],
  },
  { args: ["--format=%(align:5)%(refname)"] },
  { args: ["--format=%(align)x%(end)"] },
  { args: ["--format=%(align:0)x%(end)"] },
  { args: ["--format=%(align:middle)x%(end)"] },
  { args: ["--format=%(align:12,sideways)x%(end)"] },
  { args: ["--format=%(align:width=x)x%(end)"] },
  { args: ["--format=%(align:position=up,3)x%(end)"] },
];

/** t6302's setup (unsigned "signed" tags, as without the GPG prerequisite). */
const T6302_SETUP = `
git init -q -b master .
test_commit one
git branch -M main
test_commit two
test_commit three
git checkout -q -b side
test_commit four
git tag -m "An annotated tag" annotated-tag
git tag -m "Annotated doubly" doubly-annotated-tag annotated-tag
git tag -m "A signed tag" signed-tag
git tag -m "Signed doubly" doubly-signed-tag signed-tag
git checkout -q main
git update-ref refs/odd/spot main
test_commit foo1.3
test_commit foo1.6
test_commit foo1.10
git tag foo1.10-rc1 foo1.6
git tag foo1.10-beta foo1.6
git tag foo1.10-alpha foo1.6
git update-ref ORIG_HEAD main
git worktree add -q -b main_worktree worktree_dir main
`;

const T6302_CASES: Case[] = [
  { args: ["--format=%(refname)", "--include-root-refs"], since: [2, 45] },
  { args: ["--format=%(refname)", "--include-root-refs", "*HEAD"], since: [2, 45] },
  {
    args: [
      "--format=%(refname) %(HEAD) %(objectname:short)",
      "--include-root-refs",
      "--points-at=main",
    ],
    since: [2, 46],
  },
  { args: ["--format=%(refname)", "--points-at=main"] },
  { args: ["--format=%(refname) %(*subject)", "--points-at=side"] },
  { args: ["--format=%(refname)", "--points-at=one", "--points-at=annotated-tag"] },
  { args: ["--format=%(refname)", "--points-at=nonsense"] },
  { args: ["--format=%(refname)", "--merged=main"] },
  { args: ["--format=%(refname)", "--no-merged=main"] },
  { args: ["--format=%(refname)", "--merged=one", "--merged=four"] },
  { args: ["--format=%(refname)", "--merged"] },
  { args: ["--format=%(refname)", "--merged=nonsense"] },
  { args: ["--format=%(refname)", "--merged=main^{tree}"] },
  { args: ["--format=%(refname)", "--contains=two"] },
  { args: ["--format=%(refname)", "--no-contains=two"] },
  { args: ["--format=%(refname)", "--contains=two", "--no-contains=three"] },
  { args: ["--format=%(refname)", "--contains=annotated-tag"] },
  { args: ["--format=%(refname)", "--contains=nonsense"] },
  { args: ["--format=%(refname)", "--contains=main^{tree}"] },
  { args: ["--format=%(refname)", "--merged=HEAD", "--no-merged=HEAD"] },
  { args: ["--format=%(refname)", "--merged=side", "--contains=two", "refs/tags/"] },
  { args: ["--format=%(color)%(refname)"] },
  { args: ["--format=%(color:#aa22ac)%(refname)"] },
  { args: ["--format=%(align:30)refname is %(refname)%(end)|%(refname)"] },
  { args: ["--format=|%(align:middle,30)refname is %(refname)%(end)|%(refname)"] },
  { args: ["--format=|%(align:30,right)refname is %(refname)%(end)|%(refname)"] },
  ...[
    "middle,42",
    "42,middle",
    "position=middle,42",
    "42,position=middle",
    "middle,width=42",
    "width=42,middle",
    "position=middle,width=42",
    "width=42,position=middle",
    "32,width=42,middle",
    "width=30,42,middle",
    "width=42,position=right,middle",
    "42,right,position=middle",
  ].map((o) => ({ args: [`--format=|%(align:${o})refname is %(refname)%(end)|%(refname)`] })),
  { args: ["--shell", "--format=|%(align:30,middle)'%(refname:short)| %(authorname)'%(end)|"] },
  { args: ["--shell", "--format=|%(align:30,left)%(align:15,right)%(refname:short)%(end)%(end)|"] },
  {
    args: [
      "--python",
      "--format=|%(if)%(authorname)%(then)%(align:20)%(authorname)%(end)%(else)'none'%(end)|",
    ],
  },
  { args: ["--format=%(refname:short) |%(contents:lines=1)"] },
  { args: ["--format=%(refname:short) |%(contents:lines=0)"] },
  { args: ["--format=%(refname:short) |%(contents:lines=99999)"] },
  { args: ["--sort=version:refname", "--format=%(refname:short)", "refs/tags/"] },
  { args: ["--sort=v:refname", "--format=%(refname:short)", "refs/tags/"] },
  { args: ["--sort=-version:refname", "--format=%(refname:short)", "refs/tags/"] },
  {
    args: ["--sort=version:refname", "--format=%(refname:short)", "refs/tags/"],
    before: "git config versionsort.suffix -rc && git config --add versionsort.suffix -beta",
    after: "git config --unset-all versionsort.suffix",
  },
  {
    args: ["--sort=version:refname", "--format=%(refname:short)", "refs/tags/"],
    before: "git config versionsort.prereleasesuffix -alpha",
    after: "git config --unset-all versionsort.prereleasesuffix",
  },
  {
    args: ["--sort=version:refname", "--format=%(refname:short)", "refs/tags/"],
    before: "git config versionsort.prereleasesuffix -alpha && git config versionsort.suffix -beta",
    after:
      "git config --unset-all versionsort.prereleasesuffix && git config --unset-all versionsort.suffix",
  },
  ...[
    "%(if)",
    "%(then) %(end)",
    "%(else) %(end)",
    "%(if) %(else) %(end)",
    "%(if) %(then) %(then) %(end)",
    "%(then) %(else) %(end)",
    "%(if) %(then) %(else)",
    "%(if) %(else) %(then) %(end)",
    "%(if) %(then) %(else) %(else) %(end)",
    "%(if) %(end)",
    "%(end)",
  ].map((f) => ({ args: [`--format=${f}`] })),
  { args: ["--format=%(refname)%(if)%(authorname)%(then) Author: %(authorname)%(end)"] },
  { args: ["--format=%(if)%(authorname)%(then)%(authorname)%(else)No author%(end): %(refname)"] },
  { args: ["--format=%(refname:short): %(if)%(HEAD)%(then)Head ref%(else)Not Head ref%(end)"] },
  {
    args: [
      "--format=%(if:equals=main)%(refname:short)%(then)Found main%(else)Not main%(end)",
      "refs/heads/",
    ],
  },
  {
    args: [
      "--format=%(if:notequals=main)%(refname:short)%(then)Not main%(else)Found main%(end)",
      "refs/heads/",
    ],
  },
  {
    args: [
      "--format=%(if)%(if)%(HEAD)%(then)x%(end)%(then)[%(refname)]%(else)-%(end)",
      "refs/heads/",
    ],
  },
  { args: ["--format=%(if:bogus)x%(then)y%(end)"] },
  {
    args: [
      "--format=%(refname:short): %(if)%(worktreepath)%(then)%(worktreepath)%(else)not checked out%(end)",
      "refs/heads/",
    ],
  },
  { args: ["--format=%(refname)", "--start-after="], since: [2, 51] },
  ...[
    "refs/odd/spot",
    "refs/odd/sp",
    "refs/odd/parrot",
    "refs/odd",
    "refs/odd/",
    "refs/lost",
    "refs/odd/spotnew",
    "refs/odd/spot/new",
    "refs/tags/two",
  ].map((m) => ({
    args: ["--format=%(refname)", `--start-after=${m}`],
    since: [2, 51] as [number, number],
  })),
  {
    args: ["--format=%(refname)", "--start-after=refs/odd/spot", "--exclude=refs/tags/foo"],
    since: [2, 51],
  },
  { args: ["--format=%(refname)", "--start-after=refs/odd/spot", "refs/tags"], since: [2, 51] },
  { args: ["--format=%(refname)", "--start-after=refs/odd/spot", "--sort=author"], since: [2, 51] },
];

/** t6600-test-reach.sh's 10x10 grid: (x,y) has parents (x-1,y) and (x,y-1). */
const T6600_SETUP = `
git init -q -b master .
for i in $(seq 1 10); do
  test_commit "1-$i"
  git branch -f commit-1-$i
  git tag -a -m "1-$i" tag-1-$i commit-1-$i
done
for j in $(seq 1 9); do
  git reset -q --hard commit-$j-1
  x=$((j + 1))
  test_commit "$x-1"
  git branch -f commit-$x-1
  git tag -a -m "$x-1" tag-$x-1 commit-$x-1
  for i in $(seq 2 10); do
    test_tick
    git merge -q commit-$j-$i -m "$x-$i"
    git branch -f commit-$x-$i
    git tag -a -m "$x-$i" tag-$x-$i commit-$x-$i
  done
done
git checkout -q commit-5-5
`;

const T6600_CASES: Case[] = [
  { args: ["--format=%(refname)", "--contains=commit-4-2", "refs/heads/"] },
  { args: ["--format=%(refname)", "--no-contains=commit-4-2", "refs/heads/"] },
  { args: ["--format=%(refname)", "--merged=commit-3-3", "refs/heads/", "refs/tags/"] },
  { args: ["--format=%(refname)", "--no-merged=commit-3-3", "refs/heads/"] },
  { args: ["--format=%(refname)", "--merged=commit-3-3", "--merged=commit-2-8", "refs/tags/"] },
  {
    args: [
      "--format=%(refname)",
      "--contains=commit-2-2",
      "--contains=commit-5-1",
      "--no-merged=commit-8-8",
      "refs/heads/",
    ],
  },
  { args: ["--format=%(refname)", "--points-at=commit-3-3"] },
  {
    args: [
      "--format=%(refname) %(ahead-behind:commit-5-5)",
      "refs/heads/commit-1-*",
      "refs/heads/commit-9-*",
    ],
    since: [2, 41],
  },
  {
    args: ["--format=%(refname) %(ahead-behind:commit-9-6) %(ahead-behind:commit-6-9)", "--stdin"],
    stdin:
      "refs/heads/commit-1-1\nrefs/heads/commit-5-3\nrefs/heads/commit-7-8\nrefs/heads/commit-4-8\nrefs/heads/commit-9-9\n",
    since: [2, 41],
  },
  {
    args: [
      "--format=%(refname) %(is-base:commit-6-7)",
      "--sort=refname",
      "refs/heads/commit-3-*",
      "refs/heads/commit-5-*",
    ],
    since: [2, 47],
  },
];

describeGit("for-each-ref against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "for-each-ref-native-"));
    version = run(root, ["--version"]).stdout.toString();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const repo = (name: string, setup: string): string => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    sh(dir, setup);
    return dir;
  };

  it("t6300: every atom over every ref", { timeout: 600_000 }, async () => {
    const dir = repo("t6300", T6300_SETUP);
    for (const atom of T6300_ATOMS) {
      await twin(dir, { args: [`--format=%(refname) %(${atom})`] });
    }
  });

  it("t6300: dates in every format", { timeout: 300_000 }, async () => {
    const dir = join(root, "t6300");
    for (const f of DATE_FORMATS) {
      const suffix = f ? `:${f}` : "";
      await twin(dir, {
        args: [
          "--shell",
          `--format=%(refname) %(committerdate${suffix}) %(authordate${suffix}) %(taggerdate${suffix}) %(creatordate${suffix})`,
        ],
      });
    }
  });

  it("t6300: iso-strict dates (git 2.45+ writes Z for +0000)", { timeout: 60_000 }, async () => {
    if (!gitAtLeast(version, 2, 45)) return;
    await twin(join(root, "t6300"), {
      args: ["--format=%(refname) %(committerdate:iso-strict) %(creatordate:iso-strict-local)"],
    });
  });

  it("t6300: sorting, quoting, patterns, colors and refusals", { timeout: 600_000 }, async () => {
    const dir = join(root, "t6300");
    for (const c of T6300_CASES) await twin(dir, c);
  });

  it("t6300: describe atoms (describe-repo)", { timeout: 120_000 }, async () => {
    const dir = repo(
      "describe",
      `
git init -q -b master .
test_commit --no-tag one
git tag tagone
test_commit --no-tag two
git tag -a -m "tag two" tagtwo
test_commit --no-tag file
git tag -a -m tagged tagname
git tag -a -m "tag foo" tag-foo
git tag -a -m "tag bar" tag-bar
`,
    );
    for (const f of [
      "%(objectname) %(describe)",
      "%(describe:tags)",
      "%(describe:abbrev=14)",
      "%(describe:match=*-foo)",
      "%(describe:exclude=*-bar)",
      "%(*describe)",
      "%(describe:tags=false,match=tag*,exclude=tagname)",
    ]) {
      await twin(dir, { args: [`--format=${f}`] });
    }
  });

  it("t6300: broken tags and dangling refs", { timeout: 120_000 }, async () => {
    const dir = repo(
      "broken",
      `
git init -q -b master .
test_commit one
git tag -m "good tag" broken-tag-good HEAD
git cat-file tag broken-tag-good | sed s/commit/blob/ >bad
git update-ref refs/tags/broken-tag-bad $(git hash-object -w -t tag --literally bad)
git symbolic-ref refs/heads/dangling refs/heads/missing
`,
    );
    for (const c of [
      { args: ["--format=%(refname)"] },
      { args: ["--format=%(*objectname)", "refs/tags/broken-tag-good"] },
      { args: ["--format=%(*objectname)", "refs/tags/broken-tag-bad"] },
      { args: ["--format=%(*objectname) %(*objecttype)", "refs/tags/broken-tag-bad"] },
      { args: ["--format=%(refname) %(objecttype)", "refs/tags/"] },
    ] as Case[]) {
      await twin(dir, c);
    }
  });

  it("t6300: :remotename and :remoteref", { timeout: 120_000 }, async () => {
    const dir = repo(
      "remote-tests",
      `
git init -q -b master .
test_commit initial
git branch -M main
git remote add from fifth.coffee:blub
git config branch.main.remote from
git config branch.main.merge refs/heads/stable
git remote add to southridge.audio:repo
git config remote.to.push "refs/heads/*:refs/heads/pushed/*"
git config branch.main.pushRemote to
git branch push-simple
git config branch.push-simple.pushRemote from
git branch plain
`,
    );
    for (const f of [
      "%(upstream)",
      "%(upstream:remotename)",
      "%(upstream:remoteref)",
      "%(push)",
      "%(push:remotename)",
      "%(push:remoteref)",
      "%(push:remotename),%(push:remoteref)",
      "%(upstream:track) %(push:trackshort)",
    ]) {
      await twin(dir, { args: [`--format=%(refname) ${f}`, "refs/heads/"] });
    }
  });

  it("t6302: filters, alignment, conditions, version sort, --start-after", {
    timeout: 600_000,
  }, async () => {
    const dir = repo("t6302", T6302_SETUP);
    for (const c of T6302_CASES) await twin(dir, c);
  });

  it("t6600: reachability filters, with and without a commit-graph", {
    timeout: 600_000,
  }, async () => {
    const dir = repo("t6600", T6600_SETUP);
    for (const c of T6600_CASES) await twin(dir, c);
    sh(dir, "git commit-graph write --reachable");
    for (const c of T6600_CASES) await twin(dir, c);
  });

  it("t6301: refs whose objects are missing", { timeout: 120_000 }, async () => {
    const dir = repo(
      "t6301",
      `
git init -q -b master .
test_commit one
git update-ref refs/heads/missing 0123456789abcdef0123456789abcdef01234567 --no-deref 2>/dev/null ||
  printf '0123456789abcdef0123456789abcdef01234567\\n' >.git/refs/heads/missing
`,
    );
    for (const c of [
      { args: ["--format=%(refname)"] },
      { args: ["--format=%(objectname) %(refname)"] },
      { args: ["--format=%(objectname) %(objecttype) %(refname)"] },
      { args: ["--format=%(refname) %(subject)", "refs/heads/missing"] },
    ] as Case[]) {
      await twin(dir, c);
    }
  });
});
