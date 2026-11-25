import type { FilesApi, LinkStats, ObjectId } from "@statewalker/vcs-core";
import { joinPath } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils/encoding";
import { RemoteConfigStore } from "../../remote-config/index.js";
import { quotePath } from "../../results/quote-path.js";
import { gitFileOf } from "../git-hooks.js";
import { PlumbingCommand, PlumbingError } from "../plumbing-command.js";
import { humaniseBytes } from "../range-diff/index.js";
import { inLinkedWorktree, objectsDirectoryDisplay } from "./objects-directory.js";

/** What `git count-objects` counted. */
export interface CountObjectsResult {
  /** Loose objects (`count`). */
  count: number;
  /** Bytes the loose objects take on disk (`st_blocks * 512` where the storage tells it). */
  size: number;
  /** Objects in the local packs (`in-pack`, only with `-v`). */
  inPack: number;
  /** Local packs (`packs`, only with `-v`). */
  packs: number;
  /** Bytes of the local packs and their indexes (`size-pack`, only with `-v`). */
  sizePack: number;
  /** Loose objects a pack holds too (`prune-packable`, only with `-v`). */
  prunePackable: number;
  /** Files that are no object, pack or pack index (`garbage`, only with `-v`). */
  garbage: number;
  /** Their bytes (`size-garbage`, only with `-v`). */
  sizeGarbage: number;
  /** The alternate object directories, as git names them (only with `-v`). */
  alternates: string[];
}

const PACKDIR_FILE_PACK = 1;
const PACKDIR_FILE_IDX = 2;
const PACKDIR_FILE_GARBAGE = 4;

/** git's `bits_to_msg`: why a pack directory file is garbage (undefined: it is not). */
function bitsToMessage(bits: number): string | undefined {
  switch (bits) {
    case 0:
      return "no corresponding .idx or .pack";
    case PACKDIR_FILE_GARBAGE:
      return "garbage found";
    case PACKDIR_FILE_PACK:
      return "no corresponding .idx";
    case PACKDIR_FILE_IDX:
      return "no corresponding .pack";
    default:
      return undefined;
  }
}

/** The files of a linked worktree's git directory that belong to the common one (path.c). */
const LINKED_CHECKOUT_GARBAGE = [
  "branches",
  "common",
  "hooks",
  "info",
  "info/sparse-checkout",
  "logs/refs/bisect",
  "logs/refs/rewritten",
  "logs/refs/worktree",
  "lost-found",
  "objects",
  "refs",
  "refs/bisect",
  "refs/rewritten",
  "refs/worktree",
  "remotes",
  "worktrees",
  "rr-cache",
  "svn",
  "config",
  "packed-refs",
  "shallow",
];

/** A pack index as `load_idx` checks it: its version and object count, or git's error. */
export function checkPackIndex(
  bytes: Uint8Array,
  path: string,
  hashSize: number,
): { version: 1 | 2; count: number } | { error: string } {
  if (bytes.length < 4 * 256 + hashSize + hashSize)
    return { error: `index file ${path} is too small` };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let version: 1 | 2 = 1;
  if (view.getUint32(0) === 0xff744f63) {
    const v = view.getUint32(4);
    if (v !== 2)
      return {
        error: `index file ${path} is version ${v} and is not supported by this binary (try upgrading GIT to a newer version)`,
      };
    version = 2;
  }
  const fanout = version === 2 ? 8 : 0;
  let count = 0;
  for (let i = 0; i < 256; i++) {
    const n = view.getUint32(fanout + i * 4);
    if (n < count) return { error: `non-monotonic index ${path}` };
    count = n;
  }
  if (version === 1) {
    if (bytes.length !== 4 * 256 + 2 * hashSize + count * (hashSize + 4))
      return { error: `wrong index v1 file size in ${path}` };
  } else {
    const min = 8 + 4 * 256 + 2 * hashSize + count * (hashSize + 8);
    const max = min + (count ? (count - 1) * 8 : 0);
    if (bytes.length < min || bytes.length > max)
      return { error: `wrong index v2 file size in ${path}` };
  }
  return { version, count };
}

/** Whether a checked pack index lists `id` (its fan-out, then a binary search). */
function indexHas(bytes: Uint8Array, version: 1 | 2, id: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fanout = version === 2 ? 8 : 0;
  const first = id[0] as number;
  let lo = first === 0 ? 0 : view.getUint32(fanout + (first - 1) * 4);
  let hi = view.getUint32(fanout + first * 4);
  const raw = id.length;
  const at = (i: number) => (version === 2 ? fanout + 1024 + i * raw : 1024 + i * (raw + 4) + 4);
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const p = at(mid);
    let cmp = 0;
    for (let k = 0; k < raw && cmp === 0; k++) cmp = (bytes[p + k] as number) - (id[k] as number);
    if (cmp === 0) return true;
    if (cmp < 0) lo = mid + 1;
    else hi = mid;
  }
  return false;
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

async function readAll(files: FilesApi, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of files.read(path)) {
    parts.push(c);
    n += c.length;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * `git count-objects [-v] [-H]` (builtin/count-objects.c): the loose objects and their size
 * on disk; with `-v` also the local packs (`in-pack`, `packs`, `size-pack`), the loose objects
 * a pack holds too (`prune-packable`), the garbage in the object and pack directories (each
 * reported as git's `warning:` on stderr) and the alternates. Sizes are KiB, or with `-H`
 * humanised as git prints them.
 *
 * Sizes on disk come from `st_blocks` where the FilesApi reports it (`lstat().blocks`), else
 * from the file sizes. Warnings within one directory come in name order (git's in readdir
 * order).
 *
 * @example
 * ```typescript
 * const { stdout } = await git.countObjects().setVerbose(true).callOutput();
 * ```
 */
export class CountObjectsCommand extends PlumbingCommand {
  private verbose = false;
  private humanReadable = false;
  private counted?: CountObjectsResult;

  /** `-v`: every count, garbage warnings and alternates. */
  setVerbose(verbose: boolean): this {
    this.checkCallable();
    this.verbose = verbose;
    return this;
  }

  /** `-H` (`--human-readable`). */
  setHumanReadable(humanReadable: boolean): this {
    this.checkCallable();
    this.humanReadable = humanReadable;
    return this;
  }

  /** The counts of the last run. */
  getCounts(): CountObjectsResult | undefined {
    return this.counted;
  }

  protected async run(): Promise<number> {
    const objectsFile = await this.hooks.commonGitFile("objects");
    if (!objectsFile) throw new PlumbingError("fatal: count-objects needs a files repository");
    const files = objectsFile.files;
    const objectsDir = objectsFile.path;
    const display = await objectsDirectoryDisplay(this.hooks, this.workingCopy);
    const format = this.objectFormat;
    const verbose = this.verbose;
    const counts: CountObjectsResult = {
      count: 0,
      size: 0,
      inPack: 0,
      packs: 0,
      sizePack: 0,
      prunePackable: 0,
      garbage: 0,
      sizeGarbage: 0,
      alternates: [],
    };
    const lstat = async (path: string): Promise<LinkStats | undefined> => {
      const posix = files as FilesApi & { lstat?(path: string): Promise<LinkStats | undefined> };
      if (posix.lstat) return posix.lstat(path).catch(() => undefined);
      const s = await files.stats(path);
      return s ? { kind: s.kind, size: s.size ?? 0, lastModified: s.lastModified ?? 0 } : undefined;
    };
    const reportGarbage = async (bits: number, path: string, shown: string) => {
      const why = bitsToMessage(bits);
      if (!why) return;
      // stat(2)'s size: a directory's too
      const s = await lstat(path);
      if (s) counts.sizeGarbage += s.statSize ?? s.size;
      this.warn(`warning: ${why}: ${shown}`);
      counts.garbage++;
    };

    if (verbose) {
      // report_linked_checkout_garbage: common-directory files in a linked worktree's git dir
      if (await inLinkedWorktree(this.workingCopy)) {
        for (const name of LINKED_CHECKOUT_GARBAGE) {
          const file = await gitFileOf(this.workingCopy, name);
          if (file && (await file.files.stats(file.path)))
            await reportGarbage(
              PACKDIR_FILE_GARBAGE,
              file.path,
              await this.hooks.hookPathOf(file.path),
            );
        }
      }
    }

    // the local packs, loaded once (prepare_packed_git, reporting the pack directory's garbage)
    // each with its index as `load_idx` checked it (git opens it lazily, and again on every
    // look-up while it fails, printing the error each time)
    let packs:
      | {
          bytes: Uint8Array;
          checked: ReturnType<typeof checkPackIndex>;
          packSize: number;
          modified: number;
        }[]
      | undefined;
    const alternates = verbose
      ? ((await this.workingCopy.history.objects?.alternates?.list()) ?? [])
      : [];
    const preparePacks = async () => {
      if (packs) return packs;
      packs = [];
      const packDir = joinPath(objectsDir, "pack");
      const names: string[] = [];
      if ((await files.stats(packDir))?.kind === "directory")
        for await (const e of files.list(packDir)) names.push(e.name);
      names.sort();
      const listed: string[] = [];
      for (const name of names) {
        const path = joinPath(packDir, name);
        if (
          name.endsWith(".idx") &&
          (await files.stats(joinPath(packDir, `${name.slice(0, -4)}.pack`)))?.kind === "file"
        ) {
          const bytes = await readAll(files, path);
          const checked = checkPackIndex(bytes, `${display}/pack/${name}`, format.rawLength);
          const pack = await files.stats(joinPath(packDir, `${name.slice(0, -4)}.pack`));
          packs.push({
            bytes,
            checked,
            packSize: pack?.size ?? 0,
            modified: pack?.lastModified ?? 0,
          });
        }
        if (!verbose) continue;
        if (name === "multi-pack-index" || name === "multi-pack-index.d") continue;
        if (
          name.startsWith("multi-pack-index") &&
          (name.endsWith(".bitmap") || name.endsWith(".rev"))
        )
          continue;
        if (/\.(idx|rev|pack|bitmap|keep|promisor|mtimes)$/.test(name)) listed.push(name);
        else await reportGarbage(PACKDIR_FILE_GARBAGE, path, `${display}/pack/${name}`);
      }
      if (verbose) {
        // report_pack_garbage: files grouped by base name, sorted
        const report = async (bits: number, group: string[]) => {
          if (bits === (PACKDIR_FILE_PACK | PACKDIR_FILE_IDX)) return;
          for (const n of group)
            await reportGarbage(bits, joinPath(packDir, n), `${display}/pack/${n}`);
        };
        let group: string[] = [];
        let base = "";
        let bits = 0;
        for (const name of listed) {
          if (group.length > 0 && !name.startsWith(base)) {
            await report(bits, group);
            group = [];
            bits = 0;
          }
          if (group.length === 0) base = name.slice(0, name.lastIndexOf(".") + 1);
          group.push(name);
          const ext = name.slice(base.length);
          if (ext === "pack") bits |= PACKDIR_FILE_PACK;
          else if (ext === "idx") bits |= PACKDIR_FILE_IDX;
        }
        if (group.length > 0) await report(bits, group);
      }
      // sort_pack: the youngest first
      packs.sort((a, b) => b.modified - a.modified);
      return packs;
    };
    const packed = async (id: ObjectId) => {
      const raw = hexBytes(id);
      for (const p of await preparePacks()) {
        if ("error" in p.checked) this.warn(`error: ${p.checked.error}`);
        else if (indexHas(p.bytes, p.checked.version, raw)) return true;
      }
      for (const alt of alternates) if (await alt.packs.has(id).catch(() => false)) return true;
      return false;
    };

    // for_each_loose_file_in_source: count_loose, count_cruft
    const nameLength = format.hexLength - 2;
    if ((await files.stats(objectsDir))?.kind === "directory") {
      const dirs: string[] = [];
      for await (const e of files.list(objectsDir))
        if (e.kind === "directory" && /^[0-9a-f]{2}$/.test(e.name)) dirs.push(e.name);
      dirs.sort();
      for (const dir of dirs) {
        const names: string[] = [];
        for await (const e of files.list(joinPath(objectsDir, dir))) names.push(e.name);
        names.sort();
        for (const name of names) {
          const path = joinPath(objectsDir, dir, name);
          const shown = `${display}/${dir}/${name}`;
          if (name.length !== nameLength || !/^[0-9a-fA-F]+$/.test(name)) {
            if (verbose) await reportGarbage(PACKDIR_FILE_GARBAGE, path, shown);
            continue;
          }
          const s = await lstat(path);
          if (s?.kind !== "file") {
            if (verbose) await reportGarbage(PACKDIR_FILE_GARBAGE, path, shown);
            continue;
          }
          counts.size += s.blocks !== undefined ? s.blocks * 512 : s.size;
          counts.count++;
          if (verbose && (await packed(`${dir}${name}`.toLowerCase()))) counts.prunePackable++;
        }
      }
    }

    const quoteFully = (() => {
      const v = RemoteConfigStore.from(this.workingCopy).value("core.quotePath");
      return v === undefined ? true : (parseGitBool(v) ?? true);
    })();
    let text: string;
    if (verbose) {
      // repo_for_each_pack: the local packs whose index opens
      for (const p of await preparePacks()) {
        if ("error" in p.checked) {
          this.warn(`error: ${p.checked.error}`);
          continue;
        }
        counts.inPack += p.checked.count;
        counts.sizePack += p.packSize + p.bytes.length;
        counts.packs++;
      }
      const size = (n: number) =>
        this.humanReadable ? humaniseBytes(BigInt(n)) : String(Math.floor(n / 1024));
      for (const alt of alternates) counts.alternates.push(alt.path);
      text =
        `count: ${counts.count}\n` +
        `size: ${size(counts.size)}\n` +
        `in-pack: ${counts.inPack}\n` +
        `packs: ${counts.packs}\n` +
        `size-pack: ${size(counts.sizePack)}\n` +
        `prune-packable: ${counts.prunePackable}\n` +
        `garbage: ${counts.garbage}\n` +
        `size-garbage: ${size(counts.sizeGarbage)}\n` +
        counts.alternates.map((p) => `alternate: ${quotePath(p, quoteFully)}\n`).join("");
    } else {
      const size = this.humanReadable
        ? humaniseBytes(BigInt(counts.size))
        : `${Math.floor(counts.size / 1024)} kilobytes`;
      text = `${counts.count} objects, ${size}\n`;
    }
    this.counted = counts;
    await this.write(text);
    return 0;
  }
}
