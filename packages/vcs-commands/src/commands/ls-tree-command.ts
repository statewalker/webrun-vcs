/**
 * `git ls-tree` (builtin/ls-tree.c): the entries of a tree, byte for byte as git prints them.
 *
 * @example
 * ```typescript
 * // git ls-tree -r --name-only HEAD src/
 * const { stdout } = await git.lsTree().setTreeish("HEAD").setRecursive(true)
 *   .setNameOnly().addPaths("src/").callOutput();
 * ```
 */

import { parseGitBool } from "@statewalker/vcs-utils";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { RefNotFoundError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { quoteCStyleBody } from "../results/quote-path.js";
import { prefixPathGently, relativePath } from "./git-paths.js";
import {
  ALL_ENTRIES_INTERESTING,
  ALL_ENTRIES_NOT_INTERESTING,
  ENTRY_NOT_INTERESTING,
  latin1Bytes,
  latin1String,
  type PathspecItem,
  pathspecItemBytes,
  type TreePathspec,
  treeEntryInteresting,
  treePathspec,
} from "./pathspec.js";
import { PlumbingCommand, PlumbingError } from "./plumbing-command.js";
import { concatBytes, objectTypeOfMode, SHORT_MAGIC } from "./plumbing-shared.js";

/** ls-tree's `cmdmode`: the output options that exclude one another. */
export type LsTreeMode = "long" | "name-only" | "name-status" | "object-only";

/** The fast paths ls-tree takes for a `--format` equal to a mode's own format. */
const MODE_FORMATS: ["default" | "long" | "name-only" | "object-only", string][] = [
  ["default", "%(objectmode) %(objecttype) %(objectname)%x09%(path)"],
  ["long", "%(objectmode) %(objecttype) %(objectname) %(objectsize:padded)%x09%(path)"],
  ["name-only", "%(path)"],
  ["object-only", "%(objectname)"],
];

const USAGE = "usage: git ls-tree [<options>] <tree-ish> [<path>...]";

/** pathspec.c's `pathspec_magic`: the bits, mnemonics and names, in its order */
const MAGIC = [
  { name: "top", mnemonic: "/" },
  { name: "literal", mnemonic: "" },
  { name: "glob", mnemonic: "" },
  { name: "icase", mnemonic: "" },
  { name: "exclude", mnemonic: "!" },
  { name: "attr", mnemonic: "" },
] as const;

const FLUSH_AT = 64 * 1024;

/**
 * `git ls-tree [<options>] <tree-ish> [<path>...]`.
 *
 * Paths are ls-tree's own: literal pathspecs (only `:(top)` and `:(literal)` magic), a tree
 * shown or entered by leading path components (`show_recursive`), not wildcard matches.
 * Output paths are relative to {@link setPrefix} unless `--full-name`/`--full-tree`.
 *
 * git 2.43 (`setCompatibility("2.43")`) words the conflict of two output modes as
 * `error: <b> is incompatible with <a>`, 2.45 and later as `error: options '<b>' and '<a>'
 * cannot be used together`. Usage errors exit 129 with that first line only (git prints its
 * usage after it).
 */
export class LsTreeCommand extends PlumbingCommand {
  private treeish?: string;
  private readonly paths: string[] = [];
  private treesOnly = false;
  private recursive = false;
  private showTrees = false;
  private nul = false;
  private readonly modes: { mode: LsTreeMode; option: string }[] = [];
  private fullName?: boolean;
  private fullTree = false;
  private format?: string;
  private abbrev = 0;
  private prefix = "";
  private compatibility: "2.43" | "2.56" = "2.56";

  /** The `<tree-ish>` argument. */
  setTreeish(name: string): this {
    this.checkCallable();
    this.treeish = name;
    return this;
  }

  /** `<path>...` arguments, read against {@link setPrefix}. */
  addPaths(...paths: string[]): this {
    this.checkCallable();
    this.paths.push(...paths);
    return this;
  }

  /** `-d`: only trees (and gitlinks). */
  setTreesOnly(on = true): this {
    this.checkCallable();
    this.treesOnly = on;
    return this;
  }

  /** `-r`: recurse into subtrees. */
  setRecursive(on = true): this {
    this.checkCallable();
    this.recursive = on;
    return this;
  }

  /** `-t`: show the trees recursed into. */
  setShowTrees(on = true): this {
    this.checkCallable();
    this.showTrees = on;
    return this;
  }

  /** `-z`: entries end with NUL, paths unquoted. */
  setNullTerminated(on = true): this {
    this.checkCallable();
    this.nul = on;
    return this;
  }

  /**
   * An output mode option (`-l`/`--long`, `--name-only`, `--name-status`, `--object-only`),
   * `option` its spelling for git's conflict message; a second, different mode is refused.
   */
  addMode(mode: LsTreeMode, option = `--${mode}`): this {
    this.checkCallable();
    this.modes.push({ mode, option });
    return this;
  }

  /** `-l`/`--long`: object sizes. */
  setLong(option = "--long"): this {
    return this.addMode("long", option);
  }

  /** `--name-only`: paths only. */
  setNameOnly(): this {
    return this.addMode("name-only");
  }

  /** `--name-status`: as `--name-only`. */
  setNameStatus(): this {
    return this.addMode("name-status");
  }

  /** `--object-only`: object names only. */
  setObjectOnly(): this {
    return this.addMode("object-only");
  }

  /** `--[no-]full-name`: paths from the top (default: on when there is no prefix). */
  setFullName(on = true): this {
    this.checkCallable();
    this.fullName = on;
    return this;
  }

  /** `--full-tree`: the whole tree, paths from the top, the prefix ignored. */
  setFullTree(on = true): this {
    this.checkCallable();
    this.fullTree = on;
    return this;
  }

  /** `--format=<format>`. */
  setFormat(format: string): this {
    this.checkCallable();
    this.format = format;
    return this;
  }

  /**
   * `--abbrev[=<n>]`: `undefined` is `--abbrev` (core.abbrev, else automatic), 0 the full
   * id (`--no-abbrev`), else at least `n` digits (4 at least).
   */
  setAbbrev(length?: number): this {
    this.checkCallable();
    this.abbrev = length === undefined ? -1 : length;
    return this;
  }

  /** The directory git runs in, relative to the top of the worktree (git's prefix). */
  setPrefix(prefix: string): this {
    this.checkCallable();
    const p = prefix.replace(/^\/+|\/+$/g, "");
    this.prefix = p ? `${p}/` : "";
    return this;
  }

  /** The git version whose messages to follow (default 2.56). */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  protected override writesNoObjects(): boolean {
    return true;
  }

  private out: Uint8Array[] = [];
  private outSize = 0;

  private emit(bytes: Uint8Array): Promise<void> | undefined {
    this.out.push(bytes);
    this.outSize += bytes.length;
    return this.outSize >= FLUSH_AT ? this.flush() : undefined;
  }

  private async flush(): Promise<void> {
    if (this.outSize === 0) return;
    const all = new Uint8Array(this.outSize);
    let at = 0;
    for (const c of this.out) {
      all.set(c, at);
      at += c.length;
    }
    this.out = [];
    this.outSize = 0;
    await this.write(all);
  }

  protected async run(): Promise<number> {
    // parse_options: OPT_CMDMODE refuses a second, different mode
    let mode: LsTreeMode | undefined;
    let modeOption = "";
    for (const m of this.modes) {
      if (mode !== undefined && m.mode !== mode) {
        throw new PlumbingError(
          this.compatibility === "2.43"
            ? `error: ${m.option} is incompatible with ${modeOption}`
            : `error: options '${m.option}' and '${modeOption}' cannot be used together`,
          129,
        );
      }
      mode = m.mode;
      modeOption = m.option;
    }
    if (mode === "name-status") mode = "name-only";
    let prefix: string | undefined = this.prefix || undefined;
    if (this.fullTree) prefix = undefined;
    const fullName = this.fullName ?? !this.prefix;
    const outputPrefix = fullName ? undefined : prefix;
    let showTrees = this.showTrees;
    // -d -r implies -t
    if (this.treesOnly && this.recursive) showTrees = true;
    if (this.format !== undefined && mode !== undefined) {
      throw new PlumbingError(
        "fatal: --format can't be combined with other format-altering options",
        129,
      );
    }
    if (this.treeish === undefined) throw new PlumbingError(USAGE, 129);

    const resolver = this.revisionResolver();
    let id: string | undefined;
    try {
      // GET_OID_HASH_ANY: a tree named by an id of the compatibility format is listed with
      // that format's ids
      id = await resolver.resolve(this.treeish, { hashAny: true });
    } catch (e) {
      if (!(e instanceof RefNotFoundError)) throw e;
    }
    for (const w of resolver.warnings) this.warn(w);
    resolver.warnings.length = 0;
    if (id === undefined) throw new PlumbingError(`fatal: Not a valid object name ${this.treeish}`);

    const items = await this.parsePaths(prefix);
    const tree = await this.peelToTree(id);
    if (tree === undefined) throw new PlumbingError("fatal: not a tree object");

    let fn: "default" | "long" | "name-only" | "object-only" | "format";
    if (this.format !== undefined) {
      const fast = MODE_FORMATS.find(([, f]) => f === this.format);
      fn = fast ? fast[0] : "format";
    } else fn = mode ?? "default";

    const config = this._workingCopy.config ? RemoteConfigStore.from(this._workingCopy) : undefined;
    const quotePathValue = config?.value("core.quotePath");
    const quoteFully = quotePathValue === undefined ? true : (parseGitBool(quotePathValue) ?? true);

    const ctx: WalkContext = {
      items,
      ps: items.length > 0 ? treePathspec(items) : undefined,
      fn,
      treesOnly: this.treesOnly,
      recursive: this.recursive,
      showTrees,
      outputPrefix:
        outputPrefix === undefined ? undefined : latin1String(encodeGitPath(outputPrefix)),
      quoteFully,
      nulTerminated: this.nul,
    };
    let ok: boolean;
    try {
      ok = await this.walk(ctx, tree, "");
    } finally {
      await this.flush();
    }
    return ok ? 0 : 1;
  }

  /** parse_pathspec with ls-tree's magic mask and PATHSPEC_PREFER_CWD: literal elements. */
  private async parsePaths(prefix: string | undefined): Promise<PathspecItem[]> {
    const literal = (match: string): PathspecItem =>
      pathspecItemBytes({
        match,
        nowildcardLen: match.length,
        oneStar: false,
        exclude: false,
        glob: false,
        icase: false,
      });
    if (this.paths.length === 0) return prefix ? [literal(prefix)] : [];
    for (const p of this.paths) {
      if (p === "") {
        throw new PlumbingError(
          "fatal: empty string is not a valid pathspec. please use . instead if you meant to match all paths",
        );
      }
    }
    const items: PathspecItem[] = [];
    for (const elem of this.paths) {
      const { magic, rest } = parseElementMagic(elem);
      if (magic.has("literal") && magic.has("glob")) {
        throw new PlumbingError(`fatal: ${elem}: 'literal' and 'glob' are incompatible`);
      }
      let match: string;
      if (magic.has("top")) match = rest;
      else {
        const normalized = await this.prefixPath(prefix ?? "", rest);
        if (normalized === undefined) {
          const top = (await this.hostWorkingDir()) ?? "";
          throw new PlumbingError(
            `fatal: ${elem}: '${rest}' is outside repository at '${top.replace(/\/+$/, "") || "/"}'`,
          );
        }
        match = normalized;
      }
      const unsupported = unsupportedPathspecMagic(elem, magic, ["top", "literal"]);
      if (unsupported) throw new PlumbingError(`fatal: ${unsupported}`);
      items.push(literal(match));
    }
    return items;
  }

  /** prefix_path_gently: the path from the top, undefined when it leaves the worktree. */
  private async prefixPath(prefix: string, path: string): Promise<string | undefined> {
    return prefixPathGently(
      prefix,
      path,
      path.startsWith("/") ? await this.hostWorkingDir() : undefined,
    );
  }

  /** parse_tree_indirect: a commit's tree, a tag's object peeled, a tree itself. */
  private async peelToTree(id: string): Promise<string | undefined> {
    const compat = this.compatObjects;
    if (compat && id.length !== this.objectFormat.hexLength) {
      // git parses an object named by a compatibility id with the storage format's parsers:
      // a tree reads (its entries decoded at the id's width), a commit's `tree` line is too
      // short for them (`bogus commit object`), a blob is hashed with the storage format's
      // hash (`hash mismatch`), a tag fails quietly
      const type = (await compat.readAsCompat(id).catch(() => undefined))?.type;
      if (type === "tree") return id;
      if (type === "commit") this.warn(`error: bogus commit object ${id}`);
      if (type === "blob") this.warn(`error: hash mismatch ${id}`);
      return undefined;
    }
    const peeled = await this.revisionResolver().peelTags(id);
    if (peeled.type === "tree") return peeled.id;
    if (peeled.type === "commit") {
      const commit = await this.commits.load(peeled.id).catch(() => undefined);
      return commit?.tree;
    }
    return undefined;
  }

  /** read_tree_at: false when a tree could not be read (git's `-1`). */
  private async walk(ctx: WalkContext, tree: string, base: string): Promise<boolean> {
    const entries = await this.listedTreeEntries(tree);
    if (!entries) {
      this.warn(`error: Could not read ${tree}`);
      return false;
    }
    const baseBytes = latin1Bytes(base);
    let all = false;
    for (const e of entries) {
      const nameBytes = encodeGitPath(e.name);
      const mode = e.mode;
      if (ctx.ps && !all) {
        const r = treeEntryInteresting(ctx.ps, nameBytes, 0, nameBytes.length, mode, baseBytes);
        if (r === ALL_ENTRIES_NOT_INTERESTING) break;
        if (r === ENTRY_NOT_INTERESTING) continue;
        if (r === ALL_ENTRIES_INTERESTING) all = true;
      }
      const name = latin1String(nameBytes);
      const type = objectTypeOfMode(mode);
      // show_tree_common / show_tree_fmt
      let recurse = false;
      let show = true;
      if (type === "blob") {
        if (ctx.treesOnly) show = false;
      } else if (type === "tree" && this.showRecursive(ctx, base, name)) {
        recurse = true;
        if (!ctx.showTrees) show = false;
      }
      if (show) {
        const pending = this.emit(await this.entryLine(ctx, e.id, mode, type, base + name));
        if (pending) await pending;
      }
      if (recurse && !(await this.walk(ctx, e.id, `${base + name}/`))) return false;
    }
    return true;
  }

  /** show_recursive: whether a tree is entered. */
  private showRecursive(ctx: WalkContext, base: string, pathname: string): boolean {
    if (ctx.recursive) return true;
    for (const item of ctx.items) {
      const spec = item.match;
      if (!spec.startsWith(base)) continue;
      const rest = spec.slice(base.length);
      const len = pathname.length;
      if (rest.length <= len) continue;
      if (rest[len] !== "/") continue;
      if (rest.slice(0, len) !== pathname) continue;
      return true;
    }
    return false;
  }

  private async abbreviated(id: string): Promise<string> {
    if (this.abbrev === 0) return id;
    if (id.length !== this.objectFormat.hexLength) {
      // an id of the compatibility format: the minimum asked (default 7), not measured
      // against the repository's ids
      const min = this.abbrev < 0 ? 7 : Math.max(4, this.abbrev);
      return id.slice(0, Math.min(min, id.length));
    }
    const hex = this.objectFormat.hexLength;
    const min =
      this.abbrev < 0 ? undefined : this.abbrev < 4 ? 4 : this.abbrev > hex ? hex : this.abbrev;
    const length = (await this.idAbbreviator().lengths([id], min)).get(id) ?? hex;
    return id.slice(0, length);
  }

  /** The blob's size, undefined when it cannot be read. */
  private async blobSize(id: string): Promise<number | undefined> {
    const compat = this.compatObjects;
    if (compat && id.length !== this.objectFormat.hexLength) {
      return (await compat.readAsCompat(id).catch(() => undefined))?.content.length;
    }
    const objects = this._workingCopy.history?.objects;
    try {
      if (objects) {
        // the entry headers when the store can read them (oid_object_info), else the object
        const header = await objects.header?.(id);
        if (header) return header.size;
        const obj = await objects.get(id);
        if (!obj) return undefined;
        await obj.content[Symbol.asyncIterator]().return?.();
        return obj.size;
      }
      return await this.blobs.size(id);
    } catch {
      return undefined;
    }
  }

  /** The path (a byte string) as the fast paths print it. */
  private fastPath(ctx: WalkContext, path: string): Uint8Array {
    const rel = relativePath(path, ctx.outputPrefix);
    if (ctx.nulTerminated) return latin1Bytes(`${rel}\0`);
    return latin1Bytes(`${quoteBytes(rel, ctx.quoteFully)}\n`);
  }

  private async entryLine(
    ctx: WalkContext,
    id: string,
    mode: number,
    type: string,
    path: string,
  ): Promise<Uint8Array> {
    const modeText = mode.toString(8).padStart(6, "0");
    switch (ctx.fn) {
      case "default":
        return concatBytes([
          latin1Bytes(`${modeText} ${type} ${await this.abbreviated(id)}\t`),
          this.fastPath(ctx, path),
        ]);
      case "long": {
        let size = "-";
        if (type === "blob") size = String((await this.blobSize(id)) ?? "BAD");
        return concatBytes([
          latin1Bytes(`${modeText} ${type} ${await this.abbreviated(id)} ${size.padStart(7)}\t`),
          this.fastPath(ctx, path),
        ]);
      }
      case "name-only":
        return this.fastPath(ctx, path);
      case "object-only":
        return latin1Bytes(`${await this.abbreviated(id)}${this.nul ? "\0" : "\n"}`);
      default:
        return latin1Bytes(
          `${await this.expandFormat(ctx, id, modeText, type, path)}${this.nul ? "\0" : "\n"}`,
        );
    }
  }

  /** show_tree_fmt's expansion (a byte string). */
  private async expandFormat(
    ctx: WalkContext,
    id: string,
    modeText: string,
    type: string,
    path: string,
  ): Promise<string> {
    const format = latin1String(encodeGitPath(this.format ?? ""));
    let out = "";
    let i = 0;
    const size = async (padded: boolean) => {
      let text = "-";
      if (type === "blob") {
        const s = await this.blobSize(id);
        if (s === undefined)
          throw new PlumbingError(`fatal: could not get object info about '${id}'`);
        text = String(s);
      }
      return padded ? text.padStart(7) : text;
    };
    while (i < format.length) {
      const at = format.indexOf("%", i);
      if (at < 0) {
        out += format.slice(i);
        break;
      }
      out += format.slice(i, at);
      i = at + 1;
      const rest = format.slice(i);
      if (rest.startsWith("%")) {
        out += "%";
        i += 1;
        continue;
      }
      if (rest.startsWith("n")) {
        out += "\n";
        i += 1;
        continue;
      }
      const hex = /^x([0-9a-fA-F]{2})/.exec(rest);
      if (hex) {
        out += String.fromCharCode(Number.parseInt(hex[1] as string, 16));
        i += 3;
        continue;
      }
      const atom = /^\((objectmode|objecttype|objectsize:padded|objectsize|objectname|path)\)/.exec(
        rest,
      );
      if (!atom) {
        const shown = decodeLatin1Path(rest);
        if (!rest.startsWith("(")) {
          throw new PlumbingError(
            `fatal: bad ls-tree format: element '${shown}' does not start with '('`,
          );
        }
        const close = rest.indexOf(")", 1);
        if (close < 0) {
          throw new PlumbingError(
            `fatal: bad ls-tree format: element '${shown}' does not end in ')'`,
          );
        }
        throw new PlumbingError(
          `fatal: bad ls-tree format: %${decodeLatin1Path(rest.slice(0, close + 1))}`,
        );
      }
      i += atom[0].length;
      switch (atom[1]) {
        case "objectmode":
          out += modeText;
          break;
        case "objecttype":
          out += type;
          break;
        case "objectsize:padded":
          out += await size(true);
          break;
        case "objectsize":
          out += await size(false);
          break;
        case "objectname":
          out += await this.abbreviated(id);
          break;
        default:
          out += quoteBytes(relativePath(path, ctx.outputPrefix), ctx.quoteFully);
      }
    }
    return out;
  }
}

interface WalkContext {
  items: PathspecItem[];
  ps: TreePathspec | undefined;
  fn: "default" | "long" | "name-only" | "object-only" | "format";
  treesOnly: boolean;
  recursive: boolean;
  showTrees: boolean;
  /** The prefix paths are printed relative to (a byte string), if any */
  outputPrefix: string | undefined;
  quoteFully: boolean;
  nulTerminated: boolean;
}

/** A byte string as git prints it in an error message (bytes as they are). */
function decodeLatin1Path(s: string): string {
  return new TextDecoder().decode(latin1Bytes(s));
}

/** quote_c_style of a byte string, as a byte string. */
function quoteBytes(path: string, quoteFully: boolean): string {
  const body = quoteCStyleBody(latin1Bytes(path), quoteFully);
  if (body === undefined) return path;
  return latin1String(encodeGitPath(`"${body}"`));
}

/**
 * git's `unsupported_magic` message for the magic of `elem` outside `allowed` (a command's
 * `magic_mask`), undefined when it has none.
 */
export function unsupportedPathspecMagic(
  elem: string,
  magic: ReadonlySet<string>,
  allowed: readonly string[],
): string | undefined {
  const unsupported = MAGIC.filter((m) => !allowed.includes(m.name) && magic.has(m.name));
  if (unsupported.length === 0) return undefined;
  const names = unsupported
    .map((m) => (m.mnemonic ? `'${m.name}' (mnemonic: '${m.mnemonic}')` : `'${m.name}'`))
    .join(", ");
  return `${elem}: pathspec magic not supported by this command: ${names}`;
}

/** parse_element_magic: the magic names an element carries and the path after them. */
export function parseElementMagic(elem: string): { magic: Set<string>; rest: string } {
  const magic = new Set<string>();
  if (!elem.startsWith(":")) return { magic, rest: elem };
  if (elem[1] === "(") {
    let pos = 2;
    while (pos < elem.length && elem[pos] !== ")") {
      let len = 0;
      while (pos + len < elem.length && elem[pos + len] !== "," && elem[pos + len] !== ")") {
        if (elem[pos + len] === "\\" && pos + len + 1 < elem.length) len++;
        len++;
      }
      const next = elem[pos + len] === "," ? pos + len + 1 : pos + len;
      const word = elem.slice(pos, pos + len);
      pos = next;
      if (!word) continue;
      if (word.startsWith("prefix:")) {
        if (!/^-?\d+$/.test(word.slice(7))) {
          throw new PlumbingError("fatal: invalid parameter for pathspec magic 'prefix'");
        }
        continue;
      }
      if (word.startsWith("attr:")) {
        magic.add("attr");
        continue;
      }
      if (!MAGIC.some((m) => m.name === word)) {
        throw new PlumbingError(`fatal: Invalid pathspec magic '${word}' in '${elem}'`);
      }
      magic.add(word);
    }
    if (elem[pos] !== ")") {
      throw new PlumbingError(`fatal: Missing ')' at the end of pathspec magic in '${elem}'`);
    }
    return { magic, rest: elem.slice(pos + 1) };
  }
  let pos = 1;
  for (; pos < elem.length && elem[pos] !== ":"; pos++) {
    const ch = elem[pos] as string;
    if (ch === "^") {
      magic.add("exclude");
      continue;
    }
    if (!SHORT_MAGIC.has(ch)) break;
    const m = MAGIC.find((x) => x.mnemonic === ch);
    if (!m) throw new PlumbingError(`fatal: Unimplemented pathspec magic '${ch}' in '${elem}'`);
    magic.add(m.name);
  }
  if (elem[pos] === ":") pos++;
  return { magic, rest: elem.slice(pos) };
}
