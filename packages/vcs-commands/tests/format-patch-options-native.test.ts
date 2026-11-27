/**
 * `git format-patch`'s sign-off, MIME attachments, notes, cover letters from the branch
 * description, `--ignore-if-in-upstream` and MIME headers, against native git: histories
 * built by native git with pinned dates, formatted by native `git format-patch` and by our
 * FormatPatchCommand with the same options, the mails compared byte for byte (Message-ID
 * timestamps normalised), the file names too.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
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

import { type FormatPatchCommand, Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

type Env = Record<string, string | undefined>;
type Configure = (c: FormatPatchCommand) => FormatPatchCommand;
let root = "";
let home = "";
let version = "";
let counter = 0;

const IDENT: Env = {
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0200",
  GIT_COMMITTER_DATE: "1700000500 -0700",
};

function envOf(over: Env = {}): Record<string, string> {
  const env: Env = { ...nativeGitEnv(home), ...IDENT, ...over };
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

function git(
  cwd: string,
  args: string[],
  env: Env = {},
  input?: string,
): { status: number; stdout: Buffer; stderr: string } {
  const r = spawnSync("git", args, {
    cwd,
    env: envOf(env),
    maxBuffer: 64 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr.toString() };
}

function gitOk(cwd: string, args: string[], env: Env = {}, input?: string): string {
  const r = git(cwd, args, env, input);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
}

let tick = 1700000000;
/** test_tick: each commit a minute later */
function ticked(): Env {
  tick += 60;
  return { GIT_AUTHOR_DATE: `${tick} -0700`, GIT_COMMITTER_DATE: `${tick} -0700` };
}

function newRepo(): string {
  const repo = join(root, `r${counter++}`);
  mkdirSync(repo, { recursive: true });
  gitOk(repo, ["init", "-q", "-b", "main"]);
  return repo;
}

function commitFile(repo: string, path: string, content: string, msg: string, env: Env = {}) {
  writeFileSync(join(repo, path), content);
  gitOk(repo, ["add", path]);
  gitOk(repo, ["commit", "-q", "-m", msg], { ...ticked(), ...env });
}

async function open(repo: string, env: Env = {}): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: envOf(env) });
  const { history: h } = await createGitFilesBackend({ files, gitDir: ".git" });
  const worktrees = await openGitLinkedWorktrees({
    files,
    gitDir: ".git",
    history: h,
    environment,
  });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

const normalise = (text: string) =>
  text.replace(
    /(Message-ID: <|In-Reply-To: <|References: <|\t<)([^.>]+)\.\d+\.git\./g,
    "$1$2.T.git.",
  );

/** Native `git format-patch --stdout <args>` against ours, byte for byte. */
async function compareStdout(
  repo: string,
  args: string[],
  configure: Configure,
  label: string,
  env: Env = {},
): Promise<string> {
  const native = git(repo, ["format-patch", "--stdout", ...args], env);
  if (native.status !== 0) throw new Error(`${label}: ${native.stderr}`);
  const g = await open(repo, env);
  const r = await configure(
    g
      .formatPatch()
      .setStdout(true)
      .setVersionString(version)
      .setMessageIdTime(() => 1),
  ).call();
  g.close();
  const text = normalise(native.stdout.toString("latin1"));
  expect({ label, text: normalise(Buffer.from(r.output).toString("latin1")) }).toEqual({
    label,
    text,
  });
  return native.stdout.toString();
}

/** Native `git format-patch -o <dir> <args>` against ours: the listing and every file. */
async function compareFiles(repo: string, args: string[], configure: Configure, label: string) {
  const dir = `out${counter++}`;
  const native = gitOk(repo, ["format-patch", "-o", dir, ...args]);
  const read = () =>
    readdirSync(join(repo, dir))
      .sort()
      .map((f) => [f, normalise(readFileSync(join(repo, dir, f)).toString("latin1"))]);
  const nativeFiles = read();
  rmSync(join(repo, dir), { recursive: true });
  const g = await open(repo);
  const r = await configure(
    g
      .formatPatch()
      .setOutputDirectory(dir)
      .setVersionString(version)
      .setMessageIdTime(() => 1),
  ).call();
  g.close();
  expect({ label, out: Buffer.from(r.output).toString() }).toEqual({ label, out: native });
  expect({ label, files: read() }).toEqual({ label, files: nativeFiles });
  rmSync(join(repo, dir), { recursive: true });
  return nativeFiles;
}

/** Native git dies with `fatal: <message>`; ours throws that message. */
async function compareDeath(repo: string, args: string[], configure: Configure, label: string) {
  const native = git(repo, ["format-patch", "--stdout", ...args]);
  expect({ label, status: native.status }).toEqual({ label, status: 128 });
  const message = native.stderr.replace(/^fatal: /, "").trimEnd();
  const g = await open(repo);
  await expect(
    configure(g.formatPatch().setStdout(true).setVersionString(version)).call(),
  ).rejects.toThrow(message);
  g.close();
}

describeGit("git format-patch options as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "format-patch-options-native-"));
    home = join(root, "home");
    mkdirSync(home, { recursive: true });
    version = gitOk(root, ["--version"])
      .trim()
      .replace(/^git version /, "");
  });
  afterAll(async () => {
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  /** t4014's setup: main and a side branch, one side patch already applied upstream */
  function upstreamHistory(): string {
    const repo = newRepo();
    commitFile(repo, "file", "A\nB\nC\nD\nE\nF\nG\nH\nI\nJ\n", "Initial");
    gitOk(repo, ["checkout", "-q", "-b", "side"]);
    commitFile(repo, "file", "A\nB\nC\nD\nE\nF\nG\nH\nI\nJ\nK\n", "Side changes #1");
    commitFile(repo, "other", "other\n", "Side changes #2");
    commitFile(repo, "file", "A\nB\nC\nD\nE\nF\nG\nH\nI\nJ\nK\nL\n", "Side changes #3");
    gitOk(repo, ["checkout", "-q", "main"]);
    // the first side change, made again on main (the same patch, another commit)
    commitFile(repo, "file", "A\nB\nC\nD\nE\nF\nG\nH\nI\nJ\nK\n", "Main changes #1");
    commitFile(repo, "third", "third\n", "Main changes #2");
    // an empty commit on both sides: equal (null) patch ids
    gitOk(repo, ["commit", "-q", "--allow-empty", "-m", "empty upstream"], ticked());
    gitOk(repo, ["checkout", "-q", "side"]);
    gitOk(repo, ["commit", "-q", "--allow-empty", "-m", "empty commit"], ticked());
    gitOk(repo, ["checkout", "-q", "main"]);
    return repo;
  }

  it('t4014-format-patch.sh: "format-patch --ignore-if-in-upstream", "format-patch --ignore-if-in-upstream handles tags", "format-patch --ignore-if-in-upstream HEAD"', async () => {
    const repo = upstreamHistory();
    gitOk(repo, ["tag", "-a", "v1", "-m", "tag", "side"], ticked());
    gitOk(repo, ["tag", "-a", "v2", "-m", "tag", "main"], ticked());
    const without = await compareStdout(
      repo,
      ["main..side"],
      (c) => c.addRevision("main..side"),
      "plain",
    );
    expect(without.match(/^From /gm)?.length).toBe(4);
    const kept = await compareStdout(
      repo,
      ["--ignore-if-in-upstream", "main..side"],
      (c) => c.setIgnoreIfInUpstream(true).addRevision("main..side"),
      "main..side",
    );
    expect(kept.match(/^From /gm)?.length).toBe(2);
    await compareStdout(
      repo,
      ["--ignore-if-in-upstream", "v2..v1"],
      (c) => c.setIgnoreIfInUpstream(true).addRevision("v2..v1"),
      "tags",
    );
    await compareStdout(
      repo,
      ["--ignore-if-in-upstream", "^main", "side"],
      (c) => c.setIgnoreIfInUpstream(true).addRevision("^main").addRevision("side"),
      "^main side",
    );
    await compareStdout(
      repo,
      ["--ignore-if-in-upstream", "--cover-letter", "-n", "main..side"],
      (c) =>
        c
          .setIgnoreIfInUpstream(true)
          .setCoverLetter(true)
          .setNumbered(true)
          .addRevision("main..side"),
      "with a cover letter",
    );
    gitOk(repo, ["checkout", "-q", "side"]);
    await compareStdout(
      repo,
      ["--ignore-if-in-upstream", "main"],
      (c) => c.setIgnoreIfInUpstream(true).addRevision("main"),
      "upstream given alone",
    );
    // the same commit on both sides: nothing
    const none = await compareStdout(
      repo,
      ["--ignore-if-in-upstream", "HEAD"],
      (c) => c.setIgnoreIfInUpstream(true).addRevision("HEAD"),
      "HEAD",
    );
    expect(none).toBe("");
    await compareDeath(
      repo,
      ["--ignore-if-in-upstream", "-2"],
      (c) => c.setIgnoreIfInUpstream(true).setMaxCount(2),
      "one revision",
    );
    await compareDeath(
      repo,
      ["--ignore-if-in-upstream", "main", "side"],
      (c) => c.setIgnoreIfInUpstream(true).addRevision("main").addRevision("side"),
      "not a range",
    );
  }, 120_000);

  it('t4014-format-patch.sh: "signoff: commit with no body", "signoff: some random signoff", "signoff: misc conforming footer elements", "signoff: the same signoff at the end, no trailing NL", "signoff: respect trailer config"', async () => {
    const repo = newRepo();
    commitFile(repo, "file", "one\n", "base");
    commitFile(repo, "file", "two\n", "second");
    const messages = [
      "",
      "subject\n",
      "subject",
      "subject\n\nbody\n",
      "subject\n\nbody",
      "subject\n\nbody\n\nSigned-off-by: my@house\n",
      "subject\n\nbody\n\nSigned-off-by: my@house\n(cherry picked from commit da39a3ee5e6b4b0d3255bfef95601890afd80709)\nTested-by: Some One <someone@example.com>\nBug: 1234\n",
      "subject\n\nbody\nFooled-by-me: my@house\n",
      "subject\n\nI want to mention about Signed-off-by: here.\n",
      "subject\n\nMy unfortunate\nSigned-off-by: example happens to be wrapped here.\n",
      "subject\n\nSigned-off-by: my@house\nSigned-off-by: your@house\n\nA lot of houses.\n",
      "subject\n\nbody\n\nSigned-off-by: C O Mitter <committer@example.com>\n",
      "subject\n\nSigned-off-by: C O Mitter <committer@example.com>",
      "subject\n\nbody\n\nSigned-off-by: C O Mitter <committer@example.com>\nSigned-off-by: my@house\n",
      "subject\n\nbody\n\nTested-by: my@house\nSome Trash\nSigned-off-by: C O Mitter <committer@example.com>\n",
      "subject\n\nMyfooter: x\nSome Trash\n",
      "subject\n\nbody\n\nReviewed-id: Noone\nTested-by: my@house\nChange-id: Ideadbeef\nSigned-off-by: C O Mitter <committer@example.com>\nBug: 1234\n",
    ];
    const commits = messages.map((msg) =>
      gitOk(repo, ["commit-tree", "HEAD^^{tree}", "-p", "HEAD"], ticked(), msg).trim(),
    );
    const run = async (label: string) => {
      for (const [k, c] of commits.entries())
        await compareStdout(
          repo,
          ["--signoff", `${c}^..${c}`],
          (x) => x.setSignoff(true).addRevision(`${c}^..${c}`),
          `${label} ${JSON.stringify(messages[k])}`,
        );
    };
    await run("default");
    gitOk(repo, ["config", "trailer.Myfooter.ifexists", "add"]);
    await run("trailer.Myfooter.ifexists");
    gitOk(repo, ["config", "trailer.separators", ":#"]);
    await run("trailer.separators");
    gitOk(repo, ["config", "--unset", "trailer.separators"]);
    gitOk(repo, ["config", "--unset", "trailer.Myfooter.ifexists"]);
    // format.signOff, and a committer whose name needs the 8bit headers
    gitOk(repo, ["config", "format.signOff", "true"]);
    await compareStdout(repo, ["-2"], (c) => c.setMaxCount(2), "format.signOff");
    gitOk(repo, ["config", "--unset", "format.signOff"]);
    await compareStdout(
      repo,
      ["-s", "-2"],
      (c) => c.setSignoff(true).setMaxCount(2),
      "non-ASCII committer",
      { GIT_COMMITTER_NAME: "Çid Mïtter" },
    );
  }, 120_000);

  it('t4014-format-patch.sh: "format-patch --notes --signoff", "format-patch notes output control", "format-patch with multiple notes refs", "format-patch with multiple notes refs in config"', async () => {
    const repo = newRepo();
    commitFile(repo, "file", "one\n", "base");
    commitFile(repo, "file", "two\n", "second\n\nThe body.\n");
    gitOk(repo, ["notes", "add", "-m", "notes config message", "HEAD"], ticked());
    gitOk(repo, ["notes", "--ref", "note1", "add", "-m", "this is note 1", "HEAD"], ticked());
    gitOk(
      repo,
      ["notes", "--ref", "note2", "add", "-m", "this is note 2\n\nsecond paragraph", "HEAD"],
      ticked(),
    );
    gitOk(repo, ["notes", "--ref", "test", "add", "-m", "test message", "HEAD"], ticked());
    type Op = boolean | string;
    const cases: Op[][] = [
      [],
      [true],
      [false],
      [true, false],
      [false, true],
      ["note1"],
      ["note2"],
      ["note1", "note2"],
      ["note1", true],
      ["refs/notes/note2"],
      ["notes/note1"],
      ["note1", false, "note2"],
    ];
    const argOf = (op: Op) =>
      op === true ? "--notes" : op === false ? "--no-notes" : `--notes=${op}`;
    const run = async (label: string) => {
      for (const ops of cases) {
        await compareStdout(
          repo,
          ["-1", ...ops.map(argOf)],
          (c) => {
            c.setMaxCount(1);
            for (const op of ops) c.setNotes(op);
            return c;
          },
          `${label} ${ops.map(argOf).join(" ")}`,
        );
      }
    };
    await run("no config");
    await compareStdout(
      repo,
      ["-1", "--signoff", "--notes=test"],
      (c) => c.setMaxCount(1).setSignoff(true).setNotes("test"),
      "--notes --signoff",
    );
    await compareStdout(
      repo,
      ["-1", "--no-stat", "--notes"],
      (c) => c.setMaxCount(1).setNoStat(true).setNotes(true),
      "--notes -p",
    );
    gitOk(repo, ["config", "format.notes", "true"]);
    await run("format.notes=true");
    gitOk(repo, ["config", "format.notes", "note1"]);
    await run("format.notes=note1");
    gitOk(repo, ["config", "--add", "format.notes", "note2"]);
    await run("format.notes=note1,note2");
    gitOk(repo, ["config", "--replace-all", "format.notes", "note1"]);
    gitOk(repo, ["config", "--add", "format.notes", "false"]);
    await run("format.notes=note1,false");
    gitOk(repo, ["config", "--add", "format.notes", "note2"]);
    await run("format.notes=note1,false,note2");
    gitOk(repo, ["config", "--unset-all", "format.notes"]);
    gitOk(repo, ["config", "notes.displayRef", "refs/notes/note*"]);
    await run("notes.displayRef");
  }, 120_000);

  /** A small history with a binary file, a rename and a non-ASCII body */
  function attachHistory(): string {
    const repo = newRepo();
    commitFile(repo, "file", "1\n2\n3\n", "Initial");
    commitFile(repo, "file", "1\n2\n3\n4\n", "Second commit");
    writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 255, 0, 7]));
    gitOk(repo, ["add", "bin.dat"]);
    gitOk(repo, ["commit", "-q", "-m", "Add a binary"], ticked());
    gitOk(repo, ["mv", "file", "renamed"]);
    gitOk(repo, ["commit", "-q", "-m", "Rename it\n\nutf-8 body: ñ\n"], ticked());
    commitFile(repo, "renamed", "1\n2\n3\n4\n5\n", "Fourth: [core] sub/ject");
    return repo;
  }

  it('t4014-format-patch.sh: "format-patch --base with --attach", "format-patch --attach cover-letter only is non-multipart", "format-patch with format.attach", "format-patch with format.attach=disabled"', async () => {
    const repo = attachHistory();
    const cases: [string[], Configure][] = [
      [["--attach", "-3"], (c) => c.setAttach(true).setMaxCount(3)],
      [["--attach=mimemime", "-2"], (c) => c.setAttach("mimemime").setMaxCount(2)],
      [["--inline", "-3"], (c) => c.setInline(true).setMaxCount(3)],
      [["--inline=sep", "-1"], (c) => c.setInline("sep").setMaxCount(1)],
      [["--attach", "--no-attach", "-2"], (c) => c.setAttach(true).setAttach(false).setMaxCount(2)],
      [["--attach", "--inline", "-1"], (c) => c.setAttach(true).setInline(true).setMaxCount(1)],
      [["--inline", "--attach=x", "-1"], (c) => c.setInline(true).setAttach("x").setMaxCount(1)],
      [
        ["--attach=mimemime", "--base=HEAD~", "-1"],
        (c) => c.setAttach("mimemime").setBase("HEAD~").setMaxCount(1),
      ],
      [
        ["--attach", "--suffix=.diff", "-2"],
        (c) => c.setAttach(true).setSuffix(".diff").setMaxCount(2),
      ],
      [
        ["--attach", "--numbered-files", "-2"],
        (c) => c.setAttach(true).setNumberedFiles(true).setMaxCount(2),
      ],
      [
        ["--attach", "-v2", "--rfc", "-2"],
        (c) => c.setAttach(true).setRerollCount(2).setRfc(true).setMaxCount(2),
      ],
      [["--attach", "--no-stat", "-2"], (c) => c.setAttach(true).setNoStat(true).setMaxCount(2)],
      [
        ["--inline", "--cover-letter", "-2"],
        (c) => c.setInline(true).setCoverLetter(true).setMaxCount(2),
      ],
      [
        ["--attach", "--signoff", "--to=a@x", "--add-header=X-Foo: bar", "-2"],
        (c) =>
          c.setAttach(true).setSignoff(true).addTo("a@x").addHeader("X-Foo: bar").setMaxCount(2),
      ],
      [
        ["--attach", "--filename-max-length=12", "-2"],
        (c) => c.setAttach(true).setFilenameMaxLength(12).setMaxCount(2),
      ],
      [["--inline", "--thread", "-2"], (c) => c.setInline(true).setThread(true).setMaxCount(2)],
    ];
    for (const [args, configure] of cases)
      await compareStdout(repo, args, configure, args.join(" "));
    await compareStdout(
      repo,
      ["--attach", "--signoff", "-1"],
      (c) => c.setAttach(true).setSignoff(true).setMaxCount(1),
      "attach, non-ASCII committer",
      { GIT_COMMITTER_NAME: "Çid Mïtter" },
    );
    // files: the cover letter is no multipart mail
    const files = await compareFiles(
      repo,
      ["--cover-letter", "--attach=mimemime", "--base=HEAD~", "-1"],
      (c) => c.setCoverLetter(true).setAttach("mimemime").setBase("HEAD~").setMaxCount(1),
      "cover letter only is non-multipart",
    );
    expect(files[0]?.[1]).not.toMatch(/^--+mimemime/m);
    await compareFiles(
      repo,
      ["--inline", "--numbered-files", "-2"],
      (c) => c.setInline(true).setNumberedFiles(true).setMaxCount(2),
      "inline numbered files",
    );
    // format.attach: a value, an empty value, no value (the version)
    gitOk(repo, ["config", "format.attach", "attachment-separator"]);
    const configured = await compareFiles(repo, ["-1"], (c) => c.setMaxCount(1), "format.attach");
    expect(configured[0]?.[1]).toMatch(/^Content-Type: multipart\/.*attachment-separator/m);
    await compareStdout(
      repo,
      ["--inline", "-1"],
      (c) => c.setInline(true).setMaxCount(1),
      "format.attach --inline",
    );
    await compareStdout(
      repo,
      ["--no-attach", "-1"],
      (c) => c.setAttach(false).setMaxCount(1),
      "format.attach --no-attach",
    );
    gitOk(repo, ["config", "--add", "format.attach", ""]);
    const disabled = await compareFiles(repo, ["-1"], (c) => c.setMaxCount(1), "format.attach=");
    expect(disabled[0]?.[1]).not.toMatch(/^Content-Type: multipart\//m);
    gitOk(repo, ["config", "--unset-all", "format.attach"]);
    appendFileSync(join(repo, ".git", "config"), "[format]\n\tattach\n");
    await compareStdout(repo, ["-2"], (c) => c.setMaxCount(2), "valueless format.attach");
  }, 120_000);

  /** t4014's rebuild-1: two commits on a branch off main */
  function descriptionHistory(): string {
    const repo = newRepo();
    commitFile(repo, "file", "1\n", "Initial");
    gitOk(repo, ["checkout", "-q", "-b", "rebuild-1"]);
    commitFile(repo, "file", "1\n2\n", "First on the branch");
    commitFile(repo, "file", "1\n2\n3\n", "Second on the branch");
    return repo;
  }

  it('t4014-format-patch.sh: "cover letter with format.coverFromDescription = default", "cover letter with --cover-from-description subject (UTF-8 subject line)", "cover letter with --cover-from-description auto (long subject line)", "cover letter with command-line --cover-from-description overrides config"', async () => {
    const repo = descriptionHistory();
    const descriptions = [
      "config subject\n\nbody",
      "Café?\n\nbody",
      "this is a really long first line and it is over 100 characters long which is the threshold for long subjects\n\nbody",
      "hello",
      "first line\nsecond line of the subject\n\nbody line  \n\n\nlast\n\n",
      "\nleading blank line\n\nbody",
      "  indented subject\n\n\tbody with a tab",
      "a subject line that is long enough to need wrapping when it goes into the Subject header of the mail",
    ];
    const modes = [undefined, "default", "none", "message", "subject", "auto"] as const;
    for (const description of descriptions) {
      gitOk(repo, ["config", "branch.rebuild-1.description", description]);
      for (const mode of modes) {
        await compareStdout(
          repo,
          ["--cover-letter", ...(mode ? [`--cover-from-description=${mode}`] : []), "main"],
          (c) => {
            c.setCoverLetter(true).addRevision("main");
            return mode ? c.setCoverFromDescription(mode) : c;
          },
          `${JSON.stringify(description)} --cover-from-description=${mode}`,
        );
      }
      for (const mode of ["none", "subject", "auto", "message"]) {
        gitOk(repo, ["config", "format.coverFromDescription", mode]);
        await compareStdout(
          repo,
          ["--cover-letter", "main"],
          (c) => c.setCoverLetter(true).addRevision("main"),
          `${JSON.stringify(description)} format.coverFromDescription=${mode}`,
        );
        await compareStdout(
          repo,
          ["--cover-letter", "--cover-from-description=subject", "main"],
          (c) => c.setCoverLetter(true).setCoverFromDescription("subject").addRevision("main"),
          `${JSON.stringify(description)} format.coverFromDescription=${mode} overridden`,
        );
      }
      gitOk(repo, ["config", "--unset", "format.coverFromDescription"]);
    }
    gitOk(repo, ["config", "format.encodeEmailHeaders", "false"]);
    gitOk(repo, ["config", "branch.rebuild-1.description", "Café?\n\nbody"]);
    await compareStdout(
      repo,
      ["--cover-letter", "--cover-from-description=subject", "main"],
      (c) => c.setCoverLetter(true).setCoverFromDescription("subject").addRevision("main"),
      "unencoded headers",
    );
    gitOk(repo, ["config", "--unset", "format.encodeEmailHeaders"]);
    // invalid modes die, from the command line or the configuration
    await compareDeath(
      repo,
      ["--cover-letter", "--cover-from-description", "garbage", "main"],
      (c) => c.setCoverLetter(true).setCoverFromDescription("garbage").addRevision("main"),
      "invalid --cover-from-description",
    );
    gitOk(repo, ["config", "format.coverFromDescription", "garbage"]);
    await compareDeath(
      repo,
      ["--cover-letter", "main"],
      (c) => c.setCoverLetter(true).addRevision("main"),
      "invalid config",
    );
    gitOk(repo, ["config", "--unset", "format.coverFromDescription"]);
  }, 300_000);

  it('t4014-format-patch.sh: "cover letter using branch description (1)", "cover letter using branch description (2)", "cover letter using branch description (3)", "cover letter using branch description (4)", "cover letter using branch description (5)", "cover letter using branch description (6)"', async () => {
    const repo = descriptionHistory();
    gitOk(repo, ["config", "branch.rebuild-1.description", "hello"]);
    gitOk(repo, ["config", "branch.main.description", "main's description"]);
    gitOk(repo, ["tag", "lightweight", "rebuild-1"]);
    const cases: [string[], Configure][] = [
      [["main"], (c) => c.addRevision("main")],
      [["rebuild-1~2..rebuild-1"], (c) => c.addRevision("rebuild-1~2..rebuild-1")],
      [["^main", "rebuild-1"], (c) => c.addRevision("^main").addRevision("rebuild-1")],
      [["main.."], (c) => c.addRevision("main..")],
      [["-2", "HEAD"], (c) => c.setMaxCount(2).addRevision("HEAD")],
      [["-2"], (c) => c.setMaxCount(2)],
      [["-2", "rebuild-1"], (c) => c.setMaxCount(2).addRevision("rebuild-1")],
      [["main..lightweight"], (c) => c.addRevision("main..lightweight")],
      [["main..rebuild-1~1"], (c) => c.addRevision("main..rebuild-1~1")],
      [["-1", "main"], (c) => c.setMaxCount(1).addRevision("main")],
      [["--root", "main"], (c) => c.setRoot(true).addRevision("main")],
    ];
    for (const [args, configure] of cases)
      await compareStdout(
        repo,
        ["--cover-letter", ...args],
        (c) => configure(c.setCoverLetter(true)),
        args.join(" "),
      );
    // detached HEAD: no branch
    gitOk(repo, ["checkout", "-q", "--detach"]);
    await compareStdout(
      repo,
      ["--cover-letter", "main"],
      (c) => c.setCoverLetter(true).addRevision("main"),
      "detached",
    );
  }, 120_000);

  it('t4028-format-patch-mime-headers.sh: "patch has mime headers", "patch has mime and extra headers"', async () => {
    const repo = newRepo();
    commitFile(repo, "file", "content\n", "one");
    commitFile(repo, "file", "content\nmore\n", "two\n\nutf-8 body: ñ");
    const plain = await compareFiles(
      repo,
      ["HEAD^"],
      (c) => c.addRevision("HEAD^"),
      "mime headers",
    );
    expect(plain[0]?.[0]).toBe("0001-two.patch");
    expect(plain[0]?.[1]).toMatch(/^Content-Type: text\/plain; charset=UTF-8$/m);
    expect(plain[0]?.[1]).toMatch(/^Content-Transfer-Encoding: 8bit$/m);
    gitOk(repo, ["config", "format.headers", "x-foo: bar"]);
    const extra = await compareFiles(
      repo,
      ["HEAD^"],
      (c) => c.addRevision("HEAD^"),
      "mime and extra headers",
    );
    expect(extra[0]?.[1]).toMatch(/^x-foo: bar$/m);
    expect(extra[0]?.[1]).toMatch(/^Content-Type: text\/plain; charset=UTF-8$/m);
    // an ASCII body with a non-ASCII author: no 8bit headers, the From: encoded
    commitFile(repo, "file", "content\nmore\nagain\n", "three", { GIT_AUTHOR_NAME: "Ñandú Ñu" });
    await compareStdout(repo, ["-2"], (c) => c.setMaxCount(2), "non-ASCII author");
    await compareStdout(
      repo,
      ["-2", "--from"],
      (c) => c.setMaxCount(2).setFrom(true),
      "in-body From",
    );
  }, 120_000);
});
