/**
 * `git reflog expire --all`, as `git gc` runs it before it computes what is reachable
 * (reflog.c, builtin/reflog.c, the files backend's `files_reflog_expire`): every reflog of
 * the repository and of its linked worktrees loses the entries older than `gc.reflogExpire`
 * (default 90 days), and the entries older than `gc.reflogExpireUnreachable` (default 30
 * days) whose old or new commit the ref's current tip does not reach (for a HEAD: no ref
 * reaches). `gc.<pattern>.reflogExpire[Unreachable]` set them per ref (the first pattern
 * that matches the ref's name, wildmatch), and `refs/stash` never expires unless a pattern
 * names it.
 */

import type { FilesApi, GitObjects, ObjectId, Refs } from "@statewalker/vcs-core";
import { joinPath } from "@statewalker/vcs-core";
import { approxidateCareful } from "@statewalker/vcs-utils";
import { atomicFilesOver } from "@statewalker/vcs-utils/files";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";
import {
  configFilesApiOf,
  createWorkingCopyConfig,
} from "./workspace/working-copy/working-copy-config.files.js";

const OID = /^[0-9a-f]{40}$/;
const ZERO = "0".repeat(40);
const DAY = 24 * 3600;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** git's default `gc.reflogExpire`: 90 days. */
export const DEFAULT_REFLOG_EXPIRE = "90.days.ago";
/** git's default `gc.reflogExpireUnreachable`: 30 days. */
export const DEFAULT_REFLOG_EXPIRE_UNREACHABLE = "30.days.ago";

/** An expiry value git refuses (`git_config_expiry_date`: git dies). */
export class ReflogExpiryConfigError extends Error {
  override name = "ReflogExpiryConfigError";
}

export interface ExpireReflogsOptions {
  files: FilesApi;
  /** Path to the `.git` directory within `files` (default ".git") */
  gitDir?: string;
  /** The refs: every ref's tip marks what the reflogs of HEADs keep */
  refs: Pick<Refs, "list" | "resolve">;
  /** The objects, to walk the commits */
  objects: GitObjects;
  /** System, global and command-line config besides the repository's */
  environment?: GitHostEnvironment;
  /** "Now", in seconds since the epoch (default the clock's) */
  now?: number;
  /** `--expire=<time>`: replaces every configured `reflogExpire` (seconds; 0 never, Infinity all) */
  expire?: number;
  /** `--expire-unreachable=<time>` (seconds; 0 never, Infinity all) */
  expireUnreachable?: number;
  /** `-n`: count what would be pruned, write nothing */
  dryRun?: boolean;
}

export interface ExpireReflogsResult {
  /** Reflogs looked at, as git names them (`HEAD`, `refs/heads/main`, `worktrees/<id>/HEAD`) */
  reflogs: string[];
  /** Entries removed (or that would be, in a dry run) */
  pruned: number;
  /** git's error lines (`cannot lock ref '<ref>': ...`); the reflog is then left alone */
  errors: string[];
}

interface Policy {
  /** entries older than this go (seconds) */
  total: number;
  /** entries older than this go when unreachable (seconds) */
  unreachable: number;
}

/**
 * Whether gc runs the reflog step at all: git skips it when both `gc.reflogExpire` and
 * `gc.reflogExpireUnreachable` are `never` (`gc_config_is_timestamp_never`).
 */
export async function gcExpiresReflogs(
  files: FilesApi,
  gitDir = ".git",
  options: { environment?: GitHostEnvironment } = {},
): Promise<boolean> {
  const config = await readConfig(files, gitDir, options.environment);
  const never = (key: string) => {
    const v = config.get(key);
    return v !== undefined && v !== null && parseExpiryDate(String(v), 0, key) === 0;
  };
  return !(never("gc.reflogExpire") && never("gc.reflogExpireUnreachable"));
}

/**
 * Expires the entries of every reflog (`git reflog expire --all`).
 *
 * @example
 * ```typescript
 * const { history, files } = await createGitFilesBackend({ files });
 * const { pruned } = await expireReflogs({ files, refs: history.refs, objects: history.objects });
 * ```
 */
export async function expireReflogs(options: ExpireReflogsOptions): Promise<ExpireReflogsResult> {
  const { files, gitDir = ".git", objects } = options;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const config = await readConfig(files, gitDir, options.environment);
  // reflog_expire_config: the defaults, then each gc.<pattern>.* in the order first seen
  let defaultTotal = now - 90 * DAY;
  let defaultUnreachable = now - 30 * DAY;
  const patterns: { pattern: string; total: number; unreachable: number }[] = [];
  for (const e of config.listWithOrigin()) {
    const key = e.key;
    if (!/^gc\./i.test(key)) continue;
    const dot = key.lastIndexOf(".");
    const name = key.slice(dot + 1).toLowerCase();
    if (name !== "reflogexpire" && name !== "reflogexpireunreachable") continue;
    const text = e.text;
    if (text === undefined) throw new ReflogExpiryConfigError(`missing value for '${key}'`);
    const value = parseExpiryDate(text, now, key);
    const pattern = dot > 2 ? key.slice(3, dot) : undefined;
    if (pattern === undefined) {
      if (name === "reflogexpire") defaultTotal = value;
      else defaultUnreachable = value;
      continue;
    }
    let ent = patterns.find((p) => p.pattern === pattern);
    if (!ent) {
      // a new entry starts at 0 (git's FLEX_ALLOC zeroes it): never
      ent = { pattern, total: 0, unreachable: 0 };
      patterns.push(ent);
    }
    if (name === "reflogexpire") ent.total = value;
    else ent.unreachable = value;
  }
  const policyOf = (ref: string): Policy => {
    // reflog_expire_options_set_refname
    let total = defaultTotal;
    let unreachable = defaultUnreachable;
    const ent = patterns.find((p) => wildmatch(p.pattern, ref));
    if (ent) {
      total = ent.total;
      unreachable = ent.unreachable;
    } else if (ref === "refs/stash") {
      total = 0;
      unreachable = 0;
    }
    if (options.expire !== undefined) total = options.expire;
    if (options.expireUnreachable !== undefined) unreachable = options.expireUnreachable;
    return { total, unreachable };
  };

  const graph = new CommitGraph(objects);
  // a reftable store (of whichever worktree gc runs in): the repository's, whose reflogs
  // are the main worktree's and the shared ones, the linked worktrees' named by id
  const repository =
    (options.refs as { repositoryStore?(): ExpireReflogsOptions["refs"] }).repositoryStore?.call(
      options.refs,
    ) ?? options.refs;
  const reftable = repository as Partial<ReftableReflogs>;
  if (reftable.reflogNames && reftable.expireReflog) {
    return expireReftableReflogs(
      reftable as ReftableReflogs,
      { ...options, refs: repository },
      policyOf,
      graph,
    );
  }
  const reflogs = await collectReflogs(files, gitDir);
  const atomic = atomicFilesOver(files, gitDir);
  const result: ExpireReflogsResult = {
    reflogs: reflogs.map((r) => r.name),
    pruned: 0,
    errors: [],
  };
  /** every ref's tip (refs/ only, symrefs left out): what HEAD's entries must be reachable from */
  let allTips: ObjectId[] | undefined;
  for (const reflog of reflogs) {
    const policy = policyOf(reflog.name);
    const lock = `${reflog.refPath}.lock`;
    if (!options.dryRun) {
      if (!(await atomic.createExclusive(lock, new Uint8Array(0)))) {
        result.errors.push(
          `error: cannot lock ref '${reflog.name}': Unable to create '${joinPath(gitDir, lock)}': File exists.`,
        );
        continue;
      }
    }
    try {
      const text = await readText(files, joinPath(gitDir, reflog.logPath));
      if (text === undefined) continue;
      // reflog_expiry_prepare
      const head = reflog.name === "HEAD" || /^worktrees\/[^/]+\/HEAD$/.test(reflog.name);
      let kind: "always" | "normal" | "head";
      let reach: ((id: ObjectId) => Promise<boolean>) | undefined;
      if (!policy.unreachable || head) kind = "head";
      else {
        const tip = await resolveTip(options.refs, files, gitDir, reflog);
        const commit = tip ? await graph.peelToCommit(tip) : undefined;
        kind = commit ? "normal" : "always";
        if (commit) reach = graph.reachability([commit]);
      }
      if (policy.unreachable <= policy.total) kind = "always";
      if (kind === "head") {
        allTips ??= await refTips(options.refs, graph);
        reach = graph.reachability(allTips);
      }
      const kept: string[] = [];
      let pruned = 0;
      const lines = text.split("\n");
      // the last line without its newline is corrupt to show_one_reflog_ent
      const unterminated = lines.pop() as string;
      for (const line of lines) {
        const entry = parseEntry(line);
        if (!entry) {
          // show_one_reflog_ent passes over a line it cannot parse: not written back
          pruned++;
          continue;
        }
        if (await shouldExpire(entry, policy, kind, reach, graph)) pruned++;
        else kept.push(entry.line);
      }
      if (unterminated !== "") pruned++;
      result.pruned += pruned;
      // files_reflog_expire writes the log anew whatever it pruned, each entry as
      // expire_reflog_ent prints it (`<tz>\t<message>`, a tab even before an empty message)
      const rewritten = kept.map((l) => `${l}\n`).join("");
      if (!options.dryRun && rewritten !== text) {
        const logLock = `${reflog.logPath}.lock`;
        if (!(await atomic.createExclusive(logLock, enc.encode(rewritten)))) {
          result.errors.push(
            `error: Unable to create '${joinPath(gitDir, logLock)}': File exists.`,
          );
          continue;
        }
        await atomic.replace(logLock, reflog.logPath);
      }
    } finally {
      if (!options.dryRun) await atomic.remove(lock);
    }
  }
  return result;
}

/** The reflog operations of a reftable ref store (`ReftableRefStore`). */
interface ReftableReflogs {
  reflogNames(worktree?: string): Promise<string[]>;
  expireReflog(
    name: string,
    prune: (
      entries: readonly { oldId: string; newId: string; time: number }[],
    ) => Promise<boolean[]>,
    options?: { dryRun?: boolean },
  ): Promise<number>;
}

/**
 * `git reflog expire --all` in a reftable repository (reftable_be_reflog_expire): each
 * reflog of the repository and of its linked worktrees (`worktrees/<id>/...`), every one
 * rewritten in a table of its own whatever it loses, as git writes them.
 */
async function expireReftableReflogs(
  refs: ReftableReflogs,
  options: ExpireReflogsOptions,
  policyOf: (ref: string) => Policy,
  graph: CommitGraph,
): Promise<ExpireReflogsResult> {
  const { files, gitDir = ".git" } = options;
  const names = await refs.reflogNames();
  const worktrees = joinPath(gitDir, "worktrees");
  if ((await files.stats(worktrees))?.kind === "directory") {
    const ids: string[] = [];
    for await (const e of files.list(worktrees)) if (e.kind === "directory") ids.push(e.name);
    for (const id of ids.sort()) {
      for (const name of await refs.reflogNames(id)) {
        if (name.startsWith("worktrees/")) names.push(name);
      }
    }
  }
  const result: ExpireReflogsResult = { reflogs: names, pruned: 0, errors: [] };
  let allTips: ObjectId[] | undefined;
  for (const name of names) {
    const policy = policyOf(name);
    const head = name === "HEAD" || /^worktrees\/[^/]+\/HEAD$/.test(name);
    let kind: "always" | "normal" | "head";
    let reach: ((id: ObjectId) => Promise<boolean>) | undefined;
    if (!policy.unreachable || head) kind = "head";
    else {
      const tip = (await options.refs.resolve(name).catch(() => undefined))?.objectId;
      const commit = tip ? await graph.peelToCommit(tip) : undefined;
      kind = commit ? "normal" : "always";
      if (commit) reach = graph.reachability([commit]);
    }
    if (policy.unreachable <= policy.total) kind = "always";
    if (kind === "head") {
      allTips ??= await refTips(options.refs, graph);
      reach = graph.reachability(allTips);
    }
    try {
      result.pruned += await refs.expireReflog(
        name,
        async (entries) => {
          const verdicts: boolean[] = [];
          for (const e of entries) {
            verdicts.push(
              await shouldExpire({ ...e, timestamp: e.time }, policy, kind, reach, graph),
            );
          }
          return verdicts;
        },
        { dryRun: options.dryRun === true },
      );
    } catch (error) {
      result.errors.push(`error: cannot lock ref '${name}': ${(error as Error).message}`);
    }
  }
  return result;
}

/** should_expire_reflog_ent (without --stale-fix and record numbers). */
async function shouldExpire(
  entry: { oldId: string; newId: string; timestamp: number },
  policy: Policy,
  kind: "always" | "normal" | "head",
  reach: ((id: ObjectId) => Promise<boolean>) | undefined,
  graph: CommitGraph,
): Promise<boolean> {
  if (entry.timestamp < policy.total) return true;
  if (entry.timestamp < policy.unreachable) {
    if (kind === "always") return true;
    const unreachable = async (id: string) => {
      if (id === ZERO) return false;
      const commit = await graph.peelToCommit(id);
      // not a commit: kept
      if (!commit) return false;
      return !(await (reach as (id: ObjectId) => Promise<boolean>)(commit));
    };
    if ((await unreachable(entry.oldId)) || (await unreachable(entry.newId))) return true;
  }
  return false;
}

/**
 * One reflog line: `<old> <new> <ident> <timestamp> <tz>\t<message>`, as show_one_reflog_ent
 * parses it (the ident up to its first `>`), with `line` as expire_reflog_ent writes it back.
 */
function parseEntry(
  line: string,
): { oldId: string; newId: string; timestamp: number; line: string } | undefined {
  const oldId = line.slice(0, 40);
  const newId = line.slice(41, 81);
  if (!OID.test(oldId) || !OID.test(newId) || line[40] !== " " || line[81] !== " ")
    return undefined;
  const gt = line.indexOf(">", 82);
  if (gt < 0 || line[gt + 1] !== " ") return undefined;
  const m = /^(\d+) ([+-]\d{4})/.exec(line.slice(gt + 2));
  if (!m || Number(m[1]) === 0) return undefined;
  let rest = line.slice(gt + 2 + (m[0] as string).length);
  if (rest.startsWith("\t")) rest = rest.slice(1);
  const tzNumber = Number.parseInt(m[2] as string, 10);
  const tz = `${tzNumber < 0 ? "-" : "+"}${String(Math.abs(tzNumber)).padStart(4, "0")}`;
  return {
    oldId,
    newId,
    timestamp: Number(m[1]),
    line: `${line.slice(0, gt + 1)} ${m[1]} ${tz}\t${rest}`,
  };
}

/** A reflog: its name as git names it, the ref file and the log file under the git directory. */
interface ReflogFile {
  name: string;
  refPath: string;
  logPath: string;
}

/** The reflogs of the repository (`logs/...`) and of each linked worktree (`worktrees/<id>/logs/...`). */
async function collectReflogs(files: FilesApi, gitDir: string): Promise<ReflogFile[]> {
  const out: ReflogFile[] = [];
  const walk = async (logsDir: string, prefix: string) => {
    if ((await files.stats(logsDir))?.kind !== "directory") return;
    const rec = async (dir: string, rel: string) => {
      const entries: { name: string; path: string; kind: string }[] = [];
      for await (const e of files.list(dir)) entries.push(e);
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        const name = rel ? `${rel}/${e.name}` : e.name;
        if (e.kind === "directory") await rec(e.path, name);
        else if (e.kind === "file" && !name.endsWith(".lock"))
          out.push({
            name: `${prefix}${name}`,
            refPath: `${prefix}${name}`,
            logPath: `${prefix}logs/${name}`,
          });
      }
    };
    await rec(logsDir, "");
  };
  await walk(joinPath(gitDir, "logs"), "");
  const worktrees = joinPath(gitDir, "worktrees");
  if ((await files.stats(worktrees))?.kind === "directory") {
    const ids: string[] = [];
    for await (const e of files.list(worktrees)) if (e.kind === "directory") ids.push(e.name);
    ids.sort();
    for (const id of ids) await walk(joinPath(worktrees, id, "logs"), `worktrees/${id}/`);
  }
  return out;
}

/** The ref's current value (git's lock_ref_oid_basic resolves it): undefined when it has none. */
async function resolveTip(
  refs: Pick<Refs, "resolve">,
  files: FilesApi,
  gitDir: string,
  reflog: ReflogFile,
): Promise<ObjectId | undefined> {
  if (reflog.name.startsWith("worktrees/")) {
    // a linked worktree's own ref: its file, or a symbolic ref into the repository's refs
    const text = (await readText(files, joinPath(gitDir, reflog.refPath)))?.trim();
    if (!text) return undefined;
    if (OID.test(text)) return text;
    if (text.startsWith("ref: "))
      return (await refs.resolve(text.slice(5)).catch(() => undefined))?.objectId ?? undefined;
    return undefined;
  }
  const r = await refs.resolve(reflog.name).catch(() => undefined);
  return r?.objectId ?? undefined;
}

/** Every ref's tip under `refs/`, peeled to a commit, symbolic refs left out (push_tip_to_list). */
async function refTips(refs: Pick<Refs, "list">, graph: CommitGraph): Promise<ObjectId[]> {
  const tips: ObjectId[] = [];
  for await (const ref of refs.list("refs/")) {
    const r = ref as { objectId?: string; target?: string };
    if (!r.objectId || r.target !== undefined) continue;
    const commit = await graph.peelToCommit(r.objectId);
    if (commit) tips.push(commit);
  }
  return tips;
}

/** The commits the reflog step reads: parents, tags peeled. */
class CommitGraph {
  private parents = new Map<ObjectId, ObjectId[] | null>();
  private peeled = new Map<ObjectId, ObjectId | null>();
  constructor(private objects: GitObjects) {}

  private async read(id: ObjectId): Promise<{ type: string; text: string } | undefined> {
    let o: Awaited<ReturnType<GitObjects["get"]>>;
    try {
      o = await this.objects.get(id);
    } catch {
      return undefined;
    }
    if (!o) return undefined;
    if (o.type !== "commit" && o.type !== "tag") {
      if (!o.bytes) await o.content[Symbol.asyncIterator]().return?.();
      return { type: o.type, text: "" };
    }
    let bytes = o.bytes;
    if (!bytes) {
      const parts: Uint8Array[] = [];
      for await (const c of o.content) parts.push(c);
      bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        bytes.set(p, at);
        at += p.length;
      }
    }
    const end = bytes.indexOf(0x0a, 0) < 0 ? bytes.length : findHeaderEnd(bytes);
    return { type: o.type, text: dec.decode(bytes.subarray(0, end)) };
  }

  /** lookup_commit_reference_gently: the commit an id names, through tags; undefined if none. */
  async peelToCommit(id: ObjectId): Promise<ObjectId | undefined> {
    const known = this.peeled.get(id);
    if (known !== undefined) return known ?? undefined;
    let at = id;
    let result: ObjectId | null = null;
    for (let depth = 0; depth < 64; depth++) {
      const o = await this.read(at);
      if (!o) break;
      if (o.type === "commit") {
        result = at;
        this.parents.set(at, parseParents(o.text));
        break;
      }
      if (o.type !== "tag") break;
      const m = /^object ([0-9a-f]{40})$/m.exec(o.text);
      if (!m) break;
      at = m[1] as string;
    }
    this.peeled.set(id, result);
    return result ?? undefined;
  }

  private async parentsOf(id: ObjectId): Promise<ObjectId[] | null> {
    if (this.parents.has(id)) return this.parents.get(id) as ObjectId[] | null;
    const o = await this.read(id);
    const p = o?.type === "commit" ? parseParents(o.text) : null;
    this.parents.set(id, p);
    return p;
  }

  /**
   * Whether a commit is reachable from `tips` (mark_reachable, dug down to the roots): a
   * commit that cannot be read is not marked and its parents are not walked.
   */
  reachability(tips: readonly ObjectId[]): (id: ObjectId) => Promise<boolean> {
    let marked: Set<ObjectId> | undefined;
    return async (id) => {
      if (!marked) {
        marked = new Set();
        const pending = [...tips];
        while (pending.length > 0) {
          const c = pending.pop() as ObjectId;
          if (marked.has(c)) continue;
          const parents = await this.parentsOf(c);
          if (!parents) continue;
          marked.add(c);
          for (const p of parents) if (!marked.has(p)) pending.push(p);
        }
      }
      return marked.has(id);
    };
  }
}

function findHeaderEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 1 < bytes.length; i++)
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) return i;
  return bytes.length;
}

function parseParents(header: string): ObjectId[] {
  const out: ObjectId[] = [];
  for (const line of header.split("\n")) {
    if (line.startsWith("parent ") && OID.test(line.slice(7, 47))) out.push(line.slice(7, 47));
  }
  return out;
}

async function readText(files: FilesApi, path: string): Promise<string | undefined> {
  if ((await files.stats(path))?.kind !== "file") return undefined;
  const parts: string[] = [];
  const d = new TextDecoder();
  for await (const c of files.read(path)) parts.push(d.decode(c, { stream: true }));
  parts.push(d.decode());
  return parts.join("");
}

async function readConfig(files: FilesApi, gitDir: string, environment?: GitHostEnvironment) {
  return createWorkingCopyConfig(
    configFilesApiOf(files, { readOnly: "reading the gc settings never writes the config" }),
    gitDir,
    undefined,
    environment ? { environment } : {},
  );
}

/**
 * git's `parse_expiry_date` in seconds: exactly `never`/`false` 0 (nothing expires),
 * `all`/`now` Infinity (git's TIME_MAX), anything else through `approxidate_careful`
 * (`2.weeks.ago`, `2 weeks`, `90.days`, `yesterday`, `two.weeks.ago`, absolute dates, epoch
 * seconds). A value approxidate cannot read is refused as git dies.
 */
export function parseExpiryDate(value: string, now: number, key = "expiry"): number {
  if (value === "never" || value === "false") return 0;
  if (value === "all" || value === "now") return Number.POSITIVE_INFINITY;
  const { timestamp, error } = approxidateCareful(value, now);
  if (error) throw new ReflogExpiryConfigError(`'${value}' for '${key}' is not a valid timestamp`);
  return timestamp;
}

/**
 * git's wildmatch without flags (no WM_PATHNAME): `*` matches across `/`, `?` one character,
 * `[...]` a class (`!`/`^` negates, ranges), `\` escapes the next character.
 */
export function wildmatch(pattern: string, text: string): boolean {
  const match = (p: number, t: number): boolean => {
    while (p < pattern.length) {
      const c = pattern[p] as string;
      if (c === "*") {
        while (pattern[p] === "*") p++;
        if (p === pattern.length) return true;
        for (let k = t; k <= text.length; k++) if (match(p, k)) return true;
        return false;
      }
      if (t >= text.length) return false;
      if (c === "?") {
        p++;
        t++;
        continue;
      }
      if (c === "[") {
        let q = p + 1;
        let negate = false;
        if (pattern[q] === "!" || pattern[q] === "^") {
          negate = true;
          q++;
        }
        let matched = false;
        let first = true;
        const ch = text[t] as string;
        while (q < pattern.length && (first || pattern[q] !== "]")) {
          first = false;
          let lo = pattern[q] as string;
          if (lo === "\\") lo = pattern[++q] as string;
          if (pattern[q + 1] === "-" && pattern[q + 2] !== undefined && pattern[q + 2] !== "]") {
            const hi = pattern[q + 2] as string;
            if (ch >= lo && ch <= hi) matched = true;
            q += 3;
          } else {
            if (ch === lo) matched = true;
            q++;
          }
        }
        if (pattern[q] !== "]") return false;
        if (matched === negate) return false;
        p = q + 1;
        t++;
        continue;
      }
      const lit = c === "\\" ? (pattern[++p] as string) : c;
      if (lit !== text[t]) return false;
      p++;
      t++;
    }
    return t === text.length;
  };
  return match(0, 0);
}
