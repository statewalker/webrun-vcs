/**
 * Keeping a received pack or exploding it into loose objects, against native git: receive-pack
 * keeps a pushed pack of at least `receive.unpackLimit` objects (else `transfer.unpackLimit`,
 * else 100; 0 keeps every pack) and unpacks a smaller one; fetch-pack keeps a fetched pack of at
 * least `fetch.unpackLimit` objects (else `transfer.unpackLimit`, else 100), but 0 unpacks every
 * pack, and `fetch.fsckObjects` (or `transfer.fsckObjects`) always keeps it (index-pack
 * `--strict`). Each scenario pushes (or fetches) the same nine objects, once with native git
 * between native repositories and once with ours between ours, and compares the receiving
 * repository's layout: loose objects, packs, and the objects themselves. Native git also pushes
 * to our receive-pack served over git:// and smart HTTP, which read the limit from the served
 * repository's config.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
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
import { type Git, servedRepositoryOf } from "../src/index.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync, startTcpServer } from "./native-connect-support.js";
import { nativeGitAvailable, noMaintenance } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let source: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args).trim();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "unpack-limit-"));
  // three commits of one new file each: nine objects
  source = join(root, "source");
  git(root, "init", "-q", "-b", "main", source);
  noMaintenance(source);
  for (const n of [1, 2, 3]) {
    putFile(source, `f${n}`, `${n}\n`);
    git(source, "add", `f${n}`);
    git(source, "commit", "-qm", `c${n}`);
  }
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** A repository's layout: loose and packed object counts, packs, and its objects. */
function layout(dir: string) {
  const counts = Object.fromEntries(
    git(dir, "count-objects", "-v")
      .split("\n")
      .map((l) => l.split(": ")),
  );
  return {
    loose: Number(counts.count),
    inPack: Number(counts["in-pack"]),
    packs: Number(counts.packs),
    objects: git(
      dir,
      "cat-file",
      "--batch-all-objects",
      "--batch-check=%(objectname) %(objecttype)",
    )
      .split("\n")
      .sort(),
  };
}

async function ours(name: string): Promise<Git> {
  return openOurs(root, createNodeGitHostEnvironment({ env: testEnv(root) }), undefined, name);
}

/** A fresh pair of directories (`n` for native git, `o` for ours) under a new scenario. */
function pair(): { k: string; n: string; o: string } {
  const k = `s${counter++}`;
  return { k, n: join(root, k, "n"), o: join(root, k, "o") };
}

interface Scenario {
  /** What the test checks, with the git t/ script it comes from */
  title: string;
  config: [string, string][];
  /** Whether native git keeps the pack (checks the scenario itself) */
  kept: boolean;
}

const PUSHES: Scenario[] = [
  { title: "default limit (100): a push of nine objects is unpacked", config: [], kept: false },
  {
    title: `t5516-fetch-push.sh: "push --no-thin must produce non-thin pack" (receive.unpacklimit 0 keeps)`,
    config: [["receive.unpacklimit", "0"]],
    kept: true,
  },
  {
    title: `t5516-fetch-push.sh: "refuse to push a hidden ref, and make sure do not pollute the repository" (receive.unpackLimit 1 keeps)`,
    config: [["receive.unpackLimit", "1"]],
    kept: true,
  },
  {
    title: "receive.unpackLimit at the count keeps",
    config: [["receive.unpackLimit", "9"]],
    kept: true,
  },
  {
    title: "receive.unpackLimit one above the count unpacks",
    config: [["receive.unpackLimit", "10"]],
    kept: false,
  },
  {
    title: "transfer.unpackLimit at the count keeps",
    config: [["transfer.unpackLimit", "9"]],
    kept: true,
  },
  {
    title: "transfer.unpackLimit one above the count unpacks",
    config: [["transfer.unpackLimit", "10"]],
    kept: false,
  },
  {
    title: "receive.unpackLimit trumps transfer.unpackLimit",
    config: [
      ["receive.unpackLimit", "10"],
      ["transfer.unpackLimit", "1"],
    ],
    kept: false,
  },
  {
    title: "a limit with a unit suffix (1k)",
    config: [["receive.unpackLimit", "1k"]],
    kept: false,
  },
  {
    title: "receive.fsckObjects below the limit: unpack-objects --strict",
    config: [["receive.fsckObjects", "true"]],
    kept: false,
  },
  {
    title: "receive.fsckObjects at the limit: index-pack --strict",
    config: [
      ["receive.fsckObjects", "true"],
      ["receive.unpackLimit", "9"],
    ],
    kept: true,
  },
];

const FETCHES: Scenario[] = [
  { title: "default limit (100): a fetch of nine objects is unpacked", config: [], kept: false },
  {
    title: `t5510-fetch.sh: "fetch trumps transfer limit" (packed)`,
    config: [
      ["fetch.unpacklimit", "1"],
      ["transfer.unpacklimit", "10000"],
    ],
    kept: true,
  },
  {
    title: `t5510-fetch.sh: "fetch trumps transfer limit" (loose)`,
    config: [
      ["fetch.unpacklimit", "10000"],
      ["transfer.unpacklimit", "1"],
    ],
    kept: false,
  },
  {
    title: "fetch.unpackLimit at the count keeps",
    config: [["fetch.unpackLimit", "9"]],
    kept: true,
  },
  {
    title: "fetch.unpackLimit one above the count unpacks",
    config: [["fetch.unpackLimit", "10"]],
    kept: false,
  },
  {
    title: `t5500-fetch-pack.sh: "setup" (transfer.unpacklimit 0 unpacks every fetched pack)`,
    config: [["transfer.unpacklimit", "0"]],
    kept: false,
  },
  {
    title: "transfer.unpackLimit at the count keeps",
    config: [["transfer.unpackLimit", "9"]],
    kept: true,
  },
  {
    title: "fetch.fsckObjects keeps every pack (index-pack --strict)",
    config: [["fetch.fsckObjects", "true"]],
    kept: true,
  },
  {
    title: "transfer.fsckObjects keeps every pack (index-pack --strict)",
    config: [["transfer.fsckObjects", "true"]],
    kept: true,
  },
];

describeGit("receive.unpackLimit / transfer.unpackLimit: what a push leaves (native twins)", () => {
  for (const scenario of PUSHES) {
    it(scenario.title, async () => {
      const { k, n, o } = pair();
      for (const dir of [n, o]) {
        cpSync(source, join(dir, "src"), { recursive: true });
        git(root, "init", "-q", "--bare", "-b", "main", join(dir, "dst"));
        noMaintenance(join(dir, "dst"));
        for (const [key, value] of scenario.config) git(join(dir, "dst"), "config", key, value);
      }
      const native = gitRun(root, join(n, "src"), ["push", "-q", "../dst", "main"]);
      expect(native.status, native.stderr).toBe(0);
      const result = await (await ours(`${k}/o/src`))
        .push()
        .setRemote("../dst")
        .setRefSpecs("main")
        .call();
      expect(result.remoteUpdates.map((u) => u.status)).toEqual(["ok"]);
      const theirs = layout(join(n, "dst"));
      expect(theirs.packs > 0).toBe(scenario.kept);
      expect(layout(join(o, "dst"))).toEqual(theirs);
    });
  }
});

describeGit("fetch.unpackLimit / transfer.unpackLimit: what a fetch leaves (native twins)", () => {
  for (const scenario of FETCHES) {
    it(scenario.title, async () => {
      const { k, n, o } = pair();
      for (const dir of [n, o]) {
        cpSync(source, join(dir, "src"), { recursive: true });
        git(root, "init", "-q", "-b", "main", join(dir, "dst"));
        noMaintenance(join(dir, "dst"));
        for (const [key, value] of scenario.config) git(join(dir, "dst"), "config", key, value);
      }
      const native = gitRun(root, join(n, "dst"), ["fetch", "-q", "../src", "main:refs/heads/x"]);
      expect(native.status, native.stderr).toBe(0);
      await (await ours(`${k}/o/dst`))
        .fetch()
        .setRemote("../src")
        .setRefSpecs("main:refs/heads/x")
        .call();
      const theirs = layout(join(n, "dst"));
      expect(theirs.packs > 0).toBe(scenario.kept);
      expect(layout(join(o, "dst"))).toEqual(theirs);
    });
  }
});

describeGit(
  "receive.unpackLimit of a served repository: native git to our git:// and smart HTTP",
  () => {
    let ourHttp: LoopbackServer;
    let ourDaemon: { port: number; close(): Promise<void> };

    beforeAll(async () => {
      git(root, "init", "-q", join(root, "host"));
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
      await ourHttp?.close();
      await ourDaemon?.close();
    });

    const served = PUSHES.filter((s) => !s.config.some(([key]) => key === "receive.fsckObjects"));
    for (const scenario of served) {
      it(scenario.title, async () => {
        const { k, n } = pair();
        const dirs = { n, h: join(root, k, "h"), d: join(root, k, "d") };
        for (const dir of Object.values(dirs)) {
          cpSync(source, join(dir, "src"), { recursive: true });
          git(root, "init", "-q", "--bare", "-b", "main", join(dir, "dst"));
          noMaintenance(join(dir, "dst"));
          git(join(dir, "dst"), "config", "http.receivepack", "true");
          for (const [key, value] of scenario.config) git(join(dir, "dst"), "config", key, value);
        }
        const push = async (dir: string, url: string) => {
          const r = await gitAsync(root, join(dir, "src"), ["push", "-q", url, "main"]);
          expect(r.status, r.stderr).toBe(0);
        };
        await push(dirs.n, "../dst");
        await push(dirs.h, `${ourHttp.baseUrl}/${k}/h/dst`);
        await push(dirs.d, `git://127.0.0.1:${ourDaemon.port}/${k}/d/dst`);
        const theirs = layout(join(dirs.n, "dst"));
        expect(theirs.packs > 0).toBe(scenario.kept);
        expect(layout(join(dirs.h, "dst"))).toEqual(theirs);
        expect(layout(join(dirs.d, "dst"))).toEqual(theirs);
      });
    }
  },
);
