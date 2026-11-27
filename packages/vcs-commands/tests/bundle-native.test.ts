/**
 * `git bundle create`, `verify`, `list-heads` and `unbundle` against native git, over
 * t6020-bundle-misc.sh's history (and t5607-clone-bundle.sh's cases of the commands). Each
 * case runs the same arguments through native git and through ours and compares what they
 * print, their exit status, the bundle header (byte for byte) and the pack's object count;
 * bundles cross over: native git verifies, unbundles and clones ours, ours reads native git's.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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

import { Git, GitApiError } from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const compatibility: "2.43" | "2.56" = nativeIs25x ? "2.56" : "2.43";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;

const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...nativeGitEnv(root),
  TZ: "UTC",
  ...extra,
});

function run(cwd: string, args: string[], input?: string | Uint8Array) {
  const r = spawnSync("git", args, { cwd, env: env(), ...(input !== undefined ? { input } : {}) });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout as Buffer).toString("utf8"),
    stderr: (r.stderr as Buffer).toString("utf8"),
  };
}

function gitOk(cwd: string, args: string[]): string {
  const r = run(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** Runs a setup script (bash, with t/test-lib.sh's test_tick) in `dir`. */
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
  test_tick && echo "$1" >"$1.t" && git add "$1.t" && git commit -q -m "$1" && git tag "$1"
}
`;
  const r = spawnSync("bash", ["-c", prelude + script], { cwd: dir, env: env() });
  if (r.status !== 0) throw new Error(`setup failed: ${r.stderr.toString()}`);
}

async function openOurs(dir: string, bare = false): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const environment = createNodeGitHostEnvironment({ env: env() });
  const gitDir = bare ? "." : ".git";
  const { history } = await createGitFilesBackend({ files, gitDir, environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir, history, environment });
  return bare
    ? Git.fromWorktreeAdmin(await worktrees.openAdmin())
    : Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** t6020's history: main, topic/1, topic/2, release, refs/pull/*, tags v1..v3. */
const T6020_SETUP = `
c() { test_tick; echo "$1" >"$2"; git add "$2"; git commit -q -m "$1"; }
m() { test_tick; git merge -q --no-edit --no-ff -m "$2" "$1"; }
t() { test_tick; git tag -m "$1" "$1"; }
git init -q -b main
git config core.abbrev 7
c "Commit A" main.txt; c "Commit B" main.txt
git checkout -q -b topic/1; c "Commit C" topic-1.txt; c "Commit D" topic-1.txt
git update-ref refs/pull/1/head HEAD
git checkout -q main; c "Commit E" main.txt; t v1
git checkout -q -b topic/2; c "Commit F" topic-2.txt; c "Commit G" topic-2.txt
git update-ref refs/pull/2/head HEAD; c "Commit H" topic-2.txt
git checkout -q main; m topic/1 "Merge commit I"; m refs/pull/2/head "Merge commit J"
c "Commit K" main.txt
git checkout -q -b release; c "Commit L" release.txt; c "Commit M" release.txt; t v2
c "Commit N" release.txt; t v3
git checkout -q main; m tags/v2 "Merge commit O"; c "Commit P" main.txt
`;

/** The header of a bundle: everything up to and including its empty line. */
function headerOf(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString("latin1");
  const end = text.indexOf("\n\n");
  return end < 0 ? text : text.slice(0, end + 2);
}

/** The object count a bundle's pack header gives. */
function packCount(bytes: Uint8Array): number {
  const at = headerOf(bytes).length;
  const view = Buffer.from(bytes.subarray(at));
  if (view.length < 12 || view.subarray(0, 4).toString("latin1") !== "PACK") return -1;
  return view.readUInt32BE(8);
}

let repo: string;
let ours: Git;

/** Native git's bundle for `args` (`git bundle create [options] <file> <args>`). */
function nativeCreate(args: string[], options: string[] = [], stdin?: string) {
  const file = join(root, `native-${Math.random().toString(36).slice(2)}.bdl`);
  const r = run(repo, ["bundle", "create", ...options, file, ...args], stdin);
  const bytes = existsSync(file) ? new Uint8Array(readFileSync(file)) : undefined;
  return { ...r, bytes, file };
}

/** Ours for the same arguments: what it printed, its status and the bundle (written to a file). */
async function ourCreate(args: string[], version?: number, stdin?: string) {
  const command = (await openOurs(repo)).bundleCreate().setCompatibility(compatibility);
  if (version !== undefined) command.setVersion(version);
  for (const arg of args) command.addArgument(arg);
  if (stdin !== undefined) command.setStdin(stdin);
  try {
    const result = await command.call();
    let file: string | undefined;
    if (result.bundle) {
      file = join(root, `ours-${Math.random().toString(36).slice(2)}.bdl`);
      writeFileSync(file, result.bundle);
    }
    return { status: result.exitCode, stderr: result.stderr, bytes: result.bundle, file };
  } catch (error) {
    if (!(error instanceof GitApiError)) throw error;
    return {
      status: error.exitCode,
      stderr: `${error.message}\n`,
      bytes: undefined,
      file: undefined,
    };
  }
}

async function expectSameCreate(
  args: string[],
  options: { version?: number; stdin?: string } = {},
) {
  const native = nativeCreate(
    args,
    options.version !== undefined ? [`--version=${options.version}`] : [],
    options.stdin,
  );
  const mine = await ourCreate(args, options.version, options.stdin);
  expect({ status: mine.status, stderr: mine.stderr }).toEqual({
    status: native.status,
    stderr: native.stderr,
  });
  expect(mine.bytes === undefined).toBe(native.bytes === undefined);
  if (native.bytes && mine.bytes) {
    expect(headerOf(mine.bytes)).toBe(headerOf(native.bytes));
    expect(packCount(mine.bytes)).toBe(packCount(native.bytes));
    // native git reads ours: verify in the source repository, unbundle into a copy
    const verified = run(repo, ["bundle", "verify", mine.file as string]);
    expect(verified.stderr).toBe(`${mine.file} is okay\n`);
    expect(verified.stdout).toBe(run(repo, ["bundle", "verify", native.file]).stdout);
  }
  return { native, mine };
}

describeGit("git bundle (t6020-bundle-misc, t5607-clone-bundle)", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "bundle-native-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    sh(repo, T6020_SETUP);
    ours = await openOurs(repo);
  });
  afterAll(async () => {
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  it('t6020-bundle-misc.sh: "create bundle from special rev: main^!"', async () => {
    await expectSameCreate(["main^!"]);
  });

  it('t6020-bundle-misc.sh: "create bundle with --max-count option"', async () => {
    await expectSameCreate([
      "--max-count",
      "1",
      "main",
      "^release",
      "refs/tags/v1",
      "refs/pull/1/head",
      "refs/pull/2/head",
    ]);
  });

  it('t6020-bundle-misc.sh: "create bundle with --since option"', async () => {
    await expectSameCreate(["--since", "Thu Apr 7 15:27:00 2005 -0700", "--all"]);
  });

  it('t6020-bundle-misc.sh: "create bundle 1 - no prerequisites"', async () => {
    await expectSameCreate(["topic/1", "topic/2"]);
    await expectSameCreate(["--stdin"], { stdin: "topic/1\ntopic/2\n" });
  });

  it('t6020-bundle-misc.sh: "create bundle 2 - has prerequisites"', async () => {
    const d = gitOk(repo, ["rev-parse", "topic/1"]).trim();
    await expectSameCreate(["--ignore-missing", "^topic/deleted", `^${d}`, "^topic/2", "release"]);
    await expectSameCreate(["--ignore-missing", "--stdin", "release"], {
      stdin: `^topic/deleted\n^${d}\n^topic/2\n`,
    });
  });

  it('t6020-bundle-misc.sh: "create bundle 3 - two refs, same object"', async () => {
    await expectSameCreate(["^release", "^topic/1", "^topic/2", "main", "HEAD"], { version: 3 });
    await expectSameCreate(["--stdin", "main", "HEAD"], {
      version: 3,
      stdin: "^release\n^topic/1\n^topic/2\n",
    });
  });

  it('t6020-bundle-misc.sh: "create bundle 4 - with tags"', async () => {
    await expectSameCreate(["^main", "^release", "^topic/1", "^topic/2", "--all"]);
    await expectSameCreate(["--ignore-missing", "--stdin", "--all"], {
      stdin: "^main\n^release\n^topic/1\n^topic/2\n",
    });
  });

  it('t6020-bundle-misc.sh: "unfiltered bundle with --objects"', async () => {
    const all = await ourCreate(["--all"]);
    const objects = await ourCreate(["--all", "--objects"]);
    expect(headerOf(objects.bytes as Uint8Array)).toBe(headerOf(all.bytes as Uint8Array));
  });

  it('t6020-bundle-misc.sh: "full bundle upto annotated tag"', async () => {
    await expectSameCreate(["v2"]);
  });

  it('t6020-bundle-misc.sh: "incremental bundle between two annotated tags"', async () => {
    await expectSameCreate(["v1..v2"]);
  });

  it('t6020-bundle-misc.sh: "create bundle with duplicate refnames"', async () => {
    await expectSameCreate(["main", "main"]);
  });

  it('t6020-bundle-misc.sh: "create bundle with duplicate refnames and --all"', async () => {
    await expectSameCreate(["--all", "main", "main"]);
  });

  it('t6020-bundle-misc.sh: "create bundle with duplicate exlusion refnames"', async () => {
    await expectSameCreate(["main", "main^!"]);
  });

  it('t6020-bundle-misc.sh: "create bundle with duplicate refname short-form"', async () => {
    await expectSameCreate(["main", "main", "refs/heads/main", "refs/heads/main"]);
  });

  it("refuses what git refuses: empty bundles, bad revisions, options, versions", async () => {
    // t5607-clone-bundle.sh: "failed bundle creation does not leave cruft"
    await expectSameCreate(["main..main"]);
    await expectSameCreate(["main~1"]);
    await expectSameCreate(["nonexist"]);
    await expectSameCreate(["^nonexist", "main"]);
    await expectSameCreate(["--bogus", "main"]);
    await expectSameCreate(["main"], { version: 4 });
    await expectSameCreate(["main"], { version: 2 });
  });

  it("ranges, HEAD, symmetric differences", async () => {
    await expectSameCreate(["HEAD"]);
    await expectSameCreate(["main~1..main"]);
    await expectSameCreate(["topic/1...topic/2"]);
    await expectSameCreate(["--branches", "--not", "v1"]);
  });

  for (const filter of ["blob:none", "tree:0", "tree:1", "blob:limit=100"]) {
    it(`t6020-bundle-misc.sh: "filtered bundle: $filter" (${filter})`, async () => {
      const { native, mine } = await expectSameCreate(["--all", `--filter=${filter}`]);
      // unbundled by native git into an empty repository: a promisor pack with the objects
      // native git's own filtered bundle gives
      const listing = (file: string) => {
        const dir = mkdtempSync(join(root, "unbundled-"));
        gitOk(dir, ["init", "-q"]);
        const out = gitOk(dir, ["bundle", "unbundle", file]);
        const pack = join(dir, ".git/objects/pack");
        const promisor = readdirSync(pack).filter((f) => f.endsWith(".promisor"));
        const objects = gitOk(dir, [
          "cat-file",
          "--batch-all-objects",
          "--batch-check=%(objectname) %(objecttype)",
        ]);
        return { out, promisor: promisor.length, objects };
      };
      expect(listing(mine.file as string)).toEqual(listing(native.file));
    });
  }

  it('t6020-bundle-misc.sh: "fail to verify bundle without prerequisites"', async () => {
    const native = nativeCreate([
      "--ignore-missing",
      "^topic/deleted",
      "^topic/1",
      "^topic/2",
      "release",
    ]);
    const empty = join(root, "test1.git");
    gitOk(root, ["init", "-q", "--bare", empty]);
    const expected = run(empty, ["bundle", "verify", native.file]);
    const bundle = new Uint8Array(readFileSync(native.file));
    const result = await (await openOurs(empty, true))
      .bundleVerify()
      .setBundle(bundle, native.file)
      .call();
    expect({ status: result.exitCode, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: expected.status,
      stdout: expected.stdout,
      stderr: expected.stderr,
    });
    expect(expected.stderr).toContain("Repository lacks these prerequisite commits:");
    // unbundle refuses alike, and stores nothing
    const unbundled = await (await openOurs(empty, true))
      .bundleUnbundle()
      .setBundle(bundle, native.file)
      .call();
    const nativeUnbundle = run(empty, ["bundle", "unbundle", native.file]);
    expect({
      status: unbundled.exitCode,
      stdout: unbundled.stdout,
      stderr: unbundled.stderr,
    }).toEqual({
      status: nativeUnbundle.status,
      stdout: nativeUnbundle.stdout,
      stderr: nativeUnbundle.stderr,
    });
    // -q: no line per prerequisite
    const quiet = await (await openOurs(empty, true))
      .bundleVerify()
      .setBundle(bundle)
      .setQuiet(true)
      .call();
    const nativeQuiet = run(empty, ["bundle", "verify", "-q", native.file]);
    expect({ status: quiet.exitCode, stdout: quiet.stdout, stderr: quiet.stderr }).toEqual({
      status: nativeQuiet.status,
      stdout: nativeQuiet.stdout,
      stderr: nativeQuiet.stderr,
    });
  });

  it("verify and list-heads of native git's bundles print what native git prints", async () => {
    const cases: string[][] = [
      ["main^!"],
      ["--all"],
      ["--all", "--filter=blob:none"],
      ["^release", "^topic/1", "main", "HEAD"],
    ];
    for (const args of cases) {
      const native = nativeCreate(args);
      const bytes = new Uint8Array(readFileSync(native.file));
      const verify = await ours.bundleVerify().setBundle(bytes, native.file).call();
      const expected = run(repo, ["bundle", "verify", native.file]);
      expect({ status: verify.exitCode, stdout: verify.stdout, stderr: verify.stderr }).toEqual({
        status: expected.status,
        stdout: expected.stdout,
        stderr: expected.stderr,
      });
      const heads = await ours.bundleListHeads().setBundle(bytes, native.file).call();
      expect(heads.stdout).toBe(run(repo, ["bundle", "list-heads", native.file]).stdout);
      const some = await ours
        .bundleListHeads()
        .setBundle(bytes, native.file)
        .addRefName("refs/heads/main")
        .addRefName("HEAD")
        .call();
      expect(some.stdout).toBe(
        run(repo, ["bundle", "list-heads", native.file, "refs/heads/main", "HEAD"]).stdout,
      );
    }
  });

  it('t5607-clone-bundle.sh: "git bundle v3 rejects unknown capabilities", and bad headers', async () => {
    const cases: Record<string, string> = {
      unknown: "# v3 git bundle\n@unknown=silly\n\n",
      hash: "# v3 git bundle\n@object-format=sha42\n\n",
      v2cap: "# v2 git bundle\n@object-format=sha1\n\n",
      notABundle: "junk\n",
      shortId: "# v2 git bundle\n1234 refs/heads/main\n\n",
      noName: `# v2 git bundle\n${"a".repeat(40)}\n\n`,
      glued: `# v2 git bundle\n${"a".repeat(40)}x refs/heads/main\n\n`,
    };
    for (const [name, text] of Object.entries(cases)) {
      const file = join(root, `${name}.bdl`);
      writeFileSync(file, text);
      for (const sub of ["verify", "list-heads"]) {
        const expected = run(repo, ["bundle", sub, file]);
        const command = sub === "verify" ? ours.bundleVerify() : ours.bundleListHeads();
        const result = await command.setBundle(new TextEncoder().encode(text), file).call();
        expect({ status: result.exitCode, stdout: result.stdout, stderr: result.stderr }).toEqual({
          status: expected.status,
          stdout: expected.stdout,
          stderr: expected.stderr,
        });
      }
    }
  });

  it('t6020-bundle-misc.sh: "read bundle over stdin"', async () => {
    const native = nativeCreate(["HEAD"]);
    const bytes = new Uint8Array(readFileSync(native.file));
    const expected = run(repo, ["bundle", "verify", "-"], bytes);
    const result = await ours.bundleVerify().setBundle(bytes).call();
    expect(result.stderr).toBe(expected.stderr);
    expect(result.stderr).toContain("<stdin> is okay");
  });

  it("unbundle stores the pack and lists the refs (t6020, t5607)", async () => {
    for (const args of [["--all"], ["topic/1", "topic/2"], ["--all", "--filter=blob:none"]]) {
      const native = nativeCreate(args);
      const bytes = new Uint8Array(readFileSync(native.file));
      const a = mkdtempSync(join(root, "unb-native-"));
      const b = mkdtempSync(join(root, "unb-ours-"));
      gitOk(a, ["init", "-q"]);
      gitOk(b, ["init", "-q"]);
      const expected = run(a, ["bundle", "unbundle", native.file, "refs/heads/topic/2", "HEAD"]);
      const result = await (await openOurs(b))
        .bundleUnbundle()
        .setBundle(bytes, native.file)
        .addRefName("refs/heads/topic/2")
        .addRefName("HEAD")
        .call();
      expect({ status: result.exitCode, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: expected.status,
        stdout: expected.stdout,
        stderr: expected.stderr,
      });
      const objects = (dir: string) =>
        gitOk(dir, [
          "cat-file",
          "--batch-all-objects",
          "--batch-check=%(objectname) %(objecttype)",
        ]);
      expect(objects(b)).toBe(objects(a));
      const promisors = (dir: string) =>
        readdirSync(join(dir, ".git/objects/pack"))
          .filter((f) => f.endsWith(".promisor"))
          .map((f) => readFileSync(join(dir, ".git/objects/pack", f), "latin1"));
      expect(promisors(b)).toEqual(promisors(a));
      expect(run(b, ["fsck", "--connectivity-only", "--no-dangling"]).status).toBe(0);
    }
  });

  it('t6020-bundle-misc.sh: "verify catches unreachable, broken prerequisites"', async () => {
    const from = join(root, "clone-from");
    mkdirSync(from);
    sh(
      from,
      `git init -q -b main && git checkout -q -b base && test_commit A &&
       git checkout -q -b tip &&
       test_tick && git commit -q --allow-empty -m "will drop by shallow" &&
       test_tick && git commit -q --allow-empty -m "will keep by shallow" &&
       test_tick && git commit -q --allow-empty -m "for bundle, not clone" &&
       git bundle create tip.bundle tip~1..tip &&
       git reset -q --hard HEAD~1 && git checkout -q base`,
    );
    const to = join(root, "clone-to");
    gitOk(root, ["clone", "-q", "--depth=1", "--no-single-branch", `file://${from}`, to]);
    gitOk(to, ["update-ref", "-d", "refs/remotes/origin/tip"]);
    rmSync(join(to, ".git/shallow"));
    const file = join(from, "tip.bundle");
    const bytes = new Uint8Array(readFileSync(file));
    const expected = run(to, ["bundle", "verify", file]);
    const result = await (await openOurs(to)).bundleVerify().setBundle(bytes, file).call();
    expect({ status: result.exitCode, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: expected.status,
      stdout: expected.stdout,
      stderr: expected.stderr,
    });
    expect(expected.stderr).toMatch(/some prerequisite commits .* are not connected/);
    const unbundled = await (await openOurs(to)).bundleUnbundle().setBundle(bytes, file).call();
    const nativeUnbundle = run(to, ["bundle", "unbundle", file]);
    expect({ status: unbundled.exitCode, stderr: unbundled.stderr }).toEqual({
      status: nativeUnbundle.status,
      stderr: nativeUnbundle.stderr,
    });
  });

  it('t5607-clone-bundle.sh: "ridiculously long subject in boundary", "prerequisites with an empty commit message"', async () => {
    const dir = join(root, "subjects");
    mkdirSync(dir);
    sh(
      dir,
      `git init -q -b main && test_commit initial && test_tick &&
       printf "%01200d\\n" 0 | git commit -q --allow-empty -F - &&
       test_tick && git commit -q --allow-empty -m "tip" &&
       test_tick && git commit -q --allow-empty --allow-empty-message -m "" &&
       test_tick && git commit -q --allow-empty -m "after empty"`,
    );
    const prev = repo;
    repo = dir;
    try {
      await expectSameCreate(["HEAD~2..HEAD~1"]);
      await expectSameCreate(["HEAD^.."]);
    } finally {
      repo = prev;
    }
  });

  it("JGit BundleWriterTest: single ref, several refs, incremental with a prerequisite", async () => {
    // testWriteSingleRef, testWriteMultipleRefs, testIncrementalBundle: a bundle of
    // refs/heads/topic/1, one of several branches, then one on top of a commit the target
    // must have; fetched by native git into empty and prepared repositories
    for (const args of [["topic/1"], ["topic/1", "topic/2", "release"], ["release", "^v1"]]) {
      const mine = await ourCreate(args);
      const dir = mkdtempSync(join(root, "jgit-"));
      gitOk(dir, ["init", "-q"]);
      if (args.includes("^v1")) {
        const missing = run(dir, ["fetch", "-q", mine.file as string, "refs/heads/*:refs/heads/*"]);
        expect(missing.status).not.toBe(0);
        expect(missing.stderr).toContain("Repository lacks these prerequisite commits:");
        gitOk(dir, ["fetch", "-q", repo, "refs/tags/v1:refs/tags/v1"]);
      }
      gitOk(dir, ["fetch", "-q", mine.file as string, "refs/heads/*:refs/heads/*"]);
      expect(gitOk(dir, ["for-each-ref", "refs/heads"])).toBe(
        gitOk(repo, [
          "for-each-ref",
          ...args.filter((a) => !a.startsWith("^")).map((a) => `refs/heads/${a}`),
        ]),
      );
      expect(run(dir, ["fsck", "--strict", "--no-dangling"]).status).toBe(0);
    }
  });

  it("SHA-256 repositories write v3 bundles git reads, and read git's", async () => {
    const dir = join(root, "sha256");
    mkdirSync(dir);
    sh(dir, "git init -q -b main --object-format=sha256 && test_commit one && test_commit two");
    const prev = repo;
    repo = dir;
    try {
      await expectSameCreate(["main"]);
      await expectSameCreate(["main~1..main"]);
      await expectSameCreate(["main"], { version: 2 });
      const native = nativeCreate(["--all"]);
      const bytes = new Uint8Array(readFileSync(native.file));
      const heads = await (await openOurs(dir))
        .bundleListHeads()
        .setBundle(bytes, native.file)
        .call();
      expect(heads.stdout).toBe(run(dir, ["bundle", "list-heads", native.file]).stdout);
      const verify = await (await openOurs(dir))
        .bundleVerify()
        .setBundle(bytes, native.file)
        .call();
      expect(verify.stdout).toBe(run(dir, ["bundle", "verify", native.file]).stdout);
      const target = join(root, "sha256-target");
      cpSync(dir, target, { recursive: true });
      const unbundled = await (await openOurs(target)).bundleUnbundle().setBundle(bytes).call();
      expect(unbundled.stdout).toBe(run(dir, ["bundle", "list-heads", native.file]).stdout);
    } finally {
      repo = prev;
    }
  });
});
