/**
 * Remote configuration plumbing shared by the remote-facing commands.
 *
 * Internal: not re-exported from `src/index.ts`.
 */

export {
  defaultFetchRefspec,
  type LegacyRemote,
  listRemoteNames,
  type RemoteConfig,
  RemoteConfigStore,
  setLegacyRemote,
} from "./remote-config-store.js";
export { deleteRefs, moveRefs, type RefMove } from "./remote-refs.js";
