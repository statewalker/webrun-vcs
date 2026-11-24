/**
 * `git shortlog` (builtin/shortlog.c) as a library command: the commits of a revision range
 * (or of `git log` output, as git reads it on its stdin) grouped by author, committer,
 * trailer values or formatted fields.
 *
 * @example
 * ```typescript
 * // git shortlog -ns HEAD
 * await git.shortlog().addRevision("HEAD").setNumbered(true).setSummary(true).callText();
 * // "     5\tA U Thor\n     1\tSomeone else\n"
 *
 * // git log | git shortlog -e
 * await git.shortlog().setInput(logText).setEmail(true).callText();
 * ```
 */

import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { GitApiError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import type { Mailmap } from "./mailmap.js";
import { configValue } from "./merge-config.js";
import { RevListCommand } from "./rev-list-command.js";
import {
  outputEncoderFor,
  parseShortlogGroup,
  parseShortlogWrap,
  readShortlogInput,
  Shortlog,
  type ShortlogEntry,
  type ShortlogGroup,
  type ShortlogWrap,
  shortlogIdent,
} from "./shortlog.js";
import { trailerConfigOf, trailerLinesOf } from "./trailers.js";

/** The marks the walk's format puts between commits and between their parts. */
const COMMIT_MARK = "\x00\x01";
const PART_MARK = "\x00\x02";

/** A format whose state (`%w(...)` wrapping, `%<(...)` padding, colors) reaches later placeholders. */
const STATEFUL_FORMAT = /%(w\(|<|>|C)/;

/**
 * The shortlog of a repository's history or of `git log` output.
 *
 * Revisions ({@link addRevision}, {@link addArgument}, {@link addPath},
 * {@link configureRevisions}) are walked as `git log` walks them; without any, the input given
 * with {@link setInput} is read (`git log | git shortlog`), else HEAD's history (git's
 * behaviour on a terminal). Each commit counts once per group it falls in (`--group` options,
 * duplicates within one commit counted once), mapped through the repository's mailmap
 * (`.mailmap`, `mailmap.blob`, `mailmap.file`).
 *
 * git's stderr (a `mailmap.blob` that is no blob) is in {@link getErrors}.
 */
export class ShortlogCommand extends GitCommand<ShortlogEntry[]> {
  private summary = false;
  private numbered = false;
  private email = false;
  private wrap?: ShortlogWrap;
  private groups: ShortlogGroup[] = [];
  private format?: string;
  private date?: string;
  private abbrev?: number;
  private input?: string;
  private revisionsNamed = false;
  private readonly revisionSteps: ((r: RevListCommand) => void)[] = [];
  private readonly errors: string[] = [];
  private shortlog?: Shortlog;

  /** `-s` / `--summary`: only each group's count. */
  setSummary(summary: boolean): this {
    this.checkCallable();
    this.summary = summary;
    return this;
  }

  /** `-n` / `--numbered`: groups sorted by their count, largest first. */
  setNumbered(numbered: boolean): this {
    this.checkCallable();
    this.numbered = numbered;
    return this;
  }

  /** `-e` / `--email`: author and committer groups named `Name <email>`. */
  setEmail(email: boolean): this {
    this.checkCallable();
    this.email = email;
    return this;
  }

  /** `-c` / `--committer`: group by committer (as `--group=committer`). */
  setCommitter(committer: boolean): this {
    this.checkCallable();
    if (committer) this.groups.push({ kind: "committer" });
    else this.groups = this.groups.filter((g) => g.kind !== "committer");
    return this;
  }

  /**
   * `--group=<type>`: `author`, `committer`, `trailer:<key>`, `format:<format>` (or a
   * format with a `%`); repeatable. Throws git's `unknown group type` error (exit 129).
   */
  addGroup(group: string): this {
    this.checkCallable();
    this.groups.push(parseShortlogGroup(group));
    return this;
  }

  /** `--no-group`: the groups given so far dropped (author again unless others follow). */
  clearGroups(): this {
    this.checkCallable();
    this.groups = [];
    return this;
  }

  /**
   * `-w[<width>[,<indent1>[,<indent2>]]]`: the argument as git reads it (undefined for a bare
   * `-w`: 76, 6, 9), a {@link ShortlogWrap}, or false for `--no-w`... (no wrapping).
   */
  setWrap(wrap?: string | ShortlogWrap | false): this {
    this.checkCallable();
    if (wrap === false) this.wrap = undefined;
    else if (typeof wrap === "object") this.wrap = { ...wrap };
    else this.wrap = parseShortlogWrap(wrap);
    return this;
  }

  /**
   * `--format=<format>` / `--pretty=<format>`: each commit's line as this user format (`%h`,
   * `format:%h`, `tformat:%h`) instead of its subject; a named format (`oneline`...) keeps
   * the subject, as in git.
   */
  setFormat(format: string): this {
    this.checkCallable();
    if (format.startsWith("format:")) this.format = format.slice(7);
    else if (format.startsWith("tformat:")) this.format = format.slice(8);
    else if (format.includes("%")) this.format = format;
    else this.format = undefined;
    return this;
  }

  /** `--date=<mode>`: the date mode of `%ad`/`%cd` in formats and groups. */
  setDate(mode: string): this {
    this.checkCallable();
    this.date = mode;
    return this;
  }

  /** `--abbrev=<n>`: the length of `%h` and friends. */
  setAbbrev(abbrev: number): this {
    this.checkCallable();
    this.abbrev = abbrev;
    return this;
  }

  /** `git log` output to read when no revision is given (git's stdin). */
  setInput(input: string): this {
    this.checkCallable();
    this.input = input;
    return this;
  }

  /** A revision argument of the walk (see `RevListCommand.addRevision`: `a..b`, `--all`...). */
  addRevision(revision: string): this {
    this.checkCallable();
    this.revisionsNamed = true;
    this.revisionSteps.push((r) => r.addRevision(revision));
    return this;
  }

  /** An argument of `git shortlog <args>`, revisions and paths mixed (`RevListCommand.addArgument`). */
  addArgument(arg: string): this {
    this.checkCallable();
    this.revisionsNamed = true;
    this.revisionSteps.push((r) => r.addArgument(arg));
    return this;
  }

  /** Only commits that change `path`. */
  addPath(path: string): this {
    this.checkCallable();
    this.revisionSteps.push((r) => r.addPath(path));
    return this;
  }

  /** At most this many commits (`-n`). */
  setMaxCount(maxCount: number): this {
    this.checkCallable();
    this.revisionSteps.push((r) => r.setMaxCount(maxCount));
    return this;
  }

  /**
   * Any other walk setting (`--author`, `--first-parent`, `--since`...): `configure` is run
   * on each {@link RevListCommand} this command walks with; `names` says it names revisions
   * (so the input is not read).
   */
  configureRevisions(configure: (revisions: RevListCommand) => void, names = false): this {
    this.checkCallable();
    if (names) this.revisionsNamed = true;
    this.revisionSteps.push(configure);
    return this;
  }

  /** What git printed on stderr (`error:` lines of the mailmap's reading). */
  getErrors(): string[] {
    return [...this.errors];
  }

  /** The groups, in output order. */
  async call(): Promise<ShortlogEntry[]> {
    return (await this.run()).entries();
  }

  /** git shortlog's output. */
  async callText(): Promise<string> {
    return (await this.run()).text();
  }

  /** git shortlog's output as bytes (the log output encoding's bytes kept as they were). */
  async callBytes(): Promise<Uint8Array> {
    return encodeGitPath(await this.callText());
  }

  private async run(): Promise<Shortlog> {
    if (this.shortlog) return this.shortlog;
    this.checkCallable();
    this.setCallable(false);
    const mailmap = await this.readMailmap((line) => this.errors.push(line));
    const log = new Shortlog({
      summary: this.summary,
      numbered: this.numbered,
      ...(this.wrap ? { wrap: this.wrap } : {}),
    });
    const groups: ShortlogGroup[] = this.groups.length ? this.groups : [{ kind: "author" }];
    if (!this.revisionsNamed && this.input !== undefined) {
      readShortlogInput(this.input, log, { groups, mailmap, email: this.email });
    } else {
      await this.walk(log, groups, mailmap);
    }
    this.shortlog = log;
    return log;
  }

  /** get_from_rev: every commit of the walk added (shortlog_add_commit). */
  private async walk(log: Shortlog, groups: ShortlogGroup[], mailmap: Mailmap): Promise<void> {
    // shortlog_finish_setup: the format groups as given, then author's, then committer's
    const formats = groups.flatMap((g) => (g.kind === "format" ? [g.format] : []));
    if (groups.some((g) => g.kind === "author")) formats.push(this.email ? "%aN <%aE>" : "%aN");
    if (groups.some((g) => g.kind === "committer")) formats.push(this.email ? "%cN <%cE>" : "%cN");
    const trailerKeys = groups.flatMap((g) => (g.kind === "trailer" ? [g.key] : []));
    const foldKey = (k: string) => k.replace(/[A-Z]/g, (c) => c.toLowerCase());
    const keys = new Set(trailerKeys.map(foldKey));
    // the parts each commit is formatted into: its line, its message (for trailers), formats
    const parts: string[] = [];
    const onelineAt = this.summary ? -1 : parts.push(this.format ?? "%s") - 1;
    const bodyAt = keys.size > 0 ? parts.push("%B") - 1 : -1;
    const formatAt = formats.map((f) => parts.push(f) - 1);
    // get_log_output_encoding(): what each commit's records are written in (log's user
    // formats give UTF-8); a commit that does not convert keeps its own encoding
    const outputEncoding =
      configValue(this._workingCopy, "i18n.logOutputEncoding") ||
      configValue(this._workingCopy, "i18n.commitEncoding") ||
      "UTF-8";
    const reencode = !/^utf-?8$/i.test(outputEncoding);
    const encodingAt = reencode ? parts.push("%e") - 1 : -1;
    const commitTextAt = reencode ? parts.push("%an <%ae>%n%cn <%ce>%n%B") - 1 : -1;
    const values = await this.formatParts(parts);
    // pretty.c reads the mailmap again (its own copy) at the first mapped placeholder, and
    // prints its errors again
    if (values.length > 0 && parts.some((p) => /%[ac][NEL]/.test(p)))
      this.errors.push(...this.errors);
    const trailerConfig = keys.size > 0 ? trailerConfigOf(this._workingCopy) : undefined;
    const needsDedup =
      new Set(groups.map((g) => g.kind)).size > 1 || formats.length > 1 || keys.size > 0;
    for (const raw of values) {
      let commit = raw;
      if (reencode) {
        // the records as the output encoding's bytes (escaped where they are no UTF-8)
        const encoder = outputEncoderFor(
          outputEncoding,
          raw[commitTextAt] as string,
          (raw[encodingAt] as string) || "UTF-8",
        );
        commit = raw.map((v) => decodeGitPath(encoder(v)));
      }
      const oneline = onelineAt >= 0 ? (commit[onelineAt] as string) : "";
      const shown = oneline !== "" ? oneline : "<none>";
      const dups = new Set<string>();
      if (bodyAt >= 0) {
        // insert_records_from_trailers: the message after the headers' "\n\n"
        const body = `\n\n${commit[bodyAt] as string}`;
        for (const t of trailerLinesOf(body, trailerConfig)) {
          if (!keys.has(foldKey(t.key))) continue;
          const value = shortlogIdent(t.value, mailmap, this.email) ?? t.value;
          if (dups.has(value)) continue;
          dups.add(value);
          log.insert(value, shown);
        }
      }
      for (const at of formatAt) {
        const value = commit[at] as string;
        if (needsDedup) {
          if (dups.has(value)) continue;
          dups.add(value);
        }
        log.insert(value, shown);
      }
    }
  }

  /**
   * Each commit of the walk formatted with each of `parts` (git's format_commit_message),
   * in walk order: one walk for parts that cannot affect each other, another after a part
   * whose state would reach the next.
   */
  private async formatParts(parts: string[]): Promise<string[][]> {
    const walks: number[][] = [[]];
    for (let k = 0; k < parts.length; k++) {
      (walks[walks.length - 1] as number[]).push(k);
      if (STATEFUL_FORMAT.test(parts[k] as string) && k < parts.length - 1) walks.push([]);
    }
    let commits: string[][] | undefined;
    for (const walk of walks) {
      // each part on a line of its own, so column padding (`%<|(N)`) counts from where the
      // part starts, as in git's format of that part alone
      const format = `%x00%x01%H${walk.map((k) => `%x00%x02%n${parts[k]}`).join("")}`;
      const revisions = new RevListCommand(this._workingCopy);
      for (const step of this.revisionSteps) step(revisions);
      const text = await revisions.callLogText({
        pretty: `tformat:${format}`,
        ...(this.date !== undefined ? { date: this.date } : {}),
        ...(this.abbrev !== undefined ? { abbrev: this.abbrev } : {}),
      });
      const chunks = text.split(COMMIT_MARK).slice(1);
      if (commits && commits.length !== chunks.length)
        throw new GitApiError("fatal: revision walk setup failed");
      commits ??= chunks.map(() => new Array<string>(parts.length).fill(""));
      const rows = commits;
      chunks.forEach((chunk, n) => {
        const row = rows[n] as string[];
        // the terminator tformat adds after each commit
        const whole = chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk;
        const values = whole.split(PART_MARK).slice(1);
        walk.forEach((k, i) => {
          const value = values[i] ?? "";
          // the part's own line break (a `%-` at its start may have eaten it)
          row[k] = value.startsWith("\n") ? value.slice(1) : value;
        });
      });
    }
    return commits ?? [];
  }
}
