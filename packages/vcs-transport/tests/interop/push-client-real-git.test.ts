/**
 * The push client (git's send-pack) against four receive-packs: native `git receive-pack`
 * spawned over stdio (a duplex), native `git http-backend` (smart HTTP), and ours, over smart
 * HTTP (`createFetchHandler` on a loopback port: a real streamed request) and over a duplex
 * (`serveOverDuplex`). The same scenarios run on each: new branch, fast-forward with a thin
 * pack of exactly the new objects, up to date, fetch first, non-fast-forward refused then
 * forced, delete, a tag that already exists, a stale lease, atomic pushes refused locally and
 * by the server, push options seen by a hook. Each ends with `git fsck --strict` on the
 * receiving repository (ours: on a native mirror clone of it).
 */

import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFetchHandler,
  createMessagePortDuplex,
  openDuplexReceivePackConnection,
  openHttpReceivePackConnection,
  type PushClientOptions,
  type PushClientResult,
  pushToConnection,
  type ReceivePackHooks,
  serveOverDuplex,
} from "../../src/index.js";
import { gitHttpBackend } from "./git-http-backend.js";
import {
  cleanupDir,
  commitInRepo,
  createTransportRepo,
  git,
  gitAvailable,
  loopbackEnv,
  makeBareRepo,
  makeTmpDir,
  spawnGitService,
  type TransportRepo,
} from "./helpers.js";
import { serveFetchHandler } from "./http-server.js";

const run = promisify(execFile);
const HAS_GIT = gitAvailable();
const describeGit = HAS_GIT ? describe : describe.skip;

type PushRequest = Omit<PushClientOptions, "repository" | "refStore">;

/** A receiving repository and a way to push to it. */
interface Target {
  push(client: TransportRepo, request: PushRequest): Promise<PushClientResult>;
  /** A remote ref's value */
  ref(name: string): Promise<string | undefined>;
  /** Runs native git in a repository holding the receiving side's objects and refs */
  git(args: string[]): Promise<string>;
  /** Push options the pre-receive hook saw (last push) */
  pushOptions(): string[];
  close(): Promise<void>;
}

const UPDATE_HOOK = `#!/bin/sh
if [ "$1" = "refs/heads/locked" ]; then echo "locked branch" >&2; exit 1; fi
exit 0
`;
const PRE_RECEIVE_HOOK = `#!/bin/sh
: > "$GIT_DIR/push-options.txt"
i=0
while [ "$i" -lt "\${GIT_PUSH_OPTION_COUNT:-0}" ]; do
  eval "echo \\"\\$GIT_PUSH_OPTION_$i\\"" >> "$GIT_DIR/push-options.txt"
  i=$((i + 1))
done
cat > /dev/null
exit 0
`;

/** A native bare repository with the hooks (`locked` refused, push options recorded). */
function nativeBare(root: string): string {
  const bare = makeBareRepo(root);
  git(bare, ["config", "receive.advertisePushOptions", "true"]);
  git(bare, ["config", "http.receivepack", "true"]);
  for (const [name, script] of [
    ["update", UPDATE_HOOK],
    ["pre-receive", PRE_RECEIVE_HOOK],
  ]) {
    const path = join(bare, "hooks", name as string);
    writeFileSync(path, script as string);
    chmodSync(path, 0o755);
  }
  return bare;
}

function nativeTarget(bare: string, push: Target["push"], close = async () => {}): Target {
  return {
    push,
    async ref(name) {
      try {
        return git(bare, ["rev-parse", "--verify", "-q", name]) || undefined;
      } catch {
        return undefined;
      }
    },
    git: async (args) => git(bare, args),
    pushOptions() {
      const file = join(bare, "push-options.txt");
      return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
    },
    close,
  };
}

/** Our receive-pack's hooks: `locked` refused, push options recorded. */
function ourHooks(seen: { options: string[] }): ReceivePackHooks {
  return {
    update: (refName) => (refName === "refs/heads/locked" ? "hook declined" : undefined),
    preReceive: (_commands, ctx) => {
      seen.options = [...ctx.pushOptions];
      return undefined;
    },
  };
}

/**
 * Our receiving repository, pushed to over smart HTTP (`createFetchHandler` on a loopback port:
 * a real streamed request) or over a duplex (`serveOverDuplex`), and checked with native git
 * through a mirror clone of the same loopback server.
 */
async function ourTarget(root: string, over: "http" | "duplex"): Promise<Target> {
  const server = await createTransportRepo();
  const seen = { options: [] as string[] };
  const hooks = ourHooks(seen);
  const loopback = await serveFetchHandler(
    createFetchHandler({
      resolveRepository: async () => ({ repository: server.facade, refStore: server.refStore }),
      receivePack: { allowNonFastForward: true, hooks },
    }),
  );
  const url = `${loopback.baseUrl}/repo.git`;
  let mirrors = 0;
  const overHttp: Target["push"] = async (client, request) => {
    const connection = await openHttpReceivePackConnection({ url, streamRequestBody: true });
    try {
      return await pushToConnection(connection, { ...request, ...local(client) });
    } finally {
      await connection.close();
    }
  };
  const overDuplex: Target["push"] = async (client, request) => {
    const channel = new MessageChannel();
    const serving = serveOverDuplex({
      duplex: createMessagePortDuplex(channel.port2),
      repository: server.facade,
      refStore: server.refStore,
      service: "git-receive-pack",
      allowNonFastForward: true,
      hooks,
    });
    try {
      const connection = await openDuplexReceivePackConnection(
        createMessagePortDuplex(channel.port1),
      );
      try {
        return await pushToConnection(connection, { ...request, ...local(client) });
      } finally {
        await connection.close();
      }
    } finally {
      await serving;
      channel.port1.close();
      channel.port2.close();
    }
  };
  return {
    push: over === "http" ? overHttp : overDuplex,
    ref: (name) => server.refStore.get(name),
    async git(args) {
      // a clone from the loopback server, which runs in this process: asynchronously (a
      // synchronous child would block the server it reads), and no proxy may see it
      const mirror = join(root, `mirror-${mirrors++}.git`);
      const env = { ...loopbackEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
      await run("git", ["clone", "-q", "--mirror", url, mirror], { cwd: root, env });
      return git(mirror, args);
    },
    pushOptions: () => seen.options,
    async close() {
      await loopback.close();
      await server.close();
    },
  };
}

const targets: Array<[string, (root: string) => Promise<Target>]> = [
  [
    "native git receive-pack (duplex)",
    async (root) => {
      const bare = nativeBare(root);
      return nativeTarget(bare, async (client, request) => {
        const duplex = spawnGitService("receive-pack", bare);
        try {
          const connection = await openDuplexReceivePackConnection(duplex);
          try {
            return await pushToConnection(connection, { ...request, ...local(client) });
          } finally {
            await connection.close();
          }
        } finally {
          await duplex.close();
          await duplex.exited();
        }
      });
    },
  ],
  [
    "native git http-backend (smart HTTP)",
    async (root) => {
      const bare = nativeBare(root);
      const backend = gitHttpBackend(root);
      return nativeTarget(
        bare,
        async (client, request) => {
          const connection = await openHttpReceivePackConnection({
            url: "http://git.test/bare.git",
            fetchImpl: backend.handler,
          });
          try {
            return await pushToConnection(connection, { ...request, ...local(client) });
          } finally {
            await connection.close();
          }
        },
        async () => backend.close(),
      );
    },
  ],
  ["our receive-pack (smart HTTP, loopback)", (root) => ourTarget(root, "http")],
  ["our receive-pack (duplex)", (root) => ourTarget(root, "duplex")],
];

function local(client: TransportRepo) {
  return { repository: client.facade, refStore: client.refStore };
}

const summaries = (r: PushClientResult) =>
  Object.fromEntries(r.updates.map((u) => [u.remoteRef, u.summary]));

describeGit.each(targets)("push client → %s", (_name, makeTarget) => {
  let root: string;
  let target: Target;
  let client: TransportRepo;
  let other: TransportRepo;

  beforeEach(async () => {
    root = makeTmpDir("vcs-push-client-");
    target = await makeTarget(root);
    client = await createTransportRepo();
    other = await createTransportRepo();
  });
  afterEach(async () => {
    await target.close();
    await client.close();
    await other.close();
    cleanupDir(root);
  });

  /** A file large enough that its next version is stored as a delta of this one. */
  const big = (n: number) =>
    `${Array.from({ length: 200 }, (_, i) => `line ${i} of a file`).join("\n")}\nversion ${n}\n`;

  it("new branch, fast-forward with a thin pack of only the new objects, up to date; fsck", async () => {
    const c1 = await commitInRepo(client, "c1", { "a.txt": big(1), "b.txt": "b\n" });
    await client.refStore.update("refs/heads/main", c1);
    const first = await target.push(client, { refspecs: ["main"] });
    expect(first.ok, JSON.stringify(first.updates)).toBe(true);
    expect(summaries(first)).toEqual({ "refs/heads/main": "[new branch]" });
    expect(await target.ref("refs/heads/main")).toBe(c1);

    const c2 = await commitInRepo(client, "c2", { "a.txt": big(2), "b.txt": "b\n" }, [c1]);
    await client.refStore.update("refs/heads/main", c2);
    // the pack as sent, kept to check it is thin
    const sent: Uint8Array[] = [];
    const exportPack = client.facade.exportPack.bind(client.facade);
    client.facade.exportPack = async function* (wants, exclude, options) {
      for await (const chunk of exportPack(wants, exclude, options)) {
        sent.push(chunk);
        yield chunk;
      }
    };
    const second = await target.push(client, { refspecs: ["refs/heads/main:refs/heads/main"] });
    expect(second.ok).toBe(true);
    // thin: its new blob is a delta of c1's, which the pack does not carry, so a repository
    // without c1 cannot index it
    const empty = join(root, "empty.git");
    git(root, ["init", "-q", "--bare", empty]);
    const indexPack = (args: string[]) =>
      execFileSync("git", ["index-pack", "--stdin", ...args], {
        cwd: empty,
        input: Buffer.concat(sent),
        stdio: "pipe",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
    expect(() => indexPack([])).toThrow(/unresolved delta/i);
    expect(summaries(second)).toEqual({
      "refs/heads/main": `${c1.slice(0, 7)}..${c2.slice(0, 7)}`,
    });
    // only what c1 does not reach: the commit, its tree, the new blob
    const newObjects = (await target.git(["rev-list", "--objects", `${c1}..${c2}`])).split("\n");
    expect(second.packObjects).toBe(newObjects.length);
    expect(second.packObjects).toBe(3);
    expect(second.packBytes).toBeLessThan(first.packBytes);
    expect(await target.ref("refs/heads/main")).toBe(c2);

    const again = await target.push(client, { refspecs: ["main"] });
    expect(again.ok).toBe(true);
    expect(summaries(again)).toEqual({ "refs/heads/main": "[up to date]" });
    expect(again.bytesSent).toBe(0);
    await target.git(["fsck", "--strict"]);
  });

  it("fetch first, then non-fast-forward refused, then forced; fsck", async () => {
    const c1 = await commitInRepo(client, "c1", { "a.txt": "1\n" });
    await client.refStore.update("refs/heads/main", c1);
    expect((await target.push(client, { refspecs: ["main"] })).ok).toBe(true);

    // someone else moves main to a commit the client does not have
    const o1 = await commitInRepo(other, "o1", { "o.txt": "other\n" });
    await other.refStore.update("refs/heads/main", o1);
    expect((await target.push(other, { refspecs: ["+main"] })).ok).toBe(true);
    const c2 = await commitInRepo(client, "c2", { "a.txt": "2\n" }, [c1]);
    await client.refStore.update("refs/heads/main", c2);
    const fetchFirst = await target.push(client, { refspecs: ["main"] });
    expect(fetchFirst.ok).toBe(false);
    expect(fetchFirst.updates[0]?.status).toBe("rejected-fetch-first");
    expect(fetchFirst.bytesSent).toBe(0);
    expect(await target.ref("refs/heads/main")).toBe(o1);

    // the client has the remote value, which is no ancestor of its own
    expect((await target.push(client, { refspecs: ["+main"] })).ok).toBe(true);
    const c2x = await commitInRepo(client, "c2x", { "a.txt": "2x\n" }, [c1]);
    await client.refStore.update("refs/heads/main", c2x);
    const nonFf = await target.push(client, { refspecs: ["main"] });
    expect(summaries(nonFf)).toEqual({ "refs/heads/main": "[rejected] (non-fast-forward)" });
    expect(await target.ref("refs/heads/main")).toBe(c2);

    const forced = await target.push(client, { refspecs: ["main"], force: true });
    expect(forced.ok).toBe(true);
    expect(summaries(forced)).toEqual({
      "refs/heads/main": `+ ${c2.slice(0, 7)}...${c2x.slice(0, 7)} (forced update)`,
    });
    expect(await target.ref("refs/heads/main")).toBe(c2x);
    await target.git(["fsck", "--strict"]);
  });

  it("delete; a tag that exists is refused unless forced; fsck", async () => {
    const c1 = await commitInRepo(client, "c1", { "a.txt": "1\n" });
    const c2 = await commitInRepo(client, "c2", { "a.txt": "2\n" }, [c1]);
    await client.refStore.update("refs/heads/main", c2);
    await client.refStore.update("refs/heads/topic", c1);
    await client.refStore.update("refs/tags/v1", c1);
    const all = await target.push(client, {
      refspecs: ["refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"],
    });
    expect(summaries(all)).toEqual({
      "refs/heads/main": "[new branch]",
      "refs/heads/topic": "[new branch]",
      "refs/tags/v1": "[new tag]",
    });

    const deleted = await target.push(client, { refspecs: [":topic"] });
    expect(deleted.ok).toBe(true);
    expect(summaries(deleted)).toEqual({ "refs/heads/topic": "[deleted]" });
    expect(deleted.packObjects).toBe(0); // no pack for deletes only
    expect(await target.ref("refs/heads/topic")).toBeUndefined();

    await client.refStore.update("refs/tags/v1", c2);
    const tag = await target.push(client, { refspecs: ["v1"] });
    expect(summaries(tag)).toEqual({ "refs/tags/v1": "[rejected] (already exists)" });
    expect(await target.ref("refs/tags/v1")).toBe(c1);
    const forcedTag = await target.push(client, { refspecs: ["+v1"] });
    expect(forcedTag.ok).toBe(true);
    expect(await target.ref("refs/tags/v1")).toBe(c2);
    await target.git(["fsck", "--strict"]);
  });

  it("--force-with-lease: stale refused, a lease that holds forces", async () => {
    const c1 = await commitInRepo(client, "c1", { "a.txt": "1\n" });
    const c2 = await commitInRepo(client, "c2", { "a.txt": "2\n" }, [c1]);
    const c2x = await commitInRepo(client, "c2x", { "a.txt": "2x\n" }, [c1]);
    await client.refStore.update("refs/heads/main", c2);
    expect((await target.push(client, { refspecs: ["main"] })).ok).toBe(true);

    await client.refStore.update("refs/heads/main", c2x);
    const stale = await target.push(client, {
      refspecs: ["main"],
      forceWithLease: [{ ref: "main", expect: c1 }],
    });
    expect(summaries(stale)).toEqual({ "refs/heads/main": "[rejected] (stale info)" });
    expect(await target.ref("refs/heads/main")).toBe(c2);

    const held = await target.push(client, {
      refspecs: ["main"],
      forceWithLease: [{ ref: "refs/heads/main", expect: c2 }],
    });
    expect(held.ok).toBe(true);
    expect(held.updates[0]?.forced).toBe(true);
    expect(await target.ref("refs/heads/main")).toBe(c2x);
    await target.git(["fsck", "--strict"]);
  });

  it("--atomic: a local refusal sends nothing; a server refusal fails every ref", async () => {
    const c1 = await commitInRepo(client, "c1", { "a.txt": "1\n" });
    const c2 = await commitInRepo(client, "c2", { "a.txt": "2\n" }, [c1]);
    const c2x = await commitInRepo(client, "c2x", { "a.txt": "2x\n" }, [c1]);
    await client.refStore.update("refs/heads/main", c2);
    expect((await target.push(client, { refspecs: ["main"] })).ok).toBe(true);

    // refused here: main is no fast-forward; topic would be new
    await client.refStore.update("refs/heads/main", c2x);
    await client.refStore.update("refs/heads/topic", c1);
    const local = await target.push(client, { refspecs: ["main", "topic"], atomic: true });
    expect(summaries(local)).toEqual({
      "refs/heads/main": "[rejected] (non-fast-forward)",
      "refs/heads/topic": "[rejected] (atomic push failed)",
    });
    expect(local.bytesSent).toBe(0);
    expect(await target.ref("refs/heads/topic")).toBeUndefined();

    // refused by the server: its update hook declines `locked`
    await client.refStore.update("refs/heads/main", c2);
    await client.refStore.update("refs/heads/locked", c1);
    const plain = await target.push(client, { refspecs: ["topic", "locked"] });
    expect(plain.updates.find((u) => u.remoteRef === "refs/heads/topic")?.status).toBe("ok");
    expect(plain.updates.find((u) => u.remoteRef === "refs/heads/locked")?.status).toBe(
      "remote-rejected",
    );

    const c3 = await commitInRepo(client, "c3", { "a.txt": "3\n" }, [c2]);
    await client.refStore.update("refs/heads/main", c3);
    const atomic = await target.push(client, { refspecs: ["main", "locked"], atomic: true });
    expect(atomic.ok).toBe(false);
    expect(atomic.capabilities).toContain("atomic");
    for (const u of atomic.updates) expect(u.status).toBe("remote-rejected");
    expect(await target.ref("refs/heads/main")).toBe(c2);
    expect(await target.ref("refs/heads/locked")).toBeUndefined();
    await target.git(["fsck", "--strict"]);
  });

  it("push options reach the server's pre-receive hook", async () => {
    const c1 = await commitInRepo(client, "c1", { "a.txt": "1\n" });
    await client.refStore.update("refs/heads/main", c1);
    const result = await target.push(client, {
      refspecs: ["main"],
      pushOptions: ["ci.skip", "reviewer=alice"],
    });
    expect(result.ok).toBe(true);
    expect(result.capabilities).toContain("push-options");
    expect(target.pushOptions()).toEqual(["ci.skip", "reviewer=alice"]);
  });
});
