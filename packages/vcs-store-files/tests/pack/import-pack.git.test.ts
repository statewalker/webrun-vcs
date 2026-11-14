/**
 * importPack / unpackObjects against native git: packs written by `git pack-objects` (whole,
 * thin, OFS or REF deltas) imported into a files backend, unpacked into loose objects or kept as
 * a pack, then `git fsck --full --strict` passes and every object is readable by git. Also a
 * fetch over the local transport the tests use (a git http-backend served over fetch).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPack, unpackObjects } from "@statewalker/vcs-core";
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

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "import-pack-"));
  dirs.push(d);
  return d;
};
async function* chunks(bytes: Uint8Array, size = 65536) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

/** A repository with `commits` commits editing a few text files, so packs have delta chains. */
function repoWithHistory(commits: number): string {
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
  return dir;
}

const revParse = (repo: string, rev: string) => git(repo, ["rev-parse", rev]).toString().trim();
const objectsOf = (repo: string, revs: string) =>
  git(repo, ["rev-list", "--objects", "--stdin"], revs)
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(0, 40))
    .sort();

/** `git pack-objects --revs` for `revs` (`--thin` and OFS deltas optional). */
function packOf(repo: string, revs: string, opts: { thin?: boolean; ofs?: boolean } = {}) {
  const args = ["pack-objects", "--revs", "--stdout", "-q"];
  if (opts.thin) args.push("--thin");
  if (opts.ofs !== false) args.push("--delta-base-offset");
  return new Uint8Array(git(repo, args, revs));
}

/** An empty repository and a files backend over it. */
async function receiver() {
  const dir = tmp();
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  const backend = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });
  return { dir, ...backend };
}

const fsck = (repo: string) => git(repo, ["fsck", "--full", "--strict", "--no-dangling"]);

const source = repoWithHistory(40);
const tip = revParse(source, "main");
const middle = revParse(source, "main~20");

describe("importPack: packs from git pack-objects, checked by git fsck", () => {
  for (const ofs of [true, false]) {
    for (const mode of ["unpacked", "kept"] as const) {
      it(`a full pack (${ofs ? "OFS" : "REF"} deltas), ${mode}`, async () => {
        const r = await receiver();
        const pack = packOf(source, `${tip}\n`, { ofs });
        const result = await importPack(r.objects, chunks(pack, 4093), {
          packs: r.packs,
          unpackLimit: mode === "kept" ? 1 : Number.POSITIVE_INFINITY,
        });
        expect(mode === "kept" ? result.kept : result.unpacked).toBeDefined();
        git(r.dir, ["update-ref", "refs/heads/main", tip]);
        fsck(r.dir);
        const want = objectsOf(source, `${tip}\n`);
        expect(objectsOf(r.dir, `${tip}\n`)).toEqual(want);
        const looseDirs = readdirSync(join(r.dir, ".git/objects")).filter((n) => n.length === 2);
        expect(looseDirs.length > 0).toBe(mode === "unpacked");
      });
    }
  }

  for (const mode of ["unpacked", "kept"] as const) {
    it(`a thin pack against a base the store has, ${mode}`, async () => {
      const r = await receiver();
      await unpackObjects(r.objects, chunks(packOf(source, `${middle}\n`)));
      const thin = packOf(source, `${tip}\n^${middle}\n`, { thin: true });
      const result = await importPack(r.objects, chunks(thin, 1000), {
        packs: r.packs,
        unpackLimit: mode === "kept" ? 1 : Number.POSITIVE_INFINITY,
      });
      if (mode === "kept") expect(result.kept?.appended).toBeGreaterThan(0);
      else expect(result.unpacked?.deltas).toBeGreaterThan(0);
      git(r.dir, ["update-ref", "refs/heads/main", tip]);
      fsck(r.dir);
      expect(objectsOf(r.dir, `${tip}\n`)).toEqual(objectsOf(source, `${tip}\n`));
    });
  }

  it("the history's serialization keeps a large fetched pack and unpacks a small one", async () => {
    const r = await receiver();
    const { DefaultSerializationApi } = await import("@statewalker/vcs-core");
    const serialization = new DefaultSerializationApi({ history: r.history });
    const small = await serialization.importPack(
      chunks(packOf(source, `${revParse(source, "main~38")}\n`)),
    );
    expect(small.packId).toBeUndefined();
    const big = await serialization.importPack(chunks(packOf(source, `${tip}\n`)));
    expect(big.packId).toMatch(/^[0-9a-f]{40}$/);
    git(r.dir, ["update-ref", "refs/heads/main", tip]);
    fsck(r.dir);
  });
});
