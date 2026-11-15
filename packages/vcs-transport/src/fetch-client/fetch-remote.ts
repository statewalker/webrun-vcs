/**
 * A whole fetch, as `git fetch` does it: list the remote refs, map them through refspecs,
 * negotiate and import the pack, keep the shallow file, follow tags, update the refs.
 */

import type { PackImportResult, RepositoryFacade } from "../api/repository-facade.js";
import type { RefStore } from "../context/process-context.js";
import { INFINITE_DEPTH } from "../fsm/index.js";
import { encodeDelim, encodeFlush, encodePacketLine, TransportError } from "../protocol/index.js";
import { parseRefSpec } from "../utils/index.js";
import { Completeness } from "./completeness.js";
import type { RemoteRef, UploadPackConnection } from "./connection.js";
import {
  CLIENT_AGENT,
  type FetchPackRequest,
  fetchPack,
  type NegotiationStats,
  type ServerShallowUpdate,
} from "./fetch-pack.js";
import type { NegotiatorSource } from "./negotiator.js";
import {
  applyRefUpdates,
  type FetchRefUpdate,
  mapRefs,
  missingSources,
  type PlannedRef,
  planRefUpdates,
  refPrefixes,
} from "./ref-updates.js";

/** The default refspecs: every branch and tag under its own name (a mirror of heads and tags). */
export const DEFAULT_FETCH_REFSPECS = ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"];

/** How tags are fetched (git's `--tags`, `--no-tags`, and the default auto-follow). */
export type TagMode =
  /** Tags pointing at fetched objects (git's default) */
  | "auto"
  /** Every tag (`refs/tags/*:refs/tags/*`) */
  | "all"
  /** Only tags the refspecs select */
  | "none";

/** What a fetch asks for, beyond the connection. */
export interface FetchClientOptions {
  /** Where the objects go (pack import) and the local history is read (negotiation) */
  repository: RepositoryFacade;
  /** The local refs (written after the fetch) and the shallow file (`getShallow`/`setShallow`) */
  refStore: RefStore;
  /**
   * Refspecs (`[+]src[:dst]`, `^negative`); default {@link DEFAULT_FETCH_REFSPECS}. A
   * {@link RefspecResolver} picks them once the remote refs are known (a clone of the remote
   * HEAD's branch).
   */
  refspecs?: string[] | RefspecResolver;
  /**
   * A refspec source the remote does not have is skipped instead of failing the fetch (git:
   * configured `remote.<name>.fetch` refspecs; command-line ones fail)
   */
  missingRefsOk?: boolean;
  /** Tag following; default `auto` */
  tags?: TagMode;
  /** Shallow fetch: at most this many commits from each fetched tip (`--depth`) */
  depth?: number;
  /** `--deepen-relative`: `depth` counts from the current shallow boundary */
  deepenRelative?: boolean;
  /** `--shallow-since`: only commits newer than this (a Date, or seconds since the epoch) */
  deepenSince?: Date | number;
  /** `--shallow-exclude`: only commits not reachable from these remote refs */
  deepenNot?: string[];
  /** `--unshallow`: fetch the whole history of a shallow repository */
  unshallow?: boolean;
  /** Partial clone filter (`blob:none`) */
  filter?: string;
  /** Allow every update to be a non-fast-forward (`--force`) */
  force?: boolean;
  /** Write all ref updates in one transaction, or none (`--atomic`) */
  atomic?: boolean;
  /** Negotiate and download, but store nothing: no objects, no ref, no shallow change (`--dry-run`) */
  dryRun?: boolean;
  /** Progress messages from the server */
  onProgress?: (message: string) => void;
  /** Reflog message of the ref updates */
  reflogMessage?: string;
}

/** Refspecs chosen from the remote refs (a clone of the remote HEAD's branch, a tag). */
export interface RefspecResolver {
  /** The ref prefixes to list (protocol v2 `ls-refs`; `HEAD` is always listed) */
  prefixes: string[];
  /** The refspecs to fetch with; may throw (a branch the remote does not have) */
  resolve(remoteRefs: readonly RemoteRef[]): string[];
}

/** What a fetch did. */
export interface FetchClientResult {
  /** The protocol spoken: 2 or 0 */
  protocolVersion: 0 | 2;
  /** The remote refs listed (heads, tags, and HEAD with its symref) */
  remoteRefs: RemoteRef[];
  /** The remote HEAD's branch (`refs/heads/main`), when the server says */
  defaultBranch?: string;
  /** Whether the remote has no refs at all */
  isEmpty: boolean;
  /** Each local ref written, or refused, with git's status */
  refUpdates: FetchRefUpdate[];
  /** Tags created by auto-follow (also in `refUpdates`) */
  followedTags: string[];
  /**
   * Tags auto-follow would have created but could not fetch: annotated tags of fetched
   * objects whose tag objects did not come with the pack, over a connection that allows no
   * second request (protocol v0 over a duplex: upload-pack ends after the pack)
   */
  tagsNotFollowed: string[];
  /** The shallow file before and after (equal unless the fetch changed it) */
  shallow: { before: string[]; after: string[] };
  /** What the pack imports reported (one per pack: the fetch, and a tag backfill) */
  imports: PackImportResult[];
  /** Objects in the packs as sent (their headers) */
  packObjects: number;
  /** Bytes of the packs */
  packBytes: number;
  /** Negotiation counters, summed over the packs */
  stats: NegotiationStats;
}

/**
 * Runs a fetch over `connection` (see {@link openHttpConnection}, {@link openDuplexConnection}).
 *
 * Refs: the refspecs choose which remote refs land where; each update is checked as git
 * does (fast-forward, or forced by `+`/`force`; tags never move unless forced), written in
 * its own ref transaction with its old value checked (`atomic`: one for all), and reported.
 * A rejected ref does not stop the others.
 *
 * Shallow: the client's shallow commits are sent, `depth`/`deepenSince`/`deepenNot`/
 * `unshallow` ask the server to cut (or extend) the history, and its `shallow`/`unshallow`
 * answer is written to the shallow file (`refStore.setShallow`) once the pack is in.
 *
 * Tags (`auto`): `include-tag` asks the server to send the tags of what it sends; tags whose
 * objects are then here are created. Remote tags that point at objects here but whose tag
 * objects are missing (a server that ignores `include-tag`) are fetched in a second round.
 *
 * Throws on protocol and transport errors; rejected refs are in the result, not thrown.
 */
export async function fetchFromConnection(
  connection: UploadPackConnection,
  options: FetchClientOptions,
): Promise<FetchClientResult> {
  const { repository, refStore } = options;
  const tags = options.tags ?? "auto";
  const given = options.refspecs ?? DEFAULT_FETCH_REFSPECS;
  const resolver = Array.isArray(given) ? undefined : (given as RefspecResolver);
  const withTagSpec = (specs: readonly string[]) =>
    tags === "all" ? [...specs, "refs/tags/*:refs/tags/*"] : [...specs];
  // git follows tags only when a refspec writes a ref (fetch.c: autotags); fetching
  // objects only (`git fetch <url> main`, or HEAD) creates no tag
  const writesRefs = (specs: readonly string[]) =>
    tags === "auto" &&
    specs.some((spec) => {
      const parsed = parseRefSpec(spec);
      return !parsed.negative && !!parsed.destination;
    });

  // shallow state and options
  const shallowBefore = (await refStore.getShallow?.()) ?? [];
  let depth = options.depth;
  if (options.unshallow) {
    if (shallowBefore.length === 0) {
      throw new Error("--unshallow on a complete repository does not make sense");
    }
    depth = INFINITE_DEPTH;
  }
  const deepenSince =
    options.deepenSince instanceof Date
      ? Math.floor(options.deepenSince.getTime() / 1000)
      : options.deepenSince;
  const deepen = depth !== undefined || deepenSince !== undefined || !!options.deepenNot?.length;
  if (deepen && !refStore.setShallow && !options.dryRun) {
    throw new Error("A shallow fetch needs a ref store that records shallow commits");
  }

  // the remote refs
  const listTags = resolver ? tags !== "none" : writesRefs(given as string[]) || tags === "all";
  const remoteRefs =
    connection.version === 2
      ? await lsRefs(connection, [
          "HEAD",
          ...(resolver ? resolver.prefixes : refPrefixes(withTagSpec(given as string[]))),
          ...(listTags ? ["refs/tags/"] : []),
        ])
      : [...(connection.advertisedRefs ?? [])];
  const head = remoteRefs.find((r) => r.name === "HEAD");
  const defaultBranch = head?.symref;
  const isEmpty = !remoteRefs.some((r) => r.oid);

  const refspecs = withTagSpec(resolver ? resolver.resolve(remoteRefs) : (given as string[]));
  const autoTags = writesRefs(refspecs);
  // git: a refspec naming a ref the remote does not have is an error (not for configured
  // refspecs, `missingRefsOk`, nor against an empty remote, where nothing can match)
  if (!options.missingRefsOk && !isEmpty) {
    const missing = missingSources(remoteRefs, refspecs);
    if (missing.length > 0) throw new TransportError(`couldn't find remote ref ${missing[0]}`);
  }
  const planned = mapRefs(remoteRefs, refspecs);
  const result: FetchClientResult = {
    protocolVersion: connection.version,
    remoteRefs,
    defaultBranch,
    isEmpty,
    refUpdates: [],
    followedTags: [],
    tagsNotFollowed: [],
    shallow: { before: shallowBefore, after: shallowBefore },
    imports: [],
    packObjects: 0,
    packBytes: 0,
    stats: { rounds: 0, haves: 0 },
  };

  const source = negotiatorSource(repository);
  // what is complete here: reachable from the local refs (git's mark_complete), not merely
  // present (an interrupted fetch leaves commits without their trees and blobs)
  const localTips = new Set<string>();
  for (const [, oid] of await refStore.listAll()) localTips.add(oid);
  const complete = new Completeness(repository, localTips);
  let shallow = shallowBefore;
  const runFetchPack = async (wants: string[], request: Partial<FetchPackRequest>) => {
    const knownCommon: string[] = [];
    for (const ref of remoteRefs) {
      if (ref.oid && !knownCommon.includes(ref.oid) && (await complete.isComplete(ref.oid))) {
        knownCommon.push(ref.oid);
      }
    }
    let update: ServerShallowUpdate = { shallow: [], unshallow: [] };
    const fetched = await fetchPack(connection, source, {
      wants,
      localTips,
      knownCommon,
      shallow,
      filter: options.filter,
      includeTag: autoTags,
      onProgress: options.onProgress,
      importPack: options.dryRun ? drainPack : (pack) => repository.importPack(pack),
      onShallowUpdate: (u) => {
        update = u;
        const changed = applyShallow(shallow, u) !== shallow;
        if (changed && !refStore.setShallow && !options.dryRun) {
          throw new Error("The server sent shallow commits this ref store cannot record");
        }
      },
      ...request,
    });
    // the pack is in (its trailer checked): the wants are complete now
    if (!options.dryRun) for (const want of wants) complete.addTip(want);
    result.imports.push(fetched.imported);
    result.packObjects += fetched.packObjects;
    result.packBytes += fetched.packBytes;
    result.stats.rounds += fetched.stats.rounds;
    result.stats.haves += fetched.stats.haves;
    const after = applyShallow(shallow, update);
    if (after !== shallow) {
      // checked against what this fetch read: a concurrent fetch's change is not lost
      if (!options.dryRun) await refStore.setShallow?.(after, shallow);
      shallow = after;
    }
  };

  // wants: the selected tips not here yet (all of them when deepening: their history changes)
  const wants: string[] = [];
  for (const p of planned) {
    if (wants.includes(p.oid)) continue;
    if (deepen || !(await complete.isComplete(p.oid))) wants.push(p.oid);
  }
  if (wants.length > 0) {
    await runFetchPack(wants, {
      depth,
      deepenRelative: options.deepenRelative,
      deepenSince,
      deepenNot: options.deepenNot,
    });
  }

  // tag auto-follow
  const followed: PlannedRef[] = [];
  if (autoTags) {
    const mapped = new Set(planned.map((p) => p.localRef));
    const candidates: RemoteRef[] = [];
    for (const ref of remoteRefs) {
      if (!ref.oid || !ref.name.startsWith("refs/tags/") || mapped.has(ref.name)) continue;
      if (await refStore.get(ref.name)) continue;
      candidates.push(ref);
    }
    const backfill: RemoteRef[] = [];
    for (const ref of candidates) {
      if (await complete.isComplete(ref.oid as string)) {
        followed.push({
          remoteRef: ref.name,
          localRef: ref.name,
          oid: ref.oid as string,
          force: false,
        });
      } else if (ref.peeled && ref.peeled !== ref.oid && (await complete.isComplete(ref.peeled))) {
        // an annotated tag of an object here, its tag object missing: fetch it
        backfill.push(ref);
      }
    }
    if (backfill.length > 0 && !connection.stateless && connection.version !== 2) {
      result.tagsNotFollowed = backfill.map((r) => r.name);
    } else if (backfill.length > 0) {
      const backfillWants = [...new Set(backfill.map((r) => r.oid as string))];
      await runFetchPack(backfillWants, {});
      for (const ref of backfill) {
        if (await complete.isComplete(ref.oid as string)) {
          followed.push({
            remoteRef: ref.name,
            localRef: ref.name,
            oid: ref.oid as string,
            force: false,
          });
        }
      }
    }
  }

  result.shallow.after = shallow;
  result.refUpdates = await planRefUpdates([...planned, ...followed], repository, refStore, {
    force: options.force,
  });
  result.followedTags = followed.map((p) => p.localRef as string);
  if (!options.dryRun) {
    await applyRefUpdates(result.refUpdates, refStore, {
      atomic: options.atomic,
      message: options.reflogMessage,
    });
  }
  return result;
}

/** `ls-refs` (protocol v2): the refs under `prefixes`, with symrefs, peeled tags, an unborn HEAD. */
export async function lsRefs(
  connection: UploadPackConnection,
  prefixes: string[],
): Promise<RemoteRef[]> {
  const caps = connection.capabilities;
  const body: Uint8Array[] = [encodePacketLine("command=ls-refs")];
  if (caps.has("agent")) body.push(encodePacketLine(`agent=${CLIENT_AGENT}`));
  if (caps.get("object-format") === "sha1") body.push(encodePacketLine("object-format=sha1"));
  body.push(encodeDelim());
  body.push(encodePacketLine("symrefs"));
  body.push(encodePacketLine("peel"));
  if ((caps.get("ls-refs") ?? "").split(" ").includes("unborn")) {
    body.push(encodePacketLine("unborn"));
  }
  for (const prefix of new Set(prefixes)) body.push(encodePacketLine(`ref-prefix ${prefix}`));
  body.push(encodeFlush());
  const pkts = await connection.request(body);
  const refs: RemoteRef[] = [];
  for (let line = await pkts.readLine(); line !== undefined; line = await pkts.readLine()) {
    const parts = line.split(" ");
    const [oid, name] = parts;
    if (!oid || !name) throw new TransportError(`Unexpected ls-refs line: ${line}`);
    const ref: RemoteRef = { name };
    if (oid !== "unborn") {
      if (!/^[0-9a-f]{40}$/.test(oid)) throw new TransportError(`Unexpected ls-refs line: ${line}`);
      ref.oid = oid;
    }
    for (const attr of parts.slice(2)) {
      if (attr.startsWith("symref-target:")) ref.symref = attr.slice(14);
      else if (attr.startsWith("peeled:")) ref.peeled = attr.slice(7);
    }
    refs.push(ref);
  }
  return refs;
}

/** The shallow file after the server's update (the same array when nothing changed). */
function applyShallow(before: string[], update: ServerShallowUpdate): string[] {
  if (update.shallow.length === 0 && update.unshallow.length === 0) return before;
  const set = new Set(before);
  for (const oid of update.shallow) set.add(oid);
  for (const oid of update.unshallow) set.delete(oid);
  const after = [...set].sort();
  const same = after.length === before.length && [...before].sort().every((o, i) => o === after[i]);
  return same ? before : after;
}

/** The local history as the negotiator reads it. */
function negotiatorSource(repository: RepositoryFacade): NegotiatorSource {
  const getCommitInfo = repository.getCommitInfo?.bind(repository);
  return {
    // without commit data only the ref tips themselves are offered
    getCommitInfo: getCommitInfo
      ? (oid) => getCommitInfo(oid)
      : async (oid) => ((await repository.has(oid)) ? { parents: [], time: 0 } : undefined),
    peelTag: repository.peelTag?.bind(repository),
  };
}

/** A dry run's "import": the pack is read to its end and dropped. */
async function drainPack(pack: AsyncIterable<Uint8Array>): Promise<PackImportResult> {
  for await (const _ of pack) {
    // dropped
  }
  return {
    objectsImported: 0,
    blobsWithDelta: 0,
    treesImported: 0,
    commitsImported: 0,
    tagsImported: 0,
  };
}
