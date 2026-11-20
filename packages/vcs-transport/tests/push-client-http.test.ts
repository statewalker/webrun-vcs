/**
 * The push client over smart HTTP, against stub servers whose every byte is chosen: what it
 * asks for (only advertised capabilities), what it sends (no pack for deletes, nothing for
 * nothing), how it reads the report (side-band, keep-alives, progress, `ng`, unpack errors),
 * and HTTP failures.
 */

import { describe, expect, it } from "vitest";

import { AuthenticationError, type PushOptions, push, ZERO_OID } from "../src/index.js";
import { createMockRefStore, createMockRepository } from "./helpers/test-protocol.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const LOCAL = "a".repeat(40);
const REMOTE = "1".repeat(40);
const EXTRA = "2".repeat(40);
const pkt = (s: string) => `${(enc.encode(s).length + 4).toString(16).padStart(4, "0")}${s}`;
/** A side-band packet on `band` carrying `payload` */
const band = (n: number, payload: string) => pkt(`${String.fromCharCode(n)}${payload}`);

function advert(caps: string, refs: Array<[string, string]> = []) {
  let body = `${pkt("# service=git-receive-pack\n")}0000`;
  if (refs.length === 0) body += pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  refs.forEach(([name, oid], i) => {
    body += pkt(i === 0 ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`);
  });
  return `${body}0000`;
}

interface Stub {
  advert: string;
  answer?: string | ((body: Uint8Array) => string);
  postStatus?: number;
  infoStatus?: number;
}

/** Runs a push against a stub; returns the result (or error), the POST body and its init. */
async function run(stub: Stub, options: Partial<PushOptions> = {}) {
  const repository = createMockRepository();
  const exportCalls: Array<{ wants: string[]; haves: string[]; options: unknown }> = [];
  repository.exportPack = async function* (wants, haves, opts) {
    exportCalls.push({ wants: [...wants], haves: [...haves], options: opts });
    const head = new Uint8Array(12);
    head.set(enc.encode("PACK"));
    new DataView(head.buffer).setUint32(4, 2);
    new DataView(head.buffer).setUint32(8, 1);
    yield head;
  };
  // the remote tip and the .have object are here; the local branch is new
  const has = repository.has;
  repository.has = async (oid: string) => oid === REMOTE || oid === EXTRA || has(oid);
  const refStore = createMockRefStore();
  refStore._setRef("refs/heads/main", LOCAL);
  let posted: Uint8Array | undefined;
  let postedBodyType = "";
  let posts = 0;
  const fetchImpl = async (request: Request) => {
    if (request.url.includes("/info/refs")) {
      return new Response(stub.advert, { status: stub.infoStatus ?? 200 });
    }
    posts++;
    // a streamed body is pulled as the request is read: nothing exported before it is sent
    postedBodyType = exportCalls.length === 0 ? "streamed" : "collected";
    posted = new Uint8Array(await request.arrayBuffer());
    const answer =
      typeof stub.answer === "function" ? stub.answer(posted) : (stub.answer ?? "0000");
    return new Response(answer, { status: stub.postStatus ?? 200 });
  };
  try {
    const result = await push({
      url: "http://example.test/repo.git",
      repository,
      refStore,
      fetchImpl,
      refspecs: ["main"],
      ...options,
    });
    return { result, posted, posts, postedBodyType, exportCalls };
  } catch (error) {
    return { error: error as Error, posted, posts, postedBodyType, exportCalls };
  }
}

/** The first command line's capabilities */
function capsOf(body: Uint8Array | undefined): string[] {
  const text = dec.decode(body ?? new Uint8Array());
  const nul = text.indexOf("\0");
  return text.slice(nul + 1, text.indexOf("\n", nul)).split(" ");
}

const okReport = (ref = "refs/heads/main") => `${pkt("unpack ok\n")}${pkt(`ok ${ref}\n`)}0000`;

describe("push client over smart HTTP", () => {
  it("asks only for advertised capabilities (no agent, no ofs-delta, no side-band)", async () => {
    const r = await run({ advert: advert("report-status ofs-delta"), answer: okReport() });
    expect(r.result?.ok).toBe(true);
    expect(capsOf(r.posted)).toEqual(["report-status"]);
    expect(r.exportCalls[0]?.options).toEqual({ thin: true, ofsDelta: true });
  });

  it("asks for side-band-64k, quiet, agent and object-format when advertised", async () => {
    const answer = `${band(1, okReport())}0000`;
    const r = await run(
      { advert: advert("report-status side-band-64k quiet agent=x object-format=sha1"), answer },
      { quiet: true },
    );
    expect(r.result?.ok).toBe(true);
    expect(capsOf(r.posted)).toEqual([
      "report-status",
      "side-band-64k",
      "quiet",
      "object-format=sha1",
      "agent=statewalker-vcs/1.0",
    ]);
  });

  it("reads a side-band report among keep-alives and progress", async () => {
    const progress: string[] = [];
    const answer = `${band(1, "")}${band(2, "checking connectivity\n")}${band(1, "")}${band(
      1,
      pkt("unpack ok\n"),
    )}${band(1, `${pkt("ng refs/heads/main pre-receive hook declined\n")}0000`)}0000`;
    const r = await run(
      { advert: advert("report-status side-band-64k"), answer },
      { onProgress: (m) => progress.push(m) },
    );
    expect(r.result?.ok).toBe(false);
    expect(r.result?.updates[0]).toMatchObject({
      status: "remote-rejected",
      message: "pre-receive hook declined",
      summary: "[remote rejected] (pre-receive hook declined)",
    });
    expect(progress).toEqual(["checking connectivity\n"]);
  });

  it("reports an unpack failure", async () => {
    const answer = `${pkt("unpack index-pack failed\n")}${pkt("ng refs/heads/main unpacker error\n")}0000`;
    const r = await run({ advert: advert("report-status"), answer });
    expect(r.result?.ok).toBe(false);
    expect(r.result?.unpack).toEqual({ ok: false, message: "index-pack failed" });
    expect(r.result?.updates[0]?.message).toBe("unpacker error");
  });

  it("a band-3 error fails the push", async () => {
    const answer = `${band(3, "repository is read-only\n")}`;
    const r = await run({ advert: advert("report-status side-band-64k"), answer });
    expect(r.error?.message).toMatch(/repository is read-only/);
  });

  it("without report-status, a sent command counts as done (as git)", async () => {
    const r = await run({ advert: advert("ofs-delta") });
    expect(r.result?.ok).toBe(true);
    expect(r.result?.unpack).toBeUndefined();
  });

  it("thin against every advertised tip here, .have lines included; no-thin turns it off", async () => {
    const refs: Array<[string, string]> = [
      ["refs/heads/other", REMOTE],
      [".have", EXTRA],
      ["refs/heads/gone", "3".repeat(40)], // not here: no edge
    ];
    const r = await run({ advert: advert("report-status", refs), answer: okReport() });
    expect(r.exportCalls[0]?.wants).toEqual([LOCAL]);
    expect(r.exportCalls[0]?.haves.sort()).toEqual([EXTRA, REMOTE].sort());
    const noThin = await run({ advert: advert("report-status no-thin", refs), answer: okReport() });
    expect(noThin.exportCalls[0]?.options).toMatchObject({ thin: false });
    const off = await run(
      { advert: advert("report-status", refs), answer: okReport() },
      { thin: false },
    );
    expect(off.exportCalls[0]?.options).toMatchObject({ thin: false });
  });

  it("a push of deletes only sends no pack", async () => {
    const refs: Array<[string, string]> = [["refs/heads/old", REMOTE]];
    const r = await run(
      { advert: advert("report-status delete-refs", refs), answer: okReport("refs/heads/old") },
      { refspecs: [":old"] },
    );
    expect(r.result?.ok).toBe(true);
    expect(r.exportCalls).toEqual([]);
    expect(dec.decode(r.posted)).toBe(
      `${pkt(`${REMOTE} ${ZERO_OID} refs/heads/old\0report-status\n`)}0000`,
    );
  });

  it("a delete without delete-refs is refused here", async () => {
    const refs: Array<[string, string]> = [["refs/heads/old", REMOTE]];
    const r = await run({ advert: advert("report-status", refs) }, { refspecs: [":old"] });
    expect(r.result?.updates[0]?.status).toBe("rejected-nodelete");
    expect(r.posts).toBe(0);
  });

  it("nothing to update: no POST at all", async () => {
    const refs: Array<[string, string]> = [["refs/heads/main", LOCAL]];
    const r = await run({ advert: advert("report-status", refs) });
    expect(r.result?.updates[0]?.status).toBe("up-to-date");
    expect(r.posts).toBe(0);
  });

  it("push options and atomic go out only when advertised", async () => {
    const r = await run(
      { advert: advert("report-status atomic push-options"), answer: okReport() },
      { atomic: true, pushOptions: ["a=1", "b"] },
    );
    expect(capsOf(r.posted)).toEqual(["report-status", "atomic", "push-options"]);
    expect(dec.decode(r.posted)).toContain(`0000${pkt("a=1\n")}${pkt("b\n")}0000PACK`);
    const noAtomic = await run({ advert: advert("report-status") }, { atomic: true });
    expect(noAtomic.error?.message).toBe("the receiving end does not support --atomic push");
    const noOptions = await run({ advert: advert("report-status") }, { pushOptions: ["x"] });
    expect(noOptions.error?.message).toBe("the receiving end does not support push options");
  });

  it("dry run decides and sends nothing", async () => {
    const r = await run({ advert: advert("report-status") }, { dryRun: true });
    expect(r.result?.updates[0]?.summary).toBe("[new branch]");
    expect(r.posts).toBe(0);
  });

  it("streams the request body by default; streamRequestBody false collects it", async () => {
    const streamed = await run({ advert: advert("report-status"), answer: okReport() });
    expect(streamed.postedBodyType).toBe("streamed");
    const collected = await run(
      { advert: advert("report-status"), answer: okReport() },
      { streamRequestBody: false },
    );
    expect(collected.postedBodyType).toBe("collected");
    expect(collected.result?.ok).toBe(true);
  });

  it("401 and 403 are authentication errors; a dumb server is refused", async () => {
    const unauthorized = await run({ advert: "", infoStatus: 401 });
    expect(unauthorized.error).toBeInstanceOf(AuthenticationError);
    expect(unauthorized.error?.message).toBe(
      "fatal: Authentication failed for 'http://example.test/repo.git/'",
    );
    const forbidden = await run({ advert: advert("report-status"), postStatus: 403 });
    expect(forbidden.error).toBeInstanceOf(AuthenticationError);
    expect(forbidden.error?.message).toMatch(/\b403\b/);
    const dumb = await run({ advert: `${REMOTE}\trefs/heads/main\n` });
    expect(dumb.error?.message).toMatch(/smart-HTTP|Invalid packet|Incomplete packet/);
  });
});
