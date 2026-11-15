import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { type GiteaServer, startGitea } from "../src/index.js";
import { describeGitea } from "./helpers.js";

/** Whether any process of the group `pid` is still alive. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

/**
 * The helper's own guarantees against a real Gitea: instances started side by
 * side cannot be mistaken for each other, work directories are private, and a
 * process ended by a signal leaves no Gitea and no work directory behind.
 */
describeGitea("Gitea oracle · lifecycle", () => {
  const started: GiteaServer[] = [];
  afterAll(async () => {
    for (const g of started) await g.stop();
  });

  it("instances started together are separate: own port, own password, private work directory", async () => {
    const [a, b] = await Promise.all([startGitea(), startGitea()]);
    started.push(a, b);
    expect(a.baseUrl).not.toBe(b.baseUrl);
    expect(a.password).not.toBe(b.password);
    for (const [g, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const mine = await fetch(`${g.baseUrl}/api/v1/user`, {
        headers: { authorization: g.authorization },
      });
      expect(mine.status).toBe(200);
      await mine.body?.cancel();
      const theirs = await fetch(`${g.baseUrl}/api/v1/user`, {
        headers: { authorization: other.authorization },
      });
      expect(theirs.status).toBe(401);
      await theirs.body?.cancel();
      expect(statSync(g.workDir).mode & 0o077).toBe(0);
      expect(statSync(join(g.workDir, "custom", "conf", "app.ini")).mode & 0o077).toBe(0);
    }
  });

  it("a start on a port another Gitea holds is never mistaken for it, and retries on a free port", async () => {
    const a = await startGitea();
    started.push(a);
    const port = Number(new URL(a.baseUrl).port);
    await expect(startGitea({ port, attempts: 1 })).rejects.toThrow(
      /gitea exited|another server answers/,
    );
    const b = await startGitea({ port });
    started.push(b);
    expect(b.baseUrl).not.toBe(a.baseUrl);
    const me = await fetch(`${b.baseUrl}/api/v1/user`, {
      headers: { authorization: b.authorization },
    });
    expect(me.status).toBe(200);
    await me.body?.cancel();
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`a process ended by ${signal} takes its Gitea and work directory with it`, async () => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", join(import.meta.dirname, "fixtures", "start-and-wait.ts")],
        { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      child.stderr.on("data", (c: Buffer) => {
        err += c.toString();
      });
      const exited = new Promise<NodeJS.Signals | null>((r) =>
        child.once("exit", (_code, sig) => r(sig)),
      );
      const info = await new Promise<{ workDir: string; pid: number }>((resolve, reject) => {
        child.stdout.on("data", (c: Buffer) => {
          out += c.toString();
          const line = out.split("\n")[0];
          if (out.includes("\n") && line) resolve(JSON.parse(line));
        });
        child.once("exit", (code) => reject(new Error(`child exited (${code}): ${err}`)));
      });
      expect(existsSync(info.workDir)).toBe(true);
      expect(groupAlive(info.pid)).toBe(true);

      child.kill(signal);
      expect(await exited).toBe(signal);
      expect(await waitFor(() => !groupAlive(info.pid), 5000)).toBe(true);
      expect(existsSync(info.workDir)).toBe(false);
    });
  }
});
