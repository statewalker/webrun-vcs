/**
 * Submodule summaries against native git: `git diff --submodule=log|diff|short` (submodule.c
 * `show_submodule_diff_summary`, `show_submodule_inline_diff`), `log -p --submodule`, the
 * long status's "Submodule changes to be committed:" / "Submodules changed but not
 * updated:" sections (`status.submoduleSummary`, also in the commit template) and
 * `git submodule summary` with its options (builtin/submodule--helper.c `module_summary`).
 * The submodules move forward, rewind, diverge, are added, deleted, not checked out, point
 * at commits they lack, hold changes of their own, and replace a file or are replaced by
 * one. Every output is compared byte for byte with the git on PATH.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DiffCommand, DiffOutputFormat, SubmoduleDiffFormat } from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, openRepo, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let clock = 1_700_000_000;
/** Native git, each call a second later (commit dates order the walks). */
const git = (cwd: string, args: string[], extra: Record<string, string> = {}) => {
  clock++;
  const date = `${clock} +0000`;
  return gitOut(root, cwd, args, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, ...extra });
};
const bytesOf = (text: string) => Buffer.from(encodeGitPath(text)).toString("latin1");
const ADD = ["-c", "protocol.file.allow=always", "submodule", "add", "-q"];

/** The upstream of the submodules: c1..c5 on main, s1..s2 on a side branch from c2. */
function upstream(dir: string): Record<string, string> {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  const ids: Record<string, string> = {};
  for (const n of [1, 2, 3, 4, 5]) {
    putFile(dir, "f.txt", `line ${n}\n`);
    putFile(dir, `n${n}.txt`, `${n}\n`);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", `commit ${n}`]);
    ids[`c${n}`] = git(dir, ["rev-parse", "HEAD"]).trim();
  }
  git(dir, ["checkout", "-q", "-b", "side", ids.c2 as string]);
  for (const n of [1, 2]) {
    putFile(dir, "f.txt", `side ${n}\n`);
    git(dir, ["commit", "-qam", `side ${n}`]);
    ids[`s${n}`] = git(dir, ["rev-parse", "HEAD"]).trim();
  }
  git(dir, ["checkout", "-q", "main"]);
  return ids;
}

/** Moves the submodule at `path` to `id`. */
function moveTo(dir: string, path: string, id: string) {
  git(join(dir, path), ["checkout", "-q", "--detach", id]);
}

/**
 * A superproject with submodules in every state: `ff` moved forward (unstaged, dirty
 * inside), `rw` rewound (staged), `dv` diverged (unstaged), `nw` added, `gone` deleted,
 * `nco` not checked out (another commit staged), `miss` at a commit it lacks, `b2s` a file
 * replaced by a submodule, `s2b` a submodule replaced by a file, `rmd` one whose directory
 * is gone.
 */
function superproject(dir: string, up: string, ids: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, "a.txt", "a\n");
  putFile(dir, "b2s", "a file\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  for (const name of ["ff", "rw", "dv", "gone", "nco", "miss", "s2b", "rmd"])
    git(dir, [...ADD, up, name]);
  moveTo(dir, "ff", ids.c2 as string);
  moveTo(dir, "rw", ids.c4 as string);
  moveTo(dir, "dv", ids.c3 as string);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "submodules"]);
  // forward, with changes of its own
  moveTo(dir, "ff", ids.c4 as string);
  putFile(join(dir, "ff"), "f.txt", "dirty\n");
  putFile(join(dir, "ff"), "untracked.txt", "u\n");
  // rewound, staged
  moveTo(dir, "rw", ids.c2 as string);
  git(dir, ["add", "rw"]);
  // diverged
  moveTo(dir, "dv", ids.s2 as string);
  // added
  git(dir, [...ADD, up, "nw"]);
  // deleted
  git(dir, ["rm", "-q", "gone"]);
  // not checked out, another commit staged
  git(dir, ["submodule", "deinit", "-q", "-f", "nco"]);
  git(dir, ["update-index", "--cacheinfo", `160000,${ids.c1},nco`]);
  // a commit the submodule lacks
  git(dir, ["update-index", "--cacheinfo", `160000,${"1234567".repeat(5)}abcde,miss`]);
  // a file replaced by a submodule
  git(dir, ["rm", "-q", "b2s"]);
  git(dir, [...ADD, "--name", "b2s", up, "b2s"]);
  // a submodule replaced by a file
  git(dir, ["rm", "-q", "s2b"]);
  putFile(dir, "s2b", "now a file\n");
  git(dir, ["add", "s2b"]);
  // a submodule whose directory is gone (its repository kept in .git/modules)
  rmSync(join(dir, "rmd"), { recursive: true, force: true });
}

/** Our `git diff` text with the submodule format given (and `--cached`). */
async function ourDiff(dir: string, format: SubmoduleDiffFormat | undefined, cached: boolean) {
  const diff = (await openRepo(root, dir)).diff();
  if (cached) diff.setCached(true);
  if (format) diff.setSubmoduleFormat(format);
  return bytesOf(await diff.callText("patch"));
}

async function expectDiffs(dir: string, label: string) {
  for (const format of ["log", "diff", "short", undefined] as const) {
    for (const cached of [false, true]) {
      const args = [
        "diff",
        ...(format ? [`--submodule=${format}`] : []),
        ...(cached ? ["--cached"] : []),
      ];
      expect(await ourDiff(dir, format, cached), `${label}: ${args.join(" ")}`).toBe(
        git(dir, args),
      );
    }
  }
}

/** `git submodule summary` with the options given, ours configured alike. */
async function expectSummary(dir: string, args: string[], label: string) {
  const command = (await openRepo(root, dir)).submoduleSummary();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--cached") command.setCached(true);
    else if (a === "--files") command.setFiles(true);
    else if (a === "--for-status") command.setForStatus(true);
    else if (a === "-n") command.setSummaryLimit(Number(args[++i]));
    else rest.push(a);
  }
  const sep = rest.indexOf("--");
  const commitArgs = sep < 0 ? rest : rest.slice(0, sep);
  const paths = sep < 0 ? [] : rest.slice(sep + 1);
  if (commitArgs[0] !== undefined) command.setCommit(commitArgs[0]);
  for (const p of [...commitArgs.slice(1), ...paths]) command.addPath(p);
  const ours = bytesOf(await command.call());
  expect(ours, `${label}: submodule summary ${args.join(" ")}`).toBe(
    git(dir, ["submodule", "summary", ...args]),
  );
}

async function expectStatus(dir: string, label: string) {
  for (const value of ["true", "1", "2", "0", "false"]) {
    git(dir, ["config", "status.submoduleSummary", value]);
    try {
      for (const prefix of [false, true]) {
        const config = prefix ? ["-c", "status.displayCommentPrefix=true"] : [];
        const command = (await openRepo(root, dir)).status();
        const ours = await command.callText(
          prefix ? { format: "long", commentPrefix: "#" } : { format: "long" },
        );
        expect(bytesOf(ours.text), `${label}: status.submoduleSummary=${value} ${config}`).toBe(
          git(dir, [...config, "status"]),
        );
      }
    } finally {
      git(dir, ["config", "--unset", "status.submoduleSummary"]);
    }
  }
}

describeGit("submodule summaries: as native git", () => {
  let dir: string;
  let ids: Record<string, string>;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "submodule-summary-"));
    const up = join(root, "up");
    ids = upstream(up);
    dir = join(root, "r");
    superproject(dir, up, ids);
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("git diff --submodule=log, diff and short, of the worktree and the index", async () => {
    await expectDiffs(dir, "all states");
    // diff.submodule decides without the option
    for (const value of ["log", "diff"]) {
      git(dir, ["config", "diff.submodule", value]);
      try {
        for (const cached of [false, true]) {
          expect(await ourDiff(dir, undefined, cached), `diff.submodule=${value}`).toBe(
            git(dir, ["diff", ...(cached ? ["--cached"] : [])]),
          );
        }
      } finally {
        git(dir, ["config", "--unset", "diff.submodule"]);
      }
    }
  }, 120_000);

  it("the ignore configuration hides submodules from the diffs and the summaries", async () => {
    for (const [key, value] of [
      ["submodule.ff.ignore", "all"],
      ["submodule.ff.ignore", "dirty"],
      ["submodule.ff.ignore", "untracked"],
      ["submodule.ff.ignore", "none"],
      ["submodule.rw.ignore", "all"],
      ["diff.ignoreSubmodules", "all"],
      ["diff.ignoreSubmodules", "none"],
    ] as const) {
      git(dir, ["config", key, value]);
      try {
        const label = `${key}=${value}`;
        await expectDiffs(dir, label);
        for (const args of [
          [],
          ["--cached"],
          ["--files"],
          ["--for-status"],
          ["--cached", "--for-status"],
        ]) {
          await expectSummary(dir, args, label);
        }
        git(dir, ["config", "status.submoduleSummary", "true"]);
        const ours = await (await openRepo(root, dir)).status().callText({ format: "long" });
        expect(bytesOf(ours.text), `${label}: status`).toBe(git(dir, ["status"]));
      } finally {
        git(dir, ["config", "--unset", key]);
        gitRun(root, dir, ["config", "--unset", "status.submoduleSummary"]);
      }
    }
  }, 240_000);

  it("git submodule summary: --cached, --files, -n, a commit, paths, --for-status", async () => {
    for (const args of [
      [],
      ["--cached"],
      ["--files"],
      ["--for-status"],
      ["-n", "1"],
      ["-n", "2"],
      ["-n", "0"],
      ["--cached", "-n", "1"],
      ["--files", "-n", "1"],
      ["HEAD~1"],
      ["--cached", "HEAD~1"],
      ["--", "ff", "dv"],
      ["HEAD", "--", "rw"],
      ["dv"],
      ["--cached", "--", "b2s", "s2b", "gone"],
    ]) {
      await expectSummary(dir, args, "all states");
    }
  }, 120_000);

  it("the long status: status.submoduleSummary as a boolean and as limits 0, 1 and N", async () => {
    await expectStatus(dir, "all states");
  }, 120_000);

  it("log -p and show with --submodule=log and diff", async () => {
    const twin = join(root, "log");
    execFileSync("cp", ["-a", dir, twin]);
    git(twin, ["add", "-A"]);
    git(twin, ["commit", "-qm", "submodule moves"]);
    for (const format of ["log", "diff", "short"] as const) {
      const ours = await (await openRepo(root, twin))
        .log()
        .setMaxCount(2)
        .setDiffOptions({ submoduleFormat: format })
        .callText({ patch: true });
      expect(bytesOf(ours), `log -p --submodule=${format}`).toBe(
        git(twin, ["log", "-2", "-p", `--submodule=${format}`]),
      );
    }
    rmSync(twin, { recursive: true, force: true });
  }, 120_000);

  it("the commit template lists the submodule summaries and the -v diff", async () => {
    git(dir, ["config", "status.submoduleSummary", "1"]);
    git(dir, ["config", "diff.submodule", "log"]);
    try {
      const editor = join(root, "editor.sh");
      writeFileSync(editor, '#!/bin/sh\ncp "$1" "$COPY_TO"\nexit 1\n');
      chmodSync(editor, 0o755);
      for (const verbose of [0, 1]) {
        const copy = join(root, "template.txt");
        rmSync(copy, { force: true });
        gitRun(root, dir, ["commit", ...(verbose ? ["-v"] : [])], {
          GIT_EDITOR: editor,
          COPY_TO: copy,
        });
        const expected = readFileSync(copy).toString("latin1");
        let seen: string | undefined;
        const command = (await openRepo(root, dir)).commit().setVerbose(verbose);
        command.setEditor(async (_path: string, text: string) => {
          seen = text;
          throw new Error("editor aborted");
        });
        await command.call().catch(() => undefined);
        expect(seen !== undefined ? bytesOf(seen) : seen, `template -v=${verbose}`).toBe(expected);
      }
    } finally {
      git(dir, ["config", "--unset", "status.submoduleSummary"]);
      git(dir, ["config", "--unset", "diff.submodule"]);
    }
  }, 120_000);
});

/** git's version as [major, minor]. */
function gitVersion(): [number, number] {
  const m = /(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"]).toString());
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

/** Copies `dir` to `to`, its stat data refreshed (`cp -a` changes ctime and inode). */
function copyRepo(dir: string, to: string): string {
  execFileSync("cp", ["-a", dir, to]);
  gitRun(root, to, ["update-index", "-q", "--refresh"]);
  return to;
}

/** Our `git diff` of `formats` with `configure` applied. */
async function ourFormats(
  dir: string,
  formats: DiffOutputFormat[],
  configure: (d: DiffCommand) => void = () => {},
): Promise<string> {
  const diff = (await openRepo(root, dir)).diff();
  configure(diff);
  const { bytes } = await diff.callFormats(formats);
  return bytes ? Buffer.from(bytes).toString("latin1") : "";
}

/** The diff formats the twins compare, as git's options and ours. */
const FORMATS: [string[], DiffOutputFormat[]][] = [
  [["--name-status"], ["name-status"]],
  [["--stat"], ["stat"]],
  [
    ["--stat", "-p"],
    ["stat", "patch"],
  ],
  [["-p"], ["patch"]],
  [["--numstat"], ["numstat"]],
  [["--summary"], ["summary"]],
];

describeGit("submodules in diff-index against the worktree, as native git", () => {
  let ids: Record<string, string>;
  /** A superproject with the submodule `sub` committed at c4. */
  let base: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "submodule-diff-index-"));
    const up = join(root, "up");
    ids = upstream(up);
    base = join(root, "base");
    mkdirSync(base);
    git(base, ["init", "-q", "-b", "main"]);
    putFile(base, "a.txt", "a\n");
    git(base, ["add", "a.txt"]);
    git(base, ["commit", "-qm", "base"]);
    git(base, [...ADD, up, "sub"]);
    moveTo(base, "sub", ids.c4 as string);
    git(base, ["add", "sub"]);
    git(base, ["commit", "-qm", "sub at c4"]);
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  async function expectFormats(dir: string, rev: string, label: string, extra: string[] = []) {
    for (const [args, formats] of FORMATS) {
      for (const submodule of [undefined, "log", "diff"] as const) {
        if (submodule && !formats.includes("patch")) continue;
        const gitArgs = [
          "diff",
          ...extra,
          ...args,
          ...(submodule ? [`--submodule=${submodule}`] : []),
          rev,
        ];
        const ours = await ourFormats(dir, formats, (d) => {
          d.setOldTree(rev);
          if (extra.includes("-M")) d.setRenames(true);
          if (submodule) d.setSubmoduleFormat(submodule);
        });
        expect(ours, `${label}: ${gitArgs.join(" ")}`).toBe(git(dir, gitArgs));
      }
    }
  }

  it("a gitlink whose submodule HEAD differs from its entry, though it equals the tree", async () => {
    const dir = copyRepo(base, join(root, "back"));
    // HEAD records c2; the index c4; the submodule is back at c2
    moveTo(dir, "sub", ids.c2 as string);
    git(dir, ["commit", "-qam", "sub at c2"]);
    moveTo(dir, "sub", ids.c4 as string);
    git(dir, ["add", "sub"]);
    moveTo(dir, "sub", ids.c2 as string);
    await expectFormats(dir, "HEAD", "clean");
    for (const args of [[], ["--cached"], ["--files"], ["HEAD~1"]]) {
      await expectSummary(dir, args, "back at the tree's commit");
    }
    // with modified content in the submodule
    putFile(join(dir, "sub"), "f.txt", "dirty\n");
    await expectFormats(dir, "HEAD", "dirty");
    git(join(dir, "sub"), ["checkout", "-q", "--", "."]);
    // an index entry naming a commit the submodule lacks
    git(dir, ["update-index", "--cacheinfo", `160000,${"1234567".repeat(5)}abcde,sub`]);
    await expectFormats(dir, "HEAD", "missing commit");
    await expectFormats(dir, "HEAD~1", "missing commit, older tree");
    for (const args of [[], ["--cached"], ["--files"], ["HEAD~1"]]) {
      await expectSummary(dir, args, "missing commit");
    }
  }, 120_000);

  it("gitlinks renamed against the worktree are an add and a delete, as git pairs none", async () => {
    const dir = copyRepo(base, join(root, "ren"));
    git(dir, ["mv", "sub", "ren"]);
    moveTo(dir, "ren", ids.c5 as string);
    await expectFormats(dir, "HEAD", "renamed and moved", ["-M"]);
    // the index at c5, the submodule back at the tree's commit: git's null worktree side
    // pairs with nothing
    git(dir, ["add", "ren"]);
    moveTo(dir, "ren", ids.c4 as string);
    await expectFormats(dir, "HEAD", "renamed, back at the tree's commit", ["-M"]);
    moveTo(dir, "ren", ids.c5 as string);
    git(dir, ["commit", "-qm", "renamed"]);
    moveTo(dir, "ren", ids.c3 as string);
    await expectFormats(dir, "HEAD~1", "renamed, moved again", ["-M"]);
  }, 120_000);

  it("diff.submodule: the last value git knows, a warning for each other one", async () => {
    const dir = copyRepo(base, join(root, "config"));
    moveTo(dir, "sub", ids.c2 as string);
    const cases: string[][] = [
      ["log", "bogus"],
      ["log", "bogus", "short", "Log"],
      ["diff", ""],
      ["short", "log"],
    ];
    for (const values of cases) {
      gitRun(root, dir, ["config", "--unset-all", "diff.submodule"]);
      for (const v of values) git(dir, ["config", "--add", "diff.submodule", v]);
      const native = gitRun(root, dir, ["diff"]);
      const diff = (await openRepo(root, dir)).diff();
      const ours = bytesOf(await diff.callText("patch"));
      const label = `diff.submodule=${values.join(",")}`;
      expect(ours, label).toBe(native.stdout);
      expect(diff.warnings.map((w) => `${w}\n`).join(""), label).toBe(native.stderr);
    }
    // a variable without a value: git 2.5x fails reading the configuration (2.43 crashes)
    gitRun(root, dir, ["config", "--unset-all", "diff.submodule"]);
    writeFileSync(
      join(dir, ".git/config"),
      `${readFileSync(join(dir, ".git/config"), "latin1")}[diff]\n\tsubmodule\n`,
    );
    const line = readFileSync(join(dir, ".git/config"), "latin1").split("\n").length - 1;
    const expected =
      "error: missing value for 'diff.submodule'\n" +
      `fatal: bad config variable 'diff.submodule' in file '.git/config' at line ${line}\n`;
    const [major, minor] = gitVersion();
    if (major > 2 || minor >= 50) {
      const native = gitRun(root, dir, ["diff", "--submodule=log"]);
      expect(native.status).toBe(128);
      expect(native.stderr).toBe(expected);
    }
    for (const format of ["patch", "stat"] as const) {
      const diff = (await openRepo(root, dir)).diff().setSubmoduleFormat("log");
      const error = await diff.callText(format).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(error?.name, format).toBe("InvalidConfigError");
      expect(`${error?.message}\n`, format).toBe(expected);
    }
  }, 120_000);

  it("--submodule=diff: a missing ancestor is a corrupt repository (git 2.45 and later)", async () => {
    const dir = copyRepo(base, join(root, "corrupt"));
    moveTo(dir, "sub", ids.s1 as string);
    const c3 = ids.c3 as string;
    rmSync(join(dir, ".git/modules/sub/objects", c3.slice(0, 2), c3.slice(2)));
    const ours = await ourFormats(dir, ["patch"], (d) => d.setSubmoduleFormat("diff"));
    let native = git(dir, ["diff", "--submodule=diff"]);
    const [major, minor] = gitVersion();
    // paint_down_to_common reports the missing commit from git 2.45 on; older git walks past
    // it and prints the plain header
    if (major === 2 && minor < 45) native = native.replace(/:\n/, " (corrupt repository)\n");
    expect(native).toContain(" (corrupt repository)\n");
    expect(ours).toBe(native);
  }, 120_000);
});

describeGit("committing and adding a submodule whose .git is a gitfile, as native git", () => {
  let ids: Record<string, string>;
  let base: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "submodule-commit-only-"));
    const up = join(root, "up");
    ids = upstream(up);
    base = join(root, "base");
    mkdirSync(base);
    git(base, ["init", "-q", "-b", "main"]);
    putFile(base, "a.txt", "a\n");
    git(base, ["add", "a.txt"]);
    git(base, ["commit", "-qm", "base"]);
    // `submodule add` leaves a gitfile at sub/.git, the repository in .git/modules/sub
    git(base, [...ADD, up, "sub"]);
    git(base, ["commit", "-qm", "sub"]);
    moveTo(base, "sub", ids.c3 as string);
    putFile(base, "a.txt", "a2\n");
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const date = "1800000000 +0000";
  const dated = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const state = (dir: string) => ({
    head: git(dir, ["rev-parse", "HEAD"]),
    tree: git(dir, ["ls-tree", "-r", "HEAD"]),
    index: git(dir, ["ls-files", "-s"]),
    status: git(dir, ["status", "--porcelain"]),
  });

  it("commit --only <submodule> commits the commit checked out (and its dry run)", async () => {
    const native = copyRepo(base, join(root, "only-native"));
    const ours = copyRepo(base, join(root, "only-ours"));
    expect(readFileSync(join(ours, "sub/.git"), "latin1")).toMatch(/^gitdir: /);
    // the dry run first: nothing changes
    const dry = gitRun(root, native, ["commit", "--dry-run", "--only", "sub"], dated);
    const ourDry = await (await openRepo(root, ours, dated)).commit().setOnly("sub").callDryRun();
    expect(bytesOf(ourDry.text)).toBe(dry.stdout);
    expect(ourDry.exitCode).toBe(dry.status);
    expect(state(ours)).toEqual(state(native));
    gitOut(root, native, ["commit", "-q", "-m", "move sub", "--only", "sub"], dated);
    await (await openRepo(root, ours, dated)).commit().setMessage("move sub").setOnly("sub").call();
    expect(state(ours)).toEqual(state(native));
    expect(git(native, ["ls-tree", "HEAD", "sub"])).toContain(ids.c3 as string);
  }, 120_000);

  it("add <submodule> stages the commit checked out", async () => {
    const native = copyRepo(base, join(root, "add-native"));
    const ours = copyRepo(base, join(root, "add-ours"));
    git(native, ["add", "sub"]);
    await (await openRepo(root, ours)).add().addFilepattern("sub").call();
    expect(state(ours)).toEqual(state(native));
  }, 120_000);
});
