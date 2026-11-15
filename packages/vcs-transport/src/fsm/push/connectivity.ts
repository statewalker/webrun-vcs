/**
 * receive-pack's connectivity check, as git's `check_connected` (`rev-list --objects
 * <new tips> --not --all`): every object a pushed tip needs is present, down to what the
 * existing refs already reach.
 *
 * Objects reachable from the refs are taken as complete (git makes the same assumption); the
 * walk stops there. The commit walk is git's `limit_list`: a queue ordered by committer time
 * that paints the commits reachable from the refs "uninteresting" and ends once only
 * uninteresting commits are queued, so a push on top of a long history reads the new commits
 * and the few old ones around them, not the history. The trees of each new commit are read
 * against the tree of its first parent: a subtree or blob with the same id at the same path
 * is the parent's, checked with the parent (or known), and is not read again.
 *
 * Memory is bounded by what the push introduces (the commits walked and the objects checked),
 * not by the size of the repository.
 */

import type { GitObjectTypeName, RepositoryFacade } from "../../api/repository-facade.js";

/** The result of a connectivity check. */
export interface ConnectivityResult {
  /** Whether every object the tips need is present */
  ok: boolean;
  /** The first object found missing (or of the wrong type) */
  missing?: string;
  /** Objects checked (commits, trees, blobs, tags) */
  objects: number;
}

/** Options of {@link checkConnectivity} and {@link findNewCommits}. */
export interface ConnectivityOptions {
  /**
   * Commits whose parents are not followed (git's shallow grafts): the client's shallow
   * boundary when a shallow push is accepted.
   */
  shallow?: ReadonlySet<string>;
}

const MODE_TREE = 0o040000;
const MODE_GITLINK = 0o160000;
const MODE_TYPE_MASK = 0o170000;

/** Whether `repository` implements what the full object walk needs. */
export function canWalkObjects(repository: RepositoryFacade): boolean {
  return (
    typeof repository.getCommitInfo === "function" &&
    typeof repository.getTreeEntries === "function" &&
    typeof repository.getTagInfo === "function" &&
    typeof repository.getObjectType === "function"
  );
}

/** A commit seen by the walk. */
interface WalkCommit {
  oid: string;
  time: number;
  parents: string[];
  tree?: string;
  uninteresting: boolean;
  queued: boolean;
}

/** Missing object found by the walk (not an error of the repository). */
class MissingObject extends Error {
  constructor(readonly oid: string) {
    super(`missing object ${oid}`);
  }
}

/**
 * The commit graph walk of `rev-list <tips> --not <known>`: the commits reachable from `tips`
 * and not from `known`, in the order found. `known` may hold any object ids (tags are peeled;
 * trees and blobs are ignored). A commit `tips` need that is absent throws
 * {@link MissingObject}.
 */
class CommitWalk {
  readonly commits = new Map<string, WalkCommit>();
  /** Queued commits, newest first */
  private readonly queue: WalkCommit[] = [];
  private interestingQueued = 0;
  /** Commits found reachable from the tips and not (yet) from the known refs */
  readonly interesting: WalkCommit[] = [];

  constructor(
    private readonly repository: RepositoryFacade,
    private readonly shallow: ReadonlySet<string> | undefined,
  ) {}

  async add(oid: string, uninteresting: boolean): Promise<void> {
    const seen = this.commits.get(oid);
    if (seen) {
      if (uninteresting && !seen.uninteresting) this.markUninteresting(seen);
      return;
    }
    const info = await this.repository.getCommitInfo?.(oid);
    if (!info) {
      // an existing ref on a broken commit does not hold the push back
      if (uninteresting) return;
      throw new MissingObject(oid);
    }
    const commit: WalkCommit = {
      oid,
      time: info.time,
      parents: this.shallow?.has(oid) ? [] : info.parents,
      tree: info.tree,
      uninteresting,
      queued: true,
    };
    this.commits.set(oid, commit);
    this.enqueue(commit);
  }

  /** Paints `commit` and the walked commits below it uninteresting (git's `mark_parents_uninteresting`). */
  private markUninteresting(commit: WalkCommit): void {
    const stack = [commit];
    while (stack.length > 0) {
      const c = stack.pop() as WalkCommit;
      if (c.uninteresting) continue;
      c.uninteresting = true;
      if (c.queued) this.interestingQueued--;
      for (const p of c.parents) {
        const parent = this.commits.get(p);
        if (parent && !parent.uninteresting) stack.push(parent);
      }
    }
  }

  private enqueue(commit: WalkCommit): void {
    // binary insertion, newest first; equal times keep insertion order
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.queue[mid] as WalkCommit).time >= commit.time) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, commit);
    if (!commit.uninteresting) this.interestingQueued++;
  }

  /** Walks until only uninteresting commits are queued. */
  async run(): Promise<void> {
    while (this.interestingQueued > 0 && this.queue.length > 0) {
      const commit = this.queue.shift() as WalkCommit;
      commit.queued = false;
      if (commit.uninteresting) {
        for (const p of commit.parents) await this.add(p, true);
      } else {
        this.interestingQueued--;
        this.interesting.push(commit);
        for (const p of commit.parents) await this.add(p, false);
      }
    }
  }

  /** The commits found new, without those painted uninteresting later (clock skew). */
  newCommits(): WalkCommit[] {
    return this.interesting.filter((c) => !c.uninteresting);
  }
}

/** The commit ids among `known` (tags peeled); trees and blobs are skipped. */
async function knownCommits(
  repository: RepositoryFacade,
  known: Iterable<string>,
): Promise<string[]> {
  const commits: string[] = [];
  const seen = new Set<string>();
  for (const start of known) {
    let oid: string | undefined = start;
    for (let depth = 0; oid && depth < 16 && !seen.has(oid); depth++) {
      seen.add(oid);
      const type: GitObjectTypeName | undefined = repository.getObjectType
        ? await repository.getObjectType(oid)
        : "commit";
      if (type === "commit") {
        commits.push(oid);
        break;
      }
      if (type !== "tag") break;
      oid = (await repository.getTagInfo?.(oid))?.object;
    }
  }
  return commits;
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
  const walk = new CommitWalk(repository, options.shallow);
  try {
    for (const oid of await knownCommits(repository, known)) await walk.add(oid, true);
    for (const oid of tips) await walk.add(oid, false);
    await walk.run();
  } catch (error) {
    if (error instanceof MissingObject) return { missing: error.oid };
    throw error;
  }
  return { commits: walk.newCommits().map((c) => c.oid) };
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
  if (!canWalkObjects(repository)) {
    let objects = 0;
    for (const oid of tips) {
      objects++;
      if (!(await repository.has(oid))) return { ok: false, missing: oid, objects };
    }
    return { ok: true, objects };
  }
  const checker = new ObjectChecker(repository);
  try {
    // the tips: peel tags, collect commits, check trees and blobs named directly
    const commitTips: string[] = [];
    for (const tip of tips) await checker.checkObject(tip, undefined, commitTips);

    const walk = new CommitWalk(repository, options.shallow);
    for (const oid of await knownCommits(repository, known)) await walk.add(oid, true);
    for (const oid of commitTips) await walk.add(oid, false);
    await walk.run();

    for (const commit of walk.newCommits()) {
      checker.objects++;
      if (!commit.tree) throw new MissingObject(commit.oid);
      const parent = commit.parents[0] ? walk.commits.get(commit.parents[0]) : undefined;
      await checker.checkTree(commit.tree, parent?.tree);
    }
  } catch (error) {
    if (error instanceof MissingObject) {
      return { ok: false, missing: error.oid, objects: checker.objects };
    }
    throw error;
  }
  return { ok: true, objects: checker.objects };
}

/** Reads trees and checks blobs, each object once. */
class ObjectChecker {
  objects = 0;
  private readonly checked = new Set<string>();

  constructor(private readonly repository: RepositoryFacade) {}

  /** A tip or a tag's target: tags are followed, commits collected, trees and blobs checked. */
  async checkObject(
    start: string,
    expected: GitObjectTypeName | undefined,
    commits: string[],
  ): Promise<void> {
    let oid = start;
    let want = expected;
    for (let depth = 0; depth < 64; depth++) {
      const type = await this.repository.getObjectType?.(oid);
      if (!type || (want !== undefined && type !== want)) throw new MissingObject(oid);
      if (type === "commit") {
        commits.push(oid);
        return;
      }
      if (type === "tree") {
        await this.checkTree(oid, undefined);
        return;
      }
      this.objects++;
      this.checked.add(oid);
      if (type === "blob") return;
      const tag = await this.repository.getTagInfo?.(oid);
      if (!tag) throw new MissingObject(oid);
      oid = tag.object;
      want = tag.type;
    }
    throw new MissingObject(oid);
  }

  /**
   * Checks `tree` and what it names, skipping entries equal to those of `base` at the same
   * path (`base` is a tree already complete: a parent commit's).
   */
  async checkTree(tree: string, base: string | undefined): Promise<void> {
    const stack: Array<[string, string | undefined]> = [[tree, base]];
    while (stack.length > 0) {
      const [oid, baseOid] = stack.pop() as [string, string | undefined];
      if (oid === baseOid || this.checked.has(oid)) continue;
      const entries = await this.repository.getTreeEntries?.(oid);
      if (!entries) throw new MissingObject(oid);
      this.checked.add(oid);
      this.objects++;
      let baseEntries: Map<string, { id: string; mode: number }> | undefined;
      if (baseOid) {
        const list = await this.repository.getTreeEntries?.(baseOid);
        if (list) baseEntries = new Map(list.map((e) => [e.name, e]));
      }
      for (const entry of entries) {
        const kind = entry.mode & MODE_TYPE_MASK;
        if (kind === MODE_GITLINK) continue; // a submodule's commit lives elsewhere
        const inBase = baseEntries?.get(entry.name);
        if (inBase && inBase.id === entry.id) continue;
        if (kind === MODE_TREE) {
          const baseTree =
            inBase && (inBase.mode & MODE_TYPE_MASK) === MODE_TREE ? inBase.id : undefined;
          stack.push([entry.id, baseTree]);
        } else if (!this.checked.has(entry.id)) {
          if (!(await this.repository.has(entry.id))) throw new MissingObject(entry.id);
          this.checked.add(entry.id);
          this.objects++;
        }
      }
    }
  }
}
