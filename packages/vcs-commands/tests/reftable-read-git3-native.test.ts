/**
 * Reading reftable repositories, twinned with the git 3.0 oracle (`$GIT3`, see
 * `native-git3.ts`), which creates reftable repositories by default. Each scenario is built by
 * native git and then read by ours; refs, symbolic refs, peeled tags, reflogs and revisions
 * are compared with `git for-each-ref`, `git symbolic-ref`, `git reflog show` and
 * `git rev-parse`, and commands (log, status, branch and tag listings, rev-parse) with their
 * native output. Writes refuse with `ReftableWriteUnsupportedError` and change nothing.
 *
 * Scenarios come from git's `t/t0610-reftable-basics.sh` (named in each test), ported by hand.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSymbolicRef, type Refs } from "@statewalker/vcs-core";
import {
  createGitFilesBackend,
  openGitLinkedWorktrees,
  openReftable,
  ReftableWriteUnsupportedError,
} from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openOurs } from "./merge-native-helpers.js";
import { git3Binary, nativeGit3Env } from "./native-git3.js";

const git3 = git3Binary();

describe.skipIf(!git3)("reading reftable repositories (git 3.0 oracle)", () => {
  let root = "";
  let repo = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reftable-read-"));
    repo = join(root, "repo");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Native git 3.0 in `cwd`; its stdout. `env` adds variables (dates, compaction). */
  function g(cwd: string, args: string[], env: Record<string, string> = {}): string {
    const r = spawnSync(git3 as string, args, {
      cwd,
      env: { ...nativeGit3Env(root), GIT_EDITOR: "true", ...env },
      encoding: "utf8",
    });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
    }
    return r.stdout;
  }

  /** A commit dated `t` seconds after the base date (distinct dates order the walks). */
  function commit(cwd: string, message: string, t: number, env: Record<string, string> = {}) {
    const date = `${1112911993 + t} +0000`;
    g(cwd, ["commit", "-q", "--allow-empty", "-m", message], {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      ...env,
    });
  }

  function init(): void {
    g(root, ["init", "-q", "repo"]);
    expect(g(repo, ["rev-parse", "--show-ref-format"]).trim()).toBe("reftable");
  }

  async function oursRefs(dir = repo): Promise<Refs> {
    const files = createNodeFilesApi({ rootDir: dir });
    return (await createGitFilesBackend({ files })).history.refs;
  }

  /** `git for-each-ref --format='%(refname) %(objectname) %(symref)'` as ours reads it. */
  async function forEachRef(refs: Refs): Promise<string> {
    const lines: string[] = [];
    for await (const ref of refs.list("refs/")) {
      const resolved = await refs.resolve(ref.name);
      const target = isSymbolicRef(ref) ? ref.target : "";
      lines.push(`${ref.name} ${resolved?.objectId ?? ""} ${target}`);
    }
    return lines.map((l) => `${l}\n`).join("");
  }

  /** `git reflog show --date=raw --format='%H %gn <%ge> %gD %gs' <ref>` as ours reads it. */
  async function reflog(refs: Refs, ref: string): Promise<string> {
    const reader = await refs.getReflog?.(ref);
    const entries = (await reader?.getReverseEntries()) ?? [];
    // `reflog show` walks the entries' new ids: an entry to the null id (a rename's deletion
    // half) is passed over, though it is stored and counted (`ref@{n}`)
    return entries
      .filter((e) => e.newId !== "0000000000000000000000000000000000000000")
      .map(
        (e) =>
          `${e.newId} ${e.who.name} <${e.who.email}> ${ref}@{${e.who.timestamp} ${e.who.tzOffset}} ${e.comment}\n`,
      )
      .join("");
  }

  function nativeReflog(cwd: string, ref: string): string {
    return g(cwd, ["reflog", "show", "--date=raw", "--format=%H %gn <%ge> %gD %gs", ref]);
  }

  /** Our refs compared with native git's: every ref, HEAD, and the reflogs named. */
  async function expectSameRefs(dir: string, refs: Refs, reflogs: string[] = ["HEAD"]) {
    expect(await forEachRef(refs)).toBe(
      g(dir, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"]),
    );
    const head = await refs.get("HEAD");
    const symref = spawnSync(git3 as string, ["symbolic-ref", "-q", "HEAD"], {
      cwd: dir,
      env: nativeGit3Env(root),
      encoding: "utf8",
    });
    expect(head && isSymbolicRef(head) ? `${head.target}\n` : "").toBe(symref.stdout);
    expect((await refs.resolve("HEAD"))?.objectId).toBe(g(dir, ["rev-parse", "HEAD"]).trim());
    for (const ref of reflogs) expect(await reflog(refs, ref)).toBe(nativeReflog(dir, ref));
  }

  function tablesOf(dir: string): string[] {
    return readFileSync(join(dir, "tables.list"), "utf8").split("\n").filter(Boolean);
  }

  it("basic: commit and list refs; peeled tags are stored (t0610)", async () => {
    init();
    commit(repo, "file", 1);
    g(repo, ["tag", "file"]);
    g(repo, ["tag", "-m", "annotated tag", "test_tag", "HEAD"]);
    g(repo, ["branch", "other"]);
    const refs = await oursRefs();
    await expectSameRefs(repo, refs, ["HEAD", "refs/heads/main", "refs/heads/other"]);
    // show-ref -d: the tag's peeled value comes from its record
    const tag = await refs.get("refs/tags/test_tag");
    expect(tag && !isSymbolicRef(tag) ? tag.peeledObjectId : undefined).toBe(
      g(repo, ["rev-parse", "refs/tags/test_tag^{}"]).trim(),
    );
    expect(tag && !isSymbolicRef(tag) ? tag.objectId : undefined).toBe(
      g(repo, ["rev-parse", "refs/tags/test_tag"]).trim(),
    );
  });

  it("basic: for-each-ref can print symrefs; HEAD on a branch and detached (t0610)", async () => {
    init();
    commit(repo, "file", 1);
    g(repo, ["symbolic-ref", "refs/heads/sym", "refs/heads/main"]);
    await expectSameRefs(repo, await oursRefs());
    commit(repo, "second", 2);
    g(repo, ["checkout", "-q", "--detach", "HEAD~1"]);
    const refs = await oursRefs();
    await expectSameRefs(repo, refs);
    const head = await refs.get("HEAD");
    expect(head && isSymbolicRef(head)).toBe(false);
  });

  it("ref transaction: ref deletion leaves a tombstone over the older table (t0610)", async () => {
    init();
    commit(repo, "file", 1);
    g(repo, ["tag", "file"]);
    g(repo, ["branch", "doomed"]);
    const noCompaction = { GIT_TEST_REFTABLE_AUTOCOMPACTION: "false" };
    g(repo, ["update-ref", "-d", "refs/tags/file"], noCompaction);
    g(repo, ["branch", "-D", "doomed"], noCompaction);
    const stack = join(repo, ".git", "reftable");
    const tables = tablesOf(stack);
    expect(tables.length).toBeGreaterThan(1);
    // the newest tables hold deletion records hiding the older ones
    const deletions = tables
      .map((t) => openReftable(new Uint8Array(readFileSync(join(stack, t))), t))
      .flatMap((t) => [...t.refs()].filter((r) => r.value.type === "deletion").map((r) => r.name));
    expect(deletions.sort()).toEqual(["refs/heads/doomed", "refs/tags/file"]);
    const refs = await oursRefs();
    expect(await refs.get("refs/tags/file")).toBeUndefined();
    expect(await refs.get("refs/heads/doomed")).toBeUndefined();
    // a deleted ref's reflog is gone too
    expect(await refs.getReflog?.("refs/heads/doomed")).toBeUndefined();
    await expectSameRefs(repo, refs, ["HEAD", "refs/heads/main"]);
  });

  it("ref transaction: env var disables compaction; pack-refs: compacts tables (t0610)", async () => {
    init();
    const noCompaction = { GIT_TEST_REFTABLE_AUTOCOMPACTION: "false" };
    for (let i = 1; i <= 6; i++) {
      commit(repo, `c${i}`, i, noCompaction);
      g(repo, ["branch", `b${i}`], noCompaction);
    }
    const stack = join(repo, ".git", "reftable");
    expect(tablesOf(stack).length).toBeGreaterThan(6);
    await expectSameRefs(repo, await oursRefs(), ["HEAD", "refs/heads/main", "refs/heads/b3"]);
    // ref transaction: writes cause auto-compaction
    commit(repo, "c7", 7);
    expect(tablesOf(stack).length).toBeLessThan(13);
    await expectSameRefs(repo, await oursRefs(), ["HEAD", "refs/heads/main"]);
    g(repo, ["pack-refs"]);
    expect(tablesOf(stack)).toHaveLength(1);
    await expectSameRefs(repo, await oursRefs(), ["HEAD", "refs/heads/main", "refs/heads/b6"]);
  });

  it("many refs and a small reftable.blockSize: many blocks, restarts, index and obj blocks", async () => {
    init();
    g(repo, ["config", "reftable.blockSize", "512"]);
    g(repo, ["config", "reftable.restartInterval", "4"]);
    commit(repo, "base", 1);
    commit(repo, "next", 2);
    const head = g(repo, ["rev-parse", "HEAD"]).trim();
    const parent = g(repo, ["rev-parse", "HEAD~1"]).trim();
    const lines: string[] = [];
    for (let i = 0; i < 600; i++) {
      const name = `refs/heads/topic/${String(i).padStart(4, "0")}-${"x".repeat(i % 7)}`;
      lines.push(`create ${name} ${i % 3 === 0 ? parent : head}\n`);
    }
    for (let i = 0; i < 40; i++) lines.push(`create refs/tags/t${i} ${head}\n`);
    spawnSync(git3 as string, ["update-ref", "--stdin"], {
      cwd: repo,
      env: nativeGit3Env(root),
      input: lines.join(""),
    });
    g(repo, ["pack-refs"]);
    const stack = join(repo, ".git", "reftable");
    const [only] = tablesOf(stack);
    const table = openReftable(new Uint8Array(readFileSync(join(stack, only as string))), only);
    expect(table.blockSize).toBe(512);
    const { blocks } = table.verify();
    expect(blocks.ref).toBeGreaterThan(20);
    expect(blocks.index).toBeGreaterThan(0);
    expect(blocks.obj).toBeGreaterThan(0);
    // a lookup through the ref index, and one past the last key
    expect(table.getRef("refs/heads/topic/0300-xxxxxx")?.value.type).toBe("id");
    expect(table.getRef("refs/zzz")).toBeUndefined();
    await expectSameRefs(repo, await oursRefs(), ["HEAD", "refs/heads/main"]);
    // a prefix listing, in name order
    const refs = await oursRefs();
    const tags: string[] = [];
    for await (const r of refs.list("refs/tags/")) tags.push(r.name);
    expect(tags.map((t) => `${t}\n`).join("")).toBe(
      g(repo, ["for-each-ref", "--format=%(refname)", "refs/tags/"]),
    );
  });

  it("reflog: timezone offset is stored in minutes; deleted entries and messages (t0610)", async () => {
    init();
    commit(repo, "min", 0, { GIT_COMMITTER_DATE: "1234567890 -1200" });
    commit(repo, "east", 0, { GIT_COMMITTER_DATE: "1234567890 +0530" });
    commit(repo, "west", 0, { GIT_COMMITTER_DATE: "1234567890 -0830" });
    commit(repo, "max", 0, { GIT_COMMITTER_DATE: "1234567890 +1400" });
    g(repo, ["checkout", "-q", "-b", "side"]);
    commit(repo, "on side", 5);
    g(repo, ["checkout", "-q", "main"]);
    await expectSameRefs(repo, await oursRefs(), ["HEAD", "refs/heads/main", "refs/heads/side"]);
    // reflog: can delete separate reflog entries
    g(repo, ["reflog", "delete", "refs/heads/main@{1}"]);
    g(repo, ["reflog", "delete", "HEAD@{2}"]);
    await expectSameRefs(repo, await oursRefs(), ["HEAD", "refs/heads/main"]);
    // reflog: renaming branch writes reflog entry
    g(repo, ["branch", "-m", "side", "renamed"]);
    await expectSameRefs(repo, await oursRefs(), ["HEAD", "refs/heads/renamed"]);
    const refs = await oursRefs();
    expect(await refs.getReflog?.("refs/heads/side")).toBeUndefined();
    // a reftable rename logs a deletion and a creation: git counts both (`ref@{n}`)
    const renamed =
      (await (await refs.getReflog?.("refs/heads/renamed"))?.getReverseEntries()) ?? [];
    expect(renamed[1]?.newId).toBe("0000000000000000000000000000000000000000");
    const last = renamed.length - 1;
    expect(renamed[last]?.newId).toBe(
      g(repo, ["rev-parse", `refs/heads/renamed@{${last}}`]).trim(),
    );
    const past = spawnSync(git3 as string, ["rev-parse", `renamed@{${renamed.length}}`], {
      cwd: repo,
      env: nativeGit3Env(root),
      encoding: "utf8",
    });
    expect(past.stderr).toContain(`only has ${renamed.length} entries`);
  });

  it("worktree: adding worktree creates separate stack; per-worktree refs (t0610)", async () => {
    init();
    commit(repo, "A", 1);
    g(repo, ["branch", "wt-branch"]);
    g(repo, ["worktree", "add", "-q", "../wt", "wt-branch"]);
    const wt = join(root, "wt");
    commit(wt, "on worktree", 2);
    g(wt, ["update-ref", "refs/bisect/per-worktree", "HEAD"]);
    g(repo, ["update-ref", "refs/worktree/main-only", "HEAD"]);
    expect(tablesOf(join(repo, ".git", "worktrees", "wt", "reftable")).length).toBeGreaterThan(0);

    const files = createNodeFilesApi({ rootDir: root });
    const { history } = await createGitFilesBackend({ files, gitDir: "repo/.git" });
    // the main worktree
    await expectSameRefs(repo, history.refs, ["HEAD", "refs/heads/wt-branch"]);
    // the linked worktree: its own HEAD and refs/bisect/, the shared refs
    const worktrees = await openGitLinkedWorktrees({
      files,
      gitDir: "repo/.git/worktrees/wt",
      history,
    });
    const current = (await worktrees.list()).find((w) => w.current);
    expect(current).toBeDefined();
    const wtRefs = await worktrees.refsOf(current as NonNullable<typeof current>);
    await expectSameRefs(wt, wtRefs, ["HEAD"]);
    // worktree: can access common refs, and other worktrees' refs by name
    expect((await history.refs.resolve("worktrees/wt/HEAD"))?.objectId).toBe(
      g(repo, ["rev-parse", "worktrees/wt/HEAD"]).trim(),
    );
    expect((await wtRefs.resolve("main-worktree/HEAD"))?.objectId).toBe(
      g(wt, ["rev-parse", "main-worktree/HEAD"]).trim(),
    );
    expect((await history.refs.resolve("worktrees/wt/refs/bisect/per-worktree"))?.objectId).toBe(
      g(repo, ["rev-parse", "worktrees/wt/refs/bisect/per-worktree"]).trim(),
    );
  });

  it("fetch: accessing FETCH_HEAD special ref works (t0610)", async () => {
    init();
    commit(repo, "A", 1);
    g(root, ["init", "-q", "upstream"]);
    commit(join(root, "upstream"), "upstream", 2);
    g(repo, ["fetch", "-q", "../upstream"]);
    const refs = await oursRefs();
    const fetchHead = await refs.get("FETCH_HEAD");
    expect(fetchHead && !isSymbolicRef(fetchHead) ? fetchHead.objectId : undefined).toBe(
      g(repo, ["rev-parse", "FETCH_HEAD"]).trim(),
    );
  });

  describe("commands on a reftable repository", () => {
    async function build() {
      init();
      mkdirSync(join(repo, "dir"), { recursive: true });
      for (let i = 1; i <= 4; i++) {
        spawnSync("sh", ["-c", `echo ${i} > file${i}.txt`], { cwd: repo });
        g(repo, ["add", "."]);
        commit(repo, `commit ${i}`, i);
        if (i === 2) {
          g(repo, ["tag", "-m", "release", "v1"]);
          g(repo, ["branch", "maint"]);
        }
      }
      g(repo, ["tag", "light"]);
      spawnSync("sh", ["-c", "echo changed > file1.txt; echo new > untracked.txt"], { cwd: repo });
      return openOurs(repo);
    }

    it("log, status, branch and tag listings and rev-parse answer as native git", async () => {
      const git = await build();
      expect(await git.log().callText({ pretty: "tformat:%H %d %s" })).toBe(
        g(repo, ["log", "--decorate=short", "--format=%H %d %s"]),
      );
      expect(await git.log().all().callText({ pretty: "tformat:%H %s" })).toBe(
        g(repo, ["log", "--all", "--format=%H %s"]),
      );
      const status = await git.status().callText({ format: "short", branch: true });
      expect(status.text).toBe(g(repo, ["status", "--short", "--branch"]));
      const branches = (await git.branchList().call()).map((r) => r.name);
      expect(branches.map((b) => `${b}\n`).join("")).toBe(
        g(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/"]),
      );
      const tags = (await git.tagList().call()).map((r) => r.name);
      expect(tags.map((t) => `${t}\n`).join("")).toBe(
        g(repo, ["for-each-ref", "--format=%(refname)", "refs/tags/"]),
      );
      for (const rev of ["HEAD", "main", "maint", "v1", "v1^{}", "light", "HEAD~2", "HEAD@{1}"]) {
        const ours = await git.revParse().setRevision(rev).call();
        expect(`${rev} ${ours.objectId}`).toBe(`${rev} ${g(repo, ["rev-parse", rev]).trim()}`);
      }
      const reflog = await git.reflog().setRef("HEAD").call();
      expect(reflog.map((e) => `${e.newId} ${e.comment}\n`).join("")).toBe(
        g(repo, ["reflog", "show", "--format=%H %gs", "HEAD"]),
      );
    });

    it("writes refuse with ReftableWriteUnsupportedError and leave the repository unchanged", async () => {
      const git = await build();
      g(repo, ["add", "file1.txt"]);
      const before = snapshot(join(repo, ".git"));
      const worktreeBefore = readFileSync(join(repo, "file1.txt"), "utf8");
      await expect(git.branchCreate().setName("topic").call()).rejects.toBeInstanceOf(
        ReftableWriteUnsupportedError,
      );
      await expect(git.branchCreate().setName("topic").call()).rejects.toThrow(
        "writing the reftable ref storage (extensions.refStorage = reftable) is not supported",
      );
      await expect(git.tag().setName("t2").call()).rejects.toBeInstanceOf(
        ReftableWriteUnsupportedError,
      );
      await expect(git.commit().setMessage("refused").call()).rejects.toBeInstanceOf(
        ReftableWriteUnsupportedError,
      );
      await expect(git.checkout().setName("maint").call()).rejects.toBeInstanceOf(
        ReftableWriteUnsupportedError,
      );
      // fsck reads reflogs and worktree HEADs as files: refused until it reads them from the
      // reftable stack (statewalker-root#229), rather than misreport reflog-only objects
      await expect(git.fsck().call()).rejects.toBeInstanceOf(ReftableWriteUnsupportedError);
      expect(snapshot(join(repo, ".git"))).toEqual(before);
      expect(readFileSync(join(repo, "file1.txt"), "utf8")).toBe(worktreeBefore);
      // native git still reads the repository as before
      expect(g(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/topic"])).toBe("");
      expect(g(repo, ["fsck", "--no-progress"])).toBe("");
    });
  });

  it("reflog expire's tombstones: more records than the table has bytes", async () => {
    // a files repository with a long reflog, migrated, then expired: git writes one deletion
    // record per entry, deflated to less than a byte each (statewalker/webrun-vcs#225)
    g(root, ["init", "-q", "--ref-format=files", "repo"]);
    commit(repo, "one", 1);
    const id = g(repo, ["rev-parse", "HEAD"]).trim();
    const n = 50000;
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      lines.push(`${id} ${id} T <t@example.com> ${1700000000 + i} +0000\tupdate ${i}\n`);
    }
    appendFileSync(join(repo, ".git", "logs", "refs", "heads", "main"), lines.join(""));
    g(repo, ["refs", "migrate", "--ref-format=reftable"]);
    g(repo, [
      "-c",
      "reftable.blockSize=65536",
      "reflog",
      "expire",
      "--expire=now",
      "--expire-unreachable=now",
      "refs/heads/main",
    ]);
    const stack = join(repo, ".git", "reftable");
    const newest = tablesOf(stack).at(-1) as string;
    const bytes = new Uint8Array(readFileSync(join(stack, newest)));
    const table = openReftable(bytes, newest);
    let tombstones = 0;
    for (const log of table.logs("refs/heads/main")) if (!log.update) tombstones++;
    expect(tombstones).toBeGreaterThan(n);
    expect(tombstones).toBeGreaterThan(bytes.length);
    const refs = await oursRefs();
    await expectSameRefs(repo, refs, ["HEAD", "refs/heads/main"]);
    expect(nativeReflog(repo, "refs/heads/main")).toBe("");
    expect(await (await refs.getReflog?.("refs/heads/main"))?.getReverseEntries()).toEqual([]);
  });

  it("a large reftable.restartInterval with long names: names repeated per record", async () => {
    init();
    g(repo, ["config", "reftable.restartInterval", "65535"]);
    commit(repo, "base", 1);
    const head = g(repo, ["rev-parse", "HEAD"]).trim();
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      lines.push(`create refs/heads/${"n".repeat(250)}/${String(i).padStart(4, "0")} ${head}\n`);
    }
    spawnSync(git3 as string, ["update-ref", "--stdin"], {
      cwd: repo,
      env: nativeGit3Env(root),
      input: lines.join(""),
    });
    g(repo, ["pack-refs"]);
    const stack = join(repo, ".git", "reftable");
    const [only] = tablesOf(stack);
    const table = openReftable(new Uint8Array(readFileSync(join(stack, only as string))), only);
    expect(table.verify().blocks.ref).toBeGreaterThan(0);
    const refs = await oursRefs();
    await expectSameRefs(repo, refs, ["HEAD", "refs/heads/main"]);
    const last = `refs/heads/${"n".repeat(250)}/0299`;
    expect((await refs.resolve(last))?.objectId).toBe(head);
  });
});

/** Every file under `dir` with its bytes (as hex) and mtime: what a write would change. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, prefix: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const s = statSync(full);
      if (s.isDirectory()) walk(full, `${prefix}${name}/`);
      else out[`${prefix}${name}`] = `${s.mtimeMs} ${readFileSync(full).toString("hex")}`;
    }
  };
  walk(dir, "");
  return out;
}
