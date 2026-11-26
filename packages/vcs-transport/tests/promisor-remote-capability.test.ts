/**
 * The v2 `promisor-remote` capability's value as promisor-remote.c writes and reads it
 * (t5710-promisor-remote-capability.sh: "clone with promisor.sendFields" shows the encoding).
 */
import { describe, expect, it } from "vitest";
import {
  encodePromisorRemoteInfo,
  encodePromisorRemoteNames,
  parsePromisorRemoteInfo,
  parsePromisorRemoteNames,
  promisorRemoteAdvertisement,
  serverV2Capabilities,
} from "../src/index.js";

/** A config reader over `[key, value]` pairs in file order. */
function config(entries: [string, string][]) {
  const lower = (k: string) => {
    const first = k.indexOf(".");
    const last = k.lastIndexOf(".");
    return first === last
      ? k.toLowerCase()
      : `${k.slice(0, first).toLowerCase()}${k.slice(first, last)}${k.slice(last).toLowerCase()}`;
  };
  return {
    getAll: (key: string) => entries.filter(([k]) => lower(k) === lower(key)).map(([, v]) => v),
    list: () => entries.map(([key, value]) => ({ key: lower(key), value })),
  };
}

describe("promisor-remote capability value", () => {
  it("url-encodes `,`, `;`, `%`, spaces and non-ASCII (allow_unsanitized)", () => {
    const info = encodePromisorRemoteInfo([
      { name: "lop", url: "file:///a b/c,d;e%f", filter: "blob:none" },
      { name: "other", url: "https://invalid.invalid", filter: "blob:limit=10k", token: "fooBar" },
    ]);
    expect(info).toBe(
      "name=lop,url=file:///a%20b/c%2Cd%3Be%25f,partialCloneFilter=blob:none;" +
        "name=other,url=https://invalid.invalid,partialCloneFilter=blob:limit=10k,token=fooBar",
    );
    expect(parsePromisorRemoteInfo(info).remotes).toEqual([
      { name: "lop", url: "file:///a b/c,d;e%f", filter: "blob:none" },
      { name: "other", url: "https://invalid.invalid", filter: "blob:limit=10k", token: "fooBar" },
    ]);
    expect(encodePromisorRemoteNames(["lop", "a;b"])).toBe("lop;a%3Bb");
    expect(parsePromisorRemoteNames("lop;a%3Bb")).toEqual(["lop", "a;b"]);
  });

  it("drops a remote without a name or URL, with git's warnings", () => {
    const parsed = parsePromisorRemoteInfo("name=a,url=;junk,name=b,url=u");
    expect(parsed.remotes).toEqual([{ name: "b", url: "u" }]);
    expect(parsed.warnings).toEqual([
      "server advertised a promisor remote without a name or URL: 'name=a,url=', ignoring this remote",
      "invalid element 'junk' from remote info",
    ]);
  });

  it("promisor_remote_info: promisor remotes with a URL, sendFields, advertise off by default", () => {
    const entries: [string, string][] = [
      ["remote.lop.url", "file:///lop"],
      ["remote.lop.promisor", "true"],
      ["remote.lop.partialCloneFilter", "blob:none"],
      ["remote.lop.token", "t"],
      ["remote.nourl.promisor", "true"],
      ["remote.plain.url", "file:///plain"],
    ];
    expect(promisorRemoteAdvertisement(config(entries))).toBeUndefined();
    entries.push(["promisor.advertise", "true"]);
    expect(promisorRemoteAdvertisement(config(entries))).toBe("name=lop,url=file:///lop");
    entries.push(["promisor.sendFields", "token , partialCloneFilter, bogus"]);
    expect(promisorRemoteAdvertisement(config(entries))).toBe(
      "name=lop,url=file:///lop,partialCloneFilter=blob:none,token=t",
    );
  });

  it("is advertised last in the v2 capabilities (serve.c's order)", () => {
    const caps = serverV2Capabilities(undefined, false, undefined, undefined, {
      sessionId: "sid",
      promisorRemote: "name=lop,url=u",
    });
    expect(caps.at(-1)).toBe("promisor-remote=name=lop,url=u");
    expect(caps.at(-2)).toBe("session-id=sid");
  });
});
