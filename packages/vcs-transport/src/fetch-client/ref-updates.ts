/**
 * Which local refs a fetch writes, and whether it may (git's update_local_ref).
 */

import type { RepositoryFacade } from "../api/repository-facade.js";
import type { RefStore } from "../context/process-context.js";
import type { RefSpec } from "../protocol/index.js";
import { expandFromSource, matchSource, parseRefSpec } from "../utils/index.js";
import type { RemoteRef } from "./connection.js";

/** How a fetched ref was (or was not) written. */
export type FetchRefStatus =
  /** The local ref did not exist */
  | "new"
  /** The local ref already had the fetched value */
  | "up-to-date"
  /** The old value is an ancestor of the new one */
  | "fast-forward"
  /** Not a fast-forward, written because the refspec (or the fetch) forces it */
  | "forced"
  /** Not written: see `reason` */
  | "rejected";

/** One local ref a fetch updated, or refused to. */
export interface FetchRefUpdate {
  /** The remote ref it comes from */
  remoteRef: string;
  /** The local ref written */
  localRef: string;
  /** Its value before the fetch */
  oldOid?: string;
  /** The fetched value */
  newOid: string;
  status: FetchRefStatus;
  /**
   * Why a ref was rejected: `non-fast-forward`, `would clobber existing tag`, or the ref
   * store's refusal (`mismatch` when the ref changed meanwhile, `locked`, …).
   */
  reason?: string;
  /** How git prints it: `[new branch]`, `[new tag]`, `abc1234..def5678`, `+ abc1234...def5678`, `[rejected]`, `[up to date]` */
  summary: string;
}

/** A remote ref mapped by a refspec to a local one. */
export interface PlannedRef {
  remoteRef: string;
  /** undefined: a refspec without destination (the objects are fetched, no ref is written) */
  localRef?: string;
  oid: string;
  force: boolean;
  /** Index of the refspec that selected it in the list {@link mapRefs} got */
  refspec?: number;
}

/**
 * The remote refs `refspecs` select, with their local names (git's get_ref_map). Negative
 * refspecs (`^refs/heads/wip`) exclude; a source that is not a full ref name is looked up as
 * git does (`main` → `refs/heads/main`, …); a source that is an object id is fetched as is.
 */
export function mapRefs(
  remoteRefs: readonly RemoteRef[],
  refspecs: readonly string[],
): PlannedRef[] {
  const specs = refspecs.map(parseRefSpec);
  const negative = specs.filter((s) => s.negative);
  const excluded = (name: string) => negative.some((s) => s.source && matchSource(s, name));
  const byName = new Map(remoteRefs.map((r) => [r.name, r]));
  const planned: PlannedRef[] = [];
  const seen = new Set<string>();
  // git's ref_remove_duplicates: a ref fetched without destination is listed each time
  const add = (p: PlannedRef) => {
    if (p.localRef !== undefined) {
      const key = `${p.remoteRef}\0${p.localRef}`;
      if (seen.has(key)) return;
      seen.add(key);
    }
    planned.push(p);
  };
  for (const [index, spec] of specs.entries()) {
    if (spec.negative || !spec.source) continue;
    if (spec.wildcard) {
      for (const ref of remoteRefs) {
        if (!ref.oid || !matchSource(spec, ref.name) || excluded(ref.name)) continue;
        add({
          remoteRef: ref.name,
          localRef: expandFromSource(spec, ref.name).destination ?? undefined,
          oid: ref.oid,
          force: spec.force,
          refspec: index,
        });
      }
      continue;
    }
    if (/^[0-9a-f]{40}$/.test(spec.source)) {
      add({
        remoteRef: spec.source,
        localRef: spec.destination ?? undefined,
        oid: spec.source,
        force: spec.force,
        refspec: index,
      });
      continue;
    }
    const ref = dwimRef(spec, byName);
    if (!ref?.oid || excluded(ref.name)) continue;
    add({
      remoteRef: ref.name,
      localRef: spec.destination ?? undefined,
      oid: ref.oid,
      force: spec.force,
      refspec: index,
    });
  }
  return planned;
}

/**
 * The sources of `refspecs` the remote does not have: exact (not wildcard, not an object id,
 * not negative) sources that name no remote ref, as git's "couldn't find remote ref".
 */
export function missingSources(
  remoteRefs: readonly RemoteRef[],
  refspecs: readonly string[],
): string[] {
  const byName = new Map(remoteRefs.map((r) => [r.name, r]));
  const missing: string[] = [];
  for (const spec of refspecs.map(parseRefSpec)) {
    if (spec.negative || !spec.source || spec.wildcard) continue;
    if (/^[0-9a-f]{40}$/.test(spec.source)) continue;
    if (!dwimRef(spec, byName)?.oid) missing.push(spec.source);
  }
  return missing;
}

/** The ref-prefix lines (v2 ls-refs) that cover `refspecs`: what the server needs to list. */
export function refPrefixes(refspecs: readonly string[]): string[] {
  const prefixes = new Set<string>();
  for (const spec of refspecs.map(parseRefSpec)) {
    if (spec.negative || !spec.source) continue;
    const source = spec.source;
    if (/^[0-9a-f]{40}$/.test(source)) continue;
    if (spec.wildcard) {
      prefixes.add(source.slice(0, source.indexOf("*")));
    } else if (source.startsWith("refs/") || source === "HEAD") {
      prefixes.add(source);
    } else {
      for (const candidate of dwimCandidates(source)) prefixes.add(candidate);
    }
  }
  return [...prefixes];
}

function dwimCandidates(name: string): string[] {
  return [
    name,
    `refs/${name}`,
    `refs/tags/${name}`,
    `refs/heads/${name}`,
    `refs/remotes/${name}`,
    `refs/remotes/${name}/HEAD`,
  ];
}

function dwimRef(spec: RefSpec, byName: Map<string, RemoteRef>): RemoteRef | undefined {
  const source = spec.source as string;
  if (source.startsWith("refs/") || source === "HEAD") return byName.get(source);
  for (const candidate of dwimCandidates(source)) {
    const ref = byName.get(candidate);
    if (ref) return ref;
  }
  return undefined;
}

/** Options of {@link planRefUpdates}. */
export interface PlanOptions {
  /** Every update may be a non-fast-forward (git fetch --force) */
  force?: boolean;
}

/**
 * Decides each planned ref's update as git's fetch does: a new ref is created; an unchanged
 * one is up to date; a tag that would change is rejected unless forced; a branch moves when
 * the old value is an ancestor of the new one, or when forced, and is rejected otherwise.
 */
export async function planRefUpdates(
  planned: readonly PlannedRef[],
  repository: RepositoryFacade,
  refStore: RefStore,
  options: PlanOptions = {},
): Promise<FetchRefUpdate[]> {
  const updates: FetchRefUpdate[] = [];
  const taken = new Set<string>();
  for (const p of planned) {
    if (!p.localRef || taken.has(p.localRef)) continue;
    taken.add(p.localRef);
    const oldOid = await refStore.get(p.localRef);
    const force = options.force || p.force;
    const base = { remoteRef: p.remoteRef, localRef: p.localRef, oldOid, newOid: p.oid };
    if (!oldOid) {
      const kind = p.localRef.startsWith("refs/tags/")
        ? "tag"
        : p.remoteRef.startsWith("refs/heads/")
          ? "branch"
          : "ref";
      updates.push({ ...base, status: "new", summary: `[new ${kind}]` });
      continue;
    }
    if (oldOid === p.oid) {
      updates.push({ ...base, status: "up-to-date", summary: "[up to date]" });
      continue;
    }
    const range = `${oldOid.slice(0, 7)}...${p.oid.slice(0, 7)}`;
    if (p.localRef.startsWith("refs/tags/")) {
      updates.push(
        force
          ? { ...base, status: "forced", summary: `+ ${range}` }
          : {
              ...base,
              status: "rejected",
              reason: "would clobber existing tag",
              summary: "[rejected]",
            },
      );
      continue;
    }
    const ff = await isFastForward(repository, oldOid, p.oid);
    if (ff) {
      updates.push({
        ...base,
        status: "fast-forward",
        summary: `${oldOid.slice(0, 7)}..${p.oid.slice(0, 7)}`,
      });
    } else if (force) {
      updates.push({ ...base, status: "forced", summary: `+ ${range}` });
    } else {
      updates.push({
        ...base,
        status: "rejected",
        reason: "non-fast-forward",
        summary: "[rejected]",
      });
    }
  }
  return updates;
}

/**
 * Writes the accepted updates: each in its own `RefStore.batch` with its old value checked
 * (git's fetch, a ref changed meanwhile is rejected), or all in one batch with `atomic`.
 * Updates the store refuses become `rejected`. Stores without `batch` get `update` calls.
 */
export async function applyRefUpdates(
  updates: FetchRefUpdate[],
  refStore: RefStore,
  options: {
    atomic?: boolean;
    message?: string;
    reflogAction?: string;
    ident?: string;
    skipReflog?: boolean;
  } = {},
): Promise<void> {
  const writes = updates.filter((u) => u.status !== "rejected" && u.status !== "up-to-date");
  if (writes.length === 0) return;
  // git's update_local_ref: "<action>: <what>" per ref, else the one message given
  const logOf = (u: FetchRefUpdate) => ({
    message:
      options.reflogAction !== undefined
        ? `${options.reflogAction}: ${fetchReflogWhat(u)}`
        : options.message,
    ...(options.ident !== undefined ? { ident: options.ident } : {}),
    ...(options.skipReflog ? { skipReflog: true } : {}),
  });
  const command = (u: FetchRefUpdate) => ({
    name: u.localRef,
    old: u.oldOid ?? null,
    new: u.newOid,
  });
  const reject = (u: FetchRefUpdate, reason: string) => {
    u.status = "rejected";
    u.reason = reason;
    u.summary = "[rejected]";
  };
  if (!refStore.batch) {
    for (const u of writes) await refStore.update(u.localRef, u.newOid);
    return;
  }
  if (options.atomic) {
    // one batch, each ref logged with its own message, as git's transaction logs it
    const { message: _first, ...batchOptions } = logOf(writes[0] as FetchRefUpdate);
    const result = await refStore.batch(
      writes.map((u) => {
        const message = logOf(u).message;
        return { ...command(u), ...(message !== undefined ? { message } : {}) };
      }),
      batchOptions,
    );
    if (!result.ok) {
      const reasons = new Map(result.rejected.map((r) => [r.name, r.reason]));
      for (const u of writes) reject(u, reasons.get(u.localRef) ?? "atomic transaction failed");
    }
    return;
  }
  for (const u of writes) {
    const result = await refStore.batch([command(u)], logOf(u));
    if (!result.ok) reject(u, result.rejected[0]?.reason ?? "rejected");
  }
}

/**
 * What git's fetch logs for an accepted update (update_local_ref, after `<action>: `): a
 * changed tag `updating tag`; a new ref `storing tag`, `storing head` or `storing ref` by
 * the remote ref's name; else `fast-forward` or `forced-update`.
 */
export function fetchReflogWhat(update: FetchRefUpdate): string {
  if (update.oldOid && update.localRef.startsWith("refs/tags/")) return "updating tag";
  if (update.status === "new") {
    if (update.remoteRef.startsWith("refs/tags/")) return "storing tag";
    if (update.remoteRef.startsWith("refs/heads/")) return "storing head";
    return "storing ref";
  }
  return update.status === "fast-forward" ? "fast-forward" : "forced-update";
}

/**
 * Whether moving a ref from `oldOid` to `newOid` is a fast-forward: `oldOid` is reachable
 * from `newOid`. Values that are not commits (after peeling tags) need no check (git).
 */
export async function isFastForward(
  repository: RepositoryFacade,
  oldOid: string,
  newOid: string,
): Promise<boolean> {
  const getInfo = repository.getCommitInfo?.bind(repository);
  if (!getInfo) {
    if (repository.isReachableFrom) return repository.isReachableFrom(oldOid, newOid);
    for await (const oid of repository.walkAncestors(newOid)) if (oid === oldOid) return true;
    return false;
  }
  const peel = async (oid: string) => {
    let id = oid;
    for (let i = 0; i < 16; i++) {
      const info = await getInfo(id);
      if (info) return { id, info };
      const target = await repository.peelTag?.(id);
      if (!target || target === id) return undefined;
      id = target;
    }
    return undefined;
  };
  const from = await peel(oldOid);
  const to = await peel(newOid);
  if (!from || !to) return true;
  // walk back from the new commit, newest first (dates only order the walk: a clock-skewed
  // history is walked to its end rather than cut short), until the old commit is found
  const seen = new Set<string>([to.id]);
  const queue: { id: string; time: number }[] = [{ id: to.id, time: to.info.time }];
  while (queue.length > 0) {
    const { id } = queue.shift() as { id: string; time: number };
    if (id === from.id) return true;
    const info = id === to.id ? to.info : await getInfo(id);
    for (const parent of info?.parents ?? []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      const parentInfo = await getInfo(parent);
      if (!parentInfo) continue;
      const entry = { id: parent, time: parentInfo.time };
      let i = queue.length;
      while (i > 0 && (queue[i - 1] as { time: number }).time < entry.time) i--;
      queue.splice(i, 0, entry);
    }
  }
  return false;
}
