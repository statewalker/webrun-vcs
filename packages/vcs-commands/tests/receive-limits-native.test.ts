/**
 * receive-pack's limits and policies against native git: `receive.maxInputSize` (t5546),
 * `receive.advertiseAtomic`, `receive.keepAlive`, `receive.autogc` (the auto maintenance after
 * a push), `receive.updateServerInfo`, and git master's receive-report hook (t5412, against the
 * git 3.0 oracle built from master: no release has it yet).
 *
 * Each scenario pushes the same source to twin targets: native git to a local path (native
 * receive-pack) beside native git to our git:// server and our client to a local path (our
 * receive-pack in process), and compares the outcome (exit status, porcelain lines,
 * `remote:` lines, the unpack error) and what the target holds.
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
  rmSync,
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openLocalRemote, remoteHookSession } from "../src/commands/local-transport.js";
import { type Git, type PushResult, servedRepositoryOf } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync, startTcpServer } from "./native-connect-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { git3Binary, nativeGit3Env } from "./native-git3.js";
import { gitOut, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

/** Whether the native git is 2.5x (its hooks' behaviour), else 2.43. */
const nativeIs25x = (() => {
  try {
    const v = /git version (\d+)\.(\d+)/.exec(gitOut(tmpdir(), tmpdir(), ["--version"]));
    return v ? Number(v[1]) > 2 || Number(v[2]) >= 50 : false;
  } catch {
    return false;
  }
})();

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args).trim();

/** `count` files of `size` random-ish bytes each, committed on `main` in `dir` (`round` varies them). */
function commitFiles(dir: string, count: number, size: number, round: number): void {
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
function source(count: number, size: number): string {
  const dir = join(root, `src-${counter++}`);
  git(root, "init", "-q", "-b", "main", dir);
  commitFiles(dir, count, size, 0);
  return dir;
}

/** A bare target with `config` set (no background maintenance unless the config asks). */
function target(dir: string, config: [string, string][]): void {
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
function stateOf(dir: string) {
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
function nativeOutcome(r: { status: number | null; stdout: string; stderr: string }) {
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
function ourOutcome(result: PushResult) {
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
function nativeAsync(
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
function hostEnvironment(compatibility?: "2.43" | "2.56") {
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
async function ours(name: string, compatibility?: "2.43" | "2.56"): Promise<Git> {
  return openOurs(root, hostEnvironment(compatibility), undefined, name);
}

/** Writes an executable hook `name` in the bare repository `dir`. */
function hook(dir: string, name: string, body: string): void {
  const path = join(dir, "hooks", name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

describeGit("receive-pack's limits and policies, as native git", () => {
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
    rmSync(root, { recursive: true, force: true });
  });

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
    const result = await command.call().then(
      (r) => ({ result: r }),
      (error: Error) => ({ error }),
    );
    return { native, served, ours: result };
  };

  describe("t5546-receive-limits.sh: receive.maxInputSize", () => {
    // t5546 pushes a known-size (1024 bytes) commit: a few objects go through unpack-objects
    // (receive.unpackLimit's default 100); 120 files go through index-pack
    for (const [store, files, size] of [
      ["unpack", 1, 1024],
      ["index", 120, 40],
    ] as const) {
      it(`t5546-receive-limits.sh: "setting receive.maxInputSize to 512 rejects push" (${store})`, async () => {
        const src = source(files, size);
        const t = twins(src, [["receive.maxInputSize", "512"]]);
        const { native, served, ours: mine } = await pushAll(t, "HEAD:refs/heads/main");
        const theirs = nativeOutcome(native);
        expect(theirs.ok).toBe(false);
        expect(theirs.unpack).toEqual([
          `error: remote unpack failed: ${store === "index" ? "index-pack" : "unpack-objects"} abnormal exit`,
        ]);
        expect(theirs.remote).toEqual([
          store === "index"
            ? "fatal: pack exceeds maximum allowed size (512 bytes)"
            : "fatal: pack exceeds maximum allowed size",
        ]);
        expect(nativeOutcome(served)).toEqual(theirs);
        expect(mine.result && ourOutcome(mine.result)).toEqual(theirs);
        const state = stateOf(join(t.n, "dst"));
        expect(state.objects).toEqual([]);
        expect(stateOf(join(t.d, "dst"))).toEqual(state);
        expect(stateOf(join(t.o, "dst"))).toEqual(state);
      });

      for (const [title, limit] of [
        ['"bumping limit to 4k allows push"', "1m"],
        ['"lifting the limit allows push"', "0"],
      ] as const) {
        it(`t5546-receive-limits.sh: ${title} (${store})`, async () => {
          const src = source(files, size);
          const t = twins(src, [["receive.maxInputSize", limit]]);
          const { native, served, ours: mine } = await pushAll(t, "HEAD:refs/heads/main");
          const theirs = nativeOutcome(native);
          expect(theirs.ok).toBe(true);
          expect(nativeOutcome(served)).toEqual(theirs);
          expect(mine.result && ourOutcome(mine.result)).toEqual(theirs);
          const state = stateOf(join(t.n, "dst"));
          expect(stateOf(join(t.d, "dst")).refs).toEqual(state.refs);
          expect(stateOf(join(t.o, "dst")).objects).toEqual(state.objects);
        });
      }
    }

    it("a receive.maxInputSize git cannot read kills receive-pack before the advertisement", async () => {
      const src = source(1, 10);
      const t = twins(src, [["receive.maxInputSize", "lots"]]);
      const { native, ours: mine } = await pushAll(t, "HEAD:refs/heads/main");
      expect(native.status).toBe(128);
      const death = native.stderr.split("\n")[0];
      expect(death).toBe(
        "fatal: bad numeric config value 'lots' for 'receive.maxinputsize' in file config: invalid unit",
      );
      expect(mine.error?.message.split("\n")[0]).toBe(death);
    });
  });

  describe("receive.advertiseAtomic", () => {
    it("false: native git's `push --atomic` refuses our server as git's receive-pack", async () => {
      const src = source(1, 10);
      const t = twins(src, [["receive.advertiseAtomic", "false"]]);
      const {
        native,
        served,
        ours: mine,
      } = await pushAll(t, "HEAD:refs/heads/main", {
        args: ["--atomic"],
      });
      expect(native.status).not.toBe(0);
      expect(native.stderr).toContain("the receiving end does not support --atomic push");
      expect(served.status).toBe(native.status);
      // a local receive-pack shares the pusher's stderr: its own death on the hang-up is not
      // the server's to show
      const ownLines = (stderr: string) =>
        stderr.split("\n").filter((l) => l && l !== "fatal: the remote end hung up unexpectedly");
      expect(ownLines(served.stderr)).toEqual(ownLines(native.stderr));
      expect(mine.error?.message ?? "").toContain(
        "the receiving end does not support --atomic push",
      );
      for (const name of ["n", "d", "o"] as const) {
        expect(stateOf(join(t[name], "dst")).refs).toBe("");
      }
    });

    it("unset or true: an atomic push is accepted", async () => {
      const src = source(1, 10);
      const t = twins(src, [["receive.advertiseAtomic", "true"]]);
      const {
        native,
        served,
        ours: mine,
      } = await pushAll(t, "HEAD:refs/heads/main", {
        args: ["--atomic"],
      });
      const theirs = nativeOutcome(native);
      expect(theirs.ok).toBe(true);
      expect(nativeOutcome(served)).toEqual(theirs);
      expect(mine.result && ourOutcome(mine.result)).toEqual(theirs);
    });
  });

  describe("receive.keepAlive", () => {
    /** The keep-alive packets (`0005\1`) native git's client traced while pushing. */
    const keepAlives = (trace: string) =>
      trace.split("\n").filter((l) => /sideband< \\1$/.test(l)).length;

    for (const [value, expectSome] of [
      ["1", true],
      ["0", false],
    ] as const) {
      it(`receive.keepAlive=${value}: keep-alives while pre-receive runs ${expectSome ? "come" : "do not come"}`, async () => {
        const src = source(1, 10);
        const t = twins(src, [["receive.keepAlive", value]], (dst) =>
          hook(dst, "pre-receive", "sleep 2.5"),
        );
        const counts: number[] = [];
        for (const [name, url] of [
          ["n", "../dst"],
          ["d", `git://127.0.0.1:${daemon.port}/${t.k}/d/dst`],
        ] as const) {
          const trace = join(root, t.k, `${name}.trace`);
          const r = await nativeAsync(
            join(t[name], "src"),
            ["push", "--porcelain", url, "HEAD:refs/heads/main"],
            { env: { GIT_TRACE_PACKET: trace } },
          );
          expect(r.status).toBe(0);
          counts.push(keepAlives(readFileSync(trace, "latin1")));
        }
        const [theirs, mine] = counts as [number, number];
        if (expectSome) {
          expect(theirs).toBeGreaterThan(0);
          expect(mine).toBeGreaterThan(0);
        } else {
          expect(theirs).toBe(0);
          expect(mine).toBe(0);
        }
      }, 30_000);
    }
  });

  describe("receive.autogc: the auto maintenance after a push", () => {
    // two pushes of over 100 objects each leave two packs (both kept as packs): more than
    // gc.autoPackLimit=1, so the push's `gc --auto` repacks them into one
    const config = (autogc: string): [string, string][] => [
      ["receive.autogc", autogc],
      ["maintenance.auto", "true"],
      ["maintenance.strategy", "gc"],
      ["maintenance.autoDetach", "false"],
      ["gc.autoDetach", "false"],
      ["gc.auto", "6700"],
      ["gc.autoPackLimit", "1"],
    ];

    for (const autogc of ["true", "false"]) {
      it(`receive.autogc=${autogc}: the target ends up as native git's`, async () => {
        const src = source(120, 40);
        const t = twins(src, config(autogc));
        await pushAll(t, "HEAD:refs/heads/main");
        for (const name of ["n", "d", "o"] as const) {
          commitFiles(join(t[name], "src"), 120, 40, 1);
        }
        const { native, served, ours: mine } = await pushAll(t, "HEAD:refs/heads/main");
        const theirs = nativeOutcome(native);
        expect(theirs.ok).toBe(true);
        expect(nativeOutcome(served)).toEqual(theirs);
        expect(mine.result && ourOutcome(mine.result)).toEqual(theirs);
        const state = stateOf(join(t.n, "dst"));
        expect(state.packs).toBe(autogc === "true" ? 1 : 2);
        expect(stateOf(join(t.d, "dst"))).toEqual(state);
        expect(stateOf(join(t.o, "dst"))).toEqual(state);
      }, 60_000);
    }
  });

  describe("receive.updateServerInfo", () => {
    for (const value of ["true", "false"]) {
      it(`receive.updateServerInfo=${value}: info/refs and objects/info/packs as native git's`, async () => {
        const src = source(120, 20);
        git(src, "tag", "-a", "-m", "v1", "v1");
        const t = twins(src, [["receive.updateServerInfo", value]]);
        // one ref per push: our files store commits a batch of several refs through
        // packed-refs, where git writes them loose
        await pushAll(t, "refs/heads/main:refs/heads/main");
        const { native } = await pushAll(t, "refs/tags/v1:refs/tags/v1");
        expect(native.status).toBe(0);
        const state = stateOf(join(t.n, "dst"));
        expect(state.infoRefs !== undefined).toBe(value === "true");
        expect(stateOf(join(t.d, "dst"))).toEqual(state);
        expect(stateOf(join(t.o, "dst"))).toEqual(state);
      });
    }
  });

  // git master's receive-report hook: no release has it (2.56.1 does not), so its twins run
  // against the git 3.0 oracle built from master ($GIT3)
  const git3 = git3Binary();
  describe.skipIf(!git3)("t5412-receive-report-hook.sh (git master)", () => {
    /** A hook body rewriting the report's pkt-lines with `transform` (a JS expression of `line`). */
    const rewrite = (transform: string, extra = "") =>
      `${extra}exec node -e '
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const data = Buffer.concat(chunks);
  const out = [];
  for (let at = 0; at < data.length; ) {
    const n = parseInt(data.subarray(at, at + 4).toString(), 16);
    if (n === 0) { out.push("0000"); at += 4; continue; }
    let line = data.subarray(at + 4, at + n).toString();
    at += n;
    line = ${transform};
    out.push((line.length + 4).toString(16).padStart(4, "0") + line);
  }
  process.stdout.write(out.join(""));
});'`;

    const scenarios: { title: string; body?: string; raw?: boolean }[] = [
      { title: '"no report hook, push succeeds"' },
      { title: '"passthrough does not alter report"', body: "cat" },
      { title: '"non-zero exit reports as hook failed"', body: "exit 1" },
      { title: '"hook is invoked and receives report on stdin"', body: "tee raw", raw: true },
      {
        title: '"hook can modify the report sent to client"',
        body: rewrite('line.replace(/^ok /, "ng ")'),
      },
      {
        title: '"hook can modify the unpack status"',
        body: rewrite(
          'line.replace(/^unpack ok\\n$/, "unpack push failed due to server error\\n")',
        ),
      },
      {
        title: '"hook can report a custom failure message"',
        body: rewrite(
          'line.replace(/^ok (.*)\\n$/, "ng $1 service-x-is-down\\n")',
          'echo "push rejected: service X is down" >&2\n',
        ),
      },
      {
        title: '"hook stderr with zero exit status code"',
        body: 'echo "push rejected: service X is down" >&2\ntee raw',
        raw: true,
      },
      {
        title: '"hook stderr is relayed to client via sideband"',
        body: 'echo "hook-stderr-message" >&2\nexit 1',
      },
    ];

    for (const scenario of scenarios) {
      it(`t5412-receive-report-hook.sh: ${scenario.title}`, async () => {
        const src = source(2, 10);
        const t = twins(src, []);
        // t5412 pushes A first, then B with the hook in place
        git(src, "tag", "A", "HEAD~0");
        await pushAll(t, "HEAD:refs/heads/main", { binary: git3, compatibility: "2.56" });
        for (const name of ["n", "d", "o"] as const) {
          commitFiles(join(t[name], "src"), 2, 10, 1);
          if (scenario.body) hook(join(t[name], "dst"), "receive-report", scenario.body);
        }
        daemonCompatibility = "2.56";
        try {
          const {
            native,
            served,
            ours: mine,
          } = await pushAll(t, "HEAD:refs/heads/main", {
            binary: git3,
            compatibility: "2.56",
          });
          const theirs = nativeOutcome(native);
          expect(nativeOutcome(served)).toEqual(theirs);
          expect(mine.result && ourOutcome(mine.result)).toEqual(theirs);
          const state = stateOf(join(t.n, "dst"));
          expect(stateOf(join(t.d, "dst")).refs).toEqual(state.refs);
          expect(stateOf(join(t.o, "dst")).refs).toEqual(state.refs);
          if (scenario.raw) {
            const raw = readFileSync(join(t.n, "dst", "raw"), "latin1");
            expect(readFileSync(join(t.d, "dst", "raw"), "latin1")).toBe(raw);
            expect(readFileSync(join(t.o, "dst", "raw"), "latin1")).toBe(raw);
          }
        } finally {
          daemonCompatibility = undefined;
        }
      });
    }

    it("git 2.43 runs no receive-report hook (ours under 2.43 compatibility neither)", async () => {
      const src = source(1, 10);
      const t = twins(src, [], (dst) => hook(dst, "receive-report", "exit 1"));
      const result = await (await ours(`${t.k}/o/src`, "2.43"))
        .push()
        .setRemote("../dst")
        .setRefSpecs("HEAD:refs/heads/main")
        .call();
      expect(result.remoteUpdates.every((u) => u.status === "ok")).toBe(true);
    });
  });
});
