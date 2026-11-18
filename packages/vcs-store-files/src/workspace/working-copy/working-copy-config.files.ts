/**
 * File-based WorkingCopyConfig implementation.
 *
 * Design:
 * - Per-worktree config in .git/worktrees/NAME/config (for additional worktrees)
 * - Main worktree uses .git/config section worktree.*
 * - Allows working-copy-specific settings
 */

import {
  decodeGitPath,
  decodeGitPatternFile,
  encodeGitPath,
  parseGitBool,
} from "@statewalker/vcs-utils/encoding";
import {
  expandUserPath,
  type GitHostEnvironment,
  type WorkingCopyConfig,
  wildmatch,
  xdgConfigPath,
} from "@statewalker/vcs-working-tree";

/**
 * Thrown where git refuses a config file (`fatal: bad config line <n> in file <file>`): an
 * unknown escape (`\x`), a quote still open at the end of a line, a header or variable
 * name git does not accept. The line follows git's count: a value continued with a
 * backslash ends on the last of its lines.
 *
 * @example
 * ```typescript
 * try {
 *   await config.load();
 * } catch (error) {
 *   if (error instanceof ConfigParseError) console.error(`fatal: ${error.message}`);
 * }
 * ```
 */
export class ConfigParseError extends Error {
  constructor(
    /** The file as git names it (`.git/config`, or a host path) */
    readonly file: string,
    /** The line git names, from 1 */
    readonly line: number,
  ) {
    super(`bad config line ${line} in file ${file}`);
    this.name = "ConfigParseError";
  }
}

/**
 * Files API subset needed for config operations
 */
export interface ConfigFilesApi {
  read(path: string): Promise<Uint8Array | undefined>;
  write(path: string, content: Uint8Array): Promise<void>;
}

/**
 * A line of the config file: one physical line, or the physical lines of a variable whose
 * value runs on with backslashes at their ends (its `text` then holds them joined by `\n`).
 *
 * The parsed line list is what makes `save()` non-destructive: lines that were
 * not touched are written back verbatim, so comments, blank lines, key order
 * and hand-written formatting survive a round-trip.
 */
type ConfigLine =
  | { kind: "text"; text: string }
  | {
      kind: "section";
      text: string;
      section: string;
      /** Canonical key of a variable written on the same line as the header. */
      inlineKey?: string;
      inlineValue?: unknown;
      /** Its value as written (see {@link writtenValueOfLine}) */
      inlineWritten?: string;
    }
  | {
      kind: "entry";
      text: string;
      section: string;
      key: string;
      value: unknown;
      /** The value as written: unquoted and unescaped, not converted; none without `=` */
      written?: string;
    };

/**
 * Git-compatible working copy configuration.
 *
 * Reads and writes the git config file format (`.git/config`), so a config
 * written here is readable by native `git` and a config written by native
 * `git` is readable here.
 *
 * ## Keys
 *
 * A key is `section.name` or `section.subsection.name`. Following git, the
 * *section* and *name* parts are case-insensitive (normalised to lower case)
 * while the *subsection* keeps its case: `remote.Origin.url` and
 * `remote.origin.url` are two different keys. A subsection may contain dots
 * and spaces; when a key has more than three parts, the first part is the
 * section, the last is the name and everything between is the subsection.
 *
 * {@link set}, {@link add}, {@link unset} reject a key without a section,
 * because git config has no way to represent a variable outside a section;
 * {@link get} simply returns `undefined` for one.
 *
 * ## Multiple values
 *
 * git config keys may repeat (`fetch` in a `[remote]` section is the common
 * case). All values are kept: {@link getAll} returns them in file order,
 * {@link get} returns the last one (git's `--get` semantics), {@link add}
 * appends one and {@link set} replaces all of them.
 *
 * ## Value types
 *
 * git config values are untyped text; this class applies two conveniences on
 * read:
 * - git's boolean spellings (`true`/`false`, `yes`/`no`, `on`/`off`) become
 *   booleans;
 * - a value that is a *canonical* JS number becomes a number — canonical
 *   meaning `String(Number(text)) === text`, so `0` and `512` are numbers
 *   while `007`, `0x10`, `1e3`, `1.50`, `+5`, `Infinity` and `NaN` stay
 *   strings. The restriction keeps the conversion lossless: every value this
 *   class returns as a number serialises back to the identical text.
 *
 * A quoted value is unquoted and unescaped, and an unquoted `#` or `;` starts
 * a comment, as in git. On write, values are escaped and quoted using git's
 * own rules (quote when empty, when there is leading/trailing whitespace, or
 * when the value contains `#` or `;`).
 *
 * ## The configuration chain
 *
 * Reads see git's whole chain, lowest precedence first: the system file and the global
 * files (`$XDG_CONFIG_HOME/git/config`, then `~/.gitconfig`) when the host passes an
 * {@link GitConfigOptions.environment}, this file, then `config.worktree` when
 * `extensions.worktreeConfig` is set. `include.path` and `includeIf.<condition>.path`
 * (`gitdir:`, `gitdir/i:`, `onbranch:`) are followed in every file, their values read where
 * the directive stands, as git does. Writes go to this file only; included files are never
 * written, and a directive round-trips as just another line.
 *
 * ## Known limitations
 *
 * - `includeIf.hasconfig:remote.*.url:` is not evaluated (never true).
 * - A malformed section header (e.g. an unterminated quote) is kept verbatim
 *   but ignored, so the following variables are attributed to the previous
 *   section. `git` rejects the whole file instead. Reading such a file is
 *   therefore lenient where git is strict.
 * - `save()` writes the whole file, so it must not race another writer; there
 *   is no lock file (git uses `config.lock`). Callers that only mutate through
 *   this class are safe.
 */
export class GitWorkingCopyConfig implements WorkingCopyConfig {
  [key: string]: unknown;

  /** Canonical key -> values, in file order. An empty array means "unset". */
  private values: Map<string, unknown[]> = new Map();
  /** The file as parsed by the last load/save; empty when never loaded. */
  private lines: ConfigLine[] = [];
  /** Keys whose values differ from the parsed file. */
  private readonly dirtyKeys: Set<string> = new Set();
  /** Sections removed by {@link unsetSection}. */
  private readonly removedSections: Set<string> = new Set();
  /** Keys mirrored as own properties (for the WorkingCopyConfig index signature). */
  private readonly mirroredKeys: Set<string> = new Set();
  private trailingNewline = true;
  private loaded = false;
  /** whether the file began with a UTF-8 BOM: git keeps it when it rewrites the file */
  private bom = false;
  /** Entries of the system and global files (with their includes), lowest first */
  private baseEntries: ConfigEntry[] = [];
  /** Entries of `config.worktree`, when `extensions.worktreeConfig` is set */
  private overlayEntries: ConfigEntry[] = [];
  /** Entries an include directive of this file brings in, by the directive's line */
  private includedEntries = new Map<ConfigLine, ConfigEntry[]>();
  /** Every value of the chain in order, computed when first read after a change */
  private resolvedCache?: ConfigEntry[];

  /** The user's environment the chain reads global files from (absent: none are read) */
  readonly environment?: GitHostEnvironment;

  constructor(
    private readonly files: ConfigFilesApi,
    private readonly configPath: string,
    private readonly options: GitConfigOptions = {},
  ) {
    if (options.environment) this.environment = options.environment;
  }

  /** The git directory as the host names it ({@link GitConfigOptions.gitDirPath}), when given */
  get hostGitDir(): string | undefined {
    return this.options.gitDirPath;
  }

  /**
   * Load configuration from file, replacing any previously loaded state.
   *
   * A missing file loads as an empty configuration.
   */
  async load(): Promise<void> {
    const content = await this.files.read(this.configPath);
    // bytes, as git reads them: a value that is no UTF-8 (a latin-1 path) keeps its bytes
    // through a rewrite of the file; a leading BOM is skipped, as git skips it
    this.bom =
      !!content &&
      content.length >= 3 &&
      content[0] === 0xef &&
      content[1] === 0xbb &&
      content[2] === 0xbf;
    const text = content ? decodeGitPatternFile(content) : "";
    this.adoptText(text);
    this.loaded = true;
    await this.loadChain();
  }

  /** Reads the files around this one: system, global, includes and `config.worktree`. */
  private async loadChain(): Promise<void> {
    const env = this.options.environment;
    const followIncludes = this.options.includes !== false;
    const reader = new ChainReader(this, env, this.options, followIncludes);
    const base: ConfigEntry[] = [];
    if (env) {
      const hostSource = (path: string): ConfigSource => ({ read: env.readFile, path, host: true });
      if (env.systemConfig) await reader.readFile(hostSource(env.systemConfig), base, 0);
      if (env.globalConfig) {
        // $GIT_CONFIG_GLOBAL replaces both global files
        await reader.readFile(hostSource(env.globalConfig), base, 0);
      } else {
        const xdg = xdgConfigPath(env, "config");
        if (xdg) await reader.readFile(hostSource(xdg), base, 0);
        const userConfig = expandUserPath("~/.gitconfig", env);
        if (userConfig) await reader.readFile(hostSource(userConfig), base, 0);
      }
    }
    this.baseEntries = base;
    await this.resolveOwnIncludes(reader);
    this.overlayEntries = [];
    this.resolvedCache = undefined;
    if (isTrue(this.get("extensions.worktreeconfig"))) {
      const overlay: ConfigEntry[] = [];
      const path = this.options.worktreeConfigPath ?? `${dirOf(this.configPath)}config.worktree`;
      await reader.readFile({ read: (p) => this.files.read(p), path }, overlay, 0);
      this.overlayEntries = overlay;
    }
    this.resolvedCache = undefined;
    await this.noteHead(reader);
  }

  /** What HEAD named when an `onbranch:` condition was last evaluated, if one was. */
  private headSeen?: { ref: string | undefined };

  private async noteHead(reader: ChainReader): Promise<void> {
    this.headSeen = reader.branchUsed ? { ref: await reader.headRef() } : undefined;
  }

  /**
   * Re-evaluates the conditional includes that depend on the current branch
   * (`includeIf.onbranch:`) when HEAD names another branch than when they were read (git
   * evaluates them on every read of the configuration). Without such a condition nothing is
   * read.
   *
   * @returns whether the chain was read again
   */
  async refresh(): Promise<boolean> {
    if (!this.headSeen || !this.loaded) return false;
    const probe = new ChainReader(this, this.options.environment, this.options, false);
    if ((await probe.headRef()) === this.headSeen.ref) return false;
    await this.loadChain();
    return true;
  }

  /** The entries the include directives of this file bring in. */
  private async resolveOwnIncludes(reader?: ChainReader): Promise<void> {
    this.includedEntries = new Map();
    this.resolvedCache = undefined;
    if (this.options.includes === false) return;
    const r = reader ?? new ChainReader(this, this.options.environment, this.options, true);
    const source: ConfigSource = { read: (p) => this.files.read(p), path: this.configPath };
    for (const line of this.lines) {
      const key = keyOfLine(line);
      if (key === undefined || !isIncludeKey(key)) continue;
      const value =
        line.kind === "entry" ? line.value : line.kind === "section" ? line.inlineValue : undefined;
      const entries: ConfigEntry[] = [];
      await r.include(key, value, source, entries, 1);
      if (entries.length > 0) this.includedEntries.set(line, entries);
    }
    if (!reader && r.branchUsed) this.headSeen = { ref: await r.headRef() };
  }

  /**
   * Every value of the chain in order (system, global, this file with its includes where
   * they stand, `config.worktree`); a later value of a key wins.
   */
  private resolved(): ConfigEntry[] {
    if (this.resolvedCache) return this.resolvedCache;
    const out: ConfigEntry[] = [...this.baseEntries];
    const emitted = new Set<string>();
    // the physical line a variable ends on: what git names as its line
    let lineEnd = 0;
    for (const line of this.lines) {
      lineEnd += physicalLines(line);
      const section = sectionOfLine(line);
      if (section !== undefined && this.removedSections.has(section)) continue;
      const key = keyOfLine(line);
      if (key !== undefined) {
        if (this.dirtyKeys.has(key) || !this.values.has(key)) {
          if (!emitted.has(key)) {
            emitted.add(key);
            for (const value of this.values.get(key) ?? []) out.push({ key, value });
          }
        } else {
          out.push({
            key,
            value:
              line.kind === "entry" ? line.value : (line as { inlineValue?: unknown }).inlineValue,
            origin: {
              file: originName(this.configPath),
              line: lineEnd,
              text: writtenValueOfLine(line),
            },
          });
        }
      }
      const included = this.includedEntries.get(line);
      if (included) out.push(...included);
    }
    for (const [key, values] of this.values) {
      if (emitted.has(key)) continue;
      if (!this.dirtyKeys.has(key) && this.lines.some((l) => keyOfLine(l) === key)) continue;
      for (const value of values) out.push({ key, value });
    }
    out.push(...this.overlayEntries);
    this.resolvedCache = out;
    return out;
  }

  /**
   * Save configuration to file.
   *
   * Lines that were not modified are written back verbatim, so comments and
   * layout survive. If the file was never loaded, it is loaded first and the
   * pending changes are replayed on top of it, so an unloaded instance never
   * silently truncates an existing config.
   */
  async save(): Promise<void> {
    if (!this.loaded) await this.mergeIntoExistingFile();

    const content = this.serializeGitConfig();
    const body = encodeGitPath(content);
    await this.files.write(this.configPath, this.bom ? withBom(body) : body);

    // Re-adopt the line structure we just wrote (keeping the in-memory values,
    // which are authoritative) so a following save() is stable.
    const parsed = parseConfigText(content);
    this.lines = parsed.lines;
    this.trailingNewline = parsed.trailingNewline;
    this.dirtyKeys.clear();
    this.removedSections.clear();
    this.loaded = true;
    await this.resolveOwnIncludes();
  }

  /**
   * Get a configuration value; the last one when the key has several.
   */
  get(key: string): unknown {
    const canonical = canonicalizeKey(key);
    if (!canonical) return undefined;
    const all = this.resolved();
    for (let i = all.length - 1; i >= 0; i--) if (all[i].key === canonical) return all[i].value;
    return undefined;
  }

  /**
   * Get every value of a (possibly repeated) key, in file order.
   */
  getAll(key: string): unknown[] {
    const canonical = canonicalizeKey(key);
    if (!canonical) return [];
    return this.resolved()
      .filter((e) => e.key === canonical)
      .map((e) => e.value);
  }

  /**
   * Every value of a key in the chain's order, as {@link getAll}, each with the file and line
   * it was read from and its text as written: for git's
   * `fatal: bad config variable '<key>' in file '<file>' at line <n>`.
   */
  getAllWithOrigin(key: string): ConfigValueOrigin[] {
    const canonical = canonicalizeKey(key);
    if (!canonical) return [];
    return this.resolved()
      .filter((e) => e.key === canonical)
      .map((e) =>
        e.origin
          ? { value: e.value, text: e.origin.text, file: e.origin.file, line: e.origin.line }
          : { value: e.value, text: e.value === true ? undefined : String(e.value) },
      );
  }

  /**
   * Every value of the chain in its order with its key, as `git config --list --show-origin`
   * lists them: the text as written (undefined for a variable without `=`), the file and
   * the line it was read from (the last line of a value continued with backslashes).
   *
   * @example
   * ```typescript
   * for (const { key, text, file } of config.listWithOrigin()) {
   *   console.log(`file:${file}\t${text === undefined ? key : `${key}=${text}`}`);
   * }
   * ```
   */
  listWithOrigin(): (ConfigValueOrigin & { key: string })[] {
    return this.resolved().map((e) =>
      e.origin
        ? {
            key: e.key,
            value: e.value,
            text: e.origin.text,
            file: e.origin.file,
            line: e.origin.line,
          }
        : { key: e.key, value: e.value, text: e.value === true ? undefined : String(e.value) },
    );
  }

  /**
   * The value set last, in the chain's order, among `keys` (git reads `core.commentChar`
   * and `core.commentString` as one setting: the last line of either wins), with the key
   * it was set under.
   */
  getLastOf(keys: string[]): { key: string; value: unknown } | undefined {
    const wanted = new Set(keys.map((k) => canonicalizeKey(k)).filter((k) => k !== undefined));
    const all = this.resolved();
    for (let i = all.length - 1; i >= 0; i--) {
      if (wanted.has(all[i].key)) return { key: all[i].key, value: all[i].value };
    }
    return undefined;
  }

  /**
   * Every value of a key in this file only (not the global files, includes or
   * `config.worktree`), in file order: what a rewrite of the key here starts from.
   */
  getLocal(key: string): unknown[] {
    const canonical = canonicalizeKey(key);
    if (!canonical) return [];
    return [...(this.values.get(canonical) ?? [])];
  }

  /**
   * Every key that has a value and starts with `prefix`, canonical (section and name in
   * lower case), in no particular order; `listKeys("extensions.")` gives the
   * repository's extensions.
   */
  listKeys(prefix = ""): string[] {
    const keys = new Set<string>();
    for (const { key } of this.resolved()) if (key.startsWith(prefix)) keys.add(key);
    return [...keys];
  }

  /**
   * Set a configuration value, replacing all existing values of the key.
   *
   * @throws TypeError if the key has no section part
   */
  set(key: string, value: unknown): void {
    const canonical = requireCanonicalKey(key);
    this.values.set(canonical, [value]);
    this.dirtyKeys.add(canonical);
    this.mirror(canonical);
    this.resolvedCache = undefined;
  }

  /**
   * Append a value to a key, keeping the values already set (git's
   * `config --add`).
   *
   * @throws TypeError if the key has no section part
   */
  add(key: string, value: unknown): void {
    const canonical = requireCanonicalKey(key);
    const values = this.values.get(canonical);
    if (values) values.push(value);
    else this.values.set(canonical, [value]);
    this.dirtyKeys.add(canonical);
    this.mirror(canonical);
    this.resolvedCache = undefined;
  }

  /**
   * Remove all values of a key.
   *
   * @throws TypeError if the key has no section part
   */
  unset(key: string): void {
    const canonical = requireCanonicalKey(key);
    this.values.set(canonical, []);
    this.dirtyKeys.add(canonical);
    this.mirror(canonical);
    this.resolvedCache = undefined;
  }

  /**
   * Remove a whole section, including its header line.
   *
   * @param section `section` or `section.subsection`, e.g. `remote.origin`
   */
  unsetSection(section: string): void {
    const canonical = canonicalizeSection(section);
    if (this.editsLinesOf([canonical])) {
      // git's remove_section: from each header naming the section to the next header,
      // every line goes (comments and blank lines too)
      let removing = false;
      this.lines = this.lines.filter((line) => {
        if (line.kind === "section") removing = headerNames(line.text, canonical) > 0;
        return !removing;
      });
      this.reparseSections([canonical]);
      return;
    }
    this.removedSections.add(canonical);
    this.resolvedCache = undefined;
    for (const key of [...this.values.keys()]) {
      if (sectionOfKey(key) === canonical) {
        this.values.delete(key);
        this.dirtyKeys.add(key);
        this.unmirror(key);
      }
    }
  }

  /**
   * Rename a section in place, as git's `git_config_rename_section` (`git remote rename`):
   * every `[remote "old"]` header becomes `[remote "new"]` where it stands, its variables
   * and comments kept as they are.
   *
   * @param oldSection `section.subsection`, e.g. `remote.origin`
   * @param newSection the new name, e.g. `remote.upstream`
   *
   * @example
   * ```typescript
   * config.renameSection("remote.origin", "remote.upstream");
   * await config.save();
   * ```
   */
  renameSection(oldSection: string, newSection: string): void {
    const from = canonicalizeSection(oldSection);
    const to = canonicalizeSection(newSection);
    if (from === to) return;
    this.resolvedCache = undefined;
    const renamed = (key: string) => `${to}${key.slice(from.length)}`;
    if (this.editsLinesOf([from, to])) {
      // git's rename_section: each header naming the section (as written, case and all)
      // is rewritten where it stands; a section already named `new` stays as it is, its
      // values and the renamed ones read in file order. A variable on the header line moves
      // to a line of its own.
      let inside = false;
      this.lines = this.lines.flatMap((line): ConfigLine[] => {
        if (line.kind === "section") {
          const offset = headerNames(line.text, from);
          inside = offset > 0;
          if (!inside) return [line];
          const header: ConfigLine = {
            kind: "section",
            section: to,
            text: formatSectionHeader(to),
          };
          if (line.inlineKey === undefined) return [header];
          const rest = line.text.slice(offset);
          const key = renamed(line.inlineKey);
          return [
            header,
            {
              kind: "entry",
              section: to,
              key,
              value: line.inlineValue,
              written: line.inlineWritten,
              text: `\t${rest}`,
            },
          ];
        }
        if (inside && line.kind === "entry") {
          const moved: ConfigLine = { ...line, section: to, key: renamed(line.key) };
          this.moveIncluded(line, moved);
          return [moved];
        }
        return [line];
      });
      this.reparseSections([from, to]);
      return;
    }
    if (this.removedSections.delete(to)) {
      // the lines of a removed section of the new name go now, before ours take its name
      this.lines = this.lines.filter((line) => sectionOfLine(line) !== to);
    }
    for (const key of [...this.values.keys()]) {
      if (sectionOfKey(key) !== from) continue;
      const values = this.values.get(key) ?? [];
      this.values.delete(key);
      this.unmirror(key);
      const newKey = renamed(key);
      const existing = this.values.get(newKey) ?? [];
      this.values.set(newKey, [...existing, ...values]);
      this.mirror(newKey);
      if (this.dirtyKeys.delete(key) || existing.length > 0) this.dirtyKeys.add(newKey);
    }
    if (this.removedSections.delete(from)) this.removedSections.add(to);
    this.lines = this.lines.map((line): ConfigLine => {
      if (line.kind === "entry" && line.section === from) {
        return { ...line, section: to, key: renamed(line.key) };
      }
      if (line.kind === "section" && line.section === from) {
        if (line.inlineKey === undefined) {
          return { kind: "section", section: to, text: formatSectionHeader(to) };
        }
        // a variable on the header line is re-emitted after the new header
        const inlineKey = renamed(line.inlineKey);
        this.dirtyKeys.add(inlineKey);
        return { ...line, section: to, inlineKey, text: formatSectionHeader(to) };
      }
      return line;
    });
  }

  /**
   * Copy a section, as git's `git_config_copy_section` (`git branch -c`): after every
   * `[branch "old"]` section a `[branch "new"]` one holding a copy of its lines (variables,
   * comments and blank lines as they are), the old one kept. A section already named
   * `new` is kept too, so its variables and the copied ones add up.
   *
   * @param oldSection `section.subsection`, e.g. `branch.feat`
   * @param newSection the copy's name, e.g. `branch.feat2`
   *
   * @example
   * ```typescript
   * config.copySection("branch.feat", "branch.feat2");
   * await config.save();
   * ```
   */
  copySection(oldSection: string, newSection: string): void {
    const from = canonicalizeSection(oldSection);
    const to = canonicalizeSection(newSection);
    if (from === to || this.removedSections.has(from)) return;
    this.resolvedCache = undefined;
    const renamed = (key: string) => `${to}${key.slice(from.length)}`;
    if (this.editsLinesOf([from, to])) {
      // git's copy_section: after each section whose header names `old` (as written), a
      // `[branch "new"]` header and a copy of the lines after the old header; a variable
      // written on the old header line is not copied
      const out: ConfigLine[] = [];
      let copy: ConfigLine[] | undefined;
      for (const line of this.lines) {
        if (line.kind === "section") {
          if (copy) out.push(...copy);
          copy = undefined;
          out.push(line);
          if (headerNames(line.text, from) > 0) {
            copy = [{ kind: "section", section: to, text: formatSectionHeader(to) }];
          }
          continue;
        }
        out.push(line);
        if (!copy) continue;
        copy.push(line.kind === "entry" ? { ...line, section: to, key: renamed(line.key) } : line);
      }
      if (copy) out.push(...copy);
      this.lines = out;
      this.reparseSections([to]);
      return;
    }
    const copied = new Map<string, unknown[]>();
    const copyOf = (key: string, value: unknown) => {
      const values = copied.get(key);
      if (values) values.push(value);
      else copied.set(key, [value]);
    };
    const out: ConfigLine[] = [];
    let copy: ConfigLine[] | undefined;
    for (const line of this.lines) {
      if (line.kind === "section" && copy) {
        out.push(...copy);
        copy = undefined;
      }
      out.push(line);
      if (line.kind === "section" && line.section === from) {
        copy = [{ kind: "section", section: to, text: formatSectionHeader(to) }];
        if (line.inlineKey !== undefined) {
          const key = renamed(line.inlineKey);
          copy.push({
            kind: "entry",
            section: to,
            key,
            value: line.inlineValue,
            written: line.inlineWritten,
            text: "",
          });
          copyOf(key, line.inlineValue);
          this.dirtyKeys.add(key);
        }
      } else if (copy && line.kind === "entry") {
        const key = renamed(line.key);
        copy.push({ ...line, section: to, key });
        copyOf(key, line.value);
        if (this.dirtyKeys.has(line.key)) this.dirtyKeys.add(key);
      } else if (copy) {
        copy.push(line);
      }
    }
    if (copy) out.push(...copy);
    this.lines = out;
    // the values: what the section had (also not saved yet), after what `new` had
    for (const key of [...this.values.keys()]) {
      if (sectionOfKey(key) !== from) continue;
      const newKey = renamed(key);
      const current = this.values.get(key) ?? [];
      const fromFile = copied.get(newKey);
      if (!fromFile || this.dirtyKeys.has(key)) this.dirtyKeys.add(newKey);
      this.values.set(newKey, [...(this.values.get(newKey) ?? []), ...current]);
      this.mirror(newKey);
    }
  }

  /**
   * Whether a section operation on `sections` can work on the file's lines alone, as git's
   * does on the file: the file is loaded and none of their values was changed or removed
   * since (those are only in the values, and are handled by key).
   */
  private editsLinesOf(sections: string[]): boolean {
    if (!this.loaded) return false;
    for (const section of sections) {
      if (this.removedSections.has(section)) return false;
      for (const key of this.dirtyKeys) if (sectionOfKey(key) === section) return false;
    }
    return true;
  }

  /** The values of the keys of `sections`, read again from the lines (in file order). */
  private reparseSections(sections: string[]): void {
    const affected = new Set(sections);
    this.resolvedCache = undefined;
    for (const key of [...this.values.keys()]) {
      if (!affected.has(sectionOfKey(key))) continue;
      this.values.delete(key);
      this.unmirror(key);
    }
    for (const line of this.lines) {
      const key = keyOfLine(line);
      if (key === undefined || !affected.has(sectionOfKey(key))) continue;
      this.appendParsed(
        key,
        line.kind === "entry" ? line.value : (line as { inlineValue?: unknown }).inlineValue,
      );
    }
  }

  /** An include directive's entries follow its line when the line is replaced. */
  private moveIncluded(from: ConfigLine, to: ConfigLine): void {
    const entries = this.includedEntries.get(from);
    if (!entries) return;
    this.includedEntries.delete(from);
    this.includedEntries.set(to, entries);
  }

  /**
   * List the subsection names present for a section, e.g. the remote names for
   * `subsections("remote")`.
   */
  subsections(section: string): string[] {
    const prefix = `${section.toLowerCase()}.`;
    const found = new Set<string>();
    for (const { key } of this.resolved()) {
      const sectionPart = sectionOfKey(key);
      if (sectionPart.startsWith(prefix)) found.add(sectionPart.slice(prefix.length));
    }
    return [...found];
  }

  /**
   * Replace the whole in-memory state with the given config text.
   */
  private adoptText(text: string): void {
    const parsed = parseConfigText(text);
    if (parsed.errorLine !== undefined) {
      throw new ConfigParseError(originName(this.configPath), parsed.errorLine);
    }
    this.lines = parsed.lines;
    this.trailingNewline = parsed.trailingNewline;
    this.dirtyKeys.clear();
    this.removedSections.clear();
    this.includedEntries = new Map();
    this.resolvedCache = undefined;

    for (const key of this.mirroredKeys) delete this[key];
    this.mirroredKeys.clear();
    this.values = new Map();

    for (const line of this.lines) {
      if (line.kind === "entry") {
        this.appendParsed(line.key, line.value);
      } else if (line.kind === "section" && line.inlineKey !== undefined) {
        this.appendParsed(line.inlineKey, line.inlineValue);
      }
    }
  }

  private appendParsed(key: string, value: unknown): void {
    const values = this.values.get(key);
    if (values) values.push(value);
    else this.values.set(key, [value]);
    this.mirror(key);
  }

  /**
   * Load the file on disk and replay the changes made before loading, so that
   * a save() on a never-loaded instance does not discard the existing config.
   */
  private async mergeIntoExistingFile(): Promise<void> {
    const pending = new Map(this.values);
    const removed = [...this.removedSections];

    await this.load();

    for (const section of removed) this.unsetSection(section);
    for (const [key, values] of pending) {
      this.values.set(key, values);
      this.dirtyKeys.add(key);
      this.mirror(key);
    }
  }

  /** Mirror a key as an own property (WorkingCopyConfig index signature). */
  private mirror(key: string): void {
    const values = this.values.get(key);
    if (!values || values.length === 0) {
      this.unmirror(key);
      return;
    }
    this[key] = values[values.length - 1];
    this.mirroredKeys.add(key);
  }

  private unmirror(key: string): void {
    if (this.mirroredKeys.delete(key)) delete this[key];
  }

  /**
   * Serialize config to Git format, preserving untouched lines verbatim.
   */
  private serializeGitConfig(): string {
    // Keys that already have a line in the file (ignoring removed sections).
    const fileKeys = new Set<string>();
    for (const line of this.lines) {
      const key = keyOfLine(line);
      if (key !== undefined && !this.removedSections.has(sectionOfLine(line) ?? "")) {
        fileKeys.add(key);
      }
    }

    // Keys that need a brand-new line, grouped by section (insertion order).
    const newKeysBySection = new Map<string, string[]>();
    for (const [key, values] of this.values) {
      if (values.length === 0 || fileKeys.has(key)) continue;
      const section = sectionOfKey(key);
      const keys = newKeysBySection.get(section);
      if (keys) keys.push(key);
      else newKeysBySection.set(section, [key]);
    }

    // Where to append new keys of an existing section: after its last
    // non-blank line, so they land inside the section and not after a blank
    // separator that visually belongs to the next one.
    const insertionPoint = new Map<string, number>();
    let walked = "";
    this.lines.forEach((line, index) => {
      if (line.kind === "section") walked = line.section;
      const blank = line.kind === "text" && line.text.trim() === "";
      if (walked && !blank) insertionPoint.set(walked, index);
    });

    const out: string[] = [];
    const emittedKeys = new Set<string>();
    const filledSections = new Set<string>();

    const emitValues = (key: string): void => {
      if (emittedKeys.has(key)) return;
      emittedKeys.add(key);
      for (const value of this.values.get(key) ?? []) out.push(formatEntry(key, value));
    };

    this.lines.forEach((line, index) => {
      const section = sectionOfLine(line);
      const dropped = section !== undefined && this.removedSections.has(section);

      if (!dropped) {
        if (line.kind === "entry") {
          if (this.dirtyKeys.has(line.key)) emitValues(line.key);
          else out.push(line.text);
        } else if (
          line.kind === "section" &&
          line.inlineKey !== undefined &&
          this.dirtyKeys.has(line.inlineKey)
        ) {
          // Rewrite the header without its inline variable, then re-emit it.
          out.push(formatSectionHeader(line.section));
          emitValues(line.inlineKey);
        } else {
          out.push(line.text);
        }
      }

      for (const [section2, at] of insertionPoint) {
        if (at !== index || this.removedSections.has(section2)) continue;
        const keys = newKeysBySection.get(section2);
        if (!keys) continue;
        for (const key of keys) emitValues(key);
        filledSections.add(section2);
      }
    });

    // Sections that do not exist in the file yet.
    for (const [section, keys] of newKeysBySection) {
      if (filledSections.has(section)) continue;
      out.push(formatSectionHeader(section));
      for (const key of keys) emitValues(key);
    }

    if (out.length === 0) return "";
    return out.join("\n") + (this.trailingNewline ? "\n" : "");
  }
}

/* ----------------------------------------------------------------- chain */

/** Options of {@link GitWorkingCopyConfig}: the chain of files around this one. */
export interface GitConfigOptions {
  /**
   * The user's environment: the system file (`systemConfig`), the global files
   * (`$XDG_CONFIG_HOME/git/config`, `~/.gitconfig`) and `~/` in include paths. Absent (a
   * browser), only this file and what it includes are read.
   */
  environment?: GitHostEnvironment;
  /** Follow `include.path` / `includeIf.*.path` (default true) */
  includes?: boolean;
  /**
   * The git directory as the host names it (an absolute path on Node), matched by
   * `includeIf.gitdir:` and used for `./` in its patterns. Default: the directory of this file.
   */
  gitDirPath?: string;
  /** `config.worktree` (default: next to this file), read when `extensions.worktreeConfig` */
  worktreeConfigPath?: string;
  /**
   * The current branch's ref (`refs/heads/main`) for `includeIf.onbranch:`. Default: `HEAD`
   * next to this file, read through its FilesApi.
   */
  readHead?: () => Promise<string | undefined>;
}

/** One value of the chain. */
interface ConfigEntry {
  key: string;
  value: unknown;
  /** Where it was read (absent for a value set in memory and not saved yet) */
  origin?: { file: string; line: number; text: string | undefined };
}

/**
 * One value of a key with where it was read, as {@link GitWorkingCopyConfig.getAllWithOrigin}
 * gives it: what git names in `bad config variable '<key>' in file '<file>' at line <n>`.
 */
export interface ConfigValueOrigin {
  /** The value as {@link GitWorkingCopyConfig.get} reads it (booleans and numbers converted) */
  value: unknown;
  /**
   * The value as written, unquoted and unescaped but not converted (`yes` stays `yes`);
   * undefined for a variable written without `=` (git's NULL value: "missing value")
   */
  text: string | undefined;
  /** The file, as the host or the files API names it; absent for a value set in memory */
  file?: string;
  /** Its line in that file, from 1 */
  line?: number;
}

/** A config file and how to read it. */
interface ConfigSource {
  read(path: string): Promise<Uint8Array | undefined>;
  path: string;
  /** Read through the host's environment (a host path), not the repository's files API */
  host?: boolean;
}

/**
 * A file's name as git prints it in a config error: a host path as it is; a path of the
 * repository's files API (rooted at the top of the worktree, where git runs) without its
 * leading `/` (`.git/config`).
 */
const originName = (path: string, host?: boolean) => (host ? path : path.replace(/^\/+/, ""));

/** git's `MAX_INCLUDE_DEPTH`. */
const MAX_INCLUDE_DEPTH = 10;

const dirOf = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash + 1) : "";
};

const isTrue = (value: unknown) => parseGitBool(value) === true;

/** `include.path` or `includeif.<condition>.path`. */
function isIncludeKey(key: string): boolean {
  return key === "include.path" || (key.startsWith("includeif.") && key.endsWith(".path"));
}

/** Reads config files of the chain, following their include directives as git does. */
class ChainReader {
  private branch?: Promise<string | undefined>;

  constructor(
    private readonly config: GitWorkingCopyConfig,
    private readonly env: GitHostEnvironment | undefined,
    private readonly options: GitConfigOptions,
    private readonly followIncludes: boolean,
  ) {}

  /** Appends the entries of `source` (and what it includes) to `out`; nothing when absent. */
  async readFile(source: ConfigSource, out: ConfigEntry[], depth: number): Promise<void> {
    let content: Uint8Array | undefined;
    try {
      content = await source.read(source.path);
    } catch {
      content = undefined;
    }
    if (!content) return;
    const { lines, errorLine } = parseConfigText(decodeGitPatternFile(content));
    const file = originName(source.path, source.host);
    if (errorLine !== undefined) throw new ConfigParseError(file, errorLine);
    let lineEnd = 0;
    for (const line of lines) {
      lineEnd += physicalLines(line);
      const key = keyOfLine(line);
      if (key === undefined) continue;
      const value =
        line.kind === "entry" ? line.value : line.kind === "section" ? line.inlineValue : undefined;
      out.push({
        key,
        value,
        origin: {
          file,
          line: lineEnd,
          text: writtenValueOfLine(line),
        },
      });
      if (this.followIncludes && isIncludeKey(key)) {
        await this.include(key, value, source, out, depth + 1);
      }
    }
  }

  /** Follows one include directive of `from`. */
  async include(
    key: string,
    value: unknown,
    from: ConfigSource,
    out: ConfigEntry[],
    depth: number,
  ): Promise<void> {
    if (typeof value !== "string" || value === "") return;
    if (key !== "include.path") {
      const condition = key.slice("includeif.".length, -".path".length);
      if (!(await this.conditionHolds(condition, from))) return;
    }
    if (depth > MAX_INCLUDE_DEPTH) {
      throw new Error(
        `exceeded maximum include depth (${MAX_INCLUDE_DEPTH}) while including\n\t${value}\n\tfrom\n\t${from.path}\nThis might be due to circular includes.`,
      );
    }
    const target = this.resolvePath(value, from);
    if (target) await this.readFile(target, out, depth);
  }

  /** git's `handle_path_include`: `~/` in the home, a relative path beside `from`. */
  private resolvePath(value: string, from: ConfigSource): ConfigSource | undefined {
    const env = this.env;
    if (value.startsWith("~")) {
      const expanded = expandUserPath(value, env);
      return expanded && env ? { read: env.readFile, path: expanded, host: true } : undefined;
    }
    if (value.startsWith("/")) {
      return env ? { read: env.readFile, path: value, host: true } : undefined;
    }
    return { read: from.read, path: `${dirOf(from.path)}${value}`, host: from.host };
  }

  private gitDirPath(): string {
    return (this.options.gitDirPath ?? dirOf(this.configPath())).replace(/\/+$/, "");
  }

  private configPath(): string {
    return (this.config as unknown as { configPath: string }).configPath;
  }

  /** Whether an `onbranch:` condition was evaluated (the chain then depends on HEAD). */
  branchUsed = false;

  /** What HEAD names (`refs/heads/main`; undefined when detached), read once per reader. */
  headRef(): Promise<string | undefined> {
    this.branch ??= (async () => {
      if (this.options.readHead) return this.options.readHead();
      const files = (this.config as unknown as { files: ConfigFilesApi }).files;
      const head = await files.read(`${dirOf(this.configPath())}HEAD`).catch(() => undefined);
      if (!head) return undefined;
      const text = decodeGitPath(head).trim();
      return text.startsWith("ref: ") ? text.slice(5).trim() : undefined;
    })().catch(() => undefined);
    return this.branch;
  }

  private async currentBranch(): Promise<string | undefined> {
    this.branchUsed = true;
    const ref = await this.headRef();
    return ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
  }

  /** git's `include_condition_is_true`. */
  private async conditionHolds(condition: string, from: ConfigSource): Promise<boolean> {
    const gitdir = /^gitdir(\/i)?:/.exec(condition);
    if (gitdir) {
      const icase = gitdir[1] !== undefined;
      let pattern = condition.slice(gitdir[0].length);
      const expanded = expandUserPath(pattern, this.env);
      if (expanded === undefined) return false;
      pattern = expanded;
      if (pattern.startsWith("./")) {
        // relative to the including file's directory, known only as the host names it
        const dir = from.path === this.configPath() ? `${this.gitDirPath()}/` : dirOf(from.path);
        pattern = `${dir}${pattern.slice(2)}`;
      } else if (!pattern.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(pattern)) {
        pattern = `**/${pattern}`;
      }
      if (pattern.endsWith("/")) pattern = `${pattern}**`;
      return wildmatch(pattern, this.gitDirPath(), { pathname: true, casefold: icase });
    }
    if (condition.startsWith("onbranch:")) {
      const branch = await this.currentBranch();
      if (!branch) return false;
      let pattern = condition.slice("onbranch:".length);
      if (pattern.endsWith("/")) pattern = `${pattern}**`;
      return wildmatch(pattern, branch, { pathname: true });
    }
    return false;
  }
}

/* ------------------------------------------------------------------ keys */

/**
 * Normalise a key to its canonical form: the section and name parts are
 * lower-cased, the subsection (everything between them) keeps its case.
 *
 * @returns undefined when the key has no section part
 */
function canonicalizeKey(key: string): string | undefined {
  const parts = key.split(".");
  if (parts.length < 2) return undefined;
  const section = parts[0].toLowerCase();
  const name = parts[parts.length - 1].toLowerCase();
  const subsection = parts.slice(1, -1).join(".");
  return subsection ? `${section}.${subsection}.${name}` : `${section}.${name}`;
}

function requireCanonicalKey(key: string): string {
  const canonical = canonicalizeKey(key);
  if (!canonical) {
    throw new TypeError(
      `Invalid git config key "${key}": a key must have a section, e.g. "core.bare" or "remote.origin.url"`,
    );
  }
  return canonical;
}

/** `section.subsection` (or `section`) part of a canonical key. */
function sectionOfKey(key: string): string {
  return key.slice(0, key.lastIndexOf("."));
}

/** Normalise a section reference: the section name is case-insensitive. */
function canonicalizeSection(section: string): string {
  const dot = section.indexOf(".");
  if (dot < 0) return section.toLowerCase();
  return `${section.slice(0, dot).toLowerCase()}.${section.slice(dot + 1)}`;
}

/**
 * git's `section_name_match`: where a header line naming the section `name`
 * (`branch.feat`) ends, the whitespace after it included, or 0 when it names another one.
 * The header is matched as written, case and all (`[Branch "feat"]` is not `branch.feat`).
 */
function headerNames(text: string, name: string): number {
  const isSpace = (c: string | undefined) =>
    c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f";
  let i = 0;
  while (isSpace(text[i])) i++;
  if (text[i] !== "[") return 0;
  let j = 0;
  let dot = false;
  for (i++; i < text.length && text[i] !== "]"; i++) {
    if (!dot && isSpace(text[i])) {
      dot = true;
      if (name[j++] !== ".") break;
      for (i++; isSpace(text[i]); i++);
      if (text[i] !== '"') break;
      continue;
    }
    if (text[i] === "\\" && dot) i++;
    else if (text[i] === '"' && dot) {
      for (i++; isSpace(text[i]); i++);
      break;
    }
    if (text[i] !== name[j++]) break;
  }
  if (text[i] === "]" && j === name.length) {
    for (i++; isSpace(text[i]); i++);
    return i;
  }
  return 0;
}

function keyOfLine(line: ConfigLine): string | undefined {
  if (line.kind === "entry") return line.key;
  if (line.kind === "section") return line.inlineKey;
  return undefined;
}

function sectionOfLine(line: ConfigLine): string | undefined {
  if (line.kind === "entry") return line.section;
  if (line.kind === "section") return line.section;
  return undefined;
}

/* --------------------------------------------------------------- parsing */

/** What {@link parseConfigText} gives: the logical lines, and git's error, if it has one. */
interface ParsedConfig {
  lines: ConfigLine[];
  trailingNewline: boolean;
  /**
   * The line git's `bad config line <n>` names, where git refuses the file (an unknown
   * escape, an unterminated quote, a bad header or variable name); the lines before it are
   * parsed, the rest kept as text
   */
  errorLine?: number;
}

/** One header or variable git's parser reads, and the physical lines (from 0) it spans. */
type ConfigItem =
  | { kind: "section"; section: string; start: number; end: number }
  | { kind: "entry"; name: string; written: string | undefined; start: number; end: number };

/** C's `isspace` */
const isConfigSpace = (c: string) =>
  c === " " || c === "\t" || c === "\n" || c === "\v" || c === "\f" || c === "\r";
const isAlpha = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
/** git's `iskeychar`: alphanumeric or `-` */
const isKeyChar = (c: string) => isAlpha(c) || (c >= "0" && c <= "9") || c === "-";

/** git's `config_source` reading a string: `get_next_char` with its line counter. */
class ConfigCursor {
  private pos = 0;
  /** git's `linenr`: from 1, one more for each newline read and for each read at the end */
  linenr = 1;
  /** The physical line (from 0) of the next character */
  physical = 0;
  /** The physical line of the character read last */
  last = 0;
  eof = false;

  constructor(private readonly text: string) {}

  next(): string {
    if (this.pos >= this.text.length) {
      this.eof = true;
      this.linenr++;
      this.last = this.physical;
      return "\n";
    }
    let c = this.text[this.pos++];
    // DOS line ends: `\r\n` reads as `\n`, a lone `\r` as itself
    if (c === "\r" && this.text[this.pos] === "\n") {
      this.pos++;
      c = "\n";
    }
    this.last = this.physical;
    if (c === "\n") {
      this.linenr++;
      this.physical++;
    }
    return c;
  }
}

/**
 * git's `git_parse_source` over a whole file: its headers and variables, each with the
 * physical lines it spans (a value continued with a backslash at the end of a line runs on
 * to the next), and the line git's `bad config line <n>` names when git refuses the file.
 */
function scanConfig(text: string): { items: ConfigItem[]; errorLine?: number } {
  const cs = new ConfigCursor(text);
  const items: ConfigItem[] = [];
  let comment = false;
  for (;;) {
    const start = cs.physical;
    const c = cs.next();
    if (c === "\n") {
      if (cs.eof) return { items };
      comment = false;
      continue;
    }
    if (comment || isConfigSpace(c)) continue;
    if (c === "#" || c === ";") {
      comment = true;
      continue;
    }
    if (c === "[") {
      const section = readSectionHeader(cs);
      if (section === undefined || section === "") return { items, errorLine: cs.linenr };
      items.push({ kind: "section", section, start, end: cs.last });
      continue;
    }
    if (!isAlpha(c)) return { items, errorLine: cs.linenr };
    // get_value: the name, blanks, then `=` and the value or the end of the line
    let name = c.toLowerCase();
    let d = cs.next();
    while (!cs.eof && isKeyChar(d)) {
      name += d.toLowerCase();
      d = cs.next();
    }
    while (d === " " || d === "\t") d = cs.next();
    let written: string | undefined;
    if (d !== "\n") {
      if (d !== "=") return { items, errorLine: cs.linenr };
      written = readConfigValue(cs);
      if (written === undefined) return { items, errorLine: cs.linenr };
    }
    items.push({ kind: "entry", name, written, start, end: cs.last });
  }
}

/**
 * git's `get_base_var` / `get_extended_base_var` after the `[`: `section`, `section.sub`
 * (lower-cased) or `section "sub"` (the subsection's case kept, a backslash escaping the
 * next character, `"]` closing it); undefined where git refuses it.
 */
function readSectionHeader(cs: ConfigCursor): string | undefined {
  let name = "";
  for (;;) {
    let c = cs.next();
    if (cs.eof) return undefined;
    if (c === "]") return name;
    if (isConfigSpace(c)) {
      do {
        if (c === "\n") {
          cs.linenr--;
          return undefined;
        }
        c = cs.next();
      } while (isConfigSpace(c));
      if (c !== '"') return undefined;
      name += ".";
      for (;;) {
        let s = cs.next();
        if (s === "\n") {
          cs.linenr--;
          return undefined;
        }
        if (s === '"') break;
        if (s === "\\") {
          s = cs.next();
          if (s === "\n") {
            cs.linenr--;
            return undefined;
          }
        }
        name += s;
      }
      return cs.next() === "]" ? name : undefined;
    }
    if (!isKeyChar(c) && c !== ".") return undefined;
    name += c.toLowerCase();
  }
}

/**
 * git's `parse_value`, after the `=`: blanks around the value dropped, `"..."` keeping them
 * (and `#`, `;`), `\n` `\t` `\b` `\"` `\\` unescaped, a backslash at the end of a line
 * joining the next one, an unquoted `#` or `;` starting a comment; undefined (git refuses
 * the line) for another escape or a quote still open at the end of the line.
 */
function readConfigValue(cs: ConfigCursor): string | undefined {
  let quote = false;
  let comment = false;
  let trimLength = 0;
  let value = "";
  for (;;) {
    let c = cs.next();
    if (c === "\n") {
      if (quote) {
        cs.linenr--;
        return undefined;
      }
      return trimLength ? value.slice(0, trimLength) : value;
    }
    if (comment) continue;
    if (isConfigSpace(c) && !quote) {
      if (!trimLength) trimLength = value.length;
      if (value.length) value += c;
      continue;
    }
    if (!quote && (c === ";" || c === "#")) {
      comment = true;
      continue;
    }
    trimLength = 0;
    if (c === "\\") {
      c = cs.next();
      switch (c) {
        case "\n":
          continue;
        case "t":
          c = "\t";
          break;
        case "b":
          c = "\b";
          break;
        case "n":
          c = "\n";
          break;
        case "\\":
        case '"':
          break;
        default:
          return undefined;
      }
      value += c;
      continue;
    }
    if (c === '"') {
      quote = !quote;
      continue;
    }
    value += c;
  }
}

/**
 * Parse git config text into logical lines: a physical line, or the lines a variable
 * continued with a backslash spans (joined with `\n`, so they are written back as they
 * were). Format:
 * ```ini
 * # comment
 * [section]
 *     key = value ; comment
 *     long = "first \
 *             second"
 * [section "subsection"]
 *     key = value
 * ```
 * Where git refuses the file the lines from the bad one on are kept as text (see
 * {@link ParsedConfig.errorLine}).
 */
function parseConfigText(text: string): ParsedConfig {
  const raw = text.split("\n");
  let trailingNewline = false;
  if (raw.length > 0 && raw[raw.length - 1] === "") {
    raw.pop();
    trailingNewline = true;
  }
  const { items, errorLine } = scanConfig(text);
  const lastLine = Math.max(0, raw.length - 1);

  // the items of each group of physical lines (an item's lines, and those of the items
  // that start on its last line)
  const groups: { start: number; end: number; items: ConfigItem[] }[] = [];
  for (const item of items) {
    const end = Math.min(item.end, lastLine);
    const group = groups[groups.length - 1];
    if (group && item.start <= group.end) {
      group.items.push(item);
      group.end = Math.max(group.end, end);
    } else {
      groups.push({ start: item.start, end: Math.max(end, item.start), items: [item] });
    }
  }

  const lines: ConfigLine[] = [];
  let section = "";
  let next = 0;
  for (const group of groups) {
    for (; next < group.start && next < raw.length; next++) {
      lines.push({ kind: "text", text: raw[next] });
    }
    const groupText = raw.slice(group.start, group.end + 1).join("\n");
    next = group.end + 1;
    let header: Extract<ConfigLine, { kind: "section" }> | undefined;
    let entry: Extract<ConfigItem, { kind: "entry" }> | undefined;
    for (const item of group.items) {
      if (item.kind === "section") {
        section = item.section;
        header = { kind: "section", text: groupText, section };
        entry = undefined;
      } else {
        entry = item;
      }
    }
    if (header) {
      // git allows a variable on the same line as the section header
      if (entry) {
        header.inlineKey = `${section}.${entry.name}`;
        header.inlineValue = convertValue(entry.written);
        header.inlineWritten = entry.written;
      }
      lines.push(header);
    } else if (entry && section) {
      lines.push({
        kind: "entry",
        text: groupText,
        section,
        key: `${section}.${entry.name}`,
        value: convertValue(entry.written),
        written: entry.written,
      });
    } else {
      // a variable outside any section: kept verbatim
      lines.push({ kind: "text", text: groupText });
    }
  }
  for (; next < raw.length; next++) lines.push({ kind: "text", text: raw[next] });

  return errorLine === undefined
    ? { lines, trailingNewline }
    : { lines, trailingNewline, errorLine };
}

/** The number of physical lines a logical line spans. */
function physicalLines(line: ConfigLine): number {
  let n = 1;
  for (let i = line.text.indexOf("\n"); i >= 0; i = line.text.indexOf("\n", i + 1)) n++;
  return n;
}

/**
 * The value of a variable line as written (unquoted, unescaped, its comment dropped, not
 * converted); undefined for a line that is no variable or has no `=`.
 */
function writtenValueOfLine(line: ConfigLine): string | undefined {
  if (line.kind === "entry") return line.written;
  if (line.kind === "section") return line.inlineWritten;
  return undefined;
}

/**
 * A value as {@link GitWorkingCopyConfig.get} gives it: `true` for a variable without `=`,
 * git's boolean spellings as booleans, a lossless number conversion.
 */
function convertValue(text: string | undefined): unknown {
  if (text === undefined) return true;
  const lower = text.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "on") return true;
  if (lower === "false" || lower === "no" || lower === "off") return false;

  // Lossless only: the number must serialise back to the identical text.
  if (text !== "") {
    const num = Number(text);
    if (Number.isFinite(num) && String(num) === text) return num;
  }

  return text;
}

/* ----------------------------------------------------------- serializing */

function formatSectionHeader(section: string): string {
  const dot = section.indexOf(".");
  if (dot < 0) return `[${section}]`;
  const name = section.slice(0, dot);
  const subsection = section
    .slice(dot + 1)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `[${name} "${subsection}"]`;
}

function formatEntry(key: string, value: unknown): string {
  const name = key.slice(key.lastIndexOf(".") + 1);
  return `\t${name} = ${serializeValue(value)}`;
}

/**
 * Serialize a value using git's own quoting rules: problematic characters are
 * always backslash-escaped, and the value is quoted when it is empty, has
 * leading/trailing whitespace, or contains a comment character.
 */
function serializeValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);

  const text = typeof value === "string" ? value : String(value);
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/[\b]/g, "\\b"); // a character class: /\b/ is a word boundary

  const needsQuotes =
    text === "" || /^[ \t]/.test(text) || /[ \t]$/.test(text) || /[#;]/.test(text);
  return needsQuotes ? `"${escaped}"` : escaped;
}

/**
 * Create a WorkingCopyConfig instance.
 *
 * @param files File system API
 * @param gitDir Path to .git directory
 * @param worktreeName Name of worktree (for additional worktrees), undefined for main
 */
export async function createWorkingCopyConfig(
  files: ConfigFilesApi,
  gitDir: string,
  worktreeName?: string,
  options: GitConfigOptions = {},
): Promise<GitWorkingCopyConfig> {
  const configPath = worktreeName
    ? `${gitDir}/worktrees/${worktreeName}/config`
    : `${gitDir}/config`;

  const config = new GitWorkingCopyConfig(files, configPath, options);
  await config.load();
  return config;
}

/** `body` after a UTF-8 BOM. */
function withBom(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}
