/**
 * Test support: `git shortlog` and `git check-mailmap` command lines run through native git
 * and through ours (`ShortlogCommand`, `CheckMailmapCommand`), with stdout, stderr and the
 * exit status compared.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { Git, GitApiError } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitEnv } from "./native-git-http-backend.js";

export type Outcome = { status: number; out: string; err: string };

/** The native git's version, for the compatibility ours follows. */
export function nativeCompatibility(): "2.43" | "2.56" {
  const v = execFileSync("git", ["--version"], { encoding: "utf8" });
  const m = /(\d+)\.(\d+)/.exec(v);
  return m && (Number(m[1]) > 2 || Number(m[2]) >= 47) ? "2.56" : "2.43";
}

/** A git environment at a fixed time, `tick` seconds after git's test epoch. */
export function gitEnv(home: string, tick = 0, extra: Record<string, string> = {}) {
  const date = `${1112911993 + tick} -0700`;
  return {
    ...nativeGitEnv(home),
    GIT_AUTHOR_NAME: "A U Thor",
    GIT_AUTHOR_EMAIL: "author@example.com",
    GIT_COMMITTER_NAME: "C O Mitter",
    GIT_COMMITTER_EMAIL: "committer@example.com",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    ...extra,
  };
}

/** A repository native git builds, with test_tick's clock. */
export class Fixture {
  private tick = 0;
  constructor(
    readonly home: string,
    readonly dir: string,
  ) {}

  git(args: string[], extra: Record<string, string> = {}, input?: string | Buffer): string {
    this.tick += 60;
    return execFileSync("git", args, {
      cwd: this.dir,
      env: gitEnv(this.home, this.tick, extra),
      encoding: "latin1",
      ...(input !== undefined ? { input } : {}),
    });
  }

  put(path: string, content: string | Buffer): void {
    writeFileSync(join(this.dir, path), content);
  }

  /** test_commit: `<file>` holding `<content>` committed as `<message>`, tagged. */
  commit(message: string, file = `${message}.t`, content = message, author?: string): void {
    this.put(file, `${content}\n`);
    this.git(["add", file]);
    this.git(["commit", "-q", "-m", message, ...(author ? ["--author", author] : [])]);
    this.git(["tag", message]);
  }
}

/** `git <cmd> <args>` by native git in `dir`. */
export function native(
  home: string,
  dir: string,
  cmd: "shortlog" | "check-mailmap",
  args: string[],
  stdin = "",
  config: string[] = [],
): Outcome {
  const r = spawnSync("git", [...config.flatMap((c) => ["-c", c]), cmd, ...args], {
    cwd: dir,
    env: gitEnv(home),
    encoding: "latin1",
    input: Buffer.from(stdin, "latin1"),
  });
  return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
}

/** Our repository in `dir` (a bare one when it has no `.git`). */
export async function openRepo(dir: string): Promise<Git> {
  if (existsSync(join(dir, ".git"))) return openOurs(dir);
  const files = createNodeFilesApi({ rootDir: dir });
  const { history } = await createGitFilesBackend({ files, gitDir: "." });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".", history });
  return Git.fromWorktreeAdmin(await worktrees.openAdmin());
}

/** Stdin given as latin1 text (git's bytes), as ours reads it. */
const fromBytes = (text: string) => decodeGitPath(Buffer.from(text, "latin1"));
/** Our output as latin1 text of its bytes, as native output is read. */
const asBytes = (text: string) => Buffer.from(encodeGitPath(text)).toString("latin1");

/** git's stderr and status for an error ours threw. */
function failed(error: unknown, err: string): Outcome {
  if (!(error instanceof GitApiError)) throw error;
  return { status: error.exitCode, out: "", err: `${err}${error.message}\n` };
}

/** `git shortlog <args>` through ours. */
export async function oursShortlog(dir: string, args: string[], stdin?: string): Promise<Outcome> {
  const git = await openRepo(dir);
  const cmd = git.shortlog();
  try {
    let paths = false;
    for (const a of args) {
      if (paths) cmd.addPath(a);
      else if (a === "--") paths = true;
      else if (a === "--no-group") cmd.clearGroups();
      else if (a.startsWith("--group=")) cmd.addGroup(a.slice(8));
      else if (a.startsWith("--format=")) cmd.setFormat(a.slice(9));
      else if (a.startsWith("--date=")) cmd.setDate(a.slice(7));
      else if (a.startsWith("--abbrev=")) cmd.setAbbrev(Number(a.slice(9)));
      else if (a === "-w") cmd.setWrap();
      else if (a.startsWith("-w")) cmd.setWrap(a.slice(2));
      else if (/^-\d+$/.test(a)) cmd.setMaxCount(Number(a.slice(1)));
      else if (/^-[nsec]+$/.test(a)) {
        for (const f of a.slice(1)) {
          if (f === "n") cmd.setNumbered(true);
          if (f === "s") cmd.setSummary(true);
          if (f === "e") cmd.setEmail(true);
          if (f === "c") cmd.setCommitter(true);
        }
      } else if (/^--(all|branches|tags|remotes|exclude=)/.test(a)) cmd.addRevision(a);
      else cmd.addArgument(a);
    }
    if (stdin !== undefined) cmd.setInput(fromBytes(stdin));
    const out = asBytes(await cmd.callText());
    const err = cmd
      .getErrors()
      .map((l) => `${l}\n`)
      .join("");
    return { status: 0, out, err };
  } catch (error) {
    return failed(
      error,
      cmd
        .getErrors()
        .map((l) => `${l}\n`)
        .join(""),
    );
  }
}

/** `git check-mailmap <args>` through ours. */
export async function oursCheckMailmap(dir: string, args: string[], stdin = ""): Promise<Outcome> {
  const git = await openRepo(dir);
  const cmd = git.checkMailmap().setCompatibility(nativeCompatibility());
  try {
    for (const a of args) {
      if (a === "--stdin") cmd.setStdin(fromBytes(stdin));
      else if (a.startsWith("--mailmap-file=")) cmd.setMailmapFile(a.slice(15));
      else if (a.startsWith("--mailmap-blob=")) cmd.setMailmapBlob(a.slice(15));
      else cmd.addContact(a);
    }
    const out = asBytes(await cmd.call());
    return {
      status: 0,
      out,
      err: cmd
        .getErrors()
        .map((l) => `${l}\n`)
        .join(""),
    };
  } catch (error) {
    const o = failed(
      error,
      cmd
        .getErrors()
        .map((l) => `${l}\n`)
        .join(""),
    );
    return { ...o, out: asBytes(cmd.getOutput()) };
  }
}
