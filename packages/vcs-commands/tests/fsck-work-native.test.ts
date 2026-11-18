/**
 * The work of `git fsck --connectivity-only`, counted rather than timed, with the output
 * checked against native git: every commit and tree reached is read once (a tree the walk
 * parses is walked from those bytes, as git's parse_tree reads it once), and with a
 * commit-graph the commits reached through parents come from the graph (git's
 * parse_commit_in_graph) while the commits refs name are still read (parse_object).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

/** A fast-import stream: `n` commits on main, a side branch merged in, nested directories. */
function history(n: number): string {
  const out: string[] = [];
  let mark = 0;
  let time = 1400000000;
  const data = (s: string) => out.push(`data ${Buffer.byteLength(s)}\n${s}\n`);
  const commit = (
    ref: string,
    from: number | undefined,
    merge: number | undefined,
    path: string,
  ) => {
    time += 60;
    out.push(`commit ${ref}\nmark :${++mark}\n`);
    out.push(`author A <a@example.com> ${time} +0000\ncommitter C <c@example.com> ${time} +0000\n`);
    data(`commit ${mark}\n`);
    if (from) out.push(`from :${from}\n`);
    if (merge) out.push(`merge :${merge}\n`);
    out.push(`M 100644 inline ${path}\n`);
    data(`content ${mark}\n`);
    out.push("\n");
    return mark;
  };
  let main = commit("refs/heads/main", undefined, undefined, "README");
  let side = 0;
  for (let i = 1; i < n; i++) {
    const path = `d${i % 3}/s${i % 4}/f${i % 5}.txt`;
    if (i === n / 2) side = commit("refs/heads/side", main, undefined, "side/only.txt");
    main = commit("refs/heads/main", main, i === n - 2 && side ? side : undefined, path);
  }
  return out.join("");
}

describeGit("fsck --connectivity-only, counted", () => {
  let root: string;
  let dir: string;
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, {
      cwd: dir,
      env: nativeGitEnv(root),
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fsck-work-native-"));
    dir = join(root, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", dir], { env: nativeGitEnv(root) });
    git(["fast-import", "--quiet"], history(40));
    git(["repack", "-adq"]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** Reachable objects by type (`rev-list --objects --all`, typed by `cat-file`). */
  function reachable(): Record<string, number> {
    const ids = git(["rev-list", "--objects", "--all"])
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(0, 40));
    const types = git(["cat-file", "--batch-check=%(objecttype)"], `${ids.join("\n")}\n`)
      .split("\n")
      .filter(Boolean);
    const count: Record<string, number> = {};
    for (const t of types) count[t] = (count[t] ?? 0) + 1;
    return count;
  }

  async function compare() {
    let native: { stdout: string; stderr: string; status: number };
    try {
      native = {
        stdout: git(["fsck", "--connectivity-only", "--no-progress"]),
        stderr: "",
        status: 0,
      };
    } catch (e) {
      const err = e as { stdout: string; stderr: string; status: number };
      native = { stdout: err.stdout, stderr: err.stderr, status: err.status };
    }
    const ours = await (await openOurs(dir))
      .fsck()
      .setRepositoryFiles({ files: createNodeFilesApi({ rootDir: dir }) })
      .setConnectivityOnly(true)
      .call();
    expect(ours.output).toBe(native.stdout);
    expect(ours.exitCode).toBe(native.status);
    return ours;
  }

  it("reads each commit and tree once without a commit-graph", async () => {
    rmSync(join(dir, ".git/objects/info/commit-graph"), { force: true });
    const ours = await compare();
    const count = reachable();
    expect(ours.statistics.commitsFromGraph).toBe(0);
    expect(ours.statistics.objectsRead).toBe((count.commit ?? 0) + (count.tree ?? 0));
  });

  it("takes the commits it reaches through parents from the commit-graph", async () => {
    git(["commit-graph", "write", "--reachable"]);
    try {
      const ours = await compare();
      const count = reachable();
      // the two commits refs name (main, side) are read; the others come from the graph
      const tips = new Set(
        git(["for-each-ref", "--format=%(objectname)"]).split("\n").filter(Boolean),
      );
      expect(ours.statistics.commitsFromGraph).toBe((count.commit ?? 0) - tips.size);
      expect(ours.statistics.objectsRead).toBe((count.tree ?? 0) + tips.size);
    } finally {
      rmSync(join(dir, ".git/objects/info/commit-graph"), { force: true });
    }
  });

  /** The pack's objects by type (`cat-file --batch-all-objects`). */
  function packed(): Record<string, number> {
    const count: Record<string, number> = {};
    for (const t of git(["cat-file", "--batch-all-objects", "--batch-check=%(objecttype)"])
      .split("\n")
      .filter(Boolean))
      count[t] = (count[t] ?? 0) + 1;
    return count;
  }

  it("unpacks each commit and tree of the pack once, in one read in pack order", async () => {
    rmSync(join(dir, ".git/objects/info/commit-graph"), { force: true });
    const ours = await compare();
    const count = packed();
    // the scan unpacks no blob; the walk takes every commit and tree from it, none from the store
    expect(ours.statistics.objectsScanned).toBe((count.commit ?? 0) + (count.tree ?? 0));
    const reach = reachable();
    expect(ours.statistics.objectsRead).toBe((reach.commit ?? 0) + (reach.tree ?? 0));
  });

  it("keeps the commits the commit-graph verification compares from the same read", async () => {
    git(["commit-graph", "write", "--reachable"]);
    try {
      const ours = await compare();
      const count = packed();
      expect(ours.statistics.objectsScanned).toBe((count.commit ?? 0) + (count.tree ?? 0));
    } finally {
      rmSync(join(dir, ".git/objects/info/commit-graph"), { force: true });
    }
  });

  it("a full run reads only the objects refs name through the store", async () => {
    const ours = await (await openOurs(dir))
      .fsck()
      .setRepositoryFiles({ files: createNodeFilesApi({ rootDir: dir }) })
      .call();
    expect(ours.output).toBe(git(["fsck", "--no-progress"]));
    // the object pass reads every object in pack order; the walk reads none again
    const tips = new Set(
      git(["for-each-ref", "--format=%(objectname)"]).split("\n").filter(Boolean),
    );
    expect(ours.statistics.objectsRead).toBe(tips.size);
    expect(ours.statistics.objectsScanned).toBe(0);
  });
});
