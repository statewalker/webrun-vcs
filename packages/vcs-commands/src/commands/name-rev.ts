/**
 * git name-rev (builtin/name-rev.c): every commit named after the ref it is reached from,
 * nearest first, as `<ref>~<n>` or `<ref>~<n>^<p>~<m>`, a tagged commit itself as
 * `<tag>^0`. `git describe --contains` runs it as `name-rev --peel-tag --name-only
 * --no-undefined --tags`.
 *
 * @example
 * ```typescript
 * const run = await runNameRev(source, { tags: true, nameOnly: true }, { revs });
 * run.stdout; // "v2.0~3\n"
 * ```
 *
 * @module
 */

import type { ObjectId, PersonIdent } from "@statewalker/vcs-core";

/** An object's type as git's `parse_object` finds it. */
export type NameRevObjectType = "commit" | "tree" | "blob" | "tag";

/** A commit as name-rev reads it (from the commit-graph where it has it). */
export interface NameRevCommit {
  parents: ObjectId[];
  /** Committer date */
  date: number;
  /** The commit-graph's generation; Infinity outside the graph */
  generation: number;
}

/** What {@link runNameRev} reads. */
export interface NameRevSource {
  refs: {
    list(prefix?: string): AsyncIterable<{ name: string; objectId?: ObjectId; target?: string }>;
    resolve(name: string): Promise<{ objectId?: ObjectId } | undefined>;
  };
  /** The type of an object, undefined when the repository lacks it */
  objectType(id: ObjectId): Promise<NameRevObjectType | undefined>;
  /** An annotated tag's target and tagger */
  loadTag(id: ObjectId): Promise<{ object: ObjectId; tagger?: PersonIdent } | undefined>;
  /** A commit's parents, date and generation, undefined when it cannot be read */
  loadCommit(id: ObjectId): Promise<NameRevCommit | undefined>;
  /** Whether a full ref name (or `HEAD`) exists, for `refs_shorten_unambiguous_ref` */
  refExists(name: string): Promise<boolean>;
  /** `id` abbreviated as `find_unique_abbrev(oid, DEFAULT_ABBREV)` */
  abbreviate(id: ObjectId): Promise<string>;
  /** git's wildmatch without flags (default: a simple glob) */
  wildmatch?: (pattern: string, text: string) => boolean;
}

/** name-rev's options. */
export interface NameRevOptions {
  /** `--name-only`: no object names before the names */
  nameOnly?: boolean;
  /** `--tags`: only tags name commits */
  tags?: boolean;
  /** `--refs=<pattern>`: only refs matching one of these (or a subpath of them) */
  refs?: readonly string[];
  /** `--exclude=<pattern>`: no refs matching one of these */
  exclude?: readonly string[];
  /** `--no-undefined` (false): die instead of printing `undefined` (default true) */
  allowUndefined?: boolean;
  /** `--always`: the abbreviated id of an object no ref names */
  always?: boolean;
  /** `--peel-tag` (internal): a tag given is named by the commit it peels to */
  peelTag?: boolean;
  /** The length of the repository's hex ids `--annotate-stdin` looks for (default 40) */
  hexLength?: number;
}

/** What name-rev names: revisions given, every commit (`--all`) or stdin's text. */
export type NameRevInput =
  | {
      /** The revisions as given and the object each names (undefined: none) */
      revs: readonly { name: string; id: ObjectId | undefined }[];
    }
  | { all: true }
  | { annotate: string };

/** name-rev's outcome: stdout, stderr lines and, where git dies, its message. */
export interface NameRevRun {
  stdout: string;
  stderr: string[];
  /** The `fatal:` line git dies with (after printing {@link stdout}) */
  fatal?: string;
}

/** name-rev.c's CUTOFF_DATE_SLOP: one day. */
const CUTOFF_DATE_SLOP = 86400;
/** name-rev.c's MERGE_TRAVERSAL_WEIGHT. */
const MERGE_TRAVERSAL_WEIGHT = 65535;
const TIME_MAX = Number.MAX_SAFE_INTEGER;
const INFINITY = Number.POSITIVE_INFINITY;

interface RevName {
  tipName: string;
  taggerdate: number;
  generation: number;
  distance: number;
  fromTag: boolean;
}

interface Tip {
  oid: ObjectId;
  refname: string;
  commit: ObjectId | undefined;
  taggerdate: number;
  fromTag: boolean;
  deref: boolean;
}

const effectiveDistance = (distance: number, generation: number) =>
  distance + (generation > 0 ? MERGE_TRAVERSAL_WEIGHT : 0);

/** name-rev.c's is_better_name. */
function isBetterName(
  name: RevName,
  taggerdate: number,
  generation: number,
  distance: number,
  fromTag: boolean,
): boolean {
  const nameDistance = effectiveDistance(name.distance, name.generation);
  const newDistance = effectiveDistance(distance, generation);
  // both tags: the nearer
  if (fromTag && name.fromTag) return nameDistance > newDistance;
  // a tag over a non-tag
  if (name.fromTag !== fromTag) return fromTag;
  // two non-tags: shorter hops, then the older date
  if (nameDistance !== newDistance) return nameDistance > newDistance;
  if (name.taggerdate !== taggerdate) return name.taggerdate > taggerdate;
  return false;
}

/** A simple wildmatch: `*` (any run, `/` too), `?`, `[...]` classes. */
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

/** The ref name rules `refs_shorten_unambiguous_ref` walks (ref_rev_parse_rules). */
const RULES = [
  "%s",
  "refs/%s",
  "refs/tags/%s",
  "refs/heads/%s",
  "refs/remotes/%s",
  "refs/remotes/%s/HEAD",
];

/** refs.c's `refs_shorten_unambiguous_ref(ref, strict = 0)`. */
async function shortenUnambiguous(
  ref: string,
  exists: (name: string) => Promise<boolean>,
): Promise<string> {
  for (let i = RULES.length - 1; i > 0; i--) {
    const [prefix, suffix] = (RULES[i] as string).split("%s") as [string, string];
    if (ref.length <= prefix.length + suffix.length) continue;
    if (!ref.startsWith(prefix) || !ref.endsWith(suffix)) continue;
    const short = ref.slice(prefix.length, ref.length - suffix.length);
    let ambiguous = false;
    for (let j = 0; j < i && !ambiguous; j++) {
      if (await exists((RULES[j] as string).replace("%s", short))) ambiguous = true;
    }
    if (!ambiguous) return short;
  }
  return ref;
}

const take2 = (hex: string, ofs: number) => Number.parseInt(hex.slice(ofs * 2, ofs * 2 + 4), 16);

/** hash-lookup.c's `oid_pos` over ids sorted in byte order: an index of `id`, else -1. */
function oidPos(id: ObjectId, table: readonly ObjectId[]): number {
  const nr = table.length;
  if (nr === 0) return -1;
  let lo = 0;
  let hi = nr;
  let mi = 0;
  if (nr !== 1) {
    const rawsz = id.length / 2;
    for (let ofs = 0; ofs < rawsz - 2; ofs += 2) {
      const lov = take2(table[0] as string, ofs);
      const hiv = take2(table[nr - 1] as string, ofs);
      const miv = take2(id, ofs);
      if (miv < lov) return -1;
      if (hiv < miv) return -1;
      if (lov !== hiv) {
        mi = Math.floor(((nr - 1) * (miv - lov)) / (hiv - lov));
        break;
      }
    }
  }
  do {
    const other = table[mi] as string;
    if (other === id) return mi;
    if (other > id) hi = mi;
    else lo = mi + 1;
    mi = lo + Math.floor((hi - lo) / 2);
  } while (lo < hi);
  return -1;
}

/** The parse state of objects, as git's object hash table holds them (for `--all`). */
class ObjectTable {
  readonly types = new Map<ObjectId, NameRevObjectType | undefined>();
  private slots: (ObjectId | undefined)[] = [];

  add(id: ObjectId, type: NameRevObjectType | undefined): void {
    if (this.types.has(id)) {
      if (type && !this.types.get(id)) this.types.set(id, type);
      return;
    }
    // object.c's create_object: grow (rehashing in slot order), then probe linearly
    if (this.slots.length - 1 <= this.types.size * 2) {
      const old = this.slots;
      this.slots = new Array(old.length < 32 ? 32 : old.length * 2);
      for (const o of old) if (o !== undefined) this.insert(o);
    }
    this.insert(id);
    this.types.set(id, type);
  }

  private insert(id: ObjectId): void {
    const hash =
      (Number.parseInt(id.slice(0, 2), 16) |
        (Number.parseInt(id.slice(2, 4), 16) << 8) |
        (Number.parseInt(id.slice(4, 6), 16) << 16) |
        (Number.parseInt(id.slice(6, 8), 16) << 24)) >>>
      0;
    const size = this.slots.length;
    let j = hash & (size - 1);
    while (this.slots[j] !== undefined) {
      j++;
      if (j >= size) j = 0;
    }
    this.slots[j] = id;
  }

  /** The objects in table order (`get_indexed_object`). */
  ordered(): ObjectId[] {
    return this.slots.filter((s): s is ObjectId => s !== undefined);
  }
}

/** One name-rev run: the tips, the names they spread, and the output. */
class NameRevEngine {
  private readonly match: (pattern: string, text: string) => boolean;
  private readonly commits = new Map<ObjectId, NameRevCommit | null>();
  private readonly parsed = new Set<ObjectId>();
  private readonly names = new Map<ObjectId, RevName>();
  private readonly tips: Tip[] = [];
  private sortedTips?: Tip[];
  readonly objects = new ObjectTable();
  cutoff = TIME_MAX;
  generationCutoff = INFINITY;

  constructor(
    private readonly source: NameRevSource,
    private readonly options: NameRevOptions,
  ) {
    this.match = source.wildmatch ?? globMatch;
  }

  async commit(id: ObjectId): Promise<NameRevCommit | undefined> {
    let c = this.commits.get(id);
    if (c === undefined) {
      c = (await this.source.loadCommit(id).catch(() => undefined)) ?? null;
      this.commits.set(id, c);
    }
    return c ?? undefined;
  }

  /** `parse_object`: the object's type, recording it (and a commit's parents) as created. */
  async parseObject(id: ObjectId): Promise<NameRevObjectType | undefined> {
    const known = this.objects.types.get(id);
    const type = known ?? (await this.source.objectType(id).catch(() => undefined));
    if (type === undefined) return undefined;
    this.objects.add(id, type);
    if (type === "commit") await this.parseCommit(id);
    return type;
  }

  /** `repo_parse_commit`: the parents become (unparsed) commit objects. */
  async parseCommit(id: ObjectId): Promise<NameRevCommit | undefined> {
    const c = await this.commit(id);
    if (!this.parsed.has(id)) {
      this.parsed.add(id);
      this.objects.add(id, "commit");
      for (const p of c?.parents ?? []) this.objects.add(p, "commit");
    }
    return c;
  }

  /** set_commit_cutoff. */
  async setCommitCutoff(id: ObjectId): Promise<void> {
    const c = await this.commit(id);
    if (!c) return;
    if (this.cutoff > c.date) this.cutoff = c.date;
    if (this.generationCutoff && this.generationCutoff > c.generation) {
      this.generationCutoff = c.generation;
    }
  }

  disableCutoff(): void {
    this.generationCutoff = 0;
    this.cutoff = 0;
  }

  adjustCutoffForSlop(): void {
    if (this.cutoff) {
      this.cutoff = this.cutoff > CUTOFF_DATE_SLOP ? this.cutoff - CUTOFF_DATE_SLOP : 0;
    }
  }

  private beforeCutoff(c: NameRevCommit): boolean {
    if (this.generationCutoff < INFINITY) {
      return !!this.generationCutoff && c.generation < this.generationCutoff;
    }
    return c.date < this.cutoff;
  }

  /** name_ref over every ref (refs_for_each_ref order), then name_tips. */
  async nameRefs(): Promise<void> {
    const refs: { name: string; objectId?: ObjectId; target?: string }[] = [];
    for await (const ref of this.source.refs.list("refs/")) {
      if (ref.name.startsWith("refs/")) refs.push(ref);
    }
    refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ref of refs) {
      const oid =
        ref.objectId && ref.target === undefined
          ? ref.objectId
          : (await this.source.refs.resolve(ref.name).catch(() => undefined))?.objectId;
      if (!oid) continue;
      await this.nameRef(ref.name, oid);
    }
    await this.nameTips();
  }

  private subpathMatches(path: string, filter: string): number {
    let subpath: number | undefined = 0;
    while (subpath !== undefined) {
      if (this.match(filter, path.slice(subpath))) return subpath;
      const slash = path.indexOf("/", subpath);
      subpath = slash < 0 ? undefined : slash + 1;
    }
    return -1;
  }

  private async nameRef(refname: string, oid: ObjectId): Promise<void> {
    let type = await this.parseObject(oid);
    const { options } = this;
    let canAbbreviate = !!options.tags && !!options.nameOnly;
    if (options.tags && !refname.startsWith("refs/tags/")) return;
    for (const filter of options.exclude ?? []) {
      if (this.subpathMatches(refname, filter) >= 0) return;
    }
    if (options.refs?.length) {
      let matched = false;
      for (const filter of options.refs) {
        const at = this.subpathMatches(refname, filter);
        if (at === 0) matched = true;
        else if (at > 0) {
          matched = true;
          canAbbreviate = true;
        }
      }
      if (!matched) return;
    }
    let o: ObjectId | undefined = oid;
    let deref = false;
    let taggerdate = TIME_MAX;
    for (let depth = 0; type === "tag" && depth < 64; depth++) {
      const tag: { object: ObjectId; tagger?: PersonIdent } | undefined = await this.source
        .loadTag(o as ObjectId)
        .catch(() => undefined);
      if (!tag) break;
      deref = true;
      taggerdate = tag.tagger?.timestamp ?? 0;
      const next: ObjectId = tag.object;
      o = next;
      type = await this.parseObject(next);
      if (type === undefined) o = undefined;
    }
    let commit: ObjectId | undefined;
    let fromTag = false;
    if (o !== undefined && type === "commit") {
      commit = o;
      fromTag = refname.startsWith("refs/tags/");
      if (taggerdate === TIME_MAX) taggerdate = (await this.commit(o))?.date ?? 0;
    }
    let short: string;
    if (canAbbreviate) short = await shortenUnambiguous(refname, this.source.refExists);
    else if (refname.startsWith("refs/heads/")) short = refname.slice("refs/heads/".length);
    else short = refname.slice("refs/".length);
    this.tips.push({ oid, refname: short, commit, taggerdate, fromTag, deref });
  }

  /** name_tips: better tips first (tags, then older), so worse names spread less. */
  private async nameTips(): Promise<void> {
    // QSORT (glibc's stable merge sort): ties keep the refs' order
    const order = this.tips
      .map((t, i) => ({ t, i }))
      .sort((a, b) => {
        const byTag = (b.t.fromTag ? 1 : 0) - (a.t.fromTag ? 1 : 0);
        if (byTag) return byTag;
        if (a.t.taggerdate !== b.t.taggerdate) return a.t.taggerdate < b.t.taggerdate ? -1 : 1;
        return a.i - b.i;
      })
      .map((e) => e.t);
    this.tips.splice(0, this.tips.length, ...order);
    for (const tip of this.tips) {
      if (tip.commit) await this.nameRev(tip.commit, tip.refname, tip.taggerdate, tip);
    }
  }

  private createOrUpdate(
    id: ObjectId,
    taggerdate: number,
    generation: number,
    distance: number,
    fromTag: boolean,
  ): RevName | undefined {
    const known = this.names.get(id);
    if (known && !isBetterName(known, taggerdate, generation, distance, fromTag)) {
      return undefined;
    }
    const name: RevName = known ?? {
      tipName: "",
      taggerdate,
      generation,
      distance,
      fromTag,
    };
    name.taggerdate = taggerdate;
    name.generation = generation;
    name.distance = distance;
    name.fromTag = fromTag;
    this.names.set(id, name);
    return name;
  }

  /** name_rev: a depth-first walk from one tip, first parents first. */
  private async nameRev(
    start: ObjectId,
    tipName: string,
    taggerdate: number,
    tip: { fromTag: boolean; deref: boolean },
  ): Promise<void> {
    const startCommit = await this.parseCommit(start);
    if (!startCommit || this.beforeCutoff(startCommit)) return;
    const startName = this.createOrUpdate(start, taggerdate, 0, 0, tip.fromTag);
    if (!startName) return;
    startName.tipName = tip.deref ? `${tipName}^0` : tipName;
    const stack: ObjectId[] = [start];
    for (let oid = stack.pop(); oid !== undefined; oid = stack.pop()) {
      const name = this.names.get(oid) as RevName;
      const commit = await this.parseCommit(oid);
      const toQueue: ObjectId[] = [];
      let parentNumber = 0;
      for (const parentId of commit?.parents ?? []) {
        parentNumber++;
        const parent = await this.parseCommit(parentId);
        if (!parent || this.beforeCutoff(parent)) continue;
        let generation: number;
        let distance: number;
        if (parentNumber > 1) {
          generation = 0;
          distance = name.distance + MERGE_TRAVERSAL_WEIGHT;
        } else {
          generation = name.generation + 1;
          distance = name.distance + 1;
        }
        // the parent's name may be this commit's own record: read the tip name first
        const parentTip =
          parentNumber > 1 ? parentName(name, parentNumber) : (name.tipName as string);
        const updated = this.createOrUpdate(
          parentId,
          taggerdate,
          generation,
          distance,
          tip.fromTag,
        );
        if (updated) {
          updated.tipName = parentTip;
          toQueue.push(parentId);
        }
      }
      for (let i = toQueue.length - 1; i >= 0; i--) stack.push(toQueue[i] as ObjectId);
    }
  }

  /** get_exact_ref_match: the tip whose ref value is `id` (oid_pos over sorted tips). */
  private exactRefMatch(id: ObjectId): string | undefined {
    if (this.tips.length === 0) return undefined;
    if (!this.sortedTips) {
      this.sortedTips = this.tips
        .map((t, i) => ({ t, i }))
        .sort((a, b) => (a.t.oid < b.t.oid ? -1 : a.t.oid > b.t.oid ? 1 : a.i - b.i))
        .map((e) => e.t);
    }
    const found = oidPos(
      id,
      this.sortedTips.map((t) => t.oid),
    );
    return found >= 0 ? this.sortedTips[found]?.refname : undefined;
  }

  /** get_rev_name. */
  revName(id: ObjectId, type: NameRevObjectType | undefined): string | undefined {
    if (type !== "commit") return this.exactRefMatch(id);
    const n = this.names.get(id);
    if (!n) return undefined;
    if (!n.generation) return n.tipName;
    const base = n.tipName.endsWith("^0") ? n.tipName.slice(0, -2) : n.tipName;
    return `${base}~${n.generation}`;
  }
}

/** get_parent_name. */
function parentName(name: RevName, parentNumber: number): string {
  const base = name.tipName.endsWith("^0") ? name.tipName.slice(0, -2) : name.tipName;
  return name.generation > 0
    ? `${base}~${name.generation}^${parentNumber}`
    : `${base}^${parentNumber}`;
}

const isHex = (c: string | undefined) =>
  c !== undefined && ((c >= "0" && c <= "9") || (c >= "a" && c <= "f"));

/**
 * `git name-rev [<options>] (<rev>... | --all | --annotate-stdin)`: what git prints, and the
 * line it dies with (`cannot describe '<id>'` under `--no-undefined`).
 */
export async function runNameRev(
  source: NameRevSource,
  options: NameRevOptions,
  input: NameRevInput,
): Promise<NameRevRun> {
  const engine = new NameRevEngine(source, options);
  const stderr: string[] = [];
  const shown: { name: string | undefined; id: ObjectId; type: NameRevObjectType }[] = [];
  if ("revs" in input) {
    for (const rev of input.revs) {
      if (rev.id === undefined) {
        stderr.push(`Could not get sha1 for ${rev.name}. Skipping.`);
        continue;
      }
      let type = await engine.parseObject(rev.id);
      if (type === undefined) {
        stderr.push(`Could not get object for ${rev.name}. Skipping.`);
        continue;
      }
      // deref_tag
      let peeled: ObjectId | undefined = rev.id;
      for (let depth = 0; type === "tag" && peeled !== undefined && depth < 64; depth++) {
        const tag: { object: ObjectId } | undefined = await source
          .loadTag(peeled)
          .catch(() => undefined);
        peeled = tag?.object;
        type = peeled === undefined ? undefined : await engine.parseObject(peeled);
      }
      const commit = type === "commit" ? peeled : undefined;
      if (commit) await engine.setCommitCutoff(commit);
      if (options.peelTag) {
        if (!commit) {
          stderr.push(`Could not get commit for ${rev.name}. Skipping.`);
          continue;
        }
        shown.push({ name: rev.name, id: commit, type: "commit" });
      } else {
        const own = engine.objects.types.get(rev.id) as NameRevObjectType;
        shown.push({ name: rev.name, id: rev.id, type: own });
      }
    }
  } else engine.disableCutoff();
  engine.adjustCutoffForSlop();
  await engine.nameRefs();

  let stdout = "";
  if ("annotate" in input) {
    const lines = input.annotate.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const raw of lines) {
      const line = `${raw.endsWith("\r") ? raw.slice(0, -1) : raw}\n`;
      stdout += annotateLine(engine, line, options, options.hexLength ?? 40);
    }
    return { stdout, stderr };
  }
  const allowUndefined = options.allowUndefined ?? true;
  const show = async (id: ObjectId, type: NameRevObjectType, caller?: string) => {
    if (!options.nameOnly) stdout += `${caller ?? id} `;
    const name = engine.revName(id, type);
    if (name !== undefined) stdout += `${name}\n`;
    else if (allowUndefined) stdout += "undefined\n";
    else if (options.always) stdout += `${await source.abbreviate(id)}\n`;
    else return `fatal: cannot describe '${id}'`;
    return undefined;
  };
  if ("all" in input) {
    for (const id of engine.objects.ordered()) {
      if (engine.objects.types.get(id) !== "commit") continue;
      const fatal = await show(id, "commit");
      if (fatal) return { stdout, stderr, fatal };
    }
    return { stdout, stderr };
  }
  for (const s of shown) {
    const fatal = await show(s.id, s.type, s.name);
    if (fatal) return { stdout, stderr, fatal };
  }
  return { stdout, stderr };
}

/** name_rev_line: each full-length hex id in `line` followed by its name. */
function annotateLine(
  engine: NameRevEngine,
  line: string,
  options: NameRevOptions,
  hexsz: number,
): string {
  let out = "";
  let counter = 0;
  let start = 0;
  for (let p = 0; p < line.length; p++) {
    const c = line[p];
    if (!isHex(c)) {
      counter = 0;
    } else if (++counter === hexsz && !isHex(line[p + 1])) {
      counter = 0;
      const id = line.slice(p - (hexsz - 1), p + 1);
      const type = engine.objects.types.get(id);
      const name = type ? engine.revName(id, type) : undefined;
      if (name === undefined) continue;
      if (options.nameOnly) out += line.slice(start, p + 1 - hexsz) + name;
      else out += `${line.slice(start, p + 1)} (${name})`;
      start = p + 1;
    }
  }
  return out + line.slice(start);
}

/** What {@link nameRevByTags} reads. */
export type DescribeContainsSource = NameRevSource;

/**
 * `git describe --contains <id>` with default options (`name-rev --peel-tag --name-only
 * --no-undefined --tags`): the name, undefined when no tag contains the commit.
 */
export async function nameRevByTags(
  source: NameRevSource,
  id: ObjectId,
): Promise<string | undefined> {
  const run = await runNameRev(
    source,
    { peelTag: true, nameOnly: true, allowUndefined: false, tags: true },
    { revs: [{ name: id, id }] },
  );
  if (run.fatal || run.stdout === "") return undefined;
  return run.stdout.replace(/\n$/, "");
}

/** The commit stores {@link commitLoaderOf} reads. */
export interface NameRevCommitStore {
  load(id: ObjectId): Promise<{ parents: ObjectId[]; committer: PersonIdent } | undefined>;
  headerReader?(): Promise<{
    getHeader(
      id: ObjectId,
    ): Promise<{ parents: ObjectId[]; commitTime: number; generation: number } | undefined>;
  }>;
}

/**
 * `loadCommit` over a commit store: from the commit-graph loaded at the first read where it
 * has the commit (its generation), else from the object (generation Infinity). In a shallow
 * repository (`shallow`: its `.git/shallow` commits, given or read on first use) a shallow
 * commit has no parents and no commit-graph is read (git's `commit_graph_compatible`).
 */
export function commitLoaderOf(
  commits: NameRevCommitStore,
  shallow?: () => Promise<readonly ObjectId[] | undefined>,
): (id: ObjectId) => Promise<NameRevCommit | undefined> {
  let cut: Promise<Set<ObjectId>> | undefined;
  const plain = graphLoaderOf(commits);
  const fromObjects = async (id: ObjectId) => {
    const c = await commits.load(id).catch(() => undefined);
    return c
      ? { parents: c.parents, date: c.committer.timestamp, generation: INFINITY }
      : undefined;
  };
  return async (id) => {
    cut ??= (shallow?.().catch(() => undefined) ?? Promise.resolve(undefined)).then(
      (ids) => new Set(ids ?? []),
    );
    const boundary = await cut;
    if (boundary.size === 0) return plain(id);
    const c = await fromObjects(id);
    return c && boundary.has(id) ? { ...c, parents: [] } : c;
  };
}

/** {@link commitLoaderOf} without shallow commits. */
function graphLoaderOf(
  commits: NameRevCommitStore,
): (id: ObjectId) => Promise<NameRevCommit | undefined> {
  let reader:
    | Promise<
        | {
            getHeader(
              id: ObjectId,
            ): Promise<{ parents: ObjectId[]; commitTime: number; generation: number } | undefined>;
          }
        | undefined
      >
    | undefined;
  return async (id) => {
    reader ??= commits.headerReader?.().catch(() => undefined) ?? Promise.resolve(undefined);
    const r = await reader;
    if (r) {
      const h = await r.getHeader(id).catch(() => undefined);
      return h ? { parents: h.parents, date: h.commitTime, generation: h.generation } : undefined;
    }
    const c = await commits.load(id).catch(() => undefined);
    return c
      ? { parents: c.parents, date: c.committer.timestamp, generation: INFINITY }
      : undefined;
  };
}

/**
 * A commit store's `load` as a shallow repository's walks read it: the commits of
 * `.git/shallow` without parents (git's shallow grafts), others as stored.
 */
export function withShallowParents<C extends { parents: ObjectId[] }>(
  commits: { load(id: ObjectId): Promise<C | undefined> },
  shallow: () => Promise<readonly ObjectId[] | undefined>,
): { load(id: ObjectId): Promise<C | undefined> } {
  let cut: Promise<Set<ObjectId>> | undefined;
  return {
    load: async (id) => {
      cut ??= shallow()
        .catch(() => undefined)
        .then((ids) => new Set(ids ?? []));
      const c = await commits.load(id);
      return c && (await cut).has(id) ? { ...c, parents: [] } : c;
    },
  };
}
