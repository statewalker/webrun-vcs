/**
 * Octopus merges (`git merge a b c`) against native git: histories built twice
 * (`buildGraph`), native git merging in one twin and ours in the other, then the octopus
 * script's messages, status, index, every worktree file and the state files compared
 * (MERGE_HEAD with a line per head, MERGE_MODE `no-ff`). The conflict markers of a file
 * git-merge-one-file leaves are labelled with git's random temporary file names
 * (`.merge_file_XXXXXX`), evened out before comparing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ContentMergeStrategy,
  FastForwardMode,
  type MergeCommand,
  MergeOperation,
  MergeStatus,
  MergeStrategy,
} from "../src/index.js";
import {
  git,
  gitOk,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  put,
  type Snapshot,
  snapshot,
} from "./merge-native-helpers.js";
import {
  buildGraph,
  type FileSpec,
  type Files,
  type Graph,
  text,
} from "./merge-native-scenarios.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

const OCTOPUS_LINE =
  /^(Trying simple merge|Simple merge did not work|Auto-merging|Added .* in both|Adding |Removing |Fast-forwarding to|Already up to date|Automated merge did not work|Should not be doing|Automatic merge failed|Merge made by|Error: Your local changes| {4})/;

/** git's temporary file names in markers, evened out. */
function evenOut(s: Snapshot): Snapshot {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.files))
    files[k] = v.replace(/\.merge_file_\w{6}/g, ".merge_file_X");
  return { ...s, files };
}

interface Options {
  noCommit?: boolean;
  prepare?: (dir: string) => void;
  branch?: string;
  /** Native git's further options (`--squash`, `-s ours`, ...) */
  args?: string[];
  /** The same options set on our command */
  configure?: (command: MergeCommand) => void;
  /** Ours throws an error with this text, native git dies with it */
  throws?: string;
}

async function compareOctopus(graph: Graph, heads: string[], options: Options = {}) {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  for (const dir of [native, ours]) {
    buildGraph(root, dir, graph);
    if (options.branch) gitOk(root, dir, "checkout", "-q", options.branch);
    options.prepare?.(dir);
  }
  const expected = git(
    root,
    native,
    "merge",
    ...(options.noCommit ? ["--no-commit"] : []),
    ...(options.args ?? []),
    ...heads,
  );
  const command = (await openOurs(ours))
    .merge()
    .setAuthor(INTEROP_IDENT)
    .setCommitter(INTEROP_IDENT);
  for (const h of heads) command.include(h);
  if (options.noCommit) command.setCommit(false);
  options.configure?.(command);
  if (options.throws) {
    await expect(command.call()).rejects.toThrow(options.throws);
    expect(expected.stderr).toContain(options.throws);
    expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
    rmSync(native, { recursive: true, force: true });
    rmSync(ours, { recursive: true, force: true });
    return { result: undefined as never, expected };
  }
  const result = await command.call();
  expect(evenOut(snapshot(root, ours, normalizeState))).toEqual(
    evenOut(snapshot(root, native, normalizeState)),
  );
  const lines = (text: string) => text.split("\n").filter((l) => OCTOPUS_LINE.test(l));
  expect((result.output ?? []).filter((l) => OCTOPUS_LINE.test(l))).toEqual(lines(expected.stdout));
  if (result.status === MergeStatus.CONFLICTING) {
    // git-merge-one-file's stderr, its temporary names evened out
    const even = (t: string) => t.replace(/\.merge_file_\w{6}/g, ".merge_file_X").trim();
    expect(even(result.message ?? "")).toBe(even(expected.stderr));
  }
  if (result.status === MergeStatus.FAILED) {
    const errors = expected.stderr.trim().split("\n");
    // the last line before the autostash is applied back
    expect(result.message?.split("\n").pop()).toBe(
      errors.filter((l) => !/autostash|git stash/i.test(l)).pop(),
    );
  }
  rmSync(native, { recursive: true, force: true });
  rmSync(ours, { recursive: true, force: true });
  return { result, expected };
}

/** main, and branches a, b, c off it with their changes; main's own change on top. */
function branches(changes: Record<string, Files>, main?: Files): Graph {
  return {
    base: { f: text(), g: text(), h: text() },
    steps: [
      ...Object.entries(changes).map(([branch, files]) => ({ branch, from: "main", files })),
      ...(main ? [{ branch: "main", files: main }] : []),
    ],
  };
}

describeGit("octopus merges against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-octopus-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("three branches with separate changes: one commit with four parents", async () => {
    const graph = branches(
      { a: { f: text({ 1: "a" }) }, b: { g: text({ 2: "b" }), n: "new\n" }, c: { h: null } },
      { f: text({ 9: "main" }) },
    );
    const { result } = await compareOctopus(graph, ["a", "b", "c"]);
    expect(result.status).toBe(MergeStatus.MERGED);
  });

  it("--no-commit stops with MERGE_HEAD listing every head", async () => {
    const graph = branches(
      { a: { f: text({ 1: "a" }) }, b: { g: text({ 2: "b" }) } },
      { h: text({ 5: "m" }) },
    );
    await compareOctopus(graph, ["a", "b"], { noCommit: true });
  });

  it("edits of one file merged file by file (git-merge-one-file)", async () => {
    const graph = branches(
      { a: { f: text({ 1: "a" }) }, b: { f: text({ 9: "b" }) } },
      { f: text({ 5: "main" }) },
    );
    await compareOctopus(graph, ["a", "b"]);
  });

  it("a conflict with the last head is left to resolve", async () => {
    const graph = branches(
      { a: { g: text({ 1: "a" }) }, b: { f: text({ 3: "b" }), n: "b\n" } },
      { f: text({ 3: "main" }), n: "main\n" },
    );
    const { result } = await compareOctopus(graph, ["a", "b"]);
    expect(result.status).toBe(MergeStatus.CONFLICTING);
  });

  it("a conflict with an earlier head: the octopus gives up", async () => {
    const graph = branches(
      { a: { f: text({ 3: "a" }) }, b: { g: text({ 2: "b" }) } },
      { f: text({ 3: "main" }) },
    );
    const { result } = await compareOctopus(graph, ["a", "b"]);
    expect(result.status).toBe(MergeStatus.FAILED);
  });

  it("the first head a fast-forward, the others merged on top", async () => {
    const graph = branches({ a: { f: text({ 1: "a" }) }, b: { g: text({ 2: "b" }) } });
    await compareOctopus(graph, ["a", "b"]);
  });

  it("a head already merged by another drops out", async () => {
    const graph: Graph = {
      base: { f: text(), g: text() },
      steps: [
        { branch: "a", files: { f: text({ 1: "a" }) } },
        { branch: "b", from: "a", files: { g: text({ 2: "b" }) } },
        { branch: "c", from: "main", files: { f: text({ 9: "c" }) } },
        { branch: "main", files: { g: text({ 9: "m" }) } },
      ],
    };
    await compareOctopus(graph, ["a", "b", "c"]);
  });

  it("additions: the same file alike, and differently", async () => {
    const graph = branches(
      { a: { same: "s\n", x: "a\n" }, b: { same: "s\n" }, c: { x: "c\n" } },
      { h: text({ 4: "m" }) },
    );
    await compareOctopus(graph, ["a", "b", "c"]);
  });

  it("staged changes: refused before anything is written", async () => {
    const graph = branches(
      { a: { f: text({ 1: "a" }) }, b: { g: text({ 2: "b" }) } },
      { h: "m\n" },
    );
    await compareOctopus(graph, ["a", "b"], {
      prepare: (dir) => {
        put(dir, "h", "staged\n");
        gitOk(root, dir, "add", "h");
      },
    });
  });

  it("on another branch: the message says into which", async () => {
    const graph: Graph = {
      ...branches({ a: { f: text({ 1: "a" }) }, b: { g: text({ 2: "b" }) } }),
      steps: [
        { branch: "a", from: "main", files: { f: text({ 1: "a" }) } },
        { branch: "b", from: "main", files: { g: text({ 2: "b" }) } },
        { branch: "topic", from: "main", files: { h: text({ 3: "t" }) } },
      ],
    };
    await compareOctopus(graph, ["a", "b"], { branch: "topic" });
  });

  it("a resolved octopus is committed with every head as a parent", async () => {
    const graph = branches(
      { a: { g: text({ 1: "a" }) }, b: { f: text({ 3: "b" }) } },
      { f: text({ 3: "main" }) },
    );
    const n = counter++;
    const native = join(root, `native-${n}`);
    const ours = join(root, `ours-${n}`);
    for (const dir of [native, ours]) {
      buildGraph(root, dir, graph);
      git(root, dir, "merge", "a", "b");
      put(dir, "f", "resolved\n");
      gitOk(root, dir, "add", "f");
    }
    git(root, native, "merge", "--continue");
    const result = await (await openOurs(ours))
      .merge()
      .setOperation(MergeOperation.CONTINUE)
      .setAuthor(INTEROP_IDENT)
      .setCommitter(INTEROP_IDENT)
      .call();
    expect(result.status).toBe(MergeStatus.MERGED);
    expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
  });

  it("--ff-only is refused", async () => {
    const graph = branches(
      { a: { f: text({ 1: "a" }) }, b: { g: text({ 2: "b" }) } },
      { h: "m\n" },
    );
    const dir = join(root, "ffonly");
    buildGraph(root, dir, graph);
    const command = (await openOurs(dir))
      .merge()
      .include("a")
      .include("b")
      .setFastForwardMode(FastForwardMode.FF_ONLY);
    await expect(command.call()).rejects.toThrow("Not possible to fast-forward");
    expect(git(root, dir, "merge", "--ff-only", "a", "b").stderr).toContain(
      "Not possible to fast-forward",
    );
  });

  // what git's merge sets up for any head count: squash, strategies, autostash, unrelated
  // histories, --no-ff, a message given

  const two = () =>
    branches({ a: { f: text({ 1: "a" }) }, b: { g: text({ 2: "b" }) } }, { h: "m\n" });
  const lastConflicts = () =>
    branches(
      { a: { g: text({ 1: "a" }) }, b: { f: text({ 3: "b" }) } },
      { f: text({ 3: "main" }) },
    );

  it("--squash stages the octopus with SQUASH_MSG, HEAD left alone", async () => {
    const { result } = await compareOctopus(two(), ["a", "b"], {
      args: ["--squash"],
      configure: (c) => c.setSquash(true),
    });
    expect(result.status).toBe(MergeStatus.MERGED_SQUASHED);
  });

  it("--squash with a conflict on the last head: SQUASH_MSG and the conflict list", async () => {
    const { result } = await compareOctopus(lastConflicts(), ["a", "b"], {
      args: ["--squash"],
      configure: (c) => c.setSquash(true),
    });
    expect(result.status).toBe(MergeStatus.CONFLICTING);
  });

  it("--squash of heads HEAD already has: nothing to squash", async () => {
    const graph: Graph = {
      base: { f: text() },
      steps: [
        { branch: "a", files: { f: text({ 1: "a" }) } },
        { branch: "b", from: "main", files: { g: "g\n" } },
        { branch: "main", merge: "a" },
        { branch: "main", merge: "b" },
      ],
    };
    const { result, expected } = await compareOctopus(graph, ["a", "b"], {
      args: ["--squash"],
      configure: (c) => c.setSquash(true),
    });
    expect(result.output).toEqual([expected.stdout.trim()]);
  });

  it("--squash with --no-ff is refused", async () => {
    await compareOctopus(two(), ["a", "b"], {
      args: ["--squash", "--no-ff"],
      configure: (c) => c.setSquash(true).setFastForwardMode(FastForwardMode.NO_FF),
      throws: "options '--squash' and '--no-ff.' cannot be used together",
    });
  });

  it("-s ours: HEAD's tree with every head as a parent", async () => {
    const { result } = await compareOctopus(two(), ["a", "b"], {
      args: ["-s", "ours"],
      configure: (c) => c.setStrategy(MergeStrategy.OURS),
    });
    expect(result.status).toBe(MergeStatus.MERGED);
    expect(result.output).toContain("Merge made by the 'ours' strategy.");
  });

  it("-s ours with heads that contain HEAD still keeps HEAD (no fast-forward)", async () => {
    const graph = branches({ a: { f: text({ 1: "a" }) }, b: { g: text({ 2: "b" }) } });
    await compareOctopus(graph, ["a", "b"], {
      args: ["-s", "ours"],
      configure: (c) => c.setStrategy(MergeStrategy.OURS),
    });
  });

  it("-s ours --no-commit and -s ours --squash", async () => {
    await compareOctopus(two(), ["a", "b"], {
      noCommit: true,
      args: ["-s", "ours"],
      configure: (c) => c.setStrategy(MergeStrategy.OURS),
    });
    await compareOctopus(two(), ["a", "b"], {
      args: ["-s", "ours", "--squash"],
      configure: (c) => c.setStrategy(MergeStrategy.OURS).setSquash(true),
    });
  });

  it("-s ours with staged changes: the strategy fails, nothing written", async () => {
    const { result } = await compareOctopus(two(), ["a", "b"], {
      args: ["-s", "ours"],
      configure: (c) => c.setStrategy(MergeStrategy.OURS),
      prepare: (dir) => {
        put(dir, "h", "staged\n");
        gitOk(root, dir, "add", "h");
      },
    });
    expect(result.status).toBe(MergeStatus.FAILED);
  });

  it("-s resolve handles two heads only; theirs is no git strategy", async () => {
    const { result } = await compareOctopus(two(), ["a", "b"], {
      args: ["-s", "resolve"],
      configure: (c) => c.setStrategy(MergeStrategy.RESOLVE),
      prepare: (dir) => put(dir, "h", "dirty\n"),
    });
    expect(result.status).toBe(MergeStatus.FAILED);
    const theirs = await compareOctopus(two(), ["a", "b"], {
      args: ["-s", "theirs"],
      configure: (c) => c.setStrategy(MergeStrategy.THEIRS),
    });
    expect(theirs.result.status).toBe(MergeStatus.FAILED);
    expect(theirs.expected.stderr).toContain("Could not find merge strategy 'theirs'.");
  });

  it("--no-ff keeps HEAD a parent when the heads contain it", async () => {
    const graph = branches({ a: { f: text({ 1: "a" }) }, b: { g: text({ 2: "b" }) } });
    await compareOctopus(graph, ["a", "b"], {
      args: ["--no-ff"],
      configure: (c) => c.setFastForwardMode(FastForwardMode.NO_FF),
    });
    // without --no-ff HEAD drops out of the parents
    await compareOctopus(graph, ["a", "b"]);
  });

  it("a message given, committed and with conflicts", async () => {
    await compareOctopus(two(), ["a", "b"], {
      args: ["-m", "octopus by hand"],
      // a message given is git's -m: cleaned up for the commit, a newline added in MERGE_MSG
      configure: (c) => c.setMessage("octopus by hand"),
    });
    await compareOctopus(lastConflicts(), ["a", "b"], {
      args: ["-m", "octopus by hand"],
      // a message given is git's -m: cleaned up for the commit, a newline added in MERGE_MSG
      configure: (c) => c.setMessage("octopus by hand"),
    });
  });

  it("--autostash: a dirty file the octopus changes is stashed and applied back", async () => {
    for (const path of ["f", "h"]) {
      const { result } = await compareOctopus(two(), ["a", "b"], {
        args: ["--autostash"],
        configure: (c) => c.setAutoStash(true),
        prepare: (dir) => put(dir, path, text({ 9: "dirty" })),
      });
      expect(result.status).toBe(MergeStatus.MERGED);
      expect(result.output).toContain("Applied autostash.");
    }
  });

  it("merge.autoStash, and an autostash kept while the octopus stops", async () => {
    await compareOctopus({ ...two(), config: { "merge.autoStash": "true" } }, ["a", "b"], {
      prepare: (dir) => put(dir, "f", text({ 9: "dirty" })),
    });
    const { result } = await compareOctopus(lastConflicts(), ["a", "b"], {
      args: ["--autostash"],
      configure: (c) => c.setAutoStash(true),
      prepare: (dir) => put(dir, "h", "dirty\n"),
    });
    expect(result.status).toBe(MergeStatus.CONFLICTING);
    expect(result.output).toContain("When finished, apply stashed changes with `git stash pop`");
    // a given-up octopus applies the autostash back
    await compareOctopus(
      branches({ a: { f: text({ 3: "a" }) }, b: { g: text({ 2: "b" }) } }, { f: text({ 3: "m" }) }),
      ["a", "b"],
      {
        args: ["--autostash"],
        configure: (c) => c.setAutoStash(true),
        prepare: (dir) => put(dir, "h", "dirty\n"),
      },
    );
  });

  const unrelated = (dir: string) => {
    gitOk(root, dir, "checkout", "-q", "--orphan", "orph");
    gitOk(root, dir, "rm", "-rqf", ".");
    put(dir, "o", "o\n");
    gitOk(root, dir, "add", "o");
    gitOk(root, dir, "commit", "-qm", "orphan");
    gitOk(root, dir, "checkout", "-q", "main");
  };

  it("unrelated histories are refused, and with --allow-unrelated-histories the octopus stops", async () => {
    await compareOctopus(two(), ["a", "orph"], {
      prepare: unrelated,
      throws: "refusing to merge unrelated histories",
    });
    for (const heads of [
      ["a", "orph"],
      ["orph", "a"],
    ]) {
      const { result } = await compareOctopus(two(), heads, {
        prepare: unrelated,
        args: ["--allow-unrelated-histories"],
        configure: (c) => c.setAllowUnrelatedHistories(true),
      });
      expect(result.status).toBe(MergeStatus.CONFLICTING);
    }
  });

  it("a two-head merge of unrelated histories: refused, or merged against the empty tree", async () => {
    await compareOctopus(two(), ["orph"], {
      prepare: unrelated,
      throws: "refusing to merge unrelated histories",
    });
    const { result } = await compareOctopus(two(), ["orph"], {
      prepare: unrelated,
      args: ["--allow-unrelated-histories"],
      configure: (c) => c.setAllowUnrelatedHistories(true),
    });
    expect(result.status).toBe(MergeStatus.MERGED);
  });

  // local changes and untracked files around an octopus

  it("a dirty file the octopus does not touch is kept", async () => {
    const { result } = await compareOctopus(two(), ["a", "b"], {
      prepare: (dir) => put(dir, "h", "MY DIRTY WORK\n"),
    });
    expect(result.status).toBe(MergeStatus.MERGED);
  });

  it("a dirty file the octopus changes refuses it, nothing written", async () => {
    for (const path of ["f", "g"]) {
      const { result } = await compareOctopus(two(), ["a", "b"], {
        prepare: (dir) => put(dir, path, "MY DIRTY WORK\n"),
      });
      expect(result.status).toBe(MergeStatus.FAILED);
    }
  });

  it("an untracked file where a head adds one refuses it", async () => {
    for (const graph of [
      branches({ a: { f: text({ 1: "a" }) }, b: { n: "from b\n" } }, { h: "m\n" }),
      branches({ a: { n: "from a\n" }, b: { g: text({ 2: "b" }) } }, { h: "m\n" }),
    ]) {
      const { result } = await compareOctopus(graph, ["a", "b"], {
        prepare: (dir) => put(dir, "n", "MY UNTRACKED\n"),
      });
      expect(result.status).toBe(MergeStatus.FAILED);
    }
  });

  it("conflicts and a give-up with a dirty file and an untracked one kept", async () => {
    const dirty = (dir: string) => {
      put(dir, "h", "MY DIRTY WORK\n");
      put(dir, "u", "MY UNTRACKED\n");
    };
    const conflicted = await compareOctopus(lastConflicts(), ["a", "b"], { prepare: dirty });
    expect(conflicted.result.status).toBe(MergeStatus.CONFLICTING);
    const gaveUp = await compareOctopus(
      branches({ a: { f: text({ 3: "a" }) }, b: { g: text({ 2: "b" }) } }, { f: text({ 3: "m" }) }),
      ["a", "b"],
      { prepare: dirty },
    );
    expect(gaveUp.result.status).toBe(MergeStatus.FAILED);
  });

  it("-s ours of one head never fast-forwards, not even with --ff-only", async () => {
    const graph = branches({ a: { f: text({ 1: "a" }) } });
    await compareOctopus(graph, ["a"], {
      args: ["-s", "ours"],
      configure: (c) => c.setStrategy(MergeStrategy.OURS),
    });
    await compareOctopus(graph, ["a"], {
      args: ["-s", "ours", "--ff-only"],
      configure: (c) =>
        c.setStrategy(MergeStrategy.OURS).setFastForwardMode(FastForwardMode.FF_ONLY),
    });
  });

  it("conflict styles: diff3 and zdiff3 label all three sides with temporary names", async () => {
    const lastHead = (style: string, edit: Record<number, string>) => ({
      ...branches(
        { a: { g: text({ 1: "a" }) }, b: { f: text({ 3: "b", ...edit }) } },
        { f: text({ 3: "main", ...edit }) },
      ),
      config: { "merge.conflictStyle": style },
    });
    await compareOctopus(lastHead("diff3", {}), ["a", "b"]);
    await compareOctopus(lastHead("zdiff3", { 4: "x" }), ["a", "b"]);
    // the same file merged with every head, the last one conflicting
    const sameFile = {
      ...branches(
        { a: { f: text({ 1: "a" }) }, b: { f: text({ 9: "b" }) }, c: { f: text({ 5: "c" }) } },
        { f: text({ 5: "main" }) },
      ),
      config: { "merge.conflictStyle": "diff3" },
    };
    const { result } = await compareOctopus(sameFile, ["a", "b", "c"]);
    expect(result.status).toBe(MergeStatus.CONFLICTING);
    // added in both: the base is the empty blob's temporary file
    const added = {
      ...branches({ a: { g: text({ 1: "a" }) }, b: { x: "b\n" } }, { x: "m\n", e: "" }),
      config: { "merge.conflictStyle": "diff3" },
    };
    await compareOctopus(added, ["a", "b"]);
  });

  it("binary files: git merge-file refuses them, ours stays in the worktree", async () => {
    const bytes = (...b: number[]) => new Uint8Array([0, 1, 2, 3, ...b]);
    const graph = branches(
      { a: { g: text({ 1: "a" }) }, b: { bin: bytes(98) } },
      { bin: bytes(109) },
    );
    graph.base.bin = bytes();
    const { result, expected } = await compareOctopus(graph, ["a", "b"]);
    expect(result.status).toBe(MergeStatus.CONFLICTING);
    expect(expected.stderr).toMatch(/^error: Cannot merge binary files: \.merge_file_\w{6}$/m);
    // only the base binary, and a binary with a mode change
    const baseOnly = branches({ a: { g: text({ 1: "a" }) }, b: { bin: "b\n" } }, { bin: "m\n" });
    baseOnly.base.bin = bytes();
    await compareOctopus(baseOnly, ["a", "b"]);
    const mode = branches(
      { a: { g: text({ 1: "a" }) }, b: { bin: { exec: "b\u0000\n" } } },
      { bin: "m\u0000\n" },
    );
    mode.base.bin = bytes();
    await compareOctopus(mode, ["a", "b"]);
  });

  it("git-merge-one-file reads no attributes and no -X: marker size, union, theirs", async () => {
    const graph = branches(
      { a: { g: text({ 1: "a" }) }, b: { f: text({ 3: "b" }), "d/u": text({ 3: "b" }) } },
      { f: text({ 3: "main" }), "d/u": text({ 3: "main" }) },
    );
    graph.base[".gitattributes"] = "f conflict-marker-size=10\nd/u merge=union\n";
    graph.base["d/u"] = text();
    await compareOctopus(graph, ["a", "b"]);
    await compareOctopus(graph, ["a", "b"], {
      args: ["-X", "theirs"],
      configure: (c) => c.setContentMergeStrategy(ContentMergeStrategy.THEIRS),
    });
  });

  it("the last head deletes, links or changes the mode of a file main changed", async () => {
    const last = (theirs: FileSpec, ours: FileSpec) =>
      branches({ a: { g: text({ 1: "a" }) }, b: { f: theirs } }, { f: ours });
    await compareOctopus(last(null, text({ 3: "main" })), ["a", "b"]);
    await compareOctopus(last({ link: "b" }, { link: "m" }), ["a", "b"]);
    await compareOctopus(last({ exec: text({ 3: "b" }) }, text({ 9: "main" })), ["a", "b"]);
    await compareOctopus(last({ exec: text({ 3: "b" }) }, text({ 3: "main" })), ["a", "b"]);
  });
});
