/**
 * `createNodeHookRunner().start`: a hook talked to while it runs (receive-pack's
 * proc-receive): its stderr streamed as it comes (git's copy_to_sideband), and `kill` for a
 * hook receive-pack gave up on.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeHookRunner } from "../src/files/index.js";

const describeUnix = process.platform === "win32" ? describe.skip : describe;

describeUnix("createNodeHookRunner().start", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hook-start-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function script(body: string): Promise<string> {
    const path = join(dir, "hook");
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  const invocation = (path: string) => ({
    name: "proc-receive",
    path,
    args: [],
    env: {},
    cwd: dir,
    hostCwd: dir,
    stdoutToStderr: false,
  });

  it("streams stderr before the hook exits; the outcome keeps none", async () => {
    const path = await script('printf "first\\n" >&2; read line; printf "second\\n" >&2');
    const chunks: string[] = [];
    let firstSeen: () => void = () => {};
    const seen = new Promise<void>((resolve) => {
      firstSeen = resolve;
    });
    const process = await createNodeHookRunner().start(invocation(path), {
      onStderr: (chunk) => {
        chunks.push(new TextDecoder().decode(chunk));
        firstSeen();
      },
    });
    if (!process) throw new Error("not started");
    // the hook waits for its stdin: what it wrote so far arrives meanwhile
    await seen;
    expect(chunks.join("")).toBe("first\n");
    await process.write(new TextEncoder().encode("go\n"));
    await process.closeStdin();
    const outcome = await process.wait();
    expect(outcome.exitCode).toBe(0);
    expect(chunks.join("")).toBe("first\nsecond\n");
    expect(outcome.stderr.length).toBe(0);
  });

  it("kill stops a hung hook", async () => {
    // a child of the script holds the pipes open too
    const path = await script("sleep 30; true");
    const process = await createNodeHookRunner().start(invocation(path));
    if (!process) throw new Error("not started");
    process.kill();
    const outcome = await process.wait();
    // 128 + SIGTERM
    expect(outcome.exitCode).toBe(143);
  });
});
