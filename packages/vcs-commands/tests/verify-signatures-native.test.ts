/**
 * Signature checks (statewalker/statewalker-root#318) against native git: `verify-commit`,
 * `verify-tag`, the `%G` placeholders, `log --show-signature` / `log.showSignature`, and
 * `merge`/`pull --verify-signatures` (`merge.verifySignatures`), through the Node verifier
 * (`createNodeVerifier`) running the same gpg and ssh-keygen native git runs.
 *
 * Real throwaway keys only, in this test's temporary directory: a GnuPG home with an
 * ultimately trusted key (the committer's), an imported key of undefined trust, a key that
 * expired, and a second home holding keys the first does not know; Ed25519 ssh keys listed in
 * an allowed signers file (one with `valid-before` before the commits' date, one revoked).
 * Both twins read one repository native git built (good, bad, unknown-key, untrusted,
 * expired and missing signatures, in openpgp and ssh), so their output must be equal byte for
 * byte. Each test names the t/ script and test title its inputs come from.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeSigner,
  createNodeVerifier,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createSshVerifier,
  FastForwardMode,
  type Git,
  SignatureVerificationError,
} from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { openOurs, put } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const has = (program: string, ...args: string[]) =>
  spawnSync(program, args, { stdio: "ignore" }).error === undefined;

const ready =
  nativeGitAvailable() &&
  process.platform === "linux" &&
  has("gpg", "--version") &&
  has("ssh-keygen", "-?");
const describeGit = ready ? describe : describe.skip;

let root: string;
/** The repository both twins read */
let repo: string;
/** Commit and tag names of the fixture, with their ids */
const ids: Record<string, string> = {};

/** Extra `-c` settings, as GIT_CONFIG_* after the test environment's own two */
function env(config: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    ...nativeGitEnv(root),
    GIT_EDITOR: "true",
    GNUPGHOME: join(root, "gnupg"),
    TZ: "UTC",
  };
  let n = Number(base.GIT_CONFIG_COUNT ?? "0");
  for (const [key, value] of Object.entries(config)) {
    base[`GIT_CONFIG_KEY_${n}`] = key;
    base[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  base.GIT_CONFIG_COUNT = String(n);
  return base;
}

/** Native git in `cwd`: status, stdout, stderr. */
function git(cwd: string, args: string[], config: Record<string, string> = {}) {
  const r = spawnSync("git", args, { cwd, env: env(config), encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function gitOk(cwd: string, args: string[], config: Record<string, string> = {}): string {
  return execFileSync("git", args, { cwd, env: env(config), encoding: "utf8", stdio: "pipe" });
}

/** Our working copy over `dir`, with the Node verifier and the `-c` settings given. */
function ours(dir: string, config: Record<string, string> = {}): Promise<Git> {
  const e = env(config);
  return openOurs(
    dir,
    createNodeGitHostEnvironment({
      env: e,
      signer: createNodeSigner({ env: e }),
      verifier: createNodeVerifier({ env: e, compatibility: nativeIs25x ? "2.56" : "2.43" }),
    }),
  );
}

/** A `gpg.program` running gpg with `prefix` arguments, or in another GnuPG home. */
function gpgWrapper(name: string, line: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\n${line}\n`);
  chmodSync(path, 0o755);
  return path;
}

const COMMITS_GPG = ["good", "unsigned", "untrusted", "unknown", "expired", "forged"];
const COMMITS_SSH = ["ssh-good", "ssh-untrusted", "ssh-expired", "ssh-revoked", "ssh-forged"];
const ALL_COMMITS = [...COMMITS_GPG, ...COMMITS_SSH, "merge-tag"];
const TAGS = ["t-good", "t-forged", "t-unsigned", "t-unknown", "t-ssh", "t-ssh-forged", "t-light"];

/** The commit `forged` of `id`: its message changed, written with hash-object. */
function forge(dir: string, id: string, from: string, to: string): string {
  const raw = gitOk(dir, ["cat-file", "commit", id]).replace(from, to);
  return execFileSync("git", ["hash-object", "-w", "-t", "commit", "--stdin"], {
    cwd: dir,
    env: env(),
    input: raw,
    encoding: "utf8",
  }).trim();
}

function forgeTag(dir: string, id: string, from: string, to: string): string {
  const raw = gitOk(dir, ["cat-file", "tag", id]).replace(from, to);
  return execFileSync("git", ["hash-object", "-w", "-t", "tag", "--stdin"], {
    cwd: dir,
    env: env(),
    input: raw,
    encoding: "utf8",
  }).trim();
}

describeGit("signature checks against native git", { timeout: 120_000 }, () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "verify-signatures-"));
    const home = join(root, "gnupg");
    const other = join(root, "gnupg-other");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(other, { mode: 0o700 });
    const gpg = (args: string[], gnupghome = home) =>
      execFileSync("gpg", ["--batch", "--passphrase", "", ...args], {
        env: { ...env(), GNUPGHOME: gnupghome },
        stdio: "pipe",
      });
    gpg(["--quick-gen-key", "Interop Tester <interop@example.com>", "ed25519", "sign", "never"]);
    gpg(
      ["--quick-gen-key", "Untrusted <untrusted@example.com>", "ed25519", "sign", "never"],
      other,
    );
    gpg(["--quick-gen-key", "Unknown <unknown@example.com>", "ed25519", "sign", "never"], other);
    execFileSync("gpg", ["--batch", "--import"], {
      env: { ...env(), GNUPGHOME: home },
      input: gpg(["--export", "untrusted@example.com"], other),
      stdio: ["pipe", "pipe", "pipe"],
    });
    gpg([
      "--faked-system-time",
      "20200101T000000",
      "--quick-gen-key",
      "Expired <expired@example.com>",
      "ed25519",
      "sign",
      "2020-06-01",
    ]);
    // the trust database checked now, not by the first check a test makes
    gpg(["--check-trustdb"]);
    const otherGpg = gpgWrapper("other-gpg", `GNUPGHOME='${other}' exec gpg "$@"`);
    const pastGpg = gpgWrapper("past-gpg", 'exec gpg --faked-system-time 20200301T000000 "$@"');

    // ssh keys: trusted, unknown, expired (valid before the commits' date), revoked
    const ssh = join(root, "ssh");
    mkdirSync(ssh);
    const sshKey = (name: string) => {
      const key = join(ssh, name);
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", key]);
      return { key, pub: readFileSync(`${key}.pub`, "utf8").trim() };
    };
    const trusted = sshKey("trusted");
    const untrusted = sshKey("untrusted");
    const expired = sshKey("expired");
    const revoked = sshKey("revoked");
    writeFileSync(
      join(ssh, "allowed_signers"),
      [
        `interop@example.com namespaces="git" ${trusted.pub}`,
        `expired@example.com namespaces="git",valid-before="20000101" ${expired.pub}`,
        `revoked@example.com namespaces="git" ${revoked.pub}`,
        "",
      ].join("\n"),
    );
    writeFileSync(join(ssh, "revoked_keys"), `${revoked.pub}\n`);

    repo = join(root, "repo");
    mkdirSync(repo);
    gitOk(repo, ["init", "-q", "-b", "main"]);
    gitOk(repo, ["config", "gpg.ssh.allowedSignersFile", join(ssh, "allowed_signers")]);
    gitOk(repo, ["config", "gpg.ssh.revocationFile", join(ssh, "revoked_keys")]);
    let n = 0;
    const commit = (name: string, args: string[] = [], config: Record<string, string> = {}) => {
      put(repo, `f${n++}.txt`, `${name}\n`);
      gitOk(repo, ["add", "-A"]);
      gitOk(repo, ["commit", "-q", "-m", name, ...args], config);
      ids[name] = gitOk(repo, ["rev-parse", "HEAD"]).trim();
    };
    commit("good", ["-S"]);
    commit("unsigned");
    commit("untrusted", ["-Suntrusted@example.com"], { "gpg.program": otherGpg });
    commit("unknown", ["-Sunknown@example.com"], { "gpg.program": otherGpg });
    commit("expired", ["-Sexpired@example.com"], { "gpg.program": pastGpg });
    ids.forged = forge(repo, ids.good as string, "\ngood\n", "\nforged good\n");
    const sshConfig = (key: string) => ({ "gpg.format": "ssh", "user.signingKey": key });
    commit("ssh-good", ["-S"], sshConfig(trusted.key));
    commit("ssh-untrusted", ["-S"], sshConfig(untrusted.key));
    commit("ssh-expired", ["-S"], sshConfig(expired.key));
    commit("ssh-revoked", ["-S"], sshConfig(revoked.key));
    ids["ssh-forged"] = forge(repo, ids["ssh-good"] as string, "\nssh-good\n", "\nssh-forged\n");

    // tags
    gitOk(repo, ["tag", "-s", "-m", "good tag", "t-good", ids.good as string]);
    gitOk(repo, ["tag", "-a", "-m", "unsigned tag", "t-unsigned", ids.good as string]);
    gitOk(repo, ["tag", "-s", "-u", "unknown@example.com", "-m", "unknown", "t-unknown"], {
      "gpg.program": otherGpg,
    });
    gitOk(repo, ["tag", "-s", "-m", "ssh tag", "t-ssh"], sshConfig(trusted.key));
    gitOk(repo, ["tag", "t-light"]);
    const forgedTag = forgeTag(
      repo,
      gitOk(repo, ["rev-parse", "t-good"]).trim(),
      "good tag",
      "evil tag",
    );
    gitOk(repo, ["tag", "t-forged", forgedTag]);
    const forgedSsh = forgeTag(repo, gitOk(repo, ["rev-parse", "t-ssh"]).trim(), "ssh tag", "evil");
    gitOk(repo, ["tag", "t-ssh-forged", forgedSsh]);

    // a merge of a signed tag (a mergetag header) on a side branch
    gitOk(repo, ["checkout", "-q", "-b", "side", ids.good as string]);
    put(repo, "side.txt", "side\n");
    gitOk(repo, ["add", "-A"]);
    gitOk(repo, ["commit", "-q", "-m", "side"]);
    gitOk(repo, ["tag", "-s", "-m", "side tag", "t-side"]);
    gitOk(repo, ["checkout", "-q", "main"]);
    gitOk(repo, ["merge", "-q", "--no-ff", "-m", "merge-tag", "t-side"]);
    ids["merge-tag"] = gitOk(repo, ["rev-parse", "HEAD"]).trim();
    for (const tag of TAGS) ids[tag] = gitOk(repo, ["rev-parse", tag]).trim();
  }, 120_000);

  afterAll(() => {
    spawnSync("gpgconf", ["--kill", "all"], { env: env() });
    rmSync(root, { recursive: true, force: true });
  });

  /** git verify-commit / verify-tag with `args` against ours, compared whole. */
  async function compareVerify(
    kind: "commit" | "tag",
    name: string,
    options: { verbose?: boolean; raw?: boolean } = {},
    config: Record<string, string> = {},
  ) {
    const args = [
      `verify-${kind}`,
      ...(options.verbose ? ["-v"] : []),
      ...(options.raw ? ["--raw"] : []),
      ids[name] ?? name,
    ];
    const native = git(repo, args, config);
    const g = await ours(repo, config);
    const command =
      kind === "commit"
        ? g.verifyCommit().addCommit(ids[name] ?? name)
        : g.verifyTag().addTag(ids[name] ?? name);
    const result = await command.setVerbose(!!options.verbose).setRaw(!!options.raw).call();
    const label = `${args.join(" ")} (${name})`;
    expect(result.exitCode, `${label}: ${native.stderr}`).toBe(native.status);
    expect(result.stderr, label).toBe(native.stderr);
    expect(new TextDecoder().decode(result.stdout), label).toBe(native.stdout);
    return { native, result };
  }

  it('t7510-signed-commit.sh: "verify and show signatures", "verify-commit exits success on untrusted signature", "detect fudged signature", "verify signatures with --raw", "show signed commit with signature"', async () => {
    for (const name of COMMITS_GPG) {
      await compareVerify("commit", name);
      await compareVerify("commit", name, { raw: true });
      await compareVerify("commit", name, { verbose: true });
    }
    // the outcomes git gives them
    expect(git(repo, ["verify-commit", ids.good as string]).status).toBe(0);
    expect(git(repo, ["verify-commit", ids.forged as string]).status).toBe(1);
  });

  it('t7510-signed-commit.sh: "verify-commit exits success with matching minTrustLevel", "verify-commit exits success with low minTrustLevel", "verify-commit exits failure with high minTrustLevel"', async () => {
    for (const level of ["undefined", "marginal", "fully", "ultimate", "Ultimate"]) {
      for (const name of ["good", "untrusted", "expired"]) {
        await compareVerify("commit", name, {}, { "gpg.minTrustLevel": level });
      }
    }
  });

  it('t7528-signed-commit-ssh.sh: "verify and show signatures", "verify-commit exits failure on untrusted signature", "verify-commit exits failure on expired signature key", "detect fudged signature", "verify signatures with --raw"', async () => {
    for (const name of COMMITS_SSH) {
      await compareVerify("commit", name);
      await compareVerify("commit", name, { raw: true });
      await compareVerify("commit", name, { verbose: true });
    }
    for (const level of ["fully", "ultimate"]) {
      await compareVerify("commit", "ssh-good", {}, { "gpg.minTrustLevel": level });
    }
  });

  it('t7528-signed-commit-ssh.sh: "verify and show signatures", "verify-commit exits failure on untrusted signature", "verify-commit exits failure on expired signature key", "detect fudged signature", "show good signature with custom format", "show bad signature with custom format", "show untrusted signature with custom format"; t7031-verify-tag-signed-ssh.sh: "verify and show ssh signatures", "detect fudged ssh signature": the in-process ssh verifier', async () => {
    const e = env();
    const g = await openOurs(
      repo,
      createNodeGitHostEnvironment({
        env: e,
        verifier: createSshVerifier({
          readFile: async (path) => {
            try {
              return readFileSync(path, "utf8");
            } catch {
              return undefined;
            }
          },
          localTzOffset: () => 0,
          compatibility: nativeIs25x ? "2.56" : "2.43",
        }),
      }),
    );
    const format = "%G?|%GS|%GK|%GF|%GP|%GT|%GG|%x00";
    for (const name of COMMITS_SSH) {
      const native = git(repo, ["verify-commit", ids[name] as string]);
      const result = await g
        .verifyCommit()
        .addCommit(ids[name] as string)
        .call();
      expect(result.exitCode, name).toBe(native.status);
      expect(result.stderr, name).toBe(native.stderr);
      const nf = git(repo, ["log", "-1", `--format=${format}`, ids[name] as string]);
      const text = await g
        .log()
        .add(ids[name] as string)
        .setMaxCount(1)
        .callText({ pretty: `tformat:${format}` });
      expect(text, name).toBe(nf.stdout);
    }
    for (const name of ["t-ssh", "t-ssh-forged"]) {
      const native = git(repo, ["verify-tag", name]);
      const result = await g.verifyTag().addTag(name).call();
      expect(result.exitCode, name).toBe(native.status);
      expect(result.stderr, name).toBe(native.stderr);
    }
  });

  it('t7528-signed-commit-ssh.sh: "verify-commit exits failure on untrusted signature": without gpg.ssh.allowedSignersFile', async () => {
    const native = git(repo, [
      "-c",
      "gpg.ssh.allowedSignersFile=",
      "verify-commit",
      ids["ssh-good"] as string,
    ]);
    // an empty value is a path too: compare instead the unset case through a copy
    const copy = join(root, "no-allowed");
    cpSync(repo, copy, { recursive: true });
    gitOk(copy, ["config", "--unset", "gpg.ssh.allowedSignersFile"]);
    const n = git(copy, ["verify-commit", ids["ssh-good"] as string]);
    const r = await (await ours(copy))
      .verifyCommit()
      .addCommit(ids["ssh-good"] as string)
      .call();
    expect(r.exitCode).toBe(n.status);
    expect(r.stderr).toBe(n.stderr);
    const fmt = ["log", "-1", "--format=%G?|%GS|%GT", ids["ssh-good"] as string];
    const nf = git(copy, fmt);
    const of = await (await ours(copy))
      .log()
      .add(ids["ssh-good"] as string)
      .setMaxCount(1)
      .callText({ pretty: "tformat:%G?|%GS|%GT" });
    expect(of).toBe(nf.stdout);
    expect(native.status).not.toBe(0);
  });

  it('t7030-verify-tag.sh: "verify and show signatures", "detect fudged signature", "verify signatures with --raw", "verify multiple tags"; t7031-verify-tag-signed-ssh.sh: "verify and show ssh signatures", "detect fudged ssh signature", "verify ssh signatures with --raw"', async () => {
    for (const name of TAGS) {
      await compareVerify("tag", name);
      await compareVerify("tag", name, { raw: true });
      await compareVerify("tag", name, { verbose: true });
    }
    // several at once, and names that are not tags or name nothing
    const names = ["t-good", "t-forged", "t-ssh", "main", "nosuch"];
    const native = git(repo, ["verify-tag", ...names]);
    const g = await ours(repo);
    const cmd = g.verifyTag();
    for (const n of names) cmd.addTag(n);
    const result = await cmd.call();
    expect(result.exitCode).toBe(native.status);
    expect(result.stderr).toBe(native.stderr);
    const nc = git(repo, ["verify-commit", "t-light", "nosuch", "HEAD^{tree}"]);
    const oc = await (await ours(repo))
      .verifyCommit()
      .addCommit("t-light")
      .addCommit("nosuch")
      .addCommit("HEAD^{tree}")
      .call();
    expect(oc.exitCode).toBe(nc.status);
    expect(oc.stderr).toBe(nc.stderr);
  });

  it('t7510-signed-commit.sh: "show good signature with custom format", "show bad signature with custom format", "show untrusted signature with custom format", "show unknown signature with custom format", "show lack of signature with custom format", "bare signature"; t7528-signed-commit-ssh.sh: "show good signature with custom format", "show bad signature with custom format", "show untrusted signature with custom format"', async () => {
    const format = "%G?|%GS|%GK|%GF|%GP|%GT|%GG|%x00";
    const g = await ours(repo);
    for (const name of ALL_COMMITS) {
      const native = git(repo, ["log", "-1", `--format=${format}`, ids[name] as string]);
      const text = await g
        .log()
        .add(ids[name] as string)
        .setMaxCount(1)
        .callText({ pretty: `tformat:${format}` });
      expect(text, name).toBe(native.stdout);
    }
  });

  it('t7510-signed-commit.sh: "show untrusted signature with undefined trust level", "show untrusted signature with ultimate trust level"', async () => {
    const format = "%G?|%GT";
    for (const level of ["undefined", "ultimate"]) {
      const g = await ours(repo, { "gpg.minTrustLevel": level });
      for (const name of ["good", "untrusted"]) {
        const native = git(repo, ["log", "-1", `--format=${format}`, ids[name] as string], {
          "gpg.minTrustLevel": level,
        });
        const text = await g
          .log()
          .add(ids[name] as string)
          .setMaxCount(1)
          .callText({ pretty: `tformat:${format}` });
        expect(text, `${level} ${name}`).toBe(native.stdout);
      }
    }
  });

  it('t7510-signed-commit.sh: "verify and show signatures", "log.showsignature behaves like --show-signature"; t7528-signed-commit-ssh.sh: "log.showsignature behaves like --show-signature"', async () => {
    const g = await ours(repo);
    for (const name of ALL_COMMITS) {
      for (const pretty of ["short", "oneline", "tformat:%s"]) {
        const native = git(repo, [
          "log",
          "-1",
          "--show-signature",
          `--pretty=${pretty}`,
          ids[name] as string,
        ]);
        const text = await g
          .log()
          .add(ids[name] as string)
          .setMaxCount(1)
          .callText({ pretty, showSignature: true });
        expect(text, `${name} ${pretty}`).toBe(native.stdout);
      }
    }
    // the whole history with a graph, and log.showSignature from the configuration
    const config = { "log.showSignature": "true" };
    const native = git(repo, ["log", "--graph", "--pretty=short", "main"], config);
    const text = await (await ours(repo, config))
      .log()
      .add(ids["merge-tag"] as string)
      .callText({ pretty: "short", graph: true });
    expect(text).toBe(native.stdout);
    const off = git(repo, ["log", "--no-show-signature", "-1", "main"], config);
    const offOurs = await (await ours(repo, config))
      .log()
      .add(ids["merge-tag"] as string)
      .setMaxCount(1)
      .callText({ showSignature: false });
    expect(offOurs).toBe(off.stdout);
  });

  /** A repository with main at `initial` and side branches, as t7612 creates it. */
  function mergeFixture(): string {
    const dir = join(root, "merge-src");
    if (ids["side-signed"]) return dir;
    mkdirSync(dir);
    gitOk(dir, ["init", "-q", "-b", "main"]);
    put(dir, "file", "1\n");
    gitOk(dir, ["add", "file"]);
    gitOk(dir, ["commit", "-q", "-m", "initial"]);
    gitOk(dir, ["tag", "initial"]);
    const side = (
      branch: string,
      file: string,
      args: string[],
      config: Record<string, string> = {},
    ) => {
      gitOk(dir, ["checkout", "-q", "-b", branch, "initial"]);
      put(dir, file, "3\n");
      gitOk(dir, ["add", file]);
      gitOk(dir, ["commit", "-q", "-m", `${branch} on side`, ...args], config);
      ids[branch] = gitOk(dir, ["rev-parse", "HEAD"]).trim();
    };
    side("side-signed", "elif", ["-S"]);
    side("side-unsigned", "foo", []);
    side("side-bad", "bar", ["-S"]);
    ids["side-forged"] = forge(
      dir,
      ids["side-bad"] as string,
      "\nside-bad on side",
      "\nforged bad on side",
    );
    gitOk(dir, ["branch", "side-forged", ids["side-forged"] as string]);
    side("side-untrusted", "baz", ["-Suntrusted@example.com"], {
      "gpg.program": join(root, "other-gpg"),
    });
    gitOk(dir, ["checkout", "-q", "main"]);
    return dir;
  }

  /** Two copies of the merge fixture, `prepare` run in each. */
  function mergeTwins(name: string, prepare?: (dir: string) => void) {
    const src = mergeFixture();
    const dirs = { native: join(root, `${name}-native`), ours: join(root, `${name}-ours`) };
    for (const dir of [dirs.native, dirs.ours]) {
      cpSync(src, dir, { recursive: true });
      prepare?.(dir);
    }
    return dirs;
  }

  const state = (dir: string) => ({
    head: git(dir, ["rev-parse", "-q", "--verify", "HEAD"]).stdout,
    status: gitOk(dir, ["status", "--porcelain"]),
  });

  it('t7612-merge-verify-signatures.sh: "merge unsigned commit with verification", "merge commit with bad signature with verification", "merge commit with untrusted signature with verification", "merge commit with untrusted signature with verification and high minTrustLevel", "merge commit with untrusted signature with verification and low minTrustLevel", "merge signed commit with verification", "merge commit with bad signature without verification", "merge commit with bad signature with merge.verifySignatures=true and --no-verify-signatures", "merge unsigned commit with merge.verifySignatures=true", "merge commit with untrusted signature with merge.verifySignatures=true and minTrustLevel"', async () => {
    mergeFixture();
    const cases: {
      branch: string;
      verify?: boolean;
      config?: Record<string, string>;
      ffOnly?: boolean;
    }[] = [
      { branch: "side-unsigned", verify: true, ffOnly: true },
      { branch: "side-forged", verify: true, ffOnly: true },
      { branch: "side-untrusted", verify: true, ffOnly: true },
      {
        branch: "side-untrusted",
        verify: true,
        ffOnly: true,
        config: { "gpg.minTrustLevel": "marginal" },
      },
      {
        branch: "side-untrusted",
        verify: true,
        ffOnly: true,
        config: { "gpg.minTrustLevel": "undefined" },
      },
      { branch: "side-signed", verify: true, ffOnly: true },
      { branch: "side-forged" },
      { branch: "side-forged", config: { "merge.verifySignatures": "false" } },
      { branch: "side-forged", verify: false, config: { "merge.verifySignatures": "true" } },
      { branch: "side-unsigned", ffOnly: true, config: { "merge.verifySignatures": "true" } },
      { branch: "side-untrusted", ffOnly: true, config: { "merge.verifySignatures": "true" } },
      {
        branch: "side-untrusted",
        ffOnly: true,
        config: { "merge.verifySignatures": "true", "gpg.minTrustLevel": "marginal" },
      },
      { branch: "side-signed", config: { "merge.verifySignatures": "true" }, ffOnly: true },
      // a merge commit, not a fast-forward
      { branch: "side-signed", verify: true },
      // the merged head already in HEAD: nothing to check
      { branch: "initial", verify: true },
    ];
    let k = 0;
    for (const c of cases) {
      const dirs = mergeTwins(`merge-${k++}`, (dir) => {
        gitOk(dir, ["checkout", "-q", "-b", "work", "side-unsigned"]);
        if (c.branch === "side-signed" && !c.ffOnly) return;
        gitOk(dir, ["reset", "-q", "--hard", "initial"]);
      });
      const args = [
        "merge",
        "-m",
        "merged",
        ...(c.ffOnly ? ["--ff-only"] : []),
        ...(c.verify === true
          ? ["--verify-signatures"]
          : c.verify === false
            ? ["--no-verify-signatures"]
            : []),
        ids[c.branch] ?? c.branch,
      ];
      const native = git(dirs.native, args, c.config ?? {});
      const g = await ours(dirs.ours, c.config ?? {});
      const merge = g
        .merge()
        .include(ids[c.branch] ?? c.branch)
        .setMessage("merged");
      if (c.ffOnly) merge.setFastForwardMode(FastForwardMode.FF_ONLY);
      if (c.verify !== undefined) merge.setVerifySignatures(c.verify);
      const label = `${args.join(" ")} ${JSON.stringify(c.config ?? {})}`;
      try {
        const result = await merge.call();
        expect(native.status, `${label}: ${native.stderr}`).toBe(0);
        const good = native.stdout.split("\n").filter((l) => l.includes("GPG signature"));
        expect(
          result.output?.filter((l) => l.includes("GPG signature")),
          label,
        ).toEqual(good);
      } catch (error) {
        if (!(error instanceof SignatureVerificationError)) throw error;
        expect(native.status, label).toBe(128);
        expect(`${error.message}\n`, label).toBe(native.stderr);
      }
      expect(state(dirs.ours), label).toEqual(state(dirs.native));
    }
  });

  it('t7612-merge-verify-signatures.sh: "merge unsigned commit into unborn branch"', async () => {
    for (const branch of ["side-unsigned", "side-signed"]) {
      const dirs = mergeTwins(`unborn-${branch}`, (dir) => {
        gitOk(dir, ["checkout", "-q", "--orphan", "unborn"]);
        gitOk(dir, ["rm", "-q", "-rf", "."]);
      });
      const native = git(dirs.native, ["merge", "--verify-signatures", ids[branch] as string]);
      const g = await ours(dirs.ours);
      try {
        await g
          .merge()
          .include(ids[branch] as string)
          .setVerifySignatures(true)
          .call();
        expect(native.status, native.stderr).toBe(0);
      } catch (error) {
        if (!(error instanceof SignatureVerificationError)) throw error;
        expect(native.status).toBe(128);
        expect(`${error.message}\n`).toBe(native.stderr);
      }
      expect(state(dirs.ours), branch).toEqual(state(dirs.native));
    }
  });

  it('t5573-pull-verify-signatures.sh: "pull unsigned commit with --verify-signatures", "pull commit with bad signature with --verify-signatures", "pull commit with untrusted signature with --verify-signatures", "pull commit with untrusted signature with --verify-signatures and minTrustLevel=ultimate", "pull commit with untrusted signature with --verify-signatures and minTrustLevel=marginal", "pull commit with untrusted signature with --verify-signatures and minTrustLevel=undefined", "pull signed commit with --verify-signatures", "pull commit with bad signature without verification", "pull commit with bad signature with --no-verify-signatures", "pull unsigned commit into unborn branch", "pull commit into unborn branch with bad signature and --verify-signatures", "pull commit into unborn branch with untrusted signature and --verify-signatures", "pull commit into unborn branch with untrusted signature and --verify-signatures and minTrustLevel=ultimate", "pull commit into unborn branch with untrusted signature and --verify-signatures and minTrustLevel=marginal", "pull commit into unborn branch with untrusted signature and --verify-signatures and minTrustLevel=undefined"', async () => {
    const src = mergeFixture();
    const cases: {
      branch: string;
      verify?: boolean;
      config?: Record<string, string>;
      unborn?: boolean;
    }[] = [];
    for (const unborn of [false, true]) {
      cases.push(
        { branch: "side-unsigned", verify: true, unborn },
        { branch: "side-forged", verify: true, unborn },
        { branch: "side-untrusted", verify: true, unborn },
        {
          branch: "side-untrusted",
          verify: true,
          unborn,
          config: { "gpg.minTrustLevel": "ultimate" },
        },
        {
          branch: "side-untrusted",
          verify: true,
          unborn,
          config: { "gpg.minTrustLevel": "marginal" },
        },
        {
          branch: "side-untrusted",
          verify: true,
          unborn,
          config: { "gpg.minTrustLevel": "undefined" },
        },
        { branch: "side-signed", verify: true, unborn },
        { branch: "side-forged", unborn },
        { branch: "side-forged", verify: false, unborn },
      );
    }
    let k = 0;
    for (const c of cases) {
      const dirs = { native: join(root, `pull-${k}-native`), ours: join(root, `pull-${k}-ours`) };
      k++;
      for (const dir of [dirs.native, dirs.ours]) {
        // the remote inside the twin, where our FilesApi reaches it
        mkdirSync(dir);
        gitOk(dir, ["init", "-q", "-b", "main"]);
        cpSync(src, join(dir, "upstream"), { recursive: true });
        writeFileSync(join(dir, ".git", "info", "exclude"), "upstream/\n");
        gitOk(dir, ["remote", "add", "origin", "./upstream"]);
        if (!c.unborn) {
          gitOk(dir, ["fetch", "-q", "origin"]);
          gitOk(dir, ["checkout", "-q", "-b", "main", "origin/main"]);
        }
      }
      const args = [
        "pull",
        "--no-rebase",
        ...(c.verify === true
          ? ["--verify-signatures"]
          : c.verify === false
            ? ["--no-verify-signatures"]
            : []),
        "origin",
        c.branch,
      ];
      const native = git(dirs.native, args, c.config ?? {});
      const g = await ours(dirs.ours, c.config ?? {});
      const pull = g.pull().setRemote("origin").setRemoteBranchName(c.branch).setRebase(false);
      if (c.verify !== undefined) pull.setVerifySignatures(c.verify);
      const label = `${args.join(" ")} ${c.unborn ? "unborn" : ""} ${JSON.stringify(c.config ?? {})}`;
      try {
        await pull.call();
        expect(native.status, `${label}: ${native.stderr}`).toBe(0);
      } catch (error) {
        if (!(error instanceof SignatureVerificationError)) throw error;
        expect(native.status, `${label}: ${native.stderr}`).not.toBe(0);
        const fatal = native.stderr.split("\n").filter((l) => l.startsWith("fatal: Commit"));
        expect(
          error.message.split("\n").filter((l) => l.startsWith("fatal: Commit")),
          label,
        ).toEqual(fatal);
      }
      expect(state(dirs.ours), label).toEqual(state(dirs.native));
    }
  });
});
