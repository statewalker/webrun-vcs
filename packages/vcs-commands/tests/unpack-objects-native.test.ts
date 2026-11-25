/**
 * `git unpack-objects` (`git.unpackObjects()`), against native git: each scenario feeds the
 * same pack to native git and to ours, in twin repositories set up alike, and compares the exit
 * status, stderr and what the repository holds afterwards (loose objects, packs, the objects).
 * Packs come from native `pack-objects`. Scenarios from git's t5300-pack-object.sh (unpacking
 * with and without deltas, `--strict`), t5351-unpack-large-objects.sh (`-n`, big objects
 * streamed, objects already packed) and t5302-pack-index.sh (a tag without a tagger).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, noMaintenance } from "./native-git-http-backend.js";
import { gitOut, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let src: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args).trim();

/** Native `git <args>` in `cwd` with `input` on stdin. */
function gitWithInput(cwd: string, args: string[], input: Uint8Array) {
  const r = spawnSync("git", args, { cwd, env: testEnv(root), input });
  return { status: r.status, stdout: r.stdout.toString("latin1"), stderr: r.stderr.toString() };
}

/** Writes `ids` (one per line) into a pack with native pack-objects, returning its bytes. */
function packOf(ids: string[], ...options: string[]): Uint8Array {
  const base = join(root, `pack-${counter++}`);
  const name = gitWithInput(
    src,
    ["pack-objects", ...options, base],
    new TextEncoder().encode(`${ids.join("\n")}\n`),
  ).stdout.trim();
  return new Uint8Array(readFileSync(`${base}-${name}.pack`));
}

/** Writes `content` as an object of `type` without checks (`hash-object --literally`). */
function literally(type: string, content: string): string {
  const path = join(src, ".tmp-object");
  writeFileSync(path, content);
  const id = git(src, "hash-object", "--literally", "-t", type, "-w", ".tmp-object");
  rmSync(path);
  return id;
}

/** A repository's layout: loose and packed object counts, packs, and its objects. */
function layout(dir: string) {
  const counts = Object.fromEntries(
    git(dir, "count-objects", "-v")
      .split("\n")
      .map((l) => l.split(": ")),
  );
  return {
    loose: Number(counts.count),
    inPack: Number(counts["in-pack"]),
    packs: Number(counts.packs),
    objects: git(
      dir,
      "cat-file",
      "--batch-all-objects",
      "--batch-check=%(objectname) %(objecttype)",
    )
      .split("\n")
      .filter(Boolean)
      .sort(),
  };
}

/** Twin bare repositories `n` (native) and `o` (ours), set up by `prepare`. */
function twins(prepare: (dir: string) => void = () => {}) {
  const k = `t${counter++}`;
  const n = join(root, k, "n");
  const o = join(root, k, "o");
  for (const dir of [n, o]) {
    git(root, "init", "-q", "--bare", dir);
    noMaintenance(dir);
    prepare(dir);
  }
  return { k, n, o };
}

/** Our `unpack-objects` in `<root>/<name>` with `options`. */
async function oursUnpack(
  name: string,
  pack: Uint8Array,
  options: { dryRun?: boolean; strict?: boolean | string } = {},
) {
  const git = await openOurs(
    root,
    createNodeGitHostEnvironment({ env: testEnv(root) }),
    undefined,
    "",
    false,
    name,
  );
  const command = git.unpackObjects().setInput(pack);
  if (options.dryRun) command.setDryRun(true);
  if (options.strict !== undefined) command.setStrict(options.strict);
  return command.callOutput();
}

/** Both twins unpack `pack` with `args` (native) and `options` (ours); outcomes compared. */
async function unpackBoth(
  t: { k: string; n: string; o: string },
  pack: Uint8Array,
  args: string[],
  options: { dryRun?: boolean; strict?: boolean | string } = {},
) {
  const native = gitWithInput(t.n, ["unpack-objects", ...args], pack);
  const ours = await oursUnpack(`${t.k}/o`, pack, options);
  expect({ exitCode: ours.exitCode, stderr: ours.stderr, stdout: ours.stdout.length }).toEqual({
    exitCode: native.status,
    stderr: native.stderr,
    stdout: 0,
  });
  expect(layout(t.o)).toEqual(layout(t.n));
  return native;
}

let all: string[];
let commit: string;
let bigPack: Uint8Array;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "unpack-objects-"));
  src = join(root, "src");
  git(root, "init", "-q", "-b", "main", src);
  noMaintenance(src);
  // files alike enough to be stored as deltas of each other
  const text = Array.from({ length: 200 }, (_, i) => `line ${i} of a text long enough\n`).join("");
  for (let n = 0; n < 8; n++) putFile(src, `f${n}`, `${text}change ${n}\n`);
  git(src, "add", "-A");
  git(src, "commit", "-qm", "files");
  commit = git(src, "rev-parse", "HEAD");
  all = git(src, "rev-list", "--objects", "HEAD")
    .split("\n")
    .map((l) => l.slice(0, 40));
  // t5351: two 1.5 MB random blobs, one per commit
  const big = join(root, "big");
  git(root, "init", "-q", "-b", "main", big);
  noMaintenance(big);
  for (const seed of [1, 2]) {
    const bytes = Buffer.alloc(1_500_000);
    let x = seed * 2654435761;
    for (let i = 0; i < bytes.length; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      bytes[i] = x >>> 24;
    }
    writeFileSync(join(big, "big-blob"), bytes);
    git(big, "add", "big-blob");
    git(big, "commit", "-qm", `big ${seed}`);
  }
  const base = join(root, "bigpack");
  const name = gitWithInput(
    big,
    ["pack-objects", "--revs", base],
    Buffer.from("HEAD\n"),
  ).stdout.trim();
  bigPack = new Uint8Array(readFileSync(`${base}-${name}.pack`));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describeGit("git unpack-objects (native twins)", () => {
  it(`t5300-pack-object.sh: "unpack without delta"`, async () => {
    const pack = packOf(all, "--window=0");
    const t = twins();
    await unpackBoth(t, pack, ["-n"], { dryRun: true });
    expect(layout(t.n).objects).toEqual([]);
    await unpackBoth(t, pack, []);
    expect(layout(t.n).loose).toBe(all.length);
  });

  it(`t5300-pack-object.sh: "unpack with REF_DELTA"`, async () => {
    const pack = packOf(all);
    const t = twins();
    await unpackBoth(t, pack, ["-n"], { dryRun: true });
    await unpackBoth(t, pack, []);
  });

  it(`t5300-pack-object.sh: "unpack with OFS_DELTA"`, async () => {
    const pack = packOf(all, "--delta-base-offset");
    const t = twins();
    await unpackBoth(t, pack, ["-n"], { dryRun: true });
    await unpackBoth(t, pack, []);
  });

  it(`t5351-unpack-large-objects.sh: "unpack-objects works with memory limitation in dry-run mode"`, async () => {
    const t = twins((dir) => git(dir, "config", "core.bigFileThreshold", "2m"));
    await unpackBoth(t, bigPack, ["-n"], { dryRun: true });
    expect(layout(t.n).objects).toEqual([]);
  });

  it(`t5351-unpack-large-objects.sh: "unpack big object in stream"`, async () => {
    const t = twins((dir) => git(dir, "config", "core.bigFileThreshold", "1m"));
    await unpackBoth(t, bigPack, []);
    expect(layout(t.n).packs).toBe(0);
  });

  it(`t5351-unpack-large-objects.sh: "do not unpack existing large objects"`, async () => {
    const t = twins((dir) => {
      git(dir, "config", "core.bigFileThreshold", "1m");
      gitWithInput(dir, ["index-pack", "--stdin"], bigPack);
    });
    await unpackBoth(t, bigPack, []);
    expect(layout(t.n).loose).toBe(0);
  });

  it(`t5300-pack-object.sh: "unpacking with --strict"`, async () => {
    const trees = all.filter((id) => git(src, "cat-file", "-t", id) === "tree");
    const treesOnly = packOf(trees);
    const full = packOf(all);
    // tree-only into an empty repository: its blobs are missing
    const empty = twins();
    const refused = await unpackBoth(empty, treesOnly, ["--strict"], { strict: true });
    expect(refused.status).toBe(128);
    // the whole history, then the trees again into the populated repository
    const t = twins();
    await unpackBoth(t, full, ["--strict"], { strict: true });
    await unpackBoth(t, treesOnly, ["--strict"], { strict: true });
  });

  describe("a commit without an email (t5504's bogus commit)", () => {
    let bogus: string;
    let fresh: string;
    let freshTree: string;
    beforeAll(() => {
      const tree = git(src, "rev-parse", "HEAD^{tree}");
      bogus = literally(
        "commit",
        `tree ${tree}\nauthor Bugs Bunny 1234567890 +0000\ncommitter Bugs Bunny <bugs@bun.ni> 1234567890 +0000\n\nbroken\n`,
      );
      // a new blob in a new tree, under a commit as bad: what --strict leaves of it
      fresh = literally("blob", "fresh\n");
      const mktree = gitWithInput(
        src,
        ["mktree"],
        new TextEncoder().encode(`100644 blob ${fresh}\tfresh\n`),
      );
      freshTree = mktree.stdout.trim();
    });
    const populated = () =>
      twins((dir) => gitWithInput(dir, ["unpack-objects", "-q"], packOf(all)));

    it("--strict refuses it as index-pack --strict", async () => {
      const r = await unpackBoth(populated(), packOf([bogus]), ["--strict"], { strict: true });
      expect(r.stderr).toContain("missingEmail");
      expect(r.status).toBe(128);
    });

    it("--strict leaves what it wrote before the refused commit", async () => {
      const commitFresh = literally(
        "commit",
        `tree ${freshTree}\nauthor Bugs Bunny 1234567890 +0000\ncommitter Bugs Bunny <bugs@bun.ni> 1234567890 +0000\n\nbroken\n`,
      );
      const t = twins();
      const r = await unpackBoth(t, packOf([fresh, freshTree, commitFresh]), ["--strict"], {
        strict: true,
      });
      expect(r.status).toBe(128);
      // the blob, and the tree checked before the refused commit; not the commit
      expect(layout(t.n).objects).toContain(`${fresh} blob`);
      expect(layout(t.n).objects.some((l) => l.startsWith(commitFresh))).toBe(false);
    });

    it("--strict=missingEmail=ignore accepts it", async () => {
      await unpackBoth(populated(), packOf([bogus]), ["--strict=missingEmail=ignore"], {
        strict: "missingEmail=ignore",
      });
    });

    it("--strict=missingEmail=warn warns and accepts it", async () => {
      const r = await unpackBoth(populated(), packOf([bogus]), ["--strict=missingEmail=warn"], {
        strict: "missingEmail=warn",
      });
      expect(r.stderr).toMatch(/^warning: /);
    });

    it("-n --strict checks nothing and writes nothing", async () => {
      await unpackBoth(populated(), packOf([bogus]), ["-n", "--strict"], {
        dryRun: true,
        strict: true,
      });
    });

    it("without --strict it is written", async () => {
      await unpackBoth(populated(), packOf([bogus]), []);
    });
  });

  it(`t5302-pack-index.sh: "index-pack --strict warns upon missing tagger in tag"`, async () => {
    const tag = literally(
      "tag",
      `object ${commit}\ntype commit\ntag guten tag\n\nThis is an invalid tag.\n`,
    );
    const t = twins((dir) => gitWithInput(dir, ["unpack-objects", "-q"], packOf(all)));
    const r = await unpackBoth(t, packOf([tag]), ["--strict"], { strict: true });
    expect(r.stderr).toMatch(/^warning:.* expected .tagger. line/m);
    expect(r.status).toBe(0);
  });

  it("a pack of more than 100 objects is exploded too, with and without --strict", async () => {
    const many = join(root, "many");
    git(root, "init", "-q", "-b", "main", many);
    noMaintenance(many);
    for (let n = 0; n < 120; n++) putFile(many, `m${n}`, `file ${n}\n`);
    git(many, "add", "-A");
    git(many, "commit", "-qm", "many");
    const base = join(root, `many-pack-${counter++}`);
    const name = gitWithInput(
      many,
      ["pack-objects", "--revs", base],
      Buffer.from("HEAD\n"),
    ).stdout.trim();
    const pack = new Uint8Array(readFileSync(`${base}-${name}.pack`));
    const strict = twins();
    await unpackBoth(strict, pack, ["--strict"], { strict: true });
    expect(layout(strict.n)).toMatchObject({ loose: 122, packs: 0 });
    await unpackBoth(twins(), pack, []);
  });

  it("--strict with a value without '=' dies", async () => {
    await unpackBoth(twins(), packOf(all), ["--strict=bogus"], { strict: "bogus" });
  });

  it("a truncated pack dies (and writes nothing in a dry run)", async () => {
    const truncated = packOf(all).subarray(0, 20);
    await unpackBoth(twins(), truncated, []);
    await unpackBoth(twins(), truncated, ["-n"], { dryRun: true });
  });
});
