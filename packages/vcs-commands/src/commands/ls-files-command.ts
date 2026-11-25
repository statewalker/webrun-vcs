/**
 * `git ls-files` (builtin/ls-files.c): the index's entries, the untracked, ignored, deleted,
 * modified and killed files, with git's output formats (`-s`, `-t`, `-v`, `--eol`,
 * `--format`, `-z`) and its pathspec rules, run from any directory of the worktree.
 *
 * @example
 * ```typescript
 * // git ls-files -s
 * const { stdout } = await git.lsFiles().setStage(true).callOutput();
 * // "100644 3b18e512dba79e4c8300dd08aeb37f8e728b8dad 0\thello.txt\n"
 *
 * // git ls-files --others --exclude-standard (from the subdirectory src/)
 * await git.lsFiles().setOthers(true).setExcludeStandard().setPrefix("src/").callOutput();
 * ```
 */

import { parseGitBool } from "@statewalker/vcs-utils";
import { compareGitPaths, decodeGitPatternFile } from "@statewalker/vcs-utils/encoding";
import { FileMode } from "@statewalker/vcs-utils/files";
import {
  compareWithWorktree,
  createCommandLineExcludes,
  createIgnoreNode,
  DIR_COLLECT_KILLED_ONLY,
  DIR_HIDE_EMPTY_DIRECTORIES,
  DIR_SHOW_IGNORED,
  DIR_SHOW_OTHER_DIRECTORIES,
  eolStatsAscii,
  expandUserPath,
  type IgnoreNode,
  IndexPathLookup,
  type ResolveUndoRecord,
  type StagingEntry,
  scanUntracked,
  type UntrackedScanHost,
  unreadableDirectoryWarning,
  type Worktree,
  walkUntrackedScanHost,
  withWorktreeEntries,
  xdgConfigPath,
} from "@statewalker/vcs-working-tree";
import { RemoteConfigStore } from "../remote-config/index.js";
import { quotePath } from "../results/quote-path.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import { hostEnvironmentOf } from "./git-ident.js";
import {
  DO_MATCH_DIRECTORY,
  matchPathspec,
  matchPathspecSeen,
  type PathspecItem,
  parsePathspec,
  pathspecCommonPrefix,
  pathspecErrors,
  pathspecName,
  untrackedScanPathspec,
} from "./pathspec.js";
import { PlumbingCommand, PlumbingError } from "./plumbing-command.js";

/** One entry of the index as ls-files walks it (`struct cache_entry`). */
interface ListedEntry {
  path: string;
  mode: number;
  objectId: string;
  stage: number;
  assumeValid: boolean;
  skipWorktree: boolean;
  intentToAdd: boolean;
  /** git's `CE_UPDATE` mark of `--with-tree`: a tree entry a stage-0 entry shadows */
  shadowed: boolean;
  /** The index entry itself (for the stat comparison); none for a `--with-tree` entry */
  entry?: StagingEntry;
}

/** An exclude source given in order (`-X <file>`, `--exclude-standard`). */
type ExcludeSource = { kind: "file"; path: string } | { kind: "standard" };

const S_IFMT = 0o170000;
const isRegularMode = (mode: number) => (mode & S_IFMT) === 0o100000;

/**
 * `git ls-files`. Output is written as git writes it ({@link PlumbingCommand}); the exit
 * status is 1 when `--error-unmatch` finds an element matching nothing.
 *
 * Not supported: `--recurse-submodules` and `--debug` (refused), `-f` (fsmonitor: taken as
 * `-v` without fsmonitor-valid entries). `--sparse` has no effect: the index is always held
 * expanded, so the directory entries of a sparse index are listed as their files, as git
 * lists them without `--sparse`.
 */
export class LsFilesCommand extends PlumbingCommand {
  private cached = false;
  private deleted = false;
  private modified = false;
  private others = false;
  private ignored = false;
  private stage = false;
  private killed = false;
  private unmerged = false;
  private resolveUndo = false;
  private directory = false;
  private hideEmptyDirectories = false;
  private tags = false;
  private validBit = false;
  private fsmonitorBit = false;
  private nul = false;
  private eol = false;
  private deduplicate = false;
  private fullName = false;
  private errorUnmatch = false;
  private recurseSubmodules = false;
  private abbrev: number | true = 0;
  private withTree?: string;
  private format?: string;
  private prefix = "";
  private readonly paths: string[] = [];
  private readonly excludes: string[] = [];
  private readonly excludeSources: ExcludeSource[] = [];
  private excludePerDirectory?: string;
  private compatibility: "2.43" | "2.56" = "2.56";

  /** `-c`/`--cached`: the index's entries (the default when nothing else is asked). */
  setCached(value: boolean): this {
    return this.set(() => {
      this.cached = value;
    });
  }

  /** `-d`/`--deleted`: entries whose file is gone. */
  setDeleted(value: boolean): this {
    return this.set(() => {
      this.deleted = value;
    });
  }

  /** `-m`/`--modified`: entries whose file differs (a deleted one included). */
  setModified(value: boolean): this {
    return this.set(() => {
      this.modified = value;
    });
  }

  /** `-o`/`--others`: the untracked files. */
  setOthers(value: boolean): this {
    return this.set(() => {
      this.others = value;
    });
  }

  /** `-i`/`--ignored`: only the ignored files (with `-o`) or entries (with `-c`). */
  setIgnored(value: boolean): this {
    return this.set(() => {
      this.ignored = value;
    });
  }

  /** `-s`/`--stage`: each entry's mode, object name and stage. */
  setStage(value: boolean): this {
    return this.set(() => {
      this.stage = value;
    });
  }

  /** `-k`/`--killed`: the untracked files a checkout of the index would remove. */
  setKilled(value: boolean): this {
    return this.set(() => {
      this.killed = value;
    });
  }

  /** `-u`/`--unmerged`: the unmerged entries (implies `-s`). */
  setUnmerged(value: boolean): this {
    return this.set(() => {
      this.unmerged = value;
    });
  }

  /** `--resolve-undo`: the resolve-undo records (`U` tag with `-t`). */
  setResolveUndo(value: boolean): this {
    return this.set(() => {
      this.resolveUndo = value;
    });
  }

  /** `--directory`: an untracked directory as `dir/` rather than its files. */
  setDirectory(value: boolean): this {
    return this.set(() => {
      this.directory = value;
    });
  }

  /** `--[no-]empty-directory`: false hides empty untracked directories. */
  setEmptyDirectory(show: boolean): this {
    return this.set(() => {
      this.hideEmptyDirectories = !show;
    });
  }

  /** `-t`: a status tag before each path (`H`, `S`, `M`, `R`, `C`, `K`, `?`, `U`). */
  setShowTags(value: boolean): this {
    return this.set(() => {
      this.tags = value;
    });
  }

  /** `-v`: tags, lowercase for assume-unchanged entries. */
  setShowValidBit(value: boolean): this {
    return this.set(() => {
      this.validBit = value;
    });
  }

  /** `-f`: tags, lowercase for fsmonitor-valid entries (none here: no fsmonitor). */
  setShowFsmonitorBit(value: boolean): this {
    return this.set(() => {
      this.fsmonitorBit = value;
    });
  }

  /** `-z`: paths ended by NUL and never quoted. */
  setNulTerminated(value: boolean): this {
    return this.set(() => {
      this.nul = value;
    });
  }

  /** `--eol`: the `i/`, `w/` and `attr/` line-ending columns before each path. */
  setEol(value: boolean): this {
    return this.set(() => {
      this.eol = value;
    });
  }

  /** `--deduplicate`: each path once. */
  setDeduplicate(value: boolean): this {
    return this.set(() => {
      this.deduplicate = value;
    });
  }

  /** `--full-name`: paths from the top of the worktree, whatever the prefix. */
  setFullName(value: boolean): this {
    return this.set(() => {
      this.fullName = value;
    });
  }

  /** `--error-unmatch`: an element matching nothing is an error (exit 1). */
  setErrorUnmatch(value: boolean): this {
    return this.set(() => {
      this.errorUnmatch = value;
    });
  }

  /** `--recurse-submodules` (refused: not supported). */
  setRecurseSubmodules(value: boolean): this {
    return this.set(() => {
      this.recurseSubmodules = value;
    });
  }

  /**
   * `--abbrev[=<n>]`: object names abbreviated (`true`: `core.abbrev`'s length; a number: at
   * least that many digits, 4 at the least; 0: full names, the default).
   */
  setAbbrev(value: number | boolean): this {
    return this.set(() => {
      if (value === false) this.abbrev = 0;
      else if (value === true) this.abbrev = true;
      else this.abbrev = value > 0 && value < 4 ? 4 : value;
    });
  }

  /** `--with-tree=<tree-ish>`: the tree's paths the index lacks are listed too. */
  setWithTree(treeish: string): this {
    return this.set(() => {
      this.withTree = treeish;
    });
  }

  /** `--format=<format>`: each entry through a format of `%(atom)`s. */
  setFormat(format: string): this {
    return this.set(() => {
      this.format = format;
    });
  }

  /** `-x`/`--exclude=<pattern>`: an exclude pattern (git's `EXC_CMDL`). */
  addExclude(pattern: string): this {
    return this.set(() => {
      this.excludes.push(pattern);
    });
  }

  /** `-X`/`--exclude-from=<file>`: exclude patterns from a file (from the worktree's top). */
  addExcludeFrom(file: string): this {
    return this.set(() => {
      this.excludeSources.push({ kind: "file", path: file });
    });
  }

  /** `--exclude-per-directory=<file>`: per-directory exclude files of that name. */
  setExcludePerDirectory(name: string): this {
    return this.set(() => {
      this.excludePerDirectory = name;
    });
  }

  /**
   * `--exclude-standard`: `core.excludesFile`, `$GIT_DIR/info/exclude` and `.gitignore`
   * files.
   */
  setExcludeStandard(): this {
    return this.set(() => {
      this.excludeSources.push({ kind: "standard" });
      this.excludePerDirectory = ".gitignore";
    });
  }

  /** Pathspec elements, read from the {@link setPrefix} directory. */
  addPathspec(...paths: string[]): this {
    return this.set(() => {
      this.paths.push(...paths);
    });
  }

  /** The current directory below the top of the worktree (`sub/dir/`). */
  setPrefix(prefix: string): this {
    return this.set(() => {
      this.prefix = prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`;
    });
  }

  /** The git version whose behaviour to follow (default 2.56). */
  setCompatibility(version: "2.43" | "2.56"): this {
    return this.set(() => {
      this.compatibility = version;
    });
  }

  private set(apply: () => void): this {
    this.checkCallable();
    apply();
    return this;
  }

  protected async run(): Promise<number> {
    if (
      this.format !== undefined &&
      (this.stage ||
        this.others ||
        this.killed ||
        this.resolveUndo ||
        this.deduplicate ||
        this.eol ||
        this.tags)
    ) {
      throw new PlumbingError(
        "fatal: --format cannot be used with -s, -o, -k, -t, --resolve-undo, --deduplicate, --eol",
        129,
      );
    }
    const tagged = this.tags || this.validBit || this.fsmonitorBit;
    const showStage = this.stage || this.unmerged;
    const dedup = this.deduplicate && !(this.tags || showStage);
    const excludeGiven =
      this.excludes.length > 0 ||
      this.excludeSources.length > 0 ||
      this.excludePerDirectory !== undefined;
    const needsWorktree =
      this.modified || this.others || this.deleted || this.ignored || this.killed;
    const worktree = needsWorktree ? this.worktreeAccess : undefined;
    if (needsWorktree && !worktree) {
      throw new PlumbingError("fatal: this operation must be run in a work tree");
    }
    if (
      this.recurseSubmodules &&
      (this.deleted ||
        this.others ||
        this.unmerged ||
        this.killed ||
        this.modified ||
        this.resolveUndo ||
        this.withTree !== undefined)
    ) {
      throw new PlumbingError("fatal: ls-files --recurse-submodules unsupported mode");
    }
    if (this.recurseSubmodules && this.errorUnmatch) {
      throw new PlumbingError(
        "fatal: ls-files --recurse-submodules does not support --error-unmatch",
      );
    }
    if (this.recurseSubmodules) {
      throw new PlumbingError("fatal: ls-files --recurse-submodules is not supported");
    }

    // parse_pathspec with PATHSPEC_PREFER_CWD: no element is the current directory
    const prefix = this.prefix;
    const args = this.paths.length > 0 ? this.paths.map((p) => prefixedElement(p, prefix)) : [];
    if (args.length === 0 && prefix) args.push(prefix);
    let items: PathspecItem[];
    try {
      items = parsePathspec(args);
    } catch (e) {
      throw new PlumbingError(`fatal: ${(e as Error).message}`);
    }
    const originals = this.paths.length > 0 ? this.paths : args.map(() => "");
    const maxPrefix = pathspecCommonPrefix(items);
    const pruneBy = maxPrefix.endsWith("/") ? maxPrefix.slice(0, -1) : maxPrefix;
    const seen = this.errorUnmatch && items.length > 0 ? items.map(() => 0) : undefined;
    const exactStopsGlobs = this.compatibility === "2.43";
    const match = (path: string, isDir: boolean) => {
      const flags = isDir ? DO_MATCH_DIRECTORY : 0;
      return seen
        ? matchPathspecSeen(items, path, flags, seen, exactStopsGlobs) > 0
        : matchPathspec(items, path, flags) > 0;
    };

    if (this.ignored && !this.others && !this.cached) {
      throw new PlumbingError("fatal: ls-files -i must be used with either -o or -c");
    }
    if (this.ignored && !excludeGiven) {
      throw new PlumbingError("fatal: ls-files --ignored needs some exclude pattern");
    }
    const cached =
      this.cached ||
      !(
        showStage ||
        this.deleted ||
        this.others ||
        this.unmerged ||
        this.killed ||
        this.modified ||
        this.resolveUndo
      );

    await this.readCurrentIndex(false);
    // prune_index: only the entries under the pathspec's common leading directory
    const list: ListedEntry[] = [];
    for await (const e of this.staging.entryList?.() ?? this.staging.entries()) {
      if (pruneBy && !pathspecName(e.path).startsWith(pruneBy)) continue;
      list.push({
        path: e.path,
        mode: e.mode,
        objectId: e.objectId,
        stage: e.stage,
        assumeValid: e.assumeValid === true,
        skipWorktree: e.skipWorktree === true,
        intentToAdd: e.intentToAdd === true,
        shadowed: false,
        entry: e,
      });
    }
    if (this.withTree !== undefined) {
      if (showStage) {
        throw new PlumbingError(
          "fatal: options 'ls-files --with-tree' and '-s/-u' cannot be used together",
        );
      }
      await this.overlayTree(list, this.withTree, maxPrefix);
    }

    const quoteFully =
      parseGitBool(RemoteConfigStore.from(this.workingCopy).value("core.quotePath") ?? "true") ??
      true;
    const term = this.nul ? "\0" : "\n";
    const relative = (path: string) =>
      this.fullName || !prefix ? path : relativeGitPath(path, prefix);
    const nameText = (path: string) => {
      const rel = relative(path);
      return this.nul ? rel : quotePath(rel, quoteFully);
    };

    const tag = (name: string) => (tagged ? `${name} ` : "");
    const rules = excludeGiven ? await this.excludeRules(worktree, list) : undefined;
    const eolColumns = this.eol ? await this.eolColumns(worktree, list) : undefined;

    const body = async () => {
      // show_files: the directory walk for -o and -k first
      if (this.others || this.killed) {
        const ws = worktree as Worktree;
        const names = await this.walkOthers(ws, items, list, rules);
        if (this.others) {
          for (const name of names) {
            // index_name_is_other: a directory named as an index entry is no other file
            if (isInIndex(list, name.endsWith("/") ? name.slice(0, -1) : name)) continue;
            if (seen) {
              const dir = name.endsWith("/");
              matchPathspecSeen(
                items,
                dir ? name.slice(0, -1) : name,
                dir ? DO_MATCH_DIRECTORY : 0,
                seen,
                exactStopsGlobs,
              );
            }
            await this.write(
              `${tag("?")}${eolColumns ? await eolColumns(name, undefined) : ""}${nameText(name)}${term}`,
            );
          }
        }
        if (this.killed) {
          for (const name of names) {
            if (!isKilled(list, name)) continue;
            if (seen) {
              const dir = name.endsWith("/");
              matchPathspecSeen(
                items,
                dir ? name.slice(0, -1) : name,
                dir ? DO_MATCH_DIRECTORY : 0,
                seen,
                exactStopsGlobs,
              );
            }
            await this.write(
              `${tag("K")}${eolColumns ? await eolColumns(name, undefined) : ""}${nameText(name)}${term}`,
            );
          }
        }
      }
      if (!(cached || showStage || this.deleted || this.modified)) return;

      const showCe = async (e: ListedEntry, name: string) => {
        const isDir = (e.mode & S_IFMT) === 0o040000 || e.mode === FileMode.GITLINK;
        if (!match(e.path, isDir)) return;
        if (this.format !== undefined) {
          await this.write(`${await this.formatEntry(e, worktree, list, nameText)}${term}`);
          return;
        }
        let t = tagged ? `${name} ` : "";
        if (t && this.validBit && e.assumeValid) t = lowerTag(t);
        let line = t;
        if (showStage) {
          line += `${e.mode.toString(8).padStart(6, "0")} ${await this.abbreviated(e.objectId)} ${e.stage}\t`;
        }
        if (eolColumns) line += await eolColumns(e.path, e);
        await this.write(`${line}${nameText(e.path)}${term}`);
      };

      // the entries a stat pass looks at (-d, -m)
      const statted = (e: ListedEntry) => (this.deleted || this.modified) && !e.skipWorktree;
      const trust = worktree ? worktreeModeTrust(this.workingCopy, worktree) : undefined;
      const indexTime = this.staging.getUpdateTime();
      const walk = worktree
        ? withWorktreeEntries(worktree, list, statted)
        : (async function* () {
            for (const item of list) yield { item, current: undefined };
          })();
      let skipName: string | undefined;
      for await (const { item: e, current } of walk) {
        if (skipName !== undefined && e.path === skipName) continue;
        skipName = undefined;
        if (rules) {
          const isDir = e.mode === FileMode.GITLINK;
          await rules.loadFor(e.path);
          if (this.ignored && !rules.isExcluded(e.path, isDir)) continue;
        }
        if (e.shadowed) continue;
        if ((cached || showStage) && (!this.unmerged || e.stage !== 0)) {
          await showCe(e, e.stage !== 0 ? "M" : e.skipWorktree ? "S" : "H");
          if (dedup) {
            skipName = e.path;
            continue;
          }
        }
        if (!(this.deleted || this.modified)) continue;
        if (e.skipWorktree) continue;
        const missing = !current;
        if (missing && this.deleted) {
          await showCe(e, "R");
          if (dedup) {
            skipName = e.path;
            continue;
          }
        }
        if (
          this.modified &&
          (missing || (await this.entryModified(e, current, worktree, trust, indexTime)))
        ) {
          await showCe(e, "C");
          if (dedup) {
            skipName = e.path;
          }
        }
      }
    };
    if (worktree?.batch) await worktree.batch(body);
    else await body();

    if (this.resolveUndo) {
      const records = [...(this.staging.getResolveUndo?.() ?? [])].sort((a, b) =>
        compareGitPaths(a.path, b.path),
      );
      for (const record of records)
        await this.showResolveUndo(record, pruneBy, match, tag, nameText, term);
    }

    if (seen) {
      const errors = pathspecErrors(originals, seen);
      if (errors.length > 0) {
        for (const line of errors) this.warn(line);
        this.warn("Did you forget to 'git add'?");
        return 1;
      }
    }
    return 0;
  }

  /** show_ru_info: one line per stage the record keeps. */
  private async showResolveUndo(
    record: ResolveUndoRecord,
    pruneBy: string,
    match: (path: string, isDir: boolean) => boolean,
    tag: (name: string) => string,
    nameText: (path: string) => string,
    term: string,
  ): Promise<void> {
    if (pathspecName(record.path).length < pruneBy.length) return;
    if (!match(record.path, false)) return;
    for (let i = 0; i < 3; i++) {
      const mode = record.modes[i] as number;
      const id = record.objectIds[i];
      if (!mode || !id) continue;
      await this.write(
        `${tag("U")}${mode.toString(8).padStart(6, "0")} ${await this.abbreviated(id)} ${i + 1}\t${nameText(record.path)}${term}`,
      );
    }
  }

  /** ie_modified for an entry whose file is there (`current`). */
  private async entryModified(
    e: ListedEntry,
    current: unknown,
    worktree: Worktree | undefined,
    trust: ReturnType<typeof worktreeModeTrust> | undefined,
    indexTime: number,
  ): Promise<boolean> {
    if (e.assumeValid) return false;
    if (e.intentToAdd) return true;
    if (!worktree || !e.entry) return true;
    const file = current as { isDirectory?: boolean } | null | undefined;
    // a directory where a file was: TYPE_CHANGED
    if (file?.isDirectory && e.mode !== FileMode.GITLINK) return true;
    const compared = await compareWithWorktree(
      worktree,
      e.entry,
      { ...(trust ? { trust } : {}), indexTime },
      (current ?? null) as Parameters<typeof compareWithWorktree>[3],
    );
    return compared.kind !== undefined;
  }

  /** An object name as `--abbrev` asks (full by default). */
  private async abbreviated(id: string): Promise<string> {
    if (this.abbrev === 0 || (typeof this.abbrev === "number" && this.abbrev >= id.length)) {
      return id;
    }
    if (this.abbrev === true) return this.abbreviateObjectId(id);
    const length = (await this.idAbbreviator().lengths([id], this.abbrev)).get(id) ?? id.length;
    return id.slice(0, length);
  }

  /**
   * overlay_tree_on_index: the tree's entries under `prefix` at stage 1 (unmerged entries
   * hoisted to stage 3), those a stage-0 entry of the same path shadows marked.
   */
  private async overlayTree(list: ListedEntry[], name: string, prefix: string): Promise<void> {
    let id: string;
    try {
      id = await this.resolveRevision(name);
    } catch {
      throw new PlumbingError(`fatal: tree-ish ${name} not found.`);
    }
    let tree: string;
    try {
      tree = await this.resolveRevision(`${id}^{tree}`);
    } catch {
      throw new PlumbingError(`fatal: bad tree-ish ${name}`);
    }
    for (const e of list) if (e.stage !== 0) e.stage = 3;
    const add = async (treeId: string, base: string) => {
      for (const entry of await this.treeEntries(treeId)) {
        const path = base + entry.name;
        const nameBytes = pathspecName(path);
        if ((entry.mode & S_IFMT) === 0o040000) {
          const dirBytes = `${nameBytes}/`;
          if (prefix && !prefix.startsWith(dirBytes) && !dirBytes.startsWith(prefix)) continue;
          await add(entry.id, `${path}/`);
          continue;
        }
        if (prefix && !nameBytes.startsWith(prefix)) continue;
        list.push({
          path,
          mode: entry.mode,
          objectId: entry.id,
          stage: 1,
          assumeValid: false,
          skipWorktree: false,
          intentToAdd: false,
          shadowed: false,
        });
      }
    };
    await add(tree, "");
    list.sort((a, b) => compareGitPaths(a.path, b.path) || a.stage - b.stage);
    let lastStage0: string | undefined;
    for (const e of list) {
      if (e.stage === 0) lastStage0 = e.path;
      else if (e.stage === 1 && lastStage0 === e.path) e.shadowed = true;
    }
  }

  /** fill_directory: the untracked (or with `-i` ignored) paths, as dir.c's walk finds them. */
  private async walkOthers(
    worktree: Worktree,
    items: PathspecItem[],
    list: ListedEntry[],
    rules: ExcludeRules | undefined,
  ): Promise<string[]> {
    const base: UntrackedScanHost = worktree.untrackedScanHost
      ? await worktree.untrackedScanHost()
      : await walkUntrackedScanHost(worktree);
    const host: UntrackedScanHost = {
      listDirectory: (path, readdirOrder) => base.listDirectory(path, readdirOrder),
      lstat: (path) => base.lstat(path),
      isNestedRepository: (path) => base.isNestedRepository(path),
      loadIgnoreFile: async (dir) => {
        await rules?.load(dir);
        return { kind: "missing" };
      },
      isExcluded: (path, isDirectory) => rules?.isExcluded(path, isDirectory) ?? false,
    };
    let flags = 0;
    if (this.ignored) flags |= DIR_SHOW_IGNORED;
    if (this.directory) flags |= DIR_SHOW_OTHER_DIRECTORIES;
    if (this.hideEmptyDirectories) flags |= DIR_HIDE_EMPTY_DIRECTORIES;
    if (!this.others) flags |= DIR_COLLECT_KILLED_ONLY;
    const ignoreCase = coreBool(this.workingCopy, "ignorecase", false);
    const paths: string[] = [];
    const gitlinks: string[] = [];
    let last: string | undefined;
    for (const e of list) {
      if (e.path === last) continue;
      last = e.path;
      paths.push(e.path);
      if (e.mode === FileMode.GITLINK) gitlinks.push(e.path);
    }
    const index = new IndexPathLookup(paths, { ignoreCase, gitlinks, sorted: true });
    const result = await scanUntracked(host, {
      isTracked: (p) => index.has(p),
      isTrackedExactly: (p) => index.hasExactly(p),
      trackedIn: (dir) => index.trackedIn(dir),
      indexDirectory: (dir) => index.indexDirectory(dir),
      flags,
      allEntries: true,
      ...(items.length > 0 ? { matcher: untrackedScanPathspec(items) } : {}),
      onUnreadable: (path, error) => this.warn(unreadableDirectoryWarning(path, error)),
    });
    return result.paths;
  }

  /** The exclude rules of `-x`, `-X`, `--exclude-per-directory` and `--exclude-standard`. */
  private async excludeRules(
    worktree: Worktree | undefined,
    list: ListedEntry[],
  ): Promise<ExcludeRules> {
    const environment = hostEnvironmentOf(this.workingCopy);
    const top = worktree?.hostPath;
    const config = RemoteConfigStore.from(this.workingCopy);
    const readHostFile = async (path: string): Promise<Uint8Array | undefined> => {
      const absolute = path.startsWith("/") ? path : top ? `${top}/${path}` : undefined;
      if (absolute && environment) {
        const bytes = await environment.readFile(absolute).catch(() => undefined);
        if (bytes) return bytes;
      }
      if (!path.startsWith("/") && worktree) {
        if (path.startsWith(".git/") && worktree.readGitDirFile) {
          return worktree.readGitDirFile(path.slice(5)).catch(() => undefined);
        }
        return readAll(worktree.readContent(path)).catch(() => undefined);
      }
      return undefined;
    };
    const files: IgnoreNode[] = [];
    const parse = (bytes: Uint8Array) => {
      const node = createIgnoreNode();
      node.parse(decodeGitPatternFile(bytes));
      return node;
    };
    for (const source of this.excludeSources) {
      if (source.kind === "file") {
        const bytes = await readHostFile(source.path);
        if (!bytes) throw new PlumbingError(`fatal: cannot use ${source.path} as an exclude file`);
        files.push(parse(bytes));
        continue;
      }
      // setup_standard_excludes: core.excludesFile (else XDG), then info/exclude
      const configured = config.value("core.excludesFile");
      const excludesFile =
        configured !== undefined && configured !== ""
          ? environment
            ? expandUserPath(configured, environment)
            : configured
          : environment
            ? xdgConfigPath(environment, "ignore")
            : undefined;
      if (excludesFile) {
        const bytes = await readHostFile(excludesFile);
        if (bytes) files.push(parse(bytes));
      }
      const info = await worktree?.readGitDirFile?.("info/exclude").catch(() => undefined);
      if (info) files.push(parse(info));
    }
    const perDir = this.excludePerDirectory;
    const skipWorktree = new Map<string, string>();
    for (const e of list) if (e.stage === 0 && e.skipWorktree) skipWorktree.set(e.path, e.objectId);
    const readPerDir = async (path: string): Promise<string | undefined> => {
      if (worktree) {
        const entry = await worktree.getEntry(path).catch(() => undefined);
        if (entry && !entry.isDirectory && entry.mode !== FileMode.SYMLINK) {
          const bytes = await readAll(worktree.readContent(path)).catch(() => undefined);
          if (bytes) return decodeGitPatternFile(bytes);
        }
        if (entry) return undefined;
      }
      // read_skip_worktree_file_from_index
      const id = skipWorktree.get(path);
      if (!id) return undefined;
      const content = await this.blobs.load(id).catch(() => undefined);
      return content ? decodeGitPatternFile(await readAll(content)) : undefined;
    };
    return new ExcludeRules(
      this.excludes.length > 0 ? createCommandLineExcludes(this.excludes) : undefined,
      files,
      perDir,
      coreBool(this.workingCopy, "ignorecase", false),
      readPerDir,
    );
  }

  /** write_eolinfo: `i/<index> w/<worktree> attr/<attributes>\t`. */
  private async eolColumns(
    worktree: Worktree | undefined,
    list: ListedEntry[],
  ): Promise<(path: string, e: ListedEntry | undefined) => Promise<string>> {
    const ws = worktree ?? this.worktreeAccess;
    return async (path, e) => {
      const i = e && isRegularMode(e.mode) ? await this.indexEolInfo(list, e.path) : "";
      const w = ws ? await worktreeEolInfo(ws, path) : "";
      const a = (await ws?.contentFilter?.eolAttribute?.(path).catch(() => "")) ?? "";
      return `i/${i.padEnd(5)} w/${w.padEnd(5)} attr/${a.padEnd(17)}\t`;
    };
  }

  /** get_cached_convert_stats_ascii: the stage-0 (else stage-2) blob of `path`. */
  private async indexEolInfo(list: ListedEntry[], path: string): Promise<string> {
    let found: ListedEntry | undefined;
    for (const e of list) {
      if (e.path !== path || e.shadowed) continue;
      if (e.stage === 0) {
        found = e;
        break;
      }
      if (e.stage === 2) found = e;
    }
    if (!found) return eolStatsAscii(undefined);
    const content = await this.blobs.load(found.objectId).catch(() => undefined);
    return eolStatsAscii(content ? await readAll(content) : undefined);
  }

  /** show_ce_fmt: one entry through `--format`. */
  private async formatEntry(
    e: ListedEntry,
    worktree: Worktree | undefined,
    list: ListedEntry[],
    nameText: (path: string) => string,
  ): Promise<string> {
    const format = this.format as string;
    const ws = worktree ?? this.worktreeAccess;
    let out = "";
    let i = 0;
    while (i < format.length) {
      const pct = format.indexOf("%", i);
      if (pct < 0) {
        out += format.slice(i);
        break;
      }
      out += format.slice(i, pct);
      const rest = format.slice(pct + 1);
      if (rest.startsWith("%")) {
        out += "%";
        i = pct + 2;
        continue;
      }
      if (rest.startsWith("n")) {
        out += "\n";
        i = pct + 2;
        continue;
      }
      if (rest.startsWith("x") && /^[0-9a-fA-F]{2}/.test(rest.slice(1))) {
        out += String.fromCharCode(Number.parseInt(rest.slice(1, 3), 16));
        i = pct + 4;
        continue;
      }
      if (!rest.startsWith("(")) {
        throw new PlumbingError(
          `fatal: bad ls-files format: element '${rest}' does not start with '('`,
        );
      }
      const end = rest.indexOf(")", 1);
      if (end < 0) {
        throw new PlumbingError(
          `fatal: bad ls-files format: element '${rest}' does not end in ')'`,
        );
      }
      const atom = rest.slice(0, end + 1);
      i = pct + 1 + atom.length;
      const type = objectTypeOfMode(e.mode);
      switch (atom) {
        case "(objectmode)":
          out += e.mode.toString(8).padStart(6, "0");
          break;
        case "(objectname)":
          out += await this.abbreviated(e.objectId);
          break;
        case "(objecttype)":
          out += type;
          break;
        case "(objectsize:padded)":
        case "(objectsize)": {
          const padded = atom === "(objectsize:padded)";
          let text = "-";
          if (type === "blob") {
            const size = await this.blobs.size(e.objectId).catch(() => undefined);
            if (size === undefined) {
              throw new PlumbingError(`fatal: could not get object info about '${e.objectId}'`);
            }
            text = String(size);
          }
          out += padded ? text.padStart(7) : text;
          break;
        }
        case "(stage)":
          out += String(e.stage);
          break;
        case "(eolinfo:index)":
          out += isRegularMode(e.mode) ? await this.indexEolInfo(list, e.path) : "";
          break;
        case "(eolinfo:worktree)":
          out += ws ? await worktreeEolInfo(ws, e.path) : "";
          break;
        case "(eolattr)":
          out += (await ws?.contentFilter?.eolAttribute?.(e.path).catch(() => "")) ?? "";
          break;
        case "(path)":
          out += nameText(e.path);
          break;
        default:
          throw new PlumbingError(`fatal: bad ls-files format: %${atom}`);
      }
    }
    return out;
  }
}

/** The rules `is_excluded` asks: command line, per-directory files, exclude files. */
class ExcludeRules {
  private readonly dirs = new Map<string, IgnoreNode | null>();

  constructor(
    private readonly commandLine: IgnoreNode | undefined,
    /** The exclude files in the order added (the last added asked first) */
    private readonly files: IgnoreNode[],
    private readonly perDirectory: string | undefined,
    private readonly ignoreCase: boolean,
    private readonly readFile: (path: string) => Promise<string | undefined>,
  ) {}

  /** Reads `dir`'s per-directory exclude file (once). */
  async load(dir: string): Promise<void> {
    if (!this.perDirectory || this.dirs.has(dir)) return;
    this.dirs.set(dir, null);
    const text = await this.readFile(dir ? `${dir}/${this.perDirectory}` : this.perDirectory);
    if (text === undefined) return;
    const node = createIgnoreNode();
    node.parse(text);
    this.dirs.set(dir, node);
  }

  /** Reads the per-directory files of every directory above `path`. */
  async loadFor(path: string): Promise<void> {
    if (!this.perDirectory) return;
    await this.load("");
    for (let k = path.indexOf("/"); k > 0; k = path.indexOf("/", k + 1)) {
      await this.load(path.slice(0, k));
    }
  }

  /** last_matching_pattern_from_lists: true excluded, false re-included, undefined none. */
  private match(path: string, isDirectory: boolean): boolean | undefined {
    const cmdl = this.commandLine?.checkIgnored(path, isDirectory, this.ignoreCase);
    if (cmdl !== undefined) return cmdl;
    let dir = path;
    for (;;) {
      const slash = dir.lastIndexOf("/");
      dir = slash < 0 ? "" : dir.slice(0, slash);
      const node = this.dirs.get(dir);
      if (node) {
        const relative = dir ? path.slice(dir.length + 1) : path;
        const result = node.checkIgnored(relative, isDirectory, this.ignoreCase);
        if (result !== undefined) return result;
      }
      if (dir === "") break;
    }
    for (let i = this.files.length - 1; i >= 0; i--) {
      const result = (this.files[i] as IgnoreNode).checkIgnored(path, isDirectory, this.ignoreCase);
      if (result !== undefined) return result;
    }
    return undefined;
  }

  /** is_excluded: the path, or a directory above it, matches an exclude pattern. */
  isExcluded(path: string, isDirectory: boolean): boolean {
    const clean = path.endsWith("/") ? path.slice(0, -1) : path;
    for (let k = clean.indexOf("/"); k > 0; k = clean.indexOf("/", k + 1)) {
      if (this.match(clean.slice(0, k), true) === true) return true;
    }
    return this.match(clean, isDirectory) === true;
  }
}

/** git's tag letter in lowercase (`-v` for an assume-unchanged entry). */
function lowerTag(tag: string): string {
  const c = tag[0] as string;
  if (/[A-Za-z]/.test(c)) return c.toLowerCase() + tag.slice(1);
  if (c === "?") return `!${tag.slice(1)}`;
  return `v${c} `;
}

/** object_type of an index mode. */
function objectTypeOfMode(mode: number): string {
  if ((mode & S_IFMT) === 0o040000) return "tree";
  if (mode === FileMode.GITLINK) return "commit";
  return "blob";
}

/**
 * show_killed_files' test of one walked path: a leading directory of it is an index file, or
 * (for the last component) the index has entries below it.
 */
function isKilled(list: readonly ListedEntry[], name: string): boolean {
  const len = name.length;
  for (let cp = 0; cp < len; ) {
    const sp = name.indexOf("/", cp);
    if (sp < 0) {
      let pos = -namePos(list, name) - 1;
      while (pos < list.length && (list[pos] as ListedEntry).stage !== 0) pos++;
      if (pos >= list.length) return false;
      const next = (list[pos] as ListedEntry).path;
      return len < next.length && next.startsWith(name) && next[len] === "/";
    }
    if (namePos(list, name.slice(0, sp)) >= 0) return true;
    cp = sp + 1;
  }
  return false;
}

/** Whether the index has an entry (any stage) at exactly `name`. */
function isInIndex(list: readonly ListedEntry[], name: string): boolean {
  const pos = namePos(list, name);
  if (pos >= 0) return true;
  const next = list[-pos - 1];
  return next !== undefined && next.path === name;
}

/** index_name_pos for stage 0: the position, else -(insertion point) - 1. */
function namePos(list: readonly ListedEntry[], name: string): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const e = list[mid] as ListedEntry;
    const cmp = compareGitPaths(e.path, name) || e.stage;
    if (cmp === 0) return mid;
    if (cmp < 0) lo = mid + 1;
    else hi = mid;
  }
  return -lo - 1;
}

/** get_wt_convert_stats_ascii of a regular file (no link, no directory), else "". */
async function worktreeEolInfo(worktree: Worktree, path: string): Promise<string> {
  if (path.endsWith("/")) return "";
  const entry = await worktree.getEntry(path).catch(() => undefined);
  if (
    !entry ||
    entry.isDirectory ||
    entry.mode === FileMode.SYMLINK ||
    entry.mode === FileMode.GITLINK
  )
    return "";
  const bytes = await readAll(worktree.readContent(path)).catch(() => undefined);
  return bytes ? eolStatsAscii(bytes) : "";
}

async function readAll(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
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
}

const SHORT_MAGIC = new Set([..."!\"#%&',-;<=>@_`~^/"]);

/** A pathspec element read against the current directory (`:(top)` and `:/` from the top). */
function prefixedElement(arg: string, prefix: string): string {
  if (!prefix) return arg;
  if (arg.startsWith(":(")) {
    const close = arg.indexOf(")");
    if (close < 0) return arg;
    const words = arg
      .slice(2, close)
      .split(",")
      .map((w) => w.trim());
    if (words.includes("top")) return arg;
    return arg.slice(0, close + 1) + prefix + arg.slice(close + 1);
  }
  if (arg.startsWith(":")) {
    let i = 1;
    while (i < arg.length && arg[i] !== ":" && SHORT_MAGIC.has(arg[i] as string)) i++;
    const magic = arg.slice(1, i);
    if (magic.includes("/")) return arg;
    if (arg[i] === ":") i++;
    return `${arg.slice(0, i)}${prefix}${arg.slice(i)}`;
  }
  return prefix + arg;
}

/**
 * path.c's `relative_path(in, prefix)`: `in` (from the top) as seen from the directory
 * `prefix` (from the top, ending with `/`), with `../` to climb.
 */
export function relativeGitPath(input: string, prefix: string): string {
  const inLen = input.length;
  const prefixLen = prefix.length;
  if (!inLen) return "./";
  if (!prefixLen) return input;
  let inOff = 0;
  let prefixOff = 0;
  let i = 0;
  let j = 0;
  while (i < prefixLen && j < inLen && prefix[i] === input[j]) {
    if (prefix[i] === "/") {
      while (prefix[i] === "/") i++;
      while (input[j] === "/") j++;
      prefixOff = i;
      inOff = j;
    } else {
      i++;
      j++;
    }
  }
  if (i >= prefixLen && prefixOff < prefixLen) {
    if (j >= inLen) inOff = inLen;
    else if (input[j] === "/") {
      while (input[j] === "/") j++;
      inOff = j;
    } else i = prefixOff;
  } else if (j >= inLen && inOff < inLen) {
    if (prefix[i] === "/") {
      while (prefix[i] === "/") i++;
      inOff = inLen;
    }
  }
  const rest = input.slice(inOff);
  if (i >= prefixLen) return rest.length === 0 ? "./" : rest;
  let out = "";
  while (i < prefixLen) {
    if (prefix[i] === "/") {
      out += "../";
      while (prefix[i] === "/") i++;
      continue;
    }
    i++;
  }
  if (prefix[prefixLen - 1] !== "/") out += "../";
  return out + rest;
}
