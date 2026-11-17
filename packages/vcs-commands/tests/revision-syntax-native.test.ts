/**
 * git's revision syntax against native `git rev-parse --verify`: one repository built by
 * native git, every revision resolved by both (the id on stdout, or the exact `fatal:`
 * line; `warning:` lines compared too). Reflog entries are dated relative to now, so
 * `@{<date>}` lookups land between them for both.
 */
import { execFileSync, spawnSync } from "node:child_process";
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
import { Git, ResetMode } from "../src/index.js";
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
