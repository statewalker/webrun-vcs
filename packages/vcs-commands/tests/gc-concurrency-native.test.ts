/**
 * Our gc and native git's side by side (statewalker-root#286), after git's t6500-gc.sh (the
 * `gc.pid` lock, "gc is already running") and t5304-prune.sh / t6501-freshen-objects.sh (an
 * old object written again while a gc runs is freshened and kept). Each interleaving is
 * deterministic:
 *
 * - ours is paused by a FilesApi proxy at chosen steps (mid-repack, before the prune), and
 *   native git runs there (`git gc`, `git commit`);
 * - native gc is paused before its `pack-refs` and `prune` children by a `git` wrapper first on
 *   its exec path (`GIT_EXEC_PATH`), which waits for the test's go-ahead file, and ours runs
 *   there.
 *
 * Both sides end in a repository native `git fsck --strict` accepts, holding what the writer
 * wrote, and further gcs (ours, native) keep it so.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { FilesApi } from "@statewalker/vcs-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DAY,
  fsck,
  gcEnv,
  initRepo,
  NOW,
  nativeGc,
  newCase,
  openOursGc,
  REFLOG_EXPIRY_DEFAULTS,
} from "./gc-native-twins-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;

/** The `git` the tests run (first on PATH), by absolute path. */
function realGit(): string {
  return spawnSync("sh", ["-c", "command -v git"]).stdout.toString().trim();
}

/** Sets a loose object's mtime `days` ago. */
function ageLoose(gitDir: string, id: string, days: number) {
  const t = NOW - days * DAY;
  utimesSync(join(gitDir, "objects", id.slice(0, 2), id.slice(2)), t, t);
}

/** A FilesApi calling `at(step)` once at each step of a gc: mid-repack, before the prune. */
function pausing(at: (step: "repack" | "prune") => Promise<void>) {
  const done = new Set<string>();
  const once = async (step: "repack" | "prune") => {
    if (done.has(step)) return;
    done.add(step);
    await at(step);
  };
  return (base: FilesApi): FilesApi =>
    new Proxy(base, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "write")
          return async (path: string, content: Iterable<Uint8Array>) => {
            // the repack's first pack file: its listing is made, nothing is removed yet
            if (path.includes("objects/pack/") && done.size === 0) await once("repack");
            return target.write(path, content);
          };
        if (prop === "move")
          return async (source: string, path: string) => {
            const moved = await target.move(source, path);
            // update-server-info: the repack is over, the prune comes next
            if (path.endsWith("objects/info/packs")) await once("prune");
            return moved;
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
}

describeGit("gc beside native git (t6500-gc, t5304-prune, t6501-freshen-objects)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "gc-concurrency-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A history, a deleted branch, an old unreachable loose blob `revived` later. */
  function scenario(name: string) {
    const caseDir = newCase(root, name);
    const r = initRepo(root, caseDir);
    r.commit("one", { "a.txt": "a\n".repeat(20) });
    r.git(["checkout", "-q", "-b", "topic"]);
    r.commit("topic", { "t.txt": "topic\n" });
    r.git(["checkout", "-q", "main"]);
    r.git(["repack", "-adq"]);
    r.git(["branch", "-D", "-q", "topic"]);
    r.commit("two", { "b.txt": "b\n" });
    const revived = r.blob("old and unreachable, written again during the gc\n");
    ageLoose(r.gitDir, revived, 30);
    return { caseDir, r, revived };
  }

  it("t6500-gc: native gc refuses while ours holds gc.pid; native commits during ours survive it", async () => {
    const { caseDir, r, revived } = scenario("ours-holds");
    const repo = r.dir;
    const seen: { gc?: ReturnType<typeof nativeGc>; pid?: string } = {};
    let committed = "";
    const git = await openOursGc(
      root,
      join(caseDir, "src"),
      "repo",
      {},
      pausing(async (step) => {
        if (step === "repack") {
          seen.pid = spawnSync("cat", [join(r.gitDir, "gc.pid")]).stdout.toString();
          seen.gc = nativeGc(root, repo, []);
          r.commit("during the repack", { "c.txt": "written while our gc repacks\n" });
        } else {
          // an old unreachable blob named again: native git freshens it as it writes
          committed = r.commit("during the prune", {
            "revived.txt": "old and unreachable, written again during the gc\n",
          });
        }
      }),
    );
    const result = await git.gc().call();
    expect(result.details?.skipped).toBe(false);
    expect(seen.pid).toBe(`${process.pid} ${hostname()}`);
    expect(seen.gc).toEqual({
      status: 128,
      stderr: `fatal: gc is already running on machine '${hostname()}' pid ${process.pid} (use --force if not)\n`,
    });
    expect(existsSync(join(r.gitDir, "gc.pid"))).toBe(false);
    expect(committed).not.toBe("");
    expect(r.git(["rev-parse", "main"])).toBe(committed);
    expect(fsck(root, repo)).toEqual({ status: 0, out: "" });
    r.git(["cat-file", "-e", revived]);
    // later gcs, ours then native, keep it all
    expect(
      (await (await openOursGc(root, join(caseDir, "src"))).gc().call()).details?.skipped,
    ).toBe(false);
    expect(nativeGc(root, repo, []).status).toBe(0);
    expect(fsck(root, repo)).toEqual({ status: 0, out: "" });
    expect(r.git(["rev-parse", "main"])).toBe(committed);
  });

  it("t6500-gc: ours refuses with git's message while native gc holds gc.pid; our commits during native's survive it", async () => {
    const { caseDir, r, revived } = scenario("native-holds");
    const repo = r.dir;
    // a `git` first on the exec path pausing gc's pack-refs and prune children
    const wrapper = join(caseDir, "exec-path");
    const pause = join(caseDir, "pause");
    for (const d of [wrapper, pause]) spawnSync("mkdir", ["-p", d]);
    const script = join(wrapper, "git");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        'case "$1" in pack-refs|prune)',
        '  : > "$GC_PAUSE_DIR/at-$1"',
        '  while [ ! -e "$GC_PAUSE_DIR/go-$1" ]; do sleep 0.02; done ;;',
        "esac",
        'exec "$REAL_GIT" "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(script, 0o755);
    const child = spawn(realGit(), [...REFLOG_EXPIRY_DEFAULTS, "gc", "-q"], {
      cwd: repo,
      env: gcEnv(root, { GIT_EXEC_PATH: wrapper, GC_PAUSE_DIR: pause, REAL_GIT: realGit() }),
    });
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    const reach = async (step: string) => {
      for (let i = 0; i < 1500 && !existsSync(join(pause, `at-${step}`)); i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(existsSync(join(pause, `at-${step}`)), `native gc reached ${step}`).toBe(true);
    };

    await reach("pack-refs");
    const git = await openOursGc(root, join(caseDir, "src"));
    await expect(git.gc().call()).rejects.toThrow(
      `fatal: gc is already running on machine '${hostname()}' pid ${child.pid} (use --force if not)`,
    );
    writeFileSync(join(pause, "go-pack-refs"), "");

    await reach("prune");
    // native's repack is over; we commit, naming the old unreachable blob again: ours
    // freshens its file, so native's prune keeps it
    writeFileSync(join(repo, "revived.txt"), "old and unreachable, written again during the gc\n");
    writeFileSync(join(repo, "d.txt"), "written while native gc prunes\n");
    await git.add().addFilepattern("revived.txt").addFilepattern("d.txt").call();
    const commit = await git.commit().setMessage("during native's prune").call();
    writeFileSync(join(pause, "go-prune"), "");
    expect(await exited, stderr).toBe(0);

    expect(r.git(["rev-parse", "main"])).toBe(commit.id);
    expect(fsck(root, repo)).toEqual({ status: 0, out: "" });
    r.git(["cat-file", "-e", revived]);
    expect(
      (await (await openOursGc(root, join(caseDir, "src"))).gc().call()).details?.skipped,
    ).toBe(false);
    expect(nativeGc(root, repo, []).status).toBe(0);
    expect(fsck(root, repo)).toEqual({ status: 0, out: "" });
  });

  it("t6500-gc: ours dies on gc.pid.lock as git does, and --force takes a held gc.pid", async () => {
    const { caseDir, r } = scenario("lock-file");
    writeFileSync(join(r.gitDir, "gc.pid.lock"), "");
    const native = nativeGc(root, r.dir, []);
    expect(native.status).toBe(128);
    const git = await openOursGc(root, join(caseDir, "src"));
    const error = await git
      .gc()
      .call()
      .then(
        () => undefined,
        (e: Error) => e.message,
      );
    // the first line is the same in every version; the advice is 2.43's or 2.5x's
    const lines = (s: string) => s.split(/\n/).filter(Boolean);
    expect(lines(error ?? "")[0]).toBe(lines(native.stderr)[0]);
    rmSync(join(r.gitDir, "gc.pid.lock"));

    writeFileSync(join(r.gitDir, "gc.pid"), "12345 elsewhere");
    expect(nativeGc(root, r.dir, []).stderr).toBe(
      "fatal: gc is already running on machine 'elsewhere' pid 12345 (use --force if not)\n",
    );
    await expect(git.gc().call()).rejects.toThrow(
      "fatal: gc is already running on machine 'elsewhere' pid 12345 (use --force if not)",
    );
    const forced = await git.gc().setForce(true).call();
    expect(forced.details?.skipped).toBe(false);
    // git unlinks its pid file at exit: gc.pid is gone after a forced gc too
    expect(existsSync(join(r.gitDir, "gc.pid"))).toBe(false);
    expect(fsck(root, r.dir)).toEqual({ status: 0, out: "" });
  });
});
