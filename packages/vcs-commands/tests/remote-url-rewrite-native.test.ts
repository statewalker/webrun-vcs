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
import { createDefaultTransports } from "@statewalker/vcs-transport";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git, GitApiError } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitHttpBackend } from "./native-git-http-backend.js";
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

describeGit("review fixes: option-looking URLs, default remotes, clone sources, -v, v1", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "url-review-"));
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
    git(root, "init", "-q", "--bare", "other.git");
    git(src, "push", "-q", "../other.git", "feat:refs/heads/only");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // ssh would run a command: git refuses an option-looking path (ssh and local), then host
  // (ssh, after protocol.ssh.allow), before it connects
  const strange: { url: string; config?: string[][] }[] = [
    { url: "ssh://-oProxyCommand=x/r" },
    { url: "-oProxyCommand=x:r" },
    { url: "h:-r" },
    { url: "-h:-r" },
    { url: "ssh://-h:22/r" },
    { url: "ssh://[-h:22]/r" },
    { url: "ssh://u@-h/r" },
    { url: "-r" },
    { url: "ssh://-h/r", config: [["protocol.ssh.allow", "never"]] },
    { url: "h:-r", config: [["protocol.ssh.allow", "never"]] },
  ];
  for (const c of strange) {
    it(`refuses ${c.url}${c.config ? " (ssh never)" : ""} as native git`, async () => {
      const [n, o] = twins();
      for (const d of [n, o]) {
        // a repository named `-r` beside: still refused
        git(join(root, d), "init", "-q", "--bare", "./-r");
        for (const [key, value] of c.config ?? []) git(join(root, d), "config", key, value);
      }
      const env = { GIT_SSH_COMMAND: "false" };
      for (const command of ["ls-remote", "fetch"] as const) {
        const native = gitRun(root, join(root, n), [command, "--", c.url], env);
        const g = await ours(o, env);
        const error = await failure(() =>
          command === "ls-remote"
            ? g.lsRemote().setRemote(c.url).call()
            : g.fetch().setRemote(c.url).call(),
        );
        // ssh://u@-h/r: git's host check sees `u@-h`, not an option: it connects (and fails)
        if (c.url === "ssh://u@-h/r") {
          expect(native.stderr).not.toContain("strange");
          expect(error?.message).not.toContain("strange");
          continue;
        }
        expect(error?.message, `${command} ${c.url}`).toBe(native.stderr.trim());
        expect(error?.exitCode).toBe(native.status);
      }
    });
  }

  it("ls-remote without a remote: remote_get(NULL)", async () => {
    const [n, o] = twins();
    const getUrl = async () => {
      const native = gitRun(root, join(root, n), ["ls-remote", "--get-url"]);
      let mine: string | undefined;
      const error = await failure(async () => {
        mine = await (await ours(o)).lsRemote().callGetUrl();
      });
      if (native.status === 0) {
        expect(error).toBeUndefined();
        expect(mine).toBe(native.stdout.trim());
      } else {
        expect(error?.message).toBe(native.stderr.trim());
        expect(error?.exitCode).toBe(native.status);
      }
      return native.status;
    };
    const both = (...args: string[]) => {
      for (const d of [n, o]) git(join(root, d), "config", ...args);
    };
    // no remote at all: listing fails as getting the URL does
    expect(await getUrl()).toBe(128);
    const nativeLs = gitRun(root, join(root, n), ["ls-remote"]);
    const ls = await failure(async () => (await ours(o)).lsRemote().call());
    expect(ls?.message).toBe(nativeLs.stderr.trim());
    expect(ls?.exitCode).toBe(nativeLs.status);
    // the only remote
    both("remote.up.url", "../src");
    expect(await getUrl()).toBe(0);
    // two remotes, none origin: origin, which has no URL
    both("remote.b.url", "../other.git");
    expect(await getUrl()).toBe(128);
    // the current branch's remote; one that names no remote is a URL (insteadOf applies)
    both("branch.main.remote", "b");
    expect(await getUrl()).toBe(0);
    both(`url.${root}/.insteadOf`, "sh:");
    both("branch.main.remote", "sh:other.git");
    expect(await getUrl()).toBe(0);
    both("--unset", "branch.main.remote");
    // origin with no URL
    both("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    expect(await getUrl()).toBe(128);
    both("remote.origin.url", "../src");
    expect(await getUrl()).toBe(0);
    // and ls-remote lists the default remote's refs
    const listed = (await (await ours(o)).lsRemote().call()).refs.map(
      (r) => `${r.objectId}\t${r.name}`,
    );
    const native = git(join(root, n), "ls-remote")
      .split("\n")
      .filter((l) => l && !l.endsWith("\tHEAD"));
    expect(listed).toEqual(native);
  });

  it("clone: a name without a colon that is no path is not rewritten", async () => {
    const [n, o] = twins();
    rmSync(join(root, n), { recursive: true, force: true });
    const native = gitRun(root, root, [
      "-c",
      `url.${root}/src.insteadOf=nocolon`,
      "clone",
      "nocolon",
      n,
    ]);
    git(join(root, o), "config", `url.${root}/src.insteadOf`, "nocolon");
    const error = await failure(async () => (await ours(o)).clone().setURI("nocolon").call());
    expect(native.stderr.trim()).toBe("fatal: repository 'nocolon' does not exist");
    expect(error?.message).toBe(native.stderr.trim());
    expect(error?.exitCode).toBe(native.status);
    expect(git(join(root, o), "for-each-ref")).toBe("");
  });

  it("clone: a path becomes absolute, and insteadOf rewrites that absolute path", async () => {
    // native clones into its (empty) directory, so both resolve `../src` from their top
    const [n, o] = twins();
    rmSync(join(root, n), { recursive: true, force: true });
    mkdirSync(join(root, n));
    expect(gitRun(root, join(root, n), ["clone", "-q", "../src", "."]).status).toBe(0);
    await (await ours(o)).clone().setURI("../src").call();
    expect(refs(o)).toBe(refs(n));
    const originUrl = (d: string) => git(join(root, d), "config", "remote.origin.url").trim();
    expect(originUrl(n)).toBe(`${root}/${n}/../src`);
    expect(originUrl(o)).toBe(`${root}/${o}/../src`);
    const reflog = (d: string) => git(join(root, d), "reflog", "-1", "--format=%gs", "main");
    expect(reflog(o).replace(`/${o}/`, "/X/")).toBe(reflog(n).replace(`/${n}/`, "/X/"));

    const [n2, o2] = twins();
    rmSync(join(root, n2), { recursive: true, force: true });
    mkdirSync(join(root, n2));
    const rewrite = (d: string) => `url.${root}/other.git.insteadOf=${root}/${d}/../src`;
    expect(
      gitRun(root, join(root, n2), ["-c", rewrite(n2), "clone", "-q", "../src", "."]).status,
    ).toBe(0);
    git(join(root, o2), "config", `url.${root}/other.git.insteadOf`, `${root}/${o2}/../src`);
    await (await ours(o2)).clone().setURI("../src").call();
    expect(refs(o2)).toBe(refs(n2));
    expect(refs(o2)).toContain("refs/remotes/origin/only");
    expect(originUrl(o2)).toBe(`${root}/${o2}/../src`);
  });

  it("remote -v: URLs as alias_all_urls leaves them", async () => {
    const [n, o] = twins();
    for (const d of [n, o]) {
      const set = (...args: string[]) => git(join(root, d), "config", ...args);
      set(`url.${root}/.insteadOf`, "short:");
      set("url.ssh://push.example/.pushInsteadOf", "short:");
      set("remote.a.url", "short:src");
      set("remote.b.url", "short:src");
      set("remote.b.pushurl", "short:dst");
      set("remote.d.url", "short:x1");
      set("--add", "remote.d.url", "plain:y1");
      set("remote.f.url", "https://example.com/r.git");
      set("remote.e.url", "short:gone");
      set("--add", "remote.e.url", "");
      set("--add", "remote.e.url", "short:kept");
    }
    const keepsEmpty = git(join(root, n), "remote", "get-url", "--all", "e")
      .split("\n")
      .includes("");
    const native = git(join(root, n), "remote", "-v")
      .split("\n")
      .filter((l) => l && !(keepsEmpty && l.startsWith("e\t")));
    const remotes = await (await ours(o)).remoteList().call();
    const mine: string[] = [];
    for (const r of [...remotes].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
      if (keepsEmpty && r.name === "e") continue;
      if (r.urls[0] !== undefined) mine.push(`${r.name}\t${r.urls[0]} (fetch)`);
      for (const url of r.pushUrls.length > 0 ? r.pushUrls : r.urls) {
        mine.push(`${r.name}\t${url} (push)`);
      }
    }
    expect(mine).toEqual(native);
  });

  it("protocol.version=1: local fetch and push", async () => {
    const [n, o] = twins();
    git(root, "init", "-q", "--bare", `${n}-dst.git`);
    git(root, "init", "-q", "--bare", `${o}-dst.git`);
    for (const d of [n, o]) git(join(root, d), "config", "protocol.version", "1");
    expect(gitRun(root, join(root, n), ["fetch", "../src", "feat:refs/heads/f"]).status).toBe(0);
    await (await ours(o)).fetch().setRemote("../src").setRefSpecs("feat:refs/heads/f").call();
    expect(refs(o)).toBe(refs(n));
    expect(gitRun(root, join(root, n), ["push", `../${n}-dst.git`, "f:refs/heads/p"]).status).toBe(
      0,
    );
    await (await ours(o)).push().setRemote(`../${o}-dst.git`).setRefSpecs("f:refs/heads/p").call();
    const dst = (d: string) => git(join(root, `${d}-dst.git`), "for-each-ref");
    expect(dst(o)).toBe(dst(n));
  });

  it("protocol.version=1 over smart HTTP: native http-backend answers `version 1`", async () => {
    const [n, o] = twins();
    git(root, "init", "-q", "--bare", `${o}-http.git`);
    git(join(root, `${o}-http.git`), "config", "http.receivepack", "true");
    git(join(root, o), "config", "protocol.version", "1");
    const backend = nativeGitHttpBackend(root, root);
    const seen: string[] = [];
    const transports = createDefaultTransports({
      fetchImpl: async (request: Request) => {
        const response = await backend.fetch(request);
        let first = "";
        if (request.method === "GET") {
          const text = new TextDecoder().decode(await response.clone().arrayBuffer());
          first = text.split("0000")[1]?.slice(0, 14) ?? "";
        }
        seen.push(
          `${request.method} ${new URL(request.url).pathname} ${request.headers.get("git-protocol")} ${first}`,
        );
        return response;
      },
    });
    try {
      expect(
        gitRun(root, join(root, n), [
          "-c",
          "protocol.version=1",
          "fetch",
          "../src",
          "feat:refs/heads/f",
        ]).status,
      ).toBe(0);
      await (await ours(o))
        .fetch()
        .setRemote("http://h/src")
        .setRefSpecs("feat:refs/heads/f")
        .setTransports(transports)
        .call();
      expect(refs(o)).toBe(refs(n));
      await (await ours(o))
        .push()
        .setRemote(`http://h/${o}-http.git`)
        .setRefSpecs("f:refs/heads/p")
        .setTransports(transports)
        .call();
      expect(git(join(root, `${o}-http.git`), "rev-parse", "refs/heads/p")).toBe(
        git(join(root, "src"), "rev-parse", "feat"),
      );
    } finally {
      backend.close();
    }
    expect(seen).toEqual([
      "GET /src/info/refs version=1 000eversion 1\n",
      "POST /src/git-upload-pack version=1 ",
      `GET /${o}-http.git/info/refs version=1 000eversion 1\n`,
      `POST /${o}-http.git/git-receive-pack version=1 `,
    ]);
  });
});
