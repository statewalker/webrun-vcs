/**
 * Tests for the high-level `push()` operation (src/operations/push.ts).
 *
 * These drive the operation through a stub `fetchImpl`, so the exact bytes it
 * puts on the wire — and the exact values it reports back — are observable.
 */

import { describe, expect, it } from "vitest";

import { push } from "../src/operations/push.js";
import { ZERO_OID } from "../src/protocol/constants.js";

/** Distinctive, non-zero remote values: a wrong wire-up cannot accidentally match. */
const REMOTE_MAIN_OID = "1".repeat(40);
const REMOTE_OTHER_OID = "2".repeat(40);
const LOCAL_OID = "3".repeat(40);

const textDecoder = new TextDecoder();

/** A flush packet — ends the advertisement, the commands, and the status. */
const FLUSH = "0000";

/** Encode a single pkt-line (payload must carry its own trailing newline). */
function pkt(payload: string): string {
  return (payload.length + 4).toString(16).padStart(4, "0") + payload;
}

/**
 * A receive-pack advertisement in the exact shape a Git server sends it:
 * a service line, a flush, then the refs — the FIRST of which carries the
 * capability list after a NUL, and follows the flush with no newline between.
 */
function advertisement(refs: Array<[string, string]>): string {
  const caps = "report-status side-band-64k delete-refs";
  let body = pkt("# service=git-receive-pack\n") + FLUSH;
  refs.forEach(([name, oid], index) => {
    body += pkt(index === 0 ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`);
  });
  return body + FLUSH;
}

/** A report-status response accepting every listed ref. */
function reportStatusOk(refNames: string[]): string {
  return pkt("unpack ok\n") + refNames.map((name) => pkt(`ok ${name}\n`)).join("") + FLUSH;
}

/** The `<old> <new> <ref>` triples the client sent in its receive-pack request. */
function parseSentCommands(body: string): Array<[string, string, string]> {
  const commands: Array<[string, string, string]> = [];
  let pos = 0;
  while (pos + 4 <= body.length) {
    const lengthHex = body.slice(pos, pos + 4);
    if (lengthHex === "0000") break; // commands end at the first flush
    const length = Number.parseInt(lengthHex, 16);
    if (Number.isNaN(length) || length < 4) break;
    const payload = body.slice(pos + 4, pos + length);
    const [line = ""] = payload.split("\0");
    const [oldOid = "", newOid = "", refName = ""] = line.trim().split(" ");
    commands.push([oldOid, newOid, refName]);
    pos += length;
  }
  return commands;
}

/**
 * Run `push()` against a stub server, returning both what the client sent and
 * what the operation reported.
 */
async function runPush(options: {
  advertisedRefs: Array<[string, string]>;
  refspecs: string[];
  /** Overrides the default all-accepted report-status. */
  reportStatus?: (destRefs: string[]) => string;
}) {
  let requestBody = "";
  const destRefs = options.refspecs.map((spec) => {
    const [source = "", dest] = spec.replace(/^\+/, "").split(":");
    return dest || source;
  });

  const result = await push({
    url: "http://example.test/repo.git",
    refspecs: options.refspecs,
    getLocalRef: async () => LOCAL_OID,
    fetchImpl: async (request: Request) => {
      if (request.url.includes("/info/refs")) {
        return new Response(advertisement(options.advertisedRefs), { status: 200 });
      }
      requestBody = textDecoder.decode(new Uint8Array(await request.arrayBuffer()));
      const status = options.reportStatus ?? reportStatusOk;
      return new Response(status(destRefs), { status: 200 });
    },
  });

  return { result, sentCommands: parseSentCommands(requestBody) };
}

describe("push() — ref advertisement", () => {
  it("sends the advertised old object id for the FIRST advertised ref", async () => {
    const { sentCommands } = await runPush({
      advertisedRefs: [
        ["refs/heads/main", REMOTE_MAIN_OID],
        ["refs/heads/other", REMOTE_OTHER_OID],
      ],
      refspecs: ["refs/heads/main:refs/heads/main"],
    });

    // The first ref follows the advertisement's flush packet with no newline
    // between them; parsing it by line leaves its pkt-length glued to the oid.
    expect(sentCommands).toEqual([[REMOTE_MAIN_OID, LOCAL_OID, "refs/heads/main"]]);
  });

  it("sends the advertised old object id for a later advertised ref", async () => {
    const { sentCommands } = await runPush({
      advertisedRefs: [
        ["refs/heads/main", REMOTE_MAIN_OID],
        ["refs/heads/other", REMOTE_OTHER_OID],
      ],
      refspecs: ["refs/heads/other:refs/heads/other"],
    });

    expect(sentCommands).toEqual([[REMOTE_OTHER_OID, LOCAL_OID, "refs/heads/other"]]);
  });

  it("sends the zero id for a ref the remote does not have", async () => {
    const { sentCommands } = await runPush({
      advertisedRefs: [["refs/heads/main", REMOTE_MAIN_OID]],
      refspecs: ["refs/heads/main:refs/heads/brand-new"],
    });

    expect(sentCommands).toEqual([[ZERO_OID, LOCAL_OID, "refs/heads/brand-new"]]);
  });

  it("ignores peeled tag lines when reading the advertisement", async () => {
    const caps = "report-status";
    const advertised =
      pkt("# service=git-receive-pack\n") +
      FLUSH +
      pkt(`${REMOTE_MAIN_OID} refs/tags/v1\0${caps}\n`) +
      pkt(`${REMOTE_OTHER_OID} refs/tags/v1^{}\n`) +
      FLUSH;

    let requestBody = "";
    await push({
      url: "http://example.test/repo.git",
      refspecs: ["refs/tags/v1:refs/tags/v1"],
      getLocalRef: async () => LOCAL_OID,
      fetchImpl: async (request: Request) => {
        if (request.url.includes("/info/refs")) {
          return new Response(advertised, { status: 200 });
        }
        requestBody = textDecoder.decode(new Uint8Array(await request.arrayBuffer()));
        return new Response(reportStatusOk(["refs/tags/v1"]), { status: 200 });
      },
    });

    // The tag's own oid, not the peeled commit it points at.
    expect(parseSentCommands(requestBody)).toEqual([[REMOTE_MAIN_OID, LOCAL_OID, "refs/tags/v1"]]);
  });
});

describe("push() — reported old object id", () => {
  const advertisedRefs: Array<[string, string]> = [
    ["refs/heads/main", REMOTE_MAIN_OID],
    ["refs/heads/other", REMOTE_OTHER_OID],
  ];

  it("reports the remote's pre-push value for an accepted ref", async () => {
    const { result } = await runPush({
      advertisedRefs,
      refspecs: ["refs/heads/main:refs/heads/main", "refs/heads/other:refs/heads/other"],
    });

    // Distinct per ref: a single shared value, or the newOid, cannot pass both.
    expect(result.updates.get("refs/heads/main")?.oldOid).toBe(REMOTE_MAIN_OID);
    expect(result.updates.get("refs/heads/other")?.oldOid).toBe(REMOTE_OTHER_OID);
    expect(result.updates.get("refs/heads/main")?.ok).toBe(true);
  });

  it("reports the pre-push value for a REJECTED ref, alongside the reason", async () => {
    const { result } = await runPush({
      advertisedRefs,
      refspecs: ["refs/heads/main:refs/heads/main"],
      reportStatus: () => pkt("unpack ok\n") + pkt("ng refs/heads/main non-fast-forward\n") + FLUSH,
    });

    const update = result.updates.get("refs/heads/main");
    expect(update?.ok).toBe(false);
    expect(update?.message).toBe("non-fast-forward");
    expect(update?.oldOid).toBe(REMOTE_MAIN_OID);
  });

  it("reports the zero id for a ref the remote does not have", async () => {
    const { result } = await runPush({
      advertisedRefs,
      refspecs: ["refs/heads/main:refs/heads/brand-new"],
    });

    expect(result.updates.get("refs/heads/brand-new")?.oldOid).toBe(ZERO_OID);
  });

  it("reports the pre-push value even when the server sends no status for the ref", async () => {
    const { result } = await runPush({
      advertisedRefs,
      refspecs: ["refs/heads/main:refs/heads/main"],
      reportStatus: () => pkt("unpack ok\n") + FLUSH,
    });

    const update = result.updates.get("refs/heads/main");
    expect(update?.ok).toBe(false);
    expect(update?.message).toBe("No status received");
    expect(update?.oldOid).toBe(REMOTE_MAIN_OID);
  });
});
