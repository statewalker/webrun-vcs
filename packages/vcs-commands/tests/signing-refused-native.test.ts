/**
 * Requests to sign refused as native git refuses them when its signing program fails
 * (statewalker/statewalker-root#283): no signer exists yet, so `commit -S`, `commit.gpgSign`,
 * `tag -s`/`-u`, `tag.gpgSign`, `tag.forceSignAnnotated` and `push --signed`/`push.gpgSign`
 * fail with git's lines and exit status, and write nothing a signature would have covered
 * (no commit or tag object reaches a ref). `--no-gpg-sign` / `--no-sign` / `--no-signed`
 * let the commands go on.
 *
 * Native git signs through a `gpg.program` that exits 1 without output; both twins carry
 * the same configuration. Scenarios from git's t7510-signed-commit (commit, merge,
 * cherry-pick, revert, rebase, am with `-S` and `commit.gpgSign`), t7004-tag (`tag -s`,
 * `-u`, `tag.gpgSign`, `tag.forceSignAnnotated`, `--no-sign`) and t5534-push-signed
 * (`push --signed` / `push.gpgSign` against a receiving end without `push-cert`).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Git, MergeStatus, RebaseStatus, SigningFailedError } from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { git, gitOk, normalizeState, openOurs, put, snapshot } from "./merge-native-helpers.js";
import {
  nativeGitAvailable,
  nativeGitEnv,
  nativeGitHttpBackend,
} from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;

/** gpg-interface.c's lines for a signing program that fails without output. */
const GPG_FAILED = ["error: gpg failed to sign the data:", "(no gpg output)"];

/**
 * Two copies (native, ours) of a repository: `main` (a.txt, then b.txt) and `side` from
 * main's first commit (s.txt); a failing `gpg.program` and `config` in both.
 */
function twins(config: Record<string, string> = {}, branch = "main") {
  const n = counter++;
  const dirs = { native: join(root, `native-${n}`), ours: join(root, `ours-${n}`) };
  for (const dir of [dirs.native, dirs.ours]) {
    mkdirSync(dir, { recursive: true });
    gitOk(root, dir, "init", "-q", "-b", "main");
    put(dir, "a.txt", "a\n");
    gitOk(root, dir, "add", "-A");
    gitOk(root, dir, "commit", "-qm", "one");
    gitOk(root, dir, "checkout", "-qb", "side");
    put(dir, "s.txt", "s\n");
    gitOk(root, dir, "add", "-A");
    gitOk(root, dir, "commit", "-qm", "side");
    gitOk(root, dir, "checkout", "-q", "main");
    put(dir, "b.txt", "b\n");
    gitOk(root, dir, "add", "-A");
    gitOk(root, dir, "commit", "-qm", "two");
    gitOk(root, dir, "checkout", "-q", branch);
    gitOk(root, dir, "config", "gpg.program", join(root, "failing-gpg"));
    for (const [key, value] of Object.entries(config)) gitOk(root, dir, "config", key, value);
  }
  return dirs;
}

/** Our working copy over `dir`, as the native git of the sandbox (2.43 or 2.5x) behaves. */
function ours(dir: string): Promise<Git> {
  const env = { ...nativeGitEnv(root), GIT_EDITOR: "true" };
  return openOurs(
    dir,
    createNodeGitHostEnvironment({
      env,
      hookRunner: createNodeHookRunner({ env, compatibility: nativeIs25x ? "2.56" : "2.43" }),
    }),
  );
}

/** The error `run` throws (undefined when it succeeds). */
async function thrown(run: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

/** Every ref with its value (packed and loose), and the objects stored. */
function refs(dir: string): string {
  return gitOk(root, dir, "for-each-ref", "--format=%(refname) %(objectname)");
}

/** The twins agree: refs, HEAD, index, worktree, state files. */
function same(dirs: { native: string; ours: string }): void {
  expect(refs(dirs.ours)).toBe(refs(dirs.native));
  expect(snapshot(root, dirs.ours)).toEqual(snapshot(root, dirs.native));
}

describeGit("requests to sign refused as git refuses them when gpg fails", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "signing-refused-"));
    writeFileSync(join(root, "failing-gpg"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(root, "failing-gpg"), 0o755);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  describe("commit (t7510-signed-commit)", () => {
    const COMMIT_FAILED = [...GPG_FAILED, "fatal: failed to write commit object"].join("\n");

    it("-S, -S<keyid> and commit.gpgSign: refused, nothing committed, the index kept", async () => {
      const cases: { args: string[]; config?: Record<string, string>; sign?: boolean | string }[] =
        [
          { args: ["-S"], sign: true },
          { args: ["-SB7227189"], sign: "B7227189" },
          { args: [], config: { "commit.gpgSign": "true" } },
          { args: ["-a"], config: { "commit.gpgSign": "true" } },
        ];
      for (const c of cases) {
        const dirs = twins(c.config);
        for (const dir of [dirs.native, dirs.ours]) {
          put(dir, "a.txt", "a2\n");
          if (!c.args.includes("-a")) gitOk(root, dir, "add", "a.txt");
        }
        const native = git(root, dirs.native, "commit", "-m", "signed", ...c.args);
        const g = await ours(dirs.ours);
        const command = g.commit().setMessage("signed");
        if (c.args.includes("-a")) command.setAll(true);
        if (c.sign !== undefined) {
          if (typeof c.sign === "string") command.setSigningKey(c.sign);
          else command.setSign(c.sign);
        }
        const error = await thrown(() => command.call());
        expect(native.status).toBe(128);
        expect(error).toBeInstanceOf(SigningFailedError);
        expect((error as SigningFailedError).exitCode).toBe(128);
        expect(`${error?.message}\n`).toBe(native.stderr);
        expect(native.stderr).toBe(`${COMMIT_FAILED}\n`);
        same(dirs);
      }
    });

    it("--no-gpg-sign under commit.gpgSign: committed", async () => {
      const dirs = twins({ "commit.gpgSign": "true" });
      for (const dir of [dirs.native, dirs.ours]) {
        put(dir, "a.txt", "a2\n");
        gitOk(root, dir, "add", "a.txt");
      }
      expect(git(root, dirs.native, "commit", "-qm", "unsigned", "--no-gpg-sign").status).toBe(0);
      const g = await ours(dirs.ours);
      await g.commit().setMessage("unsigned").setSign(false).call();
      same(dirs);
    });

    it("nothing to commit is told before the signing (prepare_to_commit first)", async () => {
      const dirs = twins({ "commit.gpgSign": "true" });
      const native = git(root, dirs.native, "commit", "-m", "x");
      const error = await thrown(async () =>
        (await ours(dirs.ours)).commit().setMessage("x").call(),
      );
      expect(native.status).toBe(1);
      expect(error).toBeDefined();
      expect(error).not.toBeInstanceOf(SigningFailedError);
      same(dirs);
    });
  });

  describe("tag (t7004-tag)", () => {
    const TAG_FAILED = [
      ...GPG_FAILED,
      "error: unable to sign the tag",
      "The tag message has been left in .git/TAG_EDITMSG",
    ].join("\n");

    it("-s, -u and tag.gpgSign: refused (exit 128), no tag object or ref", async () => {
      const cases: {
        args: string[];
        config?: Record<string, string>;
        setup: (g: Git) => ReturnType<Git["tag"]>;
      }[] = [
        { args: ["-s", "-m", "m"], setup: (g) => g.tag().setMessage("m").setSigned(true) },
        {
          args: ["-u", "KEY", "-m", "m"],
          setup: (g) => g.tag().setMessage("m").setSigningKey("KEY"),
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
      ];
      for (const c of cases) {
        const dirs = twins(c.config);
        const native = git(root, dirs.native, "tag", ...c.args, "v1");
        const command = c.setup(await ours(dirs.ours)).setName("v1");
        const error = await thrown(() => command.call());
        expect(native.status, c.args.join(" ")).toBe(128);
        if (c.args.includes("-m")) {
          expect(native.stderr).toBe(`${TAG_FAILED}\n`);
        }
        expect(error, c.args.join(" ")).toBeInstanceOf(SigningFailedError);
        expect((error as SigningFailedError).exitCode).toBe(128);
        expect(`${error?.message}\n`).toBe(`${TAG_FAILED}\n`);
        same(dirs);
        expect(gitOk(root, dirs.ours, "count-objects")).toBe(
          gitOk(root, dirs.native, "count-objects"),
        );
      }
    });

    it("--no-sign, -a under tag.forceSignAnnotated, lightweight tags: made unsigned", async () => {
      const cases: {
        args: string[];
        config: Record<string, string>;
        setup: (g: Git) => ReturnType<Git["tag"]>;
      }[] = [
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
        {
          args: [],
          config: { "tag.forceSignAnnotated": "true" },
          setup: (g) => g.tag(),
        },
        {
          args: ["-a", "-m", "m"],
          config: { "user.signingKey": "KEY" },
          setup: (g) => g.tag().setMessage("m").setAnnotated(true),
        },
      ];
      for (const c of cases) {
        const dirs = twins(c.config);
        expect(git(root, dirs.native, "tag", ...c.args, "v1").status, c.args.join(" ")).toBe(0);
        await c
          .setup(await ours(dirs.ours))
          .setName("v1")
          .call();
        same(dirs);
      }
    });
  });

  describe("merge, cherry-pick, revert, rebase, am (t7510-signed-commit)", () => {
    it("merge under commit.gpgSign and -S: git's death, the merge left in progress", async () => {
      for (const sign of ["config", "option"] as const) {
        const dirs = twins(sign === "config" ? { "commit.gpgSign": "true" } : {});
        const native = git(
          root,
          dirs.native,
          "merge",
          ...(sign === "option" ? ["-S"] : []),
          "-m",
          "merged",
          "side",
        );
        const command = (await ours(dirs.ours)).merge().include("side").setMessage("merged");
        if (sign === "option") command.setSign(true);
        const error = await thrown(() => command.call());
        expect(native.status).toBe(128);
        expect(error).toBeInstanceOf(SigningFailedError);
        expect(`${error?.message}\n`).toBe(native.stderr);
        same(dirs);
      }
    });

    it("merge: a fast-forward signs nothing; --no-gpg-sign commits", async () => {
      const ff = twins({ "commit.gpgSign": "true" }, "side");
      for (const dir of [ff.native, ff.ours]) gitOk(root, dir, "reset", "-q", "--hard", "main~1");
      expect(git(root, ff.native, "merge", "main").status).toBe(0);
      const result = await (await ours(ff.ours)).merge().include("main").call();
      expect(result.status).toBe(MergeStatus.FAST_FORWARD);
      same(ff);

      const dirs = twins({ "commit.gpgSign": "true" });
      expect(git(root, dirs.native, "merge", "--no-gpg-sign", "-m", "merged", "side").status).toBe(
        0,
      );
      await (await ours(dirs.ours))
        .merge()
        .include("side")
        .setMessage("merged")
        .setSign(false)
        .call();
      same(dirs);
    });

    it("cherry-pick and revert under commit.gpgSign: git's failure, CHERRY_PICK_HEAD left", async () => {
      for (const action of ["cherry-pick", "revert"] as const) {
        const dirs = twins({ "commit.gpgSign": "true" });
        const native =
          action === "cherry-pick"
            ? git(root, dirs.native, "cherry-pick", "side")
            : git(root, dirs.native, "revert", "--no-edit", "HEAD");
        const g = await ours(dirs.ours);
        const error = await thrown(() =>
          action === "cherry-pick"
            ? g.cherryPick().include("side").call()
            : g.revert().include("HEAD").call(),
        );
        // 2.43 dies (`fatal: <action> failed`, 128), 2.5x returns after the error (1)
        const tail = nativeIs25x ? [] : [`fatal: ${action} failed`];
        expect(native.stderr).toBe(
          `${[...GPG_FAILED, "error: failed to write commit object", ...tail].join("\n")}\n`,
        );
        expect(error).toBeInstanceOf(SigningFailedError);
        expect((error as SigningFailedError).exitCode).toBe(native.status);
        expect(`${error?.message}\n`).toBe(native.stderr);
        same(dirs);
      }
    });

    it("cherry-pick --no-gpg-sign under commit.gpgSign: picked", async () => {
      const dirs = twins({ "commit.gpgSign": "true" });
      expect(git(root, dirs.native, "cherry-pick", "--no-gpg-sign", "side").status).toBe(0);
      await (await ours(dirs.ours)).cherryPick().include("side").setSign(false).call();
      same(dirs);
    });

    it("rebase under commit.gpgSign: the pick stops, the branch untouched", async () => {
      const dirs = twins({ "commit.gpgSign": "true" }, "side");
      const native = git(root, dirs.native, "rebase", "main");
      const command = (await ours(dirs.ours)).rebase();
      await command.setUpstreamBranch("main");
      const result = await command.call();
      expect(native.status).toBe(1);
      expect(result.status).not.toBe(RebaseStatus.OK);
      // native git's progress (`Rebasing (1/1)\r`) left out
      const lines = (text: string) =>
        text
          .replace(/^Rebasing \(\d+\/\d+\)\r?/gm, "")
          .replace(/^(Could not apply [0-9a-f]+\.\.\.) (?!# )/m, "$1 # ")
          // 2.43's todo line in the advice has no `# `, its empty hint lines a space
          .replace(/^(hint: {5}pick [0-9a-f]+) (?!# )/m, "$1 # ")
          .replace(/^hint: $/gm, "hint:")
          .replace(/\n+$/, "");
      expect(lines(result.message ?? "")).toBe(lines(native.stderr));
      expect(native.stderr).toContain(GPG_FAILED.join("\n"));
      expect(refs(dirs.ours)).toBe(refs(dirs.native));
      expect(snapshot(root, dirs.ours, normalizeState)).toEqual(
        snapshot(root, dirs.native, normalizeState),
      );
    });

    it("am under commit.gpgSign: git's death, nothing committed; --no-gpg-sign applies", async () => {
      for (const noSign of [false, true]) {
        const dirs = twins({ "commit.gpgSign": "true" });
        const patch = gitOk(root, dirs.native, "format-patch", "--stdout", "-1", "main");
        for (const dir of [dirs.native, dirs.ours]) {
          gitOk(root, dir, "reset", "-q", "--hard", "main~1");
        }
        writeFileSync(join(root, "p.mbox"), patch);
        const native = git(
          root,
          dirs.native,
          "am",
          ...(noSign ? ["--no-gpg-sign"] : []),
          join(root, "p.mbox"),
        );
        const command = (await ours(dirs.ours)).am().addMbox(patch);
        if (noSign) command.setSign(false);
        const result = await command.call();
        expect({ status: result.exitCode, stderr: result.errors }).toEqual({
          status: native.status,
          stderr: native.stderr,
        });
        same(dirs);
      }
    });
  });

  describe("push (t5534-push-signed)", () => {
    function withRemote(dirs: { native: string; ours: string }) {
      for (const dir of [dirs.native, dirs.ours]) {
        gitOk(root, dir, "init", "-q", "--bare", "remote.git");
        gitOk(root, dir, "remote", "add", "origin", join(dir, "remote.git"));
      }
    }

    it("--signed and push.gpgSign=true: the receiving end does not support it", async () => {
      for (const how of ["option", "config"] as const) {
        const dirs = twins(how === "config" ? { "push.gpgSign": "true" } : {});
        withRemote(dirs);
        const native = git(
          root,
          dirs.native,
          "push",
          ...(how === "option" ? ["--signed"] : []),
          "origin",
          "main",
        );
        const command = (await ours(dirs.ours)).push().setRemote("origin").setRefSpecs("main");
        if (how === "option") command.setSigned(true);
        const error = await thrown(() => command.call());
        expect(native.status).toBe(128);
        expect(native.stderr).toContain(
          "fatal: the receiving end does not support --signed push\n",
        );
        expect(error).toBeDefined();
        expect(error?.message).toBe("fatal: the receiving end does not support --signed push");
        expect(refs(join(dirs.ours, "remote.git"))).toBe(refs(join(dirs.native, "remote.git")));
        expect(refs(join(dirs.ours, "remote.git"))).toBe("");
      }
    });

    it("a receiving end that takes certificates (receive.certNonceSeed): signing fails, nothing pushed", async () => {
      for (const how of ["always", "if-asked"] as const) {
        const dirs = twins({ "push.gpgSign": how === "always" ? "true" : "if-asked" });
        withRemote(dirs);
        for (const dir of [dirs.native, dirs.ours]) {
          const remote = join(dir, "remote.git");
          gitOk(root, remote, "config", "receive.certNonceSeed", "seed");
          gitOk(root, remote, "config", "http.receivepack", "true");
        }
        // native git pushes through its local receive-pack, ours through http-backend
        const native = git(root, dirs.native, "push", "origin", "main");
        expect(native.status).toBe(128);
        expect(native.stderr).toContain(
          `${[...GPG_FAILED, "fatal: failed to sign the push certificate"].join("\n")}\n`,
        );
        const backend = nativeGitHttpBackend(dirs.ours, root);
        const originalFetch = globalThis.fetch;
        globalThis.fetch = backend.fetch;
        try {
          gitOk(root, dirs.ours, "remote", "set-url", "origin", "http://git.test/remote.git");
          const error = await thrown(async () =>
            (await ours(dirs.ours)).push().setRemote("origin").setRefSpecs("main").call(),
          );
          expect(error).toBeInstanceOf(SigningFailedError);
          expect((error as SigningFailedError).exitCode).toBe(128);
          expect(error?.message).toBe(
            [...GPG_FAILED, "fatal: failed to sign the push certificate"].join("\n"),
          );
        } finally {
          globalThis.fetch = originalFetch;
          backend.close();
        }
        expect(refs(join(dirs.ours, "remote.git"))).toBe("");
        expect(refs(join(dirs.native, "remote.git"))).toBe("");
      }
    });

    it("push.gpgSign=if-asked: warned, pushed unsigned; --no-signed: pushed", async () => {
      for (const how of ["if-asked", "no-signed"] as const) {
        const dirs = twins({ "push.gpgSign": how === "if-asked" ? "if-asked" : "true" });
        withRemote(dirs);
        const native = git(
          root,
          dirs.native,
          "push",
          ...(how === "no-signed" ? ["--no-signed"] : []),
          "origin",
          "main",
        );
        expect(native.status).toBe(0);
        const command = (await ours(dirs.ours)).push().setRemote("origin").setRefSpecs("main");
        if (how === "no-signed") command.setSigned(false);
        const result = await command.call();
        const warning =
          "warning: not sending a push certificate since the receiving end does not support --signed push";
        if (how === "if-asked") {
          expect(native.stderr).toContain(`${warning}\n`);
          expect(result.warnings).toEqual([warning]);
        } else {
          expect(native.stderr).not.toContain("warning:");
          expect(result.warnings ?? []).toEqual([]);
        }
        expect(refs(join(dirs.ours, "remote.git"))).toBe(refs(join(dirs.native, "remote.git")));
      }
    });
  });
});
