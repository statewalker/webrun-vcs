/**
 * Replace refs and grafts in history walks, against native git: `git log`, `git rev-list`,
 * `git rev-parse` (parents such as `HEAD~2`, the merge bases of `a...b`) read a commit
 * replaced by `refs/replace/<id>` as its replacement (keeping its id) and a commit named in
 * `info/grafts` with the grafted parents; `--no-replace-objects`, `GIT_NO_REPLACE_OBJECTS` and
 * `core.useReplaceRefs=false` turn replace refs off.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, type LogResult } from "../src/index.js";
import { git, gitOk, normalizeState, openOurs, put, snapshot } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let n = 0;
const g = (dir: string, ...args: string[]) => gitOk(root, dir, ...args).trim();

/**
 * main: one - two - three - four, then a merge of side; side forks at one (side1, side2).
 * Each commit is tagged with its name.
 */
function repo(): { dir: string; ids: Record<string, string> } {
  const dir = join(root, `r${n++}`);
  g(root, "init", "-q", "-b", "main", dir);
  const ids: Record<string, string> = {};
  const commit = (name: string) => {
    put(dir, `${name}.txt`, `${name}\n`);
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", name, "-m", `body of ${name}`);
    ids[name] = g(dir, "rev-parse", "HEAD");
    g(dir, "tag", name);
  };
  commit("one");
  commit("two");
  commit("three");
  g(dir, "checkout", "-q", "-b", "side", ids.one as string);
  commit("side1");
  commit("side2");
  g(dir, "checkout", "-q", "main");
  commit("four");
  g(dir, "merge", "-q", "--no-ff", "-m", "merge side", "side");
  ids.merge = g(dir, "rev-parse", "HEAD");
  return { dir, ids };
}

const FORMAT = "%H %P %T %an %s";
const line = (c: LogResult) =>
  `${c.id} ${c.parents.join(" ")} ${c.tree} ${c.author.name} ${c.message.split("\n")[0]}`;

async function oursLog(ours: Git, args: string[], configure = (c: unknown) => c) {
  const command = ours.revList();
  configure(command);
  for (const arg of args) command.addArgument(arg);
  const out: string[] = [];
  for await (const c of await command.call()) out.push(line(c));
  return out;
}

const nativeLog = (dir: string, args: string[], env: string[] = []) =>
  g(dir, ...env, "log", `--format=${FORMAT}`, ...args)
    .split("\n")
    .filter((l) => l !== "");

async function oursRevParse(ours: Git, args: string[]): Promise<string[]> {
  const command = ours.revParse();
  for (const arg of args) command.addArgument(arg);
  return [...(await command.call()).lines];
}

const nativeRevParse = (dir: string, args: string[], env: string[] = []) =>
  g(dir, ...env, "rev-parse", ...args)
    .split("\n")
    .filter((l) => l !== "");

describeGit("replace refs and grafts in history walks, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "replace-grafts-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("grafts: log, rev-list, parents and merge bases follow the grafted parents", async () => {
    const { dir, ids } = repo();
    // four's parent becomes one (two and three leave main's history); side2 becomes a root
    writeFileSync(
      join(dir, ".git", "info", "grafts"),
      `# grafts\n${ids.four} ${ids.one}\n${ids.side2}\nbad line\n`,
    );
    const ours = await openOurs(dir);
    for (const args of [["main"], ["main", "--", "two.txt"], ["side..main"], ["main...three"]]) {
      expect(await oursLog(ours, args)).toEqual(nativeLog(dir, args));
    }
    for (const args of [
      ["main~1"],
      ["main~2"],
      ["main^2"],
      ["four~1"],
      ["main...three"],
      ["side...four"],
    ]) {
      expect(await oursRevParse(await openOurs(dir), args)).toEqual(nativeRevParse(dir, args));
    }
    expect(g(dir, "merge-base", "--all", ids.three as string, ids.merge as string)).toBe(ids.one);
  });

  it("replace refs: the replacement's content under the replaced id, and turned off", async () => {
    const { dir, ids } = repo();
    // three is replaced by a commit of another message whose parent is one
    const tree = g(dir, "rev-parse", `${ids.three}^{tree}`);
    const replacement = g(dir, "commit-tree", "-p", ids.one as string, "-m", "replaced", tree);
    g(dir, "replace", ids.three as string, replacement);
    // and side2 by four (a replacement's own replacement is followed)
    g(dir, "replace", ids.side2 as string, ids.four as string);
    const ours = await openOurs(dir);
    for (const args of [["main"], ["main", "--", "two.txt"], ["side..main"], ["main...two"]]) {
      expect(await oursLog(ours, args)).toEqual(nativeLog(dir, args));
    }
    for (const args of [["main~2"], ["main~3"], ["main^2"], ["main^2~1"], ["main...two"]]) {
      expect(await oursRevParse(await openOurs(dir), args)).toEqual(nativeRevParse(dir, args));
    }
    // --no-replace-objects
    const off = (c: unknown) =>
      (c as { setUseReplaceRefs(u: boolean): void }).setUseReplaceRefs(false);
    expect(await oursLog(await openOurs(dir), ["main"], off)).toEqual(
      nativeLog(dir, ["main"], ["--no-replace-objects"]),
    );
    // GIT_NO_REPLACE_OBJECTS
    const environment = createNodeGitHostEnvironment({
      env: { ...nativeGitEnv(root), GIT_NO_REPLACE_OBJECTS: "1" },
    });
    const noReplace = git(root, dir, "-c", "core.useReplaceRefs=false", "log", `--format=${FORMAT}`)
      .stdout.split("\n")
      .filter((l) => l !== "");
    expect(await oursLog(await openOurs(dir, environment), ["main"])).toEqual(noReplace);
    // core.useReplaceRefs=false
    g(dir, "config", "core.useReplaceRefs", "false");
    expect(await oursLog(await openOurs(dir), ["main"])).toEqual(noReplace);
    expect(await oursRevParse(await openOurs(dir), ["main~2"])).toEqual(
      nativeRevParse(dir, ["main~2"]),
    );
  });

  it("grafts and replace refs together: a replaced commit keeps its own id's graft", async () => {
    const { dir, ids } = repo();
    const tree = g(dir, "rev-parse", `${ids.two}^{tree}`);
    const replacement = g(dir, "commit-tree", "-p", ids.one as string, "-m", "two again", tree);
    g(dir, "replace", ids.two as string, replacement);
    writeFileSync(join(dir, ".git", "info", "grafts"), `${ids.two}\n${ids.merge} ${ids.three}\n`);
    expect(await oursLog(await openOurs(dir), ["main"])).toEqual(nativeLog(dir, ["main"]));
    expect(await oursLog(await openOurs(dir), ["main", "--", "one.txt"])).toEqual(
      nativeLog(dir, ["main", "--", "one.txt"]),
    );
    expect(await oursRevParse(await openOurs(dir), ["three~1", "main^", "main...two"])).toEqual(
      nativeRevParse(dir, ["three~1", "main^", "main...two"]),
    );
  });
});

/**
 * Porcelain commands read objects through replace refs and grafts as git does: merge bases,
 * fast-forward decisions, the trees a merge or checkout reads, the blobs a diff shows and
 * the HEAD tree status compares with. Each scenario runs native git in one copy and ours in
 * another, and compares the two repositories.
 */
describeGit("replace refs and grafts in porcelain commands, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "replace-grafts-porcelain-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const twins = (dir: string) => {
    const nd = join(root, `n${n}`);
    const od = join(root, `o${n++}`);
    cpSync(dir, nd, { recursive: true });
    cpSync(dir, od, { recursive: true });
    return { nd, od };
  };
  /** Native git fed `input` on stdin; its trimmed stdout. */
  const gitIn = (dir: string, args: string[], input: string) =>
    execFileSync("git", args, { cwd: dir, env: nativeGitEnv(root), input })
      .toString()
      .trim();
  const environment = () => createNodeGitHostEnvironment({ env: nativeGitEnv(root) });
  const open = (dir: string) => openOurs(dir, environment());
  const same = (od: string, nd: string) =>
    expect(snapshot(root, od, normalizeState)).toEqual(snapshot(root, nd, normalizeState));

  it("merge of a replaced side reads the replacement's tree and parents", async () => {
    // base: a; main: b, m; side: x. side's tip is replaced by a commit of base with a and c
    const dir = join(root, `r${n++}`);
    g(root, "init", "-q", "-b", "main", dir);
    put(dir, "a", "a\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "base");
    const base = g(dir, "rev-parse", "HEAD");
    g(dir, "checkout", "-q", "-b", "side");
    put(dir, "x", "x\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "side");
    const side = g(dir, "rev-parse", "HEAD");
    g(dir, "checkout", "-q", "main");
    put(dir, "b", "b\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "b");
    put(dir, "m", "m\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "m");
    const a = g(dir, "rev-parse", `${base}:a`);
    const blobC = gitIn(dir, ["hash-object", "-w", "--stdin"], "c\n");
    const tree = gitIn(dir, ["mktree"], `100644 blob ${a}\ta\n100644 blob ${blobC}\tc\n`);
    const replacement = g(dir, "commit-tree", "-p", base, "-m", "replaced side", tree);
    g(dir, "replace", side, replacement);
    const { nd, od } = twins(dir);
    g(nd, "merge", "-q", "--no-edit", "side");
    const result = await (await open(od)).merge().include("side").call();
    expect(result.status).toBeDefined();
    same(od, nd);
    expect(g(nd, "ls-tree", "--name-only", "HEAD").split("\n")).toEqual(["a", "b", "c", "m"]);
  });

  it("checkout and status of a replaced commit use the replacement's tree", async () => {
    const { dir, ids } = repo();
    const tree = g(dir, "rev-parse", `${ids.side2}^{tree}`);
    const replacement = g(dir, "commit-tree", "-p", ids.two as string, "-m", "other", tree);
    g(dir, "replace", ids.three as string, replacement);
    // revisions peel through the replacement too
    for (const rev of ["three^{tree}", "three:side2.txt", "three~1", "three^{commit}"]) {
      expect(await oursRevParse(await open(dir), [rev]), rev).toEqual(nativeRevParse(dir, [rev]));
    }
    const { nd, od } = twins(dir);
    g(nd, "checkout", "-q", "--detach", ids.three as string);
    await (await open(od))
      .checkout()
      .setName(ids.three as string)
      .call();
    same(od, nd);
    expect((await (await open(od)).status().call()).isClean()).toBe(true);
    // a replaced HEAD whose checkout native git made: our status agrees it is clean
    expect((await (await open(nd)).status().call()).isClean()).toBe(true);
    // reset --hard to it and back
    g(nd, "checkout", "-q", "main");
    await (await open(od)).checkout().setName("main").call();
    same(od, nd);
  });

  it("a replaced blob and tree: diff and checkout show the replacement's content", async () => {
    const { dir, ids } = repo();
    // three.txt's blob reads as other content; two's tree as side1's
    const blob = g(dir, "rev-parse", `${ids.three}:three.txt`);
    const replacementBlob = gitIn(dir, ["hash-object", "-w", "--stdin"], "replaced content\n");
    g(dir, "replace", blob, replacementBlob);
    g(
      dir,
      "replace",
      g(dir, "rev-parse", `${ids.two}^{tree}`),
      g(dir, "rev-parse", "side1^{tree}"),
    );
    for (const [a, b] of [
      ["two", "three"],
      ["one", "two"],
      ["one", "main"],
    ] as const) {
      const ours = Buffer.from(
        await (await open(dir)).diff().setOldTree(a).setNewTree(b).callBytes("patch"),
      ).toString();
      expect(ours).toBe(gitOk(root, dir, "diff", a, b));
    }
    const { nd, od } = twins(dir);
    g(nd, "checkout", "-q", "--detach", "two");
    await (await open(od)).checkout().setName("two").call();
    same(od, nd);
    g(nd, "checkout", "-q", "--detach", "three");
    await (await open(od)).checkout().setName("three").call();
    same(od, nd);
    expect(snapshot(root, od).files["three.txt"]).toBe("replaced content\n");
  });

  it("log -- <path> compares replaced trees", async () => {
    const { dir, ids } = repo();
    // two's tree reads as side1's: two.txt leaves it, side1.txt comes in
    g(
      dir,
      "replace",
      g(dir, "rev-parse", `${ids.two}^{tree}`),
      g(dir, "rev-parse", "side1^{tree}"),
    );
    for (const args of [
      ["main", "--", "two.txt"],
      ["main", "--", "side1.txt"],
      ["one..main", "--", "two.txt", "side1.txt"],
    ]) {
      expect(await oursLog(await open(dir), args), args.join(" ")).toEqual(nativeLog(dir, args));
    }
  });

  it("grafts decide fast-forwards, branch --contains and merge bases of a rebase", async () => {
    const { dir, ids } = repo();
    // side2's parent becomes four: merging side into four fast-forwards
    writeFileSync(join(dir, ".git", "info", "grafts"), `${ids.side1} ${ids.four}\n`);
    g(dir, "checkout", "-q", "-B", "work", ids.four as string);
    const { nd, od } = twins(dir);
    const native = g(nd, "merge", "side");
    expect(native).toContain("Fast-forward");
    const result = await (await open(od)).merge().include("side").call();
    expect(String(result.status)).toMatch(/fast/i);
    same(od, nd);
    // branch --contains four: work and side (through the graft), not main's older history
    const contains = (
      await (
        await open(od)
      )
        .branchList()
        .setContains(ids.four as string)
        .call()
    ).map((r) => r.name.replace(/^refs\/heads\//, ""));
    const nativeContains = g(nd, "branch", "--format=%(refname:short)", "--contains", "four")
      .split("\n")
      .filter(Boolean);
    expect(contains.sort()).toEqual(nativeContains.sort());
    // rebase main onto side: the graft makes four the merge base, so only the merge is new
    const r2 = twins(dir);
    g(r2.nd, "checkout", "-q", "side");
    await (await open(r2.od)).checkout().setName("side").call();
    const nativeRebase = git(root, r2.nd, "rebase", "work");
    await (await (await open(r2.od)).rebase().setUpstreamBranch("work")).call();
    expect(nativeRebase.status).toBe(0);
    same(r2.od, r2.nd);
  });
});

describeGit("replace ref names, grafts file and their messages, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "replace-grafts-messages-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** git 2.43 words the grafts advice differently: its hint lines are compared from 2.5x on */
  const modern = /git version 2\.(5\d|[6-9]\d)/.test(g(process.cwd(), "--version"));
  const stderrOf = (dir: string, args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync("git", args, {
      cwd: dir,
      env: { ...nativeGitEnv(root), ...env },
      encoding: "utf8",
    });
    return r.stderr.split("\n").filter((l) => l !== "");
  };
  const comparable = (lines: string[]) =>
    modern ? lines : lines.filter((l) => !l.startsWith("hint:"));

  it("log, rev-list and rev-parse print the replace and graft messages where git does", async () => {
    const { dir, ids } = repo();
    writeFileSync(join(dir, ".git", "info", "grafts"), `bad line\n${ids.three} ${ids.one}\n`);
    g(dir, "update-ref", "refs/replace/notahex", ids.two as string);
    const log = (await openOurs(dir)).log();
    for await (const _ of await log.call()) {
      // walked
    }
    expect(comparable(await log.replacementMessages())).toEqual(
      comparable(stderrOf(dir, ["log", "--oneline"])),
    );
    const list = (await openOurs(dir)).revList().addArgument("main");
    for await (const _ of await list.call()) {
      // walked
    }
    expect(comparable(await list.replacementMessages())).toEqual(
      comparable(stderrOf(dir, ["rev-list", "main"])),
    );
    for (const rev of ["main~1", "main^{tree}", "main"]) {
      const ours = await (await openOurs(dir)).revParse().setRevision(rev).call();
      expect(comparable(ours.warnings)).toEqual(comparable(stderrOf(dir, ["rev-parse", rev])));
    }
    // advice.graftFileDeprecated=false drops the advice
    g(dir, "config", "advice.graftFileDeprecated", "false");
    const quiet = await (await openOurs(dir)).revParse().setRevision("main~1").call();
    expect(quiet.warnings).toEqual(stderrOf(dir, ["rev-parse", "main~1"]));
  });

  it("refs/replace/<dir>/<id> replaces <id>; GIT_REPLACE_REF_BASE empty or elsewhere", async () => {
    const { dir, ids } = repo();
    const tree = g(dir, "rev-parse", `${ids.three}^{tree}`);
    const replacement = g(dir, "commit-tree", "-p", ids.one as string, "-m", "nested", tree);
    g(dir, "update-ref", `refs/replace/nested/dir/${ids.three}`, replacement);
    expect(await oursLog(await openOurs(dir), ["main"])).toEqual(nativeLog(dir, ["main"]));
    for (const base of ["", "refs/other/", "refs/replace/nested/"]) {
      const env = { GIT_REPLACE_REF_BASE: base };
      const environment = createNodeGitHostEnvironment({ env: { ...nativeGitEnv(root), ...env } });
      const native = spawnSync("git", ["log", `--format=${FORMAT}`, "main"], {
        cwd: dir,
        env: { ...nativeGitEnv(root), ...env },
        encoding: "utf8",
      });
      const ours = (await openOurs(dir, environment)).log();
      const lines: string[] = [];
      for await (const c of await ours.call()) lines.push(line(c));
      expect(lines, `GIT_REPLACE_REF_BASE=${base}`).toEqual(
        native.stdout.split("\n").filter((l) => l !== ""),
      );
      expect(await ours.replacementMessages()).toEqual(native.stderr.split("\n").filter(Boolean));
    }
  });

  it("GIT_GRAFT_FILE names the grafts file read in place of info/grafts", async () => {
    const { dir, ids } = repo();
    const file = join(root, `grafts-${n++}`);
    writeFileSync(file, `${ids.four} ${ids.one}\n`);
    writeFileSync(join(dir, ".git", "info", "grafts"), `${ids.four} ${ids.three} ${ids.side1}\n`);
    const env = { GIT_GRAFT_FILE: file };
    const environment = createNodeGitHostEnvironment({ env: { ...nativeGitEnv(root), ...env } });
    const native = spawnSync("git", ["log", `--format=${FORMAT}`, "main"], {
      cwd: dir,
      env: { ...nativeGitEnv(root), ...env },
      encoding: "utf8",
    }).stdout;
    const ours = (await openOurs(dir, environment)).log();
    const lines: string[] = [];
    for await (const c of await ours.call()) lines.push(line(c));
    expect(lines).toEqual(native.split("\n").filter((l) => l !== ""));
  });

  it("a relative GIT_GRAFT_FILE names a file in the worktree top, also run from a subdirectory", async () => {
    const { dir, ids } = repo();
    // git opens it after its setup has changed to the worktree top: the top's file counts,
    // not the one in the directory git is run from, nor the process's current directory
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "rel-grafts"), `${ids.four} ${ids.one}\n`);
    writeFileSync(join(dir, "sub", "rel-grafts"), `${ids.four}\n`);
    const env = { ...nativeGitEnv(root), GIT_GRAFT_FILE: "rel-grafts" };
    const native = spawnSync("git", ["log", `--format=${FORMAT}`, "main"], {
      cwd: join(dir, "sub"),
      env,
      encoding: "utf8",
    }).stdout;
    const expected = native.split("\n").filter((l) => l !== "");
    expect(expected.some((l) => l.includes(" two"))).toBe(false);
    const environment = createNodeGitHostEnvironment({ env });
    const files = createNodeFilesApi({ rootDir: dir });
    // the working copy knows its git directory on the host (log), the backend its files
    const { history } = await createGitFilesBackend({ files, environment });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
    const ours = Git.fromWorkingCopy(await worktrees.openCurrent());
    const lines: string[] = [];
    for await (const c of await ours.log().call()) lines.push(line(c));
    expect(lines).toEqual(expected);
    // the backend's own walks (rev-list through history.refs.readGrafts) read the same file
    expect(await history.refs.readGrafts?.()).toBe(`${ids.four} ${ids.one}\n`);
  });

  it("a shallow commit has no parents even when info/grafts gives it some", async () => {
    const { dir, ids } = repo();
    writeFileSync(join(dir, ".git", "info", "grafts"), `${ids.three} ${ids.one}\n`);
    writeFileSync(join(dir, ".git", "shallow"), `${ids.three}\n`);
    expect(await oursLog(await openOurs(dir), ["main"])).toEqual(nativeLog(dir, ["main"]));
    expect(await oursRevParse(await openOurs(dir), ["main~1", "four~1"])).toEqual(
      nativeRevParse(dir, ["main~1", "four~1"]),
    );
    const parents = await (await openOurs(dir)).revList().addArgument("three").call();
    const out: string[] = [];
    for await (const c of parents) out.push(line(c));
    expect(out).toEqual(nativeLog(dir, ["three"]));
  });
});
