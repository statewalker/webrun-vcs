/**
 * Bundles as remotes (transport.c's bundle transport): `git clone`, `git fetch` and
 * `git ls-remote` of a bundle file, against native git (t6020-bundle-misc.sh's clones and
 * fetches, t5607-clone-bundle.sh). Each case runs native git in one repository and ours in a
 * twin, from the same bundle, and compares the refs, the objects, what was printed and the
 * exit status.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import { FetchCheckError } from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fetchOutputText, Git, GitApiError } from "../src/index.js";
import { compatibility, ourClone, ourCloneFails } from "./clone-options-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let home: string;
let repo: string;

function run(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, env: testEnv(home, { TZ: "UTC" }) });
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

function sh(dir: string, script: string): void {
  const prelude = `
set -e
export GIT_AUTHOR_NAME="A U Thor" GIT_AUTHOR_EMAIL=author@example.com
export GIT_COMMITTER_NAME="C O Mitter" GIT_COMMITTER_EMAIL=committer@example.com
test_tick () {
  if test -z "\${test_tick+set}"; then test_tick=1112911993; else test_tick=$((test_tick + 60)); fi
  export GIT_COMMITTER_DATE="$test_tick -0700" GIT_AUTHOR_DATE="$test_tick -0700"
}
c() { test_tick; echo "$1" >"$2"; git add "$2"; git commit -q -m "$1"; }
m() { test_tick; git merge -q --no-edit --no-ff -m "$2" "$1"; }
t() { test_tick; git tag -m "$1" "$1"; }
`;
  const r = spawnSync("bash", ["-c", prelude + script], { cwd: dir, env: testEnv(home) });
  if (r.status !== 0) throw new Error(`setup failed: ${r.stderr.toString()}`);
}

/** Ours over the bare repository at `dir` (below home). */
async function openBare(dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: home });
  const environment = createNodeGitHostEnvironment({ env: testEnv(home) });
  const gitDir = dir.slice(home.length + 1);
  const { history } = await createGitFilesBackend({ files, gitDir, environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir, history, environment });
  return Git.fromWorktreeAdmin(await worktrees.openAdmin());
}

/** Ours over the repository with a worktree at `dir` (below home). */
function openWorktree(dir: string): Promise<Git> {
  const environment = createNodeGitHostEnvironment({ env: testEnv(home) });
  return openOurs(home, environment, undefined, dir.slice(home.length + 1));
}

function bundle(name: string, args: string[], options: string[] = []): string {
  const file = join(home, name);
  gitOk(repo, ["bundle", "create", ...options, file, ...args]);
  return file;
}

const showRef = (dir: string) => run(dir, ["show-ref"]).stdout;
/** The pack directory's files by kind (`pack`, `idx`, `promisor`, ...) and the loose objects. */
function storage(gitDir: string) {
  const packDir = join(gitDir, "objects", "pack");
  const kinds = readdirSync(packDir)
    .map((name) => name.slice(name.lastIndexOf(".") + 1))
    .sort();
  const promisors = readdirSync(packDir)
    .filter((name) => name.endsWith(".promisor"))
    .map((name) => readFileSync(join(packDir, name), "utf8"))
    .sort();
  const loose = readdirSync(join(gitDir, "objects")).filter((d) => /^[0-9a-f]{2}$/.test(d));
  return { kinds, promisors, loose: loose.length };
}

const objects = (dir: string) =>
  gitOk(dir, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"]);

/** Our fetch's printout (git's stderr) and status, or its death. */
async function ourFetch(
  git: Git,
  remote: string,
  refspecs: string[],
  quiet = false,
  bytes?: Uint8Array,
) {
  try {
    const command = git.fetch().setRemote(remote).setCompatibility(compatibility);
    if (bytes) command.addBundle(remote, bytes);
    if (refspecs.length > 0) command.setRefSpecs(...refspecs);
    const result = await command.call();
    return { status: 0, stderr: fetchOutputText(result, quiet) };
  } catch (error) {
    if (error instanceof FetchCheckError) {
      return { status: error.exitCode ?? 1, stderr: `${error.lines.join("\n")}\n` };
    }
    if (!(error instanceof GitApiError)) throw error;
    return { status: error.exitCode, stderr: `${error.message}\n` };
  }
}

describeGit("bundles as remotes (t6020-bundle-misc, t5607-clone-bundle)", () => {
  let b1: string;
  let b2: string;
  let b3: string;
  let b4: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "bundle-transport-"));
    repo = join(home, "repo");
    mkdirSync(repo);
    sh(
      repo,
      `git init -q -b main
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
git checkout -q main; m tags/v2 "Merge commit O"; c "Commit P" main.txt`,
    );
    b1 = bundle("1.bdl", ["topic/1", "topic/2"]);
    b2 = bundle("2.bdl", ["^topic/1", "^topic/2", "release"]);
    b3 = bundle("3.bdl", ["^release", "^topic/1", "^topic/2", "main", "HEAD"], ["--version=3"]);
    b4 = bundle("4.bdl", ["^main", "^release", "^topic/1", "^topic/2", "--all"]);
  });
  afterAll(async () => {
    await removeTempDir(home);
  }, CLEANUP_TIMEOUT);

  it('t6020-bundle-misc.sh: "clone from bundle"', async () => {
    const native = join(home, "mirror-native.git");
    gitOk(home, ["clone", "-q", "--mirror", b1, native]);
    const mine = join(home, "mirror-ours.git");
    await ourClone(home, mine, (c) => c.setURI(b1).setMirror(true), { bare: true });
    expect(showRef(mine)).toBe(showRef(native));
    expect(run(mine, ["config", "remote.origin.url"]).stdout).toBe(`${b1}\n`);
    for (const file of [b2, b3, b4]) {
      const expected = run(native, ["fetch", file, "+refs/*:refs/*"]);
      const result = await ourFetch(await openBare(mine), file, ["+refs/*:refs/*"]);
      expect(result).toEqual({ status: expected.status, stderr: expected.stderr });
      expect(showRef(mine)).toBe(showRef(native));
      expect(objects(mine)).toBe(objects(native));
    }
    expect(run(mine, ["fsck", "--strict", "--no-dangling"]).status).toBe(0);
  });

  it('t6020-bundle-misc.sh: "clone from full bundle upto annotated tag"', async () => {
    const v2 = bundle("v2.bdl", ["v2"]);
    const native = join(home, "tag-native.git");
    gitOk(home, ["clone", "-q", "--mirror", v2, native]);
    const mine = join(home, "tag-ours.git");
    await ourClone(home, mine, (c) => c.setURI(v2).setMirror(true), { bare: true });
    expect(showRef(mine)).toBe(showRef(native));
  });

  it('t6020-bundle-misc.sh: "cloning from filtered bundle has useful error"', async () => {
    const partial = bundle("partial.bdl", ["--all", "--filter=blob:none"]);
    const expected = run(home, ["clone", "--bare", partial, join(home, "partial-native")]);
    expect(expected.stderr).toContain("cannot clone from filtered bundle");
    const failed = await ourCloneFails(
      home,
      join(home, "partial-ours"),
      (c) => c.setURI(partial).setBare(true),
      { bare: true },
    );
    expect(failed).toEqual({ message: "fatal: cannot clone from filtered bundle", exitCode: 128 });
  });

  it("a clone of a bundle with HEAD checks its branch out; one without HEAD warns (t5607)", async () => {
    const all = bundle("all.bdl", ["--all"]);
    for (const [name, file] of [
      ["all", all],
      ["heads", b1],
    ] as const) {
      const native = join(home, `clone-${name}-native`);
      const expected = run(home, ["clone", file, native]);
      const mine = join(home, `clone-${name}-ours`);
      const result = await ourClone(home, mine, (c) => c.setURI(file));
      expect(run(mine, ["for-each-ref"]).stdout).toBe(run(native, ["for-each-ref"]).stdout);
      // (ourClone's twin starts from `git init -b main`: an unborn HEAD keeps that name)
      expect(run(mine, ["rev-parse", "-q", "--verify", "HEAD"]).stdout).toBe(
        run(native, ["rev-parse", "-q", "--verify", "HEAD"]).stdout,
      );
      if (name === "all") {
        expect(run(mine, ["symbolic-ref", "HEAD"]).stdout).toBe(
          run(native, ["symbolic-ref", "HEAD"]).stdout,
        );
      }
      expect(run(mine, ["status", "--porcelain"]).stdout).toBe(
        run(native, ["status", "--porcelain"]).stdout,
      );
      const warned = expected.stderr.includes("remote HEAD refers to nonexistent ref");
      expect(
        (result.messages ?? []).some((m) => m.includes("remote HEAD refers to nonexistent ref")),
      ).toBe(warned);
    }
  });

  it("a fetch lacking the prerequisites fails as git's (exit 1), a clone dies (128)", async () => {
    const native = join(home, "lacking-native");
    const mine = join(home, "lacking-ours");
    gitOk(home, ["init", "-q", native]);
    gitOk(home, ["init", "-q", mine]);
    const expected = run(native, ["fetch", b2, "refs/*:refs/*"]);
    const result = await ourFetch(await openWorktree(mine), b2, ["refs/*:refs/*"]);
    expect(result).toEqual({ status: expected.status, stderr: expected.stderr });
    expect(expected.stderr).toContain("Repository lacks these prerequisite commits:");
    const clone = run(home, ["clone", b2, join(home, "lacking-clone-native")]);
    const failed = await ourCloneFails(home, join(home, "lacking-clone-ours"), (c) => c.setURI(b2));
    expect(failed.exitCode).toBe(clone.status);
    // (git's init advice, which our twin's harness runs apart, left out)
    const errors = (text: string) =>
      text
        .split("\n")
        .filter((l) => /^(error|fatal): /.test(l))
        .join("\n");
    expect(errors(failed.message)).toBe(errors(clone.stderr));
    expect(errors(failed.message)).toContain("fatal: remote transport reported error");
  });

  it("ls-remote lists a bundle's refs in git's order (t5607, t6020)", async () => {
    for (const file of [b1, b2, b3, b4]) {
      const expected = run(repo, ["ls-remote", file])
        .stdout.split("\n")
        .filter((l) => l && !l.endsWith("\tHEAD"));
      const result = await (await openWorktree(repo)).lsRemote().setRemote(file).call();
      expect(result.refs.map((r) => `${r.objectId}\t${r.name}`)).toEqual(expected);
    }
  });

  it('t5607-clone-bundle.sh: "fetch SHA-1 from bundle"', async () => {
    const tip = bundle("tip.bundle", ["-1", "main"]);
    const id = gitOk(repo, ["rev-parse", "main"]).trim();
    const native = join(home, "sha-native");
    const mine = join(home, "sha-ours");
    gitOk(repo, ["update-ref", "refs/test/base", "main~1"]);
    for (const dir of [native, mine]) {
      gitOk(home, ["init", "-q", dir]);
      gitOk(dir, ["fetch", "-q", "--no-tags", repo, "refs/test/base:refs/heads/base"]);
    }
    gitOk(repo, ["update-ref", "-d", "refs/test/base"]);
    const expected = run(native, ["fetch", "--no-tags", tip, id]);
    const result = await ourFetch(await openWorktree(mine), tip, [id]);
    expect(result.status).toBe(expected.status);
    expect(run(mine, ["cat-file", "-t", id]).stdout).toBe("commit\n");
    expect(run(mine, ["rev-parse", "FETCH_HEAD"]).stdout).toBe(
      run(native, ["rev-parse", "FETCH_HEAD"]).stdout,
    );
  });

  it('t5607-clone-bundle.sh: "empty bundle file is rejected"', async () => {
    const empty = join(home, "empty-bundle");
    writeFileSync(empty, "");
    const native = join(home, "empty-native");
    const mine = join(home, "empty-ours");
    gitOk(home, ["init", "-q", native]);
    gitOk(home, ["init", "-q", mine]);
    const expected = run(native, ["fetch", empty]);
    expect(expected.status).not.toBe(0);
    const result = await ourFetch(await openWorktree(mine), empty, []);
    expect(result.status).toBe(expected.status);
  });

  it("push to a bundle fails as git's", async () => {
    const copy = join(home, "push-target.bdl");
    copyFileSync(b1, copy);
    const expected = run(repo, ["push", copy, "main"]);
    let failure: GitApiError | undefined;
    try {
      await (await openWorktree(repo)).push().setRemote(copy).setRefSpecs("main").call();
    } catch (error) {
      if (!(error instanceof GitApiError)) throw error;
      failure = error;
    }
    expect(failure?.exitCode).toBe(expected.status);
    expect(`${failure?.message}\n`).toBe(expected.stderr);
    expect(existsSync(copy)).toBe(true);
  });

  it("a clone of a bundle whose HEAD no branch matches detaches HEAD there (update_head)", async () => {
    const ht = bundle("head-topic.bdl", ["HEAD", "topic/1"]);
    const native = join(home, "head-topic-native");
    gitOk(home, ["clone", "-q", ht, native]);
    const mine = join(home, "head-topic-ours");
    const result = await ourClone(home, mine, (c) => c.setURI(ht));
    expect(run(mine, ["rev-parse", "HEAD"]).stdout).toBe(run(native, ["rev-parse", "HEAD"]).stdout);
    expect(run(mine, ["symbolic-ref", "-q", "HEAD"]).status).toBe(
      run(native, ["symbolic-ref", "-q", "HEAD"]).status,
    );
    expect(run(mine, ["for-each-ref"]).stdout).toBe(run(native, ["for-each-ref"]).stdout);
    expect(run(mine, ["status", "--porcelain"]).stdout).toBe("");
    expect(existsSync(join(mine, "main.txt"))).toBe(existsSync(join(native, "main.txt")));
    expect((result.messages ?? []).join("")).not.toContain("nonexistent ref");
  });

  it("a symbolic link to a bundle is a bundle remote (git's is_file follows it)", async () => {
    const link = join(home, "link.bundle");
    symlinkSync(b1, link);
    const expected = run(repo, ["ls-remote", link])
      .stdout.split("\n")
      .filter((l) => l && !l.endsWith("\tHEAD"));
    const listed = await (await openWorktree(repo)).lsRemote().setRemote(link).call();
    expect(listed.refs.map((r) => `${r.objectId}\t${r.name}`)).toEqual(expected);
    // `git clone link` finds `link.bundle` (get_repo_path's suffix)
    const native = join(home, "link-native.git");
    gitOk(home, ["clone", "-q", "--mirror", join(home, "link"), native]);
    const mine = join(home, "link-ours.git");
    await ourClone(home, mine, (c) => c.setURI(join(home, "link")).setMirror(true), { bare: true });
    expect(showRef(mine)).toBe(showRef(native));
  });
  it("a fetch keeps the bundle's pack whatever its size (unbundle runs index-pack; our extension over t6020-bundle-misc.sh's history)", async () => {
    const all = bundle("all-main.bdl", ["main"]);
    // release's tip alone: its parent (v2) is in main's history, so three new objects, which
    // a fetch over the wire would unpack (below fetch.unpackLimit); a bundle's pack is kept
    const tip = bundle("tip-only.bdl", ["-1", "release"]);
    const native = join(home, "keep-native");
    const mine = join(home, "keep-ours");
    gitOk(home, ["init", "-q", native]);
    gitOk(home, ["init", "-q", mine]);
    for (const [file, spec] of [
      [all, "refs/heads/main:refs/heads/main"],
      [tip, "refs/heads/release:refs/heads/release"],
    ] as const) {
      const expected = run(native, ["fetch", file, spec]);
      const result = await ourFetch(await openWorktree(mine), file, [spec]);
      expect(result).toEqual({ status: expected.status, stderr: expected.stderr });
      expect(storage(join(mine, ".git"))).toEqual(storage(join(native, ".git")));
      expect(showRef(mine)).toBe(showRef(native));
      expect(objects(mine)).toBe(objects(native));
    }
    expect(storage(join(mine, ".git")).kinds.filter((k) => k === "pack")).toHaveLength(2);
  });

  it("fetching a filtered bundle writes a from-bundle promisor pack (our extension: t6020-bundle-misc.sh's history and filtered bundles, git's unbundle --promisor=from-bundle)", async () => {
    const filtered = bundle("filtered.bdl", ["--all", "--filter=blob:none"]);
    // without a promisor remote: the pack is kept as a promisor pack, the check fails
    const native = join(home, "filtered-native");
    const mine = join(home, "filtered-ours");
    gitOk(home, ["init", "-q", native]);
    gitOk(home, ["init", "-q", mine]);
    const expected = run(native, ["fetch", filtered, "refs/*:refs/*"]);
    expect(expected.status).toBe(1);
    const result = await ourFetch(await openWorktree(mine), filtered, ["refs/*:refs/*"]);
    expect(result.status).toBe(expected.status);
    const errors = (text: string) => text.split("\n").filter((l) => /^(error|fatal): /.test(l));
    expect(errors(result.stderr).map((l) => l.replace(/'[0-9a-f]{40}'/, "<id>"))).toEqual(
      errors(expected.stderr).map((l) => l.replace(/'[0-9a-f]{40}'/, "<id>")),
    );
    expect(storage(join(mine, ".git"))).toEqual(storage(join(native, ".git")));
    expect(showRef(mine)).toBe(showRef(native));
    // with a promisor remote (a partial clone): the fetch succeeds, the blobs promised
    const incremental = bundle("incremental-filtered.bdl", [
      "^main",
      "release",
      "--filter=blob:none",
    ]);
    const pn = join(home, "promisor-native");
    const po = join(home, "promisor-ours");
    for (const dir of [pn, po]) {
      gitOk(home, ["init", "-q", dir]);
      gitOk(dir, ["fetch", "-q", bundle("all-main.bdl", ["main"]), "main:main"]);
      gitOk(dir, ["config", "remote.origin.url", repo]);
      gitOk(dir, ["config", "remote.origin.promisor", "true"]);
      gitOk(dir, ["config", "remote.origin.partialclonefilter", "blob:none"]);
    }
    const ok = run(pn, ["fetch", incremental, "refs/heads/release:refs/heads/release"]);
    const ours = await ourFetch(await openWorktree(po), incremental, [
      "refs/heads/release:refs/heads/release",
    ]);
    expect(ours).toEqual({ status: ok.status, stderr: ok.stderr });
    expect(ok.status).toBe(0);
    expect(showRef(po)).toBe(showRef(pn));
    expect(objects(po)).toBe(objects(pn));
    // git 2.48+'s index-pack --promisor also packs the local objects the bundle's pack links
    // to into a promisor pack of their own (repack_local_links, an empty `.promisor`); ours
    // always does, 2.43 does not
    if (compatibility === "2.43") {
      const bundlePromisors = (dir: string) =>
        storage(join(dir, ".git")).promisors.filter((c) => c !== "");
      expect(bundlePromisors(po)).toEqual(bundlePromisors(pn));
    } else {
      expect(storage(join(po, ".git"))).toEqual(storage(join(pn, ".git")));
    }
    expect(storage(join(po, ".git")).promisors).toContain("from-bundle\n");
    expect(run(po, ["fsck", "--no-dangling"]).status).toBe(0);
  });

  it("a bundle given as bytes (addBundle) is fetched, cloned and listed as the file is (JGit TransportBundleStream as in BundleWriterTest; t6020-bundle-misc.sh's bundles)", async () => {
    const bytes = new Uint8Array(readFileSync(b1));
    const url = "memory/b1.bundle"; // nothing on disk names it
    const listed = await (await openWorktree(repo))
      .lsRemote()
      .addBundle(url, bytes)
      .setRemote(url)
      .call();
    expect(listed.refs.map((r) => `${r.objectId}\t${r.name}`)).toEqual(
      run(repo, ["ls-remote", b1])
        .stdout.split("\n")
        .filter((l) => l && !l.endsWith("\tHEAD")),
    );
    const native = join(home, "bytes-native.git");
    gitOk(home, ["clone", "-q", "--mirror", b1, native]);
    const mine = join(home, "bytes-ours.git");
    await ourClone(home, mine, (c) => c.setURI(url).addBundle(url, bytes).setMirror(true), {
      bare: true,
    });
    expect(showRef(mine)).toBe(showRef(native));
    expect(run(mine, ["config", "remote.origin.url"]).stdout).toBe(`${url}\n`);
    // later bundles as bytes too, prerequisites checked against the repository
    const b2Bytes = new Uint8Array(readFileSync(b2));
    const expected = run(native, ["fetch", b2, "+refs/*:refs/*"]);
    const result = await ourFetch(await openBare(mine), b2, ["+refs/*:refs/*"], false, b2Bytes);
    expect(result).toEqual({ status: expected.status, stderr: expected.stderr });
    expect(showRef(mine)).toBe(showRef(native));
    expect(objects(mine)).toBe(objects(native));
    const lacking = join(home, "bytes-lacking");
    const lackingNative = join(home, "bytes-lacking-native");
    gitOk(home, ["init", "-q", lacking]);
    gitOk(home, ["init", "-q", lackingNative]);
    const refused = run(lackingNative, ["fetch", b2, "refs/*:refs/*"]);
    const ourRefusal = await ourFetch(
      await openWorktree(lacking),
      b2,
      ["refs/*:refs/*"],
      false,
      b2Bytes,
    );
    expect(ourRefusal).toEqual({ status: refused.status, stderr: refused.stderr });
    // pull hands the bundle to its fetch
    const pn = join(home, "bytes-pull-native");
    const po = join(home, "bytes-pull-ours");
    for (const dir of [pn, po]) gitOk(home, ["init", "-q", "-b", "main", dir]);
    const pulled = run(pn, ["pull", "-q", b1, "topic/1"]);
    expect(pulled.status).toBe(0);
    const mineBefore = await openWorktree(po);
    await mineBefore.pull().addBundle("b1", bytes).setRemote("b1").setRefSpecs("topic/1").call();
    expect(run(po, ["rev-parse", "HEAD"]).stdout).toBe(run(pn, ["rev-parse", "HEAD"]).stdout);
    expect(run(po, ["status", "--porcelain"]).stdout).toBe("");
  });

  it("BundleWriterTest: our bundles of a single ref, of HEAD and incremental ones, fetched by native git and ours", async () => {
    const ours = await openWorktree(repo);
    const write = async (name: string, args: string[]) => {
      const command = ours.bundleCreate().setCompatibility(compatibility);
      for (const a of args) command.addArgument(a);
      const { bundle: bytes } = await command.call();
      if (!bytes) throw new Error(`no bundle for ${args.join(" ")}`);
      const file = join(home, name);
      writeFileSync(file, bytes);
      return { file, bytes };
    };
    // testWriteSingleRef, testWriteHEAD, testIncrementalBundle
    const single = await write("w-single.bdl", ["topic/1"]);
    const head = await write("w-head.bdl", ["HEAD"]);
    const incremental = await write("w-incremental.bdl", ["topic/1..topic/2"]);
    const native = join(home, "writer-native");
    const mine = join(home, "writer-ours");
    gitOk(home, ["init", "-q", native]);
    gitOk(home, ["init", "-q", mine]);
    for (const { file, bytes } of [incremental, single, head, incremental]) {
      const expected = run(native, [
        "fetch",
        file,
        "refs/*:refs/remotes/b/*",
        "HEAD:refs/remotes/b/HEAD",
      ]);
      const result = await ourFetch(
        await openWorktree(mine),
        file,
        ["refs/*:refs/remotes/b/*", "HEAD:refs/remotes/b/HEAD"],
        false,
        bytes,
      );
      expect(result).toEqual({ status: expected.status, stderr: expected.stderr });
      expect(showRef(mine)).toBe(showRef(native));
      expect(objects(mine)).toBe(objects(native));
    }
    expect(run(mine, ["fsck", "--strict", "--no-dangling"]).status).toBe(0);
  });
});
