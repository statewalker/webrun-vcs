/**
 * git's loose object map (loose.c): `<objects>/loose-object-idx`, the file a repository with
 * `extensions.compatObjectFormat` keeps the other format's id of each object it writes loose
 * in. Its first line is `# loose-object-idx`, then one `<storage id> <compat id>` line per
 * object, appended under `loose-object-idx.lock` as git's `write_one_object` appends. The
 * empty tree, the empty blob and the null id are mapped without a line. A lookup that misses
 * reads the file again (another process may have written the object since), as
 * `repo_oid_to_algop` does.
 *
 * git keeps no map for packs: index-pack writes `.idx` v2 and no line here (git master too),
 * so an object only received in a pack has no compatibility id until something writes it
 * loose. gc, repack and prune leave the file alone: its lines outlive the loose objects.
 */

import type { FilesApi } from "@statewalker/vcs-core";
import type { ObjectFormat } from "@statewalker/vcs-utils/hash";

/** git's `loose_object_header` */
export const LOOSE_OBJECT_IDX_HEADER = "# loose-object-idx\n";
/** The map's file name within an objects directory */
export const LOOSE_OBJECT_IDX = "loose-object-idx";
/** git's LOOSE_OBJECT_IDX_LOCK_TIMEOUT_MS */
const LOCK_TIMEOUT_MS = 1000;

/** A map file git cannot read (`loose_object_map_read` fails) */
export class LooseObjectMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LooseObjectMapError";
  }
}

export interface LooseObjectMapOptions {
  files: FilesApi;
  /** The objects directory holding `loose-object-idx` */
  objectsDir: string;
  /** The repository's object format (`extensions.objectFormat`) */
  storage: ObjectFormat;
  /** The compatibility format (`extensions.compatObjectFormat`) */
  compat: ObjectFormat;
  /**
   * A map asked after this one (a quarantine's map reads the repository's too; writes go to
   * this one's file only)
   */
  parent?: LooseObjectMap;
}

const join = (dir: string, name: string) => (dir ? `${dir.replace(/\/+$/, "")}/${name}` : name);

/** Reads and appends one objects directory's `loose-object-idx`. */
export class LooseObjectMap {
  readonly files: FilesApi;
  readonly objectsDir: string;
  readonly storage: ObjectFormat;
  readonly compat: ObjectFormat;
  readonly parent?: LooseObjectMap;
  readonly path: string;
  private toCompatMap = new Map<string, string>();
  private toStorageMap = new Map<string, string>();
  private loaded = false;
  /** appends are made one at a time in this process */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(options: LooseObjectMapOptions) {
    this.files = options.files;
    this.objectsDir = options.objectsDir;
    this.storage = options.storage;
    this.compat = options.compat;
    if (options.parent) this.parent = options.parent;
    this.path = join(options.objectsDir, LOOSE_OBJECT_IDX);
  }

  private reserve(): void {
    // loose_object_map_load: mapped without a line in the file
    this.insert(this.storage.emptyTreeId, this.compat.emptyTreeId);
    this.insert(this.storage.emptyBlobId, this.compat.emptyBlobId);
    this.insert(this.storage.nullId, this.compat.nullId);
  }

  /** insert_loose_map: true when either direction was new */
  private insert(id: string, compatId: string): boolean {
    let inserted = false;
    if (!this.toCompatMap.has(id)) {
      this.toCompatMap.set(id, compatId);
      inserted = true;
    }
    if (!this.toStorageMap.has(compatId)) {
      this.toStorageMap.set(compatId, id);
      inserted = true;
    }
    return inserted;
  }

  /** The file's lines: `[storage id, compat id]` (none when the file is absent). */
  async entries(): Promise<Array<[string, string]>> {
    const st = await this.files.stats(this.path);
    if (st?.kind !== "file") return [];
    const chunks: Uint8Array[] = [];
    for await (const c of this.files.read(this.path)) chunks.push(c);
    const text = new TextDecoder().decode(concat(chunks));
    if (!text.startsWith(LOOSE_OBJECT_IDX_HEADER)) {
      throw new LooseObjectMapError(`unable to read loose object index ${this.path}`);
    }
    const out: Array<[string, string]> = [];
    const lines = text.slice(LOOSE_OBJECT_IDX_HEADER.length).split("\n");
    // strbuf_getline_lf: a last line without its newline still counts
    if (lines[lines.length - 1] === "") lines.pop();
    const s = this.storage.hexLength;
    const c = this.compat.hexLength;
    const hex = /^[0-9a-f]+$/;
    for (const line of lines) {
      const a = line.slice(0, s);
      const b = line.slice(s + 1);
      if (line.length !== s + 1 + c || line[s] !== " " || !hex.test(a) || !hex.test(b)) {
        throw new LooseObjectMapError(`unable to read loose object index ${this.path}`);
      }
      out.push([a, b]);
    }
    return out;
  }

  /** (Re)reads the file into memory (`loose_object_map_load`). */
  async load(): Promise<void> {
    if (!this.loaded) this.reserve();
    for (const [a, b] of await this.entries()) this.insert(a, b);
    this.loaded = true;
  }

  private async lookup(id: string, toCompat: boolean): Promise<string | undefined> {
    if (!this.loaded) await this.load();
    const map = toCompat ? this.toCompatMap : this.toStorageMap;
    let found = map.get(id);
    if (found === undefined) {
      // another process may have written the object since: read the file again
      await this.load();
      found = map.get(id);
    }
    if (found !== undefined) return found;
    return toCompat ? this.parent?.toCompat(id) : this.parent?.toStorage(id);
  }

  /** The compatibility id of `id` (a storage id), if mapped. */
  toCompat(id: string): Promise<string | undefined> {
    return this.lookup(id, true);
  }

  /** The storage id of `compatId`, if mapped. */
  toStorage(compatId: string): Promise<string | undefined> {
    return this.lookup(compatId, false);
  }

  /**
   * The mapped compatibility ids starting with `prefix` (lowercase hex), this map's and its
   * parent's: the compatibility half of git's loose object cache (`odb_source_loose_cache`,
   * which `insert_loose_map` fills with every mapped compatibility id, the reserved ones
   * too), which `get_short_oid` searches under `GET_OID_HASH_ANY`.
   */
  async compatIdsWithPrefix(prefix: string): Promise<string[]> {
    await this.load();
    const out = new Set<string>();
    for (const id of this.toStorageMap.keys()) if (id.startsWith(prefix)) out.add(id);
    if (this.parent) for (const id of await this.parent.compatIdsWithPrefix(prefix)) out.add(id);
    return [...out];
  }

  /**
   * `repo_add_loose_object_map`: records `id` ↔ `compatId`, appending a line to the file when
   * the pair is new (the header first, into an empty file), under `loose-object-idx.lock`.
   */
  add(id: string, compatId: string): Promise<void> {
    return this.addAll([[id, compatId]]);
  }

  /**
   * Records each pair as `add` does, appending the new ones in one write (a quarantine's
   * lines merged into the repository's map, as tmp-objdir's `loose_object_idx_merge`).
   */
  addAll(pairs: Iterable<readonly [string, string]>): Promise<void> {
    const run = this.writing.then(async () => {
      if (!this.loaded) await this.load();
      let lines = "";
      for (const [id, compatId] of pairs) {
        if (this.insert(id, compatId)) lines += `${id} ${compatId}\n`;
      }
      if (lines) await this.append(lines);
    });
    this.writing = run.catch(() => undefined);
    return run;
  }

  private async append(lines: string): Promise<void> {
    const lock = `${this.path}.lock`;
    const { files } = this;
    let locked = false;
    if (files.createExclusive) {
      // hold_lock_file_for_update_timeout: retried for up to a second
      const start = Date.now();
      for (;;) {
        if (await files.createExclusive(lock, [new Uint8Array(0)])) {
          locked = true;
          break;
        }
        if (Date.now() - start >= LOCK_TIMEOUT_MS) {
          throw new LooseObjectMapError(
            `Unable to create '${lock}': File exists.\n\nAnother git process seems to be running in this repository, e.g.\nan editor opened by 'git commit'. Please make sure all processes\nare terminated then try again. If it still fails, a git process\nmay have crashed in this repository earlier:\nremove the file manually to continue.`,
          );
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    try {
      const st = await files.stats(this.path);
      const empty = st?.kind !== "file" || (st.size ?? 0) === 0;
      const text = (empty ? LOOSE_OBJECT_IDX_HEADER : "") + lines;
      const bytes = new TextEncoder().encode(text);
      if (files.append) await files.append(this.path, [bytes]);
      else {
        const chunks: Uint8Array[] = [];
        if (!empty) for await (const c of files.read(this.path)) chunks.push(c);
        chunks.push(bytes);
        await files.write(this.path, [concat(chunks)]);
      }
    } finally {
      if (locked) await files.remove(lock);
    }
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
