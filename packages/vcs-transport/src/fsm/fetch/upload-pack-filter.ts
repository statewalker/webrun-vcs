/**
 * Partial clone filters as git's upload-pack serves them: advertised only with
 * `uploadpack.allowFilter` (v0's `filter` capability, v2's `fetch=... filter` feature), and
 * each requested filter checked against `uploadpackfilter.allow`,
 * `uploadpackfilter.<choice>.allow` and `uploadpackfilter.tree.maxDepth` before anything is
 * packed:
 *
 * ```typescript
 * const policy = { allowFilter: true, allowByDefault: false, choices: { "blob:none": true } };
 * checkUploadPackFilter("blob:none", policy); // undefined: served
 * checkUploadPackFilter("tree:0", policy);
 * // { message: "filter 'tree' not supported", reported: true } (an ERR packet, then git dies)
 * checkUploadPackFilter("tree:x", policy);
 * // { message: "expected 'tree:<depth>'", reported: false } (git dies without a packet)
 * ```
 */
import {
  type ObjectFilter,
  ObjectFilterError,
  parseGitUlong,
  parseObjectFilter,
} from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils/encoding";

/** What upload-pack reads from `uploadpack.allowFilter` and `uploadpackfilter.*`. */
export interface UploadPackFilterPolicy {
  /** `uploadpack.allowFilter`: advertise `filter` and accept filter requests */
  allowFilter: boolean;
  /** `uploadpackfilter.allow`: whether a choice not listed in `choices` is served (default true) */
  allowByDefault?: boolean;
  /**
   * `uploadpackfilter.<choice>.allow` by choice (`blob:none`, `blob:limit`, `tree`,
   * `sparse:oid`, `object:type`, `combine`); `uploadpackfilter.tree.maxDepth` sets `tree`
   * allowed too, as git does
   */
  choices?: Readonly<Record<string, boolean>>;
  /** `uploadpackfilter.tree.maxDepth`: the deepest `tree:<depth>` served (default: any) */
  treeMaxDepth?: number;
  /**
   * A value of these keys git cannot read (`bad boolean config value '<v>' for '<key>'`,
   * `bad numeric config value '<v>' for 'uploadpackfilter.tree.maxdepth' in file config:
   * invalid unit`, `missing value for '<key>'`): upload-pack dies reading its config, before
   * it advertises anything (git 2.43's v2 advertisement still went out, its fetch died)
   */
  configError?: string;
}

/** Why a filter request is refused (see {@link checkUploadPackFilter}). */
export interface UploadPackFilterRefusal {
  /** git's message */
  message: string;
  /**
   * Whether git sends it to the client (`ERR <message>`, send_err_and_die) before it dies;
   * false for a spec it cannot parse (die() alone: only upload-pack's stderr has it)
   */
  reported: boolean;
}

/**
 * Checks a requested filter as upload-pack's `parse_list_objects_filter` and
 * `die_if_using_banned_filter` do (a combine's own choice first, then each of its filters);
 * undefined when it is served. Without a policy every parsable filter is served.
 */
export function checkUploadPackFilter(
  spec: string,
  policy: UploadPackFilterPolicy | undefined,
): UploadPackFilterRefusal | undefined {
  let filter: ObjectFilter;
  try {
    filter = parseObjectFilter(spec);
  } catch (error) {
    if (error instanceof ObjectFilterError) return { message: error.message, reported: false };
    throw error;
  }
  if (!policy) return undefined;
  const check = (f: ObjectFilter): UploadPackFilterRefusal | undefined => {
    const allowed = policy.choices?.[f.choice] ?? policy.allowByDefault ?? true;
    if (!allowed) return { message: `filter '${f.choice}' not supported`, reported: true };
    const max = policy.treeMaxDepth;
    if (f.choice === "tree" && max !== undefined && f.depth > max) {
      return {
        message: `tree filter allows max depth ${max}, but got ${f.depth}`,
        reported: true,
      };
    }
    if (f.choice === "combine") {
      for (const sub of f.filters) {
        const refused = check(sub);
        if (refused) return refused;
      }
    }
    return undefined;
  };
  return check(filter);
}

/** v0's capability list with `filter` when the policy allows filters and it lacks one. */
export function withFilterCapability(
  capabilities: readonly string[],
  policy: UploadPackFilterPolicy | undefined,
): string[] {
  const list = [...capabilities];
  if (policy?.allowFilter && !list.includes("filter")) list.push("filter");
  return list;
}

/** v2's capabilities with `filter` added to `fetch=` when the policy allows filters. */
export function withFilterFeature(
  capabilities: readonly string[],
  policy: UploadPackFilterPolicy | undefined,
): string[] {
  if (!policy?.allowFilter) return [...capabilities];
  return capabilities.map((c) => {
    if (c !== "fetch" && !c.startsWith("fetch=")) return c;
    const features = c === "fetch" ? [] : c.slice("fetch=".length).split(" ").filter(Boolean);
    if (features.includes("filter")) return c;
    // git's order: shallow wait-for-done filter ref-in-want ...
    const at = features.indexOf("wait-for-done");
    features.splice(at >= 0 ? at + 1 : features.length, 0, "filter");
    return `fetch=${features.join(" ")}`;
  });
}

/** The key as git names it in its messages: section and variable lowercased. */
function canonicalKey(key: string): string {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first < 0) return key.toLowerCase();
  return `${key.slice(0, first).toLowerCase()}${key.slice(first, last + 1)}${key.slice(last + 1).toLowerCase()}`;
}

/** A config value as the text git read (a key without `=` is null or true here). */
function configText(value: unknown): string | undefined {
  if (value === null || value === undefined || value === true) return undefined;
  return String(value);
}

/** git's `git_config_bool`: the value, or the message git dies with. */
function configBool(key: string, value: unknown): boolean | string {
  const b = parseGitBool(value === null ? true : value);
  return b ?? `bad boolean config value '${configText(value) ?? ""}' for '${canonicalKey(key)}'`;
}

/**
 * git's `git_config_ulong` (strtoumax with base 0: hex and octal, a `k`/`m`/`g` unit), from
 * a value read in the repository's `config` (upload-pack runs in the git directory): the
 * number, or the message git dies with.
 */
function configUlong(key: string, value: unknown): number | string {
  const text = configText(value);
  if (text === undefined) return `missing value for '${canonicalKey(key)}'`;
  const n = parseGitUlong(text);
  if (n !== undefined) return n;
  // git_parse_ulong sets ERANGE only past ULONG_MAX, EINVAL (invalid unit) otherwise
  const range = /^\s*\+?\d+[kmg]?$/i.test(text) && !text.includes("-");
  return `bad numeric config value '${text}' for '${canonicalKey(key)}' in file config: ${range ? "out of range" : "invalid unit"}`;
}

/**
 * The filter policy a repository's configuration sets (upload-pack.c's upload_pack_config and
 * parse_object_filter_config, read in config order: a later `uploadpackfilter.tree.allow`
 * undoes an earlier `maxDepth`'s allowing), or undefined when it sets none of these keys.
 */
export function uploadPackFilterPolicyOf(
  entries: Iterable<{
    key: string;
    value: unknown;
  }>,
): UploadPackFilterPolicy | undefined {
  let any = false;
  let allowFilter = false;
  let allowByDefault: boolean | undefined;
  let treeMaxDepth: number | undefined;
  let configError: string | undefined;
  const choices: Record<string, boolean> = {};
  for (const { key, value } of entries) {
    const first = key.indexOf(".");
    const last = key.lastIndexOf(".");
    if (first < 0) continue;
    const section = key.slice(0, first).toLowerCase();
    const name = key.slice(last + 1).toLowerCase();
    const sub = first === last ? undefined : key.slice(first + 1, last);
    // git dies at the first value it cannot read
    const bool = (): boolean | undefined => {
      const b = configBool(key, value);
      if (typeof b === "string") configError ??= b;
      return typeof b === "boolean" ? b : undefined;
    };
    if (section === "uploadpack" && sub === undefined && name === "allowfilter") {
      any = true;
      allowFilter = bool() ?? false;
    } else if (section === "uploadpackfilter") {
      if (sub === undefined) {
        if (name === "allow") {
          any = true;
          allowByDefault = bool() ?? true;
        }
      } else if (name === "allow") {
        any = true;
        choices[sub] = bool() ?? false;
      } else if (sub === "tree" && name === "maxdepth") {
        any = true;
        const depth = configUlong(key, value);
        if (typeof depth === "string") {
          configError ??= depth;
          continue;
        }
        choices.tree = true;
        treeMaxDepth = depth;
      }
    }
    if (configError !== undefined) break;
  }
  if (!any) return undefined;
  return {
    allowFilter,
    ...(allowByDefault !== undefined ? { allowByDefault } : {}),
    ...(Object.keys(choices).length > 0 ? { choices } : {}),
    ...(treeMaxDepth !== undefined ? { treeMaxDepth } : {}),
    ...(configError !== undefined ? { configError } : {}),
  };
}
