/**
 * git's diff output (`diff.c`) over file pairs: the patch (`git diff`), `--stat`,
 * `--numstat`, `--shortstat`, `--name-only` and `--name-status`, byte for byte as git prints
 * them.
 *
 * @example
 * ```typescript
 * const pairs: DiffFilePair[] = [{ status: "M", old: blobSide(...), new: blobSide(...) }];
 * const patch = await formatPatch(pairs, { context: 3, indentHeuristic: true });
 * const stat = formatStat(await computeDiffstat(pairs), { width: 80 });
 * ```
 *
 * A pair has an old and a new side; a side that does not exist (an added file's old side,
 * a deleted file's new side) is left out. Each file is shown as git's `builtin_diff` shows
 * it: the `diff --git` header with mode, rename and `index` lines, then "Binary files ...
 * differ" or the hunks of the text diff ({@link unifiedDiffHunks}). A pair between a file
 * and a symbolic link is shown as a deletion and an addition. The header of a file whose
 * diff comes out empty (only whitespace changes under `-w`) is printed only when it
 * carries news of its own (mode change, rename, new or deleted file).
 *
 * @module
 */

import { type Blobs, probeBlob } from "@statewalker/vcs-core";
import {
  ByteSink,
  bytesToHex,
  createSha1,
  diffLineCounts,
  type FindFunction,
  type UnifiedDiffOptions,
  type UnifiedDiffResult,
  unifiedDiffHunks,
  userdiffFindFunction,
  writeHunks,
  type XdiffAlgorithm,
} from "@statewalker/vcs-utils";
import {
  decodeGitPath,
  encodeGitPath,
  gitCharWidthAt,
  gitStrWidth,
  parseGitBool,
} from "@statewalker/vcs-utils/encoding";

import { quoteCStyleBody, quotePath, quoteTwo } from "./quote-path.js";

/** One side of a file pair */
export interface DiffSideSpec {
  path: string;
  /** git file mode, e.g. `0o100644` */
  mode: number;
  /** Object id of the content (a worktree file: the id of its cleaned content) */
  id: string;
  /** The content (a symbolic link: its target; a submodule: "Subproject commit <id>\n") */
  read(): Promise<Uint8Array>;
  /**
   * The bytes a textconv command reads, as git's `prepare_temp_file` writes them: a stored
   * blob as checkout would write it (smudged), a worktree file as it is (not cleaned);
   * default {@link read}
   */
  readTextconvInput?(): Promise<Uint8Array>;
  /**
   * Whether `id` is known as git knows a stored object's (default true); false for content
   * hashed here, a worktree file or a file outside the repository (git's `oid_valid` unset):
   * the diffstat then compares the contents even when the ids are equal
   */
  idValid?: boolean;
  /**
   * Size and binary probe without reading everything (big files): when absent, the content
   * is read
   */
  probe?(bigFileThreshold: number): Promise<{ size: number; binary: boolean }>;
}

/** git's status letters of a file pair */
export type DiffStatus = "A" | "D" | "M" | "R" | "C" | "T";

/** A file pair as git's diff queue holds it */
export interface DiffFilePair {
  status: DiffStatus;
  /** The old side; absent for an added file */
  old?: DiffSideSpec;
  /** The new side; absent for a deleted file */
  new?: DiffSideSpec;
  /** Similarity percentage of a rename or copy */
  score?: number;
}

/** What a diff driver (`diff=<name>` attribute) changes */
export interface DiffDriver {
  /** Binary (`-diff`, `diff.<name>.binary`) or text (`diff`) regardless of content */
  binary?: boolean;
  /** Hunk header function lines (`diff.<name>.xfuncname`, builtin drivers) */
  findFunction?: FindFunction;
  /** `diff.<name>.algorithm` */
  algorithm?: XdiffAlgorithm;
  /** The driver's name (`diff=<name>`) */
  name?: string;
  /** `diff.<name>.textconv`: the command git would run to turn the content into text */
  textconvCommand?: string;
  /** `diff.<name>.cachetextconv` (output is the same with or without the cache) */
  cacheTextconv?: boolean;
  /**
   * Turns a side's content into the text the patch compares (git's `fill_textconv`): set
   * when textconv is allowed and the host can run `textconvCommand`. A side converted this
   * way is never binary.
   */
  textconv?: TextconvFunction;
}

/** A textconv conversion: the text of `content`, the content of the file `path` */
export type TextconvFunction = (content: Uint8Array, path: string) => Promise<Uint8Array>;

/** Options of the diff output */
export interface DiffOutputOptions
  extends Omit<UnifiedDiffOptions, "findFunction" | "indentHeuristic"> {
  /** Slide changes as the indentation suggests (`diff.indentHeuristic`, default true) */
  indentHeuristic?: boolean;
  /** Length of abbreviated object ids in `index` lines (default 7) */
  abbrev?: number;
  /**
   * The length of each id in `index` lines, as git abbreviates them (`DiffCommand` finds
   * them from `core.abbrev`, the repository's size and the other objects); ids not in it
   * take `abbrev`
   */
  abbrevLengths?: ReadonlyMap<string, number>;
  /** Full object ids in `index` lines (`--full-index`) */
  fullIndex?: boolean;
  /** `core.quotePath` (default true): bytes above 0x7f in paths are escaped */
  quotePath?: boolean;
  /** Larger files are binary (`core.bigFileThreshold`, default 512 MiB as git's diff) */
  bigFileThreshold?: number;
  /** Treat every file as text (`-a`, `--text`) */
  text?: boolean;
  /** Prefix of old paths (default "a/"; `--src-prefix`, `--no-prefix`) */
  srcPrefix?: string;
  /** Prefix of new paths (default "b/") */
  dstPrefix?: string;
  /** The diff driver of a path (from its `diff` attribute), if any */
  driver?: (path: string) => Promise<DiffDriver | undefined> | DiffDriver | undefined;
}

const S_IFMT = 0o170000;
const NULL_ID = "0".repeat(40);
const FIRST_FEW_BYTES = 8000;
const GIT_DIFF_BIG_FILE_THRESHOLD = 512 * 1024 * 1024;

const encoder = new TextEncoder();

/**
 * The driver of a `diff` attribute value (git's `userdiff_find_by_path`): set means text,
 * unset means binary, a name means `diff.<name>.*` from `config` or a builtin driver.
 */
export function diffDriverOf(
  attribute: true | false | string | undefined | null,
  config?: (key: string) => string | undefined,
): DiffDriver | undefined {
  if (attribute === true) return { binary: false };
  if (attribute === false) return { binary: true };
  if (typeof attribute !== "string") return undefined;
  const name = attribute;
  const binary = boolValue(config?.(`diff.${name}.binary`));
  const algorithm = config?.(`diff.${name}.algorithm`) as XdiffAlgorithm | undefined;
  const findFunction = userdiffFindFunction(name, config);
  const textconvCommand = config?.(`diff.${name}.textconv`);
  const cacheTextconv = boolValue(config?.(`diff.${name}.cachetextconv`));
  if (binary === undefined && !algorithm && !findFunction && textconvCommand === undefined) {
    return undefined;
  }
  return {
    name,
    ...(binary !== undefined ? { binary } : {}),
    ...(algorithm ? { algorithm } : {}),
    ...(findFunction ? { findFunction } : {}),
    ...(textconvCommand !== undefined ? { textconvCommand } : {}),
    ...(cacheTextconv !== undefined ? { cacheTextconv } : {}),
  };
}

/** A git boolean (`git_config_bool`), undefined when unset or not one. */
const boolValue = (v: string | undefined): boolean | undefined => parseGitBool(v);

/** A side as the diff reads it: its content and binary state, read once */
class LoadedSide {
  private content?: Promise<Uint8Array>;
  private probed?: Promise<{ size: number; binary: boolean }>;

  constructor(
    readonly spec: DiffSideSpec | undefined,
    readonly driver: DiffDriver | undefined,
  ) {}

  get valid(): boolean {
    return this.spec !== undefined;
  }

  get mode(): number {
    return this.spec?.mode ?? 0;
  }

  get id(): string {
    return this.spec?.id ?? NULL_ID;
  }

  read(): Promise<Uint8Array> {
    this.content ??= this.spec ? this.spec.read() : Promise.resolve(new Uint8Array(0));
    return this.content;
  }

  /** The bytes textconv converts ({@link DiffSideSpec.readTextconvInput}) */
  textconvInput(): Promise<Uint8Array> {
    return this.spec?.readTextconvInput ? this.spec.readTextconvInput() : this.read();
  }

  /** `diff_filespec_is_binary` */
  async isBinary(threshold: number): Promise<boolean> {
    if (this.driver?.binary !== undefined) return this.driver.binary;
    if (!this.spec) return false;
    return (await this.probe(threshold)).binary;
  }

  probe(threshold: number): Promise<{ size: number; binary: boolean }> {
    this.probed ??= (async () => {
      if (this.spec?.probe && !this.content) return this.spec.probe(threshold);
      const content = await this.read();
      return {
        size: content.length,
        binary: content.length > threshold || hasNul(content),
      };
    })();
    return this.probed;
  }

  async size(threshold: number): Promise<number> {
    if (!this.spec) return 0;
    return (await this.probe(threshold)).size;
  }
}

function hasNul(content: Uint8Array): boolean {
  const n = Math.min(content.length, FIRST_FEW_BYTES);
  for (let i = 0; i < n; i++) if (content[i] === 0) return true;
  return false;
}

function octal6(mode: number): string {
  return mode.toString(8).padStart(6, "0");
}

/**
 * The driver a side's content is read with (`diff_filespec_load_driver`): a regular file's;
 * an absent side, a symbolic link and a submodule take the default driver
 */
function contentDriver(
  spec: DiffSideSpec | undefined,
  driver: DiffDriver | undefined,
): DiffDriver | undefined {
  return spec && (spec.mode & S_IFMT) === 0o100000 ? driver : undefined;
}

async function driverOf(
  options: DiffOutputOptions,
  path: string | undefined,
): Promise<DiffDriver | undefined> {
  if (!path || !options.driver) return undefined;
  return options.driver(path);
}

/**
 * The patch of the pairs, as `git diff` prints it.
 */
export async function formatPatch(
  pairs: DiffFilePair[],
  options: DiffOutputOptions = {},
): Promise<Uint8Array> {
  const sink = new ByteSink();
  for (const pair of pairs) await writePairPatch(sink, pair, options);
  return sink.bytes();
}

/** What {@link writePairPatch} found for a pair (the last part, for a split pair) */
export interface PairPatchReport {
  /** "Binary files ... differ" (or binary and equal) */
  binary: boolean;
  /** The `diff --git` line, without its LF */
  gitLine: string;
  /** The lines between `diff --git` and `---` (mode, rename, index lines), each with LF */
  extended: string;
  /** The `---` and `+++` lines, without LF, when hunks were printed */
  oldLabel?: string;
  newLabel?: string;
  /** The text diff, for a text pair */
  result?: UnifiedDiffResult;
}

/** Writes one pair as `run_diff` does: a file/symlink change as deletion and addition */
export async function writePairPatch(
  sink: ByteSink,
  pair: DiffFilePair,
  options: DiffOutputOptions = {},
  report?: PairPatchReport,
): Promise<void> {
  const { old: one, new: two } = pair;
  if (one && two && (one.mode & S_IFMT) !== (two.mode & S_IFMT)) {
    await builtinDiff(sink, { ...pair, new: undefined }, options, two.path, report);
    await builtinDiff(sink, { ...pair, old: undefined }, options, one.path, report);
    return;
  }
  await builtinDiff(sink, pair, options, undefined, report);
}

/** `fill_metainfo`: rename/copy lines and the index line; whether they force the header */
function metainfo(
  pair: DiffFilePair,
  one: LoadedSide,
  two: LoadedSide,
  name: string,
  other: string | undefined,
  options: DiffOutputOptions,
): { text: string; mustShow: boolean } {
  const quote = options.quotePath ?? true;
  let text = "";
  let mustShow = false;
  if (pair.status === "R" || pair.status === "C") {
    const word = pair.status === "R" ? "rename" : "copy";
    text += `similarity index ${pair.score ?? 0}%\n`;
    text += `${word} from ${quotePath(name, quote)}\n`;
    text += `${word} to ${quotePath(other ?? name, quote)}\n`;
    mustShow = true;
  }
  if (one.id !== two.id) {
    const abbrev = (id: string) =>
      id.slice(0, options.fullIndex ? 40 : (options.abbrevLengths?.get(id) ?? options.abbrev ?? 7));
    text += `index ${abbrev(one.id)}..${abbrev(two.id)}`;
    if (one.mode === two.mode) text += ` ${octal6(one.mode)}`;
    text += "\n";
  }
  return { text, mustShow };
}

/** git's `builtin_diff` for one pair (both sides of the same kind, or one side absent) */
async function builtinDiff(
  sink: ByteSink,
  pair: DiffFilePair,
  options: DiffOutputOptions,
  absentPath?: string,
  report?: PairPatchReport,
): Promise<void> {
  const quote = options.quotePath ?? true;
  const threshold = options.bigFileThreshold ?? GIT_DIFF_BIG_FILE_THRESHOLD;
  // names as run_diff passes them: the pair's paths even for the absent side
  const pathOne = pair.old?.path ?? absentPath ?? pair.new?.path ?? "";
  const pathTwo = pair.new?.path ?? absentPath ?? pair.old?.path ?? "";
  const name = pathOne;
  const other = pathTwo !== name ? pathTwo : undefined;
  const oneDriver = await driverOf(options, pathOne);
  const twoDriver = pathTwo === pathOne ? oneDriver : await driverOf(options, pathTwo);
  const one = new LoadedSide(pair.old, contentDriver(pair.old, oneDriver));
  const two = new LoadedSide(pair.new, contentDriver(pair.new, twoDriver));
  const meta = metainfo(pair, one, two, name, other, options);
  let mustShow = meta.mustShow;

  const aPrefix = options.srcPrefix ?? "a/";
  const bPrefix = options.dstPrefix ?? "b/";
  const nameA = one.valid ? name : (other ?? name);
  const nameB = two.valid ? (other ?? name) : nameA;
  const aOne = quoteTwo(aPrefix, stripSlash(nameA), quote);
  const bTwo = quoteTwo(bPrefix, stripSlash(nameB), quote);
  const lbl0 = one.valid ? aOne : "/dev/null";
  const lbl1 = two.valid ? bTwo : "/dev/null";
  let header = `diff --git ${aOne} ${bTwo}\n`;
  if (!one.valid) {
    header += `new file mode ${octal6(two.mode)}\n${meta.text}`;
    mustShow = true;
  } else if (!two.valid) {
    header += `deleted file mode ${octal6(one.mode)}\n${meta.text}`;
    mustShow = true;
  } else {
    if (one.mode !== two.mode) {
      header += `old mode ${octal6(one.mode)}\nnew mode ${octal6(two.mode)}\n`;
      mustShow = true;
    }
    header += meta.text;
    if ((one.mode ^ two.mode) & S_IFMT) return;
  }
  if (report) {
    report.gitLine = `diff --git ${aOne} ${bTwo}`;
    report.extended = header.slice(report.gitLine.length + 1);
    report.binary = false;
    report.result = undefined;
    report.oldLabel = undefined;
    report.newLabel = undefined;
  }

  // a side with a textconv driver (git's get_textconv: valid sides only) is text
  const textconvOne = one.driver?.textconv;
  const textconvTwo = two.driver?.textconv;
  const binary =
    !options.text &&
    ((!textconvOne && (await one.isBinary(threshold))) ||
      (!textconvTwo && (await two.isBinary(threshold))));
  if (binary) {
    if (report) report.binary = true;
    // ids name the contents: equal ids, equal contents; an absent side is empty
    const same =
      one.valid && two.valid
        ? one.id === two.id
        : (await one.size(threshold)) === 0 && (await two.size(threshold)) === 0;
    if (same) {
      if (mustShow) sink.text(header);
      return;
    }
    sink.text(header);
    sink.text(`Binary files ${lbl0} and ${lbl1} differ\n`);
    return;
  }

  if (mustShow) {
    sink.text(header);
    header = "";
  }
  const driver = one.driver?.findFunction ? one.driver : two.driver;
  const algorithm = oneDriver?.algorithm ?? options.algorithm;
  const textOne = textconvOne
    ? await textconvOne(await one.textconvInput(), pathOne)
    : await one.read();
  const textTwo = textconvTwo
    ? await textconvTwo(await two.textconvInput(), pathTwo)
    : await two.read();
  const result = unifiedDiffHunks(textOne, textTwo, {
    ...options,
    algorithm,
    indentHeuristic: options.indentHeuristic ?? true,
    findFunction: driver?.findFunction,
  });
  if (report) report.result = result;
  if (result.hunks.length === 0) return;
  if (header) sink.text(header);
  const oldLabel = `--- ${lbl0}${lbl0.includes(" ") ? "\t" : ""}`;
  const newLabel = `+++ ${lbl1}${lbl1.includes(" ") ? "\t" : ""}`;
  if (report) {
    report.oldLabel = oldLabel;
    report.newLabel = newLabel;
  }
  sink.text(`${oldLabel}\n${newLabel}\n`);
  writeHunks(sink, result);
}

function stripSlash(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

// --- diffstat ---------------------------------------------------------------------------

/** One file of a diffstat (`struct diffstat_file`) */
export interface DiffstatFile {
  /** The old name of a renamed (or differently named) pair */
  fromName?: string;
  name: string;
  isRenamed: boolean;
  isBinary: boolean;
  isUnmerged?: boolean;
  /** Lines added (binary: new size in bytes) */
  added: number;
  /** Lines deleted (binary: old size in bytes) */
  deleted: number;
}

/** The diffstat of the pairs (`builtin_diffstat` for each) */
export async function computeDiffstat(
  pairs: DiffFilePair[],
  options: DiffOutputOptions = {},
): Promise<DiffstatFile[]> {
  const threshold = options.bigFileThreshold ?? GIT_DIFF_BIG_FILE_THRESHOLD;
  const files: DiffstatFile[] = [];
  for (const pair of pairs) {
    const nameA = pair.old?.path ?? pair.new?.path ?? "";
    const nameB = pair.new?.path ?? nameA;
    const renamed = nameB !== nameA;
    const file: DiffstatFile = {
      ...(renamed ? { fromName: nameA } : {}),
      name: renamed ? nameB : nameA,
      isRenamed: renamed,
      isBinary: false,
      added: 0,
      deleted: 0,
    };
    files.push(file);
    const pathOne = nameA;
    const oneDriver = await driverOf(options, pathOne);
    const twoDriver = nameB === nameA ? oneDriver : await driverOf(options, nameB);
    const one = new LoadedSide(pair.old, contentDriver(pair.old, oneDriver));
    const two = new LoadedSide(pair.new, contentDriver(pair.new, twoDriver));
    // git's may_differ: both ids known and equal, or the contents are compared
    const mayDiffer = !(
      one.valid &&
      two.valid &&
      one.spec?.idValid !== false &&
      two.spec?.idValid !== false &&
      one.id === two.id
    );
    // builtin_diffstat: `--text` does not apply, binary files count bytes
    if ((await one.isBinary(threshold)) || (await two.isBinary(threshold))) {
      file.isBinary = true;
      if (mayDiffer) {
        file.added = await two.size(threshold);
        file.deleted = await one.size(threshold);
      }
    } else if (mayDiffer) {
      const counts = diffLineCounts(await one.read(), await two.read(), {
        ...options,
        algorithm: oneDriver?.algorithm ?? options.algorithm,
        indentHeuristic: options.indentHeuristic ?? true,
      });
      file.added = counts.added;
      file.deleted = counts.deleted;
      if (
        one.valid &&
        two.valid &&
        pair.status === "M" &&
        !file.added &&
        !file.deleted &&
        one.mode === two.mode
      ) {
        files.pop();
      }
    }
  }
  return files;
}

/** Options of {@link formatStat} (`--stat=<width>[,<name-width>[,<count>]]`) */
export interface DiffstatOptions {
  /** Total width (`COLUMNS`, default 80) */
  width?: number;
  /** Width of the name part (`--stat-name-width`, `diff.statNameWidth`) */
  nameWidth?: number;
  /** Width of the graph part (`--stat-graph-width`, `diff.statGraphWidth`) */
  graphWidth?: number;
  /** Files shown (`--stat-count`) */
  count?: number;
  /** `core.quotePath` (default true) */
  quotePath?: boolean;
}

/** git's `pprint_rename`: `a/{b => c}/d` */
export function pprintRename(a: string, b: string, quote = true): string {
  const qa = quoteCStyleBody(a, quote);
  const qb = quoteCStyleBody(b, quote);
  if (qa !== undefined || qb !== undefined) {
    return `${quotePath(a, quote)} => ${quotePath(b, quote)}`;
  }
  const ea = encodeGitPath(a);
  const eb = encodeGitPath(b);
  const lenA = ea.length;
  const lenB = eb.length;
  let pfx = 0;
  let i = 0;
  while (i < lenA && i < lenB && ea[i] === eb[i]) {
    if (ea[i] === 0x2f) pfx = i + 1;
    i++;
  }
  let oa = lenA;
  let ob = lenB;
  let sfx = 0;
  const adjust = pfx ? 1 : 0;
  // compares the byte at oa/ob (the terminating NUL at the ends, equal on both sides)
  const at = (arr: Uint8Array, k: number) => (k < arr.length ? arr[k] : 0);
  while (pfx - adjust <= oa && pfx - adjust <= ob && at(ea, oa) === at(eb, ob)) {
    if (at(ea, oa) === 0x2f) sfx = lenA - oa;
    oa--;
    ob--;
  }
  const aMid = Math.max(0, lenA - pfx - sfx);
  const bMid = Math.max(0, lenB - pfx - sfx);
  const dec = (arr: Uint8Array, s: number, e: number) => decodeGitPath(arr.subarray(s, e));
  let out = "";
  if (pfx + sfx) out += `${dec(ea, 0, pfx)}{`;
  out += `${dec(ea, pfx, pfx + aMid)} => ${dec(eb, pfx, pfx + bMid)}`;
  if (pfx + sfx) out += `}${dec(ea, lenA - sfx, lenA)}`;
  return out;
}

function printName(file: DiffstatFile, quote: boolean): string {
  if (file.isRenamed && file.fromName !== undefined)
    return pprintRename(file.fromName, file.name, quote);
  return quotePath(file.name, quote);
}

/**
 * Display width of a name, as git's utf8_strwidth measures it (git 2.56's character widths:
 * wide East Asian characters and emoji two columns, combining marks none; a name that is not
 * valid UTF-8 its byte count)
 */
export function displayWidth(s: string): number {
  let ascii = true;
  let width = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x7f) {
      ascii = false;
      break;
    }
    if (c >= 0x20) width++;
  }
  return ascii ? width : gitStrWidth(encodeGitPath(s));
}

/**
 * git's show_stats "scales" a name too wide for `width` columns: leading characters dropped
 * (diff.c's utf8_ish_width steps, byte by byte through what is not UTF-8) until the rest fits
 * in `width - 3`, then up to its first slash when it has one, behind a `...` prefix.
 */
function shortenName(name: string, width: number): { prefix: string; name: string; len: number } {
  let nameLen = displayWidth(name);
  if (width >= nameLen) return { prefix: "", name, len: width };
  const len = Math.max(0, width - 3);
  const bytes = encodeGitPath(name);
  let at = 0;
  while (nameLen > len && at < bytes.length) {
    const [w, next] = gitCharWidthAt(bytes, at);
    nameLen -= w;
    at = next;
  }
  let rest = bytes.subarray(at);
  const slash = rest.indexOf(0x2f);
  if (slash >= 0) rest = rest.subarray(slash);
  return { prefix: "...", name: decodeGitPath(rest), len };
}

function decimalWidth(n: number): number {
  let width = 1;
  for (let v = n; v >= 10; v = Math.floor(v / 10)) width++;
  return width;
}

function scaleLinear(it: number, width: number, maxChange: number): number {
  if (!it) return 0;
  return 1 + Math.floor((it * (width - 1)) / maxChange);
}

/** git's `print_stat_summary_inserts_deletes` */
export function statSummary(files: number, insertions: number, deletions: number): string {
  if (!files) return " 0 files changed\n";
  let s = files === 1 ? ` ${files} file changed` : ` ${files} files changed`;
  if (insertions || deletions === 0) {
    s += insertions === 1 ? `, ${insertions} insertion(+)` : `, ${insertions} insertions(+)`;
  }
  if (deletions || insertions === 0) {
    s += deletions === 1 ? `, ${deletions} deletion(-)` : `, ${deletions} deletions(-)`;
  }
  return `${s}\n`;
}

/** `--stat`, as git's `show_stats` prints it */
export function formatStat(files: DiffstatFile[], options: DiffstatOptions = {}): string {
  if (files.length === 0) return "";
  const quote = options.quotePath ?? true;
  const isInteresting = (_f: DiffstatFile) => true;
  let count = options.count ?? files.length;
  let maxChange = 0;
  let maxLen = 0;
  let numberWidth = 0;
  let binWidth = 0;
  const names = new Map<DiffstatFile, string>();
  let i = 0;
  for (; i < count && i < files.length; i++) {
    const file = files[i];
    const change = file.added + file.deleted;
    if (!isInteresting(file) && change === 0) {
      count++;
      continue;
    }
    const name = printName(file, quote);
    names.set(file, name);
    const len = displayWidth(name);
    if (maxLen < len) maxLen = len;
    if (file.isUnmerged) {
      binWidth = binWidth < 8 ? 8 : binWidth;
      continue;
    }
    if (file.isBinary) {
      const w = 14 + decimalWidth(file.added) + decimalWidth(file.deleted);
      binWidth = binWidth < w ? w : binWidth;
      numberWidth = 3;
      continue;
    }
    if (maxChange < change) maxChange = change;
  }
  count = i;

  let width = options.width ?? 80;
  numberWidth = decimalWidth(maxChange) > numberWidth ? decimalWidth(maxChange) : numberWidth;
  const statNameWidth = options.nameWidth ?? 0;
  const statGraphWidth = options.graphWidth ?? 0;
  if (width < 16 + 6 + numberWidth) width = 16 + 6 + numberWidth;
  let graphWidth = maxChange + 4 > binWidth ? maxChange : binWidth - 4;
  if (statGraphWidth && statGraphWidth < graphWidth) graphWidth = statGraphWidth;
  let nameWidth = statNameWidth > 0 && statNameWidth < maxLen ? statNameWidth : maxLen;
  if (nameWidth + numberWidth + 6 + graphWidth > width) {
    if (graphWidth > Math.trunc((width * 3) / 8) - numberWidth - 6) {
      graphWidth = Math.trunc((width * 3) / 8) - numberWidth - 6;
      if (graphWidth < 6) graphWidth = 6;
    }
    if (statGraphWidth && graphWidth > statGraphWidth) graphWidth = statGraphWidth;
    if (nameWidth > width - numberWidth - 6 - graphWidth) {
      nameWidth = width - numberWidth - 6 - graphWidth;
    } else {
      graphWidth = width - numberWidth - 6 - nameWidth;
    }
  }

  let out = "";
  for (i = 0; i < count; i++) {
    const file = files[i];
    const added = file.added;
    const deleted = file.deleted;
    if (!isInteresting(file) && added + deleted === 0) continue;
    let name = names.get(file) ?? printName(file, quote);
    const shortened = shortenName(name, nameWidth);
    const prefix = shortened.prefix;
    const len = shortened.len;
    name = shortened.name;
    const padding = Math.max(0, len - displayWidth(name));
    const pad = " ".repeat(padding);
    if (file.isBinary) {
      out += ` ${prefix}${name}${pad} | ${"Bin".padStart(numberWidth)}`;
      if (!added && !deleted) {
        out += "\n";
        continue;
      }
      out += ` ${deleted} -> ${added} bytes\n`;
      continue;
    }
    if (file.isUnmerged) {
      out += ` ${prefix}${name}${pad} | ${"Unmerged\n".padStart(numberWidth)}`;
      continue;
    }
    let add = added;
    let del = deleted;
    if (graphWidth <= maxChange) {
      let total = scaleLinear(add + del, graphWidth, maxChange);
      if (total < 2 && add && del) total = 2;
      if (add < del) {
        add = scaleLinear(add, graphWidth, maxChange);
        del = total - add;
      } else {
        del = scaleLinear(del, graphWidth, maxChange);
        add = total - del;
      }
    }
    out += ` ${prefix}${name}${pad} | ${String(added + deleted).padStart(numberWidth)}`;
    out += added + deleted ? " " : "";
    out += "+".repeat(Math.max(0, add));
    out += "-".repeat(Math.max(0, del));
    out += "\n";
  }

  let totalFiles = files.length;
  let adds = 0;
  let dels = 0;
  let extraShown = false;
  for (i = 0; i < files.length; i++) {
    const file = files[i];
    if (file.isUnmerged || (!isInteresting(file) && file.added + file.deleted === 0)) {
      totalFiles--;
      continue;
    }
    if (!file.isBinary) {
      adds += file.added;
      dels += file.deleted;
    }
    if (i < count) continue;
    if (!extraShown) out += " ...\n";
    extraShown = true;
  }
  return out + statSummary(totalFiles, adds, dels);
}

/** `--shortstat` (git's `show_shortstats`) */
export function formatShortstat(files: DiffstatFile[]): string {
  if (files.length === 0) return "";
  let totalFiles = files.length;
  let adds = 0;
  let dels = 0;
  for (const file of files) {
    if (file.isUnmerged) totalFiles--;
    else if (!file.isBinary) {
      adds += file.added;
      dels += file.deleted;
    }
  }
  return statSummary(totalFiles, adds, dels);
}

/** `--numstat` (git's `show_numstat`) */
export function formatNumstat(
  files: DiffstatFile[],
  options: { quotePath?: boolean } = {},
): string {
  const quote = options.quotePath ?? true;
  let out = "";
  for (const file of files) {
    out += file.isBinary ? "-\t-\t" : `${file.added}\t${file.deleted}\t`;
    out += file.isRenamed ? printName(file, quote) : quotePath(file.name, quote);
    out += "\n";
  }
  return out;
}

/** `--name-only`: the new path of each pair */
export function formatNameOnly(
  pairs: DiffFilePair[],
  options: { quotePath?: boolean } = {},
): string {
  const quote = options.quotePath ?? true;
  return pairs.map((p) => `${quotePath(p.new?.path ?? p.old?.path ?? "", quote)}\n`).join("");
}

/** `--name-status` (git's `diff_flush_raw` with `DIFF_FORMAT_NAME_STATUS`) */
export function formatNameStatus(
  pairs: DiffFilePair[],
  options: { quotePath?: boolean } = {},
): string {
  const quote = options.quotePath ?? true;
  let out = "";
  for (const p of pairs) {
    const score = p.status === "R" || p.status === "C" ? (p.score ?? 0) : 0;
    out += score ? `${p.status}${String(score).padStart(3, "0")}\t` : `${p.status}\t`;
    if (p.status === "R" || p.status === "C") {
      out += `${quotePath(p.old?.path ?? "", quote)}\t${quotePath(p.new?.path ?? "", quote)}\n`;
    } else {
      out += `${quotePath(p.old ? p.old.path : (p.new?.path ?? ""), quote)}\n`;
    }
  }
  return out;
}

/**
 * A side whose content is a stored blob (a submodule's: "Subproject commit <id>\n", as git
 * shows a gitlink). The probe reads a text blob once and keeps it for {@link DiffSideSpec.read}.
 */
export function blobSide(blobs: Blobs, path: string, mode: number, id: string): DiffSideSpec {
  if ((mode & S_IFMT) === 0o160000) {
    const content = encoder.encode(`Subproject commit ${id}\n`);
    return { path, mode, id, read: async () => content };
  }
  let loaded: Uint8Array | undefined;
  return {
    path,
    mode,
    id,
    async read() {
      if (loaded) return loaded;
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of (await blobs.load(id)) ?? []) {
        chunks.push(chunk);
        size += chunk.length;
      }
      const out = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      loaded = out;
      return out;
    },
    async probe(bigFileThreshold: number) {
      const probe = await probeBlob(blobs, id, { bigFileThreshold, loadText: true });
      if (probe.content) loaded = probe.content;
      return { size: probe.size, binary: probe.binary };
    },
  };
}

/** A side whose content comes from elsewhere (a worktree file, a file outside a repository) */
export function contentSide(
  path: string,
  mode: number,
  id: string,
  read: () => Promise<Uint8Array>,
  idValid = false,
): DiffSideSpec {
  let content: Promise<Uint8Array> | undefined;
  return {
    path,
    mode,
    id,
    idValid,
    read: () => {
      content ??= read();
      return content;
    },
  };
}

/**
 * Bytes for a string (diff output pieces are UTF-8; a path's escaped bytes, unquoted with
 * `core.quotePath=false`, are written as the bytes they stand for)
 */
export function utf8(s: string): Uint8Array {
  return encodeGitPath(s);
}

/** A file of a `--no-index` diff: its path as given, content, and mode (default 100644) */
export interface NoIndexFile {
  path: string;
  /** Undefined for a side that does not exist (`/dev/null`) */
  content?: Uint8Array;
  mode?: number;
}

/** The blob id of `content` (as `hash-object` computes it) */
export function blobIdOf(content: Uint8Array): string {
  return bytesToHex(
    createSha1()
      .update(encoder.encode(`blob ${content.length}\0`))
      .update(content)
      .digest(),
  );
}

/**
 * The pair `diff --no-index a b` compares for two files: a modification between two names
 * (no rename detection), or an addition or deletion against `/dev/null`.
 */
export function noIndexPair(a: NoIndexFile, b: NoIndexFile): DiffFilePair | undefined {
  const side = (f: NoIndexFile): DiffSideSpec | undefined => {
    if (!f.content) return undefined;
    const content = f.content;
    return contentSide(f.path, f.mode ?? 0o100644, blobIdOf(content), async () => content);
  };
  const old = side(a);
  const neu = side(b);
  if (!old && !neu) return undefined;
  if (old && neu && old.id === neu.id && old.mode === neu.mode) return undefined;
  return { status: !old ? "A" : !neu ? "D" : "M", old, new: neu };
}

/** `diff --no-index a b` for two files, as git prints it */
export async function formatNoIndexDiff(
  a: NoIndexFile,
  b: NoIndexFile,
  options: DiffOutputOptions = {},
): Promise<Uint8Array> {
  const pair = noIndexPair(a, b);
  return pair ? formatPatch([pair], options) : new Uint8Array(0);
}
