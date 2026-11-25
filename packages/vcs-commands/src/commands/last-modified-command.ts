/**
 * `git last-modified` (builtin/last-modified.c, git 2.52+): for each path of a commit's tree,
 * the commit that last changed it.
 */

import {
  type BloomFilterSettings,
  bloomFilterContains,
  bloomKey,
  type CommitGraph,
  type CommitHeader,
  type ObjectId,
} from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";

import { RefNotFoundError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { quotePath } from "../results/quote-path.js";
import { prefixedElement } from "./ls-files-command.js";
import { configBool, configValue } from "./merge-config.js";
import {
  ENTRY_NOT_INTERESTING,
  type PathspecItem,
  parsePathspec,
  type TreePathspec,
  treeEntryInteresting,
  treePathspec,
} from "./pathspec.js";
import { PlumbingCommand, PlumbingError } from "./plumbing-command.js";

const USAGE =
  "usage: git last-modified [--recursive] [--show-trees] [--max-depth=<depth>] [-z]\n" +
  "                         [<revision-range>] [[--] <pathspec>...]";

/** One line of `git last-modified`'s output. */
export interface LastModifiedEntry {
  /** The path, from the top of the worktree */
  path: string;
  /** The commit that last changed it (or the boundary commit the walk stopped at) */
  commit: ObjectId;
  /** The walk stopped at `commit` (a `-<n>` limit or an excluded commit): printed with `^` */
  boundary: boolean;
}

/** What a run did with the commit-graph's changed-path Bloom filters. */
export interface LastModifiedStatistics {
  /** First-parent comparisons a filter answered "no path changed" (no tree read) */
  bloomDefinitelyNot: number;
  /** First-parent comparisons a filter answered "maybe" */
  bloomMaybe: number;
  /** Tree comparisons made */
  treeDiffs: number;
}

/** A commit as the walk holds it (git's `struct commit` plus the object flags it uses). */
interface WalkCommit {
  id: ObjectId;
  parsed: boolean;
  tree: ObjectId;
  parents: WalkCommit[];
  /** committer date; 0 until parsed (git's `commit->date`) */
  date: number;
  /** commit-graph generation; Infinity until parsed or outside the graph */
  generation: number;
  flags: number;
  /** the paths (by `all_paths` index) still to be associated, when allocated */
  active?: Uint8Array;
}

// object flags (builtin/last-modified.c, revision.h)
const PARENT1 = 1;
const PARENT2 = 2;
const BOUNDARY = 4;
const BOTTOM = 8;

interface PathEntry {
  path: string;
  /** the path's bytes */
  bytes: Uint8Array;
  id: ObjectId;
  hash: number;
  index: number;
  key?: number[];
}

/**
 * `git last-modified`: which commit last changed each path of the tree (its files and, with
 * `setShowTrees` or without recursion, its directories), walking back from one commit.
 *
 * This is builtin/last-modified.c: the paths come from the tree of the one included revision
 * (default HEAD) limited by the pathspec and `--max-depth`; the walk takes commits newest
 * first (generation, then date) and hands each still-unexplained path on to the first parent
 * whose version of it is the same; a path no parent shares was changed by the commit. Before
 * comparing a commit with its first parent, the commit's changed-path Bloom filter (when the
 * commit-graph has one) is asked whether any of the paths may have changed; a "no" passes them
 * all to that parent without reading a tree. A path still unexplained at a boundary commit
 * (`-<n>`, an excluded commit) is printed with `^` before the boundary's id. Lines come in the
 * order git prints them: by the commit that explains them, then in the order of git's
 * hashmap of the paths.
 *
 * @example
 * ```typescript
 * const entries = await git.lastModified().setRecursive().addPaths("src").callEntries();
 * ```
 */
export class LastModifiedCommand extends PlumbingCommand {
  private maxDepth = 0;
  private showTrees = false;
  private nul = false;
  private maxCount = -1;
  private revisions: string[] = [];
  private paths: string[] = [];
  private prefix = "";
  private useBloomFilters = true;
  private statistics: LastModifiedStatistics = {
    bloomDefinitelyNot: 0,
    bloomMaybe: 0,
    treeDiffs: 0,
  };
  private entriesOut?: LastModifiedEntry[];

  /** `-r`, `--recursive`: every path below the pathspec (`--max-depth=-1`). */
  setRecursive(recursive = true): this {
    this.checkCallable();
    this.maxDepth = recursive ? -1 : 0;
    return this;
  }

  /** `-t`, `--show-trees`: directories too when recursing into them. */
  setShowTrees(show = true): this {
    this.checkCallable();
    this.showTrees = show;
    return this;
  }

  /** `--max-depth=<depth>`: levels below each pathspec element (negative: no limit; default 0). */
  setMaxDepth(depth: number): this {
    this.checkCallable();
    this.maxDepth = depth;
    return this;
  }

  /** `-z`: paths unquoted, each line ended by a NUL. */
  setNullTerminated(nul = true): this {
    this.checkCallable();
    this.nul = nul;
    return this;
  }

  /** `-<n>`, `-n <n>`, `--max-count=<n>`: stop after `n` commits (the next is a boundary). */
  setMaxCount(count: number): this {
    this.checkCallable();
    this.maxCount = count;
    return this;
  }

  /**
   * Revisions as git reads them: `<rev>`, `^<rev>` and `<a>..<b>` (one included commit at
   * most). An argument starting with `-` is refused as git refuses an unknown option.
   */
  addRevisions(...revisions: string[]): this {
    this.checkCallable();
    this.revisions.push(...revisions);
    return this;
  }

  /** Pathspec elements, relative to {@link setPrefix}. */
  addPaths(...paths: string[]): this {
    this.checkCallable();
    this.paths.push(...paths);
    return this;
  }

  /** The directory below the top the command runs in (pathspecs are relative to it). */
  setPrefix(prefix: string): this {
    this.checkCallable();
    this.prefix = prefix.replace(/\/+$/, "");
    return this;
  }

  /** Whether the commit-graph's changed-path Bloom filters are asked (default true). */
  setUseBloomFilters(use: boolean): this {
    this.checkCallable();
    this.useBloomFilters = use;
    return this;
  }

  /** What the last run did with the Bloom filters. */
  getStatistics(): LastModifiedStatistics {
    return { ...this.statistics };
  }

  /**
   * Runs the command and returns its lines as entries (git's deaths thrown as
   * `PlumbingError`).
   */
  async callEntries(): Promise<LastModifiedEntry[]> {
    const entries: LastModifiedEntry[] = [];
    this.entriesOut = entries;
    const r = await this.call();
    if (r.exitCode !== 0) throw new PlumbingError(r.stderr.trimEnd(), r.exitCode);
    return entries;
  }

  protected async run(): Promise<number> {
    for (const r of this.revisions) {
      if (r.startsWith("-")) {
        throw new PlumbingError(`error: unknown last-modified argument: ${r}\n${USAGE}`, 129);
      }
    }
    const items = await this.parsePaths();
    const ps = items.length > 0 ? treePathspec(items) : undefined;
    const depthValid = this.maxDepth >= 0;
    if (ps?.hasWildcard && depthValid) {
      throw new PlumbingError("fatal: max-depth cannot be used with wildcard pathspecs");
    }
    const diff = new TreeDiff(this, ps, depthValid ? this.maxDepth : -1, this.showTrees);

    // setup_revisions: the arguments, then HEAD when none was given (rev.def)
    const commits = new Map<ObjectId, WalkCommit>();
    const lookup = (id: ObjectId): WalkCommit => {
      let c = commits.get(id);
      if (!c) {
        c = { id, parsed: false, tree: "", parents: [], date: 0, generation: Infinity, flags: 0 };
        commits.set(id, c);
      }
      return c;
    };
    const pending: { name: string; id: ObjectId; exclude: boolean }[] = [];
    const resolver = this.revisionResolver();
    const resolve = async (name: string, arg = name): Promise<ObjectId> => {
      let id: ObjectId | undefined;
      try {
        id = await resolver.resolve(name);
      } catch (e) {
        if (!(e instanceof RefNotFoundError)) throw e;
      }
      for (const w of resolver.warnings) this.warn(w);
      resolver.warnings.length = 0;
      if (id === undefined) {
        throw new PlumbingError(
          `fatal: ambiguous argument '${arg}': unknown revision or path not in the working tree.\n` +
            "Use '--' to separate paths from revisions, like this:\n" +
            "'git <command> [<revision>...] -- [<file>...]'",
        );
      }
      return id;
    };
    const revisions = this.revisions.length > 0 ? this.revisions : ["HEAD"];
    for (const arg of revisions) {
      const dots = arg.indexOf("..");
      if (dots >= 0 && arg[dots + 2] !== ".") {
        const left = arg.slice(0, dots) || "HEAD";
        const right = arg.slice(dots + 2) || "HEAD";
        pending.push({ name: left, id: await resolve(left, arg), exclude: true });
        pending.push({ name: right, id: await resolve(right, arg), exclude: false });
      } else if (dots >= 0) {
        // a symmetric difference includes both sides
        const left = arg.slice(0, dots) || "HEAD";
        const right = arg.slice(dots + 3) || "HEAD";
        pending.push({ name: left, id: await resolve(left, arg), exclude: false });
        pending.push({ name: right, id: await resolve(right, arg), exclude: false });
      } else if (arg.startsWith("^")) {
        pending.push({ name: arg.slice(1), id: await resolve(arg.slice(1)), exclude: true });
      } else {
        pending.push({ name: arg, id: await resolve(arg), exclude: false });
      }
    }

    // populate_paths_from_revs: the paths of the one included commit's tree
    const included = pending.filter((p) => !p.exclude);
    if (included.length > 1) {
      this.warn("error: last-modified can only operate on one commit at a time");
      return 255;
    }
    const paths = new GitHashmapOrder();
    let start: WalkCommit | undefined;
    for (const p of included) {
      const commitId = await resolver.peelToType(p.id, "commit");
      if (commitId === undefined) {
        const type = (await resolver.objectType(p.id)) ?? "bad object";
        this.warn(`error: revision argument '${p.name}' is a ${type}, not a commit-ish`);
        return 255;
      }
      start = lookup(commitId);
    }

    const shallow = new Set((await this.refsStore.getShallow?.().catch(() => undefined)) ?? []);
    const reader = await this.commits.headerReader?.().catch(() => undefined);
    const graph =
      shallow.size > 0 ? undefined : await this.commits.commitGraph?.get().catch(() => undefined);
    const parse = async (c: WalkCommit): Promise<boolean> => {
      if (c.parsed) return true;
      let header: CommitHeader | undefined;
      if (reader) header = await reader.getHeader(c.id).catch(() => undefined);
      else {
        const commit = await this.commits.load(c.id).catch(() => undefined);
        header = commit && {
          tree: commit.tree,
          parents: commit.parents,
          commitTime: commit.committer.timestamp,
          generation: Infinity,
        };
      }
      if (!header) return false;
      c.parsed = true;
      c.tree = header.tree;
      c.date = header.commitTime;
      c.generation = shallow.size > 0 ? Infinity : header.generation;
      c.parents = shallow.has(c.id) ? [] : header.parents.map(lookup);
      return true;
    };

    if (start) {
      if (!(await parse(start))) throw new PlumbingError(`fatal: bad object ${start.id}`);
      for (const e of await diff.entries(undefined, start.tree)) paths.add(e);
    }
    const allPaths = paths.ordered();
    const byPath = new Map<string, PathEntry>();
    for (let i = 0; i < allPaths.length; i++) {
      const e = allPaths[i] as PathEntry;
      e.index = i;
      byPath.set(e.path, e);
    }
    const count = allPaths.length;

    // the Bloom filters git's maybe_changed_path asks (rev.bloom_filter_settings)
    const bloom = this.useBloomFilters ? this.bloomSettings(graph) : undefined;
    if (bloom) for (const e of allPaths) e.key = bloomKey(e.bytes, bloom.settings);

    const config = this._workingCopy.config ? RemoteConfigStore.from(this._workingCopy) : undefined;
    const quotePathValue = config?.value("core.quotePath");
    const quoteFully = quotePathValue === undefined ? true : (parseGitBool(quotePathValue) ?? true);

    const emit = async (path: string, c: WalkCommit): Promise<void> => {
      const boundary = (c.flags & BOUNDARY) !== 0;
      this.entriesOut?.push({ path, commit: c.id, boundary });
      const name = this.nul ? `${path}\0` : `${quotePath(path, quoteFully)}\n`;
      await this.write(`${boundary ? "^" : ""}${c.id}\t${name}`);
    };
    /** mark_path: emit a path still waiting (at `id`, when given), and forget it */
    const markPath = async (path: string, id: ObjectId | undefined, c: WalkCommit) => {
      const e = byPath.get(path);
      if (!e) return;
      if (id !== undefined && id !== e.id) return;
      await emit(path, c);
      byPath.delete(path);
    };
    const activeOf = (c: WalkCommit): Uint8Array => {
      c.active ??= new Uint8Array(count);
      return c.active;
    };
    const isEmpty = (bits: Uint8Array) => bits.indexOf(1) < 0;

    /** maybe_changed_path: whether `c`'s filter may hold one of the paths active in it */
    const maybeChangedPath = (c: WalkCommit, active: Uint8Array): boolean => {
      if (!bloom || !graph) return true;
      if (c.generation === Infinity) return true;
      const pos = graph.position(c.id);
      if (pos < 0) return true;
      const found = graph.bloomFilterAt(pos);
      if (!found || (bloom.version !== -1 && found.settings.hashVersion !== bloom.version)) {
        return true;
      }
      for (const e of byPath.values()) {
        if (!active[e.index]) continue;
        if (bloomFilterContains(found.data, e.key as number[]) !== 0) {
          this.statistics.bloomMaybe++;
          return true;
        }
      }
      this.statistics.bloomDefinitelyNot++;
      return false;
    };

    const queue = new PrioQueue();
    const notQueue = new PrioQueue();

    /** process_parent */
    const processParent = async (
      c: WalkCommit,
      activeC: Uint8Array,
      parent: WalkCommit,
      nth: number,
    ): Promise<void> => {
      if (!(await parse(parent))) return;
      const activeP = activeOf(parent);
      let changed: QueuedPath[] = [];
      if (nth > 0 || maybeChangedPath(c, activeC)) {
        this.statistics.treeDiffs++;
        changed = await diff.entries(parent.tree, c.tree);
      }
      const scratch = new Uint8Array(count);
      for (const fp of changed) {
        const e = byPath.get(fp.path);
        if (e && activeC[e.index]) scratch[e.index] = 1;
      }
      for (let i = 0; i < count; i++) {
        if (activeC[i] && !scratch[i]) {
          activeC[i] = 0;
          activeP[i] = 1;
        }
      }
      if (!isEmpty(activeP) && !(parent.flags & PARENT1)) {
        parent.flags |= PARENT1;
        queue.put(parent);
      }
      if (!(parent.flags & PARENT1)) parent.active = undefined;
    };

    // last_modified_run: rev.commits are the pending commits (prepare_revision_walk)
    const seen = new Set<WalkCommit>();
    const listed: WalkCommit[] = [];
    for (const p of pending) {
      const id = p.exclude ? await resolver.peelToType(p.id, "commit") : (start?.id ?? undefined);
      if (id === undefined) continue;
      const c = lookup(id);
      if (p.exclude) c.flags |= BOTTOM;
      if (!(await parse(c))) continue;
      if (!seen.has(c)) {
        seen.add(c);
        listed.push(c);
      }
    }
    for (const c of listed) {
      if (c.flags & BOTTOM) {
        notQueue.put(c);
        c.flags |= PARENT2;
      } else if (!(c.flags & PARENT1)) {
        queue.put(c);
        c.flags |= PARENT1;
        activeOf(c).fill(1);
      }
    }

    let popped = 0;
    for (let c = queue.get(); c; c = queue.get()) {
      const activeC = activeOf(c);
      if ((this.maxCount >= 0 && this.maxCount < ++popped) || c.flags & PARENT2) {
        // a boundary commit, or past the limit: what is left is explained by it
        c.flags |= PARENT2 | BOUNDARY;
        for (const e of await diff.entries(undefined, c.tree)) await markPath(e.path, e.id, c);
        c.active = undefined;
        continue;
      }
      if (await parse(c)) {
        // make sure c is not reachable from anything in the --not queue
        for (let n = notQueue.get(); n; n = notQueue.get()) {
          if (!(await parse(n))) continue;
          for (const np of n.parents) {
            if (!(np.flags & PARENT2)) {
              notQueue.put(np);
              np.flags |= PARENT2;
            }
          }
          if (n.generation < c.generation) break;
        }
        for (let nth = 0; nth < c.parents.length; nth++) {
          await processParent(c, activeC, c.parents[nth] as WalkCommit, nth);
          if (isEmpty(activeC)) break;
        }
        // the paths left, or not the same in any parent, were changed by c
        if (!isEmpty(activeC)) {
          for (let i = 0; i < count; i++) {
            if (activeC[i]) await markPath((allPaths[i] as PathEntry).path, undefined, c);
          }
        }
      }
      c.active = undefined;
    }
    return 0;
  }

  /** The pathspec, its elements relative to the prefix (prefix_path). */
  private async parsePaths(): Promise<PathspecItem[]> {
    // each element, magic ones too, read against the current directory (prefix_path_gently);
    // no element, or only excludes, is the whole tree (parse_pathspec without PREFER_CWD)
    const top = this.paths.length > 0 ? await this.hostWorkingDir() : undefined;
    const paths = this.paths.map((p) =>
      prefixedElement(p, this.prefix ? `${this.prefix}/` : "", top),
    );
    try {
      return parsePathspec(paths);
    } catch (e) {
      if (e instanceof Error && !(e instanceof PlumbingError)) {
        throw new PlumbingError(`fatal: ${e.message}`);
      }
      throw e;
    }
  }

  /**
   * get_bloom_filter_settings with `commitGraph.changedPathsVersion` (-1: any version; 0 or
   * `commitGraph.readChangedPaths=false`: none).
   */
  private bloomSettings(
    graph: CommitGraph | undefined,
  ): { settings: BloomFilterSettings; version: number } | undefined {
    const settings = graph?.bloomSettings;
    if (!settings) return undefined;
    const raw = configValue(this._workingCopy, "commitGraph.changedPathsVersion");
    const version =
      raw !== undefined && /^\s*[-+]?\d+\s*$/.test(raw)
        ? Number.parseInt(raw, 10)
        : configBool(this._workingCopy, "commitGraph.readChangedPaths", true)
          ? -1
          : 0;
    if (version === 0) return undefined;
    return { settings, version };
  }

  /** Raw tree entries (the command's tree view: replace refs applied). */
  async readTreeItems(id: ObjectId): Promise<TreeItem[]> {
    if (id === this.objectFormat.emptyTreeId) return [];
    const loaded = await this.trees.load(id);
    if (!loaded) throw new PlumbingError(`fatal: unable to read tree ${id}`);
    const out: TreeItem[] = [];
    for await (const e of loaded) {
      const name = encodeGitPath(e.name);
      out.push({ name, mode: e.mode, id: e.id, isDir: (e.mode & 0o170000) === 0o040000 });
    }
    return out;
  }
}

interface TreeItem {
  name: Uint8Array;
  mode: number;
  id: ObjectId;
  isDir: boolean;
}

/** A path diff_tree_oid queues (its `two` side: the newer tree's id, if any). */
interface QueuedPath {
  path: string;
  bytes: Uint8Array;
  id: ObjectId | undefined;
}

/**
 * git's recursive diff_tree_oid as last-modified sets it up (tree-diff.c): the pathspec,
 * `max_depth` (`check_recursion_depth`) and `tree_in_recursive` (`--show-trees`).
 */
class TreeDiff {
  private cache = new Map<ObjectId, TreeItem[]>();

  constructor(
    private readonly host: LastModifiedCommand,
    private readonly ps: TreePathspec | undefined,
    /** -1: no limit */
    private readonly maxDepth: number,
    private readonly showTrees: boolean,
  ) {}

  /** The paths that differ between `from` (undefined: empty) and `to`, in git's order. */
  async entries(from: ObjectId | undefined, to: ObjectId): Promise<QueuedPath[]> {
    const out: QueuedPath[] = [];
    await this.walk(from, to, new Uint8Array(0), out);
    return out;
  }

  private async tree(id: ObjectId | undefined): Promise<TreeItem[]> {
    if (id === undefined) return [];
    let t = this.cache.get(id);
    if (!t) {
      t = await this.host.readTreeItems(id);
      if (this.cache.size > 4096) this.cache.clear();
      this.cache.set(id, t);
    }
    return t;
  }

  private interesting(e: TreeItem, base: Uint8Array): boolean {
    if (!this.ps) return true;
    return (
      treeEntryInteresting(this.ps, e.name, 0, e.name.length, e.mode, base) > ENTRY_NOT_INTERESTING
    );
  }

  /** should_recurse / check_recursion_depth for the directory `name` (its full path). */
  private shouldRecurse(name: Uint8Array): boolean {
    if (this.maxDepth < 0) return true;
    const items = this.ps?.elements ?? [];
    if (items.length === 0) return withinDepth(name, 0, name.length, 1, this.maxDepth);
    for (let i = items.length - 1; i >= 0; i--) {
      const match = (items[i] as TreePathspec["elements"][number]).match;
      if (name.length >= match.length) {
        if (!isDirPrefix(name, match)) continue;
        return withinDepth(name, match.length, name.length, 1, this.maxDepth);
      }
      if (isDirPrefix(match, name)) return true;
    }
    return false;
  }

  private async walk(
    from: ObjectId | undefined,
    to: ObjectId | undefined,
    base: Uint8Array,
    out: QueuedPath[],
  ): Promise<void> {
    const a = (await this.tree(from)).filter((e) => this.interesting(e, base));
    const b = (await this.tree(to)).filter((e) => this.interesting(e, base));
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      const ea = a[i];
      const eb = b[j];
      const cmp = ea && eb ? baseNameCompare(ea, eb) : ea ? -1 : 1;
      if (cmp === 0) {
        i++;
        j++;
        if (ea?.mode === eb?.mode && ea?.id === eb?.id) continue;
        await this.emit(ea, eb, base, out);
      } else if (cmp < 0) {
        i++;
        await this.emit(ea, undefined, base, out);
      } else {
        j++;
        await this.emit(undefined, eb, base, out);
      }
    }
  }

  private async emit(
    a: TreeItem | undefined,
    b: TreeItem | undefined,
    base: Uint8Array,
    out: QueuedPath[],
  ): Promise<void> {
    const e = (b ?? a) as TreeItem;
    const full = new Uint8Array(base.length + e.name.length);
    full.set(base);
    full.set(e.name, base.length);
    let emitThis = true;
    let recurse = false;
    if (e.isDir && this.shouldRecurse(full)) {
      recurse = true;
      emitThis = this.showTrees;
    }
    if (emitThis) out.push({ path: decodeGitPath(full), bytes: full, id: b?.id });
    if (recurse) {
      const below = new Uint8Array(full.length + 1);
      below.set(full);
      below[full.length] = 0x2f;
      await this.walk(a?.id, b?.id, below, out);
    }
  }
}

/** base_name_compare: names compare as bytes, a directory's as if it ended in "/". */
function baseNameCompare(a: TreeItem, b: TreeItem): number {
  const x = a.name;
  const y = b.name;
  const n = Math.min(x.length, y.length);
  for (let k = 0; k < n; k++) {
    const d = (x[k] as number) - (y[k] as number);
    if (d) return d;
  }
  const cx = x.length > n ? (x[n] as number) : a.isDir ? 0x2f : 0;
  const cy = y.length > n ? (y[n] as number) : b.isDir ? 0x2f : 0;
  return cx - cy;
}

/** is_dir_prefix: `dir` leads `path` (equal, or followed by "/"). */
function isDirPrefix(path: Uint8Array, dir: Uint8Array): boolean {
  if (path.length < dir.length) return false;
  for (let k = 0; k < dir.length; k++) if (path[k] !== dir[k]) return false;
  return path.length === dir.length || path[dir.length] === 0x2f;
}

/** dir.c's within_depth over `name[start, end)`. */
function withinDepth(
  name: Uint8Array,
  start: number,
  end: number,
  depth: number,
  maxDepth: number,
): boolean {
  for (let k = start; k < end; k++) {
    if (name[k] !== 0x2f) continue;
    depth++;
    if (depth > maxDepth) return false;
  }
  return depth <= maxDepth;
}

/**
 * The iteration order of git's hashmap (hashmap.c) of the paths, keyed by `strhash`: 64
 * buckets, growing fourfold past 80% load; each new entry goes first in its bucket, and a
 * rehash moves the entries bucket by bucket, putting each first in its new bucket.
 */
class GitHashmapOrder {
  private table: (PathEntry & { next?: PathEntry })[][] = Array.from({ length: 64 }, () => []);
  private size = 0;

  add(q: QueuedPath): void {
    const hash = strhash(q.bytes);
    const e: PathEntry = { path: q.path, bytes: q.bytes, id: q.id ?? "", hash, index: 0 };
    this.table[hash & (this.table.length - 1)]?.unshift(e);
    this.size++;
    if (this.size > Math.floor((this.table.length * 80) / 100)) this.rehash(this.table.length * 4);
  }

  private rehash(newSize: number): void {
    const old = this.table;
    this.table = Array.from({ length: newSize }, () => []);
    for (const bucket of old) {
      for (const e of bucket) this.table[e.hash & (newSize - 1)]?.unshift(e);
    }
  }

  ordered(): PathEntry[] {
    return this.table.flat();
  }
}

/** git's strhash: 32-bit FNV-1 over the path's bytes. */
function strhash(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const c of bytes) hash = (Math.imul(hash, 0x01000193) ^ c) >>> 0;
  return hash;
}

/**
 * git's prio_queue with `compare_commits_by_gen_then_commit_date` (prio-queue.c): a binary
 * heap, ties by insertion order, the root taken lazily (a `put` after a `get` takes its place).
 * Keys are read when compared: a commit parsed after it was queued compares by its new date.
 */
class PrioQueue {
  private items: { c: WalkCommit; ctr: number }[] = [];
  private ctr = 0;
  private getPending = false;

  private compare(i: number, j: number): number {
    const a = this.items[i] as { c: WalkCommit; ctr: number };
    const b = this.items[j] as { c: WalkCommit; ctr: number };
    const cmp = compareCommits(a.c, b.c);
    if (cmp) return cmp;
    return a.ctr > b.ctr ? 1 : a.ctr < b.ctr ? -1 : 0;
  }

  private swap(i: number, j: number): void {
    const t = this.items[i] as { c: WalkCommit; ctr: number };
    this.items[i] = this.items[j] as { c: WalkCommit; ctr: number };
    this.items[j] = t;
  }

  private siftDownRoot(): void {
    const n = this.items.length;
    for (let ix = 0, child: number; ix * 2 + 1 < n; ix = child) {
      child = ix * 2 + 1;
      if (child + 1 < n && this.compare(child, child + 1) >= 0) child++;
      if (this.compare(ix, child) <= 0) break;
      this.swap(child, ix);
    }
  }

  private flushGet(): void {
    if (!this.getPending) return;
    this.getPending = false;
    const last = this.items.pop() as { c: WalkCommit; ctr: number };
    if (this.items.length > 0) {
      this.items[0] = last;
      this.siftDownRoot();
    }
  }

  put(c: WalkCommit): void {
    if (this.getPending) {
      this.getPending = false;
      this.items[0] = { c, ctr: this.ctr++ };
      this.siftDownRoot();
      return;
    }
    this.items.push({ c, ctr: this.ctr++ });
    for (let ix = this.items.length - 1, parent: number; ix; ix = parent) {
      parent = (ix - 1) >> 1;
      if (this.compare(parent, ix) <= 0) break;
      this.swap(parent, ix);
    }
  }

  get(): WalkCommit | undefined {
    if (this.items.length <= (this.getPending ? 1 : 0)) {
      this.items = [];
      this.getPending = false;
      return undefined;
    }
    this.flushGet();
    this.getPending = true;
    return this.items[0]?.c;
  }
}

/** compare_commits_by_gen_then_commit_date: newer first. */
function compareCommits(a: WalkCommit, b: WalkCommit): number {
  if (a.generation < b.generation) return 1;
  if (a.generation > b.generation) return -1;
  if (a.date < b.date) return 1;
  if (a.date > b.date) return -1;
  return 0;
}
