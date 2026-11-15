import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPeer } from "@statewalker/httpeers-core";
import { createFilesLfsStore } from "@statewalker/vcs-transport-lfs";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, describe, expect, it } from "vitest";
import { meshLfsHandler } from "../src/index.js";
import { createHub, prng } from "./helpers.js";
import { serveOnLoopback } from "./node-server.js";

/**
 * Native git-lfs against the mesh LFS handler: it offers only `basic` and gets it, sends the
 * membership token through `http.extraHeader`, and pushes and clones through the access checks.
 * The loopback edge plays the transport: it binds every request to the peer it "proved".
 */
const hasGitLfs = spawnSync("git", ["lfs", "version"]).status === 0;

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const close of closers) await close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mesh-lfs-native-"));
  dirs.push(d);
  return d;
}

/** Its own HOME, fixed identities and dates, no proxy for loopback. */
function gitEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^(https?_proxy|all_proxy|GIT_)/i.test(k)) delete env[k];
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Ada",
    GIT_AUTHOR_EMAIL: "ada@example.com",
    GIT_COMMITTER_NAME: "Ada",
    GIT_COMMITTER_EMAIL: "ada@example.com",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
}

/** Runs git without blocking the event loop (the server runs in this process). */
function git(env: NodeJS.ProcessEnv, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out).toString())
        : reject(new Error(`git ${args.join(" ")} (${code}): ${Buffer.concat(err).toString()}`)),
    );
    // git may exit before reading stdin; an EPIPE here must not become an uncaught error
    child.stdin.on("error", () => {});
    child.stdin.end();
  });
}

/** A HOME with `git lfs install` done and the token sent with every HTTP request. */
async function home(token: string): Promise<NodeJS.ProcessEnv> {
  const h = tmp();
  const env = gitEnv(h);
  await git(env, h, ["lfs", "install", "--skip-repo"]);
  writeFileSync(
    join(h, ".gitconfig"),
    `${readFileSync(join(h, ".gitconfig"), "utf8")}[http]\n\textraHeader = x-httpeers-token: ${token}\n`,
  );
  return env;
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe.runIf(!hasGitLfs && !!process.env.CI)("native git-lfs on CI", () => {
  it("git-lfs is installed", () => {
    expect(hasGitLfs, "git-lfs is required on CI for the interop tests").toBe(true);
  });
});

describe.skipIf(!hasGitLfs)("native git-lfs against meshLfsHandler", { timeout: 60_000 }, () => {
  it("pushes with an admin token, clones with a member token, refuses a reader's push", async () => {
    const hub = await createHub();
    const server = createFilesLfsStore(new MemFilesApi());
    const handler = meshLfsHandler({
      objects: server,
      access: { issuer: hub.issuer, now: hub.now },
    });
    const transfers: string[] = [];
    // the loopback edge: the peer it proved is named by the URL's first path segment
    const edge = await serveOnLoopback(async (request) => {
      const peer = new URL(request.url).pathname.split("/")[1] as string;
      registerPeer(request, peer);
      const response = await handler(request);
      if (request.url.endsWith("/objects/batch") && response.ok) {
        const answer = (await response.clone().json()) as { transfer?: string };
        transfers.push(answer.transfer ?? "");
      }
      return response;
    });
    closers.push(edge.close);
    const urlFor = (peer: string) => `${edge.origin}/${peer}/repo.git/info/lfs`;

    const d = tmp();
    const bare = join(d, "remote.git");
    const work = join(d, "work");
    const admin = await home(await hub.token("T", ["admin"]));
    await git(admin, d, ["init", "-q", "--bare", "-b", "main", bare]);
    await git(admin, d, ["init", "-q", "-b", "main", work]);
    await git(admin, work, ["lfs", "track", "*.bin"]);
    const files = { "a.bin": prng(300_000, 1), "b.bin": new TextEncoder().encode("hello lfs\n") };
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(work, name), bytes);
    writeFileSync(
      join(work, ".lfsconfig"),
      `[lfs]\n\turl = ${urlFor("T")}\n\tlocksverify = false\n`,
    );
    await git(admin, work, ["add", "-A"]);
    await git(admin, work, ["commit", "-q", "-m", "lfs files"]);
    await git(admin, work, ["remote", "add", "origin", bare]);
    await git(admin, work, ["push", "-q", "origin", "main"]);
    for (const bytes of Object.values(files))
      expect(await server.size(sha(bytes))).toBe(bytes.length);

    // a member clones (its edge proves "R"); git-lfs offered basic and got it
    const reader = await home(await hub.token("R", ["member"]));
    await git(reader, d, ["-c", `lfs.url=${urlFor("R")}`, "clone", "-q", bare, "clone"]);
    for (const [name, bytes] of Object.entries(files)) {
      const got = readFileSync(join(d, "clone", name));
      expect(Buffer.from(got).equals(Buffer.from(bytes)), name).toBe(true);
    }
    expect(transfers.length).toBeGreaterThan(0);
    expect(new Set(transfers)).toEqual(new Set(["basic"]));

    // the reader's upload is refused
    const clone = join(d, "clone");
    await git(reader, clone, ["config", "lfs.url", urlFor("R")]);
    writeFileSync(join(clone, "c.bin"), prng(1000, 3));
    await git(reader, clone, ["add", "-A"]);
    await git(reader, clone, ["commit", "-q", "-m", "more"]);
    await expect(git(reader, clone, ["lfs", "push", "origin", "main"])).rejects.toThrow();
    expect(await server.size(sha(readFileSync(join(clone, "c.bin"))))).toBeUndefined();
  });
});
