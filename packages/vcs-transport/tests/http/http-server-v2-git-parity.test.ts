/**
 * Smart-HTTP protocol v2 as git's http-backend answers it (regressions from the review of the
 * v2 server, checked against `git http-backend`): failures after the first byte are visible,
 * `ls-refs=unborn`, object-info's wire format, no service preamble in the v2 advertisement,
 * git's no-cache headers, strict request parsing (one exact command per POST, object-format,
 * the `Git-Protocol` list), and a cancelled response body ends the pack source.
 */

import { describe, expect, it } from "vitest";

import {
  createHttpHandler,
  type HttpRequest,
  type HttpResponse,
  requestsProtocolV2,
  SERVER_V2_CAPABILITIES,
} from "../../src/index.js";
import { encodeDelim, encodeFlush, encodePacketLine } from "../../src/protocol/pkt-line-codec.js";
import { commitInRepo, createTransportRepo, type TransportRepo } from "../interop/helpers.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** A pkt-line as git writes it with `packet_write_fmt` (no newline added). */
function pkt(text: string): string {
  return (text.length + 4).toString(16).padStart(4, "0") + text;
}

async function bodyText(response: HttpResponse): Promise<string> {
  const bytes =
    response.body instanceof ReadableStream
      ? new Uint8Array(await new Response(response.body).arrayBuffer())
      : response.body;
  return decoder.decode(bytes);
}

/** The pkt-lines of a response body ("0000"/"0001" for flush/delim; band packets as `<band N>`). */
function pktLines(text: string): string[] {
  const bytes = encoder.encode(text);
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
    if (payload[0] === 1 || payload[0] === 2 || payload[0] === 3)
      lines.push(`<band ${payload[0]}>`);
    else lines.push(decoder.decode(payload).replace(/\n$/, ""));
  }
  return lines;
}

function command(name: string, args: string[], caps = ["agent=git/2.43.0"]): Uint8Array {
  return concat([
    encodePacketLine(`command=${name}\n`),
    ...caps.map((c) => encodePacketLine(`${c}\n`)),
    encodeDelim(),
    ...args.map((a) => encodePacketLine(`${a}\n`)),
    encodeFlush(),
  ]);
}

const V2 = { "git-protocol": "version=2" };

function post(body: Uint8Array, headers: Record<string, string> = V2): HttpRequest {
  return {
    method: "POST",
    path: "/repo.git/git-upload-pack",
    query: {},
    headers,
    body: new Response(body).body as ReadableStream<Uint8Array>,
  };
}

function infoRefs(service: string, headers: Record<string, string> = {}): HttpRequest {
  return { method: "GET", path: "/repo.git/info/refs", query: { service }, headers };
}

async function setup(
  configure?: (repo: TransportRepo) => Partial<Parameters<typeof createHttpHandler>[0]>,
) {
  const repo = await createTransportRepo();
  const c1 = await commitInRepo(repo, "c1", { "a.txt": "hello\n" });
  const c2 = await commitInRepo(repo, "c2", { "b.txt": "world\n" }, [c1]);
  await repo.refStore.update("refs/heads/main", c2);
  await repo.history.refs.setSymbolic("HEAD", "refs/heads/main");
  const handler = createHttpHandler({
    resolveRepository: async () => ({ repository: repo.facade, refStore: repo.refStore }),
    ...configure?.(repo),
  });
  return { repo, handler, c1, c2 };
}

const GIT_NO_CACHE = {
  Expires: "Fri, 01 Jan 1980 00:00:00 GMT",
  Pragma: "no-cache",
  "Cache-Control": "no-cache, max-age=0, must-revalidate",
};

describe("v2 over HTTP: a failure after the first byte is visible", () => {
  it("ls-refs failing mid-list ends with an in-band ERR, not a clean truncated listing", async () => {
    const { repo, handler } = await setup((repo) => {
      let calls = 0;
      const refStore = {
        ...repo.refStore,
        getSymrefTarget: async (name: string) => {
          if (++calls === 2) throw new Error("backend down");
          return repo.refStore.getSymrefTarget?.(name);
        },
      };
      return { resolveRepository: async () => ({ repository: repo.facade, refStore }) };
    });
    try {
      const response = await handler(post(command("ls-refs", ["symrefs"])));
      expect(response.status).toBe(200);
      const lines = pktLines(await bodyText(response));
      expect(lines.some((l) => /^ERR .*backend down/.test(l))).toBe(true);
    } finally {
      await repo.close();
    }
  });

  it("object-info failing after its first line ends with an in-band ERR", async () => {
    const { repo, handler, c1, c2 } = await setup((repo) => {
      let calls = 0;
      const facade = Object.create(repo.facade);
      facade.getObjectSize = async (oid: string) => {
        if (++calls === 2) throw new Error("object store down");
        return repo.facade.getObjectSize?.(oid) ?? null;
      };
      return {
        resolveRepository: async () => ({ repository: facade, refStore: repo.refStore }),
      };
    });
    try {
      const response = await handler(
        post(command("object-info", ["size", `oid ${c1}`, `oid ${c2}`])),
      );
      expect(response.status).toBe(200);
      const lines = pktLines(await bodyText(response));
      expect(lines.some((l) => /^ERR .*object store down/.test(l))).toBe(true);
    } finally {
      await repo.close();
    }
  });
});

describe("v2 over HTTP: cancelling the response body", () => {
  for (const version of ["2", "0"]) {
    it(`ends the pack source (protocol v${version})`, async () => {
      const { repo, handler, c2 } = await setup();
      try {
        let finalized = false;
        repo.facade.exportPack = async function* () {
          try {
            while (true) {
              yield new Uint8Array(1000);
              await new Promise((r) => setTimeout(r, 1));
            }
          } finally {
            finalized = true;
          }
        } as typeof repo.facade.exportPack;
        const body =
          version === "2"
            ? command("fetch", [`want ${c2}`, "done"])
            : concat([
                encodePacketLine(`want ${c2} side-band-64k ofs-delta\n`),
                encodeFlush(),
                encodePacketLine("done\n"),
              ]);
        const response = await handler(post(body, version === "2" ? V2 : {}));
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        for (let i = 0; i < 3; i++) await reader.read();
        await reader.cancel("client gone");
        for (let i = 0; i < 50 && !finalized; i++) await new Promise((r) => setTimeout(r, 20));
        expect(finalized).toBe(true);
      } finally {
        await repo.close();
      }
    });
  }
});

describe("v2 over HTTP: ls-refs unborn", () => {
  it("advertises ls-refs=unborn as git does", () => {
    expect(SERVER_V2_CAPABILITIES).toContain("ls-refs=unborn");
    expect(SERVER_V2_CAPABILITIES).not.toContain("ls-refs");
  });

  it("sends `unborn HEAD symref-target:<ref>` for an empty repository", async () => {
    const repo = await createTransportRepo();
    try {
      await repo.history.refs.setSymbolic("HEAD", "refs/heads/trunk");
      const handler = createHttpHandler({
        resolveRepository: async () => ({ repository: repo.facade, refStore: repo.refStore }),
      });
      const text = await bodyText(
        await handler(post(command("ls-refs", ["symrefs", "peel", "unborn", "ref-prefix HEAD"]))),
      );
      expect(text).toBe(`${pkt("unborn HEAD symref-target:refs/heads/trunk\n")}0000`);
      // git sends the unborn HEAD only with symrefs
      const noSymrefs = await bodyText(await handler(post(command("ls-refs", ["unborn"]))));
      expect(noSymrefs).toBe("0000");
    } finally {
      await repo.close();
    }
  });

  it("sends the unborn HEAD first when other refs exist", async () => {
    const { repo, handler, c2 } = await setup();
    try {
      await repo.history.refs.setSymbolic("HEAD", "refs/heads/trunk");
      const lines = pktLines(
        await bodyText(await handler(post(command("ls-refs", ["symrefs", "unborn"])))),
      );
      expect(lines).toEqual([
        "unborn HEAD symref-target:refs/heads/trunk",
        `${c2} refs/heads/main`,
        "0000",
      ]);
    } finally {
      await repo.close();
    }
  });
});

describe("v2 over HTTP: object-info as git writes it", () => {
  it("one line per requested oid, a missing one as `<oid> `, no newlines", async () => {
    const { repo, handler, c2 } = await setup();
    try {
      const size = await repo.facade.getObjectSize?.(c2);
      const missing = "1".repeat(40);
      const text = await bodyText(
        await handler(post(command("object-info", ["size", `oid ${c2}`, `oid ${missing}`]))),
      );
      expect(text).toBe(`${pkt("size")}${pkt(`${c2} ${size}`)}${pkt(`${missing} `)}0000`);
    } finally {
      await repo.close();
    }
  });

  it("sends sizes only when the size attribute is requested", async () => {
    const { repo, handler, c2 } = await setup();
    try {
      const text = await bodyText(await handler(post(command("object-info", [`oid ${c2}`]))));
      expect(text).toBe(`${pkt(c2)}0000`);
      // no oid: nothing but the flush
      expect(await bodyText(await handler(post(command("object-info", ["size"]))))).toBe("0000");
    } finally {
      await repo.close();
    }
  });

  it("answers a malformed oid with ERR and goes on", async () => {
    const { repo, handler, c2 } = await setup();
    try {
      const size = await repo.facade.getObjectSize?.(c2);
      const text = await bodyText(
        await handler(post(command("object-info", ["size", "oid xyz", `oid ${c2}`]))),
      );
      expect(text).toBe(
        `${pkt("size")}${pkt("ERR object-info: protocol error, expected to get oid, not 'xyz'")}${pkt(`${c2} ${size}`)}0000`,
      );
    } finally {
      await repo.close();
    }
  });
});

describe("v2 over HTTP: advertisement and headers as git's http-backend", () => {
  it("the v2 info/refs has no `# service=` preamble", async () => {
    const { repo, handler } = await setup();
    try {
      const lines = pktLines(await bodyText(await handler(infoRefs("git-upload-pack", V2))));
      expect(lines[0]).toBe("version 2");
      expect(lines).toContain("ls-refs=unborn");
    } finally {
      await repo.close();
    }
  });

  it("sends git's no-cache headers on info/refs and rpc responses, v0 and v2", async () => {
    const { repo, handler, c2 } = await setup();
    try {
      const responses = [
        await handler(infoRefs("git-upload-pack", V2)),
        await handler(infoRefs("git-upload-pack")),
        await handler(infoRefs("git-receive-pack")),
        await handler(post(command("ls-refs", []))),
        await handler(
          post(
            concat([
              encodePacketLine(`want ${c2} side-band-64k\n`),
              encodeFlush(),
              encodePacketLine("done\n"),
            ]),
            {},
          ),
        ),
        await handler({
          method: "POST",
          path: "/repo.git/git-receive-pack",
          query: {},
          headers: {},
          body: new Response(encodeFlush()).body as ReadableStream<Uint8Array>,
        }),
      ];
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.headers).toMatchObject(GIT_NO_CACHE);
        await bodyText(response);
      }
    } finally {
      await repo.close();
    }
  });
});

describe("v2 over HTTP: strict request parsing as git's serve.c", () => {
  it("`command=` must name a command exactly", async () => {
    const { repo, handler } = await setup();
    try {
      const response = await handler(post(command("ls-refsX", [])));
      expect(response.status).toBe(500);
      expect(await bodyText(response)).toContain("invalid command 'ls-refsX'");
    } finally {
      await repo.close();
    }
  });

  it("refuses a command the server does not advertise", async () => {
    const { repo, handler } = await setup(() => ({
      v2Capabilities: ["agent=x", "ls-refs", "fetch"],
    }));
    try {
      const response = await handler(post(command("object-info", ["size"])));
      expect(response.status).toBe(500);
      expect(await bodyText(response)).toContain("invalid command 'object-info'");
    } finally {
      await repo.close();
    }
  });

  it("runs only the first command of a POST (stateless-rpc)", async () => {
    const { repo, handler, c2 } = await setup();
    try {
      const one = command("ls-refs", ["ref-prefix refs/heads/"]);
      const text = await bodyText(await handler(post(concat([one, one]))));
      expect(text).toBe(`${pkt(`${c2} refs/heads/main\n`)}0000`);
    } finally {
      await repo.close();
    }
  });

  it("takes capability lines before the command, and a command without arguments", async () => {
    const { repo, handler, c2 } = await setup();
    try {
      const body = concat([
        encodePacketLine("agent=git/2.43.0\n"),
        encodePacketLine("command=ls-refs\n"),
        encodeFlush(),
      ]);
      const lines = pktLines(await bodyText(await handler(post(body))));
      expect(lines).toEqual([`${c2} HEAD`, `${c2} refs/heads/main`, "0000"]);
    } finally {
      await repo.close();
    }
  });

  it("refuses capabilities without a command", async () => {
    const { repo, handler } = await setup();
    try {
      const body = concat([encodePacketLine("agent=git/2.43.0\n"), encodeFlush()]);
      const response = await handler(post(body));
      expect(response.status).toBe(500);
      expect(await bodyText(response)).toContain("no command requested");
    } finally {
      await repo.close();
    }
  });

  it("refuses an object-format other than the server's", async () => {
    const { repo, handler } = await setup();
    try {
      const response = await handler(post(command("ls-refs", [], ["object-format=sha256"])));
      expect(response.status).toBe(500);
      expect(await bodyText(response)).toContain(
        "mismatched object format: server sha1; client sha256",
      );
      const unknown = await handler(post(command("ls-refs", [], ["object-format=md5"])));
      expect(unknown.status).toBe(500);
      expect(await bodyText(unknown)).toContain("unknown object format 'md5'");
      const same = await handler(post(command("ls-refs", [], ["object-format=sha1"])));
      expect(same.status).toBe(200);
      await bodyText(same);
    } finally {
      await repo.close();
    }
  });

  it("splits Git-Protocol on ':' exactly, without trimming", () => {
    expect(requestsProtocolV2("foo : version=2")).toBe(false);
    expect(requestsProtocolV2(" version=2")).toBe(false);
    expect(requestsProtocolV2("version=2 ")).toBe(false);
    expect(requestsProtocolV2("version=1:version=2")).toBe(true);
    expect(requestsProtocolV2("version=2:foo=bar")).toBe(true);
  });
});
