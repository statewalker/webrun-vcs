/**
 * upload-pack's configuration, against native git (2.43 and 2.5x): `uploadpack.allow*SHA1InWant`
 * (t5516-fetch-push), `uploadpack.allowRefInWant` and `want-ref` (t5703-upload-pack-ref-in-want),
 * `uploadpack.packObjectsHook` (t5544-pack-objects-hook) and `transfer.advertiseSID`
 * (t5705-session-id-in-capabilities).
 *
 * Each scenario runs native git against native upload-pack (file://, or `git daemon --inetd`)
 * and the same native client against our server (git:// through `serveGitConnection`), or our
 * client against native upload-pack: git decides what is right.
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBasePathResolver,
  createDefaultTransports,
  type Duplex,
  processSessionId,
  type ServeGitConnectionResult,
  serveGitConnection,
} from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openLocalRemote, remoteHookSession } from "../src/commands/local-transport.js";
import { type Git, servedRepositoryOf } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import {
  childDuplex,
  daemonArgs,
  gitAsync,
  openTcpSocket,
  startTcpServer,
  writeNativeScripts,
} from "./native-connect-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

/** Whether native git is 2.56 or later (its pack-objects hook arguments, `odb_generate_pack`). */
function nativeIs256(): boolean {
  const m = /git version (\d+)\.(\d+)/.exec(
    nativeGitAvailable() ? gitOut(tmpdir(), tmpdir(), ["--version"]) : "",
  );
  return m ? Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 56) : false;
}

let root: string;
let srv: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

/** One of our git:// servers: its port and the results of the connections it served. */
interface OurDaemon {
  port: number;
  results: ServeGitConnectionResult[];
  close(): Promise<void>;
}

/** Our git:// server over `srv`, its host environment `env` (protected config, hooks). */
async function startOurDaemon(env: Record<string, string>): Promise<OurDaemon> {
  const environment = createNodeGitHostEnvironment({
    env,
    hookRunner: createNodeHookRunner({ env, compatibility: nativeIs256() ? "2.56" : "2.43" }),
  });
  const host: Git = await openOurs(srv, environment, undefined, "repo");
  const resolveRepository = createBasePathResolver({
    files: createNodeFilesApi({ rootDir: srv }),
    exportAll: true,
    openRepository: async (gitDir) => {
      const opened = await openLocalRemote(host.workingCopy, `..${gitDir}`).catch(() => undefined);
      if (!opened) return undefined;
      return servedRepositoryOf(opened, { hooks: remoteHookSession(host.workingCopy, opened) });
    },
  });
  const results: ServeGitConnectionResult[] = [];
  const server = await startTcpServer(async (duplex) => {
    results.push(await serveGitConnection({ duplex, resolveRepository, enableReceivePack: true }));
  });
  return { port: server.port, results, close: server.close };
}

/** The results of the connections served since `before` (waiting for the server to finish). */
async function servedSince(daemon: OurDaemon, before: number): Promise<ServeGitConnectionResult[]> {
  for (let i = 0; i < 100 && daemon.results.length <= before; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return daemon.results.slice(before);
}

/** `git daemon --inetd` over `srv` for one connection, with `extra` in its environment. */
function nativeDaemon(extra: Record<string, string> = {}): Duplex {
  const child = spawn("git", daemonArgs(srv), { env: testEnv(root, extra) });
  return childDuplex(child);
}

/** A fresh empty repository. */
function emptyRepo(name: string): string {
  const dir = join(root, `${name}-${counter++}`);
  git(root, "init", "-q", "-b", "main", dir);
  return dir;
}

/** Our working copy of the repository at `dir` (below `root`). */
async function oursAt(dir: string, env: Record<string, string> = testEnv(root)): Promise<Git> {
  return openOurs(
    root,
    createNodeGitHostEnvironment({ env }),
    undefined,
    dir.slice(root.length + 1),
  );
}

/** The lines of a run that tell upload-pack's refusal (its ERR packet). */
function refusals(stderr: string): string[] {
  return stderr.split(/\r?\n/).filter((l) => /^fatal: remote error: /.test(l));
}

/**
 * A v0 upload-pack dies right after the wants it refuses, while the fetching client may
 * still be writing (`done`): the client then dies on the write (`unable to write to remote:
 * Broken pipe`, or a reset connection) before it reads the ERR packet. Native git races so
 * against itself (file://) and against our server alike, so such a run tells nothing.
 */
function lostRefusal(r: { status: number | null; stderr: string }): boolean {
  return (
    r.status !== 0 &&
    refusals(r.stderr).length === 0 &&
    /unable to write to remote|Broken pipe|Connection reset/.test(r.stderr)
  );
}

/** pkt-lines of `bytes`, as text (`0000` flush, `0001` delim), up to the `packfile` line. */
function pktLines(bytes: Uint8Array): string[] {
  const out: string[] = [];
  let at = 0;
  const text = new TextDecoder("latin1");
  while (at + 4 <= bytes.length) {
    const len = Number.parseInt(text.decode(bytes.subarray(at, at + 4)), 16);
    if (Number.isNaN(len)) break;
    if (len < 4) {
      out.push(len === 0 ? "0000" : len === 1 ? "0001" : "0002");
      at += 4;
      continue;
    }
    const line = text.decode(bytes.subarray(at + 4, at + len)).replace(/\n$/, "");
    out.push(line);
    at += len;
    if (line === "packfile") break;
  }
  return out;
}

function pkt(line: string): string {
  const payload = `${line}\n`;
  return `${(payload.length + 4).toString(16).padStart(4, "0")}${payload}`;
}

/**
 * A raw v2 request to the git:// server behind `duplex`: the advertisement is read, then
 * `request` (pkt-lines) is sent and the answer read to its end. Returns the answer's lines.
 */
async function rawV2(duplex: Duplex, path: string, request: string): Promise<string[]> {
  const head = `git-upload-pack ${path}\0host=localhost\0\0version=2\0`;
  await duplex.write(
    new TextEncoder().encode(`${(head.length + 4).toString(16).padStart(4, "0")}${head}`),
  );
  const chunks: Uint8Array[] = [];
  let total = 0;
  let sent = false;
  const iterator = duplex[Symbol.asyncIterator]();
  while (true) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<Uint8Array>>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), 10_000),
      ),
    ]);
    if (next.done) break;
    chunks.push(next.value);
    total += next.value.length;
    if (!sent) {
      // the advertisement ends with the first flush
      const all = concat(chunks, total);
      if (new TextDecoder("latin1").decode(all).includes("0000")) {
        sent = true;
        chunks.length = 0;
        total = 0;
        await duplex.write(new TextEncoder().encode(request));
        await duplex.end?.();
      }
    }
  }
  await duplex.close?.().catch(() => {});
  return pktLines(concat(chunks, total));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The answer's lines with the pack's checksum-free parts only (agent and ids kept). */
const DELIM = "0001";

describeGit("upload-pack configuration, as native git", () => {
  let ours: OurDaemon;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "upload-pack-config-"));
    srv = join(root, "srv");
    mkdirSync(srv);
    const repo = join(srv, "repo");
    git(root, "init", "-q", "-b", "main", repo);
    const commit = (n: number, file: string) => {
      writeFileSync(join(repo, file), `${n}\n`);
      git(repo, "add", file);
      gitOut(root, repo, ["commit", "-qm", `c${n}`], {
        GIT_AUTHOR_DATE: `170000000${n} +0000`,
        GIT_COMMITTER_DATE: `170000000${n} +0000`,
      });
      return git(repo, "rev-parse", "HEAD").trim();
    };
    ids.c1 = commit(1, "a.txt");
    ids.c2 = commit(2, "b.txt");
    ids.c3 = commit(3, "a.txt");
    git(repo, "branch", "side", ids.c2 as string);
    git(repo, "tag", "-a", "v1", "-m", "v1", ids.c1 as string);
    // a hidden ref at a commit nothing else reaches
    git(repo, "checkout", "-q", "-b", "hidden");
    ids.hidden = commit(4, "h.txt");
    git(repo, "update-ref", "refs/hidden/h", ids.hidden as string);
    git(repo, "checkout", "-q", "main");
    git(repo, "branch", "-D", "hidden");
    // a commit no ref reaches
    ids.dangling = git(
      repo,
      "commit-tree",
      "-p",
      ids.c3 as string,
      "-m",
      "dangling",
      `${ids.c3}^{tree}`,
    ).trim();
    git(repo, "config", "uploadpack.hideRefs", "refs/hidden");
    git(repo, "repack", "-adq");
    const variant = (name: string, config: Array<[string, string]>) => {
      cpSync(repo, join(srv, name), { recursive: true });
      for (const [k, v] of config) git(join(srv, name), "config", k, v);
    };
    variant("none", []);
    variant("tip", [["uploadpack.allowTipSHA1InWant", "true"]]);
    variant("reach", [["uploadpack.allowReachableSHA1InWant", "true"]]);
    variant("tipreach", [
      ["uploadpack.allowTipSHA1InWant", "true"],
      ["uploadpack.allowReachableSHA1InWant", "true"],
    ]);
    variant("any", [["uploadpack.allowAnySHA1InWant", "true"]]);
    // allowAnySHA1InWant=false after allowTipSHA1InWant clears both bits (upload_pack_config)
    variant("anyoff", [
      ["uploadpack.allowTipSHA1InWant", "true"],
      ["uploadpack.allowAnySHA1InWant", "false"],
    ]);
    variant("refinwant", [["uploadpack.allowRefInWant", "true"]]);
    variant("sid", [["transfer.advertiseSID", "true"]]);
    ours = await startOurDaemon(testEnv(root));
  });

  afterAll(async () => {
    await ours?.close();
    rmSync(root, { recursive: true, force: true });
  });

  // ── uploadpack.allow*SHA1InWant (t5516) ────────────────────────────────────────────────

  const POLICIES = ["none", "tip", "reach", "tipreach", "any", "anyoff"];
  const WANTS = ["hidden", "c2", "dangling"];

  for (const version of ["0", "2"]) {
    for (const policy of POLICIES) {
      it(`t5516-fetch-push.sh: "deny fetch unreachable SHA1, allowtipsha1inwant=true" (v${version}, ${policy}): fetch by id from our server as from native`, async () => {
        for (const want of WANTS) {
          const id = ids[want] as string;
          const fetchFrom = async (url: string) => {
            for (let attempt = 1; ; attempt++) {
              const dir = emptyRepo("f");
              const r = await gitAsync(root, dir, [
                "-c",
                `protocol.version=${version}`,
                "fetch",
                "-q",
                url,
                id,
              ]);
              if (!lostRefusal(r) || attempt === 10) return r;
            }
          };
          const theirs = await fetchFrom(`file://${join(srv, policy)}`);
          const mine = await fetchFrom(`git://127.0.0.1:${ours.port}/${policy}`);
          expect(mine.status === 0, `${want}: ${mine.stderr}`).toBe(theirs.status === 0);
          expect(refusals(mine.stderr), want).toEqual(refusals(theirs.stderr));
        }
      });
    }
  }

  for (const policy of ["reach", "tipreach", "none"]) {
    it(`t5516-fetch-push.sh: "shallow fetch reachable SHA1 (but not a ref), allowtipsha1inwant=true" (${policy})`, async () => {
      const fetchFrom = async (url: string) => {
        const dir = emptyRepo("s");
        const r = await gitAsync(root, dir, [
          "-c",
          "protocol.version=0",
          "fetch",
          "-q",
          "--depth=1",
          url,
          ids.c2 as string,
        ]);
        const shallow = existsSync(join(dir, ".git", "shallow"))
          ? readFileSync(join(dir, ".git", "shallow"), "utf8")
          : "";
        return { ...r, shallow };
      };
      const theirs = await fetchFrom(`file://${join(srv, policy)}`);
      const mine = await fetchFrom(`git://127.0.0.1:${ours.port}/${policy}`);
      expect(mine.status === 0, mine.stderr).toBe(theirs.status === 0);
      expect(mine.shallow).toBe(theirs.shallow);
    });
  }

  for (const version of ["0", "2"] as const) {
    it(`t5516-fetch-push.sh: "deny fetch unreachable SHA1, allowtipsha1inwant=false" (v${version}): our client asks native upload-pack by id`, async () => {
      for (const policy of POLICIES) {
        for (const want of WANTS) {
          const id = ids[want] as string;
          const native = emptyRepo("n");
          const theirs = gitRun(root, native, [
            "-c",
            `protocol.version=${version}`,
            "fetch",
            "-q",
            `file://${join(srv, policy)}`,
            id,
          ]);
          const dir = emptyRepo("o");
          git(dir, "config", "protocol.version", version);
          const mine = await oursAt(dir);
          let ok = true;
          try {
            await mine
              .fetch()
              .setRemote(`git://localhost/${policy}`)
              .setRefSpecs(id)
              .setTransports(createDefaultTransports({ openSocket: async () => nativeDaemon() }))
              .call();
          } catch {
            ok = false;
          }
          expect(ok, `${policy} ${want}: ${theirs.stderr}`).toBe(theirs.status === 0);
          if (ok) expect(git(dir, "cat-file", "-t", id).trim()).toBe("commit");
        }
      }
    });
  }

  // ── uploadpack.allowRefInWant (t5703) ──────────────────────────────────────────────────

  /** The `fetch=` capability a native `ls-remote` (v2) read from `url`. */
  const fetchCapability = async (url: string): Promise<string | undefined> => {
    const trace = join(root, `trace-${counter++}`);
    const r = await gitAsync(root, root, ["-c", "protocol.version=2", "ls-remote", url], {
      GIT_TRACE_PACKET: trace,
    });
    expect(r.status, r.stderr).toBe(0);
    const line = readFileSync(trace, "latin1")
      .split("\n")
      .map((l) => /ls-remote< (fetch=.*)$/.exec(l)?.[1])
      .find((l) => l !== undefined);
    return line;
  };

  it(`t5703-upload-pack-ref-in-want.sh: "config controls ref-in-want advertisement"`, async () => {
    for (const repo of ["none", "refinwant"]) {
      const theirs = await fetchCapability(`file://${join(srv, repo)}`);
      const mine = await fetchCapability(`git://127.0.0.1:${ours.port}/${repo}`);
      expect(mine, repo).toBe(theirs);
    }
    expect(await fetchCapability(`file://${join(srv, "refinwant")}`)).toContain("ref-in-want");
  });

  /** A v2 fetch request (t5703's `test-tool pkt-line pack` input). */
  const request = (...args: string[]) =>
    `${pkt("command=fetch")}${DELIM}${args.map(pkt).join("")}0000`;

  const RAW: Array<[string, string, string[]]> = [
    [
      `t5703-upload-pack-ref-in-want.sh: "basic want-ref"`,
      "refinwant",
      ["no-progress", "want-ref refs/heads/main", "have c1", "done"],
    ],
    [
      `t5703-upload-pack-ref-in-want.sh: "multiple want-ref lines"`,
      "refinwant",
      ["no-progress", "want-ref refs/heads/main", "want-ref refs/heads/side", "done"],
    ],
    [
      `t5703-upload-pack-ref-in-want.sh: "mix want and want-ref"`,
      "refinwant",
      ["no-progress", "want-ref refs/heads/main", "want c2", "have c1", "done"],
    ],
    [
      `t5703-upload-pack-ref-in-want.sh: "invalid want-ref line"`,
      "refinwant",
      ["no-progress", "want-ref refs/heads/non-existent", "done"],
    ],
    [
      // hidden refs stay hidden through want-ref (parse_want_ref)
      `t5703-upload-pack-ref-in-want.sh: "with namespace: hideRefs is matched, relative to namespace"`,
      "refinwant",
      ["no-progress", "want-ref refs/hidden/h", "done"],
    ],
    [
      // another spelling of the hidden ref is no ref name (check_refname_format): unknown too
      `t5703-upload-pack-ref-in-want.sh: "invalid want-ref line" (refs//hidden/h)`,
      "refinwant",
      ["no-progress", "want-ref refs//hidden/h", "done"],
    ],
    [
      `t5703-upload-pack-ref-in-want.sh: "invalid want-ref line" (refs/./hidden/h)`,
      "refinwant",
      ["no-progress", "want-ref refs/./hidden/h", "done"],
    ],
    [
      `t5703-upload-pack-ref-in-want.sh: "config controls ref-in-want advertisement" (want-ref refused)`,
      "none",
      ["no-progress", "want-ref refs/heads/main", "done"],
    ],
  ];
  for (const [title, repo, args] of RAW) {
    it(`${title}: our answer as upload-pack's`, async () => {
      const lines = args.map((a) => a.replace(/ (c\d)$/, (_, k: string) => ` ${ids[k]}`));
      const body = request(...lines);
      const theirs = await rawV2(nativeDaemon(), `/${repo}`, body);
      const mine = await rawV2(await openTcpSocket("127.0.0.1", ours.port), `/${repo}`, body);
      expect(mine).toEqual(theirs);
    });
  }

  it(`t5703-upload-pack-ref-in-want.sh: "fetching multiple refs": our client sends want-ref to native upload-pack`, async () => {
    // what the client sent (`fetch> want-ref`), and what upload-pack read (`upload-pack<`)
    const wantRefs = (trace: string, direction: RegExp) =>
      readFileSync(trace, "latin1")
        .split("\n")
        .filter((l) => direction.test(l))
        .map((l) => /want-ref (\S+)$/.exec(l)?.[1])
        .filter((l): l is string => l !== undefined)
        .sort();
    // native client
    const nativeTrace = join(root, `trace-${counter++}`);
    const native = emptyRepo("rn");
    const r = gitRun(
      root,
      native,
      [
        "-c",
        "protocol.version=2",
        "fetch",
        "-q",
        `file://${join(srv, "refinwant")}`,
        "main",
        "side",
      ],
      { GIT_TRACE_PACKET: nativeTrace },
    );
    expect(r.status, r.stderr).toBe(0);
    // ours
    const serverTrace = join(root, `trace-${counter++}`);
    const dir = emptyRepo("ro");
    git(dir, "config", "protocol.version", "2");
    const mine = await oursAt(dir);
    await mine
      .fetch()
      .setRemote("git://localhost/refinwant")
      .setRefSpecs("main", "side")
      .setTransports(
        createDefaultTransports({
          openSocket: async () => nativeDaemon({ GIT_TRACE_PACKET: serverTrace }),
        }),
      )
      .call();
    const sent = wantRefs(serverTrace, /upload-pack< /);
    expect(sent).toEqual(["refs/heads/main", "refs/heads/side"]);
    expect(sent).toEqual(wantRefs(nativeTrace, /upload-pack< /));
    expect(git(dir, "rev-parse", "FETCH_HEAD").trim()).toBe(ids.c3);
    expect(gitOut(root, dir, ["cat-file", "-t", ids.c2 as string]).trim()).toBe("commit");
  });

  // ── uploadpack.packObjectsHook (t5544) ─────────────────────────────────────────────────

  describe("pack-objects hook", () => {
    let hooked: string;
    let globalConfig: string;
    let hookEnv: Record<string, string>;
    let hookDaemon: OurDaemon;
    let cmdlineDaemon: OurDaemon;

    beforeAll(async () => {
      hooked = join(srv, "hooked.git");
      git(root, "clone", "-q", "--bare", join(srv, "repo"), hooked);
      git(hooked, "config", "uploadpack.allowFilter", "true");
      const hook = join(hooked, "hook");
      writeFileSync(
        hook,
        [
          "#!/bin/sh",
          'echo >&2 "hook running"',
          'echo "$*" >hook.args',
          "cat >hook.stdin",
          '"$@" <hook.stdin >hook.stdout',
          "cat hook.stdout",
          "",
        ].join("\n"),
      );
      chmodSync(hook, 0o755);
      globalConfig = join(root, "hook-global.gitconfig");
      writeFileSync(globalConfig, "[uploadpack]\n\tpackObjectsHook = ./hook\n");
      hookEnv = testEnv(root, { GIT_CONFIG_GLOBAL: globalConfig });
      hookDaemon = await startOurDaemon(hookEnv);
      const cmdline = testEnv(root);
      const count = Number(cmdline.GIT_CONFIG_COUNT ?? "0");
      cmdlineDaemon = await startOurDaemon({
        ...cmdline,
        GIT_CONFIG_COUNT: String(count + 1),
        [`GIT_CONFIG_KEY_${count}`]: "uploadpack.packObjectsHook",
        [`GIT_CONFIG_VALUE_${count}`]: "./hook",
      });
    });

    afterAll(async () => {
      await hookDaemon?.close();
      await cmdlineDaemon?.close();
    });

    const clearHookResults = () => {
      for (const f of ["hook.args", "hook.stdin", "hook.stdout"]) {
        rmSync(join(hooked, f), { force: true });
      }
    };
    const hookResults = () => ({
      ran: existsSync(join(hooked, "hook.args")),
      args: existsSync(join(hooked, "hook.args"))
        ? readFileSync(join(hooked, "hook.args"), "latin1")
        : "",
      stdin: existsSync(join(hooked, "hook.stdin"))
        ? readFileSync(join(hooked, "hook.stdin"), "latin1")
        : "",
    });
    const clone = async (url: string, env: Record<string, string>, extra: string[] = []) => {
      clearHookResults();
      const dest = join(root, `dst-${counter++}`);
      const r = await gitAsync(root, root, ["clone", "--no-local", ...extra, url, dest], env);
      return { ...r, dest, ...hookResults() };
    };

    for (const version of ["0", "2"]) {
      it(`t5544-pack-objects-hook.sh: "hook runs via global config", "hook outputs are sane" (v${version})`, async () => {
        const env = { ...hookEnv, GIT_CONFIG_PARAMETERS: `'protocol.version=${version}'` };
        const theirs = await clone(`file://${hooked}`, env);
        const mine = await clone(`git://127.0.0.1:${hookDaemon.port}/hooked.git`, env);
        expect(theirs.status, theirs.stderr).toBe(0);
        expect(mine.status, mine.stderr).toBe(0);
        expect(theirs.stderr).toContain("hook running");
        expect(mine.stderr).toContain("hook running");
        expect(mine.ran).toBe(true);
        // the same command line and input as upload-pack gives pack-objects
        expect(mine.args).toBe(theirs.args);
        expect(mine.stdin).toBe(theirs.stdin);
        expect(git(mine.dest, "rev-parse", "HEAD").trim()).toBe(ids.c3);
      });
    }

    it(`t5544-pack-objects-hook.sh: "hook runs from -c config"`, async () => {
      const theirs = await clone(`file://${hooked}`, testEnv(root), [
        "-u",
        "git -c uploadpack.packObjectsHook=./hook upload-pack",
      ]);
      const mine = await clone(`git://127.0.0.1:${cmdlineDaemon.port}/hooked.git`, testEnv(root));
      expect(theirs.status, theirs.stderr).toBe(0);
      expect(mine.status, mine.stderr).toBe(0);
      expect(theirs.ran).toBe(true);
      expect(mine.ran).toBe(true);
      expect(mine.stderr).toContain("hook running");
    });

    it(`t5544-pack-objects-hook.sh: "hook does not run from repo config"`, async () => {
      git(hooked, "config", "uploadpack.packObjectsHook", "./hook");
      try {
        const theirs = await clone(`file://${hooked}`, testEnv(root));
        const mine = await clone(`git://127.0.0.1:${ours.port}/hooked.git`, testEnv(root));
        expect(theirs.status, theirs.stderr).toBe(0);
        expect(mine.status, mine.stderr).toBe(0);
        expect(theirs.ran).toBe(false);
        expect(mine.ran).toBe(false);
        expect(mine.stderr).not.toContain("hook running");
      } finally {
        git(hooked, "config", "--unset", "uploadpack.packObjectsHook");
      }
    });

    it(`t5544-pack-objects-hook.sh: "hook works with partial clone"`, async () => {
      const blobsOf = (dest: string) =>
        git(dest, "rev-list", "--objects", "--missing=allow-any", "--no-object-names", "--all")
          .split("\n")
          .filter(Boolean)
          .map((id) => git(dest, "cat-file", "-t", id).trim())
          .filter((t) => t === "blob");
      const extra = ["--bare", "--filter=blob:none"];
      const theirs = await clone(`file://${hooked}`, hookEnv, extra);
      const mine = await clone(`git://127.0.0.1:${hookDaemon.port}/hooked.git`, hookEnv, extra);
      expect(theirs.status, theirs.stderr).toBe(0);
      expect(mine.status, mine.stderr).toBe(0);
      expect(mine.args).toBe(theirs.args);
      expect(blobsOf(theirs.dest)).toEqual([]);
      expect(blobsOf(mine.dest)).toEqual([]);
    });
  });

  // ── transfer.advertiseSID (t5705) ──────────────────────────────────────────────────────

  /** The trace2 events of a file: `key`'s values and every `sid`. */
  const trace2 = (file: string) => {
    const events = existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
    return {
      values: (key: string) => events.filter((e) => e.key === key).map((e) => String(e.value)),
      sids: new Set(events.map((e) => String(e.sid))),
      first: events[0] ? String(events[0].sid) : undefined,
    };
  };

  for (const version of ["0", "1", "2"]) {
    for (const advertised of [false, true]) {
      const title = advertised
        ? `t5705-session-id-in-capabilities.sh: "session IDs advertised (fetch v${version})"`
        : `t5705-session-id-in-capabilities.sh: "session IDs not advertised by default (fetch v${version})"`;
      it(`${title}: a native client and our server`, async () => {
        const repo = advertised ? "sid" : "none";
        const run = async (url: string, serverEnv: Record<string, string> = {}) => {
          const events = join(root, `tr2-${counter++}`);
          const dir = emptyRepo("sid");
          git(dir, "config", "transfer.advertiseSID", String(advertised));
          const r = await gitAsync(
            root,
            dir,
            ["-c", `protocol.version=${version}`, "fetch", "-q", url, "main"],
            { GIT_TRACE2_EVENT_NESTING: "100", GIT_TRACE2_EVENT: events, ...serverEnv },
          );
          expect(r.status, r.stderr).toBe(0);
          return trace2(events);
        };
        const theirs = await run(`file://${join(srv, repo)}`);
        const before = ours.results.length;
        const mine = await run(`git://127.0.0.1:${ours.port}/${repo}`);
        expect(mine.values("server-sid").length).toBe(theirs.values("server-sid").length);
        // file:// runs upload-pack as a child, tracing to the same file: its client-sid
        expect(theirs.values("client-sid").length > 0).toBe(advertised);
        const served = await servedSince(ours, before);
        expect(served.length).toBe(1);
        if (advertised) {
          expect(mine.values("server-sid")).toEqual([processSessionId()]);
          expect(served[0]?.clientSessionId).toBe(mine.first);
        } else {
          expect(mine.values("server-sid")).toEqual([]);
          expect(served[0]?.clientSessionId).toBeUndefined();
        }
      });
    }

    it(`t5705-session-id-in-capabilities.sh: "session IDs advertised (push v${version})": a native client and our server`, async () => {
      // native git:// (git daemon through GIT_PROXY_COMMAND) and ours: git 2.43's client logs
      // no server-sid for a git:// push, whatever the server advertises
      const proxy = writeNativeScripts(root, srv).proxy;
      const push = async (url: string, env: Record<string, string> = {}) => {
        const target = join(srv, `push-${counter++}`);
        git(root, "clone", "-q", "--bare", join(srv, "sid"), target);
        git(target, "config", "transfer.advertiseSID", "true");
        const dir = emptyRepo("push");
        git(dir, "fetch", "-q", `file://${target}`, "main");
        git(dir, "config", "transfer.advertiseSID", "true");
        const events = join(root, `tr2-${counter++}`);
        const r = await gitAsync(
          root,
          dir,
          [
            "-c",
            `protocol.version=${version}`,
            "push",
            `${url}/${target.slice(srv.length + 1)}`,
            "FETCH_HEAD:refs/heads/new-branch",
          ],
          { GIT_TRACE2_EVENT_NESTING: "100", GIT_TRACE2_EVENT: events, ...env },
        );
        expect(r.status, r.stderr).toBe(0);
        return trace2(events);
      };
      const theirs = await push("git://localhost", { GIT_PROXY_COMMAND: proxy });
      const before = ours.results.length;
      const mine = await push(`git://127.0.0.1:${ours.port}`);
      const served = await servedSince(ours, before);
      expect(mine.values("server-sid").length).toBe(theirs.values("server-sid").length);
      if (mine.values("server-sid").length > 0) {
        expect(mine.values("server-sid")).toEqual([processSessionId()]);
      }
      // native receive-pack's trace2 (through the daemon) has the client's id: ours too
      expect(theirs.values("client-sid").length).toBe(1);
      expect(served[0]?.clientSessionId).toBe(mine.first);
    });
  }

  for (const version of ["0", "2"] as const) {
    it(`t5705-session-id-in-capabilities.sh: "session IDs advertised (fetch v${version})": our client and native upload-pack`, async () => {
      const events = join(root, `tr2-${counter++}`);
      const dir = emptyRepo("osid");
      git(dir, "config", "protocol.version", version);
      git(dir, "config", "transfer.advertiseSID", "true");
      const mine = await oursAt(dir);
      const result = await mine
        .fetch()
        .setRemote("git://localhost/sid")
        .setRefSpecs("main")
        .setTransports(
          createDefaultTransports({
            openSocket: async () =>
              nativeDaemon({ GIT_TRACE2_EVENT_NESTING: "100", GIT_TRACE2_EVENT: events }),
          }),
        )
        .call();
      const t = trace2(events);
      expect(t.values("client-sid")).toEqual([processSessionId()]);
      expect(result.serverSessionId).toBeDefined();
      expect(t.sids.has(result.serverSessionId as string)).toBe(true);
      // not advertised: nothing sent, nothing read
      const quiet = join(root, `tr2-${counter++}`);
      const plain = await mine
        .fetch()
        .setRemote("git://localhost/none")
        .setRefSpecs("main")
        .setTransports(
          createDefaultTransports({
            openSocket: async () =>
              nativeDaemon({ GIT_TRACE2_EVENT_NESTING: "100", GIT_TRACE2_EVENT: quiet }),
          }),
        )
        .call();
      expect(plain.serverSessionId).toBeUndefined();
      expect(trace2(quiet).values("client-sid")).toEqual([]);
    });
  }

  it(`t5705-session-id-in-capabilities.sh: "session IDs advertised (push v0)": our client and native receive-pack`, async () => {
    const target = join(srv, `opush-${counter++}`);
    git(root, "clone", "-q", "--bare", join(srv, "sid"), target);
    git(target, "config", "transfer.advertiseSID", "true");
    const dir = emptyRepo("opush");
    git(dir, "fetch", "-q", `file://${target}`, "main:refs/heads/topic");
    git(dir, "config", "transfer.advertiseSID", "true");
    const events = join(root, `tr2-${counter++}`);
    const mine = await oursAt(dir);
    const result = await mine
      .push()
      .setRemote(`git://localhost/${target.slice(srv.length + 1)}`)
      .setRefSpecs("refs/heads/topic:refs/heads/new-branch")
      .setTransports(
        createDefaultTransports({
          openSocket: async () =>
            nativeDaemon({ GIT_TRACE2_EVENT_NESTING: "100", GIT_TRACE2_EVENT: events }),
        }),
      )
      .call();
    expect(result.remoteUpdates.map((u) => u.status)).toEqual(["ok"]);
    const t = trace2(events);
    expect(t.values("client-sid")).toEqual([processSessionId()]);
    expect(t.sids.has(result.serverSessionId as string)).toBe(true);
  });
});
