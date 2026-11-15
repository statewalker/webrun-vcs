import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, describe, expect, it } from "vitest";
import {
  createFilesLfsStore,
  type LfsObjectStore,
  type LfsServerOptions,
  lfsDownload,
  parseLfsPointer,
  serveLfs,
} from "../src/index.js";
import { collect, drain, prng } from "./helpers.js";
import { serveOnLoopback } from "./node-server.js";
import { checkCases, smudgeCases } from "./pointer-cases.js";

/**
 * Interop with the native git-lfs binary (3.4 when this was written): `git
 * lfs push`, `pull` and `clone` against `serveLfs` on a loopback server, and
 * objects shared through `.git/lfs/objects` both ways. Skipped where git-lfs is
 * not installed locally; on CI (`process.env.CI` set) a missing git-lfs fails
 * instead, so the interop tests can never be skipped there unnoticed.
 */
const hasGitLfs = spawnSync("git", ["lfs", "version"]).status === 0;

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const close of closers) await close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "lfs-native-"));
  dirs.push(d);
  return d;
}

/** A clean environment: its own HOME (global config), fixed identities, no proxy for loopback. */
function gitEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(https?_proxy|all_proxy|GIT_)/i.test(k)) delete env[k];
  }
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
function git(
  env: NodeJS.ProcessEnv,
  cwd: string,
  args: string[],
  input?: string | Uint8Array,
): Promise<string> {
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
    child.stdin.end(input);
  });
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A home with `git lfs install` done (global filters and hooks). */
async function lfsHome(extraConfig = ""): Promise<{ home: string; env: NodeJS.ProcessEnv }> {
  const home = tmp();
  const env = gitEnv(home);
  await git(env, home, ["lfs", "install", "--skip-repo"]);
  if (extraConfig)
    writeFileSync(
      join(home, ".gitconfig"),
      `${readFileSync(join(home, ".gitconfig"), "utf8")}${extraConfig}`,
    );
  return { home, env };
}

async function startServer(store: LfsObjectStore, opts: LfsServerOptions = {}) {
  const server = await serveOnLoopback(serveLfs(store, opts));
  closers.push(server.close);
  return `${server.origin}/repo.git/info/lfs`;
}

/** A repository with LFS-tracked files and a bare remote; `.lfsconfig` points at `lfsUrl`. */
async function lfsRepo(env: NodeJS.ProcessEnv, lfsUrl: string) {
  const d = tmp();
  const bare = join(d, "remote.git");
  const work = join(d, "work");
  await git(env, d, ["init", "-q", "--bare", "-b", "main", bare]);
  await git(env, d, ["init", "-q", "-b", "main", work]);
  await git(env, work, ["config", "lfs.locksverify", "false"]);
  await git(env, work, ["lfs", "track", "*.bin"]);
  const files = {
    "a.bin": prng(300_000, 1),
    "b.bin": prng(1, 2),
    "c.bin": new TextEncoder().encode("hello lfs\n"),
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(work, name), bytes);
  writeFileSync(join(work, ".lfsconfig"), `[lfs]\n\turl = ${lfsUrl}\n\tlocksverify = false\n`);
  await git(env, work, ["add", "-A"]);
  await git(env, work, ["commit", "-q", "-m", "lfs files"]);
  await git(env, work, ["remote", "add", "origin", bare]);
  return { d, bare, work, files };
}

describe.runIf(!hasGitLfs && !!process.env.CI)("native git-lfs on CI", () => {
  it("git-lfs is installed", () => {
    expect(hasGitLfs, "git-lfs is required on CI for the interop tests").toBe(true);
  });
});

// each test spawns git and git-lfs several times: generous per-test time under a loaded CI
describe.skipIf(!hasGitLfs)("native git-lfs", { timeout: 60_000 }, () => {
  it("parsePointer agrees with the installed git-lfs on all 48 cases", async () => {
    const { env } = await lfsHome();
    const d = tmp();
    await git(env, d, ["init", "-q", "w"]);
    const w = join(d, "w");
    const content = new TextEncoder().encode("CONTENT\n");
    await git(env, w, ["lfs", "clean", "--", "c"], content);
    const wrong: string[] = [];
    for (const [text] of smudgeCases(sha(content))) {
      const r = spawnSync("git", ["lfs", "smudge"], { cwd: w, env, input: text });
      if ((r.stdout.toString() !== text) !== (parseLfsPointer(text) !== undefined))
        wrong.push(`smudge ${JSON.stringify(text.slice(0, 60))}`);
    }
    for (const [text] of checkCases()) {
      writeFileSync(join(d, "p"), text);
      const ok =
        spawnSync("git", ["lfs", "pointer", "--check", "--file=p"], { cwd: d, env }).status === 0;
      if (ok !== (parseLfsPointer(text) !== undefined))
        wrong.push(`check ${JSON.stringify(text.slice(0, 60))}`);
    }
    expect(wrong).toEqual([]);
  });

  it("git push (pre-push) and git lfs push store verified objects; git clone smudges them", async () => {
    const { env } = await lfsHome();
    const serverFiles = new MemFilesApi();
    const server = createFilesLfsStore(serverFiles);
    const url = await startServer(server);
    const { d, bare, work, files } = await lfsRepo(env, url);

    await git(env, work, ["push", "-q", "origin", "main"]);
    for (const bytes of Object.values(files))
      expect(await server.size(sha(bytes))).toBe(bytes.length);
    // an explicit `git lfs push` finds everything there already
    await git(env, work, ["lfs", "push", "origin", "main"]);

    await git(env, d, ["clone", "-q", bare, "clone"]);
    for (const [name, bytes] of Object.entries(files)) {
      const got = readFileSync(join(d, "clone", name));
      expect(Buffer.from(got).equals(Buffer.from(bytes)), name).toBe(true);
    }
    expect(await git(env, join(d, "clone"), ["lfs", "fsck"])).toContain("Git LFS fsck OK");
  });

  it("git lfs pull fetches into a clone made without smudging", async () => {
    const { env } = await lfsHome();
    const server = createFilesLfsStore(new MemFilesApi());
    const url = await startServer(server);
    const { d, bare, work, files } = await lfsRepo(env, url);
    await git(env, work, ["push", "-q", "origin", "main"]);

    await git({ ...env, GIT_LFS_SKIP_SMUDGE: "1" }, d, ["clone", "-q", bare, "lazy"]);
    const lazy = join(d, "lazy");
    expect(parseLfsPointer(readFileSync(join(lazy, "a.bin")))).toEqual({
      oid: sha(files["a.bin"]),
      size: files["a.bin"].length,
    });
    await git(env, lazy, ["lfs", "pull"]);
    for (const [name, bytes] of Object.entries(files)) {
      expect(Buffer.from(readFileSync(join(lazy, name))).equals(Buffer.from(bytes)), name).toBe(
        true,
      );
    }
  });

  it("with authorize: git-lfs answers the 401 with credentials and pushes and clones", async () => {
    const helper =
      '\n[credential]\n\thelper = "!f() { echo username=ada; echo password=secret; }; f"\n';
    const { env } = await lfsHome(helper);
    const server = createFilesLfsStore(new MemFilesApi());
    const basic = `Basic ${btoa("ada:secret")}`;
    const url = await startServer(server, {
      authorize: (request) => request.headers.get("authorization") === basic,
    });
    const { d, bare, work, files } = await lfsRepo(env, url);
    await git(env, work, ["push", "-q", "origin", "main"]);
    for (const bytes of Object.values(files))
      expect(await server.size(sha(bytes))).toBe(bytes.length);
    await git(env, d, ["clone", "-q", bare, "clone"]);
    expect(
      Buffer.from(readFileSync(join(d, "clone", "a.bin"))).equals(Buffer.from(files["a.bin"])),
    ).toBe(true);
  });

  it("our client downloads what native git-lfs pushed, into the clone's .git/lfs/objects", async () => {
    const { env } = await lfsHome();
    const server = createFilesLfsStore(new MemFilesApi());
    const url = await startServer(server);
    const { d, bare, work, files } = await lfsRepo(env, url);
    await git(env, work, ["push", "-q", "origin", "main"]);
    await git({ ...env, GIT_LFS_SKIP_SMUDGE: "1" }, d, ["clone", "-q", bare, "ours"]);
    const ours = join(d, "ours");
    const store = createFilesLfsStore(createNodeFilesApi({ rootDir: ours }), ".git");
    const pointers = Object.values(files).map((b) => ({ oid: sha(b), size: b.length }));
    const events = await drain(lfsDownload(store, url, pointers));
    expect(events.filter((e) => e.type === "object-downloaded")).toHaveLength(3);
    // native git-lfs finds them: checkout replaces the pointers, fsck is clean
    await git(env, ours, ["lfs", "checkout"]);
    for (const [name, bytes] of Object.entries(files)) {
      expect(Buffer.from(readFileSync(join(ours, name))).equals(Buffer.from(bytes)), name).toBe(
        true,
      );
    }
    expect(await git(env, ours, ["lfs", "fsck"])).toContain("Git LFS fsck OK");
  });

  it("objects native git-lfs stored in .git/lfs/objects are read by our store", async () => {
    const { env } = await lfsHome();
    const d = tmp();
    const w = join(d, "w");
    mkdirSync(w);
    await git(env, w, ["init", "-q", "-b", "main"]);
    const bytes = prng(123_456, 9);
    const pointer = parseLfsPointer(await git(env, w, ["lfs", "clean", "--", "x.bin"], bytes));
    expect(pointer).toEqual({ oid: sha(bytes), size: bytes.length });
    const store = createFilesLfsStore(createNodeFilesApi({ rootDir: w }), ".git");
    expect(await store.size(sha(bytes))).toBe(bytes.length);
    const read = await collect(store.read(sha(bytes)));
    expect(Buffer.from(read).equals(Buffer.from(bytes))).toBe(true);
  });
});
