/**
 * Signed commits (statewalker/statewalker-root#288): `commit -S[<keyid>]`, `commit.gpgSign`,
 * `--no-gpg-sign`, `user.signingKey` and `gpg.format`/`gpg.program` through the host's
 * signer, against native git.
 *
 * Scenarios from git's t7510-signed-commit (openpgp: `-S`, `-S<keyid>`, `commit.gpgSign`,
 * `user.signingKey`, a failing gpg's status output, `gpg.format` refusals) and
 * t7528-signed-commit-ssh (ssh: `user.signingKey` as a key file, `gpg.ssh.defaultKeyCommand`,
 * no key at all, `gpg.ssh.allowedSignersFile` for verification); SHA-256's `gpgsig-sha256`
 * from t7510's "verify and show signatures" run under `GIT_TEST_DEFAULT_HASH=sha256`.
 *
 * - With a deterministic `gpg.program` (a script printing a fixed signature) both twins'
 *   commits are byte for byte equal, and the program sees the same arguments, stdin and
 *   directory.
 * - With real keys (a throwaway GnuPG key in a temporary `GNUPGHOME`, an Ed25519 ssh key):
 *   openpgp signatures differ by their time, so the commits are compared without them and
 *   ours are verified by native `git verify-commit` and `git log --show-signature`; Ed25519
 *   signatures are deterministic, so ssh commits (ssh-keygen through the Node signer, or the
 *   in-process `createSshSigner`) equal native git's.
 * - Native-signed commits read by ours carry the same signature and store back to the same
 *   id.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment, createNodeSigner } from "@statewalker/vcs-utils-node/files";
import type { Signer } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSshSigner, type Git, InvalidConfigError, SigningFailedError } from "../src/index.js";
import { openOurs, put } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const has = (program: string, ...args: string[]) =>
  spawnSync(program, args, { stdio: "ignore" }).error === undefined;

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;
// a GnuPG key needs gpg; ssh signing needs ssh-keygen (OpenSSH 8.2+)
const itGpg = has("gpg", "--version") ? it : it.skip;
const itSsh = has("ssh-keygen", "-?") ? it : it.skip;

let root: string;
let counter = 0;

function env(): Record<string, string> {
  return { ...nativeGitEnv(root), GIT_EDITOR: "true", GNUPGHOME: join(root, "gnupg") };
}

/** Native git in `cwd`: status, stdout, stderr. */
function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, env: env(), encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function gitOk(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: env(), encoding: "utf8", stdio: "pipe" });
}

/** Two repositories (native, ours), one commit, a.txt changed and staged, `config` set. */
function twins(config: Record<string, string> = {}, initArgs: string[] = []) {
  const n = counter++;
  const dirs = { native: join(root, `native-${n}`), ours: join(root, `ours-${n}`) };
  for (const dir of [dirs.native, dirs.ours]) {
    mkdirSync(dir, { recursive: true });
    gitOk(dir, "init", "-q", "-b", "main", ...initArgs);
    put(dir, "a.txt", "a\n");
    gitOk(dir, "add", "-A");
    gitOk(dir, "commit", "-qm", "one");
    for (const [key, value] of Object.entries(config)) gitOk(dir, "config", key, value);
    put(dir, "a.txt", "a2\n");
    gitOk(dir, "add", "a.txt");
  }
  return dirs;
}

/** Our working copy over `dir` with `signer` (default: the Node signer running programs). */
function ours(dir: string, signer: Signer | null = createNodeSigner({ env: env() })): Promise<Git> {
  return openOurs(dir, createNodeGitHostEnvironment({ env: env(), ...(signer ? { signer } : {}) }));
}

async function thrown(run: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

/** The raw commit object at `rev`. */
const rawCommit = (dir: string, rev = "HEAD") => gitOk(dir, "cat-file", "commit", rev);

/** The commit without its signature header, and the header's lines. */
function splitSignature(raw: string, header = "gpgsig") {
  const lines = raw.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${header} `));
  if (start < 0) return { unsigned: raw, signature: [] as string[] };
  let end = start + 1;
  while (end < lines.length && lines[end]?.startsWith(" ")) end++;
  return {
    unsigned: [...lines.slice(0, start), ...lines.slice(end)].join("\n"),
    signature: lines.slice(start, end),
  };
}

/**
 * A `gpg.program` that signs deterministically: logs its arguments, directory and stdin
 * beside the repository (`<worktree>.gpg-log`), prints `status` on stderr and `signature`
 * on stdout, and exits with `code`.
 */
function fakeGpg(name: string, signature: string, status: string, code = 0): string {
  const path = join(root, name);
  writeFileSync(join(root, `${name}.sig`), signature);
  writeFileSync(join(root, `${name}.status`), status);
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'log="$(pwd).gpg-log"',
      'echo "args: $*" >> "$log"',
      'cat >> "$log"',
      `cat '${join(root, `${name}.status`)}' >&2`,
      `cat '${join(root, `${name}.sig`)}'`,
      `exit ${code}`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

const FIXED_SIGNATURE =
  "-----BEGIN PGP SIGNATURE-----\r\n\r\niHUEABYKAB0WIQRzSmc1\r\n=AbCd\r\n-----END PGP SIGNATURE-----\r\n";
const SIG_CREATED = "[GNUPG:] KEY_CONSIDERED 1234 2\n[GNUPG:] SIG_CREATED D 22 10 00 1 2\n";

describeGit("signed commits against native git", () => {
  let sshKey: string;
  let sshPublic: string;
  let gpgReady = false;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "signing-"));
    mkdirSync(join(root, "gnupg"), { mode: 0o700 });
    if (has("gpg", "--version")) {
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
        { env: env(), encoding: "utf8" },
      );
      gpgReady = r.status === 0;
      // a second key, chosen by id (t7510's "-S<keyid>")
      spawnSync(
        "gpg",
        [
          "--batch",
          "--passphrase",
          "",
          "--quick-gen-key",
          "Other <other@example.com>",
          "ed25519",
          "sign",
          "never",
        ],
        { env: env(), encoding: "utf8" },
      );
    }
    if (has("ssh-keygen", "-?")) {
      mkdirSync(join(root, "ssh"));
      sshKey = join(root, "ssh", "id_ed25519");
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "tester", "-f", sshKey]);
      sshPublic = readFileSync(`${sshKey}.pub`, "utf8").trim();
      writeFileSync(
        join(root, "ssh", "allowed_signers"),
        `interop@example.com namespaces="git" ${sshPublic}\n`,
      );
    }
  }, 60_000);
  afterAll(() => {
    spawnSync("gpgconf", ["--kill", "all"], { env: env() });
    rmSync(root, { recursive: true, force: true });
  });

  describe("a deterministic gpg.program: the same signer output, the same commit", () => {
    it("-S, -S<keyid>, commit.gpgSign, user.signingKey: same bytes, same program call", async () => {
      const program = fakeGpg("fixed-gpg", FIXED_SIGNATURE, SIG_CREATED);
      const cases: { args: string[]; config?: Record<string, string>; sign?: boolean | string }[] =
        [
          { args: ["-S"], sign: true },
          { args: ["-SB7227189"], sign: "B7227189" },
          { args: [], config: { "commit.gpgSign": "true" } },
          { args: [], config: { "commit.gpgSign": "true", "user.signingKey": "C0FFEE" } },
          { args: ["-SABC"], sign: "ABC", config: { "user.signingKey": "C0FFEE" } },
          // gpg.openpgp.program set after gpg.program wins (one setting)
          {
            args: ["-S"],
            sign: true,
            config: { "gpg.program": "/nonexistent/gpg", "gpg.openpgp.program": program },
          },
        ];
      for (const c of cases) {
        const dirs = twins({ "gpg.program": program, ...c.config });
        const native = git(dirs.native, "commit", "-q", "-m", "signed", ...c.args);
        expect(native.status, native.stderr).toBe(0);
        const g = await ours(dirs.ours);
        const command = g.commit().setMessage("signed");
        if (typeof c.sign === "string") command.setSigningKey(c.sign);
        else if (c.sign !== undefined) command.setSign(c.sign);
        const result = await command.call();
        expect(gitOk(dirs.ours, "rev-parse", "HEAD")).toBe(gitOk(dirs.native, "rev-parse", "HEAD"));
        expect(result.id).toBe(gitOk(dirs.native, "rev-parse", "HEAD").trim());
        expect(readFileSync(`${dirs.ours}.gpg-log`, "utf8")).toBe(
          readFileSync(`${dirs.native}.gpg-log`, "utf8"),
        );
        // add_header_signature: CRs before LFs stripped, continuation lines after a space
        expect(splitSignature(rawCommit(dirs.ours)).signature).toEqual([
          "gpgsig -----BEGIN PGP SIGNATURE-----",
          " ",
          " iHUEABYKAB0WIQRzSmc1",
          " =AbCd",
          " -----END PGP SIGNATURE-----",
        ]);
        // the default key is the committer (git_committer_info), else user.signingKey
        const args = readFileSync(`${dirs.ours}.gpg-log`, "utf8").split("\n")[0];
        const key =
          typeof c.sign === "string"
            ? c.sign
            : (c.config?.["user.signingKey"] ?? "Interop Tester <interop@example.com>");
        expect(args).toBe(`args: --status-fd=2 -bsau ${key}`);
      }
    });

    it("--no-gpg-sign under commit.gpgSign: unsigned, gpg never run", async () => {
      const program = fakeGpg("fixed-gpg-2", FIXED_SIGNATURE, SIG_CREATED);
      const dirs = twins({ "gpg.program": program, "commit.gpgSign": "true" });
      expect(git(dirs.native, "commit", "-q", "-m", "x", "--no-gpg-sign").status).toBe(0);
      await (await ours(dirs.ours)).commit().setMessage("x").setSign(false).call();
      expect(rawCommit(dirs.ours)).toBe(rawCommit(dirs.native));
      expect(rawCommit(dirs.ours)).not.toContain("gpgsig");
    });

    it("an amend and a commit with an encoding header: the signature after every header", async () => {
      const program = fakeGpg("fixed-gpg-3", FIXED_SIGNATURE, SIG_CREATED);
      const dirs = twins({ "gpg.program": program });
      expect(git(dirs.native, "commit", "-q", "-S", "--amend", "-m", "amended").status).toBe(0);
      await (await ours(dirs.ours))
        .commit()
        .setMessage("amended")
        .setAmend(true)
        .setSign(true)
        .call();
      expect(rawCommit(dirs.ours)).toBe(rawCommit(dirs.native));
    });

    it("SHA-256: the signature goes in gpgsig-sha256", async () => {
      const program = fakeGpg("fixed-gpg-256", FIXED_SIGNATURE, SIG_CREATED);
      const dirs = twins({ "gpg.program": program }, ["--object-format=sha256"]);
      expect(git(dirs.native, "commit", "-q", "-S", "-m", "signed").status).toBe(0);
      await (await ours(dirs.ours)).commit().setMessage("signed").setSign(true).call();
      expect(rawCommit(dirs.ours)).toBe(rawCommit(dirs.native));
      expect(rawCommit(dirs.ours)).toContain("\ngpgsig-sha256 -----BEGIN PGP SIGNATURE-----\n");
    });
  });

  describe("signing that fails dies as git (t7510)", () => {
    it("a gpg exiting 1 with status output: git's lines, nothing committed", async () => {
      const status = "[GNUPG:] KEY_CONSIDERED 1234 2\ngpg: signing failed: No secret key\n";
      const program = fakeGpg("failing-gpg", "", status, 2);
      const dirs = twins({ "gpg.program": program });
      const native = git(dirs.native, "commit", "-m", "signed", "-S");
      const error = await thrown(() =>
        ours(dirs.ours).then((g) => g.commit().setMessage("signed").setSign(true).call()),
      );
      expect(native.status).toBe(128);
      expect(error).toBeInstanceOf(SigningFailedError);
      expect((error as SigningFailedError).exitCode).toBe(128);
      expect(`${error?.message}\n`).toBe(native.stderr);
      expect(gitOk(dirs.ours, "rev-parse", "HEAD")).toBe(gitOk(dirs.native, "rev-parse", "HEAD"));
    });

    it("a gpg exiting 0 without SIG_CREATED, and one that cannot be run", async () => {
      const quiet = fakeGpg("quiet-gpg", FIXED_SIGNATURE, "");
      for (const program of [quiet, "no-such-gpg-program"]) {
        const dirs = twins({ "gpg.program": program });
        const native = git(dirs.native, "commit", "-m", "signed", "-S");
        const error = await thrown(() =>
          ours(dirs.ours).then((g) => g.commit().setMessage("signed").setSign(true).call()),
        );
        expect(native.status).toBe(128);
        expect(`${error?.message}\n`, program).toBe(native.stderr);
      }
    });

    it("gpg.format and other signing variables git refuses", async () => {
      const cases: Record<string, string>[] = [
        { "gpg.format": "malformed" },
        { "gpg.mintrustlevel": "bogus" },
      ];
      for (const config of cases) {
        const dirs = twins(config);
        const native = git(dirs.native, "commit", "-m", "signed", "-S");
        const error = await thrown(() =>
          ours(dirs.ours).then((g) => g.commit().setMessage("signed").setSign(true).call()),
        );
        expect(native.status).toBe(128);
        expect(error).toBeInstanceOf(InvalidConfigError);
        expect(`${error?.message}\n`.replace(/'[^']*\/\.git\/config'/, "'.git/config'")).toBe(
          native.stderr,
        );
      }
    });

    it("no signer: refused as a gpg that fails without output", async () => {
      const dirs = twins();
      const error = await thrown(() =>
        ours(dirs.ours, null).then((g) => g.commit().setMessage("signed").setSign(true).call()),
      );
      expect(error?.message).toBe(
        "error: gpg failed to sign the data:\n(no gpg output)\nfatal: failed to write commit object",
      );
    });
  });

  describe("openpgp with a real key (t7510-signed-commit)", () => {
    itGpg("ours verifies with native git; theirs reads back in ours", async () => {
      expect(gpgReady).toBe(true);
      const cases: { args: string[]; config?: Record<string, string>; sign?: string | boolean }[] =
        [
          { args: ["-S"], sign: true },
          { args: [], config: { "commit.gpgSign": "true" } },
          { args: ["-Sother@example.com"], sign: "other@example.com" },
          {
            args: [],
            config: { "commit.gpgSign": "true", "user.signingKey": "other@example.com" },
          },
        ];
      for (const c of cases) {
        const dirs = twins(c.config);
        const native = git(dirs.native, "commit", "-q", "-m", "signed", ...c.args);
        expect(native.status, native.stderr).toBe(0);
        const g = await ours(dirs.ours);
        const command = g.commit().setMessage("signed");
        if (typeof c.sign === "string") command.setSigningKey(c.sign);
        else if (c.sign !== undefined) command.setSign(c.sign);
        await command.call();
        const n = splitSignature(rawCommit(dirs.native));
        const o = splitSignature(rawCommit(dirs.ours));
        expect(o.unsigned).toBe(n.unsigned);
        expect(o.signature[0]).toBe("gpgsig -----BEGIN PGP SIGNATURE-----");
        expect(o.signature.at(-1)).toBe(" -----END PGP SIGNATURE-----");
        for (const dir of [dirs.native, dirs.ours]) {
          const verify = git(dir, "verify-commit", "--raw", "HEAD");
          expect(verify.status, verify.stderr).toBe(0);
          expect(verify.stderr).toContain("[GNUPG:] GOODSIG");
          const uid =
            c.sign === "other@example.com" || c.config?.["user.signingKey"]
              ? "Other <other@example.com>"
              : "Interop Tester <interop@example.com>";
          expect(verify.stderr).toContain(uid);
          expect(gitOk(dir, "log", "-1", "--show-signature")).toContain(
            `Good signature from "${uid}"`,
          );
        }
        // native's signed commit, read by ours and stored again: the same signature, the same id
        const theirs = await (await ours(dirs.native)).workingCopy.history.commits.load(
          gitOk(dirs.native, "rev-parse", "HEAD").trim(),
        );
        expect(theirs?.gpgSignature).toBe(
          n.signature
            .map((line, i) => (i === 0 ? line.slice("gpgsig ".length) : line.slice(1)))
            .join("\n"),
        );
        if (theirs) {
          const stored = await g.workingCopy.history.commits.store(theirs);
          expect(stored).toBe(gitOk(dirs.native, "rev-parse", "HEAD").trim());
        }
      }
    });
  });

  describe("ssh (t7528-signed-commit-ssh)", () => {
    itSsh("user.signingKey as a key file: the same commit as native git, verified", async () => {
      const config = {
        "gpg.format": "ssh",
        "user.signingKey": sshKey,
        "gpg.ssh.allowedSignersFile": join(root, "ssh", "allowed_signers"),
      };
      const dirs = twins(config);
      const native = git(dirs.native, "commit", "-q", "-S", "-m", "signed");
      expect(native.status, native.stderr).toBe(0);
      await (await ours(dirs.ours)).commit().setMessage("signed").setSign(true).call();
      expect(rawCommit(dirs.ours)).toBe(rawCommit(dirs.native));
      expect(rawCommit(dirs.ours)).toContain("\ngpgsig -----BEGIN SSH SIGNATURE-----\n");
      const verify = git(dirs.ours, "verify-commit", "HEAD");
      expect(verify.status, verify.stderr).toBe(0);
      expect(verify.stderr).toContain('Good "git" signature for interop@example.com');
      expect(gitOk(dirs.ours, "log", "-1", "--show-signature")).toContain(
        'Good "git" signature for interop@example.com',
      );
    });

    itSsh("the in-process createSshSigner: ssh-keygen's signature byte for byte", async () => {
      const config = {
        "gpg.format": "ssh",
        "user.signingKey": `key::${sshPublic}`,
        "commit.gpgSign": "true",
      };
      const dirs = twins({ ...config, "user.signingKey": sshKey });
      expect(git(dirs.native, "commit", "-q", "-m", "signed").status).toBe(0);
      for (const [key, value] of Object.entries(config)) gitOk(dirs.ours, "config", key, value);
      const signer = createSshSigner({ privateKey: readFileSync(sshKey, "utf8") });
      await (await ours(dirs.ours, signer)).commit().setMessage("signed").call();
      expect(rawCommit(dirs.ours)).toBe(rawCommit(dirs.native));
    });

    itSsh("no key: git's death, a failing defaultKeyCommand's warning", async () => {
      const cases: { config: Record<string, string>; exit: number }[] = [
        { config: { "gpg.format": "ssh" }, exit: 128 },
        { config: { "gpg.format": "ssh", "gpg.ssh.defaultKeyCommand": "false" }, exit: 128 },
        {
          config: { "gpg.format": "ssh", "gpg.ssh.defaultKeyCommand": "echo not-a-key" },
          exit: 128,
        },
        // ssh-keygen refusing a key file that is not there
        { config: { "gpg.format": "ssh", "user.signingKey": join(root, "missing") }, exit: 128 },
      ];
      for (const c of cases) {
        const dirs = twins(c.config);
        const native = git(dirs.native, "commit", "-m", "signed", "-S");
        const error = await thrown(() =>
          ours(dirs.ours).then((g) => g.commit().setMessage("signed").setSign(true).call()),
        );
        expect(native.status).toBe(c.exit);
        expect(error).toBeInstanceOf(SigningFailedError);
        expect(
          `${error?.message}\n`.replaceAll(/\/[^ ]*\.git_signing_buffer_tmp\w*/g, "<buffer>"),
        ).toBe(native.stderr.replaceAll(/\/[^ ]*\.git_signing_buffer_tmp\w*/g, "<buffer>"));
      }
    });
  });
});
