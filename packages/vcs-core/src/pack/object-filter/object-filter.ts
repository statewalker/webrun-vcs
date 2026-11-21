/**
 * Object filters of a partial clone (`--filter=<spec>`), parsed as git's
 * list-objects-filter-options.c reads them:
 *
 * ```typescript
 * parseObjectFilter("blob:limit=1k"); // { choice: "blob:limit", limit: 1024 }
 * parseObjectFilter("combine:blob:none+tree:2");
 * // { choice: "combine", filters: [{ choice: "blob:none" }, { choice: "tree", depth: 2 }] }
 * parseObjectFilter("tree:x"); // throws ObjectFilterError "expected 'tree:<depth>'"
 * ```
 *
 * Each spec names one of git's choices: `blob:none`, `blob:limit=<n>[kmg]`, `tree:<depth>`,
 * `sparse:oid=<blob-ish>`, `object:type=<type>`, or `combine:<f1>+<f2>...` whose sub-specs are
 * percent-encoded. A spec git refuses throws {@link ObjectFilterError} with git's message (the
 * line it dies with, without `fatal: `).
 */
import type { ObjectTypeString } from "../../history/objects/object-types.js";

/** A parsed filter spec (git's `list_objects_filter_options`). */
export type ObjectFilter =
  | { choice: "blob:none" }
  | { choice: "blob:limit"; limit: number }
  | { choice: "tree"; depth: number }
  | { choice: "sparse:oid"; name: string }
  | { choice: "object:type"; type: ObjectTypeString }
  | { choice: "combine"; filters: ObjectFilter[] };

/** The name of a filter choice in git's configuration (`uploadpackfilter.<name>.allow`). */
export type ObjectFilterChoice = ObjectFilter["choice"];

/** A filter spec git refuses: `message` is the line git dies with (without `fatal: `). */
export class ObjectFilterError extends Error {
  override name = "ObjectFilterError";
}

/** Options of {@link parseObjectFilter}. */
export interface ParseObjectFilterOptions {
  /**
   * The git version whose messages and rules to follow: 2.43 refuses an empty sub-spec of
   * `combine:` (`invalid filter-spec ''`) and has no `auto` filter; 2.56 (the default) skips
   * empty sub-specs and says `'auto' filter not supported by this command`.
   */
  compatibility?: "2.43" | "2.56";
}

const RESERVED_NON_WS = "~`!@#$^&*()[]{}\\;'\",<>?";
const OBJECT_TYPES = new Set(["commit", "tree", "blob", "tag"]);

/**
 * Parses a filter spec as git's `gently_parse_list_objects_filter` (and
 * `parse_combine_filter` for `combine:`).
 *
 * @throws {ObjectFilterError} with git's message for a spec it refuses
 */
export function parseObjectFilter(
  spec: string,
  options: ParseObjectFilterOptions = {},
): ObjectFilter {
  const v243 = options.compatibility === "2.43";
  if (spec === "auto") {
    throw new ObjectFilterError(
      v243 ? `invalid filter-spec 'auto'` : "'auto' filter not supported by this command",
    );
  }
  if (spec === "blob:none") return { choice: "blob:none" };
  if (spec.startsWith("blob:limit=")) {
    const limit = parseGitUlong(spec.slice("blob:limit=".length));
    if (limit !== undefined) return { choice: "blob:limit", limit };
  } else if (spec.startsWith("tree:")) {
    const depth = parseGitUlong(spec.slice("tree:".length));
    if (depth === undefined) throw new ObjectFilterError("expected 'tree:<depth>'");
    return { choice: "tree", depth };
  } else if (spec.startsWith("sparse:oid=")) {
    return { choice: "sparse:oid", name: spec.slice("sparse:oid=".length) };
  } else if (spec.startsWith("sparse:path=")) {
    throw new ObjectFilterError("sparse:path filters support has been dropped");
  } else if (spec.startsWith("object:type=")) {
    const type = spec.slice("object:type=".length);
    if (!OBJECT_TYPES.has(type)) {
      throw new ObjectFilterError(`'${type}' for 'object:type=<type>' is not a valid object type`);
    }
    return { choice: "object:type", type: type as ObjectTypeString };
  } else if (spec.startsWith("combine:")) {
    return parseCombine(spec.slice("combine:".length), options);
  }
  throw new ObjectFilterError(`invalid filter-spec '${spec}'`);
}

/** git's `parse_combine_filter`: sub-specs between `+`, each percent-decoded. */
function parseCombine(arg: string, options: ParseObjectFilterOptions): ObjectFilter {
  if (arg.length === 0) throw new ObjectFilterError("expected something after combine:");
  const filters: ObjectFilter[] = [];
  for (const sub of arg.split("+")) {
    // 2.5x skips an empty sub-spec (`a++b`), 2.43 parses it (and refuses it)
    if (sub.length === 0 && options.compatibility !== "2.43") continue;
    // git checks the raw sub-spec for reserved characters, then parses its decoded form
    for (const ch of sub) {
      if (ch <= " " || RESERVED_NON_WS.includes(ch)) {
        throw new ObjectFilterError(`must escape char in sub-filter-spec: '${ch}'`);
      }
    }
    filters.push(parseObjectFilter(percentDecode(sub), options));
  }
  return { choice: "combine", filters };
}

/** git's `url_percent_decode`: `%XX` decoded, anything else (a bad escape too) kept. */
function percentDecode(text: string): string {
  if (!text.includes("%")) return text;
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "%" && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of enc.encode(c)) bytes.push(b);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const ULONG_MAX = (1n << 64n) - 1n;

/**
 * git's `git_parse_ulong`: `strtoumax(value, 0)` (leading blanks, `+`, `0x` hex and `0`
 * octal accepted) times a `k`/`m`/`g` unit (any case); undefined for anything git refuses
 * (a `-` anywhere, trailing text, an empty value, more than 64 bits).
 */
export function parseGitUlong(value: string): number | undefined {
  if (value.length === 0 || value.includes("-")) return undefined;
  let i = 0;
  while (i < value.length && " \t\n\v\f\r".includes(value[i] as string)) i++;
  if (value[i] === "+") i++;
  let base = 10;
  if (value[i] === "0") {
    if ((value[i + 1] === "x" || value[i + 1] === "X") && /[0-9a-fA-F]/.test(value[i + 2] ?? "")) {
      base = 16;
      i += 2;
    } else {
      base = 8;
    }
  }
  const digits = base === 16 ? /[0-9a-fA-F]/ : base === 8 ? /[0-7]/ : /[0-9]/;
  const start = i;
  let n = 0n;
  while (i < value.length && digits.test(value[i] as string)) {
    n = n * BigInt(base) + BigInt(Number.parseInt(value[i] as string, base));
    i++;
  }
  // no digits: strtoumax's end is the start of the value
  if (i === start) return undefined;
  if (n > ULONG_MAX) return undefined;
  const unit = value.slice(i).toLowerCase();
  const factor =
    unit === ""
      ? 1n
      : unit === "k"
        ? 1024n
        : unit === "m"
          ? 1024n * 1024n
          : unit === "g"
            ? 1024n * 1024n * 1024n
            : 0n;
  if (factor === 0n) return undefined;
  const result = n * factor;
  if (result > ULONG_MAX) return undefined;
  return Number(result);
}

/**
 * The name git's configuration gives a filter's choice (`list_object_filter_config_name`):
 * `blob:none`, `blob:limit`, `tree`, `sparse:oid`, `object:type`, `combine`.
 */
export function objectFilterConfigName(filter: ObjectFilter): ObjectFilterChoice {
  return filter.choice;
}

/**
 * Whether git's bitmaps can apply the filter (pack-bitmap.c's `can_filter_bitmap`):
 * `blob:none`, `blob:limit`, `tree:0`, `object:type`, and `combine:` of those.
 */
export function canFilterBitmap(filter: ObjectFilter): boolean {
  switch (filter.choice) {
    case "blob:none":
    case "blob:limit":
    case "object:type":
      return true;
    case "tree":
      return filter.depth === 0;
    case "combine":
      return filter.filters.every(canFilterBitmap);
    default:
      return false;
  }
}
