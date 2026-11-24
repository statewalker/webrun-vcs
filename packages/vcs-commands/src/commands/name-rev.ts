/**
 * `git describe --contains` (builtin/name-rev.c run as `name-rev --peel-tag --name-only
 * --no-undefined --tags`): a commit named after the tag that contains it, nearest first,
 * as `<tag>~<n>` or `<tag>~<n>^<p>~<m>`, a tagged commit itself as `<tag>^0` (annotated) or
 * `<tag>`.
 *
 * @example
 * ```typescript
 * const name = await nameRevByTags(source, id); // "v2.0~3", undefined when no tag contains it
 * ```
 *
 * @module
 */

import type { ObjectId, PersonIdent } from "@statewalker/vcs-core";

/** What {@link nameRevByTags} reads. */
export interface NameRevSource {
  refs: {
    list(prefix?: string): AsyncIterable<{ name: string; objectId?: ObjectId; target?: string }>;
    resolve(name: string): Promise<{ objectId?: ObjectId } | undefined>;
  };
  tags?: {
    has(id: ObjectId): Promise<boolean>;
    load(id: ObjectId): Promise<{ object: ObjectId; tagger?: PersonIdent } | undefined>;
  };
  commits: {
    load(id: ObjectId): Promise<{ parents: ObjectId[]; committer: PersonIdent } | undefined>;
  };
}

/** name-rev.c's CUTOFF_DATE_SLOP: one day. */
const CUTOFF_DATE_SLOP = 86400;
/** name-rev.c's MERGE_TRAVERSAL_WEIGHT. */
const MERGE_TRAVERSAL_WEIGHT = 65535;

interface RevName {
  tipName: string;
  taggerdate: number;
  generation: number;
  distance: number;
}

interface Tip {
  name: string;
  commit: ObjectId;
  taggerdate: number;
  deref: boolean;
}

const effectiveDistance = (distance: number, generation: number) =>
  distance + (generation > 0 ? MERGE_TRAVERSAL_WEIGHT : 0);

/**
 * The name `git name-rev --tags --name-only` gives `id` (every tip a tag: name-rev.c's
 * `name_tips` from the oldest tag, `name_rev`'s first-parent-first walk, `is_better_name`
 * between two tags preferring the nearer), undefined when no tag contains it. Commits older
 * than a day before `id` are not walked (`cutoff`; no commit-graph generations).
 */
export async function nameRevByTags(
  source: NameRevSource,
  id: ObjectId,
): Promise<string | undefined> {
  const commits = new Map<ObjectId, { parents: ObjectId[]; date: number } | null>();
  const load = async (oid: ObjectId) => {
    let c = commits.get(oid);
    if (c === undefined) {
      const loaded = await source.commits.load(oid).catch(() => undefined);
      c = loaded ? { parents: loaded.parents, date: loaded.committer.timestamp } : null;
      commits.set(oid, c);
    }
    return c;
  };
  const target = await load(id);
  if (!target) return undefined;
  const cutoff = target.date - CUTOFF_DATE_SLOP;

  const tips: Tip[] = [];
  const refs: { name: string; objectId?: ObjectId; target?: string }[] = [];
  for await (const ref of source.refs.list("refs/tags/")) {
    if (ref.name.startsWith("refs/tags/")) refs.push(ref);
  }
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ref of refs) {
    let oid =
      ref.objectId && ref.target === undefined
        ? ref.objectId
        : (await source.refs.resolve(ref.name))?.objectId;
    if (!oid) continue;
    let deref = false;
    let taggerdate: number | undefined;
    for (let depth = 0; depth < 32 && source.tags && (await source.tags.has(oid)); depth++) {
      const tag = await source.tags.load(oid);
      if (!tag) break;
      oid = tag.object;
      deref = true;
      taggerdate = tag.tagger?.timestamp ?? 0;
    }
    const commit = await load(oid);
    if (!commit) continue;
    tips.push({
      name: ref.name.slice("refs/tags/".length),
      commit: oid,
      taggerdate: taggerdate ?? commit.date,
      deref,
    });
  }
  // cmp_by_tag_and_age: older first (every tip is a tag)
  tips.sort((a, b) => a.taggerdate - b.taggerdate);

  const names = new Map<ObjectId, RevName>();
  const createOrUpdate = (
    oid: ObjectId,
    taggerdate: number,
    generation: number,
    distance: number,
  ): RevName | undefined => {
    const known = names.get(oid);
    // both from tags: the nearer is better
    if (
      known &&
      !(
        effectiveDistance(known.distance, known.generation) >
        effectiveDistance(distance, generation)
      )
    ) {
      return undefined;
    }
    const name: RevName = { tipName: "", taggerdate, generation, distance };
    names.set(oid, name);
    return name;
  };

  for (const tip of tips) {
    const start = await load(tip.commit);
    if (!start || start.date < cutoff) continue;
    const startName = createOrUpdate(tip.commit, tip.taggerdate, 0, 0);
    if (!startName) continue;
    startName.tipName = tip.deref ? `${tip.name}^0` : tip.name;
    const stack: ObjectId[] = [tip.commit];
    for (let oid = stack.pop(); oid !== undefined; oid = stack.pop()) {
      const name = names.get(oid) as RevName;
      const commit = await load(oid);
      const toQueue: ObjectId[] = [];
      let parentNumber = 1;
      for (const parentId of commit?.parents ?? []) {
        const parent = await load(parentId);
        const number = parentNumber++;
        if (!parent || parent.date < cutoff) continue;
        const generation = number > 1 ? 0 : name.generation + 1;
        const distance = name.distance + (number > 1 ? MERGE_TRAVERSAL_WEIGHT : 1);
        const parentName = createOrUpdate(parentId, tip.taggerdate, generation, distance);
        if (!parentName) continue;
        if (number > 1) {
          const base = name.tipName.endsWith("^0") ? name.tipName.slice(0, -2) : name.tipName;
          parentName.tipName =
            name.generation > 0 ? `${base}~${name.generation}^${number}` : `${base}^${number}`;
        } else parentName.tipName = name.tipName;
        toQueue.push(parentId);
      }
      // the first parent comes out of the stack first
      for (let i = toQueue.length - 1; i >= 0; i--) stack.push(toQueue[i] as ObjectId);
    }
  }

  const found = names.get(id);
  if (!found) return undefined;
  if (!found.generation) return found.tipName;
  const base = found.tipName.endsWith("^0") ? found.tipName.slice(0, -2) : found.tipName;
  return `${base}~${found.generation}`;
}
