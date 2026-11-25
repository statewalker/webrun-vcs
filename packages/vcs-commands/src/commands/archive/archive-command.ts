/**
 * `git archive` (archive.c, builtin/archive.c): a tar or zip archive of a tree, with git's
 * `--prefix`, `--add-file`/`--add-virtual-file`, pathspecs, `--mtime`, compression levels,
 * the `export-ignore` and `export-subst` attributes, and tar filters (`tar.<format>.command`,
 * the builtin gzip of `tgz` and `tar.gz`).
 *
 * @example
 * ```typescript
 * // git archive --format=zip --prefix=project/ HEAD -- src
 * const zip = await git.archive().setFormat("zip").setPrefix("project/").setTree("HEAD")
 *   .addPath("src").call();
 * ```
 */

import type { ObjectId, TreeEntry } from "@statewalker/vcs-core";
import { approxidateCareful, parseGitBool, parseGitInt } from "@statewalker/vcs-utils";
import { deflateSync } from "@statewalker/vcs-utils/compression";
import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import {
  type AttributesResolver,
  type AttributeValue,
  attributesIndexOfTree,
  type ContentAttributesContext,
  smudgeContent,
  type Worktree,
} from "@statewalker/vcs-working-tree";
import { GitApiError } from "../../errors/index.js";
import { GitCommand } from "../../git-command.js";
import { RemoteConfigStore } from "../../remote-config/index.js";
import { cUnquote } from "../apply/index.js";
import { bareAttributesResolver } from "../attributes-source.js";
import { createIdAbbreviator } from "../core-config.js";
import { createDescriber } from "../git-describe.js";
import { configValue } from "../merge-config.js";
import {
  DO_MATCH_DIRECTORY,
  DO_MATCH_LEADING_PATHSPEC,
  matchPathspec,
  type PathspecItem,
  parsePathspec,
} from "../pathspec.js";
import { formatCommitPretty } from "../pretty-format.js";
import {
  type ArchiveEntry,
  type ArchiveWriter,
  isDirMode,
  isGitlinkMode,
  isRegMode,
} from "./archive-entry.js";
import { TarArchiveWriter } from "./tar-archive.js";
import { ZipArchiveWriter } from "./zip-archive.js";

/** git's builtin gzip filter (`tar.tgz.command`, `tar.tar.gz.command`). */
export const INTERNAL_GZIP_COMMAND = "git archive gzip";

/**
 * Runs a tar filter (`tar.<format>.command`, with ` -<level>` added for a compression
 * level, as git runs it through the shell): the tar archive in, the filtered bytes out.
 * Throwing is git's `'<command>' filter reported error`.
 */
export type ArchiveFilterRunner = (command: string, input: Uint8Array) => Promise<Uint8Array>;

/** An archive format git knows (`git archive --list`). */
interface Archiver {
  name: string;
  /** A tar filter's command; undefined for tar and zip */
  command?: string;
}

/** A file added with `--add-file` or `--add-virtual-file`. */
interface ExtraFile {
  /** `--add-virtual-file`'s path, or `--add-file`'s file as given */
  path: string;
  /** `--add-virtual-file`'s content; read from the worktree for `--add-file` */
  content?: Uint8Array;
  /** The last `--prefix` before it */
  base: string;
  executable?: boolean;
  /** `--add-virtual-file`: archived at its path, the prefix not applied */
  virtual: boolean;
}

const USAGE =
  "usage: git archive [<options>] <tree-ish> [<path>...]\n" +
  "   or: git archive --list\n" +
  "   or: git archive --remote <repo> [--exec <cmd>] [<options>] <tree-ish> [<path>...]\n" +
  "   or: git archive --remote <repo> [--exec <cmd>] --list";

/** git's default `core.bigFileThreshold` (512 MiB). */
const DEFAULT_BIG_FILE_THRESHOLD = 512 * 1024 * 1024;

const EXPORT_ATTRS = ["export-ignore", "export-subst"] as const;

/**
 * `git archive <tree-ish> [<path>...]`: the archive's bytes. Messages git prints on stderr
 * (`-v`'s paths, warnings) are in {@link getMessages}; where git dies, a {@link GitApiError}
 * carries its message and exit status.
 *
 * Deflated data (zip entries, `tgz`) comes from pako's zlib port, whose bytes differ from
 * the system zlib git links: the archives match git's byte for byte except for those
 * compressed streams (`-0` zips and tar archives match whole).
 */
export class ArchiveCommand extends GitCommand<Uint8Array> {
  private tree?: string;
  private format?: string;
  private outputName?: string;
  private base = "";
  private readonly paths: string[] = [];
  private readonly extraFiles: ExtraFile[] = [];
  private mtime?: string;
  private compressionLevel = -1;
  private verbose = false;
  private worktreeAttributes = false;
  private currentDirectory = "";
  private filterRunner?: ArchiveFilterRunner;
  private userUmask = 0o022;
  private localTzOffset?: (time: number) => number;
  private readonly messages: string[] = [];

  /** The tree-ish archived (a commit, a tag, a tree). */
  setTree(name: string): this {
    this.checkCallable();
    this.tree = name;
    return this;
  }

  /** `--format=<fmt>`: `tar`, `zip`, `tgz`, `tar.gz` or a configured tar filter. */
  setFormat(format: string): this {
    this.checkCallable();
    this.format = format;
    return this;
  }

  /**
   * `-o <file>`'s name: the format is inferred from its extension when none is set
   * (git's `archive_format_from_filename`). Nothing is written: the bytes are returned.
   */
  setOutputName(name: string): this {
    this.checkCallable();
    this.outputName = name;
    return this;
  }

  /** `--prefix=<prefix>`: the last one prefixes the tree's paths, each one the added files after it. */
  setPrefix(prefix: string): this {
    this.checkCallable();
    this.base = prefix;
    return this;
  }

  /**
   * `--add-file=<file>`: a file of the worktree (relative to {@link setCurrentDirectory}),
   * added under the current prefix and its base name; `content` gives its bytes instead.
   */
  addFile(path: string, content?: Uint8Array, options: { executable?: boolean } = {}): this {
    this.checkCallable();
    this.extraFiles.push({
      path,
      base: this.base,
      virtual: false,
      ...(content ? { content } : {}),
      ...(options.executable ? { executable: true } : {}),
    });
    return this;
  }

  /** `--add-virtual-file=<path>:<content>` (a C-quoted path allowed, as git reads it). */
  addVirtualFile(spec: string): this {
    this.checkCallable();
    let path: string;
    let rest: string;
    if (spec.startsWith('"')) {
      const unquoted = cUnquote(spec);
      if (!unquoted) throw new GitApiError(`fatal: unclosed quote: '${spec}'`);
      path = unquoted.name;
      rest = spec.slice(unquoted.end);
      if (!rest.startsWith(":")) throw new GitApiError(`fatal: missing colon: '${spec}'`);
    } else {
      const colon = spec.indexOf(":");
      if (colon < 0) throw new GitApiError(`fatal: missing colon: '${spec}'`);
      if (colon === 0) throw new GitApiError(`fatal: empty file name: '${spec}'`);
      path = spec.slice(0, colon);
      rest = spec.slice(colon);
    }
    // xstrdup: the content ends at a NUL
    const content = rest.slice(1).split("\0")[0] as string;
    this.extraFiles.push({
      path,
      base: this.base,
      content: encodeGitPath(content),
      virtual: true,
    });
    return this;
  }

  /** A pathspec element (`git archive <tree-ish> <path>...`). */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /** `--mtime=<time>`: the entries' time (git's approxidate). */
  setMtime(time: string): this {
    this.checkCallable();
    this.mtime = time;
    return this;
  }

  /** `-<n>`: the compression level (zip: 0 to 9, tar filters: any). */
  setCompressionLevel(level: number): this {
    this.checkCallable();
    this.compressionLevel = level;
    return this;
  }

  /** `-v`: each path archived is reported in {@link getMessages}. */
  setVerbose(verbose: boolean): this {
    this.checkCallable();
    this.verbose = verbose;
    return this;
  }

  /** `--worktree-attributes`: attributes read from the worktree (and the index), not the tree. */
  setWorktreeAttributes(on: boolean): this {
    this.checkCallable();
    this.worktreeAttributes = on;
    return this;
  }

  /**
   * The directory git runs in, relative to the worktree's top (`git -C <dir> archive`):
   * only what lies below it is archived, its paths relative to it.
   */
  setCurrentDirectory(dir: string): this {
    this.checkCallable();
    const trimmed = dir.replace(/^\/+|\/+$/g, "");
    this.currentDirectory = trimmed && trimmed !== "." ? `${trimmed}/` : "";
    return this;
  }

  /** Runs the tar filters' commands (git's shell); without it only the builtin gzip works. */
  setFilterRunner(runner: ArchiveFilterRunner): this {
    this.checkCallable();
    this.filterRunner = runner;
    return this;
  }

  /** The umask `tar.umask=user` stands for (default 022). */
  setUserUmask(umask: number): this {
    this.checkCallable();
    this.userUmask = umask;
    return this;
  }

  /** The local time zone (zip's DOS times): its offset east of UTC in minutes at a time. */
  setLocalTimezone(offset: (time: number) => number): this {
    this.checkCallable();
    this.localTzOffset = offset;
    return this;
  }

  /** What git printed on stderr (`-v`'s paths, warnings). */
  getMessages(): string[] {
    return [...this.messages];
  }

  /** `git archive --list`: the formats, as git lists them. */
  listFormats(): string[] {
    return this.archivers().map((a) => a.name);
  }

  /** The archivers in git's registration order: tar, the tar filters, zip. */
  private archivers(): Archiver[] {
    const filters = new Map<string, Archiver>();
    const define = (name: string, command: string | undefined) => {
      const known = filters.get(name) ?? { name };
      if (command !== undefined) known.command = command;
      filters.set(name, known);
    };
    define("tgz", INTERNAL_GZIP_COMMAND);
    define("tar.gz", INTERNAL_GZIP_COMMAND);
    for (const { key, value } of this.tarConfig()) {
      const last = key.lastIndexOf(".");
      const name = key.slice(4, last);
      if (last <= 4 || !name) continue;
      const type = key.slice(last + 1);
      if (type === "command") {
        if (value !== undefined) define(name, value);
      } else if (type === "remote") define(name, undefined);
    }
    return [
      { name: "tar" },
      ...[...filters.values()].filter((a) => a.command !== undefined),
      { name: "zip" },
    ];
  }

  /** The `tar.*` variables in configuration order. */
  private tarConfig(): { key: string; value: string | undefined }[] {
    return RemoteConfigStore.from(this._workingCopy).entriesWithPrefix("tar.") ?? [];
  }

  /** `tar.umask`. */
  private tarUmask(): number {
    let umask = 0o002;
    for (const { key, value } of this.tarConfig()) {
      if (key !== "tar.umask") continue;
      if (value === "user") umask = this.userUmask;
      else {
        const n = parseGitInt(value);
        if (n === undefined)
          throw new GitApiError(
            `fatal: bad numeric config value '${value}' for 'tar.umask': invalid unit`,
          );
        umask = n;
      }
    }
    return umask;
  }

  /** The archive's bytes. */
  async call(): Promise<Uint8Array> {
    this.checkCallable();
    this.setCallable(false);
    const extras = await this.readExtraFiles();
    let format = this.format;
    if (format === undefined && this.outputName !== undefined) {
      format = this.archivers().find((a) =>
        matchExtension(this.outputName as string, a.name),
      )?.name;
    }
    format ??= "tar";
    if (this.tree === undefined) throw new GitApiError(USAGE, { exitCode: 129 });
    const archiver = this.archivers().find((a) => a.name === format);
    if (!archiver) throw new GitApiError(`fatal: Unknown archive format '${format}'`);
    let level = -1;
    if (this.compressionLevel !== -1) {
      const levelsOk = archiver.name !== "tar";
      const highOk = archiver.command !== undefined;
      if (levelsOk && (this.compressionLevel <= 9 || highOk)) level = this.compressionLevel;
      else {
        throw new GitApiError(
          `fatal: Argument not supported for format '${format}': -${this.compressionLevel}`,
        );
      }
    }
    return this.inOneOperation(async () => {
      const target = await this.resolveTreeish(this.tree as string);
      const settings = {
        time: target.time,
        compressionLevel: level,
        ...(target.commitId ? { commitId: target.commitId } : {}),
      };
      const writer: ArchiveWriter =
        archiver.name === "zip"
          ? new ZipArchiveWriter({
              ...settings,
              hexLength: this.objectFormat.hexLength,
              ...(this.localTzOffset ? { localTzOffset: this.localTzOffset } : {}),
              onWarning: (m) => this.messages.push(m),
            })
          : new TarArchiveWriter({ ...settings, umask: this.tarUmask() });
      const run = new ArchiveRun(this, target, writer, extras);
      await run.prepare();
      await run.writeEntries();
      const archive = writer.finish();
      if (archiver.command === undefined) return archive;
      return this.filter(archiver.command, archive, level);
    });
  }

  private async filter(command: string, archive: Uint8Array, level: number): Promise<Uint8Array> {
    if (command === INTERNAL_GZIP_COMMAND) {
      return deflateSync([archive], { format: "gzip", level });
    }
    const cmd = level >= 0 ? `${command} -${level}` : command;
    if (!this.filterRunner) throw new GitApiError(`fatal: unable to start '${cmd}' filter`);
    try {
      return await this.filterRunner(cmd, archive);
    } catch {
      throw new GitApiError(`fatal: '${cmd}' filter reported error`);
    }
  }

  /** `--add-file`'s files read (git stats them while parsing its options). */
  private async readExtraFiles(): Promise<ResolvedExtra[]> {
    const out: ResolvedExtra[] = [];
    for (const extra of this.extraFiles) {
      const path = `${this.currentDirectory}${extra.path}`;
      if (extra.content) {
        out.push({
          path,
          base: extra.base,
          content: extra.content,
          mode: extra.executable ? 0o100755 : 0o100644,
          virtual: extra.virtual,
        });
        continue;
      }
      const worktree = this.worktreeAccess;
      const entry = await worktree?.getEntry(path).catch(() => undefined);
      if (!entry) throw new GitApiError(`fatal: File not found: ${path}`);
      if (entry.isDirectory || (entry.mode & 0o170000) !== 0o100000) {
        throw new GitApiError(`fatal: Not a regular file: ${path}`);
      }
      const chunks: Uint8Array[] = [];
      for await (const c of (worktree as Worktree).readContent(path)) chunks.push(c);
      out.push({
        path,
        base: extra.base,
        content: join(chunks),
        mode: entry.mode & 0o100 ? 0o100755 : 0o100644,
        virtual: false,
      });
    }
    return out;
  }

  /** `parse_treeish_arg`: the tree, the commit (if any) and the archive's time. */
  private async resolveTreeish(name: string): Promise<ArchiveTarget> {
    const resolver = this.revisionResolver();
    const id = await resolver.resolve(name).catch(() => undefined);
    if (id === undefined) throw new GitApiError(`fatal: not a valid object name: ${name}`);
    const peeled = await resolver.peelTags(id);
    let commitId: ObjectId | undefined;
    let time: number;
    if (peeled.type === "commit") {
      commitId = peeled.id;
      const commit = await this.commits.load(commitId);
      time = commit?.committer.timestamp ?? 0;
    } else time = this.clock();
    if (this.mtime !== undefined) time = approxidateCareful(this.mtime, this.clock()).timestamp;
    const tree = await resolver.peelToType(id, "tree").catch(() => undefined);
    if (tree === undefined) throw new GitApiError(`fatal: not a tree object: ${id}`);
    return { tree, time, ...(commitId ? { commitId } : {}) };
  }

  // ---- what the run reads through the command ----

  /** @internal */
  get archiveWorktree(): Worktree | undefined {
    return "worktree" in this._workingCopy ? this.worktreeAccess : undefined;
  }

  /** @internal */
  archiveSettings() {
    return {
      base: this.base,
      paths: this.paths,
      verbose: this.verbose,
      worktreeAttributes: this.worktreeAttributes,
      currentDirectory: this.currentDirectory,
      messages: this.messages,
    };
  }

  /** @internal */
  archiveEntries(id: ObjectId): Promise<readonly TreeEntry[]> {
    return this.treeEntries(id);
  }

  /** @internal */
  async archiveBlob(id: ObjectId): Promise<Uint8Array | undefined> {
    const content = await this.blobs.load(id).catch(() => undefined);
    if (!content) return undefined;
    const chunks: Uint8Array[] = [];
    try {
      for await (const c of content) chunks.push(c);
    } catch {
      return undefined;
    }
    return join(chunks);
  }

  /** @internal */
  archiveConfig(key: string): string | undefined {
    return configValue(this._workingCopy, key);
  }

  /** @internal The attributes git reads without a worktree (bare, or `GIT_ATTR_INDEX`). */
  archiveBareAttributes(indexTree: ObjectId | undefined): AttributesResolver {
    return bareAttributesResolver({
      workingCopy: this._workingCopy,
      trees: this.trees as never,
      blobs: this.blobs,
      revisions: () => this.revisionResolver(),
      ...(indexTree ? { indexTree } : {}),
    });
  }

  /** @internal `%h` and friends, `%(describe)`, for `export-subst`. */
  async archiveSubstitute(format: string, commitId: ObjectId, describe: boolean): Promise<string> {
    const commit = await this.commits.load(commitId);
    if (!commit) return "";
    const abbreviator = createIdAbbreviator(this._workingCopy);
    const abbreviate = async (id: ObjectId, length?: number) => {
      if (length === 0) return id;
      const lengths = await abbreviator.lengths([id], length);
      return id.slice(0, lengths.get(id) ?? 7);
    };
    const tags = this.tagsStore;
    return formatCommitPretty(format, commit, commitId, {
      now: this.clock(),
      abbreviate: (id) => abbreviate(id),
      ...(describe
        ? {
            describe: createDescriber({
              refs: this.refsStore,
              ...(tags ? { tags } : {}),
              commits: this.commits,
              abbreviate,
            }),
          }
        : {}),
    });
  }

  /** @internal */
  get archiveTreeLookup() {
    return this.trees;
  }
}

/** An extra file ready to write. */
interface ResolvedExtra {
  path: string;
  base: string;
  content: Uint8Array;
  mode: number;
  virtual: boolean;
}

interface ArchiveTarget {
  tree: ObjectId;
  commitId?: ObjectId;
  time: number;
}

/** A queued directory (archive.c's `struct directory`). */
interface Pending {
  path: string;
  id: ObjectId;
  mode: number;
  written: boolean;
}

/** git's `match_extension`: `<name>.<ext>`, the name not empty. */
function matchExtension(filename: string, ext: string): boolean {
  const prefixlen = filename.length - ext.length;
  if (prefixlen < 2 || filename[prefixlen - 1] !== ".") return false;
  return filename.slice(prefixlen) === ext;
}

function join(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
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

/** The base name of a path (`basename`). */
function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

/** The pathspec elements as git reads them from `prefix` (`PATHSPEC_PREFER_CWD`). */
function prefixedElement(elem: string, prefix: string): string {
  if (!prefix) return elem;
  if (elem.startsWith(":(")) {
    const close = elem.indexOf(")");
    if (close < 0) return elem;
    const magic = elem.slice(2, close).split(",");
    if (magic.includes("top")) return elem;
    return `${elem.slice(0, close + 1)}${prefix}${elem.slice(close + 1)}`;
  }
  if (elem.startsWith(":/")) return elem;
  if (elem.startsWith(":!") || elem.startsWith(":^")) {
    return `${elem.slice(0, 2)}${prefix}${elem.slice(2)}`;
  }
  return `${prefix}${elem}`;
}

/** One `write_archive`: the tree walked, its entries filtered and handed to the writer. */
class ArchiveRun {
  private readonly settings: ReturnType<ArchiveCommand["archiveSettings"]>;
  private pathspec: PathspecItem[] = [];
  private readonly attrCache = new Map<string, ReadonlyMap<string, AttributeValue>>();
  private bareResolver?: AttributesResolver;
  private filterContext?: ContentAttributesContext;
  private bigFileThreshold = DEFAULT_BIG_FILE_THRESHOLD;
  private describeBudget = 1;
  private readonly base: Uint8Array;
  private readonly baseText: string;

  constructor(
    private readonly cmd: ArchiveCommand,
    private readonly target: ArchiveTarget,
    private readonly writer: ArchiveWriter,
    private readonly extras: ResolvedExtra[],
  ) {
    this.settings = cmd.archiveSettings();
    this.baseText = this.settings.base;
    this.base = encodeGitPath(this.baseText);
  }

  private get worktree(): Worktree | undefined {
    return this.cmd.archiveWorktree;
  }

  /** `parse_pathspec_arg` and the attribute sources. */
  async prepare(): Promise<void> {
    const threshold = parseGitInt(this.cmd.archiveConfig("core.bigFileThreshold"));
    if (threshold !== undefined && threshold > 0) this.bigFileThreshold = threshold;
    const worktree = this.worktree;
    if (!this.settings.worktreeAttributes) {
      if (worktree?.contentFilter) {
        this.filterContext = {
          direction: "index",
          index: attributesIndexOfTree(this.cmd.archiveTreeLookup as never, this.target.tree),
        };
      } else this.bareResolver = this.cmd.archiveBareAttributes(this.target.tree);
    } else if (!worktree?.contentFilter) {
      this.bareResolver = this.cmd.archiveBareAttributes(undefined);
    } else this.filterContext = { direction: "checkin" };

    const prefix = this.settings.currentDirectory;
    const given = this.settings.paths;
    const elements =
      given.length > 0 ? given.map((p) => prefixedElement(p, prefix)) : prefix ? [prefix] : [];
    this.pathspec = this.parse(elements);
    for (let i = 0; i < given.length; i++) {
      const original = given[i] as string;
      if (!original) continue;
      const items = this.parse([elements[i] as string]);
      if (prefix && (await this.matchesOutside(items, prefix))) {
        throw new GitApiError(
          `fatal: pathspec '${original}' matches files outside the current directory`,
        );
      }
      if (!(await this.pathExists(items))) {
        throw new GitApiError(`fatal: pathspec '${original}' did not match any files`);
      }
    }
  }

  private parse(elements: string[]): PathspecItem[] {
    let items: PathspecItem[];
    try {
      items = parsePathspec(elements, { attr: true });
    } catch (e) {
      throw new GitApiError(`fatal: ${(e as Error).message}`);
    }
    for (const item of items) if (item.attr) item.attrLookup = (p) => this.attrCache.get(p);
    return items;
  }

  /** The attributes of `path` (a directory with `isDirectory`). */
  private async attributes(
    path: string,
    names: readonly string[],
    isDirectory = false,
  ): Promise<ReadonlyMap<string, AttributeValue>> {
    if (this.bareResolver) return this.bareResolver.get(path, names, { isDirectory });
    const filter = this.worktree?.contentFilter as
      | {
          attributes?(
            path: string,
            names: readonly string[],
            context?: ContentAttributesContext,
          ): Promise<Map<string, AttributeValue>>;
        }
      | undefined;
    if (!filter?.attributes) return new Map();
    return filter.attributes(path, names, {
      ...(this.filterContext ?? { direction: "checkin" }),
      ...(isDirectory ? { isDirectory } : {}),
    });
  }

  /** Whether `items` match the file or directory `path` (relative to the tree's top). */
  private async matches(items: PathspecItem[], path: string, isDir: boolean): Promise<boolean> {
    if (items.length === 0) return true;
    if (isDir) {
      // a directory is entered when something below it may match (its attributes aside)
      const plain = items.map((i) => (i.attr ? { ...i, attr: undefined } : i));
      return matchPathspec(plain, path, DO_MATCH_DIRECTORY | DO_MATCH_LEADING_PATHSPEC) > 0;
    }
    await this.loadAttributes(items, path);
    return matchPathspec(items, path, 0) > 0;
  }

  /** The attributes `:(attr)` elements ask of `path`, read once (git asks them as a file's). */
  private async loadAttributes(items: PathspecItem[], path: string): Promise<void> {
    if (this.attrCache.has(path)) return;
    const names = [...new Set(items.flatMap((i) => i.attr?.map((a) => a.name) ?? []))];
    if (names.length > 0) this.attrCache.set(path, await this.attributes(path, names));
  }

  /** `path_exists`' `reject_entry` walk: a file, or a directory the element itself names. */
  private async pathExists(items: PathspecItem[]): Promise<boolean> {
    const walk = async (tree: ObjectId, base: string): Promise<boolean> => {
      for (const entry of await this.cmd.archiveEntries(tree)) {
        const path = `${base}${entry.name}`;
        if (isDirMode(entry.mode)) {
          if (!(await this.matches(items, path, true))) continue;
          // match_pathspec of the directory's own name, its attributes included
          await this.loadAttributes(items, path);
          if (matchPathspec(items, path, DO_MATCH_DIRECTORY) > 0) return true;
          if (await walk(entry.id, `${path}/`)) return true;
        } else if (await this.matches(items, path, false)) return true;
      }
      return false;
    };
    return walk(this.target.tree, "");
  }

  /** `reject_outside`: a file the element matches lies outside `prefix`. */
  private async matchesOutside(items: PathspecItem[], prefix: string): Promise<boolean> {
    const walk = async (tree: ObjectId, base: string): Promise<boolean> => {
      for (const entry of await this.cmd.archiveEntries(tree)) {
        const path = `${base}${entry.name}`;
        if (isDirMode(entry.mode)) {
          if (!(await this.matches(items, path, true))) continue;
          if (await walk(entry.id, `${path}/`)) return true;
        } else if ((await this.matches(items, path, false)) && !path.startsWith(prefix)) {
          return true;
        }
      }
      return false;
    };
    return walk(this.target.tree, "");
  }

  private report(path: Uint8Array): void {
    if (this.settings.verbose) this.settings.messages.push(decodeGitPath(path));
  }

  private emit(entry: ArchiveEntry): void {
    const error = this.writer.entry(entry);
    if (error) throw new GitApiError(`error: ${error}`, { exitCode: 255 });
  }

  /** `write_archive_entries`. */
  async writeEntries(): Promise<void> {
    const base = this.baseText;
    if (base.length > 0 && base.endsWith("/")) {
      let len = base.length;
      while (len > 1 && base[len - 2] === "/") len--;
      const path = this.base.subarray(0, encodeGitPath(base.slice(0, len)).length);
      this.report(path);
      this.emit({ path, mode: 0o40777, id: this.target.tree, content: new Uint8Array(0) });
    }
    await this.walk(this.target.tree, "", []);
    const hexLength = this.target.commitId?.length ?? this.target.tree.length;
    this.extras.forEach((extra, i) => {
      const id = (i + 1).toString(16).padStart(16, "0").padEnd(hexLength, "0");
      const text = extra.virtual ? extra.path : `${extra.base}${baseName(extra.path)}`;
      const path = encodeGitPath(text);
      // zip asks the diff driver of the path less the prefix's length (archive-zip.c)
      this.emit({ path, mode: extra.mode, id, content: extra.content });
    });
  }

  /** `read_tree` with `queue_or_write_archive_entry`. */
  private async walk(tree: ObjectId, base: string, ancestors: Pending[]): Promise<void> {
    for (const entry of await this.cmd.archiveEntries(tree)) {
      const path = `${base}${entry.name}`;
      if (isDirMode(entry.mode)) {
        if (!(await this.matches(this.pathspec, path, true))) continue;
        // git asks for `<dir>/`: a directory
        const attrs = await this.attributes(path, EXPORT_ATTRS, true);
        if (attrs.get("export-ignore") === true) continue;
        ancestors.push({ path, id: entry.id, mode: entry.mode, written: false });
        await this.walk(entry.id, `${path}/`, ancestors);
        ancestors.pop();
        continue;
      }
      if (!(await this.matches(this.pathspec, path, false))) continue;
      // write_directory: the queued directories above it, outermost first
      for (const dir of ancestors) {
        if (dir.written) continue;
        dir.written = true;
        await this.writeEntry(dir.id, dir.path, dir.mode);
      }
      await this.writeEntry(entry.id, path, entry.mode);
    }
  }

  /** `write_archive_entry` for `path` (relative to the tree's top). */
  private async writeEntry(id: ObjectId, path: string, mode: number): Promise<void> {
    const isDir = isDirMode(mode) || isGitlinkMode(mode);
    let convert = false;
    if (!isDirMode(mode)) {
      const attrs = await this.attributes(path, EXPORT_ATTRS, isGitlinkMode(mode));
      if (attrs.get("export-ignore") === true) return;
      convert = attrs.get("export-subst") === true;
    }
    let rel = isDir ? `${path}/` : path;
    const prefix = this.settings.currentDirectory;
    if (prefix) {
      if (!rel.startsWith(prefix) || rel === prefix) return;
      rel = rel.slice(prefix.length);
    }
    const archivePath = encodeGitPath(`${this.baseText}${rel}`);
    this.report(archivePath);
    if (isDir) {
      this.emit({ path: archivePath, mode, id, content: new Uint8Array(0) });
      return;
    }
    let content = await this.cmd.archiveBlob(id);
    if (!content) throw new GitApiError(`error: cannot read '${id}'`, { exitCode: 255 });
    const streamed = isRegMode(mode) && !convert && content.length > this.bigFileThreshold;
    if (isRegMode(mode) && !streamed) {
      content = await this.smudge(path, content, mode);
      if (convert && this.target.commitId) content = await this.substitute(content);
    }
    const entry: ArchiveEntry = { path: archivePath, mode, id, content };
    if (streamed) entry.streamed = true;
    if (isRegMode(mode) || (mode & 0o170000) === 0o120000) {
      const binary = await this.binaryOf(path);
      if (binary !== undefined) entry.binary = binary;
    }
    this.emit(entry);
  }

  /** zip's `entry_is_binary`: the diff driver's `binary`, undefined to look at the content. */
  private async binaryOf(path: string): Promise<boolean | undefined> {
    const value = (await this.attributes(path, ["diff"])).get("diff");
    // userdiff.c's driver_false and driver_true
    if (value === false) return true;
    if (value === true) return false;
    const name = typeof value === "string" ? value : "default";
    const setting = this.cmd.archiveConfig(`diff.${name}.binary`);
    return setting === undefined ? undefined : parseGitBool(setting);
  }

  /** `convert_to_working_tree` with the archive's attributes. */
  private async smudge(path: string, content: Uint8Array, mode: number): Promise<Uint8Array> {
    const filter = this.worktree?.contentFilter;
    if (!filter || this.bareResolver) return content;
    const out = await smudgeContent(filter, path, content, mode, this.filterContext);
    if (out instanceof Uint8Array) return out;
    const chunks: Uint8Array[] = [];
    for await (const c of out as AsyncIterable<Uint8Array>) chunks.push(c);
    return join(chunks);
  }

  /** `format_subst`: each `$Format:<fmt>$` expanded for the commit. */
  private async substitute(content: Uint8Array): Promise<Uint8Array> {
    const text = latin1(content);
    let out = "";
    let at = 0;
    for (;;) {
      const b = text.indexOf("$Format:", at);
      if (b < 0) break;
      const c = text.indexOf("$", b + 8);
      if (c < 0) break;
      out += text.slice(at, b);
      const { format, describe } = this.limitDescribe(text.slice(b + 8, c));
      const expanded = await this.cmd.archiveSubstitute(
        decodeGitPath(latin1Bytes(format)),
        this.target.commitId as ObjectId,
        describe,
      );
      out += latin1(encodeGitPath(expanded));
      at = c + 1;
    }
    out += text.slice(at);
    return latin1Bytes(out);
  }

  /**
   * `%(describe)` expands once per archive (`describe_status.max_invocations`): later ones
   * stay as written, escaped here so the formatter keeps them.
   */
  private limitDescribe(format: string): { format: string; describe: boolean } {
    let out = "";
    let describe = false;
    for (let i = 0; i < format.length; i++) {
      if (format[i] === "%" && format[i + 1] === "%") {
        out += "%%";
        i++;
        continue;
      }
      if (format.startsWith("%(describe", i)) {
        if (this.describeBudget > 0) {
          this.describeBudget--;
          describe = true;
          out += "%";
        } else out += "%%";
        continue;
      }
      out += format[i];
    }
    return { format: out, describe };
  }
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return s;
}

function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
