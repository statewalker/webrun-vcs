/**
 * Signed merges and am (statewalker/statewalker-root#319) against native git, each test run
 * in two formats (ssh: the commits equal native git's byte for byte; openpgp: equal but for
 * the signature, which both verifies check).
 *
 * - merge: t7510-signed-commit.sh's `git merge -S side` (its setup), the same under
 *   `commit.gpgSign`, `-S<keyid>`, `--no-gpg-sign` over the configuration, a fast-forward
 *   (nothing to sign), and `merge --continue` after a conflict, which is a plain `git commit`
 *   (signed by `commit.gpgSign` alone, whatever the stopped merge was given).
 * - am: builtin/am.c's `do_commit` signs each patch's commit (`-S[<keyid>]`, `commit.gpgSign`,
 *   `--no-gpg-sign`), also under a non-UTF-8 `i18n.commitEncoding`, whose `encoding` header
 *   the signature covers and follows.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Git, MergeOperation, MergeStatus } from "../src/index.js";
import {
  FORMATS,
  SigningFixture,
  signingTwinsReady,
  type TwinFormat,
} from "./signed-rewrites-native-support.js";

const describeGit = signingTwinsReady ? describe : describe.skip;

let fx: SigningFixture;

/** t7510's setup up to its merge: initial, second on main; "third on side" on side. */
function setup(dir: string): void {
  writeFileSync(join(dir, "file"), "1\n");
  fx.gitOk(dir, "add", "file");
  fx.gitOk(dir, "commit", "-q", "-m", "initial");
  fx.gitOk(dir, "branch", "side");
  writeFileSync(join(dir, "file"), "2\n");
  fx.gitOk(dir, "commit", "-q", "-a", "-m", "second");
  fx.gitOk(dir, "checkout", "-q", "side");
  writeFileSync(join(dir, "elif"), "3\n");
  fx.gitOk(dir, "add", "elif");
  fx.gitOk(dir, "commit", "-q", "-m", "third on side");
  fx.gitOk(dir, "checkout", "-q", "main");
}

/** The key of `-S<keyid>` in a format: the ssh key file, the gpg key's address. */
function keyOf(format: TwinFormat): string {
  return format === "ssh"
    ? (fx.formatConfig("ssh")["user.signingKey"] as string)
    : "interop@example.com";
}

/** One sign option as git's argument and as our command's setter. */
type SignArg = {
  args: string[];
  apply: (c: { setSign(s: boolean): unknown; setSigningKey(k: string): unknown }) => void;
};

function signArgs(format: TwinFormat, sign: boolean | "key" | undefined): SignArg {
  if (sign === true) return { args: ["-S"], apply: (c) => c.setSign(true) };
  if (sign === false) return { args: ["--no-gpg-sign"], apply: (c) => c.setSign(false) };
  if (sign === "key") {
    const key = keyOf(format);
    return { args: [`-S${key}`], apply: (c) => c.setSigningKey(key) };
  }
  return { args: [], apply: () => undefined };
}

describeGit("signed merges and am against native git", () => {
  beforeAll(() => {
    fx = new SigningFixture("signed-merge-am-");
  }, 60_000);
  afterAll(() => fx?.dispose());

  it('t7510-signed-commit.sh: "create signed commits": `git merge -S side` signs the merge; commit.gpgSign, -S<keyid> and --no-gpg-sign as git takes them', async () => {
    const cases: { sign: boolean | "key" | undefined; config?: string; signed: boolean }[] = [
      { sign: true, signed: true },
      { sign: undefined, config: "true", signed: true },
      { sign: "key", signed: true },
      { sign: false, config: "true", signed: false },
      { sign: true, config: "false", signed: true },
      { sign: undefined, signed: false },
    ];
    for (const format of FORMATS) {
      for (const c of cases) {
        const dirs = fx.twins(format, setup);
        if (c.config !== undefined) {
          for (const dir of [dirs.native, dirs.ours])
            fx.gitOk(dir, "config", "commit.gpgsign", c.config);
        }
        const sign = signArgs(format, c.sign);
        const native = fx.git(dirs.native, ["merge", ...sign.args, "side"]);
        expect(native.status, native.stderr).toBe(0);
        const command = (await fx.ours(dirs.ours)).merge().include("side");
        sign.apply(command);
        const result = await command.call();
        expect(result.status, result.message).toBe(MergeStatus.MERGED);
        const label = `merge ${sign.args.join(" ")} commit.gpgsign=${c.config} (${format})`;
        // the merge alone is signed (its parents as the setup made them)
        await fx.expectSameCommits(format, dirs, [c.signed, false, false, false], ["HEAD"], label);
      }
    }
  }, 120_000);

  it("merge: a fast-forward signs nothing, -S or not", async () => {
    for (const format of FORMATS) {
      const dirs = fx.twins(format, setup);
      for (const dir of [dirs.native, dirs.ours]) fx.gitOk(dir, "reset", "-q", "--hard", "main~1");
      expect(fx.git(dirs.native, ["merge", "-S", "side"]).status).toBe(0);
      const result = await (await fx.ours(dirs.ours)).merge().include("side").setSign(true).call();
      expect(result.status).toBe(MergeStatus.FAST_FORWARD);
      await fx.expectSameCommits(format, dirs, false, ["HEAD"], `fast-forward (${format})`);
    }
  }, 120_000);

  it("merge --continue is a plain git commit: signed by commit.gpgSign only", async () => {
    for (const format of FORMATS) {
      for (const config of ["true", "false"]) {
        const dirs = fx.twins(format, (dir) => {
          setup(dir);
          // a conflict: side changes file too
          fx.gitOk(dir, "checkout", "-q", "side");
          writeFileSync(join(dir, "file"), "side\n");
          fx.gitOk(dir, "commit", "-q", "-a", "-m", "side file");
          fx.gitOk(dir, "checkout", "-q", "main");
          fx.gitOk(dir, "config", "commit.gpgsign", config);
        });
        expect(fx.git(dirs.native, ["merge", "-S", "side"]).status).toBe(1);
        const g: Git = await fx.ours(dirs.ours);
        const stopped = await g.merge().include("side").setSign(true).call();
        expect(stopped.status).toBe(MergeStatus.CONFLICTING);
        for (const dir of [dirs.native, dirs.ours]) {
          writeFileSync(join(dir, "file"), "merged\n");
          fx.gitOk(dir, "add", "file");
        }
        const native = fx.git(dirs.native, ["merge", "--continue"]);
        expect(native.status, native.stderr).toBe(0);
        const continued = await (await fx.ours(dirs.ours))
          .merge()
          .setOperation(MergeOperation.CONTINUE)
          .call();
        expect(continued.status, continued.message).toBe(MergeStatus.MERGED);
        await fx.expectSameCommits(
          format,
          dirs,
          [config === "true", false, false, false, false],
          ["HEAD"],
          `merge --continue commit.gpgsign=${config} (${format})`,
        );
      }
    }
  }, 120_000);

  it("am -S, -S<keyid>, commit.gpgSign and --no-gpg-sign: each patch's commit signed as git signs it", async () => {
    const cases: { sign: boolean | "key" | undefined; config?: string; signed: boolean }[] = [
      { sign: true, signed: true },
      { sign: "key", signed: true },
      { sign: undefined, config: "true", signed: true },
      { sign: false, config: "true", signed: false },
      { sign: undefined, signed: false },
    ];
    for (const format of FORMATS) {
      for (const c of cases) {
        for (const encoding of [undefined, "ISO-8859-1"]) {
          const dirs = fx.twins(format, setup);
          // two patches: main's second commit, then side's (both onto main~1)
          const patch =
            fx.gitOk(dirs.native, "format-patch", "--stdout", "-1", "main") +
            fx.gitOk(dirs.native, "format-patch", "--stdout", "-1", "side");
          const mbox = join(fx.root, "am.mbox");
          writeFileSync(mbox, patch);
          for (const dir of [dirs.native, dirs.ours]) {
            fx.gitOk(dir, "reset", "-q", "--hard", "main~1");
            if (c.config !== undefined) fx.gitOk(dir, "config", "commit.gpgsign", c.config);
            if (encoding) fx.gitOk(dir, "config", "i18n.commitEncoding", encoding);
          }
          const sign = signArgs(format, c.sign);
          const native = fx.git(dirs.native, ["am", ...sign.args, mbox]);
          expect(native.status, native.stderr).toBe(0);
          const command = (await fx.ours(dirs.ours)).am().addMbox(patch);
          sign.apply(command);
          const result = await command.call();
          expect(result.exitCode, result.errors).toBe(0);
          const label = `am ${sign.args.join(" ")} commit.gpgsign=${c.config} encoding=${encoding} (${format})`;
          if (encoding)
            expect(fx.rawCommit(dirs.ours, "HEAD"), label).toContain(`encoding ${encoding}\n`);
          await fx.expectSameCommits(format, dirs, c.signed, ["main~1..HEAD"], label);
        }
      }
    }
  }, 180_000);

  it("am -S under a non-UTF-8 i18n.commitEncoding in a SHA-256 repository: the signature in `gpgsig-sha256`", async () => {
    for (const format of FORMATS) {
      const dirs = fx.twins(format, setup, ["--object-format=sha256"]);
      const patch =
        fx.gitOk(dirs.native, "format-patch", "--stdout", "-1", "main") +
        fx.gitOk(dirs.native, "format-patch", "--stdout", "-1", "side");
      const mbox = join(fx.root, "am-sha256.mbox");
      writeFileSync(mbox, patch);
      for (const dir of [dirs.native, dirs.ours]) {
        fx.gitOk(dir, "reset", "-q", "--hard", "main~1");
        fx.gitOk(dir, "config", "i18n.commitEncoding", "ISO-8859-1");
      }
      const native = fx.git(dirs.native, ["am", "-S", mbox]);
      expect(native.status, native.stderr).toBe(0);
      const result = await (await fx.ours(dirs.ours)).am().addMbox(patch).setSign(true).call();
      expect(result.exitCode, result.errors).toBe(0);
      const label = `am -S sha256 encoding=ISO-8859-1 (${format})`;
      const raw = fx.rawCommit(dirs.ours, "HEAD");
      expect(raw, label).toContain("encoding ISO-8859-1\ngpgsig-sha256 ");
      expect(raw, label).not.toMatch(/^gpgsig /m);
      await fx.expectSameCommits(format, dirs, true, ["main~1..HEAD"], label);
    }
  }, 120_000);
});
