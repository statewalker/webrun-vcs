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
  /** Client has sent "wait-for-done": the server must not answer "ready" */
  waitForDone?: boolean;
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
 * Default V2 server capabilities: what the server implements. `ls-refs=unborn`: ls-refs reports
 * an unborn HEAD (`unborn HEAD symref-target:<ref>`), so cloning an empty repository picks its
 * branch; `fetch=shallow` covers `deepen`, `deepen-relative`, `deepen-since` and `deepen-not`;
 * no `filter` (no partial clone). No `object-info`, as git (since 2.46) without
 * `transfer.advertiseObjectInfo`: the servers' `advertiseObjectInfo` option adds
 * {@link OBJECT_INFO_CAPABILITY}.
 */
export const SERVER_V2_CAPABILITIES = [
  "agent=statewalker-vcs/1.0",
  "ls-refs=unborn",
  "fetch=shallow wait-for-done",
  "server-option",
  "object-format=sha1",
];

/** The `object-info` capability as current git advertises it (`size` and `type` attributes). */
export const OBJECT_INFO_CAPABILITY = "object-info=size type";

/**
 * The v2 capability advertisement: `capabilities` (default {@link SERVER_V2_CAPABILITIES}),
 * with {@link OBJECT_INFO_CAPABILITY} added when `advertiseObjectInfo` is set and they do not
 * name `object-info` already.
 *
 * @example
 * ```ts
 * serverV2Capabilities(undefined, true);
 * // [...SERVER_V2_CAPABILITIES, "object-info=size type"]
 * ```
 */
export function serverV2Capabilities(
  capabilities: readonly string[] = SERVER_V2_CAPABILITIES,
  advertiseObjectInfo = false,
): string[] {
  const list = [...capabilities];
  const named = list.some((c) => c === "object-info" || c.startsWith("object-info="));
  if (advertiseObjectInfo && !named) list.push(OBJECT_INFO_CAPABILITY);
  return list;
}

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
