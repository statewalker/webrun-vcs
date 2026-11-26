/**
 * `git update-index` (builtin/update-index.c): index entries added, replaced, removed or
 * re-flagged one argument at a time, as git processes its command line in order.
 *
 * @example
 * ```typescript
 * // git update-index --add a --chmod=+x b
 * await git.updateIndex().setAdd(true).addPath("a").setChmod("+x").addPath("b").call();
 *
 * // git update-index --cacheinfo 100644,<id>,c --assume-unchanged a
 * await git.updateIndex().addCacheInfo(0o100644, id, "c").setAssumeUnchanged(true).addPath("a").call();
 *
 * // git update-index --refresh
 * const { output, exitCode } = await git.updateIndex().refresh().call();
 *
 * // git update-index --fsmonitor, then --fsmonitor-valid a
 * await git.updateIndex().setFsmonitor(true).call();
 * await git.updateIndex().setFsmonitorValid(true).addPath("a").call();
 * ```
 */

import {
  FileMode,
  type FileModeValue,
  isValidWorktreePath,
  type ObjectId,
} from "@statewalker/vcs-core";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import {
  basicStatMatches,
  compareWithWorktree,
  entryStatOf,
  FsmonitorState,
  invalidateCacheTreePath,
  modeFromWorktree,
  type ResolveUndoRecord,
  type StagingEntry,
  storeWorktreeFile,
  type Worktree,
  type WorktreeEntry,
  type WorktreeModeTrust,
  wholeSeconds,
} from "@statewalker/vcs-working-tree";
import { UpdateIndexFailedError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { worktreeModeTrust } from "./core-config.js";
import { fsmonitorModeOf } from "./fsmonitor-refresh.js";
import { hookHostOf } from "./git-hooks.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { configBool } from "./merge-config.js";
import { inputLines, inputPaths, unquoteLine } from "./plumbing-input.js";
import { worktreePathRules } from "./worktree-path-rules.js";

/** Result of {@link UpdateIndexCommand}. */
export interface UpdateIndexResult {
  /** What git prints on stdout: `--verbose`'s report, the refresh's `<path>: needs update` */
  output: string;
  /** What git prints on stderr without dying (`Ignoring path <path>`, `error:` lines) */
  errors: string;
  /** git's exit status: 1 when a refresh found entries to update or merge, else 0 */
  exitCode: 0 | 1;
}

/** One index entry as the command edits it (a stage-0 entry or a conflict stage). */
type Entry = StagingEntry;

type Step =
  | { kind: "set"; apply: (state: State) => void }
  | { kind: "path"; path: string }
  | { kind: "cacheinfo"; mode: number; id: string; path: string }
  | { kind: "refresh"; really: boolean };

/** The flags git keeps in its globals as it parses the command line. */
interface State {
  add: boolean;
  remove: boolean;
  replace: boolean;
  forceRemove: boolean;
  infoOnly: boolean;
  verbose: boolean;
  /** `--[no-]assume-unchanged`: true marks, false unmarks, undefined neither */
  markValid?: boolean;
  /** `--[no-]skip-worktree` */
  markSkipWorktree?: boolean;
  /** `--[no-]fsmonitor-valid` */
  markFsmonitor?: boolean;
  ignoreSkipWorktreeEntries: boolean;
  chmod?: "+x" | "-x";
  quiet: boolean;
  unmerged: boolean;
  ignoreMissing: boolean;
  ignoreSubmodules: boolean;
}

/** A death (`die()`): git's message, without the `fatal: ` prefix. */
class Death extends Error {}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

/** git's index order: the names' bytes, then the stage. */
function compareNames(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    if (x < 0xd800 && y < 0xd800) return x - y;
    const ea = encodeGitPath(a);
    const eb = encodeGitPath(b);
    const m = Math.min(ea.length, eb.length);
    for (let j = 0; j < m; j++) {
      if (ea[j] !== eb[j]) return (ea[j] as number) - (eb[j] as number);
    }
    return ea.length - eb.length;
  }
  return a.length - b.length;
}

/**
 * Edits the index as `git update-index` does (builtin/update-index.c).
 *
 * Options and paths apply in the order they are given, as git parses its command line: a
 * setter changes how the paths after it are handled ({@link setAdd} before {@link addPath}),
 * {@link refresh} and {@link addCacheInfo} act where they stand, and {@link setIndexInfo} or
 * {@link setStdin} input is read after everything else. Each path is `update_one`:
 *
 * - with {@link setAssumeUnchanged} or {@link setSkipWorktree}, its stage-0 entry is flagged
 *   or unflagged (`Unable to mark file <path>` when it has none);
 * - with {@link setForceRemove}, every stage of it is removed;
 * - otherwise the file is hashed into the index (`--add` needed for a new path), a missing
 *   file removed only with {@link setRemove}, a directory taken as a submodule's commit.
 *
 * git's deaths are thrown as {@link UpdateIndexFailedError} (exit status 128) before the
 * index is written, carrying what was printed until then. A refresh that finds entries to
 * update or merge prints them and ends with exit status 1, the index written all the same.
 */
export class UpdateIndexCommand extends GitCommand<UpdateIndexResult> {
  private readonly steps: Step[] = [];
  private indexInfo?: { text: Uint8Array | string };
  private stdinPaths?: Uint8Array | string;
  private nulTerminated = false;
  private indexVersion?: number;
  private showIndexVersion = false;
  private forceWrite = false;
  private fsmonitor?: boolean;

  private set(apply: (state: State) => void): this {
    this.checkCallable();
    this.steps.push({ kind: "set", apply });
    return this;
  }

  /** `--add`: paths not in the index yet are added (from here on). */
  setAdd(add = true): this {
    return this.set((s) => {
      s.add = add;
    });
  }

  /** `--remove`: paths missing from the worktree are removed from the index. */
  setRemove(remove = true): this {
    return this.set((s) => {
      s.remove = remove;
    });
  }

  /** `--replace`: a file may replace a directory of its name in the index, and the reverse. */
  setReplace(replace = true): this {
    return this.set((s) => {
      s.replace = replace;
    });
  }

  /** `--force-remove`: paths are removed from the index whether or not their file exists. */
  setForceRemove(forceRemove = true): this {
    return this.set((s) => {
      s.forceRemove = forceRemove;
    });
  }

  /** `--info-only`: files are hashed into the index without storing their blobs. */
  setInfoOnly(infoOnly = true): this {
    return this.set((s) => {
      s.infoOnly = infoOnly;
    });
  }

  /** `--verbose`: `add '<path>'`, `remove '<path>'`, `chmod +x '<path>'` reported. */
  setVerbose(verbose = true): this {
    return this.set((s) => {
      s.verbose = verbose;
    });
  }

  /** `--chmod=(+|-)x`: the executable bit of the paths after it set or cleared in the index. */
  setChmod(flip: "+x" | "-x"): this {
    return this.set((s) => {
      s.chmod = flip;
    });
  }

  /** `--assume-unchanged` (true) / `--no-assume-unchanged` (false) for the paths after it. */
  setAssumeUnchanged(mark: boolean): this {
    return this.set((s) => {
      s.markValid = mark;
    });
  }

  /** `--skip-worktree` (true) / `--no-skip-worktree` (false) for the paths after it. */
  setSkipWorktree(mark: boolean): this {
    return this.set((s) => {
      s.markSkipWorktree = mark;
    });
  }

  /**
   * `--fsmonitor-valid` (true) / `--no-fsmonitor-valid` (false) for the paths after it: the
   * entry's fsmonitor valid bit (`CE_FSMONITOR_VALID`) set or cleared.
   */
  setFsmonitorValid(mark: boolean): this {
    return this.set((s) => {
      s.markFsmonitor = mark;
    });
  }

  /**
   * `--fsmonitor` (true) / `--no-fsmonitor` (false), applied after the paths, as git does:
   * the index's `FSMN` extension added (`add_fsmonitor`; a warning when `core.fsmonitor` is
   * unset; git's death in a bare repository with `core.fsmonitor` set) or removed (a warning
   * when `core.fsmonitor` is set).
   */
  setFsmonitor(enable: boolean): this {
    this.checkCallable();
    this.fsmonitor = enable;
    return this;
  }

  /** `--ignore-skip-worktree-entries`: `--remove` leaves skip-worktree entries alone. */
  setIgnoreSkipWorktreeEntries(ignore = true): this {
    return this.set((s) => {
      s.ignoreSkipWorktreeEntries = ignore;
    });
  }

  /** `-q`: a refresh after it prints nothing about entries needing an update. */
  setQuiet(quiet = true): this {
    return this.set((s) => {
      s.quiet = quiet;
    });
  }

  /** `--unmerged`: a refresh after it passes over unmerged entries quietly. */
  setUnmerged(unmerged = true): this {
    return this.set((s) => {
      s.unmerged = unmerged;
    });
  }

  /** `--ignore-missing`: a refresh after it passes over missing files. */
  setIgnoreMissing(ignore = true): this {
    return this.set((s) => {
      s.ignoreMissing = ignore;
    });
  }

  /** `--ignore-submodules`: a refresh after it passes over submodules. */
  setIgnoreSubmodules(ignore = true): this {
    return this.set((s) => {
      s.ignoreSubmodules = ignore;
    });
  }

  /** A path to update (git's `<file>` argument), relative to the worktree top. */
  addPath(path: string): this {
    this.checkCallable();
    this.steps.push({ kind: "path", path });
    return this;
  }

  /** `--cacheinfo <mode>,<object>,<path>`: an entry put in the index as given. */
  addCacheInfo(mode: number, objectId: string, path: string): this {
    this.checkCallable();
    this.steps.push({ kind: "cacheinfo", mode, id: objectId, path });
    return this;
  }

  /** `--refresh`: the stat data of unchanged files refreshed, the changed ones reported. */
  refresh(): this {
    this.checkCallable();
    this.steps.push({ kind: "refresh", really: false });
    return this;
  }

  /** `--really-refresh`: as {@link refresh}, assume-unchanged entries checked too. */
  reallyRefresh(): this {
    this.checkCallable();
    this.steps.push({ kind: "refresh", really: true });
    return this;
  }

  /**
   * `--index-info`: entries read from `input` (`<mode> <id>\t<path>`, `<mode> <type>
   * <id>\t<path>` or `<mode> <id> <stage>\t<path>`; mode 0 removes the path), after
   * everything else.
   */
  setIndexInfo(input: string | Uint8Array): this {
    this.checkCallable();
    this.indexInfo = { text: input };
    return this;
  }

  /** `--stdin`: paths read from `input`, one per line, after everything else. */
  setStdin(input: string | Uint8Array): this {
    this.checkCallable();
    this.stdinPaths = input;
    return this;
  }

  /** `-z`: {@link setIndexInfo} and {@link setStdin} input is NUL-separated. */
  setNulTerminated(nul = true): this {
    this.checkCallable();
    this.nulTerminated = nul;
    return this;
  }

  /** `--index-version <n>`: the index written in format 2, 3 or 4. */
  setIndexVersion(version: number): this {
    this.checkCallable();
    this.indexVersion = version;
    return this;
  }

  /** `--show-index-version`: the index's format version printed. */
  setShowIndexVersion(show = true): this {
    this.checkCallable();
    this.showIndexVersion = show;
    return this;
  }

  /** `--force-write-index`: the index written even when nothing changed. */
  setForceWriteIndex(force = true): this {
    this.checkCallable();
    this.forceWrite = force;
    return this;
  }

  async call(): Promise<UpdateIndexResult> {
    this.checkCallable();
    this.setCallable(false);
    // fsm_settings__get_reason: a bare repository is incompatible with a configured monitor
    // (git dies after reading the index, which a bare working copy here does not give)
    if (this.fsmonitor && !this.hasWorktree()) {
      const mode = fsmonitorModeOf(
        RemoteConfigStore.from(this.workingCopy).value("core.fsmonitor"),
      );
      if (mode.kind !== "disabled") {
        throw new UpdateIndexFailedError(
          `fatal: bare repository '${await this.currentDirectory()}' is incompatible with fsmonitor`,
        );
      }
    }
    await this.readCurrentIndex();
    // tweak_fsmonitor on the index read: the monitor asked, the extension added or removed
    const hadFsmonitor = !!this.staging.getFsmonitor?.();
    const fsm = await this.fsmonitorRefresh(this.staging);
    const run = new UpdateIndexRun(this.context(fsm?.state));
    for (const warning of fsm?.warnings ?? []) run.stderr.push(`warning: ${warning}`);
    try {
      await this.inOneOperation(async () => {
        for (const step of this.steps) await run.step(step);
        if (this.indexInfo) await run.readIndexInfo(this.indexInfo.text, this.nulTerminated);
        this.applyIndexVersion(run);
        if (this.stdinPaths !== undefined) {
          const badlyQuoted = (): never => {
            throw new Death("line is badly quoted");
          };
          for (const path of inputPaths(this.stdinPaths, this.nulTerminated, badlyQuoted)) {
            await run.updateOne(path);
          }
        }
        await this.applyFsmonitor(run);
      });
    } catch (error) {
      if (error instanceof Death) {
        throw new UpdateIndexFailedError(
          [...run.stderr, `fatal: ${error.message}`].join("\n"),
          run.stdout.join(""),
        );
      }
      throw error;
    }
    // FSMONITOR_CHANGED: the extension added or removed, bits set
    const fsmonitorNow = this.staging.getFsmonitor?.();
    const fsmonitorChanged = !!fsmonitorNow?.changed || (hadFsmonitor && !fsmonitorNow);
    if (run.changed || this.forceWrite || fsmonitorChanged) {
      try {
        await run.write();
      } catch (error) {
        if (error instanceof Death) {
          throw new UpdateIndexFailedError(
            [...run.stderr, `fatal: ${error.message}`].join("\n"),
            run.stdout.join(""),
          );
        }
        throw error;
      }
    }
    return {
      output: run.stdout.join(""),
      errors: run.stderr.map((l) => `${l}\n`).join(""),
      exitCode: run.hasErrors ? 1 : 0,
    };
  }

  /** `--[no-]fsmonitor`: `add_fsmonitor` / `remove_fsmonitor` and their warnings. */
  private async applyFsmonitor(run: UpdateIndexRun): Promise<void> {
    if (this.fsmonitor === undefined) return;
    const mode = fsmonitorModeOf(RemoteConfigStore.from(this.workingCopy).value("core.fsmonitor"));
    const staging = this.staging;
    if (this.fsmonitor) {
      if (mode.kind === "disabled") {
        run.stderr.push(
          "warning: core.fsmonitor is unset; set it if you really want to enable fsmonitor",
        );
      }
      if (!staging.getFsmonitor?.() && staging.setFsmonitor) {
        // add_fsmonitor: a nanosecond token, every entry dirty; written although the
        // monitor is off (the next read with it off removes it)
        const state = new FsmonitorState(String(BigInt(Date.now()) * 1_000_000n));
        state.changed = true;
        state.writtenWhileDisabled = mode.kind === "disabled";
        staging.setFsmonitor(state);
      }
      run.report("fsmonitor enabled");
    } else {
      if (mode.kind !== "disabled" && this.hasWorktree()) {
        run.stderr.push(
          "warning: core.fsmonitor is set; remove it if you really want to disable fsmonitor",
        );
      }
      staging.setFsmonitor?.(undefined);
      run.report("fsmonitor disabled");
    }
  }

  /** git's `xgetcwd()` for a bare repository: the git directory's host path. */
  private async currentDirectory(): Promise<string> {
    const layout = await hookHostOf(this.workingCopy).layout();
    if (!layout) return ".";
    const root = (layout.files as { rootDirectory?: string }).rootDirectory;
    if (!root) return layout.gitDir;
    const base = root.replace(/\/+$/, "");
    const rest = layout.gitDir.replace(/^\.?\/*|\/+$/g, "");
    const path = rest ? `${base}/${rest}` : base || "/";
    const environment = hostEnvironmentOf(this.workingCopy);
    return (await environment?.realPath?.(path).catch(() => undefined)) ?? path;
  }

  private applyIndexVersion(run: UpdateIndexRun): void {
    const staging = this.staging as unknown as {
      _getVersion?(): number;
      _setVersion?(version: number): void;
    };
    const current = staging._getVersion?.() ?? 2;
    if (this.showIndexVersion) run.stdout.push(`${current}\n`);
    const wanted = this.indexVersion;
    if (wanted === undefined || wanted === 0) return;
    if (wanted < 2 || wanted > 4) throw new Death(`index-version ${wanted} not in range: 2..4`);
    if (current !== wanted) run.changed = true;
    run.report(`index-version: was ${current}, set to ${wanted}`);
    run.version = wanted;
    if (staging._setVersion) run.setVersion = (v) => staging._setVersion?.(v);
  }

  private context(fsmonitor: FsmonitorState | undefined): RunContext {
    const worktree = this.worktreeAccess;
    return {
      fsmonitor,
      staging: this.staging,
      worktree,
      blobs: this.blobs,
      trust: worktree
        ? worktreeModeTrust(this.workingCopy, worktree)
        : { executable: true, symlinks: true },
      pathRules: worktreePathRules(this.workingCopy),
      nullId: this.objectFormat.nullId,
      ignoreStat: configBool(this.workingCopy, "core.ignoreStat", false),
      hexLength: this.objectFormat.hexLength,
    };
  }
}

interface RunContext {
  /** The index's fsmonitor state, the monitor asked (undefined while it is off) */
  fsmonitor: FsmonitorState | undefined;
  staging: UpdateIndexCommand["staging"];
  worktree: Worktree | undefined;
  blobs: UpdateIndexCommand["blobs"];
  trust: WorktreeModeTrust;
  pathRules: ReturnType<typeof worktreePathRules>;
  nullId: string;
  /** `core.ignoreStat` (git's `assume_unchanged`) */
  ignoreStat: boolean;
  hexLength: number;
}

/** One run of `update-index` over the index read at its start (git's `the_index`). */
class UpdateIndexRun {
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];
  changed = false;
  hasErrors = false;
  version?: number;
  setVersion?: (version: number) => void;
  private readonly state: State = {
    add: false,
    remove: false,
    replace: false,
    forceRemove: false,
    infoOnly: false,
    verbose: false,
    ignoreSkipWorktreeEntries: false,
    quiet: false,
    unmerged: false,
    ignoreMissing: false,
    ignoreSubmodules: false,
  };
  private entries: Entry[] = [];
  private loaded = false;
  private readonly invalidated = new Set<string>();
  private readonly resolveUndo = new Map<string, ResolveUndoRecord>();
  private indexTime = 0;

  constructor(private readonly ctx: RunContext) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const staging = this.ctx.staging;
    const list = staging.entryList?.();
    if (list) this.entries = [...list];
    else for await (const e of staging.entries()) this.entries.push(e);
    this.indexTime = staging.getUpdateTime();
  }

  report(line: string): void {
    if (this.state.verbose) this.stdout.push(`${line}\n`);
  }

  async step(step: Step): Promise<void> {
    await this.load();
    switch (step.kind) {
      case "set":
        step.apply(this.state);
        return;
      case "path":
        await this.updateOne(step.path);
        return;
      case "cacheinfo":
        if (!this.addCacheInfo(step.mode, step.id, step.path, 0)) {
          throw new Death(`git update-index: --cacheinfo cannot add ${step.path}`);
        }
        return;
      case "refresh":
        await this.refresh(step.really);
        return;
    }
  }

  // ------------------------------------------------------------------------------------------
  // The index in memory (read-cache.c)

  /** `index_name_stage_pos`: the entry's position, or -(insert position)-1. */
  private pos(name: string, stage: number): number {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const e = this.entries[mid] as Entry;
      const c = compareNames(name, e.path) || stage - e.stage;
      if (c === 0) return mid;
      if (c < 0) hi = mid;
      else lo = mid + 1;
    }
    return -lo - 1;
  }

  /** `index_name_pos`: the stage-0 entry's position, or -(insert position)-1. */
  private namePos(name: string): number {
    return this.pos(name, 0);
  }

  private invalidate(path: string): void {
    this.invalidated.add(path);
  }

  /** `remove_index_entry_at`: a conflict stage removed is kept as resolve-undo. */
  private removeAt(pos: number): void {
    const ce = this.entries[pos] as Entry;
    if (ce.stage > 0) {
      let record = this.resolveUndo.get(ce.path);
      if (!record) {
        record = { path: ce.path, modes: [0, 0, 0], objectIds: [undefined, undefined, undefined] };
        this.resolveUndo.set(ce.path, record);
      }
      record.modes[ce.stage - 1] = ce.mode;
      record.objectIds[ce.stage - 1] = ce.objectId;
    }
    this.entries.splice(pos, 1);
    this.changed = true;
  }

  /** `remove_file_from_index`: every stage of `path` removed. */
  private removeFile(path: string): void {
    let pos = this.namePos(path);
    if (pos < 0) pos = -pos - 1;
    this.invalidate(path);
    while (pos < this.entries.length && (this.entries[pos] as Entry).path === path) {
      this.removeAt(pos);
    }
  }

  /** `add_index_entry` with OK_TO_ADD / OK_TO_REPLACE as the flags say; false: refused. */
  private addEntry(ce: Entry): boolean {
    let okToAdd = this.state.add;
    const okToReplace = this.state.replace;
    let pos = this.pos(ce.path, ce.stage);
    this.invalidate(ce.path);
    if (pos >= 0) {
      this.entries[pos] = ce;
      this.changed = true;
      return true;
    }
    pos = -pos - 1;
    if (ce.stage === 0) {
      while (pos < this.entries.length && (this.entries[pos] as Entry).path === ce.path) {
        okToAdd = true;
        this.removeAt(pos);
      }
    }
    if (!okToAdd) return false;
    if (!isValidWorktreePath(ce.path, ce.mode, this.ctx.pathRules)) {
      this.stderr.push(`error: invalid path '${ce.path}'`);
      return false;
    }
    if (this.fileDirectoryConflict(ce, pos, okToReplace)) {
      if (!okToReplace) {
        this.stderr.push(`error: '${ce.path}' appears as both a file and as a directory`);
        return false;
      }
      pos = -this.pos(ce.path, ce.stage) - 1;
    }
    this.entries.splice(pos, 0, ce);
    this.changed = true;
    return true;
  }

  /** `check_file_directory_conflict`: `has_file_name`, then `has_dir_name`. */
  private fileDirectoryConflict(ce: Entry, at: number, okToReplace: boolean): boolean {
    let conflict = false;
    // has_file_name: entries below the new path as a directory
    let pos = at;
    const name = ce.path;
    while (pos < this.entries.length) {
      const p = this.entries[pos++] as Entry;
      if (name.length >= p.path.length || !p.path.startsWith(name)) break;
      if (p.stage !== ce.stage) continue;
      if (p.path[name.length] !== "/") continue;
      conflict = true;
      if (!okToReplace) return true;
      this.removeAt(--pos);
    }
    // has_dir_name: a file where one of its leading directories goes
    for (let slash = name.lastIndexOf("/"); slash > 0; slash = name.lastIndexOf("/", slash - 1)) {
      const dir = name.slice(0, slash);
      const found = this.pos(dir, ce.stage);
      if (found >= 0) {
        conflict = true;
        if (!okToReplace) return true;
        this.removeAt(found);
        continue;
      }
      // a directory of that name already in the index: the levels above are fine too
      let p = -found - 1;
      let exists = false;
      while (p < this.entries.length) {
        const e = this.entries[p] as Entry;
        if (e.path.length <= dir.length || e.path[dir.length] !== "/" || !e.path.startsWith(dir)) {
          break;
        }
        if (e.stage === ce.stage) {
          exists = true;
          break;
        }
        p++;
      }
      if (exists) break;
    }
    return conflict;
  }

  // ------------------------------------------------------------------------------------------
  // update_one and its helpers

  /** git's `update_one`. */
  async updateOne(path: string): Promise<void> {
    await this.load();
    const s = this.state;
    const markOnly =
      s.markValid !== undefined ||
      s.markSkipWorktree !== undefined ||
      s.markFsmonitor !== undefined;
    let current: WorktreeEntry | undefined;
    let missing = false;
    let mode = 0;
    if (!markOnly && !s.forceRemove) {
      current = await this.ctx.worktree?.getEntry(path).catch(() => undefined);
      missing = !current;
      if (current) mode = current.isDirectory ? 0o040000 : current.mode;
    }
    if (!isValidWorktreePath(path, mode, this.ctx.pathRules)) {
      this.stderr.push(`Ignoring path ${path}`);
      return;
    }
    if (s.markValid !== undefined) {
      if (!this.markFlags(path, "assumeValid", s.markValid)) {
        throw new Death(`Unable to mark file ${path}`);
      }
      return this.chmodAfter(path);
    }
    if (s.markSkipWorktree !== undefined) {
      if (!this.markFlags(path, "skipWorktree", s.markSkipWorktree)) {
        throw new Death(`Unable to mark file ${path}`);
      }
      return this.chmodAfter(path);
    }
    if (s.markFsmonitor !== undefined) {
      if (!this.markFsmonitor(path, s.markFsmonitor)) {
        throw new Death(`Unable to mark file ${path}`);
      }
      return this.chmodAfter(path);
    }
    if (s.forceRemove) {
      this.removeFile(path);
      this.report(`remove '${path}'`);
      return this.chmodAfter(path);
    }
    if (!(await this.processPath(path, current, missing))) {
      throw new Death(`Unable to process path ${path}`);
    }
    this.report(`add '${path}'`);
    return this.chmodAfter(path);
  }

  /** The `--chmod` that follows every path (`chmod_path`). */
  private chmodAfter(path: string): void {
    const flip = this.state.chmod;
    if (!flip) return;
    const pos = this.namePos(path);
    const ce = pos >= 0 ? (this.entries[pos] as Entry) : undefined;
    if (!ce || (ce.mode & S_IFMT) !== S_IFREG) {
      throw new Death(`git update-index: cannot chmod ${flip} '${path}'`);
    }
    // chmod_index_entry
    const mode = flip === "+x" ? FileMode.EXECUTABLE_FILE : FileMode.REGULAR_FILE;
    this.entries[pos] = { ...ce, mode };
    this.invalidate(path);
    this.changed = true;
    this.report(`chmod ${flip} '${path}'`);
  }

  /** `mark_ce_flags`: false when the path has no stage-0 entry. */
  private markFlags(path: string, flag: "assumeValid" | "skipWorktree", mark: boolean): boolean {
    const pos = this.namePos(path);
    if (pos < 0) return false;
    const ce = this.entries[pos] as Entry;
    this.entries[pos] = { ...ce, [flag]: mark };
    this.invalidate(path);
    this.changed = true;
    return true;
  }

  /** `mark_ce_flags` with `CE_FSMONITOR_VALID`: false when the path has no stage-0 entry. */
  private markFsmonitor(path: string, mark: boolean): boolean {
    const pos = this.namePos(path);
    if (pos < 0) return false;
    const ce = this.entries[pos] as Entry;
    const state = this.ctx.fsmonitor;
    if (state) {
      state.markInvalid(ce);
      if (mark) state.markValid(ce, { gitlinks: true });
    }
    this.invalidate(path);
    this.changed = true;
    return true;
  }

  /** `remove_one_path`. */
  private removeOnePath(path: string): boolean {
    if (!this.state.remove) {
      this.stderr.push(`error: ${path}: does not exist and --remove not passed`);
      return false;
    }
    this.removeFile(path);
    return true;
  }

  /** `process_path`: false where git's returns an error. */
  private async processPath(
    path: string,
    current: WorktreeEntry | undefined,
    missing: boolean,
  ): Promise<boolean> {
    if (await this.beyondSymlink(path)) {
      this.stderr.push(`error: '${path}' is beyond a symbolic link`);
      return false;
    }
    const pos = this.namePos(path);
    const ce = pos >= 0 ? (this.entries[pos] as Entry) : undefined;
    if (ce?.skipWorktree) {
      // the worktree's version is assumed good: only a removal applies
      if (!this.state.ignoreSkipWorktreeEntries && this.state.remove) this.removeFile(path);
      return true;
    }
    if (missing || !current) return this.removeOnePath(path);
    if (current.isDirectory) return this.processDirectory(path, current);
    return this.addOnePath(ce, path, current);
  }

  /** `has_symlink_leading_path`. */
  private async beyondSymlink(path: string): Promise<boolean> {
    const worktree = this.ctx.worktree;
    if (!worktree) return false;
    for (let at = path.indexOf("/"); at > 0; at = path.indexOf("/", at + 1)) {
      const dir = await worktree.getEntry(path.slice(0, at)).catch(() => undefined);
      if (!dir) return false;
      if (!dir.isDirectory && (dir.mode & S_IFMT) === FileMode.SYMLINK) return true;
      if (!dir.isDirectory) return false;
    }
    return false;
  }

  /** `process_directory`. */
  private async processDirectory(path: string, current: WorktreeEntry): Promise<boolean> {
    const worktree = this.ctx.worktree as Worktree;
    const pos = this.namePos(path);
    if (pos >= 0) {
      const ce = this.entries[pos] as Entry;
      if (ce.mode === FileMode.GITLINK) {
        const head = await worktree.readGitlinkHead?.(path).catch(() => undefined);
        if (!head) return true;
        return this.addGitlink(ce, path, current, head);
      }
      return this.removeOnePath(path);
    }
    // a subdirectory of entries: an error
    for (let p = -pos - 1; p < this.entries.length; p++) {
      const e = this.entries[p] as Entry;
      if (!e.path.startsWith(path)) break;
      const c = e.path.charCodeAt(path.length);
      if (c > 0x2f) break;
      if (c < 0x2f) continue;
      this.stderr.push(`error: ${path}: is a directory - add individual files instead`);
      return false;
    }
    const head = await worktree.readGitlinkHead?.(path).catch(() => undefined);
    if (head) return this.addGitlink(undefined, path, current, head);
    this.stderr.push(`error: ${path}: is a directory - add files inside instead`);
    return false;
  }

  private addGitlink(
    old: Entry | undefined,
    path: string,
    current: WorktreeEntry,
    head: ObjectId,
  ): boolean {
    // ie_match_stat of a gitlink: only the commit checked out counts
    if (old && old.stage === 0 && old.objectId === head) return true;
    const ce: Entry = {
      path,
      mode: FileMode.GITLINK,
      objectId: head,
      stage: 0,
      ...entryStatOf(current),
    };
    if (!this.addEntry(ce)) {
      this.stderr.push(`error: ${path}: cannot add to the index - missing --add option?`);
      return false;
    }
    return true;
  }

  /** Whether `old` is up to date with the file (`ie_match_stat(old, st, 0)` is 0). */
  private async upToDate(old: Entry, current: WorktreeEntry): Promise<boolean> {
    if (old.assumeValid) return true;
    if (old.intentToAdd) return false;
    const trust = this.ctx.trust;
    if (modeFromWorktree(current.mode, old.mode, trust) !== old.mode) return false;
    if (!basicStatMatches(old, current, trust)) return false;
    const racy =
      this.indexTime === 0 || wholeSeconds(old.mtime, old.mtimeNs) >= wholeSeconds(this.indexTime);
    if (!racy) return true;
    const worktree = this.ctx.worktree as Worktree;
    return (await worktree.computeHash(old.path).catch(() => undefined)) === old.objectId;
  }

  /** `add_one_path`. */
  private async addOnePath(
    old: Entry | undefined,
    path: string,
    current: WorktreeEntry,
  ): Promise<boolean> {
    if (old && old.stage === 0 && (await this.upToDate(old, current))) return true;
    const worktree = this.ctx.worktree as Worktree;
    let id: ObjectId;
    let stat = current;
    try {
      if (this.state.infoOnly) {
        id = await worktree.computeHash(path);
      } else {
        const stored = await storeWorktreeFile(this.ctx.blobs, worktree, path, current);
        id = stored.id;
        stat = stored.entry;
      }
    } catch (error) {
      this.stderr.push(`error: ${(error as Error).message}`);
      return false;
    }
    const ce: Entry = {
      path,
      mode: modeFromWorktree(stat.mode, old?.mode, this.ctx.trust) as FileModeValue,
      objectId: id,
      stage: 0,
      ...entryStatOf(stat),
    };
    if (!this.addEntry(ce)) {
      this.stderr.push(`error: ${path}: cannot add to the index - missing --add option?`);
      return false;
    }
    return true;
  }

  /** `add_cacheinfo`: false where git returns an error. */
  private addCacheInfo(mode: number, id: string, path: string, stage: number): boolean {
    if (!isValidWorktreePath(path, mode, this.ctx.pathRules)) {
      this.stderr.push(`error: Invalid path '${path}'`);
      return false;
    }
    const ce: Entry = {
      path,
      mode: createCeMode(mode) as FileModeValue,
      objectId: id.toLowerCase(),
      stage: stage as Entry["stage"],
      size: 0,
      mtime: 0,
      // add_cacheinfo's CE_VALID is core.ignoreStat's (assume_unchanged), not the option
      ...(this.ctx.ignoreStat ? { assumeValid: true } : {}),
    };
    if (!this.addEntry(ce)) {
      this.stderr.push(`error: ${path}: cannot add to the index - missing --add option?`);
      return false;
    }
    this.report(`add '${path}'`);
    return true;
  }

  // ------------------------------------------------------------------------------------------
  // --index-info

  /** `read_index_info`. */
  async readIndexInfo(input: string | Uint8Array, nul: boolean): Promise<void> {
    await this.load();
    const s = this.state;
    s.add = true;
    s.replace = true;
    s.remove = true;
    const hex = this.ctx.hexLength;
    for (const line of inputLines(input, nul)) {
      const bad = (): never => {
        throw new Death(`malformed index info ${line}`);
      };
      const m = /^([0-7]+) /.exec(line);
      if (!m) bad();
      const mode = Number.parseInt((m as RegExpExecArray)[1] as string, 8);
      if (mode > 0xffffffff) bad();
      let tab = line.indexOf("\t");
      if (tab < 0 || tab - (m as RegExpExecArray)[0].length + 1 < hex + 1) bad();
      let stage = 0;
      const pathAt = tab + 1;
      if (
        line[tab - 2] === " " &&
        line[tab - 1] !== undefined &&
        /[0-3]/.test(line[tab - 1] as string)
      ) {
        stage = Number(line[tab - 1]);
        tab -= 2;
      }
      const id = line.slice(tab - hex, tab);
      if (!/^[0-9a-fA-F]+$/.test(id) || id.length !== hex || line[tab - hex - 1] !== " ") bad();
      let path = line.slice(pathAt);
      if (!nul && path.startsWith('"')) {
        const unquoted = unquoteLine(path);
        if (unquoted === undefined) throw new Death("git update-index: bad quoting of path name");
        path = unquoted;
      }
      if (!isValidWorktreePath(path, mode, this.ctx.pathRules)) {
        this.stderr.push(`Ignoring path ${path}`);
        continue;
      }
      if (mode === 0) {
        this.removeFile(path);
      } else if (!this.addCacheInfo(mode, id, path, stage)) {
        throw new Death(`git update-index: unable to update ${path}`);
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // --refresh / --really-refresh

  /** `refresh_index` over the entries (read-cache.c), then `has_racy_timestamp`. */
  private async refresh(really: boolean): Promise<void> {
    const s = this.state;
    const worktree = this.ctx.worktree;
    if (!worktree) return;
    const trust = this.ctx.trust;
    const fsmonitor = this.ctx.fsmonitor;
    for (let i = 0; i < this.entries.length; i++) {
      const ce = this.entries[i] as Entry;
      if (s.ignoreSubmodules && ce.mode === FileMode.GITLINK) continue;
      if (ce.stage !== 0) {
        while (i < this.entries.length && (this.entries[i] as Entry).path === ce.path) i++;
        i--;
        if (s.unmerged) continue;
        this.stdout.push(`${ce.path}: needs merge\n`);
        this.hasErrors = true;
        continue;
      }
      // refresh_cache_ent: what the user promised not to have changed
      if (ce.skipWorktree) continue;
      if (!really && ce.assumeValid) continue;
      // CE_FSMONITOR_VALID: the monitor reported nothing for it, taken as up to date unseen
      if (fsmonitor?.isValid(ce)) continue;
      const current = await worktree.getEntry(ce.path).catch(() => undefined);
      if (!current && s.ignoreMissing) continue;
      let changed: boolean;
      let fresh: Entry | undefined;
      if (ce.intentToAdd) {
        changed = true;
      } else {
        const compared = await compareWithWorktree(
          worktree,
          ce,
          { trust, indexTime: this.indexTime },
          current ?? null,
        );
        changed = compared.kind !== undefined;
        const file = compared.worktreeEntry;
        // proved clean by reading it: its fresh stat recorded (refresh_cache_ent's copy)
        if (!changed && compared.hashedId === ce.objectId && file && !file.isDirectory) {
          fresh = { ...ce, ...entryStatOf(file) };
        }
      }
      if (changed) {
        if (really && ce.assumeValid && current) {
          // the promise broken: the flag goes
          this.entries[i] = { ...ce, assumeValid: false };
          this.changed = true;
        }
        if (s.quiet) continue;
        this.stdout.push(`${ce.path}: needs update\n`);
        this.hasErrors = true;
        continue;
      }
      if (fresh && !sameStat(fresh, ce)) {
        // replaced (its stat stored): no longer fsmonitor-valid (replace_index_entry)
        this.entries[i] = fresh;
        this.changed = true;
      } else {
        // up to date as it is: mark_fsmonitor_valid (gitlinks never)
        fsmonitor?.markValid(ce);
      }
    }
    // has_racy_timestamp: written anyway, so the racy entries stop being racy
    for (const ce of this.entries) {
      if (ce.stage !== 0) continue;
      if (
        this.indexTime === 0 ||
        wholeSeconds(ce.mtime, ce.mtimeNs) >= wholeSeconds(this.indexTime)
      ) {
        if (ce.mtime !== 0) {
          this.changed = true;
          break;
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Writing

  /** `write_locked_index`: the entries, invalidated cache-tree paths and resolve-undo. */
  async write(): Promise<void> {
    await this.load();
    for (const ce of this.entries) {
      if (ce.objectId === this.ctx.nullId) {
        this.stderr.push(`error: cache entry has null sha1: ${ce.path}`);
        throw new Death("Unable to write new index file");
      }
    }
    const staging = this.ctx.staging;
    const tree = staging.getCacheTree?.();
    const builder = staging.createBuilder();
    for (const ce of this.entries) builder.add(ce);
    await builder.finish({ upToDate: false });
    if (staging.setCacheTree) {
      if (tree) for (const path of this.invalidated) invalidateCacheTreePath(tree, path);
      staging.setCacheTree(tree);
    }
    if (this.resolveUndo.size > 0) staging.recordResolveUndo?.([...this.resolveUndo.values()]);
    if (this.version !== undefined) this.setVersion?.(this.version);
    await staging.write();
  }
}

function sameStat(a: Entry, b: Entry): boolean {
  return (
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.mtimeNs === b.mtimeNs &&
    a.ctime === b.ctime &&
    a.ctimeNs === b.ctimeNs &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.uid === b.uid &&
    a.gid === b.gid
  );
}

/** git's `create_ce_mode`. */
function createCeMode(mode: number): number {
  if ((mode & S_IFMT) === FileMode.SYMLINK) return FileMode.SYMLINK;
  if ((mode & S_IFMT) === 0o040000 || (mode & S_IFMT) === FileMode.GITLINK) return FileMode.GITLINK;
  return S_IFREG | ((mode & 0o100) !== 0 ? 0o755 : 0o644);
}
