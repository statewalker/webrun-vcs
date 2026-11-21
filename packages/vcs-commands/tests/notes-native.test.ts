/**
 * `git notes` against native git: each repository is built twice by native git (same ids),
 * one twin changed by native `git notes ...`, the other by our NotesCommands, with the same
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*`; then the notes refs (commit ids: trees, fanout,
 * messages, parents and identities in one), their reflogs, the merge state files and what
 * each printed are compared. Also the notes rewriting of `commit --amend` and `rebase`, and
 * the notes `git log` shows.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, NotesError, type NotesResult, RebaseStatus } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

type Env = Record<string, string | undefined>;

let root = "";
let home = "";
let counter = 0;
let modern = true;

const OP: Env = {
  GIT_AUTHOR_NAME: "Ann Author",
  GIT_AUTHOR_EMAIL: "ann@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0200",
  GIT_COMMITTER_NAME: "Cid Committer",
  GIT_COMMITTER_EMAIL: "cid@example.com",
  GIT_COMMITTER_DATE: "1700000500 -0700",
};

function envOf(over: Env = {}): Record<string, string> {
  const env: Env = { ...nativeGitEnv(home), ...OP, ...over };
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[], options: { env?: Env; input?: string } = {}): Run {
  const r = spawnSync("git", args, {
    cwd,
    env: envOf(options.env),
    encoding: "utf8",
    input: options.input ?? "",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function gitOk(cwd: string, ...args: string[]): string {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const build = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, env: nativeGitEnv(home), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/** main: c1, c2, c3; topic (from c1): t1, t2; a tag v1 at c1. */
function base(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const repo = join(dir, "repo");
  build(dir, "init", "-q", "-b", "main", "repo");
  for (const [i, name] of ["c1", "c2", "c3"].entries()) {
    put(repo, "a.txt", `${"a\n".repeat(i + 1)}`);
    build(repo, "add", ".");
    build(repo, "commit", "-qm", name);
    if (i === 0) {
      build(repo, "branch", "topic");
      build(repo, "tag", "v1");
    }
  }
  build(repo, "checkout", "-q", "topic");
  put(repo, "t.txt", "t1\n");
  build(repo, "add", ".");
  build(repo, "commit", "-qm", "t1");
  put(repo, "t.txt", "t1\nt2\n");
  build(repo, "commit", "-qam", "t2");
  build(repo, "checkout", "-q", "main");
  return repo;
}

function twins(setup?: (repo: string) => void): { native: string; ours: string } {
  const n = counter++;
  const native = base(join(root, `t${n}-native`));
  const ours = base(join(root, `t${n}-ours`));
  setup?.(native);
  setup?.(ours);
  return { native, ours };
}

async function open(repo: string, env: Env = {}): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: envOf(env) });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** Our command run as git would end: a NotesError is git's `fatal:` (status 128). */
async function ours(call: () => Promise<NotesResult | string>): Promise<Run> {
  try {
    const r = await call();
    if (typeof r === "string") return { status: 0, stdout: `${r}\n`, stderr: "" };
    return { status: r.exitCode, stdout: r.output, stderr: r.errors };
  } catch (error) {
    if (error instanceof NotesError) {
      return {
        status: 128,
        stdout: error.output,
        stderr: `${error.errors}fatal: ${error.message}\n`,
      };
    }
    throw error;
  }
}

/** The notes state of a repository: refs, reflogs, merge state files. */
function state(repo: string): string {
  const out: string[] = [];
  out.push(gitOk(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/notes"));
  const logs = join(repo, ".git/logs/refs/notes");
  if (existsSync(logs)) {
    for (const name of readdirSync(logs, { recursive: true }).map(String).sort()) {
      const p = join(logs, name);
      try {
        out.push(`log ${name}:\n${readFileSync(p, "utf8")}`);
      } catch {
        // a directory
      }
    }
  }
  for (const name of ["NOTES_MERGE_PARTIAL", "NOTES_MERGE_REF"]) {
    const p = join(repo, ".git", name);
    if (existsSync(p)) out.push(`${name}: ${readFileSync(p, "utf8")}`);
  }
  const wt = join(repo, ".git/NOTES_MERGE_WORKTREE");
  if (existsSync(wt)) {
    for (const name of readdirSync(wt).sort()) {
      out.push(`wt ${name}:\n${readFileSync(join(wt, name), "utf8")}`);
    }
  }
  return out.join("\n");
}

/** One step on both twins: the same status, output and state. */
async function step(
  t: { native: string; ours: string },
  args: string[],
  run: (git: Git) => Promise<NotesResult | string>,
  options: { env?: Env; input?: string; label?: string } = {},
): Promise<Run> {
  const n = git(t.native, args, options);
  const mine = await ours(async () => run(await open(t.ours, options.env)));
  const label = options.label ?? args.join(" ");
  expect(mine, label).toEqual(n);
  expect(state(t.ours), `${label}: state`).toBe(state(t.native));
  return n;
}

/** A deterministic stream of object ids. */
function ids(seed: number, count: number): string[] {
  let x = seed >>> 0 || 1;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let hex = "";
    for (let k = 0; k < 5; k++) {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      hex += x.toString(16).padStart(8, "0");
    }
    out.push(hex);
  }
  return out;
}

describeGit("git notes, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "notes-native-"));
    home = join(root, "home");
    mkdirSync(home);
    modern = gitAtLeast(
      String(spawnSync("git", ["--version"], { encoding: "utf8" }).stdout),
      2,
      44,
    );
    writeFileSync(join(root, "editor.sh"), '#!/bin/sh\necho "edited line" >> "$1"\n');
    chmodSync(join(root, "editor.sh"), 0o755);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("add, list, show, append, edit, copy, remove, get-ref with their messages", async () => {
    const t = twins();
    const editor = join(root, "editor.sh");
    await step(t, ["notes", "add", "-m", "first note"], (g) =>
      g.notes().add().addMessage("first note").call(),
    );
    await step(t, ["notes", "list"], (g) => g.notes().list().call());
    await step(t, ["notes", "list", "HEAD"], (g) => g.notes().list().setObject("HEAD").call());
    await step(t, ["notes", "list", "HEAD~1"], (g) => g.notes().list().setObject("HEAD~1").call());
    await step(t, ["notes", "show"], (g) => g.notes().show().call());
    await step(t, ["notes", "show", "HEAD~1"], (g) => g.notes().show().setObject("HEAD~1").call());
    await step(t, ["notes", "show", "nope"], (g) => g.notes().show().setObject("nope").call());
    await step(t, ["notes", "add", "-m", "again"], (g) =>
      g.notes().add().addMessage("again").call(),
    );
    await step(
      t,
      ["notes", "add", "-f", "-m", "  over  ", "-m", "", "-m", "two\n\n\nlines  "],
      (g) =>
        g
          .notes()
          .add()
          .setForce(true)
          .addMessage("  over  ")
          .addMessage("")
          .addMessage("two\n\n\nlines  ")
          .call(),
    );
    await step(t, ["notes", "append", "-m", "appended"], (g) =>
      g.notes().append().addMessage("appended").call(),
    );
    await step(t, ["notes", "append", "--separator=---", "-m", "x", "-m", "y"], (g) =>
      g.notes().append().setSeparator("---").addMessage("x").addMessage("y").call(),
    );
    await step(t, ["notes", "append", "--no-separator", "-m", "z"], (g) =>
      g.notes().append().setSeparator(false).addMessage("z").call(),
    );
    await step(t, ["notes", "append", "--no-stripspace", "-m", "  keep  \n\n\n"], (g) =>
      g.notes().append().setStripspace(false).addMessage("  keep  \n\n\n").call(),
    );
    await step(t, ["notes", "append", "-m", "new", "HEAD~2"], (g) =>
      g.notes().append().addMessage("new").setObject("HEAD~2").call(),
    );
    await step(
      t,
      ["notes", "edit", "HEAD~2"],
      (g) =>
        g
          .notes()
          .edit()
          .setObject("HEAD~2")
          .setEditor((text) => `${text}edited line\n`)
          .call(),
      { env: { GIT_EDITOR: editor } },
    );
    // an object with a note and no message: add is edit
    await step(
      t,
      ["notes", "add", "HEAD~2"],
      (g) =>
        g
          .notes()
          .add()
          .setObject("HEAD~2")
          .setEditor((text) => `${text}edited line\n`)
          .call(),
      { env: { GIT_EDITOR: editor } },
    );
    await step(t, ["notes", "edit", "-m", "via edit", "HEAD~2"], (g) =>
      g.notes().edit().addMessage("via edit").setObject("HEAD~2").call(),
    );
    // the editor of an object without a note, leaving it empty: no note
    await step(t, ["notes", "add", "topic"], (g) => g.notes().add().setObject("topic").call(), {
      env: { GIT_EDITOR: ":" },
    });
    await step(
      t,
      ["notes", "add", "--allow-empty", "topic"],
      (g) => g.notes().add().setAllowEmpty(true).setObject("topic").call(),
      { env: { GIT_EDITOR: ":" } },
    );
    const blob = gitOk(t.native, "rev-parse", "HEAD:a.txt").trim();
    await step(t, ["notes", "add", "-f", "-C", blob, "topic"], (g) =>
      g.notes().add().setForce(true).setReuseMessage(blob).setObject("topic").call(),
    );
    await step(t, ["notes", "add", "-f", "-C", "HEAD", "topic"], (g) =>
      g.notes().add().setForce(true).setReuseMessage("HEAD").setObject("topic").call(),
    );
    await step(t, ["notes", "add", "-f", "-C", "nope", "topic"], (g) =>
      g.notes().add().setForce(true).setReuseMessage("nope").setObject("topic").call(),
    );
    await step(
      t,
      ["notes", "add", "-f", "-c", blob, "-m", "more", "topic~1"],
      (g) =>
        g
          .notes()
          .add()
          .setForce(true)
          .setReeditMessage(blob)
          .addMessage("more")
          .setObject("topic~1")
          .setEditor((text) => `${text}edited line\n`)
          .call(),
      { env: { GIT_EDITOR: editor } },
    );
    await step(
      t,
      ["notes", "add", "-F", "-", "v1^{tree}"],
      (g) =>
        g
          .notes()
          .add()
          .addMessageFile("from stdin\n\n\n# not a comment\n")
          .setObject("v1^{tree}")
          .call(),
      { input: "from stdin\n\n\n# not a comment\n" },
    );
    await step(t, ["notes", "add", "-m", "x", "nope"], (g) =>
      g.notes().add().addMessage("x").setObject("nope").call(),
    );
    await step(t, ["notes", "copy", "HEAD", "topic"], (g) =>
      g.notes().copy().setFrom("HEAD").setTo("topic").call(),
    );
    await step(t, ["notes", "copy", "-f", "HEAD", "topic"], (g) =>
      g.notes().copy().setForce(true).setFrom("HEAD").setTo("topic").call(),
    );
    await step(t, ["notes", "copy", "v1", "HEAD~1"], (g) =>
      g.notes().copy().setFrom("v1").setTo("HEAD~1").call(),
    );
    await step(t, ["notes", "copy", "HEAD", "HEAD~1"], (g) =>
      g.notes().copy().setFrom("HEAD").setTo("HEAD~1").call(),
    );
    const stdin = "HEAD v1\nHEAD~2 topic\n";
    await step(t, ["notes", "copy", "--stdin"], (g) => g.notes().copy().setStdin(stdin).call(), {
      input: stdin,
    });
    await step(
      t,
      ["notes", "copy", "-f", "--stdin"],
      (g) => g.notes().copy().setForce(true).setStdin(stdin).call(),
      { input: stdin },
    );
    await step(t, ["notes", "list"], (g) => g.notes().list().call());
    await step(t, ["notes", "remove", "HEAD~1", "nope", "v1"], (g) =>
      g.notes().remove().addObjects("HEAD~1", "nope", "v1").call(),
    );
    await step(t, ["notes", "remove", "HEAD~1", "v1"], (g) =>
      g.notes().remove().addObjects("HEAD~1", "v1").call(),
    );
    await step(t, ["notes", "remove", "--ignore-missing", "HEAD~1", "topic"], (g) =>
      g.notes().remove().setIgnoreMissing(true).addObjects("HEAD~1", "topic").call(),
    );
    await step(
      t,
      ["notes", "remove", "--stdin"],
      (g) => g.notes().remove().setStdin("HEAD~2  \n").call(),
      {
        input: "HEAD~2  \n",
      },
    );
    await step(t, ["notes", "remove"], (g) => g.notes().remove().call());
    await step(t, ["notes", "get-ref"], (g) => g.notes().getRef().call());
    await step(t, ["notes", "--ref", "review", "get-ref"], (g) =>
      g.notes("review").getRef().call(),
    );
    await step(t, ["notes", "--ref", "notes/x", "add", "-m", "in x"], (g) =>
      g.notes("notes/x").add().addMessage("in x").call(),
    );
    await step(t, ["notes", "get-ref"], (g) => g.notes().getRef().call(), {
      env: { GIT_NOTES_REF: "refs/notes/env" },
    });
    await step(
      t,
      ["notes", "add", "-m", "outside"],
      (g) => g.notes().add().addMessage("outside").call(),
      {
        env: { GIT_NOTES_REF: "refs/heads/main" },
      },
    );
    await step(t, ["notes", "list"], (g) => g.notes().list().call(), {
      env: { GIT_NOTES_REF: "refs/notes/x" },
    });
  });

  it("an empty -m removes the note (2.5x; 2.43 edits)", async () => {
    if (!modern) return;
    const t = twins();
    await step(t, ["notes", "add", "-m", "n"], (g) => g.notes().add().addMessage("n").call());
    await step(t, ["notes", "add", "-f", "-m", ""], (g) =>
      g.notes().add().setForce(true).addMessage("").call(),
    );
    await step(
      t,
      ["notes", "add", "-m", "n", "-e"],
      (g) =>
        g
          .notes()
          .add()
          .addMessage("n")
          .setEdit(true)
          .setEditor((text) => `${text}edited line\n`)
          .call(),
      { env: { GIT_EDITOR: join(root, "editor.sh") } },
    );
  });

  it("copy --for-rewrite, append and edit through the editor", async () => {
    const t = twins((repo) => {
      build(repo, "config", "notes.rewriteRef", "refs/notes/commits");
      build(repo, "config", "notes.rewriteMode", "cat_sort_uniq");
    });
    const editor = join(root, "editor.sh");
    await step(t, ["notes", "add", "-m", "b\na"], (g) => g.notes().add().addMessage("b\na").call());
    await step(t, ["notes", "add", "-m", "c\na", "HEAD~1"], (g) =>
      g.notes().add().addMessage("c\na").setObject("HEAD~1").call(),
    );
    const input = "HEAD HEAD~1\nHEAD topic\n";
    await step(
      t,
      ["notes", "copy", "--for-rewrite=rebase"],
      (g) => g.notes().copy().setForRewrite("rebase").setStdin(input).call(),
      { input },
    );
    await step(
      t,
      ["notes", "copy", "--for-rewrite=rebase"],
      (g) => g.notes().copy().setForRewrite("rebase").setStdin(input).call(),
      { input, env: { GIT_NOTES_REWRITE_MODE: "concatenate" } },
    );
    await step(
      t,
      ["notes", "copy", "--for-rewrite=rebase"],
      (g) => g.notes().copy().setForRewrite("rebase").setStdin("HEAD\n").call(),
      { input: "HEAD\n" },
    );
    await step(
      t,
      ["notes", "append", "topic"],
      (g) =>
        g
          .notes()
          .append()
          .setObject("topic")
          .setEditor((text) => `${text}edited line\n`)
          .call(),
      { env: { GIT_EDITOR: editor } },
    );
    await step(
      t,
      ["notes", "append", "v1"],
      (g) =>
        g
          .notes()
          .append()
          .setObject("v1")
          .setEditor((text) => `${text}edited line\n`)
          .call(),
      { env: { GIT_EDITOR: editor } },
    );
    await step(
      t,
      ["notes", "edit", "--allow-empty", "HEAD~2"],
      (g) => g.notes().edit().setAllowEmpty(true).setObject("HEAD~2").call(),
      { env: { GIT_EDITOR: ":" } },
    );
    // a failed editor: git's fatal line (its `error: There was a problem with the editor`
    // line names the editor, which a callback does not have)
    const n = git(t.native, ["notes", "edit"], { env: { GIT_EDITOR: "false" } });
    const mine = await ours(async () =>
      (await open(t.ours))
        .notes()
        .edit()
        .setEditor(() => {
          throw new Error("editor failed");
        })
        .call(),
    );
    expect(n.stderr.split("\n").slice(1).join("\n")).toBe(mine.stderr);
    expect(mine.status).toBe(n.status);
    expect(state(t.ours)).toBe(state(t.native));
  });

  it("prune: notes of missing objects", async () => {
    const t = twins();
    const missing = ids(7, 5);
    for (const id of [...missing, "HEAD", "v1"]) {
      await step(t, ["notes", "add", "-m", `on ${id}`, id], (g) =>
        g.notes().add().addMessage(`on ${id}`).setObject(id).call(),
      );
    }
    await step(t, ["notes", "prune", "-n"], (g) => g.notes().prune().setDryRun(true).call());
    await step(t, ["notes", "prune", "-v"], (g) => g.notes().prune().setVerbose(true).call());
    await step(t, ["notes", "prune"], (g) => g.notes().prune().call());
  });

  it("the fanout grows and shrinks as git's (tree ids after each change)", {
    timeout: 300_000,
  }, async () => {
    const t = twins();
    const objs = ids(42, 160);
    const g = await open(t.ours);
    for (const [i, id] of objs.entries()) {
      gitOk(t.native, "notes", "add", "-m", `n${i}`, id);
      await g.notes().add().addMessage(`n${i}`).setObject(id).call();
    }
    // the notes commits chain their parents: equal tips, equal trees all the way
    expect(state(t.ours)).toBe(state(t.native));
    const root1 = gitOk(t.native, "ls-tree", "refs/notes/commits").split("\n")[0] ?? "";
    expect(root1).toMatch(/^040000 tree/);
    for (const [i, id] of objs.entries()) {
      if (i % 3 === 0) continue;
      gitOk(t.native, "notes", "remove", id);
      await g.notes().remove().addObjects(id).call();
    }
    expect(state(t.ours)).toBe(state(t.native));
    // many notes at once (git notes copy --stdin), deep enough for 2/2/36 directories
    const many = ids(99, 12000);
    const input = many.map((id) => `${objs[0]} ${id}`).join("\n");
    expect(git(t.native, ["notes", "copy", "--stdin"], { input }).status).toBe(0);
    await g.notes().copy().setStdin(input).call();
    expect(state(t.ours)).toBe(state(t.native));
    const deep = gitOk(t.native, "ls-tree", "-r", "-d", "--name-only", "refs/notes/commits");
    expect(deep.split("\n").some((p) => /^[0-9a-f]{2}\/[0-9a-f]{2}$/.test(p))).toBe(true);
    for (const id of [...many.slice(0, 20), ...ids(5, 20)]) {
      gitOk(t.native, "notes", "add", "-f", "-m", "late", id);
      await g.notes().add().setForce(true).addMessage("late").setObject(id).call();
    }
    for (const id of many.slice(100, 140)) {
      gitOk(t.native, "notes", "remove", id);
      await g.notes().remove().addObjects(id).call();
    }
    expect(state(t.ours)).toBe(state(t.native));
    // git log reads the notes of a fanned-out tree
    const shown = many[3] as string;
    gitOk(t.native, "notes", "copy", "-f", shown, "HEAD");
    await g.notes().copy().setForce(true).setFrom(shown).setTo("HEAD").call();
    const log = gitOk(t.native, "log", "-1");
    expect(await (await open(t.ours)).log().setMaxCount(1).callText()).toBe(log);
  });

  it("entries that are no notes are kept", async () => {
    const t = twins();
    for (const repo of [t.native, t.ours]) {
      const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: repo,
        env: nativeGitEnv(home),
        input: "readme\n",
        encoding: "utf8",
      }).stdout.trim();
      const head = build(repo, "rev-parse", "HEAD").trim();
      const sub = spawnSync("git", ["mktree"], {
        cwd: repo,
        env: nativeGitEnv(home),
        input: `100644 blob ${blob}\tfoo\n100644 blob ${blob}\t${head.slice(2)}\n`,
        encoding: "utf8",
      }).stdout.trim();
      const tree = spawnSync("git", ["mktree"], {
        cwd: repo,
        env: nativeGitEnv(home),
        input: `100644 blob ${blob}\tREADME\n040000 tree ${sub}\t${head.slice(0, 2)}\n040000 tree ${sub}\tzz\n`,
        encoding: "utf8",
      }).stdout.trim();
      const commit = build(repo, "commit-tree", tree, "-m", "hand made").trim();
      build(repo, "update-ref", "refs/notes/commits", commit);
    }
    await step(t, ["notes", "list"], (g) => g.notes().list().call());
    await step(t, ["notes", "add", "-m", "c1", "v1"], (g) =>
      g.notes().add().addMessage("c1").setObject("v1").call(),
    );
    await step(t, ["notes", "add", "-f", "-m", "head"], (g) =>
      g.notes().add().setForce(true).addMessage("head").call(),
    );
    await step(t, ["notes", "remove", "HEAD"], (g) => g.notes().remove().addObjects("HEAD").call());
    expect(gitOk(t.ours, "ls-tree", "-r", "refs/notes/commits")).toBe(
      gitOk(t.native, "ls-tree", "-r", "refs/notes/commits"),
    );
  });

  /** Notes in refs/notes/commits and refs/notes/other that diverge from a common commit. */
  function mergeSetup(repo: string): void {
    const run = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: repo, env: envOf(), encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    run("notes", "add", "-m", "base 1\nline", "HEAD");
    run("notes", "add", "-m", "base 2", "HEAD~1");
    run("notes", "add", "-m", "base 3", "HEAD~2");
    run("notes", "add", "-m", "base 4", "topic");
    run("update-ref", "refs/notes/other", "refs/notes/commits");
    // local changes
    run("notes", "add", "-f", "-m", "local 1\nline\nl", "HEAD");
    run("notes", "remove", "HEAD~1");
    run("notes", "add", "-f", "-m", "same", "HEAD~2");
    run("notes", "add", "-m", "local only", "v1^{tree}");
    run("notes", "add", "-m", "both added\nlocal", "topic~1");
    // remote changes
    run("notes", "--ref", "other", "add", "-f", "-m", "remote 1\nline\nr", "HEAD");
    run("notes", "--ref", "other", "add", "-f", "-m", "remote 2", "HEAD~1");
    run("notes", "--ref", "other", "add", "-f", "-m", "same", "HEAD~2");
    run("notes", "--ref", "other", "remove", "topic");
    run("notes", "--ref", "other", "add", "-m", "both added\nremote", "topic~1");
    run("notes", "--ref", "other", "add", "-m", "remote only", "HEAD:a.txt");
  }

  for (const strategy of ["ours", "theirs", "union", "cat_sort_uniq"] as const) {
    it(`merge -s ${strategy}`, async () => {
      const t = twins(mergeSetup);
      await step(t, ["notes", "merge", "-s", strategy, "other"], (g) =>
        g.notes().merge().setStrategy(strategy).setRemoteRef("other").call(),
      );
      await step(t, ["notes", "merge", "-v", "-s", strategy, "other"], (g) =>
        g.notes().merge().setVerbosity(3).setStrategy(strategy).setRemoteRef("other").call(),
      );
    });
  }

  it("merge: fast-forward, up to date, unborn sides, notes.mergeStrategy, errors", async () => {
    const t = twins((repo) => {
      const r = (...a: string[]) =>
        spawnSync("git", a, { cwd: repo, env: envOf(), encoding: "utf8" });
      r("notes", "add", "-m", "one", "HEAD");
      r("update-ref", "refs/notes/old", "refs/notes/commits");
      r("notes", "--ref", "ahead", "add", "-m", "x", "HEAD~1");
    });
    await step(t, ["notes", "merge", "old"], (g) => g.notes().merge().setRemoteRef("old").call());
    await step(t, ["notes", "merge", "-v", "-v", "old"], (g) =>
      g.notes().merge().setVerbosity(4).setRemoteRef("old").call(),
    );
    await step(t, ["notes", "--ref", "fresh", "merge", "commits"], (g) =>
      g.notes("fresh").merge().setRemoteRef("commits").call(),
    );
    await step(t, ["notes", "merge", "missing"], (g) =>
      g.notes().merge().setRemoteRef("missing").call(),
    );
    await step(t, ["notes", "--ref", "none", "merge", "missing"], (g) =>
      g.notes("none").merge().setRemoteRef("missing").call(),
    );
    await step(t, ["notes", "--ref", "old", "merge", "-vv", "commits"], (g) =>
      g.notes("old").merge().setVerbosity(4).setRemoteRef("commits").call(),
    );
    // history-less merge with a configured strategy
    for (const repo of [t.native, t.ours])
      build(repo, "config", "notes.commits.mergeStrategy", "union");
    await step(t, ["notes", "merge", "-v", "-v", "ahead"], (g) =>
      g.notes().merge().setVerbosity(4).setRemoteRef("ahead").call(),
    );
  });

  it("merge -s manual: conflicts in NOTES_MERGE_WORKTREE, then --commit", async () => {
    const t = twins(mergeSetup);
    await step(t, ["notes", "merge", "other"], (g) =>
      g.notes().merge().setRemoteRef("other").call(),
    );
    // a second merge is refused while the worktree holds conflicts
    await step(t, ["notes", "merge", "-s", "manual", "other"], (g) =>
      g.notes().merge().setStrategy("manual").setRemoteRef("other").call(),
    );
    for (const repo of [t.native, t.ours]) {
      const head = build(repo, "rev-parse", "HEAD").trim();
      writeFileSync(join(repo, ".git/NOTES_MERGE_WORKTREE", head), "resolved\n");
    }
    await step(t, ["notes", "merge", "--commit"], (g) => g.notes().merge().setCommit(true).call());
    await step(t, ["notes", "list"], (g) => g.notes().list().call());
    expect(gitOk(t.ours, "log", "-1", "--format=%P%n%B", "refs/notes/commits")).toBe(
      gitOk(t.native, "log", "-1", "--format=%P%n%B", "refs/notes/commits"),
    );
  });

  it("merge -s manual, then --abort", async () => {
    const t = twins(mergeSetup);
    await step(t, ["notes", "merge", "-v", "other"], (g) =>
      g.notes().merge().setVerbosity(3).setRemoteRef("other").call(),
    );
    await step(t, ["notes", "merge", "--abort", "-v"], (g) =>
      g.notes().merge().setAbort(true).setVerbosity(3).call(),
    );
    await step(t, ["notes", "merge", "--commit"], (g) => g.notes().merge().setCommit(true).call());
  });

  it("commit --amend carries notes over as notes.rewriteRef / notes.rewrite.amend say", async () => {
    const cases: { config: string[][]; env?: Env }[] = [
      { config: [] },
      { config: [["notes.rewriteRef", "refs/notes/commits"]] },
      { config: [["notes.rewriteRef", "refs/notes/*"]] },
      {
        config: [
          ["notes.rewriteRef", "refs/notes/commits"],
          ["notes.rewrite.amend", "false"],
        ],
      },
      { config: [["notes.rewriteRef", "refs/heads/main"]] },
      { config: [], env: { GIT_NOTES_REWRITE_REF: "refs/notes/commits:refs/notes/other" } },
    ];
    for (const [k, c] of cases.entries()) {
      const t = twins((repo) => {
        const r = (...a: string[]) =>
          spawnSync("git", a, { cwd: repo, env: envOf(), encoding: "utf8" });
        r("notes", "add", "-m", "amend me", "HEAD");
        r("notes", "--ref", "other", "add", "-m", "other note", "HEAD");
        for (const [key, value] of c.config) r("config", "--add", key as string, value as string);
      });
      const n = git(t.native, ["commit", "--amend", "-m", "amended"], { env: c.env });
      expect(n.status, n.stderr).toBe(0);
      const g = await open(t.ours, c.env);
      await g.commit().setAmend(true).setMessage("amended").call();
      expect(gitOk(t.ours, "cat-file", "-p", "HEAD")).toBe(
        gitOk(t.native, "cat-file", "-p", "HEAD"),
      );
      const dump = (r: string) =>
        git(r, ["cat-file", "-p", "refs/notes/commits"]).stdout +
        git(r, ["ls-tree", "-r", "refs/notes/commits"]).stdout;
      expect(dump(t.ours)).toBe(dump(t.native));
      expect(state(t.ours), `case ${k}`).toBe(state(t.native));
    }
  });

  it("rebase carries notes over (rewritten-list), with each notes.rewriteMode", {
    timeout: 120_000,
  }, async () => {
    for (const mode of ["concatenate", "overwrite", "cat_sort_uniq", "ignore", undefined]) {
      const t = twins((repo) => {
        const r = (...a: string[]) => {
          const x = spawnSync("git", a, { cwd: repo, env: envOf(), encoding: "utf8" });
          if (x.status !== 0) throw new Error(x.stderr);
        };
        r("checkout", "-q", "topic");
        put(repo, "f.txt", "f\n");
        r("add", ".");
        r("commit", "-qm", "fixup! t1");
        r("checkout", "-q", "main");
        r("notes", "add", "-m", "note of t1\nb", "topic~2");
        r("notes", "add", "-m", "note of t2", "topic~1");
        r("notes", "add", "-m", "note of fixup\na", "topic");
        r("config", "notes.rewriteRef", "refs/notes/commits");
        if (mode) r("config", "notes.rewriteMode", mode);
        r("checkout", "-q", "topic");
      });
      const n = git(t.native, ["rebase", "-i", "--autosquash", "main"], {
        env: { GIT_SEQUENCE_EDITOR: ":", GIT_EDITOR: ":" },
      });
      expect(n.status, n.stderr).toBe(0);
      const g = await open(t.ours);
      const command = g.rebase();
      command.runInteractively({ editTodo: (text) => text, modifyCommitMessage: (text) => text });
      command.setAutosquash(true);
      await command.setUpstreamBranch("main");
      const result = await command.call();
      expect(result.status, result.message).toBe(RebaseStatus.OK);
      expect(gitOk(t.ours, "rev-parse", "HEAD")).toBe(gitOk(t.native, "rev-parse", "HEAD"));
      expect(state(t.ours), `mode ${mode}`).toBe(state(t.native));
    }
  });

  it("rebase -i: reword and squash amend through git commit (notes commit of the amended author)", async () => {
    writeFileSync(
      join(root, "seq.sh"),
      "#!/bin/sh\nsed -i 's/^pick \\(.* t2\\)$/reword \\1/' \"$1\"\n",
    );
    chmodSync(join(root, "seq.sh"), 0o755);
    const t = twins((repo) => {
      const r = (...a: string[]) => {
        const x = spawnSync("git", a, { cwd: repo, env: envOf(), encoding: "utf8" });
        if (x.status !== 0) throw new Error(x.stderr);
      };
      r("checkout", "-q", "topic");
      put(repo, "s.txt", "s\n");
      r("add", ".");
      r("commit", "-qm", "squash! t1");
      r("checkout", "-q", "main");
      r("notes", "add", "-m", "note of t1", "topic~2");
      r("notes", "add", "-m", "note of t2", "topic~1");
      r("notes", "add", "-m", "note of squash", "topic");
      r("config", "notes.rewriteRef", "refs/notes/commits");
      r("checkout", "-q", "topic");
    });
    const n = git(t.native, ["rebase", "-i", "--autosquash", "v1"], {
      env: { GIT_SEQUENCE_EDITOR: join(root, "seq.sh"), GIT_EDITOR: ":" },
    });
    expect(n.status, n.stderr).toBe(0);
    const command = (await open(t.ours)).rebase();
    command.runInteractively({
      editTodo: (text) => text.replace(/^pick (.* t2)$/m, "reword $1"),
      modifyCommitMessage: (text) => text,
    });
    command.setAutosquash(true);
    await command.setUpstreamBranch("v1");
    const result = await command.call();
    expect(result.status, result.message).toBe(RebaseStatus.OK);
    expect(gitOk(t.ours, "rev-parse", "HEAD")).toBe(gitOk(t.native, "rev-parse", "HEAD"));
    expect(state(t.ours)).toBe(state(t.native));
    expect(state(t.native)).toContain("Notes added by 'git commit --amend'");
    expect(gitOk(t.native, "log", "--format=%an: %s", "refs/notes/commits")).toContain(
      "Interop Tester: Notes added by 'git commit --amend'",
    );
  });

  it("git log shows the notes of the display refs", async () => {
    const t = twins((repo) => {
      const r = (...a: string[]) =>
        spawnSync("git", a, { cwd: repo, env: envOf(), encoding: "utf8" });
      r("notes", "add", "-m", "default note", "HEAD");
      r("notes", "--ref", "review", "add", "-m", "review note\n\nsecond", "HEAD");
      r("notes", "--ref", "review", "add", "-m", "older review", "HEAD~1");
      r("notes", "--ref", "x/y", "add", "-m", "nested", "HEAD");
    });
    const cases: {
      args: string[];
      options: Record<string, unknown>;
      env?: Env;
      config?: string[];
    }[] = [
      { args: [], options: {} },
      { args: ["--no-notes"], options: { notes: false } },
      { args: ["--notes=review"], options: { notesRefs: ["review"] } },
      { args: ["--notes", "--notes=review"], options: { notes: true, notesRefs: ["review"] } },
      { args: ["--notes=refs/notes/*"], options: { notesRefs: ["refs/notes/*"] } },
      { args: ["--format=%h %N|"], options: { pretty: "tformat:%h %N|" } },
      { args: [], options: {}, env: { GIT_NOTES_DISPLAY_REF: "refs/notes/rev*" } },
      { args: [], options: {}, env: { GIT_NOTES_REF: "refs/notes/review" } },
      { args: [], options: {}, config: ["notes.displayRef", "refs/notes/x/*"] },
      { args: [], options: {}, config: ["core.notesRef", "refs/notes/review"] },
    ];
    for (const c of cases) {
      if (c.config)
        for (const repo of [t.native, t.ours])
          build(repo, "config", c.config[0] as string, c.config[1] as string);
      const n = git(t.native, ["log", ...c.args], { env: c.env });
      const g = await open(t.ours, c.env);
      const text = await g.log().callText(c.options);
      expect(text, JSON.stringify(c)).toBe(n.stdout);
      if (c.config)
        for (const repo of [t.native, t.ours])
          build(repo, "config", "--unset", c.config[0] as string);
    }
  });

  it("a symbolic notes ref is updated through to the ref it points at (both reflogs)", async () => {
    const t = twins((repo) => {
      const r = (...a: string[]) => {
        const x = spawnSync("git", a, { cwd: repo, env: envOf(), encoding: "utf8" });
        if (x.status !== 0) throw new Error(x.stderr);
      };
      r("notes", "--ref", "real", "add", "-m", "r", "HEAD");
      r("symbolic-ref", "refs/notes/commits", "refs/notes/real");
      r("notes", "--ref", "other", "add", "-m", "o", "HEAD");
      r("notes", "--ref", "other", "add", "-m", "o2", "HEAD~1");
    });
    const symref = (repo: string) => gitOk(repo, "symbolic-ref", "refs/notes/commits");
    await step(t, ["notes", "add", "-f", "-m", "x"], (g) =>
      g.notes().add().setForce(true).addMessage("x").call(),
    );
    expect(symref(t.ours)).toBe("refs/notes/real\n");
    await step(t, ["notes", "remove", "HEAD"], (g) => g.notes().remove().addObjects("HEAD").call());
    await step(t, ["notes", "merge", "-s", "ours", "other"], (g) =>
      g.notes().merge().setStrategy("ours").setRemoteRef("other").call(),
    );
    expect(symref(t.ours)).toBe("refs/notes/real\n");
    // a conflicted merge concluded: NOTES_MERGE_REF names the symref, --commit updates the
    // ref it ends at
    await step(t, ["notes", "--ref", "other", "add", "-f", "-m", "o3", "HEAD~1"], (g) =>
      g.notes("other").add().setForce(true).addMessage("o3").setObject("HEAD~1").call(),
    );
    await step(t, ["notes", "add", "-f", "-m", "l3", "HEAD~1"], (g) =>
      g.notes().add().setForce(true).addMessage("l3").setObject("HEAD~1").call(),
    );
    await step(t, ["notes", "merge", "other"], (g) =>
      g.notes().merge().setRemoteRef("other").call(),
    );
    await step(t, ["notes", "merge", "--commit"], (g) => g.notes().merge().setCommit(true).call());
    expect(symref(t.ours)).toBe("refs/notes/real\n");
  });

  it("a non-note of a subtree read while writing that sorts before one written is dropped", async () => {
    const t = twins();
    for (const repo of [t.native, t.ours]) {
      const mk = (input: string) =>
        spawnSync("git", ["mktree"], {
          cwd: repo,
          env: nativeGitEnv(home),
          input,
          encoding: "utf8",
        }).stdout.trim();
      const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: repo,
        env: nativeGitEnv(home),
        input: "data\n",
        encoding: "utf8",
      }).stdout.trim();
      const cd = mk(`100644 blob ${blob}\tx.txt\n100644 blob ${blob}\t${"e".repeat(36)}\n`);
      const ab = mk(`040000 tree ${cd}\tcd\n100644 blob ${blob}\tzz\n`);
      const root = mk(`040000 tree ${ab}\tab\n`);
      const commit = build(repo, "commit-tree", root, "-m", "hand made").trim();
      build(repo, "update-ref", "refs/notes/commits", commit);
    }
    const object = "ab734d4bce3d75b71d1483975651e52328b69ffc";
    await step(t, ["notes", "add", "-m", "hi", object], (g) =>
      g.notes().add().addMessage("hi").setObject(object).call(),
    );
    const tree = gitOk(t.native, "ls-tree", "-r", "refs/notes/commits");
    expect(tree).not.toContain("x.txt");
    expect(gitOk(t.ours, "ls-tree", "-r", "refs/notes/commits")).toBe(tree);
  });

  it("the editor's template ends with what git show --stat --no-notes prints, commented", async () => {
    const t = twins((repo) => {
      const r = (...a: string[]) => {
        const x = spawnSync("git", a, { cwd: repo, env: nativeGitEnv(home), encoding: "utf8" });
        if (x.status !== 0) throw new Error(x.stderr);
      };
      r("tag", "-a", "-m", "tag message\n\n\tindented", "v2", "HEAD~1");
      r("checkout", "-q", "-b", "m", "main");
      r("merge", "-q", "--no-ff", "-m", "merged", "topic");
      r("checkout", "-q", "main");
    });
    const capture = join(root, "capture.sh");
    writeFileSync(
      capture,
      `#!/bin/sh\ncp "$1" "${join(root, "editmsg")}"\nprintf 'note of %s\\n' "$NOTE_OBJECT" >> "$1"\n`,
    );
    chmodSync(capture, 0o755);
    const objects = ["HEAD", "m", "v2", "HEAD^{tree}", "HEAD:a.txt", "HEAD~2"];
    for (const [i, object] of objects.entries()) {
      if (i === 3) {
        for (const repo of [t.native, t.ours]) build(repo, "config", "core.commentChar", ";");
      }
      let seen = "";
      await step(
        t,
        ["notes", "add", "-f", object],
        (g) =>
          g
            .notes()
            .add()
            .setForce(true)
            .setObject(object)
            .setEditor((text) => {
              seen = text;
              return `${text}note of ${object}\n`;
            })
            .call(),
        {
          env: { GIT_EDITOR: capture, NOTE_OBJECT: object },
          label: `template of ${object}`,
        },
      );
      expect(seen, object).toBe(
        readFileSync(join(root, "editmsg"), "utf8").replace(/note of .*\n$/, ""),
      );
    }
    // a missing object: git show dies, and so does the note's editing
    const missing = "1234567890123456789012345678901234567890";
    await step(
      t,
      ["notes", "add", "-f", missing],
      (g) => g.notes().add().setForce(true).setObject(missing).call(),
      { env: { GIT_EDITOR: ":" } },
    );
  });

  it("a notes merge in progress elsewhere: the worktree's path, the merge's output kept", async () => {
    const t = twins(mergeSetup);
    await step(t, ["notes", "merge", "other"], (g) =>
      g.notes().merge().setRemoteRef("other").call(),
    );
    for (const repo of [t.native, t.ours]) {
      rmSync(join(repo, ".git/NOTES_MERGE_WORKTREE"), { recursive: true, force: true });
    }
    const n = git(t.native, ["notes", "merge", "other"]);
    const mine = await ours(async () =>
      (await open(t.ours)).notes().merge().setRemoteRef("other").call(),
    );
    expect(n.stderr).toContain(`is already in-progress at ${t.native}\n`);
    expect(n.stdout).toContain("CONFLICT");
    expect(mine).toEqual({ ...n, stderr: n.stderr.replaceAll(t.native, t.ours) });
    expect(state(t.ours)).toBe(state(t.native));
  });

  it("merge --commit: notes cleaned as git add cleans them, the ref checked, bad booleans", async () => {
    const t = twins(mergeSetup);
    for (const repo of [t.native, t.ours]) build(repo, "config", "core.autocrlf", "true");
    await step(t, ["notes", "merge", "other"], (g) =>
      g.notes().merge().setRemoteRef("other").call(),
    );
    for (const repo of [t.native, t.ours]) {
      const head = build(repo, "rev-parse", "HEAD").trim();
      const topic1 = build(repo, "rev-parse", "topic~1").trim();
      writeFileSync(join(repo, ".git/NOTES_MERGE_WORKTREE", head), "crlf\r\nresolved\r\n");
      // a symbolic link: git stat()s it, and stores the file it points at
      writeFileSync(join(repo, ".git/target.txt"), "linked\r\n");
      rmSync(join(repo, ".git/NOTES_MERGE_WORKTREE", topic1));
      symlinkSync("../target.txt", join(repo, ".git/NOTES_MERGE_WORKTREE", topic1));
    }
    // the notes ref moved meanwhile: the update expects the partial commit's first parent
    const other = (repo: string) => build(repo, "rev-parse", "refs/notes/other").trim();
    const kept = (repo: string) => build(repo, "rev-parse", "refs/notes/commits").trim();
    const before = { native: kept(t.native), ours: kept(t.ours) };
    for (const repo of [t.native, t.ours]) {
      build(repo, "update-ref", "refs/notes/commits", other(repo));
    }
    const n = git(t.native, ["notes", "merge", "--commit"]);
    expect(n.status).toBe(128);
    const mine = await ours(async () =>
      (await open(t.ours)).notes().merge().setCommit(true).call(),
    );
    expect(mine).toEqual(n);
    expect(state(t.ours)).toBe(state(t.native));
    for (const repo of [t.native, t.ours]) {
      build(
        repo,
        "update-ref",
        "refs/notes/commits",
        repo === t.native ? before.native : before.ours,
      );
    }
    await step(t, ["notes", "merge", "--commit"], (g) => g.notes().merge().setCommit(true).call());
    expect(gitOk(t.ours, "ls-tree", "-r", "refs/notes/commits")).toBe(
      gitOk(t.native, "ls-tree", "-r", "refs/notes/commits"),
    );
    expect(gitOk(t.native, "notes", "show", "HEAD")).toBe("crlf\nresolved\n");
    expect(gitOk(t.native, "notes", "show", "topic~1")).toBe("linked\n");
    // notes.rewrite.<cmd> that is no boolean: git_config_bool dies
    for (const repo of [t.native, t.ours]) {
      build(repo, "config", "notes.rewriteRef", "refs/notes/commits");
      build(repo, "config", "notes.rewrite.rebase", "maybe");
    }
    await step(
      t,
      ["notes", "copy", "--for-rewrite=rebase"],
      (g) => g.notes().copy().setForRewrite("rebase").setStdin("HEAD HEAD~1\n").call(),
      { input: "HEAD HEAD~1\n" },
    );
    for (const repo of [t.native, t.ours]) build(repo, "config", "notes.rewrite.amend", "2x");
    const amend = git(t.native, ["commit", "--amend", "-m", "amended"]);
    expect(amend.status).toBe(128);
    expect(amend.stderr).toBe("fatal: bad boolean config value '2x' for 'notes.rewrite.amend'\n");
    const g = await open(t.ours);
    await expect(g.commit().setAmend(true).setMessage("amended").call()).rejects.toThrow(
      "bad boolean config value '2x' for 'notes.rewrite.amend'",
    );
    expect(gitOk(t.ours, "cat-file", "-p", "HEAD")).toBe(gitOk(t.native, "cat-file", "-p", "HEAD"));
  });

  /** A linked worktree `../wt` (detached) of each twin, opened as ours at its git directory. */
  function linkedTwins(t: { native: string; ours: string }): { native: string; ours: string } {
    for (const repo of [t.native, t.ours])
      build(repo, "worktree", "add", "-q", "--detach", "../wt");
    return { native: join(t.native, "../wt"), ours: join(t.ours, "../wt") };
  }

  async function openLinked(repo: string, env: Env = {}): Promise<Git> {
    const files = createNodeFilesApi({ rootDir: join(repo, "..") });
    const environment = createNodeGitHostEnvironment({ env: envOf(env) });
    const { history } = await createGitFilesBackend({ files, gitDir: "repo/.git" });
    const worktrees = await openGitLinkedWorktrees({
      files,
      gitDir: "repo/.git/worktrees/wt",
      history,
      environment,
    });
    return Git.fromWorkingCopy(await worktrees.openCurrent());
  }

  /** The twins' paths in what native git printed, as ours prints them. */
  const asOurs = (t: { native: string; ours: string }, r: Run): Run => ({
    ...r,
    stdout: r.stdout.replaceAll(join(t.native, ".."), join(t.ours, "..")),
    stderr: r.stderr.replaceAll(join(t.native, ".."), join(t.ours, "..")),
  });

  it("merge 'Already up to date' through a symbolic ref logs on the symref, not on the ref", async () => {
    const t = twins((repo) => {
      const r = (...a: string[]) => {
        const x = spawnSync("git", a, { cwd: repo, env: envOf(), encoding: "utf8" });
        if (x.status !== 0) throw new Error(x.stderr);
      };
      r("notes", "--ref", "real", "add", "-m", "r", "HEAD");
      r("update-ref", "refs/notes/other", "refs/notes/real");
      r("notes", "--ref", "real", "add", "-f", "-m", "r2", "HEAD");
      r("symbolic-ref", "refs/notes/commits", "refs/notes/real");
    });
    const logs = (repo: string) => readFileSync(join(repo, ".git/logs/refs/notes/commits"), "utf8");
    const before = logs(t.native);
    const n = await step(t, ["notes", "merge", "other"], (g) =>
      g.notes().merge().setRemoteRef("other").call(),
    );
    expect(n.stdout).toBe("Already up to date.\n");
    const added = logs(t.native).slice(before.length);
    expect(added).toMatch(/^([0-9a-f]{40}) \1 .*\tnotes: Merged notes from refs\/notes\/other/);
    // the plain ref: unchanged, no reflog line
    const real = readFileSync(join(t.native, ".git/logs/refs/notes/real"), "utf8");
    await step(t, ["notes", "--ref", "real", "merge", "other"], (g) =>
      g.notes("real").merge().setRemoteRef("other").call(),
    );
    expect(readFileSync(join(t.native, ".git/logs/refs/notes/real"), "utf8")).toBe(real);
  });

  it("the editor's template of tags of tags and trees, and of a tag whose target is missing", async () => {
    const t = twins((repo) => {
      const r = (...a: string[]) => {
        const x = spawnSync("git", a, { cwd: repo, env: nativeGitEnv(home), encoding: "utf8" });
        if (x.status !== 0) throw new Error(x.stderr);
        return x.stdout.trim();
      };
      const literal = (content: string) => {
        const x = spawnSync("git", ["hash-object", "-t", "tag", "-w", "--literally", "--stdin"], {
          cwd: repo,
          env: nativeGitEnv(home),
          input: content,
          encoding: "utf8",
        });
        if (x.status !== 0) throw new Error(x.stderr);
        return x.stdout.trim();
      };
      r("tag", "-a", "-m", "one", "t1", "HEAD~1");
      r("tag", "-a", "-m", "two", "t2", "t1");
      r("tag", "-a", "-m", "of a tree", "tt", "HEAD^{tree}");
      r("tag", "-a", "-m", "of a tag of a tree", "tt2", "tt");
      const tagger = "tagger T <t@example.com> 1700000000 +0100\n\n";
      const t1 = r("rev-parse", "t1");
      const nonl = literal(`object ${t1}\ntype tag\ntag nonl\n${tagger}no newline`);
      r("update-ref", "refs/tags/nonl", nonl);
      const missing = "1234567890123456789012345678901234567890";
      const gone = literal(`object ${missing}\ntype commit\ntag gone\n${tagger}gone\n`);
      r("update-ref", "refs/tags/gone", gone);
    });
    const capture = join(root, "capture2.sh");
    writeFileSync(
      capture,
      `#!/bin/sh\ncp "$1" "${join(root, "editmsg2")}"\nprintf 'note of %s\\n' "$NOTE_OBJECT" >> "$1"\n`,
    );
    chmodSync(capture, 0o755);
    for (const object of ["t2", "tt", "tt2", "nonl"]) {
      let seen = "";
      await step(
        t,
        ["notes", "add", "-f", object],
        (g) =>
          g
            .notes()
            .add()
            .setForce(true)
            .setObject(object)
            .setEditor((text) => {
              seen = text;
              return `${text}note of ${object}\n`;
            })
            .call(),
        { env: { GIT_EDITOR: capture, NOTE_OBJECT: object }, label: `template of ${object}` },
      );
      const expected = readFileSync(join(root, "editmsg2"), "utf8");
      expect(seen, object).toBe(expected.replace(/note of .*\n$/, ""));
      if (object === "tt") {
        const id = gitOk(t.native, "rev-parse", "tt").trim();
        expect(expected).toContain(`# tree ${id}\n`);
      }
    }
    const n = await step(
      t,
      ["notes", "add", "-f", "gone"],
      (g) => g.notes().add().setForce(true).setObject("gone").call(),
      { env: { GIT_EDITOR: ":" } },
    );
    expect(n.stderr).toContain(
      "error: could not read object 1234567890123456789012345678901234567890\n",
    );
    expect(n.stderr).toContain("fatal: failed to finish 'show' for object '");
  });

  it("merge --commit in a linked worktree: links followed in its git directory, what stat refuses", async () => {
    const t = twins(mergeSetup);
    const w = linkedTwins(t);
    const both = async (args: string[], run: (g: Git) => Promise<NotesResult | string>) => {
      const n = git(w.native, args);
      const mine = await ours(async () => run(await openLinked(t.ours)));
      if (!n.stderr.includes("does not have a commit checked out")) {
        mine.stderr = mine.stderr.replace(/^error: '.*' does not have a commit checked out\n/m, "");
      }
      expect(mine, args.join(" ")).toEqual(asOurs(t, n));
      expect(state(t.ours), `${args.join(" ")}: state`).toBe(state(t.native));
      return n;
    };
    const merged = await both(["notes", "merge", "other"], (g) =>
      g.notes().merge().setRemoteRef("other").call(),
    );
    expect(merged.stderr).toContain(
      `Fix conflicts in ${join(t.native, ".git/worktrees/wt/NOTES_MERGE_WORKTREE")} and commit`,
    );
    const head = build(t.native, "rev-parse", "HEAD").trim();
    const entry = (repo: string) => join(repo, ".git/worktrees/wt/NOTES_MERGE_WORKTREE", head);
    const replace = (make: (path: string) => void) => {
      for (const repo of [t.native, t.ours]) {
        rmSync(entry(repo), { recursive: true, force: true });
        make(entry(repo));
      }
    };
    const commit = () =>
      both(["notes", "merge", "--commit"], (g) => g.notes().merge().setCommit(true).call());
    replace((p) => symlinkSync("nowhere", p));
    expect((await commit()).stderr).toContain("': No such file or directory\n");
    replace((p) => symlinkSync(head, p));
    expect((await commit()).stderr).toContain("': Too many levels of symbolic links\n");
    replace((p) => mkdirSync(p));
    // (git 2.5x says why index_path refused the directory; 2.43 does not)
    expect((await commit()).stderr).toContain("fatal: Failed to write blob object from '");
    // a link out of the worktree's git directory, into the common one
    for (const repo of [t.native, t.ours]) writeFileSync(join(repo, ".git/target.txt"), "linked\n");
    replace((p) => symlinkSync("../../../target.txt", p));
    expect((await commit()).status).toBe(0);
    expect(gitOk(t.native, "notes", "show", "HEAD")).toBe("linked\n");
    expect(gitOk(t.ours, "ls-tree", "-r", "refs/notes/commits")).toBe(
      gitOk(t.native, "ls-tree", "-r", "refs/notes/commits"),
    );
  });

  it("a dangling notes symref: git's warning, once, from each command that reads the notes", async () => {
    const t = twins();
    const dangle = () => {
      for (const repo of [t.native, t.ours]) {
        build(repo, "update-ref", "-d", "refs/notes/missing");
        build(repo, "symbolic-ref", "refs/notes/commits", "refs/notes/missing");
      }
    };
    for (const repo of [t.native, t.ours]) {
      spawnSync("git", ["notes", "--ref", "other", "add", "-m", "o", "HEAD~1"], {
        cwd: repo,
        env: envOf(),
      });
    }
    const cases: [string[], (g: Git) => Promise<NotesResult | string>, string?][] = [
      [["notes", "list"], (g) => g.notes().list().call()],
      [["notes", "list", "HEAD"], (g) => g.notes().list().setObject("HEAD").call()],
      [["notes", "show"], (g) => g.notes().show().call()],
      [["notes", "add", "-m", "x"], (g) => g.notes().add().addMessage("x").call()],
      [["notes", "append", "-m", "x"], (g) => g.notes().append().addMessage("x").call()],
      [["notes", "copy", "HEAD~1", "HEAD"], (g) => g.notes().copy().setFrom("HEAD~1").call()],
      [["notes", "remove", "HEAD"], (g) => g.notes().remove().addObjects("HEAD").call()],
      [["notes", "prune", "-v"], (g) => g.notes().prune().setVerbose(true).call()],
      [["notes", "get-ref"], (g) => g.notes().getRef().call()],
      [["notes", "merge", "other"], (g) => g.notes().merge().setRemoteRef("other").call()],
      [
        ["notes", "copy", "--stdin"],
        (g) => g.notes().copy().setStdin("HEAD~1 HEAD\n").call(),
        "HEAD~1 HEAD\n",
      ],
    ];
    for (const [args, run, input] of cases) {
      dangle();
      const n = await step(t, args, run, input ? { input } : {});
      const warnings = n.stderr.split("warning: ignoring dangling symref refs/notes/commits\n");
      expect(warnings.length, args.join(" ")).toBe(args[1] === "get-ref" ? 1 : 2);
    }
  });

  it("prune keeps the notes of objects an alternate holds, as git", async () => {
    const t = twins();
    for (const repo of [t.native, t.ours]) {
      const alt = join(repo, "../alt");
      build(join(repo, ".."), "init", "-q", "-b", "main", "alt");
      put(alt, "x.txt", "alt\n");
      build(alt, "add", ".");
      build(alt, "commit", "-qm", "alt");
      writeFileSync(join(repo, ".git/objects/info/alternates"), `${join(alt, ".git/objects")}\n`);
      const borrowed = build(alt, "rev-parse", "HEAD").trim();
      const r = spawnSync("git", ["notes", "add", "-m", "of a borrowed commit", borrowed], {
        cwd: repo,
        env: envOf(),
        encoding: "utf8",
      });
      if (r.status !== 0) throw new Error(r.stderr);
    }
    const n = git(t.native, ["notes", "prune", "-v"]);
    expect(n).toEqual({ status: 0, stdout: "", stderr: "" });
    // the alternate is read through the storage: rooted above both repositories
    const files = createNodeFilesApi({ rootDir: join(t.ours, "..") });
    const gitDir = `${basename(t.ours)}/.git`;
    const { history } = await createGitFilesBackend({ files, gitDir });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir, history });
    const g = Git.fromWorkingCopy(await worktrees.openCurrent());
    const mine = await ours(() => g.notes().prune().setVerbose(true).call());
    expect(mine).toEqual(n);
    expect(state(t.ours)).toBe(state(t.native));
  });

  it("a notes merge in progress in another worktree, and the linked worktree's paths", async () => {
    const t = twins(mergeSetup);
    const w = linkedTwins(t);
    const n1 = git(w.native, ["notes", "merge", "other"]);
    const m1 = await ours(async () =>
      (await openLinked(t.ours)).notes().merge().setRemoteRef("other").call(),
    );
    expect(m1).toEqual(asOurs(t, n1));
    // the main worktree: the linked one's NOTES_MERGE_REF names the ref
    const n2 = git(t.native, ["notes", "merge", "other"]);
    expect(n2.status).toBe(128);
    expect(n2.stderr).toContain(
      `fatal: a notes merge into refs/notes/commits is already in-progress at ${w.native}\n`,
    );
    const m2 = await ours(async () =>
      (await open(t.ours)).notes().merge().setRemoteRef("other").call(),
    );
    expect(m2).toEqual(asOurs(t, n2));
    expect(state(t.ours)).toBe(state(t.native));
    // -v --abort in the linked worktree prints its directory too
    const n3 = git(w.native, ["notes", "merge", "-v", "--abort"]);
    const m3 = await ours(async () =>
      (await openLinked(t.ours)).notes().merge().setVerbosity(3).setAbort(true).call(),
    );
    expect(n3.stdout).toContain(join(t.native, ".git/worktrees/wt/NOTES_MERGE_WORKTREE"));
    expect(m3).toEqual(asOurs(t, n3));
  });
});
