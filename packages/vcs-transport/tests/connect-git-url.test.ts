/**
 * `parseGitUrl`: remote URLs as git's transport_get and connect.c's parse_connect_url read
 * them. The ssh and file cases are also compared with native git's own reading
 * (`git fetch-pack --diag-url`).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isGitUrl, parseGitUrl, urlIsLocalNotSsh } from "../src/connect/index.js";

describe("parseGitUrl", () => {
  it("reads scp-like host:path as ssh", () => {
    expect(parseGitUrl("host:path")).toMatchObject({
      scheme: "ssh",
      host: "host",
      path: "path",
      scpLike: true,
      local: false,
    });
    expect(parseGitUrl("host:~u/r")).toMatchObject({ host: "host", path: "~u/r" });
  });

  it("reads user@host:path and [ipv6]:path", () => {
    expect(parseGitUrl("git@example.com:org/r.git")).toMatchObject({
      scheme: "ssh",
      user: "git",
      host: "example.com",
      path: "org/r.git",
      scpLike: true,
    });
    const v6 = parseGitUrl("[::1]:repo");
    expect(v6).toMatchObject({ scheme: "ssh", host: "::1", path: "repo", scpLike: true });
    expect(v6.port).toBeUndefined();
    expect(parseGitUrl("user@[::1]:src")).toMatchObject({ user: "user", host: "::1", path: "src" });
    // [host:port]:path names a port (ssh's get_port)
    expect(parseGitUrl("[myhost:123]:src")).toMatchObject({
      host: "myhost",
      port: 123,
      path: "src",
    });
  });

  it("reads ssh:// URLs: port, ~user paths, decoding, deprecated spellings", () => {
    expect(parseGitUrl("ssh://host:22/~user/x")).toMatchObject({
      scheme: "ssh",
      host: "host",
      port: 22,
      path: "~user/x",
      scpLike: false,
    });
    expect(parseGitUrl("ssh://host/%7Euser/x")).toMatchObject({ path: "~user/x" });
    expect(parseGitUrl("ssh://user@[::1]:2222/repo")).toMatchObject({
      user: "user",
      host: "::1",
      port: 2222,
      path: "/repo",
    });
    expect(parseGitUrl("ssh://host:/r")).toMatchObject({ host: "host", path: "/r" });
    expect(parseGitUrl("git+ssh://h/r")).toMatchObject({ scheme: "ssh", host: "h", path: "/r" });
    expect(parseGitUrl("ssh+git://h/r")).toMatchObject({ scheme: "ssh", host: "h", path: "/r" });
    expect(parseGitUrl("ssh://host").path).toBe("");
  });

  it("reads git:// URLs, keeping git-daemon's host=", () => {
    expect(parseGitUrl("git://h.example/~u/r")).toMatchObject({
      scheme: "git",
      host: "h.example",
      path: "~u/r",
      authority: "h.example",
    });
    expect(parseGitUrl("git://[::1]:9418/r")).toMatchObject({
      host: "::1",
      port: 9418,
      path: "/r",
      authority: "[::1]:9418",
    });
    // not a port: kept in the host, as git does
    expect(parseGitUrl("git://host:x/r")).toMatchObject({ host: "host:x", path: "/r" });
  });

  it("reads paths and file:// URLs as local", () => {
    expect(parseGitUrl("/abs/r.git")).toMatchObject({
      scheme: "file",
      path: "/abs/r.git",
      local: true,
    });
    expect(parseGitUrl("../other")).toMatchObject({ scheme: "file", local: true });
    expect(parseGitUrl("./x:y")).toMatchObject({ scheme: "file", path: "./x:y", local: true });
    expect(parseGitUrl("C:\\x")).toMatchObject({ scheme: "file", path: "C:\\x", local: true });
    expect(parseGitUrl("C:/x")).toMatchObject({ scheme: "file", local: true });
    const file = parseGitUrl("file:///srv/r%20x.git");
    expect(file).toMatchObject({ scheme: "file", path: "/srv/r x.git", local: false });
    expect(file.host).toBeUndefined();
    expect(parseGitUrl("file://host/srv/r")).toMatchObject({ host: "host", path: "/srv/r" });
  });

  it("reads <helper>::<address> and unknown schemes", () => {
    expect(parseGitUrl("foo::bar")).toMatchObject({ scheme: "foo", address: "bar", path: "bar" });
    expect(parseGitUrl("ext::ssh -p 22 host %S x")).toMatchObject({
      scheme: "ext",
      address: "ssh -p 22 host %S x",
    });
    expect(parseGitUrl("test://peer/repo")).toMatchObject({
      scheme: "test",
      host: "peer",
      path: "/repo",
    });
    expect(parseGitUrl("https://u:p@example.com:8443/r.git?x=1")).toMatchObject({
      scheme: "https",
      user: "u",
      host: "example.com",
      port: 8443,
      path: "/r.git?x=1",
    });
    expect(parseGitUrl("HTTPS://example.com/r").scheme).toBe("https");
  });

  it("reads hosts and ports in get_host_and_port's order", () => {
    // scp-like `/~user`: the path git asks for is `~user/x`
    expect(parseGitUrl("host:/~user/x")).toMatchObject({ host: "host", path: "~user/x" });
    // a bracketed `[user@host:port]` names the user and the port
    expect(parseGitUrl("[user@host:22]:repo")).toMatchObject({
      user: "user",
      host: "host",
      port: 22,
      path: "repo",
    });
    // the first colon past the host starts the port: `pw@host:22` is none, so no port
    const pw = parseGitUrl("ssh://user:pw@host:22/x");
    expect(pw).toMatchObject({ user: "user:pw", host: "host:22", path: "/x" });
    expect(pw.port).toBeUndefined();
    // strtol: a sign and leading blanks are read
    expect(parseGitUrl("ssh://host:+22/x")).toMatchObject({ host: "host", port: 22 });
    expect(parseGitUrl("ssh://host:22x/r")).toMatchObject({ host: "host:22x" });
    expect(parseGitUrl("ssh://host:22x/r").port).toBeUndefined();
    // `host:` names the empty path
    expect(parseGitUrl("host:")).toMatchObject({ host: "host", path: "", scpLike: true });
  });

  it("keeps %00 and cuts at a NUL, as git's C strings do", () => {
    expect(parseGitUrl("git://h/r%00%00x=y")).toMatchObject({ host: "h", path: "/r%00%00x=y" });
    expect(parseGitUrl("ssh://h/r%00x").path).toBe("/r%00x");
    const cut = parseGitUrl("git://h/r\0\0x=y");
    expect(cut).toMatchObject({ raw: "git://h/r", path: "/r" });
    // other escapes are still decoded
    expect(parseGitUrl("git://h/a%20b").path).toBe("/a b");
  });

  it("is_url and url_is_local_not_ssh", () => {
    expect(isGitUrl("a+b.c-d://x")).toBe(true);
    expect(isGitUrl("+a://x")).toBe(false);
    expect(isGitUrl("host:path")).toBe(false);
    expect(urlIsLocalNotSsh("a/b:c")).toBe(true);
    expect(urlIsLocalNotSsh("b:c/d")).toBe(false);
    expect(urlIsLocalNotSsh("plain")).toBe(true);
  });
});

const nativeGit = spawnSync("git", ["--version"]).status === 0;
const describeGit = nativeGit ? describe : describe.skip;

describeGit("parseGitUrl: as native git's fetch-pack --diag-url", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "diag-url-"));
    execFileSync("git", ["init", "-q", dir]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** native git's Diag lines, as a map */
  const diag = (url: string) => {
    const out = spawnSync("git", ["fetch-pack", "--diag-url", url], {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    }).stdout.toString();
    const map = new Map<string, string>();
    for (const line of out.split("\n")) {
      const m = /^Diag: (\w+)=(.*)$/.exec(line);
      if (m) map.set(m[1], m[2]);
    }
    return map;
  };

  const urls = [
    "host:path",
    "host:~u/r",
    "user@host:path",
    "[::1]:repo",
    "user@[::1]:src",
    "[myhost:123]:src",
    "ssh://host:22/~user/x",
    "ssh://host/%7Euser/x",
    "ssh://user@[::1]:2222/repo",
    "ssh://host:/r",
    "git+ssh://h/r",
    "ssh+git://h/r",
    "file:///srv/r.git",
    "file://host/srv/r",
    "file:///srv/a%20b",
    "./x:y",
    "/abs",
    "rel/dir",
    "host:/~user/x",
    "[user@host:22]:repo",
    "ssh://user:pw@host:22/x",
    "ssh://host:+22/x",
    "ssh://host: 22/x",
    "ssh://host:22x/r",
    "ssh://host:-1/r",
    "ssh://[u@h:22]/r",
    "ssh://u@[::1]:22/r",
    "host:",
    "git://h/r%00%00x=y",
    "git://h%00x/r",
    "ssh://h/r%00x",
    "ssh://-oProxyCommand=x/r",
  ];
  for (const url of urls) {
    it(url, () => {
      const native = diag(url);
      const ours = parseGitUrl(url);
      expect(ours.scheme).toBe(native.get("protocol"));
      expect(ours.path).toBe(native.get("path"));
      if (ours.scheme === "ssh") {
        const userAndHost = `${ours.user !== undefined ? `${ours.user}@` : ""}${ours.host ?? ""}`;
        expect(userAndHost).toBe(native.get("userandhost"));
        // git keeps the port as written (`+22`, ` 22`): compare the number strtol reads
        const port = native.get("port");
        expect(ours.port).toBe(port === "NONE" || port === undefined ? undefined : Number(port));
      } else {
        expect(ours.host ?? "").toBe(native.get("hostandport"));
      }
    });
  }
});
