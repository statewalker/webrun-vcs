/**
 * A whole fetch, as `git fetch` does it: list the remote refs, map them through refspecs,
 * negotiate and import the pack, keep the shallow file, follow tags, update the refs.
 */

import { compareRefNames, outgoingLinks } from "@statewalker/vcs-core";
import type { ProgressMonitor } from "@statewalker/vcs-utils";
import { type ObjectFormat, SHA1_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";
import type { PackImportResult, RepositoryFacade } from "../api/repository-facade.js";
import type { RefStore } from "../context/process-context.js";
import { INFINITE_DEPTH } from "../fsm/index.js";
import { encodeDelim, encodeFlush, encodePacketLine, TransportError } from "../protocol/index.js";
import { formatOf, isObjectIdOf, remoteObjectFormat } from "../protocol/object-format.js";
import {
  PROMISOR_REMOTE_CAPABILITY,
  type PromisorRemoteReply,
} from "../protocol/promisor-remote.js";
import { validSessionId } from "../protocol/session-id.js";
import { type AbbrevLengths, abbrevLengthsOf, transportSummaryWidth } from "../summary/index.js";
import { parseRefSpec } from "../utils/index.js";
import { Completeness } from "./completeness.js";
import type { RemoteRef, UploadPackConnection } from "./connection.js";
import { walkDumbHttp } from "./dumb-http.js";
import {
  checkReceivedPack,
  connectivityErrors,
  FetchCheckError,
  filterPromises,
  ReceivedLinks,
  ReceivedObjects,
  type ReceivedObjectsFsck,
} from "./fetch-checks.js";
import {
  CLIENT_AGENT,
  type FetchPackRequest,
  fetchPack,
  type NegotiationStats,
  negotiateUsingFetch,
  type ServerShallowUpdate,
  serverOptionLines,
  serverSupportsFilter,
} from "./fetch-pack.js";
import type { NegotiationAlgorithm, NegotiatorSource } from "./negotiator.js";
import { importPackfileUri } from "./packfile-uris.js";

/** git's default `transfer.unpackLimit`: a fetched pack of this many objects is kept as is. */
const DEFAULT_UNPACK_LIMIT = 100;

/**
 * Whether fetch-pack keeps (locks) a pack of `count` objects by its size: at least `limit`
 * objects (default 100), never with a limit of 0 (fetch-pack then leaves `do_keep` to
 * `--keep`).
 */
function keepsBySize(count: number, limit = DEFAULT_UNPACK_LIMIT): boolean {
  return limit > 0 && count >= limit;
}

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
  /**
   * Tags pointing at fetched objects even when no refspec writes a ref (remote.c's
   * `fetch_tags = 1`: a remote read from a `branches/` file)
   */
  | "auto-always"
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
  /**
   * Refspecs the remote refs the fetch took are also mapped through, to update their
   * remote-tracking refs too (git's opportunistic update: `git fetch origin main` also
   * writes `refs/remotes/origin/main` through `remote.origin.fetch`, or through
   * `--refmap`). These list no more refs, enable no tag following, and stay out of
   * {@link FetchClientResult.fetched} (FETCH_HEAD); a local ref the refspecs already
   * write is not written twice.
   */
  opportunisticRefspecs?: string[];
  /**
   * Called once the remote refs are listed and mapped, before any object is fetched or ref
   * written: where `git fetch --prune` deletes the stale remote-tracking refs, so a
   * renamed remote branch (`foo` to `foo/bar`) does not conflict with the old one. `refMap`
   * is git's ref map so far (get_ref_map): the refs the refspecs took, then the opportunistic
   * updates of those, each with the local ref it writes (where fetch refuses to update a
   * branch a worktree has checked out). With `atomic`, it may return the stale refs instead
   * of deleting them (`deletes`): they are deleted in the fetch's one ref transaction, as
   * git's prune_refs queues them into the `--atomic` transaction, so a refused update or a
   * failed transaction leaves them too. It may also return `completeTips`: object ids whose
   * whole history is here now (git clone's `clone_local` copies the source's objects after
   * listing its refs), counted as local tips, so the refs they name are written without
   * fetching anything.
   */
  /**
   * Called with the remote's object format (its `object-format` capability, SHA-1 without one)
   * once the remote refs are listed, before `beforeFetch` and before anything is fetched or
   * written: where git's clone initializes the new repository with the remote's hash. It may
   * throw to stop the fetch. A remote of another format than `repository`'s then fails the
   * fetch as git does ({@link ObjectFormatMismatchError}).
   */
  onRemoteObjectFormat?: (format: ObjectFormat) => void | Promise<void>;
  beforeFetch?: (
    remoteRefs: readonly RemoteRef[],
    refMap: readonly { remoteRef: string; localRef?: string }[],
  ) => Promise<{ deletes?: string[]; completeTips?: Iterable<string> } | undefined>;
  /** Tag following; default `auto` */
  tags?: TagMode;
  /**
   * Keep the received pack whatever its size (git's `TRANS_OPT_KEEP`: `git clone` keeps every
   * pack, where a fetch below `transfer.unpackLimit` objects unpacks it)
   */
  keepPack?: boolean;
  /**
   * fetch-pack's unpack limit (`fetch.unpackLimit`, else `transfer.unpackLimit`; default 100,
   * see `unpackLimitOf`): a pack of at least this many objects is kept, a smaller one unpacked
   * into loose objects; 0 unpacks every pack. A filtered or fsck-checked fetch
   * (`fsckObjects`) keeps its pack whatever its size, as git's index-pack takes those.
   */
  unpackLimit?: number;
  /**
   * The remote is a bundle (transport.c's `fetch_refs_from_bundle`, bundle.c's `unbundle`):
   * its pack goes through index-pack, so it is kept whatever its size. A filtered bundle's
   * (`filter`, its header's `@filter=`) is a promisor pack whose `.promisor` reads
   * `from-bundle` (`index-pack --promisor=from-bundle`); its absent objects pass the checks
   * only when `promised` (the repository has a promisor remote: check_connected's partial
   * clone case), else the check fails as git's rev-list does.
   */
  bundle?: { filter?: string; promised?: boolean };
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
  /**
   * Partial clone filter (`blob:none`). A server that does not take filters gets none
   * (`onWarning` hears git's "filtering not recognized by server, ignoring") and the fetch is
   * checked as a full one. A pack received under a filter is kept with a `.promisor` file
   * (the sought refs for a kept pack, as fetch-pack writes it); the new tips are checked as
   * `rev-list --exclude-promisor-objects` would, an absent object passing only when the
   * filter leaves out objects of its kind (`filterPromises`). Objects are never fetched
   * lazily: reading an absent blob fails.
   */
  filter?: string;
  /**
   * `git fetch --refetch`: every selected tip is wanted again and nothing local is offered
   * (fetch-pack's `refetch`: no `have`, no tip counted complete), so the whole history comes
   * again (under `filter`, what it keeps), as when the repository was cloned
   */
  refetch?: boolean;
  /** `fetch.negotiationAlgorithm`: which negotiator chooses the haves (default `consecutive`) */
  negotiationAlgorithm?: NegotiationAlgorithm;
  /**
   * `--negotiation-tip`: the only local commits the negotiator walks from (fetch-pack's
   * mark_tips), in place of every local ref; what is complete here still follows every ref
   */
  negotiationTips?: readonly string[];
  /** Warnings fetch-pack prints (`warning: ...`) */
  onWarning?: (line: string) => void;
  /** Allow every update to be a non-fast-forward (`--force`) */
  force?: boolean;
  /** Write all ref updates in one transaction, or none (`--atomic`) */
  atomic?: boolean;
  /**
   * Without `atomic`, write the ref updates in one batch that refuses each ref on its own
   * (git 2.5x's batched updates; see `applyRefUpdates`); default one batch per ref (2.43)
   */
  batchNonAtomic?: boolean;
  /**
   * Commit the ref transaction even when it holds no update, so the reference-transaction
   * hook hears an empty one (`preparing`, `prepared`, `committed`): git 2.5x's do_fetch
   * always commits its transaction, a dry run's and one whose every update was refused
   * included; git 2.43's only with `--atomic`. An `--atomic` fetch that refused an update
   * commits nothing.
   */
  emptyTransaction?: boolean;
  /**
   * Negotiate and download, but write no ref, no shallow change (`--dry-run`): the objects are
   * stored as git's dry run stores them, so each ref's update is told (fast-forward, forced,
   * rejected) as a real fetch tells it
   */
  dryRun?: boolean;
  /** Progress messages from the server */
  onProgress?: (message: string) => void;
  /**
   * The local side's progress: index-pack's "Receiving objects" and "Resolving deltas" of a
   * kept pack (`git fetch --progress`, `git clone --progress`)
   */
  progress?: ProgressMonitor;
  /** Reflog message of the ref updates */
  reflogMessage?: string;
  /**
   * The action of git's per-ref reflog messages, in place of `reflogMessage`: `fetch origin`
   * logs `fetch origin: fast-forward`, `storing head`, `forced-update` (git's update_local_ref)
   */
  reflogAction?: string;
  /** The identity of the reflog lines (`Name <email> 1700000000 +0000`) */
  reflogIdent?: string;
  /** Log none of the ref updates (`git clone` stores the remote's refs unlogged) */
  skipReflog?: boolean;
  /**
   * A clone (fetch-pack's `args->cloning`): the shallow commits of a shallow server (sent
   * without a deepen request) are recorded as they come, those the pack brought
   */
  cloning?: boolean;
  /**
   * `git fetch --update-shallow`: the shallow commits of a shallow server that the fetched
   * history needs are added to the shallow file, where without it each ref whose new history
   * needs one is rejected ("shallow roots are not allowed to be updated")
   */
  updateShallow?: boolean;
  /**
   * `git clone`'s write_remote_refs: the refs the refspecs map are written in one initial
   * transaction (`BatchOptions.initial`: packed-refs on a files store), then each followed
   * tag in a transaction of its own (write_followtags)
   */
  initialTransaction?: boolean;
  /**
   * `core.abbrev` as `parseCoreAbbrev` of vcs-core reads it: the length the summaries'
   * ids start from (-1, the default, for git's automatic length; 40 for full ids). Each is
   * lengthened until unique among the local objects (`RepositoryFacade.abbrevLengths`).
   */
  abbrev?: number;
  /**
   * `fetch.fsckObjects` (else `transfer.fsckObjects`): each received object is checked as git's
   * `index-pack --strict` checks it (the fsck itself is the caller's; vcs-commands builds it
   * from `fetch.fsck.<msg-id>` and `fetch.fsck.skipList`), and every object it names must have
   * come with the pack or be here. A refused pack leaves no object behind (it is imported into
   * a quarantine where the repository can keep one) and the fetch throws
   * {@link FetchCheckError} (`pack`).
   */
  fsckObjects?: ReceivedObjectsFsck;
  /**
   * Protocol v2 server options (`server-option=<option>` in `ls-refs` and every `fetch`
   * request: git's `--server-option`, `remote.<name>.serverOption`). Never sent over v0,
   * where the caller decides whether that is an error (git dies for command-line options).
   */
  serverOptions?: readonly string[];
  /**
   * `--reject-shallow` (fetch-pack's `reject_shallow_remote`): a shallow server (its shallow
   * commits sent without a deepen request) fails the fetch with
   * {@link ShallowRemoteRejectedError} before the pack is read
   */
  rejectShallow?: boolean;
  /**
   * The client's session id (git's `transfer.advertiseSID`): sent as `session-id=<id>` to a
   * server that advertises its own; undefined: none sent
   */
  sessionId?: string;
  /**
   * git's `fetch.uriProtocols`: the protocols packs may be downloaded over (protocol v2
   * `packfile-uris`; only `http` and `https` are asked for). The packs a server names are
   * downloaded after its own pack, kept, and checked to be what it said
   */
  uriProtocols?: readonly string[];
  /** Downloads those packs (default `globalThis.fetch`); never given the remote's credentials */
  packfileUriFetch?: (request: Request) => Promise<Response>;
  /**
   * The answer to a server's v2 `promisor-remote` capability (git 2.49+): asked in `ls-refs`,
   * whose request then names the accepted remotes, and again before the `fetch` command
   * (do_fetch_pack_v2). Undefined: the capability is ignored, as with git's
   * `promisor.acceptFromServer=None`.
   */
  promisorRemote?: PromisorRemoteReply;
}

/** A shallow remote refused under `rejectShallow` (git's "source repository is shallow"). */
export class ShallowRemoteRejectedError extends TransportError {
  constructor() {
    super("source repository is shallow, reject to clone.");
    this.name = "ShallowRemoteRejectedError";
  }
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
  /**
   * The server's `session-id` (advertised under its `transfer.advertiseSID`), as git's trace2
   * `server-sid`
   */
  serverSessionId?: string;
  /** The remote refs listed (heads, tags, and HEAD with its symref) */
  remoteRefs: RemoteRef[];
  /** The remote HEAD's branch (`refs/heads/main`), when the server says */
  defaultBranch?: string;
  /** Whether the remote has no refs at all */
  isEmpty: boolean;
  /** Each local ref written, or refused, with git's status */
  refUpdates: FetchRefUpdate[];
  /**
   * Every remote ref the fetch took, written to a local ref or not, in the order git lists
   * them in `FETCH_HEAD`: the refspec matches (refspec by refspec, remote order within one),
   * then the auto-followed tags (those of objects fetched or already here first, then the
   * ones found in the fetched history). See {@link formatFetchHead}.
   */
  fetched: FetchedRef[];
  /** Tags created by auto-follow (also in `refUpdates`) */
  followedTags: string[];
  /**
   * The followed tags found in the fetched history (git's backfill_tags), not those of
   * objects fetched or already here (which git lists with the refspecs' refs): git reports
   * their lines last
   */
  backfilledTags: string[];
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
  /**
   * The abbreviated length of each id the summaries show (git's find_unique_abbrev under
   * `core.abbrev`, against the local objects once the pack is in)
   */
  abbrevLengths: AbbrevLengths;
  /**
   * git's `transport_summary_width` of the fetch's ref map: the width of the summary column
   * (see `formatFetchDisplay`)
   */
  summaryWidth: number;
  /**
   * Why the one ref transaction of an `atomic` fetch failed, in git's words (the error it
   * prints after the ref lines: `'refs/remotes/origin/a' exists; cannot create
   * 'refs/remotes/origin/a/b'`); nothing was written. Absent otherwise.
   */
  refTransactionError?: string;
  /** The fsck warnings index-pack printed (`fsckObjects`), in its order */
  packCheckMessages?: string[];
}

/** A remote ref a fetch took (see {@link FetchClientResult.fetched}). */
export interface FetchedRef {
  /** The remote ref (`refs/heads/main`, `HEAD`, or an object id a refspec named) */
  remoteRef: string;
  /** The local ref it maps to; undefined for a refspec without destination */
  localRef?: string;
  /** Its value on the remote */
  oid: string;
  /**
   * Index of the refspec that selected it, among the refspecs fetched with (`tags: "all"`
   * adds `refs/tags/*:refs/tags/*` after them); undefined for a tag auto-follow took
   */
  refspec?: number;
  /**
   * Rejected because its history needs shallow commits of a shallow server that this
   * repository does not have as shallow (fetch-pack's REF_STATUS_REJECT_SHALLOW, without
   * `updateShallow`): neither written nor listed in `FETCH_HEAD`; git warns about it when it
   * would have been for merge
   */
  shallowRejected?: boolean;
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
 * objects are then here are created. The tags of objects already here are wanted with the
 * tips (git's find_non_local_tags). Remote tags of fetched objects whose tag objects did not
 * come (a server that ignores `include-tag`) are fetched in a second round, unless an update
 * was refused (git's backfill_tags, which a refusal skips).
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
    tags === "auto-always" ||
    (tags === "auto" &&
      specs.some((spec) => {
        const parsed = parseRefSpec(spec);
        return !parsed.negative && !!parsed.destination;
      }));

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
      ? await lsRefs(
          connection,
          [
            "HEAD",
            ...(resolver ? resolver.prefixes : refPrefixes(withTagSpec(given as string[]))),
            ...(listTags ? ["refs/tags/"] : []),
          ],
          connection.version === 2 ? options.serverOptions : undefined,
          options.promisorRemote,
        )
      : [...(connection.advertisedRefs ?? [])];
  const head = remoteRefs.find((r) => r.name === "HEAD");
  const defaultBranch = head?.symref;
  const isEmpty = !remoteRefs.some((r) => r.oid);

  const refspecs = withTagSpec(resolver ? resolver.resolve(remoteRefs) : (given as string[]));
  const autoTags = writesRefs(refspecs);
  // git: a refspec naming a ref the remote does not have is an error (not for configured
  // refspecs, `missingRefsOk`)
  if (!options.missingRefsOk) {
    const missing = missingSources(remoteRefs, refspecs);
    if (missing.length > 0) throw new TransportError(`couldn't find remote ref ${missing[0]}`);
  }
  const planned = mapRefs(remoteRefs, refspecs);
  const serverSid = validSessionId(connection.capabilities.get("session-id"));
  const result: FetchClientResult = {
    protocolVersion: connection.version,
    ...(serverSid !== undefined ? { serverSessionId: serverSid } : {}),
    remoteRefs,
    defaultBranch,
    isEmpty,
    refUpdates: [],
    fetched: planned.map(({ remoteRef, localRef, oid, refspec }) => ({
      remoteRef,
      localRef,
      oid,
      refspec,
    })),
    followedTags: [],
    backfilledTags: [],
    tagsNotFollowed: [],
    shallow: { before: shallowBefore, after: shallowBefore },
    imports: [],
    packObjects: 0,
    packBytes: 0,
    stats: { rounds: 0, haves: 0 },
    abbrevLengths: new Map(),
    summaryWidth: transportSummaryWidth([]),
  };

  // git's opportunistic update: the refs the refspecs took (not `--tags`), mapped through
  // the configured refspecs
  const tagSpecAt = tags === "all" ? refspecs.length - 1 : -1;
  const opportunistic = options.opportunisticRefspecs?.length
    ? mapRefs(
        planned
          .filter((p) => p.refspec !== undefined && p.refspec !== tagSpecAt)
          .map((p) => ({ name: p.remoteRef, oid: p.oid })),
        options.opportunisticRefspecs,
      )
        .filter((p) => p.localRef !== undefined)
        .map(({ refspec: _refspec, ...p }) => p)
    : [];

  // the remote's hash, as git's clone learns it from the handshake
  await options.onRemoteObjectFormat?.(
    remoteObjectFormat(connection.capabilities) ?? SHA1_OBJECT_FORMAT,
  );
  const before = options.beforeFetch
    ? await options.beforeFetch(remoteRefs, [...planned, ...opportunistic])
    : undefined;
  const deletes = (options.atomic && before?.deletes) || [];

  const source = negotiatorSource(repository);
  // what is complete here: reachable from the local refs (git's mark_complete), not merely
  // present (an interrupted fetch leaves commits without their trees and blobs)
  const localTips = new Set<string>();
  for (const [, oid] of await refStore.listAll()) localTips.add(oid);
  // the alternates' refs too: tips the negotiation offers and complete history (fetch-pack's
  // insert_alternate_refs and mark_alternate_complete)
  for (const oid of (await repository.alternateRefs?.()) ?? []) localTips.add(oid);
  for (const oid of before?.completeTips ?? []) localTips.add(oid);
  const complete = new Completeness(repository, localTips);
  let shallow = shallowBefore;
  let serverShallow: ServerShallowInfo | undefined;
  // index-pack's links check: with fsck (`--strict`), or for a clone without --depth
  // (`--check-self-contained-and-connected`); never for a partial clone's packs
  // the filter the server takes (fetch-pack drops one it does not, with a warning): its
  // objects are promised, so the checks below cannot walk them
  const filter = options.filter && serverSupportsFilter(connection) ? options.filter : undefined;
  // a filtered bundle's pack: a promisor pack of its own kind (`--promisor=from-bundle`)
  const bundleFilter = options.bundle?.filter;
  const strictLinks =
    !filter && !bundleFilter && (!!options.fsckObjects || options.cloning === true);
  /**
   * The refs a filtered round asked for (fetch-pack's `sought`), the lines of its pack's
   * `.promisor` file: `<id> <name>`, in the order the server listed them
   */
  let promisorSought: RemoteRef[] = [];
  /** Packs that named nothing outside themselves (a clone's check skips the tips they hold) */
  const selfContained: ReceivedObjects[] = [];
  /** The tips fetch-pack's own check of a deepening fetch covered */
  const deepenChecked = new Set<string>();
  const packMessages: string[] = [];
  let packFetched = false;
  /** The commits git has parsed (the skipping negotiator's dates), across fetch-pack rounds */
  let parsedCommits: Set<string> | undefined;
  const runFetchPack = async (wants: string[], request: Partial<FetchPackRequest>) => {
    if (connection.dumb) {
      // remote-curl's fetch_dumb: http-walker over the remote's files, objects stored as they
      // come (no quarantine, no index-pack checks); the refs are checked as any fetch's
      if (
        request.depth !== undefined ||
        request.deepenSince !== undefined ||
        (request.deepenNot?.length ?? 0) > 0
      ) {
        throw new TransportError(
          "fatal: dumb http transport does not support shallow capabilities",
        );
      }
      const walked = await walkDumbHttp(connection.dumb, {
        repository,
        wants,
        isComplete: (id) => complete.isComplete(id),
        ...(options.onWarning ? { onWarning: options.onWarning } : {}),
      });
      packFetched = true;
      for (const want of wants) complete.addTip(want);
      result.imports.push(...walked.imports);
      result.packObjects += walked.objects;
      result.packBytes += walked.bytes;
      return;
    }
    const knownCommon: string[] = [];
    for (const ref of options.refetch ? [] : remoteRefs) {
      if (ref.oid && !knownCommon.includes(ref.oid) && (await complete.isComplete(ref.oid))) {
        knownCommon.push(ref.oid);
      }
    }
    let update: ServerShallowUpdate = { shallow: [], unshallow: [] };
    // fetch-pack's shallow_info of a shallow server's commits sent without a deepen request
    // (v0: advertised after its refs; v2: a shallow-info without unshallow lines), split
    // before the pack comes into those here (and not shallow here) and those not here
    const deepening =
      request.depth !== undefined ||
      request.deepenSince !== undefined ||
      (request.deepenNot?.length ?? 0) > 0;
    if (connection.version === 0 && !deepening && connection.advertisedShallow?.length) {
      serverShallow = await shallowInfoOf(repository, connection.advertisedShallow, shallow);
      if (options.rejectShallow && serverShallow.ours.length + serverShallow.theirs.length > 0) {
        throw new ShallowRemoteRejectedError();
      }
    }
    const links = strictLinks && (!!options.fsckObjects || !deepening);
    const received =
      links || options.fsckObjects
        ? new ReceivedObjects(formatOf(repository).rawLength)
        : undefined;
    // the shallow commits index-pack is given (the shallow file as this fetch leaves it, and a
    // shallow server's): known once the shallow-info is in, before the pack's objects come
    const grafts = () =>
      new Set([...applyShallow(shallow, update), ...(serverShallow?.list ?? [])]);
    // the objects' links, read while the import holds them (index-pack's fsck_walk)
    const receivedLinks =
      received && links ? new ReceivedLinks(grafts, formatOf(repository).rawLength) : undefined;
    // a promisor pack's outgoing links (index-pack --promisor's repack_local_links)
    const outgoing = filter || bundleFilter ? new Set<string>() : undefined;
    if (options.negotiationAlgorithm === "skipping" && !parsedCommits) {
      parsedCommits = await parsedBeforeNegotiation(repository, remoteRefs, localTips, {
        refetch: !!options.refetch,
        deepen: deepening,
      });
    }
    await askPromisorRemote(connection, options.promisorRemote);
    const fetched = await fetchPack(connection, source, {
      wants,
      ...(repository.objectFormat ? { objectFormat: repository.objectFormat } : {}),
      localTips: options.refetch ? [] : (options.negotiationTips ?? localTips),
      knownCommon,
      ...(options.negotiationAlgorithm
        ? { negotiationAlgorithm: options.negotiationAlgorithm }
        : {}),
      ...(parsedCommits ? { parsedCommits } : {}),
      shallow,
      filter: options.filter,
      ...(options.onWarning ? { onWarning: options.onWarning } : {}),
      ...(options.serverOptions?.length ? { serverOptions: options.serverOptions } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.uriProtocols?.length ? { uriProtocols: options.uriProtocols } : {}),
      includeTag: autoTags,
      onProgress: options.onProgress,
      // a dry run stores the objects too (git's fetch_refs runs; only the refs are left)
      importPack: (pack, info) =>
        repository.importPack(pack, {
          // a filtered or checked pack goes through index-pack (`--promisor`, `--strict`), and
          // so does one beside packfile URIs: kept, never unpacked; otherwise
          // fetch.unpackLimit decides (0: always unpacked)
          ...(options.keepPack ||
          filter ||
          options.fsckObjects ||
          options.bundle ||
          info?.packfileUris
            ? { keepPack: true }
            : options.unpackLimit !== undefined
              ? {
                  unpackLimit:
                    options.unpackLimit === 0 ? Number.POSITIVE_INFINITY : options.unpackLimit,
                }
              : {}),
          ...(options.progress ? { progress: options.progress } : {}),
          // checked before anything sees them: a refused pack leaves no object behind
          ...(received
            ? { quarantine: true, onObject: (id, type, entry) => received.add(id, type, entry) }
            : {}),
          ...(receivedLinks || outgoing
            ? {
                onContent: (id, type, content) => {
                  receivedLinks?.add(id, type, content);
                  if (outgoing) for (const l of outgoingLinks(type, content)) outgoing.add(l);
                },
              }
            : {}),
        }),
      onShallowUpdate: async (u) => {
        if (
          connection.version === 2 &&
          !deepening &&
          u.unshallow.length === 0 &&
          u.shallow.length > 0
        ) {
          serverShallow = await shallowInfoOf(repository, u.shallow, shallow);
          if (
            options.rejectShallow &&
            serverShallow.ours.length + serverShallow.theirs.length > 0
          ) {
            throw new ShallowRemoteRejectedError();
          }
          return;
        }
        update = u;
        const changed = applyShallow(shallow, u) !== shallow;
        if (changed && !refStore.setShallow && !options.dryRun) {
          throw new Error("The server sent shallow commits this ref store cannot record");
        }
      },
      ...request,
    });
    // a ref asked for by name that moved since it was listed: its want is the id the server
    // sent (the pack holds that one), for the checks below and the completeness of the tips
    if (fetched.wantedRefs?.size) {
      // what the server sent: each name's answered id, and every id asked by `want <id>`;
      // an id two refs shared stays while one of them still names it
      const named = new Set((request.wantRefs ?? []).map((r) => r.oid));
      const sent = new Set(wants.filter((oid) => !named.has(oid)));
      for (const r of request.wantRefs ?? []) sent.add(fetched.wantedRefs.get(r.name) ?? r.oid);
      const kept = wants.filter((oid) => sent.has(oid));
      for (const oid of sent) if (!kept.includes(oid)) kept.push(oid);
      wants.splice(0, wants.length, ...kept);
    }
    const { quarantine, ...imported } = fetched.imported;
    // packfile URIs: the objects are split across packs, so index-pack checks objects only
    // (fetch-pack's `--fsck-objects` instead of `--strict`, no self-contained check)
    const uris = fetched.packfileUris ?? [];
    let committed = false;
    try {
      if (received) {
        // index-pack's --strict / --check-self-contained-and-connected
        const checked = await checkReceivedPack(quarantine?.repository ?? repository, received, {
          fsck: options.fsckObjects,
          links: links && uris.length === 0,
          ...(receivedLinks ? { receivedLinks } : {}),
          shallow: grafts(),
          // fetch-pack's do_keep (its lock on the pack), not whether index-pack ran: a
          // checked pack under the limit is index-pack's without --keep
          kept:
            imported.packId !== undefined &&
            (!!options.keepPack ||
              !!filter ||
              keepsBySize(fetched.packObjects, options.unpackLimit)),
        });
        packMessages.push(...checked.messages);
        if (links && uris.length === 0 && checked.selfContained) selfContained.push(received);
      }
      await quarantine?.commit();
      committed = true;
    } finally {
      // a refused pack (or any failure before the commit) leaves no object behind
      if (!committed) await quarantine?.discard().catch(() => {});
    }
    // fetch-pack's http-fetch of each packfile URI, after the pack, before the checks of the
    // refs (a dry run stores them too, as git's fetch_refs)
    for (const entry of uris) {
      // the server names the URI: ours downloads only over a protocol it asked for (git hands
      // any URI to curl)
      const asked = (options.uriProtocols ?? []).filter((p) => p === "http" || p === "https");
      if (!asked.some((p) => entry.uri.toLowerCase().startsWith(`${p}:`))) {
        throw new TransportError(
          `fatal: fetch-pack: packfile URI ${entry.uri} is not of a protocol asked for (${asked.join(",")})`,
        );
      }
      const fsck = options.fsckObjects;
      const objects = fsck ? new ReceivedObjects(formatOf(repository).rawLength) : undefined;
      const uriImport = await importPackfileUri(repository, entry, {
        ...(options.packfileUriFetch ? { fetchImpl: options.packfileUriFetch } : {}),
        ...(objects ? { onObject: (id, type, at) => objects.add(id, type, at) } : {}),
        ...(objects
          ? {
              check: async (target) => {
                const checked = await checkReceivedPack(target, objects, {
                  fsck,
                  links: false,
                  shallow: grafts(),
                  kept: true,
                });
                packMessages.push(...checked.messages);
              },
            }
          : {}),
      });
      result.imports.push(uriImport);
    }
    if (filter && imported.packId !== undefined) {
      // a promisor pack: index-pack `--promisor` writes an empty `.promisor`, which fetch-pack
      // replaces with the sought refs for a kept pack (`--keep`, or transfer.unpackLimit's 100
      // objects reached) when it locks the pack itself: not the `git fetch-pack` remote-curl
      // runs for smart HTTP v0, which is given no lock file
      const kept =
        (options.keepPack || keepsBySize(fetched.packObjects, options.unpackLimit)) &&
        !(connection.stateless && connection.version !== 2);
      const content = kept ? promisorSought.map((r) => `${r.oid} ${r.name}\n`).join("") : "";
      await repository.markPromisorPack?.(imported.packId, content);
      // git 2.48+: the local objects the pack links to go into a promisor pack of their own
      if (outgoing && outgoing.size > 0) await repository.repackLocalLinks?.(outgoing);
    } else if (bundleFilter && imported.packId !== undefined) {
      await repository.markPromisorPack?.(imported.packId, "from-bundle\n");
      if (outgoing && outgoing.size > 0) await repository.repackLocalLinks?.(outgoing);
    }
    packFetched = true;
    const after = applyShallow(shallow, update);
    // fetch-pack: a deepening fetch (not a clone) checks what it brought against the new
    // shallow commits, without `--not --all`, before the shallow file changes
    if (!options.dryRun && !options.cloning && deepening) {
      // a promisor pack's absent objects are promised (check_connected's partial clone case)
      const promised = filter ? filterPromises(filter) : undefined;
      const lines = await connectivityErrors(repository, wants, {
        known: [],
        shallow: new Set(after),
        deepening: true,
        ...(promised ? { promised } : {}),
      });
      if (lines) {
        throw new FetchCheckError(
          "deepen",
          [...lines, "error: remote did not send all necessary objects"],
          1,
        );
      }
      for (const want of wants) deepenChecked.add(want);
    }
    // the pack is in (its trailer checked): the wants are complete now
    // receive_wanted_refs: a ref asked for by name takes the id the server sent (it may have
    // moved since it was listed)
    for (const [name, oid] of fetched.wantedRefs ?? []) {
      for (const p of planned) if (p.remoteRef === name) p.oid = oid;
      for (const f of result.fetched) if (f.remoteRef === name) f.oid = oid;
      complete.addTip(oid);
    }
    for (const want of wants) complete.addTip(want);
    result.imports.push(imported);
    result.packObjects += fetched.packObjects;
    result.packBytes += fetched.packBytes;
    result.stats.rounds += fetched.stats.rounds;
    result.stats.haves += fetched.stats.haves;
    if (after !== shallow) {
      // checked against what this fetch read: a concurrent fetch's change is not lost
      if (!options.dryRun) await refStore.setShallow?.(after, shallow);
      shallow = after;
    }
  };

  // git's FETCH_HEAD lists first the tags of objects being fetched or already here (fetch.c
  // find_non_local_tags before the fetch), then those found in the fetched history (backfill)
  const tagsOfTips = new Set<string>();
  if (autoTags) {
    const plannedOids = new Set(planned.map((p) => p.oid));
    for (const ref of remoteRefs) {
      if (!ref.oid || !ref.name.startsWith("refs/tags/")) continue;
      const ids = ref.peeled && ref.peeled !== ref.oid ? [ref.oid, ref.peeled] : [ref.oid];
      for (const id of ids) {
        if (plannedOids.has(id) || (await repository.has(id))) {
          tagsOfTips.add(ref.name);
          break;
        }
      }
    }
  }

  // wants: the selected tips not here yet (all of them when deepening: their history changes)
  const wants: string[] = [];
  const wanted = new Set<string>();
  // the refs fetch-pack asks for by name (`want-ref`) where the server takes them: each
  // wanted ref listed by the remote (not an id a refspec names: git's exact_oid)
  const listedNames = new Set(remoteRefs.map((r) => r.name));
  const wantRefs: Array<{ name: string; oid: string }> = [];
  for (const p of planned) {
    if (wanted.has(p.oid)) {
      if (listedNames.has(p.remoteRef)) wantRefs.push({ name: p.remoteRef, oid: p.oid });
      continue;
    }
    if (deepen || options.refetch || !(await complete.isComplete(p.oid))) {
      wants.push(p.oid);
      wanted.add(p.oid);
      if (listedNames.has(p.remoteRef)) wantRefs.push({ name: p.remoteRef, oid: p.oid });
    }
  }
  // find_non_local_tags puts the tags of objects fetched or already here into the ref map
  // before the fetch: their tag objects come in the same round (a tag of a commit here is
  // not sent by include-tag), not in a second one
  if (autoTags) {
    const mapped = new Set(planned.map((p) => p.localRef));
    for (const ref of remoteRefs) {
      const oid = ref.oid;
      if (!oid || !tagsOfTips.has(ref.name) || mapped.has(ref.name) || wanted.has(oid)) {
        continue;
      }
      if (await refStore.get(ref.name)) continue;
      if (!(await complete.isComplete(oid))) {
        wants.push(oid);
        wanted.add(oid);
      }
    }
  }
  // do_fetch_pack sorts the remote's refs by name (HEAD first; a clone seeks the remote HEAD
  // too) and filter_refs keeps the sought ones in that order: the wants go out so, ids a
  // refspec names without a listed ref after them. upload-pack walks its wants in that order
  // (get_shallow_commits: a shallow server's shallow-info follows it)
  {
    const soughtNames = new Set([...planned.map((p) => p.remoteRef), ...tagsOfTips]);
    if (options.cloning) soughtNames.add("HEAD");
    const firstName = new Map<string, string>();
    for (const ref of remoteRefs) {
      if (!ref.oid || !soughtNames.has(ref.name)) continue;
      const known = firstName.get(ref.oid);
      if (known === undefined || compareRefNames(ref.name, known) < 0) {
        firstName.set(ref.oid, ref.name);
      }
    }
    wants.sort((a, b) => {
      const x = firstName.get(a);
      const y = firstName.get(b);
      if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
      return compareRefNames(x, y);
    });
  }
  // the refs fetch-pack was asked for (transport_fetch_refs: those not up to date here)
  const sought: PlannedRef[] = [];
  for (const p of planned) {
    if (!p.localRef || (await refStore.get(p.localRef)) !== p.oid) sought.push(p);
  }
  const shallowRejected = new Set<PlannedRef>();
  if (wants.length > 0) {
    // clone's mapped refs start with the remote HEAD (wanted_peer_refs)
    const soughtNames = new Set([...sought, ...opportunistic].map((p) => p.remoteRef));
    if (options.cloning) soughtNames.add("HEAD");
    promisorSought = remoteRefs.filter((r) => r.oid && soughtNames.has(r.name));
    // an id an exact-id refspec asks for too stays a `want <id>` (its ref may move)
    const exact = new Set(planned.filter((p) => !listedNames.has(p.remoteRef)).map((p) => p.oid));
    const byName = wantRefs.filter((r) => !exact.has(r.oid));
    await runFetchPack(wants, {
      ...(byName.length > 0 ? { wantRefs: byName } : {}),
      depth,
      deepenRelative: options.deepenRelative,
      deepenSince,
      deepenNot: options.deepenNot,
    });
    // fetch-pack's update_shallow for the shallow commits of a shallow server
    const info = serverShallow;
    serverShallow = undefined;
    if (info && !options.dryRun) {
      const recorded = await updateServerShallow(info, {
        repository,
        refStore,
        shallow,
        cloning: options.cloning === true,
        updateShallow: options.updateShallow === true,
        sought,
      });
      if (recorded.shallow !== shallow) {
        await refStore.setShallow?.(
          recorded.shallow,
          shallow,
          recorded.verbatim ? { verbatim: true } : undefined,
        );
        // a clone's file may name a commit twice; later rounds send each one once (grafts)
        shallow = recorded.verbatim ? [...new Set(recorded.shallow)].sort() : recorded.shallow;
      }
      for (const p of recorded.rejected) shallowRejected.add(p);
    }
  }
  if (shallowRejected.size > 0) {
    // neither written nor in FETCH_HEAD; fetch.c skips them in its summary
    for (let i = planned.length - 1; i >= 0; i--) {
      if (shallowRejected.has(planned[i] as PlannedRef)) planned.splice(i, 1);
    }
    for (let i = opportunistic.length - 1; i >= 0; i--) {
      const o = opportunistic[i] as PlannedRef;
      if ([...shallowRejected].some((p) => p.remoteRef === o.remoteRef)) opportunistic.splice(i, 1);
    }
    const rejectedKeys = new Set([...shallowRejected].map((p) => `${p.remoteRef}\0${p.localRef}`));
    for (const f of result.fetched) {
      if (rejectedKeys.has(`${f.remoteRef}\0${f.localRef}`)) f.shallowRejected = true;
    }
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
    // fetch.c do_fetch: a refused update (non-fast-forward, a tag it would clobber) ends the
    // fetch before backfill_tags: git makes no second round trip for them
    const refused =
      backfill.length > 0 &&
      (
        await planRefUpdates([...planned, ...followed, ...opportunistic], repository, refStore, {
          force: options.force,
        })
      ).some((u) => u.status === "rejected");
    if (refused || backfill.length === 0) {
      // nothing to backfill, or a refusal: the tags found in the fetched history are left
    } else if (!connection.stateless && connection.version !== 2) {
      result.tagsNotFollowed = backfill.map((r) => r.name);
    } else {
      const backfillWants = [...new Set(backfill.map((r) => r.oid as string))];
      promisorSought = backfill;
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
  // the summaries' ids, abbreviated against the objects here now (the pack is in): each
  // update's old and new value, and what transport_summary_width measures of git's ref map,
  // the refs the refspecs (and the configured ones) took and the tags of objects fetched or
  // here, each with its remote value and its (null) new one
  const inRefMap = [
    ...planned,
    ...opportunistic,
    ...followed.filter((p) => tagsOfTips.has(p.remoteRef)),
  ];
  const widthIds = inRefMap.flatMap((p) => [p.oid, formatOf(repository).nullId]);
  const abbrevIds = [...widthIds];
  for (const p of [...planned, ...followed, ...opportunistic]) {
    abbrevIds.push(p.oid);
    if (p.localRef) {
      const old = await refStore.get(p.localRef);
      if (old) abbrevIds.push(old);
    }
  }
  const lengths = await abbrevLengthsOf(repository, abbrevIds, options.abbrev ?? -1);
  result.abbrevLengths = lengths;
  result.summaryWidth = transportSummaryWidth(widthIds, lengths);
  result.refUpdates = await planRefUpdates(
    [...planned, ...followed, ...opportunistic],
    repository,
    refStore,
    {
      force: options.force,
      lengths,
    },
  );
  // fetch.c do_fetch: a ref update refused (update_local_ref: a non-fast-forward, a tag it
  // would clobber) ends the fetch before backfill_tags: the tags found in the fetched
  // history are neither written nor listed in FETCH_HEAD
  if (result.refUpdates.some((u) => u.status === "rejected")) {
    const dropped = new Set(
      followed.filter((p) => !tagsOfTips.has(p.remoteRef)).map((p) => p.localRef),
    );
    if (dropped.size > 0) {
      result.refUpdates = result.refUpdates.filter((u) => !dropped.has(u.localRef));
      for (let i = followed.length - 1; i >= 0; i--) {
        if (dropped.has((followed[i] as PlannedRef).localRef)) followed.splice(i, 1);
      }
    }
  }
  result.followedTags = followed.map((p) => p.localRef as string);
  result.backfilledTags = followed
    .filter((p) => !tagsOfTips.has(p.remoteRef))
    .map((p) => p.localRef as string);
  // each group by name, as find_non_local_tags lists them (a sorted string list)
  const byName = [...followed].sort((a, b) =>
    a.remoteRef < b.remoteRef ? -1 : a.remoteRef > b.remoteRef ? 1 : 0,
  );
  for (const first of [true, false]) {
    for (const p of byName) {
      if (tagsOfTips.has(p.remoteRef) !== first) continue;
      result.fetched.push({ remoteRef: p.remoteRef, localRef: p.localRef, oid: p.oid });
    }
  }
  if (packMessages.length > 0) result.packCheckMessages = packMessages;
  // git's check_connected before any ref is written: fetch's store_updated_refs over its ref
  // map (the refs a deepening fetch-pack checked aside), clone's update_remote_refs over the
  // refs it writes (those in a self-contained pack aside)
  if (packFetched) {
    const candidates = options.cloning
      ? planned.filter((p) => p.localRef !== undefined)
      : [...planned, ...opportunistic, ...followed];
    const tips: string[] = [];
    for (const p of candidates) {
      if (deepenChecked.has(p.oid)) continue;
      if (options.cloning && selfContained.some((pack) => pack.has(p.oid))) continue;
      tips.push(p.oid);
    }
    let lines: string[] | undefined;
    // a filtered bundle's absent objects are promised only in a repository with a promisor
    // remote (check_connected's --exclude-promisor-objects); elsewhere rev-list walks them
    const checkedFilter =
      filter ?? (bundleFilter && options.bundle?.promised ? bundleFilter : undefined);
    const promised = checkedFilter ? filterPromises(checkedFilter) : undefined;
    if (checkedFilter && !promised) {
      // a filter that may leave out commits or tags: their history cannot be walked; the
      // tips must have come
      for (const tip of tips) {
        if (!(await repository.has(tip))) {
          lines = [`fatal: bad object ${tip}`];
          break;
        }
      }
    } else if (promised) {
      // git's check_connected in a partial clone takes the tips found in a promisor pack and
      // fetches anything else lazily later; with no lazy fetch here, everything the new tips
      // reach is walked as rev-list --exclude-promisor-objects would, an absent object passing
      // only when it is of a kind the filter leaves out (a server that sends no trees for
      // blob:none is refused with rev-list's "bad tree object")
      lines = await connectivityErrors(repository, tips, {
        known: localTips,
        shallow: new Set(shallow),
        promised,
      });
    } else {
      lines = await connectivityErrors(repository, tips, {
        known: localTips,
        shallow: new Set(shallow),
      });
    }
    if (lines) throw new FetchCheckError("refs", lines, options.cloning ? 128 : 1);
  }
  if (!options.dryRun) {
    const failure = await applyRefUpdates(result.refUpdates, refStore, {
      atomic: options.atomic,
      ...(options.batchNonAtomic ? { batchNonAtomic: true } : {}),
      ...(options.emptyTransaction ? { emptyTransaction: true } : {}),
      deletes,
      message: options.reflogMessage,
      reflogAction: options.reflogAction,
      ident: options.reflogIdent,
      skipReflog: options.skipReflog,
      ...(options.initialTransaction
        ? {
            initial: new Set(
              [...planned, ...opportunistic].flatMap((p) => (p.localRef ? [p.localRef] : [])),
            ),
            initialEvenEmpty: !isEmpty,
          }
        : {}),
    });
    if (failure !== undefined) result.refTransactionError = failure;
  } else if (
    options.emptyTransaction &&
    !(options.atomic && result.refUpdates.some((u) => u.status === "rejected"))
  ) {
    // a dry run queues no update (s_update_ref), but do_fetch still commits its transaction
    await refStore.batch?.([], { emptyTransaction: true });
  }
  return result;
}

/** `ls-refs` (protocol v2): the refs under `prefixes`, with symrefs, peeled tags, an unborn HEAD. */
export async function lsRefs(
  connection: UploadPackConnection,
  prefixes: string[],
  /** `server-option=` lines sent after the capabilities (connect.c's get_remote_refs) */
  serverOptions?: readonly string[],
  /** The answer to the server's `promisor-remote` capability (send_capabilities) */
  promisorRemote?: PromisorRemoteReply,
): Promise<RemoteRef[]> {
  const caps = connection.capabilities;
  const body: Uint8Array[] = [encodePacketLine("command=ls-refs")];
  if (caps.has("agent")) body.push(encodePacketLine(`agent=${CLIENT_AGENT}`));
  // connect.c's send_capabilities: the server's format echoed (ls-refs never refuses another
  // one: ls-remote lists a SHA-256 remote from a SHA-1 repository); its ids are of that format
  const format = remoteObjectFormat(caps);
  if (!format) {
    throw new TransportError(
      `unknown object format '${caps.get("object-format")}' specified by server`,
    );
  }
  if (caps.has("object-format")) body.push(encodePacketLine(`object-format=${format.name}`));
  const info = caps.get(PROMISOR_REMOTE_CAPABILITY);
  if (info !== undefined && promisorRemote) {
    const reply = await promisorRemote(info);
    if (reply !== undefined) body.push(encodePacketLine(`promisor-remote=${reply}`));
  }
  body.push(...serverOptionLines(connection, serverOptions));
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
      if (!isObjectIdOf(oid, format)) throw new TransportError(`Unexpected ls-refs line: ${line}`);
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

/**
 * The v2 `bundle-uri` command (connect.c's `get_remote_bundle_uri`): the server's bundle list
 * as its `key=value` lines, in order. The capabilities are sent as for every v2 command
 * (`agent`, the server's `object-format`); the caller parses the lines (bundle-uri.c's
 * `bundle_uri_parse_line`).
 *
 * @throws TransportError when the server does not advertise `bundle-uri` (git dies there)
 */
export async function bundleUriLines(connection: UploadPackConnection): Promise<string[]> {
  const caps = connection.capabilities;
  if (!caps.has("bundle-uri")) {
    throw new TransportError("fatal: server does not support 'bundle-uri'");
  }
  const body: Uint8Array[] = [encodePacketLine("command=bundle-uri")];
  if (caps.has("agent")) body.push(encodePacketLine(`agent=${CLIENT_AGENT}`));
  const format = remoteObjectFormat(caps);
  if (!format) {
    throw new TransportError(
      `unknown object format '${caps.get("object-format")}' specified by server`,
    );
  }
  if (caps.has("object-format")) body.push(encodePacketLine(`object-format=${format.name}`));
  body.push(encodeDelim());
  body.push(encodeFlush());
  const pkts = await connection.request(body);
  const lines: string[] = [];
  for (let line = await pkts.readLine(); line !== undefined; line = await pkts.readLine()) {
    lines.push(line);
  }
  return lines;
}

/** The shallow file after the server's update (the same array when nothing changed). */
/**
 * do_fetch_pack_v2's call of promisor_remote_reply before a `fetch` (v2 only): the answer is
 * not sent, but the client's side effects (`promisor.storeFields`) happen again.
 */
async function askPromisorRemote(
  connection: UploadPackConnection,
  promisorRemote: PromisorRemoteReply | undefined,
): Promise<void> {
  if (connection.version !== 2 || !promisorRemote) return;
  const info = connection.capabilities.get(PROMISOR_REMOTE_CAPABILITY);
  if (info !== undefined) await promisorRemote(info);
}

function applyShallow(before: string[], update: ServerShallowUpdate): string[] {
  if (update.shallow.length === 0 && update.unshallow.length === 0) return before;
  const set = new Set(before);
  for (const oid of update.shallow) set.add(oid);
  for (const oid of update.unshallow) set.delete(oid);
  const after = [...set].sort();
  const same = after.length === before.length && [...before].sort().every((o, i) => o === after[i]);
  return same ? before : after;
}

/** What {@link fetchPromisedObjects} fetches, and where it goes. */
export interface FetchPromisedOptions {
  /** Where the pack goes (kept, marked as a promisor pack) */
  repository: RepositoryFacade;
  /** The objects to fetch, by id (git's `--stdin` refspecs of the lazy fetch) */
  ids: readonly string[];
  /** The filter of the fetch (git's lazy fetch passes `blob:none`) */
  filter?: string;
  /** The client's shallow commits, sent as `shallow` lines */
  shallow?: readonly string[];
  /** Progress messages from the server */
  onProgress?: (message: string) => void;
  /** Warnings fetch-pack prints */
  onWarning?: (line: string) => void;
  /**
   * `fetch.fsckObjects` / `transfer.fsckObjects` (`fetchFsckOf`): fetch-pack passes the
   * promisor fetch's index-pack `--fsck-objects`, which checks the objects, never their links
   */
  fsckObjects?: ReceivedObjectsFsck;
  /** The remote's URL, as git's check names it (`error: <url> did not send all ...`) */
  url?: string;
  /** git 2.43 prints an empty line after that error */
  compatibility?: "2.43" | "2.56";
  /** The answer to the server's `promisor-remote` capability (asked before the fetch) */
  promisorRemote?: PromisorRemoteReply;
  /**
   * The child fetch's `fetch.unpackLimit` (else `transfer.unpackLimit`; default 100): whether
   * fetch-pack keeps the promisor pack itself, which decides what its `.promisor` names
   */
  unpackLimit?: number;
}

/** What {@link fetchPromisedObjects} did. */
export interface FetchPromisedResult {
  /** The pack import's report */
  imported: PackImportResult;
  /** Objects in the pack as sent */
  packObjects: number;
  /** Bytes of the pack */
  packBytes: number;
}

/**
 * A partial clone's lazy fetch over `connection`, as the `git -c
 * fetch.negotiationAlgorithm=noop fetch <remote> --no-tags --no-write-fetch-head
 * --recurse-submodules=no --filter=blob:none --stdin` that promisor-remote.c runs: the ids
 * are wanted by id (no ref listing: every refspec is an exact id, and no tag is followed), no
 * `have` is sent (the noop negotiator), the pack is kept as a promisor pack (index-pack
 * `--promisor`; its `.promisor` file names the ids, `<id> <id>`, when fetch-pack keeps the
 * pack itself: 100 objects or more, not over smart HTTP v0), and no ref, FETCH_HEAD or
 * shallow file is written.
 *
 * @example
 * ```typescript
 * await fetchPromisedObjects(connection, { repository, ids: [blobId], filter: "blob:none" });
 * ```
 */
export async function fetchPromisedObjects(
  connection: UploadPackConnection,
  options: FetchPromisedOptions,
): Promise<FetchPromisedResult> {
  const { repository } = options;
  const wants = [...new Set(options.ids)];
  if (wants.length === 0) throw new Error("fetchPromisedObjects: nothing to fetch");
  const received = new ReceivedObjects(formatOf(repository).rawLength);
  const outgoing = new Set<string>();
  await askPromisorRemote(connection, options.promisorRemote);
  const fetched = await fetchPack(connection, negotiatorSource(repository), {
    wants,
    ...(repository.objectFormat ? { objectFormat: repository.objectFormat } : {}),
    localTips: [],
    shallow: [...(options.shallow ?? [])],
    ...(options.filter ? { filter: options.filter } : {}),
    ...(options.onWarning ? { onWarning: options.onWarning } : {}),
    includeTag: false,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    importPack: (pack) =>
      repository.importPack(pack, {
        keepPack: true,
        // checked before anything sees them: a pack without the wanted objects leaves none
        quarantine: true,
        onObject: (id, type, entry) => received.add(id, type, entry),
        onContent: (_id, type, content) => {
          for (const l of outgoingLinks(type, content)) outgoing.add(l);
        },
      }),
  });
  const { quarantine, ...imported } = fetched.imported;
  // fetch-pack keeps (locks) the pack itself at transfer.unpackLimit's 100 objects, not for the
  // `git fetch-pack` remote-curl runs for smart HTTP v0 (given no lock file)
  const kept =
    keepsBySize(fetched.packObjects, options.unpackLimit) &&
    !(connection.stateless && connection.version !== 2);
  let committed = false;
  try {
    if (options.fsckObjects) {
      // index-pack --fsck-objects: the objects only (a promisor pack's links are promised)
      await checkReceivedPack(quarantine?.repository ?? repository, received, {
        fsck: options.fsckObjects,
        links: false,
        shallow: new Set<string>(),
        kept,
      });
    }
    // the lazy fetch's check_connected: every wanted object came (a server that answered
    // with others fails the fetch, and the caller dies "could not fetch")
    const absent = wants.find((id) => !received.has(id));
    if (absent !== undefined) {
      throw new FetchCheckError(
        "refs",
        [
          // check_connected's rev-list dies on the first wanted object not there
          `fatal: bad revision '${absent}'`,
          `error: ${options.url ?? "remote"} did not send all necessary objects`,
          ...(options.compatibility === "2.43" ? [""] : []),
        ],
        1,
      );
    }
    await quarantine?.commit();
    committed = true;
  } finally {
    if (!committed) await quarantine?.discard().catch(() => {});
  }
  if (imported.packId !== undefined) {
    // from_promisor: index-pack --promisor, then the sought refs for a pack fetch-pack locks
    const content = kept ? wants.map((id) => `${id} ${id}\n`).join("") : "";
    await repository.markPromisorPack?.(imported.packId, content);
    // git 2.48+: the local objects the pack links to go into a promisor pack of their own
    if (outgoing.size > 0) await repository.repackLocalLinks?.(outgoing);
  }
  return { imported, packObjects: fetched.packObjects, packBytes: fetched.packBytes };
}

/** What {@link negotiateOnly} needs. */
export interface NegotiateOnlyOptions {
  /** The local history the negotiator walks */
  repository: RepositoryFacade;
  /** The `--negotiation-tip` commits */
  tips: readonly string[];
  negotiationAlgorithm?: NegotiationAlgorithm;
  /** The local shallow commits */
  shallow?: Iterable<string>;
  serverOptions?: readonly string[];
  sessionId?: string;
}

/**
 * `git fetch --negotiate-only --negotiation-tip=<tip>...`: negotiates over `connection`
 * (protocol v2 with `wait-for-done`, else {@link NegotiateOnlyUnsupportedError}) and returns
 * the commits the server acknowledged, fetching nothing and writing nothing.
 *
 * @example
 * ```typescript
 * const common = await negotiateOnly(connection, { repository, tips: [headId] });
 * ```
 */
export async function negotiateOnly(
  connection: UploadPackConnection,
  options: NegotiateOnlyOptions,
): Promise<string[]> {
  const { repository } = options;
  return negotiateUsingFetch(connection, negotiatorSource(repository), {
    tips: options.tips,
    ...(options.negotiationAlgorithm ? { negotiationAlgorithm: options.negotiationAlgorithm } : {}),
    ...(options.shallow ? { shallow: options.shallow } : {}),
    ...(repository.objectFormat ? { objectFormat: repository.objectFormat } : {}),
    ...(options.serverOptions?.length ? { serverOptions: options.serverOptions } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
  });
}

/**
 * The commits git has parsed when fetch-pack's negotiation starts (mark_complete_and_common_ref
 * and mark_tips): the remote refs here that are commits, the commits the local refs peel to,
 * and the parents of every commit `mark_recent_complete_commits` pops (reachable from the
 * local refs, newest first, while not older than the newest remote ref here). None of it for
 * `--refetch`, and only the remote refs for a deepening fetch.
 */
async function parsedBeforeNegotiation(
  repository: RepositoryFacade,
  remoteRefs: readonly RemoteRef[],
  localTips: Iterable<string>,
  options: { refetch: boolean; deepen: boolean },
): Promise<Set<string>> {
  const parsed = new Set<string>();
  if (options.refetch) return parsed;
  const info = async (oid: string) =>
    (await repository.has(oid)) ? await repository.getCommitInfo?.(oid) : undefined;
  let cutoff = 0;
  for (const ref of remoteRefs) {
    if (!ref.oid || parsed.has(ref.oid)) continue;
    const commit = await info(ref.oid);
    if (!commit) continue;
    parsed.add(ref.oid);
    if (!cutoff || cutoff < commit.time) cutoff = commit.time;
  }
  if (options.deepen) return parsed;
  const queue: { oid: string; time: number }[] = [];
  const queued = new Set<string>();
  for (const tip of localTips) {
    let id = tip;
    for (let i = 0; i < 16; i++) {
      const target = await repository.peelTag?.(id);
      if (!target || target === id) break;
      id = target;
    }
    const commit = await info(id);
    if (!commit) continue;
    parsed.add(id);
    if (!queued.has(id)) {
      queued.add(id);
      queue.push({ oid: id, time: commit.time });
    }
  }
  if (!cutoff) return parsed;
  while (queue.length > 0) {
    let best = 0;
    for (let i = 1; i < queue.length; i++) {
      if ((queue[i] as { time: number }).time > (queue[best] as { time: number }).time) best = i;
    }
    const top = queue[best] as { oid: string; time: number };
    if (top.time < cutoff) break;
    queue.splice(best, 1);
    for (const parent of (await info(top.oid))?.parents ?? []) {
      const commit = await info(parent);
      if (!commit) continue;
      parsed.add(parent);
      if (!queued.has(parent)) {
        queued.add(parent);
        queue.push({ oid: parent, time: commit.time });
      }
    }
  }
  return parsed;
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

/** fetch-pack's shallow_info: a shallow server's commits, split as prepare_shallow_info does. */
interface ServerShallowInfo {
  /** As the server sent them */
  list: string[];
  /** Here before the pack, and not shallow here */
  ours: string[];
  /** Not here before the pack */
  theirs: string[];
}

async function shallowInfoOf(
  repository: RepositoryFacade,
  list: readonly string[],
  ownShallow: readonly string[],
): Promise<ServerShallowInfo> {
  const own = new Set(ownShallow);
  const ours: string[] = [];
  const theirs: string[] = [];
  for (const oid of list) {
    if (!(await repository.has(oid))) theirs.push(oid);
    else if (!own.has(oid)) ours.push(oid);
  }
  return { list: [...list], ours, theirs };
}

/**
 * fetch-pack's update_shallow for a shallow server's commits once the pack is in: a clone
 * records those the pack brought; otherwise, of those not here before, the ones the pack
 * brought count (remove_nonexistent_theirs_shallow), and the sought refs are painted down
 * (assign_shallow_commits_to_refs: walking down from each ref, stopping at the local refs'
 * tips and at those commits). A commit counts when a ref paints it and it was not here
 * before, or it was here before and no local ref reaches it (post_assign_shallow). With
 * `updateShallow` only the commits that count are recorded (none: the file stays), else
 * each sought ref that paints one is rejected. Returns the shallow file to write and the
 * rejected refs.
 */
async function updateServerShallow(
  info: ServerShallowInfo,
  context: {
    repository: RepositoryFacade;
    refStore: RefStore;
    shallow: string[];
    cloning: boolean;
    updateShallow: boolean;
    sought: readonly PlannedRef[];
  },
): Promise<{ shallow: string[]; rejected: PlannedRef[]; verbatim?: boolean }> {
  const { repository, refStore } = context;
  const unchanged = { shallow: context.shallow, rejected: [] as PlannedRef[] };
  const record = (extra: readonly string[]) => {
    const after = applyShallow(context.shallow, { shallow: [...extra], unshallow: [] });
    if (after !== context.shallow && !refStore.setShallow) {
      throw new Error("The server sent shallow commits this ref store cannot record");
    }
    return { shallow: after, rejected: [] as PlannedRef[] };
  };
  if (info.list.length === 0) return unchanged;
  if (context.cloning) {
    // a clone: any shallow commit the pack brought (nothing was here before), written as
    // setup_alternate_shallow writes the `extra` array: in the order sent, a commit sent twice
    // (get_shallow_commits names one per want reaching it) on two lines
    const extra: string[] = [];
    for (const oid of info.list) if (await repository.has(oid)) extra.push(oid);
    if (extra.length === 0) return unchanged;
    if (!refStore.setShallow) {
      throw new Error("The server sent shallow commits this ref store cannot record");
    }
    return { shallow: extra, rejected: [], verbatim: true };
  }
  if (info.ours.length === 0 && info.theirs.length === 0) return unchanged;
  const theirs: string[] = [];
  for (const oid of info.theirs) if (await repository.has(oid)) theirs.push(oid);
  if (info.ours.length === 0 && theirs.length === 0) return unchanged;

  const assigned = await assignShallowToRefs(repository, refStore, context.shallow, {
    ours: info.ours,
    theirs,
    sought: context.sought,
  });
  // without the commit graph nothing can be checked: every sought ref is refused
  if (!assigned) return { shallow: context.shallow, rejected: [...context.sought] };
  if (!context.updateShallow) return { shallow: context.shallow, rejected: assigned.rejected };
  const kept = [...assigned.ours, ...assigned.theirs];
  return kept.length > 0 ? record(kept) : unchanged;
}

/**
 * shallow.c's assign_shallow_commits_to_refs with post_assign_shallow: paints the shallow
 * server's commits from the sought refs' new tips (stopping at the local refs' tips and at
 * those commits), keeps the painted `theirs` and the painted `ours` no local ref reaches
 * (in_merge_bases_many), and names the refs painting a kept one. Undefined without the
 * commit graph.
 */
async function assignShallowToRefs(
  repository: RepositoryFacade,
  refStore: RefStore,
  ownShallow: readonly string[],
  input: { ours: readonly string[]; theirs: readonly string[]; sought: readonly PlannedRef[] },
): Promise<{ ours: string[]; theirs: string[]; rejected: PlannedRef[] } | undefined> {
  const getCommitInfo = repository.getCommitInfo?.bind(repository);
  if (!getCommitInfo) return undefined;
  const own = new Set(ownShallow);
  const parentsOf = async (oid: string) =>
    own.has(oid) ? [] : ((await getCommitInfo(oid))?.parents ?? []);
  const peel = async (oid: string) => {
    let id = oid;
    for (let i = 0; i < 16 && repository.peelTag; i++) {
      const next = await repository.peelTag(id);
      if (!next || next === id) break;
      id = next;
    }
    return (await getCommitInfo(id)) ? id : undefined;
  };
  const localTips = new Set<string>();
  for (const [, oid] of await refStore.listAll()) {
    const commit = await peel(oid);
    if (commit) localTips.add(commit);
  }
  const oursSet = new Set(input.ours);
  const theirsSet = new Set(input.theirs);
  // the commits the local refs reach (in_merge_bases_many), walked once when first needed
  let reachable: Set<string> | undefined;
  const reachedLocally = async (oid: string) => {
    if (!reachable) {
      reachable = new Set();
      const stack = [...localTips];
      while (stack.length > 0) {
        const c = stack.pop() as string;
        if (reachable.has(c)) continue;
        reachable.add(c);
        stack.push(...(await parentsOf(c)));
      }
    }
    return reachable.has(oid);
  };
  const keptOurs = new Set<string>();
  const keptTheirs = new Set<string>();
  const rejected: PlannedRef[] = [];
  for (const ref of input.sought) {
    const tip = await peel(ref.oid);
    if (!tip) continue;
    let needs = false;
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const c = stack.pop() as string;
      if (seen.has(c) || localTips.has(c)) continue;
      seen.add(c);
      if (theirsSet.has(c)) {
        keptTheirs.add(c);
        needs = true;
      } else if (oursSet.has(c)) {
        if (!(await reachedLocally(c))) {
          keptOurs.add(c);
          needs = true;
        }
      } else stack.push(...(await parentsOf(c)));
    }
    if (needs) rejected.push(ref);
  }
  return {
    ours: input.ours.filter((oid) => keptOurs.has(oid)),
    theirs: input.theirs.filter((oid) => keptTheirs.has(oid)),
    rejected,
  };
}
