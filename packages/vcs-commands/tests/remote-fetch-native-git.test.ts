/**
 * `git fetch` and `git remote` behaviours against native git: the opportunistic
 * remote-tracking update of `git fetch origin main` (and `--refmap`), `followRemoteHEAD`,
 * `--prune`/`fetch.prune`/`--prune-tags`, `git remote set-head -a`, `git remote remove`
 * and `git remote rename`. Each runs the same operations on our repository (files
 * backend, the remote over `git http-backend`) and on a native clone (the remote by path),
 * and compares refs, config and messages.
 *
 * Version-aware: `followRemoteHEAD` (and fetch creating `refs/remotes/<name>/HEAD`) is git
 * 2.48+; on an older git the native side is not compared there, and ours is checked
 * against what 2.48+ does.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import {
  type NativeGitHttpBackend,
  nativeGitAvailable,
  nativeGitHttpBackend,
} from "./native-git-http-backend.js";
import {
  gitAtLeast,
  openFilesWorkingCopy,
  runGit,
  runGitResult,
} from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() ? describe : describe.skip;

/** How our side reaches the remote. */
const URL = "http://git.test/src.git";

describeGit("remote and fetch behaviours as native git", () => {
  let root: string;
  let src: string;
  let ours: string;
  let native: string;
  let backend: NativeGitHttpBackend;
  let version: string;
  const originalFetch = globalThis.fetch;
  const opened: WorkingCopy[] = [];

  const git = (cwd: string, ...args: string[]) => runGit(root, cwd, ...args);

  let counter = 0;
  /** Commits on `branch` of the bare remote (through a scratch clone). */
  function commitOnRemote(branch: string): string {
    const work = join(root, `work-${counter++}`);
    git(root, "clone", "-q", src, work);
    if (git(src, "for-each-ref", `refs/heads/${branch}`)) {
      git(work, "checkout", "-q", "-B", branch, `origin/${branch}`);
    } else {
      git(work, "checkout", "-q", "-b", branch);
    }
    writeFileSync(join(work, `f${counter}.txt`), `${branch} ${counter}\n`);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", `${branch} ${counter}`);
    git(work, "push", "-q", "origin", branch);
    rmSync(work, { recursive: true, force: true });
    return git(src, "rev-parse", `refs/heads/${branch}`);
  }

  async function open(dir = ours) {
    const opened1 = await openFilesWorkingCopy(dir);
    opened.push(opened1.workingCopy);
    return opened1;
  }

  /** Both sides cloned from the remote. */
  async function cloneBoth(): Promise<{ workingCopy: WorkingCopy }> {
    const { git: ourGit, workingCopy } = await open();
    await ourGit.clone().setURI(URL).call();
    git(root, "clone", "-q", src, native);
    return { workingCopy };
  }

  /** Both sides `git init` with `origin` added, not yet fetched. */
  async function initBoth(): Promise<{ workingCopy: WorkingCopy }> {
    const { git: ourGit, workingCopy } = await open();
    await ourGit.remoteAdd().setName("origin").setUri(URL).call();
    git(root, "init", "-q", "--initial-branch=main", native);
    git(native, "remote", "add", "origin", src);
    return { workingCopy };
  }

  /** `git for-each-ref` of `prefix`: name, value, symref target. */
  const refs = (repo: string, prefix = "refs/") =>
    git(repo, "for-each-ref", "--format=%(refname) %(objectname) %(symref)", prefix);

  const symref = (repo: string, name: string) => {
    const r = runGitResult(root, repo, "symbolic-ref", name);
    return r.status === 0 ? r.stdout.trim() : "<none>";
  };

  /** The `remote.*` and `branch.*` lines of the local config, in file order, URL normalised. */
  const remoteConfig = (repo: string, url: string) =>
    git(repo, "config", "--list", "--local")
      .split("\n")
      .filter((line) => /^(remote|branch)\./.test(line))
      .map((line) => line.replace(url, "<url>"));

  const config = (repo: string, key: string) => {
    const r = runGitResult(root, repo, "config", key);
    return r.status === 0 ? r.stdout.trim() : "<unset>";
  };

  const followsHead = () => gitAtLeast(version, 2, 48);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vcs-remote-parity-"));
    src = join(root, "src.git");
    ours = join(root, "ours");
    native = join(root, "native");
    git(root, "init", "-q", "--bare", "--initial-branch=main", src);
    commitOnRemote("main");
    commitOnRemote("feature");
    git(src, "tag", "v0", "main");
    backend = nativeGitHttpBackend(root, root);
    globalThis.fetch = backend.fetch;
    version = git(root, "--version");
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const wc of opened.splice(0)) await wc.close().catch(() => {});
    backend?.close();
    rmSync(root, { recursive: true, force: true });
  });

  describe("opportunistic remote-tracking update", () => {
    it("`fetch origin main` also moves refs/remotes/origin/main; FETCH_HEAD as native", async () => {
      const { workingCopy } = await cloneBoth();
      const tip = commitOnRemote("main");
      commitOnRemote("feature");

      await Git.fromWorkingCopy(workingCopy).fetch().setRefSpecs("main").call();
      git(native, "fetch", "-q", "origin", "main");

      expect(git(ours, "rev-parse", "refs/remotes/origin/main")).toBe(tip);
      expect(refs(ours, "refs/remotes")).toBe(refs(native, "refs/remotes"));
      const fetchHead = (repo: string) =>
        readFileSync(join(repo, ".git/FETCH_HEAD"), "utf8").replaceAll(
          /\S+src(\.git)?\n/g,
          "<url>\n",
        );
      expect(fetchHead(ours)).toBe(fetchHead(native));
    });

    it("an explicit destination and the configured mapping are both written", async () => {
      const { workingCopy } = await cloneBoth();
      commitOnRemote("feature");

      await Git.fromWorkingCopy(workingCopy).fetch().setRefSpecs("feature:refs/heads/copy").call();
      git(native, "fetch", "-q", "origin", "feature:refs/heads/copy");

      expect(refs(ours, "refs/remotes")).toBe(refs(native, "refs/remotes"));
      expect(git(ours, "rev-parse", "refs/heads/copy")).toBe(
        git(native, "rev-parse", "refs/heads/copy"),
      );
    });

    it("--refmap replaces the configured mapping; an empty one turns the update off", async () => {
      const { workingCopy } = await cloneBoth();
      commitOnRemote("main");
      commitOnRemote("feature");

      await Git.fromWorkingCopy(workingCopy).fetch().setRefSpecs("main").setRefmap().call();
      git(native, "fetch", "-q", "--refmap=", "origin", "main");
      expect(refs(ours, "refs/remotes")).toBe(refs(native, "refs/remotes"));

      await Git.fromWorkingCopy(workingCopy)
        .fetch()
        .setRefSpecs("feature")
        .setRefmap("+refs/heads/*:refs/remotes/mirror/*")
        .call();
      git(
        native,
        "fetch",
        "-q",
        "--refmap=+refs/heads/*:refs/remotes/mirror/*",
        "origin",
        "feature",
      );
      expect(refs(ours, "refs/remotes")).toBe(refs(native, "refs/remotes"));
      expect(refs(ours, "refs/remotes/mirror")).not.toBe("");

      // --refmap without command-line refspecs is refused, as native git does
      const nativeRefused = runGitResult(root, native, "fetch", "-q", "--refmap=x", "origin");
      expect(nativeRefused.stderr).toContain(
        "--refmap option is only meaningful with command-line refspec(s)",
      );
      await expect(Git.fromWorkingCopy(workingCopy).fetch().setRefmap("x").call()).rejects.toThrow(
        "--refmap option is only meaningful with command-line refspec(s)",
      );
    });
  });

  describe("followRemoteHEAD", () => {
    it("a configured fetch creates refs/remotes/origin/HEAD; create does not move it, always does", async () => {
      const { workingCopy } = await initBoth();
      const fetchBoth = async (follow?: string) => {
        const ourGit = Git.fromWorkingCopy(workingCopy);
        const cfg = workingCopy.config as unknown as { set(k: string, v: string): void };
        if (follow) cfg.set("remote.origin.followRemoteHEAD", follow);
        await ourGit.fetch().call();
        const args = follow ? ["-c", `remote.origin.followRemoteHEAD=${follow}`] : [];
        git(native, ...args, "fetch", "-q", "origin");
      };

      await fetchBoth();
      expect(symref(ours, "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
      if (followsHead()) {
        expect(symref(ours, "refs/remotes/origin/HEAD")).toBe(
          symref(native, "refs/remotes/origin/HEAD"),
        );
      }

      // the remote's HEAD moves: create keeps ours, always follows it
      git(src, "symbolic-ref", "HEAD", "refs/heads/feature");
      await fetchBoth("create");
      expect(symref(ours, "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
      await fetchBoth("always");
      expect(symref(ours, "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/feature");
      if (followsHead()) {
        expect(symref(ours, "refs/remotes/origin/HEAD")).toBe(
          symref(native, "refs/remotes/origin/HEAD"),
        );
      }
    });

    it("never creates nothing; explicit refspecs do not touch it", async () => {
      const { workingCopy } = await initBoth();
      const cfg = workingCopy.config as unknown as { set(k: string, v: string): void };
      await Git.fromWorkingCopy(workingCopy).fetch().setRefSpecs("main").call();
      git(native, "fetch", "-q", "origin", "main");
      expect(symref(ours, "refs/remotes/origin/HEAD")).toBe("<none>");
      expect(symref(native, "refs/remotes/origin/HEAD")).toBe("<none>");

      cfg.set("remote.origin.followRemoteHEAD", "never");
      git(native, "config", "remote.origin.followRemoteHEAD", "never");
      await Git.fromWorkingCopy(workingCopy).fetch().call();
      git(native, "fetch", "-q", "origin");
      expect(symref(ours, "refs/remotes/origin/HEAD")).toBe("<none>");
      expect(symref(native, "refs/remotes/origin/HEAD")).toBe("<none>");

      // fetch.followRemoteHEAD is the fallback, the remote's own setting wins
      cfg.set("fetch.followRemoteHEAD", "create");
      git(native, "config", "fetch.followRemoteHEAD", "create");
      await Git.fromWorkingCopy(workingCopy).fetch().call();
      git(native, "fetch", "-q", "origin");
      expect(symref(ours, "refs/remotes/origin/HEAD")).toBe("<none>");
      expect(symref(native, "refs/remotes/origin/HEAD")).toBe("<none>");

      // without the remote's own setting, fetch.followRemoteHEAD=create applies
      (workingCopy.config as unknown as { unset(k: string): void }).unset(
        "remote.origin.followRemoteHEAD",
      );
      git(native, "config", "--unset", "remote.origin.followRemoteHEAD");
      await Git.fromWorkingCopy(workingCopy).fetch().call();
      git(native, "fetch", "-q", "origin");
      expect(symref(ours, "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
      if (followsHead()) {
        expect(symref(native, "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
      }
    });

    it("warn reports a local HEAD that differs, in native git's words", async () => {
      const { workingCopy } = await initBoth();
      await Git.fromWorkingCopy(workingCopy).fetch().call();
      git(native, "fetch", "-q", "origin");
      git(src, "symbolic-ref", "HEAD", "refs/heads/feature");
      const cfg = workingCopy.config as unknown as { set(k: string, v: string): void };

      cfg.set("remote.origin.followRemoteHEAD", "warn");
      const result = await Git.fromWorkingCopy(workingCopy).fetch().call();
      const expected = "'HEAD' at 'origin' is 'feature', but we have 'main' locally.";
      expect(result.messages[0]).toBe(expected);
      expect(result.messages[1]).toBe(
        "hint: Run 'git remote set-head origin feature' to follow the change, or modify",
      );
      expect(symref(ours, "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
      if (followsHead()) {
        git(native, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
        const run = runGitResult(
          root,
          native,
          "-c",
          "remote.origin.followRemoteHEAD=warn",
          "fetch",
          "origin",
        );
        const warnings = result.messages.filter((m) => !m.startsWith("hint:"));
        expect(warnings.join("\n")).toBe(run.stdout.trim());
        // the advice text is git 2.56's (older versions word it differently)
        if (gitAtLeast(version, 2, 56)) {
          const hints = run.stderr.split("\n").filter((line) => line.startsWith("hint:"));
          expect(result.messages.filter((m) => m.startsWith("hint:"))).toEqual(hints);
        }

        // advice.fetchRemoteHEADWarn=false keeps the warning, drops the hint
        cfg.set("advice.fetchRemoteHEADWarn", "false");
        const plain = await Git.fromWorkingCopy(workingCopy).fetch().call();
        expect(plain.messages).toEqual([expected]);

        // warn-if-not-<branch>: silent while the remote HEAD is that branch
        cfg.set("remote.origin.followRemoteHEAD", "warn-if-not-feature");
        const quiet = await Git.fromWorkingCopy(workingCopy).fetch().call();
        const nativeQuiet = runGitResult(
          root,
          native,
          "-c",
          "remote.origin.followRemoteHEAD=warn-if-not-feature",
          "fetch",
          "origin",
        ).stdout.trim();
        expect(quiet.messages.join("\n")).toBe(nativeQuiet);
        expect(quiet.messages).toEqual([]);
      }
    });
  });

  it("fetch.followRemoteHEAD=never applies when the remote has no setting (git 2.56)", async () => {
    const { workingCopy } = await initBoth();
    (workingCopy.config as unknown as { set(k: string, v: string): void }).set(
      "fetch.followRemoteHEAD",
      "never",
    );
    git(native, "config", "fetch.followRemoteHEAD", "never");
    await Git.fromWorkingCopy(workingCopy).fetch().call();
    git(native, "fetch", "-q", "origin");
    expect(symref(ours, "refs/remotes/origin/HEAD")).toBe("<none>");
    if (gitAtLeast(version, 2, 56)) {
      expect(symref(native, "refs/remotes/origin/HEAD")).toBe("<none>");
    }
    // and the tracking refs are there: the fetch itself ran
    expect(refs(ours, "refs/remotes/origin/main")).not.toBe("");
  });

  describe("prune", () => {
    it("a prune names the symbolic refs it leaves dangling, as git 2.56", async () => {
      const { workingCopy } = await cloneBoth();
      git(src, "symbolic-ref", "HEAD", "refs/heads/feature");
      git(src, "branch", "-D", "main");
      const result = await Git.fromWorkingCopy(workingCopy)
        .fetch()
        .setRemoveDeletedRefs(true)
        .call();
      const line =
        "   refs/remotes/origin/HEAD has become dangling after refs/remotes/origin/main was deleted";
      expect(result.messages).toContain(line);
      if (gitAtLeast(version, 2, 56)) {
        const run = runGitResult(root, native, "fetch", "--prune", "origin");
        expect(run.stderr.split("\n")).toContain(line);
      }
    });

    it("--prune deletes stale tracking refs before fetching, so foo can become foo/bar", async () => {
      const { workingCopy } = await cloneBoth();
      git(src, "branch", "foo", "main");
      await Git.fromWorkingCopy(workingCopy).fetch().call();
      git(native, "fetch", "-q", "origin");
      git(src, "branch", "-D", "foo");
      git(src, "branch", "foo/bar", "main");
      git(src, "branch", "-D", "feature");

      const result = await Git.fromWorkingCopy(workingCopy)
        .fetch()
        .setRemoveDeletedRefs(true)
        .call();
      git(native, "fetch", "-q", "--prune", "origin");

      expect(refs(ours, "refs/remotes")).toBe(refs(native, "refs/remotes"));
      expect(git(ours, "rev-parse", "refs/remotes/origin/foo/bar")).toBe(
        git(src, "rev-parse", "main"),
      );
      expect(
        result.trackingRefUpdates.filter((u) => u.newObjectId === "").map((u) => u.localRef),
      ).toEqual(["refs/remotes/origin/feature", "refs/remotes/origin/foo"]);
    });

    it("fetch.prune and remote.<name>.prune decide when the fetch does not say", async () => {
      const { workingCopy } = await cloneBoth();
      const cfg = workingCopy.config as unknown as { set(k: string, v: unknown): void };
      git(src, "branch", "-D", "feature");

      // remote.origin.prune=false wins over fetch.prune=true
      cfg.set("fetch.prune", "true");
      cfg.set("remote.origin.prune", "false");
      git(native, "config", "fetch.prune", "true");
      git(native, "config", "remote.origin.prune", "false");
      await Git.fromWorkingCopy(workingCopy).fetch().call();
      git(native, "fetch", "-q");
      expect(refs(ours, "refs/remotes")).toBe(refs(native, "refs/remotes"));
      expect(refs(ours, "refs/remotes/origin/feature")).not.toBe("");

      cfg.set("remote.origin.prune", "true");
      git(native, "config", "remote.origin.prune", "true");
      await Git.fromWorkingCopy(workingCopy).fetch().call();
      git(native, "fetch", "-q");
      expect(refs(ours, "refs/remotes")).toBe(refs(native, "refs/remotes"));
      expect(refs(ours, "refs/remotes/origin/feature")).toBe("");
    });

    it("--prune-tags deletes local tags the remote no longer has", async () => {
      const { workingCopy } = await cloneBoth();
      git(src, "tag", "v1", "feature");
      await Git.fromWorkingCopy(workingCopy).fetch().call();
      git(native, "fetch", "-q");
      git(src, "tag", "-d", "v0");
      expect(refs(ours, "refs/tags")).toBe(refs(native, "refs/tags"));

      // without --prune, --prune-tags only fetches every tag
      await Git.fromWorkingCopy(workingCopy).fetch().setPruneTags(true).call();
      git(native, "fetch", "-q", "--prune-tags");
      expect(refs(ours, "refs/tags")).toBe(refs(native, "refs/tags"));
      expect(refs(ours, "refs/tags/v0")).not.toBe("");

      await Git.fromWorkingCopy(workingCopy)
        .fetch()
        .setRemoveDeletedRefs(true)
        .setPruneTags(true)
        .call();
      git(native, "fetch", "-q", "--prune", "--prune-tags");
      expect(refs(ours, "refs/tags")).toBe(refs(native, "refs/tags"));
      expect(refs(ours, "refs/tags/v0")).toBe("");
    });
  });

  describe("remote set-head -a", () => {
    it("sets refs/remotes/origin/HEAD to the remote's HEAD branch", async () => {
      const { workingCopy } = await cloneBoth();
      git(src, "symbolic-ref", "HEAD", "refs/heads/feature");
      const setHead = Git.fromWorkingCopy(workingCopy)
        .remoteSetHead()
        .setRemoteName("origin")
        .setAuto(true);
      const target = await setHead.call();
      const nativeOut = runGitResult(root, native, "remote", "set-head", "origin", "-a");
      expect(target).toBe("refs/remotes/origin/feature");
      expect(setHead.getMessages()).toEqual([
        "'origin/HEAD' has changed from 'main' and now points to 'feature'",
      ]);
      if (gitAtLeast(version, 2, 56)) {
        expect(setHead.getMessages().join("\n")).toBe(nativeOut.stdout.trim());
      }
      expect(symref(ours, "refs/remotes/origin/HEAD")).toBe(
        symref(native, "refs/remotes/origin/HEAD"),
      );
    });

    it("errors as native git: no branch, several branches, a missing tracking ref", async () => {
      const { workingCopy } = await cloneBoth();
      const setAuto = () =>
        Git.fromWorkingCopy(workingCopy).remoteSetHead().setRemoteName("origin").setAuto(true);
      const nativeError = () =>
        runGitResult(root, native, "remote", "set-head", "origin", "-a")
          .stderr.trim()
          .replace(/^error: /, "");

      // a detached remote HEAD at a commit two branches share
      commitOnRemote("main");
      await Git.fromWorkingCopy(workingCopy).fetch().call();
      git(native, "fetch", "-q");
      git(src, "branch", "-f", "feature", "main");
      git(src, "update-ref", "--no-deref", "HEAD", git(src, "rev-parse", "main"));
      const several = nativeError();
      expect(several).toContain("Multiple remote HEAD branches");
      await expect(setAuto().call()).rejects.toThrow(several);

      // at a commit no branch has
      git(src, "update-ref", "--no-deref", "HEAD", git(src, "rev-parse", "main~1"));
      const none = nativeError();
      expect(none).toBe("Cannot determine remote HEAD");
      await expect(setAuto().call()).rejects.toThrow(none);

      // a branch the remote has, but this side has no tracking ref for
      git(src, "branch", "other", "main~1");
      git(src, "symbolic-ref", "HEAD", "refs/heads/other");
      const invalid = nativeError();
      expect(invalid).toBe("Not a valid ref: refs/remotes/origin/other");
      await expect(setAuto().call()).rejects.toThrow(invalid);
    });

    it("turns followRemoteHEAD=always into warn (git 2.48+)", async () => {
      const { workingCopy } = await cloneBoth();
      const cfg = workingCopy.config as unknown as { set(k: string, v: string): void };
      cfg.set("remote.origin.followRemoteHEAD", "always");
      await (workingCopy.config as unknown as { save(): Promise<void> }).save();
      git(native, "config", "remote.origin.followRemoteHEAD", "always");
      await Git.fromWorkingCopy(workingCopy)
        .remoteSetHead()
        .setRemoteName("origin")
        .setBranch("feature")
        .call();
      git(native, "remote", "set-head", "origin", "feature");
      expect(config(ours, "remote.origin.followRemoteHEAD")).toBe("warn");
      if (followsHead()) {
        expect(config(native, "remote.origin.followRemoteHEAD")).toBe("warn");
      }
    });
  });

  /** A second remote, a branch tracking origin and pushing to it, remote.pushDefault. */
  async function moreConfig(workingCopy: WorkingCopy) {
    const set = (key: string, ourValue: string, nativeValue = ourValue) => {
      (workingCopy.config as unknown as { set(k: string, v: string): void }).set(key, ourValue);
      git(native, "config", key, nativeValue);
    };
    set("remote.other.url", URL, src);
    set("remote.other.fetch", "+refs/heads/feature:refs/remotes/origin/feature");
    set("branch.topic.remote", "origin");
    set("branch.topic.merge", "refs/heads/feature");
    set("branch.topic.pushRemote", "origin");
    set("branch.side.pushRemote", "other");
    set("remote.pushDefault", "origin");
    await (workingCopy.config as unknown as { save(): Promise<void> }).save();
  }

  describe("remote remove", () => {
    it("removes the section, the refs it maps (not another remote's), the upstream config", async () => {
      const { workingCopy } = await cloneBoth();
      await moreConfig(workingCopy);

      const removed = await Git.fromWorkingCopy(workingCopy)
        .remoteRemove()
        .setRemoteName("origin")
        .call();
      git(native, "remote", "remove", "origin");

      expect(removed?.name).toBe("origin");
      expect(remoteConfig(ours, URL)).toEqual(remoteConfig(native, src));
      expect(config(ours, "remote.pushDefault")).toBe(config(native, "remote.pushDefault"));
      expect(refs(ours)).toBe(refs(native));
      // refs/remotes/origin/feature stays: remote "other" maps it too
      expect(refs(ours, "refs/remotes/origin/feature")).not.toBe("");
      const logs = (repo: string) => {
        try {
          return readdirSync(join(repo, ".git/logs/refs/remotes/origin")).sort();
        } catch {
          return [];
        }
      };
      // the removed refs lose their reflogs (native clone logs none of the others)
      expect(logs(ours).filter((name) => name !== "feature")).toEqual(logs(native));
    });
  });

  it("remove refuses a remote without config and notes kept local branches, as git", async () => {
    const { workingCopy } = await cloneBoth();
    const remove = (name: string) =>
      Git.fromWorkingCopy(workingCopy).remoteRemove().setRemoteName(name);
    const nativeError = (name: string) =>
      runGitResult(root, native, "remote", "remove", name)
        .stderr.trim()
        .replace(/^error: /, "");

    // tracking refs alone do not make a remote
    git(native, "update-ref", "refs/remotes/ghost/main", git(src, "rev-parse", "main"));
    await workingCopy.history.refs.set("refs/remotes/ghost/main", git(src, "rev-parse", "main"));
    const ghost = nativeError("ghost");
    expect(ghost).toBe("No such remote: 'ghost'");
    await expect(remove("ghost").call()).rejects.toThrow(ghost);
    expect(refs(ours, "refs/remotes/ghost")).not.toBe("");

    // a refspec mapping to local branches: they stay, with git's note
    const cfg = workingCopy.config as unknown as {
      add(k: string, v: string): void;
      save(): Promise<void>;
    };
    cfg.add("remote.origin.fetch", "refs/heads/*:refs/heads/*");
    await cfg.save();
    git(native, "config", "--add", "remote.origin.fetch", "refs/heads/*:refs/heads/*");
    const command = remove("origin");
    await command.call();
    const run = runGitResult(root, native, "remote", "remove", "origin");
    expect(command.getMessages().join("\n")).toBe(run.stderr.trim());
    expect(command.getMessages()[0]).toContain("Note: A branch outside the refs/remotes/");
    expect(refs(ours)).toBe(refs(native));
  });

  describe("remote rename", () => {
    it("renames the section, rewrites the refspec, moves refs with their reflogs", async () => {
      const { workingCopy } = await cloneBoth();
      await moreConfig(workingCopy);
      const cfg = workingCopy.config as unknown as { add(k: string, v: string): void };
      cfg.add("remote.origin.fetch", "+refs/tags/*:refs/tags/*");
      await (workingCopy.config as unknown as { save(): Promise<void> }).save();
      git(native, "config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*");

      // a fetch gives native refs/remotes/origin/main a reflog too (its clone logs none)
      commitOnRemote("main");
      await Git.fromWorkingCopy(workingCopy).fetch().call();
      git(native, "fetch", "-q", "origin");
      const before = git(
        ours,
        "reflog",
        "show",
        "--format=%H %gs",
        "refs/remotes/origin/main",
      ).split("\n");
      expect(before.length).toBeGreaterThan(0);
      const { warnings } = await Git.fromWorkingCopy(workingCopy)
        .remoteRename()
        .setOldName("origin")
        .setNewName("upstream")
        .call();
      const nativeRun = runGitResult(root, native, "remote", "rename", "origin", "upstream");

      expect(warnings.map((w) => `warning: ${w}`).join("\n")).toBe(nativeRun.stderr.trim());
      expect(remoteConfig(ours, URL)).toEqual(remoteConfig(native, src));
      expect(config(ours, "remote.pushDefault")).toBe(config(native, "remote.pushDefault"));
      expect(refs(ours)).toBe(refs(native));
      expect(symref(ours, "refs/remotes/upstream/HEAD")).toBe("refs/remotes/upstream/main");
      expect(symref(ours, "refs/remotes/upstream/HEAD")).toBe(
        symref(native, "refs/remotes/upstream/HEAD"),
      );
      // the reflog came along, with git's rename line on top (url and ident aside, the
      // earlier lines differ: a clone logs no remote-tracking ref natively)
      const reflog = (repo: string, name: string) =>
        git(repo, "reflog", "show", "--format=%H %gs", name).split("\n");
      const mine = reflog(ours, "refs/remotes/upstream/main");
      expect(mine[0]).toBe(reflog(native, "refs/remotes/upstream/main")[0]);
      expect(mine[0]).toContain(
        "remote: renamed refs/remotes/origin/main to refs/remotes/upstream/main",
      );
      expect(mine.slice(1)).toEqual(before);
    });

    it("refuses as native git: a missing remote, a taken name, an invalid name", async () => {
      const { workingCopy } = await cloneBoth();
      const rename = (from: string, to: string) =>
        Git.fromWorkingCopy(workingCopy).remoteRename().setOldName(from).setNewName(to).call();
      const nativeError = (from: string, to: string) =>
        runGitResult(root, native, "remote", "rename", from, to)
          .stderr.trim()
          .replace(/^(error|fatal): /, "");

      await expect(rename("nope", "x")).rejects.toThrow(nativeError("nope", "x"));
      await expect(rename("origin", "origin")).rejects.toThrow(nativeError("origin", "origin"));
      await expect(rename("origin", "a..b")).rejects.toThrow(nativeError("origin", "a..b"));
    });
  });
});
