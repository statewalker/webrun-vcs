/**
 * Which remote refs a push updates, and whether it may: git's `match_push_refs` (remote.c:
 * refspecs, short names, patterns, deletes, `--prune`) and `set_ref_status_for_push`
 * (up to date, fast-forward, fetch first, non-fast-forward, tags, `--force-with-lease`).
 */

import type { RemoteRef } from "../fetch-client/index.js";
import { ZERO_OID } from "../protocol/index.js";
import type { AbbrevLengths } from "../summary/index.js";
import { pushStatusParts } from "./push-status.js";

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
  /**
   * The source as git names it in its report when it is no local ref the refspec matched:
   * `HEAD` (also for `@`), or the object name as written (`HEAD~1`, an id)
   */
  source?: string;
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
  /**
   * Resolves a source that is no ref name: a revision expression (`main~1`, `HEAD^`,
   * `v1^{tree}`, an abbreviated id; see {@link resolveRevision}). Without it only full object
   * ids are accepted.
   */
  resolveRevision?(expr: string): Promise<string | undefined>;
}

/** A refspec matched: the remote ref, what to set it to and from where. */
export interface MatchedPushRef {
  remoteRef: string;
  localRef?: string;
  /** The source as written when it is no local ref matched (`HEAD`, `HEAD~1`, an id) */
  source?: string;
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

/** git's error for a short destination it cannot place (remote.c). */
function unqualifiedDestination(dst: string, src: string): PushRefspecError {
  return new PushRefspecError(
    "The destination you provided is not a full refname (i.e.,\n" +
      'starting with "refs/"). We tried to guess what you meant by:\n' +
      "\n" +
      `- Looking for a ref that matches '${dst}' on the remote side.\n` +
      `- Checking if the <src> being pushed ('${src}')\n` +
      '  is a ref in "refs/{heads,tags}/". If so we add a corresponding\n' +
      "  refs/{heads,tags}/ prefix on the remote side.\n" +
      "\n" +
      "Neither worked, so we gave up. You must fully qualify the ref.",
  );
}
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
    if (matched.has(m.remoteRef)) {
      // git: two explicit refspecs for one remote ref are an error; a pattern skips it
      if (explicit) {
        throw new PushRefspecError(`dst ref ${m.remoteRef} receives from more than one src`);
      }
      return;
    }
    matched.set(m.remoteRef, m);
  };

  // explicit refspecs first (git's match_explicit_refs), then patterns
  for (const p of parsed) {
    if (p.negative || p.matching || p.pattern) continue;
    // the source: a local ref (git's count_refspec_match), else any object name (HEAD, an id,
    // a revision: try_explicit_object_name)
    let localRef: string | undefined;
    let newOid: string;
    // what the source resolves to as a ref (git's resolve_ref_unsafe of its name): a ref name,
    // HEAD's branch, "HEAD" when detached; undefined for an object name
    let srcRef: string | undefined;
    // the source as git's report names it (try_explicit_object_name's alloc_ref(name))
    let source: string | undefined;
    if (!p.src) {
      newOid = ZERO_OID;
    } else {
      const { count, match } = countRefspecMatch(p.src, localNames);
      if (count > 1) throw new PushRefspecError(`src refspec ${p.src} matches more than one`);
      if (count === 1 && match) {
        localRef = match;
        srcRef = match;
        newOid = local.refs.get(match) as string;
      } else if (p.src === "HEAD" || p.src === "@") {
        if (!local.head?.oid) throw new PushRefspecError(`src refspec ${p.src} does not match any`);
        newOid = local.head.oid;
        localRef = local.head.target;
        srcRef = local.head.target ?? "HEAD";
        source = "HEAD";
      } else {
        const oid =
          OID_PATTERN.test(p.src) && (await local.hasObject?.(p.src))
            ? p.src
            : await local.resolveRevision?.(p.src);
        if (!oid) throw new PushRefspecError(`src refspec ${p.src} does not match any`);
        newOid = oid;
        source = p.src;
      }
    }
    // the destination
    let dst = p.dst;
    if (dst === undefined) {
      // no colon: the name the source resolves to (HEAD's branch; "HEAD" when detached)
      if (!srcRef || (srcRef !== "HEAD" && !srcRef.startsWith("refs/"))) {
        throw new PushRefspecError(`${p.src} cannot be resolved to branch`);
      }
      dst = srcRef;
    }
    let remoteRef: string;
    {
      const { count, match } = countRefspecMatch(dst, remote.keys());
      if (count > 1) throw new PushRefspecError(`dst refspec ${dst} matches more than one`);
      if (count === 1 && match) {
        remoteRef = match;
      } else if (dst.startsWith("refs/")) {
        remoteRef = dst;
      } else if (newOid === ZERO_OID) {
        throw new PushRefspecError(`unable to delete '${dst}': remote ref does not exist`);
      } else if (srcRef?.startsWith("refs/heads/")) {
        remoteRef = `refs/heads/${dst}`;
      } else if (srcRef?.startsWith("refs/tags/")) {
        remoteRef = `refs/tags/${dst}`;
      } else {
        throw unqualifiedDestination(dst, p.src ?? "");
      }
    }
    link(
      {
        remoteRef,
        localRef,
        ...(source !== undefined ? { source } : {}),
        newOid,
        oldOid: remote.get(remoteRef) ?? ZERO_OID,
        force: p.force,
      },
      true,
    );
  }

  // patterns and "matching" (git's match_push_refs over the local refs): for each local ref
  // the first pattern whose source matches, else ":" (git's get_ref_match; a forced "+:" wins
  // over a plain ":")
  const patterns = parsed.filter((p) => !p.negative && (p.matching || p.pattern));
  const matchings = patterns.filter((p) => p.matching);
  const matching = matchings.find((p) => p.force) ?? matchings[0];
  const patternFor = (name: string, side: "src" | "dst") =>
    patterns.find(
      (q) => !q.matching && matchSide((side === "src" ? q.src : (q.dst ?? q.src)) ?? "", name),
    ) ?? matching;
  for (const name of localNames) {
    if (excluded(name)) continue;
    const p = patternFor(name, "src");
    if (!p) continue;
    let remoteRef: string;
    if (p.matching) {
      // ":" pushes branches the remote has under the same name
      if (!name.startsWith("refs/heads/") || !remote.has(name)) continue;
      remoteRef = name;
    } else {
      remoteRef = expandPattern(p.src ?? "", p.dst ?? p.src ?? "", name);
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

  // --prune: remote refs a pattern's destination (its source, without a colon) or ":" covers,
  // whose source is gone here (git's get_ref_match from the destination side)
  if (options.prune) {
    for (const [name, oid] of remote) {
      if (matched.has(name)) continue;
      const p = patternFor(name, "dst");
      if (!p) continue;
      let src: string;
      if (p.matching) {
        if (!name.startsWith("refs/heads/")) continue;
        src = name;
      } else {
        src = expandPattern(p.dst ?? p.src ?? "", p.src ?? "", name);
      }
      if (local.refs.has(src) || excluded(src)) continue;
      link({ remoteRef: name, newOid: ZERO_OID, oldOid: oid, force: p.force }, false);
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
  /**
   * The remote ref (a full name, or a short one: `main`). Omitted: every pushed ref no other
   * entry names, each at its remote-tracking value (a bare `--force-with-lease`).
   */
  ref?: string;
  /**
   * The value it must have: an object id or any revision here (`main~1`, an abbreviated id);
   * {@link ZERO_OID} or "" for "must not exist". Omitted: the remote ref's remote-tracking value
   * here (see `PushClientOptions.trackingValue`).
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
      ...(m.source !== undefined ? { source: m.source } : {}),
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

/**
 * git's status column for an update (`print_one_push_status`), with its reason in
 * parentheses (`[rejected] (fetch first)`) and a `+ ` before a forced update; ids abbreviated
 * by `lengths` (git's find_unique_abbrev under `core.abbrev`), 7 digits without.
 */
export function pushSummary(update: PushRefUpdate, lengths?: AbbrevLengths): string {
  const parts = pushStatusParts(update, lengths);
  if (update.status === "ok" && parts.flag === "+") {
    return `+ ${parts.summary} (${parts.message})`;
  }
  if (update.status === "ok" || update.status === "up-to-date") return parts.summary;
  return parts.message !== undefined ? `${parts.summary} (${parts.message})` : parts.summary;
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

/** `name` (matching the pattern `from`) mapped onto the pattern `to`. */
function expandPattern(from: string, to: string, name: string): string {
  const star = from.indexOf("*");
  if (star < 0) return to;
  const middle = name.slice(star, name.length - (from.length - star - 1));
  return to.replace("*", middle);
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
