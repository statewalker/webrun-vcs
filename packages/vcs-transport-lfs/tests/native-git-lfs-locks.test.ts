import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, describe, expect, it } from "vitest";
import {
  basicUserIdentity,
  createFilesLfsStore,
  createFilesLockStore,
  type LfsLocksOptions,
  lfsLocks,
  serveLfs,
} from "../src/index.js";
import { serveOnLoopback } from "./node-server.js";

/**
 * The File Locking API against native git-lfs: `git lfs lock`, `locks`,
 * `locks --verify`, `unlock` (and `--force`), and the pre-push lock check
 * (`lfs.<url>.locksverify=true`), all against `serveLfs` with `locks` on a
 * loopback server. Two users, ada and bob, each with a home whose credential
 * helper answers their own name; the server takes the owner from the Basic
 * user name. Skipped without git-lfs locally; on CI the suite in
 * native-git-lfs.test.ts already fails when git-lfs is missing.
 */
const hasGitLfs = spawnSync("git", ["lfs", "version"]).status === 0;

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const close of closers) await close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "lfs-locks-"));
  dirs.push(d);
  return d;
}

/** A clean environment: its own HOME, fixed identities and dates, no proxy, no GIT_* from outside. */
function gitEnv(home: string, name: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(https?_proxy|all_proxy|no_proxy|GIT_)/i.test(k)) delete env[k];
  }
  const email = `${name}@example.com`;
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
}

interface Run {
  code: number;
  out: string;
  err: string;
}

/** Runs git without blocking the event loop (the server runs in this process). */
function run(env: NodeJS.ProcessEnv, cwd: string, args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code: code ?? -1,
        out: Buffer.concat(out).toString(),
        err: Buffer.concat(err).toString(),
      }),
    );
  });
}

async function git(env: NodeJS.ProcessEnv, cwd: string, args: string[]): Promise<string> {
  const r = await run(env, cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} (${r.code}): ${r.err}${r.out}`);
  return r.out;
}

/** A home for `name`: `git lfs install`, and a credential helper that answers `name`. */
async function user(name: string) {
  const home = tmp();
  const env = gitEnv(home, name);
  await git(env, home, ["lfs", "install", "--skip-repo"]);
  await git(env, home, [
    "config",
    "--global",
    "credential.helper",
    `!f() { echo username=${name}; echo password=${name}-pw; }; f`,
  ]);
  return { name, env };
}

interface Seen {
  method: string;
  path: string;
  query: string;
  body: string;
}

/** Each user's password is `<name>-pw` (what their credential helper answers). */
const knownBasic = (header: string | null) =>
  !!header && ["ada", "bob", "root"].some((u) => header === `Basic ${btoa(`${u}:${u}-pw`)}`);

async function startServer(locks: Partial<LfsLocksOptions> = {}) {
  const files = new MemFilesApi();
  const handler = serveLfs(createFilesLfsStore(files), {
    // authorize verifies the Basic password, so identify may trust the user name
    authorize: (request) => knownBasic(request.headers.get("authorization")),
    locks: { store: createFilesLockStore(files), identify: basicUserIdentity, ...locks },
  });
  const seen: Seen[] = [];
  const server = await serveOnLoopback(async (request) => {
    const url = new URL(request.url);
    if (url.pathname.includes("/locks")) {
      const body = request.method === "POST" ? await request.clone().text() : "";
      seen.push({ method: request.method, path: url.pathname, query: url.search, body });
    }
    return handler(request);
  });
  closers.push(server.close);
  return { url: `${server.origin}/repo.git/info/lfs`, seen };
}

/** A bare remote with one commit of LFS files, and a clone of it per user. */
async function setup(lfsUrl: string, users: { name: string; env: NodeJS.ProcessEnv }[]) {
  const d = tmp();
  const bare = join(d, "remote.git");
  const seed = join(d, "seed");
  const [first] = users;
  if (!first) throw new Error("no users");
  await git(first.env, d, ["init", "-q", "--bare", "-b", "main", bare]);
  await git(first.env, d, ["init", "-q", "-b", "main", seed]);
  await git(first.env, seed, ["lfs", "track", "*.bin"]);
  writeFileSync(join(seed, "a.bin"), "alpha\n");
  writeFileSync(join(seed, "b.bin"), "beta\n");
  writeFileSync(join(seed, ".lfsconfig"), `[lfs]\n\turl = ${lfsUrl}\n`);
  await git(first.env, seed, ["add", "-A"]);
  await git(first.env, seed, ["commit", "-q", "-m", "seed"]);
  await git(first.env, seed, ["remote", "add", "origin", bare]);
  await git(first.env, seed, [
    "-c",
    `lfs.${lfsUrl}.locksverify=false`,
    "push",
    "-q",
    "-u",
    "origin",
    "main",
  ]);
  const clones: Record<string, string> = {};
  for (const u of users) {
    const dir = join(d, u.name);
    await git(u.env, d, ["clone", "-q", bare, dir]);
    clones[u.name] = dir;
  }
  return clones;
}

/** `git lfs locks` lines as `[path, owner, id]`. */
function lockLines(text: string): string[][] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) =>
      line
        .split(/\t|\s{2,}/)
        .map((s) => s.trim())
        .filter(Boolean),
    );
}

// each test runs a dozen git-lfs processes: 30 s each, past vitest's 5 s default
describe.skipIf(!hasGitLfs)("native git-lfs locking against serveLfs", { timeout: 30_000 }, () => {
  it("lock, locks, conflict, locks --verify, unlock, unlock --force by an admin", async () => {
    const ada = await user("ada");
    const bob = await user("bob");
    const root = await user("root");
    const { url, seen } = await startServer({
      admin: (request) => basicUserIdentity(request) === "root",
    });
    const clones = await setup(url, [ada, bob, root]);
    const adaDir = clones.ada as string;
    const bobDir = clones.bob as string;
    const rootDir = clones.root as string;

    expect(await git(ada.env, adaDir, ["lfs", "lock", "a.bin"])).toMatch(/Locked a\.bin/);
    // what git-lfs sent: the path and the current branch's ref
    const created = seen.find((s) => s.method === "POST" && s.path.endsWith("/locks"));
    expect(JSON.parse(created?.body ?? "{}")).toEqual({
      path: "a.bin",
      ref: { name: "refs/heads/main" },
    });

    const listed = lockLines(await git(bob.env, bobDir, ["lfs", "locks"]));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.[0]).toBe("a.bin");
    expect(listed[0]?.[1]).toBe("ada");
    const id = (listed[0]?.[2] ?? "").replace(/^ID:/, "");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(
      seen.some((s) => s.method === "GET" && /refspec=refs%2Fheads%2Fmain/.test(s.query)),
    ).toBe(true);

    // bob cannot take it: git-lfs reports the 409
    const conflict = await run(bob.env, bobDir, ["lfs", "lock", "a.bin"]);
    expect(conflict.code).not.toBe(0);
    expect(conflict.err + conflict.out).toMatch(/already created lock|Lock exists/i);
    expect(await git(bob.env, bobDir, ["lfs", "lock", "b.bin"])).toMatch(/Locked b\.bin/);

    // --verify marks the caller's own locks with "O"
    const adaView = await git(ada.env, adaDir, ["lfs", "locks", "--verify"]);
    expect(adaView).toMatch(/^O a\.bin\s+ada/m);
    expect(adaView).toMatch(/^\s+b\.bin\s+bob/m);
    const bobView = await git(bob.env, bobDir, ["lfs", "locks", "--verify"]);
    expect(bobView).toMatch(/^O b\.bin\s+bob/m);
    expect(seen.some((s) => s.path.endsWith("/locks/verify"))).toBe(true);

    // bob may not unlock ada's lock, even with --force (he is no admin)
    const refused = await run(bob.env, bobDir, ["lfs", "unlock", "a.bin"]);
    expect(refused.code).not.toBe(0);
    // git-lfs prints the server's 403 message
    expect(refused.err + refused.out).toMatch(/owned by ada; unlocking it needs force/);
    const forced = await run(bob.env, bobDir, ["lfs", "unlock", "--force", "a.bin"]);
    expect(forced.code).not.toBe(0);
    expect(forced.err + forced.out).toMatch(/force-unlock|403|Forbidden/i);

    // ada unlocks her own by path, root force-unlocks bob's by id
    expect(await git(ada.env, adaDir, ["lfs", "unlock", "a.bin"])).toMatch(/Unlocked a\.bin/);
    const bobId = lockLines(await git(root.env, rootDir, ["lfs", "locks"]))[0]?.[2]?.replace(
      /^ID:/,
      "",
    );
    expect(
      await git(root.env, rootDir, ["lfs", "unlock", "--force", "--id", bobId as string]),
    ).toMatch(/Unlocked/);
    expect((await git(ada.env, adaDir, ["lfs", "locks"])).trim()).toBe("");

    // our client sees the same server state git-lfs left
    const ours = lfsLocks(url, undefined, {
      credentials: { username: "ada", password: "ada-pw" },
    });
    // a forged Basic header (the right name, a wrong password) is refused
    const forger = lfsLocks(url, undefined, { credentials: { username: "ada", password: "x" } });
    await expect(forger.createLock("forged.bin")).rejects.toMatchObject({ status: 403 });
    expect((await ours.listLocks()).locks).toEqual([]);
    const mine = await ours.createLock("a.bin", "refs/heads/main");
    const view = lockLines(await git(bob.env, bobDir, ["lfs", "locks"]));
    expect(view[0]).toEqual(["a.bin", "ada", `ID:${mine.id}`]);
  });

  it("pre-push with locksverify=true refuses a push of a file someone else locked", async () => {
    const ada = await user("ada");
    const bob = await user("bob");
    const { url } = await startServer();
    const clones = await setup(url, [ada, bob]);
    const adaDir = clones.ada as string;
    const bobDir = clones.bob as string;
    for (const [u, dir] of [
      [ada, adaDir],
      [bob, bobDir],
    ] as const)
      await git(u.env, dir, ["config", `lfs.${url}.locksverify`, "true"]);

    await git(ada.env, adaDir, ["lfs", "lock", "a.bin"]);

    // bob changes ada's locked file: his push is refused
    writeFileSync(join(bobDir, "a.bin"), "bob was here\n");
    await git(bob.env, bobDir, ["commit", "-q", "-am", "bob edits a"]);
    const refused = await run(bob.env, bobDir, ["push", "origin", "main"]);
    expect(refused.code).not.toBe(0);
    // git-lfs 3.4: "Unable to push locked files:\n* a.bin - ada (refs: main)" on stdout
    expect(refused.out + refused.err).toMatch(/Unable to push locked files/);
    expect(refused.out + refused.err).toMatch(/a\.bin - ada/);

    // ada's push of the file she locked goes through
    writeFileSync(join(adaDir, "a.bin"), "ada was here\n");
    await git(ada.env, adaDir, ["commit", "-q", "-am", "ada edits a"]);
    const pushed = await run(ada.env, adaDir, ["push", "origin", "main"]);
    expect(pushed.code, pushed.err).toBe(0);

    // once ada unlocks, bob's change to another file pushes (after he rebases)
    await git(ada.env, adaDir, ["lfs", "unlock", "a.bin"]);
    await git(bob.env, bobDir, ["reset", "-q", "--hard", "origin/main"]);
    await git(bob.env, bobDir, ["pull", "-q", "--ff-only", "origin", "main"]);
    writeFileSync(join(bobDir, "a.bin"), "bob again\n");
    await git(bob.env, bobDir, ["commit", "-q", "-am", "bob edits a again"]);
    const after = await run(bob.env, bobDir, ["push", "origin", "main"]);
    expect(after.code, after.err).toBe(0);
  });

  it("with locksverify unset, a server without locks only warns and the push goes through", async () => {
    const ada = await user("ada");
    const files = new MemFilesApi();
    const server = await serveOnLoopback(serveLfs(createFilesLfsStore(files)));
    closers.push(server.close);
    const url = `${server.origin}/repo.git/info/lfs`;
    const clones = await setup(url, [ada]);
    const dir = clones.ada as string;
    writeFileSync(join(dir, "a.bin"), "changed\n");
    await git(ada.env, dir, ["commit", "-q", "-am", "change"]);
    const pushed = await run(ada.env, dir, ["push", "origin", "main"]);
    expect(pushed.code, pushed.err).toBe(0);
    // and `git lfs locks` reports that the server has no locking
    const locks = await run(ada.env, dir, ["lfs", "locks"]);
    expect(locks.code).not.toBe(0);
  });
});
