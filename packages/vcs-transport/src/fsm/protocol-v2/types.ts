/**
 * Protocol V2 FSM types and interfaces.
 */

/**
 * V2 fetch request structure.
 */
export interface FetchV2Request {
  /** Direct object wants ("want <oid>") */
  wants: string[];
  /** Ref-based wants ("want-ref <refname>") */
  wantRefs: string[];
  /** Client's have objects ("have <oid>") */
  haves: string[];
  /** Client has sent "done" */
  done: boolean;
  /** Use thin pack (deltas to objects not in pack) */
  thinPack?: boolean;
  /** Suppress progress messages */
  noProgress?: boolean;
  /** Include tags for fetched commits */
  includeTags?: boolean;
  /** Use OFS_DELTA encoding */
  ofsDeltas?: boolean;

  // Shallow options
  /** Client's shallow boundaries */
  shallow: string[];
  /** Deepen by N commits */
  deepen: number;
  /** Deepen relative to current shallow depth */
  deepenRelative?: boolean;
  /** Deepen since timestamp */
  deepenSince?: number;
  /** Deepen excluding refs */
  deepenNot?: string[];

  /** Partial clone filter spec */
  filter: string | null;

  /** Packfile-uri protocols (if packfile-uris capability) */
  packfileUriProtocols?: string[];
}

/**
 * V2 fetch response section types.
 */
export type FetchV2ResponseSection =
  | { type: "acknowledgments"; acks: string[]; ready?: boolean }
  | { type: "shallow-info"; shallow: string[]; unshallow: string[] }
  | { type: "wanted-refs"; refs: Map<string, string> }
  | { type: "packfile-uris"; uris: string[] }
  | { type: "packfile" };

/**
 * Default V2 server capabilities.
 */
export const SERVER_V2_CAPABILITIES = [
  "agent=statewalker-vcs/1.0",
  "ls-refs",
  "fetch=shallow wait-for-done filter",
  "server-option",
  "object-format=sha1",
  "object-info",
];

/**
 * Create an empty V2 fetch request.
 */
export function createEmptyFetchRequest(): FetchV2Request {
  return {
    wants: [],
    wantRefs: [],
    haves: [],
    done: false,
    shallow: [],
    deepen: 0,
    filter: null,
  };
}
