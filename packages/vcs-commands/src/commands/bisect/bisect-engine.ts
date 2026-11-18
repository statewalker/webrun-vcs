/**
 * `git bisect` as git's `builtin/bisect.c` and `bisect.c` run it: the state in git's files
 * (`BISECT_START`, `BISECT_LOG`, `BISECT_TERMS`, `BISECT_NAMES`, `BISECT_ANCESTORS_OK`,
 * `BISECT_FIRST_PARENT`, `BISECT_RUN`, `BISECT_RESET_WHEN_FOUND`, the pseudo refs
 * `BISECT_EXPECTED_REV` and `BISECT_HEAD`, the refs `refs/bisect/*`), the messages and the
 * exit codes git gives. One engine serves one command, as one git process does.
 */

import type { ObjectId } from "@statewalker/vcs-core";

import type { OperationState } from "../merge-support.js";
import {
  BisectDie,
  type BisectGraph,
  type BisectNode,
  type BisectPending,
  estimateBisectSteps,
  FIND_BISECTION_ALL,
  FIND_BISECTION_FIRST_PARENT_ONLY,
  findBisection,
  managedSkipped,
  UNINTERESTING,
} from "./bisect-graph.js";
import { sqDequoteToArgv, sqQuoteArgv, strbufRtrim, strbufTrim } from "./bisect-quote.js";

/** bisect.h's enum bisect_error. */
export enum BisectCode {
  OK = 0,
  FAILED = -1,
  ONLY_SKIPPED_LEFT = -2,
  MERGE_BASE_CHECK = -3,
  NO_TESTABLE_COMMIT = -4,
  INTERNAL_SUCCESS_1ST_BAD_FOUND = -10,
  INTERNAL_SUCCESS_MERGE_BASE = -11,
}

/** git's is_bisect_success. */
export const isBisectSuccess = (res: number) =>
  res === 0 ||
  res === BisectCode.INTERNAL_SUCCESS_1ST_BAD_FOUND ||
  res === BisectCode.INTERNAL_SUCCESS_MERGE_BASE;

/** The command a `git bisect run` step runs, and what the host gives back. */
export interface BisectRunInput {
  /** The command as git prints it (`running <command>`): the arguments shell-quoted */
  command: string;
  /** The arguments as given */
  argv: string[];
  /** The commit under test (HEAD, or BISECT_HEAD with `--no-checkout`) */
  commit: ObjectId | undefined;
}

/** What the command of a `git bisect run` step did: its exit status, and what it printed. */
export type BisectRunOutcome = number | { exitCode: number; output?: string };

/**
 * Runs the command of `git bisect run` (git runs it with the shell in the worktree): its
 * exit status decides the step (0 good, 125 skip, 1-127 bad, 128 and above abort).
 */
export type BisectRunHandler = (
  input: BisectRunInput,
) => BisectRunOutcome | Promise<BisectRunOutcome>;

/** What the engine reads and does through its command. */
export interface BisectContext {
  state: OperationState;
  graph: BisectGraph;
  /** The refs under `refs/bisect/`, by full name, in git's (sorted) order */
  listBisectRefs(): Promise<{ name: string; id: ObjectId }[]>;
  setRef(name: string, id: ObjectId): Promise<void>;
  deleteRef(name: string): Promise<void>;
  refExists(name: string): Promise<boolean>;
  /** HEAD as git's refs_resolve_ref_unsafe("HEAD") gives it: the ref it ends at and its id */
  resolveHead(): Promise<{ name: string; id: ObjectId | undefined } | undefined>;
  /** git's get_oid: the object a revision names, undefined when none */
  resolve(rev: string): Promise<ObjectId | undefined>;
  /** git's lookup_commit_reference: the commit an object peels to, undefined when none */
  peelCommit(id: ObjectId): Promise<ObjectId | undefined>;
  /** The object a tag peels to (git's deref_tag) and its type; undefined when missing */
  peelObject(id: ObjectId): Promise<{ id: ObjectId; type: string } | undefined>;
  /**
   * `%s` of the commit without re-encoding (git's format_commit_message with no output
   * encoding): the message's bytes as they are, decoded as paths decode
   */
  subject(id: ObjectId): Promise<string>;
  /** `git show --stat --summary --no-abbrev-commit --diff-merges=first-parent <id>` */
  showCommit(id: ObjectId): Promise<string>;
  /** git's repo_get_merge_bases_many, in git's order */
  mergeBasesMany(one: ObjectId, twos: ObjectId[]): Promise<ObjectId[]>;
  /**
   * The pending list a revision argument with `..` gives (setup_revisions of `bisect skip`):
   * throws {@link BisectDie} (or a RevisionError) where git dies on it
   */
  rangePending(arg: string): Promise<BisectPending[]>;
  /** git's check_refname_format */
  validRefName(name: string): boolean;
  isBare(): boolean;
  /**
   * git's `checkout [-q] [--ignore-other-worktrees] <name> --`: false when it failed, what
   * it printed on stdout and stderr
   */
  checkout(
    name: string,
    options: { quiet: boolean; ignoreOtherWorktrees?: boolean },
  ): Promise<{ ok: boolean; stdout?: string; stderr?: string }>;
  runHandler?: BisectRunHandler;
}

/** The terms of a bisection (git's struct bisect_terms). */
interface Terms {
  bad: string;
  good: string;
}

const VOCAB_BAD = "bad|new";
const VOCAB_GOOD = "good|old";

const BUILTIN_COMMANDS = [
  "help",
  "start",
  "skip",
  "next",
  "reset",
  "visualize",
  "view",
  "replay",
  "log",
  "run",
  "terms",
];

const START_USAGE = `git bisect start [--term-(bad|new)=<term-new> --term-(good|old)=<term-old>]
                 [--no-checkout] [--first-parent] [--reset-when-found[=<where>]] [<bad> [<good>...]] [--] [<pathspec>...]`;

/** builtin/bisect.c's git_bisect_usage. */
export const BISECT_USAGE = [
  START_USAGE,
  "git bisect (bad|new|<term-new>) [<rev>]",
  "git bisect (good|old|<term-old>) [<rev>...]",
  "git bisect terms [--term-(good|old) | --term-(bad|new)]",
  "git bisect skip [(<rev>|<range>)...]",
  "git bisect next",
  "git bisect reset [<commit>]",
  "git bisect (visualize|view)",
  "git bisect replay <logfile>",
  "git bisect log",
  "git bisect run [--reset-when-found[=<where>]] <cmd> [<arg>...]",
  "git bisect help",
];

type ResetWhenFound = "original" | "found" | undefined;

/** git's one-commit-at-a-time engine of `git bisect`, for one command. */
export class BisectEngine {
  private stdout = "";
  private stderr = "";
  /** read_bisect_refs' static arrays: they grow with each read, as in one git process */
  private goodRevs: ObjectId[] = [];
  private skippedRevs: ObjectId[] = [];
  private currentBad?: ObjectId;
  private termBad = "bad";
  private termGood = "good";
  /** The candidate checked out last (BISECT_EXPECTED_REV) */
  candidate?: ObjectId;
  /** The first bad commit, once found */
  firstBad?: ObjectId;

  constructor(private readonly ctx: BisectContext) {}

  get output(): { stdout: string; stderr: string } {
    return { stdout: this.stdout, stderr: this.stderr };
  }

  print(text: string): void {
    this.stdout += text;
  }

  /** git's error(): `error: <message>` on stderr; returns -1 */
  error(message: string): number {
    this.stderr += `error: ${message}\n`;
    return -1;
  }

  warning(message: string): void {
    this.stderr += `warning: ${message}\n`;
  }

  printErr(text: string): void {
    this.stderr += text;
  }

  // ============ files ============

  private async read(name: string): Promise<string | undefined> {
    return this.ctx.state.read(name);
  }

  private async emptyOrMissing(name: string): Promise<boolean> {
    const text = await this.read(name);
    return text === undefined || text.length === 0;
  }

  private async exists(name: string): Promise<boolean> {
    return (await this.read(name)) !== undefined;
  }

  private write(name: string, content: string): Promise<void> {
    return this.ctx.state.write(name, content);
  }

  private append(name: string, content: string): Promise<void> {
    return this.ctx.state.append(name, content);
  }

  private unlink(name: string): Promise<void> {
    return this.ctx.state.remove(name);
  }

  // ============ terms ============

  /** bisect.c's read_bisect_terms (a missing file is bad/good) */
  private async readBisectTerms(): Promise<void> {
    const text = await this.read("BISECT_TERMS");
    if (text === undefined) {
      this.termBad = "bad";
      this.termGood = "good";
      return;
    }
    const lines = readLines(text);
    if (lines.length < 1)
      throw new BisectDie("could not read bad term from file '.git/BISECT_TERMS'");
    if (lines.length < 2)
      throw new BisectDie("could not read good term from file '.git/BISECT_TERMS'");
    this.termBad = lines[0] as string;
    this.termGood = lines[1] as string;
  }

  /** builtin/bisect.c's get_terms: false (git's -1) when the file cannot give both */
  async getTerms(terms: Terms, missingIsOk: boolean): Promise<boolean> {
    const text = await this.read("BISECT_TERMS");
    if (text === undefined) return missingIsOk;
    const lines = readLines(text);
    if (lines.length < 2) return false;
    terms.bad = lines[0] as string;
    terms.good = lines[1] as string;
    return true;
  }

  private checkTermFormat(term: string, origTerm: string): number {
    if (!this.ctx.validRefName(`refs/bisect/${term}`)) {
      return this.error(`'${term}' is not a valid term`);
    }
    if (BUILTIN_COMMANDS.includes(term)) {
      return this.error(`can't use the builtin command '${term}' as a term`);
    }
    if (
      (origTerm !== "bad" && (term === "bad" || term === "new")) ||
      (origTerm !== "good" && (term === "good" || term === "old"))
    ) {
      return this.error(`can't change the meaning of the term '${term}'`);
    }
    return 0;
  }

  private async writeTerms(bad: string, good: string): Promise<number> {
    if (bad === good) return this.error("please use two different terms");
    if (this.checkTermFormat(bad, "bad") || this.checkTermFormat(good, "good")) return -1;
    await this.write("BISECT_TERMS", `${bad}\n${good}\n`);
    return 0;
  }

  /** builtin/bisect.c's check_and_set_terms */
  async checkAndSetTerms(terms: Terms, cmd: string): Promise<number> {
    const hasTermFile = !(await this.emptyOrMissing("BISECT_TERMS"));
    if (cmd === "skip" || cmd === "start" || cmd === "terms") return 0;
    if (hasTermFile && cmd !== terms.bad && cmd !== terms.good) {
      return this.error(`Invalid command: you're currently in a ${terms.bad}/${terms.good} bisect`);
    }
    if (!hasTermFile) {
      if (cmd === "bad" || cmd === "good") {
        terms.bad = "bad";
        terms.good = "good";
        return this.writeTerms(terms.bad, terms.good);
      }
      if (cmd === "new" || cmd === "old") {
        terms.bad = "new";
        terms.good = "old";
        return this.writeTerms(terms.bad, terms.good);
      }
    }
    return 0;
  }

  // ============ state ============

  /** bisect.c's bisect_clean_state */
  async cleanState(): Promise<number> {
    for (const ref of await this.ctx.listBisectRefs()) await this.ctx.deleteRef(ref.name);
    await this.ctx.deleteRef("BISECT_HEAD");
    await this.ctx.deleteRef("BISECT_EXPECTED_REV");
    for (const name of [
      "BISECT_ANCESTORS_OK",
      "BISECT_LOG",
      "BISECT_NAMES",
      "BISECT_RUN",
      "BISECT_TERMS",
      "BISECT_FIRST_PARENT",
      "BISECT_RESET_WHEN_FOUND",
      "BISECT_START",
    ]) {
      await this.unlink(name);
    }
    return 0;
  }

  /** bisect.c's read_bisect_refs */
  private async readBisectRefs(): Promise<void> {
    const goodPrefix = `${this.termGood}-`;
    for (const ref of await this.ctx.listBisectRefs()) {
      const name = ref.name.slice("refs/bisect/".length);
      if (name === this.termBad) this.currentBad = ref.id;
      else if (name.startsWith(goodPrefix)) this.goodRevs.push(ref.id);
      else if (name.startsWith("skip-")) this.skippedRevs.push(ref.id);
    }
  }

  /** The commit's `%s` line, as git's log lines carry it. */
  private async logCommit(label: string, id: ObjectId): Promise<string> {
    const commit = (await this.ctx.peelCommit(id)) ?? id;
    return `# ${label}: [${commit}] ${await this.ctx.subject(commit)}\n`;
  }

  /** builtin/bisect.c's bisect_write */
  async bisectWrite(state: string, rev: string, terms: Terms, nolog: boolean): Promise<number> {
    let tag: string;
    if (state === terms.bad) tag = `refs/bisect/${state}`;
    else if (state === terms.good || state === "skip") tag = `refs/bisect/${state}-${rev}`;
    else return this.error(`Bad bisect_write argument: ${state}`);
    const oid = await this.ctx.resolve(rev);
    if (!oid) return this.error(`couldn't get the oid of the rev '${rev}'`);
    await this.ctx.setRef(tag, oid);
    let line = await this.logCommit(state, oid);
    if (!nolog) line += `git bisect ${state} ${rev}\n`;
    await this.append("BISECT_LOG", line);
    return 0;
  }

  // ============ status ============

  private async bisectStatus(terms: Terms): Promise<{ nrGood: number; nrBad: number }> {
    let nrGood = 0;
    let nrBad = 0;
    const goodPrefix = `refs/bisect/${terms.good}-`;
    for (const ref of await this.ctx.listBisectRefs()) {
      if (ref.name === `refs/bisect/${terms.bad}`) nrBad = 1;
      else if (ref.name.startsWith(goodPrefix)) nrGood++;
    }
    return { nrGood, nrBad };
  }

  private async logPrintf(text: string): Promise<void> {
    this.print(text);
    await this.append("BISECT_LOG", `# ${text}`);
  }

  private async printStatus(terms: Terms): Promise<void> {
    const { nrGood, nrBad } = await this.bisectStatus(terms);
    if (nrGood && nrBad) return;
    if (!nrGood && !nrBad) {
      await this.logPrintf(`status: waiting for both '${terms.good}' and '${terms.bad}' commits\n`);
    } else if (nrGood) {
      const commits = nrGood === 1 ? "commit" : "commits";
      await this.logPrintf(
        `status: waiting for '${terms.bad}' commit, ${nrGood} '${terms.good}' ${commits} known\n`,
      );
    } else {
      await this.logPrintf(
        `status: waiting for '${terms.good}' commit(s), '${terms.bad}' commit known\n`,
      );
    }
  }

  /** builtin/bisect.c's decide_next (no terminal: no question asked) */
  private async decideNext(
    terms: Terms,
    currentTerm: string | undefined,
    missingGood: boolean,
    missingBad: boolean,
  ): Promise<number> {
    if (!missingGood && !missingBad) return 0;
    if (currentTerm === undefined) return -1;
    if (missingGood && !missingBad && currentTerm === terms.good) {
      this.warning(`bisecting only with a ${terms.bad} commit`);
      return 0;
    }
    if (!(await this.emptyOrMissing("BISECT_START"))) {
      return this.error(
        `You need to give me at least one ${VOCAB_BAD} and ${VOCAB_GOOD} revision.\n` +
          `You can use "git bisect ${VOCAB_BAD}" and "git bisect ${VOCAB_GOOD}" for that.`,
      );
    }
    return this.error(
      `You need to start by "git bisect start".\n` +
        `You then need to give me at least one ${VOCAB_GOOD} and ${VOCAB_BAD} revision.\n` +
        `You can use "git bisect ${VOCAB_GOOD}" and "git bisect ${VOCAB_BAD}" for that.`,
    );
  }

  private async nextCheck(terms: Terms, currentTerm: string | undefined): Promise<number> {
    const { nrGood, nrBad } = await this.bisectStatus(terms);
    return this.decideNext(terms, currentTerm, !nrGood, !nrBad);
  }

  /** builtin/bisect.c's bisect_autostart (no terminal: no question asked) */
  private async autostart(): Promise<number> {
    if (!(await this.emptyOrMissing("BISECT_START"))) return 0;
    this.printErr('You need to start by "git bisect start"\n\n');
    return -1;
  }

  // ============ the bisection ============

  /** What a checkout git runs as a child printed (the child shares git's stdout and stderr). */
  private checkoutOutput(done: { stdout?: string; stderr?: string }): void {
    if (done.stdout) this.print(done.stdout);
    if (done.stderr) this.printErr(done.stderr);
  }

  /** bisect.c's bisect_checkout */
  private async checkoutCandidate(rev: ObjectId, noCheckout: boolean): Promise<number> {
    await this.ctx.setRef("BISECT_EXPECTED_REV", rev);
    this.candidate = rev;
    if (noCheckout) {
      await this.ctx.setRef("BISECT_HEAD", rev);
    } else {
      const done = await this.ctx.checkout(rev, { quiet: true });
      this.checkoutOutput(done);
      if (!done.ok) return BisectCode.FAILED;
    }
    this.print(`[${rev}] ${await this.ctx.subject(rev)}\n`);
    return BisectCode.OK;
  }

  private async readBisectPaths(): Promise<string[]> {
    const text = (await this.read("BISECT_NAMES")) ?? "";
    const out: string[] = [];
    for (const raw of readLines(text)) {
      const line = strbufTrim(raw);
      const { argv, ok } = sqDequoteToArgv(line);
      if (!ok) throw new BisectDie(`Badly quoted content in file '.git/BISECT_NAMES': ${line}`);
      out.push(...argv);
    }
    return out;
  }

  private async handleBadMergeBase(): Promise<number> {
    const bad = this.currentBad as ObjectId;
    const expected = await this.ctx.state.ref("BISECT_EXPECTED_REV");
    if (expected === bad) {
      // join_oid_array_hex: the good ids as read_bisect_refs read them (refname order)
      const goods = this.goodRevs.join(" ");
      if (this.termBad === "bad" && this.termGood === "good") {
        this.printErr(
          `The merge base ${bad} is bad.\nThis means the bug has been fixed between ${bad} and [${goods}].\n`,
        );
      } else if (this.termBad === "new" && this.termGood === "old") {
        this.printErr(
          `The merge base ${bad} is new.\nThe property has changed between ${bad} and [${goods}].\n`,
        );
      } else {
        this.printErr(
          `The merge base ${bad} is '${this.termBad}'.\nThis means the first '${this.termGood}' commit is between ${bad} and [${goods}].\n`,
        );
      }
      return BisectCode.MERGE_BASE_CHECK;
    }
    this.printErr(
      `Some '${this.termGood}' revs are not ancestors of the '${this.termBad}' rev.\n` +
        "git bisect cannot work properly in this case.\n" +
        `Maybe you mistook '${this.termGood}' and '${this.termBad}' revs?\n`,
    );
    return BisectCode.FAILED;
  }

  /** bisect.c's check_merge_bases */
  private async checkMergeBases(noCheckout: boolean): Promise<number> {
    const bad = this.currentBad as ObjectId;
    const bases = await this.ctx.mergeBasesMany(bad, this.goodRevs);
    const goods = new Set(this.goodRevs);
    const skipped = new Set(this.skippedRevs);
    for (const mb of bases) {
      if (mb === bad) return this.handleBadMergeBase();
      if (goods.has(mb)) continue;
      if (skipped.has(mb)) {
        const goodHex = this.goodRevs.join(" ");
        this.warning(
          `the merge base between ${bad} and [${goodHex}] must be skipped.\n` +
            `So we cannot be sure the first '${this.termBad}' commit is between ${mb} and ${bad}.\n` +
            "We continue anyway.",
        );
        continue;
      }
      this.print("Bisecting: a merge base must be tested\n");
      const res = await this.checkoutCandidate(mb, noCheckout);
      return res ? res : BisectCode.INTERNAL_SUCCESS_MERGE_BASE;
    }
    return BisectCode.OK;
  }

  /** bisect.c's check_good_are_ancestors_of_bad */
  private async checkGoodAreAncestorsOfBad(noCheckout: boolean): Promise<number> {
    if (!this.currentBad) return this.error(`a '${this.termBad}' revision is needed`);
    if (await this.exists("BISECT_ANCESTORS_OK")) return BisectCode.OK;
    if (this.goodRevs.length === 0) return BisectCode.OK;
    // check_ancestors: is anything reachable from a good commit and not from the bad one?
    const pending = [
      { id: this.currentBad, exclude: true },
      ...this.goodRevs.map((id) => ({ id, exclude: false })),
    ];
    const walked = await this.ctx.graph.walk(pending);
    // check_ancestors cleans up from the bad and good commits (clear_commit_marks_many)
    this.ctx.graph.clearCommitMarks([this.currentBad, ...this.goodRevs]);
    let res: number = BisectCode.OK;
    if (walked.length > 0) res = await this.checkMergeBases(noCheckout);
    if (!res) await this.write("BISECT_ANCESTORS_OK", "");
    return res;
  }

  /** bisect.c's error_if_skipped_commits */
  private errorIfSkippedCommits(tried: BisectNode[], bad: ObjectId | undefined): number {
    if (tried.length === 0) return BisectCode.OK;
    let text = `There are only 'skip'ped commits left to test.\nThe first '${this.termBad}' commit could be any of:\n`;
    for (const n of tried) text += `${n.id}\n`;
    if (bad) text += `${bad}\n`;
    text += "We cannot bisect more!\n";
    this.print(text);
    return BisectCode.ONLY_SKIPPED_LEFT;
  }

  /** bisect.c's bisect_next_all */
  private async nextAll(): Promise<number> {
    const noCheckout = await this.ctx.refExists("BISECT_HEAD");
    let bisectFlags = 0;
    await this.readBisectTerms();
    await this.readBisectRefs();
    if (await this.exists("BISECT_FIRST_PARENT")) bisectFlags |= FIND_BISECTION_FIRST_PARENT_ONLY;
    if (this.skippedRevs.length > 0) bisectFlags |= FIND_BISECTION_ALL;

    let res = await this.checkGoodAreAncestorsOfBad(noCheckout);
    if (res) return res;

    const bad = this.currentBad as ObjectId;
    const paths = await this.readBisectPaths();
    const pending = [
      { id: bad, exclude: false },
      ...this.goodRevs.map((id) => ({ id, exclude: true })),
    ];
    const walked = await this.ctx.graph.walk(pending, {
      paths,
      firstParent: (bisectFlags & FIND_BISECTION_FIRST_PARENT_ONLY) !== 0,
    });
    const found = findBisection(walked, bisectFlags);
    const { list, tried } = managedSkipped(found.list, new Set(this.skippedRevs), bad);

    if (list.length === 0) {
      res = this.errorIfSkippedCommits(tried, undefined);
      if (res < 0) return res;
      this.print(`${bad} was both '${this.termGood}' and '${this.termBad}'\n`);
      return BisectCode.FAILED;
    }
    if (!found.all) {
      this.printErr("No testable commit found.\nMaybe you started with bad path arguments?\n");
      return BisectCode.NO_TESTABLE_COMMIT;
    }
    const rev = (list[0] as BisectNode).id;
    if (rev === bad) {
      res = this.errorIfSkippedCommits(tried, bad);
      if (res) return res;
      this.print(`${rev} is the first '${this.termBad}' commit\n`);
      this.print(await this.ctx.showCommit(rev));
      this.firstBad = rev;
      return BisectCode.INTERNAL_SUCCESS_1ST_BAD_FOUND;
    }
    const nr = found.all - found.reaches - 1;
    const steps = estimateBisectSteps(found.all);
    const stepsMsg = steps === 1 ? `(roughly ${steps} step)` : `(roughly ${steps} steps)`;
    this.print(
      nr === 1
        ? `Bisecting: ${nr} revision left to test after this ${stepsMsg}\n`
        : `Bisecting: ${nr} revisions left to test after this ${stepsMsg}\n`,
    );
    // only here does git clean up every commit's flags (repo_clear_commit_marks); the other
    // ways out keep the flags the walks left
    this.ctx.graph.clearMarks();
    return this.checkoutCandidate(rev, noCheckout);
  }

  /** builtin/bisect.c's bisect_skipped_commits */
  private async skippedCommits(terms: Terms): Promise<number> {
    const refs = await this.ctx.listBisectRefs();
    const pending: { id: ObjectId; exclude: boolean }[] = [];
    for (const ref of refs) {
      const name = ref.name.slice("refs/bisect/".length);
      if (name.startsWith(terms.bad)) pending.push({ id: ref.id, exclude: false });
    }
    for (const ref of refs) {
      const name = ref.name.slice("refs/bisect/".length);
      if (name.startsWith(`${terms.good}-`)) pending.push({ id: ref.id, exclude: true });
    }
    // prepare_revs: SEEN and ADDED of the walk before cleared, the other flags kept
    this.ctx.graph.resetRevisionWalk();
    const walked = await this.ctx.graph.walk(pending);
    let text = "# only skipped commits left to test\n";
    for (const n of walked) {
      if (n.flags & UNINTERESTING) continue;
      text += `# possible first '${terms.bad}' commit: [${n.id}] ${await this.ctx.subject(n.id)}\n`;
    }
    this.ctx.graph.resetRevisionWalk();
    await this.append("BISECT_LOG", text);
    return 0;
  }

  /** builtin/bisect.c's bisect_successful */
  private async successful(terms: Terms): Promise<number> {
    const id = await this.ctx.state.ref(`refs/bisect/${terms.bad}`);
    const commit = id ? await this.ctx.peelCommit(id) : undefined;
    if (!commit) {
      this.error(`could not find commit for 'refs/bisect/${terms.bad}'`);
      return BisectCode.FAILED;
    }
    await this.append(
      "BISECT_LOG",
      `# first '${terms.bad}' commit: [${commit}] ${await this.ctx.subject(commit)}\n`,
    );
    return 0;
  }

  /** builtin/bisect.c's bisect_next */
  async next(terms: Terms): Promise<number> {
    if (await this.autostart()) return BisectCode.FAILED;
    if (await this.nextCheck(terms, terms.good)) return BisectCode.FAILED;
    let res = await this.nextAll();
    if (res === BisectCode.INTERNAL_SUCCESS_1ST_BAD_FOUND) {
      res = await this.successful(terms);
      return res ? res : BisectCode.INTERNAL_SUCCESS_1ST_BAD_FOUND;
    }
    if (res === BisectCode.ONLY_SKIPPED_LEFT) {
      res = await this.skippedCommits(terms);
      return res ? res : BisectCode.ONLY_SKIPPED_LEFT;
    }
    return res;
  }

  /** builtin/bisect.c's bisect_auto_next */
  async autoNext(terms: Terms): Promise<number> {
    if (await this.nextCheck(terms, undefined)) {
      await this.printStatus(terms);
      return BisectCode.OK;
    }
    return this.next(terms);
  }

  // ============ subcommands ============

  /** builtin/bisect.c's bisect_start */
  async start(terms: Terms, argv: string[]): Promise<number> {
    let noCheckout = this.ctx.isBare();
    let firstParentOnly = false;
    let mustWriteTerms = false;
    let resetWhenFound: ResetWhenFound;
    const revs: ObjectId[] = [];
    const hasDoubleDash = argv.includes("--");
    let i = 0;
    for (; i < argv.length; i++) {
      const arg = argv[i] as string;
      if (arg === "--") break;
      if (arg === "--no-checkout") noCheckout = true;
      else if (arg === "--first-parent") firstParentOnly = true;
      else if (arg === "--reset-when-found") resetWhenFound = "original";
      else if (arg.startsWith("--reset-when-found=")) {
        const value = arg.slice("--reset-when-found=".length);
        if (value !== "original" && value !== "found") {
          this.error(`invalid value for '--reset-when-found': '${value}'`);
          return BisectCode.FAILED;
        }
        resetWhenFound = value;
      } else if (arg === "--term-good" || arg === "--term-old") {
        i++;
        if (argv.length <= i) return this.error("'' is not a valid term");
        mustWriteTerms = true;
        terms.good = argv[i] as string;
      } else if (arg.startsWith("--term-good=") || arg.startsWith("--term-old=")) {
        mustWriteTerms = true;
        terms.good = arg.slice(arg.indexOf("=") + 1);
      } else if (arg === "--term-bad" || arg === "--term-new") {
        i++;
        if (argv.length <= i) return this.error("'' is not a valid term");
        mustWriteTerms = true;
        terms.bad = argv[i] as string;
      } else if (arg.startsWith("--term-bad=") || arg.startsWith("--term-new=")) {
        mustWriteTerms = true;
        terms.bad = arg.slice(arg.indexOf("=") + 1);
      } else if (arg.startsWith("--")) {
        return this.error(`unrecognized option: '${arg}'`);
      } else {
        const id = await this.ctx.resolve(`${arg}^{commit}`);
        if (id) revs.push(id);
        else if (hasDoubleDash)
          throw new BisectDie(`'${arg}' does not appear to be a valid revision`);
        else break;
      }
    }
    if (resetWhenFound && noCheckout) {
      this.error("options '--reset-when-found' and '--no-checkout' cannot be used together");
      return BisectCode.FAILED;
    }
    const pathspecPos = i;
    if (revs.length > 0) mustWriteTerms = true;
    const states = revs.map((_r, k) => (k === 0 ? terms.bad : terms.good));

    // verify HEAD
    const head = await this.ctx.resolveHead();
    if (!head) {
      const id = await this.ctx.resolve("HEAD");
      if (!id) return this.error("bad HEAD - I need a HEAD");
    }
    const headName = head?.name ?? "HEAD";

    let startHead: string;
    if (!(await this.emptyOrMissing("BISECT_START"))) {
      // reset to the rev from where we started
      startHead = strbufTrim((await this.read("BISECT_START")) ?? "");
      if (!noCheckout) {
        const done = await this.ctx.checkout(startHead, { quiet: false });
        this.checkoutOutput(done);
        if (!done.ok) {
          return this.error(
            `checking out '${startHead}' failed. Try 'git bisect start <valid-branch>'.`,
          );
        }
      }
    } else {
      const headId = await this.ctx.resolve(headName);
      if (headId && !headName.startsWith("refs/heads/")) startHead = headId;
      else if (headId && headName.startsWith("refs/heads/")) {
        startHead = headName.slice("refs/heads/".length);
      } else return this.error("bad HEAD - strange symbolic ref");
    }

    // get rid of any old bisect state
    await this.cleanState();
    await this.write("BISECT_START", `${startHead}\n`);
    if (firstParentOnly) await this.write("BISECT_FIRST_PARENT", "\n");
    if (resetWhenFound) await this.write("BISECT_RESET_WHEN_FOUND", `${resetWhenFound}\n`);
    // a failure from here on leaves the state written so far (git's `goto finish`)
    if (noCheckout) {
      const id = await this.ctx.resolve(startHead);
      if (!id) return this.error(`invalid ref: '${startHead}'`);
      await this.ctx.setRef("BISECT_HEAD", id);
    }
    const names = pathspecPos < argv.length - 1 ? sqQuoteArgv(argv.slice(pathspecPos)) : "";
    await this.write("BISECT_NAMES", `${names}\n`);
    for (let k = 0; k < states.length; k++) {
      if (await this.bisectWrite(states[k] as string, revs[k] as string, terms, true)) {
        return BisectCode.FAILED;
      }
    }
    if (mustWriteTerms && (await this.writeTerms(terms.bad, terms.good))) {
      return BisectCode.FAILED;
    }
    await this.append("BISECT_LOG", `git bisect start${sqQuoteArgv(argv)}\n`);
    const res = await this.autoNext(terms);
    if (!isBisectSuccess(res)) await this.cleanState();
    return res;
  }

  /** builtin/bisect.c's bisect_state */
  async state(terms: Terms, args: string[]): Promise<number> {
    if (args.length === 0) {
      return this.error("Please call `--bisect-state` with at least one argument");
    }
    if (await this.autostart()) return BisectCode.FAILED;
    const state = args[0] as string;
    if (
      (await this.checkAndSetTerms(terms, state)) ||
      !(state === terms.good || state === terms.bad || state === "skip")
    ) {
      return BisectCode.FAILED;
    }
    const revArgs = args.slice(1);
    if (revArgs.length > 1 && state === terms.bad) {
      return this.error(`'git bisect ${terms.bad}' can take only one argument.`);
    }
    const revs: ObjectId[] = [];
    if (revArgs.length === 0) {
      let head = "BISECT_HEAD";
      let id = await this.ctx.resolve(head);
      if (!id) {
        head = "HEAD";
        id = await this.ctx.resolve(head);
      }
      if (!id) this.error(`Bad rev input: ${head}`);
      // git goes on with whatever it read (the null id)
      revs.push(id ?? "0000000000000000000000000000000000000000");
    }
    for (const arg of revArgs) {
      const id = await this.ctx.resolve(arg);
      if (!id) {
        this.error(`Bad rev input: ${arg}`);
        return BisectCode.FAILED;
      }
      const commit = await this.ctx.peelCommit(id);
      if (!commit) {
        // lookup_commit_reference's object_as_type complains first
        const peeled = await this.ctx.peelObject(id);
        if (peeled) this.error(`object ${peeled.id} is a ${peeled.type}, not a commit`);
        throw new BisectDie(`Bad rev input (not a commit): ${arg}`);
      }
      revs.push(commit);
    }
    const expected = await this.ctx.state.ref("BISECT_EXPECTED_REV");
    let verifyExpected = expected !== undefined;
    for (const rev of revs) {
      if (await this.bisectWrite(state, rev, terms, false)) return BisectCode.FAILED;
      if (verifyExpected && rev !== expected) {
        await this.unlink("BISECT_ANCESTORS_OK");
        await this.ctx.deleteRef("BISECT_EXPECTED_REV");
        verifyExpected = false;
      }
    }
    return this.autoNext(terms);
  }

  /**
   * builtin/bisect.c's bisect_skip: ranges become the commits they name, each by a revision
   * walk in this process. Deliberately as git does it (a quirk of git 2.43 and 2.5x): the walk
   * runs over the commits the bisection walks next, and reset_revision_walk clears only SEEN
   * and ADDED, so the UNINTERESTING and BOTTOM flags of the range stay. When
   * check_ancestors does not run after it (BISECT_ANCESTORS_OK is there), the bisection walk
   * starts with them: `skip c7..c2` on a linear c1..c8 bisected as `start c8 c1` leaves
   * c7 and its ancestors uninteresting, and c8 is the first bad commit.
   */
  async skip(terms: Terms, args: string[]): Promise<number> {
    const argvState = ["skip"];
    for (const arg of args) {
      if (arg.includes("..")) {
        const pending = await this.ctx.rangePending(arg);
        for (const n of await this.ctx.graph.walk(pending)) {
          if (!(n.flags & UNINTERESTING)) argvState.push(n.id);
        }
        this.ctx.graph.resetRevisionWalk();
      } else argvState.push(arg);
    }
    return this.state(terms, argvState);
  }

  /** builtin/bisect.c's bisect_reset */
  async reset(commit: string | undefined, quiet: boolean): Promise<number> {
    let branch: string;
    if (commit === undefined) {
      const text = await this.read("BISECT_START");
      // git 2.5x: a missing file reads as nothing (no checkout, no word), an empty one is
      // "We are not bisecting."
      if (text === "") this.print("We are not bisecting.\n");
      branch = strbufRtrim(text ?? "");
    } else {
      const id = await this.ctx.resolve(`${commit}^{commit}`);
      if (!id) return this.error(`'${commit}' is not a valid commit`);
      branch = commit;
    }
    if (branch.length > 0 && !(await this.ctx.refExists("BISECT_HEAD"))) {
      const done = await this.ctx.checkout(branch, { quiet, ignoreOtherWorktrees: true });
      this.checkoutOutput(done);
      if (!done.ok) {
        this.error(
          `could not check out original HEAD '${branch}'. Try 'git bisect reset <commit>'.`,
        );
        return -1;
      }
    }
    return 0;
  }

  /** builtin/bisect.c's bisect_terms */
  async terms(terms: Terms, option: string | undefined): Promise<number> {
    if (!(await this.getTerms(terms, false))) return this.error("no terms defined");
    if (option === undefined) {
      this.print(
        `Your current terms are '${terms.good}' for the old state\nand '${terms.bad}' for the new state.\n`,
      );
      return 0;
    }
    if (option === "--term-good" || option === "--term-old") this.print(`${terms.good}\n`);
    else if (option === "--term-bad" || option === "--term-new") this.print(`${terms.bad}\n`);
    else {
      return this.error(
        `invalid argument ${option} for 'git bisect terms'.\n` +
          "Supported options are: --term-good|--term-old and --term-bad|--term-new.",
      );
    }
    return 0;
  }

  /** builtin/bisect.c's bisect_log */
  async log(): Promise<number> {
    const text = await this.read("BISECT_LOG");
    if (!text) return this.error("We are not bisecting.");
    this.print(text);
    return BisectCode.OK;
  }

  private async processReplayLine(terms: Terms, line: string): Promise<number> {
    let p = line.replace(/^[ \t]+/, "");
    if (p.startsWith("git bisect")) p = p.slice("git bisect".length);
    else if (p.startsWith("git-bisect")) p = p.slice("git-bisect".length);
    else return 0;
    // git's isspace: space, tab, LF and CR (sane_ctype), not VT or FF
    if (!/^[ \t\n\r]/.test(p)) return 0;
    p = p.replace(/^[ \t]+/, "");
    const wordEnd = p.search(/[ \t]/);
    const word = wordEnd < 0 ? p : p.slice(0, wordEnd);
    const rev = wordEnd < 0 ? "" : p.slice(wordEnd).replace(/^[ \t]+/, "");
    if (!(await this.getTerms(terms, true))) return this.error("no terms defined");
    if (await this.checkAndSetTerms(terms, word)) return -1;
    if (word === "start") return this.start(terms, sqDequoteToArgv(rev).argv);
    if (word === terms.good || word === terms.bad || word === "skip") {
      return this.bisectWrite(word, rev, terms, false);
    }
    if (word === "terms") {
      const { argv } = sqDequoteToArgv(rev);
      return this.terms(terms, argv.length === 1 ? argv[0] : undefined);
    }
    this.error(`'${word}'?? what are you talking about?`);
    return -1;
  }

  /** builtin/bisect.c's bisect_replay, over the log's text */
  async replay(terms: Terms, text: string | undefined, name: string): Promise<number> {
    if (!text) return this.error(`cannot read file '${name}' for replaying`);
    await this.cleanState();
    let res = 0;
    for (const line of readLines(text)) {
      // strbuf_getline: a CR before the LF goes too
      res = await this.processReplayLine(terms, line.replace(/\r$/, ""));
      if (res) break;
    }
    if (res) return BisectCode.FAILED;
    return this.autoNext(terms);
  }

  /** builtin/bisect.c's bisect_run */
  async run(terms: Terms, args: string[]): Promise<number> {
    if (await this.nextCheck(terms, undefined)) return BisectCode.FAILED;
    let argv = args;
    let resetWhenFound: ResetWhenFound;
    if (argv[0] === "--reset-when-found") resetWhenFound = "original";
    else if (argv[0]?.startsWith("--reset-when-found=")) {
      const value = argv[0].slice("--reset-when-found=".length);
      if (value !== "original" && value !== "found") {
        this.error(`invalid value for '--reset-when-found': '${value}'`);
        return BisectCode.FAILED;
      }
      resetWhenFound = value;
    }
    if (resetWhenFound && (await this.ctx.refExists("BISECT_HEAD"))) {
      return this.error("options '--reset-when-found' and '--no-checkout' cannot be used together");
    }
    if (resetWhenFound) {
      await this.write("BISECT_RESET_WHEN_FOUND", `${resetWhenFound}\n`);
      argv = argv.slice(1);
    }
    if (argv.length === 0) {
      this.error("bisect run failed: no command provided.");
      return BisectCode.FAILED;
    }
    const command = sqQuoteArgv(argv).replace(/^\s+/, "");
    let isFirstRun = true;
    let res: number;
    for (;;) {
      res = await this.doRun(command, argv);
      if (isFirstRun && (res === 126 || res === 127)) {
        const rc = await this.verifyGood(terms, command, argv);
        isFirstRun = false;
        if (rc < 0 || 128 <= rc) {
          this.error(`unable to verify ${command} on '${terms.good}' revision`);
          res = BisectCode.FAILED;
          break;
        }
        if (rc === res) {
          this.error(`bogus exit code ${rc} for '${terms.good}' revision`);
          res = BisectCode.FAILED;
          break;
        }
      }
      if (res < 0 || 128 <= res) {
        this.error(`bisect run failed: exit code ${res} from ${command} is < 0 or >= 128`);
        break;
      }
      const newState = res === 125 ? "skip" : res === 0 ? terms.good : terms.bad;
      // the step's output goes to BISECT_RUN, then is printed
      const saved = this.stdout;
      this.stdout = "";
      res = await this.state(terms, [newState]);
      const stepOutput = this.stdout;
      this.stdout = saved;
      await this.write("BISECT_RUN", stepOutput);
      this.print(stepOutput);
      if (res === BisectCode.ONLY_SKIPPED_LEFT) this.error("bisect run cannot continue any more");
      else if (res === BisectCode.INTERNAL_SUCCESS_MERGE_BASE) {
        this.print("bisect run success\n");
        res = BisectCode.OK;
      } else if (res === BisectCode.INTERNAL_SUCCESS_1ST_BAD_FOUND) {
        this.print(`bisect found first '${terms.bad}' commit\n`);
      } else if (res) {
        this.error(`bisect run failed: 'git bisect ${newState}' exited with error code ${res}`);
      } else continue;
      break;
    }
    return res;
  }

  /** builtin/bisect.c's do_bisect_run, through the host's handler */
  private async doRun(command: string, argv: string[]): Promise<number> {
    this.print(`running ${command}\n`);
    const noCheckout = await this.ctx.refExists("BISECT_HEAD");
    const commit = await this.ctx.resolve(noCheckout ? "BISECT_HEAD" : "HEAD");
    const handler = this.ctx.runHandler;
    // without a handler the command cannot be run: the shell's "command not found"
    if (!handler) return 127;
    const outcome = await handler({ command, argv: [...argv], commit });
    if (typeof outcome === "number") return outcome;
    if (outcome.output) this.print(outcome.output);
    return outcome.exitCode;
  }

  /** builtin/bisect.c's verify_good: the command on the first good commit, then back */
  private async verifyGood(terms: Terms, command: string, argv: string[]): Promise<number> {
    const goodPrefix = `refs/bisect/${terms.good}-`;
    const good = (await this.ctx.listBisectRefs()).find((r) => r.name.startsWith(goodPrefix));
    const noCheckout = await this.ctx.refExists("BISECT_HEAD");
    const current = await this.ctx.resolve(noCheckout ? "BISECT_HEAD" : "HEAD");
    if (!current) return -1;
    if (!good) return -1;
    if ((await this.checkoutCandidate(good.id, noCheckout)) !== BisectCode.OK) return -1;
    const rc = await this.doRun(command, argv);
    if ((await this.checkoutCandidate(current, noCheckout)) !== BisectCode.OK) return -1;
    return rc;
  }

  /** builtin/bisect.c's read_reset_when_found */
  async readResetWhenFound(): Promise<ResetWhenFound | "invalid"> {
    const text = await this.read("BISECT_RESET_WHEN_FOUND");
    if (!text) return undefined;
    const value = strbufTrim(text);
    if (value === "original" || value === "found") return value;
    this.error(`invalid value for '--reset-when-found': '${value}'`);
    return "invalid";
  }

  /** builtin/bisect.c's bisect_reset_when_found */
  async resetWhenFound(mode: "original" | "found"): Promise<number> {
    let commit: string | undefined;
    if (mode === "found") {
      await this.readBisectTerms();
      commit = `refs/bisect/${this.termBad}`;
    }
    let res = await this.reset(commit, true);
    if (!res) res = await this.cleanState();
    return res;
  }
}

/** The lines of a file as strbuf_getline_lf reads them (no empty last line after an LF). */
function readLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}
