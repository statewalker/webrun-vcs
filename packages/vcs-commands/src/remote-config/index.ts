/**
 * Remote configuration plumbing shared by the remote-facing commands.
 *
 * Internal: not re-exported from `src/index.ts`.
 */

export {
  defaultFetchRefspec,
  listRemoteNames,
  type RemoteConfig,
  RemoteConfigStore,
} from "./remote-config-store.js";
