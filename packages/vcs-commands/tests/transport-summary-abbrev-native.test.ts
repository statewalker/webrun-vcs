/**
 * The ref lines `git fetch` and `git push` print on stderr abbreviate ids as
 * find_unique_abbrev does under `core.abbrev` (longer where a local object shares the
 * prefix), and the summary column is `transport_summary_width` wide (twice the longest
 * abbreviation plus 3). Native twins: the same history fetched and pushed by native git and
 * by ours, an upstream commit crafted to share its first digits with a commit both already
 * have, then the stderr lines compared.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git, TagOption } from "../src/index.js";
import {
  type NativeGitHttpBackend,
  nativeGitAvailable,
  nativeGitEnv,
  nativeGitHttpBackend,
} from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";
const run = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(home),
    encoding: "latin1",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
/** The stderr of a git command that may fail (a refused push). */
const stderrOf = (cwd: string, args: string[]) =>
  spawnSync("git", args, { cwd, env: nativeGitEnv(home), encoding: "latin1" }).stderr;

async function open(dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const environment = createNodeGitHostEnvironment({ env: nativeGitEnv(home) });
  const { history } = await createGitFilesBackend({ files });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/**
 * A commit of `tree` on `parent` whose id starts with `prefix`: the message's counter is
 * raised until it does, then the commit is written into `repo`.
 */
function craftCommit(repo: string, tree: string, parent: string, prefix: string): string {
  const ident = "Interop Tester <interop@example.com> 1112911993 +0000";
  for (let n = 0; ; n++) {
    const body = `tree ${tree}\nparent ${parent}\nauthor ${ident}\ncommitter ${ident}\n\ncrafted ${n}\n`;
    const bytes = Buffer.from(body);
    const id = createHash("sha1")
      .update(Buffer.concat([Buffer.from(`commit ${bytes.length}\0`), bytes]))
      .digest("hex");
    if (!id.startsWith(prefix)) continue;
    const written = run(repo, ["hash-object", "-t", "commit", "-w", "--stdin"], body).trim();
    expect(written).toBe(id);
    return id;
  }
}

/** The ref lines of a stderr: the `From`/`To` line and those that start with a space. */
const refLines = (stderr: string) =>
  stderr
    .split("\n")
    .filter((l) => /^(From |To | |Everything up-to-date)/.test(l))
    .filter((l) => !l.startsWith(" (use") && l.trim() !== "");

describeGit("abbreviated ids in fetch and push summaries, native twins", () => {
  let backend: NativeGitHttpBackend;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "summary-abbrev-native-"));
    home = join(root, "home");
    mkdirSync(home);
    backend = nativeGitHttpBackend(root, home);
    globalThis.fetch = backend.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    backend?.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** `work` published as `src.git`, cloned as `native` and `ours` (ours fetching over HTTP). */
  function setup(abbrev: string | undefined) {
    const work = join(root, "work");
    const src = join(root, "src.git");
    run(root, ["init", "-q", "-b", "main", work]);
    run(work, ["commit", "-q", "--allow-empty", "-m", "base"]);
    run(work, ["commit", "-q", "--allow-empty", "-m", "second"]);
    run(work, ["branch", "dev"]);
    run(work, ["branch", "gone"]);
    run(root, ["clone", "-q", "--bare", work, src]);
    const native = join(root, "native");
    const ours = join(root, "ours");
    run(root, ["clone", "-q", src, native]);
    run(root, ["clone", "-q", src, ours]);
    run(ours, ["config", "remote.origin.url", "http://git.test/src.git"]);
    for (const dir of [native, ours]) {
      if (abbrev !== undefined) run(dir, ["config", "core.abbrev", abbrev]);
    }
    return { work, src, native, ours };
  }

  for (const [label, abbrev, prefixLength] of [
    ["core.abbrev=4, a commit sharing 5 digits", "4", 5],
    ["core.abbrev unset (auto), no collision", undefined, 0],
    ["core.abbrev=12", "12", 0],
  ] as const) {
    it(`fetch --prune: ${label}`, async () => {
      const { work, src, native, ours } = setup(abbrev);
      const base = run(work, ["rev-parse", "HEAD~1"]).trim();
      const tip = run(work, ["rev-parse", "HEAD"]).trim();
      const tree = run(work, ["rev-parse", "HEAD^{tree}"]).trim();
      // main moves to a commit that shares its first digits with `base` (both clones have it)
      const crafted = craftCommit(work, tree, tip, base.slice(0, prefixLength));
      run(work, ["update-ref", "refs/heads/main", crafted]);
      // dev is rewritten (a forced update), gone deleted (pruned), topic new
      const rewritten = run(work, ["commit-tree", "-p", base, "-m", "dev rewritten", tree]).trim();
      run(work, ["update-ref", "refs/heads/dev", rewritten]);
      run(work, ["branch", "-D", "gone"]);
      run(work, ["branch", "topic", base]);
      run(work, ["push", "-q", "--force", "--prune", src, "refs/heads/*:refs/heads/*"]);

      const nativeLines = refLines(stderrOf(native, ["fetch", "--prune", "origin"]));
      const result = await (await open(ours))
        .fetch()
        .setRemote("origin")
        .setRemoveDeletedRefs(true)
        .call();
      const oursLines = (result.display ?? []).map((l) =>
        l.replace("From http://git.test/src", `From ${src.replace(/\.git$/, "")}`),
      );
      expect(nativeLines.length).toBeGreaterThan(3);
      expect(oursLines).toEqual(nativeLines);
    });

    it(`push: ${label}`, async () => {
      const { work, native, ours } = setup(abbrev);
      // each pushes to a bare copy of its own; ours over HTTP
      const nativeDst = join(root, "native-dst.git");
      const oursDst = join(root, "ours-dst.git");
      run(root, ["clone", "-q", "--bare", work, nativeDst]);
      run(root, ["clone", "-q", "--bare", work, oursDst]);
      run(oursDst, ["config", "http.receivepack", "true"]);
      run(ours, ["remote", "add", "dst", "http://git.test/ours-dst.git"]);
      run(native, ["remote", "add", "dst", nativeDst]);
      const base = run(native, ["rev-parse", "HEAD~1"]).trim();
      const tip = run(native, ["rev-parse", "HEAD"]).trim();
      const tree = run(native, ["rev-parse", "HEAD^{tree}"]).trim();
      for (const dir of [native, ours]) {
        const crafted = craftCommit(dir, tree, tip, base.slice(0, prefixLength));
        run(dir, ["update-ref", "refs/heads/main", crafted]);
        const rewritten = run(dir, ["commit-tree", "-p", base, "-m", "dev rewritten", tree]).trim();
        run(dir, ["update-ref", "refs/heads/dev", rewritten]);
        run(dir, ["branch", "-f", "topic", base]);
        run(dir, ["branch", "-f", "gone", base]);
      }
      const specs = [
        "refs/heads/main:refs/heads/main",
        "+refs/heads/dev:refs/heads/dev",
        "refs/heads/topic:refs/heads/topic",
        // behind the remote's: refused (non-fast-forward)
        "refs/heads/gone:refs/heads/gone",
      ];
      const nativeLines = refLines(stderrOf(native, ["push", "dst", ...specs]));
      const result = await (await open(ours))
        .push()
        .setRemote("dst")
        .setRefSpecs(...specs)
        .call();
      const oursLines = (result.display ?? []).map((l) =>
        l.replace("To http://git.test/ours-dst.git", `To ${nativeDst}`),
      );
      expect(nativeLines.length).toBeGreaterThan(3);
      expect(oursLines).toEqual(nativeLines);
    });
  }
});

describeGit("fetch refusals: summary width and checked-out branches, native twins", () => {
  let backend: NativeGitHttpBackend;
  const originalFetch = globalThis.fetch;
  /** git 2.5x prints every line unpadded once a ref is refused; 2.43 pads them */
  const modern = /git version 2\.(5\d|[6-9]\d)/.test(run(process.cwd(), ["--version"]));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fetch-refusals-native-"));
    home = join(root, "home");
    mkdirSync(home);
    backend = nativeGitHttpBackend(root, home);
    globalThis.fetch = backend.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    backend?.close();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * `work` published as `src.git` and cloned as `native` and `ours` with a fetch refspec
   * that does not force; then main advances, dev is rewritten and tag v1 moves upstream.
   */
  function setup() {
    const work = join(root, "work");
    const src = join(root, "src.git");
    run(root, ["init", "-q", "-b", "main", work]);
    run(work, ["commit", "-q", "--allow-empty", "-m", "base"]);
    run(work, ["commit", "-q", "--allow-empty", "-m", "second"]);
    run(work, ["branch", "dev"]);
    run(work, ["tag", "v1", "HEAD~1"]);
    run(root, ["clone", "-q", "--bare", work, src]);
    const native = join(root, "native");
    const ours = join(root, "ours");
    run(root, ["clone", "-q", src, native]);
    run(root, ["clone", "-q", src, ours]);
    run(ours, ["config", "remote.origin.url", "http://git.test/src.git"]);
    for (const dir of [native, ours]) {
      run(dir, ["config", "remote.origin.fetch", "refs/heads/*:refs/remotes/origin/*"]);
    }
    run(work, ["commit", "-q", "--allow-empty", "-m", "third"]);
    run(work, ["branch", "-f", "dev", "HEAD~2"]);
    run(work, ["commit", "-q", "--allow-empty", "--amend", "-m", "third again"]);
    run(work, ["tag", "-f", "v1", "HEAD"]);
    run(work, [
      "push",
      "-q",
      "--force",
      src,
      "refs/heads/*:refs/heads/*",
      "refs/tags/*:refs/tags/*",
    ]);
    return { src, native, ours };
  }

  const oursLinesOf = (display: string[] | undefined, src: string) =>
    (display ?? []).map((l) =>
      l.replace("From http://git.test/src", `From ${src.replace(/\.git$/, "")}`),
    );

  it("a non-fast-forward refusal: the lines as git 2.5x prints them", async () => {
    const { src, native, ours } = setup();
    const nativeLines = refLines(stderrOf(native, ["fetch", "origin"]));
    const result = await (await open(ours)).fetch().setRemote("origin").call();
    expect(nativeLines.some((l) => l.includes("[rejected]"))).toBe(true);
    const oursLines = oursLinesOf(result.display, src);
    if (modern) expect(oursLines).toEqual(nativeLines);
    else expect(oursLines.length).toBe(nativeLines.length);
  });

  it("--tags moving a tag: would clobber existing tag", async () => {
    const { src, native, ours } = setup();
    const nativeLines = refLines(stderrOf(native, ["fetch", "--tags", "origin"]));
    const result = await (await open(ours))
      .fetch()
      .setRemote("origin")
      .setTagOpt(TagOption.FETCH_TAGS)
      .call();
    expect(nativeLines.some((l) => l.includes("would clobber existing tag"))).toBe(true);
    const oursLines = oursLinesOf(result.display, src);
    if (modern) expect(oursLines).toEqual(nativeLines);
    else expect(oursLines.length).toBe(nativeLines.length);
  });

  it("push: the source as written (HEAD~1 -> y, HEAD -> z, @, an id)", async () => {
    const { src, native, ours } = setup();
    const nativeDst = join(root, "native-dst.git");
    const oursDst = join(root, "ours-dst.git");
    run(root, ["init", "-q", "--bare", nativeDst]);
    run(root, ["init", "-q", "--bare", oursDst]);
    run(oursDst, ["config", "http.receivepack", "true"]);
    void src;
    const id = run(native, ["rev-parse", "HEAD"]).trim();
    const specs = [
      "HEAD~1:refs/heads/y",
      "HEAD:refs/heads/z",
      "main:refs/heads/w",
      "@:refs/heads/v",
      `${id}:refs/heads/u`,
    ];
    const nativeLines = refLines(stderrOf(native, ["push", nativeDst, ...specs]));
    run(ours, ["remote", "add", "dst", "http://git.test/ours-dst.git"]);
    const result = await (await open(ours))
      .push()
      .setRemote("dst")
      .setRefSpecs(...specs)
      .call();
    const oursLines = (result.display ?? []).map((l) =>
      l.replace("To http://git.test/ours-dst.git", `To ${nativeDst}`),
    );
    expect(nativeLines).toContain(" * [new branch]      HEAD~1 -> y");
    expect(oursLines).toEqual(nativeLines);
  });

  it("refuses to fetch into the checked-out branch, of this or another worktree", async () => {
    const { src, native, ours } = setup();
    const upstream = run(src, ["rev-parse", "main"]).trim();
    const nativeError = stderrOf(native, ["fetch", "origin", "main:main"]).trim();
    expect(nativeError).toBe(
      `fatal: refusing to fetch into branch 'refs/heads/main' checked out at '${native}'`,
    );
    await expect(
      (await open(ours)).fetch().setRemote("origin").setRefSpecs("main:main").call(),
    ).rejects.toThrow(
      `fatal: refusing to fetch into branch 'refs/heads/main' checked out at '${ours}'`,
    );
    // nothing fetched
    expect(spawnSync("git", ["cat-file", "-e", upstream], { cwd: ours }).status).not.toBe(0);
    // a branch a linked worktree has checked out
    const linked = join(root, "linked");
    run(ours, ["worktree", "add", "-q", "-b", "side", linked, "HEAD"]);
    run(native, ["worktree", "add", "-q", "-b", "side", join(root, "nlinked"), "HEAD"]);
    expect(stderrOf(native, ["fetch", "origin", "main:side"]).trim()).toBe(
      `fatal: refusing to fetch into branch 'refs/heads/side' checked out at '${join(root, "nlinked")}'`,
    );
    await expect(
      (await open(ours)).fetch().setRemote("origin").setRefSpecs("main:side").call(),
    ).rejects.toThrow(`checked out at '${linked}'`);
    // --update-head-ok lets it through
    const ok = await (await open(ours))
      .fetch()
      .setRemote("origin")
      .setRefSpecs("main:side")
      .setUpdateHeadOk(true)
      .call();
    expect(ok.trackingRefUpdates.map((u) => u.localRef)).toContain("refs/heads/side");
  });

  it("the checked-out branch check covers only the refs fetched and their opportunistic updates", async () => {
    // a mirror-like refspec: every remote branch maps onto a local branch, main among them
    const { src, native, ours } = setup();
    const dev = run(src, ["rev-parse", "dev"]).trim();
    for (const dir of [native, ours]) {
      run(dir, ["config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
    }
    // `fetch origin dev`: only dev is in the ref map (refs/heads/dev updated), not main
    const nativeRun = spawnSync("git", ["fetch", "origin", "dev"], {
      cwd: native,
      env: nativeGitEnv(home),
      encoding: "utf8",
    });
    expect([nativeRun.status, nativeRun.stderr]).toEqual([0, nativeRun.stderr]);
    const result = await (await open(ours)).fetch().setRemote("origin").setRefSpecs("dev").call();
    expect(result.trackingRefUpdates.map((u) => u.localRef)).toContain("refs/heads/dev");
    expect(run(ours, ["rev-parse", "refs/heads/dev"]).trim()).toBe(dev);
    expect(run(native, ["rev-parse", "refs/heads/dev"]).trim()).toBe(dev);
    expect(oursLinesOf(result.display, src)).toEqual(refLines(nativeRun.stderr));
    // `fetch origin main`: main's opportunistic update is the checked-out branch: refused
    expect(stderrOf(native, ["fetch", "origin", "main"]).trim()).toBe(
      `fatal: refusing to fetch into branch 'refs/heads/main' checked out at '${native}'`,
    );
    await expect(
      (await open(ours)).fetch().setRemote("origin").setRefSpecs("main").call(),
    ).rejects.toThrow(
      `fatal: refusing to fetch into branch 'refs/heads/main' checked out at '${ours}'`,
    );
  });
});

describeGit(
  "fetch -v, --porcelain, fetch.output=compact, FETCH_HEAD after a refusal, native twins",
  () => {
    let backend: NativeGitHttpBackend;
    const originalFetch = globalThis.fetch;
    /**
     * git 2.48+ follows the remote HEAD on a fetch (remote.<name>.followRemoteHEAD, set_head,
     * which a refused update skips); 2.43 never does. FETCH_HEAD gets its lines after a refusal
     * in both (not with --atomic)
     */
    const modern = /git version 2\.(5\d|[6-9]\d)/.test(run(process.cwd(), ["--version"]));

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "fetch-formats-native-"));
      home = join(root, "home");
      mkdirSync(home);
      backend = nativeGitHttpBackend(root, home);
      globalThis.fetch = backend.fetch;
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
      backend?.close();
      rmSync(root, { recursive: true, force: true });
    });

    /**
     * `work` published as `src.git`, cloned as `native` and `ours`; then main advances, a long
     * branch name and a tag appear, `gone` is deleted, `same` stays; with `refuse`, dev is
     * rewritten under a fetch refspec that does not force.
     */
    function setup(refuse = false) {
      const work = join(root, "work");
      const src = join(root, "src.git");
      run(root, ["init", "-q", "-b", "main", work]);
      run(work, ["commit", "-q", "--allow-empty", "-m", "base"]);
      run(work, ["commit", "-q", "--allow-empty", "-m", "second"]);
      run(work, ["branch", "dev"]);
      run(work, ["branch", "same"]);
      run(work, ["branch", "gone"]);
      run(root, ["clone", "-q", "--bare", work, src]);
      const native = join(root, "native");
      const ours = join(root, "ours");
      run(root, ["clone", "-q", src, native]);
      run(root, ["clone", "-q", src, ours]);
      run(ours, ["config", "remote.origin.url", "http://git.test/src.git"]);
      if (refuse) {
        for (const dir of [native, ours]) {
          run(dir, ["config", "remote.origin.fetch", "refs/heads/*:refs/remotes/origin/*"]);
        }
        run(work, ["branch", "-f", "dev", "HEAD~1"]);
      }
      run(work, ["commit", "-q", "--allow-empty", "-m", "third"]);
      // a tag of a commit only the fetched history has: auto-follow backfills it
      run(work, ["tag", "mid"]);
      run(work, ["commit", "-q", "--allow-empty", "-m", "fourth"]);
      run(work, ["branch", "feature/a-rather-long-branch-name"]);
      run(work, ["tag", "v2"]);
      run(work, ["branch", "-D", "gone"]);
      run(work, ["push", "-q", "--force", "--prune", src, "refs/heads/*:refs/heads/*"]);
      run(work, ["push", "-q", src, "refs/tags/*:refs/tags/*"]);
      return { src, native, ours };
    }

    const urlOf = (src: string) => src.replace(/\.git$/, "");
    const fromLine = (lines: string[], src: string) =>
      lines.map((l) => l.replace("From http://git.test/src", `From ${urlOf(src)}`));
    const stdoutOf = (cwd: string, args: string[]) =>
      spawnSync("git", args, { cwd, env: nativeGitEnv(home), encoding: "latin1" }).stdout;
    const fetchHead = (dir: string, src: string) => {
      try {
        return execFileSync("cat", [join(dir, ".git", "FETCH_HEAD")], {
          encoding: "latin1",
        }).replaceAll("http://git.test/src", urlOf(src));
      } catch {
        return undefined;
      }
    };

    it("-v: the refs already up to date are listed, the columns as wide as they need", async () => {
      const { src, native, ours } = setup();
      const nativeLines = refLines(stderrOf(native, ["fetch", "-v", "--prune", "origin"]));
      const result = await (await open(ours))
        .fetch()
        .setRemote("origin")
        .setRemoveDeletedRefs(true)
        .setVerbose(true)
        .call();
      expect(nativeLines.some((l) => l.includes("[up to date]"))).toBe(true);
      expect(fromLine(result.display ?? [], src)).toEqual(nativeLines);
      // nothing new: only the up-to-date lines
      const again = refLines(stderrOf(native, ["fetch", "-v", "origin"]));
      const oursAgain = await (await open(ours))
        .fetch()
        .setRemote("origin")
        .setVerbose(true)
        .call();
      expect(fromLine(oursAgain.display ?? [], src)).toEqual(again);
    });

    it("--porcelain: flag, full ids and ref names on stdout, a prune and a FETCH_HEAD-only ref", async () => {
      const { native, ours } = setup();
      const nativeLines = stdoutOf(native, ["fetch", "--porcelain", "--prune", "origin"])
        .split("\n")
        .filter(Boolean);
      const result = await (await open(ours))
        .fetch()
        .setRemote("origin")
        .setRemoveDeletedRefs(true)
        .setPorcelain(true)
        .call();
      expect(nativeLines.length).toBeGreaterThan(3);
      expect(result.display).toEqual(nativeLines);
      // a ref into FETCH_HEAD only, and the up-to-date ones with -v
      const fetchHeadOnly = stdoutOf(native, [
        "fetch",
        "--porcelain",
        "-v",
        "origin",
        "main",
        "dev",
      ])
        .split("\n")
        .filter(Boolean);
      const oursOnly = await (await open(ours))
        .fetch()
        .setRemote("origin")
        .setRefSpecs("main", "dev")
        .setPorcelain(true)
        .setVerbose(true)
        .call();
      expect(fetchHeadOnly.some((l) => l.endsWith(" FETCH_HEAD"))).toBe(true);
      expect(oursOnly.display).toEqual(fetchHeadOnly);
    });

    it("fetch.output=compact: a shared tail is written *", async () => {
      const { src, native, ours } = setup();
      for (const dir of [native, ours]) run(dir, ["config", "fetch.output", "compact"]);
      const nativeLines = refLines(stderrOf(native, ["fetch", "--prune", "origin"]));
      const result = await (await open(ours))
        .fetch()
        .setRemote("origin")
        .setRemoveDeletedRefs(true)
        .call();
      expect(nativeLines.some((l) => l.endsWith("-> *"))).toBe(true);
      expect(fromLine(result.display ?? [], src)).toEqual(nativeLines);
    });

    it("a refused update: FETCH_HEAD written as the refs are stored, porcelain lines", async () => {
      const { src, native, ours } = setup(true);
      const nativeOut = spawnSync("git", ["fetch", "--porcelain", "origin"], {
        cwd: native,
        env: nativeGitEnv(home),
        encoding: "latin1",
      });
      expect(nativeOut.status).toBe(1);
      const result = await (await open(ours)).fetch().setRemote("origin").setPorcelain(true).call();
      expect(result.display).toEqual(nativeOut.stdout.split("\n").filter(Boolean));
      expect(result.display?.some((l) => l.startsWith("! "))).toBe(true);
      expect(fetchHead(native, src)).not.toBe("");
      expect(fetchHead(ours, src)).toBe(fetchHead(native, src));
      const refs = (dir: string) => run(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]);
      expect(refs(ours)).toBe(refs(native));
    });

    it("--atomic and a refused update: FETCH_HEAD stays truncated, no ref written", async () => {
      const { src, native, ours } = setup(true);
      for (const dir of [native, ours]) {
        execFileSync("sh", ["-c", "echo stale > .git/FETCH_HEAD"], { cwd: dir });
      }
      const status = spawnSync("git", ["fetch", "--atomic", "origin"], {
        cwd: native,
        env: nativeGitEnv(home),
      }).status;
      expect(status).toBe(1);
      await (await open(ours)).fetch().setRemote("origin").setAtomic(true).call();
      expect(fetchHead(native, src)).toBe("");
      expect(fetchHead(ours, src)).toBe("");
      const refs = (dir: string) => run(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]);
      expect(refs(ours)).toBe(refs(native));
    });

    it("a refused update skips following the remote HEAD (set_head, git 2.48+)", async () => {
      const { native, ours } = setup(true);
      const src = join(root, "src.git");
      run(src, ["symbolic-ref", "HEAD", "refs/heads/same"]);
      for (const dir of [native, ours]) {
        run(dir, ["config", "remote.origin.followRemoteHEAD", "always"]);
      }
      spawnSync("git", ["fetch", "origin"], { cwd: native, env: nativeGitEnv(home) });
      await (await open(ours)).fetch().setRemote("origin").call();
      const head = (dir: string) => run(dir, ["symbolic-ref", "refs/remotes/origin/HEAD"]).trim();
      expect(head(native)).toBe("refs/remotes/origin/main");
      expect(head(ours)).toBe(head(native));
      // with nothing refused, it is followed (git 2.48+)
      for (const dir of [native, ours]) {
        run(dir, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
      }
      spawnSync("git", ["fetch", "origin"], { cwd: native, env: nativeGitEnv(home) });
      await (await open(ours)).fetch().setRemote("origin").call();
      expect(head(ours)).toBe("refs/remotes/origin/same");
      if (modern) expect(head(native)).toBe(head(ours));
    });

    const allRefs = (dir: string) =>
      run(dir, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"]);
    /** Every object id in a repository (loose and packed), sorted. */
    const objectIds = (dir: string) =>
      run(dir, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
        .split("\n")
        .filter(Boolean)
        .sort();

    it("--atomic --prune and a refused update: the stale ref stays (prune is in the transaction)", async () => {
      const { src, native, ours } = setup(true);
      const nativeOut = spawnSync("git", ["fetch", "--atomic", "--prune", "origin"], {
        cwd: native,
        env: nativeGitEnv(home),
        encoding: "latin1",
      });
      expect(nativeOut.status).toBe(1);
      const result = await (await open(ours))
        .fetch()
        .setRemote("origin")
        .setAtomic(true)
        .setRemoveDeletedRefs(true)
        .call();
      expect(run(native, ["rev-parse", "--verify", "-q", "refs/remotes/origin/gone"])).not.toBe("");
      expect(allRefs(ours)).toBe(allRefs(native));
      // the prune's line is printed all the same, as prune_refs prints it (git 2.5x prints
      // the lines after a refusal with a summary width of 0, 2.43 padded them)
      const even = (lines: string[]) => (modern ? lines : lines.map((l) => l.replace(/ +/g, " ")));
      expect(even(fromLine(result.display ?? [], src))).toEqual(even(refLines(nativeOut.stderr)));
      // without --atomic the stale ref is pruned first, on its own
      spawnSync("git", ["fetch", "--prune", "origin"], { cwd: native, env: nativeGitEnv(home) });
      await (await open(ours)).fetch().setRemote("origin").setRemoveDeletedRefs(true).call();
      expect(allRefs(native)).not.toContain("refs/remotes/origin/gone");
      expect(allRefs(ours)).toBe(allRefs(native));
    });

    it("--atomic and a ref store failure (a D/F conflict): accepted lines, git's error, no ref, no remote HEAD", async () => {
      const { src, native, ours } = setup();
      const bare = join(root, "src.git");
      // `same` becomes `same/x` upstream: refs/remotes/origin/same/x cannot be created here
      const main = run(bare, ["rev-parse", "refs/heads/main"]).trim();
      run(bare, ["update-ref", "-d", "refs/heads/same"]);
      run(bare, ["update-ref", "refs/heads/same/x", main]);
      run(bare, ["symbolic-ref", "HEAD", "refs/heads/feature/a-rather-long-branch-name"]);
      for (const dir of [native, ours]) {
        run(dir, ["config", "remote.origin.followRemoteHEAD", "always"]);
        execFileSync("sh", ["-c", "echo stale > .git/FETCH_HEAD"], { cwd: dir });
      }
      const nativeOut = spawnSync("git", ["fetch", "--atomic", "origin"], {
        cwd: native,
        env: nativeGitEnv(home),
        encoding: "latin1",
      });
      expect(nativeOut.status).not.toBe(0);
      const result = await (await open(ours)).fetch().setRemote("origin").setAtomic(true).call();
      const nativeLines = refLines(nativeOut.stderr);
      expect(nativeLines.some((l) => l.includes("[new branch]"))).toBe(true);
      expect(nativeLines.some((l) => l.startsWith(" !"))).toBe(false);
      expect(fromLine(result.display ?? [], src)).toEqual(nativeLines);
      // git 2.43 said `cannot lock ref '<ref>': ` before the refs code's words
      const nativeErrors = nativeOut.stderr
        .split("\n")
        .filter((l) => l.startsWith("error: "))
        .map((l) => l.replace(/^error: cannot lock ref '[^']*': /, "error: "));
      expect(nativeErrors).toEqual([
        "error: 'refs/remotes/origin/same' exists; cannot create 'refs/remotes/origin/same/x'",
      ]);
      expect((result.errors ?? []).map((e) => `error: ${e}`)).toEqual(nativeErrors);
      // nothing written, the remote HEAD not followed, FETCH_HEAD left truncated
      expect(allRefs(ours)).toBe(allRefs(native));
      expect(fetchHead(ours, src)).toBe(fetchHead(native, src));
    });

    it("--atomic --prune with a D/F conflict: a ref the transaction deletes still conflicts, git's words", async () => {
      const { native, ours } = setup();
      const bare = join(root, "src.git");
      // `same` becomes `same/x` upstream: pruning origin/same and creating origin/same/x in one
      // transaction is refused, as git counts the ref being deleted as existing
      const main = run(bare, ["rev-parse", "refs/heads/main"]).trim();
      run(bare, ["update-ref", "-d", "refs/heads/same"]);
      run(bare, ["update-ref", "refs/heads/same/x", main]);
      const nativeOut = spawnSync("git", ["fetch", "--atomic", "--prune", "origin"], {
        cwd: native,
        env: nativeGitEnv(home),
        encoding: "latin1",
      });
      expect(nativeOut.status).not.toBe(0);
      const result = await (await open(ours))
        .fetch()
        .setRemote("origin")
        .setAtomic(true)
        .setRemoveDeletedRefs(true)
        .call();
      const nativeErrors = nativeOut.stderr
        .split("\n")
        .filter((l) => l.startsWith("error: "))
        .map((l) => l.replace(/^error: cannot lock ref '[^']*': /, "error: "));
      expect(nativeErrors).toEqual([
        "error: 'refs/remotes/origin/same' exists; cannot create 'refs/remotes/origin/same/x'",
      ]);
      expect((result.errors ?? []).map((e) => `error: ${e}`)).toEqual(nativeErrors);
      expect(allRefs(ours)).toBe(allRefs(native));
    });

    it("a refused update makes no second round trip: tags of objects here come with the tips", async () => {
      const { src, native, ours } = setup(true);
      const work = join(root, "work");
      const bare = join(root, "src.git");
      // an annotated tag of a commit both clones have: include-tag does not send it
      run(work, ["tag", "-a", "-m", "old", "oldtag", "HEAD~3"]);
      run(work, ["push", "-q", bare, "refs/tags/oldtag"]);
      const nativeOut = spawnSync("git", ["fetch", "origin"], {
        cwd: native,
        env: { ...nativeGitEnv(home), GIT_TRACE_PACKET: "1" },
        encoding: "latin1",
      });
      expect(nativeOut.status).toBe(1);
      const nativeRounds = nativeOut.stderr
        .split("\n")
        .filter((l) => /> command=fetch$/.test(l)).length;
      let rounds = 0;
      const counting = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, { ...init, duplex: "half" } as RequestInit);
        const body = Buffer.from(await request.clone().arrayBuffer());
        if (body.includes("command=fetch")) rounds++;
        return counting(request);
      }) as typeof globalThis.fetch;
      try {
        await (await open(ours)).fetch().setRemote("origin").call();
      } finally {
        globalThis.fetch = counting;
      }
      expect(nativeRounds).toBe(1);
      expect(rounds).toBe(nativeRounds);
      expect(allRefs(ours)).toBe(allRefs(native));
      expect(allRefs(ours)).toContain("refs/tags/oldtag");
      expect(objectIds(ours)).toEqual(objectIds(native));
      expect(fetchHead(ours, src)).toBe(fetchHead(native, src));
    });
  },
);
