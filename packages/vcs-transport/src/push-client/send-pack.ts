/**
 * A whole push, as `git push` does it (git's transport.c, remote.c and send-pack.c): read the
 * remote refs, map the refspecs, decide each ref, send the commands and a thin pack, read the
 * report.
 */

import { isHexObjectId } from "@statewalker/vcs-utils/hash";
import type { RepositoryFacade } from "../api/repository-facade.js";
import type { RefStore } from "../context/process-context.js";
import {
  CLIENT_AGENT,
  PktStream,
  type RemoteRef,
  readSidebandPack,
} from "../fetch-client/index.js";
import {
  encodeFlush,
  encodePacketLine,
  ObjectFormatMismatchError,
  TransportError,
} from "../protocol/index.js";
import { formatOf, isNullId } from "../protocol/object-format.js";
import { validSessionId } from "../protocol/session-id.js";
import { type AbbrevLengths, abbrevLengthsOf, transportSummaryWidth } from "../summary/index.js";
import type { ReceivePackConnection } from "./connection.js";
import {
  type FollowTagsSource,
  type ForceWithLease,
  isPushSuccess,
  matchPushRefs,
  type PushObjectSource,
  type PushRefReport,
  PushRefspecError,
  type PushRefUpdate,
  pushSummary,
  refnameMatch,
  setPushStatus,
} from "./push-refs.js";
import { pushSummaryIds } from "./push-status.js";
import { resolveRevision } from "./revision.js";

/** What a push sends, beyond the connection. */
export interface PushClientOptions {
  /** Where the objects come from (the pack) and the ancestry checks read */
  repository: RepositoryFacade;
  /**
   * The client's session id (git's `transfer.advertiseSID`): sent as `session-id=<id>` to a
   * receive-pack that advertises its own; undefined: none sent
   */
  sessionId?: string;
  /** The local refs (the refspec sources) */
  refStore: RefStore;
  /**
   * Refspecs, as `git push <remote> <refspec>…`: `[+]src[:dst]`, `:dst` (delete), `^src`
   * (exclude), patterns (`refs/heads/*:refs/heads/*`: `--all`; `refs/tags/*:refs/tags/*`:
   * `--tags`; `+refs/*:refs/*` with `prune`: `--mirror`), and `:` (matching branches). See
   * {@link matchPushRefs}. git's `push.default` (what an empty list would push) is the
   * caller's: no refspecs push nothing.
   */
  refspecs?: string[];
  /** Every update may be a non-fast-forward (`--force`) */
  force?: boolean;
  /**
   * `--force-with-lease`: `true` for every pushed ref (each expected at its remote-tracking
   * value, from `trackingValue`), or the refs to protect, each with its expected value
   */
  forceWithLease?: true | ForceWithLease[];
  /**
   * The remote-tracking value of a remote ref (`refs/remotes/origin/main` for
   * `refs/heads/main`), for a lease without its value; undefined: none (the lease then expects
   * the remote ref to be absent, as git)
   */
  trackingValue?: (remoteRef: string) => Promise<string | undefined>;
  /**
   * `--force-if-includes` (remote.c `check_if_includes_upstream`): asked for each leased ref
   * whose expected value is its remote-tracking value (`trackingValue` found one) and still
   * holds, with the remote's value; false refuses the ref as `rejected-remote-updated` ("remote
   * ref updated since checkout") unless forced. Ignored for leases with an explicit value.
   */
  includesRemote?: (remoteRef: string, remoteOid: string) => Promise<boolean>;
  /**
   * `--follow-tags` / `push.followTags`: also push the local annotated tags the remote lacks
   * that the pushed refs (or the remote's other refs) reach (remote.c `add_missing_tags`)
   */
  followTags?: boolean;
  /** All refs or none (`--atomic`); the server must advertise `atomic` */
  atomic?: boolean;
  /**
   * `--signed` / `push.gpgSign` (git's SEND_PACK_PUSH_CERT_*): `"always"` needs a server that
   * advertises `push-cert`, `"if-asked"` signs only for one that does (else warns and pushes
   * unsigned); undefined signs nothing. Push certificates cannot be signed here yet (no
   * signer): a push that must sign one fails ({@link PushCertificateError}) before any
   * command is sent, as git fails when gpg cannot sign.
   */
  signed?: "always" | "if-asked";
  /**
   * `--mirror` (see `MatchPushRefsOptions.mirror`): with `:` every local ref is pushed, and
   * every remote ref the refspecs leave out is deleted. git's `--mirror` also forces (`force`)
   */
  mirror?: boolean;
  /** Push options for the server's hooks (`-o`); the server must advertise `push-options` */
  pushOptions?: string[];
  /** Delete remote refs a pattern's destination covers whose local source is gone (`--prune`) */
  prune?: boolean;
  /**
   * Send a thin pack (default true, as git): deltas against objects the remote has (the
   * advertised tips here) stay out of the pack. Off when the server advertises `no-thin`.
   */
  thin?: boolean;
  /** Decide and report, but send nothing (`--dry-run`) */
  dryRun?: boolean;
  /** Ask the server for no progress (`quiet`, when advertised) */
  quiet?: boolean;
  /** Progress and hook messages from the server (side-band channel 2) */
  onProgress?: (message: string) => void;
  /**
   * `core.abbrev` as `parseCoreAbbrev` of vcs-core reads it: the length the summaries'
   * ids start from (-1, the default, for git's automatic length; 40 for full ids). Each is
   * lengthened until unique among the local objects (`RepositoryFacade.abbrevLengths`).
   */
  abbrev?: number;
  /**
   * git's pre-push hook (transport.c `run_pre_push_hook`): called with every update once
   * each has its status, before anything is sent (a dry run included); false refuses the
   * whole push, which then throws {@link PushRefusedByHookError}
   */
  prePush?: (updates: readonly PushRefUpdate[]) => Promise<boolean>;
}

/**
 * A push certificate that cannot be sent (send_pack): the server does not take one
 * (`unsupported`: `the receiving end does not support --signed push`) or it could not be
 * signed (`signing`: `failed to sign the push certificate`, after gpg's error). Nothing was
 * sent.
 */
export class PushCertificateError extends TransportError {
  constructor(
    message: string,
    readonly reason: "unsupported" | "signing",
  ) {
    super(message);
    this.name = "PushCertificateError";
  }
}

/** A push the pre-push hook refused (git: "failed to push some refs"): nothing was sent. */
export class PushRefusedByHookError extends TransportError {
  constructor(readonly updates: readonly PushRefUpdate[]) {
    super("the pre-push hook refused the push");
    this.name = "PushRefusedByHookError";
  }
}

/** What a push did. */
export interface PushClientResult {
  /** The remote refs advertised (before the push) */
  remoteRefs: RemoteRef[];
  /** receive-pack's `session-id` (its `transfer.advertiseSID`), as git's trace2 `server-sid` */
  serverSessionId?: string;
  /** Each remote ref the refspecs matched, with its status */
  updates: PushRefUpdate[];
  /** Whether every update succeeded (`ok` or `up-to-date`) and the pack was unpacked */
  ok: boolean;
  /** The server's `unpack` line (absent when no request was sent, or without report-status) */
  unpack?: { ok: boolean; message?: string };
  /**
   * Pushed over a stateless connection (smart HTTP): git's send-pack runs there as remote-curl's
   * helper, whose refused unpack does not fail `transport_push` (porcelain `Done` still printed)
   */
  stateless?: boolean;
  /**
   * The remote has no refs and nothing was pushed to it (send_pack's "No refs in common and
   * none specified; doing nothing."): nothing was sent, and the connection left at once
   */
  noRefsInCommon?: boolean;
  /** The capabilities asked for on the first command */
  capabilities: string[];
  /**
   * send_pack's warnings (`warning: not sending a push certificate since the receiving end
   * does not support --signed push`), in order
   */
  warnings?: string[];
  /** Objects in the pack as sent (its header); 0 without a pack */
  packObjects: number;
  /** Bytes of the pack */
  packBytes: number;
  /** Bytes of the whole request (commands, options, pack) */
  bytesSent: number;
  /**
   * The abbreviated length of each id the summaries show (git's find_unique_abbrev under
   * `core.abbrev`, against the local objects)
   */
  abbrevLengths: AbbrevLengths;
  /** git's `transport_summary_width` of the push: the width of the status column */
  summaryWidth: number;
  /**
   * git's error and warning lines of reading the server's report (receive_status: `error:
   * 'option' without a matching 'ok/ng' directive`, `warning: remote reported status on
   * unknown ref: <ref>`), in order
   */
  reportErrors?: string[];
  /**
   * The report broke git's rules (receive_status returned -1: an `option` line without its
   * `ok`): the push fails (git exits 1) whatever the refs' statuses say
   */
  reportFailed?: boolean;
}

/**
 * Runs a push over `connection` (see {@link openHttpReceivePackConnection},
 * {@link openDuplexReceivePackConnection}).
 *
 * The refspecs are mapped onto the advertised refs ({@link matchPushRefs}) and each update is
 * checked as git does ({@link setPushStatus}). Updates refused here are reported, not sent;
 * with `atomic` one refusal refuses all and nothing is sent. The commands carry the remote's
 * advertised values as old ids; the capabilities asked for are only advertised ones
 * (`report-status`, `side-band-64k`, `quiet`, `atomic`, `push-options`, `agent`,
 * `object-format`). The pack holds what the new values reach and no advertised tip that is
 * here does (thin unless the server says `no-thin`, OFS deltas when it says `ofs-delta`); a
 * push of deletes only sends no pack. The report (`unpack`, `ok`/`ng`, in side-band when asked)
 * sets each sent ref's final status.
 *
 * Throws on refspec errors ({@link PushRefspecError}), on `atomic`/`pushOptions` the server
 * does not support, and on transport and protocol errors; refused refs are in the result.
 */
export async function pushToConnection(
  connection: ReceivePackConnection,
  options: PushClientOptions,
): Promise<PushClientResult> {
  const result = await sendPack(connection, options);
  // the summaries as git prints them once the push is done: ids abbreviated against the
  // local objects, the column as wide as the longest pair
  const ids = pushSummaryIds(result.remoteRefs, result.updates);
  for (const u of result.updates) ids.push(u.oldOid, u.newOid);
  // the ids of the server's reports are abbreviated too (not measured for the column)
  for (const u of result.updates) {
    for (const r of u.reports ?? []) {
      if (r.oldOid) ids.push(r.oldOid);
      if (r.newOid) ids.push(r.newOid);
    }
  }
  const lengths = await abbrevLengthsOf(options.repository, ids, options.abbrev ?? -1);
  for (const u of result.updates) u.summary = pushSummary(u, lengths);
  result.abbrevLengths = lengths;
  result.summaryWidth = transportSummaryWidth(
    pushSummaryIds(result.remoteRefs, result.updates),
    lengths,
  );
  return result;
}

/**
 * The updates in the order of git's ref list after `match_push_refs`: the remote's refs as
 * advertised (sorted), then the refs the push creates in the order they were matched. git
 * feeds the pre-push hook and sends the commands in that order (so pre-receive's stdin and
 * the update hook calls follow it).
 */
function inRemoteRefOrder<T extends { remoteRef: string }>(
  updates: T[],
  remoteRefs: ReadonlyArray<{ name: string }>,
): T[] {
  const position = new Map<string, number>();
  remoteRefs.forEach((r, i) => {
    if (!position.has(r.name)) position.set(r.name, i);
  });
  const rank = (u: T) => position.get(u.remoteRef) ?? Number.MAX_SAFE_INTEGER;
  return updates
    .map((u, i) => ({ u, i }))
    .sort((a, b) => rank(a.u) - rank(b.u) || a.i - b.i)
    .map(({ u }) => u);
}

async function sendPack(
  connection: ReceivePackConnection,
  options: PushClientOptions,
): Promise<PushClientResult> {
  const caps = connection.capabilities;
  const { repository, refStore } = options;
  const remoteRefs = [...connection.advertisedRefs];
  // the ids the push sends are of the local repository's format (checked against the
  // server's below, as send_pack does)
  const format = formatOf(repository);
  const ZERO_OID = format.nullId;

  // the refs
  const localRefs = new Map<string, string>();
  for (const [name, oid] of await refStore.listAll()) {
    if (name.startsWith("refs/")) localRefs.set(name, oid);
  }
  const headOid = await refStore.get("HEAD");
  const headTarget = await refStore.getSymrefTarget?.("HEAD");
  const head = { oid: headOid, target: headTarget };
  const revision = (expr: string) => resolveRevision(expr, { refs: localRefs, head, repository });
  const matched = await matchPushRefs(
    options.refspecs ?? [],
    {
      refs: localRefs,
      head,
      hasObject: (oid) => repository.has(oid),
      resolveRevision: revision,
    },
    remoteRefs,
    {
      prune: options.prune,
      mirror: options.mirror,
      objectFormat: format,
      ...(options.followTags ? { followTags: followTagsSource(repository) } : {}),
    },
  );
  // leases (git's apply_cas): an entry naming the ref wins; one without a ref (or `true`)
  // covers every other pushed ref at its remote-tracking value
  const leases = new Map<string, string>();
  // --force-if-includes: the leased refs whose expectation is a remote-tracking value
  const fromTracking = new Set<string>();
  const lease = options.forceWithLease;
  if (lease) {
    const entries: ForceWithLease[] = lease === true ? [{}] : lease;
    const named = entries.filter((l) => l.ref !== undefined);
    const rest = entries.some((l) => l.ref === undefined);
    const expected = new Map<ForceWithLease, string>();
    for (const l of named) {
      // git: "cannot parse expected object name" before anything is sent
      if (l.expect === undefined || l.expect === "" || isNullId(l.expect)) continue;
      const oid = isHexObjectId(l.expect, format) ? l.expect : await revision(l.expect);
      if (!oid) throw new PushRefspecError(`cannot parse expected object name '${l.expect}'`);
      expected.set(l, oid);
    }
    for (const m of matched) {
      const entry = named.find(
        (l) => l.ref === m.remoteRef || refnameMatch(l.ref as string, m.remoteRef),
      );
      if (!entry && !rest) continue;
      const explicit = entry !== undefined && entry.expect !== undefined;
      const expect = explicit
        ? (expected.get(entry) ?? ZERO_OID)
        : await options.trackingValue?.(m.remoteRef);
      leases.set(m.remoteRef, expect ?? ZERO_OID);
      // check_reachable: only where remote_tracking found the value
      if (!explicit && expect !== undefined) fromTracking.add(m.remoteRef);
    }
  }
  // check_if_includes_upstream: a lease that holds must find the remote's value in the local
  // ref's reflog (a stale one is refused anyway)
  const unreachable = new Set<string>();
  if (options.includesRemote) {
    for (const m of matched) {
      if (!fromTracking.has(m.remoteRef) || leases.get(m.remoteRef) !== m.oldOid) continue;
      if (!(await options.includesRemote(m.remoteRef, m.oldOid))) unreachable.add(m.remoteRef);
    }
  }
  const updates = inRemoteRefOrder(
    await setPushStatus(matched, objectSource(repository), {
      force: options.force,
      leases,
      unreachable,
    }),
    remoteRefs,
  );
  if (options.prePush && !(await options.prePush(updates))) {
    throw new PushRefusedByHookError(updates);
  }
  // send_pack: a remote with no refs that nothing is pushed to (`git push <empty> :`): nothing
  // is sent, the connection is left at once
  if (remoteRefs.length === 0 && updates.length === 0) {
    return {
      remoteRefs,
      updates,
      ok: true,
      noRefsInCommon: true,
      capabilities: [],
      packObjects: 0,
      packBytes: 0,
      bytesSent: 0,
      abbrevLengths: new Map(),
      summaryWidth: transportSummaryWidth([]),
    };
  }
  // send_pack's server_supports_hash: a server naming no format speaks SHA-1
  const serverFormat = caps.get("object-format");
  if ((serverFormat || "sha1") !== format.name) {
    throw new ObjectFormatMismatchError(
      "the receiving end does not support this repository's hash algorithm",
    );
  }

  // send_pack: a push certificate for a server that takes one (its nonce advertised as
  // `push-cert=<nonce>`), else a refusal (always) or a warning (if-asked)
  const warnings: string[] = [];
  const pushCert = options.signed !== undefined && caps.has("push-cert");
  if (options.signed && !pushCert) {
    if (options.signed === "always") {
      throw new PushCertificateError(
        "the receiving end does not support --signed push",
        "unsupported",
      );
    } else {
      warnings.push(
        "warning: not sending a push certificate since the receiving end does not support --signed push",
      );
    }
  }

  // send_pack checks these after the hash and the push certificate
  if (options.atomic && !caps.has("atomic")) {
    throw new TransportError("the receiving end does not support --atomic push");
  }
  if (options.pushOptions?.length && !caps.has("push-options")) {
    throw new TransportError("the receiving end does not support push options");
  }

  // what the server allows (send_pack)
  if (!caps.has("delete-refs")) {
    for (const u of updates) {
      if (u.status === "ok" && isNullId(u.newOid)) setStatus(u, "rejected-nodelete");
    }
  }
  const toSend = updates.filter((u) => u.status === "ok");
  if (options.atomic && updates.some((u) => !isPushSuccess(u.status))) {
    for (const u of toSend) setStatus(u, "atomic-push-failed");
    toSend.length = 0;
  }
  // generate_push_cert signs only when a command is sent (update_seen), never in a dry run:
  // nothing signs one here yet, so such a push is refused as git refuses when gpg cannot sign
  if (pushCert && toSend.length > 0 && !options.dryRun) {
    throw new PushCertificateError("failed to sign the push certificate", "signing");
  }

  const requested: string[] = [];
  // report-status-v2 when the server offers it (the rewrites of its proc-receive hook), else
  // report-status (send-pack's status_report 2 and 1)
  const reportV2 = caps.has("report-status-v2");
  if (reportV2) requested.push("report-status-v2");
  else if (caps.has("report-status")) requested.push("report-status");
  if (caps.has("side-band-64k")) requested.push("side-band-64k");
  if (options.quiet && caps.has("quiet")) requested.push("quiet");
  if (options.atomic) requested.push("atomic");
  if (options.pushOptions?.length) requested.push("push-options");
  if (serverFormat !== undefined) requested.push(`object-format=${format.name}`);
  if (caps.has("agent")) requested.push(`agent=${CLIENT_AGENT}`);
  // transfer.advertiseSID, only to a server advertising its own (send_pack)
  if (options.sessionId !== undefined && caps.has("session-id")) {
    requested.push(`session-id=${options.sessionId}`);
  }
  const serverSid = validSessionId(caps.get("session-id"));

  const result: PushClientResult = {
    remoteRefs,
    ...(serverSid !== undefined ? { serverSessionId: serverSid } : {}),
    updates,
    ok: false,
    capabilities: requested,
    ...(warnings.length > 0 ? { warnings } : {}),
    packObjects: 0,
    packBytes: 0,
    bytesSent: 0,
    abbrevLengths: new Map(),
    summaryWidth: transportSummaryWidth([]),
  };
  if (toSend.length === 0 || options.dryRun) {
    result.ok = updates.every((u) => isPushSuccess(u.status));
    return result;
  }

  // the request: commands, push options, the pack (none for deletes only)
  // a shallow repository says where its history ends (send-pack's advertise_shallow_grafts),
  // and its pack stops there
  const shallow = (await refStore.getShallow?.()) ?? [];
  const request: Uint8Array[] = shallow.map((oid) => encodePacketLine(`shallow ${oid}\n`));
  const commands: Uint8Array[] = toSend.map((u, i) =>
    encodePacketLine(
      i === 0
        ? `${u.oldOid} ${u.newOid} ${u.remoteRef}\0${requested.join(" ")}\n`
        : `${u.oldOid} ${u.newOid} ${u.remoteRef}\n`,
    ),
  );
  request.push(...commands, encodeFlush());
  if (options.pushOptions?.length) {
    for (const option of options.pushOptions) request.push(encodePacketLine(`${option}\n`));
    request.push(encodeFlush());
  }
  const tips = [...new Set(toSend.filter((u) => !isNullId(u.newOid)).map((u) => u.newOid))];
  // the edges: every advertised tip (and `.have`) here, as send-pack feeds `^old` to
  // pack-objects; the receiver has their whole history
  const haves = new Set<string>();
  for (const oid of [...remoteRefs.map((r) => r.oid), ...connection.extraHaves]) {
    if (oid && !isNullId(oid) && !haves.has(oid) && (await repository.has(oid))) {
      haves.add(oid);
    }
  }
  const thin = (options.thin ?? true) && !caps.has("no-thin");
  const ofsDelta = caps.has("ofs-delta");
  const body = async function* (): AsyncGenerator<Uint8Array> {
    result.bytesSent = 0;
    result.packBytes = 0;
    result.packObjects = 0;
    for (const chunk of request) {
      result.bytesSent += chunk.length;
      yield chunk;
    }
    if (tips.length === 0) return;
    let header = new Uint8Array(0);
    const exportOptions = {
      thin,
      ofsDelta,
      ...(shallow.length > 0 ? { shallow: new Set(shallow) } : {}),
    };
    for await (const chunk of repository.exportPack(new Set(tips), haves, exportOptions)) {
      if (header.length < 12) {
        const joined = new Uint8Array(header.length + chunk.length);
        joined.set(header);
        joined.set(chunk, header.length);
        header = joined;
        if (header.length >= 12) {
          result.packObjects = new DataView(header.buffer, header.byteOffset).getUint32(8);
        }
      }
      result.packBytes += chunk.length;
      result.bytesSent += chunk.length;
      yield chunk;
    }
  };
  const answer = await connection.send(body);

  if (!reportV2 && !caps.has("report-status")) {
    // git: without report-status every sent command is taken as done
    for (const u of toSend) setStatus(u, "ok");
    result.ok = updates.every((u) => isPushSuccess(u.status));
    return result;
  }
  const report = caps.has("side-band-64k")
    ? new PktStream(readSidebandPack(answer, options.onProgress))
    : answer;
  // git's receive_status: a missing or unreadable unpack line is an error, the refs it did not
  // report stay "[remote failure] (remote failed to report status)"
  const first = await report.readLine();
  if (first === undefined) {
    result.unpack = {
      ok: false,
      message: "unexpected flush packet while reading remote unpack status",
    };
  } else if (!first.startsWith("unpack ")) {
    result.unpack = { ok: false, message: `unable to parse remote unpack status: ${first}` };
  } else {
    const unpackStatus = first.slice(7);
    result.unpack = unpackStatus === "ok" ? { ok: true } : { ok: false, message: unpackStatus };
  }
  if (connection.stateless) result.stateless = true;
  const reported = new Set<PushRefUpdate>();
  const byRef = new Map(toSend.map((u) => [u.remoteRef, u]));
  const unsent = new Set(updates.filter((u) => !toSend.includes(u)).map((u) => u.remoteRef));
  const reportErrors: string[] = [];
  // receive_status's error() for the unpack line
  if (!result.unpack.ok && first?.startsWith("unpack ")) {
    reportErrors.push(`error: remote unpack failed: ${result.unpack.message}`);
  }
  let optionWithoutStatus = false;
  // git's receive_status: the `option` lines after an `ok` add a report to that ref
  let hint: PushRefUpdate | undefined;
  let current: PushRefReport | undefined;
  let newReport = false;
  for (
    let line = first === undefined ? undefined : await report.readLine();
    line !== undefined;
    line = await report.readLine()
  ) {
    if (line.startsWith("option ")) {
      // git's error (once), the line ignored, the push failed
      if (!hint || !(current || newReport)) {
        if (!optionWithoutStatus) {
          reportErrors.push("error: 'option' without a matching 'ok/ng' directive");
        }
        optionWithoutStatus = true;
        result.reportFailed = true;
        continue;
      }
      if (newReport) {
        current = {};
        hint.reports = [...(hint.reports ?? []), current];
        newReport = false;
      }
      const rest = line.slice(7);
      const space = rest.indexOf(" ");
      const key = space < 0 ? rest : rest.slice(0, space);
      const val = space < 0 ? undefined : rest.slice(space + 1);
      // git's parse_oid_hex of the repository's format: an id at the start of the value
      const head = val?.slice(0, format.hexLength);
      const oid =
        head !== undefined && isHexObjectId(head.toLowerCase(), format)
          ? head.toLowerCase()
          : undefined;
      if (key === "refname") {
        if (val === undefined) delete current?.refName;
        else (current as PushRefReport).refName = val;
      } else if (key === "old-oid" && oid) (current as PushRefReport).oldOid = oid;
      else if (key === "new-oid" && oid) (current as PushRefReport).newOid = oid;
      else if (key === "forced-update") (current as PushRefReport).forcedUpdate = true;
      continue;
    }
    current = undefined;
    newReport = false;
    let ref: string;
    let message: string | undefined;
    if (line.startsWith("ok ")) {
      // `ok <ref> [<message>]`: the ref ends at a space
      const rest = line.slice(3);
      const space = rest.indexOf(" ");
      ref = space < 0 ? rest : rest.slice(0, space);
    } else if (line.startsWith("ng ")) {
      const rest = line.slice(3);
      const space = rest.indexOf(" ");
      ref = space < 0 ? rest : rest.slice(0, space);
      // git shows "failed" for an `ng` without a reason
      message = space < 0 ? "failed" : rest.slice(space + 1);
    } else {
      // git: "invalid ref status from remote"; what was not reported is a remote failure
      result.unpack = { ok: false, message: `invalid ref status from remote: ${line}` };
      break;
    }
    const update = byRef.get(ref);
    hint = update;
    if (!update) {
      // git warns of a report on a ref it did not send, and ignores it (the hint lost)
      reportErrors.push(
        unsent.has(ref)
          ? `warning: remote reported status on unexpected ref: ${ref}`
          : `warning: remote reported status on unknown ref: ${ref}`,
      );
      continue;
    }
    reported.add(update);
    if (message === undefined) {
      setStatus(update, "ok");
      newReport = true;
    } else {
      update.message = message;
      setStatus(update, "remote-rejected");
    }
  }
  for (const u of toSend) if (!reported.has(u)) setStatus(u, "remote-failure");
  if (caps.has("side-band-64k") && result.unpack.ok) {
    // git's demultiplexer reads the side-band to its end: what the server's hooks print
    // after the report (post-receive, post-update) reaches onProgress
    try {
      while ((await report.read()) !== undefined) {
        // channel 1 has nothing more; channel 2 goes to onProgress
      }
    } catch {
      // the report is in: a broken tail changes nothing
    }
  }
  if (reportErrors.length > 0) result.reportErrors = reportErrors;
  result.ok =
    result.unpack.ok && !result.reportFailed && updates.every((u) => isPushSuccess(u.status));
  return result;
}

function setStatus(update: PushRefUpdate, status: PushRefUpdate["status"]): void {
  update.status = status;
  update.summary = pushSummary(update);
}

/** What `--follow-tags` reads of the local objects (remote.c `add_missing_tags`). */
function followTagsSource(repository: RepositoryFacade): FollowTagsSource {
  const objects = objectSource(repository);
  return {
    async isTag(oid) {
      if (repository.getObjectType) return (await repository.getObjectType(oid)) === "tag";
      const peeled = await repository.peelTag?.(oid);
      return !!peeled && peeled !== oid;
    },
    peelToCommit: (oid) => objects.peelToCommit(oid),
    async reachableSubset(tips, commits) {
      const wanted = new Set(commits);
      const found = new Set<string>();
      const getCommitInfo = repository.getCommitInfo?.bind(repository);
      if (!getCommitInfo) {
        for (const tip of tips) {
          for await (const oid of repository.walkAncestors(tip)) {
            if (wanted.has(oid)) found.add(oid);
          }
        }
        return found;
      }
      // one walk from every tip, ending once each wanted commit was met
      const seen = new Set<string>(tips);
      const queue = [...seen];
      for (let i = 0; i < queue.length && found.size < wanted.size; i++) {
        const oid = queue[i];
        if (wanted.has(oid)) found.add(oid);
        const info = await getCommitInfo(oid);
        for (const parent of info?.parents ?? []) {
          if (seen.has(parent)) continue;
          seen.add(parent);
          queue.push(parent);
        }
      }
      return found;
    },
  };
}

/** The local objects, as the push decides with them (git's ref_newer, lookup_commit). */
export function objectSource(repository: RepositoryFacade): PushObjectSource {
  const getCommitInfo = repository.getCommitInfo?.bind(repository);
  return {
    has: (oid) => repository.has(oid),
    async peelToCommit(oid) {
      if (!getCommitInfo) return (await repository.has(oid)) ? oid : undefined;
      let current = oid;
      for (let depth = 0; depth < 32; depth++) {
        if (await getCommitInfo(current)) return current;
        const peeled = await repository.peelTag?.(current);
        if (!peeled || peeled === current) return undefined;
        current = peeled;
      }
      return undefined;
    },
    async isAncestor(ancestor, descendant) {
      if (ancestor === descendant) return true;
      if (!getCommitInfo) {
        for await (const oid of repository.walkAncestors(descendant)) {
          if (oid === ancestor) return true;
        }
        return false;
      }
      // breadth-first from the new value; the walk ends at the root commits
      const seen = new Set<string>([descendant]);
      const queue = [descendant];
      for (let i = 0; i < queue.length; i++) {
        const info = await getCommitInfo(queue[i]);
        if (!info) continue;
        for (const parent of info.parents) {
          if (parent === ancestor) return true;
          if (seen.has(parent)) continue;
          seen.add(parent);
          queue.push(parent);
        }
      }
      return false;
    },
  };
}
