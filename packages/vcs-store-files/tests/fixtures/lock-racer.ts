/**
 * A child process for `cross-process-locks.test.ts`: opens its own Node FilesApi over the
 * git directory given as argv[2], prints "ready", waits for "go" on stdin, then tries to
 * take every lock named in argv[3..] through `atomicFilesOver(...).createExclusive`, and
 * prints a JSON object mapping each lock to whether this process took it.
 *
 * Run with `node --conditions=source --import tsx`, so the workspace packages load from src.
 */
import { createInterface } from "node:readline";
import { atomicFilesOver } from "@statewalker/vcs-utils/files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";

const [gitDir, ...locks] = process.argv.slice(2);
const files = atomicFilesOver(createNodeFilesApi({ rootDir: gitDir }), "");
const label = `pid ${process.pid}`;
const enc = new TextEncoder();

const lines = createInterface({ input: process.stdin });
process.stdout.write("ready\n");
for await (const line of lines) {
  if (line.trim() !== "go") continue;
  const results = await Promise.all(locks.map((lock) => files.createExclusive(lock, enc.encode(label))));
  process.stdout.write(`${JSON.stringify(Object.fromEntries(locks.map((l, i) => [l, results[i]])))}\n`);
  break;
}
lines.close();
