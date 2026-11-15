/**
 * Which remote refs a push updates, and whether it may: git's `match_push_refs` (remote.c:
 * refspecs, short names, patterns, deletes, `--prune`) and `set_ref_status_for_push`
 * (up to date, fast-forward, fetch first, non-fast-forward, tags, `--force-with-lease`).
 */

import type { RemoteRef } from "../fetch-client/index.js";
import { ZERO_OID } from "../protocol/index.js";
import { expandFromDestination, expandFromSource, parseRefSpec } from "../utils/index.js";

/** A refspec could not be resolved (git's push dies before it connects to send anything). */
export class PushRefspecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushRefspecError";
  }
}

/**
 * The outcome of one ref of a push, named after git's `REF_STATUS_*`. `ok` and `up-to-date`
 * succeed; every other is a refusal: `rejected-*` and `atomic-push-failed` decided here, before
 * anything was sent, `remote-rejected` by the server (`ng`), `remote-failure` a ref the server
 * did not report.
 */
export type PushRefStatus =
  | "ok"
  | "up-to-date"
  | "rejected-nonfastforward"
  | "rejected-fetch-first"
  | "rejected-needs-force"
  | "rejected-already-exists"
  | "rejected-stale"
  | "rejected-nodelete"
  | "atomic-push-failed"
  | "remote-rejected"
  | "remote-failure";

/** One remote ref a push updates (or tried to). */
export interface PushRefUpdate {
  /** The remote ref (full name) */
  remoteRef: string;
  /** The local ref pushed (full name); undefined for a delete or an object id */
  localRef?: string;
  /** The remote's value in its advertisement ({@link ZERO_OID}: absent): the command's old id */
  oldOid: string;
  /** The value pushed ({@link ZERO_OID}: a delete) */
  newOid: string;
  /** Whether the update may be a non-fast-forward (`+`, `force`, or a lease that holds) */
  force: boolean;
  /** `--force-with-lease`: the value the remote ref must have ({@link ZERO_OID}: absent) */
  expectedOid?: string;
  status: PushRefStatus;
  /** Whether an update that is not a fast-forward was allowed by force */
  forced: boolean;
  /** The server's reason for `remote-rejected` */
  message?: string;
  /**
   * git's status column: `[new branch]`, `abc1234..def5678`, `+ abc1234...def5678 (forced
   * update)`, `[up to date]`, `[deleted]`, `[rejected] (fetch first)`, `[remote rejected]
   * (hook declined)`, …
   */
  summary: string;
}

/** What the local repository has, as the push refspecs see it. */
export interface LocalRefState {
  /** Local refs (`refs/…`), name to object id */
  refs: ReadonlyMap<string, string>;
  /** The local HEAD: the branch it names, and its value */
  head?: { target?: string; oid?: string };
  /** Whether an object id (a 40-hex refspec source) names an object here */
  hasObject?(oid: string): Promise<boolean>;
}

/** A refspec matched: the remote ref, what to set it to and from where. */
export interface MatchedPushRef {
  remoteRef: string;
  localRef?: string;
  newOid: string;
  oldOid: string;
  force: boolean;
}

/** Options of {@link matchPushRefs}. */
export interface MatchPushRefsOptions {
  /**
   * Delete remote refs a pattern refspec's destination matches that have no local source
   * (`git push --prune`; with `+refs/*:refs/*`, `--mirror`)
   */
  prune?: boolean;
}

const OID_PATTERN = /^[0-9a-f]{40}$/;
// git's ref_rev_parse_rules, used to match a short name to a full one
const RULES = [
  "%s",
  "refs/%s",
  "refs/tags/%s",
  "refs/heads/%s",
  "refs/remotes/%s",
  "refs/remotes/%s/HEAD",
];

/** Whether `abbrev` names `full` under git's rev-parse rules (`main` → `refs/heads/main`). */
export function refnameMatch(abbrev: string, full: string): boolean {
  return RULES.some((rule) => rule.replace("%s", abbrev) === full);
}

/**
 * git's `count_refspec_match`: the refs `pattern` names. A match outside `refs/heads/` and
 * `refs/tags/` that the pattern does not spell out (`main` against `refs/remotes/main`) is weak:
 * one strong match wins over any weak ones.
 */
export function countRefspecMatch(
  pattern: string,
  names: Iterable<string>,
): { count: number; match?: string } {
  let strong = 0;
  let weak = 0;
  let strongMatch: string | undefined;
  let weakMatch: string | undefined;
  for (const name of names) {
    if (!refnameMatch(pattern, name)) continue;
    const isWeak =
      name.length !== pattern.length &&
      pattern.length !== name.length - 5 &&
      !name.startsWith("refs/heads/") &&
      !name.startsWith("refs/tags/");
    if (isWeak) {
      weak++;
      weakMatch = name;
    } else {
      strong++;
      strongMatch = name;
    }
  }
  return strongMatch ? { count: strong, match: strongMatch } : { count: weak, match: weakMatch };
}

/**
 * Maps push refspecs onto the remote refs, as git's `match_push_refs`:
 *
 * - `src:dst`, `src` (to the same name), `+` to force, `:dst` to delete, `^src` to exclude
 *   from patterns; `src` may be a short name (`main`), `HEAD` (its branch), or an object id
 *   (with an explicit `dst`).
 * - `dst` may be a short name of a ref the remote has; a new ref needs its full name, unless
 *   the source is a branch or a tag (`main:topic` creates `refs/heads/topic`).
 * - Patterns (`refs/heads/*:refs/heads/*`) push every local ref they match; `:` pushes the
 *   branches the remote has under the same name ("matching"). An explicit refspec wins over a
 *   pattern for the same remote ref.
 *
 * Throws a {@link PushRefspecError} with git's message for a source that matches nothing (or
 * more than one ref), an ambiguous or unqualified destination, a delete of a short name the
 * remote does not have, or two sources for one remote ref.
 */
export async function matchPushRefs(
  refspecs: readonly string[],
  local: LocalRefState,
  remoteRefs: readonly Pick<RemoteRef, "name" | "oid">[],
  options: MatchPushRefsOptions = {},
): Promise<MatchedPushRef[]> {
  const remote = new Map<string, string>();
  for (const ref of remoteRefs) {
    if (ref.oid && ref.name.startsWith("refs/")) remote.set(ref.name, ref.oid);
  }
  const localNames = [...local.refs.keys()].filter((n) => n.startsWith("refs/"));
  const parsed = refspecs.map((spec) => ({ spec, ...parseSpec(spec) }));
  const negatives = parsed.filter((p) => p.negative);
  const excluded = (name: string) => negatives.some((n) => matchSide(n.src ?? "", name));

  const matched = new Map<string, MatchedPushRef>();
  const link = (m: MatchedPushRef, explicit: boolean) => {
    const existing = matched.get(m.remoteRef);
    if (existing) {
      if (explicit && (existing.newOid !== m.newOid || existing.localRef !== m.localRef)) {
        throw new PushRefspecError(`multiple updates for ref '${m.remoteRef}' not allowed`);
      }
      return;
    }
    matched.set(m.remoteRef, m);
  };

  // explicit refspecs first (git's match_explicit_refs), then patterns
  for (const p of parsed) {
    if (p.negative || p.matching || p.pattern) continue;
    // the source
    let localRef: string | undefined;
    let newOid: string;
    let srcIsRef = true;
    if (!p.src) {
      newOid = ZERO_OID;
      srcIsRef = false;
    } else {
      const { count, match } = countRefspecMatch(p.src, localNames);
      if (count > 1) throw new PushRefspecError(`src refspec ${p.src} matches more than one`);
      if (count === 1 && match) {
        localRef = match;
        newOid = local.refs.get(match) as string;
      } else if (p.src === "HEAD" || p.src === "@") {
        if (!local.head?.oid) throw new PushRefspecError(`src refspec ${p.src} does not match any`);
        newOid = local.head.oid;
        localRef = local.head.target;
        srcIsRef = !!local.head.target;
      } else if (OID_PATTERN.test(p.src) && (await local.hasObject?.(p.src))) {
        newOid = p.src;
        srcIsRef = false;
      } else {
        throw new PushRefspecError(`src refspec ${p.src} does not match any`);
      }
    }
    // the destination
    let remoteRef: string;
    if (p.dst === undefined) {
      // no colon: the source's own name (a branch for HEAD)
      if (!localRef || !srcIsRef) {
        throw new PushRefspecError(`${p.src} cannot be resolved to branch`);
      }
      remoteRef = localRef;
    } else {
      const { count, match } = countRefspecMatch(p.dst, remote.keys());
      if (count > 1) throw new PushRefspecError(`dst refspec ${p.dst} matches more than one`);
      if (count === 1 && match) {
        remoteRef = match;
      } else if (p.dst.startsWith("refs/")) {
        remoteRef = p.dst;
      } else if (newOid === ZERO_OID) {
        throw new PushRefspecError(`unable to delete '${p.dst}': remote ref does not exist`);
      } else if (localRef?.startsWith("refs/heads/") && srcIsRef) {
        remoteRef = `refs/heads/${p.dst}`;
      } else if (localRef?.startsWith("refs/tags/") && srcIsRef) {
        remoteRef = `refs/tags/${p.dst}`;
      } else {
        throw new PushRefspecError(
          `The destination you provided is not a full refname (i.e., starting with "refs/"). ` +
            `Cannot guess a full refname for '${p.dst}' from the source '${p.src}'.`,
        );
      }
    }
    link(
      { remoteRef, localRef, newOid, oldOid: remote.get(remoteRef) ?? ZERO_OID, force: p.force },
      true,
    );
  }

  // patterns and "matching" (git's match_push_refs over the local refs)
  const patterns = parsed.filter((p) => !p.negative && (p.matching || p.pattern));
  for (const name of localNames) {
    if (excluded(name)) continue;
    const p = patterns.find((q) => q.matching || matchSide(q.src ?? "", name));
    if (!p) continue;
    let remoteRef: string;
    if (p.matching) {
      // ":" pushes branches the remote has under the same name
      if (!name.startsWith("refs/heads/") || !remote.has(name)) continue;
      remoteRef = name;
    } else {
      remoteRef = expandFromSource(parseRefSpec(p.spec), name).destination ?? name;
    }
    if (matched.has(remoteRef)) continue;
    link(
      {
        remoteRef,
        localRef: name,
        newOid: local.refs.get(name) as string,
        oldOid: remote.get(remoteRef) ?? ZERO_OID,
        force: p.force,
      },
      false,
    );
  }

  // --prune: remote refs a pattern's destination covers, whose source is gone here
  if (options.prune) {
    for (const [name, oid] of remote) {
      if (matched.has(name)) continue;
      for (const p of patterns) {
        if (p.matching || !p.dst || !matchSide(p.dst, name)) continue;
        const src = expandFromDestination(parseRefSpec(p.spec), name).source;
        if (!src || local.refs.has(src) || excluded(src)) continue;
        link({ remoteRef: name, newOid: ZERO_OID, oldOid: oid, force: p.force }, false);
        break;
      }
    }
  }
  return [...matched.values()];
}

/** What the push decides with: the local objects. */
export interface PushObjectSource {
  /** Whether the object is here */
  has(oid: string): Promise<boolean>;
  /**
   * The commit an object peels to (itself for a commit, the target of a tag chain), or
   * undefined when it is no commit (a tree, a blob, a tag of one) or not here.
   */
  peelToCommit(oid: string): Promise<string | undefined>;
  /** Whether `ancestor` is reachable from `descendant` (both commits here) */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}

/** A `--force-with-lease` expectation. */
export interface ForceWithLease {
  /** The remote ref (a full name, or a short one: `main`) */
  ref: string;
  /**
   * The value it must have; {@link ZERO_OID} or "" for "must not exist". Omitted: the remote
   * ref's remote-tracking value here (see `PushClientOptions.trackingValue`).
   */
  expect?: string;
}

/** Options of {@link setPushStatus}. */
export interface PushStatusOptions {
  /** Every update may be a non-fast-forward (`--force`) */
  force?: boolean;
  /**
   * The leases: the remote ref's expected value per remote ref (resolved). A lease that holds
   * allows a non-fast-forward; one that does not is `rejected-stale` (unless forced).
   */
  leases?: ReadonlyMap<string, string>;
}

/**
 * Decides each matched ref as git's `set_ref_status_for_push`: `up-to-date` when the remote has
 * the value already; otherwise an update of an existing ref must be a fast-forward:
 * `rejected-already-exists` for a tag, `rejected-fetch-first` when the remote value is not
 * here, `rejected-needs-force` when either end is no commit, `rejected-nonfastforward` when the
 * remote value is not an ancestor. A lease then decides instead: `rejected-stale` when the
 * remote ref moved, else the update is forced. Force (`+` or `force`) turns every refusal into
 * a forced update. Creates and deletes need no check. What may be sent gets status `ok` (the
 * server's report decides later).
 */
export async function setPushStatus(
  matched: readonly MatchedPushRef[],
  objects: PushObjectSource,
  options: PushStatusOptions = {},
): Promise<PushRefUpdate[]> {
  const updates: PushRefUpdate[] = [];
  for (const m of matched) {
    let force = m.force || !!options.force;
    const deletion = m.newOid === ZERO_OID;
    const expectedOid = options.leases?.get(m.remoteRef);
    const update: PushRefUpdate = {
      remoteRef: m.remoteRef,
      localRef: m.localRef,
      oldOid: m.oldOid,
      newOid: m.newOid,
      force,
      ...(expectedOid !== undefined ? { expectedOid } : {}),
      status: "ok",
      forced: false,
      summary: "",
    };
    updates.push(update);
    if (!deletion && m.oldOid === m.newOid) {
      update.status = "up-to-date";
      update.summary = pushSummary(update);
      continue;
    }
    let reject: PushRefStatus | undefined;
    if (!deletion && m.oldOid !== ZERO_OID) {
      if (m.remoteRef.startsWith("refs/tags/")) reject = "rejected-already-exists";
      else if (!(await objects.has(m.oldOid))) reject = "rejected-fetch-first";
      else {
        const oldCommit = await objects.peelToCommit(m.oldOid);
        const newCommit = await objects.peelToCommit(m.newOid);
        if (!oldCommit || !newCommit) reject = "rejected-needs-force";
        else if (!(await objects.isAncestor(oldCommit, newCommit))) {
          reject = "rejected-nonfastforward";
        }
      }
    }
    // a lease decides over the fast-forward rules: one that holds forces the update, a stale
    // one refuses it (unless forced anyway)
    if (expectedOid !== undefined) {
      if (expectedOid !== m.oldOid) reject = "rejected-stale";
      else force = true;
    }
    update.force = force;
    if (reject && !force) update.status = reject;
    else if (reject) update.forced = true;
    update.summary = pushSummary(update);
  }
  return updates;
}

/** git's status column for an update (`print_one_push_status`). */
export function pushSummary(update: PushRefUpdate): string {
  const abbrev = (oid: string) => oid.slice(0, 7);
  switch (update.status) {
    case "up-to-date":
      return "[up to date]";
    case "rejected-nonfastforward":
      return "[rejected] (non-fast-forward)";
    case "rejected-fetch-first":
      return "[rejected] (fetch first)";
    case "rejected-needs-force":
      return "[rejected] (needs force)";
    case "rejected-already-exists":
      return "[rejected] (already exists)";
    case "rejected-stale":
      return "[rejected] (stale info)";
    case "rejected-nodelete":
      return "[rejected] (remote does not support deleting refs)";
    case "atomic-push-failed":
      return "[rejected] (atomic push failed)";
    case "remote-rejected":
      return `[remote rejected] (${update.message ?? "failed"})`;
    case "remote-failure":
      return "[remote failure] (remote failed to report status)";
    case "ok":
      if (update.newOid === ZERO_OID) return "[deleted]";
      if (update.oldOid === ZERO_OID) {
        if (update.remoteRef.startsWith("refs/tags/")) return "[new tag]";
        if (update.remoteRef.startsWith("refs/heads/")) return "[new branch]";
        return "[new reference]";
      }
      if (update.forced) {
        return `+ ${abbrev(update.oldOid)}...${abbrev(update.newOid)} (forced update)`;
      }
      return `${abbrev(update.oldOid)}..${abbrev(update.newOid)}`;
  }
}

/** Whether a status is a success (`ok`, `up-to-date`). */
export function isPushSuccess(status: PushRefStatus): boolean {
  return status === "ok" || status === "up-to-date";
}

interface ParsedPushSpec {
  src?: string;
  dst?: string;
  force: boolean;
  negative: boolean;
  pattern: boolean;
  matching: boolean;
}

function parseSpec(spec: string): ParsedPushSpec {
  let s = spec;
  const force = s.startsWith("+");
  if (force) s = s.slice(1);
  if (s === ":" || s === "") return { force, negative: false, pattern: false, matching: true };
  const negative = s.startsWith("^");
  if (negative) {
    if (force) throw new PushRefspecError(`invalid refspec '${spec}'`);
    s = s.slice(1);
    return { src: s, force: false, negative: true, pattern: s.includes("*"), matching: false };
  }
  const colon = s.indexOf(":");
  const src = colon < 0 ? s : s.slice(0, colon);
  const dst = colon < 0 ? undefined : s.slice(colon + 1);
  const srcPattern = src.includes("*");
  const dstPattern = dst?.includes("*") ?? srcPattern;
  if (srcPattern !== dstPattern || (dst !== undefined && !dst)) {
    if (!(dst === "" && !srcPattern)) throw new PushRefspecError(`invalid refspec '${spec}'`);
  }
  if (colon >= 0 && !src && !dst) throw new PushRefspecError(`invalid refspec '${spec}'`);
  return {
    src: src || undefined,
    dst: dst === undefined ? undefined : dst || undefined,
    force,
    negative: false,
    pattern: srcPattern,
    matching: false,
  };
}

/** A pattern side (`refs/heads/*`) or an exact name, against a ref name. */
function matchSide(side: string, name: string): boolean {
  const star = side.indexOf("*");
  if (star < 0) return side === name;
  const prefix = side.slice(0, star);
  const suffix = side.slice(star + 1);
  return (
    name.length > prefix.length + suffix.length && name.startsWith(prefix) && name.endsWith(suffix)
  );
}
