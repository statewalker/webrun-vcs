/**
 * Shared pieces of the oracle tests: the GITEA=1 gate, native git with a clean
 * environment, and an in-memory repository of ours wired for the transport.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryHistoryWithOperations,
  type HistoryWithOperations,
} from "@statewalker/vcs-core";
import {
  createRepositoryFacade,
  createTransportRefStore,
  type RefStore,
  type RepositoryFacade,
} from "@statewalker/vcs-transport";
import { describe, expect, it } from "vitest";
import { giteaOracleEnabled, redactCredentials } from "../src/index.js";

/**
 * The oracle's `describe`: skipped unless GITEA=1. With GITEA=1 a Gitea that
 * cannot be obtained or started fails the suite in `beforeAll`.
 */
export const describeGitea = giteaOracleEnabled() ? describe : describe.skip;

/** With GITEA=1, native git and git-lfs are required: their absence fails, not skips. */
export function requireNativeTools() {
  it("native git and git-lfs are installed", () => {
    expect(spawnSync("git", ["--version"]).status, "git is required").toBe(0);
    expect(spawnSync("git", ["lfs", "version"]).status, "git-lfs is required").toBe(0);
  });
}

export function tempDirs() {
  const dirs: string[] = [];
  return {
    make(prefix = "gitea-oracle-"): string {
      const d = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(d);
      return d;
    },
    cleanup() {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    },
  };
}

/** A clean environment for native git: its own HOME, fixed identities and dates, no proxy for 127.0.0.1. */
export function nativeGitEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(https?_proxy|all_proxy|no_proxy|GIT_|GITEA)/i.test(k)) delete env[k];
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

/** git-lfs's filters, given per command so no global `git lfs install` is needed. */
export const LFS_FLAGS = [
  "-c",
  "filter.lfs.clean=git-lfs clean -- %f",
  "-c",
  "filter.lfs.smudge=git-lfs smudge -- %f",
  "-c",
  "filter.lfs.process=git-lfs filter-process",
  "-c",
  "filter.lfs.required=true",
  "-c",
  "lfs.locksverify=false",
  "-c",
  "init.defaultBranch=main",
];

/**
 * Native git (with the LFS filters). Gitea is another process, so a
 * synchronous call does not hold up the server.
 */
export function nativeGit(env: NodeJS.ProcessEnv, cwd: string, args: string[]): string {
  try {
    return execFileSync("git", [...LFS_FLAGS, ...args], {
      cwd,
      env,
      maxBuffer: 1 << 30,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  } catch (e) {
    const err = e as Error & { stderr?: Buffer };
    throw new Error(
      redactCredentials(`git ${args.join(" ")}: ${err.message}\n${err.stderr?.toString() ?? ""}`),
    );
  }
}

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Deterministic incompressible bytes. */
export function noise(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed * 2654435761 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** Two byte arrays equal (a loop: `toEqual` on large arrays is slow). */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
    Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  );
}

export interface OurRepo {
  history: HistoryWithOperations;
  facade: RepositoryFacade;
  refStore: RefStore;
  close(): Promise<void>;
}

/** An empty in-memory repository of ours (SHA-1, git-compatible objects) with the transport's views. */
export async function ourRepo(): Promise<OurRepo> {
  const history = createMemoryHistoryWithOperations();
  await history.initialize();
  return {
    history,
    facade: createRepositoryFacade({ history }),
    refStore: createTransportRefStore(history.refs),
    close: () => history.close(),
  };
}

const ident = (timestamp: number) => ({
  name: "Ada",
  email: "ada@example.com",
  timestamp,
  tzOffset: "+0000",
});

/** A commit of flat `files` on `refs/heads/main` (its parent: the current tip); its id. */
export async function commitFiles(
  repo: OurRepo,
  message: string,
  files: Record<string, string | Uint8Array>,
): Promise<string> {
  const enc = new TextEncoder();
  const entries = [];
  for (const [name, content] of Object.entries(files)) {
    const bytes = typeof content === "string" ? enc.encode(content) : content;
    entries.push({ name, mode: 0o100644, id: await repo.history.blobs.store([bytes]) });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const tree = await repo.history.trees.store(entries);
  const parent = await repo.refStore.get("refs/heads/main");
  const parents = parent ? [parent] : [];
  const id = await repo.history.commits.store({
    tree,
    parents,
    author: ident(1767225600 + parents.length),
    committer: ident(1767225600 + parents.length),
    message: `${message}\n`,
  });
  await repo.refStore.update("refs/heads/main", id);
  return id;
}

/** Every commit reachable from `tip` in our repository, sorted. */
export async function ourCommits(repo: OurRepo, tip: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const id of repo.history.commits.walkAncestry(tip)) ids.push(id);
  return ids.sort();
}

/** Every commit reachable from `rev` in a native repository, sorted. */
export function nativeCommits(env: NodeJS.ProcessEnv, cwd: string, rev = "HEAD"): string[] {
  return nativeGit(env, cwd, ["rev-list", rev]).trim().split("\n").sort();
}

/** The events of a transfer, collected. */
export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of it) out.push(e);
  return out;
}
