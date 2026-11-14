/**
 * Git lock files across real processes, on the Node FilesApi of webrun-files-node 0.11
 * (`createExclusive` is `open "wx"`): two child processes, each with its own FilesApi
 * over one directory, race for the same locks and exactly one takes each; native git
 * sees a lock we hold.
 */
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { atomicFilesOver } from "@statewalker/vcs-utils/files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "A U Thor",
  GIT_COMMITTER_EMAIL: "author@example.com",
};
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" });

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cross-process-locks-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "--initial-branch=main"]);
  return dir;
}

const racer = join(import.meta.dirname, "fixtures", "lock-racer.ts");

/** A racer process; resolves once it has printed "ready". */
async function startRacer(gitDir: string, locks: string[]) {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ["--conditions=source", "--import", "tsx", racer, gitDir, ...locks],
    { cwd: import.meta.dirname, env, stdio: "pipe" },
  );
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const { value, done } = await lines.next();
    if (done) throw new Error(`racer exited early: ${stderr}`);
    return value as string;
  };
  expect(await next()).toBe("ready");
  return {
    go: () => child.stdin.write("go\n"),
    result: async () => JSON.parse(await next()) as Record<string, boolean>,
    exited: new Promise<number | null>((r) => child.on("close", r)),
  };
}

describe("lock files across processes (webrun-files-node createExclusive)", () => {
  it("two processes race for the same ref locks and index.lock: exactly one takes each", async () => {
    const dir = gitRepo();
    const gitDir = join(dir, ".git");
    const locks = [
      "index.lock",
      "packed-refs.lock",
      ...Array.from({ length: 20 }, (_, i) => `refs/heads/topic/b${i}.lock`),
    ];
    // both processes are loaded and waiting before either is told to go
    const [a, b] = await Promise.all([startRacer(gitDir, locks), startRacer(gitDir, locks)]);
    a.go();
    b.go();
    const [ra, rb] = await Promise.all([a.result(), b.result()]);
    expect(await a.exited).toBe(0);
    expect(await b.exited).toBe(0);
    for (const lock of locks) {
      expect([ra[lock], rb[lock]].filter(Boolean), lock).toHaveLength(1);
      // the lock holds the winner's content, whole
      const content = readFileSync(join(gitDir, lock), "utf8");
      expect(content).toMatch(/^pid \d+$/);
    }
  }, 30000);

  it("native git sees an index.lock we hold: git add fails with File exists", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    const files = atomicFilesOver(createNodeFilesApi({ rootDir: dir }), ".git");
    expect(await files.createExclusive("index.lock", new TextEncoder().encode("ours"))).toBe(
      true,
    );
    let message = "";
    try {
      git(dir, ["add", "a.txt"]);
    } catch (error) {
      message = String((error as { stderr?: string }).stderr);
    }
    expect(message).toContain("File exists");
    expect(message).toContain("index.lock");
    // released, git proceeds
    expect(await files.remove("index.lock")).toBe(true);
    git(dir, ["add", "a.txt"]);
    expect(git(dir, ["ls-files"]).trim()).toBe("a.txt");
  });

  it("we see an index.lock native git holds", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, ".git", "index.lock"), "");
    const files = atomicFilesOver(createNodeFilesApi({ rootDir: dir }), ".git");
    expect(await files.createExclusive("index.lock", new TextEncoder().encode("ours"))).toBe(
      false,
    );
  });
});
