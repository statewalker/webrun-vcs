/**
 * The Git LFS endpoint as git-lfs resolves it (`lfs.url`, `lfs.pushurl`,
 * `remote.<name>.lfsurl`/`lfspushurl`, `.lfsconfig` in the worktree, the index or HEAD, then
 * the remote's `pushurl`/`url`), compared with the installed git-lfs: `git lfs env` gives the
 * download endpoint of every remote it knows (and whether `origin` is its default remote),
 * `GIT_TRACE=1 git lfs locks [--verify] [--remote <r>]` the endpoint it contacts for downloads
 * and uploads of the push remote (endpoints at `127.0.0.1:1`, refused at once). Both twins
 * read the same repository (resolving writes nothing). git-lfs reads the configuration
 * through `git config -l`, which `breakingChanges` does not change.
 *
 * Inputs: JGit's LfsConfigGitTest (remote URL with and without `.git`, `lfs.url` in the local
 * config, `remote.origin.lfsurl`, `.lfsconfig` in the worktree, overridden by the local
 * config, read from the index and from HEAD, nothing configured) and git-lfs's own
 * `lfsapi/endpoint_finder_test.go` (TestEndpointOverridesOrigin, TestEndpointUseAlternateRemote,
 * TestEndpointSeparateClonePushUrl, TestEndpointOverriddenSeparateClonePushLfsUrl,
 * TestEndpointGlobalSeparateLfsPush, TestSSHEndpointAddsLfsSuffix,
 * TestSSHCustomPortEndpointAddsLfsSuffix, TestGitSSHEndpointAddsLfsSuffix,
 * TestSSHGitEndpointAddsLfsSuffix, TestBareSSHEndpointAddsLfsSuffix,
 * TestBareSSSHEndpointWithCustomPortInBrackets, TestSSHEndpointFromGlobalLfsUrl,
 * TestHTTPEndpointAddsLfsSuffix, TestGitEndpointAddsLfsSuffix,
 * TestGitEndpointAddsLfsSuffixWithCustomProtocol, TestInsteadOf, TestPushInsteadOf) and
 * `t/t-config.sh` ("default config", "config reads from repository", "config with
 * remote.lfsdefault", "url alias config", "lfsconfig in index", "lfsconfig ignores unsafe
 * keys").
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { testEnv } from "./status-native-support.js";

function gitLfsAvailable(): boolean {
  if (!nativeGitAvailable()) return false;
  try {
    execFileSync("git", ["lfs", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasGitLfs = process.platform === "linux" && gitLfsAvailable();

/** The installed git-lfs's version (`git-lfs/3.4.1 (...)`): ours follows it. */
const lfsVersion = hasGitLfs
  ? (/git-lfs\/(\d+\.\d+\.\d+)/.exec(execFileSync("git", ["lfs", "version"]).toString())?.[1] ??
    "3.8.1")
  : "3.8.1";
const compat = { compatibility: lfsVersion };

let root: string;
let counter = 0;

const env = (extra: Record<string, string> = {}) => ({
  ...testEnv(root),
  GIT_SSH_COMMAND: "false",
  GIT_TERMINAL_PROMPT: "0",
  ...extra,
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    env: env(),
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

function repo(options: { bare?: boolean } = {}): string {
  const dir = join(root, `r${counter++}`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main", ...(options.bare ? ["--bare"] : []));
  return dir;
}

function commitFile(dir: string, path: string, content: string): void {
  writeFileSync(join(dir, path), content);
  git(dir, "add", path);
  git(dir, "commit", "-q", "-m", `add ${path}`);
}

/** `git lfs env`'s endpoint blocks (sorted, auth left out) and its stderr warnings. */
function nativeEnv(dir: string): { endpoints: string[]; warnings: string[] } {
  const r = spawnSync("git", ["lfs", "env"], { cwd: dir, env: env(), timeout: 30_000 });
  const lines = r.stdout.toString().split("\n");
  const endpoints: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.startsWith("Endpoint")) continue;
    let block = line.replace(/ \(auth=[^)]*\)$/, "");
    if (lines[i + 1]?.startsWith("  SSH=")) block += `\n${lines[++i]}`;
    endpoints.push(block);
  }
  const stderr = r.stderr.toString();
  const start = stderr.indexOf("warning: These unsafe");
  const warnings =
    start < 0
      ? []
      : stderr
          .slice(start)
          .split("\n")
          .filter((l, i, all) => i < all.length - 1 && (i < 2 || l.startsWith("  ")));
  return { endpoints: endpoints.sort(), warnings };
}

/** The endpoint `git lfs locks` contacts (download, or upload with `--verify`), if HTTP. */
function nativeLocks(dir: string, upload: boolean, remote?: string): string | undefined {
  const args = [
    "lfs",
    "locks",
    ...(upload ? ["--verify"] : []),
    ...(remote ? ["--remote", remote] : []),
  ];
  const r = spawnSync("git", args, {
    cwd: dir,
    env: env({ GIT_TRACE: "1" }),
    timeout: 30_000,
  });
  const match = /HTTP: (?:GET|POST) (\S+)/.exec(r.stderr.toString());
  if (!match) return undefined;
  return (match[1] as string).replace(/\/locks(\/verify)?(\?.*)?$/, "");
}

async function ours(dir: string): Promise<Git> {
  return openOurs(dir, createNodeGitHostEnvironment({ env: env() }));
}

async function oursBare(dir: string): Promise<Git> {
  return openOurs(dir, createNodeGitHostEnvironment({ env: env() }), undefined, "", false, ".");
}

/** Ours as `git lfs env` prints it. */
async function oursEnv(g: Git): Promise<{ endpoints: string[]; warnings: string[] }> {
  const lfs = await g.lfsConfig(compat);
  const blocks: string[] = [];
  const show = (label: string, ep: { url: string; ssh?: { userAndHost: string; path: string } }) =>
    blocks.push(
      `${label}=${ep.url}${ep.ssh?.userAndHost ? `\n  SSH=${ep.ssh.userAndHost}:${ep.ssh.path}` : ""}`,
    );
  let defaultRemote = "";
  if (lfs.remote() === "origin") {
    defaultRemote = "origin";
    const ep = await lfs.endpoint("download", "origin");
    if (ep.url !== "") show("Endpoint", ep);
  }
  for (const remote of lfs.remotes) {
    if (remote === defaultRemote) continue;
    show(`Endpoint (${remote})`, await lfs.endpoint("download", remote));
  }
  return { endpoints: blocks.sort(), warnings: [...lfs.warnings] };
}

/** Compares env and, for HTTP endpoints at 127.0.0.1:1, the endpoints `locks` contacts. */
async function compare(
  dir: string,
  g: Git,
  options: { locks?: boolean; remotes?: string[] } = {},
): Promise<void> {
  expect(await oursEnv(g)).toEqual(nativeEnv(dir));
  if (!options.locks) return;
  const lfs = await g.lfsConfig(compat);
  for (const upload of [false, true]) {
    for (const remote of [undefined, ...(options.remotes ?? [])]) {
      const native = nativeLocks(dir, upload, remote);
      const ep = await lfs.endpoint(upload ? "upload" : "download", remote ?? lfs.pushRemote());
      expect({ upload, remote, url: ep.url }).toEqual({ upload, remote, url: native ?? ep.url });
      if (native === undefined) expect(ep.url.startsWith("http://127.0.0.1:1")).toBe(false);
    }
  }
}

describe.runIf(!hasGitLfs && !!process.env.CI)("LFS config twins on CI", () => {
  it("git-lfs is installed", () => {
    expect(hasGitLfs, "git-lfs is required on CI for the LFS config twins").toBe(true);
  });
});

describe.skipIf(!hasGitLfs)("LFS endpoint as git-lfs resolves it", { timeout: 60_000 }, () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lfs-config-native-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("LfsConfigGitTest: the remote URL with and without .git", async () => {
    for (const url of [
      "http://127.0.0.1:1/repo.git",
      "http://127.0.0.1:1/repo",
      "http://127.0.0.1:1/repo/",
    ]) {
      const dir = repo();
      git(dir, "remote", "add", "origin", url);
      await compare(dir, await ours(dir), { locks: true, remotes: ["origin"] });
    }
  });

  it("LfsConfigGitTest: lfs.url and remote.origin.lfsurl in the local config", async () => {
    const dir = repo();
    git(dir, "remote", "add", "origin", "http://127.0.0.1:1/repo");
    git(dir, "config", "remote.origin.lfsurl", "http://127.0.0.1:1/origin-lfs");
    await compare(dir, await ours(dir), { locks: true, remotes: ["origin"] });
    git(dir, "config", "lfs.url", "http://127.0.0.1:1/lfs-url");
    await compare(dir, await ours(dir), { locks: true, remotes: ["origin"] });
  });

  it("LfsConfigGitTest: .lfsconfig in the worktree, overridden by the local config", async () => {
    const dir = repo();
    git(dir, "remote", "add", "origin", "http://127.0.0.1:1/repo");
    commitFile(dir, ".lfsconfig", "[lfs]\n\turl = http://127.0.0.1:1/from-lfsconfig\n");
    const g = await ours(dir);
    await compare(dir, g, { locks: true, remotes: ["origin"] });
    const ep = await g.lfsEndpoint().setCompatibility(lfsVersion).call();
    expect(ep).toMatchObject({ source: "lfs.url", fromLfsconfig: true });
    git(dir, "config", "lfs.url", "http://127.0.0.1:1/from-config");
    const g2 = await ours(dir);
    await compare(dir, g2, { locks: true, remotes: ["origin"] });
    expect(await g2.lfsEndpoint().setCompatibility(lfsVersion).call()).toMatchObject({
      fromLfsconfig: false,
    });
  });

  it('LfsConfigGitTest, t-config.sh "lfsconfig in index": .lfsconfig from the index, then HEAD', async () => {
    const dir = repo();
    git(dir, "remote", "add", "origin", "http://127.0.0.1:1/repo");
    commitFile(dir, ".lfsconfig", '[remote "origin"]\n\tlfsurl = http://127.0.0.1:1/head\n');
    writeFileSync(
      join(dir, ".lfsconfig"),
      '[remote "origin"]\n\tlfsurl = http://127.0.0.1:1/index\n',
    );
    git(dir, "add", ".lfsconfig");
    rmSync(join(dir, ".lfsconfig"));
    await compare(dir, await ours(dir), { locks: true, remotes: ["origin"] });
    git(dir, "rm", "-q", "--cached", ".lfsconfig");
    await compare(dir, await ours(dir), { locks: true, remotes: ["origin"] });
  });

  it("LfsConfigGitTest: nothing configured", async () => {
    const dir = repo();
    await compare(dir, await ours(dir));
    expect((await (await ours(dir)).lfsEndpoint().setCompatibility(lfsVersion).call()).url).toBe(
      "",
    );
  });

  it("endpoint_finder_test.go TestEndpointOverridesOrigin, TestEndpointUseAlternateRemote, TestEndpointGlobalSeparateLfsPush", async () => {
    const dir = repo();
    git(dir, "config", "remote.origin.lfsurl", "http://127.0.0.1:1/def");
    git(dir, "config", "remote.other.lfsurl", "http://127.0.0.1:1/other");
    await compare(dir, await ours(dir), { locks: true, remotes: ["origin", "other"] });
    git(dir, "config", "lfs.url", "http://127.0.0.1:1/abc");
    git(dir, "config", "lfs.pushurl", "http://127.0.0.1:1/write");
    await compare(dir, await ours(dir), { locks: true, remotes: ["origin", "other"] });
  });

  it("endpoint_finder_test.go TestEndpointSeparateClonePushUrl, TestEndpointOverriddenSeparateClonePushLfsUrl", async () => {
    const dir = repo();
    git(dir, "config", "remote.origin.url", "http://127.0.0.1:1/foo/bar.git");
    git(dir, "config", "remote.origin.pushurl", "http://127.0.0.1:1/readwrite/bar.git");
    await compare(dir, await ours(dir), { locks: true, remotes: ["origin"] });
    git(dir, "config", "remote.origin.lfsurl", "http://127.0.0.1:1/examplelfs");
    git(dir, "config", "remote.origin.lfspushurl", "http://127.0.0.1:1/readwritelfs");
    await compare(dir, await ours(dir), { locks: true, remotes: ["origin"] });
  });

  it("endpoint_finder_test.go: ssh, bare ssh, git:// and http URLs of remotes", async () => {
    const dir = repo();
    const urls: Record<string, string> = {
      ssh: "ssh://git@example.com/foo/bar",
      sshport: "ssh://git@example.com:9000/foo/bar",
      gitssh: "git+ssh://git@example.com/foo/bar",
      sshgit: "ssh+git://git@example.com:9000/foo/bar",
      bare: "git@example.com:foo/bar.git",
      brackets: "[git@example.com:2222]:foo/bar.git",
      nouser: "example.com:foo/bar",
      http: "http://example.com/foo/bar",
      upper: "HTTPS://Example.com/Foo%2fbar/a b",
      git: "git://example.com/foo/bar",
      gitbare: "git://example.com/foo/bar.git",
      helper: "foo::https://example.com/bar",
      relative: "../elsewhere",
      sshnohost: "ssh:///foo",
      emptyport: "ssh://example.com:/foo",
    };
    for (const [name, url] of Object.entries(urls)) git(dir, "config", `remote.${name}.url`, url);
    await compare(dir, await ours(dir));
    git(dir, "config", "lfs.gitprotocol", "http");
    await compare(dir, await ours(dir));
  });

  it("endpoint_finder_test.go TestSSHEndpointFromGlobalLfsUrl, TestSSHEndpointOverridden", async () => {
    const dir = repo();
    git(dir, "config", "remote.origin.url", "git@example.com:foo/bar");
    git(dir, "config", "remote.origin.lfsurl", "lfs");
    git(dir, "config", "remote.two.url", "x");
    await compare(dir, await ours(dir));
    git(dir, "config", "lfs.url", "git@example.com:foo/bar.git");
    await compare(dir, await ours(dir));
  });

  it('endpoint_finder_test.go TestInsteadOf, TestPushInsteadOf; t-config.sh "url alias config"', async () => {
    const dir = repo();
    git(dir, "config", "url.http://127.0.0.1:1/aliased/.insteadOf", "alias:");
    git(dir, "config", "url.http://127.0.0.1:1/longer/.insteadOf", "alias:long");
    git(dir, "config", "url.http://127.0.0.1:1/pushed/.pushInsteadOf", "alias:");
    git(dir, "config", "remote.origin.url", "alias:longrepo");
    git(dir, "config", "remote.other.url", "alias:repo");
    git(dir, "config", "remote.third.lfsurl", "alias:third");
    await compare(dir, await ours(dir), { locks: true, remotes: ["origin", "other", "third"] });
  });

  it('t-config.sh "config with remote.lfsdefault", branch remotes and push remotes', async () => {
    const dir = repo();
    commitFile(dir, "a", "a");
    for (const name of ["origin", "up", "pu", "only"]) {
      git(dir, "config", `remote.${name}.url`, `http://127.0.0.1:1/${name}`);
    }
    await compare(dir, await ours(dir), { locks: true });
    git(dir, "config", "remote.lfsdefault", "only");
    await compare(dir, await ours(dir), { locks: true });
    git(dir, "config", "remote.pushDefault", "pu");
    await compare(dir, await ours(dir), { locks: true });
    git(dir, "config", "remote.lfspushdefault", "up");
    await compare(dir, await ours(dir), { locks: true });
    git(dir, "config", "branch.main.remote", "up");
    git(dir, "config", "branch.main.pushRemote", "only");
    await compare(dir, await ours(dir), { locks: true });
  });

  it("one remote is the default; an unborn branch's remote is not looked at", async () => {
    const dir = repo();
    git(dir, "config", "remote.single.url", "http://127.0.0.1:1/single");
    git(dir, "config", "branch.main.remote", "origin");
    await compare(dir, await ours(dir), { locks: true });
    // a remote named by a URL, and one without URL (`git remote` lists it)
    git(dir, "config", "remote.nourl.fetch", "+refs/heads/*:refs/remotes/nourl/*");
    await compare(dir, await ours(dir), {
      locks: true,
      remotes: ["nourl", "http://127.0.0.1:1/byurl.git"],
    });
  });

  it('t-config.sh "lfsconfig ignores unsafe keys": what .lfsconfig may set', async () => {
    const dir = repo();
    git(dir, "remote", "add", "origin", "http://127.0.0.1:1/repo");
    commitFile(
      dir,
      ".lfsconfig",
      [
        '[remote "origin"]',
        "\turl = http://127.0.0.1:1/evil-url",
        "\tpushurl = http://127.0.0.1:1/evil-push",
        "\tlfspushurl = http://127.0.0.1:1/evil-lfspush",
        "\tlfsurl = http://127.0.0.1:1/lfsconfig-origin",
        '[remote "a.b"]',
        "\turl = http://127.0.0.1:1/dotted",
        '[url "http://127.0.0.1:1/evil/"]',
        "\tinsteadOf = http://127.0.0.1:1/",
        "[core]",
        "\thooksPath = x",
        '[lfs "extension.foo"]',
        "\tclean = c",
        "\tpriority = 2",
        "[lfs]",
        "\tpushurl = http://127.0.0.1:1/lfsconfig-push",
        "\tgitprotocol = http",
        '[lfs "https://elsewhere.example/"]',
        "\taccess = basic",
        "",
      ].join("\n"),
    );
    await compare(dir, await ours(dir), { locks: true, remotes: ["origin", "a.b"] });
  });

  it("a bare repository reads HEAD's .lfsconfig", async () => {
    const work = repo();
    commitFile(work, ".lfsconfig", "[lfs]\n\turl = http://127.0.0.1:1/bare-lfs\n");
    const dir = join(root, `bare${counter++}`);
    git(root, "clone", "-q", "--bare", work, dir);
    // git-lfs runs in the bare repository's directory
    const g = await oursBare(dir);
    expect(await oursEnv(g)).toEqual(nativeEnv(dir));
    expect(nativeLocks(dir, false)).toBe(
      (await g.lfsEndpoint().setCompatibility(lfsVersion).call()).url,
    );
  });

  it("local paths and file:// URLs", async () => {
    const dir = repo();
    const other = repo();
    const bare = join(root, `plain${counter++}.git`);
    mkdirSync(bare);
    git(dir, "config", "remote.abs.url", other);
    git(dir, "config", "remote.absgit.url", `${other}/.git`);
    git(dir, "config", "remote.plain.url", bare);
    git(dir, "config", "remote.dotdot.url", `${other}/../${other.split("/").pop()}`);
    git(dir, "config", "remote.missing.url", join(root, "missing-dir"));
    git(dir, "config", "remote.file.url", `file://${other}`);
    git(dir, "config", "remote.rel.url", `../${other.split("/").pop()}`);
    git(dir, "config", "remote.rel2.url", "sub");
    mkdirSync(join(dir, "sub"));
    symlinkSync(other, join(dir, "linked"));
    git(dir, "config", "remote.linked.url", "linked");
    await compare(dir, await ours(dir));
  });

  it("a .lfsconfig git cannot parse drops the whole configuration, a blob is passed over", async () => {
    const dir = repo();
    git(dir, "remote", "add", "origin", "http://127.0.0.1:1/repo");
    commitFile(dir, ".lfsconfig", "[lfs\n");
    rmSync(join(dir, ".lfsconfig"));
    git(dir, "rm", "-q", "--cached", ".lfsconfig");
    await compare(dir, await ours(dir), { locks: true, remotes: ["origin"] });
  });

  it("a worktree .lfsconfig git cannot parse: git-lfs reads no configuration", async () => {
    const dir = repo();
    git(dir, "remote", "add", "origin", "http://127.0.0.1:1/repo");
    git(dir, "config", "lfs.url", "http://127.0.0.1:1/lost");
    writeFileSync(join(dir, ".lfsconfig"), "[lfs\n");
    const g = await ours(dir);
    await compare(dir, g);
    expect((await g.lfsConfig(compat)).errors).toEqual([
      "Error reading `git config`: fatal: bad config line 1 in file .lfsconfig",
    ]);
  });

  it("git-lfs 3.5+: origin without any URL falls back on FETCH_HEAD's first line", async () => {
    const dir = repo();
    commitFile(dir, "a", "a");
    const id = git(dir, "rev-parse", "HEAD").trim();
    writeFileSync(
      join(dir, ".git/FETCH_HEAD"),
      `${id}\t\tbranch 'main' of http://127.0.0.1:1/fetched\n${id}\tnot-for-merge\tbranch 'x' of http://127.0.0.1:1/other\n`,
    );
    await compare(dir, await ours(dir), { locks: true, remotes: ["origin"] });
    // a line the pattern refuses (an ssh URL holds `@`): no endpoint
    writeFileSync(join(dir, ".git/FETCH_HEAD"), `${id}\t\tbranch 'main' of git@host:x\n`);
    await compare(dir, await ours(dir), { locks: true, remotes: ["origin"] });
    // another remote's own URL wins, and a remote other than origin never reads FETCH_HEAD
    git(dir, "config", "remote.up.url", "http://127.0.0.1:1/up");
    await compare(dir, await ours(dir), { locks: true, remotes: ["origin", "up"] });
  });

  it("ssh paths that need escaping (git-lfs 3.8.1 escapes the HTTPS fallback's path)", async () => {
    const dir = repo();
    git(dir, "config", "remote.origin.url", "ssh://git@example.com/a b/c%41/ü");
    git(dir, "config", "remote.bare.url", "git@example.com:x y/z?.git");
    await compare(dir, await ours(dir));
  });
});
