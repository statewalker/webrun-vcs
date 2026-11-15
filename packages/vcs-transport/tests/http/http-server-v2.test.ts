/**
 * Smart-HTTP server, protocol v2: `Git-Protocol: version=2` routes GET /info/refs to the v2
 * capability advertisement and POST /git-upload-pack to one stateless v2 command; requests
 * without the header (and receive-pack) stay v0.
 */

import { describe, expect, it } from "vitest";

import {
  createHttpHandler,
  type HttpRequest,
  type HttpResponse,
  requestsProtocolV2,
} from "../../src/index.js";
import { encodeDelim, encodeFlush, encodePacketLine } from "../../src/protocol/pkt-line-codec.js";
import { commitInRepo, createTransportRepo } from "../interop/helpers.js";

const decoder = new TextDecoder();

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function streamOf(bytes: Uint8Array, chunkSize = 16): ReadableStream<Uint8Array> {
  let pos = 0;
  return new ReadableStream({
    pull(controller) {
      if (pos >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(pos, pos + chunkSize));
      pos += chunkSize;
    },
  });
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = streamOf(bytes, 1024).pipeThrough(
    new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function bodyBytes(response: HttpResponse): Promise<Uint8Array> {
  if (response.body instanceof ReadableStream) {
    return new Uint8Array(await new Response(response.body).arrayBuffer());
  }
  return response.body;
}

/** The pkt-lines of `bytes` as text ("0000"/"0001" for flush/delim; side-band data skipped). */
function pktLines(bytes: Uint8Array): string[] {
  const lines: string[] = [];
  let pos = 0;
  while (pos + 4 <= bytes.length) {
    const len = Number.parseInt(decoder.decode(bytes.subarray(pos, pos + 4)), 16);
    if (len === 0 || len === 1) {
      lines.push(len === 0 ? "0000" : "0001");
      pos += 4;
      continue;
    }
    const payload = bytes.subarray(pos + 4, pos + len);
    pos += len;
    if (payload[0] === 1 || payload[0] === 2 || payload[0] === 3) {
      lines.push(`<band ${payload[0]}>`);
    } else {
      lines.push(decoder.decode(payload).replace(/\n$/, ""));
    }
  }
  return lines;
}

/** A v2 command request: command, capability lines, delimiter, arguments, flush. */
function command(name: string, args: string[]): Uint8Array {
  return concat([
    encodePacketLine(`command=${name}\n`),
    encodePacketLine("agent=git/2.43.0\n"),
    encodePacketLine("object-format=sha1\n"),
    encodeDelim(),
    ...args.map((a) => encodePacketLine(`${a}\n`)),
    encodeFlush(),
  ]);
}

async function setup(maxRequestBodyBytes?: number) {
  const repo = await createTransportRepo();
  const c1 = await commitInRepo(repo, "c1", { "a.txt": "hello\n" });
  const c2 = await commitInRepo(repo, "c2", { "b.txt": "world\n" }, [c1]);
  const c3 = await commitInRepo(repo, "c3", { "c.txt": "again\n" }, [c2]);
  await repo.refStore.update("refs/heads/main", c3);
  await repo.history.refs.setSymbolic("HEAD", "refs/heads/main");
  const logs: string[] = [];
  const handler = createHttpHandler({
    resolveRepository: async (path) =>
      path === "/repo.git" ? { repository: repo.facade, refStore: repo.refStore } : null,
    maxRequestBodyBytes,
    logger: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
  });
  return { repo, handler, logs, c1, c2, c3 };
}

const V2 = { "git-protocol": "version=2" };

function infoRefs(service: string, headers: Record<string, string> = {}): HttpRequest {
  return { method: "GET", path: "/repo.git/info/refs", query: { service }, headers };
}

function post(path: string, body: Uint8Array, headers: Record<string, string> = {}): HttpRequest {
  return { method: "POST", path, query: {}, headers, body: streamOf(body) };
}

describe("Git-Protocol header", () => {
  it("finds version=2 among ':'-separated parameters", () => {
    expect(requestsProtocolV2("version=2")).toBe(true);
    expect(requestsProtocolV2("object-format=sha1:version=2")).toBe(true);
    expect(requestsProtocolV2("version=2:object-format=sha1")).toBe(true);
    expect(requestsProtocolV2("version=1")).toBe(false);
    expect(requestsProtocolV2("version=20")).toBe(false);
    expect(requestsProtocolV2("")).toBe(false);
    expect(requestsProtocolV2(undefined)).toBe(false);
  });
});

describe("smart-HTTP server: protocol v2", () => {
  it("GET /info/refs with Git-Protocol: version=2 sends the v2 capability advertisement", async () => {
    const { handler, repo, c3 } = await setup();
    try {
      const response = await handler(infoRefs("git-upload-pack", { "Git-Protocol": "version=2" }));
      expect(response.status).toBe(200);
      expect(response.headers["Content-Type"]).toBe("application/x-git-upload-pack-advertisement");
      const lines = pktLines(await bodyBytes(response));
      expect(lines.slice(0, 3)).toEqual(["# service=git-upload-pack", "0000", "version 2"]);
      expect(lines).toContain("ls-refs");
      expect(lines).toContain("fetch=shallow wait-for-done");
      expect(lines).toContain("object-info");
      expect(lines.at(-1)).toBe("0000");
      // no refs in a v2 advertisement (ls-refs lists them)
      expect(lines.join("\n")).not.toContain(c3);
    } finally {
      await repo.close();
    }
  });

  it("GET /info/refs without the header stays v0 (refs with capabilities)", async () => {
    const { handler, repo, c3 } = await setup();
    try {
      const lines = pktLines(await bodyBytes(await handler(infoRefs("git-upload-pack"))));
      expect(lines).not.toContain("version 2");
      expect(lines.some((l) => l.startsWith(`${c3} `))).toBe(true);
    } finally {
      await repo.close();
    }
  });

  it("receive-pack stays v0 with Git-Protocol: version=2", async () => {
    const { handler, repo, c3 } = await setup();
    try {
      const response = await handler(infoRefs("git-receive-pack", V2));
      const lines = pktLines(await bodyBytes(response));
      expect(lines[0]).toBe("# service=git-receive-pack");
      expect(lines).not.toContain("version 2");
      expect(lines.some((l) => l.startsWith(`${c3} `))).toBe(true);
    } finally {
      await repo.close();
    }
  });

  it("protocolV2: false answers a v2 request with v0", async () => {
    const repo = await createTransportRepo();
    try {
      const handler = createHttpHandler({
        resolveRepository: async () => ({ repository: repo.facade, refStore: repo.refStore }),
        protocolV2: false,
      });
      const lines = pktLines(await bodyBytes(await handler(infoRefs("git-upload-pack", V2))));
      expect(lines).not.toContain("version 2");
    } finally {
      await repo.close();
    }
  });

  it("POST ls-refs lists refs with symref-target", async () => {
    const { handler, repo, c3, logs } = await setup();
    try {
      const response = await handler(
        post(
          "/repo.git/git-upload-pack",
          command("ls-refs", ["symrefs", "peel", "ref-prefix HEAD", "ref-prefix refs/heads/"]),
          V2,
        ),
      );
      expect(response.status).toBe(200);
      expect(response.headers["Content-Type"]).toBe("application/x-git-upload-pack-result");
      const lines = pktLines(await bodyBytes(response));
      expect(lines).toContain(`${c3} HEAD symref-target:refs/heads/main`);
      expect(lines).toContain(`${c3} refs/heads/main`);
      expect(lines.at(-1)).toBe("0000");
      expect(logs.some((l) => l.includes("protocol: v2"))).toBe(true);
    } finally {
      await repo.close();
    }
  });

  it("POST fetch with done streams the packfile section", async () => {
    const { handler, repo, c3 } = await setup();
    try {
      const response = await handler(
        post(
          "/repo.git/git-upload-pack",
          command("fetch", [`want ${c3}`, "ofs-delta", "no-progress", "done"]),
          V2,
        ),
      );
      expect(response.status).toBe(200);
      // streamed, not buffered
      expect(response.body).toBeInstanceOf(ReadableStream);
      const bytes = await bodyBytes(response);
      const lines = pktLines(bytes);
      expect(lines[0]).toBe("packfile");
      expect(lines).toContain("<band 1>");
      expect(lines.at(-1)).toBe("0000");
      expect(decoder.decode(bytes)).toContain("PACK");
    } finally {
      await repo.close();
    }
  });

  it("negotiates statelessly: each POST stands alone", async () => {
    const { handler, repo, c1, c2, c3 } = await setup();
    try {
      const unknown = "1".repeat(40);
      // round 1: nothing in common yet: acknowledgments with NAK, no pack
      const r1 = pktLines(
        await bodyBytes(
          await handler(
            post(
              "/repo.git/git-upload-pack",
              command("fetch", [`want ${c3}`, `have ${unknown}`]),
              V2,
            ),
          ),
        ),
      );
      expect(r1).toEqual(["acknowledgments", "NAK", "0000"]);

      // round 2 (a fresh request, resending what it knows): c1 is common and reaches the want
      const r2 = pktLines(
        await bodyBytes(
          await handler(
            post(
              "/repo.git/git-upload-pack",
              command("fetch", [`want ${c3}`, `have ${unknown}`, `have ${c1}`]),
              V2,
            ),
          ),
        ),
      );
      expect(r2.slice(0, 5)).toEqual(["acknowledgments", `ACK ${c1}`, "ready", "0001", "packfile"]);

      // the same round sent again gives the same answer: no state was kept
      const r2again = pktLines(
        await bodyBytes(
          await handler(
            post(
              "/repo.git/git-upload-pack",
              command("fetch", [`want ${c3}`, `have ${unknown}`, `have ${c1}`]),
              V2,
            ),
          ),
        ),
      );
      expect(r2again.slice(0, 5)).toEqual(r2.slice(0, 5));

      // a request with wait-for-done never gets "ready"
      const r3 = pktLines(
        await bodyBytes(
          await handler(
            post(
              "/repo.git/git-upload-pack",
              command("fetch", [`want ${c3}`, "wait-for-done", `have ${c2}`]),
              V2,
            ),
          ),
        ),
      );
      expect(r3).toEqual(["acknowledgments", `ACK ${c2}`, "0000"]);
    } finally {
      await repo.close();
    }
  });

  it("answers a shallow fetch with shallow-info", async () => {
    const { handler, repo, c3 } = await setup();
    try {
      const lines = pktLines(
        await bodyBytes(
          await handler(
            post(
              "/repo.git/git-upload-pack",
              command("fetch", [`want ${c3}`, "deepen 1", "done"]),
              V2,
            ),
          ),
        ),
      );
      expect(lines.slice(0, 4)).toEqual(["shallow-info", `shallow ${c3}`, "0001", "packfile"]);
    } finally {
      await repo.close();
    }
  });

  it("refuses an unreachable want with ERR not our ref", async () => {
    const { handler, repo } = await setup();
    try {
      const missing = "2".repeat(40);
      const lines = pktLines(
        await bodyBytes(
          await handler(
            post("/repo.git/git-upload-pack", command("fetch", [`want ${missing}`, "done"]), V2),
          ),
        ),
      );
      expect(lines[0]).toMatch(/^ERR .*not our ref/);
    } finally {
      await repo.close();
    }
  });

  it("POST object-info sends object sizes", async () => {
    const { handler, repo, c3 } = await setup();
    try {
      const lines = pktLines(
        await bodyBytes(
          await handler(
            post("/repo.git/git-upload-pack", command("object-info", ["size", `oid ${c3}`]), V2),
          ),
        ),
      );
      expect(lines[0]).toBe("size");
      expect(lines[1]).toMatch(new RegExp(`^${c3} \\d+$`));
    } finally {
      await repo.close();
    }
  });

  it("accepts a gzip v2 request body", async () => {
    const { handler, repo, c3 } = await setup();
    try {
      const body = await gzip(command("ls-refs", ["ref-prefix refs/heads/"]));
      const lines = pktLines(
        await bodyBytes(
          await handler(
            post("/repo.git/git-upload-pack", body, { ...V2, "content-encoding": "gzip" }),
          ),
        ),
      );
      expect(lines).toEqual([`${c3} refs/heads/main`, "0000"]);
    } finally {
      await repo.close();
    }
  });

  it("answers 413 for a v2 request body over the limit", async () => {
    const { handler, repo, c3 } = await setup(256);
    try {
      const haves = Array.from(
        { length: 20 },
        (_, i) => `have ${i.toString(16).padStart(40, "0")}`,
      );
      const response = await handler(
        post("/repo.git/git-upload-pack", command("fetch", [`want ${c3}`, ...haves]), V2),
      );
      expect(response.status).toBe(413);
    } finally {
      await repo.close();
    }
  });

  it("answers 500 for an unknown v2 command (nothing written yet)", async () => {
    const { handler, repo } = await setup();
    try {
      const response = await handler(
        post("/repo.git/git-upload-pack", command("bundle-uri", []), V2),
      );
      expect(response.status).toBe(500);
      expect(decoder.decode(await bodyBytes(response))).toContain("Unknown command");
    } finally {
      await repo.close();
    }
  });
});
