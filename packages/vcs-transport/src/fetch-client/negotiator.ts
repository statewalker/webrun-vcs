/**
 * git's fetch negotiators (negotiator/default.c, skipping.c, noop.c), over an async commit
 * source.
 */

/** A local commit as the negotiator walks it. */
export interface NegotiatorCommit {
  /** Parent commit ids (empty for a root commit) */
  parents: string[];
  /** Committer time, seconds since the epoch: newer commits are offered first */
  time: number;
}

/** Where the negotiator reads local commits from (a `RepositoryFacade` fits). */
export interface NegotiatorSource {
  /** The commit's parents and time, or undefined when `oid` is not a commit here. */
  getCommitInfo(oid: string): Promise<NegotiatorCommit | undefined>;
  /** The object an annotated tag points at; null or undefined for anything else. */
  peelTag?(oid: string): Promise<string | null | undefined>;
}

export interface NegotiatorOptions {
  /** The local shallow commits: their parents are not walked (they are not here) */
  shallow?: Iterable<string>;
  /**
   * The commits git has parsed before the negotiation starts (the skipping negotiator only):
   * the local tips, the remote refs here and the parents of the commits fetch-pack's
   * `mark_recent_complete_commits` walked. Its queue orders a commit git has not parsed as
   * dated 0, and `mark_common` does not walk past one
   */
  parsed?: Iterable<string>;
}

/** `fetch.negotiationAlgorithm`: which negotiator chooses the haves. */
export type NegotiationAlgorithm = "consecutive" | "skipping" | "noop";

/** What fetch-pack asks of a negotiator (git's `struct fetch_negotiator`). */
export interface FetchNegotiator {
  /** A local tip (a ref, or a `--negotiation-tip`), annotated tags peeled */
  addTip(oid: string): Promise<void>;
  /** A commit the server has (a remote ref already here, and complete) */
  knownCommon(oid: string): Promise<void>;
  /** The next commit to offer as `have`, or undefined when there is none */
  next(): Promise<string | undefined>;
  /** The server acknowledged `oid`; whether it was known to be common already */
  ack(oid: string): Promise<boolean>;
  /** Whether `oid` is known to be common with the server (an acknowledged commit or an ancestor) */
  isCommon(oid: string): boolean;
}

/**
 * The negotiator `fetch.negotiationAlgorithm` names (repo-settings.c: `consecutive`,
 * `skipping`, `noop`; `default` is the default, `skipping` under `feature.experimental`).
 */
export function createNegotiator(
  algorithm: NegotiationAlgorithm | undefined,
  source: NegotiatorSource,
  options: NegotiatorOptions = {},
): FetchNegotiator {
  if (algorithm === "skipping") return new SkippingNegotiator(source, options);
  if (algorithm === "noop") return new NoopNegotiator();
  return new Negotiator(source, options);
}

/**
 * Reads `fetch.negotiationAlgorithm` as repo-settings.c does: `skipping`, `noop`,
 * `consecutive` (case-insensitive), `default` (the default: `skipping` under
 * `feature.experimental`, else `consecutive`); any other value is git's death
 * `unknown fetch negotiation algorithm '<value>'`.
 */
export function negotiationAlgorithmOf(
  value: string | undefined,
  experimental = false,
): NegotiationAlgorithm {
  const fallback: NegotiationAlgorithm = experimental ? "skipping" : "consecutive";
  if (value === undefined) return fallback;
  const lower = value.toLowerCase();
  if (lower === "skipping" || lower === "noop" || lower === "consecutive") return lower;
  if (lower === "default") return fallback;
  throw new Error(`unknown fetch negotiation algorithm '${value}'`);
}

/** git's noop negotiator: offers nothing, so the server sends everything the wants reach. */
export class NoopNegotiator implements FetchNegotiator {
  async addTip(): Promise<void> {}
  async knownCommon(): Promise<void> {}
  async next(): Promise<string | undefined> {
    return undefined;
  }
  async ack(): Promise<boolean> {
    return false;
  }
  isCommon(): boolean {
    return false;
  }
}

const COMMON = 1;
const COMMON_REF = 2;
const SEEN = 4;
const POPPED = 8;

interface Node {
  oid: string;
  flags: number;
  /** undefined until parsed; null when `oid` is not a local commit */
  info?: NegotiatorCommit | null;
}

/**
 * Chooses the `have` lines of a fetch as git's default ("consecutive") negotiator does.
 *
 * Local ref tips go into a queue ordered by committer date, newest first. Each {@link next}
 * pops the newest commit, queues its parents and offers it, so the history is walked
 * backwards from all tips at once. A commit the server acknowledges ({@link ack}) is common,
 * and so are its ancestors: they are never offered, and once only common commits are queued
 * the negotiator is exhausted. A commit the server is known to have ({@link knownCommon}: a
 * remote ref tip already here) is offered once, but its ancestors are not.
 *
 * @example
 * ```ts
 * const negotiator = new Negotiator(repository);
 * for (const [, oid] of localRefs) await negotiator.addTip(oid);
 * for (let have = await negotiator.next(); have; have = await negotiator.next()) {
 *   send(`have ${have}`);
 * }
 * ```
 */
export class Negotiator implements FetchNegotiator {
  private readonly nodes = new Map<string, Node>();
  private readonly queue = new CommitQueue();
  private readonly shallow: Set<string>;
  /** Queued commits not known to be common (git's non_common_revs) */
  private nonCommon = 0;

  constructor(
    private readonly source: NegotiatorSource,
    options: NegotiatorOptions = {},
  ) {
    this.shallow = new Set(options.shallow ?? []);
  }

  /** A local tip (a ref; annotated tags are peeled to their commit): offered with its ancestry. */
  async addTip(oid: string): Promise<void> {
    const node = await this.commitNode(oid);
    if (node) await this.push(node, SEEN);
  }

  /**
   * A commit the server has (a remote ref already here): offered once, its ancestors are
   * common and never offered.
   */
  async knownCommon(oid: string): Promise<void> {
    const node = await this.commitNode(oid);
    if (!node || node.flags & SEEN) return;
    await this.push(node, COMMON_REF | SEEN);
    await this.markCommon(node, true, true);
  }

  /** The next commit to offer as `have`, or undefined when nothing but common commits is left. */
  async next(): Promise<string | undefined> {
    while (true) {
      if (this.queue.size === 0 || this.nonCommon === 0) return undefined;
      const node = this.queue.pop() as Node;
      const info = await this.parse(node);
      node.flags |= POPPED;
      if (!(node.flags & COMMON)) this.nonCommon--;
      let offer = true;
      let mark: number;
      if (node.flags & COMMON) {
        // not offered, and neither are its ancestors
        offer = false;
        mark = COMMON | SEEN;
      } else if (node.flags & COMMON_REF) {
        // offered, its ancestors are not
        mark = COMMON | SEEN;
      } else {
        mark = SEEN;
      }
      for (const parentId of this.parentsOf(node.oid, info)) {
        const parent = this.node(parentId);
        if (!(parent.flags & SEEN)) await this.push(parent, mark);
        if (mark & COMMON) await this.markCommon(parent, true, false);
      }
      if (offer) return node.oid;
    }
  }

  /**
   * The server acknowledged `oid` (an `ACK`): it and its ancestors are common. Returns
   * whether it was common already (git's `ack` result); a fetch counts haves "in vain" from
   * the last commit newly found common.
   */
  async ack(oid: string): Promise<boolean> {
    const node = this.node(oid);
    const known = (node.flags & COMMON) !== 0;
    await this.markCommon(node, false, true);
    return known;
  }

  /** Whether `oid` is known to be common with the server. */
  isCommon(oid: string): boolean {
    return ((this.nodes.get(oid)?.flags ?? 0) & COMMON) !== 0;
  }

  private node(oid: string): Node {
    let node = this.nodes.get(oid);
    if (!node) {
      node = { oid, flags: 0 };
      this.nodes.set(oid, node);
    }
    return node;
  }

  /** The node of the commit `oid` peels to (tags followed), or undefined when it is no commit here. */
  private async commitNode(oid: string): Promise<Node | undefined> {
    let id = oid;
    for (let i = 0; i < 16; i++) {
      const node = this.node(id);
      if (await this.parse(node)) return node;
      const target = await this.source.peelTag?.(id);
      if (!target || target === id) return undefined;
      id = target;
    }
    return undefined;
  }

  private async parse(node: Node): Promise<NegotiatorCommit | null> {
    if (node.info === undefined) {
      node.info = (await this.source.getCommitInfo(node.oid)) ?? null;
    }
    return node.info;
  }

  private parentsOf(oid: string, info: NegotiatorCommit | null | undefined): string[] {
    if (!info || this.shallow.has(oid)) return [];
    return info.parents;
  }

  /** git's rev_list_push: mark, and queue a commit the first time it gets `mark`. */
  private async push(node: Node, mark: number): Promise<void> {
    if (node.flags & mark) return;
    node.flags |= mark;
    const info = await this.parse(node);
    if (!info) return;
    this.queue.push(node, info.time);
    if (!(node.flags & COMMON)) this.nonCommon++;
  }

  /** git's mark_common: `node` (unless `ancestorsOnly`) and its ancestors become common. */
  private async markCommon(start: Node, ancestorsOnly: boolean, dontParse: boolean): Promise<void> {
    if (start.flags & COMMON) return;
    const queue = new CommitQueue();
    queue.push(start, start.info?.time ?? 0);
    if (!ancestorsOnly) {
      start.flags |= COMMON;
      if (start.flags & SEEN && !(start.flags & POPPED)) this.nonCommon--;
    }
    while (queue.size > 0) {
      const node = queue.pop() as Node;
      if (!(node.flags & SEEN)) {
        await this.push(node, SEEN);
        continue;
      }
      if (node.info === undefined && dontParse) continue;
      const info = await this.parse(node);
      if (!info) continue;
      for (const parentId of this.parentsOf(node.oid, info)) {
        const parent = this.node(parentId);
        if (parent.flags & COMMON) continue;
        parent.flags |= COMMON;
        if (parent.flags & SEEN && !(parent.flags & POPPED)) this.nonCommon--;
        queue.push(parent, parent.info?.time ?? 0);
      }
    }
  }
}

/** git's prio_queue by commit date: newest first, first in first out among equal dates. */
class CommitQueue {
  private heap: { node: Node; time: number; seq: number }[] = [];
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(node: Node, time: number): void {
    const heap = this.heap;
    heap.push({ node, time, seq: this.seq++ });
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(i, parent)) break;
      [heap[i], heap[parent]] = [heap[parent], heap[i]] as [never, never];
      i = parent;
    }
  }

  pop(): Node | undefined {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (!top || !last) return undefined;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      while (true) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < heap.length && this.before(l, best)) best = l;
        if (r < heap.length && this.before(r, best)) best = r;
        if (best === i) break;
        [heap[i], heap[best]] = [heap[best], heap[i]] as [never, never];
        i = best;
      }
    }
    return top.node;
  }

  private before(a: number, b: number): boolean {
    const x = this.heap[a] as { time: number; seq: number };
    const y = this.heap[b] as { time: number; seq: number };
    return x.time !== y.time ? x.time > y.time : x.seq < y.seq;
  }
}

const SKIP_COMMON = 1;
const SKIP_ADVERTISED = 2;
const SKIP_SEEN = 4;
const SKIP_POPPED = 8;

interface SkipNode {
  oid: string;
  flags: number;
  /** Whether git has parsed the commit (its date and parents are known to it) */
  parsed: boolean;
  /** undefined until read; null when `oid` is not a local commit */
  info?: NegotiatorCommit | null;
  /** The node's queue entry while it is queued */
  entry?: SkipEntry;
}

interface SkipEntry {
  node: SkipNode;
  originalTtl: number;
  ttl: number;
  /** The date the queue compares (0 for a commit git had not parsed when it was queued) */
  time: number;
  seq: number;
}

/**
 * git's skipping negotiator (negotiator/skipping.c): walks back from the tips by commit date
 * as the default one, but skips commits, offering one, then one after 1 skipped, then after
 * 2, 4, ... (each distance about 3/2 of the last), so long histories are negotiated in few
 * rounds. A commit with no parent left to walk (a root, or parents already popped through
 * clock skew) is always offered. An acknowledged commit and every ancestor it has walked are
 * common; an advertised remote ref is offered, its ancestors are not.
 */
export class SkippingNegotiator implements FetchNegotiator {
  private readonly nodes = new Map<string, SkipNode>();
  private readonly shallow: Set<string>;
  private readonly preParsed: Set<string>;
  private readonly heap: SkipEntry[] = [];
  private seq = 0;
  /** git's non_common_revs */
  private nonCommon = 0;
  private acceptsKnownCommon = true;
  private acceptsTips = true;

  constructor(
    private readonly source: NegotiatorSource,
    options: NegotiatorOptions = {},
  ) {
    this.shallow = new Set(options.shallow ?? []);
    // a Set given is shared: what this negotiator parses stays parsed for the next one (git's
    // parsed objects outlive a negotiation, as a tag backfill's second fetch sees them)
    this.preParsed = options.parsed instanceof Set ? options.parsed : new Set(options.parsed ?? []);
  }

  async knownCommon(oid: string): Promise<void> {
    if (!this.acceptsKnownCommon) return;
    const node = await this.commitNode(oid);
    if (!node || node.flags & SKIP_SEEN) return;
    this.revListPush(node, SKIP_ADVERTISED);
  }

  async addTip(oid: string): Promise<void> {
    this.acceptsKnownCommon = false;
    if (!this.acceptsTips) return;
    const node = await this.commitNode(oid);
    if (!node || node.flags & SKIP_SEEN) return;
    this.revListPush(node, 0);
  }

  async next(): Promise<string | undefined> {
    this.acceptsKnownCommon = false;
    this.acceptsTips = false;
    let toSend: SkipNode | undefined;
    while (!toSend) {
      if (this.heap.length === 0 || this.nonCommon === 0) return undefined;
      const entry = this.pop();
      const node = entry.node;
      node.entry = undefined;
      node.flags |= SKIP_POPPED;
      if (!(node.flags & SKIP_COMMON)) this.nonCommon--;
      if (!(node.flags & SKIP_COMMON) && !entry.ttl) toSend = node;
      const info = await this.read(node);
      this.markParsed(node);
      let parentPushed = false;
      for (const parentId of this.parentsOf(node, info)) {
        if (await this.pushParent(entry, this.node(parentId))) parentPushed = true;
      }
      // no parents, or every parent popped already (clock skew): offered anyway
      if (!(node.flags & SKIP_COMMON) && !parentPushed) toSend = node;
    }
    return toSend.oid;
  }

  async ack(oid: string): Promise<boolean> {
    const node = this.node(oid);
    const known = (node.flags & SKIP_COMMON) !== 0;
    if (!(node.flags & SKIP_SEEN)) {
      throw new Error(`received ack for commit ${oid} not sent as 'have'`);
    }
    await this.markCommon(node);
    return known;
  }

  isCommon(oid: string): boolean {
    return ((this.nodes.get(oid)?.flags ?? 0) & SKIP_COMMON) !== 0;
  }

  private node(oid: string): SkipNode {
    let node = this.nodes.get(oid);
    if (!node) {
      node = { oid, flags: 0, parsed: this.preParsed.has(oid) };
      this.nodes.set(oid, node);
    }
    return node;
  }

  /** A tip's commit (tags peeled), parsed as git's deref_tag(parse_object()) leaves it. */
  private async commitNode(oid: string): Promise<SkipNode | undefined> {
    let id = oid;
    for (let i = 0; i < 16; i++) {
      const node = this.node(id);
      if (await this.read(node)) {
        this.markParsed(node);
        return node;
      }
      const target = await this.source.peelTag?.(id);
      if (!target || target === id) return undefined;
      id = target;
    }
    return undefined;
  }

  private markParsed(node: SkipNode): void {
    node.parsed = true;
    this.preParsed.add(node.oid);
  }

  private async read(node: SkipNode): Promise<NegotiatorCommit | null> {
    if (node.info === undefined) {
      node.info = (await this.source.getCommitInfo(node.oid)) ?? null;
    }
    return node.info;
  }

  private parentsOf(node: SkipNode, info: NegotiatorCommit | null): string[] {
    if (!info || this.shallow.has(node.oid)) return [];
    return info.parents;
  }

  private revListPush(node: SkipNode, mark: number): SkipEntry {
    node.flags |= mark | SKIP_SEEN;
    const entry: SkipEntry = {
      node,
      originalTtl: 0,
      ttl: 0,
      // compare_commits_by_commit_date reads the date of a parsed commit only
      time: node.parsed ? (node.info?.time ?? 0) : 0,
      seq: this.seq++,
    };
    node.entry = entry;
    this.put(entry);
    if (!(mark & SKIP_COMMON)) this.nonCommon++;
    return entry;
  }

  /** git's mark_common: `start` and every parsed, seen ancestor become common. */
  private async markCommon(start: SkipNode): Promise<void> {
    if (start.flags & SKIP_COMMON) return;
    const stack: SkipNode[] = [start];
    start.flags |= SKIP_COMMON;
    while (stack.length > 0) {
      const node = stack.pop() as SkipNode;
      if (!(node.flags & SKIP_POPPED)) this.nonCommon--;
      if (!node.parsed) continue;
      for (const parentId of this.parentsOf(node, await this.read(node))) {
        const parent = this.node(parentId);
        if (!(parent.flags & SKIP_SEEN) || parent.flags & SKIP_COMMON) continue;
        parent.flags |= SKIP_COMMON;
        stack.push(parent);
      }
    }
  }

  /** git's push_parent: the parent's entry gets the skip distance its child hands down. */
  private async pushParent(entry: SkipEntry, parent: SkipNode): Promise<boolean> {
    let parentEntry: SkipEntry;
    if (parent.flags & SKIP_SEEN) {
      // popped already through clock skew: as if the parent did not exist
      if (parent.flags & SKIP_POPPED) return false;
      parentEntry = parent.entry as SkipEntry;
    } else {
      parentEntry = this.revListPush(parent, 0);
    }
    if (entry.node.flags & (SKIP_COMMON | SKIP_ADVERTISED)) {
      await this.markCommon(parent);
    } else {
      // uint16_t arithmetic, as git's
      const newOriginalTtl = entry.ttl
        ? entry.originalTtl
        : (Math.floor((entry.originalTtl * 3) / 2) + 1) & 0xffff;
      const newTtl = entry.ttl ? entry.ttl - 1 : newOriginalTtl;
      if (parentEntry.originalTtl < newOriginalTtl) {
        parentEntry.originalTtl = newOriginalTtl;
        parentEntry.ttl = newTtl;
      }
    }
    return true;
  }

  private before(a: SkipEntry, b: SkipEntry): boolean {
    return a.time !== b.time ? a.time > b.time : a.seq < b.seq;
  }

  private put(entry: SkipEntry): void {
    const heap = this.heap;
    heap.push(entry);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(heap[i] as SkipEntry, heap[parent] as SkipEntry)) break;
      [heap[i], heap[parent]] = [heap[parent] as SkipEntry, heap[i] as SkipEntry];
      i = parent;
    }
  }

  private pop(): SkipEntry {
    const heap = this.heap;
    const top = heap[0] as SkipEntry;
    const last = heap.pop() as SkipEntry;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      while (true) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < heap.length && this.before(heap[l] as SkipEntry, heap[best] as SkipEntry)) best = l;
        if (r < heap.length && this.before(heap[r] as SkipEntry, heap[best] as SkipEntry)) best = r;
        if (best === i) break;
        [heap[i], heap[best]] = [heap[best] as SkipEntry, heap[i] as SkipEntry];
        i = best;
      }
    }
    return top;
  }
}
