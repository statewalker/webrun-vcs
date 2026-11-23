/**
 * `git.gc()` against native `git gc` (see `gc-native-twins.test.ts`) in repositories of other
 * shapes: linked worktrees (t2400-worktree-add, t2401-worktree-prune), rerere records
 * (t4200-rerere), alternates (t7700-repack), partial clones (t5616-partial-clone), shallow
 * clones (t5537-fetch-shallow), bare repositories with their bitmaps (t7700-repack,
 * t5310-pack-bitmaps), grafts (t6001-rev-list-graft, t5304-prune) and `--auto`
 * (t6500-gc).
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DAY,
  gcTwins,
  initRepo,
  NativeRepo,
  NOW,
  nativeIs25x,
  newCase,
  seventeenBlobs,
} from "./gc-native-twins-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "gc-twins-repos-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A repository on main with two commits and a tag. */
function base(name: string, bare = false) {
  const caseDir = newCase(root, name);
  const r = initRepo(root, caseDir);
  r.commit("one", { "a.txt": "a\n", "dir/b.txt": "b\n" });
  r.commit("two", { "a.txt": "a2\n" });
  r.git(["tag", "-a", "-m", "v1", "v1"]);
  if (!bare) return { caseDir, r };
  const src = join(caseDir, "src");
  rmSync(join(src, "work"), { recursive: true, force: true });
  new NativeRepo(root, src).git(["clone", "-q", "--bare", "--no-local", "repo", "bare.git"]);
  return { caseDir, r: new NativeRepo(root, join(src, "bare.git")) };
}

const pruneNow = {
  args: ["--prune=now"],
  ours: (g: import("../src/commands/gc-command.js").GarbageCollectCommand) => g.setPrune("now"),
};

describeGit("gc twins: linked worktrees", () => {
  for (const [label, run] of [
    ["default", {}],
    ["--prune=now", pruneNow],
  ] as const) {
    it(`t2400-worktree-add: what only a worktree's HEAD, index and reflog reach (${label})`, async () => {
      const { caseDir, r } = base(`worktree-${label}`);
      const wt = join(caseDir, "src", "wt");
      r.git(["worktree", "add", "-q", "--detach", wt]);
      const w = new NativeRepo(root, wt);
      w.commit("in the worktree", { "w.txt": "w\n" });
      w.commit("dropped in the worktree", { "w2.txt": "w2\n" });
      w.git(["reset", "-q", "--hard", "HEAD~1"]);
      w.put("staged.txt", "staged in the worktree\n");
      w.git(["add", "staged.txt"]);
      await gcTwins(root, caseDir, run);
    });
  }

  it("t2401-worktree-prune: a worktree whose directory was deleted (gc.worktreePruneExpire)", async () => {
    const { caseDir, r } = base("worktree-gone");
    const gone = join(caseDir, "src", "gone");
    const young = join(caseDir, "src", "young");
    r.git(["worktree", "add", "-q", "--detach", gone]);
    r.git(["worktree", "add", "-q", "--detach", young]);
    rmSync(gone, { recursive: true });
    rmSync(young, { recursive: true });
    // the gone one's index is older than three months, the young one's is not
    const old = NOW - 100 * DAY;
    utimesSync(join(r.gitDir, "worktrees", "gone", "index"), old, old);
    const result = await gcTwins(root, caseDir);
    expect(result.result.worktreesPruned).toEqual(["gone"]);
    expect(Object.keys(result.native.worktrees).some((k) => k.startsWith("gone/"))).toBe(false);
  });

  // 2.43 prunes worktrees after the repack (what only a pruned worktree reached is packed);
  // git master's gc.c runs `worktree prune` before the object step (the objects become
  // unreachable: cruft), as ours under 2.5x compatibility. Which 2.5x release moved it is not
  // pinned, so on 2.5x this runs only with GC_TWINS_ALL=1 (checked against git master)
  it.runIf(!nativeIs25x || process.env.GC_TWINS_ALL === "1")(
    "what only a pruned worktree reached is packed first",
    async () => {
      const { caseDir, r } = base("worktree-gone-objects");
      const gone = join(caseDir, "src", "gone");
      r.git(["worktree", "add", "-q", "--detach", gone]);
      new NativeRepo(root, gone).commit("only there", { "g.txt": "g\n" });
      rmSync(gone, { recursive: true });
      const old = NOW - 100 * DAY;
      utimesSync(join(r.gitDir, "worktrees", "gone", "index"), old, old);
      await gcTwins(root, caseDir);
    },
  );
});

describeGit("gc twins: rerere", () => {
  /** A conflict record `rr-cache/<id>/` with `files` dated `days` ago. */
  function record(r: NativeRepo, id: string, files: Record<string, number>) {
    const dir = join(r.gitDir, "rr-cache", id);
    mkdirSync(dir, { recursive: true });
    for (const [name, days] of Object.entries(files)) {
      writeFileSync(join(dir, name), `${name}\n`);
      utimesSync(join(dir, name), NOW - days * DAY, NOW - days * DAY);
    }
  }
  const id = (n: number) => n.toString(16).padStart(40, "a");

  it("t4200-rerere 'gc': old resolutions, old unresolved conflicts, variants", async () => {
    const { caseDir, r } = base("rerere");
    record(r, id(1), { preimage: 100, postimage: 70 }); // resolved, last used 70 days ago: goes
    record(r, id(2), { preimage: 100, postimage: 10 }); // used 10 days ago: stays
    record(r, id(3), { preimage: 20 }); // unresolved for 20 days: goes
    record(r, id(4), { preimage: 5 }); // unresolved for 5 days: stays
    record(r, id(5), { preimage: 100, postimage: 70, thisimage: 70 }); // thisimage goes too
    record(r, id(6), { preimage: 70, postimage: 70, "preimage.1": 1, "postimage.1": 1 });
    record(r, id(7), { "preimage.2": 30, "postimage.2": 30 }); // a hole at 0 and 1
    record(r, id(8), { preimage: 100, postimage: 70, junk: 1 }); // not empty: rmdir fails
    mkdirSync(join(r.gitDir, "rr-cache", "not-a-conflict-id"));
    await gcTwins(root, caseDir);
  });

  it("t4200-rerere: gc.rerereResolved/Unresolved in days", async () => {
    const { caseDir, r } = base("rerere-config");
    record(r, id(1), { preimage: 100, postimage: 8 });
    record(r, id(2), { preimage: 3 });
    r.git(["config", "gc.rerereResolved", "7"]);
    r.git(["config", "gc.rerereUnresolved", "2"]);
    await gcTwins(root, caseDir);
  });

  it("t4200-rerere: rerere.enabled=true creates rr-cache, false skips it", async () => {
    const { caseDir, r } = base("rerere-enabled");
    r.git(["config", "rerere.enabled", "true"]);
    await gcTwins(root, caseDir);
    const off = base("rerere-disabled");
    record(off.r, id(1), { preimage: 100, postimage: 70 });
    off.r.git(["config", "rerere.enabled", "false"]);
    await gcTwins(root, off.caseDir);
  });
});

describeGit("gc twins: alternates", () => {
  for (const [label, run] of [
    ["default", {}],
    ["--prune=now", pruneNow],
  ] as const) {
    it(`t7700-repack 'objects in packs marked .keep are not in new packs' / -l (${label})`, async () => {
      const caseDir = newCase(root, `alternates-${label}`);
      const shared = initRepo(root, caseDir, false, "shared");
      shared.commit("shared one", { "s.txt": "s\n" });
      shared.commit("shared two", { "s.txt": "s2\n" });
      shared.git(["repack", "-adq"]);
      shared.blob("loose in the alternate\n");
      const src = new NativeRepo(root, join(caseDir, "src"));
      src.git(["clone", "-q", "--shared", "shared", "repo"]);
      const r = new NativeRepo(root, join(caseDir, "src", "repo"));
      r.commit("own", { "o.txt": "own\n" });
      r.blob("own unreachable\n");
      await gcTwins(root, caseDir, run);
    });
  }
});

describeGit("gc twins: partial clones", () => {
  for (const [label, run] of [
    ["default", {}],
    ["--prune=now", pruneNow],
  ] as const) {
    it(`t5616-partial-clone 'gc' keeps promisor packs apart (${label})`, async () => {
      const caseDir = newCase(root, `partial-${label}`);
      const server = initRepo(root, caseDir, false, "server");
      server.commit("one", { "a.txt": "a\n", "big.txt": "big\n".repeat(100) });
      server.commit("two", { "a.txt": "a2\n" });
      server.git(["config", "uploadpack.allowFilter", "true"]);
      server.git(["config", "uploadpack.allowAnySHA1InWant", "true"]);
      const src = new NativeRepo(root, join(caseDir, "src"));
      src.git([
        "clone",
        "-q",
        "--no-local",
        "--filter=blob:none",
        `file://${join(caseDir, "src", "server")}`,
        "repo",
      ]);
      const r = new NativeRepo(root, join(caseDir, "src", "repo"));
      r.commit("local", { "l.txt": "local\n" });
      r.blob("local unreachable\n");
      await gcTwins(root, caseDir, run);
    });
  }
});

describeGit("gc twins: shallow repositories", () => {
  for (const [label, run] of [
    ["default", {}],
    ["--prune=now", pruneNow],
  ] as const) {
    it(`t5537-fetch-shallow: a shallow commit no ref reaches leaves shallow (${label})`, async () => {
      const caseDir = newCase(root, `shallow-${label}`);
      const server = initRepo(root, caseDir, false, "server");
      server.commit("one", { "a.txt": "a\n" });
      server.commit("two", { "a.txt": "a2\n" });
      server.git(["checkout", "-q", "-b", "side", "HEAD~1"]);
      server.commit("side", { "s.txt": "s\n" });
      server.git(["checkout", "-q", "main"]);
      const src = new NativeRepo(root, join(caseDir, "src"));
      src.git([
        "clone",
        "-q",
        "--depth=1",
        "--no-single-branch",
        `file://${join(caseDir, "src", "server")}`,
        "repo",
      ]);
      const r = new NativeRepo(root, join(caseDir, "src", "repo"));
      r.commit("local", { "l.txt": "l\n" });
      // the side branch's shallow commit becomes unreachable
      r.git(["update-ref", "-d", "refs/remotes/origin/side"]);
      r.git(["reflog", "expire", "--expire=now", "--all"]);
      await gcTwins(root, caseDir, run);
    });
  }
});

describeGit("gc twins: bare repositories", () => {
  it("t7700-repack: a bare repository's gc writes a bitmap and the commit-graph", async () => {
    const { caseDir, r } = base("bare", true);
    void r;
    await gcTwins(root, caseDir, { repo: "bare.git" });
  });

  it("t7700-repack: no bitmap with repack.writeBitmaps=false; gc.packRefs=notbare", async () => {
    const { caseDir, r } = base("bare-no-bitmap", true);
    r.git(["config", "repack.writeBitmaps", "false"]);
    r.git(["config", "gc.packRefs", "notbare"]);
    await gcTwins(root, caseDir, { repo: "bare.git" });
  });

  it("t6500-gc: gc.writeCommitGraph=false", async () => {
    const { caseDir, r } = base("no-commit-graph");
    r.git(["config", "gc.writeCommitGraph", "false"]);
    await gcTwins(root, caseDir);
  });

  it("t6500-gc: a bare repository with a .keep pack writes no bitmap", async () => {
    const { caseDir, r } = base("bare-keep", true);
    r.git(["repack", "-adq"]);
    const dir = join(r.dir, "objects", "pack");
    const name = readdirSync(dir).find((n) => n.endsWith(".pack")) as string;
    writeFileSync(join(dir, name.replace(/\.pack$/, ".keep")), "");
    const work = new NativeRepo(root, join(caseDir, "src", "repo"));
    work.commit("three", { "c.txt": "c\n" });
    work.git(["push", "-q", "../bare.git", "main"]);
    await gcTwins(root, caseDir, { repo: "bare.git" });
  });
});

describeGit("gc twins: grafts", () => {
  for (const [label, run] of [
    ["default", {}],
    ["--prune=now", pruneNow],
  ] as const) {
    it(`t6001-rev-list-graft: what grafts reach is kept, no commit-graph (${label})`, async () => {
      const { caseDir, r } = base(`grafts-${label}`);
      const lone = r.git(["commit-tree", "HEAD~1^{tree}", "-m", "grafted parent"]);
      const head = r.git(["rev-parse", "HEAD"]);
      mkdirSync(join(r.gitDir, "info"), { recursive: true });
      writeFileSync(join(r.gitDir, "info", "grafts"), `${head} ${lone}\n`);
      await gcTwins(root, caseDir, run);
    });
  }
});

describeGit("gc twins: --auto", () => {
  /** Native's and ours' `gc --auto` reading the repository's gc.auto (not the test's 0). */
  const auto = {
    args: ["--auto"],
    env: { GIT_CONFIG_COUNT: "1" },
    ours: (g: import("../src/commands/gc-command.js").GarbageCollectCommand) => g.setAuto(true),
  };

  it("t6500-gc 'auto gc with too many loose objects does not attempt to create bitmaps'", async () => {
    const { caseDir, r } = base("auto-loose");
    r.git(["config", "gc.autoDetach", "false"]);
    r.git(["config", "gc.auto", "1"]);
    for (const content of seventeenBlobs(3)) r.blob(content);
    r.git(["repack", "-adq"]);
    r.commit("loose", { "l.txt": "l\n" });
    for (const content of seventeenBlobs(3, "x")) r.blob(content);
    const { result } = await gcTwins(root, caseDir, { ...auto, twice: false });
    expect(result.details?.autoRepack).toBe("incremental");
  });

  it("t6500-gc: too many packs (gc.autoPackLimit) makes it a full repack", async () => {
    const { caseDir, r } = base("auto-packs");
    r.git(["config", "gc.autoDetach", "false"]);
    r.git(["config", "gc.autoPackLimit", "2"]);
    for (let i = 0; i < 3; i++) {
      r.commit(`pack ${i}`, { [`p${i}.txt`]: `${i}\n` });
      r.git(["repack", "-dq"]);
    }
    const { result } = await gcTwins(root, caseDir, { ...auto, twice: false });
    expect(result.details?.autoRepack).toBe("full");
  });

  it("t6500-gc 'background auto gc respects lock' / below every threshold: nothing done", async () => {
    const { caseDir, r } = base("auto-nothing");
    r.git(["config", "gc.autoDetach", "false"]);
    r.git(["config", "gc.autoPackLimit", "5"]);
    r.git(["config", "gc.auto", "10000"]);
    r.git(["repack", "-dq"]);
    const { result } = await gcTwins(root, caseDir, { ...auto, twice: false });
    expect(result.autoSkipped).toBe("not-needed");
  });

  it("t6500-gc 'gc --auto' with gc.bigPackThreshold keeps the big pack", async () => {
    const { caseDir, r } = base("auto-big");
    r.git(["config", "gc.autoDetach", "false"]);
    r.git(["config", "gc.autoPackLimit", "2"]);
    r.git(["config", "gc.bigPackThreshold", "2k"]);
    r.commit("big", { "big.bin": Array.from({ length: 4000 }, (_, i) => `${i * 7919}`).join(",") });
    r.git(["repack", "-adq"]);
    for (let i = 0; i < 3; i++) {
      r.commit(`pack ${i}`, { [`p${i}.txt`]: `${i}\n` });
      r.git(["repack", "-dq"]);
    }
    await gcTwins(root, caseDir, { ...auto, twice: false });
  });
});
