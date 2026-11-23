/**
 * receive-pack's fsck of pushed objects (`receive.fsckObjects`, `transfer.fsckObjects`,
 * `receive.fsck.<msg-id>`, `receive.fsck.skipList`), against native git. Scenarios from git's
 * t5504-fetch-receive-strict.sh (a corrupt object, a commit without an email, skip lists, message
 * types demoted, unknown and fatal ids), t7416-submodule-dash-url.sh and
 * t7417-submodule-path-url.sh (`.gitmodules` URLs and paths), each pushed:
 *
 * - by our client to a local path (our receive-pack in process) and by native git to a twin;
 * - by native git to our served smart HTTP and git:// endpoints, and to native http-backend and
 *   a local path (native receive-pack);
 * - by our client to native http-backend (native receive-pack), and by native git there.
 *
 * Each compares the report (porcelain lines, `remote:` lines, `error: remote unpack failed`),
 * the target's refs and objects (a refused push leaves none: the quarantine is discarded).
 * A pack of fewer than 100 objects goes through unpack-objects `--strict`, a larger one
 * through index-pack `--strict` (their deaths and statuses differ).
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBasePathResolver,
  createServedFetchHandler,
  serveGitConnection,
} from "@statewalker/vcs-transport";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openLocalRemote } from "../src/commands/local-transport.js";
import { type Git, type PushResult, servedRepositoryOf } from "../src/index.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync, startTcpServer } from "./native-connect-support.js";
import {
  nativeGitAvailable,
  nativeGitHttpBackend,
  noMaintenance,
} from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args).trim();

/** A source repository: built once per scenario, copied to each pusher. */
interface Source {
  dir: string;
  /** The refspec pushed */
  spec: string;
  /** Objects to make up a skip list from */
  bogus?: string;
}

/** `<dir>` with one commit (and `files` more files), on `main`. */
function baseRepo(dir: string, files = 0): void {
  git(root, "init", "-q", "-b", "main", dir);
  putFile(dir, "greetings", "hello\n");
  for (let i = 0; i < files; i++) putFile(dir, `f${i}`, `${i}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "greetings");
}

/** Writes `content` as a loose object of `type` without checks (`hash-object --literally`). */
function literally(dir: string, type: string, content: string): string {
  const path = join(dir, ".tmp-object");
  writeFileSync(path, content);
  const id = git(dir, "hash-object", "--literally", "-t", type, "-w", ".tmp-object");
  rmSync(path);
  return id;
}

/** t5504 'setup and inject "corrupt or missing" object': greetings's blob holds "bye". */
function corruptSource(files = 0): Source {
  const dir = join(root, `src-${counter++}`);
  baseRepo(dir, files);
  const S = git(dir, "rev-parse", ":greetings");
  putFile(dir, ".bye", "bye\n");
  const X = git(dir, "hash-object", "-w", ".bye");
  rmSync(join(dir, ".bye"));
  const at = (id: string) => join(dir, ".git/objects", id.slice(0, 2), id.slice(2));
  cpSync(at(X), at(S), { force: true });
  rmSync(at(X));
  return { dir, spec: "main:refs/heads/test" };
}

/** t5504 'setup bogus commit': an author without an email, on `bogus`. */
function bogusSource(files = 0): Source {
  const dir = join(root, `src-${counter++}`);
  baseRepo(dir, files);
  const tree = files > 0 ? git(dir, "rev-parse", "HEAD^{tree}") : git(dir, "mktree");
  const id = literally(
    dir,
    "commit",
    `tree ${tree}\nauthor Bugs Bunny 1234567890 +0000\ncommitter Bugs Bunny <bugs@bun.ni> 1234567890 +0000\n\nThis commit object intentionally broken\n`,
  );
  git(dir, "update-ref", "refs/heads/bogus", id);
  return { dir, spec: "bogus", bogus: id };
}

/** A commit whose tree has `.gitmodules` (as given) and a gitlink at `path` (t7416, t7417). */
function gitmodulesSource(gitmodules: string, path = "sub"): Source {
  const dir = join(root, `src-${counter++}`);
  baseRepo(dir);
  const head = git(dir, "rev-parse", "HEAD");
  putFile(dir, ".gitmodules", gitmodules);
  git(dir, "add", ".gitmodules");
  git(dir, "update-index", "--add", "--cacheinfo", `160000,${head},${path}`);
  git(dir, "commit", "-qm", "submodule");
  return { dir, spec: "main" };
}

/** A bare target with `config` set (and the files of `extra` in its git directory). */
function target(dir: string, config: [string, string][], extra: Record<string, string> = {}) {
  git(root, "init", "-q", "--bare", "-b", "main", dir);
  noMaintenance(dir);
  git(dir, "config", "http.receivepack", "true");
  for (const [k, v] of config) git(dir, "config", "--add", k, v);
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(dir, name), content);
}

/** What a target holds: its refs and its objects (loose and packed). */
function stateOf(dir: string) {
  return {
    refs: git(dir, "for-each-ref", "--format=%(refname) %(objectname)"),
    objects: git(dir, "cat-file", "--batch-all-objects", "--batch-check")
      .split("\n")
      .filter(Boolean)
      .sort(),
  };
}

/** A native push's outcome: exit status, porcelain stdout, `remote:` lines, other stderr. */
function nativeOutcome(r: { status: number | null; stdout: string; stderr: string }) {
  const stderr = r.stderr.split("\n").filter(Boolean);
  return {
    ok: r.status === 0,
    porcelain: r.stdout.split("\n").filter((l) => /^[ +\-*=!]\t/.test(l)),
    done: r.stdout.includes("Done"),
    // git pads each line to clear a progress line
    remote: stderr.filter((l) => l.startsWith("remote: ")).map((l) => l.slice(8).trimEnd()),
    unpack: stderr.filter((l) => l.startsWith("error: remote unpack failed")),
    warnings: stderr.filter((l) => l.startsWith("warning: ")),
  };
}

/** Our push's outcome, as {@link nativeOutcome} gives native git's. */
function ourOutcome(result: PushResult) {
  const remote = result.messages
    .join("")
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("Checking connectivity"));
  const porcelain = result.porcelain ?? [];
  return {
    ok: result.remoteUpdates.every((u) => u.status === "ok" || u.status === "up-to-date"),
    porcelain: porcelain.filter((l) => /^[ +\-*=!]\t/.test(l)),
    done: porcelain.includes("Done"),
    remote,
    unpack: (result.errors ?? []).filter((l) => l.startsWith("error: remote unpack failed")),
    warnings: result.warnings ?? [],
  };
}

/** Our working copy over `<root>/<name>`. */
async function ours(name: string): Promise<Git> {
  return openOurs(root, createNodeGitHostEnvironment({ env: testEnv(root) }), undefined, name);
}

interface Scenario {
  /** What the test says it checks, and the git t/ script it comes from */
  title: string;
  source: () => Source;
  config: [string, string][];
  /** Files written in the target's git directory (a skip list) */
  extra?: (source: Source) => Record<string, string>;
  /** Whether native git accepts the push */
  accepted: boolean;
  /** A line native git's report must hold (checks the scenario itself) */
  expectRemote?: string;
  /** Whether our client can push it (it reads a corrupt object native git sends blindly) */
  ourPusher?: boolean;
}

const MISSING_EMAIL = "missingEmail: invalid author/committer line - missing email";

const SCENARIOS: Scenario[] = [
  {
    title: "t5504 push without strict: missing necessary objects",
    source: () => corruptSource(),
    config: [
      ["fetch.fsckobjects", "false"],
      ["transfer.fsckobjects", "false"],
    ],
    accepted: false,
    ourPusher: false,
  },
  {
    title: "t5504 push with !receive.fsckobjects (transfer.fsckobjects true)",
    source: () => corruptSource(),
    config: [
      ["receive.fsckobjects", "false"],
      ["transfer.fsckobjects", "true"],
    ],
    accepted: false,
    ourPusher: false,
  },
  {
    title: "t5504 push with receive.fsckobjects: unpack-objects dies on the missing blob",
    source: () => corruptSource(),
    config: [
      ["receive.fsckobjects", "true"],
      ["transfer.fsckobjects", "false"],
    ],
    accepted: false,
    expectRemote: "fatal: object of unexpected type",
    ourPusher: false,
  },
  {
    title: "t5504 push with transfer.fsckobjects",
    source: () => corruptSource(),
    config: [["transfer.fsckobjects", "true"]],
    accepted: false,
    expectRemote: "fatal: object of unexpected type",
    ourPusher: false,
  },
  {
    title: "t5504 push with receive.fsckobjects, a kept pack: index-pack misses the blob",
    source: () => corruptSource(120),
    config: [["receive.fsckobjects", "true"]],
    accepted: false,
    expectRemote: "fatal: did not receive expected object",
    ourPusher: false,
  },
  {
    title: "t5504 push with receive.fsckObjects: a commit without an email",
    source: () => bogusSource(),
    config: [["receive.fsckObjects", "true"]],
    accepted: false,
    expectRemote: MISSING_EMAIL,
  },
  {
    title: "t5504 receive.fsck.* does not fall back on fsck.* (fsck.skipList)",
    source: () => bogusSource(),
    config: [
      ["receive.fsckObjects", "true"],
      ["fsck.skipList", "SKIP"],
    ],
    extra: (s) => ({ SKIP: `${s.bogus}\n` }),
    accepted: false,
  },
  {
    title: "t5504 push with receive.fsck.skipList naming a missing file",
    source: () => bogusSource(),
    config: [
      ["receive.fsckObjects", "true"],
      ["receive.fsck.skipList", "does-not-exist"],
    ],
    accepted: false,
    expectRemote: "fatal: could not open object name list: does-not-exist",
  },
  {
    title: "t5504 push with receive.fsck.skipList naming a file of no ids",
    source: () => bogusSource(),
    config: [
      ["receive.fsckObjects", "true"],
      ["receive.fsck.skipList", "config"],
    ],
    accepted: false,
    expectRemote: "fatal: invalid object name: [core]",
  },
  {
    title: "t5504 push with receive.fsck.skipList",
    source: () => bogusSource(),
    config: [
      ["receive.fsckObjects", "true"],
      ["receive.fsck.skipList", "SKIP"],
    ],
    extra: (s) => ({ SKIP: `# skipped\n${s.bogus}\n\n` }),
    accepted: true,
  },
  {
    title: "t5504 push with receive.fsck.missingEmail=warn (and an unknown msg id)",
    source: () => bogusSource(),
    config: [
      ["receive.fsckobjects", "true"],
      ["fsck.missingEmail", "error"],
      ["receive.fsck.whatEver", "error"],
      ["receive.fsck.missingEmail", "warn"],
    ],
    accepted: true,
    expectRemote: MISSING_EMAIL,
  },
  {
    title: "t5504 push with receive.fsck.missingEmail=warn then ignore",
    source: () => bogusSource(),
    config: [
      ["receive.fsckobjects", "true"],
      ["receive.fsck.missingEmail", "warn"],
      ["receive.fsck.missingEmail", "ignore"],
    ],
    accepted: true,
  },
  {
    title: "t5504 receive.fsck.unterminatedHeader=warn triggers error",
    source: () => bogusSource(),
    config: [
      ["receive.fsckobjects", "true"],
      ["receive.fsck.unterminatedheader", "warn"],
    ],
    accepted: false,
    expectRemote: "fatal: Cannot demote unterminatedheader to warn",
  },
  {
    title: "t5504 push with receive.fsckObjects, a kept pack: index-pack's fsck error",
    source: () => bogusSource(120),
    config: [["receive.fsckObjects", "true"]],
    accepted: false,
    expectRemote: "fatal: fsck error in packed object",
  },
  {
    title: "t7416 fsck accepts protected dash",
    source: () => gitmodulesSource('[submodule "sub"]\n\tpath = sub\n\turl = ./-upstream\n'),
    config: [["transfer.fsckObjects", "true"]],
    accepted: true,
  },
  {
    title: "t7416 fsck rejects unprotected dash",
    source: () => gitmodulesSource('[submodule "sub"]\n\tpath = sub\n\turl = -upstream\n'),
    config: [["transfer.fsckObjects", "true"]],
    accepted: false,
    expectRemote: "gitmodulesUrl",
  },
  {
    title: "t7416 fsck rejects missing URL scheme",
    source: () =>
      gitmodulesSource('[submodule "foo"]\n\turl = http::one.example.com/foo.git\n', "foo"),
    config: [["transfer.fsckObjects", "true"]],
    accepted: false,
    expectRemote: "gitmodulesUrl",
  },
  {
    title: "t7416 fsck rejects embedded newline in url",
    source: () =>
      gitmodulesSource(
        '[submodule "foo"]\nurl = "https://one.example.com?%0ahost=two.example.com/foo.git"\n',
        "foo",
      ),
    config: [["transfer.fsckObjects", "true"]],
    accepted: false,
    expectRemote: "gitmodulesUrl",
  },
  {
    title: "t7417 fsck rejects unprotected dash in a path",
    source: () =>
      gitmodulesSource('[submodule "sub"]\n\tpath = -sub\n\turl = ./upstream\n', "-sub"),
    config: [["transfer.fsckObjects", "true"]],
    accepted: false,
    expectRemote: "gitmodulesPath",
  },
  {
    title: "t7415 a submodule name climbing out (gitmodulesName)",
    source: () => gitmodulesSource('[submodule "../../hook"]\n\tpath = sub\n\turl = ./up\n'),
    config: [["transfer.fsckObjects", "true"]],
    accepted: false,
    expectRemote: "gitmodulesName",
  },
];

describeGit("receive-pack checks pushed objects (receive.fsckObjects), as native git", () => {
  let ourHttp: LoopbackServer;
  let nativeHttp: { server: LoopbackServer; close(): Promise<void> };
  let ourDaemon: { port: number; close(): Promise<void> };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "receive-fsck-"));
    git(root, "init", "-q", join(root, "host"));
    const backend = nativeGitHttpBackend(root, root);
    const server = await serveOnLoopback((request) => backend.fetch(request));
    nativeHttp = {
      server,
      close: async () => {
        await server.close();
        backend.close();
      },
    };
    const host = await openOurs(
      root,
      createNodeGitHostEnvironment({ env: testEnv(root) }),
      undefined,
      "host",
    );
    const resolveRepository = createBasePathResolver({
      files: createNodeFilesApi({ rootDir: root }),
      exportAll: true,
      openRepository: async (gitDir) => {
        const opened = await openLocalRemote(host.workingCopy, `..${gitDir}`).catch(
          () => undefined,
        );
        return opened ? servedRepositoryOf(opened) : undefined;
      },
    });
    ourHttp = await serveOnLoopback(createServedFetchHandler({ resolveRepository }));
    ourDaemon = await startTcpServer((duplex) =>
      serveGitConnection({ duplex, resolveRepository, enableReceivePack: true }),
    );
  });

  afterAll(async () => {
    await nativeHttp?.close();
    await ourHttp?.close();
    await ourDaemon?.close();
    rmSync(root, { recursive: true, force: true });
  });

  for (const scenario of SCENARIOS) {
    describe(scenario.title, () => {
      let source: Source;
      let k: string;
      beforeAll(() => {
        source = scenario.source();
        k = `s${counter++}`;
        mkdirSync(join(root, k));
      });

      /** A pusher's copy of the source and a target beside it, under `<k>/<name>/`. */
      const pair = (name: string) => {
        const dir = join(root, k, name);
        cpSync(source.dir, join(dir, "src"), { recursive: true });
        target(join(dir, "dst"), scenario.config, scenario.extra?.(source));
        return dir;
      };

      it("our client to a local path (our receive-pack) as native git to its twin", async () => {
        if (scenario.ourPusher === false) return;
        const n = pair("n");
        const o = pair("o");
        const native = nativeOutcome(
          gitRun(root, join(n, "src"), ["push", "--porcelain", "../dst", source.spec]),
        );
        expect(native.ok).toBe(scenario.accepted);
        if (scenario.expectRemote) {
          expect(native.remote.join("\n")).toContain(scenario.expectRemote);
        }
        const result = await (await ours(`${k}/o/src`))
          .push()
          .setRemote("../dst")
          .setRefSpecs(source.spec)
          .call();
        expect(ourOutcome(result)).toEqual(native);
        expect(stateOf(join(o, "dst"))).toEqual(stateOf(join(n, "dst")));
      });

      it("native git to our smart HTTP and git:// as to http-backend and a local path", async () => {
        const nh = pair("nh");
        const oh = pair("oh");
        const nl = pair("nl");
        const od = pair("od");
        const push = async (dir: string, url: string) =>
          nativeOutcome(
            await gitAsync(root, join(dir, "src"), ["push", "--porcelain", url, source.spec]),
          );
        const theirsHttp = await push(nh, `${nativeHttp.server.baseUrl}/${k}/nh/dst`);
        const oursHttp = await push(oh, `${ourHttp.baseUrl}/${k}/oh/dst`);
        const theirsLocal = await push(nl, "../dst");
        const oursDaemon = await push(od, `git://127.0.0.1:${ourDaemon.port}/${k}/od/dst`);
        expect(theirsHttp.ok).toBe(scenario.accepted);
        if (scenario.expectRemote) {
          expect(theirsHttp.remote.join("\n")).toContain(scenario.expectRemote);
        }
        expect(oursHttp).toEqual(theirsHttp);
        // receive-pack's own warnings reach a local pusher's stderr only
        expect(oursDaemon).toEqual({
          ...theirsLocal,
          warnings: theirsLocal.warnings.filter((l) => !l.includes("unknown msg id")),
        });
        expect(stateOf(join(oh, "dst"))).toEqual(stateOf(join(nh, "dst")));
        expect(stateOf(join(od, "dst"))).toEqual(stateOf(join(nl, "dst")));
      });

      it("our client to native http-backend as native git", async () => {
        if (scenario.ourPusher === false) return;
        const n = pair("cn");
        const o = pair("co");
        const theirs = nativeOutcome(
          await gitAsync(root, join(n, "src"), [
            "push",
            "--porcelain",
            `${nativeHttp.server.baseUrl}/${k}/cn/dst`,
            source.spec,
          ]),
        );
        const result = await (await ours(`${k}/co/src`))
          .push()
          .setRemote(`${nativeHttp.server.baseUrl}/${k}/co/dst`)
          .setRefSpecs(source.spec)
          .call();
        const mine = ourOutcome(result);
        // the porcelain lines name each pusher's URL
        expect({ ...mine, porcelain: undefined }).toEqual({ ...theirs, porcelain: undefined });
        expect(mine.porcelain).toEqual(theirs.porcelain);
        expect(stateOf(join(o, "dst"))).toEqual(stateOf(join(n, "dst")));
      });
    });
  }

  describe("receive-pack dies reading its config", () => {
    for (const [title, config, line] of [
      [
        "receive.fsckObjects that is no boolean",
        ["receive.fsckObjects", "maybe"],
        "fatal: bad boolean config value 'maybe' for 'receive.fsckobjects'",
      ],
      [
        "receive.fsck.<msg-id> of an unknown type",
        ["receive.fsck.missingEmail", "bogus"],
        "fatal: Unknown fsck message type: 'bogus'",
      ],
    ] as const) {
      it(`${title}: our local push dies as native git's`, async () => {
        const source = bogusSource();
        const k = `d${counter++}`;
        const dirs = ["n", "o"].map((name) => {
          const dir = join(root, k, name);
          cpSync(source.dir, join(dir, "src"), { recursive: true });
          target(join(dir, "dst"), [[config[0], config[1]]]);
          return dir;
        });
        const native = gitRun(root, join(dirs[0] as string, "src"), [
          "push",
          "--porcelain",
          "../dst",
          source.spec,
        ]);
        expect(native.status).toBe(128);
        expect(native.stderr).toContain(line);
        const error = await (await ours(`${k}/o/src`))
          .push()
          .setRemote("../dst")
          .setRefSpecs(source.spec)
          .call()
          .then(
            () => undefined,
            (e: unknown) => e as Error,
          );
        expect(error?.message.split("\n")).toEqual(native.stderr.trimEnd().split("\n"));
      });
    }
  });

  it("t7416/t7417: git fsck names the .gitmodules message ids as native git", async () => {
    for (const [gitmodules, path] of [
      ['[submodule "sub"]\n\tpath = sub\n\turl = -upstream\n', "sub"],
      ['[submodule "sub"]\n\tpath = -sub\n\turl = ./upstream\n', "-sub"],
      ['[submodule "../../hook"]\n\tpath = sub\n\turl = ./up\n', "sub"],
      ['[submodule "foo"]\n\turl = http::one.example.com/foo.git\n', "foo"],
    ] as const) {
      const source = gitmodulesSource(gitmodules, path);
      const native = gitRun(root, source.dir, ["fsck"]);
      const result = await (await ours(source.dir.slice(root.length + 1)))
        .fsck()
        .setRepositoryFiles({ files: createNodeFilesApi({ rootDir: source.dir }) })
        .call();
      expect(native.status).not.toBe(0);
      expect(result.errorOutput.split("\n").filter(Boolean).sort()).toEqual(
        native.stderr.split("\n").filter(Boolean).sort(),
      );
      expect(result.exitCode).toBe(native.status);
    }
  });
});
