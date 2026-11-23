/**
 * Protocol V2 FSM types and interfaces.
 */

import type { RepositoryFacade } from "../../api/repository-facade.js";
import { formatOf, v2ObjectFormatCapabilities } from "../../protocol/object-format.js";
import { type UploadPackFilterPolicy, withFilterFeature } from "../fetch/upload-pack-filter.js";

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
  /** A second `filter` line came (git dies: "multiple filter-specs cannot be combined") */
  filterRepeated?: boolean;

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
 * no `filter` (added with `uploadpack.allowFilter`: see `UploadPackFilterPolicy`). No `object-info`, as git (since 2.45) without
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

/** The `object-info` capability as git 2.56 advertises it (`size` and `type` attributes). */
export const OBJECT_INFO_CAPABILITY = "object-info=size type";

/**
 * The v2 capability advertisement: `capabilities` (default {@link SERVER_V2_CAPABILITIES}),
 * with `object-info` added when `advertiseObjectInfo` is set and they do not name it already:
 * {@link OBJECT_INFO_CAPABILITY}, or, given the `repository`, only the attributes its facade
 * can answer (`size` with `getObjectSize`, `type` with `getObjectType`), and no `object-info`
 * when it can answer neither.
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
  repository?: Pick<RepositoryFacade, "getObjectSize" | "getObjectType" | "objectFormat">,
  uploadPackFilter?: UploadPackFilterPolicy,
): string[] {
  // `fetch=... filter` with uploadpack.allowFilter; `object-format=` names the repository's
  // hash (serve.c's object_format_advertise)
  const list = v2ObjectFormatCapabilities(
    withFilterFeature(capabilities, uploadPackFilter),
    formatOf(repository),
  );
  const named = list.some((c) => c === "object-info" || c.startsWith("object-info="));
  if (!advertiseObjectInfo || named) return list;
  const attributes = objectInfoAttributes(repository);
  if (attributes.length > 0) list.push(`object-info=${attributes.join(" ")}`);
  return list;
}

/** The object-info attributes a facade can answer (both without a facade to look at). */
export function objectInfoAttributes(
  repository?: Pick<RepositoryFacade, "getObjectSize" | "getObjectType">,
): Array<"size" | "type"> {
  const out: Array<"size" | "type"> = [];
  if (!repository || repository.getObjectSize) out.push("size");
  if (!repository || repository.getObjectType) out.push("type");
  return out;
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
