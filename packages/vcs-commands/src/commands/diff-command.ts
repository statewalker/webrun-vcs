import type { FileModeValue, ObjectId } from "@statewalker/vcs-core";
import { ByteSink, type XdiffAlgorithm } from "@statewalker/vcs-utils";
import {
  compareWithWorktree,
  readCleanContent,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { DEFAULT_RENAME_LIMIT, detectRenames, scorePercent } from "../rename/index.js";
import { ChangeType, type DiffEntry } from "../results/diff-entry.js";
import { diffEntryToPair } from "../results/diff-formatter.js";
import {
  computeDiffstat,
  contentSide,
  type DiffDriver,
  type DiffFilePair,
  type DiffOutputOptions,
  type DiffstatOptions,
  diffDriverOf,
  formatNameOnly,
  formatNameStatus,
  formatNumstat,
  formatShortstat,
  formatStat,
  writePairPatch,
} from "../results/diff-output.js";
import { quotePath } from "../results/quote-path.js";
import { worktreeModeTrust } from "./core-config.js";

/** The output formats of {@link DiffCommand.callText} */
export type DiffOutputFormat =
  | "patch"
  | "stat"
  | "numstat"
  | "shortstat"
  | "name-only"
  | "name-status";

/** Options of the text output that `git diff` takes on its command line */
export interface DiffTextOptions
  extends Omit<DiffOutputOptions, "driver" | "algorithm" | "indentHeuristic"> {
  /** `--diff-algorithm` (default `diff.algorithm`, else myers) */
  algorithm?: XdiffAlgorithm;
  /** `--indent-heuristic` / `--no-indent-heuristic` (default `diff.indentHeuristic`, true) */
  indentHeuristic?: boolean;
  /** `--stat=...` widths (default width 80, as git without a terminal) */
  stat?: DiffstatOptions;
  /**
   * Score renames counting a last line without a newline, as git 2.50 and later (default
   * true); false scores them as older git
   */
  renameCountLastSpan?: boolean;
  /**
   * With whitespace-ignoring options (`-w`, `-b`, `--ignore-space-at-eol`,
   * `--ignore-cr-at-eol`), `--name-only` and `--name-status` list only the files whose patch
   * shows a change, as git 2.5x does (default true; false lists every changed file, as
   * older git)
   */
  namesFromContents?: boolean;
}

/** One side of a path in a tree, the index or the worktree */
interface Side {
  mode: number;
  id: ObjectId;
  read?: () => Promise<Uint8Array>;
}

const S_IFMT = 0o170000;
const GITLINK = 0o160000;
const NULL_ID = "0".repeat(40);
const encoder = new TextEncoder();

/** git's path order: bytes, as `strcmp` */
function compareBytes(a: string, b: string): number {
  const ea = encoder.encode(a);
  const eb = encoder.encode(b);
  const n = Math.min(ea.length, eb.length);
  for (let i = 0; i < n; i++) if (ea[i] !== eb[i]) return ea[i] - eb[i];
  return ea.length - eb.length;
}

function boolValue(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "no" || s === "off") return false;
  const n = Number(s);
  return Number.isInteger(n) ? n !== 0 : undefined;
}

function intValue(value: string | undefined): number | undefined {
  const m = value?.trim().match(/^(-?\d+)([kmg]?)$/i);
  if (!m) return undefined;
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()] ?? 1;
  return Number(m[1]) * unit;
}

function renamesValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "copies" || v === "copy") return true;
  return boolValue(v);
}

const ALGORITHMS: readonly string[] = ["myers", "minimal", "patience", "histogram"];
const algorithmValue = (v: string | undefined): XdiffAlgorithm | undefined => {
  const s = v?.trim().toLowerCase();
  if (s === "default") return "myers";
  return s && ALGORITHMS.includes(s) ? (s as XdiffAlgorithm) : undefined;
};

/**
 * Show changes between commits, trees, the index and the worktree.
 *
 * Equivalent to `git diff`:
 * - `setOldTree(a).setNewTree(b)`: `git diff a b`
 * - `setCached(true)` (with `setOldTree(a)`): `git diff --cached [a]` (HEAD by default)
 * - nothing set: `git diff`, the index against the worktree
 * - `setOldTree(a)` alone: `git diff a`, a commit against the worktree
 *
 * Without a worktree, the last two compare with HEAD's tree.
 *
 * `call()` gives the changed paths; `callText()` prints them as git does (patch, `--stat`,
 * `--numstat`, `--shortstat`, `--name-only`, `--name-status`), byte for byte, reading
 * `diff.algorithm`, `diff.indentHeuristic`, `diff.context`, `diff.interHunkContext`,
 * `diff.renames`, `diff.renameLimit`, `diff.statNameWidth`, `diff.statGraphWidth`,
 * `core.quotePath`, `core.bigFileThreshold` and the `diff` attribute's drivers
 * (`diff.<driver>.xfuncname`, `.funcname`, `.binary`, `.algorithm`, builtin drivers).
 *
 * @example
 * ```typescript
 * // Compare two commits
 * const entries = await git.diff().setOldTree(commitA).setNewTree(commitB).call();
 *
 * // `git diff --cached --stat`
 * const stat = await git.diff().setCached(true).callText("stat");
 *
 * // `git diff -U1 -w`
 * const patch = await git.diff().setOptions({ context: 1, ignoreWhitespace: true }).callText();
 * ```
 */
export class DiffCommand extends GitCommand<DiffEntry[]> {
  private oldTree?: string;
  private newTree?: string;
  private cached = false;
  private pathFilter?: string;
  private renames?: boolean;
  private renameLimit?: number;
  private textOptions: DiffTextOptions = {};

  /**
   * Set the old (base) tree/commit for comparison.
   *
   * Can be a commit ID, branch name, tag name, or tree ID.
   * If not set, defaults to HEAD (or the index, for the worktree diff).
   *
   * @param refOrId Commit-ish or tree ID
   */
  setOldTree(refOrId: string): this {
    this.checkCallable();
    this.oldTree = refOrId;
    return this;
  }

  /**
   * Set the new tree/commit for comparison.
   *
   * Can be a commit ID, branch name, tag name, or tree ID.
   * If not set and cached=true, compares to the index; otherwise to the worktree (HEAD's
   * tree when there is none).
   *
   * @param refOrId Commit-ish or tree ID
   */
  setNewTree(refOrId: string): this {
    this.checkCallable();
    this.newTree = refOrId;
    return this;
  }

  /**
   * Compare HEAD (or the old tree) to the index instead of the worktree.
   *
   * Equivalent to `git diff --cached` or `git diff --staged`.
   *
   * @param cached Whether to compare to staging
   */
  setCached(cached: boolean): this {
    this.checkCallable();
    this.cached = cached;
    return this;
  }

  /**
   * Filter results to only paths starting with this prefix.
   *
   * @param path Path prefix to filter by
   */
  setPathFilter(path: string): this {
    this.checkCallable();
    this.pathFilter = path;
    return this;
  }

  /**
   * Detect renames (`-M`, `--no-renames`). Default: off for `call()` (each path as added and
   * deleted), `diff.renames` (default on) for `callText()`.
   */
  setRenames(renames: boolean): this {
    this.checkCallable();
    this.renames = renames;
    return this;
  }

  /** `-l<n>`: the rename limit (default `diff.renameLimit`, 1000) */
  setRenameLimit(limit: number): this {
    this.checkCallable();
    this.renameLimit = limit;
    return this;
  }

  /** Text output options: context, algorithm, whitespace, `--stat` widths, ... */
  setOptions(options: DiffTextOptions): this {
    this.checkCallable();
    this.textOptions = { ...this.textOptions, ...options };
    return this;
  }

  /**
   * Execute the diff.
   *
   * @returns List of diff entries representing changes, in git's path order
   */
  async call(): Promise<DiffEntry[]> {
    this.checkCallable();
    this.setCallable(false);
    return this.collect(this.renames ?? false);
  }

  /** Execute the diff and print it as `git diff` does, in the given format. */
  async callText(format: DiffOutputFormat = "patch"): Promise<string> {
    return new TextDecoder().decode(await this.callBytes(format));
  }

  /** {@link callText} as bytes (file content that is not UTF-8 kept as it is). */
  async callBytes(format: DiffOutputFormat = "patch"): Promise<Uint8Array> {
    this.checkCallable();
    this.setCallable(false);
    const config = this.config;
    const renames = this.renames ?? renamesValue(config.value("diff.renames")) ?? true;
    const entries = await this.collect(renames);
    const options = this.outputOptions();
    const pairs: DiffFilePair[] = [];
    const unmerged = new Set<DiffFilePair>();
    for (const entry of entries) {
      // an unmerged path: only its name is printed
      const pair: DiffFilePair = entry.unmerged
        ? {
            status: "M",
            old: contentSide(entry.oldPath ?? "", 0, NULL_ID, async () => new Uint8Array(0)),
          }
        : diffEntryToPair(entry, this.blobs);
      if (entry.unmerged) unmerged.add(pair);
      pairs.push(pair);
    }
    const quote = options.quotePath;
    const sink = new ByteSink();
    switch (format) {
      case "patch":
        for (const pair of pairs) {
          if (unmerged.has(pair)) {
            sink.text(`* Unmerged path ${pair.new?.path ?? pair.old?.path}\n`);
          } else await writePairPatch(sink, pair, options);
        }
        break;
      case "name-only":
        sink.text(
          formatNameOnly(await this.shownNames(pairs, unmerged, options), { quotePath: quote }),
        );
        break;
      case "name-status":
        for (const pair of await this.shownNames(pairs, unmerged, options)) {
          if (unmerged.has(pair)) {
            sink.text(`U\t${quotePath(pair.new?.path ?? pair.old?.path ?? "", quote)}\n`);
          } else sink.text(formatNameStatus([pair], { quotePath: quote }));
        }
        break;
      default: {
        const files = [];
        for (const pair of pairs) {
          if (unmerged.has(pair)) {
            const name = pair.new?.path ?? pair.old?.path ?? "";
            files.push({
              name,
              isRenamed: false,
              isBinary: false,
              isUnmerged: true,
              added: 0,
              deleted: 0,
            });
          } else files.push(...(await computeDiffstat([pair], options)));
        }
        const statOptions: DiffstatOptions = {
          nameWidth: intValue(config.value("diff.statNameWidth")),
          graphWidth: intValue(config.value("diff.statGraphWidth")),
          ...this.textOptions.stat,
          quotePath: quote,
        };
        if (format === "stat") sink.text(formatStat(files, statOptions));
        else if (format === "numstat") sink.text(formatNumstat(files, { quotePath: quote }));
        else sink.text(formatShortstat(files));
      }
    }
    return sink.bytes();
  }

  /** The pairs `--name-only` lists: with whitespace options, those whose patch shows a change */
  private async shownNames(
    pairs: DiffFilePair[],
    unmerged: Set<DiffFilePair>,
    options: DiffOutputOptions,
  ): Promise<DiffFilePair[]> {
    const fromContents =
      (this.textOptions.namesFromContents ?? true) &&
      (options.ignoreWhitespace ||
        options.ignoreWhitespaceChange ||
        options.ignoreWhitespaceAtEol ||
        options.ignoreCrAtEol);
    if (!fromContents) return pairs;
    const shown: DiffFilePair[] = [];
    for (const pair of pairs) {
      if (unmerged.has(pair)) {
        shown.push(pair);
        continue;
      }
      const scratch = new ByteSink();
      await writePairPatch(scratch, pair, options);
      if (scratch.length > 0) shown.push(pair);
    }
    return shown;
  }

  private get config(): RemoteConfigStore {
    return RemoteConfigStore.from(this.workingCopy);
  }

  /** The output options: the setters', else the configuration's */
  private outputOptions(): DiffOutputOptions {
    const config = this.config;
    const get = (key: string) => config.value(key);
    const worktree = this.worktreeAccess;
    const filter = worktree?.contentFilter as
      | {
          attributes?: (
            path: string,
            names?: readonly string[],
          ) => Promise<Map<string, true | false | string | undefined>>;
        }
      | undefined;
    const drivers = new Map<string, Promise<DiffDriver | undefined>>();
    const driver = filter?.attributes
      ? (path: string) => {
          let found = drivers.get(path);
          if (!found) {
            found = (async () => {
              const attrs = await filter.attributes?.(path, ["diff"]);
              return diffDriverOf(attrs?.get("diff"), get);
            })();
            drivers.set(path, found);
          }
          return found;
        }
      : undefined;
    const {
      stat: _stat,
      renameCountLastSpan: _span,
      namesFromContents: _names,
      ...text
    } = this.textOptions;
    return {
      context: intValue(get("diff.context")) ?? 3,
      interHunkContext: intValue(get("diff.interHunkContext")) ?? 0,
      quotePath: boolValue(get("core.quotePath")) ?? true,
      ...(intValue(get("core.bigFileThreshold")) !== undefined
        ? { bigFileThreshold: intValue(get("core.bigFileThreshold")) }
        : {}),
      ...text,
      algorithm: text.algorithm ?? algorithmValue(get("diff.algorithm")) ?? "myers",
      indentHeuristic: text.indentHeuristic ?? boolValue(get("diff.indentHeuristic")) ?? true,
      ...(driver ? { driver } : {}),
    };
  }

  /** The changed paths (and renames, when asked), in git's order */
  private async collect(renames: boolean): Promise<DiffEntry[]> {
    const worktree = this.worktreeAccess;
    let oldSide: Map<string, Side>;
    let newSide: Map<string, Side>;
    const unmerged = new Set<string>();
    if (this.newTree) {
      oldSide = await this.treeSide(this.oldTree ?? "HEAD");
      newSide = await this.treeSide(this.newTree);
    } else if (this.cached) {
      oldSide = await this.treeSide(this.oldTree ?? "HEAD");
      newSide = await this.indexSide(unmerged);
    } else if (worktree) {
      const run = async () => {
        if (this.oldTree) {
          const old = await this.treeSide(this.oldTree);
          return [old, await this.worktreeSide(worktree, unmerged)] as const;
        }
        const index = await this.indexSide(unmerged);
        return [index, await this.worktreeSide(worktree, unmerged)] as const;
      };
      [oldSide, newSide] = worktree.batch ? await worktree.batch(run) : await run();
    } else {
      // no worktree: HEAD against HEAD (the old tree against HEAD)
      oldSide = await this.treeSide(this.oldTree ?? "HEAD");
      newSide = await this.treeSide("HEAD");
    }
    const entries = this.pairUp(oldSide, newSide, unmerged);
    if (renames) await this.detectRenames(entries);
    return entries;
  }

  private matches(path: string): boolean {
    return !this.pathFilter || path.startsWith(this.pathFilter);
  }

  private pairUp(
    oldSide: Map<string, Side>,
    newSide: Map<string, Side>,
    unmerged: Set<string>,
  ): DiffEntry[] {
    const paths = new Set<string>([...oldSide.keys(), ...newSide.keys(), ...unmerged]);
    const sorted = [...paths].filter((p) => this.matches(p)).sort(compareBytes);
    const entries: DiffEntry[] = [];
    for (const path of sorted) {
      if (unmerged.has(path)) {
        entries.push({
          changeType: ChangeType.MODIFY,
          oldPath: path,
          newPath: path,
          unmerged: true,
        });
        continue;
      }
      const a = oldSide.get(path);
      const b = newSide.get(path);
      if (a && !b) {
        entries.push({
          changeType: ChangeType.DELETE,
          oldPath: path,
          oldId: a.id,
          oldMode: a.mode as FileModeValue,
        });
      } else if (!a && b) {
        entries.push({
          changeType: ChangeType.ADD,
          newPath: path,
          newId: b.id,
          newMode: b.mode as FileModeValue,
          ...(b.read ? { readNew: b.read } : {}),
        });
      } else if (a && b && (a.id !== b.id || a.mode !== b.mode)) {
        entries.push({
          changeType: ChangeType.MODIFY,
          oldPath: path,
          newPath: path,
          oldId: a.id,
          newId: b.id,
          oldMode: a.mode as FileModeValue,
          newMode: b.mode as FileModeValue,
          ...(b.read ? { readNew: b.read } : {}),
        });
      }
    }
    return entries;
  }

  /** git's `diffcore_rename` over the added and deleted paths */
  private async detectRenames(entries: DiffEntry[]): Promise<void> {
    const sources = entries.filter((e) => e.changeType === ChangeType.DELETE);
    const destinations = entries.filter((e) => e.changeType === ChangeType.ADD);
    if (sources.length === 0 || destinations.length === 0) return;
    const byPath = new Map<string, DiffEntry>();
    for (const e of sources) byPath.set(`s:${e.oldPath}`, e);
    for (const e of destinations) byPath.set(`d:${e.newPath}`, e);
    const readBlob = async (id: ObjectId) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const c of (await this.blobs.load(id)) ?? []) {
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
    const limit =
      this.renameLimit ?? intValue(this.config.value("diff.renameLimit")) ?? DEFAULT_RENAME_LIMIT;
    const pairs = await detectRenames(
      sources.map((e) => ({ path: e.oldPath ?? "", mode: e.oldMode ?? 0, id: e.oldId ?? "" })),
      destinations.map((e) => ({ path: e.newPath ?? "", mode: e.newMode ?? 0, id: e.newId ?? "" })),
      {
        renameLimit: limit,
        countLastSpan: this.textOptions.renameCountLastSpan,
        size: async (c, role) => {
          const e = byPath.get(`${role === "source" ? "s" : "d"}:${c.path}`);
          if (role === "destination" && e?.readNew) return (await e.readNew()).length;
          try {
            return await this.blobs.size(c.id);
          } catch {
            return undefined;
          }
        },
        load: async (c, role) => {
          const e = byPath.get(`${role === "source" ? "s" : "d"}:${c.path}`);
          if (role === "destination" && e?.readNew) return e.readNew();
          return readBlob(c.id);
        },
      },
    );
    const drop = new Set<DiffEntry>();
    for (const pair of pairs) {
      const src = byPath.get(`s:${pair.from}`);
      const dst = byPath.get(`d:${pair.to}`);
      if (!src || !dst) continue;
      drop.add(src);
      dst.changeType = ChangeType.RENAME;
      dst.oldPath = src.oldPath;
      dst.oldId = src.oldId;
      dst.oldMode = src.oldMode;
      dst.score = scorePercent(pair.score);
    }
    if (drop.size > 0) {
      const kept = entries.filter((e) => !drop.has(e));
      entries.splice(0, entries.length, ...kept);
    }
  }

  /** The blobs of a commit's (or tree's) tree, by path */
  private async treeSide(refOrId: string): Promise<Map<string, Side>> {
    const out = new Map<string, Side>();
    let treeId: ObjectId;
    try {
      treeId = await this.resolveTreeId(refOrId);
    } catch {
      return out;
    }
    await this.collectTreeEntries(treeId, "", out);
    return out;
  }

  /** The index's stage-0 entries (intent-to-add ones left out: not in the index yet) */
  private async indexSide(unmerged: Set<string>): Promise<Map<string, Side>> {
    const out = new Map<string, Side>();
    for await (const entry of this.staging.entries()) {
      if (entry.stage !== 0) {
        unmerged.add(entry.path);
        continue;
      }
      if (entry.intentToAdd) continue;
      out.set(entry.path, { mode: entry.mode, id: entry.objectId });
    }
    return out;
  }

  /**
   * The worktree as `diff-files` and `diff-index` see it: each index
   * entry's file, its stat-clean entries taken from the index, changed ones read and hashed
   * as `git add` would store them; deleted files left out
   */
  private async worktreeSide(
    worktree: Worktree,
    unmerged: Set<string>,
  ): Promise<Map<string, Side>> {
    const out = new Map<string, Side>();
    const trust = worktreeModeTrust(this.workingCopy, worktree);
    const indexTime = this.staging.getUpdateTime();
    for await (const entry of this.staging.entries()) {
      if (entry.stage !== 0) {
        unmerged.add(entry.path);
        continue;
      }
      if (!this.matches(entry.path)) continue;
      const indexSide: Side = { mode: entry.mode, id: entry.objectId };
      if (entry.skipWorktree || entry.assumeValid) {
        if (!entry.intentToAdd) out.set(entry.path, indexSide);
        continue;
      }
      const result = await compareWithWorktree(worktree, entry, { trust, indexTime });
      if (result.kind === "deleted") continue;
      if (!result.kind && !entry.intentToAdd) {
        out.set(entry.path, indexSide);
        continue;
      }
      const mode = result.worktreeMode ?? entry.mode;
      if (mode === GITLINK) {
        out.set(entry.path, { mode, id: result.hashedId ?? entry.objectId });
        continue;
      }
      const path = entry.path;
      const id = result.hashedId ?? (await worktree.computeHash(path));
      let content: Promise<Uint8Array> | undefined;
      const read = () => {
        content ??= readCleanContent(worktree, path);
        return content;
      };
      if (!entry.intentToAdd && id === entry.objectId && mode === entry.mode) {
        out.set(path, indexSide);
        continue;
      }
      out.set(path, { mode, id, read });
    }
    return out;
  }

  /**
   * Resolve a ref to its tree ID.
   */
  private async resolveTreeId(refOrId: string): Promise<ObjectId> {
    try {
      const commitId = await this.resolveRef(refOrId);
      const commit = await this.commits.load(commitId);
      if (!commit) return refOrId;
      return commit.tree;
    } catch {
      if (refOrId === "HEAD") throw new Error("no HEAD");
      return refOrId;
    }
  }

  /**
   * Collect all blob entries from a tree recursively.
   */
  private async collectTreeEntries(
    treeId: ObjectId,
    prefix: string,
    entries: Map<string, Side>,
  ): Promise<void> {
    const TREE_MODE = 0o40000;
    for await (const entry of this.trees.loadTree(treeId)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if ((entry.mode & S_IFMT) === TREE_MODE) {
        await this.collectTreeEntries(entry.id, path, entries);
      } else {
        entries.set(path, { mode: entry.mode, id: entry.id });
      }
    }
  }
}

/**
 * Format a DiffEntry for display.
 */
export function formatDiffEntry(entry: DiffEntry): string {
  switch (entry.changeType) {
    case ChangeType.ADD:
      return `A\t${entry.newPath}`;
    case ChangeType.DELETE:
      return `D\t${entry.oldPath}`;
    case ChangeType.MODIFY:
      return `M\t${entry.newPath}`;
    case ChangeType.RENAME:
      return `R${entry.score ?? 0}\t${entry.oldPath}\t${entry.newPath}`;
    case ChangeType.COPY:
      return `C${entry.score ?? 0}\t${entry.oldPath}\t${entry.newPath}`;
  }
}
