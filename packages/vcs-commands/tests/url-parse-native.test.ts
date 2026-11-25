/**
 * `git url-parse` (git 2.5x; 2.43 has no such command, so the twins skip there) against
 * native git: every URL of git's t9904-url-parse.sh with each component (`-c scheme`,
 * `user`, `password`, `host`, `port`, `path`) and none, the refusals (local paths, a URL
 * without a host, an unknown component, no URL), and more forms: escapes, default ports,
 * `..` segments, an `@` in an scp-like path, `[host]` followed by no colon.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { urlComponent, urlParse } from "@statewalker/vcs-utils";

import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import {
  git,
  native,
  type Outcome,
  outcomeOf,
} from "./plumbing-native-support.js";

/** Whether the native git has `url-parse` (`-h` prints its usage, exit 129). */
const hasUrlParse = () =>
  spawnSync("git", ["url-parse", "-h"], { encoding: "utf8" }).stdout.includes("git url-parse");

const describeGit =
  nativeGitAvailable() && process.platform === "linux" && hasUrlParse() ? describe : describe.skip;

let root = "";

/** t9904's URLs. */
const T9904_URLS = [
  "./rel",
  "/abs/path",
  "[2001:db8::1]:repo",
  "[::1]:/repository/path",
  "[::1]:repository/path",
  "[::1]:~user/repo",
  "[myhost:123]:src",
  "[myhost]:src",
  "example.com:/repository/path",
  "example.com:~user/repository",
  "file://",
  "file:///repository/path",
  "git://[::1]/repository/path",
  "git://[::1]:9418/repository/path",
  "git://example.com/repository/path",
  "git://example.com/~user/repository",
  "git://example.com/~user/repository?query",
  "git://example.com:1234/repository/path",
  "git://example.com:1234/~user/repository",
  "http://[2001:db8::1]/repository/path",
  "http://example.com/repository/path",
  "http://example.com:1234/repository/path",
  "http://user:secret@example.com/repository/path",
  "https://",
  "https://[2001:db8::1]/repository/path",
  "https://[::1]/repository/path",
  "https://[::1]:1234/repository/path",
  "https://example.com/repo",
  "https://example.com/repository/path",
  "https://example.com:1234/repository/path",
  "https://user:secret@example.com:1234/repository/path",
  "https://user@example.com/repository/path",
  "not a url",
  "ssh://[2001:db8::1]/repository/path",
  "ssh://[::1]/repository/path",
  "ssh://[::1]:1234/repository/path",
  "ssh://example.com/repository/path",
  "ssh://example.com/~user/repository",
  "ssh://example.com/~user/repository#fragment",
  "ssh://example.com/~user/repository?query",
  "ssh://example.com:1234/repository/path",
  "ssh://example.com:1234/~user/repository",
  "ssh://user@[::1]/repository/path",
  "ssh://user@[::1]:1234/repository/path",
  "ssh://user@example.com/repository/path",
  "ssh://user@example.com/~user/repository",
  "ssh://user@example.com:1234/repository/path",
  "ssh://user@example.com:1234/~user/repository",
  "user@[::1]:repo",
  "user@[::1]:repository/path",
  "user@[::1]:~user/repo",
  "user@[myhost:123]:src",
  "user@[myhost]:src",
  "user@example.com:/repository/path",
  "user@example.com:~user/repository",
  "user@example.com:~user/repository?query",
];

/** Forms t9904 does not try. */
const MORE_URLS = [
  "HTTPS://User@Example.COM:443/a/./b/../c",
  "https://a%2Fb@h%41st:0080/x/%7e/./../y?q#f",
  "https://example.com/a/../../b",
  "https://example.com/%zz",
  "https://exa mple.com/",
  "file://host:22/x",
  "host:path@x",
  "h:~u/r",
  "git+ssh://h/~u",
  "ssh+git://h:22/~u/r",
  "[myhost]src:x",
  "[::1",
  "user@host:",
  "C:/foo",
  "x://h/\u00e9",
  "",
];

async function ours(args: string[]): Promise<Outcome> {
  const g = await openOurs(root);
  const cmd = g.urlParse();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "-c") cmd.setComponent(args[++i]);
    else if (a === "--") continue;
    else cmd.addUrl(a);
  }
  return outcomeOf(await cmd.call());
}

async function twin(args: string[]): Promise<Outcome> {
  const n = native(root, root, ["url-parse", ...args]);
  expect(await ours(args), args.join(" ")).toEqual(n);
  return n;
}

describeGit("git url-parse against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "url-parse-"));
    git(root, root, ["init", "-q", "-b", "main"]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t9904-url-parse.sh: "git url-parse -- ssh syntax", "git url-parse -c scheme -- ssh syntax", "git url-parse -c path -- scp+IPv6", "git url-parse fails on invalid URL"', async () => {
    for (const url of [...T9904_URLS, ...MORE_URLS]) {
      await twin(["--", url]);
      for (const c of ["scheme", "user", "password", "host", "port", "path"]) {
        await twin(["-c", c, "--", url]);
      }
    }
  });

  it('t9904-url-parse.sh: "git url-parse fails on unknown -c component name", "git url-parse with no URL prints usage"', async () => {
    expect((await twin(["-c", "bogus", "https://example.com/repo"])).status).toBe(128);
    expect((await twin([])).status).toBe(129);
    // several URLs: the lines printed before the first refused one
    await twin(["-c", "host", "https://a/x", "b:y", "/abs", "https://c/"]);
  });

  it("urlParse and urlComponent", () => {
    const parsed = urlParse("user@[myhost:123]:src");
    if ("error" in parsed) throw new Error(parsed.error);
    expect(urlComponent(parsed, "port")).toBe("123");
    expect(urlComponent(parsed, "path")).toBe("/src");
  });
});
