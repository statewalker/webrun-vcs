/**
 * receive-pack's connectivity check, as git's `check_connected` (`rev-list --objects
 * <new tips> --not --all`): every object a pushed tip needs is present, down to what the
 * existing refs already reach.
 *
 * Objects reachable from the refs are taken as complete (git makes the same assumption); the
 * walk stops there. It runs in two steps, both reading only through the facade:
 *
 * 1. A walk from the new tips that stops at the ref tips themselves. A push on top of a branch
 *    (the usual case) ends there after reading only the new commits, whatever the number of
 *    refs. It may take an old commit between two ref tips for a new one: that only means more
 *    objects checked, never fewer. A path that ends at a root commit (old history) or a walk
 *    past its budget hands over to step 2.
 * 2. Only when step 1 finds something wrong (a missing object, a client shallow commit) or
 *    grows past its budget, git's `limit_list`: a binary heap ordered by committer time paints
 *    every commit reachable from the refs "uninteresting" and ends once only uninteresting
 *    commits are queued, which gives the exact set of new commits.
 *
 * The trees of each new commit are read against the tree of its first parent: a subtree or
 * blob with the same id at the same path is the parent's, checked with it (or known), and is
 * not read again. One analysis serves every command of a push: the verdict of each tip (and
 * whether it reaches a client shallow commit) is read off the new-commit graph, without
 * walking again.
 *
 * Memory is bounded by what the push introduces (the commits walked and the objects checked)
 * plus, in step 2, the commits between the refs and the new commits.
 *
 * Like git without a commit-graph, step 2 trusts committer times: a pushed commit dated far in
 * the past, on top of a commit that is not a ref tip, makes it walk the history down to that
 * date.
 */

import type {
  CommitGraphInfo,
  GitObjectTypeName,
  RepositoryFacade,
} from "../../api/repository-facade.js";

/** The result of a connectivity check. */
export interface ConnectivityResult {
  /** Whether every object the tips need is present */
  ok: boolean;
  /** The first object found missing (or of the wrong type) */
  missing?: string;
  /** Objects checked (commits, trees, blobs, tags) */
  objects: number;
}

/** Options of {@link checkConnectivity}, {@link findNewCommits} and {@link PushConnectivity}. */
export interface ConnectivityOptions {
  /**
   * Commits whose parents are not followed (git's shallow grafts): the client's shallow
   * commits the server has.
   */
  shallow?: ReadonlySet<string>;
  /** Commits step 1 may read before the exact walk takes over (default 10000) */
  firstStepBudget?: number;
  /**
   * Objects a partial clone's server promised (its filter left them out): a tree or blob of
   * these kinds found absent under a tree or commit is not missing (git's
   * `--exclude-promisor-objects`, narrowed to what the filter omits)
   */
  promised?: PromisedKinds;
}

/** The kinds of objects a partial clone filter may leave out. */
export interface PromisedKinds {
  tree: boolean;
  blob: boolean;
}

/**
 * What `git rev-list --objects` stops at first when a check fails (see
 * {@link PushConnectivity.failure}): a tip or a tag's target missing (`object`), a commit the
 * walk needed (`commit`, with the commit naming it), a tree or a blob under a new commit.
 */
export interface ConnectivityFailure {
  kind: "object" | "commit" | "tree" | "blob";
  /** The object missing (or of the wrong type) */
  id: string;
  /** For `commit`: a commit that names it as a parent */
  child?: string;
}

/** The verdict for one tip. */
export interface TipVerdict {
  /** Every object the tip needs is present */
  ok: boolean;
  /** An object found missing */
  missing?: string;
  /** The tip's new history reaches one of the shallow commits */
  reachesShallow: boolean;
}

const MODE_TREE = 0o040000;
const MODE_GITLINK = 0o160000;
const MODE_TYPE_MASK = 0o170000;
const DEFAULT_FIRST_STEP_BUDGET = 10000;

/** Whether `repository` implements what the full object walk needs. */
export function canWalkObjects(repository: RepositoryFacade): boolean {
  return (
    typeof repository.getCommitInfo === "function" &&
    typeof repository.getTreeEntries === "function" &&
    typeof repository.getTagInfo === "function" &&
    typeof repository.getObjectType === "function"
  );
}

/** A new commit (or one taken for new by step 1). */
interface NewCommit {
  oid: string;
  /** Absent from the repository */
  missing: boolean;
  /** Parents followed (none past a shallow commit) */
  parents: string[];
  tree?: string;
  /** The first object found missing under it (tree check), if any */
  broken?: string;
}

/** A max-heap of commits by committer time; ties keep insertion order. */
class CommitHeap<T extends { time: number; seq: number }> {
  private readonly items: T[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.before(a[i] as T, a[p] as T)) break;
      [a[i], a[p]] = [a[p] as T, a[i] as T];
      i = p;
    }
  }

  pop(): T | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.before(a[l] as T, a[m] as T)) m = l;
        if (r < a.length && this.before(a[r] as T, a[m] as T)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m] as T, a[i] as T];
        i = m;
      }
    }
    return top;
  }

  private before(x: T, y: T): boolean {
    return x.time > y.time || (x.time === y.time && x.seq < y.seq);
  }
}

interface PaintedCommit {
  oid: string;
  time: number;
  seq: number;
  parents: string[];
  missing: boolean;
  uninteresting: boolean;
  queued: boolean;
}

/**
 * The connectivity analysis of one push: one walk for all its tips, then a verdict per tip.
 *
 * @example
 * ```ts
 * const conn = new PushConnectivity(repository, existingRefValues, { shallow });
 * await conn.analyze(newTips);
 * if (!conn.verdict(tip).ok) refuse(tip, "missing necessary objects");
 * ```
 */
export class PushConnectivity {
  /** Objects checked */
  objects = 0;
  private readonly known: Set<string>;
  private readonly shallow: ReadonlySet<string>;
  private readonly budget: number;
  private readonly commitInfo = new Map<string, CommitGraphInfo | null>();
  private nodes = new Map<string, NewCommit>();
  private readonly verdicts = new Map<string, TipVerdict>();
  /** Tips that are commits (or tags peeled to one): the commit */
  private readonly commitOf = new Map<string, string>();
  private readonly checker: ObjectChecker;
  /** The tips given to {@link analyze}, and what each one's own check found missing */
  private direct = new Map<string, string | undefined>();

  constructor(
    private readonly repository: RepositoryFacade,
    known: Iterable<string>,
    options: ConnectivityOptions = {},
  ) {
    this.known = new Set(known);
    this.shallow = options.shallow ?? new Set();
    this.budget = options.firstStepBudget ?? DEFAULT_FIRST_STEP_BUDGET;
    this.checker = new ObjectChecker(repository, options.promised);
  }

  /** Analyzes the push of `tips` (any object ids). */
  async analyze(tips: Iterable<string>): Promise<void> {
    const unique = [...new Set(tips)];
    if (!canWalkObjects(this.repository)) {
      for (const tip of unique) {
        this.objects++;
        const ok = await this.repository.has(tip);
        this.verdicts.set(tip, { ok, missing: ok ? undefined : tip, reachesShallow: false });
        this.direct.set(tip, ok ? undefined : tip);
        if (!ok) this.checker.markMissing(tip);
      }
      return;
    }

    // the tips themselves: tags followed, trees and blobs checked, commits collected
    const direct = new Map<string, string | undefined>();
    for (const tip of unique) {
      const result = await this.checker.checkObject(tip);
      direct.set(tip, result.missing);
      if (result.commit) this.commitOf.set(tip, result.commit);
    }
    this.direct = direct;
    const roots = [...new Set(this.commitOf.values())];

    // step 1: stop at the ref tips; the exact walk when something looks wrong
    let exact = false;
    const first = await this.walkToKnownTips(roots);
    if (first) {
      this.nodes = first;
      await this.checkTrees();
      exact = !this.allGood(unique, direct);
    } else {
      exact = true;
    }
    if (exact) {
      this.nodes = await this.exactNewCommits(roots);
      await this.checkTrees();
    }
    for (const tip of unique) {
      const commit = this.commitOf.get(tip);
      const inherited = commit ? this.reach(commit) : { missing: undefined, reachesShallow: false };
      const missing = direct.get(tip) ?? inherited.missing;
      this.verdicts.set(tip, {
        ok: missing === undefined,
        missing,
        reachesShallow: inherited.reachesShallow,
      });
    }
    this.objects = this.checker.objects + this.nodes.size;
  }

  /** The verdict of a tip given to {@link analyze}. */
  verdict(tip: string): TipVerdict {
    return this.verdicts.get(tip) ?? { ok: false, missing: tip, reachesShallow: false };
  }

  /**
   * Where `git rev-list --objects <tips>` would stop when something is missing, in its order:
   * a tip (or a tag's target) while it reads them, then a commit the walk needs, then a tree
   * or blob of a tree tip, then of a new commit; undefined when every tip is complete.
   */
  failure(): ConnectivityFailure | undefined {
    const kindOf = (id: string) => this.checker.missingKind(id);
    for (const [tip, missing] of this.direct) {
      if (missing === tip && kindOf(missing) === "object") return { kind: "object", id: missing };
    }
    for (const missing of this.direct.values()) {
      if (missing !== undefined && kindOf(missing) === "object") {
        return { kind: "object", id: missing };
      }
    }
    for (const node of this.nodes.values()) {
      if (!node.missing) continue;
      const child = [...this.nodes.values()].find((n) => n.parents.includes(node.oid));
      return { kind: "commit", id: node.oid, ...(child ? { child: child.oid } : {}) };
    }
    const treeFailure = (id: string): ConnectivityFailure => {
      const kind = kindOf(id);
      return { kind: kind === "tree" || kind === "blob" ? kind : "object", id };
    };
    for (const missing of this.direct.values()) {
      if (missing !== undefined) return treeFailure(missing);
    }
    for (const node of this.nodes.values()) {
      if (node.broken !== undefined) return treeFailure(node.broken);
    }
    return undefined;
  }

  /** The new commits (oids) reachable from `tips`. */
  newCommitsFrom(tips: Iterable<string>): string[] {
    const seen = new Set<string>();
    const stack: string[] = [];
    for (const tip of tips) {
      const commit = this.commitOf.get(tip);
      if (commit) stack.push(commit);
    }
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      const node = this.nodes.get(oid);
      if (!node || seen.has(oid)) continue;
      seen.add(oid);
      stack.push(...node.parents);
    }
    return [...seen];
  }

  /** The shallow commits in the new history of `tips` (what a shallow push must record). */
  shallowReachedFrom(tips: Iterable<string>): string[] {
    return this.newCommitsFrom(tips).filter((oid) => this.shallow.has(oid));
  }

  /** All new commits, in the order found. */
  newCommits(): string[] {
    return [...this.nodes.keys()];
  }

  private allGood(tips: string[], direct: Map<string, string | undefined>): boolean {
    for (const tip of tips) {
      if (direct.get(tip) !== undefined) return false;
    }
    for (const node of this.nodes.values()) {
      if (node.missing || node.broken !== undefined || this.shallow.has(node.oid)) return false;
    }
    return true;
  }

  /** Whether the new history of `commit` is complete, and whether it reaches a shallow commit. */
  private reach(commit: string): { missing?: string; reachesShallow: boolean } {
    let missing: string | undefined;
    let reachesShallow = false;
    const seen = new Set<string>();
    const stack = [commit];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      const node = this.nodes.get(oid);
      if (!node || seen.has(oid)) continue;
      seen.add(oid);
      if (this.shallow.has(oid)) reachesShallow = true;
      if (node.missing) missing ??= oid;
      else if (node.broken !== undefined) missing ??= node.broken;
      stack.push(...node.parents);
    }
    return { missing, reachesShallow };
  }

  private async info(oid: string): Promise<CommitGraphInfo | null> {
    let info = this.commitInfo.get(oid);
    if (info === undefined) {
      // a commit only a stale commit-graph lists is missing here (git checks connectivity with
      // the objects themselves)
      info = (await this.repository.getCommitInfo?.(oid, { checkExists: true })) ?? null;
      this.commitInfo.set(oid, info);
    }
    return info;
  }

  private parentsOf(oid: string, info: CommitGraphInfo): string[] {
    return this.shallow.has(oid) ? [] : info.parents;
  }

  /**
   * Step 1: the commits from `roots` down to the ref tips; undefined past the budget, or when
   * a path ends at a root commit instead of a ref tip (then the history it read is old).
   */
  private async walkToKnownTips(roots: string[]): Promise<Map<string, NewCommit> | undefined> {
    const nodes = new Map<string, NewCommit>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (nodes.has(oid) || this.known.has(oid)) continue;
      if (nodes.size >= this.budget) return undefined;
      const info = await this.info(oid);
      if (!info) {
        nodes.set(oid, { oid, missing: true, parents: [] });
        continue;
      }
      const parents = this.parentsOf(oid, info);
      // a root commit reached while refs exist: old history taken for new, walk exactly
      if (info.parents.length === 0 && this.known.size > 0) return undefined;
      nodes.set(oid, { oid, missing: false, parents, tree: info.tree });
      for (const p of parents) stack.push(p);
    }
    return nodes;
  }

  /** Step 2: git's limit_list, the exact commits reachable from `roots` and not the refs. */
  private async exactNewCommits(roots: string[]): Promise<Map<string, NewCommit>> {
    const painted = new Map<string, PaintedCommit>();
    const heap = new CommitHeap<PaintedCommit>();
    let seq = 0;
    let interestingQueued = 0;
    const order: PaintedCommit[] = [];

    const markUninteresting = (start: PaintedCommit) => {
      const stack = [start];
      while (stack.length > 0) {
        const c = stack.pop() as PaintedCommit;
        if (c.uninteresting) continue;
        c.uninteresting = true;
        if (c.queued) interestingQueued--;
        for (const p of c.parents) {
          const parent = painted.get(p);
          if (parent && !parent.uninteresting) stack.push(parent);
        }
      }
    };
    const add = async (oid: string, uninteresting: boolean) => {
      const seen = painted.get(oid);
      if (seen) {
        if (uninteresting && !seen.uninteresting) markUninteresting(seen);
        return;
      }
      const info = await this.info(oid);
      if (!info) {
        // an existing ref on a broken commit does not hold the push back
        if (uninteresting) return;
        const c: PaintedCommit = {
          oid,
          time: 0,
          seq: seq++,
          parents: [],
          missing: true,
          uninteresting: false,
          queued: false,
        };
        painted.set(oid, c);
        order.push(c);
        return;
      }
      const c: PaintedCommit = {
        oid,
        time: info.time,
        seq: seq++,
        parents: this.parentsOf(oid, info),
        missing: false,
        uninteresting,
        queued: true,
      };
      painted.set(oid, c);
      heap.push(c);
      if (!uninteresting) interestingQueued++;
    };

    for (const oid of await this.knownCommits()) await add(oid, true);
    for (const oid of roots) await add(oid, false);
    while (interestingQueued > 0 && heap.size > 0) {
      const c = heap.pop() as PaintedCommit;
      c.queued = false;
      if (c.uninteresting) {
        for (const p of c.parents) await add(p, true);
      } else {
        interestingQueued--;
        order.push(c);
        for (const p of c.parents) await add(p, false);
      }
    }

    const nodes = new Map<string, NewCommit>();
    for (const c of order) {
      if (c.uninteresting) continue; // painted later (clock skew): reachable from a ref
      const info = c.missing ? null : await this.info(c.oid);
      nodes.set(c.oid, { oid: c.oid, missing: c.missing, parents: c.parents, tree: info?.tree });
    }
    return nodes;
  }

  /** The ref values that are commits, tags peeled; trees and blobs are skipped. */
  private async knownCommits(): Promise<string[]> {
    const commits: string[] = [];
    const seen = new Set<string>();
    for (const start of this.known) {
      let oid: string | undefined = start;
      for (let depth = 0; oid && depth < 16 && !seen.has(oid); depth++) {
        seen.add(oid);
        if (await this.info(oid)) {
          commits.push(oid);
          break;
        }
        oid = (await this.repository.getTagInfo?.(oid))?.object;
      }
    }
    return commits;
  }

  /** Checks the trees of the new commits not checked yet. */
  private async checkTrees(): Promise<void> {
    for (const node of this.nodes.values()) {
      if (node.missing || node.broken !== undefined) continue;
      if (!node.tree) {
        node.broken = node.oid;
        continue;
      }
      const parent = node.parents[0];
      const base = parent ? (await this.info(parent))?.tree : undefined;
      node.broken = await this.checker.checkTree(node.tree, base);
    }
  }
}

/** Reads trees and checks blobs, each object once; remembers what is missing. */
class ObjectChecker {
  objects = 0;
  private readonly checked = new Set<string>();
  private readonly missing = new Set<string>();
  /** Trees with something missing under them: what */
  private readonly brokenTrees = new Map<string, string>();
  /** What each object found missing was expected to be */
  private readonly kinds = new Map<string, "object" | "tree" | "blob">();

  constructor(
    private readonly repository: RepositoryFacade,
    private readonly promised?: PromisedKinds,
  ) {}

  /** Records `id` as a missing tip. */
  markMissing(id: string): void {
    this.kinds.set(id, "object");
  }

  /** How an object found missing was reached: as a tip or tag target, a tree, a blob. */
  missingKind(id: string): "object" | "tree" | "blob" | undefined {
    return this.kinds.get(id);
  }

  /**
   * A tip: tags are followed (their target types checked), trees and blobs checked, a commit
   * returned. `missing`: the first object found absent (or of the wrong type).
   */
  async checkObject(start: string): Promise<{ commit?: string; missing?: string }> {
    let oid = start;
    let want: GitObjectTypeName | undefined;
    for (let depth = 0; depth < 64; depth++) {
      const type = await this.repository.getObjectType?.(oid);
      if (!type || (want !== undefined && type !== want)) {
        this.kinds.set(oid, "object");
        return { missing: oid };
      }
      if (type === "commit") return { commit: oid };
      if (type === "tree") return { missing: await this.checkTree(oid, undefined) };
      this.objects++;
      this.checked.add(oid);
      if (type === "blob") return {};
      const tag = await this.repository.getTagInfo?.(oid);
      if (!tag) {
        this.kinds.set(oid, "object");
        return { missing: oid };
      }
      oid = tag.object;
      want = tag.type;
    }
    return { missing: oid };
  }

  /**
   * Checks `tree` and what it names, skipping entries equal to those of `base` at the same
   * path (`base` is a parent commit's tree: checked with it, or reachable from a ref).
   * Returns the first object found missing, or undefined. A tree is remembered as complete
   * only once everything under it was found; a broken one keeps what is missing under it.
   */
  async checkTree(tree: string, base: string | undefined): Promise<string | undefined> {
    if (tree === base || this.checked.has(tree)) return undefined;
    const known = this.brokenTrees.get(tree);
    if (known !== undefined) return known;
    const entries = await this.repository.getTreeEntries?.(tree);
    if (!entries) {
      // a tree the filter left out (absent, not of another type): promised
      if (this.promised?.tree && !(await this.repository.has(tree))) {
        this.checked.add(tree);
        return undefined;
      }
      this.brokenTrees.set(tree, tree);
      if (!this.kinds.has(tree)) this.kinds.set(tree, "tree");
      return tree;
    }
    let baseEntries: Map<string, { id: string; mode: number }> | undefined;
    if (base) {
      const list = await this.repository.getTreeEntries?.(base);
      if (list) baseEntries = new Map(list.map((e) => [e.name, e]));
    }
    for (const entry of entries) {
      const kind = entry.mode & MODE_TYPE_MASK;
      if (kind === MODE_GITLINK) continue; // a submodule's commit lives elsewhere
      const inBase = baseEntries?.get(entry.name);
      if (inBase && inBase.id === entry.id) continue;
      let missing: string | undefined;
      if (kind === MODE_TREE) {
        const baseTree =
          inBase && (inBase.mode & MODE_TYPE_MASK) === MODE_TREE ? inBase.id : undefined;
        missing = await this.checkTree(entry.id, baseTree);
      } else if (!this.checked.has(entry.id)) {
        if (this.missing.has(entry.id) || !(await this.repository.has(entry.id))) {
          if (this.promised?.blob) {
            // a blob the filter left out: promised
            this.checked.add(entry.id);
            continue;
          }
          this.missing.add(entry.id);
          if (!this.kinds.has(entry.id)) this.kinds.set(entry.id, "blob");
          missing = entry.id;
        } else {
          this.checked.add(entry.id);
          this.objects++;
        }
      }
      if (missing !== undefined) {
        this.brokenTrees.set(tree, missing);
        return missing;
      }
    }
    this.checked.add(tree);
    this.objects++;
    return undefined;
  }
}

/**
 * The commits reachable from `tips` and not from `known` (git's `rev-list <tips> --not
 * <known>`), or `{ missing }` with the first commit the walk needed and could not read.
 * `tips` must be commits.
 */
export async function findNewCommits(
  repository: RepositoryFacade,
  tips: Iterable<string>,
  known: Iterable<string>,
  options: ConnectivityOptions = {},
): Promise<{ commits: string[] } | { missing: string }> {
  // the exact walk only (step 1 may take old commits for new ones)
  const conn = new PushConnectivity(repository, known, { ...options, firstStepBudget: 0 });
  await conn.analyze(tips);
  for (const tip of tips) {
    const verdict = conn.verdict(tip);
    if (!verdict.ok && verdict.missing) {
      const missingCommit = conn.newCommits().find((c) => c === verdict.missing);
      if (missingCommit) return { missing: missingCommit };
    }
  }
  return { commits: conn.newCommits() };
}

/**
 * Checks that every object reachable from `tips` and not from `known` is present (git's
 * `check_connected`). `tips` may be any objects (commits, tags, trees, blobs); `known` are
 * the existing ref values.
 *
 * Needs the facade's `getObjectType`, `getCommitInfo` (with `tree`), `getTreeEntries` and
 * `getTagInfo`; a facade without them gets the check git's `has_object` would make: each tip
 * exists.
 *
 * @example
 * ```ts
 * const result = await checkConnectivity(repository, [newTip], existingRefValues);
 * if (!result.ok) console.log(`missing ${result.missing}`);
 * ```
 */
export async function checkConnectivity(
  repository: RepositoryFacade,
  tips: Iterable<string>,
  known: Iterable<string>,
  options: ConnectivityOptions = {},
): Promise<ConnectivityResult> {
  const list = [...tips];
  const conn = new PushConnectivity(repository, known, options);
  await conn.analyze(list);
  for (const tip of list) {
    const verdict = conn.verdict(tip);
    if (!verdict.ok) return { ok: false, missing: verdict.missing, objects: conn.objects };
  }
  return { ok: true, objects: conn.objects };
}

/** Clock skew tolerated by {@link isAncestorOf} before it walks the whole history. */
const ANCESTRY_SLOP_SECONDS = 86400;

/**
 * Whether `ancestor` is reachable from `descendant` through parents (receive-pack's
 * fast-forward check). With the facade's `getCommitInfo`, a walk newest first that stops
 * below the ancestor's committer time (less a day of clock skew): a fast-forward reads the
 * commits between the two only. When that cut-off dropped commits without finding the
 * ancestor, the answer is confirmed with a full walk, so skewed history is never refused
 * wrongly (a real non-fast-forward pays it).
 */
export async function isAncestorOf(
  repository: RepositoryFacade,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  if (ancestor === descendant) return true;
  const getCommitInfo = repository.getCommitInfo?.bind(repository);
  const target = getCommitInfo ? await getCommitInfo(ancestor) : undefined;
  if (target && getCommitInfo) {
    const floor = target.time - ANCESTRY_SLOP_SECONDS;
    const heap = new CommitHeap<{ oid: string; time: number; seq: number; parents: string[] }>();
    const seen = new Set<string>();
    let seq = 0;
    let cut = false;
    const add = async (oid: string) => {
      if (seen.has(oid)) return;
      seen.add(oid);
      const info = await getCommitInfo(oid);
      if (info) heap.push({ oid, time: info.time, seq: seq++, parents: info.parents });
    };
    await add(descendant);
    while (heap.size > 0) {
      const c = heap.pop() as { oid: string; time: number; seq: number; parents: string[] };
      if (c.oid === ancestor) return true;
      if (c.time < floor) {
        cut = true;
        continue;
      }
      for (const p of c.parents) await add(p);
    }
    if (!cut) return false;
  }
  for await (const commit of repository.walkAncestors(descendant)) {
    if (commit === ancestor) return true;
  }
  return false;
}
