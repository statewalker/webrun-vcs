/**
 * The dumb HTTP client's parsers: remote-curl's `parse_info_refs` (ids, peeled tags, the hash
 * told by the first id's length) and http-walker's alternates lines
 * (`process_alternates_response`). The walk itself is checked against native git in
 * vcs-commands' `http-dumb-client-native.test.ts` (t5550).
 */
import { describe, expect, it } from "vitest";
import {
  alternateTargets,
  looksLikeInfoRefs,
  openHttpConnection,
  parseInfoRefs,
} from "../src/index.js";

const enc = (text: string) => new TextEncoder().encode(text);
const A = "a".repeat(40);
const B = "b".repeat(40);

describe("parseInfoRefs", () => {
  it("lists each ref, a ^{} line peeling the tag before it", () => {
    const parsed = parseInfoRefs(
      enc(`${A}\trefs/heads/main\n${B}\trefs/tags/v1\n${A}\trefs/tags/v1^{}\n`),
      "http://h/r.git",
    );
    expect(parsed.objectFormat.name).toBe("sha1");
    expect(parsed.refs).toEqual([
      { name: "refs/heads/main", oid: A },
      { name: "refs/tags/v1", oid: B, peeled: A },
    ]);
  });

  it("tells SHA-256 by the id's length; no refs is SHA-1", () => {
    const id = "c".repeat(64);
    expect(parseInfoRefs(enc(`${id}\trefs/heads/main\n`), "http://h/r").objectFormat.name).toBe(
      "sha256",
    );
    expect(parseInfoRefs(enc(""), "http://h/r")).toEqual(expect.objectContaining({ refs: [] }));
  });

  it("dies on a line of another length, as git", () => {
    expect(() => parseInfoRefs(enc(`${A}\tx\nabc\ty\n`), "http://u:p@h/r.git")).toThrow(
      "fatal: http://h/r.git/info/refs not valid: is this a git repository?",
    );
    expect(() => parseInfoRefs(enc("abc\tx\n"), "http://h/r.git")).toThrow(
      "could not determine hash algorithm",
    );
  });

  it("an answer is info/refs when empty or starting with an id and a tab", () => {
    expect(looksLikeInfoRefs(enc(""))).toBe(true);
    expect(looksLikeInfoRefs(enc(`${A}\trefs/heads/main\n`))).toBe(true);
    expect(looksLikeInfoRefs(enc(`003f${A} HEAD\0caps\n0000`))).toBe(false);
    expect(looksLikeInfoRefs(enc("001e# service=git-upload-pack\n0000"))).toBe(false);
  });
});

describe("alternateTargets (http-walker's process_alternates_response)", () => {
  const base = "http://git.host/pub/scm/linux.git";

  it("../ drops one path part fewer than it names", () => {
    expect(alternateTargets(base, "../../linus.git/objects\n", false)).toEqual([
      "http://git.host/pub/scm/linus.git/objects",
    ]);
    // one ../ alone drops nothing: appended to the base as written
    expect(alternateTargets(base, "../objects\n", false)).toEqual([`${base}objects`]);
  });

  it("/ is on the base's server", () => {
    expect(alternateTargets(base, "/other.git/objects\n", false)).toEqual([
      "http://git.host/other.git/objects",
    ]);
    expect(alternateTargets("http://h:1", "/dumb/r.git/objects\n", false)).toEqual([
      "http://h:1/dumb/r.git/objects",
    ]);
  });

  it("URLs only from http-alternates; lines without a newline are not read", () => {
    const data = "https://mirror/x.git/objects\n/a/objects";
    expect(alternateTargets(base, data, true)).toEqual(["https://mirror/x.git/objects"]);
    expect(alternateTargets(base, data, false)).toEqual([]);
  });

  it("a ../ climbing past the server is dropped", () => {
    expect(alternateTargets("http://h/r.git", "../../../../x/objects\n", false)).toEqual([]);
  });
});

describe("credentials of a dumb connection", () => {
  it("a first request redirected to another origin takes no credentials along", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = async (request: Request): Promise<Response> => {
      seen.push({ url: request.url, authorization: request.headers.get("authorization") });
      const url = new URL(request.url);
      if (url.pathname.endsWith("/info/refs")) {
        // where the redirect led (fetch dropped the header on the way, as it does)
        const response = new Response(`${A}\trefs/heads/main\n`, {
          headers: { "content-type": "text/plain" },
        });
        Object.defineProperty(response, "url", {
          value: "https://evil.example/repo/info/refs?service=git-upload-pack",
        });
        return response;
      }
      return new Response("ref: refs/heads/main\n", { headers: { "content-type": "text/plain" } });
    };
    const connection = await openHttpConnection({
      url: "https://good.example/repo",
      fetchImpl,
      auth: { username: "u", password: "secret" },
    });
    expect(connection.dumb?.baseUrl).toBe("https://evil.example/repo");
    expect(connection.advertisedRefs?.[0]).toEqual({
      name: "HEAD",
      oid: A,
      symref: "refs/heads/main",
    });
    // the first request went where the user asked, with credentials; HEAD went elsewhere
    expect(seen[0]?.authorization).not.toBeNull();
    expect(seen.slice(1)).toEqual([{ url: "https://evil.example/repo/HEAD", authorization: null }]);
  });
});
