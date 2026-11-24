/**
 * The reflog walk of `git log -g` (reflog-walk.c): each name given (`HEAD`, `main@{2}`,
 * `HEAD@{now}`) opens one reflog at one entry, and the walk takes, entry by entry, the newest
 * of the logs' current entries (the first log named wins a tie), passing over entries whose
 * new value is no commit.
 *
 * @example
 * ```typescript
 * const logs = await openReflogWalk(["HEAD", "main@{1}"], host);
 * for await (const step of walkReflogs(logs, (id) => commits.load(id))) {
 *   console.log(step.reflog.ref, step.reflog.index, step.id);
 * }
 * ```
 */

import type { Commit, ObjectId, ReflogEntry } from "@statewalker/vcs-core";
import { approxidateCareful } from "./git-date.js";
import type { LogReflogEntry } from "./log-output.js";

/** What opening a reflog walk reads of the repository. */
export interface ReflogWalkHost {
  /** A ref's reflog, oldest entry first; undefined or empty when it has none */
  reflog(ref: string): Promise<ReflogEntry[] | undefined>;
  /**
   * refs_resolve_refdup: the ref a symbolic `ref` ends at, or `ref` itself; undefined when it
   * names no ref. `reading`: only a ref that holds a value (RESOLVE_REF_READING)
   */
  resolveRef(ref: string, reading: boolean): Promise<string | undefined>;
  /** repo_interpret_branch_name over the start of a name (`@{-1}`, `@{u}`, `@`) */
  interpretBranchPrefix(name: string): Promise<{ used: number; value: string } | undefined>;
  /** repo_dwim_log: the refs whose reflog a name names by the ref rules */
  dwimLogRefs(name: string): Promise<string[]>;
  /** refs_shorten_unambiguous_ref, for `%gd` */
  shortenRef(ref: string): Promise<string>;
  /** The time `@{<date>}` selectors are read against (seconds) */
  now(): number;
}

/** One reflog of a walk, opened at one entry (reflog-walk.c's `commit_reflog`). */
export interface ReflogWalkLog {
  /** The ref as the walk names it (`HEAD`, `main`, `refs/heads/main`) */
  readonly ref: string;
  /** Its shortened name (`%gd`) */
  readonly shortRef: string;
  /** The entries, oldest first */
  readonly items: readonly ReflogEntry[];
  /** How the name selected the first entry: `@{<n>}`, `@{<date>}` or neither */
  readonly selector: "index" | "date" | undefined;
  /** The entry to read next (counting from the oldest), -1 when done */
  recno: number;
}

/**
 * add_reflog_for_walk for each name: the logs a walk reads. A name whose reflog is missing or
 * empty, or whose `@{<date>}` lies before its first entry, opens nothing (git skips it).
 * Throws where git dies (`no current branch`).
 */
export async function openReflogWalk(
  names: readonly string[],
  host: ReflogWalkHost,
): Promise<ReflogWalkLog[]> {
  const read = new Map<string, Promise<{ ref: string; items: ReflogEntry[] } | undefined>>();
  const logs: ReflogWalkLog[] = [];
  for (const given of names) {
    const name = await interpretedName(given, host);
    // strchr(name, '@'): only the first `@` can start a selector
    const at = name.indexOf("@");
    let branch = name;
    let selector: "index" | "date" | undefined;
    let recno = 0;
    let timestamp = 0;
    if (at >= 0 && name[at + 1] === "{") {
      branch = name.slice(0, at);
      const spec = name.slice(at + 2);
      const digits = /^[0-9]*/.exec(spec)?.[0] ?? "";
      if (spec[digits.length] === "}") {
        selector = "index";
        recno = digits === "" ? 0 : Number(digits);
      } else {
        selector = "date";
        recno = -1;
        const close = spec.lastIndexOf("}");
        timestamp = approxidateCareful(
          close >= 0 ? spec.slice(0, close) : spec,
          host.now(),
        ).timestamp;
      }
    }
    let found = read.get(branch);
    if (!found) {
      found = readWalkedReflog(branch, host);
      read.set(branch, found);
    }
    const reflog = await found;
    if (!reflog) continue;
    const { items } = reflog;
    let start: number;
    if (recno < 0) {
      // get_reflog_recno_by_time: the newest entry not after the date
      start = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        if (timestamp >= (items[i] as ReflogEntry).who.timestamp) {
          start = i;
          break;
        }
      }
      if (start < 0) continue;
    } else start = items.length - recno - 1;
    logs.push({
      ref: reflog.ref,
      shortRef: await host.shortenRef(reflog.ref),
      items,
      selector,
      recno: start,
    });
  }
  return logs;
}

/** add_pending_object_with_path: the name with a leading `@{-N}` / `@{u}` interpreted */
async function interpretedName(name: string, host: ReflogWalkHost): Promise<string> {
  const interpreted = await host.interpretBranchPrefix(name).catch(() => undefined);
  if (!interpreted || interpreted.used <= 0 || interpreted.value === "") return name;
  return interpreted.used < name.length
    ? interpreted.value + name.slice(interpreted.used)
    : interpreted.value;
}

/** The reflog add_reflog_for_walk reads for a name (without its selector) */
async function readWalkedReflog(
  name: string,
  host: ReflogWalkHost,
): Promise<{ ref: string; items: ReflogEntry[] } | undefined> {
  let branch = name;
  if (branch === "") {
    // `@{n}`: the branch HEAD is at
    const head = await host.resolveRef("HEAD", false);
    if (!head) throw new Error("no current branch");
    branch = head;
  }
  let items = await readCompleteReflog(branch, host);
  if (items.length === 0) {
    const found = await host.dwimLogRefs(branch).catch(() => []);
    if (found.length === 1) {
      branch = found[0] as string;
      items = await readCompleteReflog(branch, host);
    }
  }
  return items.length > 0 ? { ref: branch, items } : undefined;
}

/** read_complete_reflog: the ref's own log, its target's, then `refs/<ref>`'s, `refs/heads/<ref>`'s */
async function readCompleteReflog(ref: string, host: ReflogWalkHost): Promise<ReflogEntry[]> {
  const read = async (name: string) => (await host.reflog(name).catch(() => undefined)) ?? [];
  let items = await read(ref);
  if (items.length > 0) return items;
  const target = await host.resolveRef(ref, true).catch(() => undefined);
  if (target) {
    items = await read(target);
    if (items.length > 0) return items;
  }
  items = await read(`refs/${ref}`);
  if (items.length > 0) return items;
  return read(`refs/heads/${ref}`);
}

/** One step of a reflog walk: the commit shown and the entry it is shown for */
export interface ReflogWalkStep {
  id: ObjectId;
  commit: Commit;
  /** The entry, as the log printer shows it */
  reflog: LogReflogEntry;
  /** The entry's time (what `--since`/`--until` compare in a reflog walk) */
  time: number;
}

/**
 * next_reflog_entry until every log is done: of the logs' current entries naming commits,
 * the newest (the first log on a tie). `loadCommit` gives undefined for an id that names no
 * commit (missing, or another type), which the walk passes over.
 */
export async function* walkReflogs(
  logs: readonly ReflogWalkLog[],
  loadCommit: (id: ObjectId) => Promise<Commit | undefined>,
): AsyncGenerator<ReflogWalkStep> {
  const current = new Map<ReflogWalkLog, Commit | undefined>();
  /** next_reflog_commit: the log's current entry moved to one naming a commit */
  const nextCommit = async (log: ReflogWalkLog): Promise<Commit | undefined> => {
    if (current.has(log)) return current.get(log);
    for (; log.recno >= 0; log.recno--) {
      const entry = log.items[log.recno] as ReflogEntry;
      const commit = await loadCommit(entry.newId).catch(() => undefined);
      if (commit) {
        current.set(log, commit);
        return commit;
      }
    }
    current.set(log, undefined);
    return undefined;
  };
  for (;;) {
    let best: ReflogWalkLog | undefined;
    let bestCommit: Commit | undefined;
    for (const log of logs) {
      const commit = await nextCommit(log);
      if (!commit) continue;
      const time = (log.items[log.recno] as ReflogEntry).who.timestamp;
      if (!best || time > (best.items[best.recno] as ReflogEntry).who.timestamp) {
        best = log;
        bestCommit = commit;
      }
    }
    if (!best || !bestCommit) return;
    const taken = best.recno;
    best.recno--;
    current.delete(best);
    const entry = best.items[taken] as ReflogEntry;
    // get_reflog_message: the message less its last character (the line end)
    const message = entry.comment.endsWith("\n") ? entry.comment.slice(0, -1) : entry.comment;
    yield {
      id: entry.newId,
      commit: bestCommit,
      time: entry.who.timestamp,
      reflog: {
        ref: best.ref,
        shortRef: best.shortRef,
        index: best.items.length - 1 - taken,
        message,
        who: entry.who,
        ...(best.selector ? { selector: best.selector } : {}),
      },
    };
  }
}
