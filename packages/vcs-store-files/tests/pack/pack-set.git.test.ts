/**
 * Reading packs against native git: every object of git-made packs read through `openPackSet`
 * equals `git cat-file --batch`, and `createGitFilesBackend` reads a repository split across
 * loose objects and packs (packs first, as git and JGit), including packs git writes after open.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { type FilesApi, installPack, openPackSet } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createGitFilesBackend } from "../../src/index.js";

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
const gitText = (cwd: string, args: string[], input?: string) =>
  git(cwd, args, input).toString().trim();

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "pack-set-"));
  dirs.push(d);
  return d;
};
const emptyRepo = () => {
  const d = tmp();
  git(d, ["init", "-q", "--initial-branch=main", "."]);
  return d;
};
const PACK_DIR = ".git/objects/pack";
const filesOf = (repo: string): FilesApi => createNodeFilesApi({ rootDir: repo });
async function* chunks(bytes: Uint8Array, size = 65536) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
async function collect(s: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const c of s) parts.push(c);
  return Buffer.concat(parts);
}

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

/** A repository with `commits` commits editing a few text files (deltas between versions). */
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

/** Every object of the repository through `git cat-file --batch-all-objects --batch`. */
function allObjects(repo: string): Map<string, { type: string; content: Buffer }> {
  const out = git(repo, ["cat-file", "--batch-all-objects", "--batch"]);
  const map = new Map<string, { type: string; content: Buffer }>();
  let p = 0;
  while (p < out.length) {
    const nl = out.indexOf(10, p);
    const [oid, type, size] = out.subarray(p, nl).toString().split(" ");
    const start = nl + 1;
    const end = start + Number(size);
    map.set(oid as string, { type: type as string, content: out.subarray(start, end) });
    p = end + 1;
  }
  return map;
}

describe("openPackSet: every object of git-made packs equals git cat-file", () => {
  const history = repoWithHistory(60);
  const withBig = repoWithHistory(3, { bigBlobBytes: 4 * 2 ** 20 });
  const aggressive = (() => {
    const r = repoWithHistory(40);
    git(r, ["gc", "-q", "--aggressive"]);
    const dir = join(r, PACK_DIR);
    const p = readdirSync(dir).find((n) => n.endsWith(".pack")) as string;
    return new Uint8Array(readFileSync(join(dir, p)));
  })();
  const variants: [string, Uint8Array][] = [
    ["OFS_DELTA", packAll(history, true)],
    ["REF_DELTA", packAll(history, false)],
    ["gc --aggressive", aggressive],
    ["a 4 MiB blob with a delta child", packAll(withBig, true)],
  ];
  for (const [name, pack] of variants) {
    it(name, async () => {
      const repo = emptyRepo();
      const files = filesOf(repo);
      const r = await installPack(files, PACK_DIR, chunks(pack));
      const set = await openPackSet(files, PACK_DIR);
      const expected = allObjects(repo);
      expect(expected.size).toBe(r.count);
      expect(set.skipped).toEqual([]);
      for (const [oid, e] of expected) {
        const o = await set.get(oid);
        expect(o?.type, oid).toBe(e.type);
        expect(o?.size, oid).toBe(e.content.length);
        expect((await collect(o?.content ?? [])).equals(e.content), oid).toBe(true);
      }
      const listed: string[] = [];
      for await (const id of set.list()) listed.push(id);
      expect(new Set(listed)).toEqual(new Set(expected.keys()));
    }, 120_000);
  }
});

describe("createGitFilesBackend over packs and loose objects", () => {
  it("reads every object of a repository split across loose objects and two packs", async () => {
    const repo = repoWithHistory(20);
    git(repo, ["repack", "-q", "-d"]); // pack 1: everything so far
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(repo, `extra-${i}.txt`), `extra ${i}\n`.repeat(50));
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", `extra ${i}`]);
    }
    git(repo, ["repack", "-q", "-d"]); // pack 2: the loose objects of the extra commits
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(repo, `loose-${i}.txt`), `loose ${i}\n`);
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", `loose ${i}`]);
    }
    expect(readdirSync(join(repo, PACK_DIR)).filter((n) => n.endsWith(".idx")).length).toBe(2);
    const { objects, packs } = await createGitFilesBackend({ files: filesOf(repo) });
    expect((await packs.packs()).length).toBe(2);
    const expected = allObjects(repo);
    for (const [oid, e] of expected) {
      expect(await objects.has(oid), oid).toBe(true);
      const o = await objects.get(oid, { verify: true });
      expect(o?.type, oid).toBe(e.type);
      expect((await collect(o?.content ?? [])).equals(e.content), oid).toBe(true);
    }
    const listed: string[] = [];
    for await (const id of objects.list()) listed.push(id);
    expect(listed.length).toBe(new Set(listed).size);
    expect(new Set(listed)).toEqual(new Set(expected.keys()));
    const absent = "0123456789abcdef0123456789abcdef01234567";
    expect(await objects.has(absent)).toBe(false);
    expect(await objects.get(absent)).toBeUndefined();
  }, 120_000);

  it("getRaw of a packed delta is its header and content", async () => {
    const repo = repoWithHistory(4);
    git(repo, ["gc", "-q", "--aggressive", "--prune=now"]);
    const { objects } = await createGitFilesBackend({ files: filesOf(repo) });
    const id = gitText(repo, ["rev-parse", "HEAD~3:file0.txt"]);
    const content = git(repo, ["cat-file", "blob", id]);
    const raw = await collect(objects.getRaw(id));
    expect(raw.equals(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]))).toBe(
      true,
    );
  });

  it("finds a pack native git writes after the backend was opened", async () => {
    const repo = repoWithHistory(2);
    git(repo, ["repack", "-q", "-a", "-d"]);
    const { objects } = await createGitFilesBackend({ files: filesOf(repo) });
    const before = gitText(repo, ["rev-parse", "HEAD"]);
    expect(await objects.has(before)).toBe(true);
    // new objects, packed by git (the loose copies removed) after open
    writeFileSync(join(repo, "later.txt"), "written later\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "later"]);
    git(repo, ["repack", "-q", "-d"]);
    git(repo, ["prune-packed"]);
    const head = gitText(repo, ["rev-parse", "HEAD"]);
    const blob = gitText(repo, ["rev-parse", "HEAD:later.txt"]);
    expect(existsSync(join(repo, ".git/objects", blob.slice(0, 2), blob.slice(2)))).toBe(false);
    const o = await objects.get(blob, { verify: true });
    expect((await collect(o?.content ?? [])).toString()).toBe("written later\n");
    expect(await objects.has(head)).toBe(true);
  });

  it("streams a large packed blob in more than one chunk", async () => {
    const repo = emptyRepo();
    writeFileSync(join(repo, "big"), noise(4 * 2 ** 20, 11));
    const id = gitText(repo, ["hash-object", "-w", "big"]);
    git(repo, ["pack-objects", "-q", `${PACK_DIR}/pack`], `${id}\n`);
    git(repo, ["prune-packed"]);
    const { objects } = await createGitFilesBackend({ files: filesOf(repo) });
    const o = await objects.get(id, { verify: true });
    let n = 0;
    let bytes = 0;
    for await (const c of o?.content ?? []) {
      n++;
      bytes += c.length;
    }
    expect(bytes).toBe(4 * 2 ** 20);
    expect(n).toBeGreaterThan(1);
  });

  it("reads packs before loose objects (a corrupt loose copy of a packed object is not read)", async () => {
    const repo = emptyRepo();
    const id = gitText(repo, ["hash-object", "-w", "--stdin"], "the packed copy\n");
    git(repo, ["pack-objects", "-q", `${PACK_DIR}/pack`], `${id}\n`);
    // the loose copy left in place, overwritten with another object's bytes
    const loose = join(repo, ".git/objects", id.slice(0, 2), id.slice(2));
    chmodSync(loose, 0o644);
    writeFileSync(loose, deflateSync(Buffer.from("blob 13\0the bad copy\n")));
    const { objects } = await createGitFilesBackend({ files: filesOf(repo) });
    const o = await objects.get(id, { verify: true });
    expect((await collect(o?.content ?? [])).toString()).toBe("the packed copy\n");
    expect((await collect(objects.getRaw(id))).toString()).toBe("blob 16\0the packed copy\n");
  });
});
