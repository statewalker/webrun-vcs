/**
 * The server settings git reads from a served repository's configuration: receive-pack's
 * ref policies (`receive.denyDeletes`, `receive.denyNonFastForwards`,
 * `receive.denyCurrentBranch`, `receive.denyDeleteCurrent`, `receive.shallowUpdate`) and the
 * hidden refs of each service (`transfer.hideRefs` with `uploadpack.hideRefs` or
 * `receive.hideRefs`). The local transport and a smart-HTTP server serving a repository on
 * disk map them alike: spread the result into `serveOverDuplex` options, or (renamed as
 * {@link httpServerSettings} does) into the HTTP server's.
 *
 * @example
 * ```typescript
 * const settings = serverSettingsFromConfig(config); // config: { getAll(key) }
 * await serveOverDuplex({ duplex, repository, refStore, service, ...settings });
 * ```
 */

import type { UploadPackRequestPolicy } from "../context/process-config.js";
import {
  type UploadPackFilterPolicy,
  uploadPackFilterPolicyOf,
} from "../fsm/fetch/upload-pack-filter.js";
import type { ReceiveDenyAction } from "../fsm/push/receive-pack-types.js";

/** Reads a repository's configuration. */
export interface ServerConfigReader {
  /**
   * Every value of `key` (`section.name`, case-insensitive), in the order git reads them; a
   * key written without `=` is `true`, `null` or `undefined`.
   */
  getAll(key: string): unknown[];
  /**
   * Every entry in the order git reads them. Optional: with it the hidden ref patterns keep
   * git's order across `transfer.hideRefs` and the service's own key; without it the
   * `transfer.hideRefs` patterns come first.
   */
  list?(): Iterable<{ key: string; value: unknown }>;
  /**
   * Every entry with where it was read (the file and line of git's `bad config variable`
   * message). Optional: without it the message names no place.
   */
  listWithOrigin?(): Iterable<{ key: string; value: unknown; file?: string; line?: number }>;
}

/** What {@link serverSettingsFromConfig} reads. */
export interface ServerConfigSettings {
  /** Not `receive.denyDeletes` */
  allowDeletes: boolean;
  /** Not `receive.denyNonFastForwards` (git's default: forced updates are accepted) */
  allowNonFastForward: boolean;
  /** `receive.denyCurrentBranch`; `"unconfigured"` when it is not set */
  denyCurrentBranch: ReceiveDenyAction;
  /** `receive.denyDeleteCurrent`; `"unconfigured"` when it is not set */
  denyDeleteCurrent: ReceiveDenyAction;
  /** `receive.shallowUpdate` */
  shallowUpdate: boolean;
  /** `receive.advertisePushOptions` (git's default: false) */
  advertisePushOptions: boolean;
  /**
   * `receive.advertiseAtomic` (git's default: true): false leaves `atomic` out of the
   * advertisement, and a client's `atomic` is then ignored (git's `use_atomic` needs both)
   */
  advertiseAtomic?: boolean;
  /** `receive.certNonceSeed`: advertise `push-cert=<nonce>` (signed pushes) */
  certNonceSeed?: string;
  /** `receive.certNonceSlop` in seconds (git's default 0) */
  certNonceSlop?: number;
  /**
   * `receive.maxInputSize` in bytes: a pushed pack larger than this is refused (index-pack and
   * unpack-objects `--max-input-size`); absent, 0 or negative: no limit (git's default)
   */
  maxInputSize?: number;
  /**
   * `receive.keepAlive` in milliseconds (git's setting is in seconds, default 5): the side-band
   * keep-alive interval while a push is checked; 0 turns keep-alives off (git: 0 or less)
   */
  receiveKeepAliveMs?: number;
  /**
   * `receive.unpackLimit`, else `transfer.unpackLimit` (a negative value counts as unset;
   * git's default 100 when neither): a pushed pack of at least this many objects is kept
   * (index-pack), a smaller one unpacked (unpack-objects), 0 keeping every pack; also the child
   * receive-pack names when it refuses a pack
   */
  unpackLimit?: number;
  /** upload-pack's hidden ref patterns: `transfer.hideRefs` and `uploadpack.hideRefs` */
  uploadPackHideRefs: string[];
  /** receive-pack's hidden ref patterns: `transfer.hideRefs` and `receive.hideRefs` */
  receivePackHideRefs: string[];
  /**
   * upload-pack's partial clone filters: `uploadpack.allowFilter`, `uploadpackfilter.allow`,
   * `uploadpackfilter.<choice>.allow`, `uploadpackfilter.tree.maxDepth` (absent: none set, no
   * filter advertised, as git's default)
   */
  uploadPackFilter?: UploadPackFilterPolicy;
  /**
   * upload-pack's v0/v1 want policy: `uploadpack.allowTipSHA1InWant`,
   * `uploadpack.allowReachableSHA1InWant`, `uploadpack.allowAnySHA1InWant` (absent: none set,
   * only advertised tips, as git's default)
   */
  uploadPackRequestPolicy?: UploadPackRequestPolicy;
  /** `uploadpack.allowRefInWant` (git's default: false) */
  allowRefInWant?: boolean;
  /** `uploadpack.allowSidebandAll` (git's default: false) */
  allowSidebandAll?: boolean;
  /** `transfer.advertiseSID` (git's default: false) */
  advertiseSID?: boolean;
  /**
   * `uploadpack.advertiseBundleURIs` true: the `bundle.*` lines the v2 `bundle-uri` command
   * answers with (`<key>=<value>`, config order; a key without a value or with an empty one is
   * left out, as git warns it away)
   */
  bundleUris?: string[];
  /**
   * receive-pack's `receive.procReceiveRefs` values, in order: the commands the proc-receive
   * hook takes (absent: none set)
   */
  procReceiveRefs?: string[];
  /**
   * A receive-pack setting git cannot read (`receive.procReceiveRefs` without a value,
   * config_error_nonbool): what receive-pack prints as it dies reading its config, before it
   * advertises anything (`error: missing value for 'receive.procreceiverefs'`, then `fatal:
   * bad config variable 'receive.procreceiverefs' in file '<file>' at line <n>` where the
   * config tells the place)
   */
  receivePackConfigError?: string;
}

/** The keys of {@link ServerConfigSettings.uploadPackFilter} without a subsection list. */
const FILTER_KEYS = [
  "uploadpack.allowFilter",
  "uploadpackfilter.allow",
  ...["blob:none", "blob:limit", "tree", "sparse:oid", "object:type", "combine"].map(
    (choice) => `uploadpackfilter.${choice}.allow`,
  ),
  "uploadpackfilter.tree.maxDepth",
];

/** The filter policy the configuration sets, read in config order where it can be. */
function filterPolicy(config: ServerConfigReader): UploadPackFilterPolicy | undefined {
  if (config.list) return uploadPackFilterPolicyOf(config.list());
  const entries: { key: string; value: unknown }[] = [];
  for (const key of FILTER_KEYS) {
    for (const value of config.getAll(key)) entries.push({ key, value });
  }
  return uploadPackFilterPolicyOf(entries);
}

/** git's `git_config_bool`: a key without a value is true, an empty value false. */
function configBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === null || value === true) return true;
  if (value === false) return false;
  const text = String(value).trim().toLowerCase();
  if (["true", "yes", "on"].includes(text)) return true;
  if (["false", "no", "off", ""].includes(text)) return false;
  const n = Number(text);
  return Number.isFinite(n) ? n !== 0 : fallback;
}

/**
 * git's `git_config_bool` for the last value of `key` (a key without a value is true, an
 * empty value false), or undefined when the configuration does not set it (or sets no
 * boolean): `daemon.<service>`, `http.receivepack`, `http.getanyfile`.
 *
 * @example
 * ```typescript
 * configBoolOf(config, "http.receivepack"); // [http] receivepack → true; unset → undefined
 * ```
 */
export function configBoolOf(
  config: ServerConfigReader | undefined,
  key: string,
): boolean | undefined {
  const values = config?.getAll(key) ?? [];
  if (values.length === 0) return undefined;
  const value = values[values.length - 1];
  if (value === null || value === true || value === undefined) return true;
  if (value === false) return false;
  const text = String(value).trim().toLowerCase();
  if (["true", "yes", "on"].includes(text)) return true;
  if (["false", "no", "off", ""].includes(text)) return false;
  const n = Number(text);
  return Number.isFinite(n) ? n !== 0 : undefined;
}

/** receive-pack.c's `parse_deny_action`. */
function denyAction(values: unknown[]): ReceiveDenyAction {
  if (values.length === 0) return "unconfigured";
  const value = values[values.length - 1];
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "ignore") return "ignore";
    if (lower === "warn") return "warn";
    if (lower === "refuse") return "refuse";
    if (lower === "updateinstead") return "updateInstead";
  }
  return configBool(value, true) ? "refuse" : "ignore";
}

/** git_parse_int64's unit factors (`k`, `m`, `g`, any case). */
const INT64_UNITS: Record<string, bigint> = { "": 1n, k: 1024n, m: 1024n ** 2n, g: 1024n ** 3n };

/**
 * git's `git_config_int64`: a decimal (or `0x` hex, `0` octal) number with an optional `k`,
 * `m` or `g` unit; undefined where git dies (`bad numeric config value`).
 */
function configInt64(value: unknown): number | undefined {
  if (value === null || value === true) return undefined; // git: config_error_nonbool... dies
  const text = String(value);
  const m = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|[0-9]+)([kKmMgG]?)$/.exec(text);
  if (!m) return undefined;
  const digits = m[2] as string;
  const n = /^0[xX]/.test(digits)
    ? BigInt(digits)
    : digits.length > 1 && digits.startsWith("0")
      ? /[89]/.test(digits)
        ? undefined
        : BigInt(`0o${digits.slice(1)}`)
      : BigInt(digits);
  if (n === undefined) return undefined;
  const magnitude = n * (INT64_UNITS[(m[3] as string).toLowerCase()] ?? 1n);
  if (magnitude > 2n ** 63n - 1n) return undefined;
  return Number(m[1] === "-" ? -magnitude : magnitude);
}

/** git's `git_config_int` (32 bits, units as {@link configInt64}). */
function configInt(value: unknown): number | undefined {
  const n = configInt64(value);
  return n !== undefined && n >= -(2 ** 31) && n <= 2 ** 31 - 1 ? n : undefined;
}

/**
 * The death of git's config reader on a value that is no number of the unit it takes
 * (`die_bad_number`): `fatal: bad numeric config value '<v>' for '<key>' in file <file>: invalid
 * unit`, the place where the config tells it.
 */
function badNumeric(config: ServerConfigReader, key: string, value: unknown): string {
  // git_parse_int64 sets EINVAL ("invalid unit") or ERANGE ("out of range")
  const text = value === null || value === true ? "" : String(value);
  const range = /^\s*[+-]?(0[xX][0-9a-fA-F]+|[0-9]+)[kKmMgG]?$/.test(text);
  let place = "";
  for (const entry of config.listWithOrigin?.() ?? []) {
    if (entry.key.toLowerCase() !== key || entry.value !== value) continue;
    if (entry.file !== undefined) place = ` in file ${entry.file}`;
    break;
  }
  return `fatal: bad numeric config value '${text}' for '${key}'${place}: ${range ? "out of range" : "invalid unit"}`;
}

/** The last value of `key`, or undefined. */
function last(config: ServerConfigReader, key: string): unknown {
  const all = config.getAll(key);
  return all.length === 0 ? undefined : all[all.length - 1];
}

/** git's `parse_hide_refs_config`: the patterns of `section` (and `transfer`), in order. */
function hideRefs(config: ServerConfigReader, section: string): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    // a key without a value is an error in git (config_error_nonbool); skipped here
    if (typeof value !== "string") return;
    out.push(value.replace(/\/+$/, ""));
  };
  const keys = new Set(["transfer.hiderefs", `${section}.hiderefs`]);
  if (config.list) {
    for (const { key, value } of config.list()) {
      if (keys.has(key.toLowerCase())) push(value);
    }
    return out;
  }
  for (const value of config.getAll("transfer.hideRefs")) push(value);
  for (const value of config.getAll(`${section}.hideRefs`)) push(value);
  return out;
}

/**
 * git's `config_error_nonbool` and the death of its config reader: `error: missing value for
 * '<key>'`, then `fatal: bad config variable '<key>' in file '<file>' at line <n>` (the first
 * such entry, where the config tells its place).
 */
function nonBoolError(config: ServerConfigReader, key: string): string {
  const error = `error: missing value for '${key}'`;
  for (const entry of config.listWithOrigin?.() ?? []) {
    if (entry.key.toLowerCase() !== key || typeof entry.value === "string") continue;
    if (entry.file === undefined || entry.line === undefined) break;
    return `${error}\nfatal: bad config variable '${key}' in file '${entry.file}' at line ${entry.line}`;
  }
  return error;
}

/** upload_pack_config's `allow_uor` bits. */
const ALLOW_TIP = 1;
const ALLOW_REACHABLE = 2;
const ALLOW_ANY = 7;
const ALLOW_KEYS: Record<string, number> = {
  "uploadpack.allowtipsha1inwant": ALLOW_TIP,
  "uploadpack.allowreachablesha1inwant": ALLOW_REACHABLE,
  "uploadpack.allowanysha1inwant": ALLOW_ANY,
};

/**
 * The v0/v1 want policy `uploadpack.allow*SHA1InWant` sets, as upload_pack_config sets and
 * clears its `allow_uor` bits in config order (`allowAnySHA1InWant=false` after
 * `allowTipSHA1InWant=true` clears both); undefined when none is set.
 *
 * @example
 * ```typescript
 * uploadPackRequestPolicyOf(config); // [uploadpack] allowTipSHA1InWant → "TIP"
 * ```
 */
export function uploadPackRequestPolicyOf(
  config: ServerConfigReader,
): UploadPackRequestPolicy | undefined {
  const entries: { key: string; value: unknown }[] = [];
  if (config.list) {
    for (const entry of config.list()) {
      if (ALLOW_KEYS[entry.key.toLowerCase()] !== undefined) entries.push(entry);
    }
  } else {
    for (const key of Object.keys(ALLOW_KEYS)) {
      for (const value of config.getAll(key)) entries.push({ key, value });
    }
  }
  if (entries.length === 0) return undefined;
  let bits = 0;
  for (const { key, value } of entries) {
    const bit = ALLOW_KEYS[key.toLowerCase()] as number;
    bits = configBool(value, false) ? bits | bit : bits & ~bit;
  }
  if ((bits & ALLOW_ANY) === ALLOW_ANY) return "ANY";
  if (bits & ALLOW_TIP && bits & ALLOW_REACHABLE) return "REACHABLE_COMMIT_TIP";
  if (bits & ALLOW_TIP) return "TIP";
  if (bits & ALLOW_REACHABLE) return "REACHABLE_COMMIT";
  return "ADVERTISED";
}

/**
 * Of the deaths `errors` (each naming its key as `for '<key>'`), the one whose key comes first in
 * the configuration (receive_pack_config dies at the first value it cannot read).
 */
function firstInConfigOrder(config: ServerConfigReader, errors: string[]): string {
  if (errors.length === 1 || !config.list) return errors[0] as string;
  const keyOf = (e: string) => /for '([^']+)'/.exec(e)?.[1];
  for (const { key } of config.list()) {
    const hit = errors.find((e) => keyOf(e) === key.toLowerCase());
    if (hit) return hit;
  }
  return errors[0] as string;
}

/** git's defaults: what {@link serverSettingsFromConfig} gives for an empty configuration. */
export const GIT_SERVER_SETTINGS_DEFAULTS: Readonly<ServerConfigSettings> = Object.freeze({
  allowDeletes: true,
  allowNonFastForward: true,
  denyCurrentBranch: "unconfigured",
  denyDeleteCurrent: "unconfigured",
  shallowUpdate: false,
  advertisePushOptions: false,
  uploadPackHideRefs: [],
  receivePackHideRefs: [],
});

/**
 * The settings the configuration sets explicitly: a key appears only when one of the
 * variables behind it has a value (`receive.denyDeletes` set, a hidden ref pattern listed),
 * so the result can be layered over another source's settings without resetting what the
 * configuration leaves alone to git's defaults (see `serveGitService`).
 *
 * @example
 * ```typescript
 * explicitServerSettingsFromConfig(config); // [receive] denyDeletes = true → { allowDeletes: false }
 * ```
 */
export function explicitServerSettingsFromConfig(
  config: ServerConfigReader,
): Partial<ServerConfigSettings> {
  const out: Partial<ServerConfigSettings> = {};
  const denyDeletes = last(config, "receive.denyDeletes");
  if (denyDeletes !== undefined) out.allowDeletes = !configBool(denyDeletes, false);
  const denyNonFf = last(config, "receive.denyNonFastForwards");
  if (denyNonFf !== undefined) out.allowNonFastForward = !configBool(denyNonFf, false);
  const current = config.getAll("receive.denyCurrentBranch");
  if (current.length > 0) out.denyCurrentBranch = denyAction(current);
  const deleteCurrent = config.getAll("receive.denyDeleteCurrent");
  if (deleteCurrent.length > 0) out.denyDeleteCurrent = denyAction(deleteCurrent);
  const shallow = last(config, "receive.shallowUpdate");
  if (shallow !== undefined) out.shallowUpdate = configBool(shallow, false);
  const pushOptions = last(config, "receive.advertisePushOptions");
  if (pushOptions !== undefined) out.advertisePushOptions = configBool(pushOptions, false);
  const atomic = last(config, "receive.advertiseAtomic");
  if (atomic !== undefined) out.advertiseAtomic = configBool(atomic, true);
  // receive_pack_config reads in config order: the first value git cannot read kills it
  const numberErrors: string[] = [];
  // every value is read (git dies at a bad one even when a later one overrides it)
  const numeric = (key: string, parse: (v: unknown) => number | undefined) => {
    let result: number | undefined;
    for (const value of config.getAll(key)) {
      const n = parse(value);
      if (n === undefined) {
        numberErrors.push(badNumeric(config, key.toLowerCase(), value));
        return undefined;
      }
      result = n;
    }
    return result;
  };
  const seed = last(config, "receive.certNonceSeed");
  if (seed !== undefined) out.certNonceSeed = String(seed);
  const slop = numeric("receive.certNonceSlop", configInt);
  if (slop !== undefined) out.certNonceSlop = slop;
  const maxInput = numeric("receive.maxInputSize", configInt64);
  if (maxInput !== undefined) out.maxInputSize = maxInput;
  const keepAlive = numeric("receive.keepAlive", configInt);
  if (keepAlive !== undefined) out.receiveKeepAliveMs = Math.max(0, keepAlive) * 1000;
  // receive_pack_config: receive.unpackLimit wins over transfer.unpackLimit, in any order
  const receiveLimit = numeric("receive.unpackLimit", configInt);
  const transferLimit = numeric("transfer.unpackLimit", configInt);
  const unpackLimit =
    receiveLimit !== undefined && receiveLimit >= 0
      ? receiveLimit
      : transferLimit !== undefined && transferLimit >= 0
        ? transferLimit
        : undefined;
  if (unpackLimit !== undefined) out.unpackLimit = unpackLimit;
  const upload = hideRefs(config, "uploadpack");
  if (upload.length > 0) out.uploadPackHideRefs = upload;
  const receive = hideRefs(config, "receive");
  if (receive.length > 0) out.receivePackHideRefs = receive;
  const filter = filterPolicy(config);
  if (filter) out.uploadPackFilter = filter;
  const wantPolicy = uploadPackRequestPolicyOf(config);
  if (wantPolicy !== undefined) out.uploadPackRequestPolicy = wantPolicy;
  const refInWant = last(config, "uploadpack.allowRefInWant");
  if (refInWant !== undefined) out.allowRefInWant = configBool(refInWant, false);
  const sidebandAll = last(config, "uploadpack.allowSidebandAll");
  if (sidebandAll !== undefined) out.allowSidebandAll = configBool(sidebandAll, false);
  const sid = last(config, "transfer.advertiseSID");
  if (sid !== undefined) out.advertiseSID = configBool(sid, false);
  // bundle_uri_advertise / bundle_uri_command
  const advertiseBundles = last(config, "uploadpack.advertiseBundleURIs");
  if (advertiseBundles !== undefined && configBool(advertiseBundles, false)) {
    out.bundleUris = bundleUriLinesOf(config);
  }
  // uploadpack.packObjectsHook is never read here: git takes it only from protected config
  // (system, global, command line), never from a served repository's own
  // a key without a value is an error in git (config_error_nonbool): receive-pack dies
  const procReceiveValues = config.getAll("receive.procReceiveRefs");
  const procReceive = procReceiveValues.filter((v): v is string => typeof v === "string");
  if (procReceive.length > 0) out.procReceiveRefs = procReceive;
  if (procReceive.length < procReceiveValues.length) {
    out.receivePackConfigError = nonBoolError(config, "receive.procreceiverefs");
  }
  if (out.receivePackConfigError === undefined && numberErrors.length > 0) {
    out.receivePackConfigError = firstInConfigOrder(config, numberErrors);
  }
  return out;
}

/**
 * git's `git_config_int` of a value: a decimal integer, optionally followed by `k`, `m` or
 * `g` (case-insensitive: times 1024, 1024², 1024³); undefined for anything else (git dies
 * there: `bad numeric config value`).
 *
 * @example
 * ```typescript
 * parseConfigInt("1k"); // 1024
 * ```
 */
export function parseConfigInt(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const match = /^\s*([+-]?\d+)\s*([kmg]?)\s*$/i.exec(String(value));
  if (!match) return undefined;
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[
    (match[2] ?? "").toLowerCase() as "" | "k" | "m" | "g"
  ];
  return Number(match[1]) * unit;
}

/**
 * The unpack limit of `<section>.unpackLimit`, else `transfer.unpackLimit` (receive-pack's
 * `receive`, fetch-pack's `fetch`), each its last value; a negative value counts as unset, as
 * git's `if (0 <= receive_unpack_limit)`. Undefined when neither is set (git's default 100).
 * What 0 means is the reader's: receive-pack keeps every pack, fetch-pack unpacks every one.
 *
 * @example
 * ```typescript
 * unpackLimitOf(config, "fetch"); // [fetch] unpackLimit = 1 → 1
 * ```
 */
export function unpackLimitOf(
  config: ServerConfigReader,
  section: "receive" | "fetch",
): number | undefined {
  for (const key of [`${section}.unpackLimit`, "transfer.unpackLimit"]) {
    const limit = parseConfigInt(last(config, key));
    if (limit !== undefined && limit >= 0) return limit;
  }
  return undefined;
}

/**
 * The served repository's settings, as git's receive-pack and upload-pack read them from
 * its configuration: every key, git's default ({@link GIT_SERVER_SETTINGS_DEFAULTS}) where the
 * configuration sets none ({@link explicitServerSettingsFromConfig} gives only the keys set).
 */
export function serverSettingsFromConfig(config: ServerConfigReader): ServerConfigSettings {
  return {
    ...GIT_SERVER_SETTINGS_DEFAULTS,
    uploadPackHideRefs: [],
    receivePackHideRefs: [],
    ...explicitServerSettingsFromConfig(config),
  };
}

/**
 * {@link serverSettingsFromConfig} as the smart-HTTP server takes it: the receive-pack
 * policies and hidden refs under `receivePack`, upload-pack's hidden refs under `uploadPack`.
 */
export function httpServerSettings(settings: ServerConfigSettings): {
  receivePack: {
    allowDeletes: boolean;
    allowNonFastForward: boolean;
    denyCurrentBranch: ReceiveDenyAction;
    denyDeleteCurrent: ReceiveDenyAction;
    shallowUpdate: boolean;
    advertisePushOptions: boolean;
    advertiseAtomic?: boolean;
    maxInputSize?: number;
    receiveKeepAliveMs?: number;
    unpackLimit?: number;
    hideRefs: string[];
  };
  uploadPack: { hideRefs: string[] };
} {
  return {
    receivePack: {
      allowDeletes: settings.allowDeletes,
      allowNonFastForward: settings.allowNonFastForward,
      denyCurrentBranch: settings.denyCurrentBranch,
      denyDeleteCurrent: settings.denyDeleteCurrent,
      shallowUpdate: settings.shallowUpdate,
      advertisePushOptions: settings.advertisePushOptions,
      ...(settings.advertiseAtomic !== undefined
        ? { advertiseAtomic: settings.advertiseAtomic }
        : {}),
      ...(settings.maxInputSize !== undefined ? { maxInputSize: settings.maxInputSize } : {}),
      ...(settings.receiveKeepAliveMs !== undefined
        ? { receiveKeepAliveMs: settings.receiveKeepAliveMs }
        : {}),
      ...(settings.unpackLimit !== undefined ? { unpackLimit: settings.unpackLimit } : {}),
      hideRefs: settings.receivePackHideRefs,
    },
    uploadPack: { hideRefs: settings.uploadPackHideRefs },
  };
}

/**
 * bundle-uri.c's `config_to_packet_line`: every `bundle.*` entry with a value, as
 * `<key>=<value>` in config order (keys canonical: section and name lower-cased).
 */
function bundleUriLinesOf(config: ServerConfigReader): string[] {
  const out: string[] = [];
  if (!config.list) return out;
  for (const { key, value } of config.list()) {
    if (!key.toLowerCase().startsWith("bundle.")) continue;
    if (typeof value !== "string" || value === "") continue;
    out.push(`${canonicalConfigKey(key)}=${value}`);
  }
  return out;
}

/** git's canonical config key: the section and the name lower-cased, a subsection kept. */
function canonicalConfigKey(key: string): string {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first < 0) return key.toLowerCase();
  return `${key.slice(0, first).toLowerCase()}${key.slice(first, last)}.${key.slice(last + 1).toLowerCase()}`;
}
