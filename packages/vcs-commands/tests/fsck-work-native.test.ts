/**
 * The work of `git fsck --connectivity-only`, counted rather than timed, with the output
 * checked against native git: every commit and tree reached is read once (a tree the walk
 * parses is walked from those bytes, as git's parse_tree reads it once), and with a
 * commit-graph the commits reached through parents come from the graph (git's
 * parse_commit_in_graph) while the commits refs name are still read (parse_object).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FsckCommand } from "../src/index.js";

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

describeGit("fsck reads in pack order: REF_DELTA packs, memory bounds, the graph's copy", () => {
  let root: string;
  let dir: string;
  const git = (args: string[], input?: string, cwd = dir) =>
    execFileSync("git", args, {
      cwd,
      env: nativeGitEnv(root),
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  const nativeFsck = (args: string[]) => {
    try {
      return { stdout: git(["fsck", "--no-progress", ...args]), status: 0 };
    } catch (e) {
      const err = e as { stdout: string; status: number };
      return { stdout: err.stdout, status: err.status };
    }
  };
  const count = (cmd: string[]) => {
    const n: Record<string, number> = {};
    for (const t of git(cmd).split("\n").filter(Boolean)) n[t] = (n[t] ?? 0) + 1;
    return n;
  };
  const ours = async (configure: (c: FsckCommand) => FsckCommand) =>
    configure(
      (await openOurs(dir))
        .fsck()
        .setRepositoryFiles({ files: createNodeFilesApi({ rootDir: dir }) }),
    ).call();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fsck-work-native-"));
    dir = join(root, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", dir], { env: nativeGitEnv(root) });
    git(["fast-import", "--quiet"], history(40));
    // REF_DELTA entries only (repack.useDeltaBaseOffset=false)
    git(["-c", "repack.useDeltaBaseOffset=false", "repack", "-adfq", "--depth=10"]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("unpacks a REF_DELTA pack's commits and trees in the one read, as an OFS_DELTA one", async () => {
    const packDir = join(dir, ".git/objects/pack");
    const idx = readdirSync(packDir).find((f) => f.endsWith(".idx")) as string;
    const rows = git(["verify-pack", "-v", join(packDir, idx)]).split("\n");
    // deltas there are (trees among them)
    expect(
      rows.filter((r) => / tree +\d+ \d+ \d+ \d+ [0-9a-f]{40}$/.test(r)).length,
    ).toBeGreaterThan(0);
    const result = await ours((c) => c.setConnectivityOnly(true));
    expect(result.output).toBe(nativeFsck(["--connectivity-only"]).stdout);
    const packed = count(["cat-file", "--batch-all-objects", "--batch-check=%(objecttype)"]);
    expect(result.statistics.objectsScanned).toBe((packed.commit ?? 0) + (packed.tree ?? 0));
  });

  it("keeps at most the links and graph commits it is given, with the same output", async () => {
    git(["commit-graph", "write", "--reachable"]);
    try {
      for (const connectivityOnly of [true, false]) {
        const native = nativeFsck(connectivityOnly ? ["--connectivity-only"] : []);
        const unbounded = await ours((c) => c.setConnectivityOnly(connectivityOnly));
        expect(unbounded.output).toBe(native.stdout);
        expect(unbounded.statistics.linksKept).toBeGreaterThan(100);
        expect(unbounded.statistics.graphCommitsKept).toBeGreaterThan(20);
        const bounded = await ours((c) =>
          c.setConnectivityOnly(connectivityOnly).setMemoryLimits({ links: 100, graphCommits: 5 }),
        );
        expect(bounded.output).toBe(native.stdout);
        expect(bounded.errorOutput).toBe(unbounded.errorOutput);
        expect(bounded.exitCode).toBe(native.status);
        expect(bounded.statistics.linksKept).toBeLessThanOrEqual(100);
        expect(bounded.statistics.graphCommitsKept).toBe(5);
      }
    } finally {
      rmSync(join(dir, ".git/objects/info/commit-graph"), { force: true });
    }
  });

  it("verifies the commit-graph against the copy git reads: from its most recently used pack", async () => {
    const copy = join(root, "forged");
    execFileSync("git", ["init", "-q", "-b", "main", copy], { env: nativeGitEnv(root) });
    const g = (args: string[], input?: string) => git(args, input, copy);
    for (const [i, text] of ["one", "two", "three", "four"].entries()) {
      writeFileSync(join(copy, "a"), `${i}\n`);
      g(["add", "a"]);
      g(["commit", "-q", "-m", text]);
    }
    g(["repack", "-adq"]);
    g(["commit-graph", "write", "--reachable"]);
    // a newer pack holding the first and the last commit in id order under their ids, with
    // other bytes: git reads the first from it (the newest pack), which then is the most
    // recently used; the commits after it move the old pack in front again, so the last is
    // read from there, sound
    const ids = g(["rev-list", "main"]).trim().split("\n").sort();
    const first = ids[0] as string;
    const last = ids[ids.length - 1] as string;
    const forge = (id: string) =>
      Buffer.from(
        execFileSync("git", ["cat-file", "commit", id], { cwd: copy })
          .toString()
          .replace(/\n\n[\s\S]*$/, "\n\nforged\n")
          .replace(/^parent .*\n/m, ""),
      );
    const entries = [first, last].map((id) => ({ id, content: forge(id) }));
    const pack = forgedPack(entries.map((e) => e.content));
    const name = createHash("sha1")
      .update(pack.bytes.subarray(0, pack.bytes.length - 20))
      .digest("hex");
    const packDir = join(copy, ".git/objects/pack");
    writeFileSync(join(packDir, `pack-${name}.pack`), pack.bytes);
    writeFileSync(
      join(packDir, `pack-${name}.idx`),
      idxOf(
        entries.map((e, i) => ({
          id: e.id,
          at: pack.offsets[i] as number,
          end: pack.ends[i] as number,
        })),
        pack.bytes,
      ),
    );
    const future = new Date(Date.now() + 3600_000);
    utimesSync(join(packDir, `pack-${name}.idx`), future, future);
    utimesSync(join(packDir, `pack-${name}.pack`), future, future);
    for (const args of [[], ["--connectivity-only"]]) {
      let native: { stderr: string; status: number };
      try {
        execFileSync("git", ["fsck", "--no-progress", ...args], {
          cwd: copy,
          env: nativeGitEnv(root),
          stdio: ["pipe", "pipe", "pipe"],
        });
        native = { stderr: "", status: 0 };
      } catch (e) {
        const err = e as { stderr: Buffer; status: number };
        native = { stderr: err.stderr.toString(), status: err.status };
      }
      const result = await (await openOurs(copy))
        .fsck()
        .setRepositoryFiles({ files: createNodeFilesApi({ rootDir: copy }) })
        .setConnectivityOnly(args.length > 0)
        .call();
      const graphLines = (s: string) =>
        s
          .split("\n")
          .filter((l) => /commit-graph/.test(l))
          .sort();
      const theirs = graphLines(native.stderr);
      expect(theirs.some((l) => l.includes(first))).toBe(true);
      expect(theirs.some((l) => l.includes(last))).toBe(false);
      expect(graphLines(result.errorOutput)).toEqual(theirs);
      expect(result.exitCode & 16).toBe(native.status & 16);
    }
  });

  /** A pack of commit entries holding `contents`, and where each entry starts and ends. */
  function forgedPack(contents: Buffer[]): { bytes: Buffer; offsets: number[]; ends: number[] } {
    const head = Buffer.alloc(12);
    head.write("PACK");
    head.writeUInt32BE(2, 4);
    head.writeUInt32BE(contents.length, 8);
    const parts: Buffer[] = [head];
    const offsets: number[] = [];
    const ends: number[] = [];
    let at = 12;
    for (const content of contents) {
      const sizeBytes: number[] = [];
      let size = content.length;
      let b = (1 << 4) | (size & 15);
      size = Math.floor(size / 16);
      while (size > 0) {
        sizeBytes.push(b | 0x80);
        b = size & 0x7f;
        size = Math.floor(size / 128);
      }
      sizeBytes.push(b);
      const entry = Buffer.concat([Buffer.from(sizeBytes), deflateSync(content)]);
      offsets.push(at);
      at += entry.length;
      ends.push(at);
      parts.push(entry);
    }
    const body = Buffer.concat(parts);
    return {
      bytes: Buffer.concat([body, createHash("sha1").update(body).digest()]),
      offsets,
      ends,
    };
  }

  /** The v2 idx of a `forgedPack` pack, its entries named as given. */
  function idxOf(entries: { id: string; at: number; end: number }[], pack: Buffer): Buffer {
    const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : 1));
    const fan = Buffer.alloc(1024);
    for (let i = 0; i < 256; i++) {
      fan.writeUInt32BE(
        sorted.filter((e) => Number.parseInt(e.id.slice(0, 2), 16) <= i).length,
        i * 4,
      );
    }
    const crcs = Buffer.alloc(4 * sorted.length);
    const offs = Buffer.alloc(4 * sorted.length);
    sorted.forEach((e, i) => {
      crcs.writeUInt32BE(crc32(pack.subarray(e.at, e.end)) >>> 0, 4 * i);
      offs.writeUInt32BE(e.at, 4 * i);
    });
    const body = Buffer.concat([
      Buffer.from([0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2]),
      fan,
      ...sorted.map((e) => Buffer.from(e.id, "hex")),
      crcs,
      offs,
      pack.subarray(pack.length - 20),
    ]);
    return Buffer.concat([body, createHash("sha1").update(body).digest()]);
  }
});
