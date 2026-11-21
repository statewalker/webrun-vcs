/**
 * git's split index (`split-index.c`): the index file holds a `link` extension naming a
 * shared index (`$GIT_DIR/sharedindex.<id>`, a whole index without extensions) and two
 * EWAH bitmaps over the shared index's entries: the ones deleted and the ones replaced.
 * The index file's own entries are the replacements (in shared-index order, names
 * stripped) followed by the entries the shared index lacks.
 *
 * ```typescript
 * const link = parseLinkExtension(ext.data);
 * const shared = await readSharedIndex(files, gitDir, link.baseId);
 * const entries = mergeSplitIndex(parsed.entries, link, shared);
 * ```
 *
 * An entry read from a split index remembers its position in the shared index (git's
 * `ce->index`, here kept beside the entry object), so the next write can tell the entries
 * the shared index still holds from the changed ones, as `prepare_to_write_split_index`
 * does: an entry object kept as read stays shared, one replaced in place by an edit (`git
 * add`, a refresh) is written as a replacement when its data changed, and a new entry from a
 * tree in an unpack-trees write (checkout, reset, merge) deletes the shared one it replaces
 * and is written whole.
 */

import { readFile } from "@statewalker/vcs-core";
import { bytesToHex } from "@statewalker/vcs-utils";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import { type FilesApi, joinPath } from "@statewalker/vcs-utils/files";
import { Ewah } from "../status/untracked-cache.js";
import {
  type IndexEncoding,
  type IndexVersion,
  type OrderedIndexItem,
  parseIndexFile,
  sameOnDiskEntryData,
} from "./index-format.js";
import type { StagingEntry } from "./types.js";

/** The all-zero object id: a `link` naming no shared index. */
const NULL_ID = "0".repeat(40);

/** A `link` extension: the shared index's id and the bitmaps over its entries. */
export interface LinkExtension {
  /** The shared index's checksum, hex (all zeros: none) */
  baseId: string;
  /** The shared entries deleted (git's `delete_bitmap`); undefined when the link has none */
  deleted?: number[];
  /** The shared entries replaced, in order (git's `replace_bitmap`) */
  replaced?: number[];
}

/** git's `read_link_extension`. */
export function parseLinkExtension(data: Uint8Array): LinkExtension {
  if (data.length < 20) throw new Error("corrupt link extension (too short)");
  const baseId = bytesToHex(data.subarray(0, 20));
  if (data.length === 20) return { baseId };
  const del = Ewah.read(data, 20, data.length);
  if (!del) throw new Error("corrupt delete bitmap in link extension");
  const rep = Ewah.read(data, del.next, data.length);
  if (!rep) throw new Error("corrupt replace bitmap in link extension");
  if (rep.next !== data.length) throw new Error("garbage at the end of link extension");
  return { baseId, deleted: [...del.bitmap.bits()], replaced: [...rep.bitmap.bits()] };
}

/** git's `write_link_extension`: the shared index's id, then the delete and replace bitmaps. */
export function encodeLinkExtension(baseId: string, deleted: Ewah, replaced: Ewah): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < 40; i += 2) out.push(Number.parseInt(baseId.slice(i, i + 2), 16));
  deleted.serialize(out);
  replaced.serialize(out);
  return Uint8Array.from(out);
}

/** A shared index as read or written: its id (checksum) and entries in order. */
export interface SharedIndex {
  readonly id: string;
  readonly entries: readonly StagingEntry[];
  readonly version: IndexVersion;
  /** Where its entries' bytes are (a full write of them copies them) */
  readonly encoding?: IndexEncoding;
}

/**
 * Where an entry stands in a shared index (git's `ce->index`, 0-based here) and whether it
 * is to be written as a replacement (git's `CE_UPDATE_IN_BASE`).
 */
interface SharedLink {
  sharedId: string;
  pos: number;
  update: boolean;
}

const sharedLinks = new WeakMap<StagingEntry, SharedLink>();

/** The shared indexes read, by id: a split index read again finds its shared one parsed. */
const sharedCache = new Map<string, SharedIndex>();
const SHARED_CACHE_SIZE = 4;

function remember(shared: SharedIndex): void {
  sharedCache.delete(shared.id);
  sharedCache.set(shared.id, shared);
  while (sharedCache.size > SHARED_CACHE_SIZE) {
    const oldest = sharedCache.keys().next().value as string;
    sharedCache.delete(oldest);
  }
}

/** The path of the shared index `id` in `gitDir`. */
export function sharedIndexPath(gitDir: string, id: string): string {
  return joinPath(gitDir, `sharedindex.${id}`);
}

/**
 * Read `sharedindex.<id>` from `gitDir` (else from `indexDir`, the index file's directory, as
 * `read_index_from` falls back to it), checking that its checksum is `id`. The shared index
 * is freshened (its mtime set to now), as git signals that it is in use.
 *
 * @throws Error when it is missing or broken (git: `broken index, expect <id> in <path>`)
 */
export async function readSharedIndex(
  files: FilesApi,
  gitDir: string,
  id: string,
  indexDir: string = gitDir,
): Promise<SharedIndex> {
  let path = sharedIndexPath(gitDir, id);
  if ((await files.stats(path))?.kind !== "file") {
    const fallback = sharedIndexPath(indexDir, id);
    if ((await files.stats(fallback))?.kind !== "file") {
      throw new Error(`${fallback}: index file open failed: No such file or directory`);
    }
    path = fallback;
  }
  let shared = sharedCache.get(id);
  if (!shared) {
    const data = await readFile(files, path);
    const parsed = await parseIndexFile(data, { keepEncoding: true });
    const got = bytesToHex(data.subarray(data.length - 20));
    if (got !== id) throw new Error(`broken index, expect ${id} in ${path}, got ${got}`);
    shared = {
      id,
      entries: parsed.entries,
      version: parsed.version,
      ...(parsed.encoding ? { encoding: parsed.encoding } : {}),
    };
    remember(shared);
  }
  await freshenFile(files, path);
  return shared;
}

/** git's `freshen_shared_index`: the file's mtime set to now (best effort). */
export async function freshenFile(files: FilesApi, path: string): Promise<boolean> {
  try {
    return (await files.touch?.(path)) ?? false;
  } catch {
    return false;
  }
}

/**
 * git's `merge_base_index`: the entries of a split index, from the index file's own entries
 * (`own`, in file order) and the shared index. Each entry learns its place in the shared
 * index for the next write.
 *
 * @throws Error on a corrupt link, as git dies
 */
export function mergeSplitIndex(
  own: readonly StagingEntry[],
  link: LinkExtension,
  shared: SharedIndex,
): StagingEntry[] {
  const base = shared.entries;
  const cache: (StagingEntry | undefined)[] = base.slice();
  base.forEach((entry, pos) => {
    sharedLinks.set(entry, { sharedId: shared.id, pos, update: false });
  });
  let replacements = 0;
  for (const pos of link.replaced ?? []) {
    if (pos >= base.length) {
      throw new Error(`position for replacement ${pos} exceeds base index size ${base.length}`);
    }
    if (replacements >= own.length) {
      throw new Error(`too many replacements (${replacements} vs ${own.length})`);
    }
    const src = own[replacements] as StagingEntry;
    if (src.path !== "") {
      throw new Error(`corrupt link extension, entry ${pos} should have zero length name`);
    }
    const replaced: StagingEntry = { ...src, path: (base[pos] as StagingEntry).path };
    sharedLinks.set(replaced, { sharedId: shared.id, pos, update: true });
    cache[pos] = replaced;
    replacements++;
  }
  for (const pos of link.deleted ?? []) {
    if (pos >= base.length) {
      throw new Error(`position for delete ${pos} exceeds base index size ${base.length}`);
    }
    cache[pos] = undefined;
  }
  const merged = cache.filter((e): e is StagingEntry => e !== undefined);
  // the entries the shared index lacks: add_index_entry (one at an existing path replaces it)
  const added: StagingEntry[] = [];
  for (let i = replacements; i < own.length; i++) {
    const entry = own[i] as StagingEntry;
    if (entry.path === "") {
      throw new Error(`corrupt link extension, entry ${i} should have non-zero length name`);
    }
    added.push(entry);
  }
  if (added.length === 0) return merged;
  const byKey = new Map<string, number>();
  merged.forEach((e, i) => {
    byKey.set(`${e.stage}\0${e.path}`, i);
  });
  const out: (StagingEntry | undefined)[] = merged.slice();
  const extra: (StagingEntry | undefined)[] = [];
  for (const entry of added) {
    const at = byKey.get(`${entry.stage}\0${entry.path}`);
    if (at === undefined) {
      // add_index_entry_with_check: a merged entry replaces every unmerged one of its path
      if (entry.stage === 0) {
        for (const stage of [1, 2, 3]) {
          const key = `${stage}\0${entry.path}`;
          const i = byKey.get(key);
          if (i !== undefined) out[i] = undefined;
          byKey.delete(key);
        }
        for (let k = 0; k < extra.length; k++) {
          const x = extra[k];
          if (x && x.path === entry.path && x.stage !== 0) extra[k] = undefined;
        }
      }
      extra.push(entry);
      continue;
    }
    // replace_index_entry: the new entry takes the old one's place in the shared index
    const old = out[at] as StagingEntry;
    const link = sharedLinks.get(old);
    if (link?.sharedId === shared.id) sharedLinks.set(entry, { ...link, update: true });
    out[at] = entry;
  }
  return [...out, ...extra]
    .filter((e): e is StagingEntry => e !== undefined)
    .sort((a, b) => compareGitPaths(a.path, b.path) || a.stage - b.stage);
}

/** How the entries of the index stand against a shared index before a split write. */
export interface SplitClassification {
  /** Per shared entry: the entry of the index that keeps it, if any */
  matched: (StagingEntry | undefined)[];
  /** Per shared entry: whether it is written as a replacement */
  update: boolean[];
  /** The entries the shared index does not hold (git's `ce->index == 0`), in index order */
  added: StagingEntry[];
}

/**
 * Which entries of `entries` the shared index holds (git's `ce->index`), against the entries
 * the index held when it was last read or written (`previous`). An entry read from the
 * shared index (or written against it) keeps its place, a replacement when it was one or its
 * data changed. A new entry object takes the place of the previous entry at its path and
 * stage (git's `replace_index_entry`, and unpack-trees' copy of an unchanged entry), a
 * replacement when that one was or its data differs from the shared one; but in an
 * unpack-trees write (`unpackTrees`) an entry whose object or mode differs from the previous
 * one is built from a tree: the shared entry is deleted and the new one written whole, as is
 * an entry at a path the index did not hold, and a new entry at a path in `readded` (removed
 * and added again, as `git apply` edits the index).
 */
export function classifySplitEntries(
  entries: readonly StagingEntry[],
  shared: SharedIndex,
  unpackTrees: boolean,
  previous: readonly StagingEntry[] = [],
  readded?: ReadonlySet<string>,
): SplitClassification {
  const base = shared.entries;
  const matched: (StagingEntry | undefined)[] = new Array(base.length);
  const update: boolean[] = new Array(base.length).fill(false);
  const added: StagingEntry[] = [];
  let before: Map<string, StagingEntry> | undefined;
  for (const entry of entries) {
    let link = sharedLinks.get(entry);
    let pos = -1;
    let changed = false;
    if (!link || link.sharedId !== shared.id) {
      // a new object: it takes the place of the entry it replaced
      if (!before) {
        before = new Map();
        for (const e of previous) before.set(`${e.stage}\0${e.path}`, e);
      }
      const old = before.get(`${entry.stage}\0${entry.path}`);
      const oldLink = old ? sharedLinks.get(old) : undefined;
      link = undefined;
      if (old && oldLink?.sharedId === shared.id && !readded?.has(entry.path)) {
        const fromTree =
          unpackTrees && (old.objectId !== entry.objectId || old.mode !== entry.mode);
        if (!fromTree) link = oldLink;
      }
    }
    if (link && link.pos < base.length) {
      const b = base[link.pos] as StagingEntry;
      if (b.path === entry.path && b.stage === entry.stage && matched[link.pos] === undefined) {
        pos = link.pos;
        changed = link.update || (entry !== b && !sameOnDiskEntryData(entry, b));
      }
    }
    if (pos < 0) {
      added.push(entry);
      continue;
    }
    matched[pos] = entry;
    update[pos] = changed;
  }
  return { matched, update, added };
}

/**
 * git's `too_many_not_shared_entries`: whether more than `maxPercent` percent of the entries
 * are not in the shared index (0: always, 100: never).
 */
export function tooManyNotSharedEntries(
  total: number,
  notShared: number,
  maxPercent: number,
): boolean {
  if (maxPercent === 0) return true;
  if (maxPercent === 100) return false;
  return total * maxPercent < notShared * 100;
}

/**
 * git's `prepare_to_write_split_index`: the index file's entries (replacements with their
 * names stripped, in shared-index order, then the new entries) and the `link` payload.
 */
export function prepareSplitWrite(
  classification: SplitClassification,
  sharedId: string,
): { items: OrderedIndexItem[]; link: Uint8Array } {
  const deleted = new Ewah();
  const replaced = new Ewah();
  const items: OrderedIndexItem[] = [];
  const { matched, update, added } = classification;
  for (let i = 0; i < matched.length; i++) {
    const entry = matched[i];
    if (!entry) deleted.set(i);
    else if (update[i]) {
      replaced.set(i);
      items.push({ entry, path: "" });
    }
  }
  for (const entry of added) items.push({ entry, path: entry.path });
  return { items, link: encodeLinkExtension(sharedId, deleted, replaced) };
}

/** After a split write: the entries remember where they stand in the shared index. */
export function rememberSplitWrite(classification: SplitClassification, sharedId: string): void {
  classification.matched.forEach((entry, pos) => {
    if (entry)
      sharedLinks.set(entry, { sharedId, pos, update: classification.update[pos] === true });
  });
  for (const entry of classification.added) sharedLinks.delete(entry);
}

/** A shared index of `entries`, as written (each entry now stands at its position there). */
export function adoptSharedIndex(shared: SharedIndex): void {
  shared.entries.forEach((entry, pos) => {
    sharedLinks.set(entry, { sharedId: shared.id, pos, update: false });
  });
  remember(shared);
}

/** Whether an id is the all-zero id (a link without a shared index). */
export function isNullIndexId(id: string): boolean {
  return id === NULL_ID;
}
