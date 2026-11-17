/**
 * git's revision syntax against native `git rev-parse --verify`: one repository built by
 * native git, every revision resolved by both (the id on stdout, or the exact `fatal:`
 * line; `warning:` lines compared too). Reflog entries are dated relative to now, so
 * `@{<date>}` lookups land between them for both.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { approxidateCareful } from "../src/commands/git-date.js";
import { Git, ResetMode, RevisionError } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";
const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;

/** git's environment, with both dates `hoursAgo` hours before now. */
const envAt = (hoursAgo?: number) => {
  const env = nativeGitEnv(home);
  if (hoursAgo === undefined) return env;
  const date = `${NOW - Math.round(hoursAgo * HOUR)} +0000`;
  return { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
};
const run = (cwd: string, hoursAgo: number | undefined, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: envAt(hoursAgo),
    encoding: "latin1",
    stdio: ["ignore", "pipe", "pipe"],
  });
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/**
 * `origin` (main: c1, c2 "second commit"); `repo`, its clone: main gets c3, c4 ("fix
 * typo"); `feat` (f1) from main; back on main; tags `v1` (lightweight) and `va`
 * (annotated) at c3; a branch `loc` tracking main (`remote = .`); a conflict-free index.
 */
function build(base: string): string {
  mkdirSync(base, { recursive: true });
  const origin = join(base, "origin");
  run(base, 11, "init", "-q", "-b", "main", "origin");
  put(origin, "a.txt", "a\n");
  run(origin, 10, "add", ".");
  run(origin, 10, "commit", "-qm", "c1");
  put(origin, "d/b.txt", "b\n");
  run(origin, 8, "add", ".");
  run(origin, 8, "commit", "-qm", "second commit");
  run(base, 7, "clone", "-q", "origin", "repo");
  const repo = join(base, "repo");
  put(repo, "a.txt", "a\nthree\n");
  run(repo, 5, "commit", "-qam", "c3");
  run(repo, 5, "tag", "v1");
  run(repo, 5, "tag", "-a", "-m", "annotated", "va");
  put(repo, "a.txt", "a\nthree\nfour\n");
  run(repo, 3, "commit", "-qam", "fix typo\n\nbody line");
  run(repo, 2, "checkout", "-q", "-b", "feat");
  put(repo, "f.txt", "f\n");
  run(repo, 1, "add", ".");
  run(repo, 1, "commit", "-qm", "f1");
  run(repo, 0.5, "checkout", "-q", "main");
  run(repo, 0.5, "branch", "--track", "loc", "main");
  return repo;
}

async function open(repo: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: nativeGitEnv(home) });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** `git rev-parse --verify <rev>` by native git and by ours: status, stdout, stderr. */
async function expectSameResolution(repo: string, revs: string[]): Promise<void> {
  const git = await open(repo);
  for (const rev of revs) {
    const n = spawnSync("git", ["rev-parse", "--verify", rev], {
      cwd: repo,
      env: envAt(),
      encoding: "latin1",
    });
    let ours: { status: number; out: string; err: string };
    try {
      const r = await git.revParse().setRevision(rev).call();
      ours = {
        status: 0,
        out: `${r.objectId}\n`,
        err: r.warnings.map((w) => `${w}\n`).join(""),
      };
    } catch (error) {
      ours = { status: 128, out: "", err: `${(error as Error).message}\n` };
    }
    expect([rev, ours]).toEqual([rev, { status: n.status, out: n.stdout, err: n.stderr }]);
  }
}

describeGit("revision syntax, native rev-parse --verify", () => {
  let repo = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "revision-native-"));
    home = join(root, "home");
    mkdirSync(home);
    repo = build(join(root, "base"));
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("refs, ids, @, ~ and ^, peeling, <rev>:<path> and index paths", async () => {
    const head = run(repo, undefined, "rev-parse", "HEAD").trim();
    await expectSameResolution(repo, [
      "HEAD",
      "@",
      "@~1",
      "@^",
      "HEAD~2",
      "main^0",
      "main^2",
      "HEAD~9",
      head,
      `${head}~1`,
      "origin/main",
      "origin",
      "refs/heads/feat",
      "heads/feat",
      "v1",
      "va",
      "va^{}",
      "va^{tag}",
      "va^{commit}",
      "va^{tree}",
      "va^{object}",
      "va~1",
      "v1^{tag}",
      "HEAD^{tree}",
      "HEAD^{blob}",
      "HEAD^{tree}^{commit}",
      "HEAD:a.txt",
      "HEAD:d",
      "HEAD:d/b.txt",
      "HEAD:",
      "HEAD:./a.txt",
      "HEAD:nope",
      "HEAD~1:a.txt",
      "va:a.txt",
      ":a.txt",
      ":0:a.txt",
      ":./d/b.txt",
      ":2:a.txt",
      ":nope",
      "nope",
    ]);
  });

  it("commit message searches: :/<regex>, <rev>^{/<regex>}, !- and !!", async () => {
    await expectSameResolution(repo, [
      ":/c1",
      ":/^c",
      ":/typo$",
      ":/body",
      ":/^(f1|c3)",
      ":/second.commit",
      ":/!-c",
      ":/!!x",
      ":/!x",
      ":/nothing matches",
      ":/(",
      "HEAD^{/c}",
      "HEAD^{/second}",
      "HEAD~1^{/typo}",
      "feat^{/}",
      "va^{/c1}",
      "HEAD^{/zzz}",
    ]);
  });

  it("@{upstream}, @{u}, <branch>@{u}, @{push} and @{-N}", async () => {
    await expectSameResolution(repo, [
      "@{u}",
      "@{U}",
      "@{upstream}",
      "@{UpStream}",
      "main@{u}",
      "HEAD@{u}",
      "loc@{u}",
      "loc@{upstream}~1",
      "feat@{u}",
      "nosuch@{u}",
      "@{push}",
      "main@{push}",
      "@{push}^{tree}",
      "loc@{push}",
      "feat@{push}",
      "@{-1}",
      "@{-1}~1",
      "@{-2}",
      "@{-9}",
      "@{-1}@{u}",
      "@{u}@{1}",
    ]);
  });

  it("@{push} as push.default, remote.pushDefault, pushRemote and push refspecs say", async () => {
    const configs: string[][][] = [
      [["push.default", "upstream"]],
      [["push.default", "current"]],
      [["push.default", "matching"]],
      [["push.default", "nothing"]],
      [["push.default", "tracking"]],
      [["remote.pushDefault", "other"]],
      [["branch.main.pushRemote", "origin"]],
      [["remote.origin.push", "refs/heads/main:refs/heads/pushed"]],
      [["remote.origin.push", "refs/heads/nothere:refs/heads/x"]],
      [["remote.origin.mirror", "true"]],
    ];
    for (const config of configs) {
      for (const [key, value] of config) run(repo, undefined, "config", key ?? "", value ?? "");
      await expectSameResolution(repo, ["@{push}", "loc@{push}", "feat@{push}"]);
      for (const [key] of config) run(repo, undefined, "config", "--unset", key ?? "");
    }
    // `remote = .` upstream of a branch that tracks a local branch
    run(repo, undefined, "config", "push.default", "upstream");
    await expectSameResolution(repo, ["loc@{push}"]);
    run(repo, undefined, "config", "--unset", "push.default");
  });

  it("detached HEAD: @{u} and @{push} refused as git refuses them", async () => {
    run(repo, 0.4, "checkout", "-q", "--detach", "HEAD");
    try {
      await expectSameResolution(repo, ["@{u}", "@{push}", "HEAD@{u}", "main@{u}", "@{1}"]);
    } finally {
      run(repo, 0.3, "checkout", "-q", "main");
    }
  });

  it("<ref>@{<n>}, @{<n>}, HEAD@{<n>}, and the log running out", async () => {
    await expectSameResolution(repo, [
      "main@{0}",
      "main@{1}",
      "main@{2}",
      "main@{3}",
      "main@{9}",
      "@{0}",
      "@{1}",
      "@{2}",
      "HEAD@{0}",
      "HEAD@{1}",
      "HEAD@{3}",
      "HEAD@{30}",
      "feat@{1}",
      "feat@{2}",
      "feat@{1}~1",
      "feat@{1}^{tree}",
      "origin/main@{0}",
      "origin/main@{1}",
      "v1@{0}",
      "v1@{1}",
      "loc@{0}",
    ]);
  });

  it("<ref>@{<date>}: approxidate, seconds, and a log that does not go back far enough", async () => {
    await expectSameResolution(repo, [
      "main@{4.hours.ago}",
      "main@{4 hours ago}",
      "main@{6.hours.ago}",
      "main@{9.hours.ago}",
      "main@{yesterday}",
      "main@{1.year.ago}",
      "main@{now}",
      "@{2.hours.ago}",
      "HEAD@{90.minutes.ago}",
      "feat@{now}",
      `main@{${NOW - 4 * HOUR}}`,
      `main@{${NOW - 3 * HOUR}}`,
      "main@{blah}",
      "main@{last.week}",
      "main@{2 days ago}",
    ]);
  });

  it("<rev>:<path> as git's get_tree_entry matches it: empty components, trailing /", async () => {
    await expectSameResolution(repo, [
      "HEAD:a.txt/",
      "HEAD:d//b.txt",
      "HEAD:/a.txt",
      "HEAD:d/",
      "HEAD:d/b.txt/",
      "HEAD:d/b.txt//",
      "HEAD:./d/",
      "HEAD://",
      "HEAD:d/./b.txt",
    ]);
  });

  it("40-hex ids of missing objects resolve; peeling them does not", async () => {
    const missing = "1234567890123456789012345678901234567890";
    await expectSameResolution(repo, [
      missing,
      missing.toUpperCase(),
      `${missing}^{commit}`,
      `${missing}^{tree}`,
      `${missing}^{}`,
      `${missing}~1`,
      `${missing}:a.txt`,
    ]);
  });

  it("ambiguous refnames, 40-hex refnames and dangling symrefs warn as git does", async () => {
    run(repo, undefined, "tag", "feat", "main~1");
    const head = run(repo, undefined, "rev-parse", "HEAD").trim();
    run(repo, undefined, "update-ref", `refs/heads/${head}`, "main~1");
    run(repo, undefined, "config", "advice.objectNameWarning", "false");
    try {
      await expectSameResolution(repo, [
        "feat",
        "feat~1",
        "feat^{tree}",
        "feat@{1}",
        "@{-1}",
        "@{-1}~1",
        "heads/feat",
        "refs/heads/feat",
        "tags/feat",
        head,
        `${head}~1`,
        "HEAD",
        "HEAD~1",
        "HEAD:a.txt",
      ]);
      // the advice after the 40-hex warning (git 2.5x's text names `git config set`)
      run(repo, undefined, "config", "--unset", "advice.objectNameWarning");
      const n = spawnSync("git", ["rev-parse", "--verify", head], {
        cwd: repo,
        env: envAt(),
        encoding: "latin1",
      });
      if (n.stderr.includes("git config set")) await expectSameResolution(repo, [head]);
      // core.warnAmbiguousRefs=false: the first rule wins, quietly
      run(repo, undefined, "config", "core.warnAmbiguousRefs", "false");
      await expectSameResolution(repo, ["feat", "@{-1}", head]);
      run(repo, undefined, "config", "--unset", "core.warnAmbiguousRefs");
      // origin/HEAD pointing at a branch that is gone
      run(repo, undefined, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone");
      await expectSameResolution(repo, ["origin", "origin/main", "origin/HEAD"]);
    } finally {
      run(repo, undefined, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      run(repo, undefined, "tag", "-d", "feat");
      run(repo, undefined, "update-ref", "-d", `refs/heads/${head}`);
      spawnSync("git", ["config", "--unset", "advice.objectNameWarning"], { cwd: repo });
      spawnSync("git", ["config", "--unset", "core.warnAmbiguousRefs"], { cwd: repo });
    }
  });

  it("read_ref_at's warnings: a log with a gap, a log that ends before the ref", async () => {
    const c = (rev: string) => run(repo, undefined, "rev-parse", rev).trim();
    const [c1, c2, c3, c4] = [c("main~3"), c("main~2"), c("main~1"), c("main")];
    run(repo, 6, "update-ref", "--create-reflog", "-m", "one", "refs/heads/gap", c1);
    run(repo, 4, "update-ref", "-m", "two", "refs/heads/gap", c3, c1);
    // the second entry claims to move from c2, not from c1 where the first one left it
    const logPath = join(repo, ".git/logs/refs/heads/gap");
    const lines = readFileSync(logPath, "latin1").split("\n");
    lines[1] = (lines[1] ?? "").replace(`${c1} ${c3}`, `${c2} ${c3}`);
    writeFileSync(logPath, lines.join("\n"));
    // git 2.43 still answered `<ref>@{<n>}` with the old id of the nth entry, quietly; 2.5x
    // reads it as a date lookup does (the new id of the entry after it, gap warned)
    const version = /(\d+)\.(\d+)/.exec(run(repo, undefined, "--version"));
    const counted = Number(version?.[1]) > 2 || Number(version?.[2]) >= 50;
    const nth = (...revs: string[]) => (counted ? revs : []);
    try {
      await expectSameResolution(repo, [...nth("gap@{1}"), "gap@{5.hours.ago}", "gap@{now}"]);
      await expectSameResolution(repo, ["gap@{0}"]);
      // the ref moved without its log: the newest entry is not where it is
      writeFileSync(join(repo, ".git/refs/heads/gap"), `${c4}\n`);
      await expectSameResolution(repo, [...nth("gap@{0}", "gap@{1}"), "gap@{now}", "gap@{9}"]);
    } finally {
      run(repo, undefined, "update-ref", "-d", "refs/heads/gap");
    }
  });
});

describeGit("revision syntax in commands, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "revision-commands-native-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const lastHeadLine = (repo: string) => {
    const log = run(repo, undefined, "reflog", "-1", "--format=%gs").trim();
    const head = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], {
      cwd: repo,
      encoding: "latin1",
    });
    return { log, head: head.stdout || run(repo, undefined, "rev-parse", "HEAD") };
  };
  const failure = (repo: string, ...args: string[]) =>
    spawnSync("git", args, { cwd: repo, env: envAt(), encoding: "latin1" }).stderr.trimEnd();
  const message = async (call: () => Promise<unknown>) => {
    try {
      await call();
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  };

  it("switch / checkout / reset take @{u}, <branch>@{u} and @{push}", async () => {
    const native = build(join(root, "n"));
    const ours = build(join(root, "o"));
    let git = await open(ours);
    // a remote-tracking branch is not a branch to switch to
    expect(await message(() => git.switch().setName("@{u}").call())).toBe(
      failure(native, "switch", "@{u}"),
    );
    // no upstream: git's fatal line
    expect(await message(() => git.switch().setName("feat@{u}").call())).toBe(
      failure(native, "switch", "feat@{u}"),
    );
    // loc tracks main (remote = .): loc@{u} is the branch main
    run(native, 0.2, "checkout", "-q", "feat");
    await (await open(ours)).checkout().setName("feat").call();
    run(native, undefined, "checkout", "-q", "loc@{u}");
    git = await open(ours);
    await git.checkout().setName("loc@{u}").call();
    expect(lastHeadLine(ours)).toEqual(lastHeadLine(native));
    // a detached checkout names the revision as given
    run(native, undefined, "checkout", "-q", "@{u}");
    await (await open(ours)).checkout().setName("@{u}").call();
    expect(lastHeadLine(ours)).toEqual(lastHeadLine(native));
    run(native, undefined, "checkout", "-q", "main");
    await (await open(ours)).checkout().setName("main").call();
    run(native, undefined, "reset", "-q", "--hard", "@{push}~1");
    await (await open(ours)).reset().setRef("@{push}~1").setMode(ResetMode.HARD).call();
    expect(run(ours, undefined, "rev-parse", "HEAD")).toBe(
      run(native, undefined, "rev-parse", "HEAD"),
    );
    expect(lastHeadLine(ours)).toEqual(lastHeadLine(native));
  });

  it("a revision that names a tree, a blob or a missing object where a commit is needed", async () => {
    const native = build(join(root, "nc-n"));
    const ours = build(join(root, "nc-o"));
    const git = await open(ours);
    const missing = "1234567890123456789012345678901234567890";
    const version = /(\d+)\.(\d+)/.exec(run(native, undefined, "--version"));
    const git256 = Number(version?.[1]) > 2 || Number(version?.[2]) >= 50;
    const cases: [string[], () => Promise<unknown>][] = [];
    for (const rev of ["HEAD^{tree}", "HEAD:a.txt", "va^{tree}", missing]) {
      cases.push(
        [["reset", rev], () => git.reset().setRef(rev).call()],
        [["reset", "--hard", rev], () => git.reset().setRef(rev).setMode(ResetMode.HARD).call()],
        [["reset", "--soft", rev], () => git.reset().setRef(rev).setMode(ResetMode.SOFT).call()],
        [["branch", "x", rev], () => git.branchCreate().setName("x").setStartPoint(rev).call()],
        [["merge", rev], () => git.merge().include(rev).call()],
        [["merge", "feat", rev], () => git.merge().include("feat").include(rev).call()],
        [["rebase", rev], async () => (await git.rebase().setUpstreamBranch(rev)).call()],
        [["cherry-pick", rev], () => git.cherryPick().include(rev).call()],
        [["revert", rev], () => git.revert().include(rev).call()],
      );
      // a tree: git's switch_branches refusal (a blob or a missing object: 2.5x's text)
      if (rev !== "HEAD:a.txt" && rev !== missing) {
        cases.push(
          [["checkout", rev], () => git.checkout().setName(rev).call()],
          [["checkout", "--detach", rev], () => git.checkout().setDetach(true).setName(rev).call()],
          [
            ["checkout", "-b", "y", rev],
            () => git.checkout().setCreateBranch(true).setName("y").setStartPoint(rev).call(),
          ],
          [["switch", rev], () => git.switch().setName(rev).call()],
          [["switch", "--detach", rev], () => git.switch().setDetach(true).setName(rev).call()],
          [
            ["switch", "-c", "y", rev],
            () => git.switch().setCreateBranch("y").setStartPoint(rev).call(),
          ],
        );
      } else if (git256) {
        cases.push(
          [["checkout", rev], () => git.checkout().setName(rev).call()],
          [["switch", "--detach", rev], () => git.switch().setDetach(true).setName(rev).call()],
        );
      }
    }
    for (const [args, call] of cases) {
      expect([args, await message(call)]).toEqual([args, failure(native, ...args)]);
    }
    const refs = (repo: string) =>
      run(repo, undefined, "for-each-ref", "--format=%(refname) %(objectname)");
    expect(refs(ours)).toBe(refs(native));
    expect(lastHeadLine(ours)).toEqual(lastHeadLine(native));
    // reset with paths takes any tree-ish
    run(native, undefined, "reset", "-q", "HEAD~1^{tree}", "--", "a.txt");
    await (await open(ours)).reset().setRef("HEAD~1^{tree}").addPath("a.txt").call();
    expect(run(ours, undefined, "ls-files", "-s")).toBe(run(native, undefined, "ls-files", "-s"));
  });
});

describe("approxidateCareful", () => {
  it("reads git's approximate dates relative to now", () => {
    const now = 1_700_000_000;
    expect(approxidateCareful("1600000000 +0000", now)).toEqual({
      timestamp: 1600000000,
      error: false,
    });
    expect(approxidateCareful("2.hours.ago", now)).toEqual({
      timestamp: now - 7200,
      error: false,
    });
    expect(approxidateCareful("3 days ago", now).timestamp).toBe(now - 3 * 86400);
    expect(approxidateCareful("last week", now).timestamp).toBe(now - 7 * 86400);
    expect(approxidateCareful("blah", now).error).toBe(true);
    expect(approxidateCareful("now", now).timestamp).toBe(now);
  });
});

describeGit("approxidate against native git, one timezone for both", () => {
  const savedTz = process.env.TZ;
  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it("dates across a summer-time change (rev-parse --since), as git reads them", () => {
    for (const zone of ["America/Los_Angeles", "Europe/Berlin", "UTC"]) {
      process.env.TZ = zone;
      for (const text of [
        "1 month ago",
        "june",
        "january",
        "10/11/2026",
        "6/1/2026",
        "2026-03-01",
        "march 10 noon",
        "3.months.ago",
        "1.year.ago",
        "yesterday",
        "last friday",
      ]) {
        const before = Math.floor(Date.now() / 1000);
        const native = execFileSync("git", ["rev-parse", `--since=${text}`], {
          env: { ...nativeGitEnv(root || tmpdir()), TZ: zone },
          encoding: "utf8",
        }).trim();
        const after = Math.floor(Date.now() / 1000);
        const ours = new Set(
          [before, after].map((now) => `--max-age=${approxidateCareful(text, now).timestamp}`),
        );
        expect([zone, text, ours.has(native)]).toEqual([zone, text, true]);
      }
    }
  });
});

// ---------------------------------------------------------------- abbreviated ids (P4.25)

/** git's object id of `type` with `body` (SHA-1 of the header and the bytes). */
const objectId = (type: string, body: Buffer) =>
  createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest("hex");

/** The first `make(i)` whose id (as `type`) starts with `prefix`. */
function craft(type: string, prefix: string, make: (i: number) => Buffer): Buffer {
  for (let i = 0; ; i++) {
    const body = make(i);
    if (objectId(type, body).startsWith(prefix)) return body;
  }
}

const IDENT = "Interop Tester <interop@example.com> 1112911993 +0000";

/**
 * Objects whose ids share prefixes with a repository's: for `P` (main's commit) a blob, a
 * tree, a tag and a second commit; for `Q` (main's tree) a blob; for `R` (main's first
 * commit) a blob; two blobs sharing six digits. Each crafted object is written by native git
 * (`hash-object`, `mktree`, `commit-tree`, `mktag`) and checked against the id computed here.
 */
function craftCollisions(repo: string, tag: string): Record<string, string> {
  const git = (input: string | Buffer, ...args: string[]) =>
    execFileSync("git", args, { cwd: repo, env: envAt(), input, encoding: "latin1" }).trim();
  const head = git("", "rev-parse", "main");
  const tree = git("", "rev-parse", "main^{tree}");
  const first = git("", "rev-list", "--max-parents=0", "main");
  const blobA = git("", "rev-parse", "main:a.txt");
  const P = head.slice(0, 4);
  const Q = tree.slice(0, 4);
  const R = first.slice(0, 4);
  const blob = (prefix: string, salt: string) => {
    const body = craft("blob", prefix, (i) => Buffer.from(`${salt} ${i}\n`));
    const id = git(body, "hash-object", "-w", "--stdin");
    expect(id.startsWith(prefix)).toBe(true);
    return id;
  };
  const out: Record<string, string> = { P, Q, R, head, tree, first };
  out.blobP = blob(P, `blob-p-${tag}`);
  out.blobQ = blob(Q, `blob-q-${tag}`);
  out.blobR = blob(R, `blob-r-${tag}`);
  // a tree: one entry, its name varied
  const oid = Buffer.from(blobA, "hex");
  const treeBody = craft("tree", P, (i) =>
    Buffer.concat([Buffer.from(`100644 f-${tag}-${i}\0`), oid]),
  );
  const name = treeBody.subarray(7, treeBody.indexOf(0)).toString();
  out.treeP = git(`100644 blob ${blobA}\t${name}\n`, "mktree");
  expect(out.treeP.startsWith(P)).toBe(true);
  // a commit: main's tree and parent, its message varied
  const commitBody = craft("commit", P, (i) =>
    Buffer.from(
      `tree ${tree}\nparent ${head}\nauthor ${IDENT}\ncommitter ${IDENT}\n\ncrafted ${tag} ${i}\n`,
    ),
  );
  const msg = commitBody.toString().split("\n\n")[1]?.trim() ?? "";
  out.commitP = git("", "commit-tree", tree, "-p", head, "-m", msg);
  expect(out.commitP.startsWith(P)).toBe(true);
  // an annotated tag of the first commit, its message varied
  const tagBody = craft("tag", P, (i) =>
    Buffer.from(
      `object ${first}\ntype commit\ntag crafted-${tag}\ntagger ${IDENT}\n\nmessage ${i}\n`,
    ),
  );
  out.tagP = git(tagBody, "mktag");
  expect(out.tagP.startsWith(P)).toBe(true);
  // two blobs sharing six digits (a birthday search)
  const seen = new Map<string, Buffer>();
  for (let i = 0; ; i++) {
    const body = Buffer.from(`pair-${tag} ${i}\n`);
    const key = objectId("blob", body).slice(0, 6);
    const other = seen.get(key);
    if (other) {
      out.pairA = git(other, "hash-object", "-w", "--stdin");
      out.pairB = git(body, "hash-object", "-w", "--stdin");
      out.S = key;
      break;
    }
    seen.set(key, body);
  }
  return out;
}

/**
 * main: c1 (a.txt), c2 (d/b.txt, d/e/c.txt), m (a merge of side: s1, s2); tags v1
 * (lightweight, at c2) and va (annotated, at c1); feat from c2 with f1.
 */
function buildRanges(base: string): string {
  mkdirSync(base, { recursive: true });
  run(base, undefined, "init", "-q", "-b", "main", "r");
  const repo = join(base, "r");
  put(repo, "a.txt", "a\n");
  run(repo, undefined, "add", ".");
  run(repo, undefined, "commit", "-qm", "c1");
  run(repo, undefined, "tag", "-a", "-m", "annotated", "va");
  put(repo, "d/b.txt", "b\n");
  put(repo, "d/e/c.txt", "c\n");
  run(repo, undefined, "add", ".");
  run(repo, 9, "commit", "-qm", "c2");
  run(repo, undefined, "tag", "v1");
  run(repo, undefined, "checkout", "-q", "-b", "feat");
  put(repo, "f.txt", "f\n");
  run(repo, undefined, "add", ".");
  run(repo, 8, "commit", "-qm", "f1");
  run(repo, undefined, "checkout", "-q", "-b", "side", "v1");
  put(repo, "s.txt", "s1\n");
  run(repo, undefined, "add", ".");
  run(repo, 7, "commit", "-qm", "s1");
  put(repo, "s.txt", "s2\n");
  run(repo, 6, "commit", "-qam", "s2");
  run(repo, undefined, "checkout", "-q", "main");
  put(repo, "a.txt", "a\nmain\n");
  run(repo, 5, "commit", "-qam", "c3");
  run(repo, 4, "merge", "-q", "--no-ff", "-m", "m", "side");
  return repo;
}

/** `git rev-parse <args>` (no --verify) by native git and ours: status, stdout, stderr. */
async function expectSameRevParse(repo: string, cases: string[][]): Promise<void> {
  const git = await open(repo);
  for (const args of cases) {
    const n = spawnSync("git", ["rev-parse", ...args], {
      cwd: repo,
      env: envAt(),
      encoding: "latin1",
    });
    let ours: { status: number; out: string; err: string };
    try {
      const command = git.revParse();
      for (const arg of args) command.addArgument(arg);
      const r = await command.call();
      ours = {
        status: 0,
        out: r.lines.map((l) => `${l}\n`).join(""),
        err: r.warnings.map((w) => `${w}\n`).join(""),
      };
    } catch (error) {
      const output = error instanceof RevisionError ? error.output : [];
      ours = {
        status: 128,
        out: output.map((l) => `${l}\n`).join(""),
        err: `${(error as Error).message}\n`,
      };
    }
    expect([args, ours]).toEqual([args, { status: n.status, out: n.stdout, err: n.stderr }]);
  }
}

/** `git log --format=%H <args>` by native git and ours (`revList`). */
async function expectSameLog(repo: string, cases: string[][]): Promise<void> {
  const git = await open(repo);
  for (const args of cases) {
    const n = spawnSync("git", ["log", "--format=%H", ...args, "--"], {
      cwd: repo,
      env: envAt(),
      encoding: "latin1",
    });
    let ours: { status: number; out: string; err: string };
    try {
      const command = git.revList();
      for (const arg of args) command.addRevision(arg);
      const ids: string[] = [];
      for await (const c of await command.call()) ids.push(c.id);
      ours = { status: 0, out: ids.map((id) => `${id}\n`).join(""), err: "" };
    } catch (error) {
      ours = { status: 128, out: "", err: `${(error as Error).message}\n` };
    }
    // the commits compared as a set: LogCommand's walk without paths is not in git's
    // date order (a known gap of LogCommand, not of the revision arguments)
    // TODO: compare in order once LogCommand's plain walk follows git's limit_list /
    // date-ordered walk (the pending log-command.ts change); RevListCommand documents it
    const sorted = (out: string) => out.split("\n").filter(Boolean).sort().join("\n");
    expect([args, { ...ours, out: sorted(ours.out) }]).toEqual([
      args,
      { status: n.status, out: sorted(n.stdout), err: n.stderr },
    ]);
  }
}

describeGit("abbreviated object ids and describe names, native rev-parse --verify", () => {
  let repo = "";
  let ids: Record<string, string> = {};
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "revision-abbrev-native-"));
    home = join(root, "home");
    mkdirSync(home);
    repo = buildRanges(join(root, "base"));
    ids = craftCollisions(repo, "loose");
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });
  const setConfig = (key: string, value?: string) => {
    if (value === undefined)
      spawnSync("git", ["config", "--unset", key], { cwd: repo, env: envAt() });
    else run(repo, undefined, "config", key, value);
  };
  /** Every object's id at 4 to 8 digits, in both cases, and whole. */
  const everyAbbreviation = () => {
    const all = run(
      repo,
      undefined,
      "cat-file",
      "--batch-all-objects",
      "--batch-check=%(objectname)",
    )
      .trim()
      .split("\n");
    const revs: string[] = [];
    for (const id of all) {
      for (const len of [4, 5, 6, 7, 8]) revs.push(id.slice(0, len));
      revs.push(id.slice(0, 6).toUpperCase(), id);
    }
    return revs;
  };
  const crafted = () => {
    const { P, Q, R, S } = ids;
    return [
      P,
      P.toUpperCase(),
      `${P}^{commit}`,
      `${P}^{tree}`,
      `${P}^{blob}`,
      `${P}^{tag}`,
      `${P}^{}`,
      `${P}~0`,
      `${P}^`,
      `${P}:a.txt`,
      Q,
      `${Q}^{tree}`,
      `${Q}:a.txt`,
      `${Q}:`,
      `${Q}~0`,
      R,
      `${R}~0`,
      `${R}^{commit}`,
      `${R}:a.txt`,
      S,
      S.slice(0, 4),
      `${S}^{blob}`,
      "abc",
      "0000",
      "ffffffff",
      `${ids.head.slice(0, 39)}`,
      `${ids.head.slice(0, 12)}x`,
    ];
  };
  /**
   * git 2.5x reads `<x>-g<abbrev>` as describe output only when `<x>` is a ref name,
   * a dash and digits (`ref_and_count_parts_valid`); 2.43 takes any `-g<abbrev>`.
   */
  const strictDescribe = () =>
    spawnSync("git", ["rev-parse", "-q", "--verify", `zz-g${ids.head.slice(0, 7)}`], {
      cwd: repo,
      env: envAt(),
    }).status !== 0;
  const describeNames = () => {
    const { R, head, first } = ids;
    const lenient = [
      `v1-g${head.slice(0, 7)}`,
      `v1-xx-g${head.slice(0, 7)}`,
      `-1-g${head.slice(0, 7)}`,
      `v1[x-1-g${head.slice(0, 7)}`,
    ];
    return [
      ...(strictDescribe() ? lenient : []),
      `v1-1-g${head.slice(0, 7)}`,
      `va-0-g${first.slice(0, 5)}`,
      `junk-12-g${head.slice(0, 8)}`,
      `refs/tags/v1-3-g${head.slice(0, 6)}`,
      `v1-1-g${R}`,
      `v1-1-g${ids.P}`,
      `v1-1-g${ids.blobQ.slice(0, 8)}`,
      `v1-1-g${head.slice(0, 3)}`,
      `v1-1-g${head.slice(0, 7)}~1`,
      `v1-1-g${head.slice(0, 7)}^{tree}`,
      `v1-1-g${head.slice(0, 7)}:a.txt`,
    ];
  };

  it("every object's abbreviations, loose", async () => {
    await expectSameResolution(repo, everyAbbreviation());
  });

  it("colliding prefixes: the type the context needs, git's error and candidate list", async () => {
    await expectSameResolution(repo, crafted());
  });

  it("core.disambiguate: commit, committish, tree, treeish, blob, none", async () => {
    for (const value of ["commit", "committish", "tree", "treeish", "blob", "none", "Tree"]) {
      setConfig("core.disambiguate", value);
      await expectSameResolution(repo, crafted());
    }
    setConfig("core.disambiguate");
  });

  it("core.abbrev lengthens the candidates' abbreviations", async () => {
    for (const value of ["4", "10", "auto"]) {
      setConfig("core.abbrev", value);
      await expectSameResolution(repo, [ids.P, ids.S.slice(0, 4), `${ids.Q}~0`]);
    }
    setConfig("core.abbrev");
  });

  it("describe names: <ref>-<n>-g<abbrev> read as a commit", async () => {
    await expectSameResolution(repo, describeNames());
  });

  it("a ref that is also a short id warns; refs win over short ids", async () => {
    run(repo, undefined, "branch", ids.R, "feat");
    run(repo, undefined, "tag", ids.head.slice(0, 6), "v1");
    await expectSameResolution(repo, [
      ids.R,
      `${ids.R}~1`,
      `${ids.R}@{0}`,
      ids.head.slice(0, 6),
      ids.head.slice(0, 7),
    ]);
    setConfig("core.warnAmbiguousRefs", "false");
    await expectSameResolution(repo, [ids.R, ids.head.slice(0, 6)]);
    setConfig("core.warnAmbiguousRefs");
    run(repo, undefined, "branch", "-D", ids.R);
    run(repo, undefined, "tag", "-d", ids.head.slice(0, 6));
  });

  it("packed objects (idx prefix search), with loose collisions added after the pack", async () => {
    let n = 0;
    for (const id of Object.values(ids)) {
      if (id.length === 40) run(repo, undefined, "update-ref", `refs/keep/k${n++}`, id);
    }
    run(repo, undefined, "repack", "-a", "-d", "-q");
    run(repo, undefined, "prune-packed");
    const more = craftCollisions(repo, "after-pack");
    await expectSameResolution(repo, everyAbbreviation());
    await expectSameResolution(repo, crafted());
    await expectSameResolution(repo, [more.P, more.S, `${more.P}^{commit}`, `${more.Q}:a.txt`]);
    await expectSameResolution(repo, describeNames());
  });
});

describeGit("revision ranges and sets, native rev-parse and log", () => {
  let repo = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "revision-ranges-native-"));
    home = join(root, "home");
    mkdirSync(home);
    repo = buildRanges(join(root, "base"));
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });
  const short = (rev: string) => run(repo, undefined, "rev-parse", "--short", rev).trim();

  it("rev-parse prints ranges, exclusions and parent shorthands as git does", async () => {
    await expectSameRevParse(repo, [
      ["main..feat"],
      ["feat..main"],
      ["feat...main"],
      ["main...feat"],
      ["..feat"],
      ["feat.."],
      ["feat..."],
      ["...feat"],
      ["^main"],
      ["main", "^feat", "side"],
      ["HEAD^!"],
      ["HEAD^@"],
      ["HEAD^-"],
      ["HEAD^-1"],
      ["HEAD^-2"],
      ["HEAD^-3"],
      ["v1^!"],
      ["va^@"],
      ["va..v1"],
      ["va...feat"],
      [`${short("feat")}..${short("main")}`],
      ["main~2^!"],
      ["nope..main"],
      ["nope"],
      ["main..nope"],
      ["HEAD~1^@", "^side"],
    ]);
  });

  it("log lists ranges, symmetric differences, --not and parent shorthands as git does", async () => {
    await expectSameLog(repo, [
      [],
      ["main"],
      ["main..feat"],
      ["feat..main"],
      ["feat...main"],
      ["main...feat"],
      ["..feat"],
      ["feat.."],
      ["^feat", "main"],
      ["^main"],
      ["main", "--not", "feat"],
      ["main", "--not", "feat", "--not", "side"],
      ["--not", "^feat", "main"],
      ["HEAD^!"],
      ["HEAD^@"],
      ["HEAD^-"],
      ["HEAD^-2"],
      ["main^-1", "feat"],
      ["side^@", "^v1"],
      ["va..main"],
      ["v1...va"],
      [`${short("side")}...${short("feat")}`],
      ["nope"],
      ["nope..main"],
      ["HEAD^-x"],
      ["HEAD^-0"],
    ]);
  });

  it("rev-parse --verify prints a range or parent shorthand, then needs a single revision", async () => {
    const git = await open(repo);
    for (const rev of ["main..feat", "feat...main", "HEAD^!", "HEAD^@", "HEAD^-2", "nope..main"]) {
      const n = spawnSync("git", ["rev-parse", "--verify", rev], {
        cwd: repo,
        env: envAt(),
        encoding: "latin1",
      });
      let ours: { status: number; out: string; err: string };
      try {
        const r = await git.revParse().setRevision(rev).call();
        ours = { status: 0, out: `${r.objectId}\n`, err: "" };
      } catch (error) {
        const output = error instanceof RevisionError ? error.output : [];
        ours = {
          status: 128,
          out: output.map((l) => `${l}\n`).join(""),
          err: `${(error as Error).message}\n`,
        };
      }
      expect([rev, ours]).toEqual([rev, { status: n.status, out: n.stdout, err: n.stderr }]);
    }
  });

  it("<rev>:./<path> and <rev>:../<path> relative to the current directory", async () => {
    const sub = join(repo, "d", "e");
    const git = await open(repo);
    for (const rev of [
      "HEAD:./c.txt",
      "HEAD:../b.txt",
      "HEAD:../../a.txt",
      "HEAD:./",
      "HEAD:../",
      ":./c.txt",
      ":../b.txt",
      "HEAD:c.txt",
      "HEAD:.//c.txt",
      "HEAD:./../e/./c.txt",
      "HEAD:../../../x",
    ]) {
      const n = spawnSync("git", ["rev-parse", "--verify", rev], {
        cwd: sub,
        env: envAt(),
        encoding: "latin1",
      });
      let ours: { status: number; out: string; err: string };
      try {
        const r = await git.revParse().setPrefix("d/e").setRevision(rev).call();
        ours = { status: 0, out: `${r.objectId}\n`, err: "" };
      } catch (error) {
        ours = { status: 128, out: "", err: `${(error as Error).message}\n` };
      }
      // git names the worktree's absolute path, which ours does not know
      const err = n.stderr.replace(/ at '[^']*'\n$/, "\n");
      expect([rev, ours]).toEqual([rev, { status: n.status, out: n.stdout, err }]);
    }
  });
});

/** `git rev-parse --verify <rev>` by native git and ours, stdout printed before a death included. */
async function expectSameVerify(repo: string, revs: string[]): Promise<void> {
  const git = await open(repo);
  for (const rev of revs) {
    const n = spawnSync("git", ["rev-parse", "--verify", rev], {
      cwd: repo,
      env: envAt(),
      encoding: "latin1",
    });
    let ours: { status: number; out: string; err: string };
    try {
      const r = await git.revParse().setRevision(rev).call();
      ours = { status: 0, out: `${r.objectId}\n`, err: r.warnings.map((w) => `${w}\n`).join("") };
    } catch (error) {
      const output = error instanceof RevisionError ? error.output : [];
      ours = {
        status: 128,
        out: output.map((l) => `${l}\n`).join(""),
        err: `${(error as Error).message}\n`,
      };
    }
    expect([rev, ours]).toEqual([rev, { status: n.status, out: n.stdout, err: n.stderr }]);
  }
}

describeGit("revision arguments: --not alone, .., non-commits, core.disambiguate", () => {
  let repo = "";
  let blob = "";
  let tree = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "revision-args-native-"));
    home = join(root, "home");
    mkdirSync(home);
    repo = buildRanges(join(root, "base"));
    blob = run(repo, undefined, "rev-parse", "main:a.txt").trim();
    tree = run(repo, undefined, "rev-parse", "main^{tree}").trim();
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("log: --not alone falls back to HEAD; .. is HEAD..HEAD as before --", async () => {
    await expectSameLog(repo, [
      ["--not"],
      ["--not", "--not"],
      [".."],
      ["..", "feat"],
      ["--not", ".."],
      ["...", "side"],
    ]);
  });

  it("log: a symmetric difference or an ancestor of a tree or blob says it is no commit", async () => {
    await expectSameLog(repo, [
      ["main...main^{tree}"],
      ["main^{tree}...main"],
      [`main...${blob.slice(0, 7)}~0`],
      [`${blob.slice(0, 7)}~0`],
      [`${tree}^`],
      ["main^{tree}^!"],
      [`${blob}^@`],
      ["main..main^{tree}"],
    ]);
  });

  it("rev-parse: lookup_commit_reference's error for a side or a parent that is no commit", async () => {
    await expectSameRevParse(repo, [
      ["main...main^{tree}"],
      ["main^{tree}...main"],
      ["va...main^{tree}"],
      ["main", "feat...main^{tree}"],
      ["main^{tree}^!"],
      [`${blob}^!`],
      [`${blob.slice(0, 7)}^@`],
      ["main^{tree}^-"],
      ["main^{tree}~0"],
      [`${blob.slice(0, 7)}~0`],
      [`^${tree.slice(0, 7)}^`],
      ["main", "main^{tree}~1"],
      ["main..main^{tree}"],
    ]);
  });

  it("rev-parse --verify: the error, and a symmetric difference's sides printed first", async () => {
    await expectSameVerify(repo, [
      "main...main^{tree}",
      "va...main^{tree}",
      "main^{tree}^!",
      `${blob.slice(0, 7)}^@`,
      `${blob.slice(0, 7)}~0`,
      `${blob}~0`,
      `${tree.slice(0, 7)}^`,
      "main^{tree}^0",
    ]);
  });

  it("core.disambiguate that git does not know dies with the file and line", async () => {
    const config = join(repo, ".git", "config");
    const original = readFileSync(config, "latin1");
    const revs = ["HEAD", "main~1", blob.slice(0, 7), "main..feat"];
    try {
      for (const value of ["foo", "", "yes", "1", "Commit", "none"]) {
        run(repo, undefined, "config", "core.disambiguate", value);
        await expectSameVerify(repo, revs);
      }
      // a variable without `=` (missing value), after a valid one: the first bad one dies
      writeFileSync(config, `${original}[core]\n\tdisambiguate = commit\n\tdisambiguate\n`);
      await expectSameVerify(repo, revs);
      writeFileSync(
        config,
        `${original}[core]\n\tdisambiguate = bad ; comment\n\tdisambiguate = commit\n`,
      );
      await expectSameVerify(repo, revs);
      // the global file, named as git names it
      writeFileSync(config, original);
      writeFileSync(join(home, ".gitconfig"), "[core]\n# first\n disambiguate=Nope\n");
      await expectSameVerify(repo, revs);
    } finally {
      writeFileSync(config, original);
      rmSync(join(home, ".gitconfig"), { force: true });
    }
  });
});
