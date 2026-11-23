/**
 * git's ref-filter.c, the part that chooses and orders refs: kinds, name patterns (as paths
 * for `for-each-ref`, after the `refs/<kind>/` prefix for `branch -l`/`tag -l`), `--exclude`,
 * `--points-at`, `--contains`/`--no-contains`, `--merged`/`--no-merged`, `--start-after`,
 * and the sort keys (several, `-` reversed, `version:` with `versionsort.suffix`). The
 * listing commands share it: `for-each-ref` today, the branch and tag listings next.
 *
 * @example
 * ```typescript
 * const format = new RefFormat("%(refname:short)", formatSource);
 * const sorting = parseRefSorting(["-committerdate"], format);
 * const { lines } = await filterAndFormatRefs(filterSource, { kind: RefKind.REGULAR }, sorting, format);
 * ```
 *
 * @module
 */

import type { ObjectId } from "@statewalker/vcs-core";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils";
import { wildmatch } from "@statewalker/vcs-working-tree";

import { RefFilterError } from "../../errors/index.js";
import {
  type RefFilterItem,
  type RefFormat,
  type RefFormatObject,
  RefKind,
  tagHeader,
} from "./ref-format.js";
import { versionCompare } from "./version-compare.js";

/** A ref as the store lists it. */
export interface ListedRef {
  name: string;
  /** What it resolves to; undefined for a broken ref (a dangling symbolic ref) */
  objectId?: ObjectId;
  /** A symbolic ref's target */
  symref?: string;
  /** Read from packed-refs */
  packed?: boolean;
  /** What it peels to, when known */
  peeledId?: ObjectId;
}

/** What the filter reads of the repository. */
export interface RefFilterSource {
  /** Every ref under `refs/`, in name order */
  listRefs(): Promise<ListedRef[]>;
  /** HEAD and the root refs (`ORIG_HEAD`, ...), for `--include-root-refs` */
  listRootRefs(): Promise<ListedRef[]>;
  /** HEAD alone, for a listing of the detached HEAD (`branch` with `FILTER_REFS_DETACHED_HEAD`) */
  head(): Promise<ListedRef | undefined>;
  /** The object, through replace refs */
  readObject(id: ObjectId): Promise<RefFormatObject | undefined>;
  /** Whether `ancestor` is reachable from `descendant` (the commit-graph used where there is one) */
  isAncestor(ancestor: ObjectId, descendant: ObjectId): Promise<boolean>;
  /** A commit's parents and committer date, undefined when it is missing */
  commitHeader(id: ObjectId): Promise<{ parents: ObjectId[]; date: number } | undefined>;
  /** The commits only `ours` and only `theirs` reach */
  aheadBehind(ours: ObjectId, theirs: ObjectId): Promise<{ ahead: number; behind: number }>;
  /**
   * `lookup_commit_reference_by_name`: the commit a name peels to, undefined when none; git's
   * messages on the way (`warning: refname 'x' is ambiguous.`, `error: object ... is a
   * blob, not a commit`) added to `warnings` unless `quiet`
   */
  commitByName(name: string, warnings?: string[], quiet?: boolean): Promise<ObjectId | undefined>;
  /** Every value of a configuration key, in order */
  configValues(key: string): string[];
}

/** Which refs a listing keeps (git's `struct ref_filter`). */
export interface RefFilterOptions {
  /** The {@link RefKind}s listed */
  kind: number;
  /** Name patterns (any matches); none: every ref */
  patterns?: readonly string[];
  /** Patterns match full names as paths (`for-each-ref`), else after `refs/<kind>/` (`branch`, `tag`) */
  matchAsPath?: boolean;
  /** `--ignore-case`: patterns match without case */
  ignoreCase?: boolean;
  /** `--exclude`: refs matching any of these are left out */
  exclude?: readonly string[];
  /** `--points-at`: refs naming one of these objects, directly or through tags */
  pointsAt?: readonly ObjectId[];
  /** `--contains`: refs whose commit reaches one of these */
  contains?: readonly ObjectId[];
  /** `--no-contains`: refs whose commit reaches none of these */
  noContains?: readonly ObjectId[];
  /** `--merged`: refs whose commit one of these reaches */
  merged?: readonly ObjectId[];
  /** `--no-merged`: refs whose commit none of these reaches */
  noMerged?: readonly ObjectId[];
  /** `--start-after`: refs sorting after this name only */
  startAfter?: string;
  /** Only refs naming a commit (`branch -v`: git's `filter->verbose`) */
  needCommit?: boolean;
}

/** A sort key (git's `struct ref_sorting`). */
export interface RefSortKey {
  /** The atom's index in the format */
  atom: number;
  reverse?: boolean;
  /** `version:` / `v:` */
  version?: boolean;
  /** `--ignore-case` */
  icase?: boolean;
  /** The detached HEAD first (`branch`'s listing) */
  detachedHeadFirst?: boolean;
}

function isPlainAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0 || c > 0x7f) return false;
  }
  return true;
}

/** Byte order of two texts (strcmp). */
export function compareBytes(a: string, b: string): number {
  // ASCII texts (no NUL) compare as their code units
  if (isPlainAscii(a) && isPlainAscii(b)) return a < b ? -1 : a > b ? 1 : 0;
  const x = encodeGitPath(a);
  const y = encodeGitPath(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return x.length - y.length;
}

const lowerByte = (c: number) => (c >= 0x41 && c <= 0x5a ? c + 32 : c);

/** strcasecmp (ASCII case folded). */
function compareBytesIcase(a: string, b: string): number {
  const x = encodeGitPath(a);
  const y = encodeGitPath(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = lowerByte(x[i] as number) - lowerByte(y[i] as number);
    if (d) return d;
  }
  return x.length - y.length;
}

/** C strings: what a NUL would end. */
const cString = (s: string) => {
  const nul = s.indexOf("\0");
  return nul >= 0 ? s.slice(0, nul) : s;
};

/** ref_kind_from_refname. */
export function refKindOf(name: string): number {
  if (name === "HEAD") return RefKind.DETACHED_HEAD;
  if (name.startsWith("refs/heads/")) return RefKind.BRANCHES;
  if (name.startsWith("refs/remotes/")) return RefKind.REMOTES;
  if (name.startsWith("refs/tags/")) return RefKind.TAGS;
  if (name === "FETCH_HEAD" || name === "MERGE_HEAD") return RefKind.PSEUDOREFS;
  if (isRootRef(name)) return RefKind.ROOT_REFS;
  return RefKind.OTHERS;
}

/** refs.c's is_root_ref. */
export function isRootRef(name: string): boolean {
  if (!/^[A-Z_-]+$/.test(name)) return false;
  if (name === "FETCH_HEAD" || name === "MERGE_HEAD") return false;
  if (name.endsWith("_HEAD")) return true;
  return [
    "HEAD",
    "AUTO_MERGE",
    "BISECT_EXPECTED_REV",
    "NOTES_MERGE_PARTIAL",
    "NOTES_MERGE_REF",
    "MERGE_AUTOSTASH",
  ].includes(name);
}

/** match_name_as_path: a path prefix (whole components) or a wildmatch with WM_PATHNAME. */
function matchNameAsPath(patterns: readonly string[], name: string, icase: boolean): boolean {
  for (const p of patterns) {
    if (
      p.length <= name.length &&
      name.startsWith(p) &&
      (name.length === p.length || name[p.length] === "/" || p.endsWith("/"))
    ) {
      return true;
    }
    if (wildmatch(p, name, { pathname: true, casefold: icase })) return true;
  }
  return false;
}

/** match_pattern: a wildmatch of the name past `refs/tags/`, `refs/heads/`, `refs/remotes/` or `refs/`. */
function matchPattern(patterns: readonly string[], name: string, icase: boolean): boolean {
  let short = name;
  for (const prefix of ["refs/tags/", "refs/heads/", "refs/remotes/", "refs/"]) {
    if (short.startsWith(prefix)) {
      short = short.slice(prefix.length);
      break;
    }
  }
  return patterns.some((p) => wildmatch(p, short, { casefold: icase }));
}

/** The result of {@link filterRefs}. */
export interface FilteredRefs {
  items: RefFilterItem[];
  /** git's warnings (`warning: ignoring broken ref ...`) */
  warnings: string[];
}

/** The commit an object peels to (lookup_commit_reference_gently), undefined when none. */
async function commitOf(source: RefFilterSource, id: ObjectId): Promise<ObjectId | undefined> {
  let current = id;
  for (let depth = 0; depth < 1000; depth++) {
    const object = await source.readObject(current);
    if (!object) return undefined;
    if (object.type === "commit") return current;
    if (object.type !== "tag") return undefined;
    const target = tagHeader(decodeGitPath(object.bytes)).object;
    if (!target) return undefined;
    current = target;
  }
  return undefined;
}

/** match_points_at: the ref's object, or one a tag on the way names, is wanted. */
async function matchPointsAt(
  source: RefFilterSource,
  wanted: ReadonlySet<ObjectId>,
  id: ObjectId,
  refname: string,
): Promise<boolean> {
  if (wanted.has(id)) return true;
  let object = await source.readObject(id);
  let current = id;
  while (object && object.type === "tag") {
    const target = tagHeader(decodeGitPath(object.bytes)).object;
    if (!target) {
      object = undefined;
      break;
    }
    if (wanted.has(target)) return true;
    current = target;
    object = await source.readObject(current);
  }
  if (!object) throw new RefFilterError(`fatal: malformed object at '${refname}'`, 128);
  return false;
}

/**
 * filter_refs: the refs of the wanted kinds that pass every filter, in the store's name
 * order (`--merged`/`--no-merged` applied last, as git's reach_filter).
 *
 * @throws RefFilterError where git dies
 */
export async function filterRefs(
  source: RefFilterSource,
  filter: RefFilterOptions,
): Promise<FilteredRefs> {
  const warnings: string[] = [];
  const kind = filter.kind;
  const listed: ListedRef[] = [];
  if (kind & RefKind.ROOT_REFS) {
    const all = [...(await source.listRootRefs()), ...(await source.listRefs())];
    all.sort((a, b) => compareBytes(a.name, b.name));
    listed.push(...all);
  } else {
    let refs = await source.listRefs();
    const only =
      kind === RefKind.BRANCHES
        ? "refs/heads/"
        : kind === RefKind.REMOTES
          ? "refs/remotes/"
          : kind === RefKind.TAGS
            ? "refs/tags/"
            : undefined;
    if (only && filter.startAfter === undefined) refs = refs.filter((r) => r.name.startsWith(only));
    listed.push(...refs);
  }
  let candidates = listed;
  if (filter.startAfter !== undefined) {
    const marker = `${filter.startAfter}\x01`;
    candidates = candidates.filter((r) => compareBytes(r.name, marker) >= 0);
  }
  if (!(kind & RefKind.ROOT_REFS) && kind & RefKind.DETACHED_HEAD) {
    const head = await source.head();
    if (head) candidates.push(head);
  }
  const patterns = filter.patterns ?? [];
  const exclude = filter.exclude ?? [];
  const icase = filter.ignoreCase ?? false;
  const match = (list: readonly string[], name: string) =>
    filter.matchAsPath ? matchNameAsPath(list, name, icase) : matchPattern(list, name, icase);
  const pointsAt = filter.pointsAt?.length ? new Set(filter.pointsAt) : undefined;
  const reach =
    !!filter.needCommit ||
    !!filter.contains?.length ||
    !!filter.noContains?.length ||
    !!filter.merged?.length ||
    !!filter.noMerged?.length;
  const reaches = async (commit: ObjectId, targets: readonly ObjectId[]) => {
    for (const t of targets) if (await source.isAncestor(t, commit)) return true;
    return false;
  };
  const items: RefFilterItem[] = [];
  for (const ref of candidates) {
    // a dangling symbolic ref: the iterator leaves it out
    if (ref.objectId === undefined) continue;
    let refKind =
      kind === RefKind.BRANCHES || kind === RefKind.REMOTES || kind === RefKind.TAGS
        ? kind
        : refKindOf(ref.name);
    if (kind & RefKind.ROOT_REFS && refKind === RefKind.DETACHED_HEAD) refKind = RefKind.ROOT_REFS;
    else if (!(refKind & kind)) continue;
    if (patterns.length && !match(patterns, ref.name)) continue;
    if (exclude.length && match(exclude, ref.name)) continue;
    if (pointsAt && !(await matchPointsAt(source, pointsAt, ref.objectId, ref.name))) continue;
    let commit: ObjectId | undefined;
    if (reach) {
      commit = await commitOf(source, ref.objectId);
      if (!commit) continue;
      if (filter.contains?.length && !(await reaches(commit, filter.contains))) continue;
      if (filter.noContains?.length && (await reaches(commit, filter.noContains))) continue;
    }
    items.push({
      refname: ref.name,
      objectId: ref.objectId,
      ...(ref.peeledId ? { peeledId: ref.peeledId } : {}),
      ...(ref.symref !== undefined ? { symref: ref.symref } : {}),
      flags: { symref: ref.symref !== undefined, packed: !!ref.packed },
      kind: refKind,
      ...(commit ? { commit } : {}),
    });
  }
  let kept = items;
  const mergedFrom = async (item: RefFilterItem, bases: readonly ObjectId[]) => {
    for (const b of bases) if (await source.isAncestor(item.commit as ObjectId, b)) return true;
    return false;
  };
  if (filter.merged?.length) {
    const out: RefFilterItem[] = [];
    for (const item of kept) if (await mergedFrom(item, filter.merged)) out.push(item);
    kept = out;
  }
  if (filter.noMerged?.length) {
    const out: RefFilterItem[] = [];
    for (const item of kept) if (!(await mergedFrom(item, filter.noMerged))) out.push(item);
    kept = out;
  }
  return { items: kept, warnings };
}

/**
 * parse_ref_sorting over the keys as given on the command line (`--sort` in order): the
 * last becomes the primary key, as git's.
 *
 * @throws RefFilterError for a key the format language refuses
 */
export function parseRefSorting(keys: readonly string[], format: RefFormat): RefSortKey[] {
  const out: RefSortKey[] = [];
  for (const key of keys) {
    let arg = key;
    const s: RefSortKey = { atom: 0 };
    if (arg.startsWith("-")) {
      s.reverse = true;
      arg = arg.slice(1);
    }
    if (arg.startsWith("version:")) {
      s.version = true;
      arg = arg.slice(8);
    } else if (arg.startsWith("v:")) {
      s.version = true;
      arg = arg.slice(2);
    }
    s.atom = format.atomIndex(arg);
    out.unshift(s);
  }
  return out;
}

/** The `versionsort.suffix` list, and the warning git prints when both names are set. */
function versionSuffixes(source: RefFilterSource, warnings: string[]): string[] {
  const suffix = source.configValues("versionsort.suffix");
  const old = source.configValues("versionsort.prereleasesuffix");
  if (suffix.length && old.length) {
    warnings.push(
      "warning: ignoring versionsort.prereleasesuffix because versionsort.suffix is set",
    );
  }
  return suffix.length ? suffix : old;
}

/**
 * ref_array_sort: `items` sorted in place by the keys (primary first), ties by refname.
 *
 * @throws RefFilterError where a sort key's value cannot be computed
 */
export async function sortRefs(
  items: RefFilterItem[],
  sorting: readonly RefSortKey[],
  format: RefFormat,
  source: RefFilterSource,
  warnings: string[] = [],
): Promise<void> {
  if (sorting.length === 0) return;
  for (const item of items) for (const key of sorting) await format.value(item, key.atom);
  let suffixes: string[] | undefined;
  const compareKey = (key: RefSortKey, a: RefFilterItem, b: RefFilterItem): number => {
    const va = (a.values as NonNullable<RefFilterItem["values"]>)[key.atom];
    const vb = (b.values as NonNullable<RefFilterItem["values"]>)[key.atom];
    if (!va || !vb) return 0;
    let cmp: number;
    let detached = false;
    if (key.detachedHeadFirst && (a.kind | b.kind) & RefKind.DETACHED_HEAD) {
      cmp = a.kind & RefKind.DETACHED_HEAD ? -1 : 1;
      detached = true;
    } else if (key.version) {
      suffixes ??= versionSuffixes(source, warnings);
      cmp = versionCompare(cString(va.s), cString(vb.s), suffixes);
    } else if (format.cmpTypeOf(key.atom) === "str") {
      const x = va.sized ? va.s : cString(va.s);
      const y = vb.sized ? vb.s : cString(vb.s);
      cmp = key.icase ? compareBytesIcase(x, y) : compareBytes(x, y);
    } else cmp = va.value < vb.value ? -1 : va.value === vb.value ? 0 : 1;
    return key.reverse && !detached ? -cmp : cmp;
  };
  const first = sorting[0] as RefSortKey;
  items.sort((a, b) => {
    for (const key of sorting) {
      const cmp = compareKey(key, a, b);
      if (cmp) return cmp;
    }
    return first.icase
      ? compareBytesIcase(a.refname, b.refname)
      : compareBytes(a.refname, b.refname);
  });
}

/**
 * filter_ahead_behind: each `%(ahead-behind:<base>)` count of every ref that names a
 * commit, `bases` resolved in the order the atoms come in the format.
 */
export async function fillAheadBehind(
  items: RefFilterItem[],
  bases: readonly ObjectId[],
  source: RefFilterSource,
  warnings: string[] = [],
): Promise<void> {
  if (bases.length === 0) return;
  for (const item of items) {
    const tip = await source.commitByName(item.refname, warnings);
    if (!tip) continue;
    item.counts = [];
    for (const base of bases) item.counts.push(await source.aheadBehind(tip, base));
  }
}

/**
 * filter_is_base: for each `%(is-base:<tip>)`, the ref (among those naming commits) whose
 * commit is the base of `tip`'s branch (commit-reach.c's get_branch_base_for_tip).
 */
export async function fillIsBase(
  items: RefFilterItem[],
  tips: readonly { name: string; commit: ObjectId }[],
  source: RefFilterSource,
): Promise<void> {
  if (tips.length === 0) return;
  const bases: ObjectId[] = [];
  const back: RefFilterItem[] = [];
  for (const item of items) {
    item.isBase = tips.map(() => undefined);
    const c = await source.commitByName(item.refname, [], true);
    if (!c) continue;
    back.push(item);
    bases.push(c);
  }
  // git's slot counter moves only when a base is found (filter_is_base's `j++`)
  let j = 0;
  for (const tip of tips) {
    const index = await branchBaseForTip(source, tip.commit, bases);
    if (index < 0) continue;
    ((back[index] as RefFilterItem).isBase as (string | undefined)[])[j++] = tip.name;
  }
}

/** commit-reach.c's get_branch_base_for_tip, generations computed as corrected commit dates. */
async function branchBaseForTip(
  source: RefFilterSource,
  tip: ObjectId,
  bases: readonly ObjectId[],
): Promise<number> {
  if (bases.length === 0) return -1;
  const headers = new Map<ObjectId, { parents: ObjectId[]; date: number } | null>();
  const header = async (id: ObjectId) => {
    if (!headers.has(id)) headers.set(id, (await source.commitHeader(id)) ?? null);
    return headers.get(id) ?? undefined;
  };
  const generations = new Map<ObjectId, number>();
  const generation = async (id: ObjectId): Promise<number> => {
    const known = generations.get(id);
    if (known !== undefined) return known;
    const stack: ObjectId[] = [id];
    while (stack.length) {
      const current = stack[stack.length - 1] as ObjectId;
      if (generations.has(current)) {
        stack.pop();
        continue;
      }
      const h = await header(current);
      let max = 0;
      let ready = true;
      for (const p of h?.parents ?? []) {
        const g = generations.get(p);
        if (g === undefined) {
          ready = false;
          stack.push(p);
          break;
        }
        if (g > max) max = g;
      }
      if (!ready) continue;
      stack.pop();
      generations.set(current, Math.max(h?.date ?? 0, max + 1));
    }
    return generations.get(id) as number;
  };
  const best = new Map<ObjectId, number>();
  const queue: { id: ObjectId; gen: number; date: number; seq: number }[] = [];
  let seq = 0;
  const put = async (id: ObjectId) => {
    queue.push({ id, gen: await generation(id), date: (await header(id))?.date ?? 0, seq: seq++ });
  };
  const get = () => {
    if (queue.length === 0) return undefined;
    let at = 0;
    for (let i = 1; i < queue.length; i++) {
      const a = queue[i] as (typeof queue)[number];
      const b = queue[at] as (typeof queue)[number];
      if (
        a.gen > b.gen ||
        (a.gen === b.gen && (a.date > b.date || (a.date === b.date && a.seq < b.seq)))
      ) {
        at = i;
      }
    }
    return queue.splice(at, 1)[0]?.id;
  };
  let bestIndex = -1;
  best.set(tip, -1);
  await put(tip);
  for (let i = 0; i < bases.length; i++) {
    const c = bases[i] as ObjectId;
    const b = best.get(c) ?? 0;
    if (b) {
      if (b === -1) return i;
      continue;
    }
    best.set(c, i + 1);
    await put(c);
  }
  let branchPoint: ObjectId | undefined;
  for (let c = get(); c !== undefined; c = get()) {
    const bestForC = best.get(c) ?? 0;
    if (c === branchPoint) break;
    const h = await header(c);
    const parent = h?.parents[0];
    if (!parent) continue;
    const bestForP = best.get(parent) ?? 0;
    if (!bestForP) {
      best.set(parent, bestForC);
      await put(parent);
      continue;
    }
    if (bestForP > 0 && bestForC > 0) {
      if (bestForC < bestForP) best.set(parent, bestForC);
      continue;
    }
    const positive = bestForC < 0 ? bestForP : bestForC;
    if (bestIndex < 0 || positive < bestIndex) bestIndex = positive;
    best.set(parent, -1);
    branchPoint = parent;
  }
  return bestIndex > 0 ? bestIndex - 1 : -1;
}

/** What {@link filterAndFormatRefs} prints. */
export interface FormatRefsOptions {
  /** `--count`: at most this many refs (0: all) */
  count?: number;
  /** `--omit-empty`: no line for a ref whose format expands to nothing */
  omitEmpty?: boolean;
}

/** The output of {@link filterAndFormatRefs}. */
export interface FormattedRefs {
  /** The refs shown, in order */
  items: RefFilterItem[];
  /** Each shown ref's expanded format, in order (an omitted empty one left out) */
  lines: string[];
  /** git's stdout: each line and its newline */
  output: string;
  warnings: string[];
}

/**
 * filter_and_format_refs: the refs filtered, their `%(ahead-behind)` and `%(is-base)`
 * values computed, sorted, cut to `count`, and formatted.
 *
 * @throws RefFilterError where git dies
 */
export async function filterAndFormatRefs(
  source: RefFilterSource,
  filter: RefFilterOptions,
  sorting: readonly RefSortKey[],
  format: RefFormat,
  options: FormatRefsOptions & {
    aheadBehindBases?: readonly ObjectId[];
    isBaseTips?: readonly { name: string; commit: ObjectId }[];
  } = {},
): Promise<FormattedRefs> {
  const { items, warnings } = await filterRefs(source, filter);
  await fillAheadBehind(items, options.aheadBehindBases ?? [], source, warnings);
  await fillIsBase(items, options.isBaseTips ?? [], source);
  await sortRefs(items, sorting, format, source, warnings);
  const total = options.count && options.count < items.length ? options.count : items.length;
  const shown = items.slice(0, total);
  const lines: string[] = [];
  let output = "";
  for (const item of shown) {
    const line = await format.format(item);
    if (line.length || !options.omitEmpty) {
      lines.push(line);
      output += `${line}\n`;
    }
  }
  return { items: shown, lines, output, warnings };
}
