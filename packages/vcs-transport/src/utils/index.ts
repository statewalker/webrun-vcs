export {
  fetchWithRequestBody,
  isBrowserContext,
  requestBody,
  shouldStreamRequestBody,
  supportsRequestStreams,
  toReadableStream,
} from "@statewalker/vcs-utils/streams";
export type { GitUri } from "../protocol/types.js";
export {
  type ByteQueue,
  type ByteQueueOptions,
  createByteQueue,
  DEFAULT_BYTE_QUEUE_COALESCE,
  DEFAULT_BYTE_QUEUE_HIGH_WATER_MARK,
} from "./byte-queue.js";
export {
  IdleTimeoutError,
  readStreamWithIdleTimeout,
  type StreamChunks,
  WriteTimeoutError,
  withIdleTimeout,
  withWriteTimeout,
} from "./idle-timeout.js";
export {
  lenientCommitHeader,
  lenientTagTarget,
  type ObjectHeaderSource,
  storedObjectType,
} from "./lenient-headers.js";
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
  parseGitUrl as parseGitUri,
  resolveUrl,
  toHttpUrl,
} from "./uri.js";
