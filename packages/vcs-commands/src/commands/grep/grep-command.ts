/**
 * `git grep` (builtin/grep.c over grep.c): lines matching patterns in the worktree's tracked
 * files, the index (`--cached`), untracked files too (`--untracked`), a directory outside
 * git's control (`--no-index`), or trees and revisions.
 *
 * @example
 * ```typescript
 * // git grep -n -e foo --and --not -e bar HEAD -- src
 * const result = await git
 *   .grep()
 *   .addPattern("foo")
 *   .and()
 *   .not()
 *   .addPattern("bar")
 *   .setLineNumber(true)
 *   .setArguments(["HEAD", "--", "src"])
 *   .call();
 * process.stdout.write(result.output); // HEAD:src/a.c:12:foo()
 * result.exitCode; // 0 when something matched, else 1
 * ```
 *
 * What it searches, as git does:
 * - The worktree: every regular file of the index (stage 0 once per unmerged path, skip-worktree
 *   entries left out), read from disk, or from the index when the entry is assume-unchanged
 *   (an intent-to-add or unmerged one then skipped).
 * - `--cached`: the index's blobs. Trees and revisions (`setArguments`, `addRevision`): their
 *   files named `<rev>:<path>` (a blob given as `<rev>:<path>` by that name alone); the diff
 *   attributes of a commit's files come from the worktree and index, a tree's files have none.
 * - `--untracked` and `--no-index`: the files of the directory (`.git` never entered), ignored
 *   ones left out unless `--no-exclude-standard` (the default of `--no-index`); `--no-index`
 *   enters nested repositories. Without a repository, {@link grepNoIndex}.
 *
 * Names are relative to the current directory ({@link GrepCommand.setPrefix}) unless
 * `--full-name`/`grep.fullName`, quoted as `core.quotePath` says (not with `-z`). Binary files
 * (a NUL in their first 8000 bytes, or the `diff` attribute's driver) report `Binary file x
 * matches`; `--textconv` runs `diff.<driver>.textconv` through the runner the host installs
 * (`installTextconvRunner`). `-p`/`-W` use the driver's funcname pattern. Configuration:
 * `grep.lineNumber`, `grep.column`, `grep.fullName`, `grep.patternType`,
 * `grep.extendedRegexp`, `grep.threads`, `color.grep`, `color.grep.<slot>`.
 *
 * Output follows git's threaded grep (its default, `GrepEngine`): with context, every source's
 * output after the first starts with `--`. `--recurse-submodules` (or `submodule.recurse`)
 * is refused; `-O`/`--open-files-in-pager` is not offered.
 *
 * @module
 */

import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { FindFunction } from "@statewalker/vcs-utils/diff";
import { userdiffFindFunction } from "@statewalker/vcs-utils/diff";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import {
  type AttributesIndex,
  collectChunks,
  type IndexEntry,
  smudgeContent,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import { RevisionError } from "../../errors/index.js";
import { GitCommand } from "../../git-command.js";
import { quotePath } from "../../results/quote-path.js";
import { parseGitColor } from "../config-value-types.js";
import { type TextconvRunner, textconvRunnerOf } from "../diff-textconv.js";
import { configValue } from "../merge-config.js";
import { MATCHED_FNMATCH, matchPathspec, type PathspecItem, parsePathspec } from "../pathspec.js";
import type { GrepPatternType } from "../rev-filter/index.js";
import { type ArgumentFiles, verifyFilename, verifyNonFilename } from "../revision-filenames.js";
import type { RevisionResolver } from "../revision-resolver.js";
import {
  DEFAULT_GREP_COLORS,
  type GrepBinaryMode,
  type GrepColors,
  GrepEngine,
  type GrepEngineOptions,
  GrepError,
  type GrepToken,
  grepPattern,
  grepPatternFile,
} from "./grep-engine.js";

/** What `git grep` printed and how it ended. */
export interface GrepResult {
  /** git's exit status: 0 when something matched (`-L`: a file was listed), else 1 */
  exitCode: 0 | 1;
  /** Whether something matched */
  matched: boolean;
  /** git's stdout */
  output: Uint8Array;
}

/** Every option of a grep run (what {@link GrepCommand}'s setters set). */
export interface GrepOptions
  extends Omit<GrepEngineOptions, "lineNumber" | "column" | "colors" | "patternType"> {
  tokens: GrepToken[];
  /** `-E`/`-F`/`-G`/`-P`; undefined: `grep.patternType`, `grep.extendedRegexp` */
  patternType?: GrepPatternType;
  lineNumber?: boolean;
  column?: boolean;
  /** `--full-name` (undefined: `grep.fullName`) */
  fullName?: boolean;
  /** `--color[=<when>]` (undefined: `color.grep`, `color.ui`; `auto` is off here) */
  color?: boolean;
  cached?: boolean;
  untracked?: boolean;
  noIndex?: boolean;
  /** `--[no-]exclude-standard` */
  excludeStandard?: boolean;
  /** `--max-depth` (-1: none) */
  maxDepth?: number;
  /** `--textconv` */
  textconv?: boolean;
  /** `--recurse-submodules` */
  recurseSubmodules?: boolean;
  /** The current directory below the top (`sub/`), git's prefix */
  prefix?: string;
  /** The revision and path arguments, as given after the pattern */
  args?: string[];
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const isRegular = (mode: number) => (mode & S_IFMT) === S_IFREG;

/** An index without in-tree attributes files */
const NO_INDEX: AttributesIndex = { attributesBlob: () => undefined };

/** A diff driver as grep uses it: the funcname pattern read only when needed */
interface GrepDriver {
  binary?: boolean;
  textconv?: { name: string; command: string; cache: boolean };
  findFunction(): FindFunction | undefined;
}

/** What a grep run reads: the repository's parts, where there is one. */
interface GrepContext {
  worktree?: Worktree;
  /** A configuration value (the last one) */
  config(key: string): string | undefined;
  /** Whether there is a repository (git's `have_repository`) */
  repository: boolean;
  /** The top of the worktree as the host names it */
  hostTop?: string;
  entries?(): Promise<IndexEntry[]>;
  readBlob?(id: ObjectId): Promise<Uint8Array | undefined>;
  prefetch?(ids: ObjectId[]): Promise<void>;
  treeEntries?(id: ObjectId): Promise<readonly { name: string; mode: number; id: ObjectId }[]>;
  resolver?(): RevisionResolver;
  argumentFiles?(prefix: string): ArgumentFiles;
  textconv?: TextconvRunner;
  inOneOperation<T>(fn: () => Promise<T>): Promise<T>;
}

function die(message: string): never {
  throw new GrepError(`fatal: ${message}`);
}

/** git's `relative_path(in, prefix)` for two paths from the top (prefix ends with `/`). */
function relativePath(path: string, prefix: string): string {
  if (!prefix) return path;
  const a = path.split("/");
  const b = prefix.split("/").filter((p) => p !== "");
  let k = 0;
  while (k < a.length - 1 && k < b.length && a[k] === b[k]) k++;
  return [...b.slice(k).map(() => ".."), ...a.slice(k)].join("/");
}

const SHORT_MAGIC = new Set([..."!\"#%&',-;<=>@_`~^/"]);

/** The pathspec argument read against the prefix (`:(top)` and `:/` from the top). */
function prefixedArg(arg: string, prefix: string): string {
  if (!prefix) return arg;
  if (arg.startsWith(":(")) {
    const close = arg.indexOf(")");
    if (close < 0) return arg;
    const words = arg
      .slice(2, close)
      .split(",")
      .map((w) => w.trim());
    if (words.includes("top")) return arg;
    return arg.slice(0, close + 1) + prefix + arg.slice(close + 1);
  }
  if (arg.startsWith(":")) {
    let i = 1;
    while (i < arg.length && arg[i] !== ":" && SHORT_MAGIC.has(arg[i] as string)) i++;
    const magic = arg.slice(1, i);
    if (arg[i] === ":") i++;
    if (magic.includes("/")) return arg;
    return arg.slice(0, i) + prefix + arg.slice(i);
  }
  return prefix + arg;
}

/** The part of an argument after its magic (git's `copyfrom`) */
function afterMagic(arg: string): string {
  if (arg.startsWith(":(")) {
    const close = arg.indexOf(")");
    return close < 0 ? arg : arg.slice(close + 1);
  }
  if (arg.startsWith(":")) {
    let i = 1;
    while (i < arg.length && arg[i] !== ":" && SHORT_MAGIC.has(arg[i] as string)) i++;
    if (arg[i] === ":") i++;
    return arg.slice(i);
  }
  return arg;
}

/** dir.c's within_depth */
function withinDepth(name: string, depthIn: number, maxDepth: number): boolean {
  let depth = depthIn;
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) !== 0x2f) continue;
    depth++;
    if (depth > maxDepth) return false;
  }
  return depth <= maxDepth;
}

/** match_pathspec with `--max-depth` (git's PATHSPEC_MAXDEPTH, recursive) */
function pathMatches(items: PathspecItem[], path: string, maxDepth: number): boolean {
  if (maxDepth < 0) return matchPathspec(items, path, 0) !== 0;
  if (items.length === 0) return withinDepth(path, 0, maxDepth);
  const name = latin1(path);
  let positive = 0;
  for (const item of items) {
    if (item.exclude) continue;
    let how = matchPathspec([item], path, 0);
    if (how && how !== MATCHED_FNMATCH) {
      let len = item.match.length;
      if (name[len] === "/") len++;
      how = withinDepth(name.slice(len), 0, maxDepth) ? how : 0;
    }
    positive = Math.max(positive, how);
  }
  if (!positive) return false;
  // an exclude element that matches drops the path
  return !items.some((i) => i.exclude) || matchPathspec(items, path, 0) !== 0;
}

/** A path as one character per byte (pathspec items hold bytes) */
function latin1(path: string): string {
  let ascii = true;
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) > 0x7f) ascii = false;
  if (ascii) return path;
  let out = "";
  for (const b of encodeGitPath(path)) out += String.fromCharCode(b);
  return out;
}

/** One search of `git grep` over a context. */
class GrepRun {
  private engine!: GrepEngine;
  private items: PathspecItem[] = [];
  private relative = true;
  private quoteFully = true;
  private readonly drivers = new Map<string, Promise<GrepDriver | undefined>>();
  private readonly prefix: string;

  constructor(
    private readonly ctx: GrepContext,
    private readonly o: GrepOptions,
  ) {
    this.prefix = o.prefix ?? "";
  }

  async run(): Promise<GrepResult> {
    const ctx = this.ctx;
    const o = this.o;
    const get = (key: string) => ctx.config(key);
    const bool = (key: string) => {
      const v = get(key);
      return v === undefined ? undefined : (parseGitBool(v) ?? true);
    };
    // grep_config
    let configured: GrepPatternType | undefined;
    const typeValue = get("grep.patternType");
    if (typeValue !== undefined) {
      if (typeValue === "basic" || typeValue === "extended" || typeValue === "fixed") {
        configured = typeValue;
      } else if (typeValue === "perl") configured = "perl";
      else if (typeValue !== "default") die(`bad grep.patterntype argument: ${typeValue}`);
    }
    const threadsValue = get("grep.threads");
    let threads = o.threads ?? (threadsValue !== undefined ? Number(threadsValue) : 0);
    if (threadsValue !== undefined && Number(threadsValue) < 0) {
      die(`invalid number of threads specified (${threadsValue}) for grep.threads`);
    }
    this.relative = o.fullName !== undefined ? !o.fullName : !(bool("grep.fullName") ?? false);
    this.quoteFully = bool("core.quotePath") ?? true;
    const useIndex = !o.noIndex && ctx.repository;
    const recurse = o.recurseSubmodules ?? bool("submodule.recurse") ?? false;
    if (recurse && useIndex) {
      die("--recurse-submodules is not supported by this implementation of git grep");
    }
    const tokens = o.tokens;
    if (tokens.length === 0) die("no pattern given");

    // revisions, then paths
    const { objects, paths } = await this.readArguments(useIndex);
    this.items = this.parsePaths(paths);

    if (o.maxCount === 0) return { exitCode: 1, matched: false, output: new Uint8Array(0) };
    if (threads < 0) die(`invalid number of threads specified (${threads})`);
    if (threads === 0) threads = 8;

    let patternType = o.patternType ?? configured;
    if (patternType === undefined) patternType = bool("grep.extendedRegexp") ? "extended" : "basic";
    this.engine = new GrepEngine(tokens, {
      ...o,
      patternType,
      lineNumber: o.lineNumber ?? bool("grep.lineNumber") ?? false,
      column: o.column ?? bool("grep.column") ?? false,
      threads,
      ...(this.colorOn() ? { colors: this.colors() } : {}),
    });

    const incompatible = [
      [!useIndex && !!o.noIndex, "--no-index"],
      [!!o.untracked, "--untracked"],
      [!!o.cached, "--cached"],
    ].filter(([on]) => on) as [boolean, string][];
    if (incompatible.length === 3) {
      die("options '--no-index', '--untracked', and '--cached' cannot be used together");
    }
    if (incompatible.length === 2) {
      die(
        `options '${incompatible[0]?.[1]}' and '${incompatible[1]?.[1]}' cannot be used together`,
      );
    }

    let hit: boolean;
    if (!useIndex || o.untracked) {
      const exclude = o.excludeStandard ?? useIndex;
      hit = await ctx.inOneOperation(() => this.grepDirectory(exclude, useIndex));
    } else if (o.excludeStandard !== undefined) {
      die("--[no-]exclude-standard cannot be used for tracked contents");
    } else if (objects.length === 0) {
      hit = await ctx.inOneOperation(() => this.grepCache(!!o.cached));
    } else {
      if (o.cached) die("both --cached and trees are given");
      hit = await ctx.inOneOperation(() => this.grepObjects(objects));
    }
    return { exitCode: hit ? 0 : 1, matched: hit, output: this.engine.output() };
  }

  private colorOn(): boolean {
    if (this.o.color !== undefined) return this.o.color;
    const value = this.ctx.config("color.grep") ?? this.ctx.config("color.ui");
    if (value === undefined) return false;
    if (value === "always") return true;
    if (value === "auto" || value === "never") return false;
    return false;
  }

  private colors(): GrepColors {
    const colors: GrepColors = { ...DEFAULT_GREP_COLORS };
    const slots: [keyof GrepColors, string][] = [
      ["context", "context"],
      ["filename", "filename"],
      ["function", "function"],
      ["lineNumber", "lineNumber"],
      ["column", "column"],
      ["selected", "selected"],
      ["separator", "separator"],
      ["matchContext", "match"],
      ["matchSelected", "match"],
      ["matchContext", "matchContext"],
      ["matchSelected", "matchSelected"],
    ];
    for (const [slot, key] of slots) {
      const value = this.ctx.config(`color.grep.${key}`);
      if (value === undefined) continue;
      const color = parseGitColor(value);
      if (color !== undefined) colors[slot] = color;
    }
    return colors;
  }

  /** cmd_grep's revision loop and verify_filename */
  private async readArguments(
    useIndex: boolean,
  ): Promise<{ objects: { name: string; id: ObjectId; path?: string }[]; paths: string[] }> {
    const ctx = this.ctx;
    const args = this.o.args ?? [];
    const seenDashdash = args.includes("--");
    const allowRevs = useIndex && !this.o.untracked;
    const objects: { name: string; id: ObjectId; path?: string }[] = [];
    let i = 0;
    const resolver = allowRevs ? ctx.resolver?.() : undefined;
    if (resolver) resolver.cwdPrefix = this.prefix;
    const files = ctx.argumentFiles?.(this.prefix);
    for (; i < args.length; i++) {
      const arg = args[i] as string;
      if (arg === "--") {
        i++;
        break;
      }
      if (!allowRevs || !resolver) {
        if (seenDashdash) die("--no-index or --untracked cannot be used with revs");
        break;
      }
      const id = await resolver.resolve(arg).catch((e) => {
        if (e instanceof RevisionError) throw e;
        return undefined;
      });
      if (id === undefined) {
        if (seenDashdash) die(`unable to resolve revision: ${arg}`);
        break;
      }
      if (!seenDashdash && files) {
        const message = await verifyNonFilename(files, arg);
        if (message) throw new RevisionError(arg, message);
      }
      objects.push({ name: arg, id, ...this.objectPath(arg) });
    }
    if (!seenDashdash && files && resolver) {
      for (let j = i; j < args.length; j++) {
        await verifyFilename(files, resolver, args[j] as string, j === i && allowRevs);
      }
    } else if (!seenDashdash && files) {
      // diagnose is off: only the resolver's warnings are read
      const quiet = (ctx.resolver?.() ?? { warnings: [] }) as RevisionResolver;
      for (let j = i; j < args.length; j++) {
        await verifyFilename(files, quiet, args[j] as string, false);
      }
    }
    return { objects, paths: args.slice(i) };
  }

  /** The path GET_OID_RECORD_PATH records for `<rev>:<path>` or `:<n>:<path>` */
  private objectPath(arg: string): { path?: string } {
    let at = -1;
    if (arg.startsWith(":")) {
      at = /^:[0-3]:/.test(arg) ? 2 : 0;
    } else {
      let depth = 0;
      for (let i = 0; i < arg.length; i++) {
        const c = arg[i];
        if ((c === "@" || c === "^") && arg[i + 1] === "{") {
          i++;
          depth++;
        } else if (depth > 0 && c === "}") depth--;
        else if (depth === 0 && c === ":") {
          at = i;
          break;
        }
      }
    }
    if (at < 0) return {};
    let path = arg.slice(at + 1);
    if (path.startsWith("./") || path.startsWith("../") || path === "." || path === "..") {
      const out: string[] = [];
      for (const part of `${this.prefix}${path}`.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") out.pop();
        else out.push(part);
      }
      path = out.join("/");
    }
    return { path };
  }

  /** parse_pathspec with PATHSPEC_PREFER_CWD */
  private parsePaths(paths: string[]): PathspecItem[] {
    const prefix = this.prefix;
    const args = paths.length === 0 && prefix ? ["."] : paths;
    return parsePathspec(
      args.map((arg) => {
        const prefixed = prefixedArg(arg, prefix);
        try {
          parsePathspec([prefixed]);
        } catch (e) {
          if (e instanceof Error && /is outside repository/.test(e.message)) {
            const copy = afterMagic(arg);
            if (!this.ctx.repository) die(`'${copy}' is outside the directory tree`);
            die(`${arg}: '${copy}' is outside repository at '${this.ctx.hostTop ?? ""}'`);
          }
          if (e instanceof Error) die(e.message);
          throw e;
        }
        return prefixed;
      }),
    );
  }

  private matches(path: string): boolean {
    return pathMatches(this.items, path, this.o.maxDepth ?? -1);
  }

  /** grep_source_name: the name printed for `path` (after a tree's `<rev>:`) */
  private sourceName(path: string, treeName = ""): Uint8Array {
    const rel = this.relative && this.prefix ? relativePath(path, this.prefix) : path;
    if (this.o.nullFollowingName) return encodeGitPath(treeName + rel);
    return encodeGitPath(treeName + quotePath(rel, this.quoteFully));
  }

  /** userdiff_find_by_path: the `diff` attribute's driver */
  private driver(path: string | undefined, withIndex: boolean): Promise<GrepDriver | undefined> {
    if (path === undefined) return Promise.resolve(undefined);
    const key = `${withIndex ? "i" : "w"}:${path}`;
    let found = this.drivers.get(key);
    if (!found) {
      found = this.loadDriver(path, withIndex);
      this.drivers.set(key, found);
    }
    return found;
  }

  private async loadDriver(path: string, withIndex: boolean): Promise<GrepDriver | undefined> {
    const filter = this.ctx.worktree?.contentFilter as
      | {
          attributes?: (
            path: string,
            names?: readonly string[],
            context?: { direction: "checkin"; index?: AttributesIndex },
          ) => Promise<Map<string, true | false | string | undefined>>;
        }
      | undefined;
    if (!filter?.attributes) return undefined;
    const attrs = await filter.attributes(
      path,
      ["diff"],
      withIndex ? undefined : { direction: "checkin", index: NO_INDEX },
    );
    const value = attrs.get("diff");
    if (value === true) return { binary: false, findFunction: () => undefined };
    if (value === false) return { binary: true, findFunction: () => undefined };
    if (typeof value !== "string") return undefined;
    const get = (key: string) => this.ctx.config(key);
    const binaryValue = get(`diff.${value}.binary`);
    const binary = binaryValue === undefined ? undefined : parseGitBool(binaryValue);
    const command = get(`diff.${value}.textconv`);
    let find: FindFunction | undefined | null = null;
    return {
      ...(binary !== undefined ? { binary } : {}),
      ...(command !== undefined
        ? {
            textconv: {
              name: value,
              command,
              cache: parseGitBool(get(`diff.${value}.cachetextconv`)) ?? false,
            },
          }
        : {}),
      findFunction: () => {
        if (find === null) {
          try {
            find = userdiffFindFunction(value, get);
          } catch (e) {
            die((e as Error).message);
          }
        }
        return find;
      },
    };
  }

  /** grep_source for one file or blob */
  private async grepOne(
    name: Uint8Array,
    path: string | undefined,
    withIndex: boolean,
    read: () => Promise<Uint8Array | undefined>,
    textconvInput: (content: Uint8Array) => Promise<Uint8Array>,
  ): Promise<boolean> {
    const o = this.o;
    const driver = await this.driver(path, withIndex);
    let content = await read();
    let textconv = false;
    if (o.textconv && driver?.textconv && this.ctx.textconv && content !== undefined) {
      const tc = driver.textconv;
      content = await this.ctx.textconv({
        driver: tc.name,
        command: tc.command,
        path: path ?? "",
        content: await textconvInput(content),
        cache: tc.cache,
      });
      textconv = true;
    }
    return this.engine.grepSource({
      name,
      content,
      textconv,
      ...(driver?.binary !== undefined ? { binary: driver.binary } : {}),
      findFunction: () => driver?.findFunction(),
    });
  }

  private async readFile(path: string): Promise<Uint8Array | undefined> {
    const worktree = this.ctx.worktree;
    if (!worktree) return undefined;
    const entry = await worktree.getEntry(path);
    if (!entry || entry.isDirectory || !isRegular(entry.mode)) return undefined;
    try {
      return await collectChunks(worktree.readContent(path));
    } catch {
      return undefined;
    }
  }

  private grepFile(path: string, withIndex: boolean): Promise<boolean> {
    return this.grepOne(
      this.sourceName(path),
      path,
      withIndex,
      () => this.readFile(path),
      async (c) => c,
    );
  }

  private grepBlob(
    id: ObjectId,
    name: Uint8Array,
    path: string | undefined,
    mode = FileMode.REGULAR_FILE as number,
  ): Promise<boolean> {
    const read = () => this.ctx.readBlob?.(id) ?? Promise.resolve(undefined);
    return this.grepOne(name, path, true, read, async (content) =>
      collectChunks(
        await smudgeContent(this.ctx.worktree?.contentFilter, path ?? "", content, mode),
      ),
    );
  }

  /** grep_cache */
  private async grepCache(cached: boolean): Promise<boolean> {
    const entries = (await this.ctx.entries?.()) ?? [];
    let hit = false;
    for (let nr = 0; nr < entries.length; nr++) {
      const ce = entries[nr] as IndexEntry;
      if (!cached && ce.skipWorktree) continue;
      if (isRegular(ce.mode) && this.matches(ce.path)) {
        if (cached || ce.assumeValid) {
          if (ce.stage || ce.intentToAdd) continue;
          hit =
            (await this.grepBlob(ce.objectId, this.sourceName(ce.path), ce.path, ce.mode)) || hit;
        } else {
          hit = (await this.grepFile(ce.path, true)) || hit;
        }
      } else continue;
      if (ce.stage) {
        while (nr + 1 < entries.length && entries[nr + 1]?.path === ce.path) nr++;
      }
      if (hit && this.o.statusOnly) break;
    }
    return hit;
  }

  /** grep_objects */
  private async grepObjects(
    objects: { name: string; id: ObjectId; path?: string }[],
  ): Promise<boolean> {
    const resolver = this.ctx.resolver?.() as RevisionResolver;
    // resolve every object first, then prefetch what a partial clone lacks in one batch
    const work: (() => Promise<boolean>)[] = [];
    const wanted: ObjectId[] = [];
    for (const object of objects) {
      const peeled = await resolver.peelTags(object.id).catch(() => undefined);
      if (!peeled || peeled.type === undefined) die(`invalid object '${object.name}' given.`);
      const { id, type } = peeled;
      if (type === "blob") {
        work.push(() => this.grepBlob(id, this.blobName(object.name), object.path));
        continue;
      }
      if (type !== "commit" && type !== "tree") die(`unable to grep from object of type ${type}`);
      const tree = await resolver.peelToType(id, "tree");
      if (!tree) die(`unable to read tree (${id})`);
      const files: { path: string; id: ObjectId; mode: number }[] = [];
      await this.listTree(tree, "", files);
      const base = object.name ? `${object.name}:` : "";
      for (const f of files) wanted.push(f.id);
      work.push(async () => {
        let hit = false;
        for (const f of files) {
          hit =
            (await this.grepBlob(
              f.id,
              this.sourceName(f.path, base),
              type === "commit" ? f.path : undefined,
              f.mode,
            )) || hit;
          if (hit && this.o.statusOnly) break;
        }
        return hit;
      });
    }
    if (wanted.length > 0) await this.ctx.prefetch?.(wanted);
    let hit = false;
    for (const w of work) {
      if (await w()) {
        hit = true;
        if (this.o.statusOnly) break;
      }
    }
    return hit;
  }

  /**
   * The name of a blob given on the command line: git's grep_oid names it as a path, so it is
   * relative to the prefix too (`../HEAD:./v` from `t/`)
   */
  private blobName(name: string): Uint8Array {
    return this.sourceName(name);
  }

  /** grep_tree's walk: the regular files in tree order that the pathspec takes */
  private async listTree(
    id: ObjectId,
    base: string,
    out: { path: string; id: ObjectId; mode: number }[],
  ): Promise<void> {
    const entries = (await this.ctx.treeEntries?.(id)) ?? [];
    for (const e of entries) {
      const path = base + e.name;
      if ((e.mode & S_IFMT) === 0o040000) {
        await this.listTree(e.id, `${path}/`, out);
      } else if (isRegular(e.mode) && this.matches(path)) {
        out.push({ path, id: e.id, mode: e.mode });
      }
    }
  }

  /** grep_directory: fill_directory's files (index unread), sorted */
  private async grepDirectory(exclude: boolean, useIndex: boolean): Promise<boolean> {
    const worktree = this.ctx.worktree;
    if (!worktree) return false;
    const files: string[] = [];
    const host = await worktree.untrackedScanHost?.();
    if (host) {
      const walk = async (dir: string) => {
        if (exclude) await host.loadIgnoreFile(dir);
        let listed: { name: string; kind?: string }[];
        try {
          listed = await host.listDirectory(dir, false);
        } catch {
          return;
        }
        for (const entry of listed) {
          if (entry.name === ".git" || entry.name === "." || entry.name === "..") continue;
          const path = dir ? `${dir}/${entry.name}` : entry.name;
          const kind = entry.kind ?? (await host.lstat(path))?.kind;
          if (kind === "directory") {
            if (exclude && host.isExcluded(path, true)) continue;
            if (useIndex && (await host.isNestedRepository(path))) continue;
            await walk(path);
          } else if (kind === "file" || kind === "symlink") {
            if (exclude && host.isExcluded(path, false)) continue;
            if (this.matches(path)) files.push(path);
          }
        }
      };
      await walk("");
    } else {
      for await (const entry of worktree.walk({ includeIgnored: !exclude })) {
        if (!entry.isDirectory && this.matches(entry.path)) files.push(entry.path);
      }
    }
    files.sort((a, b) => compareBytes(encodeGitPath(a), encodeGitPath(b)));
    let hit = false;
    for (const path of files) {
      hit = (await this.grepFile(path, false)) || hit;
      if (hit && this.o.statusOnly) break;
    }
    return hit;
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

/** The options a {@link GrepCommand} or {@link grepNoIndex} run starts from. */
function emptyOptions(): GrepOptions {
  return { tokens: [] };
}

/** Setters shared by the command and {@link GrepNoIndex} */
interface GrepSetters {
  readonly options: GrepOptions;
}

/**
 * `git grep`. Patterns: {@link addPattern} (`-e`), {@link addPatternFile} (`-f`), with
 * {@link and}, {@link not}, {@link open}, {@link close} between them (`--or` is the default).
 * Where to search: {@link setArguments} (`[<rev>...] [[--] <path>...]` as git reads them),
 * {@link setCached}, {@link setUntracked}, {@link setNoIndex}. {@link call} resolves with
 * git's stdout and exit status, or throws `GrepError`/`GrepPatternError`/`RevisionError` with
 * git's line where it dies (exit status 128).
 */
export class GrepCommand extends GitCommand<GrepResult> implements GrepSetters {
  readonly options: GrepOptions = emptyOptions();

  private set<K extends keyof GrepOptions>(key: K, value: GrepOptions[K]): this {
    this.checkCallable();
    this.options[key] = value;
    return this;
  }

  /** `-e <pattern>` (a string is taken as UTF-8) */
  addPattern(pattern: string | Uint8Array, origin = "-e option"): this {
    this.checkCallable();
    this.options.tokens.push(grepPattern(pattern, origin));
    return this;
  }

  /** `-f <file>`: the file's content, one pattern per non-empty line; `name` as given */
  addPatternFile(content: string | Uint8Array, name: string): this {
    this.checkCallable();
    this.options.tokens.push(...grepPatternFile(content, name));
    return this;
  }

  /** `--and` */
  and(): this {
    return this.token({ kind: "and" });
  }
  /** `--not` */
  not(): this {
    return this.token({ kind: "not" });
  }
  /** `(` */
  open(): this {
    return this.token({ kind: "open" });
  }
  /** `)` */
  close(): this {
    return this.token({ kind: "close" });
  }
  private token(t: GrepToken): this {
    this.checkCallable();
    this.options.tokens.push(t);
    return this;
  }

  /** `--all-match` */
  setAllMatch(on: boolean): this {
    return this.set("allMatch", on);
  }
  /** `-E` (`extended`), `-F` (`fixed`), `-G` (`basic`), `-P` (`perl`) */
  setPatternType(type: GrepPatternType | undefined): this {
    return this.set("patternType", type);
  }
  /** `-i` */
  setIgnoreCase(on: boolean): this {
    return this.set("ignoreCase", on);
  }
  /** `-w` */
  setWordRegexp(on: boolean): this {
    return this.set("wordRegexp", on);
  }
  /** `-v` */
  setInvertMatch(on: boolean): this {
    return this.set("invert", on);
  }
  /** `--cached` */
  setCached(on: boolean): this {
    return this.set("cached", on);
  }
  /** `--untracked` */
  setUntracked(on: boolean): this {
    return this.set("untracked", on);
  }
  /** `--no-index` */
  setNoIndex(on: boolean): this {
    return this.set("noIndex", on);
  }
  /** `--exclude-standard` (true) / `--no-exclude-standard` (false) */
  setExcludeStandard(on: boolean | undefined): this {
    return this.set("excludeStandard", on);
  }
  /** `--recurse-submodules`: refused (not supported yet) */
  setRecurseSubmodules(on: boolean): this {
    return this.set("recurseSubmodules", on);
  }
  /**
   * The arguments after the pattern: revisions, then paths (`--` between them), checked as
   * git checks them (a path must exist without `--`, a revision must not also be a file)
   */
  setArguments(args: string[]): this {
    return this.set("args", [...args]);
  }
  /** A revision or tree to search (`<rev>`, `<rev>:<path>`, a tree id) */
  addRevision(revision: string): this {
    const args = this.options.args ?? [];
    const dd = args.indexOf("--");
    const revs = dd < 0 ? args : args.slice(0, dd);
    const paths = dd < 0 ? [] : args.slice(dd + 1);
    return this.set("args", [...revs, revision, "--", ...paths]);
  }
  /** Pathspecs (`-- <path>...`) */
  addPath(...paths: string[]): this {
    const args = this.options.args ?? [];
    return this.set("args", args.includes("--") ? [...args, ...paths] : [...args, "--", ...paths]);
  }
  /** The current directory below the top (`sub/` or `sub`): names are relative to it */
  setPrefix(prefix: string): this {
    const p = prefix.replace(/^\/+|\/+$/g, "");
    return this.set("prefix", p ? `${p}/` : "");
  }
  /** `--max-depth <n>` (-1: none) */
  setMaxDepth(depth: number): this {
    return this.set("maxDepth", depth);
  }
  /** `-n` / `--no-line-number` (undefined: `grep.lineNumber`) */
  setLineNumber(on: boolean | undefined): this {
    return this.set("lineNumber", on);
  }
  /** `--column` (undefined: `grep.column`) */
  setColumn(on: boolean | undefined): this {
    return this.set("column", on);
  }
  /** `-H` (true) / `-h` (false) */
  setShowFilename(on: boolean): this {
    return this.set("pathname", on);
  }
  /** `--full-name` (undefined: `grep.fullName`) */
  setFullName(on: boolean | undefined): this {
    return this.set("fullName", on);
  }
  /** `-z` */
  setNull(on: boolean): this {
    return this.set("nullFollowingName", on);
  }
  /** `-o` */
  setOnlyMatching(on: boolean): this {
    return this.set("onlyMatching", on);
  }
  /** `-c` */
  setCount(on: boolean): this {
    return this.set("count", on);
  }
  /** `-l` */
  setFilesWithMatches(on: boolean): this {
    return this.set("nameOnly", on);
  }
  /** `-L` */
  setFilesWithoutMatch(on: boolean): this {
    return this.set("unmatchNameOnly", on);
  }
  /** `-q` */
  setQuiet(on: boolean): this {
    return this.set("statusOnly", on);
  }
  /** `--break` */
  setBreak(on: boolean): this {
    return this.set("fileBreak", on);
  }
  /** `--heading` */
  setHeading(on: boolean): this {
    return this.set("heading", on);
  }
  /** `-B <n>` */
  setBeforeContext(n: number): this {
    return this.set("preContext", n);
  }
  /** `-A <n>` */
  setAfterContext(n: number): this {
    return this.set("postContext", n);
  }
  /** `-C <n>` */
  setContext(n: number): this {
    this.set("preContext", n);
    return this.set("postContext", n);
  }
  /** `-p` */
  setShowFunction(on: boolean): this {
    return this.set("funcname", on);
  }
  /** `-W` */
  setFunctionContext(on: boolean): this {
    return this.set("funcbody", on);
  }
  /** `-m <n>` (negative: no limit) */
  setMaxCount(n: number): this {
    return this.set("maxCount", n);
  }
  /** `-a` (`text`), `-I` (`nomatch`) */
  setBinary(mode: GrepBinaryMode): this {
    return this.set("binary", mode);
  }
  /** `--textconv` / `--no-textconv` */
  setTextconv(on: boolean): this {
    return this.set("textconv", on);
  }
  /** `--color=always` (true), `--no-color` (false); undefined: `color.grep`/`color.ui` */
  setColor(on: boolean | undefined): this {
    return this.set("color", on);
  }
  /**
   * `--threads <n>`: 1 prints as git's single-threaded grep, more (the default) as its
   * threaded one (a hunk mark before each file's context, the first output's first line
   * dropped)
   */
  setThreads(n: number): this {
    return this.set("threads", n);
  }
  /** The git version to follow (`2.43` or `2.56`, the default); see `GrepEngineOptions` */
  setCompatibility(compatibility: "2.43" | "2.56"): this {
    return this.set("compatibility", compatibility);
  }

  async call(): Promise<GrepResult> {
    this.checkCallable();
    this.setCallable(false);
    const wc = this.workingCopy;
    const worktree = this.worktreeAccess;
    const get = (key: string) => configValue(wc, key);
    const ctx: GrepContext = {
      worktree,
      config: get,
      repository: true,
      hostTop: worktree?.hostPath,
      entries: async () => {
        const out: IndexEntry[] = [];
        for await (const e of this.staging.entries()) out.push(e);
        return out;
      },
      readBlob: async (id) => {
        const content = await this.blobs.load(id);
        return content ? collectChunks(content) : undefined;
      },
      prefetch: async (ids) => {
        const promisor = wc.history?.objects?.promisor;
        if (promisor?.hasPromisorRemote()) await promisor.prefetch(ids);
      },
      treeEntries: async (id) =>
        (await this.treeEntries(id)).map((e) => ({ name: e.name, mode: e.mode, id: e.id })),
      resolver: () => this.revisionResolver(),
      argumentFiles: (prefix) => this.argumentFiles(prefix),
      textconv: textconvRunnerOf(wc),
      inOneOperation: (fn) => this.inOneOperation(fn),
    };
    return new GrepRun(ctx, this.options).run();
  }
}

/**
 * `git grep --no-index` outside a repository: the files of `worktree` (any `Worktree`, a
 * `FileWorktree` over the directory), read as git reads them without a repository. Options
 * are {@link GrepOptions} (`prefix` the current directory below `worktree`'s root);
 * `config` gives configuration values (the global and system files', if any).
 */
export async function grepNoIndex(
  worktree: Worktree,
  options: Partial<GrepOptions> & { tokens: GrepToken[] },
  config: (key: string) => string | undefined = () => undefined,
): Promise<GrepResult> {
  const ctx: GrepContext = {
    worktree,
    config,
    repository: false,
    hostTop: worktree.hostPath,
    argumentFiles: (prefix) => ({
      inWorktree: false,
      prefix,
      exists: async (path) => {
        const parts: string[] = [];
        for (const part of path.split("/")) {
          if (part === "" || part === ".") continue;
          if (part === "..") {
            if (parts.length === 0) return true;
            parts.pop();
          } else parts.push(part);
        }
        if (parts.length === 0) return true;
        return (await worktree.getEntry(parts.join("/"))) !== undefined;
      },
    }),
    inOneOperation: (fn) => (worktree.batch ? worktree.batch(fn) : fn()),
  };
  return new GrepRun(ctx, { ...options, noIndex: true }).run();
}
