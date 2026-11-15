/**
 * A portable `PosixFilesApi` that simulates symbolic links (and permission bits, and
 * optionally case folding) on top of any FilesApi: memory, browser, a mounted composite.
 *
 * **Representation.** Each link is a pair: an empty placeholder file at the link's path in
 * the base FilesApi, and an entry in a side table (path → target bytes, plus the permission
 * bits `chmod` set) persisted as JSON in one reserved hidden file at the root,
 * `/.webrun-symlinks.json`. Why a side table rather than a marker inside the placeholder:
 * a marker in file content can always be forged or collide with a real file's bytes, while
 * the table is out of band — no file a worktree writes can become a link, and a link's
 * target can be any bytes (not only UTF-8). The placeholder keeps the name occupied in the
 * base, so listings, parent directories and name collisions behave as on a filesystem.
 *
 * **Consistency.** A path is a link only while both halves agree: a table entry *and* an
 * empty placeholder file. Anything else reads as what the base holds — an entry without its
 * placeholder is stale (absent), a placeholder without an entry, or with content, is a
 * file. Mutations order the halves so an interruption never makes a file read as a link:
 * `symlink` records the entry before writing the placeholder, `write` drops the entry before
 * writing content. All wrappers of one base share one table, reloaded from the base before
 * each mutation, and mutations of a base are serialized, so wrappers in one program never
 * lose each other's links (writers in other programs see each other's table on reload).
 *
 * **Reserved.** `/.webrun-symlinks.json` (in any letter case and Unicode composition) is
 * hidden from listings and refused to every operation; trees may not name it either
 * ({@link isReservedFilesName}). Paths with `..` are refused.
 *
 * Links are never followed, exactly per the `PosixFilesApi` contract: a path beneath a link
 * is rejected with `BeyondSymlinkError`, a link at the path is an entry of its own.
 */

import { BeyondSymlinkError } from "./beyond-symlink-error.js";
import type {
  FileInfo,
  FileStats,
  FilesApi,
  LinkStats,
  ListOptions,
  PosixFilesApi,
  ReadOptions,
} from "./files-api.js";
import { normalizePath } from "./path-utils.js";

/** The reserved file holding the side table. */
export const SYMLINK_TABLE_PATH = "/.webrun-symlinks.json";
const RESERVED_NAME = ".webrun-symlinks.json";

/**
 * Whether a path component names the simulated-links table (in any case and Unicode
 * composition): a name no tree may hold, as `.git`.
 */
export function isReservedFilesName(component: string): boolean {
  return component.normalize("NFC").toLowerCase() === RESERVED_NAME;
}

/** Options of {@link createSymlinkFilesApi}. */
export interface SymlinkFilesApiOptions {
  /** Report `pathSeparators` (`"/\\"` simulates Windows; default `"/"`). */
  pathSeparators?: string;
  /** Resolve names case-insensitively, as a case-folding filesystem (macOS, Windows). */
  ignoreCase?: boolean;
  /** Resolve NFC and NFD spellings of a name to one entry, as HFS+/APFS. */
  precomposeUnicode?: boolean;
  /** Permission bits of a new file (default `0o644`, as with a 022 umask). */
  defaultFileMode?: number;
}

interface Table {
  links: Map<string, Uint8Array>;
  modes: Map<string, number>;
}

/** The shared state of one base: its table, and the queue its mutations run in. */
interface BaseState {
  table?: Table;
  queue: Promise<unknown>;
}
const states = new WeakMap<FilesApi, BaseState>();

type Content = Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

const isUnder = (path: string, dir: string) =>
  dir === "/" || path === dir || path.startsWith(`${dir}/`);
const rebase = (path: string, from: string, to: string) =>
  path === from ? to : `${to === "/" ? "" : to}${path.slice(from === "/" ? 0 : from.length)}`;
const parentOf = (path: string) => {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
};

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}
function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Wraps `base` into a `PosixFilesApi` with simulated symbolic links and permission bits.
 *
 * @example
 * ```typescript
 * const files = createSymlinkFilesApi(createInMemoryFilesApi());
 * await files.symlink(new TextEncoder().encode("../outside"), "/repo/link");
 * (await files.lstat("/repo/link"))?.kind; // "symlink"
 * await files.write("/repo/link/x", [bytes]); // throws BeyondSymlinkError
 * ```
 */
export function createSymlinkFilesApi(
  base: FilesApi,
  options: SymlinkFilesApiOptions = {},
): PosixFilesApi {
  return new SymlinkFilesApi(base, options);
}

class SymlinkFilesApi implements PosixFilesApi {
  readonly pathSeparators: string;
  readonly refusesBeyondLinks = true;
  /** The table file is reserved at the root: no tree may hold it there */
  readonly reservedNames = [RESERVED_NAME];
  private readonly fileMode: number;
  private readonly state: BaseState;

  constructor(
    private readonly base: FilesApi,
    private readonly options: SymlinkFilesApiOptions,
  ) {
    this.pathSeparators = options.pathSeparators ?? "/";
    this.fileMode = options.defaultFileMode ?? 0o644;
    let state = states.get(base);
    if (!state) {
      state = { queue: Promise.resolve() };
      states.set(base, state);
    }
    this.state = state;
  }

  // ========== side table ==========

  /** The table as the base holds it now. */
  private async readTable(): Promise<Table> {
    const table: Table = { links: new Map(), modes: new Map() };
    if (!(await this.base.exists(SYMLINK_TABLE_PATH))) return table;
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.base.read(SYMLINK_TABLE_PATH)) chunks.push(chunk);
    const text = new TextDecoder().decode(concat(chunks));
    const data = JSON.parse(text || "{}") as {
      links?: Record<string, string>;
      modes?: Record<string, number>;
    };
    for (const [path, target] of Object.entries(data.links ?? {})) {
      table.links.set(path, fromBase64(target));
    }
    for (const [path, mode] of Object.entries(data.modes ?? {})) table.modes.set(path, mode);
    return table;
  }

  /** The shared table, read once (mutations reload it). */
  private async table(): Promise<Table> {
    this.state.table ??= await this.readTable();
    return this.state.table;
  }

  /**
   * Runs `change` on the table freshly reloaded from the base, then saves it if it changed
   * (`change` returning false means it did not); mutations of one base run one after
   * another. A base that never held a link gets no table file.
   */
  private mutate(
    change: (table: Table) => Promise<boolean | void> | boolean | void,
  ): Promise<void> {
    const run = this.state.queue.then(async () => {
      const table = await this.readTable();
      this.state.table = table;
      if ((await change(table)) === false) return;
      if (
        table.links.size === 0 &&
        table.modes.size === 0 &&
        !(await this.base.exists(SYMLINK_TABLE_PATH))
      ) {
        return;
      }
      const data = {
        links: Object.fromEntries([...table.links].map(([p, t]) => [p, toBase64(t)])),
        modes: Object.fromEntries(table.modes),
      };
      await this.base.write(SYMLINK_TABLE_PATH, [new TextEncoder().encode(JSON.stringify(data))]);
    });
    this.state.queue = run.catch(() => {});
    return run;
  }

  /** The link at `path`, if both halves agree (entry and empty placeholder). */
  private async linkAt(table: Table, path: string): Promise<Uint8Array | undefined> {
    const target = table.links.get(path);
    if (!target) return undefined;
    const stats = await this.base.stats(path);
    return stats?.kind === "file" && (stats.size ?? 0) === 0 ? target : undefined;
  }

  // ========== paths ==========

  private fold(name: string): string {
    let folded = this.options.precomposeUnicode ? name.normalize("NFC") : name;
    if (this.options.ignoreCase) folded = folded.toLowerCase();
    return folded;
  }

  /**
   * The canonical spelling of `path`: normalized, `..` refused, and with case or composition
   * folding each existing component spelled as stored. The reserved table file is refused.
   */
  private async canonical(path: string): Promise<string> {
    const parts = path.split("/").filter((s) => s !== "" && s !== ".");
    if (parts.includes("..")) throw new Error(`'..' in path: ${path}`);
    if (parts.length > 0 && isReservedFilesName(parts[0])) {
      throw new Error(`Reserved path: ${SYMLINK_TABLE_PATH}`);
    }
    if (!this.options.ignoreCase && !this.options.precomposeUnicode) {
      return normalizePath(path);
    }
    let out = "/";
    for (const name of parts) {
      let spelled = name;
      for await (const entry of this.base.list(out)) {
        if (entry.name === name) break;
        if (this.fold(entry.name) === this.fold(name)) {
          spelled = entry.name;
          break;
        }
      }
      out = out === "/" ? `/${spelled}` : `${out}/${spelled}`;
    }
    return out;
  }

  /** The canonical path, refused with `BeyondSymlinkError` if a leading component is a link. */
  private async resolve(path: string): Promise<{ path: string; table: Table }> {
    const canonical = await this.canonical(path);
    const table = await this.table();
    const parts = canonical.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const prefix = `/${parts.slice(0, i).join("/")}`;
      if (await this.linkAt(table, prefix)) throw new BeyondSymlinkError(path, prefix);
    }
    return { path: canonical, table };
  }

  // ========== PosixFilesApi ==========

  async lstat(path: string): Promise<LinkStats | undefined> {
    const { path: p, table } = await this.resolve(path);
    const stats = await this.base.stats(p);
    if (!stats) return undefined;
    const link = await this.linkAt(table, p);
    if (link) return { kind: "symlink", size: link.length, lastModified: stats.lastModified ?? 0 };
    if (stats.kind === "directory") return { kind: "directory", size: 0, lastModified: 0 };
    return {
      kind: "file",
      size: stats.size ?? 0,
      lastModified: stats.lastModified ?? 0,
      mode: table.modes.get(p) ?? this.fileMode,
    };
  }

  async readlink(path: string): Promise<Uint8Array | undefined> {
    const { path: p, table } = await this.resolve(path);
    const link = await this.linkAt(table, p);
    return link ? new Uint8Array(link) : undefined;
  }

  async symlink(target: Uint8Array, path: string): Promise<void> {
    const { path: p, table } = await this.resolve(path);
    if (await this.base.exists(p)) {
      throw Object.assign(new Error(`EEXIST: file already exists: ${path}`), { code: "EEXIST" });
    }
    await this.mkdirs(parentOf(p), table, path);
    // the entry first: interrupted here, it is stale (no placeholder), never a file read as link
    await this.mutate((t) => {
      t.links.set(p, new Uint8Array(target));
      t.modes.delete(p);
    });
    await this.base.write(p, []);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const { path: p, table } = await this.resolve(path);
    if (await this.linkAt(table, p)) {
      throw new Error(`will not chmod through a symbolic link: ${path}`);
    }
    if (!(await this.base.exists(p))) {
      throw Object.assign(new Error(`ENOENT: no such file: ${path}`), { code: "ENOENT" });
    }
    await this.mutate((t) => {
      t.modes.set(p, mode & 0o777);
    });
  }

  // ========== FilesApi ==========

  async *read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array> {
    const { path: p, table } = await this.resolve(path);
    if (await this.linkAt(table, p)) return;
    yield* this.base.read(p, options);
  }

  async write(path: string, content: Content): Promise<void> {
    const { path: p, table } = await this.resolve(path);
    await this.mkdirs(parentOf(p), table, path);
    // the entry dropped first: interrupted here, the link is an empty file, never content
    // read as a link
    if (table.links.has(p)) await this.mutate((t) => t.links.delete(p));
    await this.base.write(p, content);
  }

  async createExclusive(path: string, content: Content): Promise<boolean> {
    const { path: p, table } = await this.resolve(path);
    if (await this.linkAt(table, p)) return false;
    await this.mkdirs(parentOf(p), table, path);
    // a stale entry (its placeholder gone) is dropped first: a new empty file at the path
    // must never complete it into a link
    if (table.links.has(p)) await this.mutate((t) => t.links.delete(p));
    if (this.base.createExclusive) return this.base.createExclusive(p, content);
    if (await this.base.exists(p)) return false;
    await this.base.write(p, content);
    return true;
  }

  async mkdir(path: string): Promise<void> {
    const { path: p, table } = await this.resolve(path);
    await this.mkdirs(p, table, path);
  }

  /** Creates `dir` and its parents; a link or file in the way is an error. */
  private async mkdirs(dir: string, table: Table, asked: string): Promise<void> {
    if (await this.linkAt(table, dir)) throw new BeyondSymlinkError(asked, dir);
    const stats = await this.base.stats(dir);
    if (stats?.kind === "directory") return;
    if (stats) {
      throw Object.assign(new Error(`ENOTDIR: not a directory: ${dir}`), { code: "ENOTDIR" });
    }
    await this.base.mkdir(dir);
  }

  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    const { path: p, table } = await this.resolve(path);
    if (await this.linkAt(table, p)) return;
    for await (const entry of this.base.list(p, options)) {
      if (entry.path.split("/").length === 2 && isReservedFilesName(entry.name)) continue;
      const link = entry.kind === "file" ? await this.linkAt(table, entry.path) : undefined;
      yield link ? { ...entry, kind: "file", size: link.length } : entry;
    }
  }

  async stats(path: string): Promise<FileStats | undefined> {
    const { path: p, table } = await this.resolve(path);
    const stats = await this.base.stats(p);
    const link = stats ? await this.linkAt(table, p) : undefined;
    return link && stats ? { ...stats, kind: "file", size: link.length } : stats;
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { path: p } = await this.resolve(path);
      return await this.base.exists(p);
    } catch (error) {
      if (error instanceof BeyondSymlinkError) return false;
      throw error;
    }
  }

  async remove(path: string): Promise<boolean> {
    const { path: p } = await this.resolve(path);
    // the entry (stale once the placeholder is gone) is purged after
    const removed = await this.base.remove(p);
    const held = (t: Table) =>
      [...t.links.keys(), ...t.modes.keys()].some((key) => isUnder(key, p));
    if (held(await this.table())) {
      await this.mutate((t) => {
        if (!held(t)) return false;
        for (const map of [t.links, t.modes] as Map<string, unknown>[]) {
          for (const key of [...map.keys()]) if (isUnder(key, p)) map.delete(key);
        }
      });
    }
    return removed;
  }

  async move(source: string, target: string): Promise<boolean> {
    const from = await this.resolve(source);
    const to = await this.resolve(target);
    if (!(await this.base.exists(from.path))) return false;
    await this.mkdirs(parentOf(to.path), from.table, target);
    const moved = await this.base.move(from.path, to.path);
    if (!moved) return false;
    await this.mutate((t) => this.rekey(t, from.path, to.path, true));
    return true;
  }

  async copy(source: string, target: string): Promise<boolean> {
    const from = await this.resolve(source);
    const to = await this.resolve(target);
    if (!(await this.base.exists(from.path))) return false;
    await this.mkdirs(parentOf(to.path), from.table, target);
    const copied = await this.base.copy(from.path, to.path);
    if (!copied) return false;
    await this.mutate((t) => this.rekey(t, from.path, to.path, false));
    return true;
  }

  /**
   * Carries the links and modes under `from` to `to`: what the target held before (a file,
   * a link, a whole subtree) is forgotten first, then the moved entries take its place.
   */
  private rekey(table: Table, from: string, to: string, moved: boolean): void {
    for (const map of [table.links, table.modes] as Map<string, unknown>[]) {
      const carried: [string, unknown][] = [];
      for (const [key, value] of map) if (isUnder(key, from)) carried.push([key, value]);
      for (const key of [...map.keys()]) if (isUnder(key, to)) map.delete(key);
      for (const [key, value] of carried) {
        if (moved) map.delete(key);
        map.set(rebase(key, from, to), value);
      }
    }
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
