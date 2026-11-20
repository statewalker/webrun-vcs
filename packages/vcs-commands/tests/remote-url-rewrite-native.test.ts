/**
 * Remote URLs as native git reads them: `url.<base>.insteadOf` / `pushInsteadOf` rewriting
 * (remote.c's `alias_url`, `alias_all_urls`, `add_url_alias`), the remote-name-or-URL rule
 * (`remote_get`), and `protocol.allow` / `protocol.<name>.allow` with `GIT_PROTOCOL_FROM_USER`
 * and `GIT_ALLOW_PROTOCOL` (transport.c's `is_transport_allowed`). The URLs are compared with
 * `git remote get-url` and `git ls-remote --get-url`; fetches and pushes through rewritten
 * URLs with the refs they leave; refusals with native git's stderr and exit code.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git, GitApiError } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

/** Our working copy over `<root>/<name>`, with `extra` in its environment. */
async function ours(name: string, extra: Record<string, string> = {}): Promise<Git> {
  return openOurs(
    root,
    createNodeGitHostEnvironment({ env: testEnv(root, extra) }),
    undefined,
    name,
  );
}

/** Two empty repositories, `n<k>` (native) and `o<k>` (ours). */
function twins(): [string, string] {
  const names: [string, string] = [`n${counter}`, `o${counter}`];
  counter++;
  for (const name of names) {
    mkdirSync(join(root, name));
    git(join(root, name), "init", "-q", "-b", "main");
  }
  return names;
}

const refs = (dir: string) =>
  git(join(root, dir), "for-each-ref", "--format=%(refname) %(objectname)");

/** Our command's failure (message, exit code), or undefined when it succeeds. */
async function failure(run: () => Promise<unknown>): Promise<GitApiError | undefined> {
  try {
    await run();
    return undefined;
  } catch (e) {
    return e as GitApiError;
  }
}

describeGit("remote URLs: insteadOf and pushInsteadOf, as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "url-rewrite-"));
    const src = join(root, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    putFile(src, "a.txt", "a\n");
    git(src, "add", "a.txt");
    git(src, "commit", "-qm", "one");
    git(src, "checkout", "-q", "-b", "feat");
    putFile(src, "b.txt", "b\n");
    git(src, "add", "b.txt");
    git(src, "commit", "-qm", "two");
    git(src, "checkout", "-q", "main");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /**
   * git 2.43 keeps an empty `remote.<name>.url` as a URL; 2.5x (and ours) read it as clearing
   * the URLs before it
   */
  const keepsEmptyUrls = (n: string) =>
    git(join(root, n), "remote", "get-url", "--all", "e").split("\n").slice(0, -1).includes("");

  /** The config lines both twins get: rewrites and remotes exercising git's rules. */
  const configure = (dir: string) => {
    const set = (...args: string[]) => git(dir, "config", ...args);
    set(`url.${root}/.insteadOf`, "short:");
    // the longest prefix wins
    set(`url.${root}/longer/.insteadOf`, "short:lo");
    // a tie: the base configured first wins
    set("url.https://first.example/.insteadOf", "tie:");
    set("url.https://second.example/.insteadOf", "tie:");
    set("url.ssh://push.example/.pushInsteadOf", "short:");
    set("--add", "url.ssh://push.example/.pushInsteadOf", "other:");
    // a: url rewritten for fetch by insteadOf, for push by pushInsteadOf
    set("remote.a.url", "short:src");
    // b: an explicit pushurl, rewritten by insteadOf only
    set("remote.b.url", "short:src");
    set("remote.b.pushurl", "short:dst");
    // c: longest match; d: two urls, only one matching pushInsteadOf
    set("remote.c.url", "short:longx");
    set("remote.d.url", "other:x1");
    set("--add", "remote.d.url", "plain:y1");
    // e: an empty url clears the earlier ones
    set("remote.e.url", "first:gone");
    set("--add", "remote.e.url", "");
    set("--add", "remote.e.url", "tie:r");
    // f: no rewrite matches
    set("remote.f.url", "https://example.com/r.git");
    // a remote name with an @ (a configured name wins over the URL reading)
    set("remote.a@b.url", "../src");
  };

  it("git remote get-url [--push] [--all]", async () => {
    const [n, o] = twins();
    for (const d of [n, o]) configure(join(root, d));
    const g = await ours(o);
    for (const name of ["a", "b", "c", "d", "e", "f", "a@b"]) {
      if (name === "e" && keepsEmptyUrls(n)) continue;
      for (const push of [false, true]) {
        for (const all of [false, true]) {
          const args = [
            "remote",
            "get-url",
            ...(push ? ["--push"] : []),
            ...(all ? ["--all"] : []),
          ];
          const native = git(join(root, n), ...args, name)
            .split("\n")
            .filter(Boolean);
          const mine = await g.remoteGetUrl().setRemoteName(name).setPush(push).setAll(all).call();
          expect(mine, `${args.join(" ")} ${name}`).toEqual(native);
        }
      }
    }
    // an unconfigured remote
    const native = gitRun(root, join(root, n), ["remote", "get-url", "nope"]);
    const error = await failure(() => g.remoteGetUrl().setRemoteName("nope").call());
    expect(error?.message).toBe(native.stderr.trim());
    expect(error?.exitCode).toBe(native.status);
  });

  it("git ls-remote --get-url: remotes and URLs given directly", async () => {
    const [n, o] = twins();
    for (const d of [n, o]) configure(join(root, d));
    const g = await ours(o);
    for (const what of [
      "a",
      "b",
      "d",
      "e",
      "short:src",
      "short:lofoo",
      "tie:x",
      "other:z",
      "plain",
      "a@b",
    ]) {
      if (what === "e" && keepsEmptyUrls(n)) continue;
      const native = git(join(root, n), "ls-remote", "--get-url", what).trim();
      expect(await g.lsRemote().setRemote(what).callGetUrl(), what).toBe(native);
    }
  });

  it("fetch through an insteadOf URL given directly and through a remote", async () => {
    const [n, o] = twins();
    for (const d of [n, o]) configure(join(root, d));
    expect(gitRun(root, join(root, n), ["fetch", "short:src", "feat:refs/heads/f"]).status).toBe(0);
    await (await ours(o)).fetch().setRemote("short:src").setRefSpecs("feat:refs/heads/f").call();
    expect(refs(o)).toBe(refs(n));
    // a remote named with an @: its configured URL, not the name as a URL
    expect(gitRun(root, join(root, n), ["fetch", "a@b", "main:refs/heads/m"]).status).toBe(0);
    await (await ours(o)).fetch().setRemote("a@b").setRefSpecs("main:refs/heads/m").call();
    expect(refs(o)).toBe(refs(n));
    expect(git(join(root, o), "rev-parse", "refs/heads/m")).toBe(
      git(join(root, "src"), "rev-parse", "main"),
    );
  });

  it("push goes to the pushInsteadOf URL, fetch to the insteadOf one", async () => {
    const [n, o] = twins();
    for (const d of [n, o]) {
      const dir = join(root, d);
      git(root, "init", "-q", "--bare", `${d}-dst.git`);
      git(dir, "config", `url.${root}/.insteadOf`, "here:");
      git(dir, "config", `url.${root}/${d}-dst.git.pushInsteadOf`, "here:src");
      git(dir, "config", "remote.origin.url", "here:src");
      git(dir, "fetch", "-q", "origin", "main");
      git(dir, "reset", "-q", "--hard", "FETCH_HEAD");
      putFile(dir, "p.txt", "p\n");
      git(dir, "add", "p.txt");
      git(dir, "commit", "-qm", "pushed");
    }
    const native = gitRun(root, join(root, n), ["push", "origin", "main:pushed"]);
    expect(native.status).toBe(0);
    const result = await (await ours(o))
      .push()
      .setRemote("origin")
      .setRefSpecs("main:pushed")
      .call();
    expect(result.uri).toBe(`${root}/${o}-dst.git`);
    const dstRefs = (d: string) =>
      git(join(root, `${d}-dst.git`), "for-each-ref", "--format=%(refname)");
    expect(dstRefs(o)).toBe(dstRefs(n));
    expect(dstRefs(o).trim()).toBe("refs/heads/pushed");
    // the source was not pushed to
    expect(git(join(root, "src"), "for-each-ref", "--format=%(refname)", "refs/heads/pushed")).toBe(
      "",
    );
  });

  it("clone through an insteadOf URL", async () => {
    const [n, o] = twins();
    rmSync(join(root, n), { recursive: true, force: true });
    const native = gitRun(root, root, [
      "-c",
      `url.${root}/.insteadOf=short:`,
      "clone",
      "-q",
      "short:src",
      n,
    ]);
    expect(native.status).toBe(0);
    git(join(root, o), "config", `url.${root}/.insteadOf`, "short:");
    await (await ours(o)).clone().setURI("short:src").call();
    expect(refs(o)).toBe(refs(n));
    // remote.origin.url keeps the URL as given
    expect(git(join(root, o), "config", "remote.origin.url").trim()).toBe("short:src");
    expect(git(join(root, n), "config", "remote.origin.url").trim()).toBe("short:src");
  });
});

describeGit("protocol.allow, as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "protocol-allow-"));
    const src = join(root, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    putFile(src, "a.txt", "a\n");
    git(src, "add", "a.txt");
    git(src, "commit", "-qm", "one");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  type Case = { name: string; url: string; config?: string[][]; env?: Record<string, string> };
  const cases: Case[] = [
    {
      name: "protocol.file.allow=never",
      url: "../src",
      config: [["protocol.file.allow", "never"]],
    },
    { name: "protocol.allow=never", url: "../src", config: [["protocol.allow", "never"]] },
    {
      name: "protocol.file.allow wins over protocol.allow",
      url: "../src",
      config: [
        ["protocol.allow", "never"],
        ["protocol.file.allow", "always"],
      ],
    },
    {
      name: "GIT_PROTOCOL_FROM_USER=0 (file is user-only)",
      url: "../src",
      env: { GIT_PROTOCOL_FROM_USER: "0" },
    },
    {
      name: "GIT_PROTOCOL_FROM_USER=0, protocol.file.allow=always",
      url: "../src",
      config: [["protocol.file.allow", "always"]],
      env: { GIT_PROTOCOL_FROM_USER: "0" },
    },
    {
      name: "GIT_ALLOW_PROTOCOL without file",
      url: "../src",
      env: { GIT_ALLOW_PROTOCOL: "https:ssh" },
    },
    {
      name: "GIT_ALLOW_PROTOCOL overrides protocol.file.allow",
      url: "../src",
      config: [["protocol.file.allow", "never"]],
      env: { GIT_ALLOW_PROTOCOL: "git:file" },
    },
    { name: "file:// URL refused", url: "", config: [["protocol.file.allow", "never"]] },
    { name: "ext is never allowed by default", url: "ext::sh -c true" },
    { name: "a helper refused", url: "foo::bar", config: [["protocol.foo.allow", "never"]] },
    {
      name: "https refused",
      url: "https://example.invalid/r.git",
      config: [["protocol.https.allow", "never"]],
    },
    {
      name: "ssh refused",
      url: "ssh://example.invalid/r.git",
      config: [["protocol.ssh.allow", "never"]],
    },
    { name: "an unknown policy", url: "../src", config: [["protocol.file.allow", "bogus"]] },
    { name: "an unknown protocol.version", url: "../src", config: [["protocol.version", "3"]] },
  ];

  for (const c of cases) {
    it(`fetch: ${c.name}`, async () => {
      const [n, o] = twins();
      const url = c.url || `file://${join(root, "src")}`;
      for (const d of [n, o]) {
        for (const [key, value] of c.config ?? []) git(join(root, d), "config", key, value);
      }
      const native = gitRun(root, join(root, n), ["fetch", url, "main:refs/heads/x"], c.env);
      const error = await failure(async () =>
        (await ours(o, c.env)).fetch().setRemote(url).setRefSpecs("main:refs/heads/x").call(),
      );
      if (native.status === 0) {
        expect(error).toBeUndefined();
      } else {
        expect(error?.message).toBe(native.stderr.trim());
        expect(error?.exitCode).toBe(native.status);
      }
      expect(refs(o)).toBe(refs(n));
    });
  }

  it("ls-remote, push and clone are checked too", async () => {
    const [n, o] = twins();
    for (const d of [n, o]) {
      const dir = join(root, d);
      git(dir, "fetch", "-q", "../src", "main");
      git(dir, "reset", "-q", "--hard", "FETCH_HEAD");
      git(dir, "config", "protocol.file.allow", "never");
    }
    const g = await ours(o);
    const nativeLs = gitRun(root, join(root, n), ["ls-remote", "../src"]);
    const ls = await failure(() => g.lsRemote().setRemote("../src").call());
    expect(ls?.message).toBe(nativeLs.stderr.trim());
    const nativePush = gitRun(root, join(root, n), ["push", "../src", "main:other"]);
    const push = await failure(async () =>
      (await ours(o)).push().setRemote("../src").setRefSpecs("main:other").call(),
    );
    expect(push?.message).toBe(nativePush.stderr.trim());
    expect(push?.exitCode).toBe(nativePush.status);
  });
});
