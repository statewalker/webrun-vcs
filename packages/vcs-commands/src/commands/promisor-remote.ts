/**
 * A partial clone's promisor remotes and their lazy fetch (git's promisor-remote.c): the
 * {@link PromisorFetcher} vcs-commands installs on a repository's object store, so a read of
 * an absent object (or a batch a command prefetches) fetches it from the promisor remotes in
 * git's order, as the `git -c fetch.negotiationAlgorithm=noop fetch <remote> --no-tags
 * --no-write-fetch-head --recurse-submodules=no --filter=blob:none --stdin` git runs.
 *
 * Every command installs the default fetcher (smart HTTP, no credentials) when the store has
 * none. Clone, fetch and pull install one built from their own transports, credentials,
 * headers and timeout for the length of their call, then put the previous one back. For later
 * commands of a repository that needs credentials or custom transports, install a fetcher
 * once with {@link installPromisorFetcher}: it stays until replaced.
 *
 * @example
 * ```typescript
 * await git.clone().setURI(url).setFilter("blob:none").setCredentials(auth).call();
 * // later commands of this store fetch with the same credentials:
 * installPromisorFetcher(workingCopy, { transports, credentials: auth });
 * await git.switch().setName("side").call(); // the missing blobs come in one fetch
 * ```
 */

import {
  historyWithoutLazyFetch,
  type ObjectId,
  type ObjectPromisor,
  type PromisorFetcher,
} from "@statewalker/vcs-core";
import {
  anonymizeUrl,
  type Credentials,
  createDefaultTransports,
  createRepositoryFacade,
  FetchCheckError,
  fetchPromisedObjects,
  type GitTransportRegistry,
} from "@statewalker/vcs-transport";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { RemoteConfigStore } from "../remote-config/index.js";
import { hostEnvironmentOf } from "./git-ident.js";

/** A promisor remote (git's `struct promisor_remote`). */
export interface PromisorRemote {
  name: string;
  /** `remote.<name>.partialclonefilter` */
  partialCloneFilter?: string;
}

/**
 * The promisor remotes in git's order (promisor_remote_init): each remote with
 * `remote.<name>.promisor = true` or a `remote.<name>.partialclonefilter`, in config order,
 * then the remote `extensions.partialClone` names moved (or added) last.
 *
 * @example
 * ```typescript
 * promisorRemotes(RemoteConfigStore.from(workingCopy)); // [{ name: "origin", partialCloneFilter: "blob:none" }]
 * ```
 */
export function promisorRemotes(store: RemoteConfigStore): PromisorRemote[] {
  const out: PromisorRemote[] = [];
  const find = (name: string) => out.find((r) => r.name === name);
  const entries =
    store.entriesWithPrefix("remote.") ??
    store.configuredNames().flatMap((name) => [
      { key: `remote.${name}.promisor`, value: store.value(`remote.${name}.promisor`) },
      {
        key: `remote.${name}.partialclonefilter`,
        value: store.value(`remote.${name}.partialclonefilter`),
      },
    ]);
  for (const { key, value } of entries) {
    const dot = key.lastIndexOf(".");
    const subkey = key.slice(dot + 1).toLowerCase();
    const name = key.slice("remote.".length, dot);
    if (dot <= "remote.".length || name === "") continue;
    if (subkey === "promisor") {
      // a variable without `=` is true, as git_config_bool reads it
      if (value === undefined ? store.value(key) === undefined : !parseGitBool(value)) continue;
      if (!find(name)) out.push({ name });
    } else if (subkey === "partialclonefilter") {
      if (value === undefined) continue;
      let remote = find(name);
      if (!remote) {
        remote = { name };
        out.push(remote);
      }
      remote.partialCloneFilter = value;
    }
  }
  const extension = store.value("extensions.partialclone");
  if (extension !== undefined && extension !== "") {
    const at = out.findIndex((r) => r.name === extension);
    const remote = at >= 0 ? (out.splice(at, 1)[0] as PromisorRemote) : { name: extension };
    out.push(remote);
  }
  return out;
}

/**
 * git's partial_clone_register: a remote already a promisor remote with a filter is left as
 * it is; else the repository format goes to 1 (no extension: git 2.29+ records the promisor
 * remote only) and the remote is marked as promisor, then the filter is recorded as its
 * default for later fetches. The caller saves the configuration.
 */
export function registerPartialClone(
  store: RemoteConfigStore,
  remote: string,
  filter: string,
): void {
  const known = promisorRemotes(store).find((r) => r.name === remote);
  if (known?.partialCloneFilter !== undefined) return;
  if (!known) {
    const version = Number.parseInt(store.value("core.repositoryformatversion") ?? "0", 10) || 0;
    if (version < 1) store.setValue("core.repositoryformatversion", "1");
    store.setValue(`remote.${remote}.promisor`, "true");
  }
  store.setValue(`remote.${remote}.partialclonefilter`, filter);
}

/** git's `repo_has_promisor_remote`. */
export function hasPromisorRemote(store: RemoteConfigStore): boolean {
  return promisorRemotes(store).length > 0;
}

/** How {@link createPromisorFetcher} reaches the promisor remotes. */
export interface PromisorFetcherOptions {
  /** The transports non-local remotes are reached through (default: smart HTTP) */
  transports?: GitTransportRegistry;
  credentials?: Credentials;
  headers?: Record<string, string>;
  timeout?: number;
  /**
   * git's behaviour to follow: 2.43 knows no `GIT_NO_LAZY_FETCH` (default: the host's hook
   * runner's, else 2.56)
   */
  compatibility?: "2.43" | "2.56";
}

/** The warning git prints once per process when `GIT_NO_LAZY_FETCH` refuses a fetch. */
export const LAZY_FETCH_DISABLED_WARNING =
  "warning: lazy fetching disabled; some objects may not be available";

/**
 * The lazy fetch of a working copy's repository (git's promisor_remote_get_direct and
 * fetch_objects): see the module documentation. Under `GIT_NO_LAZY_FETCH` (git 2.45+) a read
 * fetches nothing and a batch is refused with git's warning.
 */
export function createPromisorFetcher(
  workingCopy: WorkingCopy,
  options: PromisorFetcherOptions = {},
): PromisorFetcher {
  const store = () => RemoteConfigStore.from(workingCopy);
  const compatibilityOf = () =>
    options.compatibility ?? hostEnvironmentOf(workingCopy)?.hookRunner?.compatibility ?? "2.56";
  const noLazyFetch = () =>
    compatibilityOf() !== "2.43" && hostEnvironmentOf(workingCopy)?.noLazyFetch === true;
  let warned = false;
  const promisor = () => workingCopy.history.objects?.promisor;
  const fetchFrom = async (remote: PromisorRemote, ids: readonly ObjectId[]) => {
    if (noLazyFetch()) {
      if (!warned) {
        warned = true;
        promisor()?.warnings.push(LAZY_FETCH_DISABLED_WARNING);
      }
      return false;
    }
    const config = store();
    const url = config.remoteUrlOf(remote.name);
    // the child fetch runs with fetch_if_missing = 0: it reads through the history's view
    // without lazy fetch (a read elsewhere meanwhile still fetches)
    const history = historyWithoutLazyFetch(workingCopy.history);
    const compatibility = compatibilityOf();
    const run = async () => {
      // fetch-pack's --fsck-objects (fetch.fsckObjects, else transfer.fsckObjects); loaded
      // when first needed, as the transport's modules (fsck imports GitCommand)
      const { fetchFsckOf } = await import("./fsck/index.js");
      const environment = hostEnvironmentOf(workingCopy);
      const fsckWarnings: string[] = [];
      const fsck = await fetchFsckOf({
        value: (key) => config.value(key),
        entries: (prefix) => config.entriesWithPrefix(prefix),
        warnings: fsckWarnings,
        compatibility,
        ...(environment
          ? { readFile: (path: string) => environment.readFile(path), home: environment.home }
          : {}),
      });
      // loaded when first needed: GitCommand installs this fetcher, and the transport's
      // modules (local remotes run commands) import GitCommand
      const { prepareRemote, protocolVersionOf, withRemoteUploadPack } = await import(
        "./remote-transport.js"
      );
      const prepared = await prepareRemote(
        workingCopy,
        url,
        options.transports ?? createDefaultTransports(),
      );
      await withRemoteUploadPack(
        prepared,
        {
          ...(options.credentials ? { credentials: options.credentials } : {}),
          ...(options.headers ? { headers: options.headers } : {}),
          ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
          protocolVersion: protocolVersionOf(config),
        },
        async (connection) => {
          try {
            await fetchPromisedObjects(connection, {
              repository: createRepositoryFacade({ history }),
              ids,
              filter: "blob:none",
              url: anonymizeUrl(url),
              compatibility,
              ...(fsck ? { fsckObjects: fsck } : {}),
            });
          } catch (error) {
            // fetch-pack ran: its start-up warnings came first
            if (error instanceof FetchCheckError) {
              throw new FetchCheckError(
                error.check,
                [...fsckWarnings, ...error.lines],
                error.exitCode,
              );
            }
            throw error;
          }
        },
      );
    };
    try {
      await run();
      return true;
    } catch (error) {
      const warnings = promisor()?.warnings;
      if (error instanceof FetchCheckError) {
        // git's lines as the child fetch printed them
        warnings?.push(...error.lines);
        return false;
      }
      const message = error instanceof Error ? error.message : String(error);
      const lines = message.split("\n");
      for (const line of lines) {
        warnings?.push(/^(fatal|error|warning):/.test(line) ? line : `fatal: ${line}`);
      }
      return false;
    }
  };
  // promisor_remote_init reads the configuration once (reinit after a registration)
  let known: boolean | undefined;
  return {
    hasPromisorRemote: () => {
      known ??= hasPromisorRemote(store());
      return known;
    },
    invalidate: () => {
      known = undefined;
    },
    fetchIfMissing: () => !noLazyFetch(),
    async fetch(ids) {
      let remaining = [...ids];
      // try_promisor_remotes: the first remote whose fetch succeeds ends it
      for (const remote of promisorRemotes(store())) {
        if (await fetchFrom(remote, remaining)) return [];
        if (remaining.length === 1) continue;
        // remove_fetched_oids: what a failed fetch brought all the same
        const objects = workingCopy.history.objects;
        const left: ObjectId[] = [];
        for (const id of remaining) if (!(await objects?.has(id))) left.push(id);
        remaining = left;
        if (remaining.length === 0) return [];
      }
      return remaining;
    },
  };
}

/**
 * Installs {@link createPromisorFetcher}'s fetcher on the repository of `workingCopy`
 * (replacing one there); returns the promisor, undefined for a store without one.
 */
export function installPromisorFetcher(
  workingCopy: WorkingCopy,
  options: PromisorFetcherOptions = {},
): ObjectPromisor | undefined {
  const promisor = promisorOf(workingCopy);
  promisor?.setFetcher(createPromisorFetcher(workingCopy, options));
  return promisor;
}

/** The promisor of a working copy's object store, if it has one. */
export function promisorOf(workingCopy: WorkingCopy): ObjectPromisor | undefined {
  try {
    return workingCopy.history?.objects?.promisor;
  } catch {
    return undefined;
  }
}
