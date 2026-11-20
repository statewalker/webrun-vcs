/**
 * git's content conversion (`convert.c`) for a working copy: the attributes of a path
 * (`crlf`, `text`, `eol`, `ident`, `filter`, `working-tree-encoding`) and the configuration
 * (`core.autocrlf`, `core.eol`, `core.safecrlf`, `filter.<driver>.*`) decide how a file is
 * cleaned on its way into the index and smudged on its way out.
 *
 * Attributes are read as git reads them: on check-in (and a smudge outside unpack-trees,
 * such as `checkout -- <path>`) from the worktree's `.gitattributes` (the index's when the
 * worktree has none); on a checkout of a tree from the index the checkout leaves behind
 * (the worktree's when that index has none), which the operation passes along with each
 * file it writes, as git's `check_updates` reads `o->result`.
 */

import type { Blobs, ObjectId, Trees } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils/encoding";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { computeObjectIdFromStream } from "@statewalker/vcs-utils/pack";
import {
  type AttributesContent,
  AttributesMemo,
  AttributesResolver,
  type AttributesSourceResolver,
  type AttributesSources,
  type AttributesSourceTree,
  type AttributeValue,
  attributesSourceSetting,
  readTreeAttributesFile,
  resolveAttributesSource,
} from "../attributes/index.js";
import type { Staging } from "../staging/staging.js";
import type { WorkingCopyConfig } from "../working-copy.js";
import {
  type AttributesIndex,
  type ContentAttributesContext,
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
  /** The trees, for an attribute source (`$GIT_ATTR_SOURCE`, `attr.tree`) */
  trees?: Pick<Trees, "getEntry">;
  /**
   * Resolves the tree-ish of an attribute source (git's revision syntax); without one only a
   * full object id names a tree (see {@link GitContentFilter.setAttributesSourceResolver})
   */
  resolveAttributesSource?: AttributesSourceResolver;
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

/**
 * A git boolean value (`git_config_bool`), or undefined when it is not one: a key with no
 * `=` (the boolean `true`) is true, an empty value false.
 */
export function gitBool(value: unknown): boolean | undefined {
  return parseGitBool(value);
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

/** The directory of an in-tree attributes file ("" for the root's). */
const dirOfAttributesFile = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "";
};

/**
 * What one operation reads once: the configuration, the attributes files outside the tree,
 * and (per attribute source) each directory's chain of `.gitattributes`.
 */
interface Scope {
  settings: ConversionSettings;
  memos: Map<string, { sources: AttributesSources; memo: AttributesMemo }>;
  /** The conversion of a path no attribute applies to */
  unspecified?: ConvAttrs;
  outer: {
    system?: Promise<AttributesContent>;
    global?: Promise<AttributesContent>;
    info?: Promise<AttributesContent>;
  };
  /** The attribute source's tree, resolved once (undefined: none applies) */
  source?: Promise<AttributesSourceTree | undefined>;
}

/**
 * git's conversion of file content between the worktree and the repository.
 *
 * Attributes are read as git reads them: a clean (and a smudge outside unpack-trees, such as
 * `checkout -- <path>`) from the worktree's `.gitattributes` (the index's when the worktree
 * has none); a checkout of a tree (`checkout <branch>`, `reset --hard`, `clone`, a merge)
 * from the index it leaves behind (the worktree's when that index holds none), which the
 * operation passes as the smudge's {@link ContentAttributesContext}.
 *
 * Within a {@link batch} the configuration and the attributes files are read once; outside
 * one, every call reads them again (files whose stat is unchanged are not re-read).
 *
 * @example
 * ```typescript
 * const filter = new GitContentFilter({ worktree, staging, blobs: history.blobs, config });
 * worktree.setContentFilter?.(filter);
 * const cleaned = await filter.convertToGit("a.txt", bytes);
 * ```
 */
export class GitContentFilter implements WorktreeContentFilter {
  private readonly resolver: AttributesResolver;
  /** Worktree attributes files read, by path: content kept while their stat is unchanged */
  private readonly worktreeFiles = new Map<string, { key: string; content: Uint8Array }>();
  /** Index blobs read (attributes files), by id */
  private readonly indexBlobs = new Map<string, Uint8Array>();
  /** Numbers naming the attribute indexes passed in, for the memo of each */
  private readonly indexIds = new WeakMap<AttributesIndex, number>();
  private nextIndexId = 1;
  private settingsCache?: ConversionSettings;
  /** The operation in progress ({@link batch}) */
  private scope?: Scope;
  private sourceResolver?: AttributesSourceResolver;

  constructor(private readonly options: GitContentFilterOptions) {
    this.resolver = new AttributesResolver(
      { inTree: async () => undefined },
      {
        ignoreCase: () =>
          (this.scope?.settings ?? this.settingsCache ?? this.settings()).ignoreCase,
        ...(options.onWarning ? { onWarning: options.onWarning } : {}),
      },
    );
  }

  /**
   * Sets how the tree-ish of an attribute source is resolved (the commands set git's revision
   * syntax over the repository); it applies from the next operation on.
   */
  setAttributesSourceResolver(resolve: AttributesSourceResolver | undefined): void {
    this.sourceResolver = resolve;
  }

  /**
   * The tree the in-tree attributes files are read from (`$GIT_ATTR_SOURCE`, else
   * `attr.tree`), resolved once per scope; undefined when none applies.
   *
   * @throws AttributesSourceError when `$GIT_ATTR_SOURCE` names nothing
   */
  private attributesSource(scope: Scope): Promise<AttributesSourceTree | undefined> {
    scope.source ??= (async () => {
      const setting = attributesSourceSetting(
        this.environment?.attrSource,
        configValue(this.options.config, "attr.tree"),
      );
      if (!setting) return undefined;
      return resolveAttributesSource(
        setting,
        this.sourceResolver ?? this.options.resolveAttributesSource,
      );
    })();
    return scope.source;
  }

  /** The attributes file `path` of the attribute source's tree. */
  private async sourceAttributes(
    source: AttributesSourceTree,
    path: string,
  ): Promise<AttributesContent> {
    const { trees, blobs } = this.options;
    if (!trees || !blobs) return undefined;
    const found = await readTreeAttributesFile(trees, blobs, source.tree, path);
    return found ? { key: `blob:${found.id}`, content: found.content } : undefined;
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

  /** A fresh scope: the configuration re-read (conditional includes re-evaluated). */
  private async openScope(): Promise<Scope> {
    const refresh = (this.options.config as { refresh?: () => Promise<unknown> } | undefined)
      ?.refresh;
    if (typeof refresh === "function") await refresh.call(this.options.config);
    return { settings: this.settings(), memos: new Map(), outer: {} };
  }

  async batch<T>(fn: () => Promise<T>): Promise<T> {
    if (this.scope) return fn();
    this.scope = await this.openScope();
    try {
      return await fn();
    } finally {
      this.scope = undefined;
    }
  }

  /** The operation's scope, or a scope of its own for a call outside one. */
  private async currentScope(): Promise<Scope> {
    return this.scope ?? (await this.openScope());
  }

  noteChanged(path: string): void {
    if (!isAttributesFile(path)) return;
    this.worktreeFiles.delete(path);
    const dir = dirOfAttributesFile(path);
    if (this.scope) for (const { memo } of this.scope.memos.values()) memo.dropDirectory(dir);
  }

  /** The files outside the tree, read once per scope. */
  private outerSources(scope: Scope): Omit<AttributesSources, "inTree"> {
    const env = this.environment;
    return {
      system: () => {
        scope.outer.system ??= (async () => {
          const path = env?.systemAttributes;
          return path ? env?.readFile(path).catch(() => undefined) : undefined;
        })();
        return scope.outer.system;
      },
      global: () => {
        scope.outer.global ??= (async () => {
          const configured = scope.settings.attributesFile;
          const path = configured
            ? expandUserPath(configured, env)
            : xdgConfigPath(env, "attributes");
          if (!path || !env) return undefined;
          return env.readFile(path).catch(() => undefined);
        })();
        return scope.outer.global;
      },
      info: () => {
        scope.outer.info ??= (async () => {
          if (this.options.readInfoAttributes) return this.options.readInfoAttributes();
          return this.options.worktree.readGitDirFile?.("info/attributes");
        })();
        return scope.outer.info;
      },
    };
  }

  /** The attribute sources (and their memo in `scope`) for a direction and an index. */
  private sourcesFor(
    scope: Scope,
    context: ContentAttributesContext,
  ): { sources: AttributesSources; memo: AttributesMemo } {
    const index = context.index;
    let indexId = 0;
    if (index) {
      indexId = this.indexIds.get(index) ?? 0;
      if (!indexId) {
        indexId = this.nextIndexId++;
        this.indexIds.set(index, indexId);
      }
    }
    const memoKey = `${context.direction}:${indexId}`;
    const known = scope.memos.get(memoKey);
    if (known) return known;
    const fromIndex = (path: string) => this.indexAttributes(path, index);
    const fromWorktree = (path: string) => this.worktreeAttributes(path);
    const sources: AttributesSources = {
      ...this.outerSources(scope),
      inTree: async (dir) => {
        const path = dir ? `${dir}/.gitattributes` : ".gitattributes";
        // an attribute source replaces the worktree's and the index's files, either way
        const source = await this.attributesSource(scope);
        if (source) return this.sourceAttributes(source, path);
        if (context.direction === "checkout") {
          return (await fromIndex(path)) ?? (await fromWorktree(path));
        }
        return (await fromWorktree(path)) ?? (await fromIndex(path));
      },
    };
    const found = { sources, memo: new AttributesMemo() };
    scope.memos.set(memoKey, found);
    return found;
  }

  /** The worktree's file at `path` (never through a symbolic link). */
  private async worktreeAttributes(path: string): Promise<AttributesContent> {
    const { worktree } = this.options;
    const entry = await worktree.getEntry(path).catch(() => undefined);
    if (!entry || entry.isDirectory || (entry.mode & S_IFMT) === S_IFLNK) {
      this.worktreeFiles.delete(path);
      return undefined;
    }
    const key = statKey(entry);
    const cached = this.worktreeFiles.get(path);
    if (cached && cached.key === key) return { key: `${path}@${key}`, content: cached.content };
    let content: Uint8Array;
    try {
      content = await collectChunks(worktree.readContent(path));
    } catch {
      return undefined;
    }
    // kept only once settled: a change within the same tick could keep the same stat
    if (entry.mtime && Date.now() - entry.mtime > SETTLED_MS && entry.mtimeNs !== undefined) {
      this.worktreeFiles.set(path, { key, content });
      return { key: `${path}@${key}`, content };
    }
    this.worktreeFiles.delete(path);
    return content;
  }

  /** The attributes file `path` of `index` (default: the current index). */
  private async indexAttributes(path: string, index?: AttributesIndex): Promise<AttributesContent> {
    const id = index ? await index.attributesBlob(path) : await this.indexEntryId(path);
    if (!id) return undefined;
    let content = this.indexBlobs.get(id);
    if (!content) {
      content = await this.loadBlob(id);
      if (!content) return undefined;
      if (this.indexBlobs.size > 64) this.indexBlobs.clear();
      this.indexBlobs.set(id, content);
    }
    return { key: `blob:${id}`, content };
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

  /** git's `has_crlf_in_index`. */
  private async hasCrlfInIndex(path: string): Promise<boolean> {
    const id = await this.indexEntryId(path);
    if (!id) return false;
    return hasCrlf(await this.loadBlob(id));
  }

  private async attributesIn(
    scope: Scope,
    path: string,
    names: readonly string[] | undefined,
    context: ContentAttributesContext,
  ): Promise<Map<string, AttributeValue>> {
    const { sources, memo } = this.sourcesFor(scope, context);
    return this.resolver.get(path, names, { sources, memo, isDirectory: context.isDirectory });
  }

  /**
   * The attributes of `path` as the conversion reads them (`git check-attr`): all that are
   * set, or only `names`. `direction` (or a whole context) says which files come first.
   */
  async attributes(
    path: string,
    names?: readonly string[],
    direction: AttributesDirection | ContentAttributesContext = "checkin",
  ): Promise<Map<string, AttributeValue>> {
    const context = typeof direction === "string" ? { direction } : direction;
    return this.attributesIn(await this.currentScope(), path, names, context);
  }

  private async convAttrsIn(
    scope: Scope,
    path: string,
    context: ContentAttributesContext,
  ): Promise<ConvAttrs> {
    // the directory's files already read (every path but the first of a directory)
    const ready = this.resolver.peek(path, CONVERT_ATTRS, this.sourcesFor(scope, context).memo);
    return this.convAttrsOfScope(
      scope,
      ready ?? (await this.attributesIn(scope, path, CONVERT_ATTRS, context)),
    );
  }

  private convAttrsOfScope(scope: Scope, attrs: Map<string, AttributeValue>): ConvAttrs {
    // nothing applies (the common case): one conversion for every such path of the scope
    for (const value of attrs.values()) {
      if (value !== undefined) return convAttrsOf(attrs, scope.settings, this.options.drivers);
    }
    scope.unspecified ??= convAttrsOf(attrs, scope.settings, this.options.drivers);
    return scope.unspecified;
  }

  /** git's `convert_attrs` for `path`. */
  async convAttrs(
    path: string,
    direction: AttributesDirection | ContentAttributesContext = "checkin",
  ): Promise<ConvAttrs> {
    const context = typeof direction === "string" ? { direction } : direction;
    return this.convAttrsIn(await this.currentScope(), path, context);
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
    options: ContentConversionOptions & {
      keepCrlf?: boolean;
      attrs?: ConvAttrs;
      settings?: ConversionSettings;
    } = {},
  ): Promise<Uint8Array> {
    const scope = options.attrs && options.settings ? undefined : await this.currentScope();
    const settings = options.settings ?? scope?.settings ?? this.settings();
    const ca =
      options.attrs ??
      (await this.convAttrsIn(scope ?? (await this.currentScope()), path, {
        direction: "checkin",
      }));
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
    options: {
      normalizing?: boolean;
      attrs?: ConvAttrs;
      settings?: ConversionSettings;
      context?: ContentAttributesContext;
      onWarning?: (m: string) => void;
    } = {},
  ): Promise<Uint8Array> {
    const scope = options.attrs && options.settings ? undefined : await this.currentScope();
    const settings = options.settings ?? scope?.settings ?? this.settings();
    const ca =
      options.attrs ??
      (await this.convAttrsIn(
        scope ?? (await this.currentScope()),
        path,
        options.context ?? { direction: "checkin" },
      ));
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
  async renormalize(
    path: string,
    src: Uint8Array,
    context: ContentAttributesContext = { direction: "checkin" },
  ): Promise<Uint8Array> {
    const scope = this.scope ?? (await this.openScope());
    const ca = await this.convAttrsIn(scope, path, context);
    const { settings } = scope;
    const smudged = await this.convertToWorktree(path, src, {
      normalizing: true,
      attrs: ca,
      settings,
    });
    return this.convertToGit(path, smudged, { renormalize: true, attrs: ca, settings });
  }

  async checkin(path: string): Promise<ContentConversion | undefined> {
    const scope = this.scope ?? (await this.openScope());
    const ca = await this.convAttrsIn(scope, path, { direction: "checkin" });
    const { settings } = scope;
    if (!converts(ca, "checkin", settings)) return undefined;
    return {
      apply: (content, options) =>
        this.convertToGit(path, content, { ...options, attrs: ca, settings }),
    };
  }

  async checkout(
    path: string,
    context: ContentAttributesContext = { direction: "checkin" },
  ): Promise<ContentConversion | undefined> {
    const scope = this.scope ?? (await this.openScope());
    const ca = await this.convAttrsIn(scope, path, context);
    const { settings } = scope;
    if (!converts(ca, "checkout", settings)) return undefined;
    return {
      apply: (content, options) =>
        this.convertToWorktree(path, content, {
          attrs: ca,
          settings,
          ...(options?.onWarning ? { onWarning: options.onWarning } : {}),
        }),
    };
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
