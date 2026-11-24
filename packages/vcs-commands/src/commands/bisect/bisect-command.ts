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

import { isSymbolicRef, isValidRefName, type ObjectId } from "@statewalker/vcs-core";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";

import { InvalidArgumentError, InvalidConfigError, RevisionError } from "../../errors/index.js";
import { GitCommand } from "../../git-command.js";
import { CheckoutCommand, CheckoutStatus } from "../checkout-command.js";
import { DiffCommand } from "../diff-command.js";
import { hostEnvironmentOf } from "../git-ident.js";
import { LogCommand } from "../log-command.js";
import { commitsBaseSource, MergeBaseGraph } from "../merge-bases.js";
import { configBool, configValue } from "../merge-config.js";
import { OperationState } from "../merge-support.js";
import { formatCommitPretty } from "../pretty-format.js";
import {
  handleRevisionArg,
  type RevisionArgEntry,
  unknownRevisionMessage,
} from "../revision-range.js";
import { shortenUnambiguousRef } from "../worktree-list-command.js";
import { gitCheckout } from "./bisect-checkout.js";
import {
  BISECT_USAGE,
  BisectCode,
  type BisectContext,
  BisectEngine,
  type BisectRunHandler,
  isBisectSuccess,
} from "./bisect-engine.js";
import { BisectDie, BisectGraph, type BisectGraphSource } from "./bisect-graph.js";

/** What a `git bisect` command did. */
export interface BisectResult {
  /** git's exit status (0 also when the first bad commit is found or a merge base is checked out) */
  exitCode: number;
  /**
   * What git prints on stdout, decoded as paths decode ({@link decodeGitPath}): the subjects
   * git prints without re-encoding them (`[<id>] <subject>`) keep bytes that are no UTF-8
   * as lone surrogates, so `encodeGitPath(stdout)` is git's output byte for byte
   * ({@link stdoutBytes})
   */
  stdout: string;
  /** git's stdout as bytes */
  stdoutBytes: Uint8Array;
  /** What git prints on stderr (its `error:`, `warning:` and `fatal:` lines, and checkout's) */
  stderr: string;
  /** git's bisect result code (bisect.h's enum bisect_error) */
  code: BisectCode;
  /** The commit checked out (or written to BISECT_HEAD) for testing, if one was */
  candidate?: ObjectId;
  /** The first bad (new) commit, once found */
  firstBad?: ObjectId;
}

/** The subcommands of cmd_bisect's OPT_SUBCOMMANDs. */
const SUBCOMMANDS = new Set([
  "reset",
  "terms",
  "start",
  "next",
  "log",
  "replay",
  "skip",
  "visualize",
  "view",
  "run",
]);

/**
 * `git bisect <subcommand> <args>...` as git's `cmd_bisect` dispatches it: `start`, `bad`,
 * `good`, `new`, `old`, a custom term, `skip`, `next`, `reset`, `terms`, `log`, `replay`,
 * `run`, `help`, and git's options before them (`-h`, `--`, `--end-of-options`). The typed
 * commands ({@link BisectStartCommand}, ...) build these arguments. `visualize` is not run
 * (it starts gitk or `git log`).
 */
export class BisectCommand extends GitCommand<BisectResult> {
  protected args: string[] = [];
  private runHandler?: BisectRunHandler;
  private logText?: string;

  /**
   * The arguments after `git bisect`. A typed command that builds its own arguments
   * refuses them ({@link BisectStartCommand} takes them as the arguments after `start`).
   */
  setArguments(args: string[]): this {
    this.checkCallable();
    this.acceptArguments([...args]);
    return this;
  }

  /** Where {@link setArguments} puts the arguments. */
  protected acceptArguments(args: string[]): void {
    this.args = args;
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
      res = BisectCode.FAILED;
      if (error instanceof BisectUsage) {
        // parse-options: usage_msg_opt (fatal:), an unknown option (error:), `help`, `-h`
        exitCode = error.kind === "help-stdout" ? 0 : 129;
        if (error.kind === "help-stdout") {
          engine.print(`${usageText()}\n\n`);
          res = BisectCode.OK;
        } else if (error.kind === "help") engine.printErr(`${usageText()}\n\n`);
        else if (error.kind === "option")
          engine.printErr(`error: ${error.message}\n${usageText()}\n\n`);
        else engine.printErr(`fatal: ${error.message}\n\n${usageText()}\n\n`);
      } else if (error instanceof BisectDie) {
        exitCode = 128;
        engine.printErr(`fatal: ${error.message}\n`);
      } else if (error instanceof RevisionError) {
        // where git's revision machinery dies (its lines are `fatal:` ones already)
        exitCode = 128;
        engine.printErr(error.message.endsWith("\n") ? error.message : `${error.message}\n`);
      } else throw error;
    }
    const { stdout, stderr } = engine.output;
    return {
      exitCode: exitCode ?? (isBisectSuccess(res) ? 0 : -res & 0xff),
      stdout,
      stdoutBytes: encodeGitPath(stdout),
      stderr,
      code: res,
      ...(engine.candidate ? { candidate: engine.candidate } : {}),
      ...(engine.firstBad ? { firstBad: engine.firstBad } : {}),
    };
  }

  /** builtin/bisect.c's cmd_bisect (its parse_options first) and its subcommands */
  private async dispatch(engine: BisectEngine, args: string[]): Promise<number> {
    // parse_options with PARSE_OPT_SUBCOMMAND_OPTIONAL: no option of its own, so the first
    // option is an error; `--` and `--end-of-options` end them
    const first = args[0] ?? "";
    const at = first === "--" || first === "--end-of-options" ? 1 : 0;
    if (at === 0 && first.startsWith("-") && first.length > 1) {
      if (first === "-h") throw new BisectUsage("help-stdout", "");
      if (first.startsWith("--")) {
        throw new BisectUsage("option", `unknown option \`${first.slice(2)}'`);
      }
      throw new BisectUsage("option", `unknown switch \`${first[1]}'`);
    }
    const argv = args.slice(at);
    const [sub, ...rest] = argv;
    const terms = { bad: "bad", good: "good" };
    if (sub === undefined) throw new BisectUsage("fatal", "need a command");
    if (!SUBCOMMANDS.has(sub)) {
      if (sub === "help") throw new BisectUsage("help", "");
      if (!(await engine.getTerms(terms, true))) return engine.error("no terms defined");
      if (
        (await engine.checkAndSetTerms(terms, sub)) ||
        !(sub === terms.good || sub === terms.bad)
      ) {
        throw new BisectUsage("fatal", `unknown command: '${sub}'`);
      }
      return engine.state(terms, argv);
    }
    switch (sub) {
      case "reset": {
        if (rest.length > 1) {
          return engine.error("'git bisect reset' requires either no argument or a commit");
        }
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
      case "run":
        if (rest.length === 0) return engine.error("'git bisect run' failed: no command provided.");
        if (!(await engine.getTerms(terms, true))) return engine.error("no terms defined");
        return engine.run(terms, rest);
      default:
        // visualize, view
        throw new BisectDie("'git bisect visualize' is not supported");
    }
  }

  /** What the engine reads and does, through this command's stores. */
  private context(): BisectContext {
    const refs = this.refsStore;
    const state = new OperationState(this.workingCopy.checkout, refs);
    const commits = this.walkCommits;
    // a shallow commit has no parents (git's shallow grafts), here as in `git log`
    let shallowRead: Promise<Set<ObjectId>> | undefined;
    const shallow = () => {
      shallowRead ??= (async () =>
        new Set((await refs.getShallow?.().catch(() => undefined)) ?? []))();
      return shallowRead;
    };
    // the paths compared as LogCommand's history simplification compares them: a pruned tree
    // diff, equal subtrees and paths outside the pathspec skipped, its trees cached
    const comparers = new Map<string, LogCommand>();
    const source: BisectGraphSource = {
      header: async (id) => {
        const commit = await commits.load(id).catch(() => undefined);
        if (!commit) return undefined;
        const parents = (await shallow()).has(id) ? [] : commit.parents;
        return { tree: commit.tree, parents, date: commit.committer.timestamp };
      },
      differs: (from, to, paths) => {
        const key = paths.join("\0");
        let log = comparers.get(key);
        if (!log) {
          // a walk of bisect's own: none of git log's configuration
          log = new LogCommand(this._workingCopy).setLogConfig(false);
          for (const p of paths) log.addPath(p);
          comparers.set(key, log);
        }
        return log.pathsDiffer(from, to);
      },
    };
    const graph = new BisectGraph(source);
    const mergeBaseGraph = async () => {
      const base = commitsBaseSource(commits, async () => new Map());
      const cut = await shallow();
      if (cut.size === 0) return new MergeBaseGraph(base);
      // no commit-graph generations with shallow commits (git turns the graph off)
      return new MergeBaseGraph({
        load: async (id) => {
          const found = await base.load(id);
          return found && { parents: cut.has(id) ? [] : found.parents, date: found.date };
        },
        tree: base.tree,
        generationOrder: async () => false,
      });
    };
    const mergeBasesMany = async (one: ObjectId, twos: ObjectId[]) => {
      const g = await mergeBaseGraph();
      const bases = await g.mergeBasesMany(
        g.commit(one),
        twos.map((t) => g.commit(t)),
      );
      return bases.map((n) => n.id).filter((id): id is ObjectId => id !== undefined);
    };
    const resolver = () => this.revisionResolver();
    const resolve = async (rev: string) => {
      try {
        return await resolver().resolve(rev);
      } catch {
        return undefined;
      }
    };
    const peelObject = async (id: ObjectId) => {
      try {
        const peeled = await resolver().peelTags(id);
        return peeled.type ? { id: peeled.id, type: peeled.type as string } : undefined;
      } catch {
        return undefined;
      }
    };
    const peelCommit = async (id: ObjectId) => {
      const peeled = await peelObject(id);
      return peeled?.type === "commit" ? peeled.id : undefined;
    };
    const subject = (id: ObjectId) => this.rawSubject(id);
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
      peelObject,
      subject,
      showCommit: (id) => this.showCommit(id),
      mergeBasesMany,
      rangePending: async (arg) => {
        // setup_revisions(2, argv + i - 1): the argument alone, no `--` after it
        const out: RevisionArgEntry[] = [];
        const done = await handleRevisionArg(
          resolver(),
          arg,
          false,
          { mergeBases: (a, b) => mergeBasesMany(a, [b]) },
          out,
          false,
        );
        if (done === false) {
          throw new BisectDie(unknownRevisionMessage(arg).replace(/^fatal: /, ""));
        }
        return out.map((e) => ({ id: e.id, exclude: e.exclude }));
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
      checkout: (name, options) =>
        gitCheckout(
          {
            checkout: async (target, ignoreOtherWorktrees) => {
              const command = new CheckoutCommand(this._workingCopy).setName(target);
              if (ignoreOtherWorktrees) command.setIgnoreOtherWorktrees(true);
              try {
                const result = await command.call();
                if (result.status === CheckoutStatus.OK) return { ok: true };
                return { ok: false, message: result.message ?? "" };
              } catch (error) {
                return {
                  ok: false,
                  message: error instanceof Error ? error.message : String(error),
                };
              }
            },
            head: async () => {
              const head = await refs.get("HEAD").catch(() => undefined);
              const id = (await refs.resolve("HEAD").catch(() => undefined))?.objectId;
              const path = head && isSymbolicRef(head) ? head.target : undefined;
              return { ...(path ? { path } : {}), ...(id ? { id } : {}) };
            },
            localChanges: (commit) =>
              new DiffCommand(this._workingCopy)
                .setOldTree(commit)
                .setRenames(false)
                .callText("name-status"),
            abbreviate: (id) => this.abbreviateObjectId(id),
            subject: (id) => this.onelineSubject(id),
            printSha1Ellipsis: hostEnvironmentOf(this._workingCopy)?.printSha1Ellipsis === true,
            commits: source,
            refCommits: async () => {
              const out: ObjectId[] = [];
              for await (const ref of refs.list("refs/")) {
                const id =
                  "objectId" in ref && ref.objectId
                    ? ref.objectId
                    : (await refs.resolve(ref.name).catch(() => undefined))?.objectId;
                const commit = id ? await peelCommit(id) : undefined;
                if (commit) out.push(commit);
              }
              return out;
            },
            config: (key) => configValue(this._workingCopy, key),
            upstreamOf: (branch) =>
              resolver()
                .upstreamOf(branch)
                .catch(() => undefined),
            pushOf: (branch) =>
              resolver()
                .pushOf(branch)
                .catch(() => undefined),
            refCommit: async (ref) => {
              const id = (await refs.resolve(ref).catch(() => undefined))?.objectId;
              return id ? peelCommit(id) : undefined;
            },
            pushRemoteOf: async (branch) => {
              try {
                return resolver().pushRemoteOf(branch);
              } catch {
                return undefined;
              }
            },
            shortenRef: (ref) => shortenUnambiguousRef(refs, ref),
          },
          name,
          options,
        ),
    };
  }

  /**
   * The commit's `%s` as git's format_commit_message gives it without an output encoding
   * (bisect.c's `[%H] %s`, the `# bad: [<id>] <subject>` lines of BISECT_LOG): the message's
   * bytes as stored, not re-encoded, decoded as paths decode.
   */
  private async rawSubject(id: ObjectId): Promise<string> {
    const commit = await this.walkCommits.load(id).catch(() => undefined);
    if (!commit) return "";
    let message = commit.message;
    const bytes = await this.rawObject(id);
    if (bytes) {
      const text = decodeGitPath(bytes);
      const at = text.indexOf("\n\n");
      message = at < 0 ? "" : text.slice(at + 2);
    }
    return formatCommitPretty("%s", { ...commit, message }, id);
  }

  /**
   * The subject CMIT_FMT_ONELINE shows (pp_commit_easy): the message in the log output
   * encoding (`i18n.logOutputEncoding`, else `i18n.commitEncoding`, else UTF-8). A message
   * already in that encoding is printed as stored; another is shown in UTF-8 (the only other
   * output encoding supported).
   */
  private async onelineSubject(id: ObjectId): Promise<string> {
    const commit = await this.walkCommits.load(id).catch(() => undefined);
    if (!commit) return "";
    const canon = (charset: string) => charset.toLowerCase().replace(/^utf-?8$/, "utf-8");
    const output =
      configValue(this._workingCopy, "i18n.logOutputEncoding") ??
      configValue(this._workingCopy, "i18n.commitEncoding") ??
      "UTF-8";
    if (canon(output) === canon(commit.encoding ?? "UTF-8")) return this.rawSubject(id);
    return formatCommitPretty("%s", commit, id);
  }

  /** An object's content as stored (undefined when missing or without a raw store) */
  private async rawObject(id: ObjectId): Promise<Uint8Array | undefined> {
    const objects = this._workingCopy.history?.objects;
    if (!objects) return undefined;
    try {
      const obj = await objects.get(id);
      if (!obj) return undefined;
      if (obj.bytes) return obj.bytes;
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const c of obj.content) {
        chunks.push(c);
        size += c.length;
      }
      const out = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    } catch {
      return undefined;
    }
  }

  /**
   * git's show_commit: `git show --stat --summary --no-abbrev-commit
   * --diff-merges=first-parent <id>`, printed as `git log` prints that one commit (no
   * decorations, as without a terminal): the configuration's format, dates, mailmap and notes
   * apply as they apply to `git show`.
   */
  private async showCommit(id: ObjectId): Promise<string> {
    try {
      // git runs `git show` as a child, which reads git show's configuration
      const bytes = await new LogCommand(this._workingCopy).add(id).setMaxCount(1).callBytes({
        stat: true,
        summary: true,
        abbrevCommit: false,
        diffMerges: "first-parent",
      });
      return decodeGitPath(bytes);
    } catch (error) {
      if (error instanceof BisectDie) throw error;
      // the child's own death comes first (a bad grep.patternType: `fatal: bad ...`)
      const child =
        error instanceof InvalidConfigError
          ? `${error.message.replace(/^fatal: /, "")}\nfatal: `
          : "";
      throw new BisectDie(`${child}unable to start 'show' for object '${id}'`);
    }
  }
}

/** Where git's parse_options prints its usage: `fatal:` (usage_msg_opt), an unknown option (`error:`), `help`, `-h`. */
class BisectUsage extends Error {
  constructor(
    readonly kind: "fatal" | "option" | "help" | "help-stdout",
    message: string,
  ) {
    super(message);
  }
}

function usageText(): string {
  return BISECT_USAGE.map((line, i) => {
    const prefix = i === 0 ? "usage: " : "   or: ";
    return prefix + line.replaceAll("\n", `\n${" ".repeat(prefix.length)}`);
  }).join("\n");
}

/** A typed command's refusal of raw arguments. */
function refuseArguments(command: string, args: string[]): never {
  throw new InvalidArgumentError(
    "arguments",
    args,
    `${command} builds its own arguments; use git.bisect().setArguments() for raw ones`,
  );
}

/**
 * `git bisect start [--term-new=<term> --term-old=<term>] [--no-checkout] [--first-parent]
 * [<bad> [<good>...]] [--] [<paths>...]`: the bisection begins (any earlier one is reset),
 * and with a bad and a good commit the first candidate is checked out.
 */
export class BisectStartCommand extends BisectCommand {
  private readonly paths: string[] = [];

  /** {@link setArguments}: the arguments after `start` (before the paths added). */
  protected override acceptArguments(args: string[]): void {
    this.args = args;
  }

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
  /** Refused: the command builds its own arguments. */
  protected override acceptArguments(args: string[]): void {
    refuseArguments("BisectStateCommand", args);
  }

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
  /** Refused: the command builds its own arguments. */
  protected override acceptArguments(args: string[]): void {
    refuseArguments("BisectSkipCommand", args);
  }

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
  /** Refused: the command builds its own arguments. */
  protected override acceptArguments(args: string[]): void {
    refuseArguments("BisectNextCommand", args);
  }

  protected override arguments(): string[] {
    return ["next"];
  }
}

/** `git bisect reset [<commit>]`: the bisection ends, the original branch (or `commit`) checked out. */
export class BisectResetCommand extends BisectCommand {
  /** Refused: the command builds its own arguments. */
  protected override acceptArguments(args: string[]): void {
    refuseArguments("BisectResetCommand", args);
  }

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
  /** Refused: the command builds its own arguments. */
  protected override acceptArguments(args: string[]): void {
    refuseArguments("BisectTermsCommand", args);
  }

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
  /** Refused: the command builds its own arguments. */
  protected override acceptArguments(args: string[]): void {
    refuseArguments("BisectLogCommand", args);
  }

  protected override arguments(): string[] {
    return ["log"];
  }
}

/** `git bisect replay <logfile>`, over the log's text. */
export class BisectReplayCommand extends BisectCommand {
  /** Refused: the command builds its own arguments. */
  protected override acceptArguments(args: string[]): void {
    refuseArguments("BisectReplayCommand", args);
  }

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
  /** Refused: the command builds its own arguments. */
  protected override acceptArguments(args: string[]): void {
    refuseArguments("BisectRunCommand", args);
  }

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
