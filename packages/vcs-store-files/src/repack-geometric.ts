/**
 * `git repack --geometric=<factor>` (builtin/repack.c with repack-geometry.c): the packs that
 * are neither kept nor cruft, sorted by object count, are split where the larger ones already
 * form a geometric progression (each at least `factor` times the one before); the packs below
 * the split and every loose object are rolled up into one new pack (`pack-objects --stdin-packs
 * --unpacked`), leaving out what the packs above the split hold. With `-d` the rolled-up packs
 * are removed, and with `--write-midx` a multi-pack-index over the packs that stay is written,
 * the largest one above the split preferred.
 *
 * Promisor packs: 2.5x splits them in a geometry of their own and rolls the ones below its
 * split up into a new promisor pack (`pack_geometry_repack_promisors`); 2.43 rolls them up with
 * the rest, and dies in a repository with a promisor remote (its pack-objects refuses
 * `--exclude-promisor-objects` with `--stdin-packs`). `-i` restricts nothing: pack-objects
 * loads delta islands only for a reachability walk, never for `--stdin-packs`. The `delta`
 * attribute and the name hashes come from pack-objects' best-effort hint walk
 * (`show_object_pack_hint`) from the commits of the rolled-up packs and the loose ones.
 *
 * `repack.midxMustContainCruft=false` (2.5x; 2.43 has no such setting) runs pack-objects with
 * `--stdin-packs=follow`: the packs above the split that the existing midx does not name are
 * `!` (excluded-open: not known closed under reachability), their commits start the walk too,
 * and every object the walk reaches that no excluded pack holds goes into the new pack, so
 * once-cruft objects made reachable again are rescued from the cruft packs. The midx then
 * leaves the cruft packs out unless the old midx named a pack the new one would lose
 * (`midx_has_unknown_packs`), or nothing was written and there was no midx.
 */

import type { ObjectId, ObjectTypeString, Pack, PackObjectRef } from "@statewalker/vcs-core";
import {
  clearMultiPackIndexNaming,
  decodeTreeBytes,
  joinPath,
  listObjects,
  loadMultiPackIndex,
  objectFormatOf,
  packNameOf,
  parseCommitHeader,
  writePack,
} from "@statewalker/vcs-core";
import { multiPackIndexWrite } from "./multi-pack-index.js";
import { keepPackNames, looseObjectIdsInGitOrder, objectIdPattern } from "./object-names.js";
import { packDeltaSearch, readPackWriteSettings } from "./pack/pack-write-settings.js";
import {
  IncrementalBitmapError,
  NO_CLOSURE_BITMAP_WARNING,
  prunePacked,
  type RepackOptions,
  type RepackResult,
  readBitmapSettings,
} from "./repack.js";
import { readRepositoryFormat } from "./repository-format.js";

/** `options '--geometric' and '-A/-a' cannot be used together` (git dies). */
export class GeometricRepackError extends Error {
  override name = "GeometricRepackError";
}

/** The split of git's `compute_pack_geometry_split`: packs below it are rolled up. */
export function geometricSplit(weights: readonly number[], factor: number): number {
  const n = weights.length;
  if (n === 0) return 0;
  const w = (i: number) => weights[i] as number;
  let i: number;
  for (i = n - 1; i > 0; i--) if (w(i) < factor * w(i - 1)) break;
  let split = i;
  if (split) split++;
  let total = 0;
  for (i = 0; i < split; i++) total += w(i);
  for (i = split; i < n; i++) {
    if (w(i) < factor * total) {
      split++;
      total += w(i);
    } else break;
  }
  return split;
}

/** A pack of the repository, with what the geometric repack needs to know of it. */
interface PackInfo {
  pack: Pack;
  /** a `.keep` file, or named by `--keep-pack` */
  keep: boolean;
  /** named by `--keep-pack` (git's kept in core: its objects never go into the new packs) */
  keptInCore: boolean;
  cruft: boolean;
  promisor: boolean;
  mtime: number;
}

/** `git repack --geometric` with a promisor remote under 2.43: its pack-objects dies so. */
export const GEOMETRIC_PROMISOR_REMOTE_2_43 =
  "fatal: cannot use internal rev list with --stdin-packs";

/**
 * The paths of pack-objects' `--stdin-packs` hint walk (`read_stdin_packs`): a revision walk
 * from `tips` that never enters the objects of `excluded` (`no_kept_objects` over the packs
 * kept in core), giving each object of `ids` it meets the path it was met at
 * (`show_object_pack_hint`), the shallow commits' parents cut. A missing link (a partial
 * clone's absent tree) is passed over and the walk goes on (git's `ignore_missing_links`).
 */
async function stdinPacksHints(
  objects: Parameters<typeof listObjects>[0],
  tips: readonly ObjectId[],
  excluded: readonly Pack[],
  ids: ReadonlySet<ObjectId>,
  shallow: readonly ObjectId[],
): Promise<Map<ObjectId, { type: ObjectTypeString; path: string }>> {
  const hints = new Map<ObjectId, { type: ObjectTypeString; path: string }>();
  if (tips.length === 0) return hints;
  const exclude = new Set<ObjectId>();
  for (const p of excluded) for (const id of p.ids()) exclude.add(id);
  try {
    // the shallow commits' parents are cut, as git parses commits through its grafts
    for await (const o of listObjects(objects, {
      wants: tips,
      excludeObjects: exclude,
      ignoreMissingLinks: true,
      ...(shallow.length ? { shallow } : {}),
    })) {
      if (o.path === undefined || !ids.has(o.id) || hints.has(o.id)) continue;
      hints.set(o.id, { type: o.type, path: o.path });
    }
  } catch {
    // a best-effort walk: the hints found so far stay
  }
  return hints;
}

/** An object `followWalk` reached, with the path git's walk names it by. */
interface FollowedObject {
  id: ObjectId;
  type: ObjectTypeString;
  path: string;
}

/**
 * pack-objects' `--stdin-packs=follow` walk (`read_stdin_packs` over `traverse_commit_list`,
 * `ignore_missing_links`): from `tips` (newest first), every commit not in a closed pack
 * (`^`, `--keep-pack`: `no_kept_objects` over the packs kept in core) is shown with its tree;
 * with open packs (`!`) present, the walk neither goes past a closed commit's parents nor
 * enters a closed tree (`include_check`). A missing object ends its own branch only.
 */
async function followWalk(
  objects: Parameters<typeof listObjects>[0],
  tips: readonly ObjectId[],
  closed: (id: ObjectId) => boolean,
  hasOpen: boolean,
  shallow: ReadonlySet<ObjectId>,
  idLength: number,
): Promise<FollowedObject[]> {
  const out: FollowedObject[] = [];
  const read = async (
    id: ObjectId,
  ): Promise<{ type: ObjectTypeString; data: Uint8Array } | undefined> => {
    try {
      const o = await objects.get(id);
      if (!o) return undefined;
      if (o.bytes) return { type: o.type, data: o.bytes };
      const parts: Uint8Array[] = [];
      let n = 0;
      for await (const c of o.content) {
        parts.push(c);
        n += c.length;
      }
      const data = new Uint8Array(n);
      let at = 0;
      for (const c of parts) {
        data.set(c, at);
        at += c.length;
      }
      return { type: o.type, data };
    } catch {
      return undefined;
    }
  };
  const seen = new Set<ObjectId>();
  // commits by committer time, newest first (the revision walk's queue)
  const queue: { id: ObjectId; time: number; at: number }[] = [];
  let order = 0;
  const trees: ObjectId[] = [];
  const push = async (id: ObjectId) => {
    if (seen.has(id)) return;
    seen.add(id);
    const o = await read(id);
    if (o?.type !== "commit") return;
    let info: ReturnType<typeof parseCommitHeader>;
    try {
      info = parseCommitHeader(id, o.data);
    } catch {
      return;
    }
    queue.push({ id, time: info.time, at: order++ });
    infos.set(id, info);
  };
  const infos = new Map<ObjectId, ReturnType<typeof parseCommitHeader>>();
  for (const tip of tips) await push(tip);
  while (queue.length > 0) {
    let best = 0;
    for (let i = 1; i < queue.length; i++) {
      const q = queue[i] as (typeof queue)[number];
      const b = queue[best] as (typeof queue)[number];
      if (q.time > b.time || (q.time === b.time && q.at < b.at)) best = i;
    }
    const { id } = queue.splice(best, 1)[0] as (typeof queue)[number];
    const info = infos.get(id) as ReturnType<typeof parseCommitHeader>;
    const isClosed = closed(id);
    // process_parents: include_check stops at a closed commit when open packs are present
    if (!(hasOpen && isClosed) && !shallow.has(id)) for (const p of info.parents) await push(p);
    // get_commit_action: a commit in a pack kept in core is not shown
    if (isClosed) continue;
    out.push({ id, type: "commit", path: "" });
    trees.push(info.tree);
  }
  const walkTree = async (id: ObjectId, path: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    if (hasOpen && closed(id)) return;
    const o = await read(id);
    if (o?.type !== "tree") return;
    out.push({ id, type: "tree", path });
    let entries: ReturnType<typeof decodeTreeBytes>;
    try {
      entries = decodeTreeBytes(o.data, { idLength, checkNames: false });
    } catch {
      return;
    }
    for (const e of entries) {
      const kind = Number(e.mode) & 0o170000;
      const child = path ? `${path}/${e.name}` : e.name;
      if (kind === 0o040000) await walkTree(e.id, child);
      else if (kind !== 0o160000 && !seen.has(e.id)) {
        seen.add(e.id);
        out.push({ id: e.id, type: "blob", path: child });
      }
    }
  };
  for (const t of trees) await walkTree(t, "");
  return out;
}

/**
 * Repack geometrically (see the module comment). Returns null when nothing was written
 * (git's "Nothing new to pack."), then only the midx may have been written and the warnings go
 * to `options.onWarning`.
 *
 * @example
 * ```typescript
 * await repack({ ...backend, all: false, geometric: 2 }); // git repack --geometric=2 -d
 * ```
 */
export async function geometricRepack(options: RepackOptions): Promise<RepackResult | null> {
  const { files, packs, looseStorage, objects } = options;
  const factor = options.geometric as number;
  if (options.all === true || options.cruft || options.unpackUnreachable)
    throw new GeometricRepackError(
      "fatal: options '--geometric' and '-A/-a' cannot be used together",
    );
  const deleteRedundant = options.deleteRedundant ?? true;
  const gitDir = options.gitDir ?? ".git";
  const packDir = joinPath(gitDir, "objects", "pack");
  const format = objectFormatOf(objects);
  const legacy = options.compatibility === "2.43";
  const alternates = (await objects.alternates?.list()) ?? [];
  const warnings: string[] = [];

  const bitmapSettings = await readBitmapSettings(files, gitDir, {
    ...(options.environment ? { environment: options.environment } : {}),
  });
  // git's write_bitmaps: -b or repack.writeBitmaps, else -1 (true) with --write-midx; the midx
  // gets a bitmap only when it is > 0
  const explicitBitmaps = options.writeBitmaps ?? bitmapSettings.writeBitmaps;
  let writeBitmaps = explicitBitmaps === true;
  // an incremental repack has no pack bitmap (git dies), a midx can have one
  if (writeBitmaps && !options.writeMidx) throw new IncrementalBitmapError();
  // -l with alternates: the midx would not cover every object
  if ((explicitBitmaps ?? options.writeMidx === true) && options.local && alternates.length > 0) {
    warnings.push(NO_CLOSURE_BITMAP_WARNING);
    writeBitmaps = false;
  }
  const packKeptObjects = options.packKeptObjects ?? bitmapSettings.packKeptObjects ?? false;
  // repack.midxMustContainCruft=false: pack-objects --stdin-packs=follow (2.5x only)
  let midxMustContainCruft =
    legacy || (options.midxMustContainCruft ?? bitmapSettings.midxMustContainCruft ?? true);
  const follow = !midxMustContainCruft;
  // 2.43's pack-objects refuses --exclude-promisor-objects (repo_has_promisor_remote) with
  // --stdin-packs
  if (legacy && (await readRepositoryFormat(files, gitDir)).partialClone !== undefined)
    throw new GeometricRepackError(GEOMETRIC_PROMISOR_REMOTE_2_43);

  await packs.refresh();
  const all = await packs.packs();
  // by base name, as git's --keep-pack compares pack_basename (`custom-<id>.pack` too)
  const inCore = keepPackNames(options.keepPacks);
  const info: PackInfo[] = await Promise.all(
    all.map(async (p) => {
      const base = joinPath(packDir, packNameOf(p));
      const keptInCore = inCore.has(packNameOf(p));
      return {
        pack: p,
        keep: keptInCore || (await files.exists(`${base}.keep`)),
        keptInCore,
        cruft: await files.exists(`${base}.mtimes`),
        promisor: await files.exists(`${base}.promisor`),
        mtime: (await files.stats(`${base}.pack`))?.lastModified ?? 0,
      };
    }),
  );
  // repo_for_each_pack's order (newest first), then the object counts, ascending
  info.sort((a, b) => b.mtime - a.mtime);
  // pack_geometry_init: kept packs only with --pack-kept-objects, never cruft packs; 2.5x keeps
  // the promisor packs in a geometry of their own
  const eligible = info
    .filter((i) => (packKeptObjects || !i.keep) && !i.cruft)
    .map((i, at) => ({ ...i, at }));
  const byCount = (a: (typeof eligible)[number], b: (typeof eligible)[number]) =>
    a.pack.count - b.pack.count || a.at - b.at;
  const geometry = eligible.filter((i) => legacy || !i.promisor).sort(byCount);
  const promisorGeometry = legacy ? [] : eligible.filter((i) => i.promisor).sort(byCount);
  const split = geometricSplit(
    geometry.map((g) => g.pack.count),
    factor,
  );
  const promisorSplit = geometricSplit(
    promisorGeometry.map((g) => g.pack.count),
    factor,
  );
  const rolled = geometry.slice(0, split);
  const above = geometry.slice(split);
  // the packs the existing midx names (git's existing.midx_packs: `p->multi_pack_index`)
  const existingMidx = (
    await loadMultiPackIndex(files, packDir, {
      objectFormat: format,
      ...(legacy ? { compatibility: "2.43" as const } : {}),
    }).catch(() => undefined)
  )?.midx;
  const midxPacks = new Set<string>();
  for (let m = existingMidx; m; m = m.base)
    for (const n of m.packNames) midxPacks.add(n.replace(/\.idx$/, ""));
  // follow: the packs above the split no midx names are `!` (not known closed), the rest `^`
  const openAbove = follow ? above.filter((g) => !midxPacks.has(packNameOf(g.pack))) : [];
  const promisorRolled = promisorGeometry.slice(0, promisorSplit);
  const promisorAbove = promisorGeometry.slice(promisorSplit);
  // --honor-pack-keep (without --pack-kept-objects) and --keep-pack (always: repack passes it
  // to pack-objects whatever --pack-kept-objects says) keep a pack's objects out
  const keptOut = info.filter((i) => i.keptInCore || (i.keep && !packKeptObjects));

  const settings =
    options.packSettings ??
    (await readPackWriteSettings(files, gitDir, {
      ...(options.environment ? { environment: options.environment } : {}),
    }));
  const idPattern = objectIdPattern(format);
  const shallow = (await options.history.refs.getShallow?.().catch(() => [])) ?? [];
  // the type from the entry header, else from the object (its content left unread)
  const typeOf = async (id: ObjectId): Promise<ObjectTypeString | undefined> => {
    const known = (await objects.header?.(id))?.type ?? (await objects.objectType?.(id));
    if (known) return known;
    const o = await objects.get(id);
    if (o && !o.bytes) await o.content[Symbol.asyncIterator]().return?.();
    return o?.type;
  };

  /**
   * The loose objects in git's order (fan-out directories in order, each in readdir order:
   * their list position breaks ties of the delta search), those the FilesApi does not list
   * after them.
   */
  const looseIds = async (): Promise<ObjectId[]> => {
    const keys: ObjectId[] = [];
    for await (const key of looseStorage.keys()) if (idPattern.test(key)) keys.push(key);
    const present = new Set(keys);
    const ordered = (
      await looseObjectIdsInGitOrder(files, joinPath(gitDir, "objects"), format)
    ).filter((id) => present.delete(id));
    return [...ordered, ...keys.filter((id) => present.has(id))];
  };

  /**
   * One `pack-objects --stdin-packs` run: the objects of `include` (newest pack first, pack
   * order), then (`unpacked`) every loose object, each once, none an `excluded` pack holds (or,
   * with -l, an alternate). The hint walk never enters `walkExcluded` (the packs kept in core:
   * `^` and `--keep-pack` ones).
   */
  const list = async (
    include: readonly PackInfo[],
    excluded: readonly Pack[],
    walkExcluded: readonly Pack[],
    unpacked: boolean,
    /** --stdin-packs=follow: the `!` packs (their commits start the walk) */
    open?: readonly PackInfo[],
  ): Promise<PackObjectRef[]> => {
    const ids: ObjectId[] = [];
    const seen = new Set<ObjectId>();
    const tips: ObjectId[] = [];
    const noDelta = new Map<string, boolean>();
    // the objects the hint walk may name: 2.43 walks before adding the loose objects
    // (read_packs_list_from_stdin), so they keep the empty name; 2.5x walks after
    // (read_stdin_packs), from the loose commits too
    const hinted = new Set<ObjectId>();
    const add = async (id: ObjectId, loose: boolean) => {
      if (seen.has(id)) return;
      seen.add(id);
      // commits of the included packs (and in 2.5x loose commits) start the hint walk
      const walks = !(loose && legacy);
      if (walks && (await typeOf(id)) === "commit") tips.push(id);
      if (excluded.some((p) => p.has(id))) return;
      if (options.local) for (const alt of alternates) if (await alt.objects.has(id)) return;
      ids.push(id);
      if (walks) hinted.add(id);
    };
    const byMtime = [...include, ...(open ?? [])].sort((a, b) => b.mtime - a.mtime);
    for (const g of byMtime) for (const id of g.pack.ids()) await add(id, false);
    if (unpacked) for (const key of await looseIds()) await add(key, true);
    if (open) {
      // follow: what the walk reaches is packed too (with its name); the objects listed so far
      // are duplicates to it, so they get no name (add_object_entry's have_duplicate_entry)
      const closedIds = new Set<ObjectId>();
      for (const p of walkExcluded) for (const id of p.ids()) closedIds.add(id);
      const refs: PackObjectRef[] = [...ids];
      const reached = await followWalk(
        objects,
        tips,
        (id) => closedIds.has(id),
        open.length > 0,
        new Set(shallow),
        format.rawLength,
      );
      for (const o of reached) {
        if (seen.has(o.id)) continue;
        seen.add(o.id);
        if (excluded.some((p) => p.has(o.id))) continue;
        if (options.local) {
          let borrowed = false;
          for (const alt of alternates) if (await alt.objects.has(o.id)) borrowed = true;
          if (borrowed) continue;
        }
        // a blob the repository lacks (a partial clone's) is skipped
        if (o.type === "blob" && !(await objects.has(o.id))) continue;
        let off = false;
        if (options.noDelta && o.path) {
          const known = noDelta.get(o.path);
          off = known ?? (await options.noDelta(o.path));
          if (known === undefined) noDelta.set(o.path, off);
        }
        refs.push({ id: o.id, type: o.type, path: o.path, ...(off ? { noDelta: true } : {}) });
      }
      return refs;
    }
    const hints = await stdinPacksHints(objects, tips, walkExcluded, hinted, shallow);
    const refs: PackObjectRef[] = [];
    for (const id of ids) {
      const hint = hints.get(id);
      if (!hint) {
        refs.push(id);
        continue;
      }
      let off = false;
      if (options.noDelta && hint.path) {
        const known = noDelta.get(hint.path);
        off = known ?? (await options.noDelta(hint.path));
        if (known === undefined) noDelta.set(hint.path, off);
      }
      refs.push({ id, type: hint.type, path: hint.path, ...(off ? { noDelta: true } : {}) });
    }
    return refs;
  };

  const install = async (listed: PackObjectRef[]) =>
    packs.install(
      writePack(objects, listed, {
        packs,
        reuseObjects: options.reuseObjects ?? true,
        reuseDeltas: options.reuseDeltas ?? true,
        deltaSearch: packDeltaSearch(settings, options.deltaSearch),
        ...(options.bigFileThreshold !== undefined
          ? { bigFileThreshold: options.bigFileThreshold }
          : {}),
        ...(settings.compression !== undefined ? { compression: settings.compression } : {}),
      }),
      { writeReverseIndex: settings.writeReverseIndex },
    );

  // pack_geometry_repack_promisors (2.5x): the promisor packs below their split, `^` those above,
  // into a new promisor pack with an empty `.promisor` file (no loose objects, no --keep-pack)
  const promisorExcluded = promisorAbove.map((g) => g.pack);
  const promisorListed =
    promisorSplit > 0
      ? await list(
          promisorRolled,
          [
            ...promisorExcluded,
            ...(packKeptObjects ? [] : info.filter((i) => i.keep && !i.keptInCore)).map(
              (i) => i.pack,
            ),
          ],
          promisorExcluded,
          false,
        )
      : [];
  // the main run: the rolled-up packs, `^` the packs above the split, then the loose objects
  const listed = await list(
    rolled,
    [...above.map((g) => g.pack), ...keptOut.map((i) => i.pack)],
    [
      ...above.filter((g) => !openAbove.includes(g)).map((g) => g.pack),
      ...info.filter((i) => i.keptInCore).map((i) => i.pack),
    ],
    true,
    follow ? openAbove : undefined,
  );

  const keptPacks = info.filter((i) => i.keep).map((i) => packNameOf(i.pack));
  const removable = deleteRedundant
    ? [...rolled, ...promisorRolled].filter((g) => !g.keep).map((g) => packNameOf(g.pack))
    : [];
  if (options.dryRun) {
    if (listed.length === 0 && promisorListed.length === 0) {
      for (const w of warnings) options.onWarning?.(w);
      return null;
    }
    return {
      packName: "",
      objectCount: listed.length,
      looseObjectsRemoved: 0,
      packsRemoved: removable,
      keptPacks,
      unpackedObjects: 0,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  let promisorInstalled: { packId: string; count: number } | undefined;
  if (promisorListed.length > 0) {
    promisorInstalled = await install(promisorListed);
    if (packs.writePromisor) await packs.writePromisor(promisorInstalled.packId, "");
    else await files.write(joinPath(packDir, `pack-${promisorInstalled.packId}.promisor`), []);
  }
  let installed: { packId: string; count: number } | undefined;
  if (listed.length > 0) installed = await install(listed);
  if (installed || promisorInstalled) await packs.refresh();
  const newIds = new Set([installed?.packId, promisorInstalled?.packId].filter(Boolean));

  // --write-midx: kept packs, the new ones, the (non-promisor) packs above the split, cruft packs
  let midxWritten: string | undefined;
  if (options.writeMidx) {
    // midx_included_packs: kept packs, the new ones, the packs above the split, then the cruft
    // packs when the midx must contain them or the old midx names a pack this one would lose
    const include = new Set<string>();
    for (const i of info) if (i.keep) include.add(`${packNameOf(i.pack)}.idx`);
    for (const id of newIds) include.add(`pack-${id}.idx`);
    for (const g of above) include.add(`${packNameOf(g.pack)}.idx`);
    // nothing written and no midx before: non-cruft packs may refer to once-cruft objects
    if (newIds.size === 0 && !existingMidx) midxMustContainCruft = true;
    const rolledNames = new Set(rolled.map((g) => packNameOf(g.pack)));
    const unknownPacks = [...midxPacks].some(
      (n) => !include.has(`${n}.idx`) && !rolledNames.has(n),
    );
    if (midxMustContainCruft || unknownPacks)
      for (const i of info) if (i.cruft && !i.keep) include.add(`${packNameOf(i.pack)}.idx`);
    const preferred = above.length
      ? packNameOf((above[above.length - 1] as (typeof above)[number]).pack)
      : installed && `pack-${installed.packId}`;
    if (include.size > 0) {
      const midx = await multiPackIndexWrite({
        files,
        gitDir,
        compatibility: options.compatibility ?? "2.56",
        ...(options.environment ? { environment: options.environment } : {}),
        stdinPacks: [...include].sort(),
        ...(preferred ? { preferredPack: `${preferred}.pack` } : {}),
        bitmap: writeBitmaps,
        ...(options.writeMidxBitmap ? { writeBitmap: options.writeMidxBitmap } : {}),
      });
      if (midx.exitCode !== 0) throw new Error(midx.stderr.join("\n"));
      midxWritten = midx.written;
    }
  }

  // -d: the rolled-up packs go (pack_geometry_remove_redundant), then the loose objects packed
  const packsRemoved: string[] = [];
  let looseObjectsRemoved = 0;
  if (deleteRedundant) {
    const gone = [...rolled, ...promisorRolled].filter(
      (g) => !newIds.has(g.pack.packId) && !g.keep,
    );
    const names = gone.map((g) => packNameOf(g.pack));
    if (names.length) {
      await clearMultiPackIndexNaming(
        files,
        packDir,
        names.map((n) => `${n}.pack`),
        { wroteIncremental: false, objectFormat: format },
      );
      await packs.remove(gone.map((g) => g.pack));
      packsRemoved.push(...names);
    }
    looseObjectsRemoved = await prunePacked(looseStorage, packs, format, alternates);
  }

  const main = installed ?? promisorInstalled;
  if (!main) {
    for (const w of warnings) options.onWarning?.(w);
    return null;
  }
  return {
    packName: `pack-${main.packId}`,
    objectCount: main.count,
    looseObjectsRemoved,
    packsRemoved,
    keptPacks,
    unpackedObjects: 0,
    bitmapWritten: false,
    ...(midxWritten ? { midx: midxWritten } : {}),
    ...(installed && promisorInstalled
      ? {
          promisorPack: {
            packName: `pack-${promisorInstalled.packId}`,
            objectCount: promisorInstalled.count,
          },
        }
      : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}
