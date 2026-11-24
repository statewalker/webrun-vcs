/**
 * Merge messages against native git: fmt-merge-msg's title and shortlog (`--log[=<n>]`,
 * `--no-log`, `merge.log`, `merge.summary`, `merge.branchdesc`, `merge.suppressDest`,
 * `--into-name`, annotated tags' messages), `merge --signoff`, and the refusal of unrelated
 * histories with its override. Merge twins are built twice with the same dates (so equal
 * messages give equal commit ids), native git merging in one and ours in the other, then
 * compared whole (`snapshot`) and by message. `FmtMergeMsgCommand` is compared with `git
 * fmt-merge-msg` over the FETCH_HEAD native `git fetch` writes.
 *
 * Sources: t7608-merge-messages.sh, t7600-merge.sh (log, unrelated histories),
 * t7614-merge-signoff.sh, t6200-fmt-merge-msg.sh.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CleanupMode,
  FastForwardMode,
  type Git,
  type MergeCommand,
  MergeStatus,
} from "../src/index.js";
import { normalizeState, openOurs, snapshot } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

/** Whether native git is 2.5x (else 2.43), for the hook runner's compatibility. */
const nativeIs25x = (() => {
  if (!nativeGitAvailable()) return false;
  const m = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"]).toString());
  return !!m && (Number(m[1]) > 2 || Number(m[2]) >= 50);
})();

let root: string;
let counter = 0;

const env = (extra: Record<string, string> = {}) => ({
  ...nativeGitEnv(root),
  GIT_EDITOR: "true",
  ...extra,
});

function git(dir: string, args: string[], extra: Record<string, string> = {}, input?: string) {
  const r = spawnSync("git", args, { cwd: dir, env: env(extra), encoding: "utf8", input });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function gitOk(dir: string, args: string[], extra: Record<string, string> = {}): string {
  const r = git(dir, args, extra);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A repository builder whose commits get one minute more each (test_tick). */
function builder(dir: string) {
  mkdirSync(dir, { recursive: true });
  let tick = 0;
  const run = (...args: string[]) => gitOk(dir, args);
  run("init", "-q", "-b", "main");
  return {
    run,
    /** A commit of `files` (appended to) with `message`, by `who` (`Name` for both idents). */
    commit(message: string, files: Record<string, string> = {}, who?: string) {
      for (const [path, text] of Object.entries(files)) {
        writeFileSync(join(dir, path), text);
        run("add", path);
      }
      tick++;
      const date = `${1112911993 + tick * 60} +0000`;
      gitOk(dir, ["commit", "-q", "--allow-empty", "-m", message], {
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
        ...(who
          ? { GIT_AUTHOR_NAME: `${who} Author`, GIT_COMMITTER_NAME: `${who} Committer` }
          : {}),
      });
    },
  };
}

/** Our working copy with git's variables (and the Node hook runner). */
async function ours(dir: string): Promise<Git> {
  const variables = env();
  return openOurs(
    dir,
    createNodeGitHostEnvironment({
      env: variables,
      hookRunner: createNodeHookRunner({
        env: variables,
        compatibility: nativeIs25x ? "2.56" : "2.43",
      }),
    }),
  );
}

/**
 * main with `base`, side with three commits off it, main one ahead: the common history of
 * the merge twins; `extra` runs after it in both.
 */
function sideHistory(dir: string, extra?: (b: ReturnType<typeof builder>) => void) {
  const b = builder(dir);
  b.commit("base", { f: "base\n" });
  b.run("checkout", "-q", "-b", "side");
  b.commit("side one", { s: "1\n" });
  b.commit("side two", { s: "2\n" }, "Other");
  b.commit("side three\n\nwith a body", { s: "3\n" });
  b.run("checkout", "-q", "main");
  b.commit("main one", { m: "1\n" });
  extra?.(b);
}

interface TwinCase {
  build: (dir: string) => void;
  /** native `git merge` arguments */
  args: string[];
  /** the same merge on ours */
  merge: (git: Git) => MergeCommand;
  /** native dies with this text; ours throws it */
  throws?: string;
  /** native git in the twin before the merge (config, refs) */
  prepare?: (dir: string) => void;
  /** state files left out of the comparison */
  skipState?: string[];
}

/** Native merge in one twin, ours in the other: same repository, same message. */
async function twins(c: TwinCase) {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const mine = join(root, `ours-${n}`);
  for (const dir of [native, mine]) {
    c.build(dir);
    c.prepare?.(dir);
  }
  const expected = git(native, ["merge", ...c.args]);
  const command = c.merge(await ours(mine));
  if (c.throws) {
    await expect(command.call()).rejects.toThrow(c.throws);
    expect(expected.status).toBe(128);
    expect(expected.stderr).toContain(c.throws);
  } else {
    const result = await command.call();
    if (expected.status === 0) {
      expect([MergeStatus.MERGED, MergeStatus.MERGED_NOT_COMMITTED]).toContain(result.status);
    } else {
      expect(result.status).not.toBe(MergeStatus.MERGED);
    }
  }
  const message = (dir: string) => gitOk(dir, ["cat-file", "commit", "HEAD"]);
  expect(message(mine)).toBe(message(native));
  const normalize = (name: string, text: string) =>
    c.skipState?.includes(name) ? "<skipped>" : normalizeState(name, text);
  expect(snapshot(root, mine, normalize)).toEqual(snapshot(root, native, normalize));
  const result = { native, mine, message: message(native) };
  return result;
}

describeGit("merge messages, --log and --signoff against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-log-native-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("titles (t7608-merge-messages)", () => {
    it("merge local branch", async () => {
      const { message } = await twins({
        build: (d) => sideHistory(d),
        args: ["side"],
        merge: (g) => g.merge().include("side"),
      });
      expect(message).toMatch(/\n\nMerge branch 'side'\n$/);
    });

    it("merge octopus branches", async () => {
      const { message } = await twins({
        build: (d) =>
          sideHistory(d, (b) => {
            b.run("checkout", "-q", "-b", "octopus-b", "main~1");
            b.commit("octopus two", { o: "2\n" });
            b.run("checkout", "-q", "main");
          }),
        args: ["side", "octopus-b"],
        merge: (g) => g.merge().include("side").include("octopus-b"),
      });
      expect(message).toMatch(/Merge branches 'side' and 'octopus-b'\n$/);
    });

    it("merge tag", async () => {
      await twins({
        build: (d) => sideHistory(d, (b) => b.run("tag", "tag-1", "side")),
        args: ["tag-1"],
        merge: (g) => g.merge().include("tag-1"),
      });
    });

    it("ambiguous tag: the tag wins over the branch", async () => {
      const { message } = await twins({
        build: (d) =>
          sideHistory(d, (b) => {
            b.run("branch", "ambiguous", "side~1");
            b.run("tag", "ambiguous", "side");
          }),
        args: ["ambiguous"],
        merge: (g) => g.merge().include("ambiguous"),
      });
      expect(message).toMatch(/Merge tag 'ambiguous'\n$/);
    });

    it("remote-tracking branch", async () => {
      await twins({
        build: (d) =>
          sideHistory(d, (b) => b.run("update-ref", "refs/remotes/origin/main", "side")),
        args: ["origin/main"],
        merge: (g) => g.merge().include("origin/main"),
      });
    });

    it("a branch's early part, a full ref name and a commit id", async () => {
      await twins({
        build: (d) => sideHistory(d),
        args: ["side~1"],
        merge: (g) => g.merge().include("side~1"),
      });
      await twins({
        build: (d) => sideHistory(d),
        args: ["side^"],
        merge: (g) => g.merge().include("side^"),
      });
      await twins({
        build: (d) => sideHistory(d),
        args: ["refs/heads/side"],
        merge: (g) => g.merge().include("refs/heads/side"),
      });
      const id = (dir: string) => gitOk(dir, ["rev-parse", "side"]).trim();
      const n = counter;
      await twins({
        build: (d) => sideHistory(d),
        args: [id(join(root, `native-${n - 1}`))],
        merge: (g) => g.merge().include(id(join(root, `native-${n - 1}`))),
      });
    });

    it("into another branch, into a detached HEAD, --into-name, merge.suppressDest", async () => {
      const topic = (d: string) =>
        sideHistory(d, (b) => b.run("checkout", "-q", "-b", "topic", "main"));
      const { message } = await twins({
        build: topic,
        args: ["side"],
        merge: (g) => g.merge().include("side"),
      });
      expect(message).toMatch(/Merge branch 'side' into topic\n$/);
      await twins({
        build: (d) => sideHistory(d, (b) => b.run("checkout", "-q", "--detach", "main")),
        args: ["side"],
        merge: (g) => g.merge().include("side"),
      });
      await twins({
        build: topic,
        args: ["--into-name=main", "side"],
        merge: (g) => g.merge().include("side").setIntoName("main"),
      });
      await twins({
        build: topic,
        prepare: (d) => gitOk(d, ["config", "merge.suppressDest", "top*"]),
        args: ["side"],
        merge: (g) => g.merge().include("side"),
      });
      // an empty value clears the defaults: main is named too
      await twins({
        build: (d) => sideHistory(d),
        prepare: (d) => gitOk(d, ["config", "merge.suppressDest", ""]),
        args: ["side"],
        merge: (g) => g.merge().include("side"),
      });
    });
  });

  describe("shortlog (t7600-merge 'merge log message', t6200-fmt-merge-msg)", () => {
    it("--log, --log=<n>, --no-log", async () => {
      const { message } = await twins({
        build: (d) => sideHistory(d),
        args: ["--log", "side"],
        merge: (g) => g.merge().include("side").setLog(true),
      });
      expect(message).toMatch(
        /Merge branch 'side'\n\n\* side:\n {2}side three\n {2}side two\n {2}side one\n$/,
      );
      const limited = await twins({
        build: (d) => sideHistory(d),
        args: ["--log=2", "side"],
        merge: (g) => g.merge().include("side").setLog(2),
      });
      expect(limited.message).toMatch(
        /\* side: \(3 commits\)\n {2}side three\n {2}side two\n {2}\.\.\.\n$/,
      );
      await twins({
        build: (d) => sideHistory(d),
        prepare: (d) => gitOk(d, ["config", "merge.log", "true"]),
        args: ["--no-log", "side"],
        merge: (g) => g.merge().include("side").setLog(false),
      });
    });

    it("merge.log and merge.summary, booleans and numbers", async () => {
      for (const [key, value] of [
        ["merge.log", "yes"],
        ["merge.log", "1"],
        ["merge.summary", "true"],
        ["merge.log", "0"],
      ] as const) {
        await twins({
          build: (d) => sideHistory(d),
          prepare: (d) => gitOk(d, ["config", key, value]),
          args: ["side"],
          merge: (g) => g.merge().include("side"),
        });
      }
      // the last of the two names wins
      await twins({
        build: (d) => sideHistory(d),
        prepare: (d) => {
          gitOk(d, ["config", "merge.log", "true"]);
          gitOk(d, ["config", "merge.summary", "false"]);
        },
        args: ["side"],
        merge: (g) => g.merge().include("side"),
      });
    });

    it("-m with --log: the shortlog follows the message given", async () => {
      await twins({
        build: (d) => sideHistory(d),
        args: ["-m", "Sync with side", "--log", "side"],
        merge: (g) => g.merge().include("side").setMessage("Sync with side").setLog(true),
      });
    });

    it("an octopus with --log lists each head", async () => {
      await twins({
        build: (d) =>
          sideHistory(d, (b) => {
            b.run("checkout", "-q", "-b", "other", "main~1");
            b.commit("other one", { o: "1\n" });
            b.run("checkout", "-q", "main");
          }),
        args: ["--log", "side", "other"],
        merge: (g) => g.merge().include("side").include("other").setLog(true),
      });
    });

    it("a conflict keeps the shortlog in MERGE_MSG", async () => {
      await twins({
        build: (d) =>
          sideHistory(d, (b) => {
            b.commit("main changes s", { s: "main\n" });
          }),
        args: ["--log", "side"],
        merge: (g) => g.merge().include("side").setLog(true),
      });
    });

    it("merge.branchdesc puts the branch's description under its name", async () => {
      await twins({
        build: (d) => sideHistory(d),
        prepare: (d) => {
          gitOk(d, ["config", "merge.branchdesc", "true"]);
          gitOk(d, ["config", "branch.side.description", "First line\nsecond line"]);
        },
        args: ["--log", "side"],
        merge: (g) => g.merge().include("side").setLog(true),
      });
    });

    it("an annotated tag's message follows the title (t6200 'merging an annotated tag')", async () => {
      const annotated = (d: string) =>
        sideHistory(d, (b) => b.run("tag", "-a", "-m", "An annotated one", "annotate", "side"));
      await twins({
        build: annotated,
        args: ["--no-commit", "--no-ff", "--log", "annotate"],
        merge: (g) =>
          g
            .merge()
            .include("annotate")
            .setCommit(false)
            .setFastForwardMode(FastForwardMode.NO_FF)
            .setLog(true),
        // git's MERGE_HEAD names the tag object, ours the commit (not this ticket's)
        skipState: ["MERGE_HEAD"],
      });
      await twins({
        build: annotated,
        args: ["annotate"],
        merge: (g) => g.merge().include("annotate"),
      });
      const id = gitOk(join(root, `native-${counter - 1}`), ["rev-parse", "annotate"]).trim();
      await twins({
        build: annotated,
        args: ["--no-commit", "--no-ff", "--log", id],
        merge: (g) =>
          g
            .merge()
            .include(id)
            .setCommit(false)
            .setFastForwardMode(FastForwardMode.NO_FF)
            .setLog(true),
        skipState: ["MERGE_HEAD"],
      });
    });
  });

  describe("--signoff (t7614-merge-signoff)", () => {
    it("adds the committer's sign-off; --no-signoff adds none", async () => {
      const { message } = await twins({
        build: (d) => sideHistory(d, (b) => b.run("checkout", "-q", "-b", "other-branch", "main")),
        args: ["side", "--signoff", "--no-edit"],
        merge: (g) => g.merge().include("side").setSignoff(true),
      });
      expect(message).toMatch(
        /\n\nMerge branch 'side' into other-branch\n\nSigned-off-by: Interop Tester <interop@example.com>\n$/,
      );
      await twins({
        build: (d) => sideHistory(d),
        args: ["side", "--no-edit", "--signoff", "--no-signoff"],
        merge: (g) => g.merge().include("side").setSignoff(false),
      });
    });

    it("with -m ending in trailers, with --log, with verbatim cleanup", async () => {
      await twins({
        build: (d) => sideHistory(d),
        args: ["--signoff", "-m", "Merge it\n\nAcked-by: A <a@example.com>", "side"],
        merge: (g) =>
          g
            .merge()
            .include("side")
            .setSignoff(true)
            .setMessage("Merge it\n\nAcked-by: A <a@example.com>"),
      });
      // the same sign-off last already: none added
      await twins({
        build: (d) => sideHistory(d),
        args: [
          "--signoff",
          "-m",
          "Merge it\n\nSigned-off-by: Interop Tester <interop@example.com>",
          "side",
        ],
        merge: (g) =>
          g
            .merge()
            .include("side")
            .setSignoff(true)
            .setMessage("Merge it\n\nSigned-off-by: Interop Tester <interop@example.com>"),
      });
      await twins({
        build: (d) => sideHistory(d),
        args: ["--signoff", "--log", "side"],
        merge: (g) => g.merge().include("side").setSignoff(true).setLog(true),
      });
      await twins({
        build: (d) => sideHistory(d),
        args: ["--signoff", "--cleanup=verbatim", "side"],
        merge: (g) =>
          g.merge().include("side").setSignoff(true).setCleanupMode(CleanupMode.VERBATIM),
      });
    });

    it("a merge stopped before its commit signs nothing (--no-commit, conflicts)", async () => {
      await twins({
        build: (d) => sideHistory(d),
        args: ["--signoff", "--no-commit", "side"],
        merge: (g) => g.merge().include("side").setSignoff(true).setCommit(false),
      });
      await twins({
        build: (d) => sideHistory(d, (b) => b.commit("main changes s", { s: "main\n" })),
        args: ["--signoff", "side"],
        merge: (g) => g.merge().include("side").setSignoff(true),
      });
    });

    it("prepare-commit-msg sees the signed-off MERGE_MSG", async () => {
      const hook = '#!/bin/sh\ncat "$1" > "$(git rev-parse --git-dir)/seen-msg"\n';
      const { native, mine } = await twins({
        build: (d) => sideHistory(d),
        prepare: (d) => {
          writeFileSync(join(d, ".git/hooks/prepare-commit-msg"), hook, { mode: 0o755 });
        },
        args: ["--signoff", "side"],
        merge: (g) => g.merge().include("side").setSignoff(true),
      });
      const seen = (d: string) => readFileSync(join(d, ".git/seen-msg"), "utf8");
      expect(seen(mine)).toBe(seen(native));
      expect(seen(native)).toBe(
        "Merge branch 'side'\n\nSigned-off-by: Interop Tester <interop@example.com>\n",
      );
    });
  });

  describe("unrelated histories (t7600-merge)", () => {
    /** main, and `other`, a root of its own. */
    const unrelated = (d: string) =>
      sideHistory(d, (b) => {
        b.run("checkout", "-q", "--orphan", "other");
        b.run("rm", "-rfq", ".");
        b.commit("other root", { u: "u\n" });
        b.commit("other two", { u: "u2\n" });
        b.run("checkout", "-q", "main");
      });

    it("are refused", async () => {
      await twins({
        build: unrelated,
        args: ["other"],
        merge: (g) => g.merge().include("other"),
        throws: "fatal: refusing to merge unrelated histories",
      });
      await twins({
        build: unrelated,
        args: ["side", "other"],
        merge: (g) => g.merge().include("side").include("other"),
        throws: "fatal: refusing to merge unrelated histories",
      });
    });

    it("merge with --allow-unrelated-histories, with --log", async () => {
      await twins({
        build: unrelated,
        args: ["--allow-unrelated-histories", "other"],
        merge: (g) => g.merge().include("other").setAllowUnrelatedHistories(true),
      });
      await twins({
        build: unrelated,
        args: ["--allow-unrelated-histories", "--log", "other"],
        merge: (g) => g.merge().include("other").setAllowUnrelatedHistories(true).setLog(true),
      });
    });
  });
});

describeGit("FmtMergeMsgCommand against git fmt-merge-msg (t6200-fmt-merge-msg)", () => {
  let repo: string;
  let remote: string;
  const apos = "'";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fmt-merge-msg-native-"));
    repo = join(root, "repo");
    const b = builder(repo);
    b.commit("Initial", { one: "one\n" });
    b.commit("Second", { one: "uno\n", two: "dos\n" });
    b.run("checkout", "-q", "-b", "left");
    b.commit("Common #1", { one: "c1\n" });
    b.commit("Common #2", { one: "c2\n" });
    b.run("branch", "right");
    b.commit("Left #3", { two: "l3\n" }, "Another");
    b.commit("Left #4", { two: "l4\n" }, "Another");
    b.commit("Left #5", { two: "l5\n" }, "Another");
    b.run("tag", "tag-l5");
    b.run("checkout", "-q", "right");
    b.commit("Right #3", { three: "r3\n" });
    b.run("tag", "tag-r3");
    b.commit("Right #4", { three: "r4\n" });
    b.commit("Right #5", { three: "r5\n" });
    b.run("checkout", "-q", "-b", "long");
    for (let i = 0; i < 30; i++) b.commit(`${i}`, { one: `${i}\n` });
    b.run("checkout", "-q", "main^0");
    b.commit("One step ahead");
    b.run("tag", "-a", "-m", "An annotated one", "annotate", "HEAD");
    b.run("checkout", "-q", "main");
    // a second repository that fetched nothing to merge (t6200's `remote`)
    remote = join(root, "remote");
    gitOk(root, ["clone", "-q", repo, remote]);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Native fmt-merge-msg over FETCH_HEAD and ours over the same text. */
  async function compare(
    dir: string,
    args: string[],
    configure: (command: ReturnType<Git["fmtMergeMsg"]>) => void = () => {},
  ): Promise<string> {
    const input = readFileSync(join(dir, ".git/FETCH_HEAD"), "utf8");
    const expected = git(dir, ["fmt-merge-msg", ...args], {}, input);
    expect(expected.status).toBe(0);
    const command = (await ours(dir)).fmtMergeMsg().setInput(input);
    configure(command);
    expect(await command.call()).toBe(expected.stdout);
    return expected.stdout;
  }

  const config = (key: string, value?: string) =>
    value === undefined
      ? git(repo, ["config", "--unset-all", key])
      : gitOk(repo, ["config", key, value]);

  it("message for merging local and external branches", async () => {
    gitOk(repo, ["fetch", "-q", ".", "left"]);
    expect(await compare(repo, [])).toBe(`Merge branch ${apos}left${apos}\n`);
    gitOk(repo, ["fetch", "-q", repo, "left"]);
    expect(await compare(repo, [])).toBe(`Merge branch ${apos}left${apos} of ${repo}\n`);
  });

  it("[merge] summary/log configuration, lengths, comment character", async () => {
    gitOk(repo, ["fetch", "-q", ".", "left"]);
    config("merge.log", "true");
    const full = await compare(repo, []);
    expect(full).toContain(
      "# By Another Author (3) and Interop Tester (2)\n# Via Another Committer\n",
    );
    config("merge.log");
    config("merge.summary", "true");
    expect(await compare(repo, [])).toBe(full);
    config("merge.summary");
    for (const value of ["3", "5", "0"]) {
      config("merge.log", value);
      await compare(repo, []);
    }
    config("merge.log");
    await compare(repo, ["--log=3"], (c) => c.setLog(3));
    await compare(repo, ["--log=5"], (c) => c.setLog(5));
    await compare(repo, ["--no-log"], (c) => c.setLog(false));
    config("core.commentChar", "x");
    await compare(repo, ["--log=5"], (c) => c.setLog(5));
    config("core.commentChar");
  });

  it("fmt-merge-msg -m", async () => {
    gitOk(repo, ["fetch", "-q", repo, "left"]);
    await compare(repo, ["-m", "Sync with left"], (c) => c.setMessage("Sync with left"));
    await compare(repo, ["--log", "-m", "Sync with left"], (c) =>
      c.setLog(true).setMessage("Sync with left"),
    );
    config("merge.log", "true");
    await compare(repo, ["-m", "Sync with left"], (c) => c.setMessage("Sync with left"));
    await compare(repo, ["--no-log", "-m", "Sync with left"], (c) =>
      c.setLog(false).setMessage("Sync with left"),
    );
    config("merge.log");
  });

  it("shortlog for two branches, tags, a tag and a branch, lots of commits", async () => {
    config("merge.summary", "yes");
    for (const refs of [
      ["left", "right"],
      ["tag", "tag-r3"],
      ["tag", "tag-r3", "tag", "tag-l5"],
      ["tag", "tag-r3", "left"],
      ["long"],
      ["annotate"],
    ]) {
      gitOk(repo, ["fetch", "-q", ".", ...refs]);
      await compare(repo, []);
    }
    config("merge.summary");
  });

  it("merge-msg with nothing to merge", async () => {
    gitOk(remote, ["checkout", "-q", "-b", "unrelated"]);
    gitOk(remote, ["fetch", "-q", "origin"]);
    expect(await compare(remote, [])).toBe("");
    // a head HEAD already contains is subsumed
    gitOk(repo, ["branch", "-f", "behind", "main~1"]);
    gitOk(repo, ["fetch", "-q", ".", "behind"]);
    expect(await compare(repo, [])).toBe("");
  });

  it("merge.suppressDest configuration and --into-name", async () => {
    gitOk(repo, ["fetch", "-q", ".", "left"]);
    for (const value of ["", "mast", "ma?*[rn]"]) {
      config("merge.suppressDest", value);
      await compare(repo, []);
    }
    gitOk(repo, ["checkout", "-q", "--detach", "HEAD"]);
    config("merge.suppressDest", "main");
    expect(await compare(repo, [])).toMatch(/ into HEAD\n$/);
    await compare(repo, ["--into-name=main"], (c) => c.setIntoName("main"));
    gitOk(repo, ["checkout", "-q", "main"]);
    config("merge.suppressDest");
  });

  it("merge.branchdesc with the shortlog", async () => {
    gitOk(repo, ["fetch", "-q", ".", "left", "right"]);
    config("merge.branchdesc", "true");
    config("branch.left.description", "Left side\nof the test");
    await compare(repo, ["--log"], (c) => c.setLog(true));
    config("merge.branchdesc");
    config("branch.left.description");
  });

  it("a line not in FETCH_HEAD's format dies as git", async () => {
    const input = `${gitOk(repo, ["rev-parse", "left"]).trim()}\t\tbranch 'left' of .\ngarbage\n`;
    const expected = git(repo, ["fmt-merge-msg"], {}, input);
    expect(expected.status).toBe(128);
    await expect((await ours(repo)).fmtMergeMsg().setInput(input).call()).rejects.toThrow(
      expected.stderr.trim(),
    );
  });

  it("the heads as git merge names them (addHead)", async () => {
    for (const heads of [
      ["left"],
      ["left", "right"],
      ["tag-r3", "left"],
      ["annotate"],
      ["left~2"],
    ]) {
      // git merge --no-commit --no-ff writes fmt-merge-msg's text to MERGE_MSG
      const twin = join(root, `heads-${counter++}`);
      gitOk(root, ["clone", "-q", repo, twin]);
      for (const ref of ["left", "right", "long"])
        gitOk(twin, ["branch", "-f", ref, `origin/${ref}`]);
      gitOk(twin, ["merge", "--no-commit", "--no-ff", "--log", ...heads]);
      const expected = readFileSync(join(twin, ".git/MERGE_MSG"), "utf8");
      gitOk(twin, ["merge", "--abort"]);
      const command = (await ours(twin)).fmtMergeMsg().setLog(true).setCreditPeople(false);
      for (const head of heads) command.addHead(head);
      expect(await command.call()).toBe(expected);
    }
  });
});
