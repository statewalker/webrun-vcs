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

import type { FilesApi, GitObjects, ObjectId, ReflogLine, Refs } from "@statewalker/vcs-core";
import {
  decodeTreeBytes,
  joinPath,
  objectFormatOf,
  PromisorFetchError,
} from "@statewalker/vcs-core";
import { approxidateCareful } from "@statewalker/vcs-utils";
import { atomicFilesOver } from "@statewalker/vcs-utils/files";
import type { ObjectFormat } from "@statewalker/vcs-utils/hash";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";
import { assertAlternatesReadable } from "./alternates/index.js";
import { objectIdPattern } from "./object-names.js";
import {
  configFilesApiOf,
  createWorkingCopyConfig,
} from "./workspace/working-copy/working-copy-config.files.js";

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
  /**
   * The reflogs to expire, as git names them (`HEAD`, `refs/heads/main`,
   * `worktrees/<id>/HEAD`), in order; default every reflog (`--all`)
   */
  names?: string[];
  /** With `names`: every reflog first (`--all`), then the ones named, as git takes both */
  all?: boolean;
  /**
   * `--single-worktree` with `--all`: only the reflogs of the current worktree (`worktree`,
   * the main one when undefined) and the shared ones
   */
  singleWorktree?: boolean;
  /** The id of the linked worktree the command runs in (undefined: the main worktree) */
  worktree?: string;
  /**
   * The git version to follow: 2.43's reflog_expiry_prepare looks the tip up with
   * `lookup_commit`, so a ref at an annotated tag gets git's error line (`Object <id> not a
   * commit`, or `object <id> is a tag, not a commit` once the tag was read) and, read, its
   * unreachable entries all go
   */
  compatibility?: "2.43" | "2.56";
  /**
   * The caller already refused alternates this store cannot read (gc). Otherwise expiry
   * refuses them itself (`AlternatesUnreadableError`): their objects would look missing, so
   * `--stale-fix` and the reachability checks would drop entries git keeps
   */
  alternatesChecked?: boolean;
  /**
   * `--stale-fix`: entries naming a commit that is missing, or whose history or trees miss
   * objects (reflog.c's `keep_entry`), go too; what the refs reach counts as complete
   */
  staleFix?: boolean;
  /** `--rewrite`: each kept entry's old id the new id of the kept entry before it */
  rewrite?: boolean;
  /** `--updateref`: the ref (not a symbolic one) set to the newest kept entry's new id */
  updateRef?: boolean;
  /** `--verbose`: `keep`/`prune`/`would prune <message>` per entry in `output` */
  verbose?: boolean;
  /**
   * `git reflog delete`: the one entry to delete in each reflog (`@{<n>}`: `index`; `@{<date>}`:
   * the newest entry older than `before`, seconds); no configured expiry applies
   */
  select?: ReflogEntrySelector;
}

/** The entry `git reflog delete <ref>@{...}` names. */
export type ReflogEntrySelector = { index: number } | { before: number };

export interface ExpireReflogsResult {
  /** Reflogs looked at, as git names them (`HEAD`, `refs/heads/main`, `worktrees/<id>/HEAD`) */
  reflogs: string[];
  /** Entries removed (or that would be, in a dry run) */
  pruned: number;
  /** git's error lines (`cannot lock ref '<ref>': ...`); the reflog is then left alone */
  errors: string[];
  /** What git prints on stdout (`--verbose`) */
  output: string;
  /** Lines git prints on stderr without failing (2.43's tag-tip errors) */
  warnings?: string[];
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
  const output: string[] = [];
  try {
    return await runExpiry(options, output);
  } catch (error) {
    // git dies (a lazy fetch that failed): what it printed before stays printed
    if (error instanceof PromisorFetchError) {
      throw new ReflogExpiryAbortedError(error, output.join(""));
    }
    throw error;
  }
}

/**
 * Thrown when the expiry stops midway as git dies (a failed lazy fetch of `--stale-fix`,
 * the `PromisorFetchError` its `cause`):
 * nothing was written; `output` holds what was printed before, `cause` the failure.
 */
export class ReflogExpiryAbortedError extends Error {
  override name = "ReflogExpiryAbortedError";
  constructor(
    override readonly cause: Error,
    /** git's stdout up to the failure */
    readonly output: string,
  ) {
    super(cause.message, { cause });
  }
}

async function runExpiry(
  options: ExpireReflogsOptions,
  output: string[],
): Promise<ExpireReflogsResult> {
  const { files, gitDir = ".git", objects } = options;
  // ids of the repository's format (git's parse_oid_hex reads the_hash_algo's digits)
  const format = objectFormatOf(objects);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (!options.alternatesChecked) {
    await assertAlternatesReadable({ files, gitDir, objects }, "expire reflogs");
  }
  const policyOf = options.select
    ? // reflog_delete: no configured expiry, both cutoffs 0
      (): Policy => ({ total: 0, unreachable: 0 })
    : await configuredPolicy(files, gitDir, options, now);

  const graph = new CommitGraph(objects);
  // a reftable store (of whichever worktree gc runs in): the repository's, whose reflogs
  // are the main worktree's and the shared ones, the linked worktrees' named by id
  const repository =
    (options.refs as { repositoryStore?(): ExpireReflogsOptions["refs"] }).repositoryStore?.call(
      options.refs,
    ) ?? options.refs;
  const reftable = repository as Partial<ReftableReflogs>;
  const isReftable = Boolean(reftable.reflogNames && reftable.expireReflog);

  let stale: StaleFix | undefined;
  if (options.staleFix) {
    // cmd_reflog_expire: mark_reachable_objects from the refs and HEADs first
    if (options.verbose) output.push("Marking reachable objects...");
    stale = new StaleFix(graph, objects);
    await stale.markReachable(
      await staleFixRoots(options.refs, repository, files, gitDir, isReftable, format),
    );
    if (options.verbose) output.push("\n");
  }
  const context: ExpiryContext = {
    options,
    graph,
    stale,
    output,
    errors: [],
    tipsParsed: stale !== undefined,
  };

  if (isReftable) {
    // names and each reflog's own ref from the repository's store; what a HEAD's entries
    // must be reachable from is the current worktree's view (reflog.c's refs_for_each_ref
    // over get_main_ref_store: its own refs/bisect/, refs/worktree/, refs/rewritten/)
    const result = await expireReftableReflogs(
      reftable as ReftableReflogs,
      { ...options, refs: repository },
      policyOf,
      context,
      options.refs,
    );
    return {
      ...result,
      output: output.join(""),
      warnings: context.errors,
    };
  }
  const reflogs = [
    ...(options.names === undefined || options.all
      ? selectWorktree(await collectReflogs(files, gitDir), options)
      : []),
    ...(options.names ?? []).map((name) => ({ ...reflogFileOf(name), named: true })),
  ];
  const atomic = atomicFilesOver(files, gitDir);
  const result: ExpireReflogsResult = {
    reflogs: reflogs.map((r) => r.name),
    pruned: 0,
    errors: [],
    output: "",
  };
  const zero = format.nullId;
  for (const reflog of reflogs) {
    const policy = policyOf(reflog.name);
    // files_reflog_expire: the ref's lock first (lock_ref_oid_basic), a dry run too
    const lock = `${reflog.refPath}.lock`;
    if (!(await atomic.createExclusive(lock, new Uint8Array(0)))) {
      result.errors.push(
        `error: cannot lock ref '${reflog.name}': Unable to create '${joinPath(gitDir, lock)}': File exists.`,
      );
      continue;
    }
    let refLockHeld = true;
    try {
      const text = await readText(files, joinPath(gitDir, reflog.logPath));
      if (text === undefined) continue;
      const lines = text.split("\n");
      // the last line without its newline is corrupt to show_one_reflog_ent
      const unterminated = lines.pop() as string;
      const entries = lines.map((line) => parseEntry(line, format));
      const tip = await resolveTip(options.refs, files, gitDir, reflog, format);
      const pruner = await prepareExpiry(
        reflog.name,
        tip,
        policy,
        context,
        options.refs,
        entries.filter((e) => e !== undefined),
        "named" in reflog,
      );
      const kept: string[] = [];
      let lastKept = zero;
      let pruned = 0;
      for (const entry of entries) {
        if (!entry) {
          // show_one_reflog_ent passes over a line it cannot parse: not written back
          pruned++;
          continue;
        }
        // expire_reflog_ent: with --rewrite the policy sees the rewritten old id
        const oldId = options.rewrite ? lastKept : entry.oldId;
        if (await pruner.shouldPrune(oldId, entry.newId, entry.timestamp, `${entry.message}\n`)) {
          pruned++;
          continue;
        }
        if (options.dryRun) continue;
        kept.push(options.rewrite ? `${lastKept}${entry.line.slice(zero.length)}` : entry.line);
        lastKept = entry.newId;
      }
      if (unterminated !== "") pruned++;
      result.pruned += pruned;
      if (options.dryRun) continue;
      // --updateref: neither a symbolic ref nor a ref that does not exist is set
      const update =
        options.updateRef === true &&
        lastKept !== zero &&
        (await isDirectRef(options.refs, files, gitDir, reflog));
      // files_reflog_expire writes the log anew whatever it pruned, each entry as
      // expire_reflog_ent prints it (`<tz>\t<message>`, a tab even before an empty message)
      const rewritten = kept.map((l) => `${l}\n`).join("");
      if (rewritten !== text) {
        const logLock = `${reflog.logPath}.lock`;
        if (!(await atomic.createExclusive(logLock, enc.encode(rewritten)))) {
          result.errors.push(
            `error: Unable to create '${joinPath(gitDir, logLock)}': File exists.`,
          );
          continue;
        }
        await atomic.replace(logLock, reflog.logPath);
      }
      if (update) {
        await atomic.write(lock, enc.encode(`${lastKept}\n`));
        await atomic.replace(lock, reflog.refPath);
        refLockHeld = false;
      }
    } finally {
      if (refLockHeld) await atomic.remove(lock);
    }
  }
  result.output = output.join("");
  result.warnings = context.errors;
  return result;
}

/** The expiry per reflog name from `gc.reflogExpire*` (reflog_expire_config), the flags over it. */
async function configuredPolicy(
  files: FilesApi,
  gitDir: string,
  options: ExpireReflogsOptions,
  now: number,
): Promise<(ref: string) => Policy> {
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
  return (ref: string): Policy => {
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
}

/** What every reflog's expiry shares: the options, the commits read, `--stale-fix`'s marks. */
interface ExpiryContext {
  options: ExpireReflogsOptions;
  graph: CommitGraph;
  stale: StaleFix | undefined;
  output: string[];
  /** git's error lines */
  errors: string[];
  /** 2.43: whether the objects the refs name were parsed already (stale-fix, a HEAD's walk) */
  tipsParsed: boolean;
}

/** One reflog's should_expire_reflog_ent, after reflog_expiry_prepare. */
interface Pruner {
  shouldPrune(oldId: string, newId: string, timestamp: number, message: string): Promise<boolean>;
}

/**
 * reflog_expiry_prepare for `name` (its tip `tip`), and the per-entry decision
 * (should_expire_reflog_ent, `_verbose` with `--verbose`); `entries` (oldest first) give a
 * delete's record number (count_reflog_ent).
 */
async function prepareExpiry(
  name: string,
  tip: ObjectId | undefined,
  policy: Policy,
  context: ExpiryContext,
  currentRefs: Pick<Refs, "list">,
  entries: readonly { timestamp: number }[],
  /** named on the command line (git's policy then knows of no dry run) */
  named: boolean,
): Promise<Pruner> {
  const { graph, stale, options, output } = context;
  const head = name === "HEAD" || /^worktrees\/[^/]+\/HEAD$/.test(name);
  let kind: "always" | "normal" | "head";
  let reach: ((id: ObjectId) => Promise<boolean>) | undefined;
  if (!policy.unreachable || head) kind = "head";
  else {
    const commit = tip ? await graph.peelToCommit(tip) : undefined;
    kind = commit && !/^0+$/.test(commit) ? "normal" : "always";
    if (commit) reach = graph.reachability([commit]);
    const type = tip && commit !== tip ? await graph.typeOf(tip) : undefined;
    if (options.compatibility === "2.43" && tip && type !== undefined) {
      // 2.43's lookup_commit of a tip that is no commit
      if (context.tipsParsed) {
        context.errors.push(`error: object ${tip} is a ${type}, not a commit`);
        kind = "always";
      } else {
        context.errors.push(`error: Object ${tip} not a commit`);
        context.tipsParsed = true;
      }
    }
  }
  if (policy.unreachable <= policy.total) kind = "always";
  if (kind === "head") {
    reach = graph.reachability(await refTips(currentRefs, graph));
    context.tipsParsed = true;
  }
  // reflog_delete's record number: the entry to drop, counted from the oldest
  let recno = 0;
  const select = options.select;
  if (select && "index" in select) recno = entries.length - select.index;
  else if (select) {
    for (const e of entries) if (!select.before || e.timestamp < select.before) recno++;
  }
  return {
    async shouldPrune(oldId, newId, timestamp, message) {
      let expire = false;
      if (timestamp < policy.total) expire = true;
      else if (stale && (!(await stale.keep(oldId)) || !(await stale.keep(newId)))) expire = true;
      else if (
        timestamp < policy.unreachable &&
        (kind === "always" ||
          (await unreachable(oldId, reach, graph)) ||
          (await unreachable(newId, reach, graph)))
      )
        expire = true;
      else if (recno && --recno === 0) expire = true;
      if (options.verbose) {
        // only --all and delete tell the policy about a dry run (cmd_reflog_expire's cb)
        const would = options.dryRun && (!named || options.select);
        output.push(`${expire ? (would ? "would prune" : "prune") : "keep"} ${message}`);
      }
      return expire;
    },
  };
}

/** is_unreachable: a commit an id names that the tips do not reach (not a commit: kept). */
async function unreachable(
  id: string,
  reach: ((id: ObjectId) => Promise<boolean>) | undefined,
  graph: CommitGraph,
): Promise<boolean> {
  if (/^0+$/.test(id)) return false;
  const commit = await graph.peelToCommit(id);
  if (!commit) return false;
  return !(await (reach as (id: ObjectId) => Promise<boolean>)(commit));
}

/** The reflog operations of a reftable ref store (`ReftableRefStore`). */
interface ReftableReflogs {
  reflogNames(worktree?: string): Promise<string[]>;
  expireReflog(
    name: string,
    prune: (
      entries: readonly { oldId: string; newId: string; time: number; message: string }[],
    ) => Promise<boolean[]>,
    options?: { dryRun?: boolean; rewrite?: boolean; updateRef?: boolean },
  ): Promise<number>;
  dropReflog?(name: string): Promise<void>;
  appendReflog?(name: string, line: ReflogLine): Promise<void>;
  worktreeRefs?(worktree: string): Promise<{ name: string; objectId?: string }[]>;
}

/**
 * `git reflog expire` in a reftable repository (reftable_be_reflog_expire): each reflog
 * named, or of the repository and of its linked worktrees (`worktrees/<id>/...`), every one
 * rewritten in a table of its own whatever it loses, as git writes them.
 */
async function expireReftableReflogs(
  refs: ReftableReflogs,
  options: ExpireReflogsOptions,
  policyOf: (ref: string) => Policy,
  context: ExpiryContext,
  /** The current worktree's refs: every ref's tip there is what HEADs' entries must reach */
  currentRefs: Pick<Refs, "list">,
): Promise<ExpireReflogsResult> {
  const all =
    options.names === undefined || options.all ? await reftableReflogNames(refs, options) : [];
  const names = [...all, ...(options.names ?? [])];
  const result: ExpireReflogsResult = { reflogs: names, pruned: 0, errors: [], output: "" };
  for (const [at, name] of names.entries()) {
    const policy = policyOf(name);
    const tip = (await options.refs.resolve(name).catch(() => undefined))?.objectId ?? undefined;
    try {
      result.pruned += await refs.expireReflog(
        name,
        async (entries) => {
          // newest first here; git's policy sees them oldest first
          const pruner = await prepareExpiry(
            name,
            tip,
            policy,
            context,
            currentRefs,
            entries.map((e) => ({ timestamp: e.time })),
            at >= all.length,
          );
          const verdicts: boolean[] = new Array(entries.length).fill(false);
          for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i] as (typeof entries)[number];
            verdicts[i] = await pruner.shouldPrune(e.oldId, e.newId, e.time, e.message);
          }
          return verdicts;
        },
        {
          dryRun: options.dryRun === true,
          rewrite: options.rewrite === true,
          updateRef: options.updateRef === true,
        },
      );
    } catch (error) {
      result.errors.push(`error: cannot lock ref '${name}': ${(error as Error).message}`);
    }
  }
  return result;
}

/** Every reflog of a reftable repository (`--all`), `--single-worktree` applied. */
async function reftableReflogNames(
  refs: ReftableReflogs,
  options: Pick<ExpireReflogsOptions, "files" | "gitDir" | "singleWorktree" | "worktree">,
): Promise<string[]> {
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
  return selectWorktree(
    names.map((name) => ({ name })),
    options,
  ).map((r) => r.name);
}

/** `--single-worktree`: the current worktree's own reflogs and the shared ones. */
function selectWorktree<R extends { name: string }>(
  reflogs: R[],
  options: Pick<ExpireReflogsOptions, "singleWorktree" | "worktree">,
): R[] {
  if (!options.singleWorktree) return reflogs;
  const id = options.worktree;
  if (id === undefined) return reflogs.filter((r) => !r.name.startsWith("worktrees/"));
  return reflogs.filter((r) =>
    r.name.startsWith("worktrees/")
      ? r.name.startsWith(`worktrees/${id}/`)
      : !isPerWorktreeRefName(r.name),
  );
}

/** A ref every worktree has its own of (HEAD, root refs, `refs/bisect/` ...). */
function isPerWorktreeRefName(name: string): boolean {
  return (
    !name.startsWith("refs/") ||
    name.startsWith("refs/bisect/") ||
    name.startsWith("refs/worktree/") ||
    name.startsWith("refs/rewritten/")
  );
}

/** What `--stale-fix` trusts: every ref's tip and each worktree's HEAD (mark_reachable_objects). */
async function staleFixRoots(
  refs: Pick<Refs, "list" | "resolve">,
  repository: unknown,
  files: FilesApi,
  gitDir: string,
  isReftable: boolean,
  format: ObjectFormat,
): Promise<ObjectId[]> {
  const out: ObjectId[] = [];
  for await (const ref of refs.list("refs/")) {
    const r = ref as { objectId?: string; target?: string };
    if (r.objectId && r.target === undefined) out.push(r.objectId);
  }
  const head = await refs.resolve("HEAD").catch(() => undefined);
  if (head?.objectId) out.push(head.objectId);
  const worktrees = joinPath(gitDir, "worktrees");
  if ((await files.stats(worktrees))?.kind !== "directory") return out;
  for await (const e of files.list(worktrees)) {
    if (e.kind !== "directory") continue;
    if (isReftable) {
      const own = await (repository as ReftableReflogs).worktreeRefs?.(e.name);
      for (const r of own ?? []) if (r.objectId) out.push(r.objectId);
      continue;
    }
    const text = (await readText(files, joinPath(worktrees, e.name, "HEAD")))?.trim();
    if (!text) continue;
    if (objectIdPattern(format).test(text)) out.push(text);
    else if (text.startsWith("ref: ")) {
      const id = (await refs.resolve(text.slice(5)).catch(() => undefined))?.objectId;
      if (id) out.push(id);
    }
  }
  return out;
}

/**
 * reflog.c's `keep_entry` for `--stale-fix`: a commit is kept when it and its history, down
 * to the commits the refs reach, can be read with complete trees (`commit_is_complete`,
 * `tree_is_complete`).
 */
class StaleFix {
  /** git's SEEN: commits and trees reached from the refs, or found complete */
  private seenCommits = new Set<ObjectId>();
  private seenTrees = new Set<ObjectId>();
  /** git's INCOMPLETE */
  private incompleteCommits = new Set<ObjectId>();
  private incompleteTrees = new Set<ObjectId>();

  constructor(
    private graph: CommitGraph,
    private objects: GitObjects,
  ) {}

  /**
   * mark_reachable_objects without dying on missing objects: every readable commit the
   * roots reach and every readable tree under them.
   */
  async markReachable(roots: readonly ObjectId[]): Promise<void> {
    const trees: ObjectId[] = [];
    const pending: ObjectId[] = [];
    for (const root of roots) {
      const commit = await this.graph.peelToCommit(root);
      if (commit) pending.push(commit);
    }
    while (pending.length > 0) {
      const c = pending.pop() as ObjectId;
      if (this.seenCommits.has(c)) continue;
      const parents = await this.graph.parentsOf(c);
      if (!parents) continue;
      this.seenCommits.add(c);
      const tree = await this.graph.treeOf(c);
      if (tree) trees.push(tree);
      for (const p of parents) if (!this.seenCommits.has(p)) pending.push(p);
    }
    while (trees.length > 0) {
      const t = trees.pop() as ObjectId;
      if (this.seenTrees.has(t)) continue;
      const entries = await this.graph.treeEntries(t);
      if (!entries) continue;
      this.seenTrees.add(t);
      for (const e of entries) if (e.mode === 0o040000) trees.push(e.id);
    }
  }

  /** keep_entry */
  async keep(id: ObjectId): Promise<boolean> {
    if (/^0+$/.test(id)) return true;
    const commit = await this.graph.peelToCommit(id);
    if (!commit) return false;
    return this.commitIsComplete(commit);
  }

  private async commitIsComplete(commit: ObjectId): Promise<boolean> {
    if (this.seenCommits.has(commit)) return true;
    if (this.incompleteCommits.has(commit)) return false;
    const study = [commit];
    const found = [commit];
    const studying = new Set([commit]);
    let incomplete = false;
    while (study.length > 0) {
      const c = study.pop() as ObjectId;
      const parents = await this.graph.parentsOf(c);
      if (!parents) this.incompleteCommits.add(c);
      if (this.incompleteCommits.has(c)) {
        incomplete = true;
        break;
      }
      if (this.seenCommits.has(c)) continue;
      for (const p of parents as ObjectId[]) {
        if (studying.has(p)) continue;
        studying.add(p);
        study.push(p);
        found.push(p);
      }
    }
    if (!incomplete) {
      for (const c of found) {
        const tree = await this.graph.treeOf(c);
        if (!tree || !(await this.treeIsComplete(tree))) {
          incomplete = true;
          this.incompleteCommits.add(c);
        }
      }
    }
    if (incomplete) this.incompleteCommits.add(commit);
    else for (const c of found) this.seenCommits.add(c);
    return !incomplete;
  }

  /**
   * odb_has_object with HAS_OBJECT_FETCH_PROMISOR: an absent object of a partial clone is
   * fetched from its promisor remote (one read through the lazily fetching store) and counts
   * as present once it arrives; without a fetcher, or with lazy fetching off
   * (`GIT_NO_LAZY_FETCH`), it stays missing. A fetch that fails throws.
   */
  private async isPresent(id: ObjectId): Promise<boolean> {
    if (await this.objects.has(id).catch(() => false)) return true;
    const promisor = this.objects.promisor;
    if (!promisor?.lazyFetchEnabled || !promisor.hasPromisorRemote()) return false;
    // a failed fetch (PromisorFetchError, the remote gone) is no missing object: it
    // propagates, so the expiry dies before writing, as promisor_remote_get_direct dies
    const o = await this.objects.get(id);
    if (!o) return false;
    if (!o.bytes) await o.content[Symbol.asyncIterator]().return?.();
    return true;
  }

  private async treeIsComplete(tree: ObjectId): Promise<boolean> {
    if (this.seenTrees.has(tree)) return true;
    if (this.incompleteTrees.has(tree)) return false;
    const entries = await this.graph.treeEntries(tree);
    if (!entries) {
      this.incompleteTrees.add(tree);
      return false;
    }
    let complete = true;
    for (const e of entries) {
      const present = await this.isPresent(e.id);
      if (!present || (e.mode === 0o040000 && !(await this.treeIsComplete(e.id)))) {
        this.incompleteTrees.add(tree);
        complete = false;
      }
    }
    if (complete) this.seenTrees.add(tree);
    return complete;
  }
}

/**
 * One reflog line: `<old> <new> <ident> <timestamp> <tz>\t<message>`, as show_one_reflog_ent
 * parses it (the ident up to its first `>`), with `line` as expire_reflog_ent writes it back.
 */
function parseEntry(
  line: string,
  format: ObjectFormat,
): { oldId: string; newId: string; timestamp: number; line: string; message: string } | undefined {
  const hex = format.hexLength;
  const OID = objectIdPattern(format);
  const oldId = line.slice(0, hex);
  const newId = line.slice(hex + 1, 2 * hex + 1);
  if (!OID.test(oldId) || !OID.test(newId) || line[hex] !== " " || line[2 * hex + 1] !== " ")
    return undefined;
  const gt = line.indexOf(">", 2 * hex + 2);
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
    message: rest,
  };
}

/** A reflog: its name as git names it, the ref file and the log file under the git directory. */
interface ReflogFile {
  name: string;
  refPath: string;
  logPath: string;
}

/** The files of the reflog git names `name` (`worktrees/<id>/<ref>`: that worktree's own). */
function reflogFileOf(name: string): ReflogFile {
  const m = /^(worktrees\/[^/]+\/)(.*)$/.exec(name);
  if (m) return { name, refPath: name, logPath: `${m[1]}logs/${m[2]}` };
  return { name, refPath: name, logPath: `logs/${name}` };
}

/** Whether the reflog's ref exists and is not symbolic (refs_resolve_ref_unsafe, NO_RECURSE). */
async function isDirectRef(
  refs: Pick<Refs, "resolve">,
  files: FilesApi,
  gitDir: string,
  reflog: ReflogFile,
): Promise<boolean> {
  const text = await readText(files, joinPath(gitDir, reflog.refPath));
  if (text !== undefined) return !text.startsWith("ref:");
  if (reflog.name.startsWith("worktrees/")) return false;
  // packed
  const r = await refs.resolve(reflog.name).catch(() => undefined);
  return Boolean(r?.objectId);
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
  format: ObjectFormat,
): Promise<ObjectId | undefined> {
  if (reflog.name.startsWith("worktrees/")) {
    // a linked worktree's own ref: its file, or a symbolic ref into the repository's refs
    const text = (await readText(files, joinPath(gitDir, reflog.refPath)))?.trim();
    if (!text) return undefined;
    if (objectIdPattern(format).test(text)) return text;
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
  /** a full id of the repository's format */
  private readonly oid: RegExp;
  constructor(private objects: GitObjects) {
    this.oid = objectIdPattern(objectFormatOf(objects));
  }

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
        this.parents.set(at, parseParents(o.text, this.oid));
        break;
      }
      if (o.type !== "tag") break;
      const m = /^object ([0-9a-f]+)$/m.exec(o.text);
      if (!m || !this.oid.test(m[1] as string)) break;
      at = m[1] as string;
    }
    this.peeled.set(id, result);
    return result ?? undefined;
  }

  /** The type of an object; undefined when it cannot be read. */
  async typeOf(id: ObjectId): Promise<string | undefined> {
    return (await this.read(id))?.type;
  }

  /** The tree a commit names; undefined when it cannot be read. */
  async treeOf(id: ObjectId): Promise<ObjectId | undefined> {
    const o = await this.read(id);
    if (o?.type !== "commit") return undefined;
    const m = /^tree ([0-9a-f]+)$/m.exec(o.text);
    return m && this.oid.test(m[1] as string) ? (m[1] as string) : undefined;
  }

  /** A tree's entries (raw modes); undefined when it cannot be read. */
  async treeEntries(id: ObjectId): Promise<{ mode: number; id: ObjectId }[] | undefined> {
    let o: Awaited<ReturnType<GitObjects["get"]>>;
    try {
      o = await this.objects.get(id);
    } catch {
      return undefined;
    }
    if (!o) return undefined;
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
    if (o.type !== "tree") return undefined;
    try {
      return decodeTreeBytes(bytes, { idLength: objectFormatOf(this.objects).rawLength });
    } catch {
      return undefined;
    }
  }

  /** A commit's parents; null when it cannot be read. */
  async parentsOf(id: ObjectId): Promise<ObjectId[] | null> {
    if (this.parents.has(id)) return this.parents.get(id) as ObjectId[] | null;
    const o = await this.read(id);
    const p = o?.type === "commit" ? parseParents(o.text, this.oid) : null;
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

function parseParents(header: string, OID: RegExp): ObjectId[] {
  const out: ObjectId[] = [];
  for (const line of header.split("\n")) {
    if (line.startsWith("parent ") && OID.test(line.slice(7))) out.push(line.slice(7));
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

export interface DropReflogsOptions {
  files: FilesApi;
  /** Path to the (common) `.git` directory within `files` (default ".git") */
  gitDir?: string;
  /** The refs (a reftable repository drops through its store) */
  refs: unknown;
  /** The reflogs to drop, as git names them; default every reflog (`--all`) */
  names?: string[];
  /** `--single-worktree` with `--all` (see {@link ExpireReflogsOptions.singleWorktree}) */
  singleWorktree?: boolean;
  /** The id of the linked worktree the command runs in */
  worktree?: string;
}

/**
 * `git reflog drop` (2.5x, refs_delete_reflog): each reflog removed whole. On the files
 * backend the log file goes with the directories it leaves empty (`remove_path`: `logs/`
 * too); a reftable repository writes one table of tombstones per reflog.
 *
 * @example
 * ```typescript
 * await dropReflogs({ files, refs: history.refs, names: ["refs/heads/main"] });
 * ```
 */
export async function dropReflogs(options: DropReflogsOptions): Promise<void> {
  const { files, gitDir = ".git" } = options;
  const repository =
    (options.refs as { repositoryStore?(): unknown }).repositoryStore?.call(options.refs) ??
    options.refs;
  const reftable = repository as Partial<ReftableReflogs>;
  if (reftable.reflogNames && reftable.dropReflog) {
    const names =
      options.names ?? (await reftableReflogNames(reftable as ReftableReflogs, options));
    for (const name of names) await reftable.dropReflog(name);
    return;
  }
  const reflogs = options.names
    ? options.names.map(reflogFileOf)
    : selectWorktree(await collectReflogs(files, gitDir), options);
  for (const reflog of reflogs) {
    const path = joinPath(gitDir, reflog.logPath);
    if ((await files.stats(path))?.kind !== "file") continue;
    await files.remove(path);
    // remove_path: every parent left empty, up to the git directory
    for (let d = dirOf(path); d.length > gitDir.length && d !== gitDir; d = dirOf(d)) {
      if (!(await removeEmptyDirectory(files, d))) break;
    }
  }
}

export interface WriteReflogEntryOptions {
  files: FilesApi;
  /** Path to the (common) `.git` directory within `files` (default ".git") */
  gitDir?: string;
  /** The refs (a reftable repository writes through its store) */
  refs: unknown;
  /** The reflog, as git names it */
  name: string;
  /** The line (its message normalized as git's copy_reflog_msg) */
  line: ReflogLine;
}

/** Thrown when the ref a reflog line is written for stays locked. */
export class ReflogWriteLockedError extends Error {
  override name = "ReflogWriteLockedError";
}

/**
 * `git reflog write` (2.5x, ref_transaction_update_reflog): one line appended to `name`'s
 * reflog, created when absent, the ref itself untouched. On the files backend it is written
 * under the ref's lock (`<ref>.lock`, whose directories are removed again when they were
 * made for it); a reftable repository writes one table holding the log record.
 */
export async function writeReflogEntry(options: WriteReflogEntryOptions): Promise<void> {
  const { files, gitDir = ".git", name } = options;
  const repository =
    (options.refs as { repositoryStore?(): unknown }).repositoryStore?.call(options.refs) ??
    options.refs;
  const reftable = repository as Partial<ReftableReflogs>;
  if (reftable.appendReflog) {
    await reftable.appendReflog(name, options.line);
    return;
  }
  const reflog = reflogFileOf(name);
  const atomic = atomicFilesOver(files, gitDir);
  const lock = `${reflog.refPath}.lock`;
  const made = await missingDirectories(files, gitDir, lock);
  if (!(await atomic.createExclusive(lock, new Uint8Array(0)))) {
    throw new ReflogWriteLockedError(
      `cannot lock ref '${name}': Unable to create '${joinPath(gitDir, lock)}': File exists.`,
    );
  }
  try {
    const message = options.line.message.replace(/\s+/g, " ").trim();
    const text = `${options.line.oldId} ${options.line.newId} ${options.line.ident}${message ? `\t${message}` : ""}\n`;
    const logPath = joinPath(gitDir, reflog.logPath);
    const dir = dirOf(logPath);
    if (dir && !(await files.exists(dir))) await files.mkdir(dir);
    if (files.append) await files.append(logPath, [enc.encode(text)]);
    else {
      const before = (await readText(files, logPath)) ?? "";
      await files.write(logPath, [enc.encode(before + text)]);
    }
  } finally {
    await atomic.remove(lock);
    for (const d of made) await removeEmptyDirectory(files, d);
  }
}

/** The directories of `path` (under `gitDir`) that do not exist yet, deepest first. */
async function missingDirectories(
  files: FilesApi,
  gitDir: string,
  path: string,
): Promise<string[]> {
  const out: string[] = [];
  for (let d = dirOf(joinPath(gitDir, path)); d.length > gitDir.length; d = dirOf(d)) {
    if (await files.exists(d)) break;
    out.push(d);
  }
  return out;
}

function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/** Removes `dir` when it is an empty directory. */
async function removeEmptyDirectory(files: FilesApi, dir: string): Promise<boolean> {
  if ((await files.stats(dir))?.kind !== "directory") return false;
  for await (const _ of files.list(dir)) return false;
  await files.remove(dir);
  return true;
}
