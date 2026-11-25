/**
 * `git checkout-index` (builtin/checkout-index.c over entry.c's `checkout_entry`): index
 * entries written into the worktree, under a prefix, or into temporary files.
 *
 * @example
 * ```typescript
 * // git checkout-index -f -u -a
 * await git.checkoutIndex().setAll(true).setForce(true).setUpdateIndex(true).call();
 *
 * // git checkout-index --prefix=export/ -a
 * await git.checkoutIndex().setAll(true).setPrefix("export/").call();
 *
 * // git checkout-index --stage=all --temp -- path1
 * const { output } = await git.checkoutIndex().setStage("all").addPath("path1").call();
 * // ".merge_file_a1b2c3 .merge_file_d4e5f6 .merge_file_g7h8i9\tpath1\n"
 * ```
 */

import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import {
  basicStatMatches,
  collectChunks,
  entryStatOf,
  modeFromWorktree,
  type StagingEntry,
  type Worktree,
  type WorktreeEntry,
  wholeSeconds,
} from "@statewalker/vcs-working-tree";
import { CheckoutIndexFailedError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { quotePath } from "../results/quote-path.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import { configBool } from "./merge-config.js";
import { inputPaths } from "./plumbing-input.js";
import { SPARSE_INDEX_EXPANDED_HINT, sparseIndexAsRead } from "./sparse-index-view.js";

/** Result of {@link CheckoutIndexCommand}. */
export interface CheckoutIndexResult {
  /** git's stdout: `--temp`'s `<temporary file>\t<path>` records */
  output: string;
  /** git's stderr: the entries it could not check out (`... already exists, no checkout`) */
  errors: string;
  /** git's exit status: 1 when an entry could not be checked out */
  exitCode: 0 | 1;
  /** The temporary files written (`--temp`), by path then stage */
  tempFiles: Array<{ path: string; stage: number; file: string }>;
}

/** A death (`die()`) in the middle of the run: git's message without `fatal: `. */
class CheckoutIndexDeath extends Error {}

/** `--stage=all` (git's CHECKOUT_ALL). */
const ALL = 4;
const TEMP_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Writes index entries out as `git checkout-index` does.
 *
 * Named paths ({@link addPath}, then {@link setStdin}'s) are checked out first, then with
 * {@link setAll} every entry (skip-worktree ones only with
 * {@link setIgnoreSkipWorktreeBits}). A file already there and changed against its entry is
 * left alone with `<path> already exists, no checkout` unless {@link setForce}; one that
 * matches its entry's stat is skipped silently. {@link setStage} picks a conflict stage, or
 * all three (`all`, which implies {@link setTemp}): each is written to a temporary file named
 * as git's `mkstemp` names it (`.merge_file_XXXXXX`, `.merge_link_XXXXXX`) and reported on
 * stdout. {@link setUpdateIndex} records the new files' stat data in the index (not with a
 * prefix or temporary files). git's deaths are thrown as {@link CheckoutIndexFailedError};
 * entries that could not be written give exit status 1, the index then left unwritten.
 */
export class CheckoutIndexCommand extends GitCommand<CheckoutIndexResult> {
  private all = false;
  private force = false;
  private quiet = false;
  private noCreate = false;
  private updateIndex = false;
  private ignoreSkipWorktree = false;
  private temp: boolean | undefined;
  private prefix = "";
  private stage = 0;
  private readonly paths: string[] = [];
  private stdin?: string | Uint8Array;
  private nul = false;
  private compatibility: "2.43" | "2.56" = "2.56";

  /** `-a`: every entry of the index. */
  setAll(all = true): this {
    this.checkCallable();
    this.all = all;
    return this;
  }

  /** `-f`: files already there are overwritten. */
  setForce(force = true): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /** `-q`: no message for files already there or paths not in the index. */
  setQuiet(quiet = true): this {
    this.checkCallable();
    this.quiet = quiet;
    return this;
  }

  /** `-n`: only files already there are checked out again. */
  setNoCreate(noCreate = true): this {
    this.checkCallable();
    this.noCreate = noCreate;
    return this;
  }

  /** `-u`: the stat data of the files written recorded in the index. */
  setUpdateIndex(update = true): this {
    this.checkCallable();
    this.updateIndex = update;
    return this;
  }

  /** `--ignore-skip-worktree-bits`: skip-worktree entries checked out too. */
  setIgnoreSkipWorktreeBits(ignore = true): this {
    this.checkCallable();
    this.ignoreSkipWorktree = ignore;
    return this;
  }

  /** `--[no-]temp`: entries written to temporary files (default with `--stage=all`). */
  setTemp(temp: boolean): this {
    this.checkCallable();
    this.temp = temp;
    return this;
  }

  /** `--prefix=<string>`: each file written at `<string><path>`. */
  setPrefix(prefix: string): this {
    this.checkCallable();
    this.prefix = prefix;
    return this;
  }

  /** `--stage=(1|2|3|all)`: a conflict stage, or every stage, instead of stage 0. */
  setStage(stage: 1 | 2 | 3 | "all"): this {
    this.checkCallable();
    this.stage = stage === "all" ? ALL : stage;
    return this;
  }

  /** A path to check out (git's `<file>` argument), relative to the worktree top. */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /** `--stdin`: paths read from `input`, one per line (C-quoted ones unquoted). */
  setStdin(input: string | Uint8Array): this {
    this.checkCallable();
    this.stdin = input;
    return this;
  }

  /** `-z`: {@link setStdin}'s paths are NUL-separated. */
  setNulTerminated(nul = true): this {
    this.checkCallable();
    this.nul = nul;
    return this;
  }

  /**
   * The git version followed (default 2.56): 2.43 gives no `advice.sparseIndexExpanded`
   * hint when a path inside a sparse directory expands a sparse index.
   */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  async call(): Promise<CheckoutIndexResult> {
    this.checkCallable();
    this.setCallable(false);
    const fatal = (message: string): never => {
      throw new CheckoutIndexFailedError(`fatal: ${message}`);
    };
    const toTemp = this.temp ?? this.stage === ALL;
    if (!toTemp && this.stage === ALL) {
      fatal("options '--stage=all' and '--no-temp' cannot be used together");
    }
    const worktree = this.worktreeAccess;
    if (!worktree) fatal("this operation must be run in a work tree");
    await this.readCurrentIndex();
    const refresh = this.updateIndex && this.prefix === "" && !toTemp;
    const read = await sparseIndexAsRead(this.staging, worktree, (key, fallback) =>
      configBool(this.workingCopy, key, fallback),
    );
    const expansionHint =
      this.compatibility !== "2.43" &&
      configBool(this.workingCopy, "advice.sparseIndexExpanded", true)
        ? SPARSE_INDEX_EXPANDED_HINT
        : [];
    const run = new CheckoutIndexRun({
      worktree: worktree as Worktree,
      blobs: this.blobs,
      entries: await this.entryList(),
      sparseDirectories: read.sparseDirs ?? [],
      expansionHint: read.expanded ? [] : expansionHint,
      indexTime: this.staging.getUpdateTime(),
      force: this.force,
      quiet: this.quiet,
      noCreate: this.noCreate,
      ignoreSkipWorktree: this.ignoreSkipWorktree,
      toTemp,
      prefix: this.prefix,
      stage: this.stage,
      refresh,
      symlinks: worktreeModeTrust(this.workingCopy, worktree as Worktree).symlinks,
      quotePath: coreBool(this.workingCopy, "quotePath", true),
    });
    if (this.all && this.paths.length > 0) {
      fatal("git checkout-index: don't mix '--all' and explicit filenames");
    }
    if (this.stdin !== undefined && this.paths.length > 0) {
      fatal("git checkout-index: don't mix '--stdin' and explicit filenames");
    }
    let err = false;
    try {
      err = await this.inOneOperation(() => this.checkoutAll(run));
    } catch (error) {
      if (!(error instanceof CheckoutIndexDeath)) throw error;
      const stderr = [...run.stderr, `fatal: ${error.message}`].join("\n");
      throw new CheckoutIndexFailedError(stderr, run.stdout.join(""));
    }
    const result: CheckoutIndexResult = {
      output: run.stdout.join(""),
      errors: run.stderr.map((l) => `${l}\n`).join(""),
      exitCode: err ? 1 : 0,
      tempFiles: run.tempFiles,
    };
    if (err || !refresh) return result;
    // the index written under its lock, whether or not a stat changed
    if (run.updated.size > 0) {
      const editor = this.staging.createEditor();
      for (const [path, stat] of run.updated) {
        editor.add({
          path,
          apply: (existing: StagingEntry | undefined) =>
            existing && existing.stage === 0 ? { ...existing, ...stat } : existing,
        });
      }
      await editor.finish();
    }
    await this.staging.write();
    return result;
  }

  /** The named paths, then `--stdin`'s, then `-a`'s entries; true when one failed. */
  private async checkoutAll(run: CheckoutIndexRun): Promise<boolean> {
    let err = false;
    for (const path of this.paths) err = (await run.checkoutFile(path)) || err;
    if (this.stdin !== undefined) {
      if (this.all) {
        throw new CheckoutIndexDeath("git checkout-index: don't mix '--all' and '--stdin'");
      }
      const badlyQuoted = (): never => {
        throw new CheckoutIndexDeath("line is badly quoted");
      };
      for (const path of inputPaths(this.stdin, this.nul, badlyQuoted)) {
        err = (await run.checkoutFile(path)) || err;
      }
    }
    if (this.all) err = (await run.checkoutAll()) || err;
    return err;
  }

  private async entryList(): Promise<StagingEntry[]> {
    const list = this.staging.entryList?.();
    if (list) return [...list];
    const out: StagingEntry[] = [];
    for await (const e of this.staging.entries()) out.push(e);
    return out;
  }
}

interface RunOptions {
  worktree: Worktree;
  blobs: CheckoutIndexCommand["blobs"];
  entries: StagingEntry[];
  sparseDirectories: readonly string[];
  /** git 2.5x's hint when the sparse index is expanded (empty: none) */
  expansionHint: readonly string[];
  indexTime: number;
  force: boolean;
  quiet: boolean;
  noCreate: boolean;
  ignoreSkipWorktree: boolean;
  toTemp: boolean;
  prefix: string;
  stage: number;
  refresh: boolean;
  symlinks: boolean;
  quotePath: boolean;
}

/** One run of `checkout-index` (its globals and `struct checkout state`). */
class CheckoutIndexRun {
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];
  readonly tempFiles: CheckoutIndexResult["tempFiles"] = [];
  /** The stat data of the entries written (`-u`) */
  readonly updated = new Map<string, ReturnType<typeof entryStatOf>>();
  /** git's `topath[1..3]` (`topath[0]` for stage 0) */
  private topath: Array<string | undefined> = [];
  /** Whether the sparse index was expanded (`ensure_full_index`, once) */
  private expanded = false;

  constructor(private readonly o: RunOptions) {}

  /** `checkout_file`: true when it failed (git's -1). */
  async checkoutFile(name: string): Promise<boolean> {
    const o = this.o;
    let hasSameName = false;
    let isFile = false;
    let isSkipped = true;
    let didCheckout = false;
    let errs = 0;
    const sparseDir = !this.expanded && o.sparseDirectories.includes(name);
    // index_name_pos of a path inside a sparse directory expands the index
    if (!this.expanded && o.sparseDirectories.some((dir) => name.startsWith(dir))) {
      this.expand();
    }
    for (const ce of o.entries) {
      if (ce.path !== name) continue;
      hasSameName = true;
      isFile = true;
      if (!o.ignoreSkipWorktree && ce.skipWorktree) break;
      isSkipped = false;
      if (ce.stage !== o.stage && (o.stage !== ALL || ce.stage === 0)) continue;
      didCheckout = true;
      if (!(await this.checkoutEntry(ce))) errs++;
    }
    if (sparseDir && !hasSameName) {
      hasSameName = true;
      isFile = false;
    }
    if (didCheckout) {
      if (o.toTemp) this.writeTempfileRecord(name);
      return errs > 0;
    }
    if (hasSameName && o.stage === ALL) return false;
    if (!o.quiet) {
      let why: string;
      if (!hasSameName) why = "is not in the cache";
      else if (!isFile) why = "is a sparse directory";
      else if (isSkipped) {
        why = "has skip-worktree enabled; use '--ignore-skip-worktree-bits' to checkout";
      } else if (o.stage) why = `does not exist at stage ${o.stage}`;
      else why = "is unmerged";
      this.stderr.push(`git checkout-index: ${name} ${why}`);
    }
    return true;
  }

  /** `ensure_full_index`: 2.5x's hint the first time. */
  private expand(): void {
    if (this.expanded) return;
    this.expanded = true;
    this.stderr.push(...this.o.expansionHint);
  }

  /** `checkout_all`: true when an entry failed. */
  async checkoutAll(): Promise<boolean> {
    const o = this.o;
    // skip-worktree entries checked out: a sparse directory expands the index
    if (o.ignoreSkipWorktree && o.sparseDirectories.length > 0) this.expand();
    let errs = 0;
    let last: StagingEntry | undefined;
    for (const ce of o.entries) {
      if (!o.ignoreSkipWorktree && ce.skipWorktree) continue;
      if (ce.stage !== o.stage && (o.stage !== ALL || ce.stage === 0)) continue;
      if (last && o.toTemp && last.path !== ce.path) this.writeTempfileRecord(last.path);
      if (!(await this.checkoutEntry(ce))) errs++;
      last = ce;
    }
    if (last && o.toTemp) this.writeTempfileRecord(last.path);
    return errs > 0;
  }

  /** `write_tempfile_record`. */
  private writeTempfileRecord(name: string): void {
    const o = this.o;
    let line = "";
    let have = false;
    if (o.stage === ALL) {
      have = [1, 2, 3].some((i) => this.topath[i] !== undefined);
      if (have) line = [1, 2, 3].map((i) => this.topath[i] ?? ".").join(" ");
    } else if (this.topath[o.stage] !== undefined) {
      have = true;
      line = this.topath[o.stage] as string;
    }
    if (have) this.stdout.push(`${line}\t${quotePath(name, o.quotePath)}\n`);
    this.topath = [];
  }

  /** `checkout_entry`: false where git's returns -1 (its message printed). */
  private async checkoutEntry(ce: StagingEntry): Promise<boolean> {
    const o = this.o;
    const worktree = o.worktree;
    if (o.toTemp) return this.writeEntry(ce, undefined);
    const path = o.prefix + ce.path;
    const current = await this.lstatBelow(path);
    if (current) {
      if (!(await this.changed(ce, path, current))) return true;
      if (!o.force) {
        if (!o.quiet) this.stderr.push(`${path} already exists, no checkout`);
        return false;
      }
      if (current.isDirectory) {
        // a gitlink's directory stays
        if (ce.mode === FileMode.GITLINK) return true;
        await worktree.remove(path, { recursive: true });
      } else if (!(await worktree.remove(path).catch(() => false))) {
        this.stderr.push(`error: unable to unlink old '${path}'`);
        return false;
      }
    } else if (o.noCreate) {
      return true;
    }
    return this.writeEntry(ce, path);
  }

  /**
   * `check_path`: the entry at `path` when every leading directory is a real directory
   * (a link or a file on the way makes it absent).
   */
  private async lstatBelow(path: string): Promise<WorktreeEntry | undefined> {
    const worktree = this.o.worktree;
    for (let at = path.indexOf("/"); at > 0; at = path.indexOf("/", at + 1)) {
      const dir = await worktree.getEntry(path.slice(0, at)).catch(() => undefined);
      if (!dir?.isDirectory) return undefined;
    }
    return worktree.getEntry(path).catch(() => undefined);
  }

  /** `ie_match_stat(ce, st, CE_MATCH_IGNORE_VALID | CE_MATCH_IGNORE_SKIP_WORKTREE)` != 0. */
  private async changed(ce: StagingEntry, path: string, current: WorktreeEntry): Promise<boolean> {
    const worktree = this.o.worktree;
    if (ce.mode === FileMode.GITLINK) {
      if (!current.isDirectory) return true;
      const head = await worktree.readGitlinkHead?.(path).catch(() => undefined);
      return head !== undefined && head !== ce.objectId;
    }
    if (current.isDirectory || ce.intentToAdd) return true;
    const trust = { executable: true, symlinks: this.o.symlinks };
    if (modeFromWorktree(current.mode, ce.mode, trust) !== ce.mode) return true;
    if (!basicStatMatches(ce, current)) return true;
    const racy =
      this.o.indexTime === 0 ||
      wholeSeconds(ce.mtime, ce.mtimeNs) >= wholeSeconds(this.o.indexTime);
    if (!racy) return false;
    return (await worktree.computeHash(path).catch(() => undefined)) !== ce.objectId;
  }

  /** `write_entry` to `path`, or to a temporary file when `path` is undefined. */
  private async writeEntry(ce: StagingEntry, path: string | undefined): Promise<boolean> {
    const o = this.o;
    const worktree = o.worktree;
    if (ce.mode === FileMode.GITLINK) {
      if (path === undefined) {
        this.stderr.push(`error: cannot create temporary submodule ${ce.path}`);
        return false;
      }
      try {
        await worktree.mkdir(path, { recursive: true });
      } catch {
        this.stderr.push(`error: cannot create submodule directory ${path}`);
        return false;
      }
      return true;
    }
    const link = ce.mode === FileMode.SYMLINK;
    const blob = await this.readBlob(ce.objectId);
    if (!blob) {
      // a file without conversion is streamed: its temporary file was named (and removed)
      // before the read failed, and git reports the name all the same
      if (path === undefined && !link && !(await worktree.contentFilter?.checkout(ce.path))) {
        this.topath[ce.stage] = await this.tempName(false);
      }
      this.stderr.push(`error: unable to read sha1 file of ${ce.path} (${ce.objectId})`);
      return false;
    }
    let content = blob;
    let mode: number = ce.mode;
    if (link && (path === undefined || !o.symlinks)) {
      // a link written as a file holding its target, never converted
      mode = FileMode.REGULAR_FILE;
    } else if (!link) {
      // smudged with the entry's own attributes, wherever it is written
      const conversion = await worktree.contentFilter?.checkout(ce.path);
      if (conversion) content = await conversion.apply(blob);
    }
    if (path !== undefined) await this.createDirectories(path);
    const target = path ?? (await this.tempName(link));
    await worktree.writeContent(target, content, { mode, raw: true, createParents: true });
    if (path === undefined) {
      this.topath[ce.stage] = target;
      this.tempFiles.push({ path: ce.path, stage: ce.stage, file: target });
      return true;
    }
    if (o.refresh) {
      const written = await worktree.getEntry(path);
      if (written) this.updated.set(ce.path, entryStatOf(written));
    }
    return true;
  }

  /**
   * `create_directories`: each leading directory of `path` made, a file standing where one
   * goes unlinked with `-f`, else git dies (the prefix's own directories are not checked).
   */
  private async createDirectories(path: string): Promise<void> {
    const worktree = this.o.worktree;
    for (let at = path.indexOf("/"); at > 0; at = path.indexOf("/", at + 1)) {
      if (at < this.o.prefix.length) continue;
      const dir = path.slice(0, at);
      const entry = await worktree.getEntry(dir).catch(() => undefined);
      if (!entry) {
        await worktree.mkdir(dir, { recursive: true });
        continue;
      }
      if (entry.isDirectory) continue;
      if (!this.o.force)
        throw new CheckoutIndexDeath(`cannot create directory at '${dir}': File exists`);
      await worktree.remove(dir);
      await worktree.mkdir(dir);
    }
  }

  private async readBlob(id: ObjectId): Promise<Uint8Array | undefined> {
    try {
      const content = await this.o.blobs.load(id);
      return content ? await collectChunks(content) : undefined;
    } catch {
      return undefined;
    }
  }

  /** A name `mkstemp` would give, in the worktree top. */
  private async tempName(link: boolean): Promise<string> {
    const base = link ? ".merge_link_" : ".merge_file_";
    for (;;) {
      const random = new Uint8Array(6);
      crypto.getRandomValues(random);
      let name = base;
      for (const b of random) name += TEMP_CHARS[b % TEMP_CHARS.length];
      if (!(await this.o.worktree.exists(name))) return name;
    }
  }
}
