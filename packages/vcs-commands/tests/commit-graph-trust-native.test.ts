/**
 * merge-ort's merge-base walk (`MergeBaseGraph` over `commitsBaseSource`) and the transport
 * facade over commit-graphs whose generations cannot be trusted, against native git without
 * the graph (`core.commitGraph=false`, always right): zero topological levels (git before
 * 2.18) with clock skew, and a corrupt record. A stale graph does not make a pruned commit
 * present to receive-pack (`getCommitInfo`).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultSerializationApi } from "@statewalker/vcs-core";
import { createGitFilesBackend } from "@statewalker/vcs-store-files";
import { VcsRepositoryFacade } from "@statewalker/vcs-transport-adapters";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { commitsBaseSource, MergeBaseGraph } from "../src/commands/merge-bases.js";
import { nativeGitEnv } from "./native-git-http-backend.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "cgraph-trust-"));
  dirs.push(d);
  return d;
};
const home = tempDir();
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, { cwd, env: nativeGitEnv(home), input }).toString();
const gitOut = (cwd: string, args: string[]) => {
  try {
    return git(cwd, args);
  } catch (e) {
    if ((e as { status: number }).status === 1) return "";
    throw e;
  }
};

/** Commits through fast-import (parents by index, committer dates), a branch `c<i>` each. */
function dagRepo(commits: { parents: number[]; date: number }[]) {
  const dir = tempDir();
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  const lines: string[] = [];
  commits.forEach((c, i) => {
    lines.push(`commit refs/heads/c${i}`, `mark :${i + 1}`);
    lines.push(`author A <a@example.com> ${c.date} +0000`);
    lines.push(`committer C <c@example.com> ${c.date} +0000`);
    lines.push("data 2", `${i % 10}`);
    const [first, ...rest] = c.parents;
    if (first !== undefined) lines.push(`from :${first + 1}`);
    for (const p of rest) lines.push(`merge :${p + 1}`);
    lines.push(`M 100644 inline f${i}`, "data 2", `${i % 10}`);
  });
  git(dir, ["fast-import", "--quiet"], `${lines.join("\n")}\n`);
  return { dir, ids: commits.map((_, i) => git(dir, ["rev-parse", `c${i}`]).trim()) };
}

/** Changes `objects/info/commit-graph` (CDAT at `cdat`, OIDL at `oidl`) and fixes its checksum. */
function editGraph(dir: string, edit: (bytes: Buffer, at: Record<string, number>) => void) {
  const path = join(dir, ".git/objects/info/commit-graph");
  const bytes = Buffer.from(readFileSync(path));
  const at: Record<string, number> = {};
  for (let i = 0; i < (bytes[6] as number); i++) {
    const e = 8 + 12 * i;
    at[bytes.subarray(e, e + 4).toString("latin1")] = Number(bytes.readBigUInt64BE(e + 4));
  }
  edit(bytes, at);
  createHash("sha1")
    .update(bytes.subarray(0, bytes.length - 20))
    .digest()
    .copy(bytes, bytes.length - 20);
  rmSync(path, { force: true });
  writeFileSync(path, bytes);
}

/** The commits by graph position (OIDL order). */
const oidl = (bytes: Buffer, at: Record<string, number>, n: number) =>
  Array.from({ length: n }, (_, i) =>
    bytes.subarray((at.OIDL as number) + 20 * i, (at.OIDL as number) + 20 * i + 20).toString("hex"),
  );

/** MergeBaseGraph's bases of every pair against native git's without the graph. */
async function expectNativeBases(dir: string, ids: string[]) {
  const { history } = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });
  for (const a of ids) {
    for (const b of ids) {
      const graph = new MergeBaseGraph(commitsBaseSource(history.commits, async () => new Map()));
      const bases = await graph.mergeBases(graph.commit(a), graph.commit(b));
      const native = gitOut(dir, ["-c", "core.commitGraph=false", "merge-base", "--all", a, b])
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(
        bases.map((n) => n.id),
        `${a} ${b}`,
      ).toEqual(native);
    }
  }
}

describe("merge-ort's merge bases over an untrusted commit-graph", () => {
  it("zero topological levels and a root newer than its children", async () => {
    const { dir, ids } = dagRepo([
      { parents: [], date: 5000 },
      { parents: [0], date: 1000 },
      { parents: [0], date: 2000 },
      { parents: [1, 2], date: 1500 },
      { parents: [2], date: 900 },
      { parents: [4, 1], date: 3000 },
    ]);
    git(dir, ["-c", "commitGraph.generationVersion=1", "commit-graph", "write", "--reachable"]);
    editGraph(dir, (bytes, at) => {
      for (let i = 0; i < ids.length; i++) {
        const w = (at.CDAT as number) + 36 * i + 28;
        bytes.writeUInt32BE(bytes.readUInt32BE(w) & 3, w);
      }
    });
    await expectNativeBases(dir, ids);
  });

  it("zero topological levels: a base reachable from another through an older commit", async () => {
    // the date walk finds both Q and P (Q is not painted stale: R, older, is never reached),
    // so the redundancy check must walk P -> R -> Q, which equal zero generations would cut
    const { dir, ids } = dagRepo([
      { parents: [], date: 100 },
      { parents: [0], date: 10 },
      { parents: [1], date: 50 },
      { parents: [2, 0], date: 300 },
      { parents: [0, 2], date: 200 },
    ]);
    git(dir, ["-c", "commitGraph.generationVersion=1", "commit-graph", "write", "--reachable"]);
    editGraph(dir, (bytes, at) => {
      for (let i = 0; i < ids.length; i++) {
        const w = (at.CDAT as number) + 36 * i + 28;
        bytes.writeUInt32BE(bytes.readUInt32BE(w) & 3, w);
      }
    });
    expect(
      gitOut(dir, [
        "-c",
        "core.commitGraph=false",
        "merge-base",
        "--all",
        ids[3] as string,
        ids[4] as string,
      ]).trim(),
    ).toBe(ids[2]);
    await expectNativeBases(dir, ids);
  });

  it("a corrupt record on a base reachable from another", async () => {
    const { dir, ids } = dagRepo([
      { parents: [], date: 100 },
      { parents: [0], date: 10 },
      { parents: [1], date: 50 },
      { parents: [2, 0], date: 300 },
      { parents: [0, 2], date: 200 },
    ]);
    git(dir, ["commit-graph", "write", "--reachable"]);
    editGraph(dir, (bytes, at) => {
      const pos = oidl(bytes, at, ids.length).indexOf(ids[0] as string);
      bytes.writeUInt32BE(0x00ffffff, (at.CDAT as number) + 36 * pos + 20);
    });
    await expectNativeBases(dir, ids);
  });

  it("a corrupt parent position", async () => {
    const { dir, ids } = dagRepo([
      { parents: [], date: 1000 },
      { parents: [0], date: 2000 },
      { parents: [0], date: 2500 },
      { parents: [1, 2], date: 3000 },
      { parents: [2], date: 3500 },
      { parents: [4, 1], date: 4000 },
    ]);
    git(dir, ["commit-graph", "write", "--reachable"]);
    editGraph(dir, (bytes, at) => {
      const pos = oidl(bytes, at, ids.length).indexOf(ids[0] as string);
      bytes.writeUInt32BE(0x00ffffff, (at.CDAT as number) + 36 * pos + 20);
    });
    await expectNativeBases(dir, ids);
  });
});

describe("the transport facade over a stale commit-graph", () => {
  it("does not report a pruned commit (receive-pack's type and connectivity checks)", async () => {
    const { dir, ids } = dagRepo([
      { parents: [], date: 1000 },
      { parents: [0], date: 2000 },
      { parents: [1], date: 3000 },
    ]);
    git(dir, ["commit-graph", "write", "--reachable"]);
    git(dir, ["update-ref", "-d", "refs/heads/c2"]);
    git(dir, ["reflog", "expire", "--expire=now", "--all"]);
    git(dir, ["-c", "gc.writeCommitGraph=false", "gc", "-q", "--prune=now"]);
    const { history } = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: dir }),
    });
    expect((await history.commitGraph?.get())?.has(ids[2] as string)).toBe(true);
    const facade = new VcsRepositoryFacade({
      history,
      serialization: new DefaultSerializationApi({ history }),
    });
    expect(await facade.getCommitInfo(ids[2] as string)).toBeUndefined();
    expect((await facade.getCommitInfo(ids[1] as string))?.parents).toEqual([ids[0]]);
  });
});
