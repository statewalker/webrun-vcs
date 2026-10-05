import { describe, expect, it } from "vitest";
import { fetch as fetchPack } from "../../src/operations/fetch.js";
import { lsRemote } from "../../src/operations/ls-remote.js";

const enc = new TextEncoder();
const pkt = (line: string) =>
  `${(enc.encode(line).length + 4).toString(16).padStart(4, "0")}${line}`;

const HEAD = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";
const TEST = "b3cbd5bbd7e81436d2eee04537ea2b4c0cad4cdf";

/** An /info/refs answer laid out as GitHub sends it: service line, flush, refs, flush. */
const advertisement =
  pkt("# service=git-upload-pack\n") +
  "0000" +
  pkt(
    `${HEAD} HEAD\0multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag symref=HEAD:refs/heads/master\n`,
  ) +
  pkt(`${HEAD} refs/heads/master\n`) +
  pkt(`${TEST} refs/heads/test\n`) +
  "0000";

/** A fake server: answers /info/refs and records the upload-pack request body. */
function fakeServer() {
  const requests: string[] = [];
  const fetchImpl = async (request: Request): Promise<Response> => {
    if (request.url.endsWith("/info/refs?service=git-upload-pack"))
      return new Response(advertisement);
    requests.push(new TextDecoder().decode(await request.arrayBuffer()));
    return new Response("0008NAK\n");
  };
  return { fetchImpl, requests };
}

describe("smart-HTTP operations against a real-format advertisement", () => {
  it("lsRemote reads the first ref after the service line's flush correctly", async () => {
    const { fetchImpl } = fakeServer();
    const refs = await lsRemote("https://example.test/repo.git", { fetchImpl });
    expect(refs.get("HEAD")).toBe(HEAD);
    expect(refs.get("refs/heads/master")).toBe(HEAD);
    expect(refs.get("refs/heads/test")).toBe(TEST);
  });

  it("a fetch without haves sends wants, one flush, then done", async () => {
    const { fetchImpl, requests } = fakeServer();
    await fetchPack({ url: "https://example.test/repo.git", fetchImpl }).catch(() => {});
    const body = requests[0] ?? "";
    expect(body).toMatch(/^[0-9a-f]{4}want /);
    // A second flush before `done` ends the negotiation: the server answers NAK and sends no pack.
    expect(body).not.toContain("00000000");
    expect(body.endsWith(`0000${pkt("done\n")}`)).toBe(true);
  });
});
