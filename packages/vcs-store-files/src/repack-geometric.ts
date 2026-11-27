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
 */

import type { ObjectId, ObjectTypeString, Pack, PackObjectRef } from "@statewalker/vcs-core";
import {
  clearMultiPackIndexNaming,
  joinPath,
  listObjects,
  objectFormatOf,
  packNameOf,
  writePack,
} from "@statewalker/vcs-core";
import { multiPackIndexWrite } from "./multi-pack-index.js";
import { keepPackNames, objectIdPattern } from "./object-names.js";
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
 * (`show_object_pack_hint`). Missing links end it early (`ignore_missing_links`, best effort).
 */
async function stdinPacksHints(
  objects: Parameters<typeof listObjects>[0],
  tips: readonly ObjectId[],
  excluded: readonly Pack[],
  ids: ReadonlySet<ObjectId>,
): Promise<Map<ObjectId, { type: ObjectTypeString; path: string }>> {
  const hints = new Map<ObjectId, { type: ObjectTypeString; path: string }>();
  if (tips.length === 0) return hints;
  const exclude = new Set<ObjectId>();
  for (const p of excluded) for (const id of p.ids()) exclude.add(id);
  try {
    for await (const o of listObjects(objects, { wants: tips, excludeObjects: exclude })) {
      if (o.path === undefined || !ids.has(o.id) || hints.has(o.id)) continue;
      hints.set(o.id, { type: o.type, path: o.path });
    }
  } catch {
    // a best-effort walk: the hints found so far stay
  }
  return hints;
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
  // the type from the entry header, else from the object (its content left unread)
  const typeOf = async (id: ObjectId): Promise<ObjectTypeString | undefined> => {
    const known = (await objects.header?.(id))?.type ?? (await objects.objectType?.(id));
    if (known) return known;
    const o = await objects.get(id);
    if (o && !o.bytes) await o.content[Symbol.asyncIterator]().return?.();
    return o?.type;
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
  ): Promise<PackObjectRef[]> => {
    const ids: ObjectId[] = [];
    const seen = new Set<ObjectId>();
    const tips: ObjectId[] = [];
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
    const byMtime = [...include].sort((a, b) => b.mtime - a.mtime);
    for (const g of byMtime) for (const id of g.pack.ids()) await add(id, false);
    if (unpacked)
      for await (const key of looseStorage.keys()) if (idPattern.test(key)) await add(key, true);
    const hints = await stdinPacksHints(objects, tips, walkExcluded, hinted);
    const noDelta = new Map<string, boolean>();
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
    [...above.map((g) => g.pack), ...info.filter((i) => i.keptInCore).map((i) => i.pack)],
    true,
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
    const include = new Set<string>();
    for (const i of info) if (i.keep || i.cruft) include.add(`${packNameOf(i.pack)}.idx`);
    for (const id of newIds) include.add(`pack-${id}.idx`);
    for (const g of above) include.add(`${packNameOf(g.pack)}.idx`);
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
