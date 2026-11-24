import { describe, expect, it } from "vitest";
import {
  isUrlNormalizeError,
  type NormalizedUrl,
  normalizeUrl,
  selectUrlMatches,
} from "../../src/url/index.js";

const norm = (url: string, allowGlobs = false): NormalizedUrl => {
  const n = normalizeUrl(url, { allowGlobs });
  if (isUrlNormalizeError(n)) throw new Error(n.error);
  return n;
};

describe("normalizeUrl (urlmatch.c url_normalize)", () => {
  it("lowers scheme and host, drops default ports, resolves dot segments, fixes escapes", () => {
    expect(norm("HTTPS://User@Example.COM:443/a/./b/../c").url).toBe(
      "https://User@example.com/a/c",
    );
    expect(norm("http://x:0080").url).toBe("http://x/");
    expect(norm("http://x:8080/%7e%2F%41 b").url).toBe("http://x:8080/~%2FA%20b");
    expect(norm("file:///tmp/x").url).toBe("file:///tmp/x");
  });

  it("refuses what git refuses, with git's reasons", () => {
    const error = (url: string) => {
      const n = normalizeUrl(url);
      return isUrlNormalizeError(n) ? n.error : undefined;
    };
    expect(error("example.com")).toBe("invalid URL scheme name or missing '://' suffix");
    expect(error("https://")).toBe("missing host and scheme is not 'file:'");
    expect(error("https://a b/")).toBe("invalid characters in host name");
    expect(error("https://x:70000/")).toBe("invalid port number");
    expect(error("https://x/%zz")).toBe("invalid %XX escape sequence");
    expect(error("https://x/..")).toBe("invalid '..' path segment");
    expect(error("file://:22/x")).toBe("a 'file:' URL may not have a port number");
    expect(error("https://*.x")).toBe("invalid characters in host name");
    expect(isUrlNormalizeError(normalizeUrl("https://*.x", { allowGlobs: true }))).toBe(false);
  });
});

describe("selectUrlMatches (urlmatch_config_entry)", () => {
  const entries = [
    { key: "http.sslverify", value: "plain" },
    { key: "http.https://example.com/.cookiefile", value: "root" },
    { key: "http.https://example.com/sub.cookiefile", value: "sub" },
    { key: "http.https://user@example.com/.cookiefile", value: "user" },
    { key: "http.https://*.example.com.cookiefile", value: "wildcard" },
    { key: "http.https://example.com.sslverify", value: "host" },
  ];
  const pick = (url: string, key?: string) =>
    Object.fromEntries(
      [...selectUrlMatches(entries, "http", norm(url), key)].map(([k, e]) => [k, e.value]),
    );

  it("prefers the longest host, then the longest path, then a user", () => {
    expect(pick("https://example.com/sub/x")).toEqual({
      "http.cookiefile": "sub",
      "http.sslverify": "host",
    });
    expect(pick("https://user@example.com/")).toEqual({
      "http.cookiefile": "user",
      "http.sslverify": "host",
    });
    expect(pick("https://a.example.com/", "cookiefile")).toEqual({ "http.cookiefile": "wildcard" });
    expect(pick("https://other.org/")).toEqual({ "http.sslverify": "plain" });
  });
});
