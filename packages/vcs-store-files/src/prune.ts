/**
 * `git prune` (builtin/prune.c) over a files repository, without the rest of gc: unreachable
 * loose objects older than the expiry go, keeping what a younger unreachable object (loose or
 * packed) reaches (`mark_reachable_objects` with `mark_recent`, as gc's prune step); loose
 * objects a pack holds go too (`prune_packed_objects`), stale `tmp_*` files of the object and
 * pack directories, and the shallow commits nothing reached (`prune_shallow`).
 */

import { assertObjectsAtGitDir } from "./relocated-objects.js";
import type { FilesApi, GitObjects, History, ObjectId, PackSet } from "@statewalker/vcs-core";
import {
  graftFileBaseDir,
  graftFileReader,
  joinPath,
  objectFormatOf,
  objectsWithoutLazyFetch,
} from "@statewalker/vcs-core";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";
import { objectLinks, recentPackedObjects, typeOfObject } from "./cruft-pack.js";
import { promisorExclusions } from "./promisor-objects.js";
import { listReachableObjects, rebaseFileRoots } from "./reachable-objects.js";
import { assertObjectsDeletable, readRepositoryFormat } from "./repository-format.js";

/** Options of {@link prune}. */
export interface PruneOptions {
  history: History;
  files: FilesApi;
  /** The (common) git directory, as a path of `files`. Default `.git`. */
  gitDir?: string;
  /** The objects (default `history.objects`) and packs (default `history.packs`). */
  objects?: GitObjects;
  packs?: PackSet;
  /**
   * git's `--expire` in seconds since the epoch: loose objects (and `tmp_*` files) modified at
   * or before it go. `Infinity` (git's TIME_MAX: no `--expire`, `now`, `all`) prunes every
   * unreachable one, `0` (`never`) none. Default `Infinity`.
   */
  expire?: number;
  /** `-n`: report, remove nothing. */
  dryRun?: boolean;
  /** `-v`: report what is removed (as `-n` does). */
  verbose?: boolean;
  /** `<head>...`: more roots, as ids. */
  heads?: readonly ObjectId[];
  /** How paths of the objects directory are printed (git's object directory). Default `<gitDir>/objects`. */
  objectsDisplay?: string;
  /** 2.43 keeps nothing the rebase files name (2.44's `add_rebase_files`). Default "2.56". */
  compatibility?: "2.43" | "2.56";
  environment?: GitHostEnvironment;
  /** The time the expiry is checked against for recent packs (ms). Default `Date.now()`. */
  now?: number;
}

/** What {@link prune} did. */
export interface PruneResult {
  /** The unreachable loose objects removed (or, with `dryRun`, that would be). */
  pruned: { id: ObjectId; type: string }[];
  /** Loose objects removed because a pack holds them (`prune-packed`). */
  prunedPacked: number;
  /** git's stdout (`-n`/`-v` lines), each with its newline. */
  output: string;
  /** git's stderr lines (`bad sha1 file: ...`), each with its newline. */
  errorOutput: string;
}

const FANOUT = /^[0-9a-f]{2}$/;

/**
 * Prune as `git prune [-n] [-v] [--expire <time>] [<head>...]` does.
 *
 * @throws UnsupportedRepositoryFormatError in a precious-objects repository (git dies)
 * @example
 * ```typescript
 * const { output } = await prune({ history, files, gitDir: ".git", dryRun: true });
 * ```
 */
export async function prune(options: PruneOptions): Promise<PruneResult> {
  const { history, files, gitDir = ".git" } = options;
  assertObjectsAtGitDir(gitDir, "prune", options.objects, history.objects, history.packs);
  const dryRun = options.dryRun ?? false;
  const show = dryRun || (options.verbose ?? false);
  const expire = options.expire ?? Number.POSITIVE_INFINITY;
  const objectsDir = joinPath(gitDir, "objects");
  const display = options.objectsDisplay ?? objectsDir;
  const stored = (options.objects ?? history.objects) as GitObjects | undefined;
  if (!stored) throw new Error("prune needs the object kernel: pass objects or a files backend");
  // the walks read no absent object of a partial clone (fetch_if_missing = 0)
  const objects = objectsWithoutLazyFetch(stored);
  const packs = options.packs ?? history.packs;
  const format = await readRepositoryFormat(files, gitDir);
  assertObjectsDeletable(format, "prune", { partialClone: "allow" });
  const hexLength = objectFormatOf(objects).hexLength;
  const out: string[] = [];
  const err: string[] = [];
  const seconds = (ms: number | undefined) =>
    ms === undefined ? undefined : Math.floor(ms / 1000);
  // st_mtime > expire: kept
  const young = (ms: number | undefined) => {
    const s = seconds(ms);
    return s === undefined || s > expire;
  };

  // the traversal, done once and only when needed (perform_reachability_traversal)
  let seen: Set<ObjectId> | undefined;
  const traverse = async (): Promise<Set<ObjectId>> => {
    if (seen) return seen;
    const exclusions = await promisorExclusions(objects, files, gitDir);
    const readGraftFile = graftFileReader(options.environment, {
      files,
      dir: graftFileBaseDir(gitDir),
    });
    const listed = await listReachableObjects({
      files,
      gitDir,
      refs: history.refs,
      objects,
      commitGraph: history.commitGraph,
      ...(readGraftFile ? { readGraftFile } : {}),
      extraRoots: [...(exclusions?.roots ?? []), ...(options.heads ?? [])],
      ...(exclusions ? { excludeObjects: exclusions.excluded } : {}),
      refParanoia: options.environment?.refParanoia !== false,
      onRefError: (line) => err.push(`${line}\n`),
    });
    const kept = new Set<ObjectId>(listed.map((o) => o.id));
    for (const id of exclusions?.excluded ?? []) kept.add(id);
    const pending: ObjectId[] = [];
    const walk = async () => {
      while (pending.length > 0) {
        const id = pending.pop() as ObjectId;
        if (kept.has(id)) continue;
        kept.add(id);
        for (const link of await objectLinks(objects, id)) if (!kept.has(link)) pending.push(link);
      }
    };
    // 2.5x's add_rebase_files
    if ((options.compatibility ?? "2.56") !== "2.43") {
      for (const id of await rebaseFileRoots(files, gitDir, objectFormatOf(objects)))
        if (await objects.has(id)) pending.push(id);
      await walk();
    }
    // mark_recent: the unreachable objects younger than the expiry are roots too
    // (add_unseen_recent_objects_to_traversal), loose and packed; none for TIME_MAX or never
    if (expire !== 0 && Number.isFinite(expire)) {
      for (const { id, modified } of await looseObjects(files, objectsDir, hexLength))
        if (!kept.has(id) && modified !== undefined && young(modified)) pending.push(id);
      if (packs)
        for (const id of await recentPackedObjects(
          files,
          objectsDir,
          packs,
          expire * 1000,
          kept,
          objectFormatOf(objects),
        ))
          pending.push(id);
      await walk();
    }
    seen = kept;
    return kept;
  };

  // for_each_loose_file_in_source: prune_object, prune_cruft, prune_subdir
  const pruned: { id: ObjectId; type: string }[] = [];
  for (const dir of await fanoutDirectories(files, objectsDir)) {
    const dirPath = joinPath(objectsDir, dir);
    const names = await sortedNames(files, dirPath);
    for (const name of names) {
      const path = joinPath(dirPath, name);
      const shown = `${display}/${dir}/${name}`;
      if (name.length === hexLength - 2 && /^[0-9a-fA-F]+$/.test(name)) {
        const id = `${dir}${name}`.toLowerCase();
        if ((await traverse()).has(id)) continue;
        const stats = await files.stats(path);
        if (!stats) {
          err.push(`error: Could not stat '${shown}'\n`);
          continue;
        }
        if (young(stats.lastModified)) continue;
        const type = (await typeOfObject(objects, id)) ?? "unknown";
        if (show) out.push(`${id} ${type}\n`);
        pruned.push({ id, type });
        if (!dryRun) await files.remove(path);
      } else if (name.startsWith("tmp_obj_")) {
        await pruneTmpFile(files, path, shown, { young, show, dryRun, out });
      } else {
        err.push(`bad sha1 file: ${shown}\n`);
      }
    }
    if (!dryRun) await removeIfEmpty(files, dirPath);
  }

  // prune_packed_objects: loose objects a pack holds (any source's)
  const alternates = (await objects.alternates?.list()) ?? [];
  const packed = async (id: ObjectId) => {
    if (packs && (await packs.has(id))) return true;
    for (const alt of alternates) if (await alt.packs.has(id)) return true;
    return false;
  };
  let prunedPacked = 0;
  for (const dir of await fanoutDirectories(files, objectsDir)) {
    const dirPath = joinPath(objectsDir, dir);
    for (const name of await sortedNames(files, dirPath)) {
      if (name.length !== hexLength - 2 || !/^[0-9a-fA-F]+$/.test(name)) continue;
      if (!(await packed(`${dir}${name}`.toLowerCase()))) continue;
      prunedPacked++;
      if (dryRun) out.push(`rm -f ${display}/${dir}/${name}\n`);
      else await files.remove(joinPath(dirPath, name));
    }
    if (!dryRun) await removeIfEmpty(files, dirPath);
  }

  // remove_temporary_files of the object directory, then of the pack directory
  for (const [dir, shown] of [
    [objectsDir, display],
    [joinPath(objectsDir, "pack"), `${display}/pack`],
  ] as const) {
    if ((await files.stats(dir))?.kind !== "directory") continue;
    for (const name of await sortedNames(files, dir))
      if (name.startsWith("tmp_"))
        await pruneTmpFile(files, joinPath(dir, name), `${shown}/${name}`, {
          young,
          show,
          dryRun,
          out,
        });
  }

  // prune_shallow: the shallow commits the traversal did not reach
  const shallow = (await history.refs.getShallow?.().catch(() => [])) ?? [];
  if (shallow.length > 0) {
    const reached = await traverse();
    const stay = shallow.filter((id) => reached.has(id));
    if (dryRun) {
      for (const id of shallow)
        if (!reached.has(id)) out.push(`Removing ${id} from .git/shallow\n`);
    } else if (stay.length < shallow.length && history.refs.setShallow) {
      await history.refs.setShallow(stay, shallow);
    }
  }

  return { pruned, prunedPacked, output: out.join(""), errorOutput: err.join("") };
}

/** git's prune_tmp_file: a `tmp_*` file or directory not younger than the expiry. */
async function pruneTmpFile(
  files: FilesApi,
  path: string,
  shown: string,
  o: { young: (ms: number | undefined) => boolean; show: boolean; dryRun: boolean; out: string[] },
): Promise<void> {
  const stats = await files.stats(path);
  if (!stats || o.young(stats.lastModified)) return;
  const what = stats.kind === "directory" ? "directory" : "file";
  if (o.show) o.out.push(`Removing stale temporary ${what} ${shown}\n`);
  if (!o.dryRun) await files.remove(path);
}

/** The fan-out directories (`00`..`ff`) of the objects directory, in order. */
async function fanoutDirectories(files: FilesApi, objectsDir: string): Promise<string[]> {
  const dirs: string[] = [];
  if ((await files.stats(objectsDir))?.kind !== "directory") return dirs;
  for await (const e of files.list(objectsDir))
    if (e.kind === "directory" && FANOUT.test(e.name)) dirs.push(e.name);
  return dirs.sort();
}

async function sortedNames(files: FilesApi, dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const e of files.list(dir)) names.push(e.name);
  return names.sort();
}

/** rmdir: only an empty directory goes. */
async function removeIfEmpty(files: FilesApi, dir: string): Promise<void> {
  for await (const _ of files.list(dir)) return;
  await files.remove(dir);
}

/** The loose objects with their modification times (ms). */
async function looseObjects(
  files: FilesApi,
  objectsDir: string,
  hexLength: number,
): Promise<{ id: ObjectId; modified: number | undefined }[]> {
  const out: { id: ObjectId; modified: number | undefined }[] = [];
  for (const dir of await fanoutDirectories(files, objectsDir)) {
    for await (const e of files.list(joinPath(objectsDir, dir))) {
      if (e.kind !== "file" || e.name.length !== hexLength - 2 || !/^[0-9a-f]+$/.test(e.name))
        continue;
      out.push({ id: `${dir}${e.name}`, modified: (await files.stats(e.path))?.lastModified });
    }
  }
  return out;
}
