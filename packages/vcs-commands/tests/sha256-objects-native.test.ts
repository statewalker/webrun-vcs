/**
 * SHA-256 repositories against native git: a repository native git builds with
 * `--object-format=sha256` read by ours (cat-file-like reads, log, diff, fsck, revisions), and
 * objects ours writes read by native git (`git fsck`, `git log`, `git cat-file`). Scenarios
 * follow git's own tests, named per case: t0001-init.sh (object formats at init), t1006-cat-file.sh
 * (object reads), t1450-fsck.sh (fsck of a SHA-256 repository).
 *
 * What a SHA-256 repository does not support yet (its pack files, the index file, the
 * commit-graph) is refused with `UnsupportedObjectFormatError`: the repositories here hold loose
 * objects only, and ours read them with an in-memory index.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitFilesBackend,
  FileStagingStore,
  GitWorkingCopyConfig,
} from "@statewalker/vcs-store-files";
import { MemoryStagingStore } from "@statewalker/vcs-store-mem";
import { SHA256_OBJECT_FORMAT, UnsupportedObjectFormatError } from "@statewalker/vcs-utils";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import {
  type GitHostEnvironment,
  MemoryCheckout,
  MemoryWorkingCopy,
} from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Git, ReinitializeHashError, UnknownHashAlgorithmError } from "../src/index.js";
import { put } from "./merge-native-helpers.js";
import { createMockWorktree } from "./mock-worktree-store.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

describeGit("SHA-256 repositories against native git", () => {
  let root: string;
  let n = 0;
  /** git 2.45+ (init.defaultObjectFormat, fsck messages of 2.5x) */
  let modern = false;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sha256-native-"));
    const m = /(\d+)\.(\d+)/.exec(native(root, ["--version"]).stdout);
    modern = !!m && (Number(m[1]) > 2 || Number(m[2]) >= 45);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function native(cwd: string, args: string[], input?: string | Uint8Array, env = {}) {
    const r = spawnSync("git", args, { cwd, env: { ...nativeGitEnv(root), ...env }, input });
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  }
  const g = (dir: string, ...args: string[]) => {
    const r = native(dir, args);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const fresh = () => join(root, `r${n++}`);

  /** A SHA-256 repository native git builds: two commits, a tag, a branch merged back. */
  function nativeRepo(): string {
    const dir = fresh();
    g(root, "init", "-q", "--object-format=sha256", "-b", "main", dir);
    put(dir, "a.txt", "one\ntwo\nthree\n");
    put(dir, "d/b.txt", "bee\n");
    put(dir, "d/e/x.sh", "#!/bin/sh\n");
    g(dir, "update-index", "--add", "--chmod=+x", "d/e/x.sh");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "first");
    g(dir, "tag", "-a", "-m", "version one", "v1");
    g(dir, "checkout", "-q", "-b", "side");
    put(dir, "side.txt", "side\n");
    g(dir, "add", "side.txt");
    g(dir, "commit", "-q", "-m", "side");
    g(dir, "tag", "-a", "-m", "side tag", "s1");
    g(dir, "checkout", "-q", "main");
    put(dir, "a.txt", "one\n2\nthree\n");
    g(dir, "rm", "-q", "d/b.txt");
    g(dir, "commit", "-q", "-am", "second");
    g(dir, "merge", "-q", "--no-ff", "--no-edit", "s1");
    // a merge of a signed tag records it in a `mergetag` header, and a signed commit of a
    // SHA-256 repository carries `gpgsig-sha256`: such a commit, written as git writes them
    g(dir, "update-ref", "refs/heads/signed", signedMerge(dir));
    return dir;
  }

  /** A merge commit with a `mergetag` (a signed tag of `side`) and a `gpgsig-sha256` header. */
  function signedMerge(dir: string): string {
    const tag = g(dir, "cat-file", "tag", "s1").replace(/\n$/, "");
    const body = [
      `tree ${g(dir, "rev-parse", "main^{tree}")}`,
      `parent ${g(dir, "rev-parse", "main~1")}`,
      `parent ${g(dir, "rev-parse", "side")}`,
      "author A U Thor <author@example.com> 1112911993 +0000",
      "committer A U Thor <author@example.com> 1112911993 +0000",
      `mergetag ${tag.split("\n").join("\n ")}`,
      " -----BEGIN PGP SIGNATURE-----",
      " ",
      " not really",
      " -----END PGP SIGNATURE-----",
      "gpgsig-sha256 -----BEGIN PGP SIGNATURE-----",
      " ",
      " not really either",
      " -----END PGP SIGNATURE-----",
      "",
      "Merge tag 's1'",
      "",
    ].join("\n");
    return native(dir, ["hash-object", "-t", "commit", "-w", "--stdin"], body).stdout.trim();
  }

  /** Our working copy over `dir`'s repository, with an index held in memory. */
  async function openOurs(dir: string, environment?: GitHostEnvironment): Promise<Git> {
    const files = createNodeFilesApi({ rootDir: dir });
    const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
    const config = new GitWorkingCopyConfig(
      {
        read: async (p) =>
          existsSync(join(dir, p)) ? new Uint8Array(readFileSync(join(dir, p))) : undefined,
        write: async (p, c) => writeFileSync(join(dir, p), c),
        rootDirectory: dir,
      },
      ".git/config",
      environment ? { environment } : {},
    );
    await config.load();
    return Git.fromWorkingCopy(
      new MemoryWorkingCopy({
        history,
        checkout: new MemoryCheckout({ staging: new MemoryStagingStore() }),
        worktree: createMockWorktree(),
        config,
      }),
    );
  }

  const text = (chunks: Uint8Array[]) => Buffer.concat(chunks).toString("latin1");

  // ---------------------------------------------------------------- t0001-init.sh

  describe("init (t0001-init.sh)", () => {
    // "init honors --object-format"
    it("--object-format=sha256 writes version 1 and extensions.objectformat", async () => {
      const dir = fresh();
      const files = createNodeFilesApi({ rootDir: root });
      const name = dir.slice(root.length + 1);
      const { git, repository } = await Git.init()
        .setFilesApi(files)
        .setDirectory(name)
        .setObjectFormat("sha256")
        .call();
      expect(repository.objectFormat?.name).toBe("sha256");
      expect(g(dir, "rev-parse", "--show-object-format")).toBe("sha256");
      expect(g(dir, "config", "core.repositoryformatversion")).toBe("1");
      expect(g(dir, "config", "extensions.objectformat")).toBe("sha256");
      const { lines } = await git.revParse().addArgument("--show-object-format").call();
      expect(lines).toEqual(["sha256"]);
    });

    // "init honors GIT_DEFAULT_HASH", "--object-format overrides GIT_DEFAULT_HASH"
    it("GIT_DEFAULT_HASH picks the format, --object-format overrides it", async () => {
      const files = createNodeFilesApi({ rootDir: root });
      const env = (defaultHash: string): GitHostEnvironment => ({
        readFile: async () => undefined,
        defaultHash,
      });
      const a = fresh();
      await Git.init()
        .setFilesApi(files)
        .setDirectory(a.slice(root.length + 1))
        .setEnvironment(env("sha256"))
        .call();
      expect(g(a, "rev-parse", "--show-object-format")).toBe("sha256");
      const b = fresh();
      await Git.init()
        .setFilesApi(files)
        .setDirectory(b.slice(root.length + 1))
        .setEnvironment(env("sha256"))
        .setObjectFormat("sha1")
        .call();
      expect(g(b, "rev-parse", "--show-object-format")).toBe("sha1");
      expect(
        native(root, ["config", "-f", join(b, ".git/config"), "extensions.objectformat"]).status,
      ).toBe(1);
      // an unknown name dies, as git's "fatal: unknown hash algorithm 'bogus'"
      const c = fresh();
      await expect(
        Git.init()
          .setFilesApi(files)
          .setDirectory(c.slice(root.length + 1))
          .setEnvironment(env("bogus"))
          .call(),
      ).rejects.toThrow(UnknownHashAlgorithmError);
      expect(native(root, ["init", "-q", c], undefined, { GIT_DEFAULT_HASH: "bogus" }).stderr).toBe(
        "fatal: unknown hash algorithm 'bogus'\n",
      );
      await expect(
        Git.init()
          .setFilesApi(files)
          .setDirectory(fresh().slice(root.length + 1))
          .setObjectFormat("sha512")
          .call(),
      ).rejects.toThrow("fatal: unknown hash algorithm 'sha512'");
    });

    // "init honors init.defaultObjectFormat", "init warns about invalid init.defaultObjectFormat",
    // "GIT_DEFAULT_HASH overrides init.defaultObjectFormat" (git 2.45+)
    it("init.defaultObjectFormat picks the format after GIT_DEFAULT_HASH", async () => {
      const files = createNodeFilesApi({ rootDir: root });
      const env = (value: string, defaultHash?: string): GitHostEnvironment => ({
        readFile: async () => undefined,
        commandLineConfig: [{ key: "init.defaultObjectFormat", value }],
        ...(defaultHash ? { defaultHash } : {}),
      });
      const a = fresh();
      await Git.init()
        .setFilesApi(files)
        .setDirectory(a.slice(root.length + 1))
        .setEnvironment(env("sha256"))
        .call();
      expect(g(a, "rev-parse", "--show-object-format")).toBe("sha256");
      const b = fresh();
      await Git.init()
        .setFilesApi(files)
        .setDirectory(b.slice(root.length + 1))
        .setEnvironment(env("sha256", "sha1"))
        .call();
      expect(g(b, "rev-parse", "--show-object-format")).toBe("sha1");
      const c = fresh();
      const ours = await Git.init()
        .setFilesApi(files)
        .setDirectory(c.slice(root.length + 1))
        .setEnvironment(env("garbage"))
        .call();
      expect(ours.warnings).toEqual(["warning: unknown hash algorithm 'garbage'"]);
      expect(g(c, "rev-parse", "--show-object-format")).toBe("sha1");
      if (modern) {
        const d = fresh();
        const r = native(root, ["-c", "init.defaultObjectFormat=garbage", "init", "-q", d]);
        expect([r.status, r.stderr]).toEqual([0, "warning: unknown hash algorithm 'garbage'\n"]);
        const e = fresh();
        g(root, "-c", "init.defaultObjectFormat=sha256", "init", "-q", e);
        expect(g(e, "rev-parse", "--show-object-format")).toBe("sha256");
      }
    });

    // "init rejects attempts to initialize with different hash"
    it("re-initialising with another format is refused, the repository kept", async () => {
      const files = createNodeFilesApi({ rootDir: root });
      const dir = fresh();
      g(root, "init", "-q", "--object-format=sha256", dir);
      const name = dir.slice(root.length + 1);
      await expect(
        Git.init().setFilesApi(files).setDirectory(name).setObjectFormat("sha1").call(),
      ).rejects.toThrow(ReinitializeHashError);
      const r = native(root, ["init", "-q", "--object-format=sha1", dir]);
      expect([r.status, r.stderr]).toEqual([
        128,
        "fatal: attempt to reinitialize repository with different hash\n",
      ]);
      // the same format, or none, re-initialises
      const again = await Git.init()
        .setFilesApi(files)
        .setDirectory(name)
        .setObjectFormat("sha256")
        .call();
      expect(again.repository.objectFormat?.name).toBe("sha256");
      const plain = await Git.init().setFilesApi(files).setDirectory(name).call();
      expect(plain.repository.objectFormat?.name).toBe("sha256");
      expect(g(dir, "rev-parse", "--show-object-format")).toBe("sha256");
    });

    // "extensions.objectFormat is not allowed with repo version 0"
    it("extensions.objectFormat needs repository format version 1", async () => {
      const dir = fresh();
      g(root, "init", "-q", dir);
      g(dir, "config", "extensions.objectFormat", "sha256");
      expect(native(dir, ["rev-parse", "--show-object-format"]).status).toBe(128);
      await expect(openOurs(dir)).rejects.toThrow("repo version is 0, but v1-only extension found");
    });
  });

  // ---------------------------------------------------------------- t1006-cat-file.sh

  describe("object reads (t1006-cat-file.sh)", () => {
    it("reads every object native git wrote: type, size and content", async () => {
      const dir = nativeRepo();
      const git = await openOurs(dir);
      const history = git.workingCopy.history;
      const objects = history.objects;
      if (!objects) throw new Error("no object store");
      const ids = g(dir, "rev-list", "--objects", "--all")
        .split("\n")
        .map((l) => l.slice(0, 64));
      expect(ids.length).toBeGreaterThan(8);
      for (const id of [...ids, g(dir, "rev-parse", "v1"), g(dir, "rev-parse", "s1")]) {
        const obj = await objects.get(id, { verify: true });
        expect(obj, id).toBeDefined();
        if (!obj) continue;
        const chunks: Uint8Array[] = [];
        for await (const c of obj.content) chunks.push(c);
        expect(obj.type).toBe(g(dir, "cat-file", "-t", id));
        expect(String(obj.size)).toBe(g(dir, "cat-file", "-s", id));
        const raw = spawnSync("git", ["cat-file", obj.type, id], {
          cwd: dir,
          env: nativeGitEnv(root),
        });
        expect(text(chunks)).toBe(raw.stdout.toString("latin1"));
      }
    });

    // "--batch-check" on the empty tree and blob, which every repository has
    it("knows the SHA-256 empty tree and empty blob", async () => {
      const dir = nativeRepo();
      const git = await openOurs(dir);
      const history = git.workingCopy.history;
      expect(g(dir, "hash-object", "-t", "tree", "/dev/null")).toBe(
        SHA256_OBJECT_FORMAT.emptyTreeId,
      );
      expect(await history.trees.has(SHA256_OBJECT_FORMAT.emptyTreeId)).toBe(true);
      expect(history.trees.getEmptyTreeId()).toBe(SHA256_OBJECT_FORMAT.emptyTreeId);
      const blob = await history.blobs.store([new Uint8Array(0)]);
      expect(blob).toBe(g(dir, "hash-object", "/dev/null"));
    });

    it("parses commits, trees and tags with 64-hex ids", async () => {
      const dir = nativeRepo();
      const git = await openOurs(dir);
      const history = git.workingCopy.history;
      const head = g(dir, "rev-parse", "HEAD");
      const commit = await history.commits.load(head);
      expect(commit?.tree).toBe(g(dir, "rev-parse", "HEAD^{tree}"));
      expect(commit?.parents).toEqual([
        g(dir, "rev-parse", "HEAD^1"),
        g(dir, "rev-parse", "HEAD^2"),
      ]);
      const entries: string[] = [];
      for await (const e of (await history.trees.load(g(dir, "rev-parse", "HEAD:d"))) ?? []) {
        entries.push(`${e.mode.toString(8).padStart(6, "0")} ${e.id} ${e.name}`);
      }
      const lsTree = g(dir, "ls-tree", "HEAD:d")
        .split("\n")
        .map((l) => l.replace(/ (blob|tree) /, " ").replace("\t", " "));
      expect(entries).toEqual(lsTree);
      const tag = await history.tags.load(g(dir, "rev-parse", "v1"));
      expect(tag?.object).toBe(g(dir, "rev-parse", "v1^{commit}"));
      // gpgsig-sha256 is the signature of a SHA-256 repository's commit
      const signed = await history.commits.load(g(dir, "rev-parse", "signed"));
      expect(signed?.gpgSignature).toBe(
        "-----BEGIN PGP SIGNATURE-----\n\nnot really either\n-----END PGP SIGNATURE-----",
      );
      expect(signed?.parents).toEqual([g(dir, "rev-parse", "main~1"), g(dir, "rev-parse", "side")]);
    });
  });

  // ---------------------------------------------------------------- revisions, log, diff

  describe("revisions, log and diff", () => {
    it("resolves full and abbreviated 64-hex ids, refs and revision syntax as git", async () => {
      const dir = nativeRepo();
      const git = await openOurs(dir);
      for (const rev of [
        "HEAD",
        "HEAD^1",
        "HEAD^2",
        "v1",
        "v1^{commit}",
        "HEAD~1:a.txt",
        "main^{tree}",
        "s1^{}",
      ]) {
        const { objectId } = await git.revParse().setRevision(rev).call();
        expect(objectId, rev).toBe(g(dir, "rev-parse", rev));
      }
      const head = g(dir, "rev-parse", "HEAD");
      for (const len of [4, 7, 12, 40, 63, 64]) {
        const { objectId } = await git.revParse().setRevision(head.slice(0, len)).call();
        expect(objectId, `${len}`).toBe(head);
      }
      expect(g(dir, "rev-parse", "--short", "HEAD")).toBe(
        (await git.log().setMaxCount(1).callText({ pretty: "format:%h" })).trim(),
      );
    });

    it("prints log and diffs as native git does", async () => {
      const dir = nativeRepo();
      const git = await openOurs(dir);
      const formats = ["fuller", "raw", "format:%H %h %T %t %P %p %s"];
      for (const pretty of formats) {
        const ours = await git.log().callText({ pretty });
        expect(ours, pretty).toBe(`${native(dir, ["log", `--pretty=${pretty}`]).stdout}`);
      }
      const patch = await git.log().callText({ patch: true, stat: true });
      expect(patch).toBe(native(dir, ["log", "-p", "--stat"]).stdout);
      const names = await git.log().callText({ nameStatus: true });
      expect(names).toBe(native(dir, ["log", "--name-status"]).stdout);
      const diff = await git.diff().setOldTree("v1").setNewTree("HEAD").callText();
      expect(diff).toBe(native(dir, ["diff", "v1", "HEAD"]).stdout);
    });
  });

  // ---------------------------------------------------------------- t1450-fsck.sh

  describe("fsck (t1450-fsck.sh)", () => {
    // "setup: create a repository with sha256" / "fsck on a clean repository"
    it("finds a native repository clean, and its dangling objects as git", async () => {
      const dir = nativeRepo();
      // the index of a SHA-256 repository is not read yet: refused with a clear error
      const files = createNodeFilesApi({ rootDir: dir });
      const staging = new FileStagingStore(files, ".git/index");
      await expect(staging.read()).rejects.toThrow(UnsupportedObjectFormatError);
      g(dir, "hash-object", "-w", "--stdin");
      put(dir, "dangling.txt", "dangling\n");
      g(dir, "hash-object", "-w", "dangling.txt");
      rmSync(join(dir, ".git", "index"));
      const theirs = native(dir, ["fsck", ...(modern ? ["--no-references"] : [])]);
      const git = await openOurs(dir);
      const ours = await git
        .fsck()
        .setRepositoryFiles({ files })
        .setCompatibility(modern ? "2.56" : "2.43")
        .call();
      expect([ours.output, ours.errorOutput, ours.exitCode]).toEqual([
        theirs.stdout,
        theirs.stderr,
        theirs.status,
      ]);
      expect(ours.output).toMatch(/^dangling blob [0-9a-f]{64}$/m);
    });

    // "object with hash mismatch"
    it("reports an object whose content hashes to another id", async () => {
      const dir = nativeRepo();
      rmSync(join(dir, ".git", "index"));
      const blob = g(dir, "rev-parse", "HEAD:a.txt");
      const other = g(dir, "hash-object", "-w", "--stdin");
      const from = join(dir, ".git", "objects", other.slice(0, 2), other.slice(2));
      const to = join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2));
      rmSync(to, { force: true });
      writeFileSync(to, readFileSync(from));
      const theirs = native(dir, ["fsck", ...(modern ? ["--no-references"] : [])]);
      const files = createNodeFilesApi({ rootDir: dir });
      const ours = await (await openOurs(dir))
        .fsck()
        .setRepositoryFiles({ files })
        .setCompatibility(modern ? "2.56" : "2.43")
        .call();
      expect(ours.exitCode).toBe(theirs.status);
      expect(ours.errorOutput.split("\n").filter(Boolean).sort()).toEqual(
        theirs.stderr.split("\n").filter(Boolean).sort(),
      );
      expect(ours.output).toBe(theirs.stdout);
    });
  });

  // ---------------------------------------------------------------- ours, read by git

  describe("objects ours writes, read by native git", () => {
    it("blobs, trees, commits, tags, mergetag and gpgsig-sha256 native git reads and finds clean", async () => {
      const dir = fresh();
      const files = createNodeFilesApi({ rootDir: root });
      const { git, repository: history } = await Git.init()
        .setFilesApi(files)
        .setDirectory(dir.slice(root.length + 1))
        .setObjectFormat("sha256")
        .setInitialBranch("main")
        .setStagingStore(new MemoryStagingStore())
        .call();
      const enc = new TextEncoder();
      const who = {
        name: "A U Thor",
        email: "author@example.com",
        timestamp: 1112911993,
        tzOffset: "+0000",
      };
      const blob = await history.blobs.store([enc.encode("hello\n")]);
      expect(blob).toBe(native(dir, ["hash-object", "--stdin"], "hello\n").stdout.trim());
      const sub = await history.trees.store([{ mode: 0o100755, name: "run.sh", id: blob }]);
      const tree = await history.trees.store([
        { mode: 0o100644, name: "hello.txt", id: blob },
        { mode: 0o040000, name: "bin", id: sub },
      ]);
      const first = await history.commits.store({
        tree,
        parents: [],
        author: who,
        committer: who,
        message: "first\n",
      });
      const side = await history.commits.store({
        tree: sub,
        parents: [first],
        author: who,
        committer: who,
        message: "side\n",
      });
      const tag = await history.tags.store({
        object: side,
        objectType: 1,
        tag: "t1",
        tagger: who,
        message: "a tag\n",
      });
      const merge = await history.commits.store({
        tree,
        parents: [first, side],
        author: who,
        committer: who,
        message: "merge\n",
        gpgSignature: "-----BEGIN PGP SIGNATURE-----\n\nnot really\n-----END PGP SIGNATURE-----",
      });
      await history.refs.set("refs/heads/main", merge);
      // a commit with a mergetag, as its bytes (the commit model has no mergetag)
      const tagText = Buffer.from(
        await (async () => {
          const o = await history.objects?.get(tag);
          const out: Uint8Array[] = [];
          for await (const c of o?.content ?? []) out.push(c);
          return Buffer.concat(out);
        })(),
      )
        .toString("utf8")
        .replace(/\n$/, "");
      const withTag = enc.encode(
        [
          `tree ${tree}`,
          `parent ${first}`,
          `parent ${side}`,
          "author A U Thor <author@example.com> 1112911993 +0000",
          "committer A U Thor <author@example.com> 1112911993 +0000",
          `mergetag ${tagText.split("\n").join("\n ")}`,
          "",
          "merge t1",
          "",
        ].join("\n"),
      );
      const mergetag = await history.objects?.put("commit", withTag.length, [withTag]);
      if (!mergetag) throw new Error("no object store");
      await history.refs.set("refs/heads/tagged", mergetag);
      expect(g(dir, "cat-file", "commit", mergetag)).toContain(`mergetag object ${side}`);
      expect(g(dir, "log", "-1", "--format=%P", "tagged")).toBe(`${first} ${side}`);
      await history.refs.set("refs/tags/t1", tag);
      // the signature is written in the SHA-256 header
      expect(g(dir, "cat-file", "commit", merge)).toMatch(
        /^gpgsig-sha256 -----BEGIN PGP SIGNATURE-----$/m,
      );
      expect(g(dir, "cat-file", "-p", merge)).toContain(`tree ${tree}`);
      const fsck = native(dir, ["fsck", "--strict", ...(modern ? ["--no-references"] : [])]);
      expect([fsck.status, fsck.stderr]).toEqual([0, ""]);
      expect(g(dir, "log", "--topo-order", "--format=%H %P %s", "main")).toBe(
        [`${merge} ${first} ${side} merge`, `${side} ${first} side`, `${first}  first`].join("\n"),
      );
      expect(g(dir, "cat-file", "-p", tag)).toContain(`object ${side}`);
      expect(g(dir, "ls-tree", "-r", "main")).toBe(
        [`100755 blob ${blob}\tbin/run.sh`, `100644 blob ${blob}\thello.txt`].join("\n"),
      );
      // our own reflog has 64-zero ids for a created ref, as git's
      const reflog = readFileSync(join(dir, ".git", "logs", "refs", "heads", "main"), "utf8");
      expect(reflog.startsWith(`${"0".repeat(64)} ${merge} `)).toBe(true);
      // and an annotated tag through the command
      await git
        .tag()
        .setName("v2")
        .setMessage("v2\n")
        .setObjectId(first)
        .setTaggerIdent(who)
        .call();
      expect(g(dir, "cat-file", "-t", "v2")).toBe("tag");
      expect(native(dir, ["fsck", ...(modern ? ["--no-references"] : [])]).status).toBe(0);
    });

    it("refuses what has no SHA-256 path yet: packs, gc, the index", async () => {
      const dir = nativeRepo();
      const git = await openOurs(dir);
      await expect(git.gc().call()).rejects.toThrow(UnsupportedObjectFormatError);
      g(dir, "repack", "-q", "-a", "-d");
      await expect(openOurs(dir)).rejects.toThrow(UnsupportedObjectFormatError);
    });
  });
});
