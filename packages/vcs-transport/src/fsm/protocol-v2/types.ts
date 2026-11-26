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
  options: ServerV2CapabilityOptions = {},
): string[] {
  // `fetch=... filter` with uploadpack.allowFilter, `ref-in-want` with
  // uploadpack.allowRefInWant (upload_pack_advertise's order); `object-format=` names the
  // repository's hash (serve.c's object_format_advertise)
  const list = v2ObjectFormatCapabilities(
    withRefInWantFeature(
      withFilterFeature(capabilities, uploadPackFilter),
      options.allowRefInWant === true,
    ),
    formatOf(repository),
  );
  // serve.c's order: ... object-format, session-id, object-info
  if (options.sessionId !== undefined && !list.some((c) => c.startsWith("session-id="))) {
    const objectInfo = list.findIndex((c) => c === "object-info" || c.startsWith("object-info="));
    list.splice(objectInfo >= 0 ? objectInfo : list.length, 0, `session-id=${options.sessionId}`);
  }
  const named = list.some((c) => c === "object-info" || c.startsWith("object-info="));
  if (advertiseObjectInfo && !named) {
    const attributes = objectInfoAttributes(repository);
    if (attributes.length > 0) list.push(`object-info=${attributes.join(" ")}`);
  }
  // serve.c's last capability: `promisor-remote=<pr-info>` (promisor.advertise)
  if (
    options.promisorRemote !== undefined &&
    !list.some((c) => c === "promisor-remote" || c.startsWith("promisor-remote="))
  ) {
    list.push(`promisor-remote=${options.promisorRemote}`);
  }
  return list;
}

/** What else {@link serverV2Capabilities} advertises. */
export interface ServerV2CapabilityOptions {
  /** `fetch=... ref-in-want` (git's `uploadpack.allowRefInWant`) */
  allowRefInWant?: boolean;
  /** `session-id=<id>` (git's `transfer.advertiseSID`) */
  sessionId?: string;
  /** `promisor-remote=<pr-info>` (git's `promisor.advertise`: `promisorRemoteAdvertisement`) */
  promisorRemote?: string;
}

/**
 * The `fetch=` capability with `ref-in-want` added (after `filter`, as git's
 * upload_pack_advertise) when `allow`; the capabilities as they are otherwise.
 */
export function withRefInWantFeature(capabilities: readonly string[], allow: boolean): string[] {
  if (!allow) return [...capabilities];
  return capabilities.map((c) => {
    if (c !== "fetch" && !c.startsWith("fetch=")) return c;
    const features = c === "fetch" ? [] : c.slice("fetch=".length).split(" ").filter(Boolean);
    if (features.includes("ref-in-want")) return c;
    const after = Math.max(features.indexOf("filter"), features.indexOf("wait-for-done"));
    features.splice(after >= 0 ? after + 1 : features.length, 0, "ref-in-want");
    return `fetch=${features.join(" ")}`;
  });
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
