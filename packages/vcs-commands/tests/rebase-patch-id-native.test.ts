/**
 * `rebase` leaves out the commits whose change upstream already has, as native git does
 * (patch-ids over the diff, `--cherry-mark`): "skipped previously applied commit" warnings,
 * `--reapply-cherry-picks`, a rebase where every commit is upstream. Twins built apart
 * (`buildHistory`), native `git rebase main` on one and ours on the other, then compared
 * with snapshot / normalizeState and the warnings. Our patch-id is checked against
 * `git patch-id --stable` too.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend } from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { patchId } from "../src/commands/patch-id.js";
import { git, INTEROP_IDENT, normalizeState, openOurs, snapshot } from "./merge-native-helpers.js";
import {
  buildGraph,
  buildHistory,
  type Graph,
  type History,
  text,
} from "./merge-native-scenarios.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

/** Rebases side onto main in both twins; the differences (none: the same). */
async function compareRebase(history: History, reapply = false): Promise<string[]> {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  for (const dir of [native, ours]) {
    buildHistory(root, dir, history);
    git(root, dir, "checkout", "-q", "side");
  }
  const expected = git(
    root,
    native,
    "rebase",
    ...(reapply ? ["--reapply-cherry-picks"] : []),
    "main",
  );
  const command = (await openOurs(ours)).rebase().setCommitter(INTEROP_IDENT);
  await command.setUpstreamBranch("main");
  if (reapply) command.setReapplyCherryPicks(true);
  const result = await command.call();
  const diffs: string[] = [];
  const a = snapshot(root, ours, normalizeState);
  const b = snapshot(root, native, normalizeState);
  for (const key of ["head", "status", "index", "files", "state"] as const) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      diffs.push(`${key}: ours ${JSON.stringify(a[key])}\nnative ${JSON.stringify(b[key])}`);
    }
  }
  const warnings = (s: string[]) => s.filter((l) => l.startsWith("warning: skipped"));
  const nativeWarnings = warnings(expected.stderr.split("\n"));
  if (JSON.stringify(warnings(result.output ?? [])) !== JSON.stringify(nativeWarnings)) {
    diffs.push(`warnings: ${JSON.stringify(result.output)} vs ${JSON.stringify(expected.stderr)}`);
  }
  rmSync(native, { recursive: true, force: true });
  rmSync(ours, { recursive: true, force: true });
  return diffs;
}

describeGit("rebase drops commits already upstream, as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rebase-patchid-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const change = { f: text({ 2: "S" }), g: "new\n" };

  it("a commit whose change upstream has is skipped with git's warning", async () => {
    const history: History = {
      base: { f: text(), keep: "k\n" },
      side: change,
      sideMore: [{ keep: "side\n" }, { h: "h\n" }],
      main: change,
    };
    expect(await compareRebase(history)).toEqual([]);
  });

  it("every commit upstream: the branch moves to upstream", async () => {
    expect(
      await compareRebase({ base: { f: text(), keep: "k\n" }, side: change, main: change }),
    ).toEqual([]);
  });

  it("--reapply-cherry-picks picks it (and it drops out as empty)", async () => {
    const history: History = {
      base: { f: text(), keep: "k\n" },
      side: change,
      sideMore: [{ keep: "side\n" }],
      main: change,
    };
    expect(await compareRebase(history, true)).toEqual([]);
  });

  it("whitespace does not count in the patch-id", async () => {
    const history: History = {
      base: { f: text() },
      side: { f: text({ 4: "a  b\tc" }) },
      sideMore: [{ g: "g\n" }],
      main: { f: text({ 4: "a b c" }) },
    };
    expect(await compareRebase(history)).toEqual([]);
  });

  it("binary files, modes, deletions and additions in the patch", async () => {
    const history: History = {
      base: { b: new Uint8Array([0, 1]), x: { exec: "x\n" }, d: "d\n", f: text() },
      side: { b: new Uint8Array([0, 2]), x: "x\n", d: null, n: "n\n" },
      sideMore: [{ f: text({ 9: "side" }) }],
      main: { b: new Uint8Array([0, 2]), x: "x\n", d: null, n: "n\n" },
    };
    expect(await compareRebase(history)).toEqual([]);
  });

  it("a different change of the same files is picked", async () => {
    const history: History = {
      base: { f: text() },
      side: { f: text({ 2: "S" }) },
      sideMore: [{ f: text({ 2: "S", 8: "T" }) }],
      main: { f: text({ 2: "S", 3: "extra" }) },
    };
    expect(await compareRebase(history)).toEqual([]);
  });

  it("our patch-id of text changes is the one of native patch-id --stable", async () => {
    const dir = join(root, "pid");
    buildHistory(root, dir, {
      base: { f: text(), b: new Uint8Array([0, 1]), x: "x\n", "sp ace": "s\n", k: "k\n" },
      side: {
        f: text({ 2: "a b", 9: "z" }),
        n: "n\n",
        "sp ace": null,
      },
    });
    const run = (args: string[], input?: Buffer) =>
      execFileSync("git", args, { cwd: dir, env: nativeGitEnv(root), input });
    const show = run(["show", "--no-indent-heuristic", "side"]);
    const native = run(["patch-id", "--stable"], show).toString().split(" ")[0];
    const { history } = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: dir }),
    });
    const trees = Object.assign(Object.create(history.trees), {
      loadTree: async function* (id: string) {
        yield* (await history.trees.load(id)) ?? [];
      },
    });
    const parentTree = run(["rev-parse", "side~1^{tree}"]).toString().trim();
    const tree = run(["rev-parse", "side^{tree}"]).toString().trim();
    expect(await patchId(trees, history.blobs, parentTree, tree)).toBe(native);
  });

  it("upstream's side ends at the merge base; headers alike, contents not, still picked", async () => {
    // side: R reverts the change A made before the fork, C makes it again (A is no
    // upstream commit: C is picked), D is made upstream too (skipped), E has the header
    // of an upstream commit with another content (picked); upstream merges a branch too
    const graph: Graph = {
      base: { f: text(), g: text(), k: "k\n" },
      steps: [
        { branch: "main", files: { f: text({ 2: "S" }) }, message: "A" },
        { branch: "side", from: "main", files: { f: text() }, message: "R" },
        { branch: "side", files: { f: text({ 2: "S" }) }, message: "C" },
        { branch: "side", files: { h: "h\n" }, message: "D" },
        { branch: "side", files: { k: "side\n" }, message: "E" },
        { branch: "other", from: "main", files: { o: "o\n" }, message: "other" },
        ...Array.from({ length: 12 }, (_, i) => ({
          branch: "main",
          files: { g: text({ 1: `main ${i}` }) },
          message: `main ${i}`,
        })),
        { branch: "main", files: { h: "h\n" }, message: "D upstream" },
        { branch: "main", files: { k: "main\n" }, message: "E's header upstream" },
        { branch: "main", merge: "other", files: { o: "o\n" }, message: "merge other" },
      ],
      checkout: "side",
    };
    const n = counter++;
    const native = join(root, `native-${n}`);
    const ours = join(root, `ours-${n}`);
    for (const dir of [native, ours]) buildGraph(root, dir, graph);
    const expected = git(root, native, "rebase", "main");
    const command = (await openOurs(ours)).rebase().setCommitter(INTEROP_IDENT);
    await command.setUpstreamBranch("main");
    const result = await command.call();
    expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
    const warnings = (s: string[]) => s.filter((l) => l.startsWith("warning: skipped"));
    expect(warnings(result.output ?? [])).toEqual(warnings(expected.stderr.split("\n")));
    expect(warnings(result.output ?? [])).toHaveLength(1);
    rmSync(native, { recursive: true, force: true });
    rmSync(ours, { recursive: true, force: true });
  });

  it("a pick that becomes empty is dropped (with its AUTO_MERGE), one empty from the start kept", async () => {
    const change = { f: text({ 2: "S" }) };
    const cases: { history: History; detach?: boolean }[] = [
      // upstream has the change and more: the pick becomes empty (no patch-id match)
      { history: { base: { f: text() }, side: change, main: { ...change, n: "n\n" } } },
      {
        history: { base: { f: text() }, side: change, main: { ...change, n: "n\n" } },
        detach: true,
      },
      // a commit that changes nothing is picked as it is
      { history: { base: { f: text() }, side: {}, sideMore: [{ g: "g\n" }], main: { n: "n\n" } } },
    ];
    for (const { history, detach } of cases) {
      const n = counter++;
      const native = join(root, `native-${n}`);
      const ours = join(root, `ours-${n}`);
      for (const dir of [native, ours]) {
        buildHistory(root, dir, history);
        git(root, dir, "checkout", "-q", ...(detach ? ["--detach"] : []), "side");
      }
      const expected = git(root, native, "rebase", "main");
      const command = (await openOurs(ours)).rebase().setCommitter(INTEROP_IDENT);
      await command.setUpstreamBranch("main");
      const result = await command.call();
      expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
      const dropping = (lines: string[]) => lines.filter((l) => l.includes("-- patch contents"));
      expect(dropping(result.output ?? [])).toEqual(
        dropping(
          expected.stderr.split(/[\r\n]/).map((l) => l.replace(/^Rebasing \(\d+\/\d+\)/, "")),
        ),
      );
      rmSync(native, { recursive: true, force: true });
      rmSync(ours, { recursive: true, force: true });
    }
  });
});
