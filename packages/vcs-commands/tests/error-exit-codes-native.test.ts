/**
 * The exit status each error class carries (`GitApiError.exitCode`) against native git's
 * exit status in a representative case of each (128 for `die()`, 129 for a usage error, 1
 * for an `error()` return, `git remote`'s 2 and 3). Each row runs native git in one copy of a
 * repository and ours in another; where git 2.43 and 2.5x end differently the row names
 * both and the native version on PATH decides.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AddFailedError,
  CannotDeleteCurrentBranchError,
  EmptyCommitError,
  GitApiError,
  IncompatibleOptionsError,
  IndexLockFailedError,
  InvalidArgumentError,
  InvalidConfigError,
  InvalidRefNameError,
  InvalidTagNameError,
  MvFailedError,
  NoFilepatternError,
  NoMessageError,
  NoRebaseInProgressError,
  NotMergedError,
  RebaseOperation,
  RefAlreadyExistsError,
  RemoteAlreadyExistsError,
  RemoteNotFoundError,
  ResetMode,
  SwitchRefusedError,
  UnmergedPathsError,
} from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, openRepo, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const is25x = (() => {
  if (!nativeGitAvailable()) return false;
  const m = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"]).toString());
  return !!m && (Number(m[1]) > 2 || Number(m[2]) >= 50);
})();

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

type Repo = Awaited<ReturnType<typeof openRepo>>;

interface Row {
  /** What is refused */
  name: string;
  /** The class ours throws */
  cls: abstract new (
    ...args: never[]
  ) => GitApiError;
  /** Prepares the copy (both twins get it) */
  setup?: (dir: string) => void;
  /** Native git's command */
  native: string[];
  /** Ours */
  ours: (repo: Repo, dir: string) => Promise<unknown>;
  /** git 2.43's status where it differs from 2.5x's (ours follows 2.5x) */
  status243?: number;
}

/** A repository: main with a.txt and b.txt, `side` diverged from it, `other` merged into neither. */
function base(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, ".gitignore", "*.log\n");
  putFile(dir, "a.txt", "a\n");
  putFile(dir, "b.txt", "b\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  git(dir, ["checkout", "-q", "-b", "side"]);
  putFile(dir, "b.txt", "side\n");
  git(dir, ["commit", "-qam", "side"]);
  git(dir, ["checkout", "-q", "main"]);
  putFile(dir, "b.txt", "main\n");
  git(dir, ["commit", "-qam", "main"]);
  git(dir, ["remote", "add", "origin", join(root, "nonexistent")]);
}

const conflict = (dir: string) => {
  gitRun(root, dir, ["merge", "side"]);
};

const ROWS: Row[] = [
  {
    name: "commit: an empty message",
    cls: NoMessageError,
    setup: (d) => {
      putFile(d, "a.txt", "a2\n");
      git(d, ["add", "a.txt"]);
    },
    native: ["commit", "-m", ""],
    ours: (r) => r.commit().setMessage("").call(),
  },
  {
    name: "commit: nothing to commit",
    cls: EmptyCommitError,
    native: ["commit", "-m", "x"],
    ours: (r) => r.commit().setMessage("x").call(),
  },
  {
    name: "commit: unmerged paths",
    cls: UnmergedPathsError,
    setup: conflict,
    native: ["commit", "-m", "x"],
    ours: (r) => r.commit().setMessage("x").call(),
  },
  {
    name: "commit -a: the index lock held",
    cls: IndexLockFailedError,
    setup: (d) => {
      putFile(d, "a.txt", "a2\n");
      writeFileSync(join(d, ".git/index.lock"), "");
    },
    native: ["commit", "-a", "-m", "x"],
    ours: (r) => r.commit().setAll(true).setMessage("x").call(),
  },
  {
    name: "commit: -i with -a",
    cls: IncompatibleOptionsError,
    native: ["commit", "-i", "-a", "-m", "x"],
    ours: (r) => r.commit().setInclude("a.txt").setAll(true).setMessage("x").call(),
  },
  {
    name: "commit --only: a path matching nothing (report_path_error, exit 1)",
    cls: InvalidArgumentError,
    native: ["commit", "-m", "x", "--", "nope"],
    ours: (r) => r.commit().setOnly("nope").setMessage("x").call(),
  },
  {
    name: "add: a path matching nothing",
    cls: InvalidArgumentError,
    native: ["add", "nope"],
    ours: (r) => r.add().addFilepattern("nope").call(),
  },
  {
    name: "add -u: a path tracking nothing",
    cls: InvalidArgumentError,
    setup: (d) => putFile(d, "u.txt", "u\n"),
    native: ["add", "-u", "u.txt"],
    ours: (r) => r.add().setUpdate(true).addFilepattern("u.txt").call(),
    status243: 0,
  },
  {
    name: "add: an ignored path",
    cls: AddFailedError,
    setup: (d) => putFile(d, "x.log", "l\n"),
    native: ["add", "x.log"],
    ours: (r) => r.add().addFilepattern("x.log").call(),
  },
  {
    name: "add: no pathspec (a message, exit status 0)",
    cls: NoFilepatternError,
    native: ["add"],
    ours: (r) => r.add().call(),
  },
  {
    name: "mv: a missing source",
    cls: MvFailedError,
    native: ["mv", "nope", "x"],
    ours: (r) => r.mv().addSource("nope").setDestination("x").call(),
  },
  {
    name: "checkout: -f with -m",
    cls: SwitchRefusedError,
    native: ["checkout", "-f", "-m", "side"],
    ours: (r) => r.checkout().setName("side").setForced(true).setMerge(true).call(),
  },
  {
    name: "commit -i: a path tracking nothing (report_path_error, then exit 128)",
    cls: InvalidArgumentError,
    setup: (d) => putFile(d, "u.txt", "u\n"),
    native: ["commit", "-m", "x", "-i", "u.txt"],
    ours: (r) => r.commit().setInclude("u.txt").setMessage("x").call(),
    status243: 1,
  },
  {
    name: "branch: an invalid name",
    cls: InvalidRefNameError,
    native: ["branch", "a..b"],
    ours: (r) => r.branchCreate().setName("a..b").call(),
  },
  {
    name: "branch: one that exists",
    cls: RefAlreadyExistsError,
    native: ["branch", "side"],
    ours: (r) => r.branchCreate().setName("side").call(),
  },
  {
    name: "branch -d: not fully merged",
    cls: NotMergedError,
    native: ["branch", "-d", "side"],
    ours: (r) => r.branchDelete().setBranchNames("side").call(),
  },
  {
    name: "branch -d: the current branch",
    cls: CannotDeleteCurrentBranchError,
    native: ["branch", "-d", "main"],
    ours: (r) => r.branchDelete().setBranchNames("main").call(),
  },
  {
    name: "tag: an invalid name",
    cls: InvalidTagNameError,
    native: ["tag", "a..b"],
    ours: (r) => r.tag().setName("a..b").call(),
  },
  {
    name: "rebase --continue: none in progress",
    cls: NoRebaseInProgressError,
    native: ["rebase", "--continue"],
    ours: (r) => r.rebase().setOperation(RebaseOperation.CONTINUE).call(),
  },
  {
    name: "remote add: one that exists",
    cls: RemoteAlreadyExistsError,
    native: ["remote", "add", "origin", "/x"],
    ours: (r) => r.remoteAdd().setName("origin").setUri("/x").call(),
  },
  {
    name: "remote remove: a missing one",
    cls: RemoteNotFoundError,
    native: ["remote", "remove", "nope"],
    ours: (r) => r.remoteRemove().setRemoteName("nope").call(),
  },
  {
    name: "status: a bad status.showUntrackedFiles",
    cls: InvalidConfigError,
    setup: (d) => git(d, ["config", "status.showUntrackedFiles", "bogus"]),
    native: ["status"],
    ours: (r) => r.status().call(),
  },
  {
    name: "branch -d: a missing branch",
    cls: GitApiError,
    native: ["branch", "-d", "nope"],
    ours: (r) => r.branchDelete().setBranchNames("nope").call(),
  },
  {
    name: "tag -d: a missing tag",
    cls: GitApiError,
    native: ["tag", "-d", "nope"],
    ours: (r) => r.tagDelete().setTags("nope").call(),
  },
  {
    name: "remote rename: to one that exists",
    cls: RemoteAlreadyExistsError,
    setup: (d) => git(d, ["remote", "add", "o2", "/y"]),
    native: ["remote", "rename", "origin", "o2"],
    ours: (r) => r.remoteRename().setOldName("origin").setNewName("o2").call(),
  },
  {
    name: "cherry-pick: a bad revision",
    cls: GitApiError,
    native: ["cherry-pick", "nope"],
    ours: (r) => r.cherryPick().include("nope").call(),
  },
  {
    name: "reset: a bad revision",
    cls: GitApiError,
    native: ["reset", "nope"],
    ours: (r) => r.reset().setRef("nope").call(),
  },
  {
    name: "read-tree: a bad tree-ish",
    cls: GitApiError,
    native: ["read-tree", "nope"],
    ours: (r) => r.readTree().addTree("nope").call(),
  },
  {
    name: "rm: no pathspec",
    cls: NoFilepatternError,
    native: ["rm"],
    ours: (r) => r.rm().call(),
  },
  {
    name: "rm: a file with local modifications",
    cls: GitApiError,
    setup: (d) => putFile(d, "a.txt", "a2\n"),
    native: ["rm", "a.txt"],
    ours: (r) => r.rm().addFilepattern("a.txt").call(),
  },
  {
    name: "reset --merge: a change it would lose",
    cls: GitApiError,
    setup: (d) => {
      putFile(d, "b.txt", "dirty\n");
    },
    native: ["reset", "--merge", "side"],
    ours: (r) => r.reset().setMode(ResetMode.MERGE).setRef("side").call(),
  },
];

describeGit("error exit codes: as native git", () => {
  let template: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "exit-codes-"));
    template = join(root, "template");
    base(template);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  for (const row of ROWS) {
    it(row.name, async () => {
      const dirs = [join(root, `${row.name.length}-n`), join(root, `${row.name.length}-o`)];
      const [theirs, mine] = dirs as [string, string];
      for (const d of dirs) {
        rmSync(d, { recursive: true, force: true });
        rmSync(join(d, "../wt"), { recursive: true, force: true });
        execFileSync("cp", ["-a", template, d]);
        row.setup?.(d);
      }
      const native = gitRun(root, theirs, row.native);
      let error: unknown;
      try {
        await row.ours(await openRepo(root, mine), mine);
      } catch (e) {
        error = e;
      }
      expect(error, `${row.name}: ${native.stderr}`).toBeInstanceOf(row.cls);
      const expected = !is25x && row.status243 !== undefined ? row.status243 : native.status;
      if (is25x || row.status243 === undefined) {
        expect((error as GitApiError).exitCode, `${row.name}: ${native.stderr}`).toBe(expected);
      } else {
        // git 2.43 differs: ours keeps 2.5x's status
        expect(native.status).toBe(row.status243);
      }
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    });
  }

  it("the exit status of the message's prefixes, and one given", () => {
    expect(new GitApiError("fatal: x").exitCode).toBe(128);
    expect(new GitApiError("error: x").exitCode).toBe(1);
    expect(new GitApiError("error: x\nfatal: y").exitCode).toBe(128);
    expect(new GitApiError("error: x\nusage: git y").exitCode).toBe(129);
    expect(new GitApiError("x").exitCode).toBe(128);
    expect(new GitApiError("fatal: x", { exitCode: 3 }).exitCode).toBe(3);
    expect(new EmptyCommitError().exitCode).toBe(1);
    expect(new InvalidArgumentError("a", 1, "error: x").withExitCode(128).exitCode).toBe(128);
  });
});
