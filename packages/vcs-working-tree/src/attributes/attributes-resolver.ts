/**
 * The attributes of a path, collected from git's stack of attributes files as `attr.c`'s
 * `collect_some_attrs` does.
 *
 * From lowest to highest precedence: the built-in `binary` macro, the system file
 * (`$(prefix)/etc/gitattributes`), the global file (`core.attributesFile`, by default
 * `$XDG_CONFIG_HOME/git/attributes`), the `.gitattributes` of the root and of each directory
 * down to the path's own, and `$GIT_DIR/info/attributes`. Within a file a later line wins;
 * within a line a later state wins; a macro set to true expands to its states.
 */

import { decodeGitPatternFile } from "@statewalker/vcs-utils/encoding";
import {
  type AttributeRule,
  type AttributeSetting,
  attributePatternMatches,
  parseAttributes,
} from "./attributes-rules.js";

/**
 * An attribute's value for a path: `true` (set), `false` (unset), a string, or `undefined`
 * (unspecified).
 */
export type AttributeValue = true | false | string | undefined;

/**
 * An attributes file as a source gives it: its content, or its content with a key that
 * names this version of it (a blob id, a stat), under which its parse is kept. Undefined
 * when there is no such file.
 */
export type AttributesContent =
  | string
  | Uint8Array
  | { key: string; content: string | Uint8Array }
  | undefined;

/** Where the attributes files come from. Every method may be absent (no such file). */
export interface AttributesSources {
  /** `$(prefix)/etc/gitattributes` */
  system?(): Promise<AttributesContent>;
  /** `core.attributesFile`, or `$XDG_CONFIG_HOME/git/attributes` */
  global?(): Promise<AttributesContent>;
  /** `$GIT_DIR/info/attributes` */
  info?(): Promise<AttributesContent>;
  /** The `.gitattributes` of directory `dir` ("" for the root) */
  inTree(dir: string): Promise<AttributesContent>;
}

/** Options of {@link AttributesResolver}. */
export interface AttributesResolverOptions {
  /** Match patterns case-insensitively (`core.ignorecase`), or a function reading it */
  ignoreCase?: boolean | (() => boolean);
  /** Receives git's warnings about lines it ignores */
  onWarning?: (message: string) => void;
}

/** git's built-in attributes (`builtin_attr`). */
const BUILTIN = "[attr]binary -diff -merge -text\n";

interface Frame {
  /** The directory whose patterns this frame holds ("" for root and the files outside the tree) */
  base: string;
  rules: AttributeRule[];
  /** The attributes the frame's patterns assign (macros by their names) */
  named: Set<string>;
}

/**
 * The files read for a batch of lookups, as git keeps its attribute stack between paths:
 * the files outside the tree once, each directory's chain once. Drop it (or a directory of
 * it) when a file it read may have changed.
 */
export class AttributesMemo {
  /** builtin, system, global (lowest first) and info/attributes */
  outer?: Promise<{ low: Frame[]; info: Frame[] }>;
  /** The in-tree frames of a directory, root first */
  readonly dirs = new Map<string, Promise<Frame[]>>();
  /** The whole stack for the paths of a directory */
  readonly stacks = new Map<string, Promise<Stack>>();
  /** The stacks read so far, for lookups that need not wait */
  readonly ready = new Map<string, Stack>();

  /** Forgets the chains that read the `.gitattributes` of `dir` (all of them, for ""). */
  dropDirectory(dir: string): void {
    if (!dir) {
      this.dirs.clear();
      this.stacks.clear();
      this.ready.clear();
      return;
    }
    for (const map of [this.dirs, this.stacks, this.ready] as Map<string, unknown>[]) {
      for (const key of [...map.keys()]) {
        if (key === dir || key.startsWith(`${dir}/`)) map.delete(key);
      }
    }
  }
}

/** The frames that apply to the paths of one directory, with what they define. */
interface Stack {
  /** Lowest precedence first */
  frames: Frame[];
  /** The highest-precedence definition of each macro */
  macros: Map<string, AttributeRule & { kind: "macro" }>;
  /** Whether a pattern of the stack may assign one of a list of names (by the list) */
  relevant: WeakMap<readonly string[], boolean>;
}

function stackOf(frames: Frame[]): Stack {
  const macros = new Map<string, AttributeRule & { kind: "macro" }>();
  for (let f = frames.length - 1; f >= 0; f--) {
    const rules = frames[f].rules;
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i];
      if (rule.kind === "macro" && !macros.has(rule.name)) macros.set(rule.name, rule);
    }
  }
  return { frames, macros, relevant: new WeakMap() };
}

/**
 * Parsed files, by origin and key (or text): an unchanged file is not parsed again. Bounded
 * so a long-lived resolver does not keep every version of every file.
 */
class ParseCache {
  private readonly entries = new Map<string, Frame["rules"]>();
  get(key: string, parse: () => AttributeRule[]): AttributeRule[] {
    const hit = this.entries.get(key);
    if (hit) {
      // refresh its place
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const rules = parse();
    this.entries.set(key, rules);
    if (this.entries.size > 1024) {
      const first = this.entries.keys().next().value;
      if (first !== undefined) this.entries.delete(first);
    }
    return rules;
  }
}

const textOf = (content: string | Uint8Array) =>
  typeof content === "string" ? content : decodeGitPatternFile(content);

/** The attribute names the patterns of a list of rules assign (a macro by its name). */
function namedBy(rules: AttributeRule[]): Set<string> {
  const named = new Set<string>();
  for (const rule of rules) {
    if (rule.kind === "pattern") for (const state of rule.states) named.add(state.name);
  }
  return named;
}

/**
 * Collects the attributes of paths from {@link AttributesSources}.
 *
 * @example
 * ```typescript
 * const resolver = new AttributesResolver({ inTree: async (dir) => files.get(`${dir}/.gitattributes`) });
 * const attrs = await resolver.get("src/a.txt", ["text", "eol"]);
 * attrs.get("text"); // true, false, "auto", or undefined
 * ```
 */
export class AttributesResolver {
  private readonly cache = new ParseCache();
  private readonly frameOf = new WeakMap<AttributeRule[], Frame>();

  constructor(
    private readonly sources: AttributesSources,
    private readonly options: AttributesResolverOptions = {},
  ) {}

  private frame(base: string, origin: string, content: AttributesContent, macros: boolean): Frame {
    if (content === undefined) return { base, rules: [], named: new Set() };
    const keyed = typeof content === "object" && !(content instanceof Uint8Array);
    const cacheKey = `${macros ? "m" : "-"}${origin}\0${keyed ? `#${content.key}` : textOf(content)}`;
    const rules = this.cache.get(cacheKey, () =>
      // the bytes themselves: `parseAttributes` skips their one BOM (a decoded string would
      // lose it here and a second one there)
      parseAttributes(keyed ? content.content : content, {
        source: origin,
        macrosAllowed: macros,
        onWarning: this.options.onWarning,
      }),
    );
    // one frame per parse (and base): the names are computed once
    let frame = this.frameOf.get(rules);
    if (!frame || frame.base !== base) {
      frame = { base, rules, named: namedBy(rules) };
      this.frameOf.set(rules, frame);
    }
    return frame;
  }

  private async outer(sources: AttributesSources): Promise<{ low: Frame[]; info: Frame[] }> {
    const low: Frame[] = [this.frame("", "[builtin]", BUILTIN, true)];
    if (sources.system) low.push(this.frame("", "system", await sources.system(), true));
    if (sources.global) low.push(this.frame("", "global", await sources.global(), true));
    const info = sources.info
      ? [this.frame("", "info/attributes", await sources.info(), true)]
      : [];
    return { low, info };
  }

  /** The in-tree frames of directory `dir`, root first. */
  private inTree(dir: string, sources: AttributesSources, memo: AttributesMemo): Promise<Frame[]> {
    const known = memo.dirs.get(dir);
    if (known) return known;
    const chain = (async () => {
      if (!dir) return [this.frame("", ".gitattributes", await sources.inTree(""), true)];
      const slash = dir.lastIndexOf("/");
      const parent = await this.inTree(slash > 0 ? dir.slice(0, slash) : "", sources, memo);
      const own = this.frame(dir, `${dir}/.gitattributes`, await sources.inTree(dir), false);
      return [...parent, own];
    })();
    memo.dirs.set(dir, chain);
    // a failed read is not kept
    chain.catch(() => {
      if (memo.dirs.get(dir) === chain) memo.dirs.delete(dir);
    });
    return chain;
  }

  /** The stack for a path in directory `dir`. */
  private stack(dir: string, sources: AttributesSources, memo: AttributesMemo): Promise<Stack> {
    const known = memo.stacks.get(dir);
    if (known) return known;
    const stack = (async () => {
      memo.outer ??= this.outer(sources);
      const outer = memo.outer;
      outer.catch(() => {
        if (memo.outer === outer) memo.outer = undefined;
      });
      const { low, info } = await outer;
      return stackOf([...low, ...(await this.inTree(dir, sources, memo)), ...info]);
    })();
    memo.stacks.set(dir, stack);
    stack.then(
      (read) => {
        // kept for waitless lookups unless dropped meanwhile
        if (memo.stacks.get(dir) === stack) memo.ready.set(dir, read);
      },
      () => {
        if (memo.stacks.get(dir) === stack) memo.stacks.delete(dir);
      },
    );
    return stack;
  }

  /**
   * The attributes of `path` (see {@link get}) when the stack of its directory was already
   * read into `memo`; undefined when it must be read first.
   */
  peek(
    path: string,
    names: readonly string[] | undefined,
    memo: AttributesMemo,
  ): Map<string, AttributeValue> | undefined {
    const slash = path.lastIndexOf("/");
    const stack = memo.ready.get(slash > 0 ? path.slice(0, slash) : "");
    if (!stack) return undefined;
    return collectAttributes(stack, path, names, { ignoreCase: this.ignoreCase() });
  }

  private ignoreCase(): boolean | undefined {
    return typeof this.options.ignoreCase === "function"
      ? this.options.ignoreCase()
      : this.options.ignoreCase;
  }

  /**
   * The attributes of `path` (a file, or a directory with `isDirectory`): every attribute
   * that has a value, or only `names` when given (each present in the result, `undefined`
   * when unspecified).
   *
   * `sources` replaces the resolver's own for this lookup; `memo` keeps the files read for
   * the next lookups (without it every file is read again).
   */
  async get(
    path: string,
    names?: readonly string[],
    options: { isDirectory?: boolean; sources?: AttributesSources; memo?: AttributesMemo } = {},
  ): Promise<Map<string, AttributeValue>> {
    const slash = path.lastIndexOf("/");
    const dir = slash > 0 ? path.slice(0, slash) : "";
    const stack = await this.stack(
      dir,
      options.sources ?? this.sources,
      options.memo ?? new AttributesMemo(),
    );
    return collectAttributes(stack, path, names, {
      isDirectory: options.isDirectory,
      ignoreCase:
        typeof this.options.ignoreCase === "function"
          ? this.options.ignoreCase()
          : this.options.ignoreCase,
    });
  }
}

/**
 * git's `determine_macros` + `fill` + `fill_one` over frames (lowest precedence first).
 */
function collectAttributes(
  stack: Stack,
  path: string,
  names: readonly string[] | undefined,
  options: { isDirectory?: boolean; ignoreCase?: boolean },
): Map<string, AttributeValue> {
  const { frames, macros } = stack;
  const out = new Map<string, AttributeValue>();
  if (names) {
    // no pattern assigns a wanted attribute, nor a macro (which might set one): all
    // unspecified, without matching a pattern
    let relevant = stack.relevant.get(names);
    if (relevant === undefined) {
      const wanted = new Set(names);
      relevant = frames.some((frame) => {
        for (const name of frame.named) if (wanted.has(name) || macros.has(name)) return true;
        return false;
      });
      stack.relevant.set(names, relevant);
    }
    if (!relevant) {
      for (const name of names) out.set(name, undefined);
      return out;
    }
  }
  const wanted = names ? new Set(names) : undefined;
  const assigned = new Map<string, AttributeSetting>();
  const fillOne = (states: readonly { name: string; setting: AttributeSetting }[]) => {
    const todo = [...states];
    while (todo.length > 0) {
      const state = todo.pop();
      if (!state) break;
      if (assigned.has(state.name)) continue;
      assigned.set(state.name, state.setting);
      const macro = macros.get(state.name);
      if (macro && state.setting === true) todo.push(...macro.states);
    }
  };
  for (let f = frames.length - 1; f >= 0; f--) {
    const { base, rules } = frames[f];
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i];
      if (rule.kind !== "pattern") continue;
      if (attributePatternMatches(rule.pattern, path, base, options)) fillOne(rule.states);
    }
  }
  if (wanted) {
    for (const name of wanted) {
      const s = assigned.get(name);
      out.set(name, s === null ? undefined : s);
    }
    return out;
  }
  for (const [name, s] of assigned) if (s !== null) out.set(name, s);
  return out;
}
