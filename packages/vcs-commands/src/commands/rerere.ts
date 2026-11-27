/**
 * git's rerere (rerere.c): conflicts recorded in `rr-cache/<conflict id>/` (`preimage`,
 * `postimage`, `thisimage`, a variant's `preimage.<n>`...) and the paths waiting for their
 * resolution in `MERGE_RR` (`<id>[.<variant>]\t<path>\0`, sorted by path), in git's format
 * byte for byte, so native git replays what ours recorded and the reverse.
 *
 * @example
 * ```typescript
 * // after a merge left conflicts in the index and the worktree (what `suggest_conflicts` runs)
 * const { messages } = await runRerere(rerereHostOf(workingCopy, staging, worktree, blobs, format));
 * // ["Recorded preimage for 'f'"], or ["Resolved 'f' using previous resolution."]
 * ```
 *
 * The conflict id is the hash (the repository's) of each conflict hunk's two sides, the
 * smaller first, each followed by a NUL (`handle_path`); the preimage is the conflicted file
 * with every hunk normalised (`<<<<<<<`, the sides in that order, no common ancestor's part).
 * A recorded resolution is replayed as a three-way merge (`ll_merge`, Myers) of the preimage,
 * the file now and the postimage.
 */

import type { Blobs, ObjectId } from "@statewalker/vcs-core";
import type { ObjectFormat } from "@statewalker/vcs-utils";
import { decodeGitPath, encodeGitPath, parseGitBool } from "@statewalker/vcs-utils/encoding";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import { joinPath } from "@statewalker/vcs-utils/files";
import type { Staging, WorkingCopy, Worktree } from "@statewalker/vcs-working-tree";
import type { RerereEngine, RerereReplay } from "@statewalker/vcs-working-tree/transformation";

import { conflictMarkerSizeOf } from "../results/diff-check.js";
import { worktreeModeTrust } from "./core-config.js";
import { commonGitFileOf } from "./git-hooks.js";
import { IndexAdder } from "./index-adder.js";
import { configValue, conflictStyleOf } from "./merge-config.js";
import { lowLevelMerge, ortConfigOptions } from "./merge-drivers.js";
import type { MergeAttributes } from "./ort-merge.js";
import { worktreePathRules } from "./worktree-path-rules.js";

const RR_HAS_POSTIMAGE = 1;
const RR_HAS_PREIMAGE = 2;
const BOTH = RR_HAS_POSTIMAGE | RR_HAS_PREIMAGE;

/** What rerere works on: the working copy's config and state, its index, worktree and blobs. */
export interface RerereHost {
  workingCopy: WorkingCopy;
  staging: Staging;
  worktree: Worktree;
  blobs: Blobs;
  objectFormat: ObjectFormat;
}

/** What a rerere run printed on stderr, line by line. */
export interface RerereOutcome {
  messages: string[];
  /** Whether rerere is enabled (`rerere.enabled`, or unset and `rr-cache/` there) */
  enabled: boolean;
}

/** `git rerere` died: its stderr lines (the last `fatal:`), exit status 128. */
export class RerereError extends Error {
  readonly exitCode = 128;
  constructor(readonly lines: string[]) {
    super(lines.join("\n"));
    this.name = "RerereError";
  }
}

/** A conflict's directory (`rerere_dir`): the status bits of each variant. */
interface RerereDir {
  hex: string;
  status: number[];
}

/** A conflict id and the variant a path uses (`rerere_id`; -1: not known yet). */
interface RerereId {
  dir: RerereDir;
  variant: number;
}

/** A sorted string list of paths (git's `string_list`, strcmp order) to their ids. */
type MergeRr = Map<string, RerereId | null>;

const enc = (s: string) => encodeGitPath(s);

/** strcmp over git's bytes. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

const comparePaths = (a: string, b: string) => compareBytes(enc(a), enc(b));

function sortedPaths(rr: MergeRr): string[] {
  return [...rr.keys()].sort(comparePaths);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const isDigit = (c: number | undefined) => c !== undefined && c >= 0x30 && c <= 0x39;

/** git's sane ctype isspace: `\t`, `\n`, `\r` and the space. */
const isSpace = (c: number | undefined) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/** `is_cmarker`: `size` times `ch`, then (for `<` and `>`) a space, else any space. */
function isMarker(line: Uint8Array, ch: number, size: number): boolean {
  for (let i = 0; i < size; i++) if (line[i] !== ch) return false;
  const next = line[size];
  if ((ch === 0x3c || ch === 0x3e) && next !== 0x20) return false;
  return isSpace(next);
}

/** The lines of `bytes`, each with its LF (the last one without, when the file lacks it). */
class LineReader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  next(): Uint8Array | undefined {
    if (this.at >= this.bytes.length) return undefined;
    const nl = this.bytes.indexOf(0x0a, this.at);
    const end = nl < 0 ? this.bytes.length : nl + 1;
    const line = this.bytes.subarray(this.at, end);
    this.at = end;
    return line;
  }
}

/** A hash being built from hunk sides (`ctx`). */
interface HunkHasher {
  update(data: Uint8Array): unknown;
}

const NUL = new Uint8Array([0]);

function markerLine(ch: number, size: number): Uint8Array {
  const out = new Uint8Array(size + 1).fill(ch);
  out[size] = 0x0a;
  return out;
}

/** `handle_conflict`: one hunk (after its `<` line), normalised into `out`. */
function handleConflict(
  io: LineReader,
  out: Uint8Array[],
  size: number,
  hasher: HunkHasher | undefined,
): number {
  const SIDE_1 = 0;
  const SIDE_2 = 1;
  const ORIGINAL = 2;
  let hunk = SIDE_1;
  let one: Uint8Array[] = [];
  let two: Uint8Array[] = [];
  let status = -1;
  for (let line = io.next(); line; line = io.next()) {
    if (isMarker(line, 0x3c, size)) {
      const nested: Uint8Array[] = [];
      if (handleConflict(io, nested, size, undefined) < 0) break;
      if (hunk === SIDE_1) one.push(...nested);
      else two.push(...nested);
    } else if (isMarker(line, 0x7c, size)) {
      if (hunk !== SIDE_1) break;
      hunk = ORIGINAL;
    } else if (isMarker(line, 0x3d, size)) {
      if (hunk !== SIDE_1 && hunk !== ORIGINAL) break;
      hunk = SIDE_2;
    } else if (isMarker(line, 0x3e, size)) {
      if (hunk !== SIDE_2) break;
      let a = concat(one);
      let b = concat(two);
      if (compareBytes(a, b) > 0) [a, b] = [b, a];
      [one, two] = [[a], [b]];
      status = 1;
      out.push(markerLine(0x3c, size), a, markerLine(0x3d, size), b, markerLine(0x3e, size));
      if (hasher) {
        hasher.update(a);
        hasher.update(NUL);
        hasher.update(b);
        hasher.update(NUL);
      }
      break;
    } else if (hunk === SIDE_1) one.push(line);
    else if (hunk === SIDE_2) two.push(line);
    // the common ancestor's lines are dropped
  }
  return status;
}

/** What {@link normalizeConflicts} found. */
export interface NormalizedConflicts {
  /** `handle_path`'s result: 1 when the last hunk parsed, 0 without any, -1 on a bad one */
  status: number;
  /** The conflict id (hex), when asked for */
  id?: string;
  /** The file with its hunks normalised, as far as it was parsed */
  output: Uint8Array;
}

/**
 * git's `handle_path` over a file's bytes: the hunks normalised, their sides hashed into the
 * conflict id.
 */
export function normalizeConflicts(
  content: Uint8Array,
  markerSize: number,
  format?: ObjectFormat,
): NormalizedConflicts {
  const io = new LineReader(content);
  const hasher = format?.createHasher();
  const out: Uint8Array[] = [];
  let status = 0;
  for (let line = io.next(); line; line = io.next()) {
    if (isMarker(line, 0x3c, markerSize)) {
      const hunk: Uint8Array[] = [];
      status = handleConflict(io, hunk, markerSize, hasher);
      if (status < 0) break;
      out.push(...hunk);
    } else out.push(line);
  }
  const result: NormalizedConflicts = { status, output: concat(out) };
  if (hasher) {
    result.id = Array.from(hasher.digest(), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return result;
}

/** The files of `rr-cache/` and the stderr lines a run collects. */
class RerereRun {
  readonly messages: string[] = [];
  private readonly dirs = new Map<string, RerereDir>();
  readonly attributes: Partial<ReturnType<typeof ortConfigOptions>>;

  constructor(
    readonly host: RerereHost,
    readonly files: FilesApi,
    /** `rr-cache` as the FilesApi names it */
    readonly cache: string,
  ) {
    this.attributes = ortConfigOptions(host.workingCopy, host.worktree, {
      indexAttributes: true,
    });
  }

  error(message: string): void {
    this.messages.push(`error: ${message}`);
  }

  path(id: RerereId, file?: string): string {
    const dir = joinPath(this.cache, id.dir.hex);
    if (file === undefined) return dir;
    return joinPath(dir, id.variant <= 0 ? file : `${file}.${id.variant}`);
  }

  async attributesOf(path: string): Promise<MergeAttributes> {
    return (await this.attributes.attributes?.(path)) ?? {};
  }

  async markerSize(path: string): Promise<number> {
    const value = (await this.attributesOf(path)).conflictMarkerSize;
    return conflictMarkerSizeOf(typeof value === "string" ? value : undefined);
  }

  /** `find_rerere_dir`: the conflict's directory, its variants scanned once. */
  async dir(hex: string): Promise<RerereDir> {
    let dir = this.dirs.get(hex);
    if (dir) return dir;
    dir = { hex, status: [] };
    this.dirs.set(hex, dir);
    const path = joinPath(this.cache, hex);
    if ((await this.files.stats(path))?.kind === "directory") {
      for await (const entry of this.files.list(path)) {
        const post = variantOf(entry.name, "postimage");
        if (post !== undefined) {
          fit(dir, post);
          dir.status[post] = (dir.status[post] ?? 0) | RR_HAS_POSTIMAGE;
          continue;
        }
        const pre = variantOf(entry.name, "preimage");
        if (pre !== undefined) {
          fit(dir, pre);
          dir.status[pre] = (dir.status[pre] ?? 0) | RR_HAS_PREIMAGE;
        }
      }
    }
    return dir;
  }

  async newId(hex: string): Promise<RerereId> {
    return { dir: await this.dir(hex), variant: -1 };
  }

  async readFile(path: string): Promise<Uint8Array | undefined> {
    if ((await this.files.stats(path))?.kind !== "file") return undefined;
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.files.read(path)) chunks.push(chunk);
    return concat(chunks);
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    await this.files.write(path, [content]);
  }

  async unlink(path: string): Promise<boolean> {
    if ((await this.files.stats(path))?.kind !== "file") return false;
    return this.files.remove(path);
  }

  async mkdir(path: string): Promise<void> {
    if ((await this.files.stats(path))?.kind !== "directory") await this.files.mkdir(path);
  }

  /** git's `rmdir`: only an empty directory goes. */
  async rmdir(path: string): Promise<void> {
    if ((await this.files.stats(path))?.kind !== "directory") return;
    for await (const _ of this.files.list(path)) return;
    await this.files.remove(path);
  }

  /** The worktree file as `fopen` reads it, or the error line git prints. */
  async readWorktree(path: string): Promise<Uint8Array | undefined> {
    const entry = await this.host.worktree.getEntry(path).catch(() => undefined);
    if (!entry) {
      this.error(`could not open '${path}': No such file or directory`);
      return undefined;
    }
    if (entry.isDirectory) {
      this.error(`could not open '${path}': Is a directory`);
      return undefined;
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.host.worktree.readContent(path)) chunks.push(chunk);
    return concat(chunks);
  }

  /**
   * `handle_file`: the worktree file's conflicts (1, 0 without any, -1 on an error); with
   * `output`, its normalised form written there.
   */
  async handleFile(
    path: string,
    wantId: boolean,
    output?: string,
  ): Promise<{ status: number; id?: string }> {
    const content = await this.readWorktree(path);
    if (!content) return { status: -1 };
    return this.handleBytes(path, content, wantId, output);
  }

  async handleBytes(
    path: string,
    content: Uint8Array,
    wantId: boolean,
    output?: string,
  ): Promise<{ status: number; id?: string }> {
    const parsed = normalizeConflicts(
      content,
      await this.markerSize(path),
      wantId ? this.host.objectFormat : undefined,
    );
    if (parsed.status < 0) {
      // the output written so far is unlinked again
      if (output) await this.unlink(output);
      this.error(`could not parse conflict hunks in '${path}'`);
      return { status: -1 };
    }
    if (output) await this.writeFile(output, parsed.output);
    return { status: parsed.status, ...(parsed.id ? { id: parsed.id } : {}) };
  }

  /** `try_merge`: the recorded resolution replayed onto `current`; undefined on a conflict. */
  async tryMerge(id: RerereId, path: string, current: Uint8Array): Promise<Uint8Array | undefined> {
    const base = await this.readFile(this.path(id, "preimage"));
    const other = await this.readFile(this.path(id, "postimage"));
    if (!base || !other) return undefined;
    const a = this.attributes;
    const merged = await lowLevelMerge(
      {
        path,
        base,
        ours: current,
        theirs: other,
        baseLabel: "",
        oursLabel: "",
        theirsLabel: "",
      },
      {
        attributes: await this.attributesOf(path),
        ...(a.drivers ? { drivers: a.drivers } : {}),
        ...(a.defaultDriver ? { defaultDriver: a.defaultDriver } : {}),
        ...(a.driverCommand ? { driverCommand: a.driverCommand } : {}),
        ...(a.configuredDriver ? { configuredDriver: a.configuredDriver } : {}),
        style: conflictStyleOf(this.host.workingCopy),
        algorithm: "myers",
      },
    );
    return merged.status === "ok" ? merged.content : undefined;
  }

  /** `merge`: replays variant `id` onto the worktree file; whether it applied. */
  async merge(id: RerereId, path: string): Promise<boolean> {
    const thisimage = this.path(id, "thisimage");
    const { status } = await this.handleFile(path, false, thisimage);
    if (status < 0) return false;
    const current = await this.readFile(thisimage);
    if (!current) return false;
    const result = await this.tryMerge(id, path, current);
    if (!result) return false;
    await this.writeReplayed(id, path, result);
    return true;
  }

  /** The end of `merge`: a replayed resolution written to the worktree. */
  async writeReplayed(id: RerereId, path: string, result: Uint8Array): Promise<void> {
    // the resolution was used: its mtime tells rerere gc
    const postimage = this.path(id, "postimage");
    if (!(await this.files.touch?.(postimage))) {
      const bytes = await this.readFile(postimage);
      if (bytes) await this.writeFile(postimage, bytes);
    }
    const entry = await this.host.worktree.getEntry(path).catch(() => undefined);
    await this.host.worktree.writeContent(path, result, {
      raw: true,
      ...(entry && !entry.isDirectory ? { mode: entry.mode } : {}),
    });
  }

  /** `remove_variant`. */
  async removeVariant(id: RerereId): Promise<void> {
    await this.unlink(this.path(id, "postimage"));
    await this.unlink(this.path(id, "preimage"));
    id.dir.status[id.variant] = 0;
  }

  /** `assign_variant`: the first free variant for a new id. */
  assignVariant(id: RerereId): void {
    let variant = id.variant;
    if (variant < 0) {
      for (variant = 0; variant < id.dir.status.length; variant++) {
        if (!id.dir.status[variant]) break;
      }
    }
    fit(id.dir, variant);
    id.variant = variant;
  }

  /** `read_rr`. */
  async readRr(): Promise<MergeRr> {
    const rr: MergeRr = new Map();
    const bytes = await this.host.workingCopy.checkout.readStateFile?.("MERGE_RR");
    if (!bytes) return rr;
    const hexLength = this.host.objectFormat.hexLength;
    let at = 0;
    while (at < bytes.length) {
      let end = bytes.indexOf(0, at);
      if (end < 0) end = bytes.length;
      const record = bytes.subarray(at, end);
      at = end + 1;
      const corrupt = () => new RerereError(["fatal: corrupt MERGE_RR"]);
      if (record.length < hexLength + 2) throw corrupt();
      const hex = new TextDecoder().decode(record.subarray(0, hexLength));
      if (!/^[0-9a-fA-F]+$/.test(hex)) throw corrupt();
      let rest: number = hexLength;
      let variant = 0;
      if (record[rest] === 0x2e) {
        let digits = rest + 1;
        while (isDigit(record[digits])) {
          digits++;
        }
        variant = Number.parseInt(new TextDecoder().decode(record.subarray(rest + 1, digits)), 10);
        if (Number.isNaN(variant)) variant = 0;
        rest = digits;
      }
      if (record[rest] !== 0x09) throw corrupt();
      const path = decodeGitPath(record.subarray(rest + 1));
      const dir = await this.dir(hex.toLowerCase());
      fit(dir, variant);
      rr.set(path, { dir, variant });
    }
    return rr;
  }

  /** `write_rr`: every path still waiting, in path order. */
  async writeRr(rr: MergeRr): Promise<void> {
    const parts: Uint8Array[] = [];
    for (const path of sortedPaths(rr)) {
      const id = rr.get(path);
      if (!id) continue;
      const name = id.variant > 0 ? `${id.dir.hex}.${id.variant}` : id.dir.hex;
      parts.push(enc(`${name}\t`), enc(path), NUL);
    }
    await this.host.workingCopy.checkout.writeStateFile?.("MERGE_RR", concat(parts));
  }

  /** `has_rerere_resolution`. */
  hasResolution(id: RerereId): boolean {
    if (id.variant < 0) return false;
    return ((id.dir.status[id.variant] ?? 0) & BOTH) === BOTH;
  }
}

function fit(dir: RerereDir, variant: number): void {
  while (dir.status.length <= variant) dir.status.push(0);
}

/** `is_rr_file`: `file` (variant 0) or `file.<n>`. */
function variantOf(name: string, file: string): number | undefined {
  if (name === file) return 0;
  if (!name.startsWith(`${file}.`)) return undefined;
  const rest = name.slice(file.length + 1);
  if (!/^\s*[-+]?\d+$/.test(rest)) return undefined;
  const n = Number.parseInt(rest, 10);
  return n >= 0 ? n : undefined;
}

/** Whether `rerere.enabled` asks for rerere (`-1`: unset, then `rr-cache/` decides). */
function enabledSetting(workingCopy: WorkingCopy): number {
  const value = configValue(workingCopy, "rerere.enabled");
  if (value === undefined) return -1;
  return parseGitBool(value) === false ? 0 : 1;
}

/**
 * `setup_rerere` (`is_rerere_enabled`): the run over `rr-cache/`, created where
 * `rerere.enabled` is true; undefined where rerere is off (or the working copy keeps no
 * git directory).
 */
async function setupRerere(host: RerereHost): Promise<RerereRun | undefined> {
  const enabled = enabledSetting(host.workingCopy);
  if (!enabled) return undefined;
  if (typeof host.workingCopy.checkout.writeStateFile !== "function") return undefined;
  const location = await commonGitFileOf(host.workingCopy, "rr-cache");
  if (!location) return undefined;
  const exists = (await location.files.stats(location.path))?.kind === "directory";
  if (enabled < 0 && !exists) return undefined;
  if (!exists) await location.files.mkdir(location.path);
  return new RerereRun(host, location.files, location.path);
}

/** One conflicted path of the index (`check_one_conflict`). */
type ConflictKind = "resolved" | "punted" | "three-staged";

/** The index's paths by kind, in index order (`find_conflict`, `rerere_remaining`). */
async function indexConflicts(
  staging: Staging,
  override?: Map<string, Array<{ stage: number; mode: number; objectId: ObjectId }>>,
): Promise<Array<{ path: string; kind: ConflictKind }>> {
  const byPath = new Map<string, Array<{ stage: number; mode: number }>>();
  const order: string[] = [];
  for await (const entry of staging.entries()) {
    if (override?.has(entry.path)) continue;
    let list = byPath.get(entry.path);
    if (!list) {
      list = [];
      byPath.set(entry.path, list);
      order.push(entry.path);
    }
    list.push({ stage: entry.stage, mode: entry.mode });
  }
  for (const [path, entries] of override ?? []) {
    byPath.set(path, entries);
    order.push(path);
  }
  const out: Array<{ path: string; kind: ConflictKind }> = [];
  const isRegular = (mode: number | undefined) =>
    mode !== undefined && (mode & 0o170000) === 0o100000;
  for (const path of order) {
    const entries = byPath.get(path) ?? [];
    if (entries.some((e) => e.stage === 0)) {
      out.push({ path, kind: "resolved" });
      continue;
    }
    const ours = entries.find((e) => e.stage === 2);
    const theirs = entries.find((e) => e.stage === 3);
    out.push({
      path,
      kind:
        ours && theirs && isRegular(ours.mode) && isRegular(theirs.mode)
          ? "three-staged"
          : "punted",
    });
  }
  return out;
}

/**
 * git's `rerere()` (`do_plain_rerere`), as the merge family runs it on conflicts and `git
 * commit` after its commit: each conflicted path's preimage recorded or a recorded
 * resolution replayed, each resolved path's postimage recorded, `MERGE_RR` rewritten.
 * `autoUpdate` is `--rerere-autoupdate` / `--no-rerere-autoupdate` (else
 * `rerere.autoUpdate`): replayed resolutions are staged.
 */
export async function runRerere(
  host: RerereHost,
  options: { autoUpdate?: boolean } = {},
): Promise<RerereOutcome> {
  const run = await setupRerere(host);
  if (!run) return { messages: [], enabled: false };
  const autoUpdate =
    options.autoUpdate ??
    parseGitBool(configValue(host.workingCopy, "rerere.autoUpdate") ?? "false") ??
    false;
  const rr = await run.readRr();

  const conflicts = (await indexConflicts(host.staging))
    .filter((c) => c.kind === "three-staged")
    .map((c) => c.path)
    .sort(comparePaths);
  for (const path of conflicts) {
    const { status, id: hex } = await run.handleFile(path, true);
    if (status !== 0 && rr.has(path)) {
      const old = rr.get(path);
      if (old) await run.removeVariant(old);
      rr.delete(path);
    }
    if (status < 1 || !hex) continue;
    rr.set(path, await run.newId(hex));
    await run.mkdir(run.path({ dir: await run.dir(hex), variant: 0 }));
  }

  const update: string[] = [];
  for (const path of sortedPaths(rr)) {
    const id = rr.get(path);
    if (!id) continue;
    if (await doRerereOnePath(run, path, id, update, autoUpdate)) rr.set(path, null);
  }
  if (update.length > 0) await updatePaths(run, update);
  await run.writeRr(rr);
  return { messages: run.messages, enabled: true };
}

/** `do_rerere_one_path`; true when the path is done with (resolved or replayed). */
async function doRerereOnePath(
  run: RerereRun,
  path: string,
  id: RerereId,
  update: string[],
  autoUpdate: boolean,
): Promise<boolean> {
  const dir = id.dir;
  // has the user resolved it already?
  if (id.variant >= 0) {
    if ((await run.handleFile(path, false)).status === 0) {
      const postimage = run.path(id, "postimage");
      // copy_file: O_EXCL, an existing postimage stays
      if ((await run.files.stats(postimage)) === undefined) {
        const content = await run.readWorktree(path);
        if (content) await run.writeFile(postimage, content);
      }
      fit(dir, id.variant);
      dir.status[id.variant] = (dir.status[id.variant] ?? 0) | RR_HAS_POSTIMAGE;
      run.messages.push(`Recorded resolution for '${path}'.`);
      return true;
    }
  }
  // does any existing resolution apply cleanly?
  for (let variant = 0; variant < dir.status.length; variant++) {
    if (((dir.status[variant] ?? 0) & BOTH) !== BOTH) continue;
    if (!(await run.merge({ dir, variant }, path))) continue;
    // a different variant applies cleanly: no point keeping our own
    if (id.variant >= 0 && id.variant !== variant) await run.removeVariant(id);
    if (autoUpdate) update.push(path);
    else run.messages.push(`Resolved '${path}' using previous resolution.`);
    return true;
  }
  // none applies: a new variant
  run.assignVariant(id);
  await run.handleFile(path, false, run.path(id, "preimage"));
  if ((dir.status[id.variant] ?? 0) & RR_HAS_POSTIMAGE) {
    await run.unlink(run.path(id, "postimage"));
    dir.status[id.variant] = (dir.status[id.variant] ?? 0) & ~RR_HAS_POSTIMAGE;
  }
  dir.status[id.variant] = (dir.status[id.variant] ?? 0) | RR_HAS_PREIMAGE;
  run.messages.push(`Recorded preimage for '${path}'`);
  return false;
}

/** `update_paths`: the replayed files staged (`add_file_to_index`). */
async function updatePaths(run: RerereRun, paths: string[]): Promise<void> {
  const { staging, worktree, blobs, workingCopy } = run.host;
  const adder = await IndexAdder.open(staging, blobs, worktreeModeTrust(workingCopy, worktree), {
    pathRules: worktreePathRules(workingCopy),
  });
  for (const path of paths.sort(comparePaths)) {
    const entry = await worktree.getEntry(path);
    if (entry) await adder.add(worktree, path, entry);
    run.messages.push(`Staged '${path}' using previous resolution.`);
  }
  await adder.finish();
  await staging.write();
}

/**
 * `rerere_clear` (`git rerere clear`, `rebase --skip`/`--abort`, `am --skip`/`--abort`): the
 * waiting paths' records without a resolution removed, `MERGE_RR` deleted.
 */
export async function rerereClear(host: RerereHost): Promise<RerereOutcome> {
  const run = await setupRerere(host);
  if (!run) return { messages: [], enabled: false };
  const rr = await run.readRr();
  for (const path of sortedPaths(rr)) {
    const id = rr.get(path);
    if (!id || run.hasResolution(id)) continue;
    // unlink_rr_item
    await run.unlink(run.path(id, "thisimage"));
    await run.removeVariant(id);
    await run.rmdir(run.path(id));
  }
  await host.workingCopy.checkout.removeStateFile?.("MERGE_RR");
  return { messages: run.messages, enabled: true };
}

/** `git rerere status`: the paths `MERGE_RR` lists. */
export async function rerereStatus(host: RerereHost): Promise<string[]> {
  const run = await setupRerere(host);
  if (!run) return [];
  return sortedPaths(await run.readRr());
}

/**
 * `git rerere remaining`: the paths `MERGE_RR` lists that the index has not resolved, and
 * the conflicts rerere cannot handle (not two regular files), in path order.
 */
export async function rerereRemaining(host: RerereHost): Promise<string[]> {
  const run = await setupRerere(host);
  if (!run) return [];
  const rr = await run.readRr();
  const resolved = new Set<string>();
  for (const { path, kind } of await indexConflicts(host.staging)) {
    if (kind === "punted") {
      if (!rr.has(path)) rr.set(path, null);
    } else if (kind === "resolved" && rr.has(path)) resolved.add(path);
  }
  return sortedPaths(rr).filter((p) => !resolved.has(p));
}

/**
 * `git rerere diff`: for each path `MERGE_RR` lists, the diff from its preimage to the
 * worktree file (`diff_two`, xdiff with 3 lines of context, no function names).
 */
export async function rerereDiff(
  host: RerereHost,
  diff: (minus: Uint8Array, plus: Uint8Array) => Uint8Array,
): Promise<{ stdout: Uint8Array[]; fatal?: string }> {
  const run = await setupRerere(host);
  const stdout: Uint8Array[] = [];
  if (!run) return { stdout };
  const rr = await run.readRr();
  for (const path of sortedPaths(rr)) {
    const id = rr.get(path);
    if (!id) continue;
    const minus = await run.readFile(run.path(id, "preimage"));
    const entry = await host.worktree.getEntry(path).catch(() => undefined);
    let plus: Uint8Array | undefined;
    if (entry && !entry.isDirectory) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of host.worktree.readContent(path)) chunks.push(chunk);
      plus = concat(chunks);
    }
    if (!minus || !plus) {
      return { stdout, fatal: `unable to generate diff for '${gitPathOf(run, id)}'` };
    }
    stdout.push(enc(`--- a/${path}\n+++ b/${path}\n`), diff(minus, plus));
  }
  return { stdout };
}

/** `git_path("rr-cache/<hex>")` as git prints it (the git directory is `.git` there). */
function gitPathOf(_run: RerereRun, id: RerereId): string {
  return `.git/rr-cache/${id.dir.hex}`;
}

/** A path's stages for `rerere forget` (the index's, or restored from resolve-undo). */
type Stages = Array<{ stage: number; mode: number; objectId: ObjectId }>;

/**
 * `git rerere forget <pathspec>` (`rerere_forget`): the paths' conflicts recreated from the
 * index (resolved ones from its resolve-undo records, in memory only), the resolution that
 * replays cleanly onto each removed and its preimage written again, the path waiting in
 * `MERGE_RR` once more.
 */
export async function rerereForget(
  host: RerereHost,
  matches: (path: string) => boolean,
): Promise<RerereOutcome> {
  const run = await setupRerere(host);
  if (!run) return { messages: [], enabled: false };
  const rr = await run.readRr();
  // unmerge_index: the resolve-undo records of the matching paths as conflict stages
  const override = new Map<string, Stages>();
  for (const record of host.staging.getResolveUndo?.() ?? []) {
    if (!matches(record.path)) continue;
    const stages: Stages = [];
    for (let i = 0; i < 3; i++) {
      const mode = record.modes[i] ?? 0;
      const objectId = record.objectIds[i];
      if (mode && objectId) stages.push({ stage: i + 1, mode, objectId });
    }
    override.set(record.path, stages);
  }
  const stagesOf = async (path: string): Promise<Stages> => {
    const restored = override.get(path);
    if (restored) return restored;
    return (await host.staging.getEntries(path)).map((e) => ({
      stage: e.stage,
      mode: e.mode,
      objectId: e.objectId,
    }));
  };
  const conflicts = (await indexConflicts(host.staging, override))
    .filter((c) => c.kind === "three-staged")
    .map((c) => c.path)
    .sort(comparePaths);
  for (const path of conflicts) {
    if (!matches(path)) continue;
    await forgetOnePath(run, path, await stagesOf(path), rr);
  }
  await run.writeRr(rr);
  return { messages: run.messages, enabled: true };
}

/** `handle_cache`: the conflict recreated from the stages (ll_merge), handled as a file. */
async function handleCache(
  run: RerereRun,
  path: string,
  stages: Stages,
  output?: string,
): Promise<{ status: number; id?: string; output?: Uint8Array }> {
  if (stages.some((s) => s.stage === 0)) return { status: -1 };
  const read = async (stage: number): Promise<Uint8Array> => {
    const entry = stages.find((s) => s.stage === stage);
    if (!entry) return new Uint8Array(0);
    const chunks: Uint8Array[] = [];
    const stream = await run.host.blobs.load(entry.objectId);
    if (stream) for await (const chunk of stream) chunks.push(chunk);
    return concat(chunks);
  };
  const a = run.attributes;
  const merged = await lowLevelMerge(
    {
      path,
      base: await read(1),
      ours: await read(2),
      theirs: await read(3),
      baseLabel: "",
      oursLabel: "ours",
      theirsLabel: "theirs",
    },
    {
      attributes: await run.attributesOf(path),
      ...(a.drivers ? { drivers: a.drivers } : {}),
      ...(a.defaultDriver ? { defaultDriver: a.defaultDriver } : {}),
      ...(a.driverCommand ? { driverCommand: a.driverCommand } : {}),
      ...(a.configuredDriver ? { configuredDriver: a.configuredDriver } : {}),
      style: conflictStyleOf(run.host.workingCopy),
      algorithm: "myers",
    },
  );
  const parsed = normalizeConflicts(
    merged.content,
    await run.markerSize(path),
    run.host.objectFormat,
  );
  if (output) await run.writeFile(output, parsed.output);
  return { status: parsed.status, output: parsed.output, ...(parsed.id ? { id: parsed.id } : {}) };
}

/** `rerere_forget_one_path`. */
async function forgetOnePath(
  run: RerereRun,
  path: string,
  stages: Stages,
  rr: MergeRr,
): Promise<void> {
  const { status, id: hex } = await handleCache(run, path, stages);
  if (status < 1 || !hex) {
    run.error(`could not parse conflict hunks in '${path}'`);
    return;
  }
  const id = await run.newId(hex);
  for (id.variant = 0; id.variant < id.dir.status.length; id.variant++) {
    if (!run.hasResolution(id)) continue;
    const thisimage = run.path(id, "thisimage");
    await handleCache(run, path, stages, thisimage);
    const current = await run.readFile(thisimage);
    if (!current) {
      run.error(`failed to update conflicted state in '${path}'`);
      return;
    }
    if (await run.tryMerge(id, path, current)) break;
  }
  if (id.dir.status.length <= id.variant) {
    run.error(`no remembered resolution for '${path}'`);
    return;
  }
  if (!(await run.unlink(run.path(id, "postimage")))) {
    run.error(`no remembered resolution for '${path}'`);
    return;
  }
  await handleCache(run, path, stages, run.path(id, "preimage"));
  run.messages.push(`Updated preimage for '${path}'`);
  rr.set(path, id);
  run.messages.push(`Forgot resolution for '${path}'`);
}

/** The {@link RerereHost} of a working copy. */
export function rerereHostOf(
  workingCopy: WorkingCopy,
  staging: Staging,
  worktree: Worktree,
  blobs: Blobs,
  objectFormat: ObjectFormat,
): RerereHost {
  return { workingCopy, staging, worktree, blobs, objectFormat };
}

/** Where rr-cache lives for `git rerere gc`: the FilesApi and the common git directory. */
export async function rerereGcLocation(
  workingCopy: WorkingCopy,
): Promise<{ files: FilesApi; gitDir: string } | undefined> {
  const location = await commonGitFileOf(workingCopy, "rr-cache");
  if (!location) return undefined;
  return { files: location.files, gitDir: location.path.replace(/\/?rr-cache$/, "") || "." };
}

/** `check_one_conflict`'s three-staged conflict: no stage 0, ours and theirs regular files. */
function threeStaged(stages: Stages): boolean {
  if (stages.length === 0 || stages.some((s) => s.stage === 0)) return false;
  const isRegular = (mode: number | undefined) =>
    mode !== undefined && (mode & 0o170000) === 0o100000;
  return (
    isRegular(stages.find((s) => s.stage === 2)?.mode) &&
    isRegular(stages.find((s) => s.stage === 3)?.mode)
  );
}

async function stagesOf(staging: Staging, path: string): Promise<Stages> {
  return (await staging.getEntries(path)).map((e) => ({
    stage: e.stage,
    mode: e.mode,
    objectId: e.objectId,
  }));
}

/**
 * rerere for a resolution store (`ResolutionStore` of vcs-store-files): its records are
 * git's, written by rerere.c's steps only.
 *
 * `record(path)` is what two `git rerere` runs record for a path, one while it was
 * conflicted and one once resolved: the preimage recreated from the stages as `rerere
 * forget` recreates it (`handle_cache`), the variant `MERGE_RR` names for the path, else the
 * one holding that preimage, else a new one (`assign_variant`), then the worktree file as
 * the postimage (`copy_file`: an existing one stays) and the path dropped from `MERGE_RR`.
 * `replay(path)` is `do_rerere_one_path`'s replay over the conflicted worktree file.
 * Nothing is written where rerere is off (`setup_rerere`).
 *
 * @example
 * ```typescript
 * const engine = rerereEngineOf(rerereHostOf(workingCopy, staging, worktree, blobs, format));
 * await engine.record("f"); // "<conflict id>"
 * ```
 */
export function rerereEngineOf(host: RerereHost): RerereEngine {
  return {
    record: (path) => recordOnePath(host, path),
    replay: (path, options) => replayOnePath(host, path, options?.apply === true),
  };
}

async function recordOnePath(host: RerereHost, path: string): Promise<string | undefined> {
  const run = await setupRerere(host);
  if (!run) return undefined;
  // resolved in the worktree: no conflict hunk left (handle_file's 0)
  if ((await run.handleFile(path, false)).status !== 0) return undefined;
  const rr = await run.readRr();
  const waiting = rr.get(path);
  let id: RerereId;
  if (waiting && waiting.variant >= 0) {
    // the id and variant `git rerere` gave the conflict (do_rerere_one_path's first step)
    id = waiting;
  } else {
    const stages = await stagesOf(host.staging, path);
    if (!threeStaged(stages)) return undefined;
    const { status, id: hex, output } = await handleCache(run, path, stages);
    if (status < 1 || !hex || !output) return undefined;
    id = await run.newId(hex);
    for (let variant = 0; variant < id.dir.status.length; variant++) {
      if (!((id.dir.status[variant] ?? 0) & RR_HAS_PREIMAGE)) continue;
      const recorded = await run.readFile(run.path({ dir: id.dir, variant }, "preimage"));
      if (recorded && compareBytes(recorded, output) === 0) {
        id.variant = variant;
        break;
      }
    }
    if (id.variant < 0) run.assignVariant(id);
    await run.mkdir(run.path(id));
    if (!((id.dir.status[id.variant] ?? 0) & RR_HAS_PREIMAGE)) {
      await run.writeFile(run.path(id, "preimage"), output);
    }
  }
  fit(id.dir, id.variant);
  const bits = id.dir.status[id.variant] ?? 0;
  // copy_file: O_EXCL, an existing postimage stays
  const postimage = run.path(id, "postimage");
  if ((await run.files.stats(postimage)) === undefined) {
    const content = await run.readWorktree(path);
    if (!content) return undefined;
    await run.mkdir(run.path(id));
    await run.writeFile(postimage, content);
  }
  id.dir.status[id.variant] = bits | RR_HAS_POSTIMAGE | RR_HAS_PREIMAGE;
  if (rr.has(path)) {
    rr.delete(path);
    await run.writeRr(rr);
  }
  return id.dir.hex;
}

async function replayOnePath(
  host: RerereHost,
  path: string,
  apply: boolean,
): Promise<RerereReplay | undefined> {
  const run = await setupRerere(host);
  if (!run) return undefined;
  if (!threeStaged(await stagesOf(host.staging, path))) return undefined;
  const content = await run.readWorktree(path);
  if (!content) return undefined;
  // thisimage: the file normalised (handle_file), kept in memory
  const parsed = normalizeConflicts(content, await run.markerSize(path), host.objectFormat);
  if (parsed.status < 1 || !parsed.id) return undefined;
  const dir = await run.dir(parsed.id);
  for (let variant = 0; variant < dir.status.length; variant++) {
    if (((dir.status[variant] ?? 0) & BOTH) !== BOTH) continue;
    const id = { dir, variant };
    // git's `merge` writes the normalised file as the variant's thisimage before it tries
    if (apply) await run.writeFile(run.path(id, "thisimage"), parsed.output);
    const merged = await run.tryMerge(id, path, parsed.output);
    if (!merged) continue;
    const preimage = await run.readFile(run.path(id, "preimage"));
    const postimage = await run.readFile(run.path(id, "postimage"));
    if (!preimage || !postimage) continue;
    if (apply) {
      await run.writeReplayed(id, path, merged);
      const rr = await run.readRr();
      const waiting = rr.get(path);
      if (waiting !== undefined) {
        // a different variant applies cleanly: no point keeping the path's own
        if (waiting && waiting.dir === dir && waiting.variant >= 0 && waiting.variant !== variant) {
          await run.removeVariant(waiting);
        }
        rr.delete(path);
        await run.writeRr(rr);
      }
    }
    return { signature: dir.hex, variant, preimage, postimage, content: merged };
  }
  return undefined;
}
