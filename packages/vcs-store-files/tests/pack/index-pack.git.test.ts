/**
 * installPack against native git: the `.idx` it writes equals `git index-pack -o`'s byte for
 * byte, thin packs completed through `externalBase` pass `git verify-pack` and `git fsck --full`,
 * and the hand-built packs git refuses are refused too.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExternalBase,
  type FilesApi,
  installPack,
  type ObjectTypeString,
  PackError,
} from "@statewalker/vcs-core";
import { buildPack, copyAll, craftDelta, oidOf } from "@statewalker/vcs-testing";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (cwd: string, args: string[], input?: string | Uint8Array, env = GIT_ENV) =>
  execFileSync("git", args, { cwd, env, input, maxBuffer: 1 << 30 });

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "index-pack-"));
  dirs.push(d);
  return d;
};
const emptyRepo = () => {
  const d = tmp();
  git(d, ["init", "-q", "--initial-branch=main", "."]);
  return d;
};
const PACK_DIR = ".git/objects/pack";
const packDirOf = (repo: string) => join(repo, PACK_DIR);
const packFiles = (repo: string) => readdirSync(packDirOf(repo)).sort();
async function* chunks(bytes: Uint8Array, size = 65536) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** xorshift bytes: deterministic and incompressible */
function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 255;
  }
  return out;
}

/** A repository with `commits` real commits editing a few text files (deltas between versions). */
function repoWithHistory(commits: number, opts: { bigBlobBytes?: number } = {}): string {
  const dir = emptyRepo();
  const lines = Array.from(
    { length: 400 },
    (_, i) => `line ${i}: ${"lorem ipsum dolor sit amet ".repeat(2)}`,
  );
  for (let c = 0; c < commits; c++) {
    for (let f = 0; f < 4; f++) {
      const edit = [...lines];
      for (let k = 0; k <= c; k++)
        edit[(k * 37 + f * 11) % edit.length] = `edited ${c}/${k} in file ${f}`;
      writeFileSync(join(dir, `file${f}.txt`), `${edit.join("\n")}\n`);
    }
    writeFileSync(join(dir, `small-${c % 7}.bin`), noise(200 + c, c + 1));
    if (opts.bigBlobBytes && (c === 0 || c === commits - 1)) {
      const big = noise(opts.bigBlobBytes, 99);
      if (c > 0) big[12345] = (big[12345] as number) ^ 0xff; // one byte changed: a delta of it
      writeFileSync(join(dir, "big.bin"), big);
    }
    git(dir, ["add", "-A"]);
    const date = `${1700000000 + c * 60} +0000`;
    git(dir, ["commit", "-q", "-m", `commit ${c}`], undefined, {
      ...GIT_ENV,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
  }
  return dir;
}

/** The pack native git writes for all objects; `ofs` chooses OFS_DELTA over REF_DELTA. */
function packAll(repo: string, ofs: boolean): Uint8Array {
  const objects = git(repo, ["rev-list", "--objects", "--all"]);
  const args = ["pack-objects", "--stdout", "-q", "--window=50", "--depth=50"];
  if (ofs) args.push("--delta-base-offset");
  return new Uint8Array(git(repo, args, objects));
}

/** git's own .idx for a pack. */
function gitIdx(pack: Uint8Array): Uint8Array {
  const d = tmp();
  writeFileSync(join(d, "p.pack"), pack);
  git(d, ["index-pack", "-o", join(d, "p.idx"), join(d, "p.pack")]);
  return new Uint8Array(readFileSync(join(d, "p.idx")));
}
/** `git verify-pack -v`: entries in pack order. */
function verifyPack(pack: string) {
  return git(tmp(), ["verify-pack", "-v", pack])
    .toString()
    .split("\n")
    .map((l) => l.split(/\s+/))
    .filter((f) => /^[0-9a-f]{40}$/.test(f[0] ?? "") && f.length >= 5)
    .map((f) => ({ oid: f[0] as string, type: f[1] as string, offset: Number(f[4]) }))
    .sort((a, b) => a.offset - b.offset);
}

const filesOf = (repo: string): FilesApi => createNodeFilesApi({ rootDir: repo });
const install = async (pack: Uint8Array, repo = emptyRepo()) => {
  const result = await installPack(filesOf(repo), PACK_DIR, chunks(pack));
  const idx = new Uint8Array(readFileSync(join(packDirOf(repo), `pack-${result.packId}.idx`)));
  return { repo, result, idx };
};

const history = repoWithHistory(60);
const withBig = repoWithHistory(3, { bigBlobBytes: 4 * 2 ** 20 });
const aggressive = (() => {
  const r = repoWithHistory(60);
  git(r, ["gc", "-q", "--aggressive"]);
  const p = packFiles(r).find((n) => n.endsWith(".pack")) as string;
  return new Uint8Array(readFileSync(join(packDirOf(r), p)));
})();
const variants: [string, Uint8Array][] = [
  ["OFS_DELTA (pack-objects --delta-base-offset)", packAll(history, true)],
  ["REF_DELTA (pack-objects without --delta-base-offset)", packAll(history, false)],
  ["gc --aggressive (deep chains)", aggressive],
  ["a ~4 MiB blob and a delta of it", packAll(withBig, true)],
];

describe("installPack writes git's .idx byte for byte", () => {
  for (const [name, pack] of variants) {
    it(name, async () => {
      const { repo, result, idx } = await install(pack);
      const ref = gitIdx(pack);
      expect(same(idx, ref)).toBe(true);
      // the last fan-out slot is the object count
      expect(result.count).toBe(new DataView(ref.buffer, ref.byteOffset).getUint32(8 + 255 * 4));
      expect(result.count).toBeGreaterThan(name.startsWith("a ~4") ? 10 : 300);
      expect(packFiles(repo)).toEqual([`pack-${result.packId}.idx`, `pack-${result.packId}.pack`]);
    }, 120_000);
  }

  it("native git reads an installed pack: verify-pack, fsck --full, cat-file", async () => {
    const { repo, result } = await install(variants[0]?.[1] as Uint8Array);
    const pack = join(packDirOf(repo), `pack-${result.packId}.pack`);
    git(repo, ["verify-pack", pack]);
    git(repo, [
      "update-ref",
      "refs/heads/main",
      git(history, ["rev-parse", "HEAD"]).toString().trim(),
    ]);
    git(repo, ["fsck", "--full", "--no-dangling"]);
    const entries = verifyPack(pack);
    expect(entries.length).toBe(result.count);
    for (const e of entries.slice(0, 50))
      expect(
        same(git(repo, ["cat-file", e.type, e.oid]), git(history, ["cat-file", e.type, e.oid])),
      ).toBe(true);
  }, 120_000);
});

/** externalBase over a repository, through `git cat-file`; records the ids asked for. */
function repoBase(repo: string): ExternalBase & { calls: string[] } {
  const calls: string[] = [];
  const f = async (id: string) => {
    calls.push(id);
    const r = spawnSync("git", ["cat-file", "-t", id], {
      cwd: repo,
      env: GIT_ENV,
      encoding: "utf8",
    });
    if (r.status !== 0) return undefined;
    const type = r.stdout.trim() as ObjectTypeString;
    return { type, data: new Uint8Array(git(repo, ["cat-file", type, id])) };
  };
  return Object.assign(f, { calls });
}

/**
 * A receiver holding the objects of `have` only, and the thin pack `want ^have` from the sender;
 * also git's own completion of it (index-pack --fix-thin in a copy of the receiver).
 */
function thinCase(sender: string, want: string, have: string, ofs: boolean) {
  const receiver = emptyRepo();
  const haveObjects = git(sender, ["rev-list", "--objects", have]);
  git(
    receiver,
    ["index-pack", "--stdin"],
    git(sender, ["pack-objects", "--stdout", "-q"], haveObjects),
  );
  const args = ["pack-objects", "--revs", "--thin", "--stdout", "-q"];
  if (ofs) args.push("--delta-base-offset");
  const thin = new Uint8Array(git(sender, args, `${want}\n^${have}\n`));
  const ref = tmp();
  cpSync(receiver, ref, { recursive: true });
  const before = new Set(packFiles(ref));
  git(ref, ["index-pack", "--fix-thin", "--stdin"], thin);
  const name = packFiles(ref).find((n) => n.endsWith(".pack") && !before.has(n)) as string;
  return { receiver, thin, gitPack: join(packDirOf(ref), name) };
}

describe("thin packs completed through externalBase (git's --fix-thin)", () => {
  const sender = repoWithHistory(30);
  const cases: [string, string, string, string, boolean][] = [
    ["REF_DELTA, last 5 commits of 30", sender, "HEAD", "HEAD~5", false],
    ["OFS_DELTA, last 5 commits of 30", sender, "HEAD", "HEAD~5", true],
    ["one commit on top", sender, "HEAD", "HEAD~1", true],
    ["a ~4 MiB blob edited by one byte", withBig, "HEAD", "HEAD~1", true],
  ];
  for (const [name, from, want, have, ofs] of cases) {
    it(name, async () => {
      const { receiver, thin, gitPack } = thinCase(from, want, have, ofs);
      // the bases come from a second repository: a copy of the receiver
      const second = tmp();
      cpSync(receiver, second, { recursive: true });
      const externalBase = repoBase(second);
      const before = new Set(packFiles(receiver));
      const r = await installPack(filesOf(receiver), PACK_DIR, chunks(thin), { externalBase });
      expect(r.appended).toBeGreaterThan(0);
      expect(new Set(externalBase.calls).size).toBe(externalBase.calls.length); // once per id
      expect(packFiles(receiver).filter((n) => !before.has(n))).toEqual([
        `pack-${r.packId}.idx`,
        `pack-${r.packId}.pack`,
      ]);
      const ours = join(packDirOf(receiver), `pack-${r.packId}.pack`);
      const bytes = new Uint8Array(readFileSync(ours));
      expect(Buffer.from(bytes.subarray(bytes.length - 20)).toString("hex")).toBe(r.packId);
      // our idx is git's for our completed pack
      const idx = new Uint8Array(readFileSync(ours.replace(/\.pack$/, ".idx")));
      expect(same(idx, gitIdx(bytes))).toBe(true);
      // git's objects, and git's appended bases in git's order with git's types
      const mine = verifyPack(ours);
      const theirs = verifyPack(gitPack);
      expect(mine.map((e) => e.oid).sort()).toEqual(theirs.map((e) => e.oid).sort());
      const tail = (l: typeof mine) =>
        l.filter((e) => e.offset >= thin.length - 20).map((e) => `${e.type} ${e.oid}`);
      expect(tail(mine)).toEqual(tail(theirs));
      expect(tail(mine).length).toBe(r.appended);
      // native git reads it
      git(receiver, ["verify-pack", ours]);
      git(receiver, [
        "update-ref",
        "refs/heads/main",
        git(from, ["rev-parse", want]).toString().trim(),
      ]);
      git(receiver, ["fsck", "--full", "--no-dangling"]);
    }, 120_000);
  }

  it("without externalBase, a thin pack is refused and nothing is installed", async () => {
    const { receiver, thin } = thinCase(sender, "HEAD", "HEAD~1", true);
    const before = packFiles(receiver);
    const err = await installPack(filesOf(receiver), PACK_DIR, chunks(thin)).catch((e) => e);
    expect(err).toBeInstanceOf(PackError);
    expect(String(err)).toMatch(/thin pack/);
    expect(packFiles(receiver)).toEqual(before);
  });

  it("the committed fixture completes to the committed .idx", async () => {
    const fx = (n: string) => join(import.meta.dirname, "..", "fixtures", "thin-pack", n);
    const bases = JSON.parse(readFileSync(fx("bases.json"), "utf8")) as Record<
      string,
      { type: ObjectTypeString; base64: string }
    >;
    const repo = emptyRepo();
    const r = await installPack(
      filesOf(repo),
      PACK_DIR,
      chunks(new Uint8Array(readFileSync(fx("thin.pack"))), 4096),
      {
        externalBase: async (id) => {
          const b = bases[id];
          return b
            ? { type: b.type, data: new Uint8Array(Buffer.from(b.base64, "base64")) }
            : undefined;
        },
      },
    );
    expect(r.appended).toBe(Object.keys(bases).length);
    const idx = readFileSync(join(packDirOf(repo), `pack-${r.packId}.idx`));
    expect(same(idx, readFileSync(fx("completed.idx")))).toBe(true);
  });
});

describe("corrupt packs: refused, nothing left behind", () => {
  const good = variants[0]?.[1] as Uint8Array;
  const flip = (b: Uint8Array, at: number) => {
    const c = b.slice();
    c[at] = (c[at] as number) ^ 0x40;
    return c;
  };
  const cases: [string, Uint8Array][] = [
    ["truncated", good.subarray(0, good.length - 100)],
    ["trailer flipped", flip(good, good.length - 1)],
    ["a compressed byte flipped", flip(good, Math.floor(good.length / 2))],
    ["bytes after the trailer", Uint8Array.of(...good, 1, 2, 3)],
  ];
  for (const [name, bytes] of cases) {
    it(name, async () => {
      const repo = emptyRepo();
      await expect(install(bytes, repo)).rejects.toBeInstanceOf(PackError);
      expect(packFiles(repo)).toEqual([]);
    });
  }
});

describe("hand-built packs: git's idx, or refused like git", () => {
  const enc = new TextEncoder();
  const A = enc.encode("base object A\n".repeat(20));
  const B = enc.encode(`${"base object A\n".repeat(20)}plus B\n`);
  const C = enc.encode(`${"base object A\n".repeat(20)}plus B\nplus C\n`);
  const dAB = craftDelta(A.length, B.length, [...copyAll(A.length), 7, ...enc.encode("plus B\n")]);
  const dBC = craftDelta(B.length, C.length, [...copyAll(B.length), 7, ...enc.encode("plus C\n")]);
  const dBA = craftDelta(B.length, A.length, [...copyAll(A.length)]);
  const cases: [string, Uint8Array][] = [
    ["zero objects", buildPack([])],
    ["pack version 3", buildPack([{ kind: 3, data: A }], { version: 3 })],
    ["object count too high", buildPack([{ kind: 3, data: A }], { count: 2 })],
    [
      "object count too low",
      buildPack(
        [
          { kind: 3, data: A },
          { kind: 3, data: B },
        ],
        { count: 1 },
      ),
    ],
    [
      "the same blob twice",
      buildPack([
        { kind: 3, data: A },
        { kind: 3, data: A },
      ]),
    ],
    [
      "REF_DELTA on a REF_DELTA",
      buildPack([
        { kind: 3, data: A },
        { kind: 7, data: dAB, baseOid: oidOf("blob", A) },
        { kind: 7, data: dBC, baseOid: oidOf("blob", B) },
      ]),
    ],
    [
      "REF_DELTA before its base (forward reference)",
      buildPack([
        { kind: 7, data: dAB, baseOid: oidOf("blob", A) },
        { kind: 3, data: A },
      ]),
    ],
    [
      "OFS_DELTA on a REF_DELTA",
      buildPack([
        { kind: 3, data: A },
        { kind: 7, data: dAB, baseOid: oidOf("blob", A) },
        { kind: 6, data: dBC, baseIdx: 1 },
      ]),
    ],
    [
      "REF_DELTA cycle",
      buildPack([
        { kind: 7, data: dAB, baseOid: oidOf("blob", B) },
        { kind: 7, data: dBA, baseOid: oidOf("blob", A) },
      ]),
    ],
    [
      "duplicate base, each with REF_DELTA children",
      buildPack([
        { kind: 3, data: A },
        { kind: 3, data: A },
        { kind: 7, data: dAB, baseOid: oidOf("blob", A) },
      ]),
    ],
    [
      "OFS_DELTA base before the pack start",
      buildPack([
        { kind: 3, data: A },
        { kind: 6, data: dAB, back: 5000 },
      ]),
    ],
    [
      "an entry inflating past its declared size",
      buildPack([{ kind: 3, data: new Uint8Array(4096), sizeOverride: 10 }]),
    ],
    [
      "a delta whose copy runs past its base",
      buildPack([
        { kind: 3, data: A },
        {
          kind: 7,
          data: craftDelta(A.length, A.length + 1, copyAll(A.length + 1)),
          baseOid: oidOf("blob", A),
        },
      ]),
    ],
  ];
  for (const [name, pack] of cases) {
    it(name, async () => {
      const d = tmp();
      writeFileSync(join(d, "p.pack"), pack);
      const g = spawnSync("git", ["index-pack", "-o", join(d, "p.idx"), join(d, "p.pack")], {
        env: GIT_ENV,
        encoding: "utf8",
      });
      const repo = emptyRepo();
      if (g.status !== 0 && name.startsWith("duplicate base")) {
        // git 2.43 refuses this pack ("already resolved (duplicate base)"), later git accepts
        // it; we follow later git: the delta resolves to the same object
        const { result } = await install(pack, repo);
        expect(result.count).toBe(3);
      } else if (g.status === 0) {
        const { idx } = await install(pack, repo);
        expect(same(idx, readFileSync(join(d, "p.idx"))), "idx").toBe(true);
      } else {
        await expect(install(pack, repo), `git: ${g.stderr.trim()}`).rejects.toBeInstanceOf(
          PackError,
        );
        expect(packFiles(repo)).toEqual([]);
      }
    });
  }
});
