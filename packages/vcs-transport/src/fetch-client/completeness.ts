/**
 * Which objects a fetch may count as already here: git's COMPLETE (fetch-pack.c
 * mark_complete / everything_local), not mere presence.
 */

import type { NegotiatorCommit } from "./negotiator.js";

/** What the completeness walk reads (a `RepositoryFacade` fits). */
export interface CompletenessSource {
  has(oid: string): Promise<boolean>;
  getCommitInfo?(oid: string): Promise<NegotiatorCommit | undefined>;
  peelTag?(oid: string): Promise<string | null | undefined>;
}

/**
 * Objects reachable from the local ref tips: the repository promises their whole history
 * is here (git keeps refs connected). An object that is merely present is not complete:
 * an interrupted fetch can leave a commit and its tree behind without their blobs, and
 * counting that commit as "here" would let the next fetch skip it and write a ref to a
 * broken history.
 *
 * As git, a commit counts as complete when the walk from the tips (newest first) reaches
 * it; the walk stops once every queued commit is older than the commit asked about, so a
 * clock-skewed history at worst makes the fetch ask for something it has (never the
 * reverse). Annotated tags are complete when their tag objects are here and they peel to
 * a complete commit; other objects (a tag pointing at a tree or blob) only as a tip.
 *
 * @example
 * ```ts
 * const complete = new Completeness(repository, localTips);
 * if (!(await complete.isComplete(remoteTip))) wants.push(remoteTip);
 * ```
 */
export class Completeness {
  private readonly complete = new Set<string>();
  private readonly queued = new Set<string>();
  private readonly queue: { oid: string; time: number }[] = [];
  private readonly pending: string[] = [];
  private readonly directTips = new Set<string>();

  constructor(
    private readonly source: CompletenessSource,
    tips: Iterable<string> = [],
  ) {
    for (const tip of tips) this.addTip(tip);
  }

  /** A tip whose history is here: a local ref, or a fetched want once its pack is in. */
  addTip(oid: string): void {
    this.directTips.add(oid);
    this.pending.push(oid);
  }

  /** Whether `oid` and everything it reaches is here. */
  async isComplete(oid: string): Promise<boolean> {
    if (this.complete.has(oid) || this.directTips.has(oid)) return this.source.has(oid);
    await this.loadTips();
    // annotated tags: every tag object here, and the peeled object complete
    let id = oid;
    for (let i = 0; i < 16; i++) {
      if (!(await this.source.has(id))) return false;
      const target = await this.source.peelTag?.(id);
      if (!target || target === id) break;
      id = target;
    }
    if (id !== oid && this.directTips.has(id)) return true;
    const info = await this.source.getCommitInfo?.(id);
    if (!info) return this.complete.has(id);
    // walk newest first until the commit is reached or every queued commit is older
    while (!this.complete.has(id)) {
      const top = this.queue[0];
      if (!top || top.time < info.time) break;
      await this.pop();
    }
    return this.complete.has(id);
  }

  private async loadTips(): Promise<void> {
    while (this.pending.length > 0) {
      let id = this.pending.shift() as string;
      for (let i = 0; i < 16; i++) {
        const target = await this.source.peelTag?.(id);
        if (!target || target === id) break;
        id = target;
      }
      await this.enqueue(id);
    }
  }

  private async enqueue(oid: string): Promise<void> {
    if (this.queued.has(oid)) return;
    this.queued.add(oid);
    const info = await this.source.getCommitInfo?.(oid);
    if (!info) return;
    const entry = { oid, time: info.time };
    let i = this.queue.length;
    while (i > 0 && (this.queue[i - 1] as { time: number }).time < info.time) i--;
    this.queue.splice(i, 0, entry);
  }

  private async pop(): Promise<void> {
    const { oid } = this.queue.shift() as { oid: string };
    this.complete.add(oid);
    const info = await this.source.getCommitInfo?.(oid);
    for (const parent of info?.parents ?? []) await this.enqueue(parent);
  }
}
