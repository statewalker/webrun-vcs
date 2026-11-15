/**
 * Started by lifecycle.test.ts in a child process: starts Gitea, prints its
 * work directory and process group, then waits to be ended by a signal
 * without ever calling `stop()`.
 */
import { startGitea } from "../../src/index.js";

const gitea = await startGitea();
process.stdout.write(`${JSON.stringify({ workDir: gitea.workDir, pid: gitea.pid })}\n`);
setInterval(() => {}, 1000);
