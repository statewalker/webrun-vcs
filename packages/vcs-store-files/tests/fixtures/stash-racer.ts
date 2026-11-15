/**
 * A child process for `ref-locks-cross-process.test.ts`: opens its own git-files backend
 * (Node FilesApi, `createExclusive` = `open "wx"`) over the repository given as argv[2],
 * prints "ready", waits for "go" on stdin, then runs `count` stash operations through
 * GitStashStore, retrying each one refused by a held lock, and prints a JSON summary.
 *
 * argv: <repoDir> <mode: push|drop> <count> <label> <headId> <treeId>
 * - push: `push("<label>-<i>")`
 * - drop: `drop(1)` (stash@{1}), waiting while fewer than two entries exist
 *
 * Run with `node --conditions=source --import tsx`, so the workspace packages load from src.
 */
import { createInterface } from "node:readline";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import type { Staging, Worktree } from "@statewalker/vcs-working-tree";
import { createGitFilesBackend, GitStashStore } from "../../src/index.js";

const [repoDir, mode, countArg, label, headId, treeId] = process.argv.slice(2);
const count = Number(countArg);
const { history } = await createGitFilesBackend({
  files: createNodeFilesApi({ rootDir: repoDir }),
  gitDir: ".git",
});
// The index is the given tree; the worktree adds nothing to it.
const staging = {
  writeTree: async () => treeId,
  entries: async function* () {},
} as unknown as Staging;
const worktree = {
  getEntry: async () => undefined,
  walk: async function* () {},
} as unknown as Worktree;
const stash = new GitStashStore({
  history,
  staging,
  worktree,
  getHead: async () => headId,
  getBranch: async () => "main",
  author: { name: "Racer", email: "racer@example.com", tzOffset: "+0000" },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isLocked = (e: unknown) => (e as { code?: string })?.code === "ELOCKED";

async function entries(): Promise<number> {
  let n = 0;
  for await (const _ of stash.list()) n++;
  return n;
}

const lines = createInterface({ input: process.stdin });
process.stdout.write("ready\n");
for await (const line of lines) {
  if (line.trim() !== "go") continue;
  let done = 0;
  let retries = 0;
  for (let i = 0; i < count; ) {
    try {
      if (mode === "push") {
        await stash.push(`${label}-${i}`);
      } else {
        if ((await entries()) < 2) {
          await sleep(5);
          continue;
        }
        await stash.drop(1);
      }
      done++;
      i++;
    } catch (error) {
      // refused by a held lock, or (drop) the entry went meanwhile: nothing changed, retry
      const gone = (error as Error)?.message?.includes("does not exist");
      if (!isLocked(error) && !gone) throw error;
      retries++;
      await sleep(Math.random() * 10);
    }
  }
  process.stdout.write(`${JSON.stringify({ done, retries })}\n`);
  break;
}
lines.close();
