/**
 * A repository on disk served to other peers: what `serveGitConnection` / `serveGitService`
 * (vcs-transport) need from an opened repository, with the settings git's upload-pack and
 * receive-pack read from it.
 */

import { historyWithoutLazyFetch } from "@statewalker/vcs-core";
import {
  createRepositoryFacade,
  createTransportRefStore,
  type GitServeSettings,
  type ServedRepository,
  type ServedRequestContext,
  type ServerConfigReader,
  servedGitFilesOf,
} from "@statewalker/vcs-transport";
import { type OpenedRepository, sparseFilterMatcher } from "@statewalker/vcs-working-tree";
import type { HookSession } from "./git-hooks.js";
import {
  httpBackendEnv,
  receivePackSettingsOf,
  servedMaxTreeDepth,
  servedUseBitmaps,
  withReceiveTransactionHook,
} from "./local-transport.js";

/** Options of {@link servedRepositoryOf}. */
export interface ServedRepositoryOptions {
  /**
   * The served repository's hooks (`remoteHookSession`): pre-receive, update, post-receive and
   * post-update run for a push, their output relayed to the client; its reference-transaction
   * hook runs for the refs a push updates, as git's receive-pack runs it (in the git
   * directory, `GIT_DIR=.`), its output not sent to the client
   */
  hooks?: HookSession;
}

/** What the served repository's config decides: left to `serveGitService`'s layering. */
const CONFIG_KEYS = [
  "allowDeletes",
  "allowNonFastForward",
  "denyCurrentBranch",
  "denyDeleteCurrent",
  "shallowUpdate",
  "uploadPackHideRefs",
  "receivePackHideRefs",
  "procReceiveRefs",
] as const;

/** A repository without a config reads as one with nothing set: git's defaults. */
const EMPTY_CONFIG: ServerConfigReader = { getAll: () => [] };

/**
 * An opened repository (`Worktree.openRepository`) as a git server serves it: its objects and
 * refs, its configuration (git-daemon's `daemon.<service>`, `receive.*`, hidden refs), and the
 * settings of git's receive-pack (the current branch and the branches its worktrees have checked
 * out, `receive.denyCurrentBranch=updateInstead`, the hooks given), and the files of its git
 * directory a dumb HTTP client fetches, where it is in a FilesApi (`OpenedRepository.files`).
 *
 * The `receive.*` and hidden ref settings are not in `settings` but left to `config`, so
 * `serveGitService` applies only what the repository's config sets over the operator's
 * `settings` (git's defaults under both); a repository without a config is served with git's
 * defaults.
 *
 * @example
 * ```ts
 * await serveGitConnection({
 *   duplex,
 *   enableReceivePack: true,
 *   resolveRepository: createBasePathResolver({
 *     files,           // the worktree's FilesApi
 *     basePath: "/srv",
 *     exportAll: true, // else only repositories with git-daemon-export-ok
 *     openRepository: async (gitDir) => {
 *       // includes of the repository's config confined to the storage (on a shared host)
 *       const opened = await worktree
 *         .openRepository?.(gitDir, { configIncludes: "files" })
 *         .catch(() => undefined);
 *       return opened && (await servedRepositoryOf(opened));
 *     },
 *   }),
 * });
 * ```
 */
export async function servedRepositoryOf(
  remote: OpenedRepository,
  options: ServedRepositoryOptions = {},
): Promise<ServedRepository> {
  const settings: Record<string, unknown> = {
    ...(await receivePackSettingsOf(remote, options.hooks)),
  };
  for (const key of CONFIG_KEYS) delete settings[key];
  const hooks = options.hooks;
  return {
    repository: createRepositoryFacade({
      history: historyWithoutLazyFetch(remote.history),
      // git's pack.useBitmaps (pack-objects reads it from the served repository)
      useBitmaps: servedUseBitmaps(remote),
      // a sparse:oid filter's patterns
      sparseFilterPatterns: sparseFilterMatcher,
      // core.maxTreeDepth (pack-objects' walk)
      maxTreeDepth: servedMaxTreeDepth(remote),
    }),
    refStore: createTransportRefStore(remote.history.refs),
    config: remote.config ?? EMPTY_CONFIG,
    settings: settings as GitServeSettings,
    // a dumb HTTP client's files (objects, packs), read from the repository directory
    ...(remote.files
      ? { files: servedGitFilesOf(remote.files, remote.commonDir ?? remote.gitDir) }
      : {}),
    around: <T>(service: string, serve: () => Promise<T>, client?: ServedRequestContext) => {
      // a served partial clone never fetches lazily (upload-pack's GIT_NO_LAZY_FETCH,
      // receive-pack's rev-list --exclude-promisor-objects): the facade reads through the
      // history's view without lazy fetch
      if (service !== "git-receive-pack") return serve();
      if (!hooks?.enabled) return serve();
      // the client's variables (http-backend's REMOTE_USER, ...) reach the
      // reference-transaction hook too, as every child of receive-pack inherits them
      const env = httpBackendEnv(hooks, client);
      const session = Object.keys(env).length > 0 ? hooks.withEnv(env) : hooks;
      return withReceiveTransactionHook(remote, session, serve);
    },
  };
}
