/**
 * `git bisect`: the binary search for the commit that introduced a change, as git 2.5x runs
 * it, its state in git's files so native git and these commands continue each other's
 * bisection.
 *
 * @example
 * ```typescript
 * // git bisect start main v1.0
 * let step = await git.bisectStart().setBad("main").addGood("v1.0").call();
 * console.log(step.stdout); // "Bisecting: 3 revisions left to test after this (roughly 2 steps)\n[<id>] <subject>\n"
 * // test the commit checked out, then
 * step = await git.bisectState("bad").call();
 * // ... until step.firstBad is set
 * await git.bisectReset().call();
 *
 * // git bisect run ./test.sh
 * await git.bisectRun().setCommand(["./test.sh"]).setRunHandler(async ({ commit }) => test(commit)).call();
 * ```
 */

import { EMPTY_TREE_ID, isSymbolicRef, isValidRefName, type ObjectId } from "@statewalker/vcs-core";

import { GitCommand } from "../../git-command.js";
import { ChangeType } from "../../results/diff-entry.js";
import { pprintRename } from "../../results/diff-output.js";
import { quotePath } from "../../results/quote-path.js";
import { CheckoutCommand, CheckoutStatus } from "../checkout-command.js";
import { DiffCommand } from "../diff-command.js";
import { commitsBaseSource, MergeBaseGraph } from "../merge-bases.js";
import { configBool, configValue } from "../merge-config.js";
import { flatTree, OperationState } from "../merge-support.js";
import { matchPathspec, type PathspecItem } from "../pathspec.js";
import { formatCommitPretty } from "../pretty-format.js";
import { RevListCommand } from "../rev-list-command.js";
import { formatGitDate } from "../sequencer-support.js";
import {
  BISECT_USAGE,
  BisectCode,
  type BisectContext,
  BisectEngine,
  type BisectRunHandler,
  isBisectSuccess,
} from "./bisect-engine.js";
import { BisectDie, BisectGraph } from "./bisect-graph.js";

/** What a `git bisect` command did. */
export interface BisectResult {
  /** git's exit status (0 also when the first bad commit is found or a merge base is checked out) */
  exitCode: number;
  /** What git prints on stdout, byte for byte */
  stdout: string;
  /** What git prints on stderr (its `error:`, `warning:` and `fatal:` lines, and checkout's) */
  stderr: string;
  /** git's bisect result code (bisect.h's enum bisect_error) */
  code: BisectCode;
  /** The commit checked out (or written to BISECT_HEAD) for testing, if one was */
  candidate?: ObjectId;
  /** The first bad (new) commit, once found */
  firstBad?: ObjectId;
}

const lineText = (text: string) => (text.length === 0 || text.endsWith("\n") ? text : `${text}\n`);

/**
 * `git bisect <subcommand> <args>...` as git's `cmd_bisect` dispatches it: `start`, `bad`,
 * `good`, `new`, `old`, a custom term, `skip`, `next`, `reset`, `terms`, `log`, `replay`,
 * `run`. The typed commands ({@link BisectStartCommand}, ...) build these arguments.
 * `visualize` is not run (it starts gitk or `git log`).
 */
export class BisectCommand extends GitCommand<BisectResult> {
  protected args: string[] = [];
  private runHandler?: BisectRunHandler;
  private logText?: string;

  /** The arguments after `git bisect`. */
  setArguments(args: string[]): this {
    this.checkCallable();
    this.args = [...args];
    return this;
  }

  /** Runs the command of `bisect run` (git runs it with the shell); see {@link BisectRunHandler}. */
  setRunHandler(handler: BisectRunHandler): this {
    this.checkCallable();
    this.runHandler = handler;
    return this;
  }

  /** The text of the log `bisect replay <logfile>` reads (a portable command reads no files). */
  setLogText(text: string): this {
    this.checkCallable();
    this.logText = text;
    return this;
  }

  /** The arguments the command runs with. */
  protected arguments(): string[] {
    return this.args;
  }

  async call(): Promise<BisectResult> {
    this.checkCallable();
    this.setCallable(false);
    const engine = new BisectEngine(this.context());
    let res: number;
    let exitCode: number | undefined;
    try {
      res = await this.dispatch(engine, this.arguments());
      if (res === BisectCode.INTERNAL_SUCCESS_1ST_BAD_FOUND) {
        const mode = await engine.readResetWhenFound();
        if (mode === "invalid") res = BisectCode.FAILED;
        else if (mode && (await engine.resetWhenFound(mode))) res = BisectCode.FAILED;
      }
    } catch (error) {
      if (error instanceof BisectUsage) {
        res = BisectCode.FAILED;
        exitCode = 129;
        engine.printErr(`fatal: ${error.message}\n\n${usageText()}\n\n`);
      } else if (error instanceof BisectDie) {
        res = BisectCode.FAILED;
        exitCode = 128;
        engine.printErr(`fatal: ${error.message}\n`);
      } else throw error;
    }
    const { stdout, stderr } = engine.output;
    return {
      exitCode: exitCode ?? (isBisectSuccess(res) ? 0 : -res & 0xff),
      stdout,
      stderr,
      code: res,
      ...(engine.candidate ? { candidate: engine.candidate } : {}),
      ...(engine.firstBad ? { firstBad: engine.firstBad } : {}),
    };
  }

  /** builtin/bisect.c's cmd_bisect and its subcommands */
  private async dispatch(engine: BisectEngine, argv: string[]): Promise<number> {
    const [sub, ...rest] = argv;
    const terms = { bad: "bad", good: "good" };
    switch (sub) {
      case "reset":
        if (rest.length > 1) {
          return engine.error("'git bisect reset' requires either no argument or a commit");
        }
        {
          const res = await engine.reset(rest[0], false);
          if (res) return res;
          return engine.cleanState();
        }
      case "terms":
        if (rest.length > 1) return engine.error("'git bisect terms' requires 0 or 1 argument");
        return engine.terms(terms, rest[0]);
      case "start":
        return engine.start(terms, rest);
      case "next":
        if (rest.length > 0) return engine.error("'git bisect next' requires 0 arguments");
        if (!(await engine.getTerms(terms, true))) return engine.error("no terms defined");
        return engine.next(terms);
      case "log":
        return engine.log();
      case "replay":
        if (rest.length !== 1) return engine.error("no logfile given");
        return engine.replay(terms, this.logText, rest[0] as string);
      case "skip":
        if (!(await engine.getTerms(terms, true))) return engine.error("no terms defined");
        return engine.skip(terms, rest);
      case "visualize":
      case "view":
        throw new BisectDie("'git bisect visualize' is not supported");
      case "run":
        if (rest.length === 0) return engine.error("'git bisect run' failed: no command provided.");
        if (!(await engine.getTerms(terms, true))) return engine.error("no terms defined");
        return engine.run(terms, rest);
      case undefined:
        throw new BisectUsage("need a command");
      default: {
        if (sub === "help") throw new BisectUsage("help");
        if (!(await engine.getTerms(terms, true))) return engine.error("no terms defined");
        if (
          (await engine.checkAndSetTerms(terms, sub)) ||
          !(sub === terms.good || sub === terms.bad)
        ) {
          throw new BisectUsage(`unknown command: '${sub}'`);
        }
        return engine.state(terms, argv);
      }
    }
  }

  /** What the engine reads and does, through this command's stores. */
  private context(): BisectContext {
    const refs = this.refsStore;
    const state = new OperationState(this.workingCopy.checkout, refs);
    const commits = this.walkCommits;
    const trees = this.trees;
    const flats = new Map<ObjectId, Promise<Map<string, { objectId: ObjectId; mode: number }>>>();
    const flat = (tree: ObjectId) => {
      let found = flats.get(tree);
      if (!found) {
        found = flatTree(trees, tree);
        flats.set(tree, found);
        if (flats.size > 64) flats.delete(flats.keys().next().value as ObjectId);
      }
      return found;
    };
    const graph = new BisectGraph({
      header: async (id) => {
        const commit = await commits.load(id).catch(() => undefined);
        return commit
          ? { tree: commit.tree, parents: commit.parents, date: commit.committer.timestamp }
          : undefined;
      },
      differs: async (from, to, paths: PathspecItem[]) => {
        const a = from ? await flat(from) : new Map();
        const b = await flat(to);
        for (const [path, entry] of b) {
          const old = a.get(path);
          if (old && old.objectId === entry.objectId && old.mode === entry.mode) continue;
          if (matchPathspec(paths, path, 0)) return true;
        }
        for (const path of a.keys()) {
          if (!b.has(path) && matchPathspec(paths, path, 0)) return true;
        }
        return false;
      },
    });
    const resolver = () => this.revisionResolver();
    const resolve = async (rev: string) => {
      try {
        return await resolver().resolve(rev);
      } catch {
        return undefined;
      }
    };
    const peelCommit = async (id: ObjectId) => {
      try {
        const peeled = await resolver().peelTags(id);
        return peeled.type === "commit" ? peeled.id : undefined;
      } catch {
        return undefined;
      }
    };
    return {
      state,
      graph,
      runHandler: this.runHandler,
      listBisectRefs: async () => {
        const out: { name: string; id: ObjectId }[] = [];
        for await (const ref of refs.list("refs/bisect/")) {
          if (!ref.name.startsWith("refs/bisect/")) continue;
          const id = "objectId" in ref ? ref.objectId : undefined;
          if (id) out.push({ name: ref.name, id });
        }
        return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      },
      setRef: (name, id) => refs.set(name, id),
      deleteRef: async (name) => {
        if (await refs.has(name).catch(() => false)) await refs.delete(name);
      },
      refExists: async (name) =>
        (await refs.resolve(name).catch(() => undefined))?.objectId !== undefined,
      resolveHead: async () => {
        const head = await refs.get("HEAD").catch(() => undefined);
        if (!head) return undefined;
        if (isSymbolicRef(head)) {
          const target = await refs.resolve("HEAD").catch(() => undefined);
          return { name: head.target, id: target?.objectId };
        }
        return { name: "HEAD", id: "objectId" in head ? head.objectId : undefined };
      },
      resolve,
      peelCommit,
      subject: async (id) => {
        const commit = await commits.load(id);
        return commit ? formatCommitPretty("%s", commit, id) : "";
      },
      showCommit: (id) => this.showCommit(id),
      mergeBasesMany: async (one, twos) => {
        const g = new MergeBaseGraph(commitsBaseSource(commits, async () => new Map()));
        const bases = await g.mergeBasesMany(
          g.commit(one),
          twos.map((t) => g.commit(t)),
        );
        return bases.map((n) => n.id).filter((id): id is ObjectId => id !== undefined);
      },
      revRange: async (arg) => {
        const ids: ObjectId[] = [];
        for await (const commit of await new RevListCommand(this._workingCopy)
          .addRevision(arg)
          .call()) {
          ids.push(commit.id);
        }
        return ids;
      },
      validRefName: (name) => isValidRefName(name),
      isBare: () => {
        if (configBool(this._workingCopy, "core.bare", false)) return true;
        try {
          return !this._workingCopy.worktree;
        } catch {
          return true;
        }
      },
      checkout: async (name, options) => {
        const command = new CheckoutCommand(this._workingCopy).setName(name);
        if (options.ignoreOtherWorktrees) command.setIgnoreOtherWorktrees(true);
        try {
          const result = await command.call();
          if (result.status === CheckoutStatus.OK) return { ok: true };
          return { ok: false, stderr: lineText(result.message ?? "") };
        } catch (error) {
          return {
            ok: false,
            stderr: lineText(error instanceof Error ? error.message : String(error)),
          };
        }
      },
    };
  }

  /**
   * git's show_commit: `git show --stat --summary --no-abbrev-commit
   * --diff-merges=first-parent <id>` (no decorations, as without a terminal).
   */
  private async showCommit(id: ObjectId): Promise<string> {
    const commit = await this.walkCommits.load(id);
    if (!commit) throw new BisectDie(`unable to start 'show' for object '${id}'`);
    let out = `commit ${id}\n`;
    if (commit.parents.length > 1) {
      const abbrevs: string[] = [];
      for (const p of commit.parents) abbrevs.push(await this.abbreviateObjectId(p));
      out += `Merge: ${abbrevs.join(" ")}\n`;
    }
    out += `Author: ${commit.author.name} <${commit.author.email}>\n`;
    out += `Date:   ${formatGitDate(commit.author)}\n\n`;
    out += mediumBody(commit.message);
    const old = commit.parents[0] ?? EMPTY_TREE_ID;
    const stat = await new DiffCommand(this._workingCopy)
      .setOldTree(old)
      .setNewTree(id)
      .callText("stat");
    const renames = configValue(this._workingCopy, "diff.renames");
    const entries = await new DiffCommand(this._workingCopy)
      .setOldTree(old)
      .setNewTree(id)
      .setRenames(
        configBool(this._workingCopy, "diff.renames", true) ||
          renames === "copies" ||
          renames === "copy",
      )
      .call();
    const quote = configBool(this._workingCopy, "core.quotePath", true);
    let summary = "";
    const mode6 = (mode: number | undefined) => (mode ?? 0).toString(8).padStart(6, "0");
    for (const e of entries) {
      switch (e.changeType) {
        case ChangeType.DELETE:
          summary += ` delete mode ${mode6(e.oldMode)} ${quotePath(e.oldPath ?? "", quote)}\n`;
          break;
        case ChangeType.ADD:
          summary += ` create mode ${mode6(e.newMode)} ${quotePath(e.newPath ?? "", quote)}\n`;
          break;
        case ChangeType.RENAME:
        case ChangeType.COPY: {
          const kind = e.changeType === ChangeType.RENAME ? "rename" : "copy";
          summary += ` ${kind} ${pprintRename(e.oldPath ?? "", e.newPath ?? "", quote)} (${e.score ?? 0}%)\n`;
          if (e.oldMode && e.newMode && e.oldMode !== e.newMode) {
            summary += ` mode change ${mode6(e.oldMode)} => ${mode6(e.newMode)}\n`;
          }
          break;
        }
        default:
          if (e.oldMode && e.newMode && e.oldMode !== e.newMode) {
            summary += ` mode change ${mode6(e.oldMode)} => ${mode6(e.newMode)} ${quotePath(e.newPath ?? "", quote)}\n`;
          }
      }
    }
    const diff = stat + summary;
    return diff ? `${out}\n${diff}` : out;
  }
}

/** Where git prints its usage (`usage_msg_opt`): exit status 129. */
class BisectUsage extends Error {}

function usageText(): string {
  return BISECT_USAGE.map((line, i) => {
    const prefix = i === 0 ? "usage: " : "   or: ";
    return prefix + line.replaceAll("\n", `\n${" ".repeat(prefix.length)}`);
  }).join("\n");
}

/**
 * pretty.c's CMIT_FMT_MEDIUM body: each line indented by four (tabs expanded to eight
 * columns), leading blank lines dropped, the end trimmed.
 */
function mediumBody(message: string): string {
  const lines = message.split("\n");
  let out = "";
  let first = true;
  for (const line of lines) {
    if (/^\s*$/.test(line)) {
      if (first) continue;
      out += "    \n";
      continue;
    }
    first = false;
    let col = 0;
    let expanded = "";
    for (const c of line) {
      if (c === "\t") {
        const n = 8 - (col % 8);
        expanded += " ".repeat(n);
        col += n;
      } else {
        expanded += c;
        col++;
      }
    }
    out += `    ${expanded}\n`;
  }
  return `${out.replace(/\s+$/, "")}\n`;
}

/**
 * `git bisect start [--term-new=<term> --term-old=<term>] [--no-checkout] [--first-parent]
 * [<bad> [<good>...]] [--] [<paths>...]`: the bisection begins (any earlier one is reset),
 * and with a bad and a good commit the first candidate is checked out.
 */
export class BisectStartCommand extends BisectCommand {
  private readonly paths: string[] = [];

  /** An argument as given on git's command line (options, revisions, `--`, paths). */
  addArgument(arg: string): this {
    this.checkCallable();
    this.args.push(arg);
    return this;
  }

  /** `--term-new=<term>` (`--term-bad`) */
  setTermNew(term: string): this {
    return this.addArgument(`--term-new=${term}`);
  }

  /** `--term-old=<term>` (`--term-good`) */
  setTermOld(term: string): this {
    return this.addArgument(`--term-old=${term}`);
  }

  /** `--no-checkout`: the candidates go to BISECT_HEAD, the worktree stays */
  setNoCheckout(noCheckout = true): this {
    return noCheckout ? this.addArgument("--no-checkout") : this;
  }

  /** `--first-parent`: only the first parents of merges are followed */
  setFirstParent(firstParent = true): this {
    return firstParent ? this.addArgument("--first-parent") : this;
  }

  /** The bad (new) revision: the first revision argument */
  setBad(rev: string): this {
    return this.addArgument(rev);
  }

  /** A good (old) revision, after the bad one */
  addGood(rev: string): this {
    return this.addArgument(rev);
  }

  /** A path the bisection is limited to (after `--`) */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  protected override arguments(): string[] {
    return ["start", ...this.args, ...(this.paths.length > 0 ? ["--", ...this.paths] : [])];
  }
}

/**
 * `git bisect <term> [<rev>...]`: the revisions (HEAD, or BISECT_HEAD, when none) marked
 * with a term (`bad`, `good`, `new`, `old` or the bisection's own), then the next candidate
 * checked out, or the first bad commit shown.
 */
export class BisectStateCommand extends BisectCommand {
  private term = "bad";
  private readonly revisions: string[] = [];

  /** The term: `bad`, `good`, `new`, `old`, or one given to `start` */
  setTerm(term: string): this {
    this.checkCallable();
    this.term = term;
    return this;
  }

  /** A revision to mark (one at most for the bad term) */
  addRevision(rev: string): this {
    this.checkCallable();
    this.revisions.push(rev);
    return this;
  }

  protected override arguments(): string[] {
    return [this.term, ...this.revisions];
  }
}

/** `git bisect skip [(<rev>|<range>)...]`: commits that cannot be tested. */
export class BisectSkipCommand extends BisectCommand {
  private readonly revisions: string[] = [];

  /** A revision or a range (`a..b`) to skip */
  addRevision(rev: string): this {
    this.checkCallable();
    this.revisions.push(rev);
    return this;
  }

  protected override arguments(): string[] {
    return ["skip", ...this.revisions];
  }
}

/** `git bisect next`: the next candidate checked out. */
export class BisectNextCommand extends BisectCommand {
  protected override arguments(): string[] {
    return ["next"];
  }
}

/** `git bisect reset [<commit>]`: the bisection ends, the original branch (or `commit`) checked out. */
export class BisectResetCommand extends BisectCommand {
  private commit?: string;

  /** The commit to check out instead of the branch the bisection started on */
  setCommit(commit: string): this {
    this.checkCallable();
    this.commit = commit;
    return this;
  }

  protected override arguments(): string[] {
    return this.commit === undefined ? ["reset"] : ["reset", this.commit];
  }
}

/** `git bisect terms [--term-good | --term-bad]` */
export class BisectTermsCommand extends BisectCommand {
  private option?: string;

  /** `--term-good` / `--term-old` / `--term-bad` / `--term-new` */
  setOption(option: string): this {
    this.checkCallable();
    this.option = option;
    return this;
  }

  protected override arguments(): string[] {
    return this.option === undefined ? ["terms"] : ["terms", this.option];
  }
}

/** `git bisect log`: the bisection's log (its stdout). */
export class BisectLogCommand extends BisectCommand {
  protected override arguments(): string[] {
    return ["log"];
  }
}

/** `git bisect replay <logfile>`, over the log's text. */
export class BisectReplayCommand extends BisectCommand {
  private name = "BISECT_LOG";

  /** The log to replay (as `git bisect log` printed it), and the name errors give it */
  setLog(text: string, name = this.name): this {
    this.setLogText(text);
    this.name = name;
    return this;
  }

  protected override arguments(): string[] {
    return ["replay", this.name];
  }
}

/**
 * `git bisect run <cmd> [<arg>...]`: the command run on each candidate through the
 * {@link setRunHandler} hook (0 good, 125 skip, 1-127 bad, 128 or more aborts), until the
 * first bad commit is found.
 */
export class BisectRunCommand extends BisectCommand {
  private command: string[] = [];

  /** The command and its arguments */
  setCommand(argv: string[]): this {
    this.checkCallable();
    this.command = [...argv];
    return this;
  }

  protected override arguments(): string[] {
    return ["run", ...this.command];
  }
}
