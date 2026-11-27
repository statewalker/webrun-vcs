/**
 * `.lfsconfig` is repository content: whoever writes the repository picks its `lfs.url`.
 * The endpoint follows git-lfs (see `lfs-config-native.test.ts`), but static credentials and
 * headers go to it only when the user's own configuration (the same resolution without
 * `.lfsconfig`) names its origin, or the caller named the origin; per-URL providers decide
 * for themselves, as a credential helper does.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

let root: string;
let counter = 0;
const credentials = { username: "user", password: "secret" };
const headers = { Authorization: "Bearer token" };

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: dir, env: testEnv(root), stdio: "ignore" });
}

async function repoWith(options: {
  lfsconfig?: string;
  config?: [string, string][];
}): Promise<Git> {
  const dir = join(root, `r${counter++}`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", "https://git.example.com/team/repo.git");
  for (const [key, value] of options.config ?? []) git(dir, "config", key, value);
  if (options.lfsconfig !== undefined) {
    writeFileSync(join(dir, ".lfsconfig"), options.lfsconfig);
    git(dir, "add", ".lfsconfig");
    git(dir, "commit", "-q", "-m", "lfsconfig");
  }
  return openOurs(dir, createNodeGitHostEnvironment({ env: testEnv(root) }));
}

describe.skipIf(!nativeGitAvailable())("LFS endpoint credentials", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lfs-endpoint-credentials-"));
  });
  afterAll(async () => {
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  it("the remote's own endpoint gets the credentials and headers", async () => {
    const g = await repoWith({});
    const ep = await g.lfsEndpoint().setCredentials(credentials).setHeaders(headers).call();
    expect(ep).toMatchObject({
      url: "https://git.example.com/team/repo.git/info/lfs",
      source: "remote.url",
      fromLfsconfig: false,
      trusted: true,
      auth: { credentials, headers },
    });
  });

  it("a .lfsconfig pointing at another host gets nothing", async () => {
    for (const lfsconfig of [
      "[lfs]\n\turl = https://attacker.example/lfs\n",
      '[remote "origin"]\n\tlfsurl = https://attacker.example/lfs\n',
      "[lfs]\n\tpushurl = https://attacker.example/lfs\n",
      // same host, another port or scheme: another origin
      "[lfs]\n\turl = https://git.example.com:8443/lfs\n",
      "[lfs]\n\turl = http://git.example.com/team/repo.git/info/lfs\n",
      // userinfo tricks and ssh
      "[lfs]\n\turl = https://git.example.com@attacker.example/lfs\n",
      "[lfs]\n\turl = git@attacker.example:team/repo.git\n",
    ]) {
      const g = await repoWith({ lfsconfig });
      for (const operation of ["download", "upload"] as const) {
        const ep = await g
          .lfsEndpoint()
          .setOperation(operation)
          .setCredentials(credentials)
          .setHeaders(headers)
          .call();
        if (ep.source?.startsWith("lfs.") || ep.source === "remote.lfsurl") {
          expect(ep.fromLfsconfig).toBe(true);
        }
        if (ep.fromLfsconfig) {
          expect({ lfsconfig, operation, auth: ep.auth, trusted: ep.trusted }).toEqual({
            lfsconfig,
            operation,
            auth: {},
            trusted: false,
          });
        }
      }
    }
  });

  it("a .lfsconfig keeping the remote's origin keeps its credentials", async () => {
    const g = await repoWith({ lfsconfig: "[lfs]\n\turl = https://git.example.com/lfs/team\n" });
    const ep = await g.lfsEndpoint().setCredentials(credentials).call();
    expect(ep).toMatchObject({
      url: "https://git.example.com/lfs/team",
      fromLfsconfig: true,
      trusted: true,
      auth: { credentials },
    });
  });

  it("the user's own lfs.url is trusted; a named origin replaces the default", async () => {
    const g = await repoWith({ config: [["lfs.url", "https://lfs.example.net/repo"]] });
    expect(await g.lfsEndpoint().setCredentials(credentials).call()).toMatchObject({
      url: "https://lfs.example.net/repo",
      auth: { credentials },
    });
    const named = await (await repoWith({ config: [["lfs.url", "https://lfs.example.net/r"]] }))
      .lfsEndpoint()
      .setCredentials(credentials)
      .addCredentialOrigin("https://git.example.com")
      .call();
    expect(named.auth).toEqual({});
  });

  it("a named origin allows a .lfsconfig endpoint", async () => {
    const g = await repoWith({ lfsconfig: "[lfs]\n\turl = https://lfs.example.net/repo\n" });
    const ep = await g
      .lfsEndpoint()
      .setCredentials(credentials)
      .addCredentialOrigin("https://lfs.example.net")
      .call();
    expect(ep).toMatchObject({ trusted: true, auth: { credentials } });
  });

  it("per-URL providers are asked with the endpoint's URL", async () => {
    const g = await repoWith({ lfsconfig: "[lfs]\n\turl = https://attacker.example/lfs\n" });
    const asked: string[] = [];
    const ep = await g
      .lfsEndpoint()
      .setCredentials(credentials)
      .setCredentialsForUrl((url) => {
        asked.push(url);
        return url.startsWith("https://git.example.com/") ? credentials : undefined;
      })
      .call();
    expect(asked).toEqual(["https://attacker.example/lfs"]);
    expect(ep.auth).toEqual({});
  });

  it("an unsafe key of .lfsconfig cannot rewrite the remote's URL", async () => {
    const g = await repoWith({
      lfsconfig:
        '[url "https://attacker.example/"]\n\tinsteadOf = https://git.example.com/\n[remote "origin"]\n\turl = https://attacker.example/x\n',
    });
    const ep = await g.lfsEndpoint().setCredentials(credentials).call();
    expect(ep).toMatchObject({
      url: "https://git.example.com/team/repo.git/info/lfs",
      fromLfsconfig: false,
      auth: { credentials },
    });
    expect(ep.warnings).toEqual([
      "warning: These unsafe '.lfsconfig' keys were ignored:",
      "",
      "  url.https://attacker.example/.insteadof",
      "  remote.origin.url",
    ]);
  });

  it("a token becomes basic credentials; no origin means no credentials", async () => {
    const g = await repoWith({});
    expect(
      (await g.lfsEndpoint().setCredentials({ token: "t0k" }).call()).auth.credentials,
    ).toEqual({ username: "x-access-token", password: "t0k" });
    expect(() => g.lfsEndpoint().addCredentialOrigin("../path")).toThrow(/names no origin/);
  });

  it("a .lfsconfig choosing the default remote (a URL) gets nothing", async () => {
    for (const key of ["lfsdefault", "lfspushdefault", "pushDefault"]) {
      for (const value of ["https://attacker.example/x", "attacker.example:x"]) {
        for (const tracked of [false, true]) {
          const g = await repoWith({
            lfsconfig: `[remote]\n\t${key} = ${value}\n`,
            config: tracked ? [["branch.main.remote", "origin"]] : [],
          });
          for (const operation of ["download", "upload"] as const) {
            const ep = await g
              .lfsEndpoint()
              .setOperation(operation)
              .setCredentials(credentials)
              .setHeaders(headers)
              .call();
            const toAttacker = ep.url.includes("attacker.example");
            expect({
              key,
              value,
              tracked,
              operation,
              leaked: toAttacker && ep.auth.credentials !== undefined,
            }).toEqual({ key, value, tracked, operation, leaked: false });
            if (toAttacker)
              expect(ep).toMatchObject({ fromLfsconfig: true, trusted: false, auth: {} });
          }
        }
      }
    }
  });

  it("a .lfsconfig lfs.gitprotocol cannot downgrade a trusted endpoint", async () => {
    const dir = join(root, `r${counter++}`);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "remote", "add", "origin", "git://git.example.com/team/repo.git");
    writeFileSync(join(dir, ".lfsconfig"), "[lfs]\n\tgitprotocol = http\n");
    const g = await openOurs(dir, createNodeGitHostEnvironment({ env: testEnv(root) }));
    const ep = await g.lfsEndpoint().setCredentials(credentials).call();
    expect(ep.url).toBe("http://git.example.com/team/repo.git/info/lfs");
    expect(ep.auth).toEqual({});
  });

  it("a URL FETCH_HEAD names is no user configuration: no credentials", async () => {
    const dir = join(root, `r${counter++}`);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "remote.up.url", "https://git.example.com/team/repo.git");
    git(dir, "config", "remote.up2.url", "https://git.example.com/team/other.git");
    writeFileSync(
      join(dir, ".git/FETCH_HEAD"),
      `${"a".repeat(40)}\t\tbranch 'main' of https://attacker.example/fork\n`,
    );
    const g = await openOurs(dir, createNodeGitHostEnvironment({ env: testEnv(root) }));
    for (const operation of ["download", "upload"] as const) {
      const ep = await g
        .lfsEndpoint()
        .setOperation(operation)
        .setCredentials(credentials)
        .setHeaders(headers)
        .call();
      expect(ep).toMatchObject({
        url: "https://attacker.example/fork.git/info/lfs",
        source: "fetch-head",
        trusted: false,
        auth: {},
      });
    }
  });
});

describe.skipIf(!nativeGitAvailable())("LFS endpoint across git-lfs versions", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lfs-endpoint-versions-"));
  });
  afterAll(async () => {
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  async function lfsOf(
    setup: (dir: string) => void,
    compatibility: string,
  ): Promise<Awaited<ReturnType<Git["lfsConfig"]>>> {
    const dir = join(root, `v${counter++}`);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    setup(dir);
    const g = await openOurs(dir, createNodeGitHostEnvironment({ env: testEnv(root) }));
    return g.lfsConfig({ compatibility });
  }

  it("FETCH_HEAD: git-lfs 3.5+ reads it for origin, 3.4 does not", async () => {
    const setup = (dir: string) =>
      writeFileSync(
        join(dir, ".git/FETCH_HEAD"),
        `${"b".repeat(40)}\tnot-for-merge\ttag 'v1' of http://h.example/r\n`,
      );
    expect((await (await lfsOf(setup, "3.5.0")).endpoint("download")).url).toBe(
      "http://h.example/r.git/info/lfs",
    );
    expect((await (await lfsOf(setup, "v3.8.1")).endpoint("upload", "origin")).url).toBe(
      "http://h.example/r.git/info/lfs",
    );
    expect((await (await lfsOf(setup, "3.8.1")).endpoint("download", "other")).url).toBe(
      "http://h.example/r.git/info/lfs",
    );
    expect((await (await lfsOf(setup, "3.4.1")).endpoint("download")).url).toBe("");
  });

  it(".lfsconfig keys: 3.8.1 keeps only remote.*.lfsurl and lfs.*.access", async () => {
    const setup = (dir: string) => {
      writeFileSync(
        join(dir, ".lfsconfig"),
        '[remote]\n\tlfsdefault = up\n[remote "a.b"]\n\turl = https://x/y\n[remote "origin"]\n\tlfsurl = https://l/o\n[http "https://h/"]\n\taccess = basic\n[lfs "https://h/"]\n\taccess = basic\n',
      );
    };
    const strict = await lfsOf(setup, "3.8.1");
    expect(strict.warnings).toEqual([
      "warning: These unsafe '.lfsconfig' keys were ignored:",
      "",
      "  remote.lfsdefault",
      "  remote.a.b.url",
      "  http.https://h/.access",
    ]);
    expect(strict.remote()).toBe("origin");
    expect((await strict.endpoint("download")).url).toBe("https://l/o");
    const old = await lfsOf(setup, "3.4.1");
    expect(old.warnings).toEqual([]);
    expect(old.remote()).toBe("up");
  });

  it("ssh fallback path: escaped from 3.8.1 on", async () => {
    const setup = (dir: string) =>
      git(dir, "config", "remote.origin.url", "ssh://git@example.com/a b/ü");
    expect((await (await lfsOf(setup, "3.8.1")).endpoint("download")).url).toBe(
      "https://example.com/a%20b/%C3%BC.git/info/lfs",
    );
    expect((await (await lfsOf(setup, "3.4.1")).endpoint("download")).url).toBe(
      "https://example.com/a b/ü.git/info/lfs",
    );
  });
});
