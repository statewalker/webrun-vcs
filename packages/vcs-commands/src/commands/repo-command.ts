/**
 * `git repo info` and `git repo structure` (builtin/repo.c, git 2.52+).
 *
 * ```typescript
 * const { stdout } = await git.repoInfo().addKeys("layout.bare", "object.format").callOutput();
 * // "layout.bare=false\nobject.format=sha1\n"
 * const table = await git.repoStructure().callOutput(); // the "Repository structure" table
 * ```
 *
 * Both write stdout as git does and return git's exit status ({@link PlumbingCommand}). The
 * keys of `repo info` depend on the git version ({@link RepoInfoCommand.setCompatibility}).
 */

import {
  decodeTreeBytes,
  type FilesApi,
  joinPath,
  type ObjectId,
  type ObjectTypeString,
  type Pack,
  packNameOf,
} from "@statewalker/vcs-core";
import { readRepositoryFormat } from "@statewalker/vcs-store-files";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import { quotePath } from "../results/quote-path.js";
import { hookHostOf } from "./git-hooks.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { PlumbingCommand, PlumbingError } from "./plumbing-command.js";
import { RevListCommand } from "./rev-list-command.js";

/**
 * The `repo info` key sets: "2.54" (2.54 and 2.55: `layout.*`, `object.format`,
 * `references.format`), "2.56" (2.56.x: also `path.commondir.*` and `path.gitdir.*`), "2.57"
 * (git master after 2.56: `objects.storageFormat`, the other `path.*` keys, and
 * `references.format` renamed `references.storageFormat`). `repo structure` is the same in all.
 */
export type RepoCompatibility = "2.54" | "2.56" | "2.57";

type OutputFormat = "table" | "lines" | "nul";

/** git's `parse_format_cb`: `nul`, `lines`, `table`, else `invalid format`. */
function parseFormat(format: string): OutputFormat {
  if (format === "nul" || format === "lines" || format === "table") return format;
  throw new PlumbingError(`fatal: invalid format '${format}'`);
}

/** path.c's relative_path (POSIX: `/` the only separator). */
export function gitRelativePath(input: string, prefix: string): string {
  const inLen = input.length;
  const prefixLen = prefix.length;
  if (!inLen) return "./";
  if (!prefixLen) return input;
  if (input.startsWith("/") !== prefix.startsWith("/")) return input;
  let i = 0;
  let j = 0;
  let inOff = 0;
  let prefixOff = 0;
  while (i < prefixLen && j < inLen && prefix[i] === input[j]) {
    if (prefix[i] === "/") {
      while (prefix[i] === "/") i++;
      while (input[j] === "/") j++;
      prefixOff = i;
      inOff = j;
    } else {
      i++;
      j++;
    }
  }
  if (i >= prefixLen && prefixOff < prefixLen) {
    if (j >= inLen) inOff = inLen;
    else if (input[j] === "/") {
      while (input[j] === "/") j++;
      inOff = j;
    } else i = prefixOff;
  } else if (j >= inLen && inOff < inLen) {
    if (prefix[i] === "/") {
      while (prefix[i] === "/") i++;
      inOff = inLen;
    }
  }
  const rest = input.slice(inOff);
  if (i >= prefixLen) return rest.length ? rest : "./";
  let out = "";
  while (i < prefixLen) {
    if (prefix[i] === "/") {
      out += "../";
      while (prefix[i] === "/") i++;
      continue;
    }
    i++;
  }
  if (prefix[prefixLen - 1] !== "/") out += "../";
  return out + rest;
}

/** The repository as `repo info` reads it. */
interface RepoFacts {
  bare: boolean;
  shallow: boolean;
  objectFormat: string;
  refStorage: string;
  /** host paths (realpath'ed where the host can), undefined where there is none */
  gitDir?: string;
  commonDir?: string;
  index?: string;
  workTree?: string;
  superproject?: string;
  /** git's `repo->prefix`: the current directory below the worktree top, with a `/` */
  prefix: string;
}

type InfoField = (facts: RepoFacts) => string;

const relativeTo = (facts: RepoFacts, path: string | undefined): string => {
  if (path === undefined) return "";
  // git runs from the worktree top (the git directory when bare); the prefix is below it
  const base = facts.workTree ?? facts.gitDir ?? "";
  const cwd = facts.prefix ? `${base}/${facts.prefix}` : base;
  return gitRelativePath(path, cwd);
};

const COMMON_FIELDS: [string, InfoField][] = [
  ["layout.bare", (f) => (f.bare ? "true" : "false")],
  ["layout.shallow", (f) => (f.shallow ? "true" : "false")],
  ["object.format", (f) => f.objectFormat],
];
const PATH_DIR_FIELDS: [string, InfoField][] = [
  ["path.commondir.absolute", (f) => f.commonDir ?? ""],
  ["path.commondir.relative", (f) => relativeTo(f, f.commonDir)],
  ["path.gitdir.absolute", (f) => f.gitDir ?? ""],
  ["path.gitdir.relative", (f) => relativeTo(f, f.gitDir)],
];

/** builtin/repo.c's `repo_info_field` table of a version, in its (sorted) order. */
function infoFields(compatibility: RepoCompatibility): [string, InfoField][] {
  const refFormat: InfoField = (f) => f.refStorage;
  if (compatibility === "2.54") return [...COMMON_FIELDS, ["references.format", refFormat]];
  if (compatibility === "2.56")
    return [...COMMON_FIELDS, ...PATH_DIR_FIELDS, ["references.format", refFormat]];
  return [
    ...COMMON_FIELDS,
    ["objects.storageFormat", () => "files"],
    ...PATH_DIR_FIELDS,
    ["path.index.absolute", (f) => f.index ?? ""],
    ["path.index.relative", (f) => relativeTo(f, f.index)],
    ["path.prefix", (f) => f.prefix],
    ["path.superprojectworkingtree.absolute", (f) => f.superproject ?? ""],
    ["path.superprojectworkingtree.relative", (f) => relativeTo(f, f.superproject)],
    ["path.workingtree.absolute", (f) => f.workTree ?? ""],
    ["path.workingtree.relative", (f) => relativeTo(f, f.workTree)],
    ["references.storageFormat", refFormat],
  ];
}

/** The host path of a FilesApi path (its root directory joined), undefined without one. */
function hostPathOf(files: FilesApi, path: string): string | undefined {
  const root = (files as { rootDirectory?: string }).rootDirectory;
  if (!root) return undefined;
  const base = root.replace(/\/+$/, "");
  const rest = path.replace(/^\/+|\/+$/g, "");
  return rest ? `${base}/${rest}` : base || "/";
}

/**
 * `git repo info [--format=(lines|nul) | -z] [--all | <key>...]` and `git repo info --keys`.
 *
 * Paths are host paths: the FilesApi's root directory joined with its paths, resolved through
 * the host's `realPath`; without a root directory the path keys are empty. Not followed:
 * `$GIT_DIR`/`$GIT_COMMON_DIR` given apart from the working copy (the working copy's own
 * directories are reported). `path.superprojectworkingtree.*` is found where the repository's
 * git directory is `<super>/.git/modules/<name>` and the superproject's worktree holds the
 * repository at its place (git asks the superproject's index).
 */
export class RepoInfoCommand extends PlumbingCommand {
  private format = "lines";
  private all = false;
  private showKeys = false;
  private keys: string[] = [];
  private compatibility: RepoCompatibility = "2.57";
  private currentDirectory = "";

  /** `--format=<format>` (`lines`, `nul`; `table` is refused when printing values) */
  setFormat(format: string): this {
    this.checkCallable();
    // git dies as it parses the option: a later valid one does not save it
    this.format = this.format.startsWith("!") ? this.format : format;
    if (!["nul", "lines", "table"].includes(format)) this.format = `!${format}`;
    return this;
  }

  /** `-z`: `--format=nul` */
  setNul(): this {
    return this.setFormat("nul");
  }

  /** `--all`: every key */
  setAll(all: boolean): this {
    this.checkCallable();
    this.all = all;
    return this;
  }

  /** `--keys`: the key names instead of values */
  setShowKeys(keys: boolean): this {
    this.checkCallable();
    this.showKeys = keys;
    return this;
  }

  /** The keys asked for, in order (repeats allowed). */
  addKeys(...keys: string[]): this {
    this.checkCallable();
    this.keys.push(...keys);
    return this;
  }

  /** The git version whose keys are known (default 2.57: git master). */
  setCompatibility(compatibility: RepoCompatibility): this {
    this.checkCallable();
    this.compatibility = compatibility;
    return this;
  }

  /** The directory git runs from, below the worktree top (`path.prefix`, relative paths). */
  setCurrentDirectory(path: string): this {
    this.checkCallable();
    this.currentDirectory = path.replace(/^\/+|\/+$/g, "");
    return this;
  }

  protected async run(): Promise<number> {
    const format = parseFormat(this.format.replace(/^!/, ""));
    const fields = infoFields(this.compatibility);
    const keysAsked = this.keys.length > 0;
    if (this.showKeys && (this.all || keysAsked))
      throw new PlumbingError("fatal: --keys cannot be used with a <key> or --all");
    if (this.showKeys) {
      if (format === "table")
        throw new PlumbingError(
          "fatal: --keys can only be used with --format=lines or --format=nul",
        );
      const sep = format === "nul" ? "\0" : "\n";
      await this.write(fields.map(([key]) => `${key}${sep}`).join(""));
      return 0;
    }
    if (format === "table") throw new PlumbingError("fatal: unsupported output format");
    if (this.all && keysAsked)
      throw new PlumbingError("fatal: --all and <key> cannot be used together");
    const facts = await this.facts();
    const table = new Map(fields);
    const print = async (key: string, value: string) => {
      if (format === "lines") await this.write(`${key}=${quotePath(value)}\n`);
      else await this.write(`${key}\n${value}\0`);
    };
    if (this.all) {
      for (const [key, field] of fields) await print(key, field(facts));
      return 0;
    }
    let status = 0;
    for (const key of this.keys) {
      const field = table.get(key);
      if (!field) {
        this.warn(`error: key '${key}' not found`);
        status = 255;
        continue;
      }
      await print(key, field(facts));
    }
    return status;
  }

  private async facts(): Promise<RepoFacts> {
    const history = this.workingCopy.history;
    const layout = await hookHostOf(this.workingCopy).layout();
    const environment = hostEnvironmentOf(this.workingCopy);
    const real = async (path: string | undefined) =>
      path === undefined
        ? undefined
        : ((await environment?.realPath?.(path).catch(() => undefined)) ?? path);
    const shallow = (await history.refs.getShallow?.()) ?? [];
    const format = layout
      ? await readRepositoryFormat(layout.files, layout.gitDir).catch(() => undefined)
      : undefined;
    const refStorage = format?.refStorage ?? "files";
    const facts: RepoFacts = {
      bare: layout?.bare ?? false,
      shallow: shallow.length > 0,
      objectFormat: this.objectFormat.name,
      refStorage,
      prefix: this.currentDirectory ? `${this.currentDirectory}/` : "",
    };
    if (!layout) return facts;
    const files = layout.files;
    // a gitfile's target (a submodule, a linked worktree) may lie outside the FilesApi
    facts.gitDir = await real(
      layout.gitDirEnv?.startsWith("/") ? layout.gitDirEnv : hostPathOf(files, layout.gitDir),
    );
    // repo_get_common_dir: $GIT_COMMON_DIR, else the git directory's `commondir` file
    // (a linked worktree's), else the git directory itself
    const commondirFile = facts.gitDir
      ? await environment?.readFile(`${facts.gitDir}/commondir`).catch(() => undefined)
      : undefined;
    const named = commondirFile ? new TextDecoder().decode(commondirFile).trim() : undefined;
    facts.commonDir = environment?.commonDir
      ? await real(environment.commonDir)
      : named
        ? await real(named.startsWith("/") ? named : `${facts.gitDir}/${named}`)
        : facts.gitDir;
    const indexFile = environment?.indexFile;
    facts.index =
      indexFile === undefined
        ? facts.gitDir
          ? `${facts.gitDir}/index`
          : undefined
        : indexFile.startsWith("/")
          ? indexFile
          : // relative to the directory git was started in
            await real(
              `${hostPathOf(files, layout.bare ? layout.gitDir : layout.top) ?? ""}/${facts.prefix}${indexFile}`,
            );
    if (!layout.bare) {
      facts.workTree = await real(hostPathOf(files, layout.top));
      facts.superproject = await this.superprojectOf(facts.gitDir, facts.workTree);
    }
    return facts;
  }

  /** get_superproject_working_tree, for a git directory under `<super>/.git/modules/`. */
  private async superprojectOf(
    gitDir: string | undefined,
    workTree: string | undefined,
  ): Promise<string | undefined> {
    if (!gitDir || !workTree) return undefined;
    const at = gitDir.lastIndexOf("/.git/modules/");
    if (at < 0) return undefined;
    const superTop = gitDir.slice(0, at);
    if (!workTree.startsWith(`${superTop}/`)) return undefined;
    // the superproject's worktree must hold this one (git asks its index for the gitlink)
    const environment = hostEnvironmentOf(this.workingCopy);
    if (environment?.statFile) {
      const s = await environment.statFile(`${superTop}/.git`).catch(() => undefined);
      if (!s) return undefined;
    }
    return superTop;
  }
}

/** Counts and sizes `repo structure` prints of each object type. */
interface ObjectValues {
  commits: number;
  trees: number;
  blobs: number;
  tags: number;
}

interface Largest {
  id: ObjectId | undefined;
  value: number;
}

/** What `git repo structure` counted. */
export interface RepoStructure {
  references: { branches: number; tags: number; remotes: number; others: number };
  counts: ObjectValues;
  inflatedSizes: ObjectValues;
  diskSizes: ObjectValues;
  largest: {
    commitSize: Largest;
    treeSize: Largest;
    blobSize: Largest;
    tagSize: Largest;
    parentCount: Largest;
    treeEntries: Largest;
  };
}

const emptyValues = (): ObjectValues => ({ commits: 0, trees: 0, blobs: 0, tags: 0 });
const total = (v: ObjectValues) => v.commits + v.trees + v.blobs + v.tags;

/** strbuf.c's humanise_count. */
export function humaniseCount(count: number): { value: string; unit?: string } {
  const frac = (x: number, d: number) => String(Math.floor(x / d) % 100).padStart(2, "0");
  if (count >= 1e9) {
    const x = count + 5000000;
    return { value: `${Math.floor(x / 1e9)}.${frac(x % 1e9, 1e7)}`, unit: "G" };
  }
  if (count >= 1e6) {
    const x = count + 5000;
    return { value: `${Math.floor(x / 1e6)}.${frac(x % 1e6, 1e4)}`, unit: "M" };
  }
  if (count >= 1000) {
    const x = count + 5;
    return { value: `${Math.floor(x / 1000)}.${frac(x % 1000, 10)}`, unit: "k" };
  }
  return { value: String(count) };
}

/** strbuf.c's humanise_bytes with HUMANISE_COMPACT. */
export function humaniseBytesCompact(bytes: number): { value: string; unit: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  if (bytes > 2 ** 30) {
    const low = bytes % 2 ** 30;
    return {
      value: `${Math.floor(bytes / 2 ** 30)}.${pad(Math.floor(low / 10737419) >>> 0)}`,
      unit: "GiB",
    };
  }
  if (bytes > 2 ** 20) {
    const x = (bytes + 5243) >>> 0;
    return {
      value: `${x >>> 20}.${pad(Math.floor(((x & 0xfffff) * 100) / 2 ** 20))}`,
      unit: "MiB",
    };
  }
  if (bytes > 2 ** 10) {
    const x = (bytes + 5) >>> 0;
    return { value: `${x >>> 10}.${pad(Math.floor(((x & 0x3ff) * 100) / 1024))}`, unit: "KiB" };
  }
  return { value: String(bytes), unit: "B" };
}

/** git's utf8_strwidth for the table's (ASCII) cells. */
const width = (text: string) => text.length;

/** path-walk.c's compare_by_type: tags first, then blobs, then trees; else by path. */
const TYPE_RANK: Record<string, number> = { tag: 0, blob: 1, tree: 2, commit: 3 };

/** A binary heap ordered by `compare` (git's prio_queue without ties). */
class Heap<T> {
  private items: T[] = [];
  constructor(private readonly compare: (a: T, b: T) => number) {}
  get size(): number {
    return this.items.length;
  }
  push(item: T): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.compare(a[p] as T, a[i] as T) <= 0) break;
      [a[p], a[i]] = [a[i] as T, a[p] as T];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop() as T;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.compare(a[l] as T, a[m] as T) < 0) m = l;
        if (r < a.length && this.compare(a[r] as T, a[m] as T) < 0) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i] as T, a[m] as T];
        i = m;
      }
    }
    return top;
  }
}

/** Reads an object whole: its type and bytes, undefined when missing. */
async function readWhole(
  objects: {
    get(
      id: ObjectId,
    ): Promise<{ type: ObjectTypeString; content: AsyncIterable<Uint8Array> } | undefined>;
  },
  id: ObjectId,
): Promise<{ type: ObjectTypeString; bytes: Uint8Array } | undefined> {
  let object: Awaited<ReturnType<typeof objects.get>>;
  try {
    object = await objects.get(id);
  } catch {
    return undefined;
  }
  if (!object) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const c of object.content) {
    chunks.push(c);
    length += c.length;
  }
  if (chunks.length === 1) return { type: object.type, bytes: chunks[0] as Uint8Array };
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { type: object.type, bytes };
}

/** The pack-relevant part of a `PackFile`. */
interface OffsetPack extends Pack {
  indexOf?(id: ObjectId): number;
  offsetAt?(i: number): number;
  packOrder?(): Uint32Array;
}

/**
 * `git repo structure [--format=(table|lines|nul) | -z] [--[no-]progress]`: the references
 * by kind and the objects reachable from them (path-walk.c's walk over every ref, as git
 * walks it, so ties of the largest objects go to the object git meets first), with their
 * inflated and on-disk sizes (a packed object's entry, a loose object's file; an object only
 * an alternate holds counts 0 bytes on disk).
 */
export class RepoStructureCommand extends PlumbingCommand {
  private format = "table";
  private showProgress = false;
  private counted?: RepoStructure;

  /** `--format=<format>` (`table`, `lines`, `nul`) */
  setFormat(format: string): this {
    this.checkCallable();
    // git dies as it parses the option: a later valid one does not save it
    this.format = this.format.startsWith("!") ? this.format : format;
    if (!["nul", "lines", "table"].includes(format)) this.format = `!${format}`;
    return this;
  }

  /** `-z`: `--format=nul` */
  setNul(): this {
    return this.setFormat("nul");
  }

  /** `--progress`: the final progress lines on stderr (git's default: on a terminal only) */
  setShowProgress(progress: boolean): this {
    this.checkCallable();
    this.showProgress = progress;
    return this;
  }

  /** What the last run counted. */
  getStructure(): RepoStructure | undefined {
    return this.counted;
  }

  protected async run(): Promise<number> {
    const format = parseFormat(this.format.replace(/^!/, ""));
    const s: RepoStructure = {
      references: { branches: 0, tags: 0, remotes: 0, others: 0 },
      counts: emptyValues(),
      inflatedSizes: emptyValues(),
      diskSizes: emptyValues(),
      largest: {
        commitSize: { id: undefined, value: 0 },
        treeSize: { id: undefined, value: 0 },
        blobSize: { id: undefined, value: 0 },
        tagSize: { id: undefined, value: 0 },
        parentCount: { id: undefined, value: 0 },
        treeEntries: { id: undefined, value: 0 },
      },
    };
    const pending = await this.countReferences(s);
    if (this.showProgress) {
      const r = s.references;
      this.warn(`Counting references: ${r.branches + r.tags + r.remotes + r.others}, done.`);
    }
    await this.countObjects(s, pending);
    if (this.showProgress) this.warn(`Counting objects: ${total(s.counts)}, done.`);
    this.counted = s;
    if (format === "table") await this.write(this.table(s));
    else if (format === "lines") await this.write(this.keyValues(s, "=", "\n"));
    else await this.write(this.keyValues(s, "\n", "\0"));
    return 0;
  }

  /** count_references: every ref under refs/ (symbolic ones resolved), in name order. */
  private async countReferences(s: RepoStructure): Promise<ObjectId[]> {
    const refs = this.workingCopy.history.refs;
    const names: string[] = [];
    for await (const ref of refs.list("refs/")) names.push(ref.name);
    names.sort(compareGitPaths);
    const pending: ObjectId[] = [];
    for (const name of names) {
      const resolved = await refs.resolve(name).catch(() => undefined);
      const id = resolved?.objectId;
      if (!id) continue;
      if (name.startsWith("refs/heads/")) s.references.branches++;
      else if (name.startsWith("refs/remotes/")) s.references.remotes++;
      else if (name.startsWith("refs/tags/")) s.references.tags++;
      else s.references.others++;
      pending.push(id);
    }
    return pending;
  }

  /** structure_count_objects: path-walk.c's walk_objects_by_path from the refs. */
  private async countObjects(s: RepoStructure, pending: ObjectId[]): Promise<void> {
    const history = this.workingCopy.history;
    const objects = history.objects;
    if (!objects) throw new PlumbingError("fatal: repo structure needs an object store");
    const types = new Map<ObjectId, ObjectTypeString>();
    const typeOf = async (id: ObjectId): Promise<ObjectTypeString | undefined> => {
      let t = types.get(id);
      if (t) return t;
      try {
        t = (await objects.header?.(id))?.type ?? (await objects.get(id))?.type;
      } catch {
        t = undefined;
      }
      if (t) types.set(id, t);
      return t;
    };
    const seen = new Set<ObjectId>();
    const lists = new Map<string, { type: ObjectTypeString; ids: ObjectId[] }>();
    const pushed = new Set<string>();
    const heap = new Heap<string>((a, b) => {
      const la = lists.get(a);
      const lb = lists.get(b);
      if (!la || !lb || la.type === lb.type) return compareGitPaths(a, b);
      return (TYPE_RANK[la.type] ?? 9) - (TYPE_RANK[lb.type] ?? 9);
    });
    const push = (path: string) => {
      if (pushed.has(path)) return;
      pushed.add(path);
      heap.push(path);
    };
    const addToList = (path: string, type: ObjectTypeString, id: ObjectId) => {
      let list = lists.get(path);
      if (!list) {
        list = { type, ids: [] };
        lists.set(path, list);
      }
      list.ids.push(id);
    };
    lists.set("", { type: "tree", ids: [] });
    push("");

    // setup_pending_objects (after prepare_revision_walk): tags, tagged trees and blobs
    const starts: ObjectId[] = [];
    const tags: ObjectId[] = [];
    const taggedTrees: ObjectId[] = [];
    const taggedBlobs: ObjectId[] = [];
    for (const tip of pending) {
      let id: ObjectId | undefined = tip;
      let type = await typeOf(id);
      let stopped = false;
      while (type === "tag" && id) {
        if (seen.has(id)) {
          stopped = true;
          break;
        }
        seen.add(id);
        tags.push(id);
        const tag = await readWhole(objects, id);
        id = tag
          ? /^object ([0-9a-f]+)/.exec(new TextDecoder().decode(tag.bytes.subarray(0, 200)))?.[1]
          : undefined;
        type = id ? await typeOf(id) : undefined;
      }
      if (stopped || !id || !type) continue;
      if (type === "commit") {
        starts.push(id);
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      if (type === "tree") taggedTrees.push(id);
      else if (type === "blob") taggedBlobs.push(id);
    }
    for (const [path, type, ids] of [
      ["/tagged-blobs", "blob", taggedBlobs],
      ["/tagged-trees", "tree", taggedTrees],
      ["/tags", "tag", tags],
    ] as const) {
      if (ids.length === 0) continue;
      lists.set(path, { type, ids: [...ids] });
      push(path);
    }

    // the commit walk: commits in walk order, each new root tree
    const commits: ObjectId[] = [];
    const roots = lists.get("") as { ids: ObjectId[] };
    if (starts.length > 0) {
      const walk = new RevListCommand(this.workingCopy);
      for (const id of starts) walk.addRevision(id);
      for await (const c of await walk.call()) {
        commits.push(c.id);
        if (seen.has(c.tree)) continue;
        seen.add(c.tree);
        roots.ids.push(c.tree);
      }
    }

    const disk = await this.diskSizer();
    const check = (largest: Largest, id: ObjectId, value: number) => {
      if (value > largest.value || largest.id === undefined) {
        largest.id = id;
        largest.value = value;
      }
    };
    const idLength = this.objectFormat.rawLength;
    const count = async (type: ObjectTypeString, ids: ObjectId[]) => {
      for (const id of ids) {
        if (type === "blob") {
          let size: number | undefined;
          try {
            size = (await objects.header?.(id))?.size;
            if (size === undefined) size = (await readWhole(objects, id))?.bytes.length;
          } catch {
            size = undefined;
          }
          if (size === undefined) continue;
          s.counts.blobs++;
          s.inflatedSizes.blobs += size;
          s.diskSizes.blobs += await disk(id);
          check(s.largest.blobSize, id, size);
          continue;
        }
        const object = await readWhole(objects, id);
        if (!object) continue;
        const size = object.bytes.length;
        if (type === "tag") {
          s.counts.tags++;
          s.inflatedSizes.tags += size;
          s.diskSizes.tags += await disk(id);
          check(s.largest.tagSize, id, size);
        } else if (type === "commit") {
          s.counts.commits++;
          s.inflatedSizes.commits += size;
          s.diskSizes.commits += await disk(id);
          check(s.largest.commitSize, id, size);
          check(s.largest.parentCount, id, parentCount(object.bytes));
        } else if (type === "tree") {
          s.counts.trees++;
          s.inflatedSizes.trees += size;
          s.diskSizes.trees += await disk(id);
          check(s.largest.treeSize, id, size);
          check(
            s.largest.treeEntries,
            id,
            decodeTreeBytes(object.bytes, { idLength, checkNames: false }).length,
          );
        }
      }
    };
    if (commits.length > 0) await count("commit", commits);

    for (let path = heap.pop(); path !== undefined; path = heap.pop()) {
      const list = lists.get(path);
      pushed.delete(path);
      if (!list || list.ids.length === 0) continue;
      await count(list.type, list.ids);
      if (list.type === "tree") {
        const base = path === "/tagged-trees" ? "" : path;
        for (const treeId of list.ids) {
          const tree = await readWhole(objects, treeId);
          if (!tree) {
            this.warn(`error: bad tree object ${treeId}`);
            return;
          }
          for (const entry of decodeTreeBytes(tree.bytes, { idLength, checkNames: false })) {
            if (entry.mode === 0o160000) continue;
            const isTree = (entry.mode & 0o170000) === 0o040000;
            const child = `${base}${entry.name}${isTree ? "/" : ""}`;
            if (seen.has(entry.id)) continue;
            seen.add(entry.id);
            addToList(child, isTree ? "tree" : "blob", entry.id);
            push(child);
          }
        }
      }
      lists.delete(path);
    }
  }

  /**
   * The bytes an object takes on disk, as odb_read_object_info_extended's `disk_sizep`: its
   * pack entry (to the next entry by offset, or the trailer), else its loose file.
   */
  private async diskSizer(): Promise<(id: ObjectId) => Promise<number>> {
    const objectsFile = await this.hooks.commonGitFile("objects");
    const packSet = this.workingCopy.history.packs;
    const packs = ((await packSet?.packs().catch(() => [])) ?? []) as OffsetPack[];
    const hashLength = this.objectFormat.rawLength;
    const sorted = new Map<OffsetPack, Float64Array>();
    const packSizes = new Map<OffsetPack, number>();
    const offsetsOf = (pack: OffsetPack): Float64Array => {
      let offsets = sorted.get(pack);
      if (!offsets) {
        offsets = new Float64Array(pack.count);
        for (let i = 0; i < pack.count; i++) offsets[i] = pack.offsetAt?.(i) ?? 0;
        offsets.sort();
        sorted.set(pack, offsets);
      }
      return offsets;
    };
    const packSizeOf = async (pack: OffsetPack): Promise<number> => {
      let size = packSizes.get(pack);
      if (size === undefined) {
        size = 0;
        if (objectsFile) {
          const path = joinPath(objectsFile.path, "pack", `${packNameOf(pack)}.pack`);
          size = (await objectsFile.files.stats(path))?.size ?? 0;
        }
        packSizes.set(pack, size);
      }
      return size;
    };
    return async (id) => {
      for (const pack of packs) {
        if (!pack.has(id) || !pack.indexOf || !pack.offsetAt) continue;
        const index = pack.indexOf(id);
        if (index < 0) continue;
        const offset = pack.offsetAt(index);
        const offsets = offsetsOf(pack);
        let lo = 0;
        let hi = offsets.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((offsets[mid] as number) <= offset) lo = mid + 1;
          else hi = mid;
        }
        const next =
          lo < offsets.length ? (offsets[lo] as number) : (await packSizeOf(pack)) - hashLength;
        return next - offset;
      }
      if (!objectsFile) return 0;
      const path = joinPath(objectsFile.path, id.slice(0, 2), id.slice(2));
      return (await objectsFile.files.stats(path).catch(() => undefined))?.size ?? 0;
    };
  }

  /** stats_table_setup_structure + stats_table_print_structure. */
  private table(s: RepoStructure): string {
    type Entry = { value: string; unit?: string; index?: number };
    const rows: { name: string; entry?: Entry }[] = [];
    const annotations: string[] = [];
    let nameWidth = 0;
    let valueWidth = 0;
    let unitWidth = 0;
    const add = (name: string, entry?: Entry, id?: ObjectId) => {
      rows.push({ name, entry });
      nameWidth = Math.max(nameWidth, width(name));
      if (!entry) return;
      if (id) {
        entry.index = annotations.length + 1;
        annotations.push(`[${entry.index}] ${id}`);
      }
      valueWidth = Math.max(valueWidth, width(entry.value));
      if (entry.unit) unitWidth = Math.max(unitWidth, width(entry.unit));
    };
    const countRow = (name: string, n: number, id?: ObjectId) => add(name, humaniseCount(n), id);
    const sizeRow = (name: string, n: number, id?: ObjectId) =>
      add(name, humaniseBytesCompact(n), id);
    const r = s.references;
    add("* References");
    countRow("  * Count", r.branches + r.tags + r.remotes + r.others);
    countRow("    * Branches", r.branches);
    countRow("    * Tags", r.tags);
    countRow("    * Remotes", r.remotes);
    countRow("    * Others", r.others);
    const byType = (values: ObjectValues, row: (name: string, n: number) => void) => {
      row("    * Commits", values.commits);
      row("    * Trees", values.trees);
      row("    * Blobs", values.blobs);
      row("    * Tags", values.tags);
    };
    add("");
    add("* Reachable objects");
    countRow("  * Count", total(s.counts));
    byType(s.counts, countRow);
    sizeRow("  * Inflated size", total(s.inflatedSizes));
    byType(s.inflatedSizes, sizeRow);
    sizeRow("  * Disk size", total(s.diskSizes));
    byType(s.diskSizes, sizeRow);
    const l = s.largest;
    add("");
    add("* Largest objects");
    add("  * Commits");
    sizeRow("    * Maximum size", l.commitSize.value, l.commitSize.id);
    countRow("    * Maximum parents", l.parentCount.value, l.parentCount.id);
    add("  * Trees");
    sizeRow("    * Maximum size", l.treeSize.value, l.treeSize.id);
    countRow("    * Maximum entries", l.treeEntries.value, l.treeEntries.id);
    add("  * Blobs");
    sizeRow("    * Maximum size", l.blobSize.value, l.blobSize.id);
    add("  * Tags");
    sizeRow("    * Maximum size", l.tagSize.value, l.tagSize.id);

    const nameTitle = "Repository structure";
    const valueTitle = "Value";
    nameWidth = Math.max(nameWidth, width(nameTitle));
    if (width(valueTitle) > valueWidth + unitWidth + 1) valueWidth = width(valueTitle) - unitWidth;
    const INDEX_WIDTH = 4;
    const left = (text: string, w: number) => text.padEnd(w);
    const right = (text: string, w: number) => text.padStart(w);
    const valueCol = valueWidth + unitWidth + 1;
    let out = `| ${left(nameTitle, nameWidth + INDEX_WIDTH)} | ${left(valueTitle, valueCol)} |\n`;
    out += `| ${"-".repeat(nameWidth + INDEX_WIDTH)} | ${"-".repeat(valueCol)} |\n`;
    for (const { name, entry } of rows) {
      out += `| ${left(name, nameWidth)}`;
      out += entry?.index !== undefined ? ` [${entry.index}]` : " ".repeat(INDEX_WIDTH);
      out += ` | ${right(entry?.value ?? "", valueWidth)} ${left(entry?.unit ?? "", unitWidth)} |\n`;
    }
    if (annotations.length > 0) out += `\n${annotations.map((a) => `${a}\n`).join("")}`;
    return out;
  }

  /** structure_keyvalue_print. */
  private keyValues(s: RepoStructure, keyDelim: string, valueDelim: string): string {
    const nullId = this.objectFormat.nullId;
    let out = "";
    const kv = (key: string, value: number) => {
      out += `${key}${keyDelim}${value}${valueDelim}`;
    };
    const data = (key: string, largest: Largest) => {
      kv(key, largest.value);
      out += `${key}_oid${keyDelim}${largest.id ?? nullId}${valueDelim}`;
    };
    const r = s.references;
    kv("references.branches.count", r.branches);
    kv("references.tags.count", r.tags);
    kv("references.remotes.count", r.remotes);
    kv("references.others.count", r.others);
    for (const [suffix, values] of [
      ["count", s.counts],
      ["inflated_size", s.inflatedSizes],
      ["disk_size", s.diskSizes],
    ] as const) {
      kv(`objects.commits.${suffix}`, values.commits);
      kv(`objects.trees.${suffix}`, values.trees);
      kv(`objects.blobs.${suffix}`, values.blobs);
      kv(`objects.tags.${suffix}`, values.tags);
    }
    const l = s.largest;
    data("objects.commits.max_size", l.commitSize);
    data("objects.trees.max_size", l.treeSize);
    data("objects.blobs.max_size", l.blobSize);
    data("objects.tags.max_size", l.tagSize);
    data("objects.commits.max_parents", l.parentCount);
    data("objects.trees.max_entries", l.treeEntries);
    return out;
  }
}

/** The `parent` lines of a commit's header. */
function parentCount(bytes: Uint8Array): number {
  const end = bytes.indexOf(0x0a, 0);
  let n = 0;
  let at = end + 1;
  while (at > 0 && at < bytes.length) {
    const next = bytes.indexOf(0x0a, at);
    if (next === at) break;
    // "parent "
    if (
      bytes[at] === 0x70 &&
      bytes[at + 1] === 0x61 &&
      bytes[at + 2] === 0x72 &&
      bytes[at + 6] === 0x20
    )
      n++;
    else if (n > 0) break;
    if (next < 0) break;
    at = next + 1;
  }
  return n;
}
