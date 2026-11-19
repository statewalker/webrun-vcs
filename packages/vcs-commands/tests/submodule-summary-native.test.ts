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

import type { SubmoduleDiffFormat } from "../src/index.js";
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
