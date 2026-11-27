/**
 * Twins of receive-pack pushes (`receive-limits-native.test.ts`,
 * `receive-report-git3-native.test.ts`): native git pushes a source to a path (native
 * receive-pack) beside native git to our git:// server and our client to a path (our
 * receive-pack in process), with helpers comparing their outcomes and what the targets hold.
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBasePathResolver, serveGitConnection } from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe } from "vitest";

import { openLocalRemote, remoteHookSession } from "../src/commands/local-transport.js";
import { type Git, type PushResult, servedRepositoryOf } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync, startTcpServer } from "./native-connect-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { nativeGit3Env } from "./native-git3.js";
import { gitOut, putFile, testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

export const describeGit =
  nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

/** Whether the native git is 2.5x (its hooks' behaviour), else 2.43. */
export const nativeIs25x = (() => {
  try {
    const v = /git version (\d+)\.(\d+)/.exec(gitOut(tmpdir(), tmpdir(), ["--version"]));
    return v ? Number(v[1]) > 2 || Number(v[2]) >= 50 : false;
  } catch {
    return false;
  }
})();

let root: string;

/** The scratch directory of the file's twins. */
export const rootDir = () => root;
let counter = 0;
export const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args).trim();

/** `count` files of `size` random-ish bytes each, committed on `main` in `dir` (`round` varies them). */
export function commitFiles(dir: string, count: number, size: number, round: number): void {
  for (let i = 0; i < count; i++) {
    let content = "";
    let x = (i + 1) * 2654435761 + round * 40503;
    while (content.length < size) {
      x = (x * 1103515245 + 12345) >>> 0;
      content += x.toString(36);
    }
    putFile(dir, `f${i}`, `${content.slice(0, size)}\n`);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", `round ${round}`);
}

/** A source repository on `main` with one commit of `count` files. */
export function source(count: number, size: number): string {
  const dir = join(root, `src-${counter++}`);
  git(root, "init", "-q", "-b", "main", dir);
  commitFiles(dir, count, size, 0);
  return dir;
}

/** A bare target with `config` set (no background maintenance unless the config asks). */
export function target(dir: string, config: [string, string][]): void {
  git(root, "init", "-q", "--bare", "-b", "main", dir);
  const defaults: [string, string][] = [
    ["maintenance.auto", "false"],
    ["gc.auto", "0"],
    ["receive.autogc", "false"],
  ];
  const keys = new Set(config.map(([k]) => k.toLowerCase()));
  for (const [k, v] of [...defaults.filter(([k]) => !keys.has(k.toLowerCase())), ...config]) {
    git(dir, "config", "--add", k, v);
  }
}

/** What a target holds: refs, objects, packs and the files maintenance writes. */
export function stateOf(dir: string) {
  const packDir = join(dir, "objects", "pack");
  return {
    refs: git(dir, "for-each-ref", "--format=%(refname) %(objectname)"),
    objects: git(dir, "cat-file", "--batch-all-objects", "--batch-check")
      .split("\n")
      .filter(Boolean)
      .sort(),
    packs: existsSync(packDir) ? readdirSync(packDir).filter((n) => n.endsWith(".pack")).length : 0,
    loose: readdirSync(join(dir, "objects")).filter((n) => /^[0-9a-f]{2}$/.test(n)).length > 0,
    packedRefs: existsSync(join(dir, "packed-refs")),
    infoRefs: existsSync(join(dir, "info", "refs"))
      ? readFileSync(join(dir, "info", "refs"), "latin1")
      : undefined,
    infoPacks: existsSync(join(dir, "objects", "info", "packs"))
      ? readFileSync(join(dir, "objects", "info", "packs"), "latin1")
          .split("\n")
          .filter((l) => l.startsWith("P ")).length
      : undefined,
  };
}

/** A push's outcome: exit status, porcelain lines, `remote:` lines, the unpack and push errors. */
export function nativeOutcome(r: { status: number | null; stdout: string; stderr: string }) {
  const stderr = r.stderr.split("\n").filter(Boolean);
  return {
    ok: r.status === 0,
    porcelain: r.stdout.split("\n").filter((l) => /^[ +\-*=!]\t/.test(l)),
    // git pads each line to clear a progress line
    remote: stderr
      .filter((l) => l.startsWith("remote: "))
      .map((l) => l.slice(8).trimEnd())
      .filter(Boolean),
    unpack: stderr.filter((l) => l.startsWith("error: remote unpack failed")),
  };
}

/** Our push's outcome, as {@link nativeOutcome} gives native git's. */
export function ourOutcome(result: PushResult) {
  const unpack = (result.errors ?? []).filter((l) => l.startsWith("error: remote unpack failed"));
  return {
    // git push fails on a failed unpack whatever the refs say
    ok:
      unpack.length === 0 &&
      result.remoteUpdates.every((u) => u.status === "ok" || u.status === "up-to-date"),
    porcelain: (result.porcelain ?? []).filter((l) => /^[ +\-*=!]\t/.test(l)),
    remote: result.messages
      .join("")
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l !== "" && !l.startsWith("Checking connectivity")),
    unpack,
  };
}

/** A native git (`binary`, default the one on PATH) run in `cwd`. */
export function nativeAsync(
  cwd: string,
  args: string[],
  options: { binary?: string; env?: Record<string, string> } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  if (!options.binary) return gitAsync(root, cwd, args, options.env);
  const binary = options.binary;
  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd, env: { ...nativeGit3Env(root), ...options.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("latin1");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("latin1");
    });
    child.stdin.end();
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** The Node hook runner native git's version calls for (`compatibility` overrides). */
export function hostEnvironment(compatibility?: "2.43" | "2.56") {
  const env = testEnv(root);
  return createNodeGitHostEnvironment({
    env,
    hookRunner: createNodeHookRunner({
      env,
      compatibility: compatibility ?? (nativeIs25x ? "2.56" : "2.43"),
    }),
  });
}

/** Our working copy over `<root>/<name>`, hooks run by the Node runner. */
export async function ours(name: string, compatibility?: "2.43" | "2.56"): Promise<Git> {
  return openOurs(root, hostEnvironment(compatibility), undefined, name);
}

/** Writes an executable hook `name` in the bare repository `dir`. */
export function hook(dir: string, name: string, body: string): void {
  const path = join(dir, "hooks", name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/**
 * Registers the twins' scratch directory and our git:// server (`beforeAll`/`afterAll` of the
 * caller's `describe`): `twins` makes three targets, `pushAll` pushes to them.
 */
export function receiveTwins() {
  let daemon: { port: number; close(): Promise<void> };
  /** The hook compatibility our daemon's hooks run with (a test may switch it) */
  let daemonCompatibility: "2.43" | "2.56" | undefined;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "receive-limits-"));
    git(root, "init", "-q", join(root, "host"));
    const resolveRepository = createBasePathResolver({
      files: createNodeFilesApi({ rootDir: root }),
      exportAll: true,
      openRepository: async (gitDir) => {
        const host = await ours("host", daemonCompatibility);
        const opened = await openLocalRemote(host.workingCopy, `..${gitDir}`).catch(
          () => undefined,
        );
        if (!opened) return undefined;
        const hooks = remoteHookSession(host.workingCopy, opened);
        return servedRepositoryOf(opened, hooks ? { hooks } : {});
      },
    });
    daemon = await startTcpServer((duplex) =>
      serveGitConnection({ duplex, resolveRepository, enableReceivePack: true }),
    );
  });

  afterAll(async () => {
    await daemon?.close();
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  /**
   * Three targets with `config` under a new directory: `n` (native git pushes to a path), `d`
   * (native git pushes to our git:// server), `o` (our client pushes to a path), each with a
   * copy of `src` beside it.
   */
  const twins = (src: string, config: [string, string][], prepare?: (dst: string) => void) => {
    const k = `t${counter++}`;
    const out: Record<"n" | "d" | "o", string> = { n: "", d: "", o: "" };
    for (const name of ["n", "d", "o"] as const) {
      const dir = join(root, k, name);
      mkdirSync(dir, { recursive: true });
      cpSync(src, join(dir, "src"), { recursive: true });
      target(join(dir, "dst"), config);
      prepare?.(join(dir, "dst"));
      out[name] = dir;
    }
    return { k, ...out };
  };

  /** Pushes `spec` from each twin's `src`: native to a path, native to our daemon, ours to a path. */
  const pushAll = async (
    t: ReturnType<typeof twins>,
    spec: string,
    options: { args?: string[]; binary?: string; compatibility?: "2.43" | "2.56" } = {},
  ) => {
    const args = ["push", "--porcelain", ...(options.args ?? [])];
    const native = await nativeAsync(join(t.n, "src"), [...args, "../dst", spec], options);
    const served = await nativeAsync(
      join(t.d, "src"),
      [...args, `git://127.0.0.1:${daemon.port}/${t.k}/d/dst`, spec],
      options,
    );
    const command = (await ours(`${t.k}/o/src`, options.compatibility))
      .push()
      .setRemote("../dst")
      .setRefSpecs(spec);
    if (options.args?.includes("--atomic")) command.setAtomic(true);
    const result: { result?: PushResult; error?: Error } = await command.call().then(
      (r) => ({ result: r }),
      (error: Error) => ({ error }),
    );
    return { native, served, ours: result };
  };

  return {
    twins,
    pushAll,
    daemonPort: () => daemon.port,
    setDaemonCompatibility: (c: "2.43" | "2.56" | undefined) => {
      daemonCompatibility = c;
    },
  };
}
