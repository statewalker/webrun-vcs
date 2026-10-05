/**
 * File-based WorkingCopyConfig implementation.
 *
 * Design:
 * - Per-worktree config in .git/worktrees/NAME/config (for additional worktrees)
 * - Main worktree uses .git/config section worktree.*
 * - Allows working-copy-specific settings
 */

import type { WorkingCopyConfig } from "@statewalker/vcs-working-tree";

/**
 * Files API subset needed for config operations
 */
export interface ConfigFilesApi {
  read(path: string): Promise<Uint8Array | undefined>;
  write(path: string, content: Uint8Array): Promise<void>;
}

/**
 * A single physical line of the config file.
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
    }
  | { kind: "entry"; text: string; section: string; key: string; value: unknown };

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
 * ## Known limitations
 *
 * - This is a single-file reader: git's `[include]` / `[includeIf]` directives
 *   are *not* followed. The `include.path` key is readable like any other key,
 *   but values defined in an included file are invisible here, while `git`
 *   resolves them. Nothing in this repository writes includes; a config that
 *   uses them still round-trips unharmed (the directive is just another line).
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

  constructor(
    private readonly files: ConfigFilesApi,
    private readonly configPath: string,
  ) {}

  /**
   * Load configuration from file, replacing any previously loaded state.
   *
   * A missing file loads as an empty configuration.
   */
  async load(): Promise<void> {
    const content = await this.files.read(this.configPath);
    const text = content ? new TextDecoder().decode(content) : "";
    this.adoptText(text);
    this.loaded = true;
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
    await this.files.write(this.configPath, new TextEncoder().encode(content));

    // Re-adopt the line structure we just wrote (keeping the in-memory values,
    // which are authoritative) so a following save() is stable.
    const parsed = parseConfigText(content);
    this.lines = parsed.lines;
    this.trailingNewline = parsed.trailingNewline;
    this.dirtyKeys.clear();
    this.removedSections.clear();
    this.loaded = true;
  }

  /**
   * Get a configuration value; the last one when the key has several.
   */
  get(key: string): unknown {
    const canonical = canonicalizeKey(key);
    if (!canonical) return undefined;
    const values = this.values.get(canonical);
    return values && values.length > 0 ? values[values.length - 1] : undefined;
  }

  /**
   * Get every value of a (possibly repeated) key, in file order.
   */
  getAll(key: string): unknown[] {
    const canonical = canonicalizeKey(key);
    if (!canonical) return [];
    return [...(this.values.get(canonical) ?? [])];
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
  }

  /**
   * Remove a whole section, including its header line.
   *
   * @param section `section` or `section.subsection`, e.g. `remote.origin`
   */
  unsetSection(section: string): void {
    const canonical = canonicalizeSection(section);
    this.removedSections.add(canonical);
    for (const key of [...this.values.keys()]) {
      if (sectionOfKey(key) === canonical) {
        this.values.delete(key);
        this.dirtyKeys.add(key);
        this.unmirror(key);
      }
    }
  }

  /**
   * List the subsection names present for a section, e.g. the remote names for
   * `subsections("remote")`.
   */
  subsections(section: string): string[] {
    const prefix = `${section.toLowerCase()}.`;
    const found = new Set<string>();
    for (const [key, values] of this.values) {
      if (values.length === 0) continue;
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
    this.lines = parsed.lines;
    this.trailingNewline = parsed.trailingNewline;
    this.dirtyKeys.clear();
    this.removedSections.clear();

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

/**
 * Parse git config text into physical lines.
 *
 * Format:
 * ```ini
 * # comment
 * [section]
 *     key = value
 * [section "subsection"]
 *     key = value
 * ```
 */
function parseConfigText(text: string): { lines: ConfigLine[]; trailingNewline: boolean } {
  const raw = text.split("\n");
  let trailingNewline = false;
  if (raw.length > 0 && raw[raw.length - 1] === "") {
    raw.pop();
    trailingNewline = true;
  }

  const lines: ConfigLine[] = [];
  let section = "";

  for (const text of raw) {
    const trimmed = text.trim();

    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      lines.push({ kind: "text", text });
      continue;
    }

    if (trimmed.startsWith("[")) {
      const header = parseSectionHeader(trimmed);
      if (header) {
        section = header.section;
        const line: ConfigLine = { kind: "section", text, section };
        // git allows a variable on the same line as the section header.
        const inline = header.rest ? parseEntry(header.rest) : undefined;
        if (inline) {
          line.inlineKey = `${section}.${inline.name}`;
          line.inlineValue = inline.value;
        }
        lines.push(line);
        continue;
      }
      lines.push({ kind: "text", text });
      continue;
    }

    const entry = section ? parseEntry(trimmed) : undefined;
    if (entry) {
      lines.push({
        kind: "entry",
        text,
        section,
        key: `${section}.${entry.name}`,
        value: entry.value,
      });
      continue;
    }

    // Unparseable (or outside any section): keep it verbatim.
    lines.push({ kind: "text", text });
  }

  return { lines, trailingNewline };
}

const SECTION_NAME_CHAR = /[A-Za-z0-9.-]/;
const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * Parse `[section]`, `[section.subsection]` or `[section "subsection"]`.
 *
 * The subsection of the quoted form keeps its case and may contain any
 * character (escaped with a backslash where needed); the dotted form is
 * lower-cased, as git does.
 */
function parseSectionHeader(trimmed: string): { section: string; rest: string } | undefined {
  let i = 1; // skip "["
  while (i < trimmed.length && /\s/.test(trimmed[i])) i++;

  const nameStart = i;
  while (i < trimmed.length && SECTION_NAME_CHAR.test(trimmed[i])) i++;
  const name = trimmed.slice(nameStart, i);
  if (!name) return undefined;

  while (i < trimmed.length && /\s/.test(trimmed[i])) i++;

  let subsection: string | undefined;
  if (trimmed[i] === '"') {
    i++;
    let value = "";
    while (i < trimmed.length && trimmed[i] !== '"') {
      if (trimmed[i] === "\\" && i + 1 < trimmed.length) i++;
      value += trimmed[i];
      i++;
    }
    if (trimmed[i] !== '"') return undefined; // unterminated
    i++;
    subsection = value;
    while (i < trimmed.length && /\s/.test(trimmed[i])) i++;
  }

  if (trimmed[i] !== "]") return undefined;
  i++;

  const section =
    subsection !== undefined ? `${name.toLowerCase()}.${subsection}` : name.toLowerCase();
  return { section, rest: trimmed.slice(i).trim() };
}

/**
 * Parse a `name = value` line. A name with no `=` is boolean true, as in git.
 */
function parseEntry(trimmed: string): { name: string; value: unknown } | undefined {
  const eq = trimmed.indexOf("=");
  if (eq < 0) {
    const name = stripComment(trimmed).trim();
    if (!VARIABLE_NAME.test(name)) return undefined;
    return { name: name.toLowerCase(), value: true };
  }
  const name = trimmed.slice(0, eq).trim();
  if (!VARIABLE_NAME.test(name)) return undefined;
  return { name: name.toLowerCase(), value: parseValue(trimmed.slice(eq + 1)) };
}

function stripComment(text: string): string {
  const at = text.search(/[#;]/);
  return at < 0 ? text : text.slice(0, at);
}

/**
 * Parse a config value: unquote, unescape, drop an unquoted trailing comment,
 * then apply git's boolean spellings and a lossless number conversion.
 */
function parseValue(input: string): unknown {
  const raw = input.replace(/^[ \t]+/, ""); // whitespace after "=" is not part of the value
  let out = "";
  let end = 0; // length of `out` up to the last significant character
  let quoted = false;
  let hadQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];

    if (!quoted && (char === "#" || char === ";")) break;

    if (char === '"') {
      quoted = !quoted;
      hadQuotes = true;
      continue;
    }

    if (char === "\\" && i + 1 < raw.length) {
      i++;
      const escaped = raw[i];
      out += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped === "b" ? "\b" : escaped; // \\ , \" and anything else: the character itself
      end = out.length;
      continue;
    }

    out += char;
    if (quoted || !/\s/.test(char)) end = out.length;
  }

  const text = out.slice(0, end);
  if (hadQuotes && text === "") return "";

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
): Promise<GitWorkingCopyConfig> {
  const configPath = worktreeName
    ? `${gitDir}/worktrees/${worktreeName}/config`
    : `${gitDir}/config`;

  const config = new GitWorkingCopyConfig(files, configPath);
  await config.load();
  return config;
}
