/**
 * git describe's search (builtin/describe.c): the tag nearest to a commit by the number of
 * commits only it reaches, as `<tag>-<n>-g<abbrev>` (just `<tag>` on the tagged commit
 * itself), and a blob by the first commit that brings it, as `<description>:<path>`.
 * `%(describe)` of a pretty format, `submodule status` and `git describe` itself use it.
 *
 * @example
 * ```typescript
 * const describe = createDescriber({ refs, tags, commits, abbreviate });
 * await describe(id, {});                 // "v1.2-3-g1a2b3c4"
 * await describe(id, { tags: true });     // lightweight tags too
 * await describe(id, { match: ["v1*"], abbrev: 0 }); // "v1.2"
 * ```
 *
 * @module
 */

import type { ObjectId, PersonIdent } from "@statewalker/vcs-core";

/** git describe's search options. */
export interface DescribeOptions {
  /** Lightweight tags too (`--tags`) */
  tags?: boolean;
  /** The abbreviation length (`--abbrev=<n>`; 0: the tag alone); default `core.abbrev` */
  abbrev?: number;
  /** Only tags whose name (below `refs/tags/`) matches one of these globs (`--match`) */
  match?: readonly string[];
  /** No tags whose name matches one of these globs (`--exclude`) */
  exclude?: readonly string[];
  /** Any ref, not only tags (`--all`): names below `refs/`, an annotated tag as `tags/<name>` */
  all?: boolean;
  /** The abbreviated id when nothing describes the commit (`--always`) */
  always?: boolean;
  /** `--long`: the `-<n>-g<abbrev>` suffix on an exact match too */
  long?: boolean;
  /** `--first-parent`: only first parents are followed */
  firstParent?: boolean;
  /** `--candidates=<n>` (0: `--exact-match`); default 10, at most 28 */
  candidates?: number;
  /** `--debug`: the search strategy on stderr */
  debug?: boolean;
  /**
   * git 2.43's search: it gives up only at a candidate beyond the limit (2.5x also once it
   * has every name), suffixes a lightweight exact match with the id named (a tag's own) and says so
   * in another debug line
   */
  compatibility?: "2.43" | "2.56";
}

/** What {@link createDescriber} reads. */
export interface DescriberSource {
  refs: {
    list(prefix?: string): AsyncIterable<{ name: string; objectId?: ObjectId; target?: string }>;
    resolve(name: string): Promise<{ objectId?: ObjectId } | undefined>;
  };
  tags?: {
    has(id: ObjectId): Promise<boolean>;
    load(
      id: ObjectId,
    ): Promise<{ object: ObjectId; tag: string; tagger?: PersonIdent } | undefined>;
  };
  commits: {
    load(
      id: ObjectId,
    ): Promise<{ parents: ObjectId[]; committer: PersonIdent; tree?: ObjectId } | undefined>;
  };
  /** A tree's entries, in tree order (for blobs) */
  trees?: {
    load(
      id: ObjectId,
    ): Promise<AsyncIterable<{ mode: number; name: string; id: ObjectId }> | undefined>;
  };
  /**
   * `id` abbreviated as git's find_unique_abbrev does: to `length` digits at least (absent:
   * `core.abbrev`, auto), longer while another object shares them
   */
  abbreviate(id: ObjectId, length?: number): Promise<string>;
  /** git's wildmatch of a pattern against a tag name (default: `*`, `?`, `[...]` globs) */
  wildmatch?: (pattern: string, text: string) => boolean;
}

/** A failure where git describe dies: its message (without `fatal: `). */
export class DescribeDeath extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DescribeDeath";
  }
}

/** A name a commit may be described by (describe.c's commit_name). */
interface CommitName {
  peeled: ObjectId;
  /** annotated 2, lightweight 1, other refs 0 */
  prio: number;
  /** The ref's value (the tag object of an annotated tag) */
  oid: ObjectId;
  /** The name below refs/tags/ (refs/ with --all) */
  path: string;
  /** An annotated tag's name, date and target, once read */
  tag?: { name: string; date: number; object: ObjectId };
  nameChecked?: boolean;
  misnamed?: boolean;
}

/** A simple wildmatch: `*` (any run), `?` (one character), `[...]` classes. */
function globMatch(pattern: string, text: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end < 0) re += "\\[";
      else {
        let cls = pattern.slice(i + 1, end);
        if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
        re += `[${cls.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s").test(text);
}

/** describe.c's MAX_TAGS (FLAG_BITS - 1) */
export const DESCRIBE_MAX_TAGS = 28;
const DEFAULT_CANDIDATES = 10;
const PRIO_NAMES = ["head", "lightweight", "annotated"];
const LABEL_WIDTH = Math.max(...PRIO_NAMES.map((n) => n.length));

/** A commit of the search. */
interface Node {
  id: ObjectId;
  date: number;
  flags: number;
  seen: boolean;
  parents: ObjectId[];
  tree?: ObjectId;
}

/** prio_queue by commit date, newest first, ties in insertion order. */
class DateQueue {
  private items: { node: Node; ctr: number }[] = [];
  private counter = 0;

  get size(): number {
    return this.items.length;
  }

  put(node: Node): void {
    const entry = { node, ctr: this.counter++ };
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = this.items[mid] as { node: Node; ctr: number };
      if (m.node.date > node.date || (m.node.date === node.date && m.ctr < entry.ctr)) {
        lo = mid + 1;
      } else hi = mid;
    }
    this.items.splice(lo, 0, entry);
  }

  get(): Node | undefined {
    return this.items.shift()?.node;
  }

  nodes(): Node[] {
    return this.items.map((e) => e.node);
  }
}

/** One candidate tag of the search (describe.c's possible_tag). */
interface PossibleTag {
  name: CommitName;
  depth: number;
  foundOrder: number;
  flagWithin: number;
}

/**
 * builtin/describe.c over one repository: the names read once ({@link load}), then any
 * number of commits or blobs described, with git's stderr lines (warnings, `--debug`) in
 * {@link stderr}.
 */
export class Describer {
  /** The lines git prints on stderr, in order */
  readonly stderr: string[] = [];
  /** The name and depth the last {@link describeCommit} found (none: `--always`'s id) */
  lastMatch?: { tag: string; depth: number };
  private names = new Map<ObjectId, CommitName>();
  private readonly match: (pattern: string, text: string) => boolean;
  private readonly maxCandidates: number;

  constructor(
    private readonly source: DescriberSource,
    private readonly options: DescribeOptions = {},
  ) {
    this.match = source.wildmatch ?? globMatch;
    const candidates = options.candidates ?? DEFAULT_CANDIDATES;
    this.maxCandidates = Math.min(Math.max(candidates, 0), DESCRIBE_MAX_TAGS);
  }

  /** How many names were found (git dies without any unless `--always`). */
  get nameCount(): number {
    return this.names.size;
  }

  /** describe.c's get_name over refs/tags/ (refs/ with `--all`). */
  async load(): Promise<void> {
    const { source, options } = this;
    const refs: { name: string; objectId?: ObjectId; target?: string }[] = [];
    const prefix = options.all ? "refs/" : "refs/tags/";
    for await (const ref of source.refs.list(prefix)) {
      if (ref.name.startsWith(prefix)) refs.push(ref);
    }
    refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const names = new Map<ObjectId, CommitName>();
    const filtered = !!(options.exclude?.length || options.match?.length);
    for (const ref of refs) {
      const isTag = ref.name.startsWith("refs/tags/");
      let matched = isTag ? ref.name.slice("refs/tags/".length) : undefined;
      if (!isTag && filtered) {
        // with --all, only refs of a known kind take match/exclude patterns
        for (const kind of ["refs/heads/", "refs/remotes/"]) {
          if (ref.name.startsWith(kind)) matched = ref.name.slice(kind.length);
        }
        if (matched === undefined) continue;
      }
      if (matched !== undefined) {
        const text = matched;
        if ((options.exclude ?? []).some((p) => this.match(p, text))) continue;
        if (options.match?.length && !options.match.some((p) => this.match(p, text))) continue;
      }
      const path = options.all ? ref.name.slice("refs/".length) : (matched as string);
      const oid =
        ref.objectId && ref.target === undefined
          ? ref.objectId
          : (await source.refs.resolve(ref.name).catch(() => undefined))?.objectId;
      if (!oid) continue;
      // peeled through the tag chain
      let peeled = oid;
      let first: { name: string; date: number; object: ObjectId } | undefined;
      for (
        let depth = 0;
        depth < 32 && source.tags && (await isTagObject(source, peeled));
        depth++
      ) {
        const tag = await source.tags.load(peeled).catch(() => undefined);
        if (!tag) break;
        first ??= { name: tag.tag, date: tag.tagger?.timestamp ?? 0, object: tag.object };
        peeled = tag.object;
      }
      const prio = peeled !== oid ? 2 : isTag ? 1 : 0;
      const known = names.get(peeled);
      // replace_name: a better kind, or the newer of two annotated tags
      let replace = !known || known.prio < prio;
      if (known && known.prio === 2 && prio === 2) {
        replace = (known.tag?.date ?? 0) < (first?.date ?? 0);
      }
      if (replace) {
        names.set(peeled, {
          peeled,
          prio,
          oid,
          path,
          ...(prio === 2 && first ? { tag: first } : {}),
        });
      }
    }
    this.names = names;
  }

  /** append_name: an annotated tag by its own name (another ref name is "misnamed"). */
  private appendName(n: CommitName): string {
    const all = !!this.options.all;
    if (n.tag && !n.nameChecked) {
      if (n.tag.name !== (all ? n.path.slice(5) : n.path)) {
        this.stderr.push(`warning: tag '${n.path}' is externally known as '${n.tag.name}'`);
        n.misnamed = true;
      }
      n.nameChecked = true;
    }
    if (n.tag) return `${all ? "tags/" : ""}${n.tag.name}`;
    return n.path;
  }

  private async suffix(depth: number, oid: ObjectId): Promise<string> {
    return `-${depth}-g${await this.source.abbreviate(oid, this.options.abbrev)}`;
  }

  /**
   * describe_commit of `commit` (`named`: the object the revision named, which 2.43
   * suffixes a lightweight exact match with: an annotated tag's own id).
   *
   * @throws DescribeDeath where git dies
   */
  async describeCommit(commit: ObjectId, named: ObjectId = commit): Promise<string> {
    const { options, source } = this;
    const legacy = options.compatibility === "2.43";
    const all = !!options.all;
    const tags = !!options.tags || all;
    // 2.43 suffixes a lightweight exact match with the id named (a tag's own)
    const self = legacy ? named : commit;
    this.lastMatch = undefined;
    const exact = this.names.get(commit);
    if (exact && (tags || exact.prio === 2)) {
      const text = this.appendName(exact);
      this.lastMatch = { tag: text, depth: 0 };
      if (exact.misnamed || options.long) {
        return text + (await this.suffix(0, exact.tag ? exact.tag.object : self));
      }
      return text;
    }
    if (!this.maxCandidates) throw new DescribeDeath(`no tag exactly matches '${commit}'`);
    if (options.debug) {
      this.stderr.push("No exact match on refs or tags, searching to describe");
    }

    const nodes = new Map<ObjectId, Node | null>();
    const node = async (oid: ObjectId): Promise<Node | undefined> => {
      let n = nodes.get(oid);
      if (n === undefined) {
        const c = await source.commits.load(oid).catch(() => undefined);
        n = c
          ? {
              id: oid,
              date: c.committer.timestamp,
              flags: 0,
              seen: false,
              parents: c.parents,
              ...(c.tree ? { tree: c.tree } : {}),
            }
          : null;
        nodes.set(oid, n);
      }
      return n ?? undefined;
    };
    const queue = new DateQueue();
    const start = await node(commit);
    if (!start) throw new DescribeDeath(`${commit} is neither a commit nor blob`);
    start.seen = true;
    queue.put(start);
    const matches: PossibleTag[] = [];
    let annotated = 0;
    let unannotated = 0;
    let seenCommits = 0;
    let gaveUpOn: Node | undefined;
    for (let c = queue.get(); c; c = queue.get()) {
      seenCommits++;
      if (
        !legacy &&
        (matches.length === this.maxCandidates || matches.length === this.names.size)
      ) {
        gaveUpOn = c;
        break;
      }
      const n = this.names.get(c.id);
      if (n) {
        if (!tags && n.prio < 2) unannotated++;
        else if (matches.length < this.maxCandidates) {
          const order = matches.length + 1;
          const t: PossibleTag = {
            name: n,
            depth: seenCommits - 1,
            flagWithin: 2 ** order,
            foundOrder: order,
          };
          matches.push(t);
          c.flags |= t.flagWithin;
          if (n.prio === 2) annotated++;
        } else {
          gaveUpOn = c;
          break;
        }
      }
      for (const t of matches) if (!(c.flags & t.flagWithin)) t.depth++;
      // the last remaining path already covered by the best candidates
      if (annotated && queue.size === 0) {
        let bestDepth = Number.MAX_SAFE_INTEGER;
        let bestWithin = 0;
        for (const t of matches) {
          if (t.depth < bestDepth) {
            bestDepth = t.depth;
            bestWithin = t.flagWithin;
          } else if (t.depth === bestDepth) bestWithin |= t.flagWithin;
        }
        if ((c.flags & bestWithin) === bestWithin) {
          if (options.debug) this.stderr.push(`finished search at ${c.id}`);
          break;
        }
      }
      for (const pid of c.parents) {
        const p = await node(pid);
        if (p) {
          if (!p.seen) {
            p.seen = true;
            queue.put(p);
          }
          p.flags |= c.flags;
        }
        if (options.firstParent) break;
      }
    }
    if (matches.length === 0) {
      if (options.always) return source.abbreviate(commit, options.abbrev);
      if (unannotated) {
        throw new DescribeDeath(
          `No annotated tags can describe '${commit}'.\nHowever, there were unannotated tags: try --tags.`,
        );
      }
      throw new DescribeDeath(
        `No tags can describe '${commit}'.\nTry --always, or create some tags.`,
      );
    }
    // QSORT (stable): depth, then the order found
    matches.sort((a, b) => a.depth - b.depth || a.foundOrder - b.foundOrder);
    const best = matches[0] as PossibleTag;
    if (gaveUpOn) {
      queue.put(gaveUpOn);
      seenCommits--;
    }
    seenCommits += await this.finishDepth(queue, best, node);
    if (options.debug) {
      for (const t of matches) {
        const label = PRIO_NAMES[t.name.prio] as string;
        this.stderr.push(
          ` ${label.padEnd(LABEL_WIDTH)} ${String(t.depth).padStart(8)} ${t.name.path}`,
        );
      }
      this.stderr.push(`traversed ${seenCommits} commits`);
      if (gaveUpOn) {
        if (legacy) {
          this.stderr.push(
            `more than ${this.maxCandidates} tags found; listed ${this.maxCandidates} most recent`,
            `gave up search at ${gaveUpOn.id}`,
          );
        } else {
          this.stderr.push(`found ${this.maxCandidates} tags; gave up search at ${gaveUpOn.id}`);
        }
      }
    }
    const text = this.appendName(best.name);
    this.lastMatch = { tag: text, depth: best.depth };
    if (best.name.misnamed || options.abbrev !== 0) {
      return text + (await this.suffix(best.depth, commit));
    }
    return text;
  }

  /** finish_depth_computation: the commits the best candidate does not reach. */
  private async finishDepth(
    queue: DateQueue,
    best: PossibleTag,
    node: (oid: ObjectId) => Promise<Node | undefined>,
  ): Promise<number> {
    let seenCommits = 0;
    const unflagged = new Set<ObjectId>();
    for (const n of queue.nodes()) if (!(n.flags & best.flagWithin)) unflagged.add(n.id);
    for (let c = queue.get(); c; c = queue.get()) {
      seenCommits++;
      if (c.flags & best.flagWithin) {
        if (unflagged.size === 0) break;
      } else {
        unflagged.delete(c.id);
        best.depth++;
      }
      for (const pid of c.parents) {
        const p = await node(pid);
        if (!p) continue;
        const seen = p.seen;
        if (!seen) {
          p.seen = true;
          queue.put(p);
        }
        const before = p.flags & best.flagWithin;
        p.flags |= c.flags;
        const after = p.flags & best.flagWithin;
        if (!seen && !after) unflagged.add(p.id);
        if (seen && !before && after) unflagged.delete(p.id);
      }
    }
    return seenCommits;
  }

  /**
   * describe_blob: the first commit (oldest first, in `rev-list --objects --reverse HEAD`'s
   * order) whose tree holds the blob, described, and the blob's path in it.
   *
   * @throws DescribeDeath when HEAD does not reach it (2.43: an empty description)
   */
  async describeBlob(blob: ObjectId, head: ObjectId | undefined): Promise<string> {
    const legacy = this.options.compatibility === "2.43";
    if (head === undefined) {
      throw new DescribeDeath(`cannot search for blob '${blob}' on an unborn branch`);
    }
    const { source } = this;
    // the default rev-list walk: commit date order, ties in the order queued
    const order: Node[] = [];
    const nodes = new Map<ObjectId, Node>();
    const queue = new DateQueue();
    const load = async (oid: ObjectId) => {
      const c = await source.commits.load(oid).catch(() => undefined);
      if (!c) return undefined;
      const n: Node = {
        id: oid,
        date: c.committer.timestamp,
        flags: 0,
        seen: true,
        parents: c.parents,
        ...(c.tree ? { tree: c.tree } : {}),
      };
      nodes.set(oid, n);
      return n;
    };
    const first = await load(head);
    if (first) queue.put(first);
    for (let c = queue.get(); c; c = queue.get()) {
      order.push(c);
      for (const pid of c.parents) {
        if (nodes.has(pid)) continue;
        const p = await load(pid);
        if (p) queue.put(p);
      }
    }
    order.reverse();
    const seenTrees = new Set<ObjectId>();
    const find = async (tree: ObjectId, base: string): Promise<string | undefined> => {
      if (seenTrees.has(tree)) return undefined;
      seenTrees.add(tree);
      const entries = await source.trees?.load(tree).catch(() => undefined);
      if (!entries) return undefined;
      for await (const e of entries) {
        const path = base + e.name;
        if ((e.mode & 0o170000) === 0o040000) {
          const found = await find(e.id, `${path}/`);
          if (found !== undefined) return found;
        } else if ((e.mode & 0o170000) === 0o160000) {
          // a gitlink names no object here
        } else if (e.id === blob) return path;
      }
      return undefined;
    };
    for (const c of order) {
      if (!c.tree) continue;
      const path = await find(c.tree, "");
      if (path !== undefined) return `${await this.describeCommit(c.id)}:${path}`;
    }
    if (legacy) return "";
    throw new DescribeDeath(`blob '${blob}' not reachable from HEAD`);
  }
}

async function isTagObject(source: DescriberSource, id: ObjectId): Promise<boolean> {
  return (await source.tags?.has(id).catch(() => false)) ?? false;
}

/**
 * A `git describe <commit>` of the source's refs: the description, or an empty string where
 * git describe fails (no tag can describe the commit), as `%(describe)` shows it.
 */
export function createDescriber(
  source: DescriberSource,
): (id: ObjectId, options?: DescribeOptions) => Promise<string> {
  return async (id, options = {}) => {
    const describer = new Describer(source, options);
    await describer.load();
    if (describer.nameCount === 0 && !options.always) return "";
    return describer.describeCommit(id).catch((e) => {
      if (e instanceof DescribeDeath) return "";
      throw e;
    });
  };
}
