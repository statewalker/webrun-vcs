export {
  fetchWithRequestBody,
  isBrowserContext,
  requestBody,
  shouldStreamRequestBody,
  supportsRequestStreams,
  toReadableStream,
} from "@statewalker/vcs-utils/streams";
export type { GitUrl } from "../protocol/types.js";
export type { RefSpec } from "./refspec.js";
export {
  defaultFetchRefSpec,
  defaultPushRefSpec,
  expandFromDestination,
  expandFromSource,
  formatRefSpec,
  isWildcard,
  matchDestination,
  matchSource,
  parseRefSpec,
} from "./refspec.js";
export {
  formatGitUrl,
  getDefaultPort,
  getEffectivePort,
  getRepositoryName,
  isRemote,
  parseGitUrl,
  resolveUrl,
  toHttpUrl,
} from "./uri.js";
