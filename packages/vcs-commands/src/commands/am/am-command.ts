/**
 * `git am`: applies a series of patches from mailboxes, committing each with the author,
 * date and message of its mail, as git does: the state in `.git/rebase-apply/` (the split
 * mails `0001`..., `next`, `last`, `info`, `msg`, `patch`, `final-commit`,
 * `author-script`, the option files, `abort-safety`), `ORIG_HEAD`, the reflog lines
 * (`am: <subject>`, `am --abort`), the output ("Applying: <subject>", "Patch failed at
 * ...") and the advice, and `--continue`, `--skip`, `--abort`, `--quit`.
 *
 * Not run: the `applypatch-msg`, `pre-applypatch` and `post-applypatch` hooks, rerere,
 * and the auto maintenance git starts at the end. Notes are not copied: plain `git am`
 * copies none (only `rebase --apply` does, through `rewritten`).
 */

import type { ObjectId, PersonIdent } from "@statewalker/vcs-core";

import { compareGitPaths } from "@statewalker/vcs-utils/encoding";

import { GitCommand } from "../../git-command.js";
import { quotePath } from "../../results/quote-path.js";
import { ApplyCommand } from "../apply/apply-command.js";
import { ApplyEngine, type ApplyIO } from "../apply/apply-engine.js";
import {
  bytesToLatin1,
  latin1ToBytes,
  latin1ToPath,
  latin1ToText,
  pathToLatin1,
  textToLatin1,
} from "../apply/latin1.js";
import { coreBool } from "../core-config.js";
import { localTimezoneOffset, parseGitDate } from "../git-date.js";
import { withoutCrud } from "../git-ident.js";
import { configValue, conflictStyleOf } from "../merge-config.js";
import { ortConfigOptions } from "../merge-drivers.js";
import {
  flatTree,
  indexChangesFromTree,
  OperationState,
  readIndex,
  storeFlatTree,
  storeFlatTreeOver,
  switchTrees,
  treeDelta,
} from "../merge-support.js";
import { stripspace } from "../message-cleanup.js";
import { ortResultEntries } from "../ort-merge.js";
import { mergeStoredTrees, storedBase } from "../ort-recursive.js";
import { updateHead } from "../reflog-messages.js";
import { resetMerge } from "../sequencer-support.js";
import { appendSignoff } from "../trailers.js";
import { mailinfo, mailsplit } from "./mailinfo.js";
import {
  type AmPatchFormat,
  detectPatchFormat,
  hgPatchToMail,
  stgitPatchToMail,
} from "./patch-format.js";

const DIR = "rebase-apply";

/** What `git am` printed and how it ended. */
export interface AmResult {
  /** 0 done, 128 stopped (a patch that does not apply, an error) */
  exitCode: number;
  output: string;
  errors: string;
}

type Resume = "apply" | "continue" | "allow-empty" | "skip" | "abort" | "quit";

/** The options `git am` passes to `git apply` (kept in `apply-opt`). */
export interface AmApplyOptions {
  /** `-C<n>` */
  context?: number;
  /** `-p<n>` */
  strip?: number;
  /** `--whitespace=<action>` */
  whitespace?: string;
  /** `--directory=<dir>` */
  directory?: string;
  /** `--exclude=<path>` */
  exclude?: string[];
  /** `--include=<path>` */
  include?: string[];
  /** `--reject` */
  reject?: boolean;
  /** `--ignore-whitespace` */
  ignoreWhitespace?: boolean;
}

/** `sq_quote_buf`. */
function sqQuote(s: string): string {
  return `'${s.replace(/['!]/g, (c) => `'\\${c}'`)}'`;
}

/** `sq_dequote_to_strvec` of what `sqQuote` wrote. */
function sqDequoteAll(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (s[i] === " ") i++;
    if (i >= s.length) break;
    if (s[i] !== "'") break;
    let cur = "";
    i++;
    for (;;) {
      const c = s[i++];
      if (c === undefined) break;
      if (c === "'") {
        if (s[i] === "\\" && s[i + 2] === "'") {
          cur += s[i + 1];
          i += 3;
          continue;
        }
        break;
      }
      cur += c;
    }
    out.push(cur);
  }
  return out;
}

/**
 * `git am`.
 *
 * @example
 * ```typescript
 * await git.am().addMbox(mboxBytes).setThreeWay(true).call();
 * await git.am().setResume("continue").call();
 * ```
 */
export class AmCommand extends GitCommand<AmResult> {
  private mboxes: { content: string; name?: string }[] = [];
  private patchFormat?: AmPatchFormat;
  private fixedClock?: number;
  private resume?: Resume;
  private threeWay?: boolean;
  private signoff = false;
  private keepCr?: boolean;
  private keep: "t" | "b" | "f" = "f";
  private messageId?: boolean;
  private scissors?: boolean;
  private quiet = false;
  private utf8 = true;
  private ignoreDate = false;
  private committerDateIsAuthorDate = false;
  private mboxrd = false;
  private emptyMode: "stop" | "drop" | "keep" = "stop";
  private applyOptions: AmApplyOptions = {};
  private legacyMessages = false;
  private out = "";
  private err = "";

  /**
   * A mailbox (mbox) to apply, in order. `name` is its file's name as git shows it in
   * messages (the file argument); a named file's format is detected (from the first one)
   * and it must not be empty, while one without a name reads as standard input (an mbox).
   */
  addMbox(mbox: Uint8Array | string, name?: string): this {
    const content = typeof mbox === "string" ? textToLatin1(mbox) : bytesToLatin1(mbox);
    this.mboxes.push({ content, ...(name !== undefined ? { name } : {}) });
    return this;
  }

  /**
   * `--patch-format=<format>`: mbox, mboxrd, stgit or hg (Mercurial); detected from the
   * first named mailbox when not given. An StGit series (`stgit-series`) names its patch
   * files, which a command given contents cannot open: it is refused.
   */
  setPatchFormat(format: AmPatchFormat): this {
    this.patchFormat = format;
    return this;
  }

  /**
   * The clock (seconds since the epoch) for the dates git takes from it: the author date of
   * `--ignore-date` or of a mail without a `Date:` header, the committer date and the reflog
   * lines (default: the system clock).
   */
  setClock(seconds: number): this {
    this.fixedClock = seconds;
    return this;
  }

  protected override clock(): number {
    return this.fixedClock ?? super.clock();
  }

  /** `--continue`/`--resolved`, `--allow-empty`, `--skip`, `--abort`, `--quit`. */
  setResume(mode: "continue" | "resolved" | "allow-empty" | "skip" | "abort" | "quit"): this {
    this.resume = mode === "resolved" ? "continue" : mode;
    return this;
  }

  /** `-3` / `--3way` (default `am.threeWay`). */
  setThreeWay(value: boolean): this {
    this.threeWay = value;
    return this;
  }

  /** `-s` / `--signoff`. */
  setSignoff(value: boolean): this {
    this.signoff = value;
    return this;
  }

  /** `--keep-cr` (default `am.keepcr`). */
  setKeepCr(value: boolean): this {
    this.keepCr = value;
    return this;
  }

  /** `-k` (true) / `--keep-non-patch` ("non-patch"). */
  setKeep(value: boolean | "non-patch"): this {
    this.keep = value === "non-patch" ? "b" : value ? "t" : "f";
    return this;
  }

  /** `-m` / `--message-id` (default `am.messageid`). */
  setMessageId(value: boolean): this {
    this.messageId = value;
    return this;
  }

  /** `-c` / `--scissors`, `--no-scissors`. */
  setScissors(value: boolean): this {
    this.scissors = value;
    return this;
  }

  /** `-q`. */
  setQuiet(value: boolean): this {
    this.quiet = value;
    return this;
  }

  /** `-u` (default) / `-n`. */
  setUtf8(value: boolean): this {
    this.utf8 = value;
    return this;
  }

  /** `--ignore-date`. */
  setIgnoreDate(value: boolean): this {
    this.ignoreDate = value;
    return this;
  }

  /** `--committer-date-is-author-date`. */
  setCommitterDateIsAuthorDate(value: boolean): this {
    this.committerDateIsAuthorDate = value;
    return this;
  }

  /** `--patch-format=mboxrd`. */
  setMboxrd(value: boolean): this {
    this.mboxrd = value;
    return this;
  }

  /** `--empty=stop|drop|keep`. */
  setEmpty(mode: "stop" | "drop" | "keep"): this {
    this.emptyMode = mode;
    return this;
  }

  /** The options passed through to `git apply`. */
  setApplyOptions(options: AmApplyOptions): this {
    this.applyOptions = options;
    return this;
  }

  /** git before 2.46 prints the resolve advice on stdout, not as hints. */
  setLegacyMessages(value: boolean): this {
    this.legacyMessages = value;
    return this;
  }

  private state(): OperationState {
    return new OperationState(this.workingCopy.checkout, this.refsStore);
  }

  private say(text: string): void {
    if (!this.quiet) this.out += `${text}\n`;
  }

  private result(exitCode: number): AmResult {
    return { exitCode, output: latin1ToText(this.out), errors: latin1ToText(this.err) };
  }

  async call(): Promise<AmResult> {
    this.checkCallable();
    this.setCallable(false);
    try {
      return await this.run();
    } catch (error) {
      if (error instanceof AmStop) return this.result(error.status);
      throw error;
    }
  }

  private fatal(message: string): never {
    this.err += `fatal: ${message}\n`;
    throw new AmStop(128);
  }

  private async read(name: string): Promise<string | undefined> {
    const bytes = await this.workingCopy.checkout.readStateFile?.(`${DIR}/${name}`);
    return bytes ? bytesToLatin1(bytes) : undefined;
  }

  /** `write_file_buf`: the content as it is. */
  private async write(name: string, content: string): Promise<void> {
    await this.workingCopy.checkout.writeStateFile?.(`${DIR}/${name}`, latin1ToBytes(content));
  }

  /** `write_state_text` (`write_file`): the line completed. */
  private async writeText(name: string, content: string): Promise<void> {
    await this.write(name, content && !content.endsWith("\n") ? `${content}\n` : content);
  }

  private async headId(): Promise<ObjectId | undefined> {
    return (await this.refsStore.resolve("HEAD").catch(() => undefined))?.objectId;
  }

  private async run(): Promise<AmResult> {
    const state = this.state();
    const inProgress =
      (await this.read("next")) !== undefined && (await this.read("last")) !== undefined;
    if (inProgress) {
      if (this.mboxes.length)
        this.fatal(`previous rebase directory .git/${DIR} still exists but mbox given.`);
      const mode = this.resume ?? "apply";
      if (mode === "quit") {
        await state.remove(DIR);
        return this.result(0);
      }
      if (mode === "abort") return this.abort();
      const st = await this.load();
      if (mode === "skip") {
        const head = await this.headId();
        if (head) {
          const refused = await resetMerge(this.sequencerContext(), head, "HEAD");
          if (refused) this.fatal(refused.message);
        }
        await this.next(st);
        return this.amRun(st, false);
      }
      if (mode === "continue" || mode === "allow-empty")
        return this.resolve(st, mode === "allow-empty");
      return this.amRun(st, true);
    }
    if (await state.exists(DIR)) {
      if (this.resume === "abort" || this.resume === "quit") {
        await state.remove(DIR);
        return this.result(0);
      }
      this.fatal(`Stray .git/${DIR} directory found.\nUse "git am --abort" to remove it.`);
    }
    if (this.resume) this.fatal("Resolve operation not in progress, we are not resuming.");
    return this.setup();
  }

  private async setup(): Promise<AmResult> {
    const state = this.state();
    const bool = (k: string) => {
      const v = configValue(this.workingCopy, k)?.toLowerCase();
      return v === undefined ? undefined : ["true", "yes", "on", "1", ""].includes(v);
    };
    const threeway = this.threeWay ?? bool("am.threeWay") ?? false;
    const keepCr = this.keepCr ?? bool("am.keepcr") ?? false;
    const messageId = this.messageId ?? bool("am.messageid") ?? false;
    // detect_patch_format: standard input is a mailbox, a file is looked at
    const first = this.mboxes[0];
    const format =
      this.patchFormat ??
      (this.mboxrd
        ? "mboxrd"
        : first?.name !== undefined
          ? detectPatchFormat(first.content)
          : "mbox");
    if (!format) {
      this.err += "Patch format detection failed.\n";
      throw new AmStop(128);
    }
    await state.removeRef("REBASE_HEAD");
    const mails: string[] = [];
    const failSplit = (error: string): never => {
      this.err += `error: ${error}\n`;
      this.fatal("Failed to split patches.");
    };
    const inputs = this.mboxes.length ? this.mboxes : [{ content: "" }];
    if (format === "mbox" || format === "mboxrd") {
      for (const mbox of inputs) {
        // mailsplit: an empty file is an error, empty standard input is not
        if (mbox.name !== undefined && /^[ \t\n\v\f\r]*$/.test(mbox.content)) {
          this.err += `error: empty mbox: '${mbox.name}'\n`;
          failSplit(`cannot split patches from ${mbox.name}`);
        }
        mails.push(...mailsplit(mbox.content, { keepCr, mboxrd: format === "mboxrd" }));
      }
    } else if (format === "stgit-series") {
      failSplit("Only one StGIT patch series can be applied at once");
    } else {
      for (const mbox of inputs) {
        if (format === "stgit") mails.push(stgitPatchToMail(mbox.content));
        else {
          const r = hgPatchToMail(mbox.content);
          if ("error" in r) {
            this.err += `error: ${r.error}\n`;
            failSplit(`could not parse patch '${mbox.name ?? "-"}'`);
          }
          mails.push((r as { mail: string }).mail);
        }
      }
    }
    let n = 0;
    for (const mail of mails) await this.write(String(++n).padStart(4, "0"), mail);
    await this.writeText("threeway", threeway ? "t" : "f");
    await this.writeText("quiet", this.quiet ? "t" : "f");
    await this.writeText("sign", this.signoff ? "t" : "f");
    await this.writeText("utf8", this.utf8 ? "t" : "f");
    await this.writeText("keep", this.keep);
    await this.writeText("messageid", messageId ? "t" : "f");
    await this.writeText("scissors", this.scissors === undefined ? "" : this.scissors ? "t" : "f");
    await this.writeText("quoted-cr", "");
    await this.writeText(
      "apply-opt",
      this.applyArgs()
        .map((a) => ` ${sqQuote(a)}`)
        .join(""),
    );
    await this.writeText("applying", "");
    const head = await this.headId();
    if (head) {
      await this.writeText("abort-safety", head);
      await state.setRef("ORIG_HEAD", head);
    } else {
      await this.writeText("abort-safety", "");
      await state.removeRef("ORIG_HEAD");
    }
    await this.writeText("next", "1");
    await this.writeText("last", String(n));
    return this.amRun(await this.load(), false);
  }

  private applyArgs(): string[] {
    const o = this.applyOptions;
    const args: string[] = [];
    if (o.context !== undefined) args.push(`-C${o.context}`);
    if (o.strip !== undefined) args.push(`-p${o.strip}`);
    if (o.whitespace !== undefined) args.push(`--whitespace=${o.whitespace}`);
    if (o.directory !== undefined) args.push(`--directory=${o.directory}`);
    for (const e of o.exclude ?? []) args.push(`--exclude=${e}`);
    for (const e of o.include ?? []) args.push(`--include=${e}`);
    if (o.reject) args.push("--reject");
    if (o.ignoreWhitespace) args.push("--ignore-whitespace");
    return args;
  }

  private async load(): Promise<AmState> {
    const t = async (name: string) => (await this.read(name))?.trim() ?? "";
    const st: AmState = {
      cur: Number.parseInt(await t("next"), 10),
      last: Number.parseInt(await t("last"), 10),
      threeway: (await t("threeway")) === "t",
      quiet: (await t("quiet")) === "t",
      signoff: (await t("sign")) === "t",
      utf8: (await t("utf8")) === "t",
      keep: ((await t("keep")) || "f") as "t" | "b" | "f",
      messageId: (await t("messageid")) === "t",
      scissors: await t("scissors"),
      applyOpts: sqDequoteAll(await t("apply-opt")),
    };
    const script = await this.read("author-script");
    if (script !== undefined) {
      const get = (k: string) => {
        const m = new RegExp(`^${k}=(.*)$`, "m").exec(script);
        return m ? (sqDequoteAll(m[1] as string)[0] ?? "") : undefined;
      };
      st.author = {
        name: get("GIT_AUTHOR_NAME") ?? "",
        email: get("GIT_AUTHOR_EMAIL") ?? "",
        date: get("GIT_AUTHOR_DATE") ?? "",
      };
    }
    st.msg = await this.read("final-commit");
    this.quiet = st.quiet;
    return st;
  }

  private async next(st: AmState): Promise<void> {
    const state = this.state();
    st.author = undefined;
    st.msg = undefined;
    await state.remove(`${DIR}/author-script`, `${DIR}/final-commit`, `${DIR}/original-commit`);
    await state.removeRef("REBASE_HEAD");
    await this.writeText("abort-safety", (await this.headId()) ?? "");
    st.cur++;
    await this.writeText("next", String(st.cur));
  }

  private firstLine(msg: string): string {
    const nl = msg.indexOf("\n");
    return nl < 0 ? msg : msg.slice(0, nl);
  }

  private async indexHasChanges(): Promise<string[]> {
    const head = await this.headId();
    const tree = head ? (await this.commits.load(head))?.tree : undefined;
    const { index } = await readIndex(this.staging);
    return indexChangesFromTree(index, this.trees, tree);
  }

  /** `die_user_resolve`: the advice, then the stop. */
  private async dieUserResolve(): Promise<never> {
    const bool = (k: string) => {
      const v = configValue(this.workingCopy, k)?.toLowerCase();
      return v === undefined ? undefined : ["true", "yes", "on", "1", ""].includes(v);
    };
    const patchEmptyAndClean =
      bool("advice.amWorkDir") !== false &&
      (await this.patchIsEmpty()) &&
      (await this.indexHasChanges()).length === 0;
    if (bool("advice.mergeConflict") === false && !this.legacyMessages) throw new AmStop(128);
    const lines = [
      'When you have resolved this problem, run "git am --continue".',
      'If you prefer to skip this patch, run "git am --skip" instead.',
      ...(patchEmptyAndClean
        ? ['To record the empty patch as an empty commit, run "git am --allow-empty".']
        : []),
      'To restore the original branch and stop patching, run "git am --abort".',
    ];
    if (this.legacyMessages) this.out += `${lines.join("\n")}\n`;
    else {
      for (const l of lines) this.err += `hint: ${l}\n`;
      this.err += 'hint: Disable this message with "git config set advice.mergeConflict false"\n';
    }
    throw new AmStop(128);
  }

  private async patchIsEmpty(): Promise<boolean> {
    const p = await this.read("patch");
    return p === undefined || p.length === 0;
  }

  private async amRun(st: AmState, resume0: boolean): Promise<AmResult> {
    const state = this.state();
    let resume = resume0;
    await state.remove(`${DIR}/dirtyindex`);
    const dirty = await this.indexHasChanges();
    if (dirty.length) {
      await this.writeText("dirtyindex", "t");
      this.fatal(`Dirty index: cannot apply patches (dirty: ${dirty.join(" ")})`);
    }
    while (st.cur <= st.last) {
      const name = String(st.cur).padStart(4, "0");
      const mail = await this.read(name);
      if (mail === undefined) {
        await this.next(st);
        resume = false;
        continue;
      }
      if (resume) {
        if (st.msg === undefined)
          this.fatal(`cannot resume: .git/${DIR}/final-commit does not exist.`);
        if (!st.author) this.fatal(`cannot resume: .git/${DIR}/author-script does not exist.`);
      } else {
        const mi = mailinfo(mail, {
          keepSubject: st.keep === "t",
          keepNonPatchBrackets: st.keep === "b",
          addMessageId: st.messageId,
          ...(st.scissors ? { useScissors: st.scissors === "t" } : {}),
          utf8: st.utf8,
        });
        await this.write("info", mi.info);
        await this.write("msg", mi.msg);
        await this.write("patch", mi.patch);
        this.err += mi.errors;
        if (mi.failed) this.fatal("could not parse patch");
        if (mi.formatFlowed)
          this.err +=
            "warning: Patch sent with format=flowed; space at the end of lines might be lost.\n";
        if (mi.author === "Mail System Internal Data") {
          await this.next(st);
          continue;
        }
        let msg = `${mi.subject}\n\n${mi.msg}`;
        msg = stripspace(msg);
        if (st.signoff) {
          const c = this.resolveCommitter();
          msg = appendSignoff(msg, pathToLatin1(`Signed-off-by: ${c.name} <${c.email}>\n`));
        }
        st.author = { name: mi.author, email: mi.email, date: mi.date };
        st.msg = msg;
        await this.writeText(
          "author-script",
          `GIT_AUTHOR_NAME=${sqQuote(mi.author)}\nGIT_AUTHOR_EMAIL=${sqQuote(mi.email)}\nGIT_AUTHOR_DATE=${sqQuote(mi.date)}\n`,
        );
        await this.write("final-commit", msg);
      }
      const msg = st.msg as string;
      let toKeep = false;
      if (await this.patchIsEmpty()) {
        if (this.emptyMode === "drop") {
          this.say(`Skipping: ${this.firstLine(msg)}`);
          await this.next(st);
          resume = false;
          continue;
        }
        if (this.emptyMode === "keep") {
          toKeep = true;
          this.say(`Creating an empty commit: ${this.firstLine(msg)}`);
        } else {
          this.out += "Patch is empty.\n";
          await this.dieUserResolve();
        }
      }
      if (!toKeep) {
        this.say(`Applying: ${this.firstLine(msg)}`);
        let status = await this.runApply(st);
        if (status && st.threeway) {
          status = await this.fallBackThreeway(st, msg);
          // the patch applied to an earlier tree merges into what HEAD has already
          if (!status && !(await this.indexHasChanges()).length) {
            this.say("No changes -- Patch already applied.");
            await this.next(st);
            resume = false;
            continue;
          }
        }
        if (status) {
          this.out += `Patch failed at ${name} ${this.firstLine(msg)}\n`;
          this.err += "hint: Use 'git am --show-current-patch=diff' to see the failed patch\n";
          await this.dieUserResolve();
        }
      }
      await this.doCommit(st);
      await this.next(st);
      resume = false;
    }
    await state.remove(DIR);
    return this.result(0);
  }

  private async runApply(st: AmState): Promise<number> {
    const patch = (await this.read("patch")) ?? "";
    const cmd = new ApplyCommand(this.workingCopy)
      .addPatch(latin1ToBytes(patch), `.git/${DIR}/patch`)
      .setIndex(true)
      .setLegacyMessages(this.legacyMessages);
    for (const a of st.applyOpts) {
      if (a.startsWith("-C")) cmd.setContext(Number(a.slice(2)));
      else if (a.startsWith("-p")) cmd.setStrip(Number(a.slice(2)));
      else if (a.startsWith("--whitespace=")) cmd.setWhitespace(a.slice(13));
      else if (a.startsWith("--directory=")) cmd.setDirectory(a.slice(12));
      else if (a.startsWith("--exclude=")) cmd.addExclude(a.slice(10));
      else if (a.startsWith("--include=")) cmd.addInclude(a.slice(10));
      else if (a === "--reject") cmd.setReject(true);
      else if (a === "--ignore-whitespace") cmd.setIgnoreWhitespace(true);
    }
    if (st.threeway) cmd.setVerbose(false);
    const r = await cmd.call();
    this.out += pathToLatin1(r.output);
    this.err += pathToLatin1(r.errors);
    return r.exitCode;
  }

  /** `fall_back_threeway`: the patch applied to the blobs it names, merged into HEAD. */
  private async fallBackThreeway(st: AmState, msg: string): Promise<number> {
    const head = await this.headId();
    const ourTree = head ? (await this.commits.load(head))?.tree : undefined;
    const patch = (await this.read("patch")) ?? "";
    // build_fake_ancestor (git apply --build-fake-ancestor)
    const parser = new ApplyEngine(
      undefined as unknown as ApplyIO,
      () => undefined,
      async () => 0,
      () => false,
    );
    for (const a of st.applyOpts) {
      if (a.startsWith("-p")) {
        parser.pValue = Number(a.slice(2));
        parser.pValueKnown = true;
      } else if (a.startsWith("--directory="))
        parser.root = pathToLatin1(`${a.slice(12).replace(/\/?$/, "/")}`);
    }
    parser.apply = false;
    const list = await parser.parsePatches({
      text: patch,
      name: `.git/${DIR}/patch`,
      fromFile: true,
    });
    this.err += parser.stderr;
    const fake = new Map<string, { mode: number; objectId: string }>();
    const resolver = this.revisionResolver();
    let failed: string | undefined = typeof list === "number" ? "" : undefined;
    const { index } = await readIndex(this.staging);
    for (const p of typeof list === "number" ? [] : list) {
      const name = latin1ToPath((p.oldName ?? p.newName) as string);
      if (p.isNew > 0) continue;
      let oid: string | undefined;
      try {
        oid = /^[0-9a-f]{4,40}$/.test(p.oldOidPrefix)
          ? await resolver.resolve(p.oldOidPrefix)
          : undefined;
        if (oid && !(await this.blobs.has(oid))) oid = undefined;
      } catch {
        oid = undefined;
      }
      if (!oid) {
        if (!p.linesAdded && !p.linesDeleted) {
          oid = index.get(latin1ToPath(p.oldName as string))?.objectId;
          if (!oid) {
            failed = `mode change for ${name}, which is not in current HEAD`;
            break;
          }
        } else {
          failed = `sha1 information is lacking or useless (${name}).`;
          break;
        }
      }
      fake.set(name, { mode: p.oldMode, objectId: oid });
    }
    if (failed !== undefined) {
      if (failed) this.err += `error: ${failed}\n`;
      this.err += "error: could not build fake ancestor\n";
      return 1;
    }
    const flatOf = (m: Map<string, { mode: number; objectId: string }>) =>
      new Map([...m].map(([k, v]) => [k, { mode: v.mode, objectId: v.objectId }] as const));
    const baseTree = await storeFlatTree(this.trees, flatOf(fake));
    this.say("Using index info to reconstruct a base tree...");
    if (!this.quiet) {
      const ours = await flatTree(this.trees, ourTree);
      for (const path of [...fake.keys()].sort(compareGitPaths)) {
        const e = fake.get(path) as { mode: number; objectId: string };
        const o = ours.get(path);
        if (!o) this.out += `A\t${pathToLatin1(quotePath(path))}\n`;
        else if (o.objectId !== e.objectId || o.mode !== e.mode)
          this.out += `M\t${pathToLatin1(quotePath(path))}\n`;
      }
    }
    // run_apply on the fake ancestor's index
    const apply = new ApplyCommand(this.workingCopy)
      .addPatch(latin1ToBytes(patch), `.git/${DIR}/patch`)
      .setTemporaryIndex(fake)
      .setLegacyMessages(this.legacyMessages);
    for (const a of st.applyOpts) {
      if (a.startsWith("-C")) apply.setContext(Number(a.slice(2)));
      else if (a.startsWith("-p")) apply.setStrip(Number(a.slice(2)));
      else if (a.startsWith("--whitespace=")) apply.setWhitespace(a.slice(13));
      else if (a.startsWith("--directory=")) apply.setDirectory(a.slice(12));
    }
    const applied = await apply.call();
    this.out += pathToLatin1(applied.output);
    this.err += pathToLatin1(applied.errors);
    if (applied.exitCode || !applied.index) {
      this.err +=
        "error: Did you hand edit your patch?\nIt does not apply to blobs recorded in its index.\n";
      return 1;
    }
    const theirTree = await storeFlatTree(this.trees, flatOf(applied.index));
    this.say("Falling back to patching base and 3-way merge...");
    const subject = latin1ToPath(this.firstLine(msg));
    const merge = await mergeStoredTrees(
      { trees: this.trees, blobs: this.blobs },
      storedBase(baseTree, "constructed fake ancestor", () => flatTree(this.trees, baseTree)),
      ourTree,
      theirTree,
      {
        oursLabel: "HEAD",
        theirsLabel: subject,
        baseLabel: "constructed fake ancestor",
        style: conflictStyleOf(this.workingCopy),
        ignoreCase: coreBool(this.workingCopy, "ignorecase", false),
        ...ortConfigOptions(this.workingCopy, this.worktreeAccess),
        directoryRenames: "false",
      },
    );
    const target = await ortResultEntries(this.blobs, merge);
    const treeId = await storeFlatTreeOver(this.trees, ourTree, merge.ours, target);
    const conflicts = [...merge.conflicts.values()];
    const delta = await treeDelta(this.trees, ourTree, treeId);
    const refused = await switchTrees(this.sequencerContext(), delta.from, delta.to, {
      action: "merge",
      operation: "merge",
      conflicts,
      targetTree: treeId,
    });
    if (refused) {
      this.err += `${pathToLatin1(refused.message)}\n`;
      this.err += "error: Failed to merge in the changes.\n";
      return 1;
    }
    if (!this.quiet) for (const m of merge.messages) this.out += `${pathToLatin1(m)}\n`;
    if (conflicts.length || !merge.clean) {
      await this.state().setRef("AUTO_MERGE", treeId);
      this.err += "error: Failed to merge in the changes.\n";
      return 1;
    }
    return 0;
  }

  private async doCommit(st: AmState): Promise<void> {
    const tree = await this.staging.writeTree(this.trees);
    const head = await this.headId();
    if (!head) {
      if (!this.quiet) this.err += "applying to an empty history\n";
    }
    const a = st.author as { name: string; email: string; date: string };
    if (!a.name) this.fatal(`empty ident name (for <${a.email}>) not allowed`);
    if (!withoutCrud(a.name)) this.fatal(`name consists only of disallowed characters: ${a.name}`);
    // fmt_ident: crud trimmed; no date (--ignore-date, a mail without Date:) is now, not
    // GIT_AUTHOR_DATE
    const date = this.ignoreDate ? "" : a.date;
    const parsed = date ? parseGitDate(date) : undefined;
    if (date && !parsed) this.fatal(`invalid date format: ${date}`);
    const now = this.clock();
    let author: PersonIdent = {
      name: withoutCrud(a.name),
      email: withoutCrud(a.email),
      ...(parsed ?? { timestamp: now, tzOffset: localTimezoneOffset(now) }),
    };
    let committer = this.resolveCommitter();
    if (this.committerDateIsAuthorDate)
      committer = { ...committer, timestamp: author.timestamp, tzOffset: author.tzOffset };
    // commit_tree's ensure_utf8: bytes that are not UTF-8 read as Latin-1
    let msg = st.msg as string;
    if (isUtf8Encoding(configValue(this.workingCopy, "i18n.commitEncoding"))) {
      const fixed = [author.name, author.email, msg].map(ensureUtf8);
      const committerFixed = [committer.name, committer.email].map((v) =>
        ensureUtf8(pathToLatin1(v)),
      );
      if ([...fixed, ...committerFixed].some((f) => f.changed)) {
        this.err +=
          "Warning: commit message did not conform to UTF-8.\nYou may want to amend it after fixing the message, or set the config\nvariable i18n.commitEncoding to the encoding your project uses.\n";
      }
      author = { ...author, name: (fixed[0] as Fixed).text, email: (fixed[1] as Fixed).text };
      msg = (fixed[2] as Fixed).text;
      committer = {
        ...committer,
        name: latin1ToPath((committerFixed[0] as Fixed).text),
        email: latin1ToPath((committerFixed[1] as Fixed).text),
      };
    }
    author = { ...author, name: latin1ToPath(author.name), email: latin1ToPath(author.email) };
    const message = latin1ToPath(msg);
    const id = await this.commits.store({
      tree,
      parents: head ? [head] : [],
      author,
      committer,
      message,
    });
    const action = this.reflogAction("am");
    await updateHead(
      this.refsStore,
      id,
      // the subject as the mail had it, before commit_tree's UTF-8 fixup
      this.reflogLine(`${action}: ${latin1ToPath(this.firstLine(st.msg as string))}`, committer),
    );
  }

  private async resolve(st: AmState, allowEmpty: boolean): Promise<AmResult> {
    if (st.msg === undefined) this.fatal(`cannot resume: .git/${DIR}/final-commit does not exist.`);
    if (!st.author) this.fatal(`cannot resume: .git/${DIR}/author-script does not exist.`);
    this.say(`Applying: ${this.firstLine(st.msg)}`);
    if (!(await this.indexHasChanges()).length) {
      if (allowEmpty && (await this.patchIsEmpty())) {
        this.out += "No changes - recorded it as an empty commit.\n";
      } else {
        this.out +=
          "No changes - did you forget to use 'git add'?\nIf there is nothing left to stage, chances are that something else\nalready introduced the same changes; you might want to skip this patch.\n";
        await this.dieUserResolve();
      }
    }
    const { unmerged } = await readIndex(this.staging);
    if (unmerged.length) {
      this.out +=
        "You still have unmerged paths in your index.\nYou should 'git add' each file with resolved conflicts to mark them as such.\nYou might run `git rm` on a file to accept \"deleted by them\" for it.\n";
      await this.dieUserResolve();
    }
    await this.doCommit(st);
    await this.next(st);
    return this.amRun(await this.load(), false);
  }

  private async abort(): Promise<AmResult> {
    const state = this.state();
    const head = await this.headId();
    const safety = (await this.read("abort-safety"))?.trim() ?? "";
    if ((await this.read("dirtyindex")) !== undefined || (head ?? "") !== safety) {
      if ((await this.read("dirtyindex")) === undefined)
        this.err +=
          "warning: You seem to have moved HEAD since the last 'am' failure.\nNot rewinding to ORIG_HEAD\n";
      await state.remove(DIR);
      return this.result(0);
    }
    const orig = await state.ref("ORIG_HEAD");
    // clean_index: the index and worktree reset to HEAD, then moved to ORIG_HEAD (a two-way
    // merge that keeps local changes it does not touch); unpack-trees' error, then the stop
    const cleanFailed = (message: string): never => {
      this.err += `${message.replace(/\nfatal: Could not reset index file to revision '[^\n]*'\.$/, "")}\n`;
      this.fatal("failed to clean index");
    };
    if (head) {
      const refused = await resetMerge(this.sequencerContext(), head, "HEAD", { reset: true });
      if (refused) cleanFailed(refused.message);
    }
    const target = orig ?? head;
    if (target && target !== head) {
      const refused = await resetMerge(this.sequencerContext(), target, "ORIG_HEAD");
      if (refused) cleanFailed(refused.message);
    }
    if (orig) await updateHead(this.refsStore, orig, this.reflogLine("am --abort"));
    await state.remove(DIR);
    return this.result(0);
  }

  private sequencerContext() {
    return {
      workingCopy: this.workingCopy,
      ...(this.worktreeAccess ? { worktree: this.worktreeAccess } : {}),
      staging: this.staging,
      blobs: this.blobs,
      trees: this.trees,
      commits: this.commits,
      refs: this.refsStore,
    };
  }
}

interface AmState {
  cur: number;
  last: number;
  threeway: boolean;
  quiet: boolean;
  signoff: boolean;
  utf8: boolean;
  keep: "t" | "b" | "f";
  messageId: boolean;
  scissors: string;
  applyOpts: string[];
  author?: { name: string; email: string; date: string };
  msg?: string;
}

interface Fixed {
  text: string;
  changed: boolean;
}

/** `is_encoding_utf8` of `i18n.commitEncoding` (unset is UTF-8). */
function isUtf8Encoding(encoding: string | undefined): boolean {
  return encoding === undefined || /^utf-?8$/i.test(encoding);
}

/**
 * commit.c's `ensure_utf8` of a binary string: each byte that starts no valid UTF-8
 * sequence (`has_invalid_utf8`: overlong forms, surrogates and non-characters included)
 * read as Latin-1.
 */
export function ensureUtf8(text: string): Fixed {
  const max = [0x7f, 0x7ff, 0xffff, 0x10ffff];
  let out = "";
  let changed = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c0 = text.charCodeAt(i);
    if (c0 < 0x80) {
      out += text[i++];
      continue;
    }
    let c = c0;
    let bytes = 0;
    while (c & 0x40) {
      c = (c << 1) & 0xff;
      bytes++;
    }
    let valid = bytes >= 1 && bytes <= 3 && n - i - 1 >= bytes;
    if (valid) {
      let cp = (c & 0x7f) >> bytes;
      for (let k = 1; k <= bytes; k++) {
        const b = text.charCodeAt(i + k);
        cp = (cp << 6) | (b & 0x3f);
        if ((b & 0xc0) !== 0x80) valid = false;
      }
      if (
        valid &&
        (cp < (max[bytes - 1] as number) + 1 ||
          cp > (max[bytes] as number) ||
          (cp & 0x1ff800) === 0xd800 ||
          (cp & 0xfffe) === 0xfffe ||
          (cp >= 0xfdd0 && cp <= 0xfdef))
      )
        valid = false;
    }
    if (valid) {
      out += text.slice(i, i + bytes + 1);
      i += bytes + 1;
    } else {
      out += String.fromCharCode(0xc0 + (c0 >> 6), 0x80 + (c0 & 0x3f));
      changed = true;
      i++;
    }
  }
  return { text: out, changed };
}

class AmStop extends Error {
  constructor(readonly status: number) {
    super(`git am stopped (${status})`);
  }
}
