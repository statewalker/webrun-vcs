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

/** Where the attributes files come from. Every method may be absent (no such file). */
export interface AttributesSources {
  /** `$(prefix)/etc/gitattributes` */
  system?(): Promise<string | Uint8Array | undefined>;
  /** `core.attributesFile`, or `$XDG_CONFIG_HOME/git/attributes` */
  global?(): Promise<string | Uint8Array | undefined>;
  /** `$GIT_DIR/info/attributes` */
  info?(): Promise<string | Uint8Array | undefined>;
  /** The `.gitattributes` of directory `dir` ("" for the root) */
  inTree(dir: string): Promise<string | Uint8Array | undefined>;
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
}

/**
 * Parsed files, by origin and text: an unchanged file is not parsed again. Bounded so
 * a long-lived resolver does not keep every version of every file.
 */
class ParseCache {
  private readonly entries = new Map<string, AttributeRule[]>();
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
    if (this.entries.size > 512) {
      const first = this.entries.keys().next().value;
      if (first !== undefined) this.entries.delete(first);
    }
    return rules;
  }
}

const textOf = (content: string | Uint8Array) =>
  typeof content === "string"
    ? content
    : new TextDecoder("utf-8", { ignoreBOM: true }).decode(content);

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

  constructor(
    private readonly sources: AttributesSources,
    private readonly options: AttributesResolverOptions = {},
  ) {}

  private parse(
    origin: string,
    content: string | Uint8Array | undefined,
    macrosAllowed: boolean,
  ): AttributeRule[] {
    if (content === undefined) return [];
    const text = textOf(content);
    return this.cache.get(`${macrosAllowed ? "m" : "-"}${origin}\0${text}`, () =>
      parseAttributes(text, { source: origin, macrosAllowed, onWarning: this.options.onWarning }),
    );
  }

  /** The frames for a path in directory `dir`, lowest precedence first. */
  private async frames(dir: string): Promise<Frame[]> {
    const { sources } = this;
    const frames: Frame[] = [{ base: "", rules: this.parse("[builtin]", BUILTIN, true) }];
    if (sources.system) {
      frames.push({ base: "", rules: this.parse("system", await sources.system(), true) });
    }
    if (sources.global) {
      frames.push({ base: "", rules: this.parse("global", await sources.global(), true) });
    }
    frames.push({ base: "", rules: this.parse(".gitattributes", await sources.inTree(""), true) });
    if (dir) {
      const parts = dir.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const sub = parts.slice(0, i).join("/");
        const origin = `${sub}/.gitattributes`;
        frames.push({ base: sub, rules: this.parse(origin, await sources.inTree(sub), false) });
      }
    }
    if (sources.info) {
      frames.push({ base: "", rules: this.parse("info/attributes", await sources.info(), true) });
    }
    return frames;
  }

  /**
   * The attributes of `path` (a file, or a directory with `isDirectory`): every attribute
   * that has a value, or only `names` when given (each present in the result, `undefined`
   * when unspecified).
   */
  async get(
    path: string,
    names?: readonly string[],
    options: { isDirectory?: boolean } = {},
  ): Promise<Map<string, AttributeValue>> {
    const slash = path.lastIndexOf("/");
    const dir = slash > 0 ? path.slice(0, slash) : "";
    const frames = await this.frames(dir);
    return collectAttributes(frames, path, names, {
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
  frames: Frame[],
  path: string,
  names: readonly string[] | undefined,
  options: { isDirectory?: boolean; ignoreCase?: boolean },
): Map<string, AttributeValue> {
  // the highest-precedence definition of each macro
  const macros = new Map<string, AttributeRule & { kind: "macro" }>();
  for (let f = frames.length - 1; f >= 0; f--) {
    const rules = frames[f].rules;
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i];
      if (rule.kind === "macro" && !macros.has(rule.name)) macros.set(rule.name, rule);
    }
  }
  const assigned = new Map<string, AttributeSetting>();
  const wanted = names ? new Set(names) : undefined;
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
  const out = new Map<string, AttributeValue>();
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
