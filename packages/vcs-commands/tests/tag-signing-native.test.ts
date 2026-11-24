/**
 * Signed tags (statewalker/statewalker-root#317): `tag -s`, `tag -u <keyid>`, `tag.gpgSign`,
 * `tag.forceSignAnnotated` and `--no-sign` through the host's signer, against native git.
 *
 * The signature is appended to the tag's message, as builtin/tag.c's `do_sign` appends it to
 * the tag object; `git verify-tag` checks it. Every test names the t/ script and test title it
 * takes its inputs from: t7004-tag (signed parts), t7030-verify-tag (openpgp) and
 * t7031-verify-tag-signed-ssh (ssh).
 *
 * - With a deterministic `gpg.program` (a script printing a fixed signature) both twins' tags
 *   are byte for byte equal, and the program sees the same arguments, stdin and directory.
 * - With real keys (a throwaway GnuPG key in a temporary `GNUPGHOME`, an Ed25519 ssh key):
 *   openpgp signatures differ by their time, so ours is checked by native `git verify-tag`;
 *   Ed25519 signatures are deterministic, so ssh tags equal native git's.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment, createNodeSigner } from "@statewalker/vcs-utils-node/files";
import type { Signer } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CleanupMode,
  createSshSigner,
  type Git,
  InvalidConfigError,
  SigningFailedError,
} from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
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

/** Two repositories (native, ours), one commit, `config` set. */
function twins(config: Record<string, string> = {}) {
  const n = counter++;
  const dirs = { native: join(root, `native-${n}`), ours: join(root, `ours-${n}`) };
  for (const dir of [dirs.native, dirs.ours]) {
    mkdirSync(dir, { recursive: true });
    gitOk(dir, "init", "-q", "-b", "main");
    put(dir, "a.txt", "a\n");
    gitOk(dir, "add", "-A");
    gitOk(dir, "commit", "-qm", "one");
    for (const [key, value] of Object.entries(config)) gitOk(dir, "config", key, value);
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

/** The raw tag object `name` (empty when there is none). */
const rawTag = (dir: string, name = "v1") => git(dir, "cat-file", "tag", name).stdout;
/** Every ref with its value. */
const refs = (dir: string) => gitOk(dir, "for-each-ref", "--format=%(refname) %(objectname)");

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
/** The fixed signature as git appends it (CRs before LFs stripped). */
const APPENDED =
  "-----BEGIN PGP SIGNATURE-----\n\niHUEABYKAB0WIQRzSmc1\n=AbCd\n-----END PGP SIGNATURE-----\n";

type TagSetup = (g: Git) => ReturnType<Git["tag"]>;

describeGit("signed tags against native git", () => {
  let sshKey: string;
  let sshPublic: string;
  let gpgReady = false;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tag-signing-"));
    mkdirSync(join(root, "gnupg"), { mode: 0o700 });
    if (has("gpg", "--version")) {
      for (const uid of ["Interop Tester <interop@example.com>", "Other <other@example.com>"]) {
        const r = spawnSync(
          "gpg",
          ["--batch", "--passphrase", "", "--quick-gen-key", uid, "ed25519", "sign", "never"],
          { env: env(), encoding: "utf8" },
        );
        if (uid.startsWith("Interop")) gpgReady = r.status === 0;
      }
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

  describe("a deterministic gpg.program: the same signer output, the same tag", () => {
    it("t7004 'creating a signed tag with -m message should succeed', 'sign with a given key id', '-u implies signed tag', 'git tag --sign enable GPG sign', 'git tag configured tag.gpgsign enables GPG sign', 'git tag -s implied if configured with tag.forcesignannotated'", async () => {
      const program = fakeGpg("fixed-gpg", FIXED_SIGNATURE, SIG_CREATED);
      const cases: { args: string[]; config?: Record<string, string>; setup: TagSetup }[] = [
        {
          args: ["-s", "-m", "A signed tag"],
          setup: (g) => g.tag().setMessage("A signed tag").setSigned(true),
        },
        {
          args: ["-u", "B7227189", "-m", "keyed"],
          setup: (g) => g.tag().setMessage("keyed").setSigningKey("B7227189"),
        },
        // -u with --no-sign still signs (cmd_tag sets opt.sign after the options)
        {
          args: ["--no-sign", "-u", "B7227189", "-m", "keyed"],
          setup: (g) => g.tag().setMessage("keyed").setSigned(false).setSigningKey("B7227189"),
        },
        // -u wins over user.signingKey
        {
          args: ["-u", "ABC", "-m", "m"],
          config: { "user.signingKey": "C0FFEE" },
          setup: (g) => g.tag().setMessage("m").setSigningKey("ABC"),
        },
        {
          args: ["-s", "-m", "m"],
          config: { "user.signingKey": "C0FFEE" },
          setup: (g) => g.tag().setMessage("m").setSigned(true),
        },
        {
          args: ["-a", "-m", "m"],
          config: { "tag.gpgSign": "true" },
          setup: (g) => g.tag().setMessage("m").setAnnotated(true),
        },
        {
          args: ["-m", "m"],
          config: { "tag.forceSignAnnotated": "true" },
          setup: (g) => g.tag().setMessage("m"),
        },
        // t7004 'creating a signed tag pointing to a tree should succeed'
        // t7004 'creating a signed tag pointing to a blob should succeed'
        {
          args: ["-s", "-m", "tree", "HEAD^{tree}"],
          setup: (g) => g.tag().setMessage("tree").setSigned(true).setObjectId("HEAD^{tree}"),
        },
        {
          args: ["-s", "-m", "blob", "HEAD:a.txt"],
          setup: (g) => g.tag().setMessage("blob").setSigned(true).setObjectId("HEAD:a.txt"),
        },
      ];
      for (const c of cases) {
        const label = c.args.join(" ");
        const dirs = twins({ "gpg.program": program, ...c.config });
        // the object after the name: git tag [options] <name> [<object>]
        const positional = c.args.at(-1)?.startsWith("HEAD") ? [c.args.at(-1) as string] : [];
        const options = positional.length ? c.args.slice(0, -1) : c.args;
        const made = git(dirs.native, "tag", ...options, "v1", ...positional);
        expect(made.status, `${label}: ${made.stderr}`).toBe(0);
        await c
          .setup(await ours(dirs.ours))
          .setName("v1")
          .call();
        expect(rawTag(dirs.ours), label).toBe(rawTag(dirs.native));
        expect(refs(dirs.ours), label).toBe(refs(dirs.native));
        expect(rawTag(dirs.ours).endsWith(`\n${APPENDED}`), label).toBe(true);
        expect(readFileSync(`${dirs.ours}.gpg-log`, "utf8"), label).toBe(
          readFileSync(`${dirs.native}.gpg-log`, "utf8"),
        );
      }
    });

    it("t7004 'creating a signed tag with -m message should succeed': the default key is the committer (get_signing_key)", async () => {
      const program = fakeGpg("fixed-gpg-key", FIXED_SIGNATURE, SIG_CREATED);
      const dirs = twins({ "gpg.program": program });
      expect(git(dirs.native, "tag", "-s", "-m", "m", "v1").status).toBe(0);
      await (await ours(dirs.ours)).tag().setName("v1").setMessage("m").setSigned(true).call();
      expect(rawTag(dirs.ours)).toBe(rawTag(dirs.native));
      const args = readFileSync(`${dirs.ours}.gpg-log`, "utf8").split("\n")[0];
      expect(args).toBe("args: --status-fd=2 -bsau Interop Tester <interop@example.com>");
    });

    it("t7004 'creating a signed tag with an empty -m message should succeed', 'extra blanks in the message for a signed tag should be removed', 'creating a signed tag with spaces and no newline should succeed', 'creating a signed tag with #commented -m message should succeed'", async () => {
      const program = fakeGpg("fixed-gpg-msg", FIXED_SIGNATURE, SIG_CREATED);
      const cases: { args: string[]; setup: TagSetup }[] = [
        { args: ["-m", ""], setup: (g) => g.tag().setMessage("") },
        { args: ["-m", "   "], setup: (g) => g.tag().setMessage("   ") },
        {
          args: ["-m", "\n\n  Summary  \n\n\n\nBody   \n\n"],
          setup: (g) => g.tag().setMessage("\n\n  Summary  \n\n\n\nBody   \n\n"),
        },
        {
          args: ["-m", "#comment\nkept"],
          setup: (g) => g.tag().setMessage("#comment\nkept"),
        },
        // no newline before the signature: verbatim keeps the message as given
        {
          args: ["--cleanup=verbatim", "-m", "no newline  "],
          setup: (g) => g.tag().setMessage("no newline  ").setCleanupMode(CleanupMode.VERBATIM),
        },
        {
          args: ["--cleanup=whitespace", "-m", "#kept\n\n\nx"],
          setup: (g) => g.tag().setMessage("#kept\n\n\nx").setCleanupMode(CleanupMode.WHITESPACE),
        },
      ];
      for (const c of cases) {
        const label = JSON.stringify(c.args);
        const dirs = twins({ "gpg.program": program });
        const made = git(dirs.native, "tag", "-s", ...c.args, "v1");
        expect(made.status, `${label}: ${made.stderr}`).toBe(0);
        await c
          .setup(await ours(dirs.ours))
          .setSigned(true)
          .setName("v1")
          .call();
        expect(rawTag(dirs.ours), label).toBe(rawTag(dirs.native));
        expect(readFileSync(`${dirs.ours}.gpg-log`, "utf8"), label).toBe(
          readFileSync(`${dirs.native}.gpg-log`, "utf8"),
        );
      }
    });

    it("t7004 'git tag --no-sign configured tag.gpgsign skip GPG sign', 'git tag -a disable configured tag.forcesignannotated', 'lightweight with no message when configured with tag.forcesignannotated': gpg never run", async () => {
      const program = fakeGpg("fixed-gpg-none", FIXED_SIGNATURE, SIG_CREATED);
      const cases: { args: string[]; config: Record<string, string>; setup: TagSetup }[] = [
        {
          args: ["--no-sign", "-m", "m"],
          config: { "tag.gpgSign": "true" },
          setup: (g) => g.tag().setMessage("m").setSigned(false),
        },
        {
          args: ["-a", "-m", "m"],
          config: { "tag.forceSignAnnotated": "true" },
          setup: (g) => g.tag().setMessage("m").setAnnotated(true),
        },
        { args: [], config: { "tag.forceSignAnnotated": "true" }, setup: (g) => g.tag() },
      ];
      for (const c of cases) {
        const dirs = twins({ "gpg.program": program, ...c.config });
        expect(git(dirs.native, "tag", ...c.args, "v1").status).toBe(0);
        await c
          .setup(await ours(dirs.ours))
          .setName("v1")
          .call();
        expect(refs(dirs.ours)).toBe(refs(dirs.native));
        expect(rawTag(dirs.ours)).toBe(rawTag(dirs.native));
        expect(rawTag(dirs.ours)).not.toContain("SIGNATURE");
        expect(() => readFileSync(`${dirs.ours}.gpg-log`)).toThrow();
      }
    });

    it("t7004 'reediting a signed tag body omits signature': -f retag starts from the message without the signature", async () => {
      const program = fakeGpg("fixed-gpg-re", FIXED_SIGNATURE, SIG_CREATED);
      const dirs = twins({ "gpg.program": program });
      for (const dir of [dirs.native, dirs.ours]) {
        gitOk(dir, "tag", "-s", "-m", "signed body\n\nmore", "v1");
      }
      // GIT_EDITOR=true keeps the template: the previous message, without its signature
      expect(git(dirs.native, "tag", "-f", "-a", "v1").status).toBe(0);
      await (await ours(dirs.ours)).tag().setName("v1").setAnnotated(true).setForce(true).call();
      expect(rawTag(dirs.ours)).toBe(rawTag(dirs.native));
      expect(rawTag(dirs.ours)).not.toContain("SIGNATURE");
    });

    it("t7004 'listing the one-line message of a signed tag should succeed': tag -n hides the signature", async () => {
      const program = fakeGpg("fixed-gpg-list", FIXED_SIGNATURE, SIG_CREATED);
      const dirs = twins({ "gpg.program": program });
      expect(git(dirs.native, "tag", "-s", "-m", "one line", "v1").status).toBe(0);
      const g = await ours(dirs.ours);
      await g.tag().setName("v1").setMessage("one line").setSigned(true).call();
      expect(rawTag(dirs.ours)).toBe(rawTag(dirs.native));
      expect(gitOk(dirs.ours, "tag", "-n1")).toBe(gitOk(dirs.native, "tag", "-n1"));
      expect((await g.tagList().setLines(1).callText()).output).toBe(
        gitOk(dirs.native, "tag", "-n1"),
      );
      // native's signed tag read by ours: the signature stays in the message, stored back alike
      const id = gitOk(dirs.native, "rev-parse", "v1").trim();
      const theirs = await (await ours(dirs.native)).workingCopy.history.tags.load(id);
      expect(theirs?.message).toBe(`one line\n${APPENDED}`);
      if (theirs) expect(await g.workingCopy.history.tags.store(theirs)).toBe(id);
    });
  });

  describe("signing that fails dies as git", () => {
    it("t7004 'sign with an unknown id (1)', 'git tag -s fails if gpg is misconfigured (bad key)': gpg's status output, no tag", async () => {
      const status = "[GNUPG:] KEY_CONSIDERED 1234 2\ngpg: signing failed: No secret key\n";
      const program = fakeGpg("failing-gpg", "", status, 2);
      for (const setup of [
        {
          args: ["-s", "-m", "m"],
          tag: ((g) => g.tag().setMessage("m").setSigned(true)) as TagSetup,
        },
        {
          args: ["-u", "unknown@example.com", "-m", "m"],
          tag: ((g) => g.tag().setMessage("m").setSigningKey("unknown@example.com")) as TagSetup,
        },
      ]) {
        const dirs = twins({ "gpg.program": program });
        const native = git(dirs.native, "tag", ...setup.args, "v1");
        const error = await thrown(async () =>
          setup
            .tag(await ours(dirs.ours))
            .setName("v1")
            .call(),
        );
        expect(native.status).toBe(128);
        expect(error).toBeInstanceOf(SigningFailedError);
        expect((error as SigningFailedError).exitCode).toBe(128);
        expect(`${error?.message}\n`).toBe(native.stderr);
        expect(refs(dirs.ours)).toBe(refs(dirs.native));
        expect(gitOk(dirs.ours, "count-objects")).toBe(gitOk(dirs.native, "count-objects"));
        // TAG_EDITMSG is left only when the message went through the editor file
        expect(git(dirs.ours, "rev-parse", "v1").status).not.toBe(0);
      }
    });

    it("t7004 'git tag -s fails if gpg is misconfigured (bad signature format)': no SIG_CREATED, a program that cannot run", async () => {
      const quiet = fakeGpg("quiet-gpg", FIXED_SIGNATURE, "");
      for (const program of [quiet, "no-such-gpg-program"]) {
        const dirs = twins({ "gpg.program": program });
        const native = git(dirs.native, "tag", "-s", "-m", "m", "v1");
        const error = await thrown(async () =>
          (await ours(dirs.ours)).tag().setName("v1").setMessage("m").setSigned(true).call(),
        );
        expect(native.status).toBe(128);
        expect((error as SigningFailedError).exitCode, program).toBe(128);
        expect(`${error?.message}\n`, program).toBe(native.stderr);
        expect(refs(dirs.ours)).toBe(refs(dirs.native));
      }
    });

    it("t7004 '-s implies annotated tag': the editor's message signed; an empty one dies before signing", async () => {
      const program = fakeGpg("fixed-gpg-editor", FIXED_SIGNATURE, SIG_CREATED);
      const editor = join(root, "fakeeditor");
      writeFileSync(editor, '#!/bin/sh\necho "A message" >>"$1"\n');
      chmodSync(editor, 0o755);
      const dirs = twins({ "gpg.program": program });
      const native = spawnSync("git", ["tag", "-s", "v1"], {
        cwd: dirs.native,
        env: { ...env(), GIT_EDITOR: editor },
        encoding: "utf8",
      });
      expect(native.status, native.stderr).toBe(0);
      await (await ours(dirs.ours))
        .tag()
        .setName("v1")
        .setSigned(true)
        .setEditor(async (_path, text) => `${text}A message\n`)
        .call();
      expect(rawTag(dirs.ours)).toBe(rawTag(dirs.native));
      expect(readFileSync(`${dirs.ours}.gpg-log`, "utf8")).toBe(
        readFileSync(`${dirs.native}.gpg-log`, "utf8"),
      );

      // GIT_EDITOR=true keeps the commented template: no message, gpg never run
      const empty = twins({ "gpg.program": program });
      const died = git(empty.native, "tag", "-s", "v1");
      const error = await thrown(async () =>
        (await ours(empty.ours)).tag().setName("v1").setSigned(true).call(),
      );
      expect(died.status).toBe(128);
      expect(`${error?.message}\n`).toBe(died.stderr);
      expect(() => readFileSync(`${empty.ours}.gpg-log`)).toThrow();
      expect(() => readFileSync(`${empty.native}.gpg-log`)).toThrow();
    });

    it("gpg-interface.c git_gpg_config: a gpg.format git refuses", async () => {
      const dirs = twins({ "gpg.format": "malformed" });
      const native = git(dirs.native, "tag", "-s", "-m", "m", "v1");
      const error = await thrown(async () =>
        (await ours(dirs.ours)).tag().setName("v1").setMessage("m").setSigned(true).call(),
      );
      expect(native.status).toBe(128);
      expect(error).toBeInstanceOf(InvalidConfigError);
      expect(`${error?.message}\n`.replace(/'[^']*\/\.git\/config'/, "'.git/config'")).toBe(
        native.stderr,
      );
    });

    it("no signer: refused as a gpg that fails without output", async () => {
      const dirs = twins();
      const error = await thrown(async () =>
        (await ours(dirs.ours, null)).tag().setName("v1").setMessage("m").setSigned(true).call(),
      );
      expect(error?.message).toBe(
        [
          "error: gpg failed to sign the data:",
          "(no gpg output)",
          "error: unable to sign the tag",
          "The tag message has been left in .git/TAG_EDITMSG",
        ].join("\n"),
      );
      expect(git(dirs.ours, "rev-parse", "v1").status).not.toBe(0);
    });
  });

  describe("openpgp with a real key (t7030-verify-tag)", () => {
    itGpg(
      "t7030 'create signed tags', 'verify and show signatures', 'verify signatures with --raw': ours passes native verify-tag",
      async () => {
        expect(gpgReady).toBe(true);
        const cases: {
          args: string[];
          config?: Record<string, string>;
          setup: TagSetup;
          uid: string;
        }[] = [
          {
            args: ["-s", "-m", "signed"],
            setup: (g) => g.tag().setMessage("signed").setSigned(true),
            uid: "Interop Tester <interop@example.com>",
          },
          {
            args: ["-u", "other@example.com", "-m", "signed"],
            setup: (g) => g.tag().setMessage("signed").setSigningKey("other@example.com"),
            uid: "Other <other@example.com>",
          },
          {
            args: ["-m", "signed"],
            config: { "tag.gpgSign": "true", "user.signingKey": "other@example.com" },
            setup: (g) => g.tag().setMessage("signed"),
            uid: "Other <other@example.com>",
          },
        ];
        for (const c of cases) {
          const dirs = twins(c.config);
          const native = git(dirs.native, "tag", ...c.args, "v1");
          expect(native.status, native.stderr).toBe(0);
          await c
            .setup(await ours(dirs.ours))
            .setName("v1")
            .call();
          const strip = (raw: string) => raw.slice(0, raw.indexOf("-----BEGIN PGP SIGNATURE-----"));
          expect(strip(rawTag(dirs.ours))).toBe(strip(rawTag(dirs.native)));
          expect(rawTag(dirs.ours).endsWith("-----END PGP SIGNATURE-----\n")).toBe(true);
          for (const dir of [dirs.native, dirs.ours]) {
            const verify = git(dir, "verify-tag", "--raw", "v1");
            expect(verify.status, verify.stderr).toBe(0);
            expect(verify.stderr).toContain("[GNUPG:] GOODSIG");
            expect(verify.stderr).toContain(c.uid);
            const shown = git(dir, "verify-tag", "-v", "v1");
            expect(shown.stderr).toContain(`Good signature from "${c.uid}"`);
            expect(git(dir, "tag", "-v", "v1").status).toBe(0);
          }
          // t7030 'detect fudged signature': a changed message fails
          const fudged = rawTag(dirs.ours).replace("signed", "forged");
          const id = execFileSync("git", ["hash-object", "-t", "tag", "-w", "--stdin"], {
            cwd: dirs.ours,
            env: env(),
            input: fudged,
            encoding: "utf8",
          }).trim();
          expect(git(dirs.ours, "verify-tag", id).status).not.toBe(0);
        }
      },
    );
  });

  describe("ssh (t7031-verify-tag-signed-ssh)", () => {
    itSsh(
      "t7031 'create signed tags ssh', 'verify and show ssh signatures': the same tag as native git, verified",
      async () => {
        const config = {
          "gpg.format": "ssh",
          "user.signingKey": sshKey,
          "gpg.ssh.allowedSignersFile": join(root, "ssh", "allowed_signers"),
        };
        const cases: { args: string[]; extra?: Record<string, string>; setup: TagSetup }[] = [
          {
            args: ["-s", "-m", "signed"],
            setup: (g) => g.tag().setMessage("signed").setSigned(true),
          },
          {
            args: ["-u", sshKey, "-m", "signed"],
            extra: { "user.signingKey": "/nonexistent/key" },
            setup: (g) => g.tag().setMessage("signed").setSigningKey(sshKey),
          },
          {
            args: ["-m", "signed"],
            extra: { "tag.forceSignAnnotated": "true" },
            setup: (g) => g.tag().setMessage("signed"),
          },
        ];
        for (const c of cases) {
          const dirs = twins({ ...config, ...c.extra });
          const native = git(dirs.native, "tag", ...c.args, "v1");
          expect(native.status, native.stderr).toBe(0);
          await c
            .setup(await ours(dirs.ours))
            .setName("v1")
            .call();
          expect(rawTag(dirs.ours)).toBe(rawTag(dirs.native));
          expect(rawTag(dirs.ours)).toContain("\n-----BEGIN SSH SIGNATURE-----\n");
          const verify = git(dirs.ours, "verify-tag", "v1");
          expect(verify.status, verify.stderr).toBe(0);
          expect(verify.stderr).toContain('Good "git" signature for interop@example.com');
          // t7031 'verify ssh signatures with --raw'
          const raw = git(dirs.ours, "verify-tag", "--raw", "v1");
          expect(raw.status).toBe(0);
          expect(raw.stderr).toContain('Good "git" signature for interop@example.com');
        }
      },
    );

    itSsh(
      "t7031 'create signed tags ssh' through the in-process createSshSigner: ssh-keygen's bytes",
      async () => {
        const dirs = twins({
          "gpg.format": "ssh",
          "user.signingKey": sshKey,
          "tag.gpgSign": "true",
        });
        expect(git(dirs.native, "tag", "-m", "signed", "v1").status).toBe(0);
        gitOk(dirs.ours, "config", "user.signingKey", `key::${sshPublic}`);
        const signer = createSshSigner({ privateKey: readFileSync(sshKey, "utf8") });
        await (await ours(dirs.ours, signer)).tag().setName("v1").setMessage("signed").call();
        expect(rawTag(dirs.ours)).toBe(rawTag(dirs.native));
      },
    );

    itSsh(
      "gpg-interface.c sign_buffer_ssh: no key, a failing gpg.ssh.defaultKeyCommand, a missing key file: git's death",
      async () => {
        const cases: Record<string, string>[] = [
          { "gpg.format": "ssh" },
          { "gpg.format": "ssh", "gpg.ssh.defaultKeyCommand": "false" },
          { "gpg.format": "ssh", "gpg.ssh.defaultKeyCommand": "echo not-a-key" },
          { "gpg.format": "ssh", "user.signingKey": join(root, "missing") },
        ];
        const norm = (text: string) =>
          text.replaceAll(/\/[^ ]*\.git_signing_buffer_tmp\w*/g, "<buffer>");
        for (const config of cases) {
          const dirs = twins(config);
          const native = git(dirs.native, "tag", "-s", "-m", "m", "v1");
          const label = JSON.stringify(config);
          const command = (await ours(dirs.ours))
            .tag()
            .setName("v1")
            .setMessage("m")
            .setSigned(true)
            .setCompatibility(nativeIs25x ? "2.56" : "2.43");
          if (!nativeIs25x && config["user.signingKey"]) {
            // git 2.43: sign_buffer_ssh returns ssh-keygen's status, which do_sign takes for
            // success: the error printed, the tag made unsigned
            expect(native.status, label).toBe(0);
            const result = await command.callText();
            expect(norm(`${result.warnings.join("\n")}\n`)).toBe(norm(native.stderr));
            expect(rawTag(dirs.ours)).toBe(rawTag(dirs.native));
            expect(rawTag(dirs.ours)).not.toContain("SIGNATURE");
            continue;
          }
          const error = await thrown(() => command.call());
          expect(native.status, label).toBe(128);
          expect(error, label).toBeInstanceOf(SigningFailedError);
          expect((error as SigningFailedError).exitCode, label).toBe(128);
          expect(norm(`${error?.message}\n`), label).toBe(norm(native.stderr));
          expect(refs(dirs.ours)).toBe(refs(dirs.native));
        }
      },
    );

    itSsh(
      "t7031 'create signed tags ssh' with gpg.ssh.defaultKeyCommand naming a key in ssh-agent (t7528 'sign commits using literal public keys with ssh-agent'): the same tag",
      async () => {
        const agent = spawnSync("ssh-agent", ["-a", join(root, "agent.sock"), "-s"], {
          encoding: "utf8",
        });
        if (agent.status !== 0) return; // no ssh-agent in this environment
        const pid = /SSH_AGENT_PID=(\d+)/.exec(agent.stdout)?.[1];
        try {
          const agentEnv = { ...env(), SSH_AUTH_SOCK: join(root, "agent.sock") };
          execFileSync("ssh-add", ["-q", sshKey], { env: agentEnv, stdio: "ignore" });
          const config = {
            "gpg.format": "ssh",
            "gpg.ssh.defaultKeyCommand": `echo key::${sshPublic}`,
            "gpg.ssh.allowedSignersFile": join(root, "ssh", "allowed_signers"),
          };
          const dirs = twins(config);
          const native = spawnSync("git", ["tag", "-s", "-m", "m", "v1"], {
            cwd: dirs.native,
            env: agentEnv,
            encoding: "utf8",
          });
          expect(native.status, native.stderr).toBe(0);
          const g = await openOurs(
            dirs.ours,
            createNodeGitHostEnvironment({
              env: agentEnv,
              signer: createNodeSigner({ env: agentEnv }),
            }),
          );
          await g.tag().setName("v1").setMessage("m").setSigned(true).call();
          expect(rawTag(dirs.ours)).toBe(rawTag(dirs.native));
          const verify = git(dirs.ours, "verify-tag", "v1");
          expect(verify.status, verify.stderr).toBe(0);
        } finally {
          if (pid) process.kill(Number(pid));
        }
      },
    );
  });
});
