/**
 * Split index (`link`) against native git: an index split by git is read with its shared
 * index, and what we write (split or not) is read back by git with the same entries; the
 * same edit on twin repositories gives the same index and shared index bytes, stat data
 * apart.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import {
  createGitStaging,
  type IndexSettings,
  parseIndexFile,
  parseLinkExtension,
  type Staging,
} from "../../src/staging/index.js";

const baseEnv = (home: string) => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
});

/** The native git on PATH (2.43 locally, 2.5x on CI). */
const VERSIONS: { name: string; path: string }[] = [{ name: "git", path: process.env.PATH ?? "" }];

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A clock second never used before: files and indexes are dated there, far from racy-git. */
let clock = 1_600_000_000;
const nextSecond = () => {
  clock += 10;
  return clock;
};

function gitIn(pathEnv: string) {
  return (cwd: string, args: string[], extra: Record<string, string> = {}) =>
    execFileSync("git", args, {
      cwd,
      env: { ...baseEnv(cwd), PATH: pathEnv, ...extra },
      maxBuffer: 1 << 30,
    })
      .toString()
      .trim();
}

/** Date every file of the worktree (not .git) back to a fixed second, so no entry is racy. */
function dateWorktree(dir: string, second: number): void {
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    if (name === ".git" || name.startsWith(".git/")) continue;
    utimesSync(join(dir, name), second, second);
  }
}

/** A repository of `count` files, committed, with core.trustctime off (ctime cannot be dated). */
function repo(git: ReturnType<typeof gitIn>, count = 10): string {
  const dir = tempDir("split-index-");
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  git(dir, ["config", "core.trustctime", "false"]);
  for (let i = 1; i <= count; i++) writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
  writeFileSync(join(dir, "sub/a.txt".replace("sub/", "")), "a\n");
  dateWorktree(dir, nextSecond());
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function sharedIndexes(dir: string): string[] {
  return readdirSync(join(dir, ".git"))
    .filter((n) => n.startsWith("sharedindex."))
    .sort();
}

async function openStaging(dir: string, settings: IndexSettings = {}): Promise<Staging> {
  const staging = createGitStaging(createNodeFilesApi({ rootDir: dir }), ".git/index");
  staging.setIndexHost?.({ settings: () => settings });
  await staging.read();
  return staging;
}

/** A copy of a repository (git's read-only files made writable). */
function twin(dir: string): string {
  const copy = tempDir("split-twin-");
  cpSync(dir, copy, { recursive: true, preserveTimestamps: true });
  for (const name of readdirSync(join(copy, ".git"))) {
    if (name === "index" || name.startsWith("sharedindex."))
      chmodSync(join(copy, ".git", name), 0o644);
  }
  return copy;
}

for (const version of VERSIONS) {
  const git = gitIn(version.path);
  describe(`split index with ${version.name}`, () => {
    it("reads an index git split, and git reads back what we write", async () => {
      const dir = repo(git);
      git(dir, ["update-index", "--split-index"]);
      const listed = git(dir, ["ls-files", "-s"]);
      const staging = await openStaging(dir);
      const ours = [];
      for await (const e of staging.entries())
        ours.push(`${e.mode.toString(8)} ${e.objectId} ${e.stage}\t${e.path}`);
      expect(ours.join("\n")).toBe(listed);
      await staging.removeEntry("f3.txt");
      await staging.write();
      const parsed = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
      expect(parsed.extensions[0]).toBe("link");
      expect(git(dir, ["ls-files", "-s"])).toBe(
        listed
          .split("\n")
          .filter((l) => !l.endsWith("\tf3.txt"))
          .join("\n"),
      );
      expect(git(dir, ["status", "--porcelain"])).toBe("D  f3.txt\n?? f3.txt");
    });

    it("an edit gives the bytes git writes for it, index and shared index", async () => {
      const dir = repo(git);
      git(dir, ["update-index", "--split-index"]);
      dateWorktree(dir, nextSecond());
      git(dir, ["update-index", "--refresh"]);
      const ours = twin(dir);
      const theirs = twin(dir);
      // the same change in both: f3.txt modified and staged, f4.txt removed, new.txt added
      for (const d of [ours, theirs]) {
        writeFileSync(join(d, "f3.txt"), "changed\n");
        writeFileSync(join(d, "new.txt"), "new\n");
        const s = nextSecond();
        dateWorktree(d, s);
        clock -= 10;
      }
      clock += 10;
      git(theirs, ["update-index", "--add", "--remove", "f3.txt", "new.txt"]);
      git(theirs, ["update-index", "--force-remove", "f4.txt"]);
      const staging = await openStaging(ours);
      const stat = (p: string) => statSync(join(ours, p), { bigint: true });
      for (const p of ["f3.txt", "new.txt"]) {
        const st = stat(p);
        const objectId = git(ours, ["hash-object", "-w", p]);
        await staging.setEntry({
          path: p,
          mode: 0o100644,
          objectId,
          size: Number(st.size),
          mtime: Number(st.mtimeMs),
          mtimeNs: Number(st.mtimeNs % 1_000_000_000n),
          ctime: Number(st.ctimeMs),
          ctimeNs: Number(st.ctimeNs % 1_000_000_000n),
          dev: Number(st.dev),
          ino: Number(st.ino),
          uid: Number(st.uid),
          gid: Number(st.gid),
        });
      }
      await staging.removeEntry("f4.txt");
      await staging.write();
      expect(sharedIndexes(ours)).toEqual(sharedIndexes(theirs));
      const a = await parseIndexFile(new Uint8Array(readFileSync(join(ours, ".git/index"))));
      const b = await parseIndexFile(new Uint8Array(readFileSync(join(theirs, ".git/index"))));
      expect(a.extensions).toEqual(b.extensions);
      const linkA = parseLinkExtension(a.extensionData[0]?.data as Uint8Array);
      const linkB = parseLinkExtension(b.extensionData[0]?.data as Uint8Array);
      expect(linkA).toEqual(linkB);
      expect(a.entries.map((e) => [e.path, e.objectId, e.mode])).toEqual(
        b.entries.map((e) => [e.path, e.objectId, e.mode]),
      );
      expect(git(ours, ["ls-files", "-s"])).toBe(git(theirs, ["ls-files", "-s"]));
    });
  });
}
