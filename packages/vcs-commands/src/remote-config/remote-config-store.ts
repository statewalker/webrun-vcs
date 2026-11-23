/**
 * Reading and writing the `[remote "<name>"]` sections of a working copy's
 * configuration.
 *
 * Internal to the package: the remote/fetch/push/ls-remote commands share it,
 * the public API does not expose it. Only {@link RemoteConfig} is public, and
 * it is re-exported from `commands/remote-command.ts`.
 */

import type { WorkingCopy, WorkingCopyConfig } from "@statewalker/vcs-working-tree";

import { InvalidArgumentError } from "../errors/index.js";

/**
 * Remote configuration entry.
 *
 * Based on JGit's RemoteConfig.
 */
export interface RemoteConfig {
  /** Remote name */
  name: string;
  /** Fetch URLs */
  urls: string[];
  /** Push URLs (defaults to fetch URLs if not set) */
  pushUrls: string[];
  /** Fetch refspecs */
  fetchRefspecs: string[];
  /** Push refspecs */
  pushRefspecs: string[];
}

/** The default fetch refspec `git remote add` writes for a remote. */
export function defaultFetchRefspec(name: string): string {
  return `+refs/heads/*:refs/remotes/${name}/*`;
}

/* ------------------------------------------------------- config plumbing */

/**
 * The git-config surface {@link RemoteConfigStore} needs.
 *
 * `WorkingCopy.config` is typed as a bare index-signature bag, so a working
 * copy may hand us either a real git config object (`GitWorkingCopyConfig` in
 * `@statewalker/vcs-store-files`, which reads and writes `.git/config`) or a
 * plain object. This is the shape of the former; {@link PlainObjectConfig}
 * gives the latter the same shape, so the commands never branch.
 */
interface GitConfigLike {
  get(key: string): unknown;
  getAll(key: string): unknown[];
  set(key: string, value: unknown): void;
  add(key: string, value: unknown): void;
  unset(key: string): void;
  unsetSection(section: string): void;
  subsections(section: string): string[];
  /**
   * Optional: renames a section in place (git's `git_config_rename_section`), keeping its
   * position and lines; without it the section's keys are copied and the old one removed.
   */
  renameSection?(oldSection: string, newSection: string): void;
  /**
   * Optional: copies a section after itself (git's `git_config_copy_section`), keeping its
   * lines; without it the section's keys are copied into a new section.
   */
  copySection?(oldSection: string, newSection: string): void;
  /** Optional: a config with no backing file has nothing to save. */
  save?(): Promise<void>;
  /**
   * Optional: the value set last, in the configuration's order, among several keys that
   * name one setting (`core.commentChar` and `core.commentString`).
   */
  getLastOf?(keys: string[]): { key: string; value: unknown } | undefined;
  /**
   * Optional: every value of a key with the file and line it was read from and its text as
   * written (undefined for a variable without `=`), as `GitWorkingCopyConfig` gives them.
   */
  getAllWithOrigin?(key: string): ConfigValueWhere[];
  /**
   * Optional: every variable of the configuration in its order, keys canonical (section and
   * name in lower case), as `GitWorkingCopyConfig` lists them
   */
  listWithOrigin?(): (ConfigValueWhere & { key: string })[];
}

/** A config value, its text as written and where it was read (see {@link RemoteConfigStore.valuesWithOrigin}). */
export interface ConfigValueWhere {
  /** As written; undefined for a variable without `=` (git's NULL value) */
  text: string | undefined;
  /** The file as the host names it; absent where the config cannot tell */
  file?: string;
  /** The line in that file, from 1 */
  line?: number;
  /** The scope of that file (`local`, `global`, `system`, `worktree`), where the config tells */
  scope?: string;
}

const GIT_CONFIG_METHODS = [
  "get",
  "getAll",
  "set",
  "add",
  "unset",
  "unsetSection",
  "subsections",
] as const;

function isGitConfigLike(
  config: WorkingCopyConfig | undefined,
): config is WorkingCopyConfig & GitConfigLike {
  if (!config) return false;
  return GIT_CONFIG_METHODS.every((method) => typeof config[method] === "function");
}

/**
 * Split `<section>.<subsection>.<name>` into its subsection.
 *
 * Follows git's key grammar (and `GitWorkingCopyConfig`'s): the first part is
 * the section, the last is the variable name and everything in between is the
 * subsection, which keeps its case and may itself contain dots.
 *
 * @returns undefined when the key is not a subsection key of `section`
 */
function subsectionOf(key: string, section: string): string | undefined {
  const parts = key.split(".");
  if (parts.length < 3 || parts[0].toLowerCase() !== section.toLowerCase()) return undefined;
  return parts.slice(1, -1).join(".");
}

/**
 * {@link GitConfigLike} over a plain `{[key: string]: unknown}` bag.
 *
 * Keys are stored in canonical dotted form (`remote.origin.url`) — the same
 * form `GitWorkingCopyConfig` mirrors as own properties — so the two
 * representations read alike. A repeated key holds an array.
 *
 * There is no `save()`: this config lives and dies with the working copy
 * instance, which is exactly what a working copy without a config file has.
 */
class PlainObjectConfig implements GitConfigLike {
  constructor(private readonly bag: Record<string, unknown>) {}

  get(key: string): unknown {
    const values = this.getAll(key);
    return values.length > 0 ? values[values.length - 1] : undefined;
  }

  getAll(key: string): unknown[] {
    const value = this.bag[key];
    if (value === undefined) return [];
    return Array.isArray(value) ? [...value] : [value];
  }

  set(key: string, value: unknown): void {
    this.bag[key] = value;
  }

  add(key: string, value: unknown): void {
    const existing = this.getAll(key);
    this.bag[key] = existing.length > 0 ? [...existing, value] : value;
  }

  unset(key: string): void {
    delete this.bag[key];
  }

  unsetSection(section: string): void {
    const parts = section.split(".");
    if (parts.length < 2) return;
    const subsection = parts.slice(1).join(".");
    for (const key of Object.keys(this.bag)) {
      if (subsectionOf(key, parts[0]) === subsection) delete this.bag[key];
    }
  }

  renameSection(oldSection: string, newSection: string): void {
    const [section, ...oldParts] = oldSection.split(".");
    const oldSub = oldParts.join(".");
    const newSub = newSection.split(".").slice(1).join(".");
    for (const key of Object.keys(this.bag)) {
      if (subsectionOf(key, section) !== oldSub) continue;
      const name = key.slice(key.lastIndexOf(".") + 1);
      this.bag[`${section}.${newSub}.${name}`] = this.bag[key];
      delete this.bag[key];
    }
  }

  copySection(oldSection: string, newSection: string): void {
    const [section, ...oldParts] = oldSection.split(".");
    const oldSub = oldParts.join(".");
    const newSub = newSection.split(".").slice(1).join(".");
    for (const key of Object.keys(this.bag)) {
      if (subsectionOf(key, section) !== oldSub) continue;
      const name = key.slice(key.lastIndexOf(".") + 1);
      for (const value of this.getAll(key)) this.add(`${section}.${newSub}.${name}`, value);
    }
  }

  subsections(section: string): string[] {
    const found = new Set<string>();
    for (const key of Object.keys(this.bag)) {
      if (this.getAll(key).length === 0) continue;
      const subsection = subsectionOf(key, section);
      if (subsection !== undefined) found.add(subsection);
    }
    return [...found];
  }
}

/**
 * The `[remote "<name>"]` sections of a working copy's configuration.
 *
 * Reading a remote is a **union** of two sources, and stays that way: the
 * config sections, plus every name that appears under `refs/remotes/`. A
 * remote that was fetched into tracking refs without ever being configured is
 * a real remote to `git remote`, and so it is here — it simply has no URL.
 */
export class RemoteConfigStore {
  private constructor(private readonly config: GitConfigLike) {}

  /**
   * Wrap a working copy's configuration.
   *
   * A config that implements the git-config methods is used directly, so
   * changes reach its backing file; anything else is driven as a plain bag.
   */
  static from(workingCopy: WorkingCopy): RemoteConfigStore {
    const config = workingCopy.config;
    if (isGitConfigLike(config)) return new RemoteConfigStore(config);
    return new RemoteConfigStore(new PlainObjectConfig((config ?? {}) as Record<string, unknown>));
  }

  /** Remote names that have a config section. */
  configuredNames(): string[] {
    return this.config.subsections("remote");
  }

  /** Whether the remote has a config section. */
  isConfigured(name: string): boolean {
    return this.configuredNames().includes(name);
  }

  /**
   * Read a remote, filling in the default fetch refspec when none is
   * configured, exactly as `git remote -v` reports one: its URLs as remote.c's
   * `alias_all_urls` leaves them (an empty `url`/`pushurl` line clearing the ones before it,
   * each URL rewritten by `url.<base>.insteadOf`), its push URLs the `pushurl` lines
   * rewritten by `insteadOf` or, without any, the `pushInsteadOf` rewrites of its URLs (empty
   * when none applies: the fetch URLs are pushed to).
   */
  read(name: string): RemoteConfig {
    const fetchRefspecs = this.strings(name, "fetch");
    return {
      name,
      urls: this.remoteUrls(name),
      pushUrls: this.aliasedPushUrls(name),
      fetchRefspecs: fetchRefspecs.length > 0 ? fetchRefspecs : [defaultFetchRefspec(name)],
      pushRefspecs: this.strings(name, "push"),
    };
  }

  /**
   * The `remote.<name>.fetch` lines as configured, without the default {@link read} fills
   * in: a remote without any fetches only its HEAD, as `git fetch <name>` does.
   */
  configuredFetchRefspecs(name: string): string[] {
    return this.strings(name, "fetch");
  }

  /** Write every field of a remote, replacing whatever was there. */
  write(remote: RemoteConfig): void {
    this.setAll(remote.name, "url", remote.urls);
    this.setAll(remote.name, "fetch", remote.fetchRefspecs);
    this.setAll(remote.name, "pushurl", remote.pushUrls);
    this.setAll(remote.name, "push", remote.pushRefspecs);
  }

  /** Drop every `[<section> "<subsection>"]` section named `section` (`branch.feat`). */
  removeSection(section: string): void {
    this.config.unsetSection(section);
  }

  /** Drop the whole `[remote "<name>"]` section. */
  remove(name: string): void {
    this.config.unsetSection(`remote.${name}`);
  }

  /**
   * Rename the `[remote "<oldName>"]` section to `[remote "<newName>"]`, in place where the
   * config can (git's rename_section), else by copying every `remote.<oldName>.*` variable.
   */
  rename(oldName: string, newName: string): void {
    if (this.config.renameSection) {
      this.config.renameSection(`remote.${oldName}`, `remote.${newName}`);
      return;
    }
    // every remote.<old>.* variable: a git-config object mirrors its keys as own
    // properties (the WorkingCopyConfig index signature), so they can be listed
    const variables = new Set<string>();
    for (const key of Object.keys(this.config)) {
      if (subsectionOf(key, "remote") === oldName) {
        variables.add(key.slice(key.lastIndexOf(".") + 1));
      }
    }
    for (const variable of variables) {
      const values = this.strings(oldName, variable);
      if (values.length > 0) this.setAll(newName, variable, values);
    }
    this.config.unsetSection(`remote.${oldName}`);
  }

  /**
   * Rename a `<section>.<subsection>` section (`branch.old` to `branch.new`), in place where
   * the config can (git's `git_config_rename_section`), else by moving its variables.
   */
  renameSection(oldSection: string, newSection: string): void {
    if (this.config.renameSection) {
      this.config.renameSection(oldSection, newSection);
      return;
    }
    for (const [variable, values] of this.sectionVariables(oldSection)) {
      this.setValues(`${newSection}.${variable}`, values);
    }
    this.config.unsetSection(oldSection);
  }

  /**
   * Copy a `<section>.<subsection>` section (`branch.a` to `branch.b`), right after the old
   * one where the config can (git's `git_config_copy_section`), else by adding its values.
   */
  copySection(oldSection: string, newSection: string): void {
    if (this.config.copySection) {
      this.config.copySection(oldSection, newSection);
      return;
    }
    for (const [variable, values] of this.sectionVariables(oldSection)) {
      for (const value of values) this.config.add(`${newSection}.${variable}`, value);
    }
  }

  /** The variables of a section and their values, from a config that mirrors its keys. */
  private sectionVariables(sectionName: string): Map<string, string[]> {
    const [section = "", ...rest] = sectionName.split(".");
    const subsection = rest.join(".");
    const out = new Map<string, string[]>();
    for (const key of Object.keys(this.config)) {
      if (subsectionOf(key, section) !== subsection) continue;
      const variable = key.slice(key.lastIndexOf(".") + 1);
      if (!out.has(variable)) out.set(variable, this.values(`${sectionName}.${variable}`));
    }
    return out;
  }

  /** Subsection names of a section (`branch`: the branch names with configuration). */
  subsections(section: string): string[] {
    return this.config.subsections(section);
  }

  /** Remove every value of a config variable. */
  unset(key: string): void {
    this.config.unset(key);
  }

  /**
   * Point a remote at a URL.
   *
   * @param push Write `pushurl` instead of `url`
   * @param oldUrl Replace only this URL, as `git remote set-url <name> <new> <old>` does
   * @throws InvalidArgumentError if `oldUrl` is not among the configured URLs
   */
  setUrl(name: string, url: string, options: { push?: boolean; oldUrl?: string } = {}): void {
    const variable = options.push ? "pushurl" : "url";
    if (options.oldUrl === undefined) {
      this.setAll(name, variable, [url]);
      return;
    }
    const existing = this.strings(name, variable);
    if (!existing.includes(options.oldUrl)) {
      throw new InvalidArgumentError("oldUri", `No such URL found: ${options.oldUrl}`);
    }
    this.setAll(
      name,
      variable,
      existing.map((value) => (value === options.oldUrl ? url : value)),
    );
  }

  /**
   * The URL to talk to a remote over, or undefined when it has none: the first of
   * {@link remoteUrls} (fetch) or {@link remotePushUrls} (push), with `url.<base>.insteadOf`
   * and `url.<base>.pushInsteadOf` applied as git applies them.
   *
   * @param push The push URL (`pushurl`, else the fetch URLs), as git does
   */
  urlFor(name: string, options: { push?: boolean } = {}): string | undefined {
    return (options.push ? this.remotePushUrls(name) : this.remoteUrls(name))[0];
  }

  /**
   * The URL a remote command talks to for `nameOrUrl`, as git's `remote_get`: a remote whose
   * configuration gives it URLs uses its first one ({@link urlFor}); anything else is a URL
   * or path itself, rewritten by `url.<base>.insteadOf` (for a push, by
   * `url.<base>.pushInsteadOf` first: git's `add_url_alias`).
   *
   * @example
   * ```ts
   * // [url "https://example.com/"] insteadOf = ex:
   * store.remoteUrlOf("ex:repo.git");   // "https://example.com/repo.git"
   * store.remoteUrlOf("origin");        // remote.origin.url, rewritten
   * ```
   */
  remoteUrlOf(nameOrUrl: string, options: { push?: boolean } = {}): string {
    const configured = this.urlFor(nameOrUrl, options);
    if (configured !== undefined) return configured;
    if (options.push) {
      const pushAlias = this.aliasUrl(nameOrUrl, { push: true });
      if (pushAlias !== undefined) return pushAlias;
    }
    return this.aliasUrl(nameOrUrl) ?? nameOrUrl;
  }

  /**
   * A remote's fetch URLs as git reads them: the `remote.<name>.url` lines (an empty one
   * clears those before it: git's `add_url`), each rewritten by `url.<base>.insteadOf`.
   */
  remoteUrls(name: string): string[] {
    return this.urlList(name, "url").map((url) => this.aliasUrl(url) ?? url);
  }

  /**
   * A remote's push URLs as git's `alias_all_urls` and `push_url_of_remote` give them: the
   * `remote.<name>.pushurl` lines rewritten by `insteadOf`; without any, the
   * `pushInsteadOf` rewrite of each `url` line one matches; when that leaves none, the fetch
   * URLs ({@link remoteUrls}).
   */
  remotePushUrls(name: string): string[] {
    const pushUrls = this.aliasedPushUrls(name);
    return pushUrls.length > 0 ? pushUrls : this.remoteUrls(name);
  }

  /**
   * A remote's `pushurl` list as remote.c's `alias_all_urls` leaves it: the `pushurl` lines
   * rewritten by `insteadOf`, or without any, the `pushInsteadOf` rewrites of the `url` lines
   * one matches (`add_pushurl_alias`).
   */
  private aliasedPushUrls(name: string): string[] {
    const pushUrls = this.urlList(name, "pushurl").map((url) => this.aliasUrl(url) ?? url);
    if (pushUrls.length > 0) return pushUrls;
    const aliased: string[] = [];
    for (const url of this.urlList(name, "url")) {
      const alias = this.aliasUrl(url, { push: true });
      if (alias !== undefined) aliased.push(alias);
    }
    return aliased;
  }

  /**
   * git's `alias_url`: `url` with the longest `url.<base>.insteadOf` (or, for `push`,
   * `url.<base>.pushInsteadOf`) prefix it starts with replaced by that `<base>`; the first
   * base configured wins a tie. Undefined when none matches.
   *
   * @example
   * ```ts
   * // [url "git@example.com:"] pushInsteadOf = https://example.com/
   * store.aliasUrl("https://example.com/r.git", { push: true }); // "git@example.com:r.git"
   * ```
   */
  aliasUrl(url: string, options: { push?: boolean } = {}): string | undefined {
    // a git config reads the variable without case; a plain bag by its spelling
    const variables = options.push
      ? ["pushInsteadOf", "pushinsteadof"]
      : ["insteadOf", "insteadof"];
    let best: { base: string; length: number } | undefined;
    for (const base of this.config.subsections("url")) {
      const prefixes = new Set(variables.flatMap((v) => this.values(`url.${base}.${v}`)));
      for (const prefix of prefixes) {
        if (url.startsWith(prefix) && (best === undefined || best.length < prefix.length)) {
          best = { base, length: prefix.length };
        }
      }
    }
    return best === undefined ? undefined : best.base + url.slice(best.length);
  }

  /** The values of a remote's `url`/`pushurl` lines, an empty value clearing the earlier ones. */
  private urlList(name: string, variable: string): string[] {
    const out: string[] = [];
    for (const value of this.strings(name, variable)) {
      if (value === "") out.length = 0;
      else out.push(value);
    }
    return out;
  }

  /** A config variable (`push.default`, `branch.main.merge`), the last value when repeated. */
  value(key: string): string | undefined {
    const value = this.config.get(key);
    return value === undefined || value === null ? undefined : String(value);
  }

  /**
   * The value set last among keys that name one setting (git reads `core.commentChar` and
   * `core.commentString` as one variable, the last line wins); a config that cannot tell
   * the order gives the first key with a value.
   */
  lastValueOf(keys: string[]): string | undefined {
    if (this.config.getLastOf) {
      const found = this.config.getLastOf(keys);
      return found === undefined || found.value === undefined || found.value === null
        ? undefined
        : String(found.value);
    }
    for (const key of keys) {
      const value = this.value(key);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /**
   * Every value of a config variable in the configuration's order with where it was read,
   * for git's `bad config variable '<key>' in file '<file>' at line <n>`. A config that
   * cannot tell gives the values alone (`true` for a variable without `=` read as missing).
   */
  valuesWithOrigin(key: string): ConfigValueWhere[] {
    if (this.config.getAllWithOrigin) return this.config.getAllWithOrigin(key);
    return this.config
      .getAll(key)
      .filter((value) => value !== undefined && value !== null)
      .map((value) => ({ text: value === true ? undefined : String(value) }));
  }

  /**
   * Every variable whose canonical key starts with `prefix` (lower case), in the
   * configuration's order with its text (undefined for a variable without `=`), as git's
   * config callbacks see them; undefined when the config cannot list its variables.
   */
  entriesWithPrefix(prefix: string): { key: string; value: string | undefined }[] | undefined {
    if (!this.config.listWithOrigin) return undefined;
    const lower = prefix.toLowerCase();
    return this.config
      .listWithOrigin()
      .filter((e) => e.key.startsWith(lower))
      .map((e) => ({ key: e.key, value: e.text }));
  }

  /**
   * Every value of the variables `keys` (canonical, lower case) in the configuration's order,
   * with where each was read (file, scope; none for the command line); undefined when the
   * config cannot list its variables.
   */
  entriesWithOriginFor(keys: string[]): (ConfigValueWhere & { key: string })[] | undefined {
    if (!this.config.listWithOrigin) return undefined;
    const wanted = new Set(keys.map((k) => k.toLowerCase()));
    return this.config.listWithOrigin().filter((e) => wanted.has(e.key));
  }

  /** Every value of a config variable (`branch.main.merge` may repeat). */
  values(key: string): string[] {
    return this.config
      .getAll(key)
      .filter((value) => value !== undefined && value !== null)
      .map((value) => String(value));
  }

  /** Sets a config variable, replacing every value it had. */
  setValue(key: string, value: string): void {
    this.config.set(key, value);
  }

  /** Sets every value of a config variable, in order (none: unset). */
  setValues(key: string, values: string[]): void {
    if (values.length === 0) {
      this.config.unset(key);
      return;
    }
    this.config.set(key, values[0]);
    for (const value of values.slice(1)) this.config.add(key, value);
  }

  /** Flush to the backing file, if the config has one. */
  async save(): Promise<void> {
    await this.config.save?.();
  }

  private strings(name: string, variable: string): string[] {
    return this.config
      .getAll(`remote.${name}.${variable}`)
      .filter((value) => value !== undefined && value !== null)
      .map((value) => String(value));
  }

  private setAll(name: string, variable: string, values: string[]): void {
    const key = `remote.${name}.${variable}`;
    if (values.length === 0) {
      this.config.unset(key);
      return;
    }
    this.config.set(key, values[0]);
    for (const value of values.slice(1)) this.config.add(key, value);
  }
}

/**
 * Every remote name known to the repository: config sections ∪ the names
 * appearing under `refs/remotes/`.
 */
export async function listRemoteNames(
  store: RemoteConfigStore,
  refs: { list(prefix: string): AsyncIterable<{ name: string }> },
): Promise<string[]> {
  const names = new Set<string>(store.configuredNames());
  for await (const ref of refs.list("refs/remotes/")) {
    const parts = ref.name.split("/");
    if (parts.length >= 3) names.add(parts[2]);
  }
  return [...names];
}
