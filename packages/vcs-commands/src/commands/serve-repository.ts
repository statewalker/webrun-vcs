/**
 * A repository on disk served to other peers: what `serveGitConnection` / `serveGitService`
 * (vcs-transport) need from an opened repository, with the settings git's upload-pack and
 * receive-pack read from it.
 */

import { historyWithoutLazyFetch } from "@statewalker/vcs-core";
import { readProtectedConfig } from "@statewalker/vcs-store-files";
import {
  createRepositoryFacade,
  createTransportRefStore,
  type GitServeSettings,
  type PackObjectsHook,
  packObjectsHookArgs,
  type ServedRepository,
  type ServedRequestContext,
  type ServerConfigReader,
  servedGitFilesOf,
} from "@statewalker/vcs-transport";
import { type OpenedRepository, sparseFilterMatcher } from "@statewalker/vcs-working-tree";
import { uploadArchiveWriterOf } from "./archive/upload-archive-writer.js";
import type { HookSession } from "./git-hooks.js";
import {
  httpBackendEnv,
  type ReceivePackHost,
  receiveFsckSettingsOf,
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
  /**
   * Where receive-pack runs (`ReceivePackHost`): whose fsck messages to give and whose v2
   * upload-pack ACKs (2.43: every have held), by default the hooks' runner's compatibility. A
   * served repository's `receive.fsck.skipList` is always read confined to its own git
   * directories (`confineFiles`), never from the host
   */
  host?: ReceivePackHost;
  /**
   * git's `uploadpack.packObjectsHook`: by default (`"protected"`) the last value of the
   * host's protected configuration (system, global, command line: `readProtectedConfig` of
   * the hooks' host environment), never the served repository's own config, run through the
   * host's hook runner in the git directory (`packObjectsHookOf`); `false` runs none
   */
  packObjectsHook?: "protected" | false;
}

/** What the served repository's config decides: left to `serveGitService`'s layering. */
const CONFIG_KEYS = [
  "allowDeletes",
  "allowNonFastForward",
  "denyCurrentBranch",
  "denyDeleteCurrent",
  "shallowUpdate",
  "advertisePushOptions",
  "advertiseSID",
  "promisorRemoteInfo",
  "advertiseAtomic",
  "maxInputSize",
  "certNonceSeed",
  "certNonceSlop",
  "receiveKeepAliveMs",
  "unpackLimit",
  "uploadPackHideRefs",
  "receivePackHideRefs",
  "procReceiveRefs",
  "receivePackConfigError",
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
  // someone else's repository: files its config names are read only inside it
  const host: ReceivePackHost = { ...options.host, confineFiles: true };
  const full = await receivePackSettingsOf(remote, options.hooks, undefined, host);
  const settings: Record<string, unknown> = { ...full };
  for (const key of CONFIG_KEYS) delete settings[key];
  // receive.fsck.* that kills receive-pack is not among the config keys serveGitService reads
  const fsckError = receiveFsckSettingsOf(remote, host).configError;
  if (fsckError !== undefined && full.receivePackConfigError === fsckError) {
    settings.receivePackConfigError = fsckError;
  }
  const hooks = options.hooks;
  // v2 upload-pack's ACKs: git before 2.45 acknowledges every have it holds
  if ((options.host?.compatibility ?? hooks?.compatibility) === "2.43") {
    settings.acknowledgeEveryHave = true;
  }
  if (options.packObjectsHook !== false && hooks) {
    const hook = await packObjectsHookOf(hooks);
    if (hook) settings.packObjectsHook = hook;
  }
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
    // git archive --remote (upload-archive--writer in the git directory)
    ...(() => {
      const uploadArchive = uploadArchiveWriterOf(remote);
      return uploadArchive ? { uploadArchive } : {};
    })(),
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

/**
 * upload-pack's `uploadpack.packObjectsHook` as the host runs it: the last value of the
 * protected configuration of the session's host environment (upload_pack_protected_config:
 * system, global, command line; a key without a value is git's `config_error_nonbool`, no
 * hook here), started through the session's runner as git starts it (`<hook> git
 * pack-objects ...` through the shell, in the git directory). Undefined when none is set or
 * no runner can start it.
 *
 * @example
 * ```ts
 * // ~/.gitconfig: [uploadpack] packObjectsHook = /srv/bin/pack-cache
 * const hook = await packObjectsHookOf(remoteHookSession(workingCopy, opened));
 * ```
 */
export async function packObjectsHookOf(
  hooks: HookSession | undefined,
): Promise<PackObjectsHook | undefined> {
  const environment = hooks?.hostEnvironment;
  if (!hooks?.enabled || !environment) return undefined;
  let command: string | undefined;
  for (const entry of await readProtectedConfig(environment)) {
    if (entry.key.toLowerCase() === "uploadpack.packobjectshook") command = entry.value;
  }
  if (!command) return undefined;
  const hookCommand = command;
  // git before 2.56 (create_pack_file's own argv) orders the arguments otherwise
  const legacy = hooks.compatibility === "2.43";
  return ({ args, options, stdin, onStderr }) =>
    hooks.startShellCommand(
      "pack-objects-hook",
      hookCommand,
      legacy ? packObjectsHookArgs(options, "2.43") : args,
      stdin,
      onStderr,
    );
}
