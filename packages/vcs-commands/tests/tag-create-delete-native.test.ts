/**
 * `git.tag()` and `git.tagDelete()` against native `git tag` (create and delete modes), on the
 * files and the reftable backends: t7004-tag.sh's forced replacements (`Updated tag 'x' (was
 * abc1234)`), deletions and their refusals (`Deleted tag 'x' (was abc1234)`, `error: tag 'x'
 * not found.`, exit codes), `--create-reflog`, `-e` with git's template and cleanup, the
 * previous tag's body reused by `-f`, and `--trailer` (git 2.46+). Each case runs the same
 * arguments through native git in one copy of a repository and through ours in another, then
 * compares stdout, stderr, the exit status, the refs, the reflogs (a reftable repository's
 * through `git refs migrate`), `TAG_EDITMSG` and the loose object count.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
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

import { type CleanupMode, Git, GitApiError } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let version = "";
let reftable = false;

const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...nativeGitEnv(root),
  TZ: "UTC",
  GIT_EDITOR: ":",
  ...extra,
});

function run(cwd: string, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync("git", args, { cwd, env: env(extra) });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout as Buffer).toString("utf8"),
    stderr: (r.stderr as Buffer).toString("utf8"),
  };
}

function gitOk(cwd: string, args: string[]): string {
  const r = run(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** Runs a setup script (bash, t/test-lib.sh's helpers defined) in `dir`. */
function sh(dir: string, script: string): void {
  const prelude = `
set -e
export GIT_AUTHOR_NAME="A U Thor" GIT_AUTHOR_EMAIL=author@example.com
export GIT_COMMITTER_NAME="C O Mitter" GIT_COMMITTER_EMAIL=committer@example.com
test_tick () {
  if test -z "\${test_tick+set}"; then test_tick=1112911993; else test_tick=$((test_tick + 60)); fi
  export GIT_COMMITTER_DATE="$test_tick -0700" GIT_AUTHOR_DATE="$test_tick -0700"
}
test_tick
test_commit () {
  echo "$1" >"$1.t" && git add "$1.t" && test_tick && git commit -q -m "$1"
}
`;
  const r = spawnSync("bash", ["-c", prelude + script], { cwd: dir, env: env() });
  if (r.status !== 0) throw new Error(`setup failed: ${r.stderr.toString()}`);
}

async function openOurs(dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const environment = createNodeGitHostEnvironment({ env: env() });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/**
 * The editors of the cases: a shell script for native git (`GIT_EDITOR`, copying what it was
 * given to `$EDITOR_SEEN` first) and the same edit as ours (`setEditor`).
 */
const EDITORS = {
  /** t7004's first fakeeditor */
  replace: {
    sh: 'sed -e "s/A message/An edited message/g" <"$1" >"$1-" && mv "$1-" "$1"',
    js: (text: string): string | undefined => text.replaceAll("A message", "An edited message"),
  },
  /** t7004's "create tag with -m and --trailer and --edit" */
  prefix: {
    sh: 'sed -e "1s/^/EDITED: /g" <"$1" >"$1-" && mv "$1-" "$1"',
    js: (text: string): string | undefined => text.replace(/^/, "EDITED: "),
  },
  /** t7004's "create annotated tag and force editor when only --trailer is given" */
  addLine: {
    sh: 'echo "add a line" >"$1-" && cat <"$1" >>"$1-" && mv "$1-" "$1"',
    js: (text: string): string | undefined => `add a line\n${text}`,
  },
  /** An editor leaving the file as it is (`GIT_EDITOR=true`) */
  same: {
    sh: "true",
    js: (_text: string): string | undefined => undefined,
  },
  /** An editor that fails (`GIT_EDITOR=false`) */
  fail: {
    sh: "false",
    js: (_text: string): string | undefined => {
      throw new Error("editor failed");
    },
  },
} as const;

type EditorName = keyof typeof EDITORS;

interface Case {
  /** The arguments after `git tag` */
  args: string[];
  editor?: EditorName;
  /** [major, minor] native git must be at least */
  since?: [number, number];
  /** A script run in both copies first */
  before?: string;
}

type Backend = "files" | "reftable";

/** The command for `tag <args>` run through ours; git's stdout, stderr and exit status. */
async function runOurs(
  dir: string,
  args: string[],
  editor: EditorName | undefined,
  seen: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  const git = await openOurs(dir);
  const compatibility = gitAtLeast(version, 2, 45) ? "2.56" : "2.43";
  try {
    if (args[0] === "-d" || args[0] === "--delete") {
      const command = git.tagDelete().setCompatibility(compatibility);
      if (args.length > 1) command.setTags(...args.slice(1));
      const result = await command.callText();
      return {
        status: result.exitCode,
        stdout: result.output,
        stderr: result.errors.map((e) => `${e}\n`).join(""),
      };
    }
    const command = git.tag().setCompatibility(compatibility);
    const positional: string[] = [];
    let messages = 0;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string;
      const eq = arg.indexOf("=");
      const [name, value] =
        arg.startsWith("--") && eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
      switch (name) {
        case "-a":
          command.setAnnotated(true);
          break;
        case "-f":
        case "--force":
          command.setForce(true);
          break;
        case "-e":
        case "--edit":
          command.setEdit(true);
          break;
        case "--create-reflog":
          command.setCreateReflog(true);
          break;
        case "-m":
          if (messages++ === 0) command.setMessage(args[++i] as string);
          else command.addMessage(args[++i] as string);
          break;
        case "-F":
          command.setMessage(readFileSync(join(dir, args[++i] as string), "utf8"));
          break;
        case "--trailer":
          command.addTrailer(value ?? (args[++i] as string));
          break;
        case "--cleanup":
          command.setCleanupMode(value as CleanupMode);
          break;
        default:
          if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
          positional.push(arg);
      }
    }
    command.setName(positional[0] as string);
    if (positional[1] !== undefined) command.setObjectId(positional[1]);
    if (editor) {
      command.setEditor(async (path, text) => {
        expect(path).toBe("TAG_EDITMSG");
        seen.push(text);
        return EDITORS[editor].js(text);
      });
    }
    const result = await command.callText();
    return {
      status: 0,
      stdout: result.output,
      stderr: result.warnings.map((w) => `${w}\n`).join(""),
    };
  } catch (e) {
    if (!(e instanceof GitApiError)) throw e;
    return { status: e.exitCode, stdout: "", stderr: `${e.message}\n` };
  }
}

/** Every file under `dir`, relative path to content. */
function filesUnder(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, filesUnder(path, rel));
    else out[rel] = readFileSync(path, "utf8");
  }
  return out;
}

/** What a case leaves: refs, reflogs (as the files backend writes them), TAG_EDITMSG, objects. */
function snapshot(dir: string, backend: Backend) {
  const refs = gitOk(dir, ["for-each-ref", "--format=%(refname) %(objectname) %(*objectname)"]);
  let logsDir = join(dir, ".git", "logs");
  let migrated: string | undefined;
  if (backend === "reftable") {
    migrated = mkdtempSync(join(root, "migrated-"));
    cpSync(dir, migrated, { recursive: true });
    gitOk(migrated, ["refs", "migrate", "--ref-format=files"]);
    logsDir = join(migrated, ".git", "logs");
  }
  const logs = filesUnder(logsDir);
  if (migrated) rmSync(migrated, { recursive: true, force: true });
  const editMsgPath = join(dir, ".git", "TAG_EDITMSG");
  const tagEditMsg = existsSync(editMsgPath) ? readFileSync(editMsgPath, "utf8") : null;
  const objects = gitOk(dir, ["count-objects"]).split(",")[0];
  return { refs, logs, tagEditMsg, objects };
}

let counter = 0;

/** A repository made by `setup` with the backend's ref format. */
function repo(backend: Backend, setup: string): string {
  const dir = join(root, `base-${counter++}`);
  mkdirSync(dir, { recursive: true });
  sh(
    dir,
    `git init -q -b main${backend === "reftable" ? " --ref-format=reftable" : ""} .\n${setup}`,
  );
  return dir;
}

/** Runs `c` through native git and ours on copies of `base` and compares what they did. */
async function twin(base: string, backend: Backend, c: Case): Promise<void> {
  if (c.since && !gitAtLeast(version, c.since[0], c.since[1])) return;
  const label = `[${backend}] tag ${c.args.join(" ")}${c.editor ? ` (editor ${c.editor})` : ""}`;
  const native = join(root, `native-${counter}`);
  const ours = join(root, `ours-${counter++}`);
  cpSync(base, native, { recursive: true });
  cpSync(base, ours, { recursive: true });
  try {
    if (c.before) {
      sh(native, c.before);
      sh(ours, c.before);
    }
    const seenFile = join(root, "seen.txt");
    rmSync(seenFile, { force: true });
    const editorEnv: Record<string, string> = c.editor
      ? { GIT_EDITOR: join(root, `editor-${c.editor}`), EDITOR_SEEN: seenFile }
      : {};
    const expected = run(native, ["tag", ...c.args], editorEnv);
    const seen: string[] = [];
    const actual = await runOurs(ours, c.args, c.editor, seen);
    expect(actual.status, `${label} (status; native stderr: ${expected.stderr})`).toBe(
      expected.status,
    );
    expect(actual.stdout, `${label} (stdout)`).toBe(expected.stdout);
    if (c.editor === "fail") {
      // git names the editor first (`error: there was a problem with the editor 'false'`)
      expect(expected.stderr.endsWith(actual.stderr), `${label} (stderr)`).toBe(true);
    } else {
      expect(actual.stderr, `${label} (stderr)`).toBe(expected.stderr);
    }
    if (c.editor) {
      const nativeSeen = existsSync(seenFile) ? [readFileSync(seenFile, "utf8")] : [];
      expect(seen, `${label} (editor's text)`).toEqual(nativeSeen);
    }
    expect(snapshot(ours, backend), `${label} (state)`).toEqual(snapshot(native, backend));
  } finally {
    rmSync(native, { recursive: true, force: true });
    rmSync(ours, { recursive: true, force: true });
  }
}

describeGit("tag creation and deletion against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tag-create-delete-native-"));
    version = run(root, ["--version"]).stdout;
    const probe = join(root, "reftable-probe");
    reftable = run(root, ["init", "-q", "--ref-format=reftable", probe]).status === 0;
    rmSync(probe, { recursive: true, force: true });
    for (const [name, editor] of Object.entries(EDITORS)) {
      const path = join(root, `editor-${name}`);
      writeFileSync(path, `#!/bin/sh\ncp "$1" "$EDITOR_SEEN"\n${editor.sh}\n`);
      chmodSync(path, 0o755);
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const backends = (): Backend[] => (reftable ? ["files", "reftable"] : ["files"]);

  /** t7004's start: two commits, a lightweight and an annotated tag on the first. */
  const SETUP = `test_commit one
test_commit two
git tag mytag HEAD~1
test_tick
git tag -m "An annotation to be reused" annotated HEAD~1
test_tick`;

  it("t7004: creating over an existing tag, -f and its 'Updated tag' line", {
    timeout: 300_000,
  }, async () => {
    const cases: Case[] = [
      // trying to create a tag with the name of one existing should fail
      { args: ["mytag"] },
      { args: ["mytag", "HEAD"] },
      // --force can create a tag with the name of one existing
      { args: ["--force", "mytag"] },
      { args: ["-f", "mytag", "HEAD~1"] },
      { args: ["-f", "mytag", "HEAD^{tree}"] },
      // --force is moot with a non-existing tag name
      { args: ["--force", "forcetag"] },
      { args: ["-f", "-m", "now annotated", "mytag"] },
      { args: ["-f", "-m", "An annotation to be reused", "annotated", "HEAD~1"] },
      { args: ["-f", "-m", "new annotation", "annotated"] },
      { args: ["-f", "-m", "of a tree", "annotated", "HEAD^{tree}"] },
      { args: ["-f", "annotated"] },
      // a tag of a tag: git's nested-tag advice
      { args: ["-m", "nested", "nest", "annotated"] },
      { args: ["-f", "-m", "nested", "mytag", "annotated"] },
      // trying to create a tag with a non-valid name should fail
      { args: [""] },
      { args: [".othertag"] },
      { args: ["other tag"] },
      { args: ["othertag^"] },
      { args: ["other~tag"] },
      { args: ["HEAD"] },
      { args: ["newtag", "nonexistent"] },
      // overwriting an annotated tag should use its previous body
      { args: ["-f", "-a", "annotated"], editor: "same" },
      { args: ["-f", "-a", "annotated"] },
      // a lightweight tag has no body to reuse
      { args: ["-f", "-a", "mytag"], editor: "same" },
    ];
    for (const backend of backends()) {
      const base = repo(backend, SETUP);
      for (const c of cases) await twin(base, backend, c);
    }
  });

  it("t7004: deleting tags, their output and refusals", { timeout: 300_000 }, async () => {
    const cases: Case[] = [
      // trying to delete an unknown tag should fail
      { args: ["-d", "unknown-tag"] },
      // trying to delete tags without params should succeed and do nothing
      { args: ["-d"] },
      // deleting two existing tags in one command should succeed
      { args: ["-d", "mytag", "annotated"] },
      // trying to delete two tags, existing and not, should fail in the 2nd
      { args: ["-d", "mytag", "nonexistingtag"] },
      { args: ["-d", "nonexistingtag", "mytag", "other"] },
      // one tag named twice: one transaction refuses both
      { args: ["-d", "mytag", "mytag"] },
      { args: ["-d", "mytag", "annotated", "mytag"] },
      // "git tag" can remove a tag named HEAD
      { args: ["-d", "HEAD"], before: "git update-ref refs/tags/HEAD HEAD" },
      // names are always under refs/tags/
      { args: ["-d", "refs/tags/mytag"] },
      // packed tags
      { args: ["-d", "mytag", "annotated"], before: "git pack-refs --all" },
      // reflogs go with their tags
      { args: ["-d", "logged"], before: "git tag --create-reflog logged" },
    ];
    for (const backend of backends()) {
      const base = repo(backend, SETUP);
      for (const c of cases) await twin(base, backend, c);
    }
  });

  it("t7004: --create-reflog", { timeout: 300_000 }, async () => {
    const cases: Case[] = [
      // creating a tag with --create-reflog should create reflog
      { args: ["--create-reflog", "tag_with_reflog1"] },
      // annotated tag with --create-reflog has correct message
      { args: ["-m", "annotated tag", "--create-reflog", "tag_with_reflog2"] },
      { args: ["--create-reflog", "tree_reflog", "HEAD^{tree}"] },
      // --create-reflog does not create reflog on failure
      { args: ["--create-reflog", "mytag"] },
      { args: ["-f", "--create-reflog", "mytag"] },
      { args: ["-f", "--create-reflog", "-m", "replaced", "annotated"] },
      // option core.logAllRefUpdates=always creates reflog
      { args: ["tag_with_reflog3"], before: "git config core.logAllRefUpdates always" },
      // an existing reflog is appended to
      { args: ["-f", "logged", "HEAD~1"], before: "git tag --create-reflog logged" },
    ];
    for (const backend of backends()) {
      const base = repo(backend, SETUP);
      for (const c of cases) await twin(base, backend, c);
    }
  });

  it("t7004: -e and the editor's template and cleanup", { timeout: 300_000 }, async () => {
    const cases: Case[] = [
      // creating an annotated tag with -m message --edit should succeed
      { args: ["-m", "A message", "--edit", "annotated-tag-edit"], editor: "replace" },
      // creating an annotated tag with -F messagefile --edit should succeed
      {
        args: ["-F", "msgfile", "--edit", "file-annotated-tag-edit"],
        editor: "replace",
        before: "echo 'A message' >msgfile",
      },
      { args: ["-m", "A message", "-m", "second", "-e", "two-paragraphs"], editor: "addLine" },
      // git tag -a fails if tag annotation is empty; message in editor has initial comment
      { args: ["-a", "initial-comment"], editor: "same" },
      { args: ["-a", "initial-comment"] },
      { args: ["-a", "added"], editor: "addLine" },
      { args: ["-a", "--cleanup=whitespace", "kept-comments"], editor: "addLine" },
      { args: ["-a", "--cleanup=verbatim", "verbatim"], editor: "addLine" },
      { args: ["-a", "--cleanup=strip", "stripped"], editor: "addLine" },
      {
        args: ["-a", "semicolon"],
        editor: "addLine",
        before: "git config core.commentChar ';'",
      },
      // -e alone: git 2.43 makes a lightweight tag, 2.5x an annotated one
      { args: ["-e", "edit-alone"], editor: "addLine" },
      { args: ["-e", "-m", "", "empty-message"], editor: "addLine" },
      { args: ["-f", "-e", "-m", "", "annotated"], editor: "same" },
      { args: ["-f", "-e", "annotated"], editor: "addLine" },
      { args: ["-f", "-e", "-m", "abc", "--cleanup=verbatim", "annotated"], editor: "same" },
      // a failing editor
      { args: ["-a", "no-editor"], editor: "fail" },
      { args: ["-e", "-m", "x", "no-editor"], editor: "fail", since: [2, 45] },
    ];
    for (const backend of backends()) {
      const base = repo(backend, SETUP);
      for (const c of cases) await twin(base, backend, c);
    }
  });

  it("t7004: --trailer", { timeout: 300_000 }, async () => {
    const since: [number, number] = [2, 46];
    const cases: Case[] = [
      // create tag with -m and --trailer
      {
        args: [
          "-m",
          "create tag with trailers",
          "--trailer",
          "my-trailer=here",
          "--trailer",
          "alt-trailer=there",
          "tag-with-inline-message-and-trailers",
        ],
      },
      // create tag with -F and --trailer
      {
        args: [
          "-F",
          "messagefilewithnotrailers",
          "--trailer",
          "my-trailer=here",
          "--trailer",
          "alt-trailer=there",
          "tag-with-file-message-and-trailers",
        ],
        before: 'echo "create tag from message file using --trailer" >messagefilewithnotrailers',
      },
      // create tag with -m and --trailer and --edit
      {
        args: [
          "--edit",
          "-m",
          "create tag with trailers",
          "--trailer",
          "my-trailer=here",
          "--trailer",
          "alt-trailer=there",
          "tag-with-edited-inline-message-and-trailers",
        ],
        editor: "prefix",
      },
      // create annotated tag and force editor when only --trailer is given
      {
        args: [
          "--trailer",
          "my-trailer=here",
          "--trailer",
          "alt-trailer=there",
          "tag-with-trailers-and-no-message",
        ],
        editor: "addLine",
      },
      { args: ["--trailer", "my-trailer=here", "no-editor-only-trailers"] },
      // bad editor causes panic when only --trailer is given
      { args: ["--trailer", "my-trailer=here", "tag-will-not-exist"], editor: "fail" },
      // configured trailers, an existing trailer block, cleanup modes
      {
        args: ["-m", "subject", "--trailer", "sign=Me <me@example.com>", "configured"],
        before: 'git config trailer.sign.key "Signed-off-by: "',
      },
      {
        args: ["-m", "subject\n\nAcked-by: x", "--trailer", "Acked-by: x", "dedup"],
        before: "git config trailer.ifexists addIfDifferent",
      },
      {
        args: ["-m", "subject\n# comment", "--trailer", "a=b", "--cleanup=verbatim", "verbatim"],
      },
      {
        args: ["-m", "subject\n# comment", "--trailer", "a=b", "--cleanup=whitespace", "ws"],
      },
      // -f reuses the previous body, trailers added to it
      { args: ["-f", "--trailer", "a=b", "annotated"] },
      // refused trailers
      { args: ["-m", "m", "--trailer", "", "empty"] },
      { args: ["-m", "m", "--trailer", "=value", "no-key"] },
    ];
    for (const backend of backends()) {
      const base = repo(backend, SETUP);
      for (const c of cases) await twin(base, backend, { ...c, since });
    }
  });
});
