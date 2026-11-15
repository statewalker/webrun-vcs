/**
 * The stash's refs/stash and reflog writes across real processes: tsx children, each with
 * its own Node FilesApi and git-files backend, push and drop stashes through GitStashStore
 * at the same time, while native `git update-ref --create-reflog` writes refs/stash too.
 * Every write takes refs/stash.lock (and a drop logs/refs/stash.lock), so no update and no
 * reflog line is lost, and the log stays a chain git reads (`git stash list`).
 *
 * Before the stash went through the ref store, it rewrote refs/stash and logs/refs/stash
 * with plain writes: concurrent pushes lost each other's reflog lines.
 */
import {
  type ChildProcessWithoutNullStreams,
  execFile,
  execFileSync,
  spawn,
} from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, afterEach, describe, expect, it } from "vitest";

/** A clean git environment: no user or system config, a fixed identity (CI has none). */
const env = {
  PATH: process.env.PATH ?? "",
  HOME: tmpdir(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_NAME: "A U Thor",
  GIT_COMMITTER_EMAIL: "author@example.com",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
/** Native git without blocking the event loop; resolves with its exit status. */
const gitAsync = (cwd: string, args: string[]) =>
  new Promise<number>((resolve) => {
    execFile("git", args, { cwd, env }, (error) =>
      resolve(error ? Number((error as { code?: number }).code ?? 1) : 0),
    );
  });

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A repository with two commits; returns its directory, HEAD and the first commit's tree. */
function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ref-locks-cross-process-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "-b", "main", "."]);
  writeFileSync(join(dir, "f.txt"), "one\n");
  git(dir, ["add", "f.txt"]);
  git(dir, ["commit", "-q", "-m", "c0"]);
  const tree0 = git(dir, ["rev-parse", "HEAD^{tree}"]);
  writeFileSync(join(dir, "f.txt"), "two\n");
  git(dir, ["commit", "-q", "-am", "c1"]);
  return { dir, head: git(dir, ["rev-parse", "HEAD"]), tree0 };
}

const racer = join(import.meta.dirname, "..", "fixtures", "stash-racer.ts");

const running = new Set<ChildProcessWithoutNullStreams>();
afterEach(() => {
  for (const child of running) child.kill();
  running.clear();
});

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`racer: no ${what} within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A racer process; resolves once it has printed "ready". */
async function startRacer(args: string[]) {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ["--conditions=source", "--import", "tsx", racer, ...args],
    { cwd: import.meta.dirname, env: { ...process.env, ...env }, stdio: "pipe" },
  );
  running.add(child);
  child.on("close", () => running.delete(child));
  child.stdin.on("error", () => {}); // EPIPE if it exits first: its stderr says why
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const { value, done } = await within(lines.next(), 60000, "answer");
    if (done) throw new Error(`racer exited early: ${stderr}`);
    return value as string;
  };
  expect(await next()).toBe("ready");
  return {
    go: () => child.stdin.write("go\n"),
    result: async () => JSON.parse(await next()) as { done: number; retries: number },
    exited: new Promise<number | null>((r) => child.on("close", r)),
  };
}

/** The reflog of refs/stash: one { old, new, message } per line, oldest first. */
function stashLog(dir: string) {
  return readFileSync(join(dir, ".git/logs/refs/stash"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      old: line.slice(0, 40),
      new: line.slice(41, 81),
      message: line.slice(line.indexOf("\t") + 1),
    }));
}

/** Every line's old id is the previous line's new id, and refs/stash is the last new id. */
function expectChain(dir: string, log: ReturnType<typeof stashLog>) {
  expect(log[0]?.old).toBe("0".repeat(40));
  for (let i = 1; i < log.length; i++) expect(log[i]?.old, `line ${i}`).toBe(log[i - 1]?.new);
  expect(git(dir, ["rev-parse", "refs/stash"])).toBe(log.at(-1)?.new);
}

describe("refs/stash and its reflog across processes", () => {
  it("concurrent pushes from three processes and native git update-ref lose no update", async () => {
    const { dir, head, tree0 } = newRepo();
    const perRacer = 12;
    const racers = await Promise.all(
      ["A", "B", "C"].map((label) =>
        startRacer([dir, "push", String(perRacer), label, head, tree0]),
      ),
    );
    // distinct commits for native git (it logs no line for a no-op update)
    const nativeIds = Array.from({ length: 12 }, (_, i) =>
      git(dir, ["commit-tree", "-p", head, "-m", `native ${i}`, tree0]),
    );
    for (const r of racers) r.go();
    // native git writes refs/stash meanwhile, under the same refs/stash.lock, once the
    // racers are writing
    let nativeOk = 0;
    const native = (async () => {
      const logFile = join(dir, ".git/logs/refs/stash");
      const lines = () => (existsSync(logFile) ? stashLog(dir).length : 0);
      while (lines() < 3) await new Promise((r) => setTimeout(r, 2));
      for (const [i, id] of nativeIds.entries()) {
        const status = await gitAsync(dir, [
          "update-ref",
          "--create-reflog",
          "-m",
          `native-${i}`,
          "refs/stash",
          id,
        ]);
        if (status === 0) nativeOk++;
      }
    })();
    const results = await Promise.all(racers.map((r) => r.result()));
    await native;
    for (const r of racers) expect(await r.exited).toBe(0);
    expect(results.map((r) => r.done)).toEqual([perRacer, perRacer, perRacer]);

    const log = stashLog(dir);
    // every push and every successful native update has its line, exactly once
    expect(log).toHaveLength(3 * perRacer + nativeOk);
    for (const label of ["A", "B", "C"]) {
      for (let i = 0; i < perRacer; i++) {
        expect(log.filter((l) => l.message === `On main: ${label}-${i}`)).toHaveLength(1);
      }
    }
    expectChain(dir, log);
    // git reads the log: one stash@{n} per line that names a stash commit
    expect(git(dir, ["stash", "list"]).split("\n").filter(Boolean).length).toBe(log.length);
    expect(git(dir, ["fsck", "--strict", "--no-dangling"])).toBe("");
  }, 120000);

  it("a process dropping stash@{1} while two others push: the log keeps every other entry, chained", async () => {
    const { dir, head, tree0 } = newRepo();
    const pushes = 10;
    const drops = 8;
    const racers = await Promise.all([
      startRacer([dir, "push", String(pushes), "A", head, tree0]),
      startRacer([dir, "push", String(pushes), "B", head, tree0]),
      startRacer([dir, "drop", String(drops), "D", head, tree0]),
    ]);
    for (const r of racers) r.go();
    const results = await Promise.all(racers.map((r) => r.result()));
    for (const r of racers) expect(await r.exited).toBe(0);
    expect(results.map((r) => r.done)).toEqual([pushes, pushes, drops]);

    const log = stashLog(dir);
    expect(log).toHaveLength(2 * pushes - drops);
    expect(new Set(log.map((l) => l.message)).size).toBe(log.length);
    expectChain(dir, log); // drops rewrite the old ids (--rewrite)
    expect(git(dir, ["stash", "list"]).split("\n").filter(Boolean)).toHaveLength(log.length);
  }, 120000);
});
