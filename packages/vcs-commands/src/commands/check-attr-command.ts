/**
 * `git check-attr` (builtin/check-attr.c): the attributes of paths as git's attribute
 * stack gives them, from the worktree's `.gitattributes` files (then the index's), the
 * index's alone (`--cached`), or a tree's (`--source`).
 *
 * @example
 * ```typescript
 * // git check-attr text eol -- a.txt
 * await git.checkAttr().addAttribute("text").addAttribute("eol").addPath("a.txt").call();
 * // { exitCode: 0, stdout: "a.txt: text: set\na.txt: eol: unspecified\n", stderr: "" }
 * ```
 */

import {
  AttributesMemo,
  AttributesSourceError,
  type AttributeValue,
  isValidAttributeName,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import { GitCommand } from "../git-command.js";
import { quotePath } from "../results/quote-path.js";
import { attributesSourceResolver, bareAttributesResolver } from "./attributes-source.js";
import type { PlumbingTextOutput } from "./check-ref-format-command.js";
import { configBool } from "./merge-config.js";
import { directoryPrefix, inputRecords, prefixPath } from "./plumbing-input.js";
import { worktreeHostPath } from "./submodule-model.js";

const USAGE =
  "usage: git check-attr [--source <tree-ish>] [-a | --all | <attr>...] [--] <pathname>...\n" +
  "   or: git check-attr --stdin [-z] [--source <tree-ish>] [-a | --all | <attr>...]\n\n" +
  "    -a, --[no-]all        report all attributes set on file\n" +
  "    --[no-]cached         use .gitattributes only from the index\n" +
  "    --[no-]stdin          read file names from stdin\n" +
  "    -z                    terminate input and output records by a NUL character\n" +
  "    --[no-]source <tree-ish>\n" +
  "                          which tree-ish to check attributes at\n\n";

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFGITLINK = 0o160000;

/**
 * An attributes file's message as git prints it: its `warning()`s (negative patterns, an
 * overly long line or large file) prefixed, the others (an invalid name, a macro where none
 * is allowed) as they are.
 */
export function attributeWarningLine(message: string): string {
  return message.startsWith("Negative patterns") || message.startsWith("ignoring overly")
    ? `warning: ${message}`
    : message;
}

/** What reads the attributes of one path. */
interface AttributeReader {
  get(path: string, names: string[] | undefined): Promise<Map<string, AttributeValue>>;
  order(path: string, order: Set<string>): Promise<unknown>;
}

/**
 * `git check-attr [--source <tree-ish>] [--cached] [-a | <attr>...] [--] <pathname>...` or
 * with `--stdin` [-z]: one line per path and attribute, `<path>: <attr>: <value>` (the path
 * as given, C-quoted as `core.quotePath` asks), the value `set`, `unset`, `unspecified` or
 * the string. `--all` lists the attributes a path has, in the order git first read their
 * names. git's argument errors give its usage (129); an invalid attribute name exits 255, a
 * bad `--source` 128. Paths are read against {@link setCurrentDirectory}. git 2.5x computes
 * `builtin_objectmode` (the path's mode in the worktree, or the index's with `--cached`).
 */
export class CheckAttrCommand extends GitCommand<PlumbingTextOutput> {
  private readonly attributes: string[] = [];
  private readonly paths: string[] = [];
  private all = false;
  private cached = false;
  private stdin?: Uint8Array;
  private nul = false;
  private source?: string;
  private prefix = "";
  private compatibility: "2.43" | "2.56" = "2.56";

  /** An attribute to report. */
  addAttribute(name: string): this {
    this.checkCallable();
    this.attributes.push(name);
    return this;
  }

  /** A path to check. */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /** `--all`: every attribute set on each path. */
  setAll(all: boolean): this {
    this.checkCallable();
    this.all = all;
    return this;
  }

  /** `--cached`: the index's `.gitattributes` files only. */
  setCached(cached: boolean): this {
    this.checkCallable();
    this.cached = cached;
    return this;
  }

  /** `--stdin`: the paths of this input (git's stdin). */
  setStdin(input: string | Uint8Array): this {
    this.checkCallable();
    this.stdin = typeof input === "string" ? new TextEncoder().encode(input) : input;
    return this;
  }

  /** `-z`: NUL-terminated input records and output fields. */
  setNulTerminated(nul: boolean): this {
    this.checkCallable();
    this.nul = nul;
    return this;
  }

  /** `--source <tree-ish>`: the in-tree files of this tree-ish. */
  setSource(treeish: string | undefined): this {
    this.checkCallable();
    this.source = treeish;
    return this;
  }

  /** The directory git runs in, from the top of the worktree (paths are relative to it). */
  setCurrentDirectory(dir: string): this {
    this.checkCallable();
    this.prefix = directoryPrefix(dir);
    return this;
  }

  /** The git version whose behaviour to follow (default 2.56). */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  async call(): Promise<PlumbingTextOutput> {
    this.checkCallable();
    this.setCallable(false);
    const usage = (message: string) => ({
      exitCode: 129,
      stdout: "",
      stderr: `error: ${message}\n${USAGE}`,
    });
    if (this.all && this.attributes.length > 0) return usage("Attributes and --all both specified");
    if (!this.all && this.attributes.length === 0) return usage("No attribute specified");
    if (this.stdin !== undefined && this.paths.length > 0) {
      return usage("Can't specify files with --stdin");
    }
    if (this.stdin === undefined && this.paths.length === 0) return usage("No file specified");
    for (const name of this.attributes) {
      if (!isValidAttributeName(name)) {
        return {
          exitCode: 255,
          stdout: "",
          stderr: `error: ${name}: not a valid attribute name\n`,
        };
      }
    }
    let sourceTree: string | undefined;
    if (this.source !== undefined) {
      const found = await attributesSourceResolver(() => this.revisionResolver())(
        this.source,
      ).catch(() => undefined);
      if (!found) {
        return {
          exitCode: 128,
          stdout: "",
          stderr: `fatal: ${this.source}: not a valid tree-ish source\n`,
        };
      }
      sourceTree = found.tree ?? "";
    }
    let stdout = "";
    let stderr = "";
    const warn = (message: string) => {
      stderr += `${attributeWarningLine(message)}\n`;
    };
    const die = (message: string) => ({
      exitCode: 128,
      stdout,
      stderr: `${stderr}fatal: ${message}\n`,
    });
    let paths = this.paths;
    let badlyQuoted = false;
    if (this.stdin !== undefined)
      ({ records: paths, badlyQuoted } = inputRecords(this.stdin, this.nul));
    const quoteFully = configBool(this._workingCopy, "core.quotePath", true);
    const worktree = this.worktreeIfAny();
    const reader = this.reader(worktree, sourceTree, warn);
    const order = new Set<string>();
    const run = async () => {
      for (const file of paths) {
        const full = prefixPath(this.prefix, file);
        if (full === undefined) {
          const top = (await worktreeHostPath(this._workingCopy)) ?? "";
          return die(`'${file}' is outside repository at '${top}'`);
        }
        const names = this.all ? undefined : this.attributes;
        const values = await reader.get(full, names);
        let items: [string, AttributeValue][];
        if (this.all) {
          await reader.order(full, order);
          items = [...order]
            .filter((n) => values.get(n) !== undefined)
            .map((n) => [n, values.get(n)]);
        } else {
          items = [];
          for (const name of this.attributes) {
            let value = values.get(name);
            if (
              value === undefined &&
              name === "builtin_objectmode" &&
              this.compatibility !== "2.43"
            ) {
              const mode = await this.objectMode(full);
              if (typeof mode === "object") return die(mode.error);
              value = mode;
            }
            items.push([name, value]);
          }
        }
        for (const [name, value] of items) {
          const text =
            value === true
              ? "set"
              : value === false
                ? "unset"
                : value === undefined
                  ? "unspecified"
                  : value;
          stdout += this.nul
            ? `${file}\0${name}\0${text}\0`
            : `${quotePath(file, quoteFully)}: ${name}: ${text}\n`;
        }
      }
      if (badlyQuoted) return die("line is badly quoted");
      return { exitCode: 0, stdout, stderr };
    };
    try {
      return worktree?.batch
        ? await worktree.batch(run, { onAttributeWarning: warn })
        : await run();
    } catch (error) {
      if (error instanceof AttributesSourceError) return die(error.message);
      throw error;
    }
  }

  /** The worktree; undefined in a bare repository. */
  private worktreeIfAny(): Worktree | undefined {
    return "worktree" in this._workingCopy ? this._workingCopy.worktree : undefined;
  }

  /** Where the attributes come from: the content filter's stack, or the bare resolver's. */
  private reader(
    worktree: Worktree | undefined,
    sourceTree: string | undefined,
    warn: (message: string) => void,
  ): AttributeReader {
    const filter = worktree?.contentFilter as
      | {
          attributes?(
            path: string,
            names: readonly string[] | undefined,
            context: { direction: "checkin" | "index" },
          ): Promise<Map<string, AttributeValue>>;
          attributeNameOrder?(
            path: string,
            order: Set<string>,
            context: { direction: "checkin" | "index" },
          ): Promise<Set<string>>;
        }
      | undefined;
    const useFilter =
      worktree &&
      filter?.attributes &&
      filter.attributeNameOrder &&
      (this.cached || sourceTree === undefined);
    if (useFilter && filter?.attributes && filter.attributeNameOrder) {
      const context = { direction: this.cached ? ("index" as const) : ("checkin" as const) };
      const attributes = filter.attributes.bind(filter);
      const nameOrder = filter.attributeNameOrder.bind(filter);
      return {
        get: (path, names) => attributes(path, names, context),
        order: (path, order) => nameOrder(path, order, context),
      };
    }
    // a bare repository, or the files of a tree
    const { history } = this._workingCopy;
    const resolver = bareAttributesResolver({
      workingCopy: this._workingCopy,
      trees: history.trees,
      blobs: history.blobs,
      revisions: () => this.revisionResolver(),
      ...(sourceTree !== undefined ? { sourceTree } : {}),
    });
    const memo = new AttributesMemo(warn);
    return {
      get: (path, names) => resolver.get(path, names, { memo }),
      order: (path, order) => resolver.nameOrder(path, order, { memo }),
    };
  }

  /** attr.c's `builtin_object_mode_attr`: the mode as `%06o`, or unspecified. */
  private async objectMode(path: string): Promise<string | undefined | { error: string }> {
    const octal = (mode: number) => mode.toString(8).padStart(6, "0");
    const staging =
      "checkout" in this._workingCopy ? this._workingCopy.checkout?.staging : undefined;
    const indexEntry = await staging?.getEntry(path, 0).catch(() => undefined);
    if (this.cached) return indexEntry ? octal(indexEntry.mode) : undefined;
    const entry = await this.worktreeIfAny()
      ?.getEntry(path)
      .catch(() => undefined);
    if (!entry) return { error: `unable to stat '${path}': No such file or directory` };
    if (entry.isDirectory || (entry.mode & S_IFMT) === S_IFDIR) {
      if (indexEntry && (indexEntry.mode & S_IFMT) === S_IFGITLINK) return octal(indexEntry.mode);
      return octal((entry.mode & S_IFMT) === S_IFGITLINK ? S_IFGITLINK : S_IFDIR);
    }
    if ((entry.mode & S_IFMT) === S_IFGITLINK) return octal(S_IFGITLINK);
    if ((entry.mode & S_IFMT) === S_IFLNK) return octal(S_IFLNK);
    return octal(entry.mode & 0o111 ? 0o100755 : 0o100644);
  }
}
