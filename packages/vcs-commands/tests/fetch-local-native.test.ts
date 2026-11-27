/**
 * `git fetch` from a repository named by a path or a `file://` URL, against native git:
 * git's local transport runs `git-upload-pack '<path>'`; ours opens the repository through
 * the working copy's FilesApi and serves upload-pack in process. The refs, FETCH_HEAD and
 * the display lines are compared; a path that holds no repository, and a URL no transport
 * here can reach, fail in git's words.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git, GitApiError } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

/** Our working copy over `<root>/<name>`, its FilesApi rooted at `root` (the source beside it). */
async function ours(name: string): Promise<Git> {
  return openOurs(root, createNodeGitHostEnvironment({ env: testEnv(root) }), undefined, name);
}

/** Two empty repositories, `n<k>` (native) and `o<k>` (ours). */
function twins(): [string, string] {
  const names: [string, string] = [`n${counter}`, `o${counter}`];
  counter++;
  for (const name of names) {
    mkdirSync(join(root, name));
    git(join(root, name), "init", "-q", "-b", "main");
  }
  return names;
}

/** git 2.48+ writes `refs/remotes/<name>/HEAD` on a fetch (followRemoteHEAD); ours does too */
const followsRemoteHead = (() => {
  if (!nativeGitAvailable()) return false;
  const m = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"]).toString());
  return !!m && (Number(m[1]) > 2 || Number(m[2]) >= 48);
})();

/** The refs; before git 2.48 without the remote HEAD ours writes as 2.48+ does */
const refs = (dir: string) =>
  git(join(root, dir), "for-each-ref", "--format=%(refname) %(objectname)")
    .split("\n")
    .filter((l) => followsRemoteHead || !l.startsWith("refs/remotes/origin/HEAD "))
    .join("\n");
const fetchHead = (dir: string) => readFileSync(join(root, dir, ".git/FETCH_HEAD"), "utf8");

/** The display lines git prints (stderr), without the progress lines. */
const displayOf = (stderr: string) =>
  stderr
    .split("\n")
    .filter((l) => l !== "" && !/^(remote: |Unpacking|Receiving|Resolving)/.test(l));

describeGit("fetch from a local repository: as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fetch-local-"));
    const src = join(root, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    putFile(src, "a.txt", "a\n");
    git(src, "add", "a.txt");
    git(src, "commit", "-qm", "one");
    git(src, "tag", "-a", "-m", "v1", "v1");
    git(src, "checkout", "-q", "-b", "feat");
    putFile(src, "b.txt", "b\n");
    git(src, "add", "b.txt");
    git(src, "commit", "-qm", "two");
    git(src, "checkout", "-q", "main");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  for (const how of ["path", "file://"] as const) {
    it(`fetch origin (remote.origin.url a ${how}), then again after a new commit`, async () => {
      const [n, o] = twins();
      const url = how === "path" ? "../src" : `file://${join(root, "src")}`;
      for (const d of [n, o]) git(join(root, d), "remote", "add", "origin", url);
      const native = gitRun(root, join(root, n), ["fetch", "origin"]);
      expect(native.status).toBe(0);
      const result = await (await ours(o)).fetch().setRemote("origin").call();
      expect(refs(o)).toBe(refs(n));
      expect(fetchHead(o)).toBe(fetchHead(n));
      expect(result.display).toEqual(displayOf(native.stderr));

      // incremental: only the new commit comes
      const src = join(root, "src");
      putFile(src, `c${counter}.txt`, "c\n");
      git(src, "add", ".");
      git(src, "commit", "-qm", `three ${counter}`);
      const again = gitRun(root, join(root, n), ["fetch", "origin"]);
      const second = await (await ours(o)).fetch().setRemote("origin").call();
      expect(refs(o)).toBe(refs(n));
      expect(fetchHead(o)).toBe(fetchHead(n));
      expect(second.display).toEqual(displayOf(again.stderr));
      expect(git(join(root, o), "fsck", "--no-progress", "--connectivity-only")).toBe("");
    });
  }

  it("fetch <path> <refspec> without a configured remote", async () => {
    const [n, o] = twins();
    const native = gitRun(root, join(root, n), ["fetch", "../src", "feat:refs/heads/f"]);
    expect(native.status).toBe(0);
    const result = await (await ours(o))
      .fetch()
      .setRemote("../src")
      .setRefSpecs("feat:refs/heads/f")
      .call();
    expect(refs(o)).toBe(refs(n));
    expect(fetchHead(o)).toBe(fetchHead(n));
    expect(result.display).toEqual(displayOf(native.stderr));
  });

  for (const url of ["../nope", "/nonexistent/x", "file:///nonexistent/x", "file://../nope"]) {
    it(`a path holding no repository (${url}) fails in git's words`, async () => {
      const [n, o] = twins();
      const native = gitRun(root, join(root, n), ["fetch", url]);
      let error: GitApiError | undefined;
      try {
        await (await ours(o)).fetch().setRemote(url).call();
      } catch (e) {
        error = e as GitApiError;
      }
      expect(error?.message).toBe(native.stderr.trim());
      expect(error?.exitCode).toBe(native.status);
      expect(refs(o)).toBe(refs(n));
    });
  }

  it("a URL no transport here reaches fails as git without a remote helper", async () => {
    const [, o] = twins();
    for (const [url, helper] of [
      ["foo://x/y", "foo"],
      ["foo::bar", "foo"],
    ]) {
      let error: GitApiError | undefined;
      try {
        await (await ours(o))
          .fetch()
          .setRemote(url as string)
          .call();
      } catch (e) {
        error = e as GitApiError;
      }
      expect(error?.message).toBe(`fatal: unable to find remote helper for '${helper}'`);
      expect(error?.exitCode).toBe(128);
    }
  });

  for (const how of ["path", "file://"] as const) {
    it(`ls-remote of a ${how}`, async () => {
      const [n, o] = twins();
      const url = how === "path" ? "../src" : `file://${join(root, "src")}`;
      const native = git(join(root, n), "ls-remote", url)
        .split("\n")
        .filter((l) => l && !l.endsWith("^{}") && !l.endsWith("\tHEAD"))
        .map((l) => l.split("\t").reverse().join(" "));
      const result = await (await ours(o)).lsRemote().setRemote(url).call();
      expect(result.refs.map((r) => `${r.name} ${r.objectId}`)).toEqual(native);
      expect(result.defaultBranch).toBe("main");
    });
  }

  it("ls-remote of a path holding no repository fails in git's words", async () => {
    const [n, o] = twins();
    const native = gitRun(root, join(root, n), ["ls-remote", "../nope"]);
    let error: GitApiError | undefined;
    try {
      await (await ours(o)).lsRemote().setRemote("../nope").call();
    } catch (e) {
      error = e as GitApiError;
    }
    expect(error?.message).toBe(native.stderr.trim());
    expect(error?.exitCode).toBe(native.status);
  });

  it("push to a bare repository by path, and to a checked-out branch (refused)", async () => {
    const [n, o] = twins();
    for (const d of [n, o]) {
      const dir = join(root, d);
      git(dir, "fetch", "-q", "../src", "main");
      git(dir, "reset", "-q", "--hard", "FETCH_HEAD");
      putFile(dir, "p.txt", "p\n");
      git(dir, "add", "p.txt");
      git(dir, "commit", "-qm", "pushed");
      git(root, "init", "-q", "--bare", `${d}-dst.git`);
    }
    const native = gitRun(root, join(root, n), ["push", `../${n}-dst.git`, "main", "main:other"]);
    expect(native.status).toBe(0);
    const result = await (await ours(o))
      .push()
      .setRemote(`../${o}-dst.git`)
      .setRefSpecs("main", "main:other")
      .call();
    expect(result.remoteUpdates.map((u) => u.status)).toEqual(["ok", "ok"]);
    expect(refs(`${o}-dst.git`)).toBe(refs(`${n}-dst.git`));
    expect(git(join(root, `${o}-dst.git`), "fsck", "--no-progress")).toBe("");

    // a non-bare repository's checked-out branch: receive.denyCurrentBranch refuses it
    for (const d of [n, o]) git(root, "clone", "-q", "src", `${d}-wt`);
    const refused = gitRun(root, join(root, n), ["push", `../${n}-wt`, "main:main"]);
    expect(refused.status).toBe(1);
    const ourRefused = await (await ours(o))
      .push()
      .setRemote(`../${o}-wt`)
      .setRefSpecs("main:main")
      .call();
    expect(ourRefused.remoteUpdates.map((u) => u.status)).toEqual(["rejected-other"]);
    expect(refs(`${o}-wt`)).toBe(refs(`${n}-wt`));
  });

  it("clone of a path and of a file:// URL", async () => {
    for (const url of [join(root, "src"), `file://${join(root, "src")}`]) {
      const n = `nclone${counter}`;
      const o = `oclone${counter}`;
      counter++;
      git(root, "clone", "-q", "--no-local", url, n);
      mkdirSync(join(root, o));
      git(join(root, o), "init", "-q", "-b", "main");
      await (await ours(o)).clone().setURI(url).call();
      expect(refs(o)).toBe(refs(n));
      for (const args of [
        ["config", "--get-regexp", "^(remote|branch)\\."],
        ["symbolic-ref", "HEAD"],
        ["ls-files", "-s"],
        ["status", "--porcelain"],
      ]) {
        expect(git(join(root, o), ...args), args.join(" ")).toBe(git(join(root, n), ...args));
      }
    }
  });

  for (const url of ["/nonexistent/x", "file:///nonexistent/x"]) {
    it(`clone of ${url} (no repository) fails in git's words`, async () => {
      const o = `onone${counter++}`;
      mkdirSync(join(root, o));
      git(join(root, o), "init", "-q", "-b", "main");
      const native = gitRun(root, root, ["clone", "--no-local", url, `n${o}`]);
      let error: GitApiError | undefined;
      try {
        await (await ours(o)).clone().setURI(url).call();
      } catch (e) {
        error = e as GitApiError;
      }
      // the file:// clone prints "Cloning into '<dir>'..." first
      const lines = native.stderr.trim().split("\n");
      expect(lines.filter((l) => !l.startsWith("Cloning into")).join("\n")).toBe(error?.message);
      expect(error?.exitCode).toBe(native.status);
      expect(refs(o)).toBe("");
    });
  }

  // statewalker/webrun-vcs#280: an empty remote (or one whose HEAD is unborn) is not special
  // to git's get_fetch_map: an exact source it lacks dies, only wildcards and the configured
  // refspecs (missing_ok) go through
  describe("a remote with an unborn HEAD", () => {
    /** `empty` (no refs) and `unborn` (refs, HEAD at a missing branch), each beside `src` */
    beforeAll(() => {
      git(root, "init", "-q", "--bare", "-b", "main", "empty");
      git(root, "clone", "-q", "--bare", "src", "unborn");
      git(join(root, "unborn"), "symbolic-ref", "HEAD", "refs/heads/trunk");
    });

    /** `git fetch <args>` in a new pair, `configure` run in each first: status, stderr, refs */
    async function expectFetch(
      args: string[],
      configure: (dir: string) => void = () => {},
    ): Promise<void> {
      const [n, o] = twins();
      configure(join(root, n));
      configure(join(root, o));
      const native = gitRun(root, join(root, n), ["fetch", ...args]);
      let error: GitApiError | undefined;
      try {
        await (await ours(o))
          .fetch()
          .setRemote(args[0] as string)
          .setRefSpecs(...args.slice(1))
          .call();
      } catch (e) {
        error = e as GitApiError;
      }
      if (native.status === 0) {
        expect(error, native.stderr).toBeUndefined();
      } else {
        expect(error?.message).toBe(native.stderr.trim());
        expect(error?.exitCode).toBe(native.status);
      }
      expect(refs(o)).toBe(refs(n));
    }

    for (const remote of ["empty", "unborn"]) {
      for (const url of [`../${remote}`, `file://${remote}`]) {
        it(`fetch ${url} dies: couldn't find remote ref HEAD`, async () => {
          await expectFetch([url.startsWith("file://") ? `file://${join(root, remote)}` : url]);
        });
        it(`fetch ${url} HEAD dies too`, async () => {
          const u = url.startsWith("file://") ? `file://${join(root, remote)}` : url;
          await expectFetch([u, "HEAD"]);
        });
      }
    }

    for (const spec of ["main", "refs/heads/main", "main:refs/heads/x"]) {
      it(`fetch ../empty ${spec} dies: the source names no remote ref`, async () => {
        await expectFetch(["../empty", spec]);
      });
    }

    it("fetch ../empty with a wildcard refspec succeeds", async () => {
      await expectFetch(["../empty", "refs/heads/*:refs/remotes/e/*"]);
    });

    it("fetch ../unborn <branch> fetches the branch", async () => {
      await expectFetch(["../unborn", "feat:refs/heads/f"]);
    });

    for (const remote of ["empty", "unborn"]) {
      it(`a configured remote at ${remote}: fetch succeeds, fetch <remote> HEAD dies`, async () => {
        const configure = (dir: string) => git(dir, "remote", "add", "origin", `../${remote}`);
        await expectFetch(["origin"], configure);
        await expectFetch(["origin", "HEAD"], configure);
      });
    }

    for (const single of [false, true]) {
      it(`clone --single-branch=${single} of a repository whose HEAD is unborn`, async () => {
        const n = `nclone${counter}`;
        const o = `oclone${counter}`;
        counter++;
        const args = single ? ["--single-branch"] : ["--no-single-branch"];
        const native = gitRun(root, root, ["clone", "-q", ...args, "unborn", n]);
        expect(native.status, native.stderr).toBe(0);
        mkdirSync(join(root, o));
        git(join(root, o), "init", "-q", "-b", "main");
        await (await ours(o)).clone().setURI(join(root, "unborn")).setSingleBranch(single).call();
        const config = ["config", "--get-regexp", "^(remote|branch)\\."];
        expect(git(join(root, o), ...config).replaceAll(o, "<d>")).toBe(
          git(join(root, n), ...config).replaceAll(n, "<d>"),
        );
        expect(refs(o)).toBe(refs(n));
        expect(git(join(root, o), "symbolic-ref", "HEAD")).toBe(
          git(join(root, n), "symbolic-ref", "HEAD"),
        );
      });
    }
  });

  it("the source repository is left untouched", () => {
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: join(root, "src") }).toString(),
    ).toBe("");
  });
});
