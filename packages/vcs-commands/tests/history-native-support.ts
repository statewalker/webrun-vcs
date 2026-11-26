/**
 * `git history reword` and `git history split` (builtin/history.c, git 2.54+), native twins
 * of t3450-history.sh, t3451-history-reword.sh and t3452-history-split.sh: each fixture is
 * built with native git and copied (`cp -a`); one copy runs native `git history`, the other
 * our `HistoryRewordCommand`/`HistorySplitCommand`, with the same editor answers (the messages
 * a fake editor writes, in order) and the same hunk answers (git's stdin). Compared: exit
 * status, stdout (dry-run ref updates, split's hunk transcript), stderr, what each editor was
 * shown, `COMMIT_EDITMSG`, then every ref, HEAD, the reflogs, the commits reachable (their
 * ids: the dates are fixed) and the worktree's status.
 *
 * The suite runs against a native git given by the caller: the git on `PATH` when it has
 * `git history` (`history-native.test.ts`), and git master as `$GIT3`
 * (`history-git3-native.test.ts`, the git3-oracle workflow).
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  createNodeSigner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, type HistoryResult, type PatchRequest } from "../src/index.js";

/** A native git and the environment it runs with. */
export interface NativeGit {
  binary: string;
  env: (home: string) => Record<string, string>;
}

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
}

/** Whether `binary` has `git history` with the `split` subcommand (2.54+). */
export function hasHistory(native: NativeGit): boolean {
  const home = tmpdir();
  const r = spawnSync(native.binary, ["history", "split", "-h"], {
    env: native.env(home),
    encoding: "utf8",
  });
  return /usage: git history split/.test(r.stdout + r.stderr);
}

/**
 * Whether `binary`'s `git history` signs its rewrites (`-S`, `--[no-]gpg-sign`,
 * `commit.gpgSign`): git master, after 2.56.1, whose `git history` signs nothing and refuses
 * the options.
 */
export function historySigns(native: NativeGit): boolean {
  const r = spawnSync(native.binary, ["history", "reword", "-h"], {
    env: native.env(tmpdir()),
    encoding: "utf8",
  });
  return /gpg-sign/.test(r.stdout + r.stderr);
}

/** The scenarios of t3450, t3451 and t3452 against `native`. */
export function historyTwins(title: string, native: NativeGit | undefined): void {
  const describeGit = native && process.platform !== "win32" ? describe : describe.skip;
  // the signing twins need a git whose `git history` signs (git master)
  const itSigning = native && historySigns(native) ? it : it.skip;

  describeGit(title, () => {
    const nat = native as NativeGit;
    let root: string;
    let counter = 0;
    let time = 1112911993;
    /** Bare repositories: git runs there with `GIT_DIR=.` (git 3.0's safe.bareRepository) */
    const bareDirs = new Set<string>();

    const env = (extra: Record<string, string> = {}): Record<string, string> => ({
      ...nat.env(root),
      GIT_AUTHOR_DATE: `${time} -0700`,
      GIT_COMMITTER_DATE: `${time} -0700`,
      // fixtures stay on the files backend whatever the build's default
      GIT_DEFAULT_REF_FORMAT: "files",
      ...extra,
    });

    const git = (
      cwd: string,
      args: string[],
      options: { env?: Record<string, string>; input?: string } = {},
    ): Outcome => {
      const r = spawnSync(nat.binary, args, {
        cwd,
        env: env({ ...(bareDirs.has(cwd) ? { GIT_DIR: "." } : {}), ...options.env }),
        input: options.input ?? "",
        encoding: "utf8",
      });
      return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    const ok = (cwd: string, ...args: string[]): string => {
      const r = git(cwd, args);
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
      return r.stdout;
    };

    /** test_tick */
    const tick = () => {
      time += 60;
    };

    /** test_commit <message> [<file> [<contents>]]: a commit and its lightweight tag. */
    const commit = (dir: string, message: string, file = `${message}.t`, contents = message) => {
      writeFileSync(join(dir, file), `${contents}\n`);
      ok(dir, "add", "--", file);
      tick();
      ok(dir, "commit", "-q", "-m", message);
      ok(dir, "tag", message);
    };

    /** `git commit -m <message>` of everything staged. */
    const commitAll = (dir: string, message: string, ...args: string[]) => {
      tick();
      ok(dir, "commit", "-q", ...args, "-m", message);
    };

    /** A new repository on `main`. */
    const repository = (): string => {
      const dir = join(root, `repo-${counter++}`);
      ok(root, "init", "-q", "-b", "main", dir);
      return dir;
    };

    /** Twin copies of `fixture`. */
    const twins = (fixture: string) => {
      const id = counter++;
      const native = join(root, `native-${id}`);
      const ours = join(root, `ours-${id}`);
      for (const to of [native, ours]) {
        const r = spawnSync("cp", ["-a", fixture, to]);
        if (r.status !== 0) throw new Error(`cp failed: ${r.stderr}`);
        if (bareDirs.has(fixture)) bareDirs.add(to);
      }
      return { native, ours };
    };

    async function openOurs(dir: string, gitDir: string): Promise<Git> {
      const files = createNodeFilesApi({ rootDir: dir });
      const environment = createNodeGitHostEnvironment({
        env: env(),
        signer: createNodeSigner({ env: env() }),
      });
      const { history } = await createGitFilesBackend({ files, gitDir, environment });
      const worktrees = await openGitLinkedWorktrees({ files, gitDir, history, environment });
      return gitDir === "."
        ? Git.fromWorktreeAdmin(await worktrees.openAdmin())
        : Git.fromWorkingCopy(await worktrees.openCurrent());
    }

    interface StepOptions {
      /** The messages the editor writes, one per launch (none: the editor is `true`) */
      messages?: string[];
      /** The editor fails (`false`) */
      failingEditor?: boolean;
      /** git's stdin: the answers to split's prompts */
      answers?: string[];
      /** A bare repository: the git directory is the twin itself */
      bare?: boolean;
      /** `-c key=value` of the native run (ours: the config written in both twins first) */
      config?: Record<string, string>;
    }

    /**
     * `git history <argv>` in both twins, compared with the repositories' state after; the
     * native outcome.
     */
    async function step(
      t: { native: string; ours: string },
      argv: string[],
      options: StepOptions = {},
    ): Promise<Outcome> {
      for (const [key, value] of Object.entries(options.config ?? {})) {
        ok(t.native, "config", key, value);
        ok(t.ours, "config", key, value);
      }
      const id = counter++;
      const seen = join(root, `seen-${id}`);
      const input = join(root, `input-${id}`);
      let editor = "true";
      if (options.failingEditor) editor = "false";
      else if (options.messages) {
        writeFileSync(input, options.messages.map((m) => `${m}\n`).join(""));
        const script = join(root, `editor-${id}.sh`);
        writeFileSync(
          script,
          `#!/bin/sh\ncat "$1" >>"${seen}"\nhead -n1 "${input}" >"$1"\n` +
            `sed 1d "${input}" >"${input}.t" && mv "${input}.t" "${input}"\n`,
        );
        chmodSync(script, 0o755);
        editor = script;
      }
      const native = git(t.native, ["history", ...argv], {
        env: { GIT_EDITOR: editor },
        input: (options.answers ?? []).map((a) => `${a}\n`).join(""),
      });

      const ours = await openOurs(t.ours, options.bare ? "." : ".git");
      const shown: string[] = [];
      const messages = [...(options.messages ?? [])];
      const answers = [...(options.answers ?? [])];
      const command = historyArgs(ours, argv);
      command.setEditor(async (_path, text) => {
        if (options.failingEditor) {
          throw new Error("error: there was a problem with the editor 'false'");
        }
        shown.push(text);
        if (!options.messages) return text;
        return `${messages.shift() ?? ""}\n`;
      });
      if ("setPatchSelector" in command) {
        command.setPatchSelector((request: PatchRequest) =>
          request.type === "hunk" ? answers.shift() : undefined,
        );
      }
      const result: HistoryResult = await command.call();
      ours.close();
      expect({
        argv,
        status: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      }).toEqual({ argv, ...native });
      if (options.messages) {
        expect(shown.join("")).toBe(existsSync(seen) ? readFileSync(seen, "utf8") : "");
      }
      compareState(t, options.bare ?? false);
      return native;
    }

    /** Refs, HEAD, reflogs, the commits reachable, COMMIT_EDITMSG and the worktree's status. */
    function compareState(t: { native: string; ours: string }, bare: boolean): void {
      const state = (dir: string) => {
        const refs = ok(dir, "for-each-ref", "--format=%(refname) %(objectname)");
        const head =
          git(dir, ["symbolic-ref", "-q", "HEAD"]).stdout || ok(dir, "rev-parse", "HEAD");
        const reflogs = ["HEAD", ...refs.split("\n").filter(Boolean)]
          .map((line) => line.split(" ")[0] as string)
          .filter((ref) => ref === "HEAD" || ref.startsWith("refs/heads/"))
          .map((ref) => `${ref}:\n${git(dir, ["log", "-g", "--format=%H %gs", ref]).stdout}`)
          .join("");
        const log = ok(dir, "log", "--all", "--format=%H %P %an %ae %ad %cn %ce %cd%n%B");
        const gitDir = bare ? dir : join(dir, ".git");
        const editMsg = existsSync(join(gitDir, "COMMIT_EDITMSG"))
          ? readFileSync(join(gitDir, "COMMIT_EDITMSG"), "utf8")
          : undefined;
        const status = bare ? "" : ok(dir, "status", "--porcelain");
        const tmpIndex = existsSync(join(gitDir, "history-split.index"));
        return { refs, head, reflogs, log, editMsg, status, tmpIndex };
      };
      expect(state(t.ours)).toEqual(state(t.native));
    }

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "history-native-"));
    });
    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    /** first, second, third on main */
    const linear = () => {
      const dir = repository();
      commit(dir, "first");
      commit(dir, "second");
      commit(dir, "third");
      return dir;
    };

    /** base; ours on main; theirs on branch; on main merged (`git merge theirs`) */
    const merged = () => {
      const dir = repository();
      commit(dir, "base");
      ok(dir, "branch", "branch");
      commit(dir, "ours");
      ok(dir, "switch", "-q", "branch");
      commit(dir, "theirs");
      ok(dir, "switch", "-q", "-");
      tick();
      ok(dir, "merge", "-q", "--no-edit", "theirs");
      return dir;
    };

    /** base, then `bar` and `foo` (empty) added as split-me */
    const splitMe = (files = ["bar", "foo"], withBase = true) => {
      const dir = repository();
      if (withBase) commit(dir, "base");
      for (const f of files) writeFileSync(join(dir, f), "");
      ok(dir, "add", ".");
      commitAll(dir, "split-me");
      return dir;
    };

    // t3450-history.sh's two cases are argv parsing ("need a subcommand", "unknown
    // subcommand"): the library has one command class per subcommand

    it('t3451-history-reword.sh: "can reword tip of a branch"', async () => {
      const t = twins(linear());
      await step(t, ["reword", "HEAD"], { messages: ["third reworded"] });
    });

    it('t3451-history-reword.sh: "can reword commit in the middle"', async () => {
      const t = twins(linear());
      await step(t, ["reword", "HEAD~"], { messages: ["second reworded"] });
    });

    it('t3451-history-reword.sh: "can reword commit in the middle even on detached head"', async () => {
      const dir = repository();
      commit(dir, "first");
      commit(dir, "second");
      commit(dir, "third_on_main");
      ok(dir, "checkout", "-q", "--detach", "HEAD^");
      commit(dir, "third_on_head");
      const t = twins(dir);
      await step(t, ["reword", "HEAD~"], { messages: ["second reworded"] });
    });

    it('t3451-history-reword.sh: "can reword the detached head"', async () => {
      const dir = repository();
      commit(dir, "first");
      commit(dir, "second");
      ok(dir, "checkout", "-q", "--detach", "HEAD");
      commit(dir, "third");
      const t = twins(dir);
      await step(t, ["reword", "HEAD"], { messages: ["third reworded"] });
    });

    it('t3451-history-reword.sh: "can reword root commit"', async () => {
      const t = twins(linear());
      await step(t, ["reword", "HEAD~2"], { messages: ["first reworded"] });
    });

    it('t3451-history-reword.sh: "can reword in a bare repo"', async () => {
      const dir = repository();
      commit(dir, "first");
      const bare = join(root, `bare-${counter++}.git`);
      ok(root, "clone", "-q", "--bare", dir, bare);
      bareDirs.add(bare);
      const t = twins(bare);
      await step(t, ["reword", "HEAD"], { messages: ["reworded"], bare: true });
    });

    it('t3451-history-reword.sh: "can reword a commit on a different branch"', async () => {
      const dir = repository();
      commit(dir, "base");
      ok(dir, "branch", "theirs");
      commit(dir, "ours");
      ok(dir, "switch", "-q", "theirs");
      commit(dir, "theirs");
      const t = twins(dir);
      await step(t, ["reword", "theirs"], { messages: ["Reworded theirs"] });
    });

    it('t3451-history-reword.sh: "can reword a merge commit"', async () => {
      const t = twins(merged());
      await step(t, ["reword", "HEAD~"], { failingEditor: true });
      await step(t, ["reword", "HEAD"], { messages: ["Reworded merge commit"] });
    });

    it('t3451-history-reword.sh: "--dry-run prints ref updates without modifying repo"', async () => {
      const dir = repository();
      commit(dir, "base");
      ok(dir, "branch", "branch");
      commit(dir, "ours");
      ok(dir, "switch", "-q", "branch");
      commit(dir, "theirs");
      const t = twins(dir);
      await step(t, ["reword", "--dry-run", "--update-refs=head", "base"], {
        messages: ["reworded commit"],
      });
      await step(t, ["reword", "--dry-run", "base"], { messages: ["reworded commit"] });
      // detached, with several branches at one commit
      ok(t.native, "branch", "z");
      ok(t.ours, "branch", "z");
      ok(t.native, "checkout", "-q", "--detach");
      ok(t.ours, "checkout", "-q", "--detach");
      await step(t, ["reword", "-n", "base"], { messages: ["reworded commit"] });
      await step(t, ["reword", "--dry-run", "--update-refs=head", "HEAD"], {
        messages: ["reworded commit"],
      });
    });

    it('t3451-history-reword.sh: "--update-refs=head updates only HEAD"', async () => {
      const dir = repository();
      commit(dir, "base");
      ok(dir, "branch", "branch");
      commit(dir, "theirs");
      ok(dir, "switch", "-q", "branch");
      commit(dir, "ours");
      const t = twins(dir);
      await step(t, ["reword", "--update-refs=head", "theirs"], { failingEditor: true });
      await step(t, ["reword", "--update-refs=head", "base"], { messages: ["reworded base"] });
    });

    it('t3451-history-reword.sh: "editor shows proper status"', async () => {
      const dir = repository();
      commit(dir, "first");
      const t = twins(dir);
      await step(t, ["reword", "HEAD"]);
    });

    it('t3451-history-reword.sh: "hooks are not executed for rewritten commits"', async () => {
      const dir = linear();
      for (const hook of ["prepare-commit-msg", "pre-commit", "post-commit", "commit-msg"]) {
        const path = join(dir, ".git/hooks", hook);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "#!/bin/sh\ntouch hooks.log\n");
        chmodSync(path, 0o755);
      }
      const t = twins(dir);
      await step(t, ["reword", "HEAD~"], { messages: ["second reworded"] });
    });

    it('t3451-history-reword.sh: "aborts with empty commit message"', async () => {
      const dir = repository();
      commit(dir, "first");
      const t = twins(dir);
      await step(t, ["reword", "HEAD"], { messages: [""] });
    });

    it('t3451-history-reword.sh: "retains changes in the worktree and index"', async () => {
      const dir = repository();
      writeFileSync(join(dir, "a"), "");
      writeFileSync(join(dir, "b"), "");
      ok(dir, "add", ".");
      commitAll(dir, "initial commit");
      writeFileSync(join(dir, "a"), "foo\n");
      writeFileSync(join(dir, "b"), "bar\n");
      ok(dir, "add", "b");
      const t = twins(dir);
      await step(t, ["reword", "HEAD"], { messages: ["message"] });
    });

    it("reword: argument checks and an empty message", async () => {
      const t = twins(linear());
      await step(t, ["reword", "does-not-exist"]);
      await step(t, ["reword"]);
      await step(t, ["reword", "HEAD", "HEAD~"]);
      await step(t, ["reword", "first"], { messages: ["", "x"], failingEditor: false });
    });

    it('t3452-history-split.sh: "refuses to work with merge commits"', async () => {
      const t = twins(merged());
      await step(t, ["split", "HEAD"]);
      await step(t, ["split", "HEAD~"]);
    });

    it('t3452-history-split.sh: "errors on missing commit argument"', async () => {
      const dir = repository();
      commit(dir, "initial");
      await step(twins(dir), ["split"]);
    });

    it('t3452-history-split.sh: "errors on unknown revision"', async () => {
      const dir = repository();
      commit(dir, "initial");
      await step(twins(dir), ["split", "does-not-exist"]);
    });

    it('t3452-history-split.sh: "--dry-run does not modify any refs"', async () => {
      const t = twins(splitMe());
      await step(t, ["split", "--dry-run", "HEAD"], {
        messages: ["first", "second"],
        answers: ["y", "n"],
      });
    });

    it('t3452-history-split.sh: "can split up tip commit"', async () => {
      const t = twins(splitMe());
      await step(t, ["split", "HEAD"], { messages: ["first", "second"], answers: ["y", "n"] });
    });

    it('t3452-history-split.sh: "can split up root commit"', async () => {
      const dir = repository();
      writeFileSync(join(dir, "bar"), "");
      writeFileSync(join(dir, "foo"), "");
      ok(dir, "add", ".");
      commitAll(dir, "split-me");
      commit(dir, "on-top");
      const t = twins(dir);
      await step(t, ["split", "HEAD~"], { messages: ["first", "second"], answers: ["y", "n"] });
    });

    it('t3452-history-split.sh: "can split up in-between commit"', async () => {
      const dir = splitMe();
      commit(dir, "on-top");
      const t = twins(dir);
      await step(t, ["split", "HEAD~"], { messages: ["first", "second"], answers: ["y", "n"] });
    });

    it('t3452-history-split.sh: "can split HEAD only"', async () => {
      const dir = repository();
      commit(dir, "base");
      writeFileSync(join(dir, "a"), "");
      writeFileSync(join(dir, "b"), "");
      ok(dir, "add", ".");
      commitAll(dir, "split-me");
      ok(dir, "branch", "unrelated");
      const t = twins(dir);
      await step(t, ["split", "--update-refs=head", "HEAD"], {
        messages: ["ours-a", "ours-b"],
        answers: ["y", "n"],
      });
    });

    it('t3452-history-split.sh: "can split detached HEAD"', async () => {
      const dir = splitMe();
      ok(dir, "checkout", "-q", "--detach");
      const t = twins(dir);
      await step(t, ["split", "--update-refs=head", "HEAD"], {
        messages: ["first", "second"],
        answers: ["y", "n"],
      });
    });

    it('t3452-history-split.sh: "can split commit in unrelated branch"', async () => {
      const dir = repository();
      commit(dir, "base");
      ok(dir, "branch", "ours");
      ok(dir, "switch", "-q", "-c", "theirs");
      writeFileSync(join(dir, "theirs-a"), "");
      writeFileSync(join(dir, "theirs-b"), "");
      ok(dir, "add", ".");
      commitAll(dir, "theirs");
      ok(dir, "switch", "-q", "ours");
      commit(dir, "ours");
      const t = twins(dir);
      await step(t, ["split", "--update-refs=head", "theirs"]);
      await step(t, ["split", "theirs"], {
        messages: ["theirs-rewritten-a", "theirs-rewritten-b"],
        answers: ["y", "n"],
      });
    });

    it('t3452-history-split.sh: "updates multiple descendant branches"', async () => {
      const dir = splitMe();
      ok(dir, "branch", "-q", "one");
      commit(dir, "two-commit");
      ok(dir, "branch", "-q", "two");
      ok(dir, "switch", "-q", "-c", "three", "one");
      commit(dir, "three-commit");
      const t = twins(dir);
      await step(t, ["split", "HEAD~"], { messages: ["split-a", "split-b"], answers: ["y", "n"] });
    });

    it('t3452-history-split.sh: "can pick multiple hunks"', async () => {
      const t = twins(splitMe(["bar", "baz", "foo", "qux"], false));
      await step(t, ["split", "HEAD"], {
        messages: ["first", "second"],
        answers: ["y", "n", "y", "n"],
      });
    });

    it('t3452-history-split.sh: "can use only last hunk"', async () => {
      const t = twins(splitMe(["bar", "foo"], false));
      await step(t, ["split", "HEAD"], { messages: ["first", "second"], answers: ["n", "y"] });
    });

    it('t3452-history-split.sh: "can split commit with file deletions"', async () => {
      const dir = repository();
      for (const f of ["a", "b", "c"]) writeFileSync(join(dir, f), `${f}\n`);
      ok(dir, "add", ".");
      commitAll(dir, "base");
      ok(dir, "rm", "-q", "a", "b");
      commitAll(dir, "delete-both");
      const t = twins(dir);
      await step(t, ["split", "HEAD"], {
        messages: ["delete-a", "delete-b"],
        answers: ["y", "n"],
      });
    });

    it('t3452-history-split.sh: "preserves original authorship"', async () => {
      const dir = repository();
      writeFileSync(join(dir, "bar"), "");
      writeFileSync(join(dir, "foo"), "");
      ok(dir, "add", ".");
      commitAll(dir, "split-me", "--author=Other <other@example.com>");
      const t = twins(dir);
      await step(t, ["split", "HEAD"], { messages: ["first", "second"], answers: ["y", "n"] });
    });

    it('t3452-history-split.sh: "aborts with empty commit message"', async () => {
      const t = twins(splitMe());
      await step(t, ["split", "HEAD"], { messages: [""], answers: ["y", "n"] });
    });

    it('t3452-history-split.sh: "commit message editor sees split-out changes"', async () => {
      const t = twins(splitMe());
      await step(t, ["split", "HEAD"], {
        messages: ["some commit message", "some commit message"],
        answers: ["y", "n"],
      });
    });

    it('t3452-history-split.sh: "can use pathspec to limit what gets split"', async () => {
      const t = twins(splitMe());
      await step(t, ["split", "HEAD", "--", "foo"], {
        messages: ["first", "second"],
        answers: ["y"],
      });
    });

    it('t3452-history-split.sh: "pathspec matching no files produces empty split error"', async () => {
      const t = twins(splitMe());
      await step(t, ["split", "HEAD", "--", "nonexistent"], { messages: ["first", "second"] });
    });

    it('t3452-history-split.sh: "split with multiple pathspecs"', async () => {
      const t = twins(splitMe(["a", "b", "c", "d"]));
      await step(t, ["split", "HEAD", "--", "a", "c"], {
        messages: ["split-ac", "remainder"],
        answers: ["y", "y"],
      });
    });

    it('t3452-history-split.sh: "split with file mode change"', async () => {
      const dir = repository();
      writeFileSync(join(dir, "script"), "content\n");
      ok(dir, "add", ".");
      commitAll(dir, "base");
      chmodSync(join(dir, "script"), 0o755);
      writeFileSync(join(dir, "script"), "change\n");
      commitAll(dir, "mode and content change", "-a");
      const t = twins(dir);
      await step(t, ["split", "HEAD"], {
        messages: ["mode-change", "content-change"],
        answers: ["y", "n"],
      });
    });

    it('t3452-history-split.sh: "refuses to create empty split-out commit"', async () => {
      const t = twins(splitMe());
      await step(t, ["split", "HEAD"], { answers: ["n", "n"] });
    });

    it('t3452-history-split.sh: "refuses to create empty original commit"', async () => {
      const t = twins(splitMe());
      await step(t, ["split", "HEAD"], { answers: ["y", "y"] });
    });

    it('t3452-history-split.sh: "retains changes in the worktree and index"', async () => {
      const dir = repository();
      writeFileSync(join(dir, "a"), "a\n");
      writeFileSync(join(dir, "b"), "b\n");
      ok(dir, "add", ".");
      commitAll(dir, "initial commit");
      writeFileSync(join(dir, "a"), "a2\n");
      writeFileSync(join(dir, "b"), "b2\n");
      ok(dir, "add", "b");
      const t = twins(dir);
      await step(t, ["split", "HEAD"], {
        messages: ["a-only", "remainder"],
        answers: ["y", "n"],
      });
    });

    /**
     * A deterministic `gpg.program` (signing-native.test.ts's way): a fixed signature, so a
     * signed commit has the same id in both twins and an unsigned one differs.
     */
    const fakeGpg = (): string => {
      const path = join(root, `gpg-${counter++}.sh`);
      writeFileSync(
        path,
        "#!/bin/sh\ncat >/dev/null\n" +
          "printf '[GNUPG:] KEY_CONSIDERED 1234 2\\n[GNUPG:] SIG_CREATED D 22 10 00 1 2\\n' >&2\n" +
          "printf -- '-----BEGIN PGP SIGNATURE-----\\n\\niHUEABYKAB0WIQRzSmc1\\n=AbCd\\n" +
          "-----END PGP SIGNATURE-----\\n'\n",
      );
      chmodSync(path, 0o755);
      return path;
    };

    // test_reword_gpg_sign / test_split_gpg_sign: [commit.gpgsign, options, signs]
    const signMatrix: [string, string[], boolean][] = [
      ["false", [], false],
      ["true", [], true],
      ["false", ["--gpg-sign"], true],
      ["true", ["--no-gpg-sign"], false],
      ["true", ["--gpg-sign", "--no-gpg-sign"], false],
      ["false", ["--no-gpg-sign", "--gpg-sign"], true],
    ];
    for (const [conf, args, signs] of signMatrix) {
      const will = signs ? "will" : "will not";
      itSigning(
        `t3451-history-reword.sh: 'reword ${args.join(" ")} with commit.gpgsign=${conf} ${will} sign rewritten history'`,
        async () => {
          const t = twins(linear());
          await step(t, ["reword", ...args, "HEAD~"], {
            messages: ["second reworded"],
            config: { "gpg.program": fakeGpg(), "commit.gpgsign": conf },
          });
          expect(ok(t.ours, "cat-file", "commit", "HEAD").includes("gpgsig ")).toBe(signs);
        },
      );
      itSigning(
        `t3452-history-split.sh: 'split ${args.join(" ")} with commit.gpgsign=${conf} ${will} sign rewritten history'`,
        async () => {
          const dir = splitMe();
          commit(dir, "tip");
          const t = twins(dir);
          await step(t, ["split", ...args, "HEAD~"], {
            messages: ["first", "second"],
            answers: ["y", "n"],
            config: { "gpg.program": fakeGpg(), "commit.gpgsign": conf },
          });
          expect(ok(t.ours, "cat-file", "commit", "HEAD~2").includes("gpgsig ")).toBe(signs);
        },
      );
    }

    itSigning(
      't3451-history-reword.sh: "reword uses an explicit signing key for rewritten history"',
      async () => {
        const t = twins(linear());
        await step(t, ["reword", "-SB7227189", "HEAD~"], {
          messages: ["second reworded"],
          config: { "gpg.program": fakeGpg() },
        });
      },
    );

    itSigning("reword: a signing program that fails moves no ref", async () => {
      const t = twins(linear());
      await step(t, ["reword", "--gpg-sign", "HEAD~"], {
        messages: ["second reworded"],
        config: { "gpg.program": "false" },
      });
    });

    it("split: hunks within one file, help and quit", async () => {
      const dir = repository();
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
      writeFileSync(join(dir, "f"), `${lines.join("\n")}\n`);
      ok(dir, "add", ".");
      commitAll(dir, "base");
      lines[1] = "changed 2";
      lines[17] = "changed 18";
      writeFileSync(join(dir, "f"), `${lines.join("\n")}\n`);
      commitAll(dir, "two hunks", "-a");
      const t = twins(dir);
      await step(t, ["split", "HEAD"], {
        messages: ["one", "two"],
        answers: ["?", "y", "q"],
      });
    });
  });
}

/** `git history <argv>` mapped onto our commands. */
function historyArgs(git: Git, argv: string[]) {
  const [sub, ...rest] = argv;
  const command = sub === "split" ? git.historySplit() : git.historyReword();
  let options = true;
  for (const arg of rest) {
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (options && arg.startsWith("-")) {
      if (arg === "--dry-run" || arg === "-n") command.setDryRun(true);
      else if (arg === "--gpg-sign" || arg === "-S") command.setSign(true);
      else if (arg === "--no-gpg-sign") command.setSign(false);
      else if (arg.startsWith("--gpg-sign=")) command.setSigningKey(arg.slice(11));
      else if (arg.startsWith("-S")) command.setSigningKey(arg.slice(2));
      else if (arg.startsWith("--update-refs=")) {
        command.setUpdateRefs(arg.slice("--update-refs=".length) as "branches" | "head");
      } else throw new Error(`unmapped option ${arg}`);
      continue;
    }
    command.addArgument(arg);
  }
  return command;
}
