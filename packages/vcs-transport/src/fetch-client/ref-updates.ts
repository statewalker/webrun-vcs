/**
 * Which local refs a fetch writes, and whether it may (git's update_local_ref).
 */

import type { RepositoryFacade } from "../api/repository-facade.js";
import type { RefStore } from "../context/process-context.js";
import type { RefSpec } from "../protocol/index.js";
import { type AbbrevLengths, abbreviate } from "../summary/index.js";
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
   * Why a ref was rejected: `non-fast-forward`, `would clobber existing tag`, or, when the
   * ref store refused the write, git's `unable to update local ref` (the store's own reason
   * in {@link storeError}).
   */
  reason?: string;
  /**
   * The ref store's refusal of the write (`mismatch` when the ref changed meanwhile,
   * `locked`, …): the update was accepted, and its {@link summary} is the one it was
   * accepted with (git prints it with `!` and `(unable to update local ref)`).
   */
  storeError?: string;
  /**
   * The status the update was accepted with before the ref store refused the write (set
   * with {@link storeError})
   */
  accepted?: Exclude<FetchRefStatus, "rejected">;
  /**
   * Refused because the one transaction of an atomic fetch failed (set with
   * {@link storeError}): git prints the line it was accepted with, then the transaction's
   * error (`FetchClientResult.refTransactionError`)
   */
  aborted?: boolean;
  /**
   * How git prints it: `[new branch]`, `[new tag]`, `abc1234..def5678`, `+ abc1234...def5678`,
   * `[tag update]` (a forced tag), `[rejected]`, `[up to date]`; ids as long as git's
   * find_unique_abbrev makes them under `core.abbrev`
   */
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
        localRef: localRefOf(spec.destination),
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
      localRef: localRefOf(spec.destination),
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

/**
 * git's get_local_ref: the local ref a refspec's destination names (`main` is
 * `refs/heads/main`, `tags/v1` is `refs/tags/v1`); none for an empty destination.
 */
function localRefOf(destination: string | null | undefined): string | undefined {
  if (!destination) return undefined;
  if (destination.startsWith("refs/")) return destination;
  if (/^(heads|tags|remotes)\//.test(destination)) return `refs/${destination}`;
  return `refs/heads/${destination}`;
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
  /**
   * The abbreviated length of each id in the summaries (git's find_unique_abbrev under
   * `core.abbrev`; see `abbrevLengthsOf`); 7 digits for an id not there
   */
  lengths?: AbbrevLengths;
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
      // update_local_ref names it after the remote ref, "more likely to follow a standard layout"
      const kind = p.remoteRef.startsWith("refs/tags/")
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
    const lengths = options.lengths;
    const range = `${abbreviate(oldOid, lengths)}...${abbreviate(p.oid, lengths)}`;
    if (p.localRef.startsWith("refs/tags/")) {
      updates.push(
        force
          ? { ...base, status: "forced", summary: "[tag update]" }
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
        summary: `${abbreviate(oldOid, lengths)}..${abbreviate(p.oid, lengths)}`,
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
 * (git's fetch, a ref changed meanwhile is rejected), or all in one batch with `atomic` (none
 * when an update was refused already), the stale refs of a prune (`deletes`, atomic only)
 * deleted in the same batch.
 * Updates the store refuses become `rejected`. Stores without `batch` get `update` calls.
 * Returns git's error when the atomic transaction failed (see
 * `FetchClientResult.refTransactionError`), else undefined.
 */
export async function applyRefUpdates(
  updates: FetchRefUpdate[],
  refStore: RefStore,
  options: {
    atomic?: boolean;
    /** Refs to delete in the atomic transaction (git's prune_refs, logged `fetch: prune`) */
    deletes?: readonly string[];
    message?: string;
    reflogAction?: string;
    ident?: string;
    skipReflog?: boolean;
    /**
     * The refs written in one initial transaction (git clone's write_remote_refs:
     * `BatchOptions.initial`, packed-refs on a files store) before the others, each of which
     * is then written on its own (write_followtags). Git's error when it failed.
     */
    initial?: ReadonlySet<string>;
  } = {},
): Promise<string | undefined> {
  // git's fetch --atomic: a ref refused before the transaction (non-fast-forward, a tag it
  // would clobber) aborts it, nothing is written, no stale ref deleted (the other lines
  // still read as accepted)
  if (options.atomic && updates.some((u) => u.status === "rejected")) return undefined;
  const writes = updates.filter((u) => u.status !== "rejected" && u.status !== "up-to-date");
  const deletes = options.atomic ? (options.deletes ?? []) : [];
  if (writes.length === 0 && deletes.length === 0) return undefined;
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
  // git's update_local_ref when s_update_ref fails: the summary the update was accepted
  // with, its fail code `!` and "unable to update local ref"
  const reject = (u: FetchRefUpdate, storeError: string) => {
    if (u.status !== "rejected") u.accepted = u.status;
    u.status = "rejected";
    u.reason = "unable to update local ref";
    u.storeError = storeError;
  };
  if (!refStore.batch) {
    for (const u of writes) await refStore.update(u.localRef, u.newOid);
    // the zero id deletes, as in a push command
    for (const name of deletes) await refStore.update(name, ZERO_OID);
    return undefined;
  }
  if (options.atomic) {
    // one batch, each ref logged with its own message, as git's transaction logs it; the
    // stale refs first, as prune_refs queues them before the updates
    const batchOptions = {
      ...(options.ident !== undefined ? { ident: options.ident } : {}),
      ...(options.skipReflog ? { skipReflog: true } : {}),
    };
    const result = await refStore.batch(
      [
        ...deletes.map((name) => ({ name, new: null, message: "fetch: prune" })),
        ...writes.map((u) => {
          const message = logOf(u).message;
          return { ...command(u), ...(message !== undefined ? { message } : {}) };
        }),
      ],
      batchOptions,
    );
    if (result.ok) return undefined;
    const reasons = new Map(result.rejected.map((r) => [r.name, r.reason]));
    for (const u of writes) {
      reject(u, reasons.get(u.localRef) ?? "atomic transaction failed");
      u.aborted = true;
    }
    return transactionError(writes, result.rejected, refStore);
  }
  let rest = writes;
  if (options.initial) {
    const initial = options.initial;
    const first = writes.filter((u) => initial.has(u.localRef));
    rest = writes.filter((u) => !initial.has(u.localRef));
    if (first.length > 0) {
      const result = await refStore.batch(
        first.map((u) => ({ name: u.localRef, old: null, new: u.newOid })),
        {
          initial: true,
          skipReflog: true,
          ...(options.ident !== undefined ? { ident: options.ident } : {}),
        },
      );
      if (!result.ok) {
        const reasons = new Map(result.rejected.map((r) => [r.name, r.reason]));
        for (const u of first) {
          reject(u, reasons.get(u.localRef) ?? "initial transaction failed");
          u.aborted = true;
        }
        return transactionError(first, result.rejected, refStore);
      }
    }
  }
  for (const u of rest) {
    const result = await refStore.batch([command(u)], logOf(u));
    if (!result.ok) reject(u, result.rejected[0]?.reason ?? "rejected");
  }
  return undefined;
}

const ZERO_OID = "0000000000000000000000000000000000000000";

/**
 * The error git's ref transaction reports when an atomic fetch's commit fails: for a name
 * conflict, refs.c refs_verify_refnames_available's words for the first update (by name)
 * that conflicts with a ref here (`'<ref>' exists; cannot create '<name>'`; a ref the same
 * transaction deletes still counts, as in git's do_fetch) or with another update (`cannot process '<name>' and '<other>' at
 * the same time`); for a ref changed meanwhile, the files backend's `cannot lock ref`.
 * git 2.43 put `cannot lock ref '<name>': ` before a name conflict too; this is 2.5x's text.
 */
async function transactionError(
  writes: readonly FetchRefUpdate[],
  rejected: readonly { name: string; reason: string }[],
  refStore: RefStore,
): Promise<string> {
  const existing = new Set<string>();
  for (const [name] of await refStore.listAll()) existing.add(name);
  const names = writes.map((u) => u.localRef).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const extras = new Set(names);
  for (const name of names) {
    for (let at = name.indexOf("/"); at >= 0; at = name.indexOf("/", at + 1)) {
      const dir = name.slice(0, at);
      if (existing.has(dir)) return `'${dir}' exists; cannot create '${name}'`;
      if (extras.has(dir)) return `cannot process '${name}' and '${dir}' at the same time`;
    }
    const below = (set: Iterable<string>) =>
      [...set].filter((n) => n.startsWith(`${name}/`)).sort((a, b) => (a < b ? -1 : 1))[0];
    const here = below(existing);
    if (here !== undefined) return `'${here}' exists; cannot create '${name}'`;
    const other = below(extras);
    if (other !== undefined) return `cannot process '${name}' and '${other}' at the same time`;
  }
  const first = rejected[0];
  const update = writes.find((u) => u.localRef === first?.name);
  if (first?.reason === "mismatch" && update) {
    const now = (await refStore.get(update.localRef)) ?? ZERO_OID;
    return `cannot lock ref '${update.localRef}': is at ${now} but expected ${update.oldOid ?? ZERO_OID}`;
  }
  return `cannot lock ref '${first?.name ?? names[0]}': ${first?.reason ?? "transaction failed"}`;
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
