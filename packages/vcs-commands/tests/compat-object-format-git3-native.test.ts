/**
 * `extensions.compatObjectFormat` (git 2.45+, built with Rust: git master and 2.56 die
 * "compatibility hash algorithm support requires Rust" without it) against the git master
 * oracle (`$GIT3`, skipped without it or when it was built without Rust). A SHA-256
 * repository with a SHA-1 compatibility format keeps `objects/loose-object-idx`: one
 * `<sha256> <sha1>` line per object written loose, appended as it is written. git keeps no map
 * for packs (index-pack writes `.idx` v2 and no line, gc and repack leave the file alone), so:
 *
 * - ours opens such a repository, and native `rev-parse --output-object-format` and `cat-file`
 *   of the compatibility ids agree on what ours reads and what ours writes;
 * - ours writes the lines native git writes for the same history, and native `fsck` is clean;
 * - an object received in a pack has no compatibility id, so a commit over it dies in both
 *   (`failed to map tree entry`), and unpack-objects of a pack whose commit comes first dies
 *   in both (`unable to map tree ... in commit object`) before any ref moves.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGit3Env } from "./native-git3.js";

/** `$GIT3` when it can open a compatibility repository (a build with Rust) */
function compatGit(): string | undefined {
  const git = process.env.GIT3;
  if (!git) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "compat-probe-"));
  try {
    const run = (args: string[]) =>
      spawnSync(git, args, { cwd: dir, env: { ...nativeGit3Env(dir) }, encoding: "utf8" });
    run(["init", "-q", "--object-format=sha256"]);
    run(["config", "extensions.compatObjectFormat", "sha1"]);
    const r = run(["rev-parse", "--show-object-format=compat"]);
    if (r.status !== 0) {
      console.warn(`compatObjectFormat twins skipped: ${r.stderr.trim()}`);
      return undefined;
    }
    return git;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const git3 = compatGit();

describe.skipIf(!git3)("extensions.compatObjectFormat (git master)", () => {
  let root = "";
  let n = 0;
  const fresh = (name: string) => join(root, `${name}-${n++}`);
  const env = (extra: Record<string, string> = {}) => ({
    ...nativeGit3Env(root),
    GIT_DEFAULT_REF_FORMAT: "files",
    GIT_AUTHOR_NAME: "A",
    GIT_AUTHOR_EMAIL: "a@example.com",
    GIT_COMMITTER_NAME: "C",
    GIT_COMMITTER_EMAIL: "c@example.com",
    GIT_AUTHOR_DATE: "1700000000 +0000",
    GIT_COMMITTER_DATE: "1700000000 +0000",
    ...extra,
  });
  const git = (cwd: string, args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync(git3 as string, args, { cwd, env: env(extra), encoding: "utf8" });
    return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
  };
  const ok = (cwd: string, args: string[]) => {
    const r = git(cwd, args);
    expect(r.err, args.join(" ")).toBe(r.status === 0 ? r.err : "");
    expect(r.status, `${args.join(" ")}: ${r.err}`).toBe(0);
    return r.out;
  };
  /** An empty SHA-256 repository with a SHA-1 compatibility format */
  const compatRepo = (name = "repo") => {
    const dir = fresh(name);
    mkdirSync(dir);
    ok(dir, ["init", "-q", "-b", "main", "--object-format=sha256"]);
    ok(dir, ["config", "extensions.compatObjectFormat", "sha1"]);
    return dir;
  };
  const ours = (dir: string) =>
    openOurs(dir, createNodeGitHostEnvironment({ env: env(), effectiveUid: null }));
  const mapLines = (dir: string) => {
    let text = "";
    try {
      text = readFileSync(join(dir, ".git/objects/loose-object-idx"), "utf8");
    } catch {
      return [];
    }
    const [header, ...lines] = text.split("\n");
    expect(header).toBe("# loose-object-idx");
    return lines.filter((l) => l !== "").sort();
  };
  const ourRevParse = async (g: Git, args: string[]) =>
    (
      await g
        .revParse()
        .addArgument(args[0] as string)
        .call()
    ).lines;
  const ourCat = async (g: Git, mode: "type" | "size" | "pretty", name: string) => {
    const r = await g.catFile().setMode(mode).setObject(name).callOutput();
    return { status: r.exitCode, out: new TextDecoder().decode(r.stdout) };
  };
  /** Native's history: two files in two directories, a commit, an annotated tag, a second commit */
  const buildNative = (dir: string) => {
    mkdirSync(join(dir, "d"));
    writeFileSync(join(dir, "a"), "hello\n");
    writeFileSync(join(dir, "d/b"), "x\n");
    ok(dir, ["add", "."]);
    ok(dir, ["commit", "-q", "-m", "one"]);
    ok(dir, ["tag", "-a", "-m", "release", "v1"]);
    writeFileSync(join(dir, "a"), "hello again\n");
    ok(dir, ["commit", "-q", "-am", "two"]);
  };
  const NAMES = ["HEAD", "HEAD^{tree}", "HEAD~1", "v1", "HEAD:a", "HEAD:d"];

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "compat-format-git3-")));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("ours opens a native compatibility repository and translates its ids as git does", async () => {
    const dir = compatRepo();
    buildNative(dir);
    const g = await ours(dir);
    expect(await ourRevParse(g, ["--show-object-format=compat"])).toEqual(
      git(dir, ["rev-parse", "--show-object-format=compat"]).out.trim().split("\n"),
    );
    for (const name of NAMES) {
      for (const format of ["sha1", "sha256", "storage"]) {
        const args = [`--output-object-format=${format}`, name];
        const native = ok(dir, ["rev-parse", ...args]).trim();
        const r = await g
          .revParse()
          .addArgument(args[0] as string)
          .addArgument(name)
          .call();
        expect(r.lines, args.join(" ")).toEqual([native]);
      }
    }
    // a compatibility id given back: as given in its format, the storage id in the other
    const sha1Head = ok(dir, ["rev-parse", "--output-object-format=sha1", "HEAD"]).trim();
    for (const format of ["sha1", "sha256"]) {
      const native = ok(dir, ["rev-parse", `--output-object-format=${format}`, sha1Head]).trim();
      const r = await g
        .revParse()
        .addArgument(`--output-object-format=${format}`)
        .addArgument(sha1Head)
        .call();
      expect(r.lines).toEqual([native]);
    }
    // unsupported formats die alike
    const bad = git(dir, ["rev-parse", "--output-object-format=sha3", "HEAD"]);
    expect(bad.status).toBe(128);
    await expect(
      g.revParse().addArgument("--output-object-format=sha3").addArgument("HEAD").call(),
    ).rejects.toThrow(bad.err.trim().replace(/^fatal: /, ""));
    // cat-file of the compatibility ids: the objects as SHA-1 sees them
    for (const name of NAMES) {
      const id = ok(dir, ["rev-parse", "--output-object-format=sha1", name]).trim();
      for (const mode of ["type", "size", "pretty"] as const) {
        const flag = mode === "type" ? "-t" : mode === "size" ? "-s" : "-p";
        const native = git(dir, ["cat-file", flag, id]);
        expect(native.status, `${flag} ${name}: ${native.err}`).toBe(0);
        expect(await ourCat(g, mode, id), `${flag} ${name}`).toEqual({
          status: 0,
          out: native.out,
        });
      }
    }
  });

  it("ours writes the loose object map git writes, and native git reads it", async () => {
    const native = compatRepo("native");
    buildNative(native);
    const dir = compatRepo("ours");
    const g = await ours(dir);
    mkdirSync(join(dir, "d"));
    writeFileSync(join(dir, "a"), "hello\n");
    writeFileSync(join(dir, "d/b"), "x\n");
    await g.add().addFilepattern(".").call();
    await g.commit().setMessage("one\n").call();
    await g.tag().setName("v1").setMessage("release\n").call();
    writeFileSync(join(dir, "a"), "hello again\n");
    await g.add().addFilepattern("a").call();
    await g.commit().setMessage("two\n").call();
    // the same objects, so the same lines (git appends them in write order: compared sorted)
    expect(ok(dir, ["rev-parse", "HEAD", "v1"])).toBe(ok(native, ["rev-parse", "HEAD", "v1"]));
    expect(mapLines(dir)).toEqual(mapLines(native));
    expect(mapLines(dir).length).toBeGreaterThan(0);
    for (const name of NAMES) {
      expect(ok(dir, ["rev-parse", "--output-object-format=sha1", name])).toBe(
        ok(native, ["rev-parse", "--output-object-format=sha1", name]),
      );
    }
    expect(git(dir, ["fsck", "--strict"])).toMatchObject({ status: 0, err: "" });
    // our fsck takes the map file as git's does (no garbage)
    expect(await g.fsck().setStrict(true).call()).toMatchObject({ exitCode: 0 });
    // gc packs the objects and keeps the map: the ids still translate, in both
    expect((await g.gc().setQuiet(true).call()) !== undefined).toBe(true);
    ok(native, ["gc", "-q"]);
    expect(mapLines(dir)).toEqual(mapLines(native));
    expect(ok(dir, ["rev-parse", "--output-object-format=sha1", "HEAD"])).toBe(
      ok(native, ["rev-parse", "--output-object-format=sha1", "HEAD"]),
    );
    expect(git(dir, ["fsck", "--strict"])).toMatchObject({ status: 0, err: "" });
    // and a later commit over the packed (mapped) objects maps too
    writeFileSync(join(dir, "c"), "three\n");
    await g.add().addFilepattern("c").call();
    await g.commit().setMessage("three\n").call();
    const sha1 = ok(dir, ["rev-parse", "--output-object-format=sha1", "HEAD"]).trim();
    expect(sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(ok(dir, ["cat-file", "-p", sha1])).toBe(
      new TextDecoder().decode(
        (await g.catFile().setMode("pretty").setObject(sha1).callOutput()).stdout,
      ),
    );
  });

  it("a received pack gets no map: a commit over it dies in both, writing nothing", async () => {
    const upstream = fresh("up");
    mkdirSync(upstream);
    ok(upstream, ["init", "-q", "-b", "main", "--object-format=sha256"]);
    writeFileSync(join(upstream, "a"), "upstream\n");
    ok(upstream, ["add", "a"]);
    ok(upstream, ["commit", "-q", "-m", "up"]);
    const twins = [compatRepo("n"), compatRepo("o")] as const;
    for (const dir of twins) {
      // index-pack keeps the pack: no map line for its objects
      ok(dir, ["-c", "fetch.unpackLimit=1", "fetch", "-q", upstream, "main:up"]);
      ok(dir, ["checkout", "-q", "up"]);
      expect(mapLines(dir)).toEqual([]);
      writeFileSync(join(dir, "b"), "local\n");
    }
    const [native, mine] = twins;
    ok(native, ["add", "b"]);
    const died = git(native, ["commit", "-q", "-m", "local"]);
    expect(died.status).toBe(128);
    expect(died.err).toMatch(/^error: failed to map tree entry for [0-9a-f]{64}\n/);
    expect(died.err).toContain("fatal: Failed to convert object from sha256 to sha1");
    const g = await ours(mine);
    await g.add().addFilepattern("b").call();
    const before = ok(mine, ["rev-parse", "HEAD"]);
    const error = await g
      .commit()
      .setMessage("local\n")
      .call()
      .then(
        () => undefined,
        (e: unknown) => e as { lines?: string[]; message: string },
      );
    expect(error?.lines).toEqual(died.err.trim().split("\n"));
    expect(ok(mine, ["rev-parse", "HEAD"])).toBe(before);
    // the blob `add` wrote is mapped (a blob needs no other id), as native's
    expect(mapLines(mine)).toEqual(mapLines(native));
  });

  it("unpack-objects of a commit before its tree dies in both, moving no ref", async () => {
    const upstream = fresh("up");
    mkdirSync(upstream);
    ok(upstream, ["init", "-q", "-b", "main", "--object-format=sha256"]);
    writeFileSync(join(upstream, "a"), "upstream\n");
    ok(upstream, ["add", "a"]);
    ok(upstream, ["commit", "-q", "-m", "up"]);
    const native = compatRepo("n");
    const died = git(native, ["fetch", "-q", upstream, "main:up"]);
    expect(died.status).toBe(128);
    expect(died.err).toContain("fatal: Failed to convert object from sha256 to sha1");
    expect(git(native, ["rev-parse", "--verify", "-q", "up"]).status).not.toBe(0);
    const mine = compatRepo("o");
    // rooted above both, so the local remote is reachable
    const g = await openOurs(
      root,
      createNodeGitHostEnvironment({ env: env(), effectiveUid: null }),
      undefined,
      basename(mine),
    );
    await expect(
      g
        .fetch()
        .setRemote(`../${basename(upstream)}`)
        .setRefSpecs("main:up")
        .call(),
    ).rejects.toThrow(/Failed to convert object from sha256 to sha1/);
    expect(git(mine, ["rev-parse", "--verify", "-q", "up"]).status).not.toBe(0);
    expect(git(mine, ["fsck"]).status).toBe(0);
  });
});
