/**
 * `git.tagList().callText()` against native `git tag` (list mode), byte for byte: the
 * listings of t7004-tag.sh (patterns, `-i`, `-n<num>` annotations of annotated, empty,
 * many-line, signed and lightweight tags and of a blob, `--sort` with `tag.sort`,
 * `--no-sort` and `versionsort.suffix`, `--contains`/`--no-contains`, `--merged`/
 * `--no-merged`, `--points-at`, `--format`, `--omit-empty`, colors) and JGit
 * TagCommandTest's `--contains` inputs (testListTagsContainingCommit). Each case runs the
 * same arguments through native git and through ours and compares stdout (or the exit status
 * and stderr of a refusal).
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, GitApiError, type ListTagCommand } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let version = "";

const env = (): Record<string, string> => ({ ...nativeGitEnv(root), TZ: "UTC" });

function run(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, env: env() });
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
test_tick
test_commit () {
  echo "$1" >"$1.t" && git add "$1.t" && test_tick && git commit -q -m "$1" && git tag "$1"
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

/** The command for `tag <args>` (list mode). */
function configure(command: ListTagCommand, args: string[]): void {
  const patterns: string[] = [];
  let sort: string[] = [];
  const lists: Record<string, string[]> = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    const [name, value] =
      arg.startsWith("--") && eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    if (/^-n\d*$/.test(name)) {
      command.setLines(name.length > 2 ? Number(name.slice(2)) : 1);
      continue;
    }
    switch (name) {
      case "--list":
      case "-l":
        break;
      case "--format":
        command.setFormat(value as string);
        break;
      case "--sort":
        sort.push(value as string);
        command.setSort(...sort);
        break;
      case "--no-sort":
        sort = [];
        command.setNoSort();
        break;
      case "--omit-empty":
        command.setOmitEmpty(true);
        break;
      case "--color":
        command.setColor(true);
        break;
      case "--no-color":
        command.setColor(false);
        break;
      case "-i":
      case "--ignore-case":
        command.setIgnoreCase(true);
        break;
      case "--points-at":
      case "--contains":
      case "--no-contains":
      case "--merged":
      case "--no-merged":
        if (!lists[name]) lists[name] = [];
        (lists[name] as string[]).push(value ?? "HEAD");
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        patterns.push(arg);
    }
  }
  if (patterns.length) command.setPatterns(...patterns);
  if (lists["--points-at"]) command.setPointsAt(...lists["--points-at"]);
  if (lists["--contains"]) command.setContains(...lists["--contains"]);
  if (lists["--no-contains"]) command.setNoContains(...lists["--no-contains"]);
  if (lists["--merged"]) command.setMerged(...lists["--merged"]);
  if (lists["--no-merged"]) command.setNoMerged(...lists["--no-merged"]);
}

/** A case: arguments, the git version it needs, a script run before it (and one after). */
interface Case {
  args: string[];
  /** [major, minor] native git must be at least */
  since?: [number, number];
  before?: string;
  after?: string;
}

/** Runs `c` through native git and ours in `dir` and compares the results. */
async function twin(dir: string, c: Case): Promise<void> {
  if (c.since && !gitAtLeast(version, c.since[0], c.since[1])) return;
  if (c.before) sh(dir, c.before);
  try {
    const native = run(dir, ["tag", ...c.args]);
    const label = `tag ${c.args.join(" ")}`;
    const git = await openOurs(dir);
    const command = git.tagList();
    try {
      configure(command, c.args);
      command.setCompatibility(gitAtLeast(version, 2, 45) ? "2.56" : "2.43");
      const result = await command.callText();
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

/** A `gpg.program` signing anything with the same fake signature (no real gpg). */
const FAKE_GPG = `#!/bin/sh
cat >/dev/null
echo "[GNUPG:] SIG_CREATED D 1 8 00 1112911993 FAKE" >&2
printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZSBzaWduYXR1cmU=\\n-----END PGP SIGNATURE-----\\n'
`;

describeGit("tag listing against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tag-list-native-"));
    version = run(root, ["--version"]).stdout.toString();
    writeFileSync(join(root, "fake-gpg"), FAKE_GPG);
    chmodSync(join(root, "fake-gpg"), 0o755);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const repo = (name: string, setup: string): string => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    sh(dir, setup);
    return dir;
  };

  it("t7004: empty repository, sort tags ignoring case", { timeout: 120_000 }, async () => {
    const empty = repo("t7004-empty", "git init -q -b main .");
    await twin(empty, { args: ["-l"] });
    await twin(empty, { args: [] });
    const dir = repo(
      "t7004-sort",
      `git init -q -b main .
test_commit initial
git tag tag-one
git tag TAG-two`,
    );
    for (const c of [
      { args: ["-l"] },
      { args: ["-l", "-i"] },
      { args: ["-l", "--ignore-case", "tag-*"] },
      { args: ["-l", "--ignore-case", "-n", "TAG-*"] },
      { args: ["-i", "--sort=-refname"] },
    ])
      await twin(dir, c);
  });

  it("t7004: listing ordered tags and patterns", { timeout: 120_000 }, async () => {
    const dir = repo(
      "t7004-patterns",
      `git init -q -b main .
>foo && git add foo && test_tick && git commit -q -m Foo
git tag mytag
for t in v1.0.1 t211 aa1 v0.2.1 v1.1.3 cba a1 v1.0 t210; do git tag $t; done`,
    );
    for (const c of [
      { args: ["-l"] },
      { args: [] },
      { args: ["-l", "-l"] },
      { args: ["-l", "mytag"] },
      { args: ["-l", "--ignore-case", "MYTAG"] },
      { args: ["-l", "xxx"] },
      { args: ["-l", "*a*"] },
      { args: ["-l", "*.1"] },
      { args: ["-l", "t21*"] },
      { args: ["-l", "a1"] },
      { args: ["-l", "v1.0"] },
      { args: ["-l", "v1.?.?"] },
      { args: ["-l", "v.*"] },
      { args: ["-l", "v*"] },
      { args: ["-l", "v1*", "v0*"] },
    ])
      await twin(dir, c);
  });

  it("t7004: -n<num> annotations (annotated, empty, many lines, blob, lightweight, signed)", {
    timeout: 300_000,
  }, async () => {
    const dir = repo(
      "t7004-lines",
      `git init -q -b main .
git config gpg.program "${join(root, "fake-gpg")}"
>foo && git add foo && test_tick && git commit -q -m "Foo subject" -m "Foo body line"
git tag light
git tag -m "A msg" tag-one-line
git tag -m "A msg" 100
git tag -m "" tag-zero-lines
printf 'tag line one\\ntag line two\\ntag line three\\n' >annotagmsg
git tag -F annotagmsg tag-lines
blob=$(printf 'Blob paragraph 1.\\n\\nBlob paragraph 2.\\n' | git hash-object -w --stdin)
git tag tag-blob $blob
git tag tag-tree HEAD^{tree}
git tag -s -m "A signed tag message" stag-one-line
git tag -s -m "" stag-zero-lines
printf 'stag line one\\nstag line two\\nstag line three\\n' >sigtagmsg
git tag -s -F sigtagmsg stag-lines
git tag -m "of a tag" tag-of-tag tag-lines
git tag a-very-long-tag-name-over-fifteen
`,
    );
    const cases: Case[] = [{ args: ["-l"] }];
    for (const n of ["-n0", "-n1", "-n", "-n2", "-n3", "-n4", "-n99", "-n999"]) {
      cases.push({ args: [n, "-l"] }, { args: [n] });
    }
    for (const name of [
      "tag-one-line",
      "tag-zero-lines",
      "tag-lines",
      "stag-one-line",
      "stag-zero-lines",
      "stag-lines",
      "tag-blob",
      "light",
    ]) {
      for (const n of ["-n0", "-n1", "-n2", "-n999"]) cases.push({ args: [n, "-l", name] });
    }
    // The -n 100 invocation means -n --list 100, not -n100
    cases.push({ args: ["-n", "100"] }, { args: ["-n", "-l", "--sort=-refname", "tag-*"] });
    for (const c of cases) await twin(dir, c);
  });

  it("t7004: --format, --omit-empty, %(ahead-behind), colors", { timeout: 300_000 }, async () => {
    const dir = repo(
      "t7004-format",
      `git init -q -b main .
>foo && git add foo && test_tick && git commit -q -m Foo
git tag v1.0
git tag -m "annotated v1.0.1" v1.0.1
test_tick && git commit -q --allow-empty -m left
git tag -a -m left tag-left
git reset -q --hard HEAD~1
test_tick && git commit -q --allow-empty -m right
git tag -a -m right tag-right
blob=$(echo blob | git hash-object -w --stdin)
git tag tag-blob $blob`,
    );
    const cases: Case[] = [
      { args: ["-l", "--format=refname : %(refname)", "v1*"] },
      {
        args: [
          "-l",
          "--format=%(if:notequals=refs/tags/v1.0.1)%(refname)%(then)refname : %(refname)%(end)",
          "v1*",
        ],
      },
      {
        args: [
          "-l",
          "--omit-empty",
          "--format=%(if:notequals=refs/tags/v1.0.1)%(refname)%(then)refname : %(refname)%(end)",
          "v1*",
        ],
      },
      { args: ["-l", "--format=%(rest)", "v1*"] },
      { args: ["-l", "--format=%(refname"] },
      { args: ["-l", "--format=%(refname) %(ahead-behind:HEAD) !"], since: [2, 41] },
      {
        args: ["-l", "--format=%(refname) %(ahead-behind:HEAD)", "--sort=ahead-behind:HEAD"],
        since: [2, 41],
      },
      {
        args: [
          "-l",
          "--format=%(objecttype) %(*objecttype) %(objectname:short) %(subject) %(taggername)",
        ],
      },
      { args: ["--format=%(color:green)%(refname:short)%(color:reset)"] },
      { args: ["--color", "--format=%(color:green)%(refname:short)%(color:reset)"] },
      {
        args: ["--format=%(color:green)%(refname:short)%(color:reset)"],
        before: "git config color.ui always",
        after: "git config --unset color.ui",
      },
      {
        args: ["--no-color", "--format=%(color:green)%(refname:short)%(color:reset)"],
        before: "git config color.ui always",
        after: "git config --unset color.ui",
      },
    ];
    for (const c of cases) await twin(dir, c);
  });

  it("t7004: --sort, tag.sort, --no-sort, versionsort.suffix", { timeout: 300_000 }, async () => {
    const dir = repo(
      "t7004-version",
      `git init -q -b main .
>foo && git add foo && test_tick && git commit -q -m Foo
for t in foo1.3 foo1.6 foo1.10 foo1.6-rc1 foo1.6-rc2 foo1.7-before1 foo1.7 foo1.7-after1 \\
  foo1.8-foo-bar foo1.8-foo-baz foo1.8 foo1.9-pre1 foo1.9-pre2 foo1.9-prerelease1 \\
  foo1.10-alpha foo1.10-beta foo1.10-gamma foo1.10-delta foo1.10-unlisted-suffix; do
  git tag $t
done
git tag -a -m "sample 1.0" vsample-1.0
git tag -a -m "sample 2.0" vsample-2.0
git tag -a -m "sample 10.0" vsample-10.0`,
    );
    const unset = (key: string) => `git config --unset-all ${key}`;
    const cases: Case[] = [
      { args: ["-l", "--sort=refname", "foo*"] },
      { args: ["-l", "--sort=version:refname", "foo*"] },
      { args: ["-l", "--sort=-version:refname", "foo*"] },
      { args: ["-l", "--sort=-refname", "foo*"] },
      { args: ["-l", "--sort=v:refname", "--sort=-refname", "foo1.1*"] },
      // configured lexical sort, and an option overriding it
      { before: "git config tag.sort v:refname", args: ["-l", "foo*"] },
      { args: ["-l", "--sort=-refname", "foo*"] },
      // --no-sort cancels config sort keys
      { args: ["-l", "--no-sort", "--sort=-refname", "foo1.1*"], after: unset("tag.sort") },
      // --no-sort cancels command line sort keys
      { args: ["-l", "--sort=-version:refname", "--no-sort", "--sort=refname", "foo1.1*"] },
      { args: ["-l", "--no-sort", "foo*"] },
      // invalid sort parameters
      { args: ["-l", "--sort=notvalid", "foo*"] },
      { before: "git config tag.sort v:notvalid", args: ["-l", "foo*"], after: unset("tag.sort") },
      // prerelease reordering
      {
        before: "git config versionsort.suffix -rc",
        args: ["-l", "--sort=version:refname", "foo*"],
      },
      { args: ["-l", "--sort=-version:refname", "foo*"], after: unset("versionsort.suffix") },
      {
        before: "git config versionsort.suffix -before",
        args: ["-l", "--sort=version:refname", "foo1.7*"],
      },
      {
        before: "git config --add versionsort.suffix -after",
        args: ["-l", "--sort=version:refname", "foo1.7*"],
        after: unset("versionsort.suffix"),
      },
      {
        before:
          "git config versionsort.suffix -bar && git config --add versionsort.suffix -foo-baz",
        args: ["-l", "--sort=version:refname", "foo1.8*"],
        after: unset("versionsort.suffix"),
      },
      {
        before:
          "git config versionsort.suffix -pre && git config --add versionsort.suffix -prerelease",
        args: ["-l", "--sort=version:refname", "foo1.9*"],
        after: unset("versionsort.suffix"),
      },
      {
        before:
          "for s in -alpha -beta '' -gamma -delta; do git config --add versionsort.suffix \"$s\"; done",
        args: ["-l", "--sort=version:refname", "foo1.10*"],
        after: unset("versionsort.suffix"),
      },
      {
        before:
          "git config versionsort.prereleaseSuffix -before && git config versionsort.suffix -after",
        args: ["-l", "--sort=version:refname", "foo1.7*"],
        after: `${unset("versionsort.suffix")} && ${unset("versionsort.prereleaseSuffix")}`,
      },
      {
        before: "git config versionsort.prereleaseSuffix -rc",
        args: ["-l", "--sort=version:refname", "foo1.6*"],
        after: unset("versionsort.prereleaseSuffix"),
      },
      // version sort handles empty value for versionsort.{prereleaseSuffix,suffix}
      {
        before:
          "cp .git/config .git/config.orig && printf '[versionsort]\\n\\tprereleaseSuffix\\n\\tsuffix\\n' >>.git/config",
        args: ["-l", "--sort=version:refname", "foo1.6*"],
        after: "mv .git/config.orig .git/config",
      },
      // annotated tag version sort
      { args: ["--list", "--sort=version:tag", "vsample-*"] },
      { args: ["--list", "--sort=-v:tag", "vsample-*"] },
      { args: ["--list", "--sort=taggerdate", "--sort=objecttype"] },
    ];
    for (const c of cases) await twin(dir, c);
  });

  it("t7004: --contains, --no-contains, --points-at, --merged, --no-merged", {
    timeout: 300_000,
  }, async () => {
    const dir = repo(
      "t7004-contains",
      `git init -q -b main .
echo foo >foo && git add foo && test_tick && git commit -q -m first
for t in v0.2.1 v1.0 v1.0.1 v1.1.3; do git tag $t; done
echo foo-2.0 >foo && git add foo && test_tick && git commit -q -m second
git tag v2.0
echo foo-dev >foo && git add foo && test_tick && git commit -q -m third
git branch stable v2.0
git checkout -q stable
echo foo-3.0 >foo && test_tick && git commit -q foo -m fourth
git tag v3.0
test_tick && git merge -q --strategy=ours main -m merge
git tag v4.0
git tag -m "v4.0, annotated" annotated-v4.0 v4.0
git tag -m "describing the v4.0 tag object" annotated-again-v4.0 annotated-v4.0
git tag mergetest-1 HEAD~2
git tag mergetest-2 HEAD~1
git tag mergetest-3 HEAD
git tag ambiguous
git branch ambiguous
blob=$(echo blob | git hash-object -w --stdin)
git tag tag-blob $blob
git tag tag-tree HEAD^{tree}`,
    );
    const hash = (rev: string) => run(dir, ["rev-parse", rev]).stdout.toString().trim();
    const hash1 = hash("v1.0");
    const hash2 = hash("v2.0");
    const hash3 = hash("main");
    const hash4 = hash("v3.0");
    const cases: Case[] = [];
    for (const commit of [hash1, "v1.0", "HEAD~3", hash2, hash3, hash4, "main"]) {
      cases.push(
        { args: ["-l", `--contains=${commit}`, "v*"] },
        { args: ["-l", `--no-contains=${commit}`, "v*"] },
      );
    }
    cases.push(
      // --contains can be used in non-list mode
      { args: [`--contains=${hash1}`, "v*"] },
      { args: ["--contains"] },
      { args: ["--no-contains"] },
      { args: ["-n", "--contains=HEAD", "HEAD"] },
      { args: ["--contains=HEAD", "HEAD"] },
      { args: ["--points-at=v4.0", "v*"] },
      { args: ["--points-at"] },
      { args: ["--points-at=v4.0"] },
      { args: ["-l", "--points-at=v4.0", "annotated*"] },
      { args: ["--points-at=annotated-v4.0"] },
      { args: ["--points-at=v2.0", "--points-at=v3.0"] },
      { args: ["--points-at=nonexistent"] },
      { args: ["--merged=mergetest-2", "mergetest*"] },
      { args: ["--merged=HEAD", "--no-merged=HEAD"] },
      { args: ["-l", "--merged=mergetest-2", "mergetest-*"] },
      { args: ["-l", "--no-merged=mergetest-2", "mergetest-*"] },
      { args: ["--no-merged=mergetest-2", "mergetest-*"] },
      { args: ["--merged"] },
      { args: ["--no-merged=v2.0"] },
      { args: ["-l", "ambiguous"] },
      // refusals: --contains of a tree or blob, names that are no objects
      { args: ["--contains=tag-tree"] },
      { args: ["--contains=tag-blob"] },
      { args: ["--no-contains=tag-tree"] },
      { args: ["--no-contains=tag-blob"] },
      { args: ["--contains=nonexistent"] },
      { args: ["--merged=tag-tree"] },
      { args: ["--merged=nonexistent"] },
      { args: ["--contains=v1.0", "--format=%(refname:short) %(objecttype)"] },
      { args: ["-n2", "--contains=v2.0"] },
    );
    for (const c of cases) await twin(dir, c);
  });

  it("t7004: --contains combined with --no-contains, stopping at commits", {
    timeout: 120_000,
  }, async () => {
    const dir = repo(
      "t7004-no-contains",
      `git init -q -b main .
for v in v0.1 v0.2 v0.3 v0.4 v0.5; do test_commit $v; done`,
    );
    await twin(dir, { args: ["--contains=v0.2", "--no-contains=v0.5"] });
    for (const c of [
      { args: ["--contains=v0.3"] },
      { args: ["--no-contains=v0.3"] },
      { args: ["--contains=v0.2", "--contains=v0.4", "-n"] },
    ]) {
      await twin(dir, {
        ...c,
        before:
          "git tag -f tag-blob $(git rev-parse v0.3:v0.3.t) >/dev/null && git tag -f tag-tree $(git rev-parse v0.3^{tree}) >/dev/null",
      });
    }
  });

  it("JGit TagCommandTest: testListTagsContainingCommit", { timeout: 120_000 }, async () => {
    //      c3
    //      |
    // v2 - c2   b2 - v1
    //      |    |
    //      c1   b1
    //       \   /
    //         a
    const dir = repo(
      "jgit-contains",
      `git init -q -b main .
test_tick && git commit -q --allow-empty -m a && git branch a
test_tick && git commit -q --allow-empty -m b1 && git branch b1
test_tick && git commit -q --allow-empty -m b2 && git branch b2
git tag -m v1 v1 b2
git checkout -q -b c a
test_tick && git commit -q --allow-empty -m c1 && git branch c1
test_tick && git commit -q --allow-empty -m c2 && git branch c2
git tag v2 c2
test_tick && git commit -q --allow-empty -m c3 && git branch c3`,
    );
    const expected: Record<string, string[]> = {
      a: ["refs/tags/v1", "refs/tags/v2"],
      b1: ["refs/tags/v1"],
      b2: ["refs/tags/v1"],
      c1: ["refs/tags/v2"],
      c2: ["refs/tags/v2"],
      c3: [],
    };
    for (const [commit, tags] of Object.entries(expected)) {
      await twin(dir, { args: [`--contains=${commit}`] });
      await twin(dir, { args: [`--no-contains=${commit}`] });
      // JGit's API: `tagList().setContains(commit).call()` gives the refs
      const git = await openOurs(dir);
      const refs = await git.tagList().setContains(commit).call();
      expect(
        refs.map((r) => r.name),
        commit,
      ).toEqual(tags);
    }
  });
});
