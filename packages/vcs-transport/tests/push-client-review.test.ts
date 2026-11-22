/**
 * The push client as git, the cases of the P3.5 review: revision sources and lease values,
 * `--prune` with patterns without a colon and with `:`, patterns before `:`, duplicate
 * destinations and a detached HEAD in git's words, the report when the server fails to send
 * one, shallow lines, leases for the rest, the idle timeout (the server's time only) and abort.
 */

import { ObjectType } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMessagePortDuplex,
  matchPushRefs,
  type PushOptions,
  PushRefspecError,
  push,
  pushOverDuplex,
  resolveRevision,
  ZERO_OID,
} from "../src/index.js";
import { commitInRepo, createTransportRepo, type TransportRepo } from "./interop/helpers.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const pkt = (s: string) => `${(enc.encode(s).length + 4).toString(16).padStart(4, "0")}${s}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** c1 <- c2 <- c3 on main; topic at c1; v1 (light) at c2; v2 annotated at c3 */
async function history(repo: TransportRepo) {
  const c1 = await commitInRepo(repo, "c1", { "a.txt": "1\n" });
  const c2 = await commitInRepo(repo, "c2", { "a.txt": "2\n" }, [c1]);
  const c3 = await commitInRepo(repo, "c3", { "a.txt": "3\n" }, [c2]);
  await repo.refStore.update("refs/heads/main", c3);
  await repo.refStore.update("refs/heads/topic", c1);
  await repo.refStore.update("refs/tags/v1", c2);
  const v2 = await repo.history.tags.store({
    object: c3,
    objectType: ObjectType.COMMIT,
    tag: "v2",
    tagger: { name: "T", email: "t@example.com", timestamp: 1112911993, tzOffset: "+0000" },
    message: "v2\n",
  });
  await repo.refStore.update("refs/tags/v2", v2);
  await repo.history.refs.setSymbolic("HEAD", "refs/heads/main");
  const tree3 = (await repo.facade.getCommitInfo?.(c3))?.tree as string;
  return { c1, c2, c3, v2, tree3 };
}

async function localState(repo: TransportRepo) {
  const refs = new Map<string, string>();
  for (const [name, oid] of await repo.refStore.listAll()) {
    if (name.startsWith("refs/")) refs.set(name, oid);
  }
  const head = {
    oid: await repo.refStore.get("HEAD"),
    target: await repo.refStore.getSymrefTarget?.("HEAD"),
  };
  return {
    refs,
    head,
    hasObject: (oid: string) => repo.facade.has(oid),
    resolveRevision: (expr: string) =>
      resolveRevision(expr, { refs, head, repository: repo.facade }),
  };
}

describe("revisions as sources (git's get_oid)", () => {
  let repo: TransportRepo;
  beforeEach(async () => {
    repo = await createTransportRepo();
  });
  afterEach(async () => {
    await repo.close();
  });

  it("resolves ~, ^, ^{…}, HEAD, @ and abbreviated ids", async () => {
    const { c1, c2, c3, v2, tree3 } = await history(repo);
    const state = await localState(repo);
    const r = (e: string) => state.resolveRevision(e);
    expect(await r("main~1")).toBe(c2);
    expect(await r("main~2")).toBe(c1);
    expect(await r("HEAD^")).toBe(c2);
    expect(await r("@~1")).toBe(c2);
    expect(await r("main^^")).toBe(c1);
    expect(await r("main^0")).toBe(c3);
    expect(await r("v2")).toBe(v2);
    expect(await r("v2^{}")).toBe(c3);
    expect(await r("v2^{commit}")).toBe(c3);
    expect(await r("v2~1")).toBe(c2);
    expect(await r("main^{tree}")).toBe(tree3);
    expect(await r("v2^{tag}")).toBe(v2);
    expect(await r("main^{tag}")).toBeUndefined();
    expect(await r(c2.slice(0, 7))).toBe(c2);
    expect(await r(`${c2.slice(0, 8)}~1`)).toBe(c1);
    expect(await r("main~9")).toBeUndefined();
    expect(await r("nope")).toBeUndefined();
  });

  it("pushes a revision to a full or existing destination; refuses an unqualified new one", async () => {
    const { c1, c2, tree3 } = await history(repo);
    const state = await localState(repo);
    const remote = [{ name: "refs/heads/main", oid: c2 }];
    const brief = async (specs: string[]) =>
      (await matchPushRefs(specs, state, remote)).map((m) => `${m.newOid}>${m.remoteRef}`);
    expect(await brief(["main~1:refs/heads/x"])).toEqual([`${c2}>refs/heads/x`]);
    expect(await brief(["HEAD~1:main"])).toEqual([`${c2}>refs/heads/main`]);
    expect(await brief(["main^{tree}:refs/heads/tr"])).toEqual([`${tree3}>refs/heads/tr`]);
    expect(await brief([`${c1.slice(0, 7)}:refs/heads/short`])).toEqual([`${c1}>refs/heads/short`]);
    await expect(matchPushRefs(["main~1"], state, remote)).rejects.toThrow(
      "main~1 cannot be resolved to branch",
    );
    await expect(matchPushRefs(["main~1:fresh"], state, remote)).rejects.toThrow(
      /The destination you provided is not a full refname \(i\.e\.,\nstarting with "refs\/"\)\. We tried to guess what you meant by:/,
    );
  });

  it("a lease value may be a revision or an abbreviated id; an unknown one is refused", async () => {
    const { c2, c3 } = await history(repo);
    const advert = `${pkt("# service=git-receive-pack\n")}0000${pkt(
      `${c2} refs/heads/main\0report-status delete-refs\n`,
    )}0000`;
    const fetchImpl = async (request: Request) => {
      if (request.url.includes("/info/refs")) return new Response(advert);
      await request.arrayBuffer();
      return new Response(`${pkt("unpack ok\n")}${pkt("ok refs/heads/main\n")}0000`);
    };
    const base = { url: "http://x.test/r.git", repository: repo.facade, refStore: repo.refStore };
    await repo.refStore.update("refs/heads/main", c3);
    const viaRevision = await push({
      ...base,
      fetchImpl,
      refspecs: ["main"],
      forceWithLease: [{ ref: "main", expect: "main~1" }],
    });
    expect(viaRevision.updates[0]?.expectedOid).toBe(c2);
    const viaShort = await push({
      ...base,
      fetchImpl,
      refspecs: ["main"],
      forceWithLease: [{ ref: "main", expect: c2.slice(0, 7) }],
    });
    expect(viaShort.updates[0]?.expectedOid).toBe(c2);
    await expect(
      push({
        ...base,
        fetchImpl,
        refspecs: ["main"],
        forceWithLease: [{ ref: "main", expect: "zz" }],
      }),
    ).rejects.toThrow("cannot parse expected object name 'zz'");
  });
});

describe("refspec rules the review found (remote.c)", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const R = "1".repeat(40);
  const local = {
    refs: new Map([
      ["refs/heads/main", A],
      ["refs/heads/topic", B],
    ]),
    head: { target: "refs/heads/main", oid: A },
  };
  const remote = [
    { name: "refs/heads/main", oid: R },
    { name: "refs/heads/gone", oid: R },
    { name: "refs/tags/t", oid: R },
  ];
  const brief = (m: Awaited<ReturnType<typeof matchPushRefs>>) =>
    m.map((x) => `${x.localRef ?? "-"}>${x.remoteRef}`).sort();

  it("--prune with a pattern without a colon deletes what the source side lacks", async () => {
    expect(brief(await matchPushRefs(["refs/heads/*"], local, remote, { prune: true }))).toEqual([
      "->refs/heads/gone",
      "refs/heads/main>refs/heads/main",
      "refs/heads/topic>refs/heads/topic",
    ]);
  });

  it("--prune with ':' deletes remote branches (not tags) the local side lacks", async () => {
    expect(brief(await matchPushRefs([":"], local, remote, { prune: true }))).toEqual([
      "->refs/heads/gone",
      "refs/heads/main>refs/heads/main",
    ]);
  });

  it("a pattern wins over ':' for the refs it matches, whatever their order", async () => {
    for (const specs of [
      [":", "refs/heads/*:refs/x/*"],
      ["refs/heads/*:refs/x/*", ":"],
    ]) {
      expect(brief(await matchPushRefs(specs, local, remote))).toEqual([
        "refs/heads/main>refs/x/main",
        "refs/heads/topic>refs/x/topic",
      ]);
    }
  });

  it("two explicit refspecs for one destination: git's error, even with the same source", async () => {
    await expect(matchPushRefs(["main", "main:main"], local, remote)).rejects.toThrow(
      "dst ref refs/heads/main receives from more than one src",
    );
  });

  it("a detached HEAD without a destination: git's unqualified-destination error", async () => {
    const detached = { ...local, head: { oid: A } };
    for (const spec of ["HEAD", "@", "HEAD:new"]) {
      await expect(matchPushRefs([spec], detached, remote)).rejects.toThrow(
        /The destination you provided is not a full refname/,
      );
    }
    expect(brief(await matchPushRefs(["HEAD:refs/heads/new"], detached, remote))).toEqual([
      "->refs/heads/new",
    ]);
  });
});

describe("the report, shallow lines, leases for the rest (send-pack.c)", () => {
  const LOCAL = "a".repeat(40);
  const OTHER = "b".repeat(40);
  const REMOTE = "1".repeat(40);
  function setup(caps = "report-status delete-refs", refs: Array<[string, string]> = []) {
    const lines = refs.length
      ? refs.map(([n, o], i) => pkt(i === 0 ? `${o} ${n}\0${caps}\n` : `${o} ${n}\n`)).join("")
      : pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    return `${pkt("# service=git-receive-pack\n")}0000${lines}0000`;
  }
  async function run(
    advert: string,
    answer: string,
    options: Partial<PushOptions> = {},
    shallow: string[] = [],
  ) {
    const { createMockRefStore, createMockRepository } = await import("./helpers/test-protocol.js");
    const repository = createMockRepository();
    const exports: unknown[] = [];
    repository.exportPack = async function* (_w, _h, opts) {
      exports.push(opts);
      const head = new Uint8Array(12);
      head.set(enc.encode("PACK"));
      new DataView(head.buffer).setUint32(4, 2);
      yield head;
    };
    repository.has = async (oid: string) => oid !== REMOTE;
    const refStore = createMockRefStore();
    refStore._setRef("refs/heads/main", LOCAL);
    refStore._setRef("refs/heads/other", OTHER);
    if (shallow.length) refStore.getShallow = async () => shallow;
    let posted = "";
    const result = await push({
      url: "http://x.test/r.git",
      repository,
      refStore,
      refspecs: ["main"],
      fetchImpl: async (request: Request) => {
        if (request.url.includes("/info/refs")) return new Response(advert);
        posted = dec.decode(await request.arrayBuffer());
        return new Response(answer);
      },
      ...options,
    });
    return { result, posted, exports };
  }

  it("a report without the unpack line: every sent ref is a remote failure", async () => {
    for (const answer of ["", "0000"]) {
      const { result } = await run(setup(), answer);
      expect(result.ok).toBe(false);
      expect(result.unpack).toEqual({
        ok: false,
        message: "unexpected flush packet while reading remote unpack status",
      });
      expect(result.updates[0]?.summary).toBe("[remote failure] (remote failed to report status)");
    }
  });

  it("an unreadable status line keeps the refs not reported as remote failures", async () => {
    const { result } = await run(
      setup(),
      `${pkt("unpack ok\n")}${pkt("what refs/heads/main\n")}0000`,
    );
    expect(result.ok).toBe(false);
    expect(result.updates[0]?.status).toBe("remote-failure");
    expect(result.unpack?.message).toBe("invalid ref status from remote: what refs/heads/main");
  });

  it("ng without a reason reads 'failed', as git", async () => {
    const { result } = await run(
      setup(),
      `${pkt("unpack ok\n")}${pkt("ng refs/heads/main\n")}0000`,
    );
    expect(result.updates[0]?.summary).toBe("[remote rejected] (failed)");
  });

  it("report-status-v2: an option without its ok fails the push; unknown refs warn", async () => {
    const caps = "report-status report-status-v2 delete-refs";
    const { result } = await run(
      setup(caps),
      `${pkt("unpack ok\n")}${pkt("option refname refs/x\n")}${pkt("ok refs/heads/nope\n")}` +
        `${pkt("option refname refs/y\n")}${pkt("ok refs/heads/main\n")}` +
        `${pkt("option refname refs/heads/rewritten\n")}0000`,
    );
    expect(result.reportErrors).toEqual([
      "error: 'option' without a matching 'ok/ng' directive",
      "warning: remote reported status on unknown ref: refs/heads/nope",
    ]);
    expect(result.reportFailed).toBe(true);
    expect(result.ok).toBe(false);
    // what was reported stands
    expect(result.updates[0]?.status).toBe("ok");
    expect(result.updates[0]?.reports).toEqual([{ refName: "refs/heads/rewritten" }]);
  });

  it("a shallow repository sends its shallow lines first, and a pack cut there", async () => {
    const S = "5".repeat(40);
    const { posted, exports } = await run(
      setup(),
      `${pkt("unpack ok\n")}${pkt("ok refs/heads/main\n")}0000`,
      {},
      [S],
    );
    expect(
      posted.startsWith(
        `${pkt(`shallow ${S}\n`)}${pkt(`${ZERO_OID} ${LOCAL} refs/heads/main\0report-status\n`)}0000`,
      ),
    ).toBe(true);
    expect(exports[0]).toMatchObject({ shallow: new Set([S]) });
  });

  it("atomic: a delete the server does not allow (no delete-refs) refuses the whole push", async () => {
    const refs: Array<[string, string]> = [["refs/heads/old", REMOTE]];
    const { result, posted } = await run(setup("report-status atomic", refs), "", {
      refspecs: [":old", "main"],
      atomic: true,
    });
    expect(result.updates.map((u) => [u.remoteRef, u.status])).toEqual([
      ["refs/heads/old", "rejected-nodelete"],
      ["refs/heads/main", "atomic-push-failed"],
    ]);
    expect(posted).toBe("");
  });

  it("a bare lease covers every pushed ref an explicit one does not name", async () => {
    const refs: Array<[string, string]> = [
      ["refs/heads/main", REMOTE],
      ["refs/heads/other", REMOTE],
    ];
    const { result } = await run(setup("report-status delete-refs", refs), "", {
      refspecs: ["main", "other"],
      forceWithLease: [{ ref: "main", expect: REMOTE }, {}],
      trackingValue: async () => OTHER,
    });
    const byRef = new Map(result.updates.map((u) => [u.remoteRef, u]));
    expect(byRef.get("refs/heads/main")?.expectedOid).toBe(REMOTE);
    expect(byRef.get("refs/heads/other")?.expectedOid).toBe(OTHER);
    expect(byRef.get("refs/heads/other")?.status).toBe("rejected-stale");
  });
});

describe("timeout and abort", () => {
  const LOCAL = "a".repeat(40);
  const advert = `${pkt("# service=git-receive-pack\n")}0000${pkt(
    `${ZERO_OID} capabilities^{}\0report-status delete-refs\n`,
  )}0000`;
  async function local(exportDelay = 0) {
    const { createMockRefStore, createMockRepository } = await import("./helpers/test-protocol.js");
    const repository = createMockRepository();
    repository.exportPack = async function* () {
      await sleep(exportDelay); // listing objects and the delta search, before the first byte
      const head = new Uint8Array(12);
      head.set(enc.encode("PACK"));
      new DataView(head.buffer).setUint32(4, 2);
      yield head;
      await sleep(exportDelay);
      yield new Uint8Array(20);
    };
    const refStore = createMockRefStore();
    refStore._setRef("refs/heads/main", LOCAL);
    return { repository, refStore };
  }
  const ok = `${pkt("unpack ok\n")}${pkt("ok refs/heads/main\n")}0000`;

  for (const streamRequestBody of [true, false]) {
    it(`a slow pack here does not time out (streamRequestBody: ${streamRequestBody})`, async () => {
      const result = await push({
        url: "http://x.test/r.git",
        ...(await local(150)),
        refspecs: ["main"],
        timeout: 60,
        streamRequestBody,
        fetchImpl: async (request) => {
          if (request.url.includes("/info/refs")) return new Response(advert);
          await request.arrayBuffer();
          return new Response(ok);
        },
      });
      expect(result.ok).toBe(true);
    });
  }

  it("a server that never answers times out", async () => {
    const started = Date.now();
    await expect(
      push({
        url: "http://x.test/r.git",
        ...(await local()),
        refspecs: ["main"],
        timeout: 60,
        fetchImpl: async (request) => {
          if (request.url.includes("/info/refs")) return new Response(advert);
          await request.arrayBuffer();
          return new Promise<Response>(() => {});
        },
      }),
    ).rejects.toThrow("Request timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a server that stops reading the request times out", async () => {
    await expect(
      push({
        url: "http://x.test/r.git",
        ...(await local()),
        refspecs: ["main"],
        timeout: 60,
        streamRequestBody: true,
        fetchImpl: async (request) => {
          if (request.url.includes("/info/refs")) return new Response(advert);
          const reader = request.body?.getReader();
          await reader?.read(); // one chunk, then nothing
          return new Promise<Response>(() => {});
        },
      }),
    ).rejects.toThrow("Request timeout");
  });

  it("an already-aborted signal sends nothing", async () => {
    let requests = 0;
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      push({
        url: "http://x.test/r.git",
        ...(await local()),
        refspecs: ["main"],
        signal: controller.signal,
        fetchImpl: async () => {
          requests++;
          return new Response(advert);
        },
      }),
    ).rejects.toThrow("stop");
    expect(requests).toBe(0);
  });

  it("over a duplex: a silent server times out, an abort stops the push", async () => {
    const channel = new MessageChannel();
    try {
      const silent = await pushOverDuplex({
        duplex: createMessagePortDuplex(channel.port1),
        ...(await local()),
        refspecs: ["main"],
        timeout: 60,
      });
      expect(silent).toMatchObject({ success: false, error: "Request timeout" });

      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("cancelled")), 30);
      const aborted = await pushOverDuplex({
        duplex: createMessagePortDuplex(channel.port1),
        ...(await local()),
        refspecs: ["main"],
        signal: controller.signal,
      });
      expect(aborted).toMatchObject({ success: false, error: "cancelled" });
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("the refspec error class is exported for callers", () => {
    expect(new PushRefspecError("x")).toBeInstanceOf(Error);
  });
});
