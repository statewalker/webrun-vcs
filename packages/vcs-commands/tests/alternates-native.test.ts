/**
 * Alternate object directories against native git (2.43 and 2.5x): the files store reads
 * `objects/info/alternates` (relative and absolute entries, nested ones, git's errors for a
 * missing directory and nesting too deep) and `$GIT_ALTERNATE_OBJECT_DIRECTORIES`; reads,
 * abbreviations and fsck see borrowed objects; `repack -a -d` copies them unless `-l`, gc
 * (`repack -d -l`) and prune keep the alternates' objects theirs; `clone --shared`,
 * `--reference`, `--reference-if-able` and `--dissociate` write what git writes; receive-pack
 * advertises the alternates' refs as `.have`.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findAbbrevLengths } from "@statewalker/vcs-core";
import { createGitFilesBackend, FileGcStrategy, gc, repack } from "@statewalker/vcs-store-files";
import { createBasePathResolver, createServedFetchHandler } from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openLocalRemote } from "../src/commands/local-transport.js";
import { type GitApiError, servedRepositoryOf } from "../src/index.js";
import { serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync } from "./native-connect-support.js";
import { nativeGitAvailable, nativeGitHttpBackend } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
let compatibility: "2.43" | "2.56" = "2.43";
let noReferences: string[] = [];
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

/** A fresh directory below the root. */
function fresh(prefix: string): string {
  const dir = join(root, `${prefix}${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A repository at `dir` with commits `names` (one file each). */
function repoWith(dir: string, names: string[], init = true): string {
  if (init) git(root, "init", "-q", "-b", "main", dir);
  for (const name of names) {
    putFile(dir, `${name}.txt`, `${name}\n`);
    git(dir, "add", `${name}.txt`);
    git(dir, "commit", "-qm", name);
  }
  return dir;
}

/** Every object id in the objects directory `objects` itself: loose files and packed ids. */
function localObjects(objects: string): string[] {
  const ids: string[] = [];
  for (const sub of existsSync(objects) ? readdirSync(objects) : []) {
    if (!/^[0-9a-f]{2}$/.test(sub)) continue;
    for (const f of readdirSync(join(objects, sub))) ids.push(sub + f);
  }
  const pack = join(objects, "pack");
  for (const f of existsSync(pack) ? readdirSync(pack) : []) {
    if (!f.endsWith(".idx")) continue;
    const r = spawnSync("git", ["show-index"], { input: readFileSync(join(pack, f)) });
    for (const line of r.stdout.toString().split("\n")) {
      const id = line.split(" ")[1];
      if (id) ids.push(id);
    }
  }
  return [...new Set(ids)].sort();
}

/** Our backend over the repository at `dir` (a FilesApi rooted at the test root). */
function backendOf(dir: string, env: Record<string, string> = {}) {
  const rel = dir.slice(root.length + 1);
  return createGitFilesBackend({
    files: createNodeFilesApi({ rootDir: root }),
    gitDir: `${rel}/.git`,
    environment: createNodeGitHostEnvironment({ env: testEnv(root, env) }),
  });
}

/** git's error lines on stderr, as ours collects them. */
const errorLines = (stderr: string) => stderr.split("\n").filter((l) => l.startsWith("error: "));

describeGit("alternate object directories, as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "alternates-native-"));
    const probe = join(root, "probe");
    git(root, "init", "-q", probe);
    noReferences =
      gitRun(root, probe, ["fsck", "--no-references"]).status === 129 ? [] : ["--no-references"];
    const version = /(\d+)\.(\d+)/.exec(git(probe, "--version"));
    if (version && (Number(version[1]) > 2 || Number(version[2]) >= 45)) compatibility = "2.56";
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reads through relative, absolute and nested alternates", async () => {
    const dir = fresh("chain");
    const deep = repoWith(join(dir, "deep"), ["d1", "d2"]);
    git(deep, "tag", "-a", "-m", "deep tag", "vdeep");
    git(deep, "repack", "-q", "-a", "-d");
    repoWith(deep, ["d3"], false); // and a loose commit beside the pack
    // middle borrows from deep by an absolute path (clone --shared), repo from middle relatively
    const middle = join(dir, "middle");
    git(dir, "clone", "-q", "--shared", deep, middle);
    repoWith(middle, ["m1"], false);
    const repo = join(dir, "repo");
    git(dir, "clone", "-q", "--shared", middle, repo);
    writeFileSync(
      join(repo, ".git/objects/info/alternates"),
      "# borrowed\n../../../middle/.git/objects\n",
    );
    repoWith(repo, ["r1"], false);
    const blob = git(repo, "hash-object", "-w", "--stdin").trim();
    expect(localObjects(join(repo, ".git/objects"))).not.toContain(git(repo, "rev-parse", "vdeep"));

    const { objects, history } = await backendOf(repo);
    const all = git(repo, "rev-list", "--objects", "--all").split("\n").filter(Boolean);
    for (const line of all) {
      const id = line.slice(0, 40);
      expect(await objects.has(id), line).toBe(true);
      const obj = await history.objects?.get(id);
      expect(obj?.type, line).toBe(git(repo, "cat-file", "-t", id).trim());
    }
    expect(await objects.has(blob)).toBe(true);
    expect((await objects.alternates?.list())?.map((a) => a.path)).toEqual([
      join(middle, ".git/objects"),
      join(deep, ".git/objects"),
    ]);
    // log walks the borrowed history
    const g = await openOurs(root, undefined, undefined, repo.slice(root.length + 1));
    const ids: string[] = [];
    for await (const c of await g.log().call()) ids.push(c.id);
    expect(ids.join("\n")).toBe(git(repo, "rev-list", "HEAD").trim());
    // the approximate count adds the alternates' packs (abbreviations take git's length)
    const head = git(repo, "rev-parse", "HEAD").trim();
    const lengths = await findAbbrevLengths(objects, [
      head,
      git(repo, "rev-parse", "vdeep").trim(),
    ]);
    expect(head.slice(0, lengths.get(head))).toBe(git(repo, "rev-parse", "--short", "HEAD").trim());
  });

  it("fsck checks the alternates' objects too (dangling ones listed), as git", async () => {
    const dir = fresh("fsck");
    const alt = repoWith(join(dir, "alt"), ["a1", "a2"]);
    git(alt, "hash-object", "-w", "--stdin"); // nothing: an empty input is the empty blob
    putFile(alt, "dangling.txt", "dangling in the alternate\n");
    git(alt, "hash-object", "-w", "dangling.txt");
    git(alt, "repack", "-q", "-a", "-d");
    putFile(alt, "loose.txt", "loose dangling\n");
    git(alt, "hash-object", "-w", "loose.txt");
    const repo = join(dir, "repo");
    git(dir, "clone", "-q", "--shared", alt, repo);
    repoWith(repo, ["r1"], false);
    putFile(repo, "mine.txt", "dangling here\n");
    git(repo, "hash-object", "-w", "mine.txt");
    for (const args of [[], ["--connectivity-only"], ["--unreachable"]]) {
      const theirs = gitRun(root, repo, ["fsck", ...noReferences, ...args]);
      const files = createNodeFilesApi({ rootDir: root });
      const { history } = await backendOf(repo);
      void history;
      const g = await openOurs(root, undefined, undefined, repo.slice(root.length + 1));
      let cmd = g
        .fsck()
        .setRepositoryFiles({ files, gitDir: `${repo.slice(root.length + 1)}/.git` });
      cmd = cmd.setCompatibility(compatibility);
      if (args.includes("--connectivity-only")) cmd = cmd.setConnectivityOnly(true);
      if (args.includes("--unreachable")) cmd = cmd.setUnreachable(true);
      const ours = await cmd.call();
      expect(ours.output.split("\n").sort(), args.join(" ")).toEqual(
        theirs.stdout.split("\n").sort(),
      );
      expect(ours.exitCode).toBe(theirs.status);
      expect(theirs.stdout).toContain(
        args.includes("--unreachable") ? "unreachable blob" : "dangling blob",
      );
    }
  });

  it("reports a missing alternate and nesting too deep as git does", async () => {
    const dir = fresh("errors");
    const chain = Array.from({ length: 8 }, (_, i) => repoWith(join(dir, `a${i}`), [`c${i}`]));
    for (let i = 0; i < chain.length - 1; i++) {
      writeFileSync(
        join(chain[i] as string, ".git/objects/info/alternates"),
        `${join(chain[i + 1] as string, ".git/objects")}\n${join(dir, "gone", "objects")}\n`,
      );
    }
    const top = chain[0] as string;
    const theirs = gitRun(root, top, ["cat-file", "-e", "HEAD"]);
    const { objects } = await backendOf(top);
    if (compatibility === "2.56") {
      expect(objects.alternates?.errors).toEqual(errorLines(theirs.stderr));
    } else {
      // 2.43 links each entry as it parses it, and refuses a file nested too deep before
      // parsing it: the same lines, the depth error first, the deepest missing entry unread
      expect(new Set(objects.alternates?.errors)).toEqual(new Set(errorLines(theirs.stderr)));
    }
    expect(errorLines(theirs.stderr).join("\n")).toContain("nesting too deep");
    // what lies within the depth is read; the seventh level is not
    const reached = await objects.has(git(chain[6] as string, "rev-parse", "HEAD").trim());
    expect(reached).toBe(
      gitRun(root, top, ["cat-file", "-e", git(chain[6] as string, "rev-parse", "HEAD").trim()])
        .status === 0,
    );
    expect(await objects.has(git(chain[7] as string, "rev-parse", "HEAD").trim())).toBe(false);
  });

  it("reads $GIT_ALTERNATE_OBJECT_DIRECTORIES (colon-separated, quoted, relative)", async () => {
    const dir = fresh("env");
    const one = repoWith(join(dir, "one"), ["o1"]);
    const two = repoWith(join(dir, "two:colon"), ["t1"]);
    const repo = repoWith(join(dir, "repo"), ["r1"]);
    const env = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: `../one/.git/objects:"${join(two, ".git/objects")}"`,
    };
    for (const source of [one, two]) {
      const id = git(source, "rev-parse", "HEAD").trim();
      expect(gitRun(root, repo, ["cat-file", "-e", id], env).status).toBe(0);
      const { objects } = await backendOf(repo, env);
      expect(await objects.has(id)).toBe(true);
      expect(await (await backendOf(repo)).objects.has(id)).toBe(false);
    }
  });

  it("abbreviates and disambiguates across alternates", async () => {
    const dir = fresh("abbrev");
    const alt = repoWith(join(dir, "alt"), ["a"]);
    const repo = join(dir, "repo");
    git(dir, "clone", "-q", "--shared", alt, repo);
    // blobs here and in the alternate until two share their first four digits
    const seen = new Map<string, string>();
    let pair: [string, string] | undefined;
    for (let i = 0; !pair; i++) {
      const where = i % 2 === 0 ? alt : repo;
      putFile(where, "x.txt", `blob ${i}\n`);
      const id = git(where, "hash-object", "-w", "x.txt").trim();
      const other = seen.get(id.slice(0, 4));
      if (other && !other.startsWith(where)) pair = [other.slice(-40), id];
      seen.set(id.slice(0, 4), `${where}/${id}`);
    }
    const { objects } = await backendOf(repo);
    for (const id of pair) {
      const short = git(repo, "rev-parse", "--short=4", id).trim();
      const lengths = await findAbbrevLengths(objects, [id], 4);
      expect(id.slice(0, lengths.get(id))).toBe(short);
    }
    const prefix = pair[0].slice(0, 4);
    expect(gitRun(root, repo, ["rev-parse", "--verify", "-q", prefix]).status).not.toBe(0);
    const g = await openOurs(root, undefined, undefined, repo.slice(root.length + 1));
    await expect(g.revParse().setRevision(prefix).call()).rejects.toThrow();
  });

  /** Twins borrowing from one alternate: `n` for native git, `o` for ours. */
  function twins(): { alt: string; n: string; o: string } {
    const dir = fresh("twins");
    const alt = repoWith(join(dir, "alt"), ["a1", "a2"]);
    git(alt, "repack", "-q", "-a", "-d");
    repoWith(alt, ["a3"], false);
    const make = (name: string) => {
      const repo = join(dir, name);
      git(dir, "clone", "-q", "--shared", alt, repo);
      repoWith(repo, ["l1", "l2"], false);
      putFile(repo, "orphan.txt", "unreachable here\n");
      git(repo, "hash-object", "-w", "orphan.txt");
      return repo;
    };
    return { alt, n: make("n"), o: make("o") };
  }

  for (const local of [false, true]) {
    it(`repack -a -d${local ? " -l" : ""}: borrowed objects ${local ? "left out" : "copied"}`, async () => {
      const { alt, n, o } = twins();
      const altBefore = localObjects(join(alt, ".git/objects"));
      git(n, "repack", "-q", "-a", "-d", ...(local ? ["-l"] : []));
      const backend = await backendOf(o);
      await repack({ ...backend, all: true, local });
      expect(localObjects(join(o, ".git/objects"))).toEqual(localObjects(join(n, ".git/objects")));
      expect(localObjects(join(alt, ".git/objects"))).toEqual(altBefore);
      git(o, "fsck", "--no-progress");
    });
  }

  it("gc --prune=now keeps the alternates' objects theirs (repack -d -l, prune)", async () => {
    const { alt, n, o } = twins();
    const altBefore = localObjects(join(alt, ".git/objects"));
    git(n, "gc", "-q", "--prune=now");
    const backend = await backendOf(o);
    await gc({
      history: backend.history,
      files: backend.files,
      gitDir: backend.gitDir,
      pruneExpireMs: 0,
      writeCommitGraph: false,
    });
    expect(localObjects(join(o, ".git/objects"))).toEqual(localObjects(join(n, ".git/objects")));
    expect(localObjects(join(alt, ".git/objects"))).toEqual(altBefore);
    git(o, "fsck", "--no-progress");
  });

  /** A source repository and an empty destination `git init` made for each twin. */
  function cloneSetup() {
    const dir = fresh("clone");
    const src = repoWith(join(dir, "src"), ["s1", "s2"]);
    git(src, "tag", "-a", "-m", "tag", "v1");
    const ref = join(dir, "ref");
    git(dir, "clone", "-q", src, ref);
    repoWith(src, ["s3"], false);
    const o = join(dir, "o");
    git(dir, "init", "-q", "-b", "main", o);
    return { dir, src, ref, n: join(dir, "n"), o };
  }

  /** The alternates file's entries as real paths, or undefined without one. */
  const alternatesOf = (repo: string) => {
    const file = join(repo, ".git/objects/info/alternates");
    if (!existsSync(file)) return undefined;
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => resolve(l));
  };
  const refsOf = (repo: string) => git(repo, "for-each-ref", "--format=%(refname) %(objectname)");

  async function ourClone(
    o: string,
    configure: (c: ReturnType<Awaited<ReturnType<typeof openOurs>>["clone"]>) => void,
  ) {
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

  it("clone --shared borrows the source's objects and fetches none", async () => {
    const { dir, src, n, o } = cloneSetup();
    git(dir, "clone", "-q", "--shared", "src", n);
    await ourClone(o, (c) => c.setURI("../src").setShared(true));
    expect(alternatesOf(o)).toEqual(alternatesOf(n));
    expect(alternatesOf(n)).toEqual([join(src, ".git/objects")]);
    expect(refsOf(o)).toBe(refsOf(n));
    expect(localObjects(join(o, ".git/objects"))).toEqual(localObjects(join(n, ".git/objects")));
    expect(localObjects(join(n, ".git/objects"))).toEqual([]);
    git(o, "fsck", "--no-progress");
  });

  it("clone --reference over file:// fetches only what the reference lacks", async () => {
    const { dir, src, ref, n, o } = cloneSetup();
    git(dir, "clone", "-q", "--reference", "ref", `file://${src}`, n);
    await ourClone(o, (c) => c.setURI(`file://${src}`).addReference("../ref"));
    expect(alternatesOf(o)).toEqual(alternatesOf(n));
    expect(alternatesOf(n)).toEqual([join(ref, ".git/objects")]);
    expect(refsOf(o)).toBe(refsOf(n));
    expect(localObjects(join(o, ".git/objects"))).toEqual(localObjects(join(n, ".git/objects")));
    git(o, "fsck", "--no-progress");
  });

  it("clone --reference of no repository fails; --reference-if-able goes on with git's info", async () => {
    const { dir, src, n, o } = cloneSetup();
    mkdirSync(join(dir, "plain"));
    const required = gitRun(root, dir, ["clone", "-q", "--reference", "plain", "src", `${n}x`]);
    expect(required.status).toBe(128);
    let error: GitApiError | undefined;
    try {
      await ourClone(o, (c) => c.setURI("../src").addReference("../plain"));
    } catch (e) {
      error = e as GitApiError;
    }
    expect(`fatal: ${error?.message.replace(/^fatal: /, "")}\n`).toBe(
      required.stderr.replace("'plain'", "'../plain'"),
    );

    const optional = gitRun(root, dir, [
      "clone",
      "-q",
      "--reference-if-able",
      "missing",
      `file://${src}`,
      n,
    ]);
    expect(optional.status).toBe(0);
    const result = await ourClone(o, (c) =>
      c.setURI(`file://${src}`).addReferenceIfAble("../missing"),
    );
    expect((result.messages ?? []).join("")).toBe(
      optional.stderr
        .replaceAll("'missing'", "'../missing'")
        .replace(join(dir, "missing"), join(o, "../missing")),
    );
    expect(alternatesOf(o)).toEqual(alternatesOf(n));
    expect(refsOf(o)).toBe(refsOf(n));
  });

  it("clone --shared --dissociate copies the borrowed objects in and stops borrowing", async () => {
    const { dir, n, o } = cloneSetup();
    git(dir, "clone", "-q", "--shared", "--dissociate", "src", n);
    await ourClone(o, (c) => c.setURI("../src").setShared(true).setDissociate(true));
    expect(alternatesOf(o)).toBeUndefined();
    expect(alternatesOf(n)).toBeUndefined();
    expect(refsOf(o)).toBe(refsOf(n));
    expect(localObjects(join(o, ".git/objects"))).toEqual(localObjects(join(n, ".git/objects")));
    expect(
      readdirSync(join(o, ".git/objects/pack")).filter((f) => f.endsWith(".pack")).length,
    ).toBe(1);
    git(o, "fsck", "--no-progress");
  });

  it("receive-pack advertises the alternates' refs as .have, as git", async () => {
    const dir = fresh("have");
    const alt = repoWith(join(dir, "alt"), ["a1"]);
    git(dir, "clone", "-q", "--bare", "--shared", alt, join(dir, "b.git"));
    // refs the borrower lacks: a branch and an annotated tag, one at a commit it has
    repoWith(alt, ["a2"], false);
    git(alt, "branch", "extra", "HEAD~1");
    git(alt, "tag", "-a", "-m", "t", "vt", "HEAD");
    git(join(dir, "b.git"), "config", "http.receivepack", "true");
    const path = "/b.git/info/refs?service=git-receive-pack";
    const backend = nativeGitHttpBackend(dir, root);
    const ours = await ourHandler(dir);
    try {
      // the pkt-lines, capabilities left out (ours and git's differ)
      const strip = (body: string) => {
        const lines: string[] = [];
        for (let at = 0; at < body.length; ) {
          const n = Number.parseInt(body.slice(at, at + 4), 16);
          if (n === 0) {
            lines.push("0000");
            at += 4;
            continue;
          }
          lines.push(body.slice(at + 4, at + n).replace(/\0.*$|\n$/s, ""));
          at += n;
        }
        return lines;
      };
      const theirs = await (await backend.fetch(new Request(`http://localhost${path}`))).text();
      const mine = await (await ours(new Request(`http://localhost${path}`))).text();
      expect(strip(mine)).toEqual(strip(theirs));
      expect(theirs).toContain(".have");
    } finally {
      backend.close();
    }
    // a native push into ours: the borrowed history is not sent again (the pushed pack holds
    // the new commit, its tree and blob alone), and the result is whole
    const work = join(dir, "work");
    git(dir, "clone", "-q", alt, work);
    repoWith(work, ["w1"], false);
    const server = await serveOnLoopback(await ourHandler(dir));
    try {
      // (asynchronously: the server answers from this process)
      const pushed = await gitAsync(root, work, [
        "push",
        "-q",
        `${server.baseUrl}/b.git`,
        "HEAD:refs/heads/w",
      ]);
      expect(pushed.status, pushed.stderr).toBe(0);
    } finally {
      await server.close();
    }
    const received = localObjects(join(dir, "b.git/objects"));
    for (const id of git(work, "rev-list", "--objects", "vt").split("\n").filter(Boolean)) {
      expect(received).not.toContain(id.slice(0, 40));
    }
    expect(gitRun(root, join(dir, "b.git"), ["fsck", "--no-progress"]).status).toBe(0);
  });

  it("gc --prune=now, repack and prune refuse a branch at a commit of a gone alternate, deleting nothing", async () => {
    const dir = fresh("gone");
    const src = repoWith(join(dir, "src"), ["s1", "s2"]);
    const blob = git(src, "rev-parse", "HEAD:s1.txt").trim();
    const twin = (name: string) => {
      const repo = join(dir, name);
      git(dir, "clone", "-q", "--shared", src, repo);
      // a branch at a borrowed commit, and a loose copy of a borrowed blob of its own
      git(repo, "branch", "kept", "HEAD~1");
      const at = join(repo, ".git/objects", blob.slice(0, 2));
      mkdirSync(at, { recursive: true });
      writeFileSync(
        join(at, blob.slice(2)),
        readFileSync(join(src, ".git/objects", blob.slice(0, 2), blob.slice(2))),
      );
      return repo;
    };
    const n = twin("n");
    const o = twin("o");
    renameSync(src, join(dir, "moved"));
    const before = {
      n: localObjects(join(n, ".git/objects")),
      o: localObjects(join(o, ".git/objects")),
    };
    expect(before.n).toContain(blob);
    const theirs = gitRun(root, n, ["gc", "-q", "--prune=now"]);
    expect(theirs.status).not.toBe(0);
    expect(theirs.stderr).toContain("bad object");
    expect(gitRun(root, n, ["prune", "--expire=now"]).status).not.toBe(0);
    expect(localObjects(join(n, ".git/objects"))).toEqual(before.n);
    const backend = await backendOf(o);
    expect(backend.objects.alternates?.errors.length).toBeGreaterThan(0);
    const target = { ...backend, history: backend.history };
    await expect(gc({ ...target, pruneExpireMs: 0, writeCommitGraph: false })).rejects.toThrow(
      /^bad object /,
    );
    await expect(repack(target)).rejects.toThrow(/^bad object /);
    await expect(new FileGcStrategy(target).collectRoots()).rejects.toThrow();
    // with alternates not read at all (alternates: false), a refusal up front: the walk would
    // skip a borrowed reflog entry, and git, reading the alternate, keeps what it reaches
    const blind = await createGitFilesBackend({
      files: backend.files,
      gitDir: backend.gitDir,
      alternates: false,
    });
    await expect(gc({ ...blind, pruneExpireMs: 0, writeCommitGraph: false })).rejects.toThrow(
      /alternates are not read/,
    );
    expect(localObjects(join(o, ".git/objects"))).toEqual(before.o);
    expect(before.o).toEqual(before.n);
  });

  it("clone --reference, repack -a -d, the reference removed: gc --prune=now goes on as git", async () => {
    const dir = fresh("unref");
    const ref = repoWith(join(dir, "ref"), ["r1", "r2"]);
    const twin = (name: string) => {
      const repo = join(dir, name);
      git(dir, "clone", "-q", "--reference", ref, ref, repo);
      repoWith(repo, ["l1"], false);
      return repo;
    };
    const n = twin("n");
    const o = twin("o");
    git(n, "repack", "-q", "-a", "-d");
    const copied = await repack({ ...(await backendOf(o)), all: true });
    expect(copied?.objectCount).toBeGreaterThan(0);
    expect(localObjects(join(o, ".git/objects"))).toEqual(localObjects(join(n, ".git/objects")));
    rmSync(ref, { recursive: true, force: true });
    const theirs = gitRun(root, n, ["gc", "-q", "--prune=now"]);
    expect(theirs.status, theirs.stderr).toBe(0);
    const backend = await backendOf(o);
    const result = await gc({
      history: backend.history,
      files: backend.files,
      gitDir: backend.gitDir,
      pruneExpireMs: 0,
      writeCommitGraph: false,
    });
    // git prints its error lines once per reading of the alternates; ours, once
    expect(result.errors).toEqual([...new Set(errorLines(theirs.stderr))]);
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(localObjects(join(o, ".git/objects"))).toEqual(localObjects(join(n, ".git/objects")));
    for (const repo of [n, o]) {
      const fsck = gitRun(root, repo, ["fsck", "--no-progress", ...noReferences]);
      expect(fsck.status, fsck.stderr).toBe(0);
      expect(git(repo, "rev-list", "--objects", "--all").trim().split("\n").length).toBe(
        git(n, "rev-list", "--objects", "--all").trim().split("\n").length,
      );
    }
  });

  it("reads relative $GIT_ALTERNATE_OBJECT_DIRECTORIES entries from the worktree top (--separate-git-dir)", async () => {
    const dir = fresh("separate");
    const work = join(dir, "work");
    mkdirSync(join(work, "meta"), { recursive: true });
    git(dir, "init", "-q", "-b", "main", "--separate-git-dir", join(work, "meta/repo.git"), work);
    mkdirSync(join(work, "sub"));
    const inner = repoWith(join(work, "vendor/inner"), ["i1"]);
    const beside = repoWith(join(dir, "beside"), ["b1"]);
    const ids = [git(inner, "rev-parse", "HEAD").trim(), git(beside, "rev-parse", "HEAD").trim()];
    const env = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "vendor/inner/.git/objects:../beside/.git/objects",
    };
    // git runs from the worktree top, wherever it was started
    for (const id of ids) {
      expect(gitRun(root, join(work, "sub"), ["cat-file", "-e", id], env).status).toBe(0);
    }
    const environment = createNodeGitHostEnvironment({ env: testEnv(root, env) });
    // a FilesApi rooted at the worktree: its root is the worktree top (`../beside` lies
    // beyond the storage)
    const atTop = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: work }),
      gitDir: "meta/repo.git",
      environment,
    });
    expect(atTop.objects.alternates?.errors).toEqual([
      `error: unable to normalize alternate object path: ${work}/../beside/.git/objects`,
    ]);
    expect(await atTop.objects.has(ids[0] as string)).toBe(true);
    // one rooted above it, told where the worktree is
    const above = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: dir }),
      gitDir: "work/meta/repo.git",
      workTree: "work",
      environment,
    });
    expect(above.objects.alternates?.errors).toEqual([]);
    for (const id of ids) expect(await above.objects.has(id)).toBe(true);
  });

  it("commands surface git's alternates error lines once (status, log, fsck, gc)", async () => {
    const dir = fresh("cmderr");
    const alt = repoWith(join(dir, "alt"), ["a1"]);
    const repo = join(dir, "repo");
    git(dir, "clone", "-q", "--shared", alt, repo);
    repoWith(repo, ["r1"], false);
    mkdirSync(join(dir, "gone")); // its objects directory is missing (not its parent)
    writeFileSync(
      join(repo, ".git/objects/info/alternates"),
      `${join(alt, ".git/objects")}\n${join(dir, "gone", "objects")}\n`,
    );
    const rel = repo.slice(root.length + 1);
    const runs: Array<[string[], (g: Awaited<ReturnType<typeof openOurs>>) => Promise<string[]>]> =
      [
        [
          ["status", "--porcelain"],
          async (g) => {
            const cmd = g.status();
            await cmd.call();
            return cmd.alternatesErrors();
          },
        ],
        [
          ["log", "--oneline"],
          async (g) => {
            const cmd = g.log();
            for await (const _ of await cmd.call());
            return cmd.alternatesErrors();
          },
        ],
        [
          ["fsck", ...noReferences],
          async (g) => {
            const files = createNodeFilesApi({ rootDir: root });
            const cmd = g
              .fsck()
              .setRepositoryFiles({ files, gitDir: `${rel}/.git` })
              .setCompatibility(compatibility);
            await cmd.call();
            return cmd.alternatesErrors();
          },
        ],
        [
          ["gc", "-q"],
          async (g) => {
            const cmd = g.gc();
            await cmd.call();
            return cmd.alternatesErrors();
          },
        ],
      ];
    for (const [args, ours] of runs) {
      const theirs = gitRun(root, repo, args);
      const lines = errorLines(theirs.stderr);
      expect(lines.length, args[0]).toBeGreaterThan(0);
      const g = await openOurs(root, undefined, undefined, rel);
      // git prints them once per process (gc and fsck run child processes: once each)
      expect(await ours(g), args[0]).toEqual([...new Set(lines)]);
      expect(lines[0]).toBe(
        `error: object directory ${join(dir, "gone", "objects")} does not exist; check .git/objects/info/alternates`,
      );
    }
    // a clean repository: none
    const g = await openOurs(root, undefined, undefined, alt.slice(root.length + 1));
    const st = g.status();
    await st.call();
    expect(st.alternatesErrors()).toEqual([]);
  });

  it("reads the first alternate's commit-graph where the repository has none; fsck verifies each", async () => {
    const dir = fresh("graph");
    const alt = repoWith(join(dir, "alt"), ["a1", "a2", "a3"]);
    git(alt, "checkout", "-q", "-b", "side", "HEAD~1");
    repoWith(alt, ["b1", "b2"], false);
    git(alt, "checkout", "-q", "main");
    git(alt, "commit-graph", "write", "--reachable");
    const repo = join(dir, "repo");
    git(dir, "clone", "-q", "--shared", alt, repo);
    git(repo, "checkout", "-q", "-b", "topic", "origin/side");
    repoWith(repo, ["r1", "r2"], false);
    expect(existsSync(join(repo, ".git/objects/info/commit-graph"))).toBe(false);
    const { history } = await backendOf(repo);
    const graph = await history.commitGraph?.get();
    // the alternate's: its five commits
    expect(graph?.size).toBe(5);
    // the graph is a cache: the walks answer as git's
    const rel = repo.slice(root.length + 1);
    const g = await openOurs(root, undefined, undefined, rel);
    const walk = async (...revs: string[]) => {
      const cmd = g.revList();
      for (const r of revs) cmd.addRevision(r);
      const ids: string[] = [];
      for await (const c of await cmd.call()) ids.push(c.id);
      return ids.join("\n");
    };
    expect(await walk("HEAD")).toBe(git(repo, "rev-list", "HEAD").trim());
    expect(await walk("HEAD...origin/main")).toBe(
      git(repo, "rev-list", "HEAD...origin/main").trim(),
    );
    expect(await walk("origin/main", "^HEAD")).toBe(
      git(repo, "rev-list", "origin/main", "^HEAD").trim(),
    );
    // fsck verifies the alternate's graph too (commit-graph verify --object-dir <each>)
    const graphFile = join(alt, ".git/objects/info/commit-graph");
    const bytes = readFileSync(graphFile);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff; // its checksum
    writeFileSync(graphFile, bytes);
    const theirs = gitRun(root, repo, ["fsck", "--no-progress", ...noReferences]);
    const files = createNodeFilesApi({ rootDir: root });
    const ours = await g
      .fsck()
      .setRepositoryFiles({ files, gitDir: `${rel}/.git` })
      .setCompatibility(compatibility)
      .call();
    expect(theirs.status).not.toBe(0);
    expect(ours.exitCode).toBe(theirs.status);
    expect(ours.errorOutput.split("\n").filter(Boolean).sort()).toEqual(
      theirs.stderr.split("\n").filter(Boolean).sort(),
    );
  });
});

type Fetcher = (request: Request) => Promise<Response>;

/** Our smart HTTP handler over the repositories under `dir`. */
async function ourHandler(dir: string): Promise<Fetcher> {
  const host = join(dir, "host");
  if (!existsSync(host)) repoWith(host, ["h"]);
  const g = await openOurs(
    dir,
    createNodeGitHostEnvironment({ env: testEnv(root) }),
    undefined,
    host.slice(dir.length + 1),
  );
  return createServedFetchHandler({
    resolveRepository: createBasePathResolver({
      files: createNodeFilesApi({ rootDir: dir }),
      exportAll: true,
      openRepository: async (gitDir) => {
        const opened = await openLocalRemote(g.workingCopy, `..${gitDir}`).catch(() => undefined);
        return opened ? servedRepositoryOf(opened) : undefined;
      },
    }),
  });
}
