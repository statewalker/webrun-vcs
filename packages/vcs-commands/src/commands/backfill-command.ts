/**
 * `git backfill` (git 2.49+, builtin/backfill.c over path-walk.c): in a partial clone, fetches
 * the blobs the history lacks, in batches of paths, through the promisor remotes.
 *
 * @example
 * ```typescript
 * // git backfill --min-batch-size=1000
 * const result = await git.backfill().setMinBatchSize(1000).call();
 * console.log(result.batches.length, "fetches");
 * // git backfill --sparse main..topic
 * await git.backfill().setSparse(true).addRevision("main..topic").call();
 * ```
 *
 * The commits are walked from HEAD (or the revisions given, with `^x` and `a..b` excluding
 * history), and their root trees, then the trees and blobs below them, path by path in git's
 * path-walk order: a priority queue of paths popping blob paths before tree paths, each kind
 * in byte order of the path (a tree's path ends with `/`), every object listed at the first
 * path it is met at. For each blob path the blobs the store lacks join the current batch,
 * which is fetched as one promisor fetch once it holds `--min-batch-size` ids (default
 * 50000), and what is left at the end in one last fetch. With `--sparse` (the default in a
 * sparse checkout) paths outside the sparse-checkout patterns are skipped. With an excluded
 * revision, the trees of the boundary commits (excluded parents of walked commits) are walked
 * too unless `setIncludeEdges(false)` (`--no-include-edges`).
 *
 * Revisions are read as setup_revisions reads them and handled as revision.c's
 * `handle_commit` and path-walk.c's `setup_pending_objects` handle them: an annotated tag is
 * peeled to what it points at (`^v1`, `v1..main` exclude history), a tree given with a path
 * (`HEAD:dir`) is walked from that path, a blob given with a path (`HEAD:file`) is fetched
 * (a missing one first through a lazy fetch of its own, as git's `parse_object`), a blob
 * reached through a tag or by id alone is fetched, a tree reached so is not walked, an
 * excluded tree or blob does nothing. `--all` adds every ref under `refs/` in name order and
 * HEAD, `--not` flips the revisions after it. Paths (`git backfill -- <path>...`,
 * `addPath`) limit the walk as git's prune_data does: history simplified to the commits
 * changing them (try_to_simplify_commit), only directories on the way to a path entered and
 * only blobs at a path fetched (path-walk's exact pathspecs). Pathspec magic and wildcards,
 * and rev-list options other than `--all` and `--not`, are refused with exit status 128.
 */

import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import type { SparseCheckoutPatterns } from "@statewalker/vcs-working-tree";

import { RevisionError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { promisorOf } from "./promisor-remote.js";
import { revisionMergeBases } from "./rev-parse-command.js";
import {
  handleRevisionArg,
  type RevisionArgEntry,
  unknownRevisionMessage,
} from "./revision-range.js";
import {
  readSparseCheckoutFile,
  readSparseCheckoutPatterns,
  sparseCheckoutConfig,
} from "./sparse-checkout-support.js";

/** What a backfill did. */
export interface BackfillResult {
  /** git's exit status: 0, 1 when it fails (or under 2.43, which has no backfill) */
  exitCode: number;
  /** What git prints on stderr */
  stderr: string;
  /** The ids each promisor fetch asked for, in order (one entry per fetch) */
  batches: ObjectId[][];
}

/** The git version whose behaviour is reproduced. */
export type BackfillCompatibility = "2.43" | "2.56";

/** One path of the walk (git's `struct type_and_oid_list`). */
interface PathList {
  type: "tree" | "blob";
  oids: ObjectId[];
}

/** What the walk starts from: the trees and paths of setup_pending_objects and the commits. */
interface WalkStart {
  /** The boundary commits' trees (when edges are included), then the walked commits' */
  edgeTrees: ObjectId[];
  rootTrees: ObjectId[];
  /** Trees and blobs given with a path, by path (a tree's with its trailing slash) */
  pending: Map<string, PathList>;
  /** Blobs given by id or through a tag (path-walk's `/tagged-blobs`) */
  taggedBlobs: ObjectId[];
  /** Trees and blobs listed by setup_pending_objects (SEEN before the root trees) */
  pendingSeen: ObjectId[];
}

/** A failure git dies with (exit status 128). */
class BackfillDie extends Error {}

/** The rev-list options git accepts and backfill refuses, with git's own message. */
const GIT_REFUSED: Record<string, string> = {
  "-S": "-S",
  "-G": "-G",
  "--diff-filter": "--diff-filter",
  "--follow": "--follow",
  "-L": "-L",
  "--diff-merges": "--diff-merges",
};

/**
 * `git backfill [--min-batch-size=<n>] [--[no-]sparse] [--[no-]include-edges]
 * [<revision-range>]`: see the module documentation.
 */
export class BackfillCommand extends GitCommand<BackfillResult> {
  private minBatchSize = 50000;
  private sparse?: boolean;
  private includeEdges = true;
  private revisions: string[] = [];
  private paths: string[] = [];
  /** `--` was given (a revision naming nothing is then a bad revision, not ambiguous) */
  private dashdash = false;
  private compatibility: BackfillCompatibility = "2.56";
  /** The lazy fetches of pending objects git's parse_object makes, before the batches */
  private lazyFetches: ObjectId[][] = [];

  /** `--min-batch-size=<n>`: the ids a batch gathers before it is fetched (default 50000). */
  setMinBatchSize(size: number): this {
    this.checkCallable();
    this.minBatchSize = Math.max(0, Math.floor(size));
    return this;
  }

  /**
   * `--sparse` / `--no-sparse`: only paths in the sparse checkout (default: whether
   * `core.sparseCheckout` is on).
   */
  setSparse(sparse: boolean): this {
    this.checkCallable();
    this.sparse = sparse;
    return this;
  }

  /** `--[no-]include-edges`: the boundary commits' blobs too (default true). */
  setIncludeEdges(include: boolean): this {
    this.checkCallable();
    this.includeEdges = include;
    return this;
  }

  /**
   * A revision to walk from (`x`, `^x`, `a..b`, `a...b`, `<rev>:<path>`, or the options
   * `--all` and `--not`); none: HEAD.
   */
  addRevision(revision: string): this {
    this.checkCallable();
    this.revisions.push(revision);
    return this;
  }

  /** `--all`: every ref and HEAD, where the call stands among the revisions. */
  setAll(all: boolean): this {
    this.checkCallable();
    if (all) this.revisions.push("--all");
    else this.revisions = this.revisions.filter((r) => r !== "--all");
    return this;
  }

  /** A path after `--` (an exact pathspec: no magic, no wildcards). */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    this.dashdash = true;
    return this;
  }

  /**
   * The command line after `git backfill`: its options (`--min-batch-size`, `--[no-]sparse`,
   * `--[no-]include-edges`), then revisions (`--all` and `--not` among them) and `-- <path>`.
   */
  setArguments(args: readonly string[]): this {
    this.checkCallable();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string;
      if (arg === "--") {
        this.paths.push(...args.slice(i + 1));
        this.dashdash = true;
        break;
      }
      if (arg === "--sparse") this.sparse = true;
      else if (arg === "--no-sparse") this.sparse = false;
      else if (arg === "--include-edges") this.includeEdges = true;
      else if (arg === "--no-include-edges") this.includeEdges = false;
      else if (arg.startsWith("--min-batch-size=")) {
        this.minBatchSize = Math.max(0, Number(arg.slice("--min-batch-size=".length)) || 0);
      } else if (arg === "--min-batch-size" && i + 1 < args.length) {
        this.minBatchSize = Math.max(0, Number(args[++i]) || 0);
      } else this.revisions.push(arg);
    }
    return this;
  }

  /** The git version reproduced (default 2.56); 2.43 has no backfill. */
  setCompatibility(version: BackfillCompatibility): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  async call(): Promise<BackfillResult> {
    this.checkCallable();
    this.setCallable(false);
    if (this.compatibility === "2.43") {
      return {
        exitCode: 1,
        stderr: "git: 'backfill' is not a git command. See 'git --help'.\n",
        batches: [],
      };
    }
    let patterns: SparseCheckoutPatterns | undefined;
    const sparse = this.sparse ?? sparseCheckoutConfig(this.workingCopy).enabled;
    if (sparse) {
      const content = await readSparseCheckoutFile(this.workingCopy);
      if (content === undefined) {
        return { exitCode: 1, stderr: "error: problem loading sparse-checkout\n", batches: [] };
      }
      patterns = await readSparseCheckoutPatterns(this.workingCopy);
    }
    // exact pathspecs as git normalizes them; `.` (everything) limits nothing
    // (a trailing slash is kept: path-walk compares the items as given, so `dir/` enters dir
    // and then lists nothing below it, as git does)
    this.paths = this.paths.map((p) => p.replace(/^(\.\/)+/, ""));
    if (this.paths.some((p) => p === "" || p === ".")) this.paths = [];
    try {
      const start = await this.walkStart();
      const batches = await this.walkPaths(start, patterns);
      return { exitCode: 0, stderr: "", batches: [...this.lazyFetches, ...batches] };
    } catch (error) {
      if (error instanceof BackfillDie || error instanceof RevisionError) {
        return { exitCode: 128, stderr: `${error.message}\n`, batches: [...this.lazyFetches] };
      }
      throw error;
    }
  }

  /** setup_revisions over the revisions: git's pending list, in order. */
  private async pendingEntries(): Promise<RevisionArgEntry[]> {
    for (const path of this.paths) {
      if (path.startsWith(":") || /[*?[\\]/.test(path)) {
        throw new BackfillDie(
          `fatal: pathspec '${path}': magic and wildcards are not supported by backfill`,
        );
      }
    }
    const resolver = this.revisionResolver();
    const options = {
      mergeBases: (a: string, b: string) => revisionMergeBases(this.walkCommits, a, b),
    };
    const entries: RevisionArgEntry[] = [];
    let not = false;
    for (const arg of this.revisions) {
      if (arg === "--not") {
        not = !not;
        continue;
      }
      if (arg === "--all") {
        for (const id of await this.allRefs()) entries.push({ id, exclude: not });
        continue;
      }
      if (arg.startsWith("-")) {
        const option = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
        const refused = GIT_REFUSED[option] ?? GIT_REFUSED[arg.slice(0, 2)];
        if (refused !== undefined) {
          throw new BackfillDie(`fatal: '${refused}' cannot be used with 'git backfill'`);
        }
        throw new BackfillDie(
          `fatal: '${arg}' is not supported by backfill (revisions, --all, --not and -- <path> are)`,
        );
      }
      const ok = await handleRevisionArg(resolver, arg, not, options, entries, true);
      if (ok === false) {
        // without `--` git takes the argument for a path (verify_filename): a misspelt
        // `<rev>:<path>` dies with its diagnosis, anything else as ambiguous
        if (!this.dashdash) await resolver.dieOnMisspeltObjectName(arg);
        const fatal = this.dashdash ? `fatal: bad revision '${arg}'` : unknownRevisionMessage(arg);
        throw new RevisionError(arg, [...resolver.warnings, fatal].join("\n"));
      }
    }
    return entries;
  }

  /** revision.c's handle_refs for `--all`: each ref under `refs/` in name order, then HEAD. */
  private async allRefs(): Promise<ObjectId[]> {
    const named: { name: string; id: ObjectId }[] = [];
    for await (const ref of this.refsStore.list()) {
      if (!ref.name.startsWith("refs/")) continue;
      let id = "objectId" in ref ? ref.objectId : undefined;
      if (!id) id = (await this.refsStore.resolve(ref.name).catch(() => undefined))?.objectId;
      if (id) named.push({ name: ref.name, id });
    }
    named.sort((a, b) => comparePaths(a.name, b.name));
    const ids = named.map((n) => n.id);
    const head = (await this.refsStore.resolve("HEAD").catch(() => undefined))?.objectId;
    if (head) ids.push(head);
    return ids;
  }

  /**
   * The walk's start: handle_commit of each pending entry (tags peeled, commits walked,
   * trees and blobs kept for setup_pending_objects), then the revision walk's root trees,
   * each once: the boundary commits' first (git's `mark_edges_uninteresting` with
   * `edge_hint`), then the walked commits'.
   */
  private async walkStart(): Promise<WalkStart> {
    const include: ObjectId[] = [];
    const exclude: ObjectId[] = [];
    const entries = await this.pendingEntries();
    if (entries.length === 0) entries.push({ id: await this.resolveHead(), exclude: false });
    const resolver = this.revisionResolver();
    const pending = new Map<string, PathList>();
    const taggedBlobs: ObjectId[] = [];
    const pendingSeen: ObjectId[] = [];
    const pendingSeenSet = new Set<ObjectId>();
    const objects: { id: ObjectId; type: "tree" | "blob"; path: string | undefined }[] = [];
    for (const entry of entries) {
      let peeled = await resolver.peelTags(entry.id);
      const throughTag = peeled.id !== entry.id;
      // the path of `<rev>:<path>` (git's oc.path), dropped when a tag was peeled
      const path = throughTag ? undefined : revisionPath(entry.name);
      if (peeled.type === undefined) {
        // parse_object (get_reference, handle_commit) of a blob the partial clone lacks,
        // excluded or not: fetched lazily, on its own
        const promisor = promisorOf(this.workingCopy);
        if (promisor) {
          this.lazyFetches.push([peeled.id]);
          await promisor.fetchObjects([peeled.id]);
          peeled = await resolver.peelTags(entry.id);
        }
      }
      if (peeled.type === "commit") {
        (entry.exclude ? exclude : include).push(peeled.id);
        continue;
      }
      if (peeled.type === undefined) {
        throw new BackfillDie(`fatal: bad object ${entry.name ?? peeled.id}`);
      }
      // an excluded tree marks its contents UNINTERESTING, which backfill never looks at
      if (entry.exclude || (peeled.type !== "tree" && peeled.type !== "blob")) continue;
      objects.push({ id: peeled.id, type: peeled.type, path });
    }

    const parentsOf = async (id: ObjectId): Promise<ObjectId[]> => {
      try {
        return await this.commits.getParents(id);
      } catch {
        return [];
      }
    };
    // UNINTERESTING: every ancestor of an excluded commit
    const uninteresting = new Set<ObjectId>();
    const stack = [...exclude];
    while (stack.length > 0) {
      const id = stack.pop() as ObjectId;
      if (uninteresting.has(id)) continue;
      uninteresting.add(id);
      stack.push(...(await parentsOf(id)));
    }
    // every commit reached (TREESAME ones too: revs->commits after limit_list) gives its
    // excluded parents as edges; only the shown ones give their root trees
    const shown: ObjectId[] = [];
    const edges: ObjectId[] = [];
    const seen = new Set<ObjectId>();
    const edgeSeen = new Set<ObjectId>();
    const queue = include.filter((id) => !uninteresting.has(id));
    const snapshots = new Map<ObjectId, string>();
    const snapshot = async (commit: ObjectId): Promise<string> => {
      const tree = await this.commits.getTree(commit).catch(() => undefined);
      if (!tree) return "";
      let snap = snapshots.get(tree);
      if (snap === undefined) {
        snap = await this.pathSnapshot(tree, "");
        snapshots.set(tree, snap);
      }
      return snap;
    };
    while (queue.length > 0) {
      const id = queue.shift() as ObjectId;
      if (seen.has(id)) continue;
      seen.add(id);
      let parents = await parentsOf(id);
      let treesame = false;
      if (this.paths.length > 0) {
        // try_to_simplify_commit (simplify_history, dense)
        const own = await snapshot(id);
        if (parents.length === 0) {
          treesame = own === "";
        } else {
          let relevantParents = 0;
          let relevantChange = false;
          let irrelevantChange = false;
          let followed: ObjectId | undefined;
          for (const parent of parents) {
            const relevant = !uninteresting.has(parent);
            if (relevant) relevantParents++;
            if ((await snapshot(parent)) === own) {
              if (!relevant) continue;
              followed = parent;
              break;
            }
            if (relevant) relevantChange = true;
            else irrelevantChange = true;
          }
          if (followed !== undefined) {
            parents = [followed];
            treesame = true;
          } else {
            treesame = relevantParents > 0 ? !relevantChange : !irrelevantChange;
          }
        }
      }
      if (!treesame) shown.push(id);
      for (const parent of parents) {
        if (uninteresting.has(parent)) {
          if (!edgeSeen.has(parent)) {
            edgeSeen.add(parent);
            edges.push(parent);
          }
        } else if (!seen.has(parent)) {
          queue.push(parent);
        }
      }
    }
    // SEEN in git's order: show_edge's trees, setup_pending_objects', the root trees
    const treeSeen = new Set<ObjectId>();
    const edgeTrees: ObjectId[] = [];
    if (this.includeEdges) {
      for (const id of edges) {
        const tree = await this.commits.getTree(id);
        if (!tree || treeSeen.has(tree)) continue;
        treeSeen.add(tree);
        edgeTrees.push(tree);
      }
    }
    for (const object of objects) {
      if (treeSeen.has(object.id) || pendingSeenSet.has(object.id)) continue;
      pendingSeenSet.add(object.id);
      pendingSeen.push(object.id);
      if (object.type === "tree") {
        // only a tree given with a path is walked (`/tagged-trees` is not, info->trees off)
        if (object.path) addToList(pending, `${object.path}/`, "tree", object.id);
      } else if (object.path !== undefined) {
        addToList(pending, object.path, "blob", object.id);
      } else {
        taggedBlobs.push(object.id);
      }
    }
    const rootTrees: ObjectId[] = [];
    for (const id of shown) {
      const tree = await this.commits.getTree(id);
      if (!tree || treeSeen.has(tree) || pendingSeenSet.has(tree)) continue;
      treeSeen.add(tree);
      rootTrees.push(tree);
    }
    return { edgeTrees, rootTrees, pending, taggedBlobs, pendingSeen };
  }

  /** The entries at the paths below `tree` (no trees), as one string: rev_compare_tree's view. */
  private async pathSnapshot(tree: ObjectId, base: string): Promise<string> {
    const entries = (await this.trees.entries?.(tree)) ?? (await collectEntries(this.trees, tree));
    if (!entries) return "";
    let out = "";
    for (const entry of entries) {
      const path = `${base}${entry.name}`;
      if (entry.mode === FileMode.TREE) {
        if (this.paths.some((p) => related(path, p.replace(/\/+$/, "")))) {
          out += await this.pathSnapshot(entry.id, `${path}/`);
        }
      } else if (this.matchesPath(path)) {
        out += `${entry.mode.toString(8)} ${entry.id} ${path}\n`;
      }
    }
    return out;
  }

  /** match_pathspec of an exact pathspec: the path itself or one below it. */
  private matchesPath(path: string): boolean {
    return this.paths.some((p) => (p.endsWith("/") ? path.startsWith(p) : dirPrefix(path, p)));
  }

  /** path-walk.c's walk_objects_by_path with backfill's fill_missing_blobs: the batches. */
  private async walkPaths(
    start: WalkStart,
    patterns: SparseCheckoutPatterns | undefined,
  ): Promise<ObjectId[][]> {
    const rootTrees = [...start.edgeTrees, ...start.rootTrees];
    // odb_has_object without fetching
    const objects = this.workingCopy.history.objects;
    const has = (id: ObjectId) => (objects ? objects.has(id) : this.blobs.has(id));
    const promisor = promisorOf(this.workingCopy);
    const lists = new Map<string, PathList>(start.pending);
    const pushed = new Set<string>();
    const seen = new Set<ObjectId>([...start.edgeTrees, ...start.pendingSeen, ...rootTrees]);
    const queue = new PathQueue(lists);
    const push = (path: string) => {
      if (pushed.has(path)) return;
      pushed.add(path);
      queue.put(path);
    };
    // the root list and the direct objects are pushed; the pending paths wait until a tree
    // walk meets them, or the end
    lists.set("", { type: "tree", oids: [...rootTrees] });
    push("");
    if (start.taggedBlobs.length > 0) {
      lists.set(TAGGED_BLOBS, { type: "blob", oids: [...start.taggedBlobs] });
      push(TAGGED_BLOBS);
    }
    const exact = this.paths.length > 0;

    const batches: ObjectId[][] = [];
    let batch: ObjectId[] = [];
    const download = async () => {
      const ids = batch;
      batch = [];
      if (ids.length === 0) return;
      batches.push(ids);
      await promisor?.fetchObjects(ids);
    };

    const addTreeEntries = async (base: string, id: ObjectId) => {
      const entries = (await this.trees.entries?.(id)) ?? (await collectEntries(this.trees, id));
      if (!entries) throw new Error(`failed to walk children of tree ${id}: not found`);
      for (const entry of entries) {
        if (entry.mode === FileMode.GITLINK) continue;
        const isTree = entry.mode === FileMode.TREE;
        const path = `${base}${entry.name}${isTree ? "/" : ""}`;
        if (seen.has(entry.id)) continue;
        // pl_sparse_trees: a path outside the patterns is left, tree or blob (cone mode);
        // without cone patterns only blobs are matched
        if (patterns && (isTree ? patterns.cone : true) && !patterns.includes(path)) continue;
        // exact pathspecs: a path that is neither on the way to one nor below one is left
        if (exact) {
          const bare = isTree ? path.slice(0, -1) : path;
          if (!this.paths.some((p) => related(bare, p))) continue;
        }
        seen.add(entry.id);
        let list = lists.get(path);
        if (!list) {
          list = { type: isTree ? "tree" : "blob", oids: [] };
          lists.set(path, list);
        }
        list.oids.push(entry.id);
        push(path);
      }
    };

    const walk = async () => {
      for (let path = queue.get(); path !== undefined; path = queue.get()) {
        const list = lists.get(path);
        if (!list) continue;
        const direct = path.startsWith("/");
        if (list.oids.length > 0) {
          if (list.type === "blob") {
            // prune_data: a blob path no pathspec matches is skipped (direct objects never)
            if (direct || !exact || this.matchesPath(path)) {
              for (const id of list.oids) if (!(await has(id))) batch.push(id);
              if (batch.length >= this.minBatchSize) await download();
            }
          } else if (!direct) {
            for (const id of list.oids) await addTreeEntries(path, id);
          }
        }
        lists.delete(path);
      }
    };
    await walk();
    // paths left (the pending ones no tree walk met), walked the same way
    if (lists.size > 0) {
      for (const path of [...lists.keys()]) push(path);
      await walk();
    }
    await download();
    return batches;
  }
}

/** path-walk.c's path of the blobs given by id or through a tag. */
const TAGGED_BLOBS = "/tagged-blobs";

function addToList(
  lists: Map<string, PathList>,
  path: string,
  type: "tree" | "blob",
  id: ObjectId,
): void {
  let list = lists.get(path);
  if (!list) {
    list = { type, oids: [] };
    lists.set(path, list);
  }
  list.oids.push(id);
}

/** git's dir_prefix: `dir` is `buf` or a directory above it. */
function dirPrefix(buf: string, dir: string): boolean {
  return buf.startsWith(dir) && (buf.length === dir.length || buf[dir.length] === "/");
}

/** Either path is the other or a directory above it (path-walk's exact pathspec check). */
function related(a: string, b: string): boolean {
  return dirPrefix(a, b) || dirPrefix(b, a);
}

/**
 * The path git's get_oid_with_context records for a revision (`<rev>:<path>`, `:<path>`,
 * `:<n>:<path>`); undefined for one without.
 */
function revisionPath(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (name.startsWith(":")) {
    if (name.startsWith(":/")) return undefined;
    const staged = /^:[0-3]:/.exec(name);
    return staged ? name.slice(3) : name.slice(1);
  }
  const colon = name.indexOf(":");
  return colon > 0 ? name.slice(colon + 1) : undefined;
}

async function collectEntries(
  trees: {
    load(
      id: ObjectId,
    ): Promise<AsyncIterable<{ mode: number; name: string; id: ObjectId }> | undefined>;
  },
  id: ObjectId,
): Promise<{ mode: number; name: string; id: ObjectId }[] | undefined> {
  const loaded = await trees.load(id);
  if (!loaded) return undefined;
  const out: { mode: number; name: string; id: ObjectId }[] = [];
  for await (const entry of loaded) out.push(entry);
  return out;
}

/** strcmp of the paths' UTF-8 bytes: code point order. */
function comparePaths(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(i) as number;
    if (x !== y) return x < y ? -1 : 1;
    if (x > 0xffff) i++;
  }
  return a.length - b.length;
}

/**
 * path-walk.c's `path_stack` (a prio_queue ordered by compare_by_type): blob paths before
 * tree paths, each kind in byte order.
 */
class PathQueue {
  private readonly heap: string[] = [];
  constructor(private readonly lists: Map<string, PathList>) {}

  private less(a: string, b: string): boolean {
    const ta = this.lists.get(a)?.type;
    const tb = this.lists.get(b)?.type;
    if (ta !== undefined && tb !== undefined && ta !== tb) return ta === "blob";
    return comparePaths(a, b) < 0;
  }

  put(path: string): void {
    const heap = this.heap;
    heap.push(path);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(heap[i] as string, heap[parent] as string)) break;
      [heap[i], heap[parent]] = [heap[parent] as string, heap[i] as string];
      i = parent;
    }
  }

  get(): string | undefined {
    const heap = this.heap;
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop() as string;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && this.less(heap[l] as string, heap[m] as string)) m = l;
        if (r < heap.length && this.less(heap[r] as string, heap[m] as string)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m] as string, heap[i] as string];
        i = m;
      }
    }
    return top;
  }
}
