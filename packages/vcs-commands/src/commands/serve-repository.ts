/**
 * A repository on disk served to other peers: what `serveGitConnection` / `serveGitService`
 * (vcs-transport) need from an opened repository, with the settings git's upload-pack and
 * receive-pack read from it.
 */

import {
  createRepositoryFacade,
  createTransportRefStore,
  type ServedRepository,
} from "@statewalker/vcs-transport";
import type { OpenedRepository } from "@statewalker/vcs-working-tree";
import type { HookSession } from "./git-hooks.js";
import { receivePackSettingsOf } from "./local-transport.js";

/** Options of {@link servedRepositoryOf}. */
export interface ServedRepositoryOptions {
  /**
   * The served repository's hooks (`remoteHookSession`): pre-receive, update, post-receive and
   * post-update run for a push, their output relayed to the client
   */
  hooks?: HookSession;
}

/**
 * An opened repository (`Worktree.openRepository`) as a git server serves it: its objects and
 * refs, its configuration (git-daemon's `daemon.<service>`, `receive.*`, hidden refs), and the
 * settings of git's receive-pack (the current branch and the branches its worktrees have checked
 * out, `receive.denyCurrentBranch=updateInstead`, the hooks given).
 *
 * @example
 * ```ts
 * await serveGitConnection({
 *   duplex,
 *   enableReceivePack: true,
 *   resolveRepository: async (path) => {
 *     const opened = await worktree.openRepository?.(`srv${path}`).catch(() => undefined);
 *     return opened && (await servedRepositoryOf(opened));
 *   },
 * });
 * ```
 */
export async function servedRepositoryOf(
  remote: OpenedRepository,
  options: ServedRepositoryOptions = {},
): Promise<ServedRepository> {
  return {
    repository: createRepositoryFacade({ history: remote.history }),
    refStore: createTransportRefStore(remote.history.refs),
    ...(remote.config ? { config: remote.config } : {}),
    settings: await receivePackSettingsOf(remote, options.hooks),
  };
}
