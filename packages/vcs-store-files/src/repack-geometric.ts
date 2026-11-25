/**
 * `git repack --geometric=<factor>` (builtin/repack.c with repack-geometry.c): the packs that
 * are neither kept nor cruft, sorted by object count, are split where the larger ones already
 * form a geometric progression (each at least `factor` times the one before); the packs below
 * the split and every loose object are rolled up into one new pack (`pack-objects --stdin-packs
 * --unpacked`), leaving out what the packs above the split hold. With `-d` the rolled-up packs
 * are removed, and with `--write-midx` a multi-pack-index over the packs that stay is written,
 * the largest one above the split preferred.
 */

import type { ObjectId, Pack, PackObjectRef } from "@statewalker/vcs-core";
import {
  clearMultiPackIndexNaming,
  joinPath,
  objectFormatOf,
  packNameOf,
  writePack,
} from "@statewalker/vcs-core";
import { multiPackIndexWrite } from "./multi-pack-index.js";
import { objectIdPattern } from "./object-names.js";
import { packDeltaSearch, readPackWriteSettings } from "./pack/pack-write-settings.js";
import {
  IncrementalBitmapError,
  prunePacked,
  type RepackOptions,
  type RepackResult,
  readBitmapSettings,
} from "./repack.js";

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

/**
 * Repack geometrically (see the module comment). Returns null when nothing was written
 * (git's "Nothing new to pack."), then only the midx may have been written.
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

  const bitmapSettings = await readBitmapSettings(files, gitDir, {
    ...(options.environment ? { environment: options.environment } : {}),
  });
  const writeBitmaps = options.writeBitmaps ?? bitmapSettings.writeBitmaps ?? false;
  // an incremental repack has no pack bitmap (git dies), a midx can have one
  if (writeBitmaps && !options.writeMidx) throw new IncrementalBitmapError();
  const packKeptObjects = options.packKeptObjects ?? bitmapSettings.packKeptObjects ?? false;

  await packs.refresh();
  const all = await packs.packs();
  const inCore = new Set(
    (options.keepPacks ?? []).map((n) => n.replace(/^pack-/, "").replace(/\.pack$/, "")),
  );
  const info = await Promise.all(
    all.map(async (p) => {
      const base = joinPath(packDir, packNameOf(p));
      return {
        pack: p,
        keep: (await files.exists(`${base}.keep`)) || inCore.has(p.packId),
        cruft: await files.exists(`${base}.mtimes`),
        promisor: await files.exists(`${base}.promisor`),
        mtime: (await files.stats(`${base}.pack`))?.lastModified ?? 0,
      };
    }),
  );
  // repo_for_each_pack's order (newest first), then the object counts, ascending
  info.sort((a, b) => b.mtime - a.mtime);
  // pack_geometry_init: kept packs only with --pack-kept-objects, never cruft packs; promisor
  // packs are left alone (2.5x rolls them up apart, which ours does not yet)
  const geometry = info
    .filter((i) => (packKeptObjects || !i.keep) && !i.cruft && !i.promisor)
    .map((i, at) => ({ ...i, at }))
    .sort((a, b) => a.pack.count - b.pack.count || a.at - b.at);
  const split = geometricSplit(
    geometry.map((g) => g.pack.count),
    factor,
  );
  const rolled = geometry.slice(0, split);
  const above = geometry.slice(split);
  const keptOnDisk = info.filter((i) => i.keep && !packKeptObjects).map((i) => i.pack);
  const excluded: Pack[] = [...above.map((g) => g.pack), ...keptOnDisk];
  const alternates = (await objects.alternates?.list()) ?? [];

  // --stdin-packs: the rolled-up packs' objects (newest pack first, pack order), then every
  // loose object (--unpacked), each once, none an excluded pack holds (or, with -l, an alternate)
  const listed: PackObjectRef[] = [];
  const seen = new Set<ObjectId>();
  const add = async (id: ObjectId) => {
    if (seen.has(id)) return;
    seen.add(id);
    if (excluded.some((p) => p.has(id))) return;
    if (options.local) for (const alt of alternates) if (await alt.objects.has(id)) return;
    listed.push(id);
  };
  const byMtime = [...rolled].sort((a, b) => b.mtime - a.mtime);
  for (const g of byMtime) for (const id of g.pack.ids()) await add(id);
  const idPattern = objectIdPattern(format);
  for await (const key of looseStorage.keys()) if (idPattern.test(key)) await add(key);

  const keptPacks = info.filter((i) => i.keep).map((i) => packNameOf(i.pack));
  if (options.dryRun) {
    return listed.length === 0
      ? null
      : {
          packName: "",
          objectCount: listed.length,
          looseObjectsRemoved: 0,
          packsRemoved: deleteRedundant ? rolled.map((g) => packNameOf(g.pack)) : [],
          keptPacks,
          unpackedObjects: 0,
        };
  }

  let installed: { packId: string; count: number } | undefined;
  if (listed.length > 0) {
    const settings =
      options.packSettings ??
      (await readPackWriteSettings(files, gitDir, {
        ...(options.environment ? { environment: options.environment } : {}),
      }));
    installed = await packs.install(
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
    await packs.refresh();
  }

  // --write-midx: kept packs, the new one, the packs above the split, cruft packs
  let midxWritten: string | undefined;
  if (options.writeMidx) {
    const include = new Set<string>();
    for (const i of info) if (i.keep || i.cruft) include.add(`${packNameOf(i.pack)}.idx`);
    if (installed) include.add(`pack-${installed.packId}.idx`);
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
    const removable = rolled.filter((g) => g.pack.packId !== installed?.packId && !g.keep);
    const names = removable.map((g) => packNameOf(g.pack));
    if (names.length) {
      await clearMultiPackIndexNaming(
        files,
        packDir,
        names.map((n) => `${n}.pack`),
        { wroteIncremental: false, objectFormat: format },
      );
      await packs.remove(removable.map((g) => g.pack));
      packsRemoved.push(...names);
    }
    looseObjectsRemoved = await prunePacked(looseStorage, packs, format, alternates);
  }

  if (!installed) return null;
  return {
    packName: `pack-${installed.packId}`,
    objectCount: installed.count,
    looseObjectsRemoved,
    packsRemoved,
    keptPacks,
    unpackedObjects: 0,
    bitmapWritten: false,
    ...(midxWritten ? { midx: midxWritten } : {}),
  };
}
