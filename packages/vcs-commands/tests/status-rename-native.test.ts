/**
 * Status rename tuning (`--no-renames`, `--find-renames=<n>`, `status.renames`,
 * `status.renameLimit`, copies) and the verbose diffs of `status -v` / `-vv`, against native git
 * (statewalker-root#342). Each test names the git t/ script whose scenario it replays; the
 * whole output of each format is compared byte for byte.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { StatusCommand } from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitRun, openRepo, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string | undefined;
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
const home = () => {
  root ??= mkdtempSync(join(tmpdir(), "status-rename-"));
  return root;
};
let count = 0;

function repo(script: string): string {
  const dir = join(home(), `repo-${++count}`);
  execFileSync("mkdir", ["-p", dir]);
  execFileSync("bash", ["-ec", `git init -q -b main .\n${script}`], {
    cwd: dir,
    env: testEnv(home()),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return dir;
}

type Format = "long" | "short" | "porcelain" | "porcelain-v2";
const FORMAT_ARGS: Record<Format, string[]> = {
  long: [],
  short: ["--short"],
  porcelain: ["--porcelain"],
  "porcelain-v2": ["--porcelain=v2"],
};

/**
 * `git [-c config...] status <flags>` against our status built by `build`, in every format
 * (with `verbose`, the long one only), adding mismatches to `out`.
 */
async function twin(
  out: string[],
  dir: string,
  config: string[],
  flags: string[],
  build: (s: StatusCommand) => StatusCommand,
  verbose = 0,
): Promise<void> {
  const formats: Format[] = verbose ? ["long"] : ["long", "short", "porcelain", "porcelain-v2"];
  const env: Record<string, string> = {};
  config.forEach((c, i) => {
    const eq = c.indexOf("=");
    env[`GIT_CONFIG_KEY_${i + 2}`] = c.slice(0, eq);
    env[`GIT_CONFIG_VALUE_${i + 2}`] = c.slice(eq + 1);
  });
  env.GIT_CONFIG_COUNT = String(2 + config.length);
  for (const format of formats) {
    const args = [
      "status",
      ...flags,
      ...FORMAT_ARGS[format],
      ...(verbose ? [verbose === 1 ? "-v" : "-vv"] : []),
    ];
    const native = gitRun(home(), dir, args, env);
    const git = await openRepo(home(), dir, env);
    let mine: string;
    try {
      const r = await build(git.status()).callText({
        format,
        ...(verbose ? { verbose } : {}),
      });
      mine = Buffer.from(r.text, "utf8").toString("latin1");
    } catch (e) {
      mine = `threw ${(e as Error).message}`;
    }
    if (native.stdout !== mine) {
      out.push(
        `git ${config.map((c) => `-c ${c} `).join("")}${args.join(" ")}\n--- git\n${native.stdout}${native.stderr}--- ours\n${mine}`,
      );
    }
  }
}

/** t7525's setup: `original` renamed to `renamed` and edited, all staged */
const T7525_SETUP = `
  export GIT_AUTHOR_DATE="1112911993 +0000" GIT_COMMITTER_DATE="1112911993 +0000"
  echo 1 >original
  git add .
  git commit -q -m"Adding original file."
  mv original renamed
  echo 2 >> renamed
  git add .
  printf '.gitignore\\nexpect*\\nactual*\\n' >.gitignore
`;

describeGit("status rename detection options", () => {
  it('t7525-status-rename.sh: "status no-options", "status --no-renames", "status config overridden"', async () => {
    const dir = repo(T7525_SETUP);
    const out: string[] = [];
    await twin(out, dir, [], [], (s) => s);
    await twin(out, dir, [], ["--no-renames"], (s) => s.setRenames(false));
    await twin(out, dir, ["status.renames=true"], ["--no-renames"], (s) => s.setRenames(false));
    expect(out).toEqual([]);
  });

  it('t7525-status-rename.sh: "status.renames inherits from diff.renames false", "status.renames inherits from diff.renames true", "status.renames overrides diff.renames false", "status.renames overrides from diff.renames true", "status status.renames=false", "status status.renames=true"', async () => {
    const dir = repo(T7525_SETUP);
    const out: string[] = [];
    for (const config of [
      ["diff.renames=false"],
      ["diff.renames=true"],
      ["diff.renames=true", "status.renames=false"],
      ["diff.renames=false", "status.renames=true"],
      ["status.renames=false"],
      ["status.renames=true"],
    ]) {
      await twin(out, dir, config, [], (s) => s);
    }
    expect(out).toEqual([]);
  });

  it('t7525-status-rename.sh: "commit honors status.renames=false", "commit honors status.renames=true"', async () => {
    const dir = repo(T7525_SETUP);
    const out: string[] = [];
    for (const value of ["false", "true"]) {
      const env = {
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_2: "status.renames",
        GIT_CONFIG_VALUE_2: value,
      };
      const native = gitRun(home(), dir, ["commit", "--dry-run"], env);
      const git = await openRepo(home(), dir, env);
      const dry = await git.commit().callDryRun();
      if (dry.text !== native.stdout) {
        out.push(`commit --dry-run status.renames=${value}\n${native.stdout}---\n${dry.text}`);
      }
    }
    expect(out).toEqual([]);
  });

  it('t7525-status-rename.sh: "status score=100%", "status score=01%"', async () => {
    const dir = repo(T7525_SETUP);
    const out: string[] = [];
    for (const score of ["100%", "01%", "50%", "9", ".2"]) {
      await twin(out, dir, [], [`-M=${score}`], (s) => s.setFindRenames(`=${score}`));
      await twin(out, dir, [], [`--find-renames=${score}`], (s) => s.setFindRenames(score));
      await twin(out, dir, ["status.renames=false"], [`--find-renames=${score}`], (s) =>
        s.setFindRenames(score),
      );
    }
    await twin(out, dir, ["diff.renames=false"], ["-M"], (s) => s.setFindRenames());
    expect(out).toEqual([]);
  });

  it('t7525-status-rename.sh: "copies not overridden by find-renames"', async () => {
    const dir = repo(`${T7525_SETUP}
      cp renamed copy
      git add copy
    `);
    const out: string[] = [];
    for (const config of [["status.renames=copies"], ["diff.renames=copies"]]) {
      await twin(out, dir, config, [], (s) => s);
      await twin(out, dir, config, ["-M=01%"], (s) => s.setFindRenames("=01%"));
      await twin(out, dir, config, ["--find-renames=01%"], (s) => s.setFindRenames("01%"));
    }
    // a modified path copied, in the index and in the worktree (to an intent-to-add path)
    execFileSync(
      "bash",
      [
        "-ec",
        `git commit -q -m two
         for i in 1 2 3 4 5 6 7 8 9; do echo "line $i"; done >base
         git add base && git commit -q -m base
         echo 10 >>base && cp base copy2 && git add base copy2
         echo 11 >>base && cp base copy3 && git add -N copy3`,
      ],
      { cwd: dir, env: testEnv(home()), stdio: "ignore" },
    );
    for (const config of [["status.renames=copies"], ["status.renames=true"]]) {
      await twin(out, dir, config, [], (s) => s);
      await twin(out, dir, config, [], (s) => s, 2);
    }
    expect(out).toEqual([]);
  });

  it("t7525-status-rename.sh: status.renameLimit and the rename limit warning", async () => {
    const dir = repo(`
      for f in a b c; do for i in 1 2 3 4 5 6; do echo "$f line $i"; done >$f; done
      git add . && git commit -q -m one
      for f in a b c; do mv $f $f.moved && echo more >>$f.moved; done
      git add -A
    `);
    const out: string[] = [];
    await twin(out, dir, ["status.renameLimit=1"], [], (s) => s);
    await twin(out, dir, ["diff.renameLimit=1"], [], (s) => s);
    await twin(out, dir, ["diff.renameLimit=1", "status.renameLimit=10"], [], (s) => s);
    await twin(out, dir, ["status.renameLimit=1"], [], (s) => s, 1);
    expect(out).toEqual([]);
  });
});

describeGit("status -v / -vv", () => {
  /** t7508's status setup, reduced: a staged addition, an unstaged change, untracked files */
  const T7508_SETUP = `
    export GIT_AUTHOR_DATE="1112911993 +0000" GIT_COMMITTER_DATE="1112911993 +0000"
    printf '.gitignore\\nexpect*\\noutput*\\n' >.gitignore
    mkdir dir1 dir2
    : >tracked && : >modified && : >dir1/tracked && : >dir1/modified
    git add . && git commit -q -m initial
    : >untracked && : >dir1/untracked && : >dir2/untracked
    echo 1 >dir1/modified && echo 2 >dir2/modified && echo 3 >dir2/added
    git add dir2/added
  `;

  it('t7508-status.sh: "status -v", "status -v -v"', async () => {
    const dir = repo(T7508_SETUP);
    const out: string[] = [];
    await twin(out, dir, [], [], (s) => s, 1);
    await twin(out, dir, [], [], (s) => s, 2);
    await twin(out, dir, ["status.displayCommentPrefix=true"], [], (s) => s, 2);
    await twin(out, dir, ["diff.mnemonicPrefix=true"], [], (s) => s, 1);
    expect(out).toEqual([]);
  });

  it('t7508-status.sh: "status -v", "status -v -v" with renames, copies and rename options', async () => {
    const dir = repo(`${T7508_SETUP}
      git commit -q -m two
      for i in 1 2 3 4 5 6 7 8 9; do echo "line $i"; done >base
      cp base other && git add base other && git commit -q -m base
      git mv other moved && echo 10 >>moved && git add moved
      echo 11 >>base && cp base copy && git add copy
      echo 12 >>base
    `);
    const out: string[] = [];
    for (const level of [1, 2]) {
      await twin(out, dir, [], [], (s) => s, level);
      await twin(out, dir, [], ["--no-renames"], (s) => s.setRenames(false), level);
      await twin(out, dir, ["status.renames=copies"], [], (s) => s, level);
      await twin(out, dir, ["diff.renames=copies"], [], (s) => s, level);
      await twin(out, dir, ["status.renames=false"], [], (s) => s, level);
      await twin(out, dir, ["diff.renames=false"], [], (s) => s, level);
      await twin(out, dir, [], ["--find-renames=95%"], (s) => s.setFindRenames("95%"), level);
    }
    expect(out).toEqual([]);
  });
});
