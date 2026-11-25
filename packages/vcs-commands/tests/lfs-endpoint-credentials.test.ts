/**
 * `.lfsconfig` is repository content: whoever writes the repository picks its `lfs.url`.
 * The endpoint follows git-lfs (see `lfs-config-native.test.ts`), but static credentials and
 * headers go to it only when the user's own configuration (the same resolution without
 * `.lfsconfig`) names its origin, or the caller named the origin; per-URL providers decide
 * for themselves, as a credential helper does.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { testEnv } from "./status-native-support.js";

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
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

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
});
