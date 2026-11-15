/**
 * writePack against native git: packs written from a files backend over a repository native git
 * built (loose objects, or packs reused entry by entry) are accepted by `git index-pack --strict`
 * and `git verify-pack -v`, and the objects they carry pass `git fsck --full --strict`. Thin
 * packs complete with `index-pack --fix-thin` against the receiver's objects.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ListedObject, listObjects, writePack } from "@statewalker/vcs-core";
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
const git = (cwd: string, args: string[], input?: Uint8Array, env = GIT_ENV) =>
  execFileSync("git", args, { cwd, env, input, maxBuffer: 1 << 30 });

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "write-pack-"));
  dirs.push(d);
  return d;
};

/** A repository with `commits` commits editing a few text files, so there are deltas to find. */
function repoWithHistory(commits: number, packed: boolean): string {
  const dir = tmp();
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i}: lorem ipsum dolor sit amet`);
  for (let c = 0; c < commits; c++) {
    for (let f = 0; f < 3; f++) {
      const edit = [...lines];
      for (let k = 0; k <= c; k++) edit[(k * 37 + f * 11) % edit.length] = `edited ${c}/${k} ${f}`;
      writeFileSync(join(dir, `file${f}.txt`), `${edit.join("\n")}\n`);
    }
    git(dir, ["add", "-A"]);
    const date = `${1700000000 + c * 60} +0000`;
    git(dir, ["commit", "-q", "-m", `commit ${c}`], undefined, {
      ...GIT_ENV,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
  }
  if (packed) git(dir, ["repack", "-adq"]);
  return dir;
}

const revParse = (repo: string, rev: string) => git(repo, ["rev-parse", rev]).toString().trim();
const objectsOf = (repo: string, revs: string) =>
  git(repo, ["rev-list", "--objects", "--stdin"], new TextEncoder().encode(revs))
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(0, 40))
    .sort();

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of chunks) parts.push(c);
  return new Uint8Array(Buffer.concat(parts));
}

/** Our pack of what `wants` reach and `haves` do not, from a files backend over `repo`. */
async function ourPack(
  repo: string,
  wants: string[],
  haves: string[],
  options: Parameters<typeof writePack>[2] & { thinBases?: boolean } = {},
) {
  const backend = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: repo }) });
  const listed: ListedObject[] = [];
  const boundary: ListedObject[] = [];
  for await (const o of listObjects(backend.objects, {
    wants,
    haves,
    onBoundary: (b) => boundary.push(b),
  })) {
    listed.push(o);
  }
  const kinds: number[] = [];
  const reused: boolean[] = [];
  const bytes = await collect(
    writePack(backend.objects, listed, {
      packs: backend.packs,
      ...(options.thinBases ? { thin: true, haves: boundary } : {}),
      ...options,
      onEntry: (e) => {
        kinds.push(e.kind);
        reused.push(e.reused);
      },
    }),
  );
  return { bytes, listed, kinds, reused };
}

/** A fresh repository that indexes `pack` with `git index-pack --strict`, then `verify-pack -v`. */
function indexInto(pack: Uint8Array, args: string[] = [], into?: string) {
  const dir = into ?? tmp();
  if (!into) git(dir, ["init", "-q", "--bare", "."]);
  git(dir, ["index-pack", "--strict", "--stdin", ...args], pack);
  const packDir = join(dir, "objects/pack");
  const idx = readdirSync(packDir).filter((n) => n.endsWith(".idx"));
  const verify = idx.map((n) => git(dir, ["verify-pack", "-v", join(packDir, n)]).toString());
  return { dir, verify };
}

const fsck = (repo: string) => git(repo, ["fsck", "--full", "--strict", "--no-dangling"]);

describe("writePack: packs native git accepts", () => {
  for (const packed of [false, true]) {
    const source = repoWithHistory(30, packed);
    const tip = revParse(source, "main");
    const from = packed ? "packs (reused)" : "loose objects";

    for (const deltaSearch of [false, true]) {
      for (const ofsDelta of [true, false]) {
        it(`from ${from}, search ${deltaSearch ? "on" : "off"}, ${ofsDelta ? "OFS" : "REF"} deltas: index-pack --strict, verify-pack, fsck`, async () => {
          const { bytes, listed, kinds, reused } = await ourPack(source, [tip], [], {
            deltaSearch,
            ofsDelta,
          });
          expect(listed.map((o) => o.id).sort()).toEqual(objectsOf(source, `${tip}\n`));
          const deltas = kinds.filter((k) => k === 6 || k === 7).length;
          if (packed) expect(reused.every(Boolean) || deltaSearch).toBe(true);
          if (packed || deltaSearch) expect(deltas).toBeGreaterThan(30);
          else expect(deltas).toBe(0);
          if (!ofsDelta) expect(kinds).not.toContain(6);
          const { dir, verify } = indexInto(bytes);
          expect(verify.join("")).toMatch(/ok\s*$/m);
          if (deltas) expect(verify.join("")).toMatch(/chain length = 1:/);
          git(dir, ["update-ref", "refs/heads/main", tip]);
          fsck(dir);
          expect(objectsOf(dir, `${tip}\n`)).toEqual(objectsOf(source, `${tip}\n`));
        });
      }
    }
  }

  it("a thin pack completes against the receiver's objects (index-pack --fix-thin)", async () => {
    const source = repoWithHistory(30, false);
    const tip = revParse(source, "main");
    const middle = revParse(source, "main~10");
    // the receiver has everything up to `middle`
    const receiver = tmp();
    git(receiver, ["init", "-q", "--bare", "."]);
    const base = await ourPack(source, [middle], []);
    git(receiver, ["index-pack", "--strict", "--stdin"], base.bytes);
    git(receiver, ["update-ref", "refs/heads/main", middle]);

    const thin = await ourPack(source, [tip], [middle], { deltaSearch: true, thinBases: true });
    expect(thin.kinds.filter((k) => k === 7).length).toBeGreaterThan(0);
    // not complete on its own
    expect(() => indexInto(thin.bytes)).toThrow();
    git(receiver, ["index-pack", "--strict", "--stdin", "--fix-thin"], thin.bytes);
    git(receiver, ["update-ref", "refs/heads/main", tip]);
    fsck(receiver);
    expect(objectsOf(receiver, `${tip}\n`)).toEqual(objectsOf(source, `${tip}\n`));
  });
});
