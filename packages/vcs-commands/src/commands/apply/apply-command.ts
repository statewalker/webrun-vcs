/**
 * `git apply`: applies patches (git diffs, unified diffs, binary patches) to the worktree,
 * the index (`--index`) or the index alone (`--cached`), or only reports on them
 * (`--check`, `--stat`, `--numstat`, `--summary`), with git's messages byte for byte.
 */

import { FileMode, isValidWorktreePath } from "@statewalker/vcs-core";
import { mergeLines } from "@statewalker/vcs-utils";
import { bytesToHex, sha1Of } from "@statewalker/vcs-utils/hash";
import {
  compareWithWorktree,
  type IndexEntry,
  modeFromWorktree,
  type Worktree,
  wildmatch,
} from "@statewalker/vcs-working-tree";

import { GitCommand } from "../../git-command.js";
import { coreBool, worktreeModeTrust } from "../core-config.js";
import { configValue, conflictStyleOf } from "../merge-config.js";
import { type IndexEntryInput, rewriteIndex } from "../merge-support.js";
import { strerror } from "../strerror.js";
import {
  ApplyEngine,
  type ApplyIndexEntry,
  type ApplyInput,
  type ApplyIO,
} from "./apply-engine.js";
import type { ApplyVerbosity } from "./apply-parse.js";
import { isGitlink, isLink, S_IFDIR, S_IFGITLINK, type WsErrorAction } from "./apply-types.js";
import {
  bytesToLatin1,
  latin1ToBytes,
  latin1ToPath,
  latin1ToText,
  pathToLatin1,
} from "./latin1.js";
import {
  parseWhitespaceRule,
  WhitespaceRuleError,
  WS_DEFAULT_RULE,
  whitespaceRuleOf,
} from "./whitespace.js";

/** What `git apply` printed and how it ended. */
export interface ApplyResult {
  /** git's exit status: 0 applied, 1 not (or not cleanly), 128 fatal */
  exitCode: number;
  /** Standard output (`--stat`, `--numstat`, `--summary`) */
  output: string;
  /** Standard error: errors, warnings, verbose messages */
  errors: string;
  /** Paths left with conflicts by `--3way` */
  conflicts: string[];
  /** With {@link ApplyCommand.setTemporaryIndex}: that index after the patches */
  index?: Map<string, { mode: number; objectId: string }>;
}

/** One patch to apply. */
interface PatchSource {
  text: string;
  name?: string;
}

/**
 * Applies patches as `git apply` does.
 *
 * @example
 * ```typescript
 * const { exitCode, errors } = await git.apply().addPatch(diffBytes).setIndex(true).call();
 * const { output } = await git.apply().addPatch(diffBytes).setStat(true).call();
 * ```
 */
export class ApplyCommand extends GitCommand<ApplyResult> {
  private patches: PatchSource[] = [];
  private index = false;
  private cached = false;
  private check = false;
  private stat = false;
  private numstat = false;
  private summary = false;
  private forceApply = false;
  private reverse = false;
  private threeWay = false;
  private reject = false;
  private unidiffZero = false;
  private recount = false;
  private inaccurateEof = false;
  private allowEmpty = false;
  private allowOverlap = false;
  private noAdd = false;
  private unsafePaths = false;
  private intentToAdd = false;
  private nul = false;
  private whitespace: string[] = [];
  private ignoreWhitespace?: boolean;
  private context?: number;
  private strip?: number;
  private directory?: string;
  private limits: { pattern: string; include: boolean }[] = [];
  private verbosity: ApplyVerbosity = 0;
  private mergeVariant?: "ours" | "theirs" | "union";
  private legacyMessages = false;
  private temporaryIndex?: Map<string, { mode: number; objectId: string }>;

  /**
   * Adds a patch. `name` is the patch file's name as git shows it in messages (the file
   * argument); without it the patch reads as standard input (`<stdin>`).
   */
  addPatch(patch: Uint8Array | string, name?: string): this {
    this.checkCallable();
    const text =
      typeof patch === "string"
        ? bytesToLatin1(new TextEncoder().encode(patch))
        : bytesToLatin1(patch);
    this.patches.push({ text, ...(name !== undefined ? { name } : {}) });
    return this;
  }

  /** `--index`: apply to the index and the worktree, which must match it. */
  setIndex(value: boolean): this {
    this.index = value;
    return this;
  }

  /** `--cached`: apply to the index only. */
  setCached(value: boolean): this {
    this.cached = value;
    return this;
  }

  /** `--check`: only see whether the patches apply. */
  setCheck(value: boolean): this {
    this.check = value;
    return this;
  }

  /** `--stat`: print a diffstat instead of applying. */
  setStat(value: boolean): this {
    this.stat = value;
    return this;
  }

  /** `--numstat`. */
  setNumstat(value: boolean): this {
    this.numstat = value;
    return this;
  }

  /** `--summary`. */
  setSummary(value: boolean): this {
    this.summary = value;
    return this;
  }

  /** `--apply`: apply even with `--stat`, `--numstat`, `--summary` or `--check`. */
  setApply(value: boolean): this {
    this.forceApply = value;
    return this;
  }

  /** `-R`: apply in reverse. */
  setReverse(value: boolean): this {
    this.reverse = value;
    return this;
  }

  /** `--3way`: fall back to a three-way merge with the blobs the patch names. */
  setThreeWay(value: boolean): this {
    this.threeWay = value;
    return this;
  }

  /** `--ours`, `--theirs`, `--union` with `--3way`. */
  setMergeVariant(variant: "ours" | "theirs" | "union" | undefined): this {
    this.mergeVariant = variant;
    return this;
  }

  /** `--reject`: apply what applies, leave the rest in `<file>.rej`. */
  setReject(value: boolean): this {
    this.reject = value;
    return this;
  }

  /** `--unidiff-zero`. */
  setUnidiffZero(value: boolean): this {
    this.unidiffZero = value;
    return this;
  }

  /** `--recount`. */
  setRecount(value: boolean): this {
    this.recount = value;
    return this;
  }

  /** `--inaccurate-eof`. */
  setInaccurateEof(value: boolean): this {
    this.inaccurateEof = value;
    return this;
  }

  /** `--allow-empty`. */
  setAllowEmpty(value: boolean): this {
    this.allowEmpty = value;
    return this;
  }

  /** `--allow-overlap`. */
  setAllowOverlap(value: boolean): this {
    this.allowOverlap = value;
    return this;
  }

  /** `--no-add`. */
  setNoAdd(value: boolean): this {
    this.noAdd = value;
    return this;
  }

  /** `--unsafe-paths`. */
  setUnsafePaths(value: boolean): this {
    this.unsafePaths = value;
    return this;
  }

  /** `-N` / `--intent-to-add`. */
  setIntentToAdd(value: boolean): this {
    this.intentToAdd = value;
    return this;
  }

  /** `-z`: `--numstat` names unquoted and NUL-terminated. */
  setNul(value: boolean): this {
    this.nul = value;
    return this;
  }

  /**
   * `--whitespace=<action>`: nowarn, warn, fix (strip), error, error-all. As with git's
   * repeated option, the last action wins, but an `error-all` before it still reports
   * every whitespace error.
   */
  setWhitespace(action: string): this {
    this.whitespace.push(action);
    return this;
  }

  /** `--ignore-whitespace` / `--ignore-space-change`. */
  setIgnoreWhitespace(value: boolean): this {
    this.ignoreWhitespace = value;
    return this;
  }

  /** `-C<n>`: at least this many context lines must match. */
  setContext(lines: number): this {
    this.context = lines;
    return this;
  }

  /** `-p<n>`: leading path components to strip (default 1). */
  setStrip(n: number): this {
    this.strip = n;
    return this;
  }

  /** `--directory=<root>`: prepend to every path. */
  setDirectory(root: string): this {
    this.directory = root;
    return this;
  }

  /** `--include=<glob>`. */
  addInclude(pattern: string): this {
    this.limits.push({ pattern, include: true });
    return this;
  }

  /** `--exclude=<glob>`. */
  addExclude(pattern: string): this {
    this.limits.push({ pattern, include: false });
    return this;
  }

  /** `-v` (true) / `-q` (false) / normal (undefined). */
  setVerbose(verbose: boolean | undefined): this {
    this.verbosity = verbose === undefined ? 0 : verbose ? 1 : -1;
    return this;
  }

  /**
   * Messages as git before 2.46 words them ("corrupt patch at line 5" instead of
   * "corrupt patch at <stdin>:5").
   */
  setLegacyMessages(value: boolean): this {
    this.legacyMessages = value;
    return this;
  }

  /**
   * Applies to this index instead of the repository's (`--cached` with git's
   * `index_file`, as `git am --3way` applies to its fake ancestor); the result has it.
   */
  setTemporaryIndex(index: Map<string, { mode: number; objectId: string }>): this {
    this.temporaryIndex = new Map(index);
    this.cached = true;
    return this;
  }

  async call(): Promise<ApplyResult> {
    this.checkCallable();
    this.setCallable(false);
    // git apply --index/--cached reads the index at its start: one another writer replaced
    // is read again (refused while this instance holds unwritten edits)
    if (this.index || this.cached) await this.readCurrentIndex();
    const run = await this.run();
    return {
      exitCode: run.status,
      output: latin1ToText(run.stdout),
      errors: latin1ToText(run.stderr),
      conflicts: run.conflicts.map(latin1ToPath),
      ...(this.temporaryIndex ? { index: this.temporaryIndex } : {}),
    };
  }

  private async run(): Promise<{
    status: number;
    stdout: string;
    stderr: string;
    conflicts: string[];
  }> {
    const fatal = (message: string, prefix = "error") => ({
      status: 128,
      stdout: "",
      stderr: `${prefix}: ${message}\n`,
      conflicts: [],
    });
    const config = (key: string) => configValue(this.workingCopy, key);
    let configRule = WS_DEFAULT_RULE;
    try {
      const core = config("core.whitespace");
      if (core !== undefined) configRule = parseWhitespaceRule(core);
    } catch (error) {
      if (error instanceof WhitespaceRuleError) return fatal(error.message, "fatal");
      throw error;
    }
    const worktree = this.cached ? undefined : this.worktreeAccess;
    const staging = this.staging;
    const trust = worktree
      ? worktreeModeTrust(this.workingCopy, worktree)
      : { executable: true, symlinks: true };
    const filter = worktree?.contentFilter as
      | {
          attributes?: (
            path: string,
            names?: readonly string[],
          ) => Promise<Map<string, true | false | string | undefined>>;
          checkin?: (path: string) => Promise<
            | {
                apply(
                  c: Uint8Array,
                  options?: { keepCrlf?: boolean; renormalize?: boolean },
                ): Promise<Uint8Array>;
              }
            | undefined
          >;
        }
      | undefined;

    let indexEntries: Map<string, IndexEntry> | undefined;
    const loadIndex = async () => {
      if (indexEntries) return indexEntries;
      indexEntries = new Map();
      if (this.temporaryIndex) {
        for (const [path, e] of this.temporaryIndex)
          indexEntries.set(pathToLatin1(path), {
            path,
            mode: e.mode,
            objectId: e.objectId,
            stage: 0,
          } as IndexEntry);
        return indexEntries;
      }
      await staging.read();
      for await (const entry of staging.entries()) {
        if (entry.stage === 0) indexEntries.set(pathToLatin1(entry.path), entry);
      }
      return indexEntries;
    };

    const toPath = latin1ToPath;
    const engine: ApplyEngine = new ApplyEngine(
      this.makeIO(worktree, trust, filter, this.worktreeAccess),
      (name) => {
        const e = indexEntries?.get(name);
        return e
          ? { mode: e.mode, oid: e.objectId, ...(e.intentToAdd ? { intentToAdd: true } : {}) }
          : undefined;
      },
      async (name) => {
        let attr: true | false | string | undefined;
        try {
          attr = (await filter?.attributes?.(toPath(name), ["whitespace"]))?.get("whitespace");
        } catch {
          attr = undefined;
        }
        return whitespaceRuleOf(attr, configRule);
      },
      (pattern, text) => wildmatch(toPath(pattern), toPath(text)),
      () => indexEntries?.keys() ?? [],
    );
    engine.legacyMessages = this.legacyMessages;
    engine.quotePathFully = coreBool(this.workingCopy, "quotePath", true);

    // init_apply_state: apply.whitespace, apply.ignoreWhitespace
    const applyWs = config("apply.whitespace");
    if (applyWs !== undefined) {
      engine.configWhitespace = applyWs;
      const action = parseWhitespaceAction(applyWs);
      if (!action) return fatal(`unrecognized whitespace option '${applyWs}'`);
      engine.wsErrorAction = action.action;
      if (action.all) engine.squelchWhitespaceErrors = 0;
    }
    const applyIgnore = config("apply.ignoreWhitespace");
    if (applyIgnore !== undefined) {
      const v = applyIgnore;
      if (["no", "false", "never", "none"].includes(v)) engine.wsIgnoreChange = false;
      else if (v === "change") engine.wsIgnoreChange = true;
      else return fatal(`unrecognized whitespace ignore option '${v}'`);
    }

    // options
    for (const l of this.limits) {
      engine.limitByName.push({ pattern: pathToLatin1(l.pattern), include: l.include });
      if (l.include) engine.hasInclude = true;
    }
    if (this.strip !== undefined) {
      engine.pValue = this.strip;
      engine.pValueKnown = true;
    }
    engine.diffstat = this.stat;
    engine.numstat = this.numstat;
    engine.summary = this.summary;
    engine.check = this.check;
    engine.checkIndex = this.index;
    engine.itaOnly = this.intentToAdd;
    engine.cached = this.cached;
    engine.unsafePaths = this.unsafePaths;
    engine.threeway = this.threeWay;
    engine.mergeVariant = this.mergeVariant;
    if (this.nul) engine.lineTermination = "\0";
    if (this.context !== undefined) engine.pContext = this.context;
    for (const option of this.whitespace) {
      engine.whitespaceOptionGiven = true;
      const action = parseWhitespaceAction(option);
      // an option parse error: usage status
      if (!action) return { ...fatal(`unrecognized whitespace option '${option}'`), status: 129 };
      engine.wsErrorAction = action.action;
      if (action.all) engine.squelchWhitespaceErrors = 0;
    }
    if (this.ignoreWhitespace !== undefined) engine.wsIgnoreChange = this.ignoreWhitespace;
    engine.applyInReverse = this.reverse;
    engine.unidiffZero = this.unidiffZero;
    engine.applyWithReject = this.reject;
    engine.allowOverlap = this.allowOverlap;
    engine.verbosity = this.verbosity;
    engine.inaccurateEof = this.inaccurateEof;
    engine.recount = this.recount;
    engine.allowEmpty = this.allowEmpty;
    engine.noAdd = this.noAdd;
    if (this.directory !== undefined) {
      const root = normalizeRoot(this.directory);
      if (root === undefined) return fatal(`unable to normalize directory: '${this.directory}'`);
      engine.root = pathToLatin1(root);
    }
    if (this.mergeVariant && !this.threeWay)
      return fatal("--ours, --theirs, and --union require --3way", "fatal");

    // check_apply_state
    if (engine.applyWithReject && engine.threeway)
      return fatal("options '--reject' and '--3way' cannot be used together");
    if (engine.threeway) engine.checkIndex = true;
    if (engine.applyWithReject) {
      engine.apply = true;
      if (engine.verbosity === 0) engine.verbosity = 1;
    }
    if (!this.forceApply && (engine.diffstat || engine.numstat || engine.summary || engine.check))
      engine.apply = false;
    if (engine.cached) engine.checkIndex = true;
    if (engine.itaOnly && engine.checkIndex) engine.itaOnly = false;
    if (engine.checkIndex) engine.unsafePaths = false;

    if (engine.checkIndex || engine.itaOnly) await loadIndex();
    const inputs: ApplyInput[] = (this.patches.length ? this.patches : [{ text: "" }]).map((p) => ({
      text: p.text,
      name: p.name ?? "<stdin>",
      fromFile: p.name !== undefined,
    }));
    const { status, writeIndex } = await engine.applyAll(inputs);
    if (writeIndex && this.temporaryIndex) {
      for (const [name, entries] of engine.indexChanges) {
        const path = toPath(name);
        const e = entries.find((x) => !x.stage);
        if (e) this.temporaryIndex.set(path, { mode: e.mode, objectId: e.oid });
        else this.temporaryIndex.delete(path);
      }
    } else if (writeIndex && engine.indexChanges.size) {
      const changes = new Map<string, IndexEntryInput[]>();
      for (const [name, entries] of engine.indexChanges) {
        const path = toPath(name);
        changes.set(
          path,
          entries.map((e) => ({
            path,
            mode: e.mode,
            objectId: e.oid,
            ...(e.stage ? { stage: e.stage as 1 | 2 | 3 } : {}),
            ...(e.intentToAdd ? { intentToAdd: true } : {}),
            ...(e.stat ?? {}),
          })),
        );
      }
      await rewriteIndex(staging, changes);
    }
    return {
      status,
      stdout: engine.stdout,
      stderr: engine.stderr,
      conflicts: engine.conflictedPaths,
    };
  }

  private makeIO(
    worktree: Worktree | undefined,
    trust: { executable?: boolean; symlinks?: boolean },
    filter:
      | {
          checkin?: (path: string) => Promise<
            | {
                apply(
                  c: Uint8Array,
                  options?: { keepCrlf?: boolean; renormalize?: boolean },
                ): Promise<Uint8Array>;
              }
            | undefined
          >;
        }
      | undefined,
    /** Where rejects go: the worktree, `--cached` or not */
    rejectWorktree: Worktree | undefined,
  ): ApplyIO {
    const blobs = this.blobs;
    const toPath = latin1ToPath;
    const readAll = async (content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const c of content) {
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
    };
    const lstat = async (name: string) => {
      if (!worktree) return undefined;
      const entry = await worktree.getEntry(toPath(name)).catch(() => undefined);
      if (!entry) return undefined;
      return { mode: entry.isDirectory ? S_IFDIR : entry.mode, entry };
    };
    const resolver = () => this.revisionResolver();
    const workingCopy = this.workingCopy;
    return {
      hasSymlinks: trust.symlinks !== false,
      trustExecutableBit: trust.executable !== false,
      lstat: async (name) => {
        const st = await lstat(name);
        return st ? { mode: st.mode } : undefined;
      },
      readWorktree: async (name, mode, keepCrlf) => {
        if (!worktree) return undefined;
        try {
          const path = toPath(name);
          let bytes: Uint8Array = await readAll(worktree.readContent(path));
          if (!isLink(mode)) {
            const conversion = await filter?.checkin?.(path);
            if (conversion)
              bytes = await conversion.apply(
                bytes,
                keepCrlf ? { keepCrlf: true } : { renormalize: true },
              );
          }
          return bytesToLatin1(bytes);
        } catch {
          return undefined;
        }
      },
      missingReason: async (name) => {
        // lstat fails with ENOTDIR where a leading path is a file
        let at = name.indexOf("/");
        while (at > 0) {
          const st = await lstat(name.slice(0, at));
          if (!st) break;
          if ((st.mode & 0o170000) === 0o100000) return "Not a directory";
          at = name.indexOf("/", at + 1);
        }
        return "No such file or directory";
      },
      hasSymlinkLeadingPath: async (name) => {
        let at = name.indexOf("/");
        while (at > 0) {
          const st = await lstat(name.slice(0, at));
          if (!st) return false;
          if (isLink(st.mode)) return true;
          at = name.indexOf("/", at + 1);
        }
        return false;
      },
      // create_ce_mode: a directory stages as a gitlink
      modeFromStat: (_name, entry, stMode) =>
        (stMode & 0o170000) === S_IFDIR
          ? S_IFGITLINK
          : modeFromWorktree(stMode, entry?.mode, {
              executable: trust.executable !== false,
              symlinks: trust.symlinks !== false,
            }),
      matchesIndex: async (name, entry) => {
        if (!worktree) return true;
        const st = await lstat(name);
        if (isGitlink(entry.mode)) return st !== undefined && (st.mode & 0o170000) === S_IFDIR;
        const staged = await this.staging.getEntry(toPath(name));
        if (!staged) return false;
        const cmp = await compareWithWorktree(worktree, staged, {
          trust: { executable: trust.executable !== false, symlinks: trust.symlinks !== false },
        });
        return cmp.kind === undefined;
      },
      checkout: async (name, entry) => {
        if (!worktree) return false;
        // checkout_entry of a submodule that is not populated: its empty directory
        if (isGitlink(entry.mode)) {
          try {
            await worktree.mkdir(toPath(name), { recursive: true });
            return true;
          } catch {
            return false;
          }
        }
        const content = await blobs.load(entry.oid);
        if (!content) return false;
        try {
          await worktree.writeContent(toPath(name), content, {
            mode: entry.mode,
            createParents: true,
          });
          return true;
        } catch {
          return false;
        }
      },
      readBlob: async (oid) => {
        const content = await blobs.load(oid);
        return content ? bytesToLatin1(await readAll(content)) : undefined;
      },
      hasObject: (oid) => blobs.has(oid),
      writeBlob: async (content) => blobs.store([latin1ToBytes(content)]),
      hashBlob: async (content) =>
        bytesToHex(sha1Of(latin1ToBytes(`blob ${content.length}\0`), latin1ToBytes(content))),
      resolveBlob: async (prefix) => {
        if (!/^[0-9a-f]{4,40}$/.test(prefix)) return undefined;
        try {
          const id = await resolver().resolve(prefix);
          return id && (await blobs.has(id)) ? id : undefined;
        } catch {
          return undefined;
        }
      },
      merge: async (name, base, ours, theirs, variant) => {
        const load = async (oid: string) => {
          const c = await blobs.load(oid);
          return c ? readAll(c) : new Uint8Array(0);
        };
        const [b, o, t] = (await Promise.all([
          load(base),
          load(ours),
          load(theirs),
        ])) as Uint8Array<ArrayBuffer>[];
        if ([b, o, t].some((x) => x.subarray(0, 8000).includes(0))) {
          return { content: bytesToLatin1(o), conflicts: 1, binary: true };
        }
        void name;
        const merged = mergeLines(b, o, t, {
          oursLabel: "ours",
          theirsLabel: "theirs",
          baseLabel: "base",
          style: conflictStyleOf(workingCopy),
          algorithm: "myers",
          level: "zealous",
          ...(variant ? { favor: variant } : {}),
        });
        return { content: bytesToLatin1(merged.content), conflicts: merged.conflicts };
      },
      removeWorktree: async (name, mode, rmdirEmpty) => {
        if (!worktree) return undefined;
        const path = toPath(name);
        // remove_or_warn: rmdir a gitlink, unlink anything else; a missing path is fine
        if (isGitlink(mode)) {
          const st = await lstat(name);
          if (st) {
            if ((st.mode & 0o170000) !== S_IFDIR)
              return `unable to rmdir '${name}': Not a directory`;
            if (!(await worktree.removeEmptyDirectory?.(path).catch(() => false)))
              return `unable to rmdir '${name}': Directory not empty`;
          }
        } else {
          try {
            await worktree.remove(path);
          } catch (error) {
            if ((error as { code?: string })?.code !== "ENOENT")
              return `unable to unlink '${name}': ${strerror(error)}`;
          }
        }
        if (rmdirEmpty && worktree.removeEmptyDirectory) {
          let at = path.lastIndexOf("/");
          while (at > 0) {
            const dir = path.slice(0, at);
            if (!(await worktree.removeEmptyDirectory(dir).catch(() => false))) break;
            at = dir.lastIndexOf("/");
          }
        }
        return undefined;
      },
      createWorktree: async (name, mode, content) => {
        if (!worktree) return undefined;
        const path = toPath(name);
        try {
          if (isGitlink(mode)) {
            await worktree.mkdir(path, { recursive: true });
            return undefined;
          }
          const bytes = latin1ToBytes(content);
          if (isLink(mode) && trust.symlinks !== false) {
            await worktree.writeContent(path, bytes, {
              mode: FileMode.SYMLINK,
              createParents: true,
            });
          } else {
            const fileMode = isLink(mode)
              ? FileMode.REGULAR_FILE
              : mode & 0o100
                ? FileMode.EXECUTABLE_FILE
                : FileMode.REGULAR_FILE;
            const st = await lstat(name);
            if (st && (st.mode & 0o170000) === S_IFDIR) {
              if (!(await worktree.removeEmptyDirectory?.(path).catch(() => false)))
                return `unable to write file '${name}' mode ${mode.toString(8)}: Directory not empty`;
            }
            await worktree.writeContent(path, bytes, {
              mode: fileMode,
              createParents: true,
              ...(isLink(mode) ? { raw: true } : {}),
            });
          }
          return undefined;
        } catch (error) {
          return `unable to write file '${name}' mode ${mode.toString(8)}: ${strerror(error)}`;
        }
      },
      writeReject: async (name, content) => {
        if (!rejectWorktree) return;
        await rejectWorktree.writeContent(toPath(name), latin1ToBytes(content), {
          mode: FileMode.REGULAR_FILE,
          raw: true,
        });
      },
      statOf: async (name) => {
        const st = await lstat(name);
        if (!st) return undefined;
        const e = st.entry;
        const out: Record<string, number> = { size: e.size, mtime: e.mtime };
        for (const k of ["ctime", "mtimeNs", "ctimeNs", "dev", "ino", "uid", "gid"] as const) {
          const v = (e as unknown as Record<string, number | undefined>)[k];
          if (v !== undefined) out[k] = v;
        }
        return out;
      },
      verifyPath: (name, mode) => isValidWorktreePath(toPath(name), mode),
    };
  }
}

/** `parse_whitespace_option`. */
export function parseWhitespaceAction(
  option: string | undefined,
): { action: WsErrorAction; all?: boolean } | undefined {
  if (option === undefined || option === "warn") return { action: "warn" };
  if (option === "nowarn") return { action: "nowarn" };
  if (option === "error") return { action: "error" };
  if (option === "error-all") return { action: "error", all: true };
  if (option === "strip" || option === "fix") return { action: "fix" };
  return undefined;
}

/** `strbuf_normalize_path` plus a trailing slash; undefined when it climbs above the top. */
function normalizeRoot(dir: string): string | undefined {
  const out: string[] = [];
  const absolute = dir.startsWith("/");
  for (const part of dir.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!out.length) return undefined;
      out.pop();
    } else out.push(part);
  }
  const joined = (absolute ? "/" : "") + out.join("/");
  return joined === "" ? "" : joined.endsWith("/") ? joined : `${joined}/`;
}

export type { ApplyIndexEntry };
