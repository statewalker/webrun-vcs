/**
 * `git am` against native git: a series made by native `git format-patch` from a history
 * (renames, binaries, mode changes, non-ASCII authors and subjects) is applied to two
 * twins built by native git, one by native `git am`, the other by our AmCommand, with the
 * same pinned committer; then the exit status, stdout, stderr, `.git/rebase-apply/` (at a
 * stop), HEAD's commit id, the reflogs, ORIG_HEAD, the worktree and the index are compared,
 * through `--skip`, `--continue` and `--abort`.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AmCommand, Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

type Env = Record<string, string | undefined>;
let root = "";
let home = "";
let counter = 0;
let modern = true;

const IDENT: Env = {
  GIT_AUTHOR_NAME: "Ann Author",
  GIT_AUTHOR_EMAIL: "ann@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0200",
  GIT_COMMITTER_NAME: "Cid Committer",
  GIT_COMMITTER_EMAIL: "cid@example.com",
  GIT_COMMITTER_DATE: "1700000500 -0700",
};

function envOf(over: Env = {}): Record<string, string> {
  const env: Env = { ...nativeGitEnv(home), ...IDENT, ...over };
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

function git(cwd: string, args: string[], env: Env = {}) {
  const r = spawnSync("git", args, {
    cwd,
    env: envOf(env),
    encoding: "utf8",
    input: "",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function gitOk(cwd: string, args: string[], env: Env = {}): string {
  const r = git(cwd, args, env);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const put = (dir: string, path: string, content: string | Buffer, mode = 0o644) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  rmSync(join(dir, path), { force: true });
  writeFileSync(join(dir, path), content, { mode });
};

async function open(repo: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: envOf() });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

const lines = (n: number, p = "line") =>
  Array.from({ length: n }, (_, i) => `${p} ${i + 1}\n`).join("");

/** The base every repository starts from. */
function base(repo: string): void {
  mkdirSync(repo, { recursive: true });
  gitOk(repo, ["init", "-q", "-b", "main"]);
  put(repo, "a.txt", lines(20));
  put(repo, "b.txt", lines(10, "bee"));
  put(repo, "data.bin", Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 7) % 256)));
  gitOk(repo, ["add", "-A"]);
  gitOk(repo, ["commit", "-qm", "base"]);
}

/** A series made by native format-patch on top of the base; the mbox file's path. */
function series(): string {
  const src = join(root, `src${counter++}`);
  base(src);
  const commit = (msg: string, name: string, email: string, date: string) => {
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-q", "-m", msg], {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: date,
    });
  };
  put(src, "a.txt", lines(20).replace("line 3\n", "line three\n"));
  commit(
    "Change line three\n\nWith a body line.\n",
    "José Núñez",
    "jose@example.com",
    "1700001000 +0100",
  );
  gitOk(src, ["mv", "b.txt", "bee.txt"]);
  put(src, "run.sh", "#!/bin/sh\necho hi\n", 0o755);
  commit(
    "[core] Rename bee and add a script",
    "O'Brien, Pat",
    "pat@example.com",
    "1700002000 -0500",
  );
  const bin = readFileSync(join(src, "data.bin"));
  bin[10] = 0;
  bin[300] = 1;
  put(src, "data.bin", bin);
  put(
    src,
    "a.txt",
    lines(20).replace("line 3\n", "line three\n").replace("line 18\n", "line eighteen\n"),
  );
  commit("Café: binary and text", "张伟", "zhang@example.com", "1700003000 +0800");
  const mbox = join(root, `series${counter++}.mbox`);
  writeFileSync(
    mbox,
    spawnSync("git", ["format-patch", "--stdout", "HEAD~3"], { cwd: src, env: envOf() }).stdout,
  );
  return mbox;
}

function snapshot(repo: string): string {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(repo, rel)).sort()) {
      if (!rel && name === ".git") continue;
      const p = rel ? `${rel}/${name}` : name;
      const full = join(repo, p);
      if (
        readdirSync(join(repo, rel), { withFileTypes: true })
          .find((d) => d.name === name)
          ?.isDirectory()
      )
        walk(p);
      else out.push(`${p} ${readFileSync(full).toString("base64")}`);
    }
  };
  walk("");
  const state = join(repo, ".git", "rebase-apply");
  if (existsSync(state)) {
    // patch-merge-index: the temporary index of --3way, which ours keeps in memory
    for (const f of readdirSync(state).sort())
      if (f !== "patch-merge-index")
        out.push(`STATE ${f}: ${readFileSync(join(state, f)).toString()}`);
  }
  return out.join("\n");
}

function refsOf(repo: string): string {
  return [
    gitOk(repo, ["rev-parse", "HEAD"]),
    git(repo, ["rev-parse", "-q", "--verify", "ORIG_HEAD"]).stdout,
    gitOk(repo, ["reflog", "--format=%H %gs"]),
    gitOk(repo, ["ls-files", "-s"]),
    gitOk(repo, ["status", "--porcelain"]),
  ].join("\n--\n");
}

async function compare(
  pair: { native: string; ours: string },
  args: string[],
  configure: (c: AmCommand) => AmCommand,
  label: string,
) {
  const native = git(pair.native, ["am", ...args]);
  const g = await open(pair.ours);
  const r = await configure(g.am().setLegacyMessages(!modern)).call();
  g.close();
  expect({ label, status: r.exitCode, stdout: r.output, stderr: r.errors }).toEqual({
    label,
    status: native.status,
    stdout: native.stdout,
    stderr: native.stderr,
  });
  expect(snapshot(pair.ours)).toBe(snapshot(pair.native));
  expect(refsOf(pair.ours)).toBe(refsOf(pair.native));
}

function twins(setup?: (repo: string) => void) {
  const n = counter++;
  const make = (side: string) => {
    const repo = join(root, `t${n}-${side}`);
    base(repo);
    setup?.(repo);
    return repo;
  };
  return { native: make("native"), ours: make("ours") };
}

describeGit("git am as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "am-native-"));
    home = join(root, "home");
    mkdirSync(home, { recursive: true });
    modern = gitAtLeast(gitOk(root, ["--version"]), 2, 46);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("applies a series as native git does", async () => {
    const mbox = series();
    const bytes = readFileSync(mbox);
    await compare(twins(), [mbox], (c) => c.addMbox(bytes), "plain");
    await compare(
      twins(),
      ["-s", "-k", mbox],
      (c) => c.addMbox(bytes).setSignoff(true).setKeep(true),
      "-s -k",
    );
    await compare(
      twins(),
      ["-q", "-m", mbox],
      (c) => c.addMbox(bytes).setQuiet(true).setMessageId(true),
      "-q -m",
    );
  }, 120_000);

  it("--skip after a stop with changes staged cleans the index as git's clean_index", async () => {
    const mbox = series();
    const bytes = readFileSync(mbox);
    const drift = (repo: string) => {
      put(repo, "a.txt", lines(20).replace("line 3\n", "LINE 3\n"));
      gitOk(repo, ["commit", "-qam", "drift"]);
    };
    for (const threeway of [false, true]) {
      const pair = twins(drift);
      const args = threeway ? ["-3", mbox] : [mbox];
      await compare(pair, args, (c) => c.addMbox(bytes).setThreeWay(threeway), "stop");
      for (const repo of [pair.native, pair.ours]) {
        // a staged new file, a staged edit, an unstaged edit
        put(repo, "new.txt", "new\n");
        put(repo, "b.txt", lines(10, "bee").replace("bee 2\n", "BEE 2\n"));
        gitOk(repo, ["add", "new.txt", "b.txt"]);
        put(repo, "data.bin", "worktree only\n");
      }
      await compare(pair, ["--skip"], (c) => c.setResume("skip"), `skip ${threeway}`);
    }
    // a staged file changed again in the worktree: clean_index refuses to overwrite it
    const pair = twins(drift);
    await compare(pair, [mbox], (c) => c.addMbox(bytes), "stop dirty");
    for (const repo of [pair.native, pair.ours]) {
      put(repo, "b.txt", "staged\n");
      gitOk(repo, ["add", "b.txt"]);
      put(repo, "b.txt", "dirty again\n");
    }
    await compare(pair, ["--skip"], (c) => c.setResume("skip"), "skip refused");
  }, 120_000);

  it("stops, skips, continues and aborts as native git does", async () => {
    const mbox = series();
    const bytes = readFileSync(mbox);
    const drift = (repo: string) => {
      put(repo, "a.txt", lines(20).replace("line 3\n", "LINE 3\n"));
      gitOk(repo, ["commit", "-qam", "drift"]);
    };
    // stop on the first patch, then --skip the rest through
    let pair = twins(drift);
    await compare(pair, [mbox], (c) => c.addMbox(bytes), "stop");
    await compare(pair, ["--skip"], (c) => c.setResume("skip"), "skip");
    // stop, resolve by hand, --continue
    pair = twins(drift);
    await compare(pair, [mbox], (c) => c.addMbox(bytes), "stop 2");
    for (const repo of [pair.native, pair.ours]) {
      put(repo, "a.txt", lines(20).replace("line 3\n", "line three\n"));
      gitOk(repo, ["add", "a.txt"]);
    }
    await compare(pair, ["--continue"], (c) => c.setResume("continue"), "continue");
    // stop, --abort
    pair = twins(drift);
    await compare(pair, [mbox], (c) => c.addMbox(bytes), "stop 3");
    await compare(pair, ["--abort"], (c) => c.setResume("abort"), "abort");
    // --continue with nothing staged
    pair = twins(drift);
    await compare(pair, [mbox], (c) => c.addMbox(bytes), "stop 4");
    await compare(pair, ["--continue"], (c) => c.setResume("continue"), "continue without changes");
    await compare(pair, ["--quit"], (c) => c.setResume("quit"), "quit");
    // --3way: a context change merges cleanly, a real conflict stops with stages
    const near = (repo: string) => {
      put(repo, "a.txt", lines(20).replace("line 4\n", "LINE 4\n"));
      gitOk(repo, ["commit", "-qam", "drift near"]);
    };
    await compare(
      twins(near),
      ["-3", mbox],
      (c) => c.addMbox(bytes).setThreeWay(true),
      "3way clean",
    );
    pair = twins(drift);
    await compare(
      pair,
      ["--3way", mbox],
      (c) => c.addMbox(bytes).setThreeWay(true),
      "3way conflict",
    );
    for (const repo of [pair.native, pair.ours]) {
      put(repo, "a.txt", lines(20).replace("line 3\n", "merged 3\n"));
      gitOk(repo, ["add", "a.txt"]);
    }
    await compare(pair, ["--continue"], (c) => c.setResume("continue"), "3way continue");
    // already applied: the 3-way merge finds nothing to change
    const applied = (repo: string) => {
      put(
        repo,
        "a.txt",
        lines(20).replace("line 3\n", "line three\n").replace("line 1\n", "first\n"),
      );
      gitOk(repo, ["commit", "-qam", "same change"]);
    };
    await compare(
      twins(applied),
      ["-3", mbox],
      (c) => c.addMbox(bytes).setThreeWay(true),
      "3way already applied",
    );
    // a dirty index refuses
    pair = twins((repo) => {
      put(repo, "a.txt", "staged\n");
      gitOk(repo, ["add", "a.txt"]);
    });
    await compare(pair, [mbox], (c) => c.addMbox(bytes), "dirty index");
  }, 120_000);

  it("detects patch formats and refuses what git refuses", async () => {
    const file = (name: string, content: string | Buffer) => {
      const path = join(root, `${name}-${counter++}`);
      writeFileSync(path, content);
      return path;
    };
    const diff =
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-line 1\n+one\n line 2\n";
    const inputs: [string, string | Buffer][] = [
      ["empty", ""],
      ["blank", "\n\n"],
      ["plain diff", diff],
      ["not mail", "\n\nnot a mail\nfoo\n"],
      [
        "hg",
        `# HG changeset patch\n# User Hg User <hg@example.com>\n# Date 1700000000 -3600\n# Node ID 0123\nHg subject\n\nHg body.\n\n${diff}`,
      ],
      [
        "hg bad date",
        `# HG changeset patch\n# User Hg <hg@x>\n# Date 1700000000 x\nsubj\n\n${diff}`,
      ],
      [
        "stgit",
        `Stgit subject\n\nAuthor: Stg User <stg@example.com>\nDate: Tue, 14 Nov 2023 10:00:00 +0000\n\nStgit body\n---\n${diff}`,
      ],
      ["mail headers", `X-Foo: bar\nSubject: header only\nFrom: H <h@x>\n\nbody\n---\n${diff}`],
    ];
    for (const [label, content] of inputs) {
      const path = file(label.replace(/ /g, "-"), content);
      await compare(twins(), [path], (c) => c.addMbox(Buffer.from(content), path), label);
    }
    // --patch-format given: an empty mbox file fails to split
    const empty = file("empty-mbox", "");
    await compare(
      twins(),
      ["--patch-format=mbox", empty],
      (c) => c.addMbox(Buffer.alloc(0), empty).setPatchFormat("mbox"),
      "empty mbox",
    );
    // standard input: an mbox, empty or not
    for (const [label, content] of [
      ["stdin empty", ""],
      ["stdin plain diff", diff],
    ] as const) {
      const pair = twins();
      const native = spawnSync("git", ["am"], {
        cwd: pair.native,
        env: envOf(),
        input: content,
        encoding: "utf8",
      });
      const g = await open(pair.ours);
      const r = await g.am().setLegacyMessages(!modern).addMbox(content).call();
      g.close();
      expect({ label, status: r.exitCode, stdout: r.output, stderr: r.errors }).toEqual({
        label,
        status: native.status,
        stdout: native.stdout,
        stderr: native.stderr,
      });
      expect(snapshot(pair.ours)).toBe(snapshot(pair.native));
    }
  }, 120_000);

  it("commits authors, dates and 8-bit messages as git does", async () => {
    const patch =
      "---\n a.txt | 2 +-\n\ndiff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-line 1\n+one\n line 2\n";
    const mails: [string, Buffer, string[]][] = [
      // crud around the name and the email
      [
        "crud",
        Buffer.from(
          `From: ";Jo, Doe;" <:jo@x:>\nSubject: crud\nDate: Thu, 1 Jan 2015 00:00:00 +0000\n\nbody\n${patch}`,
        ),
        [],
      ],
      [
        "only crud",
        Buffer.from(
          `From: ";;" <jo@x>\nSubject: crud\nDate: Thu, 1 Jan 2015 00:00:00 +0000\n\nbody\n${patch}`,
        ),
        [],
      ],
      // 8-bit without a charset: the commit's bytes made UTF-8 as Latin-1
      [
        "8bit",
        Buffer.concat([
          Buffer.from(
            "From: Ren\xe9 <r@x>\nSubject: caf\xe9 \xc3\xa9\nDate: Thu, 1 Jan 2015 00:00:00 +0000\n\nna\xefve \xed\xa0\x80 \xef\xbf\xbe body\n",
            "latin1",
          ),
          Buffer.from(patch),
        ]),
        [],
      ],
      // a charset that does not convert
      [
        "bad charset",
        Buffer.from(
          `From: A <a@x>\nSubject: s\nContent-Type: text/plain; charset=us-ascii\nDate: Thu, 1 Jan 2015 00:00:00 +0000\n\nb\xe9\n${patch}`,
          "latin1",
        ),
        [],
      ],
    ];
    for (const [label, mail, args] of mails) {
      const path = join(root, `m${counter++}`);
      writeFileSync(path, mail);
      await compare(twins(), [...args, path], (c) => c.addMbox(mail, path), label);
    }
    // --ignore-date and a mail without Date: the clock, not GIT_AUTHOR_DATE
    for (const [label, mail, args] of [
      [
        "ignore date",
        `From: A <a@x>\nSubject: s\nDate: Thu, 1 Jan 2015 00:00:00 +0000\n\nb\n${patch}`,
        ["--ignore-date"],
      ],
      ["no date", `From: A <a@x>\nSubject: s\n\nb\n${patch}`, []],
      [
        "no date, committer date",
        `From: A <a@x>\nSubject: s\n\nb\n${patch}`,
        ["--committer-date-is-author-date"],
      ],
    ] as const) {
      const path = join(root, `m${counter++}`);
      writeFileSync(path, mail);
      const pair = twins();
      const native = git(pair.native, ["am", ...args, path]);
      expect(native.status, native.stderr).toBe(0);
      const now = Number(gitOk(pair.native, ["log", "-1", "--format=%at"]).trim());
      const g = await open(pair.ours);
      let cmd = g.am().addMbox(mail, path).setClock(now);
      const given: readonly string[] = args;
      if (given.includes("--ignore-date")) cmd = cmd.setIgnoreDate(true);
      if (given.includes("--committer-date-is-author-date"))
        cmd = cmd.setCommitterDateIsAuthorDate(true);
      const r = await cmd.call();
      g.close();
      expect({ label, status: r.exitCode, stderr: r.errors }).toEqual({
        label,
        status: 0,
        stderr: native.stderr,
      });
      expect(gitOk(pair.ours, ["rev-parse", "HEAD"]), label).toBe(
        gitOk(pair.native, ["rev-parse", "HEAD"]),
      );
    }
  }, 120_000);

  it("advises --allow-empty on --continue and fails --abort as git", async () => {
    const pair = twins();
    const path = join(root, `m${counter++}`);
    // with a Date: header (without one, git am dates the commit by the wall clock)
    writeFileSync(
      path,
      "From: A <a@x>\nSubject: no patch\nDate: Thu, 1 Jan 2015 00:00:00 +0000\n\nbody only\n",
    );
    const bytes = readFileSync(path);
    await compare(pair, [path], (c) => c.addMbox(bytes, path), "empty patch");
    await compare(pair, ["--continue"], (c) => c.setResume("continue"), "continue empty");
    await compare(pair, ["--allow-empty"], (c) => c.setResume("allow-empty"), "allow empty");
    // --abort with an untracked file where ORIG_HEAD has one
    const mbox = series();
    const mboxBytes = readFileSync(mbox);
    const drift = (repo: string) => {
      put(repo, "a.txt", lines(20).replace("line 18\n", "LINE 18\n"));
      gitOk(repo, ["commit", "-qam", "drift"]);
    };
    const stuck = twins(drift);
    await compare(stuck, [mbox], (c) => c.addMbox(mboxBytes), "stop at 3");
    for (const repo of [stuck.native, stuck.ours]) put(repo, "b.txt", "untracked\n");
    await compare(stuck, ["--abort"], (c) => c.setResume("abort"), "abort refused");
  }, 120_000);

  it("applies a submodule bump", async () => {
    const a = "1111111111111111111111111111111111111111";
    const b = "2222222222222222222222222222222222222222";
    const withSub = (repo: string) => {
      gitOk(repo, ["update-index", "--add", "--cacheinfo", `160000,${a},sub`]);
      gitOk(repo, ["commit", "-qm", "add sub"]);
    };
    const mail = `From: A <a@x>\nSubject: bump sub\nDate: Thu, 1 Jan 2015 00:00:00 +0000\n\nbody\n---\n sub | 2 +-\n\ndiff --git a/sub b/sub\nindex 1111111..2222222 160000\n--- a/sub\n+++ b/sub\n@@ -1 +1 @@\n-Subproject commit ${a}\n+Subproject commit ${b}\n`;
    const path = join(root, `m${counter++}`);
    writeFileSync(path, mail);
    for (const [label, setup] of [
      ["absent", withSub],
      [
        "empty dir",
        (repo: string) => {
          withSub(repo);
          mkdirSync(join(repo, "sub"));
        },
      ],
    ] as const) {
      await compare(twins(setup), [path], (c) => c.addMbox(mail, path), `sub ${label}`);
      await compare(
        twins(setup),
        ["-3", path],
        (c) => c.addMbox(mail, path).setThreeWay(true),
        `sub -3 ${label}`,
      );
    }
  }, 120_000);

  it("cleans the index on --abort as git's clean_index", async () => {
    const mbox = series();
    const bytes = readFileSync(mbox);
    const drift = (repo: string) => {
      put(repo, "a.txt", lines(20).replace("line 18\n", "LINE 18\n"));
      gitOk(repo, ["commit", "-qam", "drift"]);
    };
    // a staged change with unstaged changes on top: not up to date for ORIG_HEAD, refused
    let pair = twins(drift);
    await compare(pair, [mbox], (c) => c.addMbox(bytes), "stop at 3 (staged)");
    for (const repo of [pair.native, pair.ours]) {
      put(repo, "a.txt", "staged\n");
      gitOk(repo, ["add", "a.txt"]);
      put(repo, "a.txt", "unstaged on top\n");
    }
    await compare(pair, ["--abort"], (c) => c.setResume("abort"), "abort staged and unstaged");
    // a staged deletion of a path ORIG_HEAD does not have: the file stays, untracked
    pair = twins(drift);
    await compare(pair, [mbox], (c) => c.addMbox(bytes), "stop at 3 (rm --cached)");
    for (const repo of [pair.native, pair.ours]) gitOk(repo, ["rm", "-q", "--cached", "bee.txt"]);
    await compare(pair, ["--abort"], (c) => c.setResume("abort"), "abort rm --cached");
    // a conflict of --3way: the conflicted path is reset, a staged new file is kept
    pair = twins(drift);
    await compare(pair, ["-3", mbox], (c) => c.addMbox(bytes).setThreeWay(true), "3way stop at 3");
    for (const repo of [pair.native, pair.ours]) {
      put(repo, "new.txt", "new\n");
      gitOk(repo, ["add", "new.txt"]);
    }
    await compare(pair, ["--abort"], (c) => c.setResume("abort"), "abort 3way conflict");
  }, 120_000);

  it("reconstructs a pure rename's base with a regular file's mode on -3", async () => {
    const src = join(root, `src${counter++}`);
    base(src);
    gitOk(src, ["mv", "b.txt", "bee.txt"]);
    put(src, "a.txt", lines(20).replace("line 3\n", "line three\n"));
    gitOk(src, ["commit", "-qam", "rename and change"]);
    const mbox = join(root, `rename${counter++}.mbox`);
    writeFileSync(
      mbox,
      spawnSync("git", ["format-patch", "--stdout", "-M", "HEAD~1"], { cwd: src, env: envOf() })
        .stdout,
    );
    const bytes = readFileSync(mbox);
    const drift = (repo: string) => {
      put(repo, "a.txt", lines(20).replace("line 3\n", "LINE 3\n"));
      gitOk(repo, ["commit", "-qam", "drift"]);
    };
    await compare(
      twins(drift),
      ["-3", mbox],
      (c) => c.addMbox(bytes).setThreeWay(true),
      "3way pure rename",
    );
  }, 120_000);

  it("converts to i18n.commitEncoding and records it in the commit", async () => {
    const patch =
      "---\n a.txt | 2 +-\n\ndiff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-line 1\n+one\n line 2\n";
    const mail = Buffer.from(
      `From: =?UTF-8?q?Ren=C3=A9?= <r@x>\nSubject: =?UTF-8?q?caf=C3=A9?=\nContent-Type: text/plain; charset=UTF-8\nDate: Thu, 1 Jan 2015 00:00:00 +0000\n\nna\u00efve body\n${patch}`,
    );
    const path = join(root, `m${counter++}`);
    writeFileSync(path, mail);
    for (const encoding of ["ISO-8859-1", "koi8-r"]) {
      const pair = twins((repo) => gitOk(repo, ["config", "i18n.commitEncoding", encoding]));
      await compare(pair, [path], (c) => c.addMbox(mail, path), `commitEncoding ${encoding}`);
      expect(gitOk(pair.ours, ["cat-file", "commit", "HEAD"])).toBe(
        gitOk(pair.native, ["cat-file", "commit", "HEAD"]),
      );
    }
    // a subject that is no UTF-8: the reflog keeps its bytes
    const latin = Buffer.from(
      `From: A <a@x>\nSubject: =?ISO-8859-1?q?caf=E9?=\nDate: Thu, 1 Jan 2015 00:00:00 +0000\n\nbody\n${patch}`,
    );
    const latinPath = join(root, `m${counter++}`);
    writeFileSync(latinPath, latin);
    await compare(
      twins((repo) => gitOk(repo, ["config", "i18n.commitEncoding", "ISO-8859-1"])),
      [latinPath],
      (c) => c.addMbox(latin, latinPath),
      "latin-1 reflog subject",
    );
  }, 120_000);

  it("refuses StGit series and blank mboxes as git does", async () => {
    const dir = join(root, `stg${counter++}`);
    mkdirSync(dir, { recursive: true });
    const seriesPath = join(dir, "series");
    const content = "# This series applies on GIT commit 0000\n# comment\np1\np2\n";
    writeFileSync(seriesPath, content);
    await compare(
      twins(),
      ["--patch-format=stgit-series", seriesPath],
      (c) => c.addMbox(Buffer.from(content), seriesPath).setPatchFormat("stgit-series"),
      "stgit series",
    );
    await compare(
      twins(),
      ["--patch-format=stgit-series", seriesPath, seriesPath],
      (c) =>
        c
          .addMbox(Buffer.from(content), seriesPath)
          .addMbox(Buffer.from(content), seriesPath)
          .setPatchFormat("stgit-series"),
      "two stgit series",
    );
    // a vertical tab or a form feed is no space to git: the mbox is not empty
    for (const [label, blank] of [
      ["vt", "\v\n"],
      ["ff", "\f\n"],
    ] as const) {
      const path = join(root, `blank-${label}-${counter++}`);
      writeFileSync(path, blank);
      await compare(
        twins(),
        ["--patch-format=mbox", path],
        (c) => c.addMbox(Buffer.from(blank), path).setPatchFormat("mbox"),
        `blank mbox ${label}`,
      );
    }
  }, 120_000);
});
