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
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createNodeGitHostEnvironment, createNodeSigner } from "@statewalker/vcs-utils-node/files";
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

  /** native git with `input` on stdin, stdout as latin1 bytes */
  const gitIn = (cwd: string, args: string[], input: string) => {
    const r = spawnSync(git3 as string, args, { cwd, env: env(), input, encoding: "latin1" });
    return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
  };
  const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

  it("cat-file --batch* take compatibility ids, full and abbreviated (cat-file.c batch_one_object, GET_OID_HASH_ANY)", async () => {
    const dir = compatRepo();
    buildNative(dir);
    const g = await ours(dir);
    const ids: string[] = [];
    for (const name of NAMES)
      ids.push(ok(dir, ["rev-parse", "--output-object-format=sha1", name]).trim());
    const input = [
      ...ids,
      ...ids.map((id) => id.slice(0, 8)),
      ...ids.map((id) => id.toUpperCase().slice(0, 12)),
      ...NAMES,
      // an abbreviation that misses flushes git's loose cache, and the map's compatibility
      // ids with it: the lines after it find none
      "1234567890123456789012345678901234567890",
      `${ids[0]}:a`,
      `${ids[1]} with rest`,
      "",
    ].join("\n");
    const cases: Array<[string[], (c: ReturnType<Git["catFile"]>) => ReturnType<Git["catFile"]>]> =
      [
        [["cat-file", "--batch-check"], (c) => c.setBatch("info")],
        [["cat-file", "--batch"], (c) => c.setBatch("contents")],
        [
          ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize) %(rest)"],
          (c) => c.setBatch("info", "%(objectname) %(objecttype) %(objectsize) %(rest)"),
        ],
        [
          ["cat-file", "--batch", "--use-mailmap"],
          (c) => c.setBatch("contents").setUseMailmap(true),
        ],
      ];
    writeFileSync(join(dir, ".mailmap"), "M <m@example.com> <a@example.com>\n");
    for (const [args, configure] of cases) {
      const native = gitIn(dir, args, input);
      expect(native.status, `${args.join(" ")}: ${native.err}`).toBe(0);
      const r = await configure(g.catFile()).setStdin(input).callOutput();
      expect({ status: r.exitCode, out: latin1(r.stdout), err: r.stderr }, args.join(" ")).toEqual(
        native,
      );
    }
    // --batch-command: info and contents of compatibility ids
    const commands = `info ${ids[0]}\ncontents ${ids[2]?.slice(0, 9)}\ninfo ${ids[4]}\ncontents ${ids[3]}\n`;
    const native = gitIn(dir, ["cat-file", "--batch-command"], commands);
    expect(native.status, native.err).toBe(0);
    const r = await g.catFile().setBatch("command").setStdin(commands).callOutput();
    expect({ status: r.exitCode, out: latin1(r.stdout), err: r.stderr }).toEqual(native);
    // single-object modes take abbreviated compatibility ids too, and refuse unmapped ones
    for (const name of [
      ids[0]?.slice(0, 7),
      ids[3]?.slice(0, 10),
      "1234567890123456789012345678901234567890",
    ]) {
      for (const [flag, mode] of [
        ["-t", "type"],
        ["-s", "size"],
        ["-p", "pretty"],
        ["-e", "exists"],
      ] as const) {
        const n = git(dir, ["cat-file", flag, name as string]);
        const o = await g
          .catFile()
          .setMode(mode)
          .setObject(name as string)
          .callOutput();
        expect(
          { status: o.exitCode, out: new TextDecoder().decode(o.stdout) },
          `${flag} ${name}`,
        ).toEqual({
          status: n.status,
          out: n.out,
        });
        if (n.status !== 0) expect(o.stderr.trim()).toBe(n.err.trim());
      }
    }
  });

  it("ls-tree lists a tree named by its compatibility id with compatibility ids (builtin/ls-tree.c, GET_OID_HASH_ANY)", async () => {
    const dir = compatRepo();
    buildNative(dir);
    const g = await ours(dir);
    const id = (name: string) => ok(dir, ["rev-parse", "--output-object-format=sha1", name]).trim();
    const tree = id("HEAD^{tree}");
    const variants: string[][] = [
      [],
      ["-r"],
      ["-r", "-t"],
      ["-l"],
      ["-r", "-l"],
      ["--name-only"],
      ["--object-only", "-r"],
      ["--abbrev"],
      ["--format=%(objectmode) %(objecttype) %(objectname) %(objectsize:padded) %(path)", "-r"],
      ["-d"],
    ];
    const run = async (args: string[], name: string) => {
      const c = g.lsTree().setTreeish(name);
      for (const a of args) {
        if (a === "-r") c.setRecursive(true);
        else if (a === "-t") c.setShowTrees(true);
        else if (a === "-d") c.setTreesOnly(true);
        else if (a === "-l") c.setLong();
        else if (a === "--name-only") c.setNameOnly();
        else if (a === "--object-only") c.setObjectOnly();
        else if (a === "--abbrev") c.setAbbrev();
        else if (a.startsWith("--format=")) c.setFormat(a.slice("--format=".length));
      }
      const r = await c.callOutput();
      return { status: r.exitCode, out: latin1(r.stdout), err: r.stderr };
    };
    for (const name of [tree, tree.slice(0, 9), id("HEAD:d")]) {
      for (const args of variants) {
        const native = git(dir, ["ls-tree", ...args, name]);
        expect(native.status, `${args.join(" ")} ${name}: ${native.err}`).toBe(0);
        expect(await run(args, name), `${args.join(" ")} ${name}`).toEqual(native);
      }
    }
    // git parses a commit or tag named by a compatibility id with the storage parsers: no tree
    for (const name of [
      id("HEAD"),
      id("v1"),
      id("HEAD:a"),
      "1234567890123456789012345678901234567890",
    ]) {
      const native = git(dir, ["ls-tree", name]);
      expect(native.status, name).toBe(128);
      const r = await run([], name);
      expect({ status: r.status, out: r.out, err: r.err.trim() }, name).toEqual({
        status: 128,
        out: native.out,
        err: native.err.trim(),
      });
    }
  });

  it("rev-parse --output-object-format takes abbreviated ids of either format (get_short_oid without an algorithm)", async () => {
    const dir = compatRepo();
    buildNative(dir);
    const g = await ours(dir);
    for (const name of NAMES) {
      const sha1 = ok(dir, ["rev-parse", "--output-object-format=sha1", name]).trim();
      const sha256 = ok(dir, ["rev-parse", name]).trim();
      for (const short of [sha1.slice(0, 7), sha1.slice(0, 11).toUpperCase(), sha256.slice(0, 9)]) {
        for (const format of ["sha1", "sha256"]) {
          const native = ok(dir, ["rev-parse", `--output-object-format=${format}`, short]).trim();
          const r = await g
            .revParse()
            .addArgument(`--output-object-format=${format}`)
            .addArgument(short)
            .call();
          expect(r.lines, `${format} ${short}`).toEqual([native]);
        }
      }
    }
  });

  it("an abbreviation shared by a storage id and a compatibility id is ambiguous across both", async () => {
    const dir = compatRepo();
    // blobs until a 4-digit prefix of a SHA-256 id is one of a SHA-1 id
    const paths: string[] = [];
    for (let i = 1; i <= 400; i++) {
      writeFileSync(join(dir, `f${i}`), `blob ${i}\n`);
      paths.push(`f${i}`);
    }
    gitIn(dir, ["hash-object", "-w", "--stdin-paths"], `${paths.join("\n")}\n`);
    const lines = mapLines(dir).map((l) => l.split(" ") as [string, string]);
    const storage = new Set(lines.map(([a]) => a.slice(0, 4)));
    const shared = lines.map(([, b]) => b.slice(0, 4)).find((p) => storage.has(p));
    expect(shared).toBeDefined();
    const prefix = shared as string;
    const g = await ours(dir);
    const native = gitIn(dir, ["cat-file", "--batch-check"], `${prefix}\n`);
    const r = await g.catFile().setBatch("info").setStdin(`${prefix}\n`).callOutput();
    expect({ status: r.exitCode, out: latin1(r.stdout), err: r.stderr }).toEqual(native);
    expect(native.out).toBe(`${prefix} ambiguous\n`);
    for (const format of ["sha1", "sha256"]) {
      const n = git(dir, ["rev-parse", `--output-object-format=${format}`, prefix]);
      expect(n.status).toBe(128);
      const error = await g
        .revParse()
        .addArgument(`--output-object-format=${format}`)
        .addArgument(prefix)
        .call()
        .then(
          () => undefined,
          (e: Error) => e.message,
        );
      // git's candidate list, then its unknown-revision death
      expect(error).toContain(n.err.split("fatal:")[0]?.trim());
    }
  });

  /**
   * A `gpg.program` whose signature is a hash of what it is given: a signature over the wrong
   * buffer shows as another signature (and another object id)
   */
  const hashingGpg = () => {
    const path = join(root, "hashing-gpg");
    writeFileSync(
      path,
      [
        "#!/bin/sh",
        "h=$(sha256sum | cut -c1-48)",
        'echo "[GNUPG:] SIG_CREATED D 22 10 00 1 2" >&2',
        "printf -- '-----BEGIN PGP SIGNATURE-----\\n\\n%s\\n-----END PGP SIGNATURE-----\\n' \"$h\"",
        "",
      ].join("\n"),
    );
    chmodSync(path, 0o755);
    return path;
  };

  for (const [storage, compat] of [
    ["sha256", "sha1"],
    ["sha1", "sha256"],
  ] as const) {
    it(`commit -S and tag -s sign both formats' views (${storage} with ${compat}; commit.c commit_tree_extended, builtin/tag.c do_sign)`, async () => {
      const program = hashingGpg();
      const twins = ["n", "o"].map((name) => {
        const dir = fresh(name);
        mkdirSync(dir);
        ok(dir, ["init", "-q", "-b", "main", `--object-format=${storage}`]);
        ok(dir, ["config", "core.repositoryformatversion", "1"]);
        ok(dir, ["config", "extensions.compatObjectFormat", compat]);
        ok(dir, ["config", "gpg.program", program]);
        mkdirSync(join(dir, "d"));
        writeFileSync(join(dir, "a"), "hello\n");
        writeFileSync(join(dir, "d/b"), "x\n");
        return dir;
      });
      const [native, mine] = twins as [string, string];
      ok(native, ["add", "."]);
      ok(native, ["commit", "-q", "-S", "-m", "one"]);
      ok(native, ["tag", "-s", "-m", "release", "v1"]);
      writeFileSync(join(native, "a"), "again\n");
      ok(native, ["commit", "-q", "-S", "-am", "two"]);
      const g = await openOurs(
        mine,
        createNodeGitHostEnvironment({
          env: env(),
          effectiveUid: null,
          signer: createNodeSigner({ env: env() }),
        }),
      );
      await g.add().addFilepattern(".").call();
      await g.commit().setMessage("one\n").setSign(true).call();
      await g.tag().setName("v1").setMessage("release\n").setSigned(true).call();
      writeFileSync(join(mine, "a"), "again\n");
      await g.add().addFilepattern("a").call();
      await g.commit().setMessage("two\n").setSign(true).call();
      // the same objects in both formats, so the same ids and map lines
      for (const name of ["HEAD", "HEAD~1", "v1"]) {
        for (const format of [storage, compat]) {
          expect(
            ok(mine, ["rev-parse", `--output-object-format=${format}`, name]),
            `${format} ${name}`,
          ).toBe(ok(native, ["rev-parse", `--output-object-format=${format}`, name]));
        }
        const compatId = ok(native, ["rev-parse", `--output-object-format=${compat}`, name]).trim();
        expect(ok(mine, ["cat-file", "-p", compatId])).toBe(
          ok(native, ["cat-file", "-p", compatId]),
        );
      }
      expect(mapLines(mine)).toEqual(mapLines(native));
      // each view carries both signatures, and they differ: each signs its own view
      const head = ok(mine, ["cat-file", "-p", "HEAD"]);
      const sigs = [
        ...head.matchAll(/^(gpgsig(?:-sha256)?) -----BEGIN PGP SIGNATURE-----\n \n (\w+)$/gm),
      ];
      expect(sigs.map((m) => m[1])).toEqual(["gpgsig", "gpgsig-sha256"]);
      expect(sigs[0]?.[2]).not.toBe(sigs[1]?.[2]);
      expect(git(mine, ["fsck", "--strict"])).toMatchObject({ status: 0, err: "" });
    });
  }
});
