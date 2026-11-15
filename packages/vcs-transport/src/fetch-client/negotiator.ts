/**
 * git's default fetch negotiator (negotiator/default.c), over an async commit source.
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
export class Negotiator {
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
