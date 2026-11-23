/**
 * `git.gc()` against native `git gc`: each scenario builds a repository with native git,
 * copies it (`cp -a`), runs native `git gc <args>` in one copy and ours with the same options
 * in the other, and compares the whole result (`gcTwins`: the loose objects, the packs by kind
 * with their objects and a cruft pack's `.mtimes`, `.keep`/`.promisor`/`.rev`/`.bitmap` files,
 * packed-refs bytes, loose refs, reflogs, worktree administrative files, `rr-cache`, `shallow`,
 * the commit-graph, `info/refs` and `objects/info/packs`), checks ours with native `git fsck
 * --strict`, `commit-graph verify` and `rev-list --test-bitmap`, then runs a second gc on each
 * and compares again. Pack bytes are never compared (delta choices may differ). Scenarios come
 * from git's t6500-gc, t5304-prune, t5329-pack-objects-cruft, t6501-freshen-objects and
 * t7700-repack, each named by its source.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GarbageCollectCommand } from "../src/commands/gc-command.js";
import {
  DAY,
  gcTwins,
  holds,
  initRepo,
  type NativeRepo,
  NOW,
  newCase,
} from "./gc-native-twins-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;

describeGit("gc twins: objects", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "gc-twins-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A small history on main, a topic branch, a tag. */
  function history(name: string) {
    const caseDir = newCase(root, name);
    const r = initRepo(root, caseDir);
    r.commit("one", { "a.txt": "a\n", "dir/b.txt": "b\n" });
    r.commit("two", { "a.txt": "a2\n" });
    r.git(["tag", "-a", "-m", "v1", "v1"]);
    r.git(["checkout", "-q", "-b", "topic"]);
    r.commit("three", { "c.txt": "c\n" });
    r.git(["checkout", "-q", "main"]);
    return { caseDir, r };
  }

  it("t6500-gc 'gc empty repository'", async () => {
    const caseDir = newCase(root, "empty");
    initRepo(root, caseDir);
    await gcTwins(root, caseDir);
  });

  it("t6500-gc: a plain history, everything loose", async () => {
    const { caseDir } = history("plain");
    await gcTwins(root, caseDir);
  });

  it("t5304-prune: fresh and old unreachable loose objects (default grace period)", async () => {
    const { caseDir, r } = history("unreachable-loose");
    const fresh = r.blob("fresh\n");
    const old = r.blob("old\n");
    r.age(old, 30);
    void fresh;
    await gcTwins(root, caseDir);
  });

  it("t5304-prune: --prune=now drops every unreachable object", async () => {
    const { caseDir, r } = history("prune-now");
    r.blob("fresh\n");
    r.age(r.blob("old\n"), 30);
    await gcTwins(root, caseDir, { args: ["--prune=now"], ours: (g) => g.setPrune("now") });
  });

  it("t6501-freshen-objects: an old object a young unreachable one reaches is kept", async () => {
    const { caseDir, r } = history("freshen");
    // an unreachable commit: young, its tree and blob old
    const blob = r.blob("deep\n");
    const tree = r.git(["mktree"], { input: `100644 blob ${blob}\tdeep.txt\n` });
    const commit = r.git(["commit-tree", tree, "-m", "dangling"]);
    r.age(blob, 30);
    r.age(tree, 30);
    void commit;
    await gcTwins(root, caseDir);
  });

  it("t5304-prune: --no-prune keeps every unreachable object", async () => {
    const { caseDir, r } = history("no-prune");
    r.age(r.blob("old\n"), 300);
    await gcTwins(root, caseDir, { args: ["--no-prune"], ours: (g) => g.setPrune(false) });
  });

  it("t6500-gc: gc.cruftPacks=false (repack -A, unreachable objects loosened)", async () => {
    const { caseDir, r } = history("no-cruft");
    r.git(["repack", "-adq"]);
    r.git(["branch", "-D", "topic"]);
    r.git(["reflog", "expire", "--expire=now", "--all"]);
    r.git(["config", "gc.cruftPacks", "false"]);
    await gcTwins(root, caseDir);
  });

  it("t6500-gc: gc.pruneExpire=never", async () => {
    const { caseDir, r } = history("never");
    r.age(r.blob("old\n"), 300);
    r.git(["config", "gc.pruneExpire", "never"]);
    await gcTwins(root, caseDir);
  });

  it("t5329-pack-objects-cruft: unreachable packed objects go to a cruft pack", async () => {
    const { caseDir, r } = history("cruft");
    r.git(["repack", "-adq"]);
    r.git(["branch", "-D", "topic"]);
    r.git(["reflog", "expire", "--expire=now", "--all"]);
    r.agePacks(1);
    await gcTwins(root, caseDir);
  });

  it("detached HEAD, annotated and nested tags", async () => {
    const { caseDir, r } = history("tags");
    r.git(["tag", "-a", "-m", "outer", "nested", "v1"]);
    r.git(["tag", "light", "topic"]);
    const blob = r.blob("tagged blob\n");
    r.git(["tag", "-a", "-m", "blob tag", "blobtag", blob]);
    r.git(["checkout", "-q", "--detach", "HEAD~1"]);
    r.commit("detached", { "d.txt": "d\n" });
    await gcTwins(root, caseDir, { args: ["--prune=now"], ours: (g) => g.setPrune("now") });
  });

  it("t5329-pack-objects-cruft: an existing cruft pack is rewritten with its .mtimes", async () => {
    const { caseDir, r } = history("cruft-again");
    r.git(["branch", "-D", "topic"]);
    r.git(["reflog", "expire", "--expire=now", "--all"]);
    r.git(["gc", "-q"]);
    // a second unreachable generation, younger
    r.blob("later\n");
    r.agePacks(2);
    await gcTwins(root, caseDir);
  });

  it("t5329-pack-objects-cruft: cruft objects past the expiration are dropped", async () => {
    const { caseDir, r } = history("cruft-expire");
    r.git(["branch", "-D", "topic"]);
    r.git(["reflog", "expire", "--expire=now", "--all"]);
    r.git(["gc", "-q"]);
    r.agePacks(30);
    await gcTwins(root, caseDir);
  });

  it("t6500-gc: --aggressive (repack -f --depth=50 --window=250)", async () => {
    const { caseDir, r } = history("aggressive");
    for (let i = 0; i < 5; i++) r.commit(`more ${i}`, { "a.txt": `${"line\n".repeat(50)}${i}\n` });
    await gcTwins(root, caseDir, { args: ["--aggressive"], ours: (g) => g.setAggressive(true) });
  });

  it("t6500-gc: gc.aggressiveDepth/Window are read", async () => {
    const { caseDir, r } = history("aggressive-config");
    r.git(["config", "gc.aggressiveDepth", "3"]);
    r.git(["config", "gc.aggressiveWindow", "4"]);
    await gcTwins(root, caseDir, { args: ["--aggressive"], ours: (g) => g.setAggressive(true) });
  });

  it("t6500-gc 'gc --keep-largest-pack'", async () => {
    const { caseDir, r } = history("keep-largest");
    r.git(["repack", "-adq"]);
    r.commit("four", { "big.txt": "x".repeat(5000) });
    r.git(["repack", "-dq"]);
    r.commit("five", { "e.txt": "e\n" });
    r.git(["repack", "-dq"]);
    r.git(["branch", "-D", "topic"]);
    await gcTwins(root, caseDir, {
      args: ["--keep-largest-pack"],
      ours: (g) => g.setKeepLargestPack(true),
    });
  });

  it("t6500-gc 'bigPackThreshold' keeps packs at least that big", async () => {
    const { caseDir, r } = history("big-pack");
    r.commit("big", { "big.bin": Array.from({ length: 4000 }, (_, i) => `${i * 7919}`).join(",") });
    r.git(["repack", "-adq"]);
    r.commit("small", { "s.txt": "s\n" });
    r.git(["repack", "-dq"]);
    r.git(["config", "gc.bigPackThreshold", "2k"]);
    await gcTwins(root, caseDir);
  });

  it("t7700-repack: a .keep pack stays, its objects stay out of the new pack", async () => {
    const { caseDir, r } = history("keep");
    r.git(["repack", "-adq"]);
    const pack = r.git(["rev-parse", "--git-path", "objects/pack"]);
    const { readdirSync, writeFileSync } = await import("node:fs");
    const name = readdirSync(join(r.dir, pack)).find((n) => n.endsWith(".pack")) as string;
    writeFileSync(join(r.dir, pack, name.replace(/\.pack$/, ".keep")), "kept by test\n");
    r.commit("after keep", { "k.txt": "k\n" });
    await gcTwins(root, caseDir, { args: ["--prune=now"], ours: (g) => g.setPrune("now") });
  });

  it("t6500-gc: a lone .idx (no .pack) is removed with its siblings", async () => {
    const { caseDir, r } = history("lone-idx");
    r.git(["repack", "-adq"]);
    const { readdirSync, copyFileSync } = await import("node:fs");
    const dir = join(r.gitDir, "objects", "pack");
    const name = readdirSync(dir).find((n) => n.endsWith(".idx")) as string;
    const fake = "pack-0123456789012345678901234567890123456789";
    copyFileSync(join(dir, name), join(dir, `${fake}.idx`));
    copyFileSync(join(dir, name), join(dir, `${fake}.keep`));
    await gcTwins(root, caseDir);
  });
});

describeGit("gc twins: expiry and storage", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "gc-twins-expiry-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function base(name: string) {
    const caseDir = newCase(root, name);
    const r = initRepo(root, caseDir);
    r.commit("one", { "a.txt": "a\n" });
    r.commit("two", { "a.txt": "a2\n", "b.txt": "b\n" });
    return { caseDir, r };
  }

  it("t5304-prune 'prune --expire': --prune=<date> between two ages", async () => {
    const { caseDir, r } = base("prune-date");
    r.age(r.blob("three days\n"), 3);
    r.age(r.blob("ten days\n"), 10);
    await gcTwins(root, caseDir, {
      args: ["--prune=1.week.ago"],
      ours: (g) => g.setPrune("1.week.ago"),
      graceSeconds: 7 * DAY,
    });
  });

  it("t5304-prune 'gc: prune old objects after local clone' / gc.pruneExpire in days", async () => {
    const { caseDir, r } = base("prune-config");
    r.age(r.blob("three days\n"), 3);
    r.age(r.blob("ten days\n"), 10);
    r.git(["config", "gc.pruneExpire", "5.days.ago"]);
    await gcTwins(root, caseDir, { graceSeconds: 5 * DAY });
  });

  it("t5304-prune 'prune: prune former temporary objects' / stale temporaries", async () => {
    const { caseDir, r } = base("temporaries");
    const { mkdirSync, writeFileSync, utimesSync } = await import("node:fs");
    const objects = join(r.gitDir, "objects");
    const files = [
      [join(objects, "ab"), "tmp_obj_old", 30],
      [join(objects, "ab"), "tmp_obj_young", 1],
      [join(objects, "pack"), "tmp_pack_old", 30],
      [join(objects, "pack"), "tmp_idx_young", 1],
    ] as const;
    for (const [dir, name, days] of files) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), "x");
      utimesSync(join(dir, name), NOW - days * DAY, NOW - days * DAY);
    }
    await gcTwins(root, caseDir, { twice: false });
  });

  it("t5304-prune: --prune=now removes the young temporaries too", async () => {
    const { caseDir, r } = base("temporaries-now");
    const { mkdirSync, writeFileSync, utimesSync } = await import("node:fs");
    const dir = join(r.gitDir, "objects", "cd");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tmp_obj_young"), "x");
    utimesSync(join(dir, "tmp_obj_young"), NOW - DAY, NOW - DAY);
    await gcTwins(root, caseDir, { args: ["--prune=now"], ours: (g) => g.setPrune("now") });
  });

  it("t6500-gc: gc.cruftPacks=false, an old pack's unreachable objects are dropped", async () => {
    const { caseDir, r } = base("no-cruft-old");
    r.git(["checkout", "-q", "-b", "gone"]);
    r.commit("gone", { "g.txt": "g\n" });
    r.git(["checkout", "-q", "main"]);
    r.git(["repack", "-adq"]);
    r.git(["branch", "-D", "gone"]);
    r.git(["reflog", "expire", "--expire=now", "--all"]);
    r.agePacks(30);
    r.git(["config", "gc.cruftPacks", "false"]);
    await gcTwins(root, caseDir);
  });

  it("t5329-pack-objects-cruft 'gc.maxCruftSize'", async () => {
    const { caseDir, r } = base("max-cruft");
    for (let i = 0; i < 3; i++) {
      const noise = Array.from(
        { length: 30000 },
        (_, k) => ((k * 2654435761 + i) >>> 7) % 997,
      ).join(",");
      r.blob(`${i}:${noise}\n`);
    }
    r.git(["config", "gc.maxCruftSize", "1m"]);
    await gcTwins(root, caseDir);
  });

  it("t5319-multi-pack-index: gc replaces a multi-pack-index over the packs it removes", async () => {
    const { caseDir, r } = base("midx");
    r.git(["repack", "-dq"]);
    r.commit("three", { "c.txt": "c\n" });
    r.git(["repack", "-dq"]);
    r.git(["multi-pack-index", "write"]);
    await gcTwins(root, caseDir);
  });

  it("t5324-split-commit-graph: gc replaces a split commit-graph chain", async () => {
    const { caseDir, r } = base("split-graph");
    r.git(["commit-graph", "write", "--reachable", "--split"]);
    r.commit("three", { "c.txt": "c\n" });
    r.git(["commit-graph", "write", "--reachable", "--split"]);
    await gcTwins(root, caseDir);
  });

  it("t6500-gc: extensions.preciousObjects skips the repack and prune", async () => {
    const { caseDir, r } = base("precious");
    r.age(r.blob("old\n"), 30);
    r.git(["config", "core.repositoryformatversion", "1"]);
    r.git(["config", "extensions.preciousObjects", "true"]);
    await gcTwins(root, caseDir);
  });

  it("t7700-repack: repack.writeBitmaps=true in a non-bare repository", async () => {
    const { caseDir, r } = base("bitmap-nonbare");
    r.git(["config", "repack.writeBitmaps", "true"]);
    const twins = await gcTwins(root, caseDir);
    expect(twins.native.packs.some((p) => p.files.includes("bitmap"))).toBe(true);
  });

  it("t7700-repack: repack.writeBitmaps=true with a .keep pack warns and writes none", async () => {
    const { caseDir, r } = base("bitmap-keep");
    r.git(["repack", "-adq"]);
    const { readdirSync, writeFileSync } = await import("node:fs");
    const dir = join(r.gitDir, "objects", "pack");
    const name = readdirSync(dir).find((n) => n.endsWith(".pack")) as string;
    writeFileSync(join(dir, name.replace(/\.pack$/, ".keep")), "");
    r.commit("three", { "c.txt": "c\n" });
    r.git(["config", "repack.writeBitmaps", "true"]);
    r.git(["config", "repack.packKeptObjects", "false"]);
    const twins = await gcTwins(root, caseDir, { twice: false });
    const warnings = twins.nativeStderr.split("\n").filter((l) => l.startsWith("warning:"));
    expect(warnings.length).toBeGreaterThan(0);
    expect(twins.result.warnings ?? []).toEqual(warnings);
  });
});

describeGit("gc twins: roots", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "gc-twins-roots-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const both = [
    ["default", [], undefined],
    ["--prune=now", ["--prune=now"], (g: GarbageCollectCommand) => g.setPrune("now")],
  ] as const;

  /** A repository on main with two commits; `extra` adds the scenario's state. */
  function base(name: string) {
    const caseDir = newCase(root, name);
    const r = initRepo(root, caseDir);
    r.commit("one", { "a.txt": "a\n" });
    r.commit("two", { "a.txt": "a2\n", "b.txt": "b\n" });
    return { caseDir, r };
  }

  for (const [label, args, ours] of both) {
    it(`t5304-prune: objects only in reflogs, unexpired (${label})`, async () => {
      const { caseDir, r } = base(`reflog-young-${label}`);
      r.commit("dropped", { "c.txt": "c\n" });
      r.git(["reset", "-q", "--hard", "HEAD~1"]);
      rmSync(join(r.gitDir, "ORIG_HEAD"));
      await gcTwins(root, caseDir, { args: [...args], ...(ours ? { ours } : {}) });
    });

    it(`t5304-prune: objects only in expired reflog entries (${label})`, async () => {
      const { caseDir, r } = base(`reflog-old-${label}`);
      // the unreachable entries are 40 days old (gc.reflogExpireUnreachable: 30 days)
      r.commit("dropped", { "c.txt": "c\n" }, NOW - 40 * DAY);
      r.git(["reset", "-q", "--hard", "HEAD~1"], {
        env: { GIT_COMMITTER_DATE: `${NOW - 40 * DAY} +0000` },
      });
      rmSync(join(r.gitDir, "ORIG_HEAD"));
      // and a reachable history older than gc.reflogExpire (90 days)
      r.git(["checkout", "-q", "-b", "old"]);
      r.commit("ancient", { "o.txt": "o\n" }, NOW - 100 * DAY);
      r.git(["checkout", "-q", "main"]);
      await gcTwins(root, caseDir, { args: [...args], ...(ours ? { ours } : {}) });
    });

    it(`t5304-prune: objects only in the index, its cache-tree and resolve-undo (${label})`, async () => {
      const { caseDir, r } = base(`index-${label}`);
      // a conflict resolved with add: resolve-undo records the stages
      r.git(["checkout", "-q", "-b", "side", "HEAD~1"]);
      r.commit("side", { "a.txt": "side\n" });
      r.git(["checkout", "-q", "main"]);
      spawnMerge(r);
      r.put("a.txt", "resolved\n");
      r.git(["add", "a.txt"]);
      r.put("staged/new.txt", "only staged\n");
      r.git(["add", "staged/new.txt"]);
      // the cache-tree's trees are stored, no commit names them
      const tree = r.git(["write-tree"]);
      const staged = r.git(["rev-parse", ":staged/new.txt"]);
      const twins = await gcTwins(root, caseDir, { args: [...args], ...(ours ? { ours } : {}) });
      expect(holds(twins.ours, tree)).toBe("pack");
      expect(holds(twins.ours, staged)).toBe("pack");
    });

    it(`t5304-prune: stash, notes and replace refs (${label})`, async () => {
      const { caseDir, r } = base(`stash-notes-${label}`);
      r.put("a.txt", "stashed\n");
      r.git(["stash", "-q"]);
      r.put("a.txt", "stashed and dropped\n");
      r.git(["stash", "-q"]);
      r.git(["stash", "drop", "-q"]);
      r.git(["notes", "add", "-m", "a note", "HEAD"]);
      const one = r.git(["rev-parse", "HEAD~1"]);
      const replacement = r.git(["commit-tree", `${one}^{tree}`, "-m", "replacement"]);
      r.git(["replace", one, replacement]);
      await gcTwins(root, caseDir, { args: [...args], ...(ours ? { ours } : {}) });
    });

    it(`t5304-prune: pseudo-refs are no roots (${label})`, async () => {
      const { caseDir, r } = base(`pseudo-${label}`);
      // ORIG_HEAD
      const orig = r.commit("orig", { "o.txt": "o\n" });
      r.git(["reset", "-q", "--hard", "HEAD~1"]);
      // FETCH_HEAD
      const other = initRepo(root, caseDir, false, "other");
      other.commit("fetched", { "f.txt": "fetched\n" });
      r.git(["fetch", "-q", "../other", "main"]);
      // CHERRY_PICK_HEAD (a conflict)
      other.commit("pick", { "a.txt": "picked\n" });
      r.git(["fetch", "-q", "../other", "main"]);
      const pick = r.git(["rev-parse", "FETCH_HEAD"]);
      spawnSyncGit(r, ["cherry-pick", pick]);
      r.git(["reflog", "expire", "--expire=now", "--all"]);
      // the cherry-pick's conflict is left in place: fsck of both says the same
      const twins = await gcTwins(root, caseDir, { args: [...args], ...(ours ? { ours } : {}) });
      // only ORIG_HEAD names it: unreachable, as in git (cruft while young, gone with now)
      expect(holds(twins.ours, orig)).toBe(args.length ? undefined : "cruft");
      expect(holds(twins.ours, pick)).toBe(args.length ? undefined : "cruft");
    });

    it(`t5304-prune: MERGE_HEAD of a merge in progress (${label})`, async () => {
      const { caseDir, r } = base(`merge-head-${label}`);
      r.git(["checkout", "-q", "-b", "side", "HEAD~1"]);
      r.commit("side", { "s.txt": "s\n" });
      r.git(["checkout", "-q", "main"]);
      r.git(["merge", "-q", "--no-commit", "--no-ff", "side"]);
      r.git(["branch", "-D", "side"]);
      r.git(["reflog", "expire", "--expire=now", "--all"]);
      await gcTwins(root, caseDir, { args: [...args], ...(ours ? { ours } : {}) });
    });

    it(`t5304-prune: rebase-merge/orig-head and autostash (${label})`, async () => {
      const { caseDir, r } = base(`rebase-files-${label}`);
      const orig = r.commit("orig", { "o.txt": "o\n" });
      r.git(["reset", "-q", "--hard", "HEAD~1"]);
      rmSync(join(r.gitDir, "ORIG_HEAD"));
      r.put("a.txt", "autostashed\n");
      const stash = r.git(["stash", "create"]);
      r.git(["checkout", "-q", "--", "a.txt"]);
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(r.gitDir, "rebase-merge"));
      writeFileSync(join(r.gitDir, "rebase-merge", "orig-head"), `${orig}\n`);
      writeFileSync(join(r.gitDir, "rebase-merge", "autostash"), `${stash}\n`);
      r.git(["reflog", "expire", "--expire=now", "--all"]);
      await gcTwins(root, caseDir, { args: [...args], ...(ours ? { ours } : {}) });
    });
  }
});

/** `git merge` of `side` that stops on a conflict. */
function spawnMerge(r: NativeRepo) {
  spawnSyncGit(r, ["merge", "side"]);
}

/** A native git call that may fail (a conflict). */
function spawnSyncGit(r: NativeRepo, args: string[]) {
  try {
    r.git(args);
  } catch {
    // stopped on a conflict, as the scenario wants
  }
}
