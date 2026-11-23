/**
 * The `object-format` capability as git's servers send and check it (upload-pack.c's
 * send_ref, receive-pack.c's show_ref and read_head_info, serve.c's object_format_advertise
 * and process_request): a SHA-256 repository advertises `object-format=sha256` in v0 (before
 * `agent=`) and v2, an empty one a 64-zero `capabilities^{}` line; a SHA-1 repository's v0
 * advertisement keeps its bytes (no `object-format`), its v2 one `object-format=sha1`; a
 * client of another format is refused.
 */
import { createMemoryHistory } from "@statewalker/vcs-core";
import { SHA1_OBJECT_FORMAT, SHA256_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";
import { describe, expect, it } from "vitest";

import {
  createHttpHandler,
  createRepositoryFacade,
  type HttpRequest,
  type HttpResponse,
  remoteObjectFormat,
  v0ObjectFormatCapabilities,
  v2ObjectFormatCapabilities,
} from "../src/index.js";
import { encodeDelim, encodeFlush, encodePacketLine } from "../src/protocol/pkt-line-codec.js";
import { createTransportRefStore } from "./interop/helpers.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function bodyText(response: HttpResponse): Promise<string> {
  const bytes =
    response.body instanceof ReadableStream
      ? new Uint8Array(await new Response(response.body).arrayBuffer())
      : response.body;
  return decoder.decode(bytes);
}

/** The pkt-lines of a body ("0000" for a flush), newlines dropped. */
function pktLines(text: string): string[] {
  const bytes = encoder.encode(text);
  const lines: string[] = [];
  for (let pos = 0; pos + 4 <= bytes.length; ) {
    const len = Number.parseInt(decoder.decode(bytes.subarray(pos, pos + 4)), 16);
    if (len <= 1) {
      lines.push(len === 0 ? "0000" : "0001");
      pos += 4;
      continue;
    }
    lines.push(decoder.decode(bytes.subarray(pos + 4, pos + len)).replace(/\n$/, ""));
    pos += len;
  }
  return lines;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const infoRefs = (service: string, headers: Record<string, string> = {}): HttpRequest => ({
  method: "GET",
  path: "/repo.git/info/refs",
  query: { service },
  headers,
});

const post = (service: string, body: Uint8Array, headers: Record<string, string> = {}) =>
  ({
    method: "POST",
    path: `/repo.git/${service}`,
    query: {},
    headers,
    body: new Response(body as BodyInit).body as ReadableStream<Uint8Array>,
  }) as HttpRequest;

async function served(format: typeof SHA1_OBJECT_FORMAT, withCommit: boolean) {
  const history = createMemoryHistory({ objectFormat: format });
  await history.initialize();
  let commit: string | undefined;
  if (withCommit) {
    const blob = await history.blobs.store([encoder.encode("hello\n")]);
    const tree = await history.trees.store([{ name: "a.txt", mode: 0o100644, id: blob }]);
    const who = { name: "T", email: "t@example.com", timestamp: 1700000000, tzOffset: "+0000" };
    commit = await history.commits.store({
      tree,
      parents: [],
      author: who,
      committer: who,
      message: "c1\n",
    });
    await history.refs.set("refs/heads/main", commit);
  }
  await history.refs.setSymbolic("HEAD", "refs/heads/main");
  const repository = createRepositoryFacade({ history });
  const refStore = createTransportRefStore(history.refs);
  const handler = createHttpHandler({
    resolveRepository: async () => ({ repository, refStore }),
  });
  return { handler, commit, repository };
}

describe("object-format in the advertisements", () => {
  it("a SHA-256 repository names its hash in v0, before agent, as upload-pack and receive-pack do", async () => {
    const { handler, commit, repository } = await served(SHA256_OBJECT_FORMAT, true);
    expect(repository.objectFormat?.name).toBe("sha256");
    for (const service of ["git-upload-pack", "git-receive-pack"]) {
      const lines = pktLines(await bodyText(await handler(infoRefs(service))));
      const first = lines.find((l) => l.includes("\0")) as string;
      expect(first.slice(0, 65)).toBe(`${commit} `);
      const caps = first.slice(first.indexOf("\0") + 1).split(" ");
      expect(caps).toContain("object-format=sha256");
      expect(caps.at(-1)).toBe("object-format=sha256");
    }
    expect(v0ObjectFormatCapabilities(["ofs-delta", "agent=x"], SHA256_OBJECT_FORMAT)).toEqual([
      "ofs-delta",
      "object-format=sha256",
      "agent=x",
    ]);
  });

  it("an empty SHA-256 repository sends a 64-zero capabilities^{} line", async () => {
    const { handler } = await served(SHA256_OBJECT_FORMAT, false);
    for (const service of ["git-upload-pack", "git-receive-pack"]) {
      const lines = pktLines(await bodyText(await handler(infoRefs(service))));
      const first = lines.find((l) => l.includes("\0")) as string;
      expect(first.startsWith(`${"0".repeat(64)} capabilities^{}\0`)).toBe(true);
      expect(first).toContain("object-format=sha256");
    }
  });

  it("v2 names the repository's hash: sha256, and sha1 as before", async () => {
    const v2 = { "git-protocol": "version=2" };
    const sha256 = await served(SHA256_OBJECT_FORMAT, true);
    expect(
      pktLines(await bodyText(await sha256.handler(infoRefs("git-upload-pack", v2)))),
    ).toContain("object-format=sha256");
    const sha1 = await served(SHA1_OBJECT_FORMAT, true);
    const lines = pktLines(await bodyText(await sha1.handler(infoRefs("git-upload-pack", v2))));
    expect(lines).toContain("object-format=sha1");
    expect(lines.filter((l) => l.startsWith("object-format="))).toHaveLength(1);
    expect(v2ObjectFormatCapabilities(["a", "object-format=sha1"], SHA256_OBJECT_FORMAT)).toEqual([
      "a",
      "object-format=sha256",
    ]);
  });

  it("a SHA-1 repository's v0 advertisement names no object format (its bytes unchanged)", async () => {
    const { handler } = await served(SHA1_OBJECT_FORMAT, true);
    for (const service of ["git-upload-pack", "git-receive-pack"]) {
      const text = await bodyText(await handler(infoRefs(service)));
      expect(text).not.toContain("object-format");
    }
  });

  it("the client reads the server's hash from its capabilities (SHA-1 without one)", () => {
    expect(remoteObjectFormat(new Map([["object-format", "sha256"]]))?.name).toBe("sha256");
    expect(remoteObjectFormat(new Map())?.name).toBe("sha1");
    expect(remoteObjectFormat(new Map([["object-format", "md5"]]))).toBeUndefined();
  });
});

describe("a client of another hash is refused", () => {
  it("v2: a SHA-1 request (named or implied) to a SHA-256 server, as serve.c", async () => {
    const { handler, commit } = await served(SHA256_OBJECT_FORMAT, true);
    const v2 = { "git-protocol": "version=2" };
    for (const caps of [["object-format=sha1"], []]) {
      const body = concat([
        encodePacketLine("command=ls-refs\n"),
        ...caps.map((c) => encodePacketLine(`${c}\n`)),
        encodeDelim(),
        encodeFlush(),
      ]);
      const response = await handler(post("git-upload-pack", body, v2));
      expect(await bodyText(response)).toContain(
        "mismatched object format: server sha256; client sha1",
      );
    }
    const ok = concat([
      encodePacketLine("command=ls-refs\n"),
      encodePacketLine("object-format=sha256\n"),
      encodeDelim(),
      encodeFlush(),
    ]);
    const response = await handler(post("git-upload-pack", ok, v2));
    expect(response.status).toBe(200);
    expect(pktLines(await bodyText(response))).toContain(`${commit} refs/heads/main`);
  });

  it("receive-pack: commands without object-format=sha256 die as read_head_info", async () => {
    const { handler, commit } = await served(SHA256_OBJECT_FORMAT, true);
    const zero = "0".repeat(64);
    const body = concat([
      encodePacketLine(`${commit} ${zero} refs/heads/main\0report-status\n`),
      encodeFlush(),
    ]);
    const response = await handler(post("git-receive-pack", body));
    const text = await bodyText(response);
    expect(response.status).toBe(400);
    expect(text).toBe("error: unsupported object format 'sha1'");
  });
});
