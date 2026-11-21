/**
 * `git clone <path>` against native git (2.43 and 2.5x): a local repository path is cloned as
 * clone.c's `clone_local` does: its objects directory copied (loose objects, packs, info files
 * byte for byte), its `objects/info/alternates` entries carried over as absolute paths, the
 * refs listed through the transport; `--reference` still copies, `--no-local` fetches,
 * `--depth` is ignored with git's warning. (A shallow source is fetched instead, as git does,
 * but serving a fetch from a shallow repository is not implemented: no twin.)
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { copyLocalObjects } from "../src/commands/local-clone.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

function fresh(prefix: string): string {
  const dir = join(root, `${prefix}${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function repoWith(dir: string, names: string[], init = true): string {
  if (init) git(root, "init", "-q", "-b", "main", dir);
  for (const name of names) {
    putFile(dir, `${name}.txt`, `${name}\n`);
    git(dir, "add", `${name}.txt`);
    git(dir, "commit", "-qm", name);
  }
  return dir;
}

/** Every file below `dir` (relative path → content hash), `info/alternates` left out. */
function filesOf(dir: string, skip = new Set(["info/alternates"])): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    const abs = rel ? join(dir, rel) : dir;
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (!skip.has(r)) {
        out.set(
          r,
          createHash("sha1")
            .update(readFileSync(join(dir, r)))
            .digest("hex"),
        );
      }
    }
  };
  walk("");
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Object ids in the objects directory itself (loose and packed). */
function objectIds(repo: string): string[] {
  const out = git(
    repo,
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname)",
    "--unordered",
  );
  return out.split("\n").filter(Boolean).sort();
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

/** The repository state git's clone leaves (objects aside). */
function stateOf(repo: string) {
  const gitDir = join(repo, ".git");
  return {
    head: read(join(gitDir, "HEAD")),
    // (git's initial ref transaction writes packed-refs, ours loose refs: the values compared)
    refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname) %(symref)"),
    config: read(join(gitDir, "config")),
    alternates: read(join(gitDir, "objects/info/alternates")),
    shallow: read(join(gitDir, "shallow")),
  };
}

async function ourClone(
  o: string,
  configure: (c: ReturnType<Awaited<ReturnType<typeof openOurs>>["clone"]>) => void,
) {
  git(root, "init", "-q", "-b", "main", o);
  const g = await openOurs(
    root,
    createNodeGitHostEnvironment({ env: testEnv(root) }),
    undefined,
    o.slice(root.length + 1),
  );
  const c = g.clone();
  configure(c);
  return c.call();
}

/** git's warning lines on stderr. */
const warnings = (stderr: string) =>
  stderr
    .split("\n")
    .filter((l) => l.startsWith("warning: "))
    .map((l) => `${l}\n`);

describeGit("local clone (clone_local), as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "clone-local-native-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A source with a pack, a commit-graph, loose objects, a tag and a relative alternate. */
  function source() {
    const dir = fresh("src");
    const other = repoWith(join(dir, "other"), ["o1"]);
    const src = repoWith(join(dir, "src"), ["s1", "s2"]);
    git(src, "repack", "-q", "-a", "-d");
    git(src, "commit-graph", "write", "--reachable");
    repoWith(src, ["s3"], false);
    git(src, "tag", "-a", "-m", "tag", "v1");
    git(src, "branch", "side", "HEAD~1");
    putFile(src, ".git/objects/info/alternates", "# borrowed\n../../../other/.git/objects\n\n");
    return { dir, src, other };
  }

  it("copies the objects directory and carries the alternates over as absolute paths", async () => {
    const { dir, src, other } = source();
    const n = join(dir, "n");
    const o = join(dir, "o");
    const theirs = gitRun(root, dir, ["clone", "-q", src, n]);
    expect(theirs.status).toBe(0);
    const result = await ourClone(o, (c) => c.setURI(src));
    expect(result.messages ?? []).toEqual([]);
    expect(filesOf(join(o, ".git/objects"))).toEqual(filesOf(join(n, ".git/objects")));
    // byte for byte the source's: loose objects, the pack, info/packs, the commit-graph
    expect(filesOf(join(n, ".git/objects"))).toEqual(filesOf(join(src, ".git/objects")));
    expect(stateOf(o)).toEqual(stateOf(n));
    expect(stateOf(n).alternates).toBe(`${join(other, ".git/objects")}\n`);
    expect(git(o, "status", "--porcelain")).toBe("");
    git(o, "fsck", "--no-progress");
  });

  it("--no-local fetches (a pack, no alternates carried)", async () => {
    const { dir, src } = source();
    const n = join(dir, "n");
    const o = join(dir, "o");
    git(dir, "clone", "-q", "--no-local", src, n);
    await ourClone(o, (c) => c.setURI(src).setLocal(false));
    expect(stateOf(o)).toEqual(stateOf(n));
    expect(stateOf(n).alternates).toBeUndefined();
    expect(objectIds(o)).toEqual(objectIds(n));
    const loose = (repo: string) =>
      [...filesOf(join(repo, ".git/objects")).keys()].filter((p) => /^[0-9a-f]{2}\//.test(p));
    expect(loose(o)).toEqual([]);
    expect(loose(n)).toEqual([]);
  });

  it("--reference writes the reference's alternate and still copies; --no-hardlinks the same", async () => {
    const { dir, src, other } = source();
    const ref = join(dir, "ref");
    git(dir, "clone", "-q", "--no-local", src, ref);
    const n = join(dir, "n");
    const o = join(dir, "o");
    git(dir, "clone", "-q", "--no-hardlinks", "--reference", ref, src, n);
    await ourClone(o, (c) => c.setURI(src).addReference(ref).setNoHardlinks(true));
    expect(filesOf(join(o, ".git/objects"))).toEqual(filesOf(join(n, ".git/objects")));
    expect(stateOf(o)).toEqual(stateOf(n));
    expect(stateOf(n).alternates).toBe(
      `${join(ref, ".git/objects")}\n${join(other, ".git/objects")}\n`,
    );
  });

  it("--depth, --shallow-since are ignored with git's warnings; --local of a URL warns", async () => {
    const { dir, src } = source();
    const n = join(dir, "n");
    const o = join(dir, "o");
    const theirs = gitRun(root, dir, [
      "clone",
      "-q",
      "--depth=1",
      "--shallow-since=2000-01-01",
      src,
      n,
    ]);
    expect(theirs.status).toBe(0);
    const result = await ourClone(o, (c) =>
      c.setURI(src).setDepth(1).setShallowSince(new Date("2000-01-01T00:00:00Z")),
    );
    expect(result.messages ?? []).toEqual(warnings(theirs.stderr));
    expect(warnings(theirs.stderr).length).toBe(2);
    expect(stateOf(o)).toEqual(stateOf(n));
    expect(filesOf(join(o, ".git/objects"))).toEqual(filesOf(join(n, ".git/objects")));

    const n2 = join(dir, "n2");
    const o2 = join(dir, "o2");
    const url = gitRun(root, dir, ["clone", "-q", "--local", `file://${src}`, n2]);
    const ours = await ourClone(o2, (c) => c.setURI(`file://${src}`).setLocal(true));
    expect(ours.messages ?? []).toEqual(warnings(url.stderr));
    expect(warnings(url.stderr)).toEqual(["warning: --local is ignored\n"]);
    expect(objectIds(o2)).toEqual(objectIds(n2));
  });

  it("a linked worktree of a shallow repository is cloned locally (clone.c checks its own git directory)", async () => {
    const dir = fresh("shallowwt");
    const up = repoWith(join(dir, "up"), ["u1", "u2", "u3"]);
    const src = join(dir, "src");
    git(dir, "clone", "-q", "--depth=1", `file://${up}`, src);
    const wt = join(dir, "wt");
    git(src, "worktree", "add", "-q", wt, "-b", "wtb");
    // get_repo_path answers the gitfile's target (.git/worktrees/wt): no `shallow` there, so
    // git copies the objects locally without a warning (the shallow source itself is fetched)
    const n = join(dir, "n");
    const o = join(dir, "o");
    const theirs = gitRun(root, dir, ["clone", "-q", "--local", wt, n]);
    expect(theirs.status).toBe(0);
    expect(warnings(theirs.stderr)).toEqual([]);
    const result = await ourClone(o, (c) => c.setURI(wt).setLocal(true));
    expect(result.messages ?? []).toEqual([]);
    expect(filesOf(join(o, ".git/objects"))).toEqual(filesOf(join(n, ".git/objects")));
    expect(filesOf(join(n, ".git/objects"))).toEqual(filesOf(join(src, ".git/objects")));
    expect(stateOf(o).shallow).toBe(stateOf(n).shallow);
  });

  it("refuses a source whose objects directory is a symlink, naming its absolute path", async () => {
    const dir = fresh("objlink");
    const src = repoWith(join(dir, "src"), ["s1"]);
    renameSync(join(src, ".git/objects"), join(dir, "objects"));
    symlinkSync("../../objects", join(src, ".git/objects"));
    const theirs = gitRun(root, dir, ["clone", "-q", src, join(dir, "n")]);
    expect(theirs.status).toBe(128);
    expect(theirs.stderr).toBe(
      `fatal: '${join(src, ".git/objects")}' is a symlink, refusing to clone with --local\n`,
    );
    // (our worktree opens no repository whose objects directory is a link, so the copy is
    // driven directly, as clone's localObjectsCopy calls it)
    const files = createNodeFilesApi({ rootDir: root });
    const rel = (p: string) => p.slice(root.length + 1);
    await expect(
      copyLocalObjects({
        source: {
          files,
          objectsDir: rel(join(src, ".git/objects")),
          repo: join(src, ".git"),
          objectsPath: join(src, ".git/objects"),
        },
        target: { files, objectsDir: rel(join(dir, "o/.git/objects")) },
        addAlternate: async () => {},
      }),
    ).rejects.toThrow(theirs.stderr.trimEnd());
  });
});
