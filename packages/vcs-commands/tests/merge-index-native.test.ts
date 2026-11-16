/**
 * The index a merge, a cherry-pick and `cherry-pick -n` leave, against native git: the
 * cache-tree (`TREE` extension) unpack-trees writes, the version (3 exactly when an entry
 * has an extended flag), the skip-worktree bit of an entry the merge updates, the tree of an
 * index with intent-to-add entries (AUTO_MERGE), the racy entries `write_index_as_tree`
 * makes for `-n`, and restore_state dropping an assume-unchanged change. Each case builds
 * the same history twice, runs native git on one twin and ours on the other.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIndexFile } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResetMode } from "../src/index.js";
import {
  git,
  gitOk,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  snapshot,
} from "./merge-native-helpers.js";
import { buildHistory, type History } from "./merge-native-scenarios.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const T = (s: string) => `${s}\n${"line\n".repeat(6)}`;
const base = {
  "a.txt": T("a"),
  "b.txt": T("b"),
  "d/x.txt": T("dx"),
  "d/y.txt": T("dy"),
  "e/k.txt": T("ek"),
};

type Op = "merge" | "cherry-pick" | "cherry-pick -n";
const OPS: Op[] = ["merge", "cherry-pick", "cherry-pick -n"];

/** The index as both twins must agree on it: version, extensions, TREE bytes, entry flags. */
async function indexShape(dir: string): Promise<string> {
  const parsed = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
  const tree = parsed.extensionData.find((e) => e.signature === "TREE");
  const flags = parsed.entries.map(
    (e) =>
      `${e.path} ${e.stage}${e.skipWorktree ? " skip-worktree" : ""}${e.intentToAdd ? " ita" : ""}${e.assumeValid ? " assume-unchanged" : ""}`,
  );
  return [
    `v${parsed.version} ${parsed.extensions.join(",")}`,
    `TREE ${tree ? Buffer.from(tree.data).toString("hex") : "-"}`,
    ...flags,
  ].join("\n");
}

describeGit("the index merge and cherry-pick leave, against native git", () => {
  let root: string;
  let n = 0;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-index-native-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** Both twins, native run on one and ours on the other; native's exit status. */
  async function run(history: History, op: Op, after?: string) {
    const nd = join(root, `n${n}`);
    const od = join(root, `o${n++}`);
    for (const dir of [nd, od]) {
      buildHistory(root, dir, history);
      if (after) execFileSync("bash", ["-c", after], { cwd: dir, env: nativeGitEnv(root) });
    }
    const args = op === "merge" ? ["merge", "--no-edit", "side"] : [...op.split(" "), "side"];
    const native = git(root, nd, ...args).status;
    const g = await openOurs(od);
    // where native dies (exit 128) before it changes anything, ours throws
    let threw = false;
    try {
      if (op === "merge") {
        await g.merge().include("side").setAuthor(INTEROP_IDENT).setCommitter(INTEROP_IDENT).call();
      } else {
        await g
          .cherryPick()
          .include("side")
          .setNoCommit(op === "cherry-pick -n")
          .setCommitter(INTEROP_IDENT)
          .call();
      }
    } catch (e) {
      if (native !== 128) throw e;
      threw = true;
    }
    if (native === 128 && op === "merge") expect(threw).toBe(true);
    return { nd, od, native };
  }

  async function expectSame(nd: string, od: string) {
    expect(snapshot(root, od, normalizeState)).toEqual(snapshot(root, nd, normalizeState));
    expect(await indexShape(od)).toBe(await indexShape(nd));
  }

  const cases: { name: string; history: History; after?: string }[] = [
    {
      name: "clean, cache-tree primed",
      history: { base, main: { "b.txt": T("b1") }, side: { "d/x.txt": T("dx2") } },
      after: "git write-tree >/dev/null",
    },
    {
      name: "clean, no cache-tree",
      history: {
        base,
        main: { "b.txt": T("b1") },
        side: { "d/x.txt": T("dx2"), "n/m.txt": T("m") },
      },
      after:
        "git update-index --force-remove --cacheinfo 100644,$(git rev-parse HEAD:b.txt),b.txt && git update-index --add --cacheinfo 100644,$(git rev-parse HEAD:b.txt),b.txt",
    },
    {
      name: "conflict",
      history: {
        base,
        main: { "a.txt": T("a1") },
        side: { "a.txt": T("a2"), "d/x.txt": T("dx2") },
      },
      after: "git write-tree >/dev/null",
    },
    {
      name: "skip-worktree on the path the side changes",
      history: { base, main: { "b.txt": T("b1") }, side: { "a.txt": T("A") } },
      after: "git update-index --skip-worktree a.txt",
    },
    {
      name: "intent-to-add and skip-worktree elsewhere",
      history: { base, main: { "b.txt": T("b1") }, side: { "a.txt": T("A"), "d/x.txt": T("dx2") } },
      after:
        "echo n > new.txt && mkdir -p g && echo g > g/h.txt && git add -N new.txt g/h.txt && git update-index --skip-worktree e/k.txt",
    },
    {
      name: "a dirty file the side changes (refused)",
      history: { base, main: { "b.txt": T("b1") }, side: { "a.txt": T("A") } },
      after: "echo unstaged >> a.txt",
    },
    {
      name: "a staged change elsewhere",
      history: { base, main: { "b.txt": T("b1") }, side: { "a.txt": T("A") } },
      after: "echo staged >> e/k.txt && git add e/k.txt && echo unstaged >> d/y.txt",
    },
    {
      name: "index version 4",
      history: { base, main: { "b.txt": T("b1") }, side: { "d/x.txt": T("dx2") } },
      after: "git update-index --index-version 4",
    },
    {
      name: "index version 3 without extended flags",
      history: { base, main: { "b.txt": T("b1") }, side: { "d/x.txt": T("dx2") } },
      after: "git update-index --index-version 3",
    },
  ];
  for (const c of cases) {
    for (const op of OPS) {
      it(`${c.name}: ${op}`, async () => {
        const { nd, od } = await run(c.history, op, c.after);
        await expectSame(nd, od);
      });
    }
  }

  // a same-size edit that keeps the entry's mtime (in the future) under an index file newer
  // still: git trusts the stat, except after `-n` rewrote the index (write_index_as_tree),
  // which makes the entry racy and its change seen
  const RACY =
    "f=$(( $(date +%s) + 100 )); touch -d @$f a.txt; git add a.txt; " +
    "printf z | dd of=a.txt bs=1 seek=0 conv=notrunc 2>/dev/null; touch -d @$f a.txt; " +
    "touch -d @$(( f + 100 )) .git/index";
  for (const op of OPS) {
    it(`a racily clean same-size edit: ${op}`, async () => {
      const history = {
        base,
        config: { "core.trustctime": "false" },
        main: { "b.txt": T("b1") },
        side: { "a.txt": T("A") },
      };
      const { nd, od, native } = await run(history, op, RACY);
      // pinned: git keeps the edit (refuses) only with -n
      expect(native).toBe(op === "cherry-pick -n" ? 128 : 0);
      expect(snapshot(root, od, normalizeState)).toEqual(snapshot(root, nd, normalizeState));
    });
  }

  it("a refused merge drops the change of an assume-unchanged file (restore_state)", async () => {
    const { nd, od, native } = await run(
      { base, main: { "b.txt": T("b1") }, side: { "a.txt": T("A") } },
      "merge",
      "echo unstaged >> a.txt && git update-index --assume-unchanged a.txt",
    );
    expect(native).toBe(2);
    expect(readFileSync(join(nd, "a.txt"), "utf8")).toBe(T("a"));
    await expectSame(nd, od);
  });

  it("with core.ignorecase a cherry-pick and a rebase leave no stray tree", async () => {
    const history: History = {
      base,
      config: { "core.ignorecase": "true" },
      main: { "b.txt": T("b1") },
      side: { "d/x.txt": T("dx2"), "n/m.txt": T("m") },
    };
    // the trees no ref reaches (fsck --unreachable --no-reflogs, without fsck)
    const unreachable = (dir: string) => {
      const reachable = new Set(
        gitOk(root, dir, "rev-list", "--objects", "--all")
          .split("\n")
          .map((l) => l.slice(0, 40)),
      );
      return gitOk(root, dir, "cat-file", "--batch-all-objects", "--batch-check")
        .split("\n")
        .filter((l) => / tree \d+$/.test(l))
        .map((l) => l.slice(0, 40))
        .filter((id) => !reachable.has(id))
        .sort();
    };
    const { nd, od } = await run(history, "cherry-pick");
    expect(unreachable(od)).toEqual(unreachable(nd));

    const rn = join(root, `r${n++}`);
    const ro = join(root, `r${n++}`);
    for (const dir of [rn, ro]) {
      buildHistory(root, dir, history);
      gitOk(root, dir, "checkout", "-q", "side");
    }
    gitOk(root, rn, "rebase", "main");
    const r = await (await openOurs(ro))
      .rebase()
      .setCommitter(INTEROP_IDENT)
      .setUpstreamBranch("main")
      .then((c) => c.call());
    expect(r.status).toBe("ok");
    expect(unreachable(ro)).toEqual(unreachable(rn));
  });

  // core.ignorecase on a filesystem that keeps case (Linux): a file and a directory whose
  // names differ only in case are two paths, which native git checks out side by side; the
  // case-variant guard of tree-restore applies only where the worktree folds case
  it("with core.ignorecase on a case-keeping filesystem a file beside a directory in another case", async () => {
    const history: History = {
      base,
      config: { "core.ignorecase": "true" },
      main: { "b.txt": T("b1") },
      side: { D: T("file D"), "E/k.txt": T("Ek") },
    };
    for (const op of ["merge", "cherry-pick"] as const) {
      const { nd, od, native } = await run(history, op);
      expect(native).toBe(0);
      await expectSame(nd, od);
    }
    // a checkout and a reset --hard of the tree that holds both
    for (const command of ["checkout", "reset"] as const) {
      const cn = join(root, `c${n++}`);
      const co = join(root, `c${n++}`);
      for (const dir of [cn, co]) buildHistory(root, dir, history);
      if (command === "checkout") {
        gitOk(root, cn, "checkout", "-q", "side");
        await (await openOurs(co)).checkout().setName("side").call();
      } else {
        gitOk(root, cn, "reset", "-q", "--hard", "side");
        await (await openOurs(co)).reset().setRef("side").setMode(ResetMode.HARD).call();
      }
      expect(snapshot(root, co, normalizeState)).toEqual(snapshot(root, cn, normalizeState));
    }
  });
});
