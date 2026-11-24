/**
 * Test-only: native twins of commands that write signed commits (rebase, cherry-pick,
 * revert, merge, am: statewalker/statewalker-root#319), with real throwaway keys in a
 * temporary directory: a GnuPG key in a temporary `GNUPGHOME` (the committer's identity, so
 * the default key) and an Ed25519 ssh key listed in an allowed signers file.
 *
 * - `ssh` (`gpg.format=ssh`, `user.signingKey` the key file): Ed25519 signatures are
 *   deterministic, so every commit ours writes must equal native git's byte for byte.
 * - `openpgp` (the default format): gpg signatures carry their time, so the commits are
 *   compared without their `gpgsig` header and parent ids, and the signatures are verified
 *   instead.
 *
 * Every commit of ours is also checked by native `git verify-commit` and by our
 * `verifyCommit()` (the Node verifier): signed where native git signs, unsigned where it
 * does not.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
  createNodeSigner,
  createNodeVerifier,
} from "@statewalker/vcs-utils-node/files";
import { expect } from "vitest";

import type { Git } from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const has = (program: string, ...args: string[]) =>
  spawnSync(program, args, { stdio: "ignore" }).error === undefined;

/** Native git, gpg and ssh-keygen are there (Linux): the twins can run. */
export const signingTwinsReady =
  nativeGitAvailable() &&
  process.platform === "linux" &&
  has("gpg", "--version") &&
  has("ssh-keygen", "-?");

/** The signature formats the twins run in. */
export type TwinFormat = "ssh" | "openpgp";
export const FORMATS: readonly TwinFormat[] = ["ssh", "openpgp"];

/** The temporary home of the keys and twins (one per test file). */
export class SigningFixture {
  readonly root: string;
  private counter = 0;
  private sshKey = "";

  constructor(prefix: string) {
    this.root = mkdtempSync(join(tmpdir(), prefix));
    mkdirSync(join(this.root, "gnupg"), { mode: 0o700 });
    const r = spawnSync(
      "gpg",
      [
        "--batch",
        "--passphrase",
        "",
        "--quick-gen-key",
        "Interop Tester <interop@example.com>",
        "ed25519",
        "sign",
        "never",
      ],
      { env: this.env(), encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`gpg could not make a key: ${r.stderr}`);
    mkdirSync(join(this.root, "ssh"));
    this.sshKey = join(this.root, "ssh", "id_ed25519");
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "tester",
      "-f",
      this.sshKey,
    ]);
    const pub = readFileSync(`${this.sshKey}.pub`, "utf8").trim();
    writeFileSync(
      join(this.root, "ssh", "allowed_signers"),
      `interop@example.com namespaces="git" ${pub}\n`,
    );
  }

  /** Removes the keys (the gpg agent stopped) and the twins. */
  dispose(): void {
    spawnSync("gpgconf", ["--kill", "all"], { env: this.env() });
    rmSync(this.root, { recursive: true, force: true });
  }

  /** The environment of native git and ours (dates and identities pinned, GIT_EDITOR=true). */
  env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...nativeGitEnv(this.root),
      GIT_EDITOR: "true",
      GNUPGHOME: join(this.root, "gnupg"),
      ...extra,
    };
  }

  /** The repository settings of a format (the key, the allowed signers). */
  formatConfig(format: TwinFormat): Record<string, string> {
    return format === "ssh"
      ? {
          "gpg.format": "ssh",
          "user.signingKey": this.sshKey,
          "gpg.ssh.allowedSignersFile": join(this.root, "ssh", "allowed_signers"),
        }
      : {};
  }

  /** Native git in `cwd`: status, stdout, stderr. */
  git(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
    const r = spawnSync("git", args, { cwd, env: this.env(extraEnv), encoding: "utf8" });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  /** Native git that must succeed: its stdout. */
  gitOk(cwd: string, ...args: string[]): string {
    const r = this.git(cwd, args);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  }

  /** t/test-lib-functions.sh's `test_commit <name>`: `<name>.t` holding the name, tagged. */
  testCommit(dir: string, name: string): void {
    writeFileSync(join(dir, `${name}.t`), `${name}\n`);
    this.gitOk(dir, "add", `${name}.t`);
    this.gitOk(dir, "commit", "-q", "-m", name);
    this.gitOk(dir, "tag", name);
  }

  /**
   * Two repositories (native, ours) built by the same steps (`git init <initArgs>`), the
   * format's settings in both before `build` runs (so a setup commit may be signed too).
   */
  twins(format: TwinFormat, build: (dir: string) => void, initArgs: string[] = []) {
    const n = this.counter++;
    const dirs = { native: join(this.root, `native-${n}`), ours: join(this.root, `ours-${n}`) };
    for (const dir of [dirs.native, dirs.ours]) {
      mkdirSync(dir, { recursive: true });
      this.gitOk(dir, "init", "-q", "-b", "main", ...initArgs);
      for (const [key, value] of Object.entries(this.formatConfig(format))) {
        this.gitOk(dir, "config", key, value);
      }
      build(dir);
    }
    return dirs;
  }

  /** Our working copy over `dir`: the Node signer and verifier, as the sandbox's git behaves. */
  ours(dir: string): Promise<Git> {
    const env = this.env();
    const compatibility = nativeIs25x ? "2.56" : "2.43";
    return openOurs(
      dir,
      createNodeGitHostEnvironment({
        env,
        signer: createNodeSigner({ env }),
        verifier: createNodeVerifier({ env, compatibility }),
        hookRunner: createNodeHookRunner({ env, compatibility }),
      }),
    );
  }

  /** The commits of `range` (newest first). */
  revList(dir: string, ...range: string[]): string[] {
    return this.gitOk(dir, "rev-list", ...range)
      .split("\n")
      .filter((l) => l !== "");
  }

  /** The raw commit object `rev`. */
  rawCommit(dir: string, rev: string): string {
    return this.gitOk(dir, "cat-file", "commit", rev);
  }

  /**
   * The twins wrote the same commits on `range` (default HEAD's whole history): byte for byte
   * in ssh, without their signature in openpgp; each commit of ours verifies (native
   * `verify-commit` and ours) exactly where native git's does, and `signed` says whether
   * they must (true: all, false: none, a list: each commit's, newest first).
   */
  async expectSameCommits(
    format: TwinFormat,
    dirs: { native: string; ours: string },
    signed: boolean | boolean[],
    range: string[] = ["HEAD"],
    label = "",
  ): Promise<void> {
    const nativeIds = this.revList(dirs.native, ...range);
    const ourIds = this.revList(dirs.ours, ...range);
    expect(ourIds.length, `${label}: commits`).toBe(nativeIds.length);
    const g = await this.ours(dirs.ours);
    for (let k = 0; k < nativeIds.length; k++) {
      const nativeId = nativeIds[k] as string;
      const ourId = ourIds[k] as string;
      const nativeRaw = this.rawCommit(dirs.native, nativeId);
      const ourRaw = this.rawCommit(dirs.ours, ourId);
      const what = `${label}: commit ${k} of ${range.join(" ")}`;
      if (format === "ssh") {
        expect(ourRaw, what).toBe(nativeRaw);
        expect(ourId, what).toBe(nativeId);
      } else {
        // the parents carry signatures of their own, so their ids differ too
        const even = (raw: string) =>
          withoutSignature(raw).replace(/^parent [0-9a-f]+$/gm, "parent <signed>");
        expect(even(ourRaw), what).toBe(even(nativeRaw));
      }
      const expected = Array.isArray(signed) ? signed[k] : signed;
      const nativeVerify = this.git(dirs.native, ["verify-commit", nativeId]);
      const ourVerifyByNative = this.git(dirs.ours, ["verify-commit", ourId]);
      expect(nativeVerify.status === 0, `${what}: native signed`).toBe(expected);
      expect(ourVerifyByNative.status, `${what}: ${ourVerifyByNative.stderr}`).toBe(
        nativeVerify.status,
      );
      const ourVerify = await g.verifyCommit().addCommit(ourId).call();
      expect(ourVerify.exitCode, `${what}: our verify-commit`).toBe(nativeVerify.status);
    }
  }
}

/** A raw commit without its `gpgsig` header (the signature and its continuation lines). */
export function withoutSignature(raw: string): string {
  const lines = raw.split("\n");
  const start = lines.findIndex((l) => l.startsWith("gpgsig ") || l.startsWith("gpgsig-sha256 "));
  if (start < 0) return raw;
  let end = start + 1;
  while (end < lines.length && lines[end]?.startsWith(" ")) end++;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}
