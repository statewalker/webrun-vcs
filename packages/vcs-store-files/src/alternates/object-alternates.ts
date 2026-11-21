/**
 * git's alternate object directories (odb.c: `odb_prepare_alternates`,
 * `odb_add_alternate_recursively`, `odb_is_source_usable`, `odb_for_each_alternate_ref`;
 * object-file.c's `link_alt_odb_entries` in 2.43) for the files backend: the directories a
 * repository borrows objects from, read through the repository's FilesApi.
 *
 * @example
 * ```typescript
 * const alternates = await openObjectAlternates({ files, gitDir: ".git", objectsDir: ".git/objects" });
 * const objects = withAlternates(withPacks(loose, packs), alternates);
 * await objects.get(id); // the repository's copy, else the first alternate's
 * ```
 *
 * The entries of `$GIT_ALTERNATE_OBJECT_DIRECTORIES` (`environment.alternateObjectDirectories`,
 * `:`-separated, relative ones from the worktree top where git runs) come first, then those of
 * `objects/info/alternates` (relative to the objects directory); each is followed by its own
 * `objects/info/alternates` in turn, at most five levels below the first ("nesting too deep").
 * An entry naming the repository's own objects directory, or one already linked, is skipped;
 * one that is no directory is skipped with git's "object directory ... does not exist" error.
 *
 * Paths are those of the FilesApi: an absolute entry is a host path, read where it lies inside
 * the FilesApi's `rootDirectory` (where the storage has none, such as memory, it is taken as a
 * path of the FilesApi itself); one outside it cannot be read and is skipped with an error.
 * Symbolic links on the way are followed through `lstat`/`readlink` where the FilesApi has
 * them (an absolute target inside the root too), as git's `strbuf_realpath`.
 */

import {
  type AlternateObjectDirectory,
  createGitObjects,
  type FilesApi,
  type GitObject,
  type GitObjects,
  graftFileBaseDir,
  joinPath,
  type ObjectAlternates,
  openPackSet,
  type PackSet,
} from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils/encoding";
import { atomicFilesOver } from "@statewalker/vcs-utils/files";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";
import { skipPacked, withPacks } from "../pack/index.js";
import { createFileRefStore } from "../refs/index.js";
import { filesStagingStore } from "../storage/loose/files-staging-store.js";
import { HostPaths, hostRootOf } from "../workspace/git-dir/index.js";
import {
  alternateRealPath,
  isAbsolute,
  normalizeAlternatePath as normalize,
  readAllBytes,
} from "./alternate-paths.js";
import { parseAlternates } from "./parse-alternates.js";

/** git's limit on nested alternates (`depth + 1 > 5`). */
export const MAX_ALTERNATE_DEPTH = 5;
const OID = /^[0-9a-f]{40}$/;

/** Options of {@link openObjectAlternates}. */
export interface ObjectAlternatesOptions {
  /** The repository's FilesApi */
  files: FilesApi;
  /** The repository's git directory in `files` */
  gitDir: string;
  /** Its objects directory in `files` (default `<gitDir>/objects`) */
  objectsDir?: string;
  /**
   * The host environment: `alternateObjectDirectories` (`$GIT_ALTERNATE_OBJECT_DIRECTORIES`)
   * is read unless `honorEnvironment` is false
   */
  environment?: GitHostEnvironment;
  /**
   * Read `$GIT_ALTERNATE_OBJECT_DIRECTORIES` (default true). False for a repository opened as
   * another process git would start with `local_repo_env` cleared (a local remote, a served
   * repository): the variable is not theirs
   */
  honorEnvironment?: boolean;
  /**
   * Where git runs, in `files`: relative `$GIT_ALTERNATE_OBJECT_DIRECTORIES` entries name
   * directories from there (git resolves them against its current directory, which its setup
   * changed to the worktree top, or to the git directory of a bare repository). Default: the
   * git directory when bare (`core.bare`, or a git directory not named `.git` without it),
   * else `core.worktree` when set, else the directory holding `.git`, else (a separate git
   * directory) the FilesApi's root, taken as the worktree top.
   */
  workTree?: string;
  /** Passed to each alternate's packs and loose store (git's freshen window) */
  freshenMaxAgeMs?: number;
  /** The repository's configuration (`core.alternateRefsCommand`, `core.alternateRefsPrefixes`) */
  readConfig?: () => Promise<{ get(key: string): unknown }>;
  /** Each of git's error lines (`error: ...`) while the alternates are read */
  onError?: (line: string) => void;
}

/**
 * The start of the error line for an absolute alternate outside the FilesApi's root: git reads
 * it, this store cannot (gc, repack and prune refuse while one is listed).
 */
export const OUTSIDE_STORAGE_ERROR =
  "error: unable to read alternate object directory outside the storage: ";

/** One alternate as the files backend reads it. */
interface Source extends AlternateObjectDirectory {
  /** git's freshen of a copy here (check_and_freshen_nonlocal): false when absent or old and fixed */
  freshen(id: string): Promise<boolean>;
}

/** The alternates of a files repository: {@link ObjectAlternates} plus what the store needs. */
export interface FilesObjectAlternates extends ObjectAlternates {
  /** The alternates read so far (none until the first read is done) */
  current(): readonly AlternateObjectDirectory[];
  /** Whether some alternate holds `id` and renewed its copy (a write of it may be skipped) */
  freshen(id: string): Promise<boolean>;
  /** Whether some alternate holds `id`, loose or packed (`pack-objects --local` leaves it out) */
  has(id: string): Promise<boolean>;
  /** Whether a pack of some alternate holds `id` (`prune-packed` removes a loose copy then) */
  packed(id: string): Promise<boolean>;
  /** The first alternate's copy of `id` */
  get(id: string, options?: { verify?: boolean }): Promise<GitObject | undefined>;
  /** Calls `listener` once, when the first alternate is linked (by `add()` or `refresh()`) */
  whenLinked(listener: () => void): void;
}

/**
 * Reads the alternates of the repository at `options.gitDir` (see the module notes). The
 * result is read once here; `refresh()` reads them again and `add()` links one more.
 */
export async function openObjectAlternates(
  options: ObjectAlternatesOptions,
): Promise<FilesObjectAlternates> {
  const { files, gitDir } = options;
  const objectsDir = normalize(options.objectsDir ?? joinPath(gitDir, "objects")) ?? "/objects";
  const host = new HostPaths(hostRootOf(files));
  let sources: Source[] = [];
  let errors: string[] = [];
  const report = (line: string) => {
    errors.push(line);
    options.onError?.(line);
  };
  /** The host path git prints for a path of the FilesApi. */
  const display = (path: string) => (host.known ? host.hostPath(path) : path);

  /**
   * An entry as a real path of the FilesApi: `base` (a real path) for a relative one;
   * undefined, with git's error, when it cannot be normalized or lies beyond the storage.
   */
  const resolve = async (entry: string, base: string): Promise<string | undefined> => {
    let path: string;
    if (isAbsolute(entry)) {
      if (host.known && !host.inside(entry)) {
        report(`${OUTSIDE_STORAGE_ERROR}${entry}`);
        return undefined;
      }
      path = host.known ? host.filesPath(entry) : entry;
    } else {
      path = `${base}/${entry}`;
    }
    const real = await alternateRealPath(files, path, host);
    if (real === undefined) {
      report(`error: unable to normalize alternate object path: ${display(path)}`);
      return undefined;
    }
    return real;
  };

  /** The entries of `objects/info/alternates` below `dir` (a real path), resolved. */
  const readFileEntries = async (dir: string): Promise<string[]> => {
    const file = `${dir === "/" ? "" : dir}/info/alternates`;
    let bytes: Uint8Array | undefined;
    try {
      if ((await files.stats(file))?.kind !== "file") return [];
      bytes = await readAllBytes(files, file);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of parseAlternates(bytes, "\n")) {
      const real = await resolve(entry, dir);
      if (real !== undefined) out.push(real);
    }
    return out;
  };

  const openSource = async (dir: string): Promise<Source> => {
    const { freshenMaxAgeMs } = options;
    const staging = filesStagingStore(files, dir, { freshenMaxAgeMs });
    const looseOnly = createGitObjects(staging);
    const packs: PackSet = await openPackSet(files, joinPath(dir, "pack"), {
      externalBase: (id) => looseOnly.get(id),
      freshenMaxAgeMs,
    });
    const objects = withPacks(createGitObjects(skipPacked(staging, packs)), packs);
    return {
      path: display(dir),
      objectsDir: dir,
      objects,
      packs,
      freshen: async (id) => (await packs.freshen(id)) || (await staging.isFresh(id)),
    };
  };

  /** git's odb_add_alternate_recursively: `dir` and, below it, its own alternates. */
  const link = async (into: Source[], seen: Set<string>, dir: string, depth: number) => {
    // odb_is_source_usable: a directory, not the objects directory itself, not linked twice
    if ((await files.stats(dir).catch(() => undefined))?.kind !== "directory") {
      report(
        `error: object directory ${display(dir)} does not exist; check .git/objects/info/alternates`,
      );
      return;
    }
    if (seen.has(dir)) return;
    seen.add(dir);
    into.push(await openSource(dir));
    const nested = await readFileEntries(dir);
    if (nested.length > 0 && depth + 1 > MAX_ALTERNATE_DEPTH) {
      report(`error: ${display(dir)}: ignoring alternate object stores, nesting too deep`);
      return;
    }
    for (const entry of nested) await link(into, seen, entry, depth + 1);
  };

  /** The objects directory's real path: what `link` skips. */
  const ownDir = async () => (await alternateRealPath(files, objectsDir, host)) ?? objectsDir;
  /** The directories `link` skips: the own one and each linked alternate (read on demand). */
  let seenDirs: Set<string> | undefined;
  const seen = async () => {
    seenDirs ??= new Set([await ownDir()]);
    return seenDirs;
  };
  let listeners: (() => void)[] = [];
  const linked = () => {
    if (sources.length === 0 || listeners.length === 0) return;
    const pending = listeners;
    listeners = [];
    for (const listener of pending) listener();
  };

  /** Where git runs (relative environment entries are read from there), as a real path. */
  const workTreeDir = async (): Promise<string> => {
    let dir = options.workTree;
    if (dir === undefined) {
      const config = await options.readConfig?.().catch(() => undefined);
      const bareValue = config?.get("core.bare");
      const bare =
        typeof bareValue === "boolean"
          ? bareValue
          : typeof bareValue === "string"
            ? parseGitBool(bareValue)
            : undefined;
      const worktree = config?.get("core.worktree");
      const name = gitDir.replace(/\/+$/, "").split("/").pop();
      if (gitDir === "." || bare === true || (bare === undefined && name !== ".git")) {
        dir = gitDir;
      } else if (typeof worktree === "string" && worktree !== "") {
        dir = isAbsolute(worktree)
          ? host.known && host.inside(worktree)
            ? host.filesPath(worktree)
            : worktree
          : `${gitDir}/${worktree}`;
      } else if (name === ".git") {
        dir = graftFileBaseDir(gitDir, false);
      } else {
        dir = "/";
      }
    }
    const cwd = normalize(dir || "/") ?? "/";
    return (await alternateRealPath(files, cwd, host)) ?? cwd;
  };

  const load = async () => {
    errors = [];
    const env =
      options.honorEnvironment === false
        ? undefined
        : options.environment?.alternateObjectDirectories;
    // nothing to read: no realpath, no config (the repositories that borrow nothing)
    const file = `${objectsDir}/info/alternates`;
    if (!env && (await files.stats(file).catch(() => undefined))?.kind !== "file") {
      sources = [];
      seenDirs = undefined;
      return;
    }
    const own = await ownDir();
    const skip = new Set<string>([own]);
    const top: string[] = [];
    if (env) {
      const realCwd = await workTreeDir();
      for (const entry of parseAlternates(env, ":")) {
        const real = await resolve(entry, realCwd);
        if (real !== undefined) top.push(real);
      }
    }
    top.push(...(await readFileEntries(own)));
    const into: Source[] = [];
    for (const dir of top) await link(into, skip, dir, 0);
    sources = into;
    seenDirs = skip;
    linked();
  };
  await load();

  const firstGet = async (id: string, opts?: { verify?: boolean }) => {
    for (const s of sources) {
      const obj = await s.objects.get(id, opts);
      if (obj) return obj;
    }
    return undefined;
  };

  return {
    get errors() {
      return errors;
    },
    current: () => sources,
    list: async () => sources,
    refresh: load,
    async add(path) {
      // odb_source_files_write_alternate: under `alternates.lock` (taken before the file is
      // read, as hold_lock_file_for_update), the line appended unless there, then renamed
      // over the file; the lock is dropped when nothing changes
      const info = atomicFilesOver(files, `${objectsDir}/info`);
      if (!(await info.createExclusive("alternates.lock", new Uint8Array()))) {
        throw new Error(
          `Unable to create '${display(`${objectsDir}/info/alternates.lock`)}': File exists.`,
        );
      }
      try {
        const file = `${objectsDir}/info/alternates`;
        const existing =
          (await files.stats(file))?.kind === "file"
            ? await readAllBytes(files, file)
            : new Uint8Array();
        const text = new TextDecoder().decode(existing);
        const lines = text.split("\n");
        if (lines[lines.length - 1] === "") lines.pop();
        if (lines.includes(path)) {
          await info.remove("alternates.lock");
        } else {
          const body = `${lines.map((l) => `${l}\n`).join("")}${path}\n`;
          await info.write("alternates.lock", new TextEncoder().encode(body));
          await info.replace("alternates.lock", "alternates");
        }
      } catch (error) {
        await info.remove("alternates.lock").catch(() => false);
        throw error;
      }
      const real = await resolve(path, await ownDir());
      if (real !== undefined) await link(sources, await seen(), real, 0);
      linked();
    },
    whenLinked(listener) {
      if (sources.length > 0) listener();
      else listeners.push(listener);
    },
    async refs() {
      if (sources.length === 0) return [];
      const config = await options.readConfig?.().catch(() => undefined);
      // a command of the user's (run through the shell) is not run here: no alternate refs
      if (config?.get("core.alternateRefsCommand") !== undefined) return [];
      const prefixes = config?.get("core.alternateRefsPrefixes");
      const patterns =
        typeof prefixes === "string" ? prefixes.split(/\s+/).filter((p) => p !== "") : [];
      const ids: string[] = [];
      for (const s of sources) {
        // refs_from_alternate_cb: a repository's `objects` directory, with a `refs` directory
        if (!s.objectsDir.endsWith("/objects")) continue;
        const repo = s.objectsDir.slice(0, -"/objects".length) || "/";
        if (
          (await files.stats(joinPath(repo, "refs")).catch(() => undefined))?.kind !== "directory"
        )
          continue;
        const store = createFileRefStore(files, repo);
        const names: string[] = [];
        try {
          for await (const ref of store.list("refs/")) names.push(ref.name);
        } catch {
          continue;
        }
        names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        for (const name of names) {
          if (patterns.length > 0 && !patterns.some((p) => refMatches(name, p))) continue;
          const id = (await store.resolve(name).catch(() => undefined))?.objectId;
          // for-each-ref there leaves out a ref whose object the alternate lacks
          if (id && OID.test(id) && (await s.objects.has(id))) ids.push(id);
        }
      }
      return ids;
    },
    async freshen(id) {
      for (const s of sources) if (await s.freshen(id)) return true;
      return false;
    },
    async has(id) {
      for (const s of sources) if (await s.objects.has(id)) return true;
      return false;
    },
    async packed(id) {
      for (const s of sources) if (await s.packs.has(id)) return true;
      return false;
    },
    get: firstGet,
  };
}

/**
 * `local`, then the alternates' objects: reads fall through to the first alternate holding
 * an object, listings include theirs (each id once), and the approximate count adds their
 * packs (git counts every source's packs). Writes and removals go to `local` only: build it
 * over `skipPacked(..., alternates)` so a write of an object an alternate holds is skipped, as
 * git's `odb_freshen_object` skips it.
 */
export function withAlternates(local: GitObjects, alternates: FilesObjectAlternates): GitObjects {
  if (alternates.current().length > 0) return wrapWithAlternates(local, alternates);
  // none yet: `local` itself, no layer on any read; wrapped in place once one is linked
  const base: GitObjects = { ...local };
  (local as { alternates?: ObjectAlternates }).alternates = alternates;
  alternates.whenLinked(() => {
    // only the reads: what was set on `local` since (beginQuarantine, ...) stays
    const wrapped = wrapWithAlternates(base, alternates);
    for (const key of WRAPPED_READS) {
      (local as unknown as Record<string, unknown>)[key] = wrapped[key];
    }
  });
  return local;
}

/** The methods {@link wrapWithAlternates} replaces. */
const WRAPPED_READS = [
  "get",
  "getNow",
  "getRaw",
  "has",
  "list",
  "listPrefix",
  "approximateCount",
] as const;

/** `local` with every read and listing falling through to the alternates. */
function wrapWithAlternates(local: GitObjects, alternates: FilesObjectAlternates): GitObjects {
  const fromAlternates = (id: string, options?: { verify?: boolean }) =>
    alternates.current().length === 0 ? undefined : alternates.get(id, options);
  const get = async (id: string, options?: { verify?: boolean }) =>
    (await local.get(id, options)) ?? (await fromAlternates(id, options));
  const objects: GitObjects = {
    ...local,
    alternates,
    get,
    getNow(id, options) {
      const found = local.getNow ? local.getNow(id, options) : local.get(id, options);
      if (found === undefined) return fromAlternates(id, options);
      if (found instanceof Promise) return found.then((o) => o ?? fromAlternates(id, options));
      return found;
    },
    async *getRaw(id) {
      if (alternates.current().length === 0) {
        yield* local.getRaw(id);
        return;
      }
      let any = false;
      for await (const chunk of local.getRaw(id)) {
        any = true;
        yield chunk;
      }
      if (any) return;
      for (const s of alternates.current()) {
        for await (const chunk of s.objects.getRaw(id)) {
          any = true;
          yield chunk;
        }
        if (any) return;
      }
    },
    async has(id) {
      return (await local.has(id)) || (await alternates.has(id));
    },
    async *list() {
      const sources = alternates.current();
      if (sources.length === 0) {
        yield* local.list();
        return;
      }
      const seen = new Set<string>();
      for await (const id of local.list()) {
        seen.add(id);
        yield id;
      }
      for (const s of sources) {
        for await (const id of s.objects.list()) {
          if (seen.has(id)) continue;
          seen.add(id);
          yield id;
        }
      }
    },
    async *listPrefix(prefix, options) {
      const seen = new Set<string>();
      const all = [local, ...alternates.current().map((s) => s.objects)];
      for (let i = 0; i < all.length; i++) {
        const store = all[i] as GitObjects;
        const ids = store.listPrefix
          ? store.listPrefix(
              prefix,
              options?.cache ? { cache: subCache(options.cache, i) } : undefined,
            )
          : store.list();
        for await (const id of ids) {
          if (!id.startsWith(prefix) || seen.has(id)) continue;
          seen.add(id);
          yield id;
        }
      }
    },
    async approximateCount() {
      let n = (await local.approximateCount?.()) ?? 0;
      for (const s of alternates.current()) {
        for (const p of await s.packs.packs()) n += p.count;
      }
      return n;
    },
  };
  return objects;
}

/** The listings cache of the `index`th store (each store keeps its own keys). */
function subCache(cache: Map<string, unknown>, index: number): Map<string, unknown> {
  if (index === 0) return cache;
  const key = `alternate:${index}`;
  let sub = cache.get(key) as Map<string, unknown> | undefined;
  if (!sub) {
    sub = new Map();
    cache.set(key, sub);
  }
  return sub;
}

/** for-each-ref's pattern match: literal up to a slash (or the whole name), else a wildmatch. */
function refMatches(name: string, pattern: string): boolean {
  if (/[*?[\\]/.test(pattern)) {
    const re = new RegExp(
      `^${pattern
        .replace(/[.+^${}()|\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
    );
    return re.test(name);
  }
  if (name === pattern) return true;
  const prefix = pattern.endsWith("/") ? pattern : `${pattern}/`;
  return name.startsWith(prefix);
}
