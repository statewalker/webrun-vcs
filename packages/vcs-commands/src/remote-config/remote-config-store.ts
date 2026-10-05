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
  /** Optional: a config with no backing file has nothing to save. */
  save?(): Promise<void>;
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
 * Split `remote.<subsection>.<name>` into its subsection.
 *
 * Follows git's key grammar (and `GitWorkingCopyConfig`'s): the first part is
 * the section, the last is the variable name and everything in between is the
 * subsection, which keeps its case and may itself contain dots.
 *
 * @returns undefined when the key is not a `remote` subsection key
 */
function remoteSubsectionOf(key: string): string | undefined {
  const parts = key.split(".");
  if (parts.length < 3 || parts[0].toLowerCase() !== "remote") return undefined;
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
    if (parts.length < 2 || parts[0].toLowerCase() !== "remote") return;
    const subsection = parts.slice(1).join(".");
    for (const key of Object.keys(this.bag)) {
      if (remoteSubsectionOf(key) === subsection) delete this.bag[key];
    }
  }

  subsections(section: string): string[] {
    if (section.toLowerCase() !== "remote") return [];
    const found = new Set<string>();
    for (const key of Object.keys(this.bag)) {
      if (this.getAll(key).length === 0) continue;
      const subsection = remoteSubsectionOf(key);
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
   * configured, exactly as `git remote` reports one.
   */
  read(name: string): RemoteConfig {
    const fetchRefspecs = this.strings(name, "fetch");
    return {
      name,
      urls: this.strings(name, "url"),
      pushUrls: this.strings(name, "pushurl"),
      fetchRefspecs: fetchRefspecs.length > 0 ? fetchRefspecs : [defaultFetchRefspec(name)],
      pushRefspecs: this.strings(name, "push"),
    };
  }

  /** Write every field of a remote, replacing whatever was there. */
  write(remote: RemoteConfig): void {
    this.setAll(remote.name, "url", remote.urls);
    this.setAll(remote.name, "fetch", remote.fetchRefspecs);
    this.setAll(remote.name, "pushurl", remote.pushUrls);
    this.setAll(remote.name, "push", remote.pushRefspecs);
  }

  /** Drop the whole `[remote "<name>"]` section. */
  remove(name: string): void {
    this.config.unsetSection(`remote.${name}`);
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
   * The URL to talk to a remote over, or undefined when it has none.
   *
   * @param push Prefer `pushurl`, falling back to `url`, as git does
   */
  urlFor(name: string, options: { push?: boolean } = {}): string | undefined {
    if (options.push) {
      const pushUrl = this.strings(name, "pushurl")[0];
      if (pushUrl !== undefined) return pushUrl;
    }
    return this.strings(name, "url")[0];
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
