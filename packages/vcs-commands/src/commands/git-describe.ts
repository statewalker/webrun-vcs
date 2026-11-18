/**
 * git describe's search (builtin/describe.c `describe_commit`), for `%(describe)` of a
 * pretty format: the tag nearest to a commit by the number of commits only it reaches, as
 * `<tag>-<n>-g<abbrev>` (just `<tag>` on the tagged commit itself).
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

/** The `%(describe:...)` options: git describe's `--tags`, `--abbrev`, `--match`, `--exclude`. */
export interface DescribeOptions {
  /** Lightweight tags too (`--tags`) */
  tags?: boolean;
  /** The abbreviation length (`--abbrev=<n>`; 0: the tag alone); default `core.abbrev` */
  abbrev?: number;
  /** Only tags whose name (below `refs/tags/`) matches one of these globs (`--match`) */
  match?: readonly string[];
  /** No tags whose name matches one of these globs (`--exclude`) */
  exclude?: readonly string[];
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
    load(id: ObjectId): Promise<{ parents: ObjectId[]; committer: PersonIdent } | undefined>;
  };
  /**
   * `id` abbreviated as git's find_unique_abbrev does: to `length` digits at least (absent:
   * `core.abbrev`, auto), longer while another object shares them
   */
  abbreviate(id: ObjectId, length?: number): Promise<string>;
  /** git's wildmatch of a pattern against a tag name (default: `*`, `?`, `[...]` globs) */
  wildmatch?: (pattern: string, text: string) => boolean;
}

/** A name a commit may be described by (describe.c's commit_name). */
interface CommitName {
  peeled: ObjectId;
  /** annotated 2, lightweight 1 */
  prio: number;
  /** The tag ref's value (the tag object of an annotated tag) */
  oid: ObjectId;
  /** The name below refs/tags/ */
  path: string;
  /** An annotated tag's name and date, once read */
  tag?: { name: string; date: number };
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
const MAX_TAGS = 28;
const DEFAULT_CANDIDATES = 10;

/**
 * A `git describe <commit>` of the source's refs: the description, or an empty string where
 * git describe fails (no tag can describe the commit), as `%(describe)` shows it.
 */
export function createDescriber(
  source: DescriberSource,
): (id: ObjectId, options?: DescribeOptions) => Promise<string> {
  const match = source.wildmatch ?? globMatch;
  return async (id, options = {}) => {
    const names = await knownNames(source, options, match);
    if (names.size === 0) return "";
    return describeCommit(source, names, id, options);
  };
}

/** describe.c's get_name over refs/tags/: the best name of each peeled object. */
async function knownNames(
  source: DescriberSource,
  options: DescribeOptions,
  match: (pattern: string, text: string) => boolean,
): Promise<Map<ObjectId, CommitName>> {
  const refs: { name: string; objectId?: ObjectId; target?: string }[] = [];
  for await (const ref of source.refs.list("refs/tags/")) {
    if (ref.name.startsWith("refs/tags/")) refs.push(ref);
  }
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const names = new Map<ObjectId, CommitName>();
  for (const ref of refs) {
    const path = ref.name.slice("refs/tags/".length);
    if ((options.exclude ?? []).some((p) => match(p, path))) continue;
    if (options.match?.length && !options.match.some((p) => match(p, path))) continue;
    const oid =
      ref.objectId && ref.target === undefined
        ? ref.objectId
        : (await source.refs.resolve(ref.name))?.objectId;
    if (!oid) continue;
    // peeled through the tag chain
    let peeled = oid;
    let first: { name: string; date: number } | undefined;
    for (let depth = 0; depth < 32 && source.tags && (await source.tags.has(peeled)); depth++) {
      const tag = await source.tags.load(peeled);
      if (!tag) break;
      first ??= { name: tag.tag, date: tag.tagger?.timestamp ?? 0 };
      peeled = tag.object;
    }
    const prio = peeled !== oid ? 2 : 1;
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
  return names;
}

/** One candidate tag of the search (describe.c's possible_tag). */
interface PossibleTag {
  name: CommitName;
  depth: number;
  foundOrder: number;
  flagWithin: number;
}

/** describe.c's describe_commit. */
async function describeCommit(
  source: DescriberSource,
  names: Map<ObjectId, CommitName>,
  id: ObjectId,
  options: DescribeOptions,
): Promise<string> {
  const tags = !!options.tags;
  const abbrev = options.abbrev;
  const suffix = async (depth: number, oid: ObjectId) =>
    `-${depth}-g${await source.abbreviate(oid, abbrev)}`;
  // append_name: an annotated tag by its own name (a different ref name is "misnamed")
  const nameOf = (n: CommitName) => ({
    text: n.tag ? n.tag.name : n.path,
    misnamed: !!n.tag && n.tag.name !== n.path,
  });
  const exact = names.get(id);
  if (exact && (tags || exact.prio === 2)) {
    const { text, misnamed } = nameOf(exact);
    return misnamed ? text + (await suffix(0, id)) : text;
  }
  const maxCandidates = Math.min(DEFAULT_CANDIDATES, MAX_TAGS);

  interface Node {
    id: ObjectId;
    date: number;
    flags: number;
    seen: boolean;
    parents?: ObjectId[];
  }
  const nodes = new Map<ObjectId, Node>();
  const node = async (oid: ObjectId): Promise<Node | undefined> => {
    let n = nodes.get(oid);
    if (!n) {
      const commit = await source.commits.load(oid);
      if (!commit) return undefined;
      n = {
        id: oid,
        date: commit.committer.timestamp,
        flags: 0,
        seen: false,
        parents: commit.parents,
      };
      nodes.set(oid, n);
    }
    return n;
  };
  // prio_queue by commit date, newest first, ties in insertion order
  let counter = 0;
  const queue: { node: Node; ctr: number }[] = [];
  const put = (n: Node) => {
    const entry = { node: n, ctr: counter++ };
    let k = queue.length;
    while (
      k > 0 &&
      (queue[k - 1].node.date < n.date ||
        (queue[k - 1].node.date === n.date && queue[k - 1].ctr > entry.ctr))
    )
      k--;
    queue.splice(k, 0, entry);
  };
  const get = () => queue.shift()?.node;

  const start = await node(id);
  if (!start) return "";
  start.flags = 0;
  start.seen = true;
  put(start);
  const matches: PossibleTag[] = [];
  let annotated = 0;
  let unannotated = 0;
  let seenCommits = 0;
  let gaveUpOn: Node | undefined;
  for (let c = get(); c; c = get()) {
    seenCommits++;
    if (matches.length === maxCandidates || matches.length === names.size) {
      gaveUpOn = c;
      break;
    }
    const n = names.get(c.id);
    if (n) {
      if (!tags && n.prio < 2) unannotated++;
      else if (matches.length < maxCandidates) {
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
      }
    }
    for (const t of matches) if (!(c.flags & t.flagWithin)) t.depth++;
    // the last remaining path already covered by the best candidates
    if (annotated && queue.length === 0) {
      let bestDepth = Number.MAX_SAFE_INTEGER;
      let bestWithin = 0;
      for (const t of matches) {
        if (t.depth < bestDepth) {
          bestDepth = t.depth;
          bestWithin = t.flagWithin;
        } else if (t.depth === bestDepth) bestWithin |= t.flagWithin;
      }
      if ((c.flags & bestWithin) === bestWithin) break;
    }
    for (const pid of c.parents ?? []) {
      const p = await node(pid);
      if (!p) continue;
      if (!p.seen) {
        p.seen = true;
        put(p);
      }
      p.flags |= c.flags;
    }
  }
  void unannotated;
  if (matches.length === 0) return "";
  matches.sort((a, b) => a.depth - b.depth || a.foundOrder - b.foundOrder);
  const best = matches[0] as PossibleTag;
  if (gaveUpOn) put(gaveUpOn);
  // finish_depth_computation
  const unflagged = new Set<ObjectId>();
  for (const e of queue) if (!(e.node.flags & best.flagWithin)) unflagged.add(e.node.id);
  for (let c = get(); c; c = get()) {
    if (c.flags & best.flagWithin) {
      if (unflagged.size === 0) break;
    } else {
      unflagged.delete(c.id);
      best.depth++;
    }
    for (const pid of c.parents ?? []) {
      const p = await node(pid);
      if (!p) continue;
      const seen = p.seen;
      if (!seen) {
        p.seen = true;
        put(p);
      }
      const before = p.flags & best.flagWithin;
      p.flags |= c.flags;
      const after = p.flags & best.flagWithin;
      if (!seen && !after) unflagged.add(p.id);
      if (seen && !before && after) unflagged.delete(p.id);
    }
  }
  const { text, misnamed } = nameOf(best.name);
  return misnamed || abbrev !== 0 ? text + (await suffix(best.depth, id)) : text;
}
