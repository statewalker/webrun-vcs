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
import { type ObjectFilter, ObjectFilterError, parseObjectFilter } from "@statewalker/vcs-core";

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

/** git's `git_config_bool` of a config value; undefined for none it can read. */
function configBool(value: unknown): boolean | undefined {
  if (value === null || value === true) return true;
  if (value === false) return false;
  if (value === undefined) return undefined;
  const text = String(value).trim().toLowerCase();
  if (["true", "yes", "on"].includes(text)) return true;
  if (["false", "no", "off", ""].includes(text)) return false;
  const n = Number(text);
  return Number.isFinite(n) ? n !== 0 : undefined;
}

/** git's `git_config_ulong` (a `k`/`m`/`g` unit allowed); undefined for anything else. */
function configUlong(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^\s*\+?(\d+)([kmg]?)$/i.exec(value);
  if (!m) return undefined;
  const unit = (m[2] ?? "").toLowerCase();
  const factor = unit === "k" ? 1024 : unit === "m" ? 1024 ** 2 : unit === "g" ? 1024 ** 3 : 1;
  return Number(m[1]) * factor;
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
  const choices: Record<string, boolean> = {};
  for (const { key, value } of entries) {
    const first = key.indexOf(".");
    const last = key.lastIndexOf(".");
    if (first < 0) continue;
    const section = key.slice(0, first).toLowerCase();
    const name = key.slice(last + 1).toLowerCase();
    const sub = first === last ? undefined : key.slice(first + 1, last);
    if (section === "uploadpack" && sub === undefined && name === "allowfilter") {
      any = true;
      allowFilter = configBool(value) ?? false;
    } else if (section === "uploadpackfilter") {
      if (sub === undefined) {
        if (name === "allow") {
          any = true;
          allowByDefault = configBool(value) ?? true;
        }
      } else if (name === "allow") {
        any = true;
        choices[sub] = configBool(value) ?? false;
      } else if (sub === "tree" && name === "maxdepth") {
        const depth = configUlong(value);
        if (depth === undefined) continue;
        any = true;
        choices.tree = true;
        treeMaxDepth = depth;
      }
    }
  }
  if (!any) return undefined;
  return {
    allowFilter,
    ...(allowByDefault !== undefined ? { allowByDefault } : {}),
    ...(Object.keys(choices).length > 0 ? { choices } : {}),
    ...(treeMaxDepth !== undefined ? { treeMaxDepth } : {}),
  };
}
