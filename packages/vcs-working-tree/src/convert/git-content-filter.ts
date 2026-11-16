/**
 * git's content conversion (`convert.c`) for a working copy: the attributes of a path
 * (`crlf`, `text`, `eol`, `ident`, `filter`, `working-tree-encoding`) and the configuration
 * (`core.autocrlf`, `core.eol`, `core.safecrlf`, `filter.<driver>.*`) decide how a file is
 * cleaned on its way into the index and smudged on its way out.
 *
 * Attributes are read as git reads them: on check-in from the worktree's `.gitattributes`
 * (the index's when the worktree has none), on checkout from the index's (the worktree's
 * when the index has none). A checkout in progress writes `.gitattributes` files before the
 * files they govern (they sort first): what it wrote is what the index will hold, so it is
 * read in their place, as git reads its already-updated index.
 */

import type { Blobs, ObjectId } from "@statewalker/vcs-core";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { computeObjectIdFromStream } from "@statewalker/vcs-utils/pack";
import {
  AttributesResolver,
  type AttributesSources,
  type AttributeValue,
} from "../attributes/index.js";
import type { Staging } from "../staging/staging.js";
import type { WorkingCopyConfig } from "../working-copy.js";
import {
  type ContentConversion,
  type ContentConversionOptions,
  collectChunks,
  isAttributesFile,
  type WorktreeContentFilter,
} from "../worktree/content-filter.js";
import type { NewHasher } from "../worktree/hash-worktree-file.js";
import type { WorktreeEntry } from "../worktree/types.js";
import type { Worktree } from "../worktree/worktree.js";
import { isSupportedEncoding, reencode, sameEncoding, validateEncoding } from "./encoding.js";
import {
  type AutoCrlf,
  type CoreEol,
  type CrlfAction,
  crlfToGit,
  crlfToWorktree,
  type EolSettings,
  hasCrlf,
  outputEol,
  type SafeCrlf,
  textEolIsCrlf,
} from "./eol.js";
import {
  type FilterDriver,
  FilterDriverError,
  type FilterDriverRegistry,
  lookupFilterDriver,
} from "./filter-driver.js";
import { expandUserPath, type GitHostEnvironment, xdgConfigPath } from "./host-environment.js";
import { identToGit, identToWorktree } from "./ident.js";

/** Which way attributes are read: check-in (worktree first) or checkout (index first). */
export type AttributesDirection = "checkin" | "checkout";

/** A filter driver as the configuration and the host define it. */
export interface ConvertDriver {
  name: string;
  /** `filter.<name>.clean` */
  clean?: string;
  /** `filter.<name>.smudge` */
  smudge?: string;
  /** `filter.<name>.process` */
  process?: string;
  /** `filter.<name>.required` (or the host driver's) */
  required: boolean;
  /** The host's implementation, when it registered one */
  host?: FilterDriver;
}

/** git's `struct conv_attrs`: how a path is converted. */
export interface ConvAttrs {
  /** The line-ending action after the configuration is applied */
  crlfAction: CrlfAction;
  /** The line-ending action the attributes alone ask for (`ls-files --eol`'s `attr/`) */
  attrAction: CrlfAction;
  ident: boolean;
  driver?: ConvertDriver;
  workingTreeEncoding?: string;
}

/** The configuration the conversion reads. */
export interface ConversionSettings extends EolSettings {
  /** `core.ignorecase`: attribute patterns match case-insensitively */
  ignoreCase: boolean;
  /** `core.attributesFile` */
  attributesFile?: string;
  /** `filter.<name>.*` */
  drivers: Map<string, Omit<ConvertDriver, "host">>;
}

/** What {@link GitContentFilter} reads from. */
export interface GitContentFilterOptions {
  /** The worktree: its `.gitattributes` files, and `info/attributes` through `readGitDirFile` */
  worktree: Worktree;
  /** The index: its `.gitattributes` and the content `has_crlf_in_index` checks */
  staging?: Staging;
  /** The blobs the index names */
  blobs?: Blobs;
  /** The configuration (`core.*`, `filter.*`); read afresh on every conversion */
  config?: WorkingCopyConfig;
  /** The user's environment (global attributes); default: the configuration's `environment` */
  environment?: GitHostEnvironment;
  /** The host's filter drivers, by name */
  drivers?: FilterDriverRegistry;
  /** The hash of blob ids (`ident`); default SHA-1 */
  newHasher?: NewHasher;
  /** Reads `$GIT_DIR/info/attributes`; default: `worktree.readGitDirFile("info/attributes")` */
  readInfoAttributes?: () => Promise<Uint8Array | undefined>;
  /** Receives git's warnings and non-fatal errors (attribute lines ignored, failed encodings) */
  onWarning?: (message: string) => void;
}

const CONVERT_ATTRS = ["crlf", "ident", "filter", "eol", "text", "working-tree-encoding"] as const;

/** Reads a configuration value from a git config object or a plain bag. */
export function configValue(config: WorkingCopyConfig | undefined, key: string): unknown {
  if (!config) return undefined;
  const get = (config as { get?: unknown }).get;
  if (typeof get === "function") return (get as (k: string) => unknown).call(config, key);
  return config[key];
}

/** Every key of the configuration that starts with `prefix`. */
function configKeys(config: WorkingCopyConfig | undefined, prefix: string): string[] {
  if (!config) return [];
  const list = (config as { listKeys?: unknown }).listKeys;
  if (typeof list === "function") return (list as (p: string) => string[]).call(config, prefix);
  return Object.keys(config).filter((k) => k.toLowerCase().startsWith(prefix));
}

/** A git boolean value, or undefined when it is not one. */
export function gitBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (["true", "yes", "on", ""].includes(text)) return true;
  if (["false", "no", "off"].includes(text)) return false;
  if (/^-?\d+$/.test(text)) return Number(text) !== 0;
  return undefined;
}

const str = (value: unknown) =>
  value === undefined || value === null || typeof value === "boolean" ? undefined : String(value);

/** The conversion settings of a configuration (git's `git_default_core_config` and friends). */
export function readConversionSettings(
  config: WorkingCopyConfig | undefined,
  native: "lf" | "crlf" = "lf",
): ConversionSettings {
  const autocrlfValue = configValue(config, "core.autocrlf");
  let autocrlf: AutoCrlf = "false";
  if (typeof autocrlfValue === "string" && autocrlfValue.toLowerCase() === "input") {
    autocrlf = "input";
  } else if (gitBool(autocrlfValue)) autocrlf = "true";

  const eolValue = str(configValue(config, "core.eol"))?.toLowerCase();
  const eol: CoreEol =
    eolValue === "lf" || eolValue === "crlf" || eolValue === "native" ? eolValue : "unset";

  const safeValue = configValue(config, "core.safecrlf");
  let safecrlf: SafeCrlf = "warn";
  if (safeValue !== undefined) {
    if (typeof safeValue === "string" && safeValue.toLowerCase() === "warn") safecrlf = "warn";
    else safecrlf = gitBool(safeValue) ? "die" : "off";
  }

  const drivers = new Map<string, Omit<ConvertDriver, "host">>();
  for (const key of configKeys(config, "filter.")) {
    const last = key.lastIndexOf(".");
    const name = key.slice("filter.".length, last);
    const prop = key.slice(last + 1).toLowerCase();
    if (!name) continue;
    const driver = drivers.get(name) ?? { name, required: false };
    const value = configValue(config, key);
    if (prop === "clean") driver.clean = str(value);
    else if (prop === "smudge") driver.smudge = str(value);
    else if (prop === "process") driver.process = str(value);
    else if (prop === "required") driver.required = gitBool(value) ?? false;
    drivers.set(name, driver);
  }

  const attributesFile = str(configValue(config, "core.attributesfile"));
  return {
    autocrlf,
    eol,
    safecrlf,
    native,
    ignoreCase: gitBool(configValue(config, "core.ignorecase")) ?? false,
    ...(attributesFile ? { attributesFile } : {}),
    drivers,
  };
}

/** git's `git_path_check_crlf`. */
function checkCrlf(value: AttributeValue): CrlfAction {
  if (value === true) return "text";
  if (value === false) return "binary";
  if (value === undefined) return "undefined";
  if (value === "input") return "text-input";
  if (value === "auto") return "auto";
  return "undefined";
}

/** git's `git_path_check_eol`. */
function checkEol(value: AttributeValue): "lf" | "crlf" | undefined {
  if (value === "lf") return "lf";
  if (value === "crlf") return "crlf";
  return undefined;
}

/** git's `convert_attrs`: the attributes and the configuration combined. */
export function convAttrsOf(
  attrs: Map<string, AttributeValue>,
  settings: ConversionSettings,
  hostDrivers?: FilterDriverRegistry,
): ConvAttrs {
  let crlfAction = checkCrlf(attrs.get("text"));
  if (crlfAction === "undefined") crlfAction = checkCrlf(attrs.get("crlf"));
  const ident = attrs.get("ident") === true;

  let driver: ConvertDriver | undefined;
  const filter = attrs.get("filter");
  if (typeof filter === "string") {
    const configured = settings.drivers.get(filter);
    const host = lookupFilterDriver(hostDrivers, filter);
    if (configured || host) {
      driver = {
        name: filter,
        ...(configured?.clean !== undefined ? { clean: configured.clean } : {}),
        ...(configured?.smudge !== undefined ? { smudge: configured.smudge } : {}),
        ...(configured?.process !== undefined ? { process: configured.process } : {}),
        required: configured?.required || (host?.required ?? false),
        ...(host ? { host } : {}),
      };
    }
  }

  if (crlfAction !== "binary") {
    const eol = checkEol(attrs.get("eol"));
    if (crlfAction === "auto" && eol === "lf") crlfAction = "auto-input";
    else if (crlfAction === "auto" && eol === "crlf") crlfAction = "auto-crlf";
    else if (eol === "lf") crlfAction = "text-input";
    else if (eol === "crlf") crlfAction = "text-crlf";
  }

  let workingTreeEncoding: string | undefined;
  const enc = attrs.get("working-tree-encoding");
  if (enc === true || enc === false) {
    throw new Error("true/false are no valid working-tree-encodings");
  }
  if (typeof enc === "string" && enc.length > 0 && !sameEncoding(enc, "UTF-8")) {
    workingTreeEncoding = enc;
  }

  const attrAction = crlfAction;
  if (crlfAction === "text") crlfAction = textEolIsCrlf(settings) ? "text-crlf" : "text-input";
  if (crlfAction === "undefined" && settings.autocrlf === "false") crlfAction = "binary";
  if (crlfAction === "undefined" && settings.autocrlf === "true") crlfAction = "auto-crlf";
  if (crlfAction === "undefined" && settings.autocrlf === "input") crlfAction = "auto-input";

  return {
    crlfAction,
    attrAction,
    ident,
    ...(driver ? { driver } : {}),
    ...(workingTreeEncoding ? { workingTreeEncoding } : {}),
  };
}

/** git's `get_convert_attr_ascii`: the `attr/` column of `git ls-files --eol`. */
export function convertAttrAscii(ca: ConvAttrs): string {
  switch (ca.attrAction) {
    case "undefined":
      return "";
    case "binary":
      return "-text";
    case "text":
      return "text";
    case "text-input":
      return "text eol=lf";
    case "text-crlf":
      return "text eol=crlf";
    case "auto":
      return "text=auto";
    case "auto-crlf":
      return "text=auto eol=crlf";
    case "auto-input":
      return "text=auto eol=lf";
  }
}

/** Whether a clean or smudge of `ca` may change content at all. */
function converts(ca: ConvAttrs, direction: AttributesDirection, settings: EolSettings): boolean {
  if (ca.driver || ca.ident || ca.workingTreeEncoding) return true;
  if (ca.crlfAction === "binary") return false;
  return direction === "checkin" || outputEol(ca.crlfAction, settings) === "crlf";
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** A stat of a worktree file that a later identical one shows unchanged. */
function statKey(entry: WorktreeEntry): string {
  return [entry.size, entry.mtime, entry.mtimeNs, entry.ctime, entry.ctimeNs, entry.ino].join(":");
}

/** How long after its last change a file's stat is trusted to show further changes (ms). */
const SETTLED_MS = 3000;

/**
 * git's conversion of file content between the worktree and the repository.
 *
 * @example
 * ```typescript
 * const filter = new GitContentFilter({ worktree, staging, blobs: history.blobs, config });
 * worktree.setContentFilter?.(filter);
 * const cleaned = await filter.convertToGit("a.txt", bytes);
 * ```
 */
export class GitContentFilter implements WorktreeContentFilter {
  private readonly checkinResolver: AttributesResolver;
  private readonly checkoutResolver: AttributesResolver;
  /** In-tree attributes files a checkout wrote or removed (path -> content, or none) */
  private readonly written = new Map<string, { content?: Uint8Array; key?: string }>();
  /** Worktree attributes files read, by path: content kept while their stat is unchanged */
  private readonly worktreeFiles = new Map<string, { key: string; content: Uint8Array }>();
  /** Index blobs read (attributes files), by id */
  private readonly indexBlobs = new Map<string, Uint8Array>();
  private settingsCache?: ConversionSettings;

  constructor(private readonly options: GitContentFilterOptions) {
    const resolverOptions = {
      ignoreCase: () => (this.settingsCache ?? this.settings()).ignoreCase,
      ...(options.onWarning ? { onWarning: options.onWarning } : {}),
    };
    this.checkinResolver = new AttributesResolver(this.sources("checkin"), resolverOptions);
    this.checkoutResolver = new AttributesResolver(this.sources("checkout"), resolverOptions);
  }

  /** The configuration's conversion settings, read afresh. */
  settings(): ConversionSettings {
    const native = this.options.worktree.capabilities?.windowsPaths ? "crlf" : "lf";
    this.settingsCache = readConversionSettings(this.options.config, native);
    return this.settingsCache;
  }

  private get environment(): GitHostEnvironment | undefined {
    return (
      this.options.environment ??
      (this.options.config as { environment?: GitHostEnvironment } | undefined)?.environment
    );
  }

  private sources(direction: AttributesDirection): AttributesSources {
    const env = () => this.environment;
    return {
      system: async () => {
        const path = env()?.systemAttributes;
        return path ? env()?.readFile(path) : undefined;
      },
      global: async () => {
        const e = env();
        const configured = (this.settingsCache ?? this.settings()).attributesFile;
        const path = configured ? expandUserPath(configured, e) : xdgConfigPath(e, "attributes");
        if (!path || !e) return undefined;
        return e.readFile(path).catch(() => undefined);
      },
      info: async () => {
        if (this.options.readInfoAttributes) return this.options.readInfoAttributes();
        return this.options.worktree.readGitDirFile?.("info/attributes");
      },
      inTree: async (dir) => {
        const path = dir ? `${dir}/.gitattributes` : ".gitattributes";
        if (direction === "checkout") {
          const written = await this.writtenAttributes(path);
          if (written) return written.content;
          return (await this.indexContent(path)) ?? (await this.worktreeContent(path));
        }
        return (await this.worktreeContent(path)) ?? (await this.indexContent(path));
      },
    };
  }

  /** What a checkout wrote at `path`, while the file still holds it. */
  private async writtenAttributes(path: string): Promise<{ content?: Uint8Array } | undefined> {
    const note = this.written.get(path);
    if (!note) return undefined;
    const entry = await this.options.worktree.getEntry(path).catch(() => undefined);
    if (note.content === undefined) {
      if (!entry) return note;
      this.written.delete(path);
      return undefined;
    }
    if (!entry || entry.isDirectory) {
      this.written.delete(path);
      return undefined;
    }
    const key = statKey(entry);
    if (note.key === undefined) note.key = key;
    if (note.key !== key) {
      this.written.delete(path);
      return undefined;
    }
    return note;
  }

  /** The worktree's file at `path` (never through a symbolic link). */
  private async worktreeContent(path: string): Promise<Uint8Array | undefined> {
    const { worktree } = this.options;
    const entry = await worktree.getEntry(path).catch(() => undefined);
    if (!entry || entry.isDirectory || (entry.mode & S_IFMT) === S_IFLNK) {
      this.worktreeFiles.delete(path);
      return undefined;
    }
    const key = statKey(entry);
    const cached = this.worktreeFiles.get(path);
    if (cached && cached.key === key) return cached.content;
    let content: Uint8Array;
    try {
      content = await collectChunks(worktree.readContent(path));
    } catch {
      return undefined;
    }
    // kept only once settled: a change within the same tick could keep the same stat
    if (entry.mtime && Date.now() - entry.mtime > SETTLED_MS && entry.mtimeNs !== undefined) {
      this.worktreeFiles.set(path, { key, content });
    } else this.worktreeFiles.delete(path);
    return content;
  }

  /** The index's blob for `path` (stage 0, else "ours" during a merge). */
  private async indexEntryId(path: string): Promise<ObjectId | undefined> {
    const { staging } = this.options;
    if (!staging) return undefined;
    const entry = (await staging.getEntry(path, 0)) ?? (await staging.getEntry(path, 2));
    return entry?.objectId;
  }

  private async loadBlob(id: ObjectId): Promise<Uint8Array | undefined> {
    const { blobs } = this.options;
    if (!blobs) return undefined;
    const content = await blobs.load(id).catch(() => undefined);
    return content ? collectChunks(content) : undefined;
  }

  private async indexContent(path: string): Promise<Uint8Array | undefined> {
    const id = await this.indexEntryId(path);
    if (!id) return undefined;
    const cached = this.indexBlobs.get(id);
    if (cached) return cached;
    const content = await this.loadBlob(id);
    if (content) {
      if (this.indexBlobs.size > 64) this.indexBlobs.clear();
      this.indexBlobs.set(id, content);
    }
    return content;
  }

  /** git's `has_crlf_in_index`. */
  private async hasCrlfInIndex(path: string): Promise<boolean> {
    const id = await this.indexEntryId(path);
    if (!id) return false;
    return hasCrlf(await this.loadBlob(id));
  }

  /**
   * The attributes of `path` as the conversion reads them (`git check-attr`): all that are
   * set, or only `names`.
   */
  async attributes(
    path: string,
    names?: readonly string[],
    direction: AttributesDirection = "checkin",
  ): Promise<Map<string, AttributeValue>> {
    this.settings();
    const resolver = direction === "checkout" ? this.checkoutResolver : this.checkinResolver;
    return resolver.get(path, names);
  }

  /** git's `convert_attrs` for `path`. */
  async convAttrs(path: string, direction: AttributesDirection = "checkin"): Promise<ConvAttrs> {
    const attrs = await this.attributes(path, CONVERT_ATTRS, direction);
    return convAttrsOf(attrs, this.settingsCache ?? this.settings(), this.options.drivers);
  }

  /** The `attr/` column of `git ls-files --eol` for `path`. */
  async eolAttribute(path: string): Promise<string> {
    return convertAttrAscii(await this.convAttrs(path, "checkin"));
  }

  private async blobId(content: Uint8Array): Promise<string> {
    return computeObjectIdFromStream(
      "blob",
      content.length,
      [content],
      this.options.newHasher ?? createSha1,
    );
  }

  private warn(options: ContentConversionOptions | undefined, message: string): void {
    (options?.onWarning ?? this.options.onWarning)?.(message);
  }

  /** git's `apply_filter`: the driver's output, or undefined when it did not run. */
  private async applyDriver(
    driver: ConvertDriver | undefined,
    direction: "clean" | "smudge",
    path: string,
    content: Uint8Array,
  ): Promise<Uint8Array | undefined> {
    if (!driver) return undefined;
    const run = driver.host?.[direction];
    if (!run) return undefined;
    try {
      return await run.call(driver.host, content, { path });
    } catch {
      return undefined;
    }
  }

  /**
   * git's `convert_to_git`: worktree content as the repository stores it.
   *
   * @throws FilterDriverError when a required filter driver is missing or fails
   * @throws SafeCrlfError when `core.safecrlf=true` refuses the change of line endings
   */
  async convertToGit(
    path: string,
    src: Uint8Array,
    options: ContentConversionOptions & { keepCrlf?: boolean; attrs?: ConvAttrs } = {},
  ): Promise<Uint8Array> {
    const ca = options.attrs ?? (await this.convAttrs(path, "checkin"));
    const settings = this.settingsCache ?? this.settings();
    let out = src;
    const filtered = await this.applyDriver(ca.driver, "clean", path, out);
    if (filtered === undefined && ca.driver?.required) {
      throw new FilterDriverError(`${path}: clean filter '${ca.driver.name}' failed`);
    }
    if (filtered !== undefined) out = filtered;

    const enc = ca.workingTreeEncoding;
    if (enc && out.length > 0) {
      // git's errors (and advice) go to the filter's sink, not the command's warnings: a
      // write fails with the error, anything else keeps the content as it is
      const invalid = validateEncoding(path, enc, out);
      if (invalid) {
        this.options.onWarning?.(`hint: ${invalid.advice}`);
        if (options.write) throw new Error(invalid.error);
        this.options.onWarning?.(`error: ${invalid.error}`);
      } else {
        const converted = reencode(out, "UTF-8", enc);
        if (!converted) {
          const message = `failed to encode '${path}' from ${enc} to UTF-8`;
          if (options.write) throw new Error(message);
          this.options.onWarning?.(`error: ${message}`);
        } else out = converted;
      }
    }

    if (!options.keepCrlf) {
      const roundTrip =
        options.write && !options.renormalize && settings.safecrlf !== "off"
          ? settings.safecrlf
          : undefined;
      out = await crlfToGit(path, out, ca.crlfAction, settings, {
        hasCrlfInIndex: () => this.hasCrlfInIndex(path),
        ...(options.renormalize ? { renormalize: true } : {}),
        ...(roundTrip ? { roundTrip } : {}),
        onWarning: (message) => this.warn(options, message),
      });
    }
    if (ca.ident) out = identToGit(out);
    return out;
  }

  /**
   * git's `convert_to_working_tree`: repository content as the worktree holds it.
   * `normalizing` (renormalisation) skips the line-ending step unless a smudge driver may
   * expect it.
   *
   * @throws FilterDriverError when a required filter driver is missing or fails
   */
  async convertToWorktree(
    path: string,
    src: Uint8Array,
    options: { normalizing?: boolean; attrs?: ConvAttrs; onWarning?: (m: string) => void } = {},
  ): Promise<Uint8Array> {
    const ca = options.attrs ?? (await this.convAttrs(path, "checkout"));
    const settings = this.settingsCache ?? this.settings();
    let out = src;
    if (ca.ident) out = identToWorktree(out, await this.blobId(out));
    const smudger = ca.driver && (ca.driver.smudge || ca.driver.process || ca.driver.host?.smudge);
    if (smudger || !options.normalizing) out = crlfToWorktree(out, ca.crlfAction, settings);
    const enc = ca.workingTreeEncoding;
    if (enc && out.length > 0) {
      const converted = reencode(out, enc, "UTF-8");
      if (!converted) {
        this.options.onWarning?.(`error: failed to encode '${path}' from UTF-8 to ${enc}`);
      } else out = converted;
    }
    const filtered = await this.applyDriver(ca.driver, "smudge", path, out);
    if (filtered === undefined && ca.driver?.required) {
      throw new FilterDriverError(`${path}: smudge filter ${ca.driver.name} failed`);
    }
    return filtered ?? out;
  }

  /** git's `renormalize_buffer`: content as a checkout and check-in would leave it. */
  async renormalize(path: string, src: Uint8Array): Promise<Uint8Array> {
    const ca = await this.convAttrs(path, "checkin");
    const smudged = await this.convertToWorktree(path, src, { normalizing: true, attrs: ca });
    return this.convertToGit(path, smudged, { renormalize: true, attrs: ca });
  }

  async checkin(path: string): Promise<ContentConversion | undefined> {
    const ca = await this.convAttrs(path, "checkin");
    if (!converts(ca, "checkin", this.settingsCache ?? this.settings())) return undefined;
    return {
      apply: (content, options) => this.convertToGit(path, content, { ...options, attrs: ca }),
    };
  }

  async checkout(path: string): Promise<ContentConversion | undefined> {
    const ca = await this.convAttrs(path, "checkout");
    if (!converts(ca, "checkout", this.settingsCache ?? this.settings())) return undefined;
    return {
      apply: (content, options) =>
        this.convertToWorktree(path, content, {
          attrs: ca,
          ...(options?.onWarning ? { onWarning: options.onWarning } : {}),
        }),
    };
  }

  noteWritten(path: string, content: Uint8Array): void {
    if (isAttributesFile(path)) this.written.set(path, { content });
  }

  noteRemoved(path: string): void {
    if (isAttributesFile(path)) this.written.set(path, {});
  }

  /** Whether `encoding` is one the conversion can handle (others fail as in git). */
  static supportsEncoding(encoding: string): boolean {
    return isSupportedEncoding(encoding);
  }
}

/** Options of {@link createGitContentFilter}. */
export type CreateGitContentFilterOptions = GitContentFilterOptions;

/**
 * git's conversion for a working copy's worktree, index and configuration.
 *
 * @example
 * ```typescript
 * worktree.setContentFilter?.(
 *   createGitContentFilter({ worktree, staging: checkout.staging, blobs: history.blobs, config }),
 * );
 * ```
 */
export function createGitContentFilter(options: CreateGitContentFilterOptions): GitContentFilter {
  return new GitContentFilter(options);
}
