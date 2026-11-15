/**
 * Network sync of workspaces (`@statewalker/vcs-workspace/net`), ported from the sandbox
 * prototype 39-workspace-net: workspaces sync through a served repository over loopback HTTP,
 * a duplex and an httpeers mesh; concurrent edits merge or report conflicts; lost races retry;
 * post-receive tells the others; a link failing mid-sync leaves everything consistent; native
 * git accepts the served repository.
 */

import { generateSigner, mintToken } from "@statewalker/httpeers-access/issuer";
import {
  meshGitHandler,
  meshRemoteFetch,
  servePeerConnection,
} from "@statewalker/vcs-transport-httpeers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitWorkspaceChanges,
  httpRemote,
  SyncError,
  type SyncEvent,
  type SyncRemote,
  syncWorkspace,
} from "../src/net/index.js";
import {
  failingLink,
  folderFiles,
  git,
  gitAvailable,
  headOf,
  messageChannelRemote,
  readFile,
  removeFile,
  serveLoopback,
  serverRepo,
  tmpDir,
  workspace,
  writeFile,
} from "./net-helpers.js";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** A served repository on loopback HTTP, and a remote for it. */
async function httpServer() {
  const served = await serverRepo();
  const http = await serveLoopback(served.server.fetch);
  closers.push(() => http.close());
  const url = `${http.baseUrl}/notes.git`;
  return { ...served, url, remote: (name = "origin") => httpRemote({ url, name }) };
}

describe("syncWorkspace over loopback HTTP", () => {
  it("two workspaces converge: different files, then different lines of one file", async () => {
    const srv = await httpServer();
    const a = await workspace("Ann", { "a.txt": "from a\n", "shared.txt": "1\n2\n3\n4\n5\n" });
    const b = await workspace("Bob");

    const first = await syncWorkspace(a, srv.remote());
    expect(first).toMatchObject({ committed: true, pushed: true, attempts: 1, conflicts: [] });
    expect(await srv.refStore.get("refs/heads/main")).toBe(first.head);

    const pulled = await syncWorkspace(b, srv.remote());
    expect(pulled).toMatchObject({ integration: "fast-forward", pushed: false });
    expect(await folderFiles(b)).toEqual(await folderFiles(a));

    // concurrent edits: different files and different lines of the same file
    await writeFile(a, "only-a.txt", "a\n");
    await writeFile(a, "shared.txt", "1 (a)\n2\n3\n4\n5\n");
    await writeFile(b, "only-b.txt", "b\n");
    await writeFile(b, "shared.txt", "1\n2\n3\n4\n5 (b)\n");
    await removeFile(b, "a.txt");

    await syncWorkspace(a, srv.remote());
    const merged = await syncWorkspace(b, srv.remote());
    expect(merged).toMatchObject({ integration: "merge", pushed: true, conflicts: [] });
    const back = await syncWorkspace(a, srv.remote());
    expect(back).toMatchObject({ integration: "fast-forward", pushed: false });

    expect(await headOf(a)).toBe(await headOf(b));
    expect(await srv.refStore.get("refs/heads/main")).toBe(await headOf(a));
    const files = await folderFiles(a);
    expect(files).toEqual({
      "only-a.txt": "a\n",
      "only-b.txt": "b\n",
      "shared.txt": "1 (a)\n2\n3\n4\n5 (b)\n",
    });
    expect(await folderFiles(b)).toEqual(files);
    // the merge commit has both parents
    const mergeCommit = await b.history.commits.load(merged.head as string);
    expect(mergeCommit?.parents).toHaveLength(2);
  });

  it("the same line edited on both sides: conflict markers kept, reported, and converged", async () => {
    const srv = await httpServer();
    const a = await workspace("Ann", { "p.txt": "title\nbody\n" });
    const b = await workspace("Bob");
    await syncWorkspace(a, srv.remote());
    await syncWorkspace(b, srv.remote());

    await writeFile(a, "p.txt", "title by Ann\nbody\n");
    await writeFile(b, "p.txt", "title by Bob\nbody\n");
    await syncWorkspace(a, srv.remote());
    const events: SyncEvent[] = [];
    // the pre-0.4 behaviour, kept as an option: the conflicts are committed and pushed
    const result = await syncWorkspace(b, srv.remote(), {
      onEvent: (e) => events.push(e),
      onConflict: "commit",
    });

    expect(result.conflicts).toEqual(["p.txt"]);
    expect(result.pushed).toBe(true);
    const text = await readFile(b, "p.txt");
    expect(text).toContain("<<<<<<<");
    expect(text).toContain("title by Ann");
    expect(text).toContain("title by Bob");
    expect(events.find((e) => e.type === "integrate")).toMatchObject({
      kind: "merge",
      conflicts: ["p.txt"],
    });
    const message = (await b.history.commits.load(result.head as string))?.message;
    expect(message).toContain("Conflicts:\n\tp.txt");

    // the other side gets the marked file; resolving it is an ordinary edit
    await syncWorkspace(a, srv.remote());
    expect(await readFile(a, "p.txt")).toBe(text);
    await writeFile(a, "p.txt", "title by Ann and Bob\nbody\n");
    await syncWorkspace(a, srv.remote());
    await syncWorkspace(b, srv.remote());
    expect(await readFile(b, "p.txt")).toBe("title by Ann and Bob\nbody\n");
    expect(await headOf(a)).toBe(await headOf(b));
  });

  it("binary files both changed: both kept side by side and reported", async () => {
    const srv = await httpServer();
    const a = await workspace("Ann", { "img.bin": "\0base" });
    const b = await workspace("Bob");
    await syncWorkspace(a, srv.remote());
    await syncWorkspace(b, srv.remote());
    await writeFile(a, "img.bin", "\0ann");
    await writeFile(b, "img.bin", "\0bob");
    const pushedByA = await syncWorkspace(a, srv.remote());
    const result = await syncWorkspace(b, srv.remote());
    expect(result.conflicts).toEqual(["img.bin"]);
    const files = await folderFiles(b);
    expect(files["img.bin"]).toBe("\0bob");
    expect(files[`img.bin.theirs-${(pushedByA.head as string).slice(0, 7)}`]).toBe("\0ann");
  });

  it("a push that loses the race is refused (never forced): fetch, merge and push again", async () => {
    const srv = await httpServer();
    const a = await workspace("Ann", { "a.txt": "a\n" });
    const c = await workspace("Cid");
    await syncWorkspace(a, srv.remote());
    await syncWorkspace(c, srv.remote());

    // between A's fetch and A's push, C pushes once
    const base = srv.remote();
    let raced = false;
    const racing: SyncRemote = {
      name: base.name,
      fetch: (o) => base.fetch(o),
      async push(o) {
        if (!raced) {
          raced = true;
          await writeFile(c, "c.txt", "from c\n");
          await syncWorkspace(c, srv.remote());
        }
        return base.push(o);
      },
    };
    await writeFile(a, "a.txt", "a, edited\n");
    const events: SyncEvent[] = [];
    const result = await syncWorkspace(a, racing, { onEvent: (e) => events.push(e) });
    expect(result.attempts).toBe(2);
    expect(result.pushed).toBe(true);
    const refused = events.find((e) => e.type === "push" && e.status !== "ok");
    expect(refused).toMatchObject({ status: "rejected-fetch-first" });
    expect(events.some((e) => e.type === "retry")).toBe(true);
    // nothing C committed is lost
    expect(await folderFiles(a)).toEqual({ "a.txt": "a, edited\n", "c.txt": "from c\n" });
    expect(await srv.refStore.get("refs/heads/main")).toBe(result.head);
  });

  it("gives up after maxAttempts when the remote keeps moving", async () => {
    const srv = await httpServer();
    const a = await workspace("Ann", { "a.txt": "a\n" });
    const c = await workspace("Cid");
    await syncWorkspace(a, srv.remote());
    await syncWorkspace(c, srv.remote());
    const base = srv.remote();
    let n = 0;
    const busy: SyncRemote = {
      name: base.name,
      fetch: (o) => base.fetch(o),
      async push(o) {
        await writeFile(c, "c.txt", `${n++}\n`);
        await syncWorkspace(c, srv.remote());
        return base.push(o);
      },
    };
    await writeFile(a, "a.txt", "a2\n");
    await expect(syncWorkspace(a, busy, { maxAttempts: 3 })).rejects.toThrow(
      /no agreement with origin after 3 attempts/,
    );
    // still consistent: the folder is what A's branch holds, and the next sync converges
    expect(await syncWorkspace(a, srv.remote())).toMatchObject({ pushed: true });
    await syncWorkspace(c, srv.remote());
    expect(await folderFiles(a)).toEqual(await folderFiles(c));
  });

  it("post-receive notifies subscribers after a push, and the other workspace pulls", async () => {
    const srv = await httpServer();
    const a = await workspace("Ann", { "a.txt": "1\n" });
    const b = await workspace("Bob");
    await syncWorkspace(a, srv.remote());
    await syncWorkspace(b, srv.remote());

    const notified: unknown[] = [];
    const unsubscribe = srv.server.subscribe(async (updates) => {
      notified.push(updates);
      if (updates.some((u) => u.ref === "refs/heads/main")) await syncWorkspace(b, srv.remote());
    });
    await writeFile(a, "a.txt", "2\n");
    const pushed = await syncWorkspace(a, srv.remote());
    await vi.waitFor(async () => expect(await readFile(b, "a.txt")).toBe("2\n"));
    expect(await headOf(b)).toBe(pushed.head);
    expect(notified[0]).toEqual([
      { ref: "refs/heads/main", oldOid: expect.any(String), newOid: pushed.head },
    ]);

    // a throwing listener breaks neither the push nor the other listeners
    unsubscribe();
    const logged: unknown[] = [];
    srv.server.subscribe(() => {
      logged.push("thrown");
      throw new Error("notification channel down");
    });
    await writeFile(a, "a.txt", "3\n");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await syncWorkspace(a, srv.remote())).toMatchObject({ pushed: true });
      await vi.waitFor(() => expect(logged).toEqual(["thrown"]));
    } finally {
      errors.mockRestore();
    }
  });

  it("a link failing mid-fetch or mid-push leaves both sides consistent; the next sync converges", async () => {
    const srv = await httpServer();
    const a = await workspace("Ann");
    for (let i = 0; i < 40; i++) {
      await writeFile(a, `f${i}.txt`, `${"x".repeat(200)} ${i} ${Math.sin(i)}\n`);
    }
    await syncWorkspace(a, srv.remote());
    const before = await srv.refStore.get("refs/heads/main");

    // mid-fetch: B gets nothing half-done
    const b = await workspace("Bob", { "b.txt": "local edit\n" });
    const brokenFetch = httpRemote({
      url: srv.url,
      fetchImpl: failingLink((r) => fetch(r), "fetch", 2048),
    });
    await expect(syncWorkspace(b, brokenFetch)).rejects.toBeInstanceOf(SyncError);
    const bHead = await headOf(b);
    expect(bHead).toBeDefined(); // the local edit is committed, nothing else moved
    expect(await b.history.refs.resolve("refs/remotes/origin/main")).toBeUndefined();
    expect(await folderFiles(b)).toEqual({ "b.txt": "local edit\n" });

    // mid-push: the server keeps its branch and no half pack
    for (let i = 0; i < 40; i++) await writeFile(a, `g${i}.txt`, `${"y".repeat(300)} ${i}\n`);
    const brokenPush = httpRemote({
      url: srv.url,
      fetchImpl: failingLink((r) => fetch(r), "push", 2048),
    });
    await expect(syncWorkspace(a, brokenPush)).rejects.toBeInstanceOf(SyncError);
    expect(await srv.refStore.get("refs/heads/main")).toBe(before);
    const aHead = await headOf(a);
    expect((await commitWorkspaceChanges(a)).changed).toBe(false); // folder == branch

    // working links: everything converges
    await syncWorkspace(b, srv.remote());
    await syncWorkspace(a, srv.remote());
    await syncWorkspace(b, srv.remote());
    expect(await headOf(a)).toBe(await headOf(b));
    expect(await headOf(a)).not.toBe(aHead);
    const files = await folderFiles(a);
    expect(Object.keys(files)).toHaveLength(81);
    expect(await folderFiles(b)).toEqual(files);
  });
});

describe("syncWorkspace over a duplex", () => {
  it("two workspaces converge through MessageChannel connections, with a retry", async () => {
    const { server, refStore } = await serverRepo();
    const a = await workspace("Ann", { "a.txt": "a\n", "s.txt": "1\n2\n3\n" });
    const b = await workspace("Bob");
    await syncWorkspace(a, messageChannelRemote(server));
    await syncWorkspace(b, messageChannelRemote(server));
    expect(await folderFiles(b)).toEqual(await folderFiles(a));

    await writeFile(a, "s.txt", "1a\n2\n3\n");
    await writeFile(b, "s.txt", "1\n2\n3b\n");
    const base = messageChannelRemote(server);
    let raced = false;
    const racing: SyncRemote = {
      name: base.name,
      fetch: (o) => base.fetch(o),
      async push(o) {
        if (!raced) {
          raced = true;
          await syncWorkspace(a, messageChannelRemote(server));
        }
        return base.push(o);
      },
    };
    const result = await syncWorkspace(b, racing);
    expect(result).toMatchObject({ attempts: 2, pushed: true, conflicts: [] });
    await syncWorkspace(a, messageChannelRemote(server));
    expect(await readFile(a, "s.txt")).toBe("1a\n2\n3b\n");
    expect(await headOf(a)).toBe(await headOf(b));
    expect(await refStore.get("refs/heads/main")).toBe(await headOf(a));
  });
});

describe("syncWorkspace over an httpeers mesh", () => {
  it("workspaces reach the served repository only through peer connections", async () => {
    const { repository, refStore, server } = await serverRepo();
    const signer = await generateSigner();
    const now = () => Date.now();
    const handler = meshGitHandler({
      repository,
      refStore,
      access: { issuer: signer.mesh, now },
      receivePack: { hooks: server.hooks },
    });
    const peerRemote = async (peer: string) => {
      const token = await mintToken({ signer, sub: peer, roles: ["admin"], ttlMs: 60_000, now });
      const call = servePeerConnection(handler, { remotePeer: peer });
      return httpRemote({
        url: "http://hub.mesh/notes.git",
        fetchImpl: meshRemoteFetch({ call, token }),
      });
    };
    const notified: string[] = [];
    server.subscribe((updates) => {
      for (const u of updates) notified.push(u.ref);
    });

    const a = await workspace("Ann", { "a.txt": "a\n" });
    const b = await workspace("Bob", { "b.txt": "b\n" });
    const ra = await peerRemote("A");
    const rb = await peerRemote("B");
    await syncWorkspace(a, ra);
    await syncWorkspace(b, rb); // unrelated histories: merged, both files kept
    await syncWorkspace(a, ra);
    expect(await folderFiles(a)).toEqual({ "a.txt": "a\n", "b.txt": "b\n" });
    expect(await folderFiles(b)).toEqual(await folderFiles(a));
    expect(await headOf(a)).toBe(await headOf(b));
    await vi.waitFor(() => expect(notified.length).toBeGreaterThanOrEqual(2));
  });
});

describe.skipIf(!gitAvailable())("native git reads the served repository", () => {
  it("git clone after syncs passes fsck --strict and shows the history", async () => {
    const srv = await httpServer();
    const a = await workspace("Ann", { "readme.md": "# notes\n", "dir/a.txt": "1\n2\n3\n" });
    const b = await workspace("Bob");
    await syncWorkspace(a, srv.remote(), { message: "first notes" });
    await syncWorkspace(b, srv.remote());
    await writeFile(a, "dir/a.txt", "1a\n2\n3\n");
    await writeFile(b, "dir/a.txt", "1\n2\n3b\n");
    await writeFile(b, "dir/sub/b.txt", "deep\n");
    await syncWorkspace(a, srv.remote(), { message: "ann edits" });
    const merged = await syncWorkspace(b, srv.remote(), { message: "bob edits" });
    await syncWorkspace(a, srv.remote());

    const tmp = tmpDir();
    closers.push(() => tmp.cleanup());
    await git(tmp.dir, ["clone", "--quiet", srv.url, "clone"]);
    const clone = `${tmp.dir}/clone`;
    await git(clone, ["fsck", "--strict", "--no-dangling"]);
    expect(await git(clone, ["rev-parse", "HEAD"])).toBe(merged.head);
    const log = (await git(clone, ["log", "--format=%s|%an|%p"])).split("\n");
    expect(log).toHaveLength(4);
    expect(log[0]).toMatch(/^Merge origin\/main \([0-9a-f]{7}\) into main\|Bob\|\S+ \S+$/);
    expect(
      log
        .map((l) => l.split("|")[0])
        .slice(1)
        .sort(),
    ).toEqual(["ann edits", "bob edits", "first notes"].sort());
    expect(await git(clone, ["show", "HEAD:dir/a.txt"])).toBe("1a\n2\n3b");
    expect(await git(clone, ["show", "HEAD:dir/sub/b.txt"])).toBe("deep");
    expect(await git(clone, ["status", "--porcelain"])).toBe("");
  });
});
