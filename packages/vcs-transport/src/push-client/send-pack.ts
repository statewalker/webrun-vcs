/**
 * A whole push, as `git push` does it (git's transport.c, remote.c and send-pack.c): read the
 * remote refs, map the refspecs, decide each ref, send the commands and a thin pack, read the
 * report.
 */

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
  PackProtocolError,
  TransportError,
  ZERO_OID,
} from "../protocol/index.js";
import type { ReceivePackConnection } from "./connection.js";
import {
  type ForceWithLease,
  isPushSuccess,
  matchPushRefs,
  type PushObjectSource,
  type PushRefUpdate,
  pushSummary,
  refnameMatch,
  setPushStatus,
} from "./push-refs.js";

/** What a push sends, beyond the connection. */
export interface PushClientOptions {
  /** Where the objects come from (the pack) and the ancestry checks read */
  repository: RepositoryFacade;
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
  /** All refs or none (`--atomic`); the server must advertise `atomic` */
  atomic?: boolean;
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
}

/** What a push did. */
export interface PushClientResult {
  /** The remote refs advertised (before the push) */
  remoteRefs: RemoteRef[];
  /** Each remote ref the refspecs matched, with its status */
  updates: PushRefUpdate[];
  /** Whether every update succeeded (`ok` or `up-to-date`) and the pack was unpacked */
  ok: boolean;
  /** The server's `unpack` line (absent when no request was sent, or without report-status) */
  unpack?: { ok: boolean; message?: string };
  /** The capabilities asked for on the first command */
  capabilities: string[];
  /** Objects in the pack as sent (its header); 0 without a pack */
  packObjects: number;
  /** Bytes of the pack */
  packBytes: number;
  /** Bytes of the whole request (commands, options, pack) */
  bytesSent: number;
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
  const caps = connection.capabilities;
  if (options.atomic && !caps.has("atomic")) {
    throw new TransportError("the receiving end does not support --atomic push");
  }
  if (options.pushOptions?.length && !caps.has("push-options")) {
    throw new TransportError("the receiving end does not support push options");
  }
  const { repository, refStore } = options;
  const remoteRefs = [...connection.advertisedRefs];

  // the refs
  const localRefs = new Map<string, string>();
  for (const [name, oid] of await refStore.listAll()) {
    if (name.startsWith("refs/")) localRefs.set(name, oid);
  }
  const headOid = await refStore.get("HEAD");
  const headTarget = await refStore.getSymrefTarget?.("HEAD");
  const matched = await matchPushRefs(
    options.refspecs ?? [],
    {
      refs: localRefs,
      head: { oid: headOid, target: headTarget },
      hasObject: (oid) => repository.has(oid),
    },
    remoteRefs,
    { prune: options.prune },
  );
  const leases = new Map<string, string>();
  const lease = options.forceWithLease;
  if (lease) {
    for (const m of matched) {
      const entry =
        lease === true
          ? { ref: m.remoteRef }
          : lease.find((l) => l.ref === m.remoteRef || refnameMatch(l.ref, m.remoteRef));
      if (!entry) continue;
      const expect =
        entry.expect === undefined
          ? await options.trackingValue?.(m.remoteRef)
          : entry.expect || ZERO_OID;
      leases.set(m.remoteRef, expect ?? ZERO_OID);
    }
  }
  const updates = await setPushStatus(matched, objectSource(repository), {
    force: options.force,
    leases,
  });

  // what the server allows (send_pack)
  if (!caps.has("delete-refs")) {
    for (const u of updates) {
      if (u.status === "ok" && u.newOid === ZERO_OID) setStatus(u, "rejected-nodelete");
    }
  }
  const toSend = updates.filter((u) => u.status === "ok");
  if (options.atomic && updates.some((u) => !isPushSuccess(u.status))) {
    for (const u of toSend) setStatus(u, "atomic-push-failed");
    toSend.length = 0;
  }

  const requested: string[] = [];
  if (caps.has("report-status")) requested.push("report-status");
  if (caps.has("side-band-64k")) requested.push("side-band-64k");
  if (options.quiet && caps.has("quiet")) requested.push("quiet");
  if (options.atomic) requested.push("atomic");
  if (options.pushOptions?.length) requested.push("push-options");
  const objectFormat = caps.get("object-format");
  if (objectFormat !== undefined) requested.push(`object-format=${objectFormat || "sha1"}`);
  if (caps.has("agent")) requested.push(`agent=${CLIENT_AGENT}`);

  const result: PushClientResult = {
    remoteRefs,
    updates,
    ok: false,
    capabilities: requested,
    packObjects: 0,
    packBytes: 0,
    bytesSent: 0,
  };
  if (toSend.length === 0 || options.dryRun) {
    result.ok = updates.every((u) => isPushSuccess(u.status));
    return result;
  }

  // the request: commands, push options, the pack (none for deletes only)
  const head: Uint8Array[] = toSend.map((u, i) =>
    encodePacketLine(
      i === 0
        ? `${u.oldOid} ${u.newOid} ${u.remoteRef}\0${requested.join(" ")}\n`
        : `${u.oldOid} ${u.newOid} ${u.remoteRef}\n`,
    ),
  );
  head.push(encodeFlush());
  if (options.pushOptions?.length) {
    for (const option of options.pushOptions) head.push(encodePacketLine(`${option}\n`));
    head.push(encodeFlush());
  }
  const tips = [...new Set(toSend.filter((u) => u.newOid !== ZERO_OID).map((u) => u.newOid))];
  // the edges: every advertised tip (and `.have`) here, as send-pack feeds `^old` to
  // pack-objects; the receiver has their whole history
  const haves = new Set<string>();
  for (const oid of [...remoteRefs.map((r) => r.oid), ...connection.extraHaves]) {
    if (oid && oid !== ZERO_OID && !haves.has(oid) && (await repository.has(oid))) {
      haves.add(oid);
    }
  }
  const thin = (options.thin ?? true) && !caps.has("no-thin");
  const ofsDelta = caps.has("ofs-delta");
  const body = async function* (): AsyncGenerator<Uint8Array> {
    result.bytesSent = 0;
    result.packBytes = 0;
    result.packObjects = 0;
    for (const chunk of head) {
      result.bytesSent += chunk.length;
      yield chunk;
    }
    if (tips.length === 0) return;
    let header = new Uint8Array(0);
    for await (const chunk of repository.exportPack(new Set(tips), haves, { thin, ofsDelta })) {
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

  if (!caps.has("report-status")) {
    // git: without report-status every sent command is taken as done
    for (const u of toSend) setStatus(u, "ok");
    result.ok = updates.every((u) => isPushSuccess(u.status));
    return result;
  }
  const report = caps.has("side-band-64k")
    ? new PktStream(readSidebandPack(answer, options.onProgress))
    : answer;
  const first = await report.readLine();
  if (first === undefined || !first.startsWith("unpack ")) {
    throw new PackProtocolError(`unexpected report from receive-pack: ${first ?? "(none)"}`);
  }
  const unpackStatus = first.slice(7);
  result.unpack = unpackStatus === "ok" ? { ok: true } : { ok: false, message: unpackStatus };
  const reported = new Set<PushRefUpdate>();
  const byRef = new Map(toSend.map((u) => [u.remoteRef, u]));
  for (let line = await report.readLine(); line !== undefined; line = await report.readLine()) {
    if (line.startsWith("option ")) continue; // report-status-v2 (not asked for)
    let ref: string;
    let message: string | undefined;
    if (line.startsWith("ok ")) {
      ref = line.slice(3);
    } else if (line.startsWith("ng ")) {
      const rest = line.slice(3);
      const space = rest.indexOf(" ");
      ref = space < 0 ? rest : rest.slice(0, space);
      message = space < 0 ? "failed" : rest.slice(space + 1);
    } else {
      throw new PackProtocolError(`unexpected report line: ${line}`);
    }
    const update = byRef.get(ref);
    if (!update) continue; // git: a report of a ref not pushed is ignored
    reported.add(update);
    if (message === undefined) setStatus(update, "ok");
    else {
      update.message = message;
      setStatus(update, "remote-rejected");
    }
  }
  for (const u of toSend) if (!reported.has(u)) setStatus(u, "remote-failure");
  result.ok = result.unpack.ok && updates.every((u) => isPushSuccess(u.status));
  return result;
}

function setStatus(update: PushRefUpdate, status: PushRefUpdate["status"]): void {
  update.status = status;
  update.summary = pushSummary(update);
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
