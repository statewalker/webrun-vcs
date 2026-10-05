/**
 * Real-git interop test helpers.
 *
 * These helpers bridge the transport's `Duplex` abstraction to a spawned
 * real `git upload-pack` / `git receive-pack` subprocess, and build a
 * transport-side repository (facade + refStore) backed by real vcs-core
 * in-memory history (SHA-1 git-compatible objects).
 *
 * Test-only code: `node:child_process`, `node:fs`, `node:os` are allowed
 * here (the FilesApi-only rule is production-only).
 */

import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMemoryHistoryWithOperations,
  type HistoryWithOperations,
  type Ref,
  type Refs,
  type SymbolicRef,
} from "@statewalker/vcs-core";
import {
  createRepositoryFacade,
  type Duplex,
  type PackImportResult,
  type RepositoryFacade,
  type RefStore as TransportRefStore,
} from "../../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// git binary detection + invocation
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true if the real `git` binary is available. */
export function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Deterministic identity + dates so fixture oids are reproducible. */
const DETERMINISTIC_ENV = {
  GIT_AUTHOR_NAME: "Interop Tester",
  GIT_AUTHOR_EMAIL: "interop@example.com",
  GIT_COMMITTER_NAME: "Interop Tester",
  GIT_COMMITTER_EMAIL: "interop@example.com",
  GIT_AUTHOR_DATE: "1112911993 +0000",
  GIT_COMMITTER_DATE: "1112911993 +0000",
  // Keep global/user config out of the fixtures.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
} as const;

/** Run a git command synchronously in `cwd`, returning trimmed stdout. */
export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...DETERMINISTIC_ENV },
  }).trim();
}

/** Create a throwaway tmp directory; caller cleans up via {@link cleanupDir}. */
export function makeTmpDir(prefix = "vcs-interop-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Remove a tmp directory tree, ignoring errors. */
export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture repositories built with the real git binary
// ─────────────────────────────────────────────────────────────────────────────

export interface Fixture {
  /** Absolute path of the working (non-bare) repo. */
  dir: string;
  /** Root tmp dir to clean up. */
  root: string;
  /** Commit oid of the first commit (c1). */
  c1: string;
  /** Commit oid of the second commit (c2, tip of main + feature). */
  c2: string;
  /** Annotated tag object oid (refs/tags/v1). */
  tag: string;
}

/**
 * Build a small deterministic fixture repo with the real git binary:
 *   - main:    c1 → c2   (two commits, each adds a file)
 *   - feature: c2        (branch at tip)
 *   - v1:      annotated tag pointing at c2
 */
export function makeFixtureRepo(): Fixture {
  const root = makeTmpDir();
  const dir = join(root, "repo");
  git(root, ["init", "-q", "--initial-branch=main", "repo"]);
  writeAndCommit(dir, "a.txt", "hello\n", "c1");
  const c1 = git(dir, ["rev-parse", "HEAD"]);
  writeAndCommit(dir, "b.txt", "world\n", "c2");
  const c2 = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["tag", "-a", "v1", "-m", "tag one"]);
  const tag = git(dir, ["rev-parse", "refs/tags/v1"]);
  git(dir, ["branch", "feature"]);
  return { dir, root, c1, c2, tag };
}

function writeAndCommit(dir: string, file: string, content: string, message: string): void {
  writeFileSync(join(dir, file), content);
  git(dir, ["add", file]);
  git(dir, ["commit", "-q", "-m", message]);
}

/**
 * Build a repo containing ONLY the first commit (c1) of {@link makeFixtureRepo},
 * under a fresh tmp root. Because commit identity + dates are deterministic, its
 * `main` tip oid is byte-identical to the fixture's `c1` — so a client cloned
 * from it can act as a "have c1" peer for incremental-fetch negotiation.
 */
export function makeC1OnlyRepo(): { dir: string; root: string; c1: string } {
  const root = makeTmpDir("vcs-interop-old-");
  const dir = join(root, "old");
  git(root, ["init", "-q", "--initial-branch=main", "old"]);
  writeAndCommit(dir, "a.txt", "hello\n", "c1");
  const c1 = git(dir, ["rev-parse", "HEAD"]);
  return { dir, root, c1 };
}

/** Create a bare repo with the real git binary; returns its path. */
export function makeBareRepo(root: string, name = "bare.git"): string {
  git(root, ["init", "-q", "--bare", "--initial-branch=main", name]);
  return join(root, name);
}

// ─────────────────────────────────────────────────────────────────────────────
// Duplex over a spawned git subprocess (stdio pkt-line, protocol v1)
// ─────────────────────────────────────────────────────────────────────────────

export interface GitProcessDuplex extends Duplex {
  close(): Promise<void>;
  /** stderr text captured from the child (diagnostics). */
  stderr(): string;
  /** Resolves when the child process exits, with its exit code. */
  exited(): Promise<number | null>;
}

/**
 * Adapt a spawned `git upload-pack`/`git receive-pack` child into a Duplex:
 *   - the async-iterator yields the child's stdout chunks,
 *   - write(data) pushes to the child's stdin,
 *   - close() ends stdin.
 *
 * A single shared queue backs the iterator (mirrors createMessagePortDuplex),
 * so a second `[Symbol.asyncIterator]()` call does not lose buffered data.
 */
export function gitProcessDuplex(child: ChildProcessWithoutNullStreams): GitProcessDuplex {
  const queue: Uint8Array[] = [];
  let resolveNext: ((chunk: Uint8Array) => void) | null = null;
  let closed = false;
  let stderrText = "";

  const exitPromise = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  child.stdout.on("data", (chunk: Buffer) => {
    const data = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (resolveNext) {
      resolveNext(data);
      resolveNext = null;
    } else {
      queue.push(data);
    }
  });
  const signalEnd = () => {
    closed = true;
    if (resolveNext) {
      resolveNext(new Uint8Array(0));
      resolveNext = null;
    }
  };
  child.stdout.on("end", signalEnd);
  child.stdout.on("close", signalEnd);
  child.stderr.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString("utf8");
  });

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      while (true) {
        if (queue.length > 0) {
          const chunk = queue.shift();
          if (chunk && chunk.length > 0) yield chunk;
          continue;
        }
        if (closed) return;
        const chunk = await new Promise<Uint8Array>((resolve) => {
          resolveNext = resolve;
        });
        if (chunk.length === 0 && closed) return;
        if (chunk.length > 0) yield chunk;
      }
    },
    write(data: Uint8Array): void {
      if (!child.stdin.destroyed) {
        child.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      }
    },
    async close(): Promise<void> {
      if (!child.stdin.destroyed) child.stdin.end();
    },
    stderr: () => stderrText,
    exited: () => exitPromise,
  };
}

/** Spawn `git <service> <repoPath>` and wrap it as a Duplex. */
export function spawnGitService(
  service: "upload-pack" | "receive-pack",
  repoPath: string,
  extraEnv: Record<string, string> = {},
): GitProcessDuplex {
  const child = spawn("git", [service, repoPath], {
    env: { ...process.env, ...DETERMINISTIC_ENV, ...extraEnv },
  }) as ChildProcessWithoutNullStreams;
  return gitProcessDuplex(child);
}

/**
 * Spawn `git <service> <repoPath>` speaking Git **protocol v2** (via the
 * `GIT_PROTOCOL=version=2` environment handshake) and wrap it as a Duplex.
 * On connect the server writes the v2 capability advertisement
 * (`version 2`, `agent=…`, `ls-refs=…`, `fetch=…`, `object-format=sha1`,
 * flush) and then accepts command-based requests.
 */
export function spawnGitServiceV2(
  service: "upload-pack" | "receive-pack",
  repoPath: string,
): GitProcessDuplex {
  return spawnGitService(service, repoPath, { GIT_PROTOCOL: "version=2" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport-side repository (real vcs-core in-memory history)
// ─────────────────────────────────────────────────────────────────────────────

export interface TransportRepo {
  history: HistoryWithOperations;
  facade: RepositoryFacade;
  refStore: TransportRefStore;
  /**
   * Import results captured from every `importPack` the facade performed, in
   * order. Lets tests assert real object-transfer counts (the `FetchResult`
   * does not currently surface `objectsImported` — see fetch-over-duplex).
   */
  imports: PackImportResult[];
  close: () => Promise<void>;
}

/** Build a fresh transport-side repository backed by in-memory vcs-core. */
export async function createTransportRepo(): Promise<TransportRepo> {
  const history = createMemoryHistoryWithOperations();
  await history.initialize();
  const facade = createRepositoryFacade({ history });
  const imports: PackImportResult[] = [];
  const baseImportPack = facade.importPack.bind(facade);
  facade.importPack = async (packStream) => {
    const result = await baseImportPack(packStream);
    imports.push(result);
    return result;
  };
  return {
    history,
    facade,
    refStore: createTransportRefStore(history.refs),
    imports,
    close: () => history.close(),
  };
}

/** Deterministic author/committer for transport-side commits. */
function interopIdent() {
  return {
    name: "Interop Tester",
    email: "interop@example.com",
    timestamp: 1112911993,
    tzOffset: "+0000",
  };
}

/**
 * Build a commit in a transport-side (vcs-core) repository from a flat set of
 * files and return its git oid. Objects are SHA-1 git-compatible, so real git
 * accepts them verbatim when pushed.
 */
export async function commitInRepo(
  repo: TransportRepo,
  message: string,
  files: Record<string, string>,
  parents: string[] = [],
): Promise<string> {
  const encoder = new TextEncoder();
  const entries = [];
  for (const [name, content] of Object.entries(files)) {
    const id = await repo.history.blobs.store([encoder.encode(content)]);
    entries.push({ name, mode: 0o100644, id });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const tree = await repo.history.trees.store(entries);
  return repo.history.commits.store({
    tree,
    parents,
    author: interopIdent(),
    committer: interopIdent(),
    message: `${message}\n`,
  });
}

function isSymbolicRef(ref: Ref | SymbolicRef): ref is SymbolicRef {
  return "target" in ref;
}

/** Adapt a core `Refs` into the transport-layer `RefStore` interface. */
export function createTransportRefStore(coreRefs: Refs): TransportRefStore {
  return {
    async get(name: string): Promise<string | undefined> {
      const ref = await coreRefs.resolve(name);
      return ref?.objectId;
    },
    async update(name: string, oid: string): Promise<void> {
      await coreRefs.set(name, oid);
    },
    async listAll(): Promise<Iterable<[string, string]>> {
      const refs: Array<[string, string]> = [];
      for await (const ref of coreRefs.list()) {
        if (isSymbolicRef(ref)) {
          const resolved = await coreRefs.resolve(ref.name);
          if (resolved?.objectId) refs.push([ref.name, resolved.objectId]);
        } else if (ref.objectId) {
          refs.push([ref.name, ref.objectId]);
        }
      }
      return refs;
    },
    async getSymrefTarget(name: string): Promise<string | undefined> {
      const ref = await coreRefs.get(name);
      if (ref && isSymbolicRef(ref)) return ref.target;
      return undefined;
    },
    async isRefTip(oid: string): Promise<boolean> {
      for await (const ref of coreRefs.list()) {
        if (!isSymbolicRef(ref) && ref.objectId === oid) return true;
      }
      return false;
    },
  };
}
