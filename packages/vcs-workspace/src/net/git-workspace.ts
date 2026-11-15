/**
 * A folder kept as git history: the folder's files are committed on one branch of a
 * repository, and that branch's tip is always the commit the folder was last committed or
 * checked out at.
 *
 * Bringing the folder to another commit is recorded first (`refs/workspace/pending/<branch>`),
 * then the folder is checked out, then the branch moves and the record goes. A checkout cut
 * short (a full disk, an edit that stops it) is finished before anything else is committed, so
 * a half-written folder is never taken for local edits.
 *
 * What the folder cannot hold stays in history as it was: ignored paths, submodule entries,
 * file modes (an executable stays executable when its content changes) and symbolic links
 * (written as files holding their target).
 */

import {
  type HistoryWithOperations,
  type ObjectId,
  type PersonIdent,
  probeBlob,
} from "@statewalker/vcs-core";
import {
  createRepositoryFacade,
  createTransportRefStore,
  type RefStore,
  type RepositoryFacade,
} from "@statewalker/vcs-transport";
import { mergeLines } from "@statewalker/vcs-utils";
import type { FilesApi } from "@statewalker/webrun-files";
import {
  type FlatEntry,
  type FlatTree,
  MODE_FILE,
  MODE_GITLINK,
  MODE_SYMLINK,
  readCommitTree,
  storeFlatTree,
} from "./flat-tree.js";
import {
  applyFolderPath,
  checkoutFolder,
  currentFileId,
  DEFAULT_RACY_WINDOW_MS,
  defaultIgnore,
  FolderChangedError,
  type FolderSnapshot,
  type FolderWalk,
  folderHasSymlinks,
  type IgnorePath,
  isExpendableDirectory,
  isSyncTempFile,
  pathMatcher,
  probeCaseInsensitive,
  type SkippedPath,
  type SnapshotReport,
  snapshotFolder,
  sweepTempFiles,
  under,
  walkFolder,
} from "./folder-tree.js";
import { hasConflictMarkers, mergeRecursive } from "./merge-trees.js";
import { assertSafePaths, isSafePath } from "./path-rules.js";

/** Who commits, and when. */
export interface WorkspaceIdentity {
  name: string;
  email: string;
}

/** Options of {@link openGitWorkspace}. */
export interface GitWorkspaceOptions {
  /** The folder kept in history */
  folder: FilesApi;
  /** Its repository (in memory, on files, in a database: any vcs-core history) */
  history: HistoryWithOperations;
  /** The branch the folder is committed on (default `main`) */
  branch?: string;
  /** Author and committer of the commits made here (default `Workspace <workspace@localhost>`) */
  identity?: WorkspaceIdentity;
  /** Seconds since the epoch, for commit dates (default: the clock) */
  now?: () => number;
  /**
   * Folder paths kept out of history: never committed, never written or removed by a checkout,
   * and kept in history as they are (default: `.git/`)
   */
  ignore?: IgnorePath;
  /**
   * Whether the folder treats `A.txt` and `a.txt` as one file. Then a commit holding both has
   * one of them moved aside and reported. Default: probed once, with a temporary file.
   */
  caseInsensitive?: boolean;
  /**
   * How long after a file's modification time its size and time are not trusted to show a
   * later change, so it is hashed again (default 3 s; raise it for a filesystem with coarser
   * times)
   */
  racyWindowMs?: number;
  /**
   * Read every folder file on every snapshot instead of trusting unchanged sizes and times:
   * for folders whose times can be set back (`rsync -t`, `cp -p`, restores) or whose clock
   * is skewed by more than the racy window (default false)
   */
  rehashAll?: boolean;
  /**
   * What a merge with conflicts does (default `stop`):
   * - `stop`, as git does: the merge result is written into the folder (markers in text
   *   files, the other side beside binary ones), nothing is committed or pushed, and the merge
   *   stays in progress until {@link concludeMerge} or {@link abortMerge};
   * - `commit`: the merge is committed with the conflicts in the files, pushed, and the sync
   *   goes on; fixing them is an ordinary edit
   */
  onConflict?: ConflictMode;
  /**
   * Commit files that come back from being ignored as the folder holds them (default false:
   * a file the branch never held, or whose folder copy differs from what the branch had, is
   * held out of commits and reported as `unignored-local` until it is included explicitly)
   */
  commitUnignored?: boolean;
}

/** See {@link GitWorkspaceOptions.onConflict}. */
export type ConflictMode = "stop" | "commit";

/** A folder and its repository, as {@link openGitWorkspace} opened them. */
export interface GitWorkspace {
  readonly folder: FilesApi;
  readonly history: HistoryWithOperations;
  /** The full branch name (`refs/heads/main`) */
  readonly branch: string;
  /** The repository as the transport clients read and write it */
  readonly repository: RepositoryFacade;
  readonly refStore: RefStore;
  readonly identity: WorkspaceIdentity;
  readonly now: () => number;
  readonly ignore: IgnorePath;
  readonly caseInsensitive: boolean;
  readonly racyWindowMs: number;
  readonly rehashAll: boolean;
  readonly onConflict: ConflictMode;
  readonly commitUnignored: boolean;
}

/**
 * Opens a folder as a workspace kept in `history`. HEAD is pointed at the branch when it names
 * nothing yet.
 *
 * @example
 * ```ts
 * const history = createMemoryHistoryWithOperations();
 * await history.initialize();
 * const ws = await openGitWorkspace({ folder, history, identity: { name: "Ann", email: "ann@example.com" } });
 * ```
 */
export async function openGitWorkspace(options: GitWorkspaceOptions): Promise<GitWorkspace> {
  const branch = `refs/heads/${options.branch ?? "main"}`;
  const { history } = options;
  if (!(await history.refs.get("HEAD"))) await history.refs.setSymbolic("HEAD", branch);
  return {
    folder: options.folder,
    history,
    branch,
    repository: createRepositoryFacade({ history }),
    refStore: createTransportRefStore(history.refs),
    identity: options.identity ?? { name: "Workspace", email: "workspace@localhost" },
    now: options.now ?? (() => Math.floor(Date.now() / 1000)),
    ignore: options.ignore ?? defaultIgnore,
    caseInsensitive: options.caseInsensitive ?? (await probeCaseInsensitive(options.folder)),
    racyWindowMs: options.racyWindowMs ?? DEFAULT_RACY_WINDOW_MS,
    rehashAll: options.rehashAll ?? false,
    onConflict: options.onConflict ?? "stop",
    commitUnignored: options.commitUnignored ?? false,
  };
}

// one queue per workspace: its commits, merges and checkouts never interleave
const queues = new WeakMap<GitWorkspace, Promise<unknown>>();
// the last snapshot of each workspace's folder: unchanged files (size, mtime) are not read again
const snapshots = new WeakMap<GitWorkspace, FolderSnapshot>();
// the nested repositories the last snapshot found: their files are left alone like ignored ones
const nestedRoots = new WeakMap<GitWorkspace, string[]>();
// files back from being ignored, held out of commits: left alone like ignored ones
const heldPaths = new WeakMap<GitWorkspace, Set<string>>();
// while a merge is in progress: what was left out when it stopped (see MergeRecord.leftOut)
const frozenPaths = new WeakMap<GitWorkspace, string[]>();

/** Runs `task` once everything queued on `ws` before it has finished. */
export function runExclusive<T>(ws: GitWorkspace, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(ws) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(
    ws,
    next.catch(() => undefined),
  );
  return next;
}

/** The branch tip: the commit the folder was last committed or checked out at. */
export async function workspaceHead(ws: GitWorkspace): Promise<ObjectId | undefined> {
  return (await ws.history.refs.resolve(ws.branch))?.objectId;
}

function pendingRef(ws: GitWorkspace): string {
  return `refs/workspace/pending/${ws.branch.slice("refs/heads/".length)}`;
}

function person(ws: GitWorkspace): PersonIdent {
  return { ...ws.identity, timestamp: ws.now(), tzOffset: "+0000" };
}

async function moveBranch(ws: GitWorkspace, from: ObjectId | undefined, to: ObjectId) {
  const result = await ws.history.refs.compareAndSwap(ws.branch, from, to);
  if (!result.success) {
    throw new Error(
      `${ws.branch} moved while the workspace updated it: ${result.errorMessage ?? "compare-and-swap failed"}`,
    );
  }
}

/** Paths of `files` under a submodule entry: the submodule's own files, never committed. */
function underGitlink(files: FlatTree): (path: string) => boolean {
  const links = [...files].filter(([, e]) => e.mode === MODE_GITLINK).map(([p]) => `${p}/`);
  if (links.length === 0) return () => false;
  return (path) => links.some((l) => path.startsWith(l));
}

/** What a checkout or a commit leaves alone in a folder holding `files`. */
function skipFor(ws: GitWorkspace, files: FlatTree): IgnorePath {
  const inLink = underGitlink(files);
  const inNested = under(nestedRoots.get(ws) ?? []);
  const held = heldPaths.get(ws) ?? new Set<string>();
  const frozen = frozenPaths.get(ws) ?? [];
  const inFrozen = frozen.length > 0 ? within(frozen) : () => false;
  return (path) =>
    ws.ignore(path) ||
    isSyncTempFile(path) ||
    inLink(path) ||
    inNested(path) ||
    held.has(path) ||
    inFrozen(path);
}

/**
 * Lists the folder once (see {@link walkFolder}). The nested repositories it finds are the
 * round's (see {@link skipFor}); `keep` adds them to those already found this round instead.
 */
async function walk(ws: GitWorkspace, keep = false): Promise<FolderWalk> {
  const found = await walkFolder(ws.folder, { ignore: ws.ignore });
  const before = keep ? (nestedRoots.get(ws) ?? []) : [];
  nestedRoots.set(ws, [...new Set([...before, ...found.nested])].sort());
  return found;
}

/** What the folder can hold of an entry (submodules: nothing). */
function inFolder(entry: FlatEntry | undefined): FlatEntry | undefined {
  return entry && entry.mode !== MODE_GITLINK ? entry : undefined;
}

/**
 * The tree to commit: the folder's files, with the modes the branch gave them, plus what the
 * folder cannot hold, carried over from the branch exactly (ignored paths, submodule entries,
 * files under a nested repository): no deletion is ever recorded for those.
 */
function composeTree(
  headFiles: FlatTree,
  snapshot: FolderSnapshot,
  skip: IgnorePath,
  linksInFolder = false,
): FlatTree {
  const out: FlatTree = new Map();
  for (const [path, entry] of headFiles) {
    if (entry.mode === MODE_GITLINK || skip(path)) out.set(path, entry);
  }
  for (const [path, file] of snapshot) {
    const previous = inFolder(headFiles.get(path));
    // a link is a link; a file keeps the mode the branch gave it (an executable bit, or a
    // link a folder without links holds as a file of its target)
    const mode = file.link
      ? MODE_SYMLINK
      : previous && previous.mode !== MODE_SYMLINK
        ? previous.mode
        : previous?.mode === MODE_SYMLINK && !linksInFolder
          ? MODE_SYMLINK
          : MODE_FILE;
    out.set(path, { id: file.id, mode });
  }
  return out;
}

/**
 * Snapshots the folder from the round's listing `walked`, remembering the nested repositories
 * (see {@link skipFor}). Returns the snapshot, what to skip now (nested repositories included)
 * and what was left out (submodule checkouts of `headFiles` not counted).
 */
async function folderSnapshot(
  ws: GitWorkspace,
  headFiles: FlatTree,
  walked: FolderWalk,
  tempFiles?: Map<string, number>,
): Promise<{ snapshot: FolderSnapshot; skip: IgnorePath; skipped: SkippedPath[] }> {
  const report: SnapshotReport = { nested: [], skipped: [] };
  const snapshot = await snapshotFolder(
    ws.history,
    ws.folder,
    {
      skip: skipFor(ws, headFiles),
      cache: snapshots.get(ws),
      racyWindowMs: ws.racyWindowMs,
      rehashAll: ws.rehashAll,
      tempFiles,
      walk: walked,
      // the nested repositories this round decided on, with any the listing shows: what the
      // snapshot leaves out is exactly what the tree carries over
      nested: nestedRoots.get(ws) ?? [],
    },
    report,
  );
  nestedRoots.set(ws, report.nested);
  snapshots.set(ws, snapshot);
  const skipped = report.skipped.filter(
    (s) => !(s.reason === "nested-repository" && headFiles.get(s.path)?.mode === MODE_GITLINK),
  );
  return { snapshot, skip: skipFor(ws, headFiles), skipped };
}

/** Forgets what the snapshot cache knows of `paths` (a checkout wrote or removed them). */
function invalidate(ws: GitWorkspace, paths: Iterable<string>) {
  const cache = snapshots.get(ws);
  if (!cache) return;
  for (const p of paths) cache.delete(p);
}

/** What {@link commitWorkspaceChanges} did. */
export interface WorkspaceCommit {
  /** The branch tip afterwards (undefined: nothing ever committed, the folder is empty) */
  head?: ObjectId;
  /** Whether a commit was made */
  changed: boolean;
  /**
   * Paths of an unfinished checkout that the folder had changed meanwhile: merged with the
   * checkout's content (both kept) before committing
   */
  conflicts: string[];
  /**
   * Folder paths left out of history: nested repositories (their files belong to them; the
   * branch keeps what it had there) and names no tree may hold
   */
  skipped: SkippedPath[];
  /**
   * Paths that were left out and came back (a nested repository removed, `ignore` changed):
   * brought up to the branch where the folder's copy was unchanged, merged where both changed
   */
  rejoined: string[];
  /**
   * A merge with conflicts in progress (see {@link concludeMerge}): nothing was committed
   */
  merge?: MergeInProgress;
  /**
   * Whether this call finished writing the merge result into the folder (a stop whose
   * writing was cut short): the merge stopped now, not earlier
   */
  mergeStarted?: boolean;
}

/** Options of {@link commitWorkspaceChanges}. */
export interface CommitOptions {
  /** The commit message (default `Workspace changes`) */
  message?: string;
  /**
   * Files (or directories) back from being ignored to commit as the folder holds them,
   * although they are held out by default (`unignored-local` in `skipped`)
   */
  include?: string[];
  /**
   * What conflicts found while finishing a cut-short checkout, or while bringing back paths
   * that were left out, do (default: the workspace's `onConflict`): `stop` writes them into
   * the folder and stops like a merge (see {@link concludeMerge}); `commit` commits them
   */
  onConflict?: ConflictMode;
}

/** Where the plan of an unfinished checkout is kept: a ref only this workspace writes. */
function planRef(ws: GitWorkspace): string {
  return `refs/workspace/plan/${ws.branch.slice("refs/heads/".length)}`;
}

/** A directory kept because it holds files the checkout may not remove */
const KEPT_DIRECTORY = "directory";

interface CheckoutPlan {
  target: ObjectId;
  /** What the folder must hold when the checkout is done */
  files: FlatTree;
  /**
   * Folder content found in place of the checkout's: path to the blob id kept (null: the
   * file was removed; `directory`: a directory with files of its own was kept)
   */
  seen: Record<string, string | null>;
  conflicts: string[];
  /** Paths already brought to the plan: a later change there is a user edit, kept as it is */
  done: string[];
}

/** Files a checkout may remove to make room: ignored and temporary ones, never a nested repository. */
function expendableFor(ws: GitWorkspace): IgnorePath {
  return (path) => ws.ignore(path) || isSyncTempFile(path);
}

async function textOf(ws: GitWorkspace, entry: FlatEntry | undefined) {
  if (!entry) return new Uint8Array(0);
  const probe = await probeBlob(ws.history.blobs, entry.id, { loadText: true });
  return probe.binary ? undefined : probe.content;
}

/**
 * Records in `plan` how the folder's own content at `path` (neither the head's nor the
 * target's) is kept: a text file merged with the target's content (git's markers), a binary
 * file kept with the target's version beside it, a directory with files of its own kept with
 * the target's file beside it, a removed file restored to the target's version. The path is
 * reported as a conflict. Returns the paths the plan now wants written, or nothing when the
 * folder holds only what the checkout may clear.
 */
async function keepFolderContent(
  ws: GitWorkspace,
  plan: CheckoutPlan,
  path: string,
  h: FlatEntry | undefined,
  t: FlatEntry | undefined,
  taken: Set<string>,
): Promise<string[]> {
  const aside = () => {
    let name = `${path}.theirs-${plan.target.slice(0, 7)}`;
    for (let n = 2; taken.has(name) || plan.files.has(name); n++) {
      name = `${path}.theirs-${plan.target.slice(0, 7)}-${n}`;
    }
    taken.add(name);
    return name;
  };
  const report = () => {
    if (!plan.conflicts.includes(path)) plan.conflicts.push(path);
  };
  const now = await currentFileId(ws.folder, path);
  if (now === undefined) {
    // removed meanwhile: the target's version comes back
    plan.seen[path] = null;
    if (t) plan.files.set(path, t);
    else plan.files.delete(path);
    report();
    return t ? [path] : [];
  }
  if (now.startsWith("directory:")) {
    // only what the checkout may clear: the target's file goes in its place
    if (await isExpendableDirectory(ws.folder, path, expendableFor(ws))) return [path];
    plan.seen[path] = KEPT_DIRECTORY;
    plan.files.delete(path);
    report();
    if (!t) return [];
    const name = aside();
    plan.files.set(name, t);
    return [name];
  }
  const id = await ws.history.blobs.store(ws.folder.read(`/${path}`));
  plan.seen[path] = id;
  const mine: FlatEntry = { id, mode: t?.mode ?? h?.mode ?? MODE_FILE };
  report();
  if (!t) {
    plan.files.set(path, mine); // the target removes it: the edit is kept
    return [path];
  }
  const [base, ours, theirs] = [await textOf(ws, h), await textOf(ws, mine), await textOf(ws, t)];
  if (base && ours && theirs) {
    const merged = mergeLines(base, ours, theirs, {
      oursLabel: "folder",
      theirsLabel: `checkout (${plan.target.slice(0, 7)})`,
    });
    plan.files.set(path, { id: await ws.history.blobs.store([merged.content]), mode: t.mode });
    return [path];
  }
  plan.files.set(path, mine);
  const name = aside();
  plan.files.set(name, t);
  return [path, name];
}

/**
 * The plan to finish a checkout from `head` to `target`: the target's files, except where the
 * folder holds neither the head's nor the target's content (see {@link keepFolderContent}).
 * Stored once, so finishing is idempotent: a retry never merges a merged file again.
 */
async function makePlan(
  ws: GitWorkspace,
  target: ObjectId,
  from: FlatTree,
  to: FlatTree,
): Promise<CheckoutPlan> {
  const skipWrite = skipFor(ws, to);
  const skipRemove = skipFor(ws, from);
  const plan: CheckoutPlan = { target, files: new Map(to), seen: {}, conflicts: [], done: [] };
  const taken = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...taken].sort()) {
    const h = inFolder(from.get(path));
    const t = inFolder(to.get(path));
    if (h?.id === t?.id || (t ? skipWrite(path) : skipRemove(path))) continue;
    const now = await currentFileId(ws.folder, path);
    if (now === t?.id || now === h?.id) continue;
    await keepFolderContent(ws, plan, path, h, t, taken);
  }
  return plan;
}

async function storePlan(ws: GitWorkspace, plan: CheckoutPlan): Promise<void> {
  const meta = JSON.stringify({ seen: plan.seen, conflicts: plan.conflicts, done: plan.done });
  const id = await commitTree(ws, plan.files, [plan.target], `checkout plan\n\n${meta}`);
  await ws.history.refs.set(planRef(ws), id);
}

/** The stored plan for `target`, if a valid one is there (anything else is made again). */
async function loadPlan(ws: GitWorkspace, target: ObjectId): Promise<CheckoutPlan | undefined> {
  const id = (await ws.history.refs.resolve(planRef(ws)))?.objectId;
  if (!id) return undefined;
  try {
    const commit = await ws.history.commits.load(id);
    if (!commit || commit.parents[0] !== target) return undefined;
    const body = commit.message.slice(commit.message.indexOf("\n\n") + 2);
    const meta = JSON.parse(body) as { seen?: unknown; conflicts?: unknown; done?: unknown };
    if (typeof meta.seen !== "object" || meta.seen === null || !Array.isArray(meta.conflicts)) {
      return undefined;
    }
    return {
      target,
      files: (await readCommitTree(ws.history, id)).files,
      seen: meta.seen as Record<string, string | null>,
      conflicts: (meta.conflicts as unknown[]).filter((c): c is string => typeof c === "string"),
      done: Array.isArray(meta.done)
        ? (meta.done as unknown[]).filter((c): c is string => typeof c === "string")
        : [],
    };
  } catch {
    return undefined;
  }
}

/**
 * Finishes a checkout cut short, from its plan (made and stored on the first attempt): every
 * file still holding the head's or the target's content, or what the plan kept, gets the
 * plan's content. A file changed again since is kept like any folder edit (merged or moved
 * aside, reported), the plan updated first. A file that cannot be brought to the plan stops
 * the finish with the branch unmoved; only when every path is done does the branch move to the
 * target.
 *
 * With `onConflict: "stop"`, a plan with conflicts (folder edits that clash with the target)
 * stops like a merge instead: before the first folder write that follows the conflict, the
 * merge record is set (`recovery`, `writing`) and takes over from the pending record; once the
 * folder holds the plan, {@link stopRecovery} commits the edits on their own and stops, with
 * nothing of the target committed.
 */
async function finishPendingCheckout(
  ws: GitWorkspace,
  walked: FolderWalk,
  onConflict: ConflictMode,
): Promise<FinishResult> {
  const ref = pendingRef(ws);
  const target = (await ws.history.refs.resolve(ref))?.objectId;
  if (!target) return { conflicts: [], touched: [] };
  const existing = await readMerge(ws);
  if (existing) {
    // the recovery stop was recorded, the pending record not yet removed: it takes over
    if (existing.kind === "recovery" && existing.theirs === target) {
      await ws.history.refs.remove(ref);
    }
    return { conflicts: [], touched: [] };
  }
  const head = await workspaceHead(ws);
  if (head === target) {
    await ws.history.refs.remove(ref);
    await ws.history.refs.remove(planRef(ws));
    return { conflicts: [], touched: [] };
  }
  let stop: MergeRecord | undefined;
  const begin = async (plan: CheckoutPlan) => {
    if (stop) return;
    const trees = [
      (await readCommitTree(ws.history, head)).files,
      (await readCommitTree(ws.history, target)).files,
    ];
    stop = await storeMerge(ws, {
      kind: "recovery",
      phase: "writing",
      head: head ?? target,
      theirs: target,
      ...(head ? { from: head } : {}),
      files: plan.files,
      conflicts: [...plan.conflicts].sort(),
      title: `Merge ${target.slice(0, 7)} (an unfinished checkout) into the folder's edits`,
      leftOut: freezeLeftOut(ws, walked, trees),
    });
    frozenPaths.set(ws, stop.leftOut);
    await ws.history.refs.remove(ref);
  };
  const finished = await finishCheckout(
    ws,
    head,
    target,
    onConflict === "stop" ? begin : undefined,
  );
  if (stop) return { ...finished, stopped: await stopRecovery(ws, stop) };
  await moveBranch(ws, head, target);
  await ws.history.refs.remove(ref);
  await ws.history.refs.remove(planRef(ws));
  return finished;
}

/** What finishing a checkout did: the paths it reported, and those it wrote or removed. */
interface FinishResult {
  conflicts: string[];
  touched: string[];
  /** The recovery stop it recorded (see {@link finishPendingCheckout}) */
  stopped?: MergeRecord;
}

/**
 * Brings the folder from `head`'s tree to `target`'s, from the stored plan (see
 * {@link finishPendingCheckout}); the caller moves whatever records the checkout.
 * `beforeConflictWrites`, when given, runs once the plan holds conflicts and before any folder
 * write that follows (it records the stop).
 */
async function finishCheckout(
  ws: GitWorkspace,
  head: ObjectId | undefined,
  target: ObjectId,
  beforeConflictWrites?: (plan: CheckoutPlan) => Promise<void>,
): Promise<FinishResult> {
  const from = (await readCommitTree(ws.history, head)).files;
  const to = (await readCommitTree(ws.history, target)).files;
  await recordLeftAlone(ws, from, to);
  let plan = await loadPlan(ws, target);
  if (!plan) {
    plan = await makePlan(ws, target, from, to);
    await storePlan(ws, plan);
  }
  if (beforeConflictWrites && plan.conflicts.length > 0) await beforeConflictWrites(plan);
  const skipWrite = skipFor(ws, to);
  const skipRemove = skipFor(ws, from);
  const expendable = expendableFor(ws);
  const taken = new Set([...from.keys(), ...to.keys(), ...plan.files.keys()]);
  const touched: string[] = [];
  const apply = async (path: string, current: CheckoutPlan) => {
    const h = inFolder(from.get(path));
    const t = inFolder(to.get(path));
    const want = inFolder(current.files.get(path));
    const seen = current.seen[path];
    if (seen === KEPT_DIRECTORY) return;
    const accept = (now: ObjectId | undefined) =>
      now === h?.id ||
      now === t?.id ||
      now === want?.id ||
      (seen !== undefined && now === (seen ?? undefined));
    touched.push(path);
    await applyFolderPath(ws.history, ws.folder, path, want, { accept, expendable });
  };
  const done = new Set(plan.done);
  try {
    for (const path of [...taken].sort()) {
      const h = inFolder(from.get(path));
      const want = inFolder(plan.files.get(path));
      if (h?.id === want?.id && !(path in plan.seen)) continue;
      if (want ? skipWrite(path) : skipRemove(path)) continue;
      try {
        await apply(path, plan);
      } catch (error) {
        if (!(error instanceof FolderChangedError)) throw error;
        // already brought to the plan, changed since: the user's edit, committed on top
        if (done.has(path)) continue;
        // changed before the plan reached it: kept like any folder edit, the plan updated first
        const t = inFolder(to.get(path));
        const paths = await keepFolderContent(ws, plan, path, h, t, taken);
        await storePlan(ws, plan);
        if (beforeConflictWrites && plan.conflicts.length > 0) await beforeConflictWrites(plan);
        // a file that changes again stops the finish here, the branch unmoved
        for (const p of paths) {
          await apply(p, plan);
          done.add(p);
        }
      }
      done.add(path);
    }
  } catch (error) {
    // what is done stays done: a retry treats later changes there as the user's
    plan.done = [...done];
    await storePlan(ws, plan).catch(() => undefined);
    throw error;
  } finally {
    invalidate(ws, touched);
  }
  return { conflicts: plan.conflicts, touched };
}

/**
 * Where the workspace remembers the folder's copies that checkouts left alone: paths that were
 * ignored or inside a nested repository while the branch moved on. A ref only this workspace
 * writes (never pushed).
 */
function staleRef(ws: GitWorkspace): string {
  return `refs/workspace/skip/${ws.branch.slice("refs/heads/".length)}`;
}

/** A path's rejoin, recorded before anything is written, so a retry never merges it twice. */
interface RejoinStep {
  /** What the folder holds at the path once the step is done (null: nothing) */
  result: ObjectId | null;
  /** Folder writes, in order: the blob to write (null: remove) and what the path must hold */
  writes: { at: string; id: ObjectId | null; mode: number; expect: ObjectId | null }[];
  /** Whether both sides were kept */
  conflict: boolean;
  /** A conflict's folder copy, before the step (null: none, or a directory) */
  mine?: FlatEntry | null;
  /**
   * A conflict stopped on (`onConflict: "stop"`): its writes are done, and the step stays in
   * the record until the merge is concluded or aborted. Without a merge record (a crash before
   * the stop was recorded), it counts only while the folder holds `result` and the path is not
   * left out again; otherwise it goes and the path is decided afresh.
   */
  written?: boolean;
}

/** What the workspace remembers of left-out paths (`refs/workspace/skip/<branch>`). */
interface SkipRecord {
  /**
   * Left-out paths the branch tracks, whose folder copy may be behind the branch: the version
   * the folder last held (null: it never held one, a file the remote added meanwhile)
   */
  paths: Map<string, FlatEntry | null>;
  /** Those of `paths` left out as part of a nested repository (the others were ignored) */
  nested: Set<string>;
  /** The topmost ignored folder paths the last commit saw (see {@link walkFolder}) */
  local: string[];
  /** Folder files back from being ignored, held out of commits until included */
  held: Set<string>;
  /**
   * For each held file, the branch's version when it was held (null: none), the base of the
   * three-way merge made when it is included after the branch changed it
   */
  heldBase: Map<string, FlatEntry | null>;
  /**
   * Paths of a record written before reasons were kept: they come back by the three-way
   * merge, as that record's version promised, never held
   */
  legacy: Set<string>;
  /** Rejoins decided and recorded, perhaps not yet written to the folder */
  rejoining: Map<string, RejoinStep>;
}

/** What checkouts leave alone and later come back: ignored paths and nested repositories. */
function staleSkip(ws: GitWorkspace): IgnorePath {
  const inNested = under(nestedRoots.get(ws) ?? []);
  return (path) => ws.ignore(path) || inNested(path);
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

async function loadStale(ws: GitWorkspace): Promise<SkipRecord> {
  const record: SkipRecord = {
    paths: new Map(),
    nested: new Set(),
    local: [],
    held: new Set(),
    heldBase: new Map(),
    legacy: new Set(),
    rejoining: new Map(),
  };
  const id = (await ws.history.refs.resolve(staleRef(ws)))?.objectId;
  if (!id) return record;
  try {
    const commit = await ws.history.commits.load(id);
    if (!commit) return record;
    for (const [path, entry] of (await readCommitTree(ws.history, id)).files) {
      record.paths.set(path, entry);
    }
    const meta = JSON.parse(commit.message.slice(commit.message.indexOf("\n\n") + 2)) as {
      absent?: unknown;
      nested?: unknown;
      local?: unknown;
      held?: unknown;
      heldBase?: unknown;
      legacy?: unknown;
      rejoining?: unknown;
    };
    for (const p of strings(meta.absent)) record.paths.set(p, null);
    record.nested = new Set(strings(meta.nested));
    // a record without reasons (written before they were kept): its paths come back by the
    // three-way merge, as that version did
    record.legacy =
      meta.nested === undefined ? new Set(record.paths.keys()) : new Set(strings(meta.legacy));
    record.local = strings(meta.local);
    record.held = new Set(strings(meta.held));
    if (meta.heldBase && typeof meta.heldBase === "object") {
      for (const [path, entry] of Object.entries(meta.heldBase as Record<string, unknown>)) {
        const e = entry as FlatEntry | null;
        if (e === null || (typeof e?.id === "string" && typeof e?.mode === "number")) {
          record.heldBase.set(path, e);
        }
      }
    }
    if (meta.rejoining && typeof meta.rejoining === "object") {
      for (const [path, step] of Object.entries(meta.rejoining as Record<string, RejoinStep>)) {
        if (step && Array.isArray(step.writes)) record.rejoining.set(path, step);
      }
    }
  } catch {
    // an unreadable record is an empty one: nothing is taken for stale
  }
  return record;
}

async function saveStale(ws: GitWorkspace, record: SkipRecord): Promise<void> {
  if (
    record.paths.size === 0 &&
    record.local.length === 0 &&
    record.held.size === 0 &&
    record.rejoining.size === 0
  ) {
    await ws.history.refs.remove(staleRef(ws));
    return;
  }
  const files: FlatTree = new Map();
  const absent: string[] = [];
  for (const [path, entry] of record.paths) {
    if (entry) files.set(path, entry);
    else absent.push(path);
  }
  const heldBase = [...record.heldBase].filter(([p]) => record.held.has(p));
  const meta = {
    absent,
    nested: [...record.nested].filter((p) => record.paths.has(p)).sort(),
    legacy: [...record.legacy].filter((p) => record.paths.has(p)).sort(),
    local: record.local,
    held: [...record.held].sort(),
    heldBase: Object.fromEntries(heldBase),
    rejoining: Object.fromEntries(record.rejoining),
  };
  // blobs the record names only in its message (rejoin results, held bases) stay reachable:
  // a parent commit's tree holds them
  const kept: FlatTree = new Map();
  const keep = (id: ObjectId | null | undefined, mode = MODE_FILE) => {
    if (id) kept.set(`${kept.size}`, { id, mode });
  };
  for (const step of record.rejoining.values()) {
    for (const w of step.writes) keep(w.id, w.mode);
    keep(step.mine?.id, step.mine?.mode);
  }
  for (const [, entry] of heldBase) keep(entry?.id, entry?.mode);
  const parents = kept.size > 0 ? [await commitTree(ws, kept, [], "kept blobs")] : [];
  const id = await commitTree(ws, files, parents, `skipped paths\n\n${JSON.stringify(meta)}`);
  await ws.history.refs.set(staleRef(ws), id);
}

/** Records `path` as left out with the version the folder holds, and why it is left out. */
function remember(ws: GitWorkspace, record: SkipRecord, path: string, entry: FlatEntry | null) {
  record.paths.set(path, entry);
  if (ws.ignore(path)) record.nested.delete(path);
  else record.nested.add(path);
}

function forget(record: SkipRecord, path: string) {
  record.paths.delete(path);
  record.nested.delete(path);
  record.legacy.delete(path);
  record.rejoining.delete(path);
}

/**
 * Records the paths a checkout from `from` to `to` leaves alone because they are ignored or
 * inside a nested repository, with the version the folder holds (from `from`), unless already
 * recorded.
 */
async function recordLeftAlone(ws: GitWorkspace, from: FlatTree, to: FlatTree): Promise<void> {
  const skip = staleSkip(ws);
  const record = await loadStale(ws);
  let changed = false;
  for (const path of new Set([...from.keys(), ...to.keys()])) {
    const h = inFolder(from.get(path));
    const t = inFolder(to.get(path));
    if (h?.id === t?.id || !skip(path) || record.paths.has(path)) continue;
    remember(ws, record, path, h ?? null);
    changed = true;
  }
  if (changed) await saveStale(ws, record);
}

/**
 * How a path that is no longer left out comes back: a three-way merge of the version the
 * folder last held (`base`), the folder's copy and the branch's. A copy unchanged in the folder
 * gets the branch's version (written, or removed); one changed only in the folder is kept; one
 * changed on both sides is merged (text, git's markers) or kept with the branch's version
 * beside it (binary, or a directory in its place), and reported. With `hold` (a path back from
 * being ignored), a file the folder holds of its own, which the branch never had there, is not
 * merged or committed at all: `hold` is returned and nothing is written.
 */
async function planRejoin(
  ws: GitWorkspace,
  path: string,
  base: FlatEntry | null,
  theirs: FlatEntry | undefined,
  taken: Set<string>,
  hold: boolean,
): Promise<RejoinStep | "hold"> {
  const ours = await currentFileId(ws.folder, path);
  const keep = (conflict: boolean): RejoinStep => ({ result: ours ?? null, writes: [], conflict });
  const write = (at: string, entry: FlatEntry | undefined, expect: ObjectId | undefined) => ({
    at,
    id: entry?.id ?? null,
    mode: entry?.mode ?? MODE_FILE,
    expect: expect ?? null,
  });
  const aside = () => {
    let name = `${path}.theirs-${theirs?.id.slice(0, 7)}`;
    for (let n = 2; taken.has(name); n++) name = `${path}.theirs-${theirs?.id.slice(0, 7)}-${n}`;
    taken.add(name);
    return name;
  };
  const baseId = base?.id ?? undefined;
  if (ours === theirs?.id) return keep(false);
  if (ours === baseId) {
    return { result: theirs?.id ?? null, writes: [write(path, theirs, ours)], conflict: false };
  }
  // the folder holds content of its own here, which history never had
  if (hold && ours !== undefined && !ours.startsWith("directory:")) return "hold";
  if (theirs?.id === baseId) return keep(false); // changed only in the folder
  if (ours?.startsWith("directory:")) {
    return theirs
      ? { result: ours, writes: [write(aside(), theirs, undefined)], conflict: true, mine: null }
      : { ...keep(true), mine: null };
  }
  if (ours === undefined) {
    // removed in the folder, changed on the branch: it comes back
    return theirs
      ? { result: theirs.id, writes: [write(path, theirs, undefined)], conflict: true, mine: null }
      : { ...keep(true), mine: null };
  }
  const mine: FlatEntry = {
    id: await ws.history.blobs.store(ws.folder.read(`/${path}`)),
    mode: theirs?.mode ?? base?.mode ?? MODE_FILE,
  };
  // removed on the branch, changed in the folder: kept
  if (!theirs) return { ...keep(true), result: mine.id, mine };
  const [b, o, t] = [
    await textOf(ws, base ?? undefined),
    await textOf(ws, mine),
    await textOf(ws, theirs),
  ];
  if (b && o && t) {
    const merged = mergeLines(b, o, t, {
      oursLabel: "folder",
      theirsLabel: `${ws.branch.slice("refs/heads/".length)}`,
    });
    const id = await ws.history.blobs.store([merged.content]);
    return {
      result: id,
      writes: [write(path, { id, mode: theirs.mode }, mine.id)],
      conflict: merged.conflicts > 0,
      ...(merged.conflicts > 0 ? { mine } : {}),
    };
  }
  return { result: mine.id, writes: [write(aside(), theirs, undefined)], conflict: true, mine };
}

/**
 * Paths that were left out and no longer are (a nested repository removed, an `ignore` that
 * changed) come back, one by one (see {@link planRejoin}); paths the branch has that are left
 * out now are recorded with the version the folder holds. Each path's rejoin is recorded
 * before it is written: a retry after a crash finds the folder holding the recorded result
 * and only finishes the step, never merging the path again. A held file that `include` names
 * (or every one, with `commitUnignored`) whose branch version changed since it was held is
 * merged the same way, three ways against the version the branch had when it was held.
 *
 * With `stop` (`onConflict: "stop"`), a path with a conflict is written the same way but not
 * taken as rejoined: its step stays in the record, marked written once the folder holds it,
 * and the path is returned in `stopped` for the caller to stop on (see {@link stopRejoin}).
 */
async function rejoinLeftOut(
  ws: GitWorkspace,
  headFiles: FlatTree,
  include: string[] = [],
  stop = false,
): Promise<{ rejoined: string[]; conflicts: string[]; touched: string[]; stopped: string[] }> {
  const skip = staleSkip(ws);
  const record = await loadStale(ws);
  const rejoined: string[] = [];
  const stopped: string[] = [];
  const conflicts: string[] = [];
  const touched: string[] = [];
  const expendable = expendableFor(ws);
  const included = ws.commitUnignored ? () => true : within(include);
  const merge = new Set<string>();
  for (const p of [...record.held]) {
    if (ws.ignore(p) || !included(p)) continue;
    const base = record.heldBase.get(p) ?? null;
    // unchanged on the branch since it was held: committed as the folder holds it
    if (inFolder(headFiles.get(p))?.id === (base?.id ?? undefined)) continue;
    record.held.delete(p);
    record.heldBase.delete(p);
    record.paths.set(p, base);
    merge.add(p);
  }
  if (merge.size > 0) await saveStale(ws, record);
  const taken = new Set([...headFiles.keys(), ...record.paths.keys()]);
  try {
    for (const [path, base] of [...record.paths]) {
      let step = record.rejoining.get(path);
      if (skip(path)) {
        // left out again before a stop on it was recorded: the decision is stale (the folder
        // may change a lot meanwhile), and the path comes back by a fresh one
        if (step?.written) {
          record.rejoining.delete(path);
          await saveStale(ws, record);
        }
        continue;
      }
      // decided before a crash (no merge is in progress here): done when the folder holds the
      // result, made again otherwise, a stopped-on step too
      if (step && (await currentFileId(ws.folder, path)) !== (step.result ?? undefined)) {
        step = undefined;
      }
      if (!step) {
        const hold =
          !merge.has(path) &&
          !record.nested.has(path) &&
          !record.legacy.has(path) &&
          !ws.commitUnignored;
        const planned = await planRejoin(
          ws,
          path,
          base,
          inFolder(headFiles.get(path)),
          taken,
          hold,
        );
        if (planned === "hold") {
          forget(record, path);
          record.held.add(path);
          record.heldBase.set(path, base);
          await saveStale(ws, record);
          continue;
        }
        step = planned;
        if (step.writes.length > 0 || (stop && step.conflict)) {
          record.rejoining.set(path, step);
          await saveStale(ws, record); // write-ahead: the decision first, then the folder
        }
      }
      if (!step.written) {
        for (const w of step.writes) {
          touched.push(w.at);
          await applyFolderPath(
            ws.history,
            ws.folder,
            w.at,
            w.id ? { id: w.id, mode: w.mode } : undefined,
            { accept: (now) => now === (w.expect ?? undefined), expendable },
          );
        }
      }
      if (step.conflict) conflicts.push(path);
      if (stop && step.conflict) {
        // stopped on: the step stays until the merge is concluded or aborted
        if (!step.written) {
          step.written = true;
          record.rejoining.set(path, step);
          await saveStale(ws, record);
        }
        stopped.push(path);
        continue;
      }
      forget(record, path);
      rejoined.push(path);
      await saveStale(ws, record); // each path once, even when a later one fails
    }
  } finally {
    invalidate(ws, [...rejoined, ...stopped, ...touched]);
  }
  let changed = false;
  for (const [path, entry] of headFiles) {
    if (entry.mode === MODE_GITLINK || !skip(path) || record.paths.has(path)) continue;
    remember(ws, record, path, entry);
    changed = true;
  }
  if (changed) await saveStale(ws, record);
  return {
    rejoined: rejoined.sort(),
    conflicts: conflicts.sort(),
    touched,
    stopped: stopped.sort(),
  };
}

/** Whether a path is one of `list` or below one of them */
const within = (list: string[]) => pathMatcher(list);

/**
 * Which folder files are held out of commits this round: files back from being ignored that
 * history never had there (`unignored-local`), until `include` names them or the workspace
 * commits them all (`commitUnignored`). A held file that is removed stops being held; when the
 * branch tracks that path, the branch's version (never written over the held file) comes back
 * at the next commit, and the tree keeps it meanwhile. A held file whose content is the
 * branch's again is released (reported in `released`). Updates `record`; returns the paths to
 * hold now and whether the record changed.
 */
async function holdUnignored(
  ws: GitWorkspace,
  record: SkipRecord,
  walked: FolderWalk,
  headFiles: FlatTree,
  include: string[],
): Promise<{ hold: Set<string>; report: string[]; released: string[]; changed: boolean }> {
  const wasIgnored = within(record.local);
  const included = ws.commitUnignored ? () => true : within(include);
  const inLink = underGitlink(headFiles);
  const inNested = under(nestedRoots.get(ws) ?? []);
  const leftOut = (p: string) => isSyncTempFile(p) || inLink(p) || inNested(p);
  const present = new Set(walked.files.map((f) => f.path));
  const hold = new Set<string>();
  const kept = new Set<string>();
  const released: string[] = [];
  let changed = false;
  for (const p of record.held) {
    if (ws.ignore(p) || included(p)) continue;
    if (present.has(p)) {
      const branch = inFolder(headFiles.get(p));
      if (branch && (await currentFileId(ws.folder, p)) === branch.id) {
        released.push(p); // the branch's content again: nothing to hold
        continue;
      }
      kept.add(p);
    } else if (inFolder(headFiles.get(p)) && !record.paths.has(p)) {
      // removed while held: the branch's version comes back at the next commit (the folder
      // never held it), and nothing is deleted meanwhile
      record.paths.set(p, null);
      hold.add(p);
    }
  }
  for (const f of walked.files) {
    const p = f.path;
    if (kept.has(p) || headFiles.has(p) || !wasIgnored(p) || ws.ignore(p) || included(p)) continue;
    if (leftOut(p) || !isSafePath(p)) continue;
    kept.add(p);
  }
  for (const p of kept) {
    hold.add(p);
    if (!record.heldBase.has(p)) record.heldBase.set(p, null); // history never had it
  }
  for (const p of [...record.heldBase.keys()]) if (!kept.has(p)) record.heldBase.delete(p);
  const same = (a: Iterable<string>, b: Iterable<string>) =>
    [...a].sort().join("\n") === [...b].sort().join("\n");
  if (!same(kept, record.held) || !same(walked.ignored, record.local)) changed = true;
  if (hold.size !== kept.size) changed = true;
  record.held = kept;
  record.local = walked.ignored;
  return { hold, report: [...kept].sort(), released: released.sort(), changed };
}

async function commitTree(
  ws: GitWorkspace,
  files: FlatTree,
  parents: ObjectId[],
  message: string,
): Promise<ObjectId> {
  const who = person(ws);
  return ws.history.commits.store({
    tree: await storeFlatTree(ws.history, files),
    parents,
    author: who,
    committer: who,
    message: `${message}\n`,
  });
}

/**
 * Where a merge with conflicts in progress is kept (git's `MERGE_HEAD`): a ref only this
 * workspace writes, never pushed. It names a commit whose parents are the branch tip and the
 * commit merged in, whose tree is the merge result, and whose message holds the merge's state.
 */
function mergeRef(ws: GitWorkspace): string {
  return `refs/workspace/merge/${ws.branch.slice("refs/heads/".length)}`;
}

/**
 * What stopped with conflicts:
 * - `merge`: a merge of the remote's commits (`head` the branch tip, `theirs` the commit
 *   merged in);
 * - `recovery`: finishing a checkout that was cut short found folder edits that clash with the
 *   checkout's target. `head` is the commit of those edits, made on the commit the checkout
 *   started from (the branch moves there); `theirs` is the checkout's target. A first checkout
 *   (nothing committed before it) has the target as `head` and the edits as a commit on it,
 *   `theirs`, and concludes with one parent;
 * - `rejoin`: paths that come back from being left out (a nested repository removed, `ignore`
 *   changed) were changed both in the folder and on the branch. `head` is the branch tip,
 *   `theirs` a commit on it holding the folder's copies of those paths.
 */
export type MergeKind = "merge" | "recovery" | "rejoin";

/** A merge with conflicts in progress (see {@link concludeMerge}). */
export interface MergeInProgress {
  /** What stopped (see {@link MergeKind}) */
  kind: MergeKind;
  /** The branch tip the merge started from: the branch stays there until it is concluded */
  head: ObjectId;
  /** The commit merged in */
  theirs: ObjectId;
  /** Paths with both sides kept, to resolve before concluding */
  conflicts: string[];
  /**
   * Those of `conflicts` with nothing to resolve in a file: a directory stands there (a
   * nested repository, a submodule's checkout, files of your own) where the other side has a
   * file, which is beside it as `<path>.theirs-<id>`. The directory is never removed.
   */
  kept: string[];
  /**
   * When every conflict is `kept`, how to get out: aborting alone brings the same stop back
   * at the next sync while the directory stays
   */
  hint?: string;
  /** The message the merge commit gets */
  message: string;
}

interface MergeRecord {
  /** The record's own commit */
  id: ObjectId;
  kind: MergeKind;
  /**
   * `recovery` only: the commit the cut-short checkout started from (undefined: none). While
   * `writing`, the branch is still there (and the record's first parent is it, or the target
   * when there is none); once `stopped`, the branch moves from it to `head`, the commit of the
   * folder's edits, and a move cut short is finished from it.
   */
  from?: ObjectId;
  /**
   * `writing`: the merge result is being written into the folder (a write cut short is
   * finished first, from the checkout plan); `stopped`: the folder holds it, for the user
   */
  phase: "writing" | "stopped";
  head: ObjectId;
  theirs: ObjectId;
  /** The merge result */
  files: FlatTree;
  conflicts: string[];
  /** Conflicts where a directory is kept in place of the other side's file (see {@link MergeInProgress.kept}) */
  kept?: string[];
  /** First line of the merge commit's message */
  title: string;
  /**
   * What was left out when the merge stopped (ignored paths, nested repositories, held files),
   * as paths or directories: until the merge is concluded or aborted they stay left out,
   * whatever `ignore` or the folder say meanwhile, so the merge commit carries them over and
   * an abort never touches them. The next commit after it brings them back by the usual rules.
   */
  leftOut: string[];
}

/** The record's commit, not yet named by the ref. */
async function mergeCommit(
  ws: GitWorkspace,
  record: Omit<MergeRecord, "id">,
): Promise<MergeRecord> {
  const meta = JSON.stringify({
    phase: record.phase,
    conflicts: record.conflicts,
    title: record.title,
    leftOut: record.leftOut,
    kind: record.kind,
    ...(record.kind === "recovery" ? { from: record.from ?? null } : {}),
    ...(record.kept?.length ? { kept: record.kept } : {}),
  });
  const id = await commitTree(
    ws,
    record.files,
    [record.head, record.theirs],
    `workspace merge\n\n${meta}`,
  );
  return { ...record, id };
}

async function storeMerge(ws: GitWorkspace, record: Omit<MergeRecord, "id">): Promise<MergeRecord> {
  const stored = await mergeCommit(ws, record);
  await ws.history.refs.set(mergeRef(ws), stored.id);
  return stored;
}

/**
 * The merge in progress, if any; what it froze as left out applies from now on (see
 * {@link skipFor}). A record whose merge commit already landed (a conclude cut short between
 * moving the branch and removing the record) is removed.
 */
async function loadMerge(ws: GitWorkspace): Promise<MergeRecord | undefined> {
  const record = await readMerge(ws);
  frozenPaths.set(ws, record?.leftOut ?? []);
  return record;
}

async function readMerge(ws: GitWorkspace): Promise<MergeRecord | undefined> {
  const id = (await ws.history.refs.resolve(mergeRef(ws)))?.objectId;
  if (!id) return undefined;
  const commit = await ws.history.commits.load(id);
  if (!commit) return undefined;
  if (commit.parents.length !== 2) return undefined;
  const [head, theirs] = commit.parents as [ObjectId, ObjectId];
  const meta = JSON.parse(commit.message.slice(commit.message.indexOf("\n\n") + 2)) as {
    phase?: unknown;
    conflicts?: unknown;
    title?: unknown;
    leftOut?: unknown;
    kind?: unknown;
    from?: unknown;
    kept?: unknown;
  };
  const kind: MergeKind = meta.kind === "recovery" || meta.kind === "rejoin" ? meta.kind : "merge";
  const tip = await workspaceHead(ws);
  if (tip && tip !== head) {
    const landed = await ws.history.commits.load(tip);
    // a first checkout's recovery concludes with one parent (see concludeParents)
    const single = kind === "recovery" && typeof meta.from !== "string";
    const expected = single ? [head] : [head, theirs];
    if (
      landed?.parents.length === expected.length &&
      expected.every((p, i) => landed.parents[i] === p)
    ) {
      // concluded, cut short before the record went: what the conclude still had to do
      if (kind === "rejoin") await endRejoin(ws, strings(meta.conflicts), "concluded");
      await ws.history.refs.remove(planRef(ws));
      await ws.history.refs.remove(mergeRef(ws));
      return undefined;
    }
  }
  return {
    id,
    kind,
    ...(kind === "recovery" && typeof meta.from === "string" ? { from: meta.from } : {}),
    phase: meta.phase === "writing" ? "writing" : "stopped",
    head,
    theirs,
    files: (await readCommitTree(ws.history, id)).files,
    conflicts: strings(meta.conflicts),
    kept: strings(meta.kept),
    title: typeof meta.title === "string" ? meta.title : "Merge",
    leftOut: strings(meta.leftOut),
  };
}

function mergeMessage(record: MergeRecord): string {
  const lines = [record.title];
  const kept = new Set(record.kept ?? []);
  if (record.conflicts.length > 0) {
    lines.push(
      "",
      "Conflicts:",
      ...record.conflicts.map((p) => (kept.has(p) ? `\t${p} (directory kept)` : `\t${p}`)),
    );
  }
  return lines.join("\n");
}

function publicMerge(record: MergeRecord): MergeInProgress {
  return {
    kind: record.kind,
    head: record.head,
    theirs: record.theirs,
    conflicts: record.conflicts,
    kept: record.kept ?? [],
    ...(keptOnly(record) ? { hint: keptHint(record) } : {}),
    message: mergeMessage(record),
  };
}

/** Whether every conflict of `record` is a directory kept in place of a file: nothing to resolve. */
function keptOnly(record: MergeRecord): boolean {
  const kept = new Set(record.kept ?? []);
  return record.conflicts.length > 0 && record.conflicts.every((c) => kept.has(c));
}

function keptHint(record: MergeRecord): string {
  const paths = record.conflicts.join(", ");
  return (
    `nothing to resolve in a file: ${paths} stay directories (a nested repository, a submodule's ` +
    "checkout or files of your own) where the other side has a file, which is beside each as " +
    "<path>.theirs-<id>. Conclude to keep both (remove the copy first to drop it), or move the " +
    'directory away and sync again, or sync once with onConflict: "commit"; aborting alone ' +
    "brings the same stop back at the next sync."
  );
}

/**
 * The merge in progress, if any. A merge result whose writing was cut short is written first
 * (from the checkout plan, so nothing is merged twice), then the merge is `stopped`.
 */
async function recoverMerge(
  ws: GitWorkspace,
): Promise<{ record: MergeRecord; touched: string[]; resumed: boolean } | undefined> {
  const record = await loadMerge(ws);
  if (!record) return undefined;
  const head = await workspaceHead(ws);
  if (record.kind === "recovery") {
    if (record.phase === "stopped") {
      // the branch move to the folder's edits was cut short: finished now
      if (head !== record.head && head === record.from) await moveBranch(ws, head, record.head);
      await ws.history.refs.remove(planRef(ws));
      return { record, touched: [], resumed: false };
    }
    if (head !== record.from) {
      throw new Error(`${ws.branch} moved while a checkout was being finished in the folder`);
    }
    const done = await finishCheckout(ws, record.from, record.theirs);
    return { record: await stopRecovery(ws, record), touched: done.touched, resumed: true };
  }
  if (record.phase === "stopped") return { record, touched: [], resumed: false };
  if (head !== record.head) {
    throw new Error(`${ws.branch} moved while a merge was being written into the folder`);
  }
  const done = await finishCheckout(ws, record.head, record.id);
  const stopped = await storeMerge(ws, {
    ...record,
    phase: "stopped",
    conflicts: [...new Set([...record.conflicts, ...done.conflicts])].sort(),
  });
  await ws.history.refs.remove(planRef(ws));
  return { record: stopped, touched: done.touched, resumed: true };
}

/**
 * What is left out of the folder now (ignored paths, nested repositories, held files), as
 * topmost paths: frozen in a merge record when a merge stops (see {@link MergeRecord.leftOut}).
 * `trees` adds the ignored paths they hold, by their topmost ignored directory.
 */
function freezeLeftOut(ws: GitWorkspace, walked: FolderWalk, trees: FlatTree[]): string[] {
  const leftOut = new Set<string>([
    ...walked.ignored,
    ...(nestedRoots.get(ws) ?? []),
    ...(heldPaths.get(ws) ?? []),
  ]);
  const topIgnored = (path: string) => {
    for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) {
      if (ws.ignore(path.slice(0, i))) return path.slice(0, i);
    }
    return path;
  };
  for (const tree of trees) {
    for (const p of tree.keys()) if (ws.ignore(p)) leftOut.add(topIgnored(p));
  }
  // only topmost entries: one below another adds nothing, and the record stays small
  const below = under(leftOut);
  return [...leftOut].filter((p) => !below(p)).sort();
}

/** Whether a {@link currentFileId} result names a blob (not a directory, not an unreadable file). */
const isBlobId = (id: string) => !id.includes(":");

/**
 * Turns a recovery stop whose folder writes are done (`writing`) into a stopped merge: the
 * folder's edits that the checkout met become a commit on the commit it started from (the
 * user's version of each conflicted path, as the plan saw it, and edits made on top of paths
 * the checkout had already written), the record names that commit as `head` and the target as
 * `theirs`, then the branch moves there and the plan goes. The record is stored before the
 * branch moves: a move cut short is finished by {@link recoverMerge}.
 *
 * A first checkout (no commit before it) has nothing to commit the edits on: the branch moves
 * to the target, which is `head`, and the edits become a commit on it, `theirs`; concluding
 * then commits on the target (one parent) and aborting gives the edits back (see
 * {@link editsOnTop}).
 *
 * Paths left out now (a file back from being ignored and held, say) are never taken as edits:
 * the merge result keeps the target's version there, and they are not reported.
 */
async function stopRecovery(ws: GitWorkspace, record: MergeRecord): Promise<MergeRecord> {
  const target = record.theirs;
  const { from } = record;
  const fromFiles = (await readCommitTree(ws.history, from)).files;
  const to = (await readCommitTree(ws.history, target)).files;
  const plan = await loadPlan(ws, target);
  if (!plan) throw new Error(`the plan of the checkout of ${target.slice(0, 7)} is missing`);
  // the edits go on the start, or on the target when there is none
  const mine: FlatTree = new Map(from ? fromFiles : to);
  const files: FlatTree = new Map(plan.files);
  const leftOut = new Set<string>();
  const kept = new Set<string>();
  const skipWrite = skipFor(ws, to);
  const skipRemove = skipFor(ws, fromFiles);
  const paths = new Set([...fromFiles.keys(), ...to.keys(), ...plan.files.keys()]);
  for (const path of [...paths].sort()) {
    const h = inFolder(fromFiles.get(path));
    const t = inFolder(to.get(path));
    const base = from ? h : t;
    const want = inFolder(plan.files.get(path));
    if (path in plan.seen) {
      if (plan.seen[path] === KEPT_DIRECTORY) kept.add(path);
      const held = heldPaths.get(ws)?.has(path) || ws.ignore(path);
      if (held && plan.seen[path] !== KEPT_DIRECTORY && (t ? skipWrite(path) : skipRemove(path))) {
        // a file held or ignored now: its folder copy is not history's and never named as a
        // conflict (it is reported as held), the target's version stays
        leftOut.add(path);
        const entry = to.get(path);
        if (entry) files.set(path, entry);
        else files.delete(path);
        continue;
      }
      // a conflict: the folder's own content, as the plan found it
      const seen = plan.seen[path];
      if (seen === null || seen === KEPT_DIRECTORY) {
        if (base) mine.delete(path);
      } else {
        const mode = h?.mode ?? t?.mode ?? MODE_FILE;
        mine.set(path, { id: seen, mode });
      }
      continue;
    }
    if (h?.id === want?.id || (want ? skipWrite(path) : skipRemove(path))) continue;
    // written by the checkout, then changed: the user's edit, kept by an abort too
    const now = await currentFileId(ws.folder, path);
    if (now === undefined) {
      if (want && base) mine.delete(path);
      continue;
    }
    if (now === h?.id || now === want?.id || !isBlobId(now)) continue;
    const id = await ws.history.blobs.store(ws.folder.read(`/${path}`));
    mine.set(path, { id, mode: h?.mode ?? want?.mode ?? MODE_FILE });
  }
  const tree = await storeFlatTree(ws.history, mine);
  const who = person(ws);
  const editsCommit = (parents: ObjectId[]) =>
    ws.history.commits.store({
      tree,
      parents,
      author: who,
      committer: who,
      message: `Folder edits made while the checkout of ${target.slice(0, 7)} was unfinished\n`,
    });
  let head: ObjectId;
  let theirs = target;
  if (!from) {
    head = target;
    theirs = await editsCommit([target]);
  } else if (tree !== (await readCommitTree(ws.history, from)).tree) {
    head = await editsCommit([from]);
  } else {
    head = from;
  }
  const stopped = await storeMerge(ws, {
    ...record,
    phase: "stopped",
    head,
    theirs,
    files,
    conflicts: plan.conflicts.filter((c) => !leftOut.has(c)).sort(),
    kept: [...kept].filter((c) => plan.conflicts.includes(c)).sort(),
  });
  if ((await workspaceHead(ws)) !== head) await moveBranch(ws, from, head);
  await ws.history.refs.remove(planRef(ws));
  return stopped;
}

/**
 * Whether the merge's `theirs` is the folder's own side, as a commit on `head`: a rejoin, or
 * a recovery of a first checkout. An abort gives `theirs` back; a conclude of a first
 * checkout commits on `head` alone (see {@link concludeParents}).
 */
function editsOnTop(record: MergeRecord): boolean {
  return record.kind === "rejoin" || (record.kind === "recovery" && record.from === undefined);
}

/** The parents of the commit that concludes `record`. */
function concludeParents(record: MergeRecord): ObjectId[] {
  // a first checkout: nothing to merge the target with, the resolution is a commit on it
  if (record.kind === "recovery" && record.from === undefined) return [record.head];
  return [record.head, record.theirs];
}

/**
 * Stops a rejoin with conflicts: the folder holds the rejoin's results (written by
 * {@link rejoinLeftOut}, whose steps stay in the skip record until the merge ends). The
 * folder's copies of the conflicted paths become a commit on the branch tip (`theirs`), and
 * the merge record names the branch tip as `head`. The branch does not move.
 */
async function stopRejoin(
  ws: GitWorkspace,
  head: ObjectId,
  headFiles: FlatTree,
  paths: string[],
  walked: FolderWalk,
): Promise<MergeRecord> {
  const stale = await loadStale(ws);
  const mine: FlatTree = new Map(headFiles);
  const files: FlatTree = new Map(headFiles);
  const kept: string[] = [];
  for (const path of paths) {
    const step = stale.rejoining.get(path);
    if (!step) continue;
    if (step.result?.startsWith("directory:") && headFiles.has(path)) kept.push(path);
    const branch = inFolder(headFiles.get(path));
    if (step.mine) mine.set(path, step.mine);
    else mine.delete(path);
    if (step.result && isBlobId(step.result)) {
      files.set(path, { id: step.result, mode: branch?.mode ?? step.mine?.mode ?? MODE_FILE });
    } else {
      files.delete(path);
    }
    for (const w of step.writes) {
      if (w.at === path) continue;
      if (w.id) files.set(w.at, { id: w.id, mode: w.mode });
      else files.delete(w.at);
    }
  }
  const theirs = await commitTree(ws, mine, [head], "Folder copies of paths that came back");
  const record = await storeMerge(ws, {
    kind: "rejoin",
    phase: "stopped",
    head,
    theirs,
    files,
    conflicts: [...paths].sort(),
    kept: kept.sort(),
    title: `Merge folder copies of paths that came back into ${ws.branch.slice("refs/heads/".length)}`,
    leftOut: freezeLeftOut(ws, walked, [headFiles]),
  });
  frozenPaths.set(ws, record.leftOut);
  return record;
}

/**
 * Ends a rejoin stop in the skip record: `concluded`, the paths are history's now (forgotten);
 * `aborted`, their decided steps go and they stay recorded with the version the folder last
 * held, so the next commit brings them back again.
 */
async function endRejoin(
  ws: GitWorkspace,
  paths: string[],
  how: "concluded" | "aborted",
): Promise<void> {
  const stale = await loadStale(ws);
  let changed = false;
  for (const path of paths) {
    if (how === "aborted") {
      if (stale.rejoining.delete(path)) changed = true;
    } else if (stale.paths.has(path) || stale.rejoining.has(path)) {
      forget(stale, path);
      changed = true;
    }
  }
  if (changed) await saveStale(ws, stale);
}

/**
 * The merge in progress on the workspace branch, if any: its conflicts are in the folder, and
 * nothing is committed or synced until {@link concludeMerge} or {@link abortMerge}.
 */
export function readMergeState(ws: GitWorkspace): Promise<MergeInProgress | undefined> {
  return runExclusive(ws, async () => {
    const record = await loadMerge(ws);
    return record ? publicMerge(record) : undefined;
  });
}

/**
 * The commit step of {@link commitWorkspaceChanges}, without taking the workspace's queue: for
 * code that already runs inside {@link runExclusive} (a sync).
 */
export async function commitFolder(
  ws: GitWorkspace,
  message: string,
  options: { include?: string[]; onConflict?: ConflictMode } = {},
): Promise<WorkspaceCommit> {
  const onConflict = options.onConflict ?? ws.onConflict;
  heldPaths.set(ws, new Set((await loadStale(ws)).held));
  await loadMerge(ws); // a merge in progress: what it froze as left out stays left out
  // one listing for the round: the nested repositories it finds drive the finish, the rejoin,
  // the snapshot and the tree, and the snapshot is taken from it. Only when the finish or the
  // rejoin wrote something is the folder listed again (its repositories added to the round's).
  let walked = await walk(ws);
  // held files released by the early hold (their content is the branch's again)
  let released: string[] = [];
  if (await ws.history.refs.resolve(pendingRef(ws))) {
    // files back from being ignored are held before the finish: it never writes over them,
    // never takes them for edits that clash with the target, and a stop freezes them as left out
    const stale = await loadStale(ws);
    const from = (await readCommitTree(ws.history, await workspaceHead(ws))).files;
    const early = await holdUnignored(ws, stale, walked, from, options.include ?? []);
    if (early.changed) await saveStale(ws, stale);
    heldPaths.set(ws, early.hold);
    released = early.released;
  }
  const finished = await finishPendingCheckout(ws, walked, onConflict);
  const conflicts = [...finished.conflicts];
  const touched = [...finished.touched];
  const merging = await recoverMerge(ws);
  if (merging) {
    // a merge with conflicts in progress: nothing is committed until it is concluded
    touched.push(...merging.touched);
    if (touched.length > 0) walked = await walk(ws, true);
    const tempFiles = new Map<string, number>();
    const { skipped } = await folderSnapshot(ws, merging.record.files, walked, tempFiles);
    await sweepTempFiles(ws.folder, tempFiles);
    for (const path of [...(heldPaths.get(ws) ?? [])].sort()) {
      skipped.push({ path, reason: "unignored-local" });
    }
    const { record } = merging;
    const started = merging.resumed || finished.stopped !== undefined;
    return {
      head: await workspaceHead(ws),
      // a recovery stop commits the folder's edits on their own (never the target's content)
      changed:
        started &&
        record.kind === "recovery" &&
        record.from !== undefined &&
        record.head !== record.from,
      conflicts: record.conflicts,
      skipped,
      rejoined: released,
      merge: publicMerge(record),
      mergeStarted: started,
    };
  }
  const head = await workspaceHead(ws);
  const current = await readCommitTree(ws.history, head);
  const stop = onConflict === "stop" && head !== undefined;
  const back = await rejoinLeftOut(ws, current.files, options.include ?? [], stop);
  conflicts.push(...back.conflicts.filter((c) => !conflicts.includes(c)));
  touched.push(...back.touched);
  if (touched.length > 0) walked = await walk(ws, true);
  const record = await loadStale(ws);
  const held = await holdUnignored(ws, record, walked, current.files, options.include ?? []);
  if (held.changed) await saveStale(ws, record);
  const rejoined = [...new Set([...released, ...back.rejoined, ...held.released])].sort();
  heldPaths.set(ws, held.hold);
  const tempFiles = new Map<string, number>();
  if (head && back.stopped.length > 0) {
    // paths that came back with conflicts: stopped like a merge, nothing committed
    const stopped = await stopRejoin(ws, head, current.files, back.stopped, walked);
    const { skipped } = await folderSnapshot(ws, stopped.files, walked, tempFiles);
    for (const path of held.report) skipped.push({ path, reason: "unignored-local" });
    await sweepTempFiles(ws.folder, tempFiles);
    return {
      head,
      changed: false,
      conflicts: stopped.conflicts,
      skipped,
      rejoined,
      merge: publicMerge(stopped),
      mergeStarted: true,
    };
  }
  const { snapshot, skip, skipped } = await folderSnapshot(ws, current.files, walked, tempFiles);
  for (const path of held.report) skipped.push({ path, reason: "unignored-local" });
  await sweepTempFiles(ws.folder, tempFiles);
  const tree = await storeFlatTree(
    ws.history,
    composeTree(current.files, snapshot, skip, folderHasSymlinks(ws.folder)),
  );
  if (tree === current.tree) return { head, changed: false, conflicts, skipped, rejoined };
  const who = person(ws);
  const commit = await ws.history.commits.store({
    tree,
    parents: head ? [head] : [],
    author: who,
    committer: who,
    message: message.endsWith("\n") ? message : `${message}\n`,
  });
  await moveBranch(ws, head, commit);
  return { head: commit, changed: true, conflicts, skipped, rejoined };
}

/**
 * Commits the folder as it is now on the workspace branch, when it differs from the branch tip.
 * While a merge with conflicts is in progress nothing is committed: the result's `merge` says
 * so (see {@link concludeMerge}).
 *
 * @example
 * ```ts
 * const { head, changed } = await commitWorkspaceChanges(ws, "notes from the train");
 * // a file back from being ignored is committed only when named
 * await commitWorkspaceChanges(ws, { include: ["app.cfg"] });
 * ```
 */
export function commitWorkspaceChanges(
  ws: GitWorkspace,
  options: string | CommitOptions = {},
): Promise<WorkspaceCommit> {
  const {
    message = "Workspace changes",
    include,
    onConflict,
  } = typeof options === "string" ? { message: options } : options;
  return runExclusive(ws, () => commitFolder(ws, message, { include, onConflict }));
}

/** How {@link integrateCommit} brought `theirs` into the workspace. */
export interface Integration {
  /**
   * `conflicted`: a merge with conflicts stopped, as git stops: the folder holds the merge
   * result, the branch did not move, and the merge is in progress (see {@link concludeMerge})
   */
  kind: "up-to-date" | "fast-forward" | "merge" | "conflicted";
  /** The branch tip afterwards */
  head?: ObjectId;
  /** Paths merged with both sides kept, or moved aside (see the merge) */
  conflicts: string[];
  /** Folder paths written and removed */
  written: string[];
  removed: string[];
  /** The merge in progress (`conflicted` only) */
  merge?: MergeInProgress;
}

/** Options of {@link integrateCommit}. */
export interface IntegrateOptions {
  /** Names their side in conflict markers (default `theirs`) */
  theirsName?: string;
  /** Message of a merge commit */
  message?: string;
  /** What a merge with conflicts does (default: the workspace's `onConflict`) */
  onConflict?: ConflictMode;
}

/** How a case-insensitive (and, on HFS+, normalizing) folder compares names */
function fold(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * Paths a case-insensitive folder would merge: a directory spelled two ways (`Docs/` and
 * `docs/`) is one directory there, so its later spellings are renamed to the first one; two
 * files that are then one name keep the first, the others are moved aside. Each path changed
 * is reported.
 */
function caseCollisions(files: FlatTree, tag: string): { files: FlatTree; moved: string[] } {
  const dirs = new Map<string, string>(); // folded directory path -> first spelling
  const names = new Set<string>(); // folded paths in the tree
  for (const p of files.keys()) names.add(fold(p));
  const out: FlatTree = new Map();
  const taken = new Set<string>();
  const moved: string[] = [];
  for (const path of [...files.keys()].sort()) {
    const entry = files.get(path) as FlatEntry;
    const parts = path.split("/");
    const last = parts.pop() as string;
    let dir = "";
    for (const part of parts) {
      const spelled = dir ? `${dir}/${part}` : part;
      const canon = dirs.get(fold(spelled));
      if (canon === undefined) dirs.set(fold(spelled), spelled);
      dir = canon ?? spelled;
    }
    const wanted = dir ? `${dir}/${last}` : last;
    let name = wanted;
    for (let n = 1; taken.has(fold(name)) || (name !== wanted && names.has(fold(name))); n++) {
      name = n === 1 ? `${wanted}.${tag}` : `${wanted}.${tag}-${n}`;
    }
    taken.add(fold(name));
    out.set(name, entry);
    if (name !== path) moved.push(path);
  }
  return { files: out, moved };
}

/**
 * Brings the folder from `head` to `target`, recorded first under `record` (default: the
 * pending checkout), then `complete` (default: the branch moves to `target` and the record
 * goes). A checkout cut short leaves the record and a plan to finish it. `targetOf` may be
 * made from the round's listing, once the folder is known to match `head`.
 */
async function checkoutAndMove(
  ws: GitWorkspace,
  head: ObjectId | undefined,
  headFiles: FlatTree,
  targetOf: ObjectId | ((walked: FolderWalk) => Promise<ObjectId>),
  targetFiles: FlatTree,
  options: { record?: string; complete?: () => Promise<void> } = {},
) {
  // one listing: the folder must still be what `head` recorded, an edit made since is not
  // overwritten; the nested repositories it finds are left alone by the checkout
  const walked = await walk(ws);
  const { snapshot, skip } = await folderSnapshot(ws, headFiles, walked);
  const expected = composeTree(headFiles, snapshot, skip, folderHasSymlinks(ws.folder));
  const tree = await storeFlatTree(ws.history, expected);
  if (tree !== (await readCommitTree(ws.history, head)).tree) throw new FolderChangedError();
  const target = typeof targetOf === "string" ? targetOf : await targetOf(walked);
  await ws.history.refs.remove(planRef(ws));
  await recordLeftAlone(ws, headFiles, targetFiles);
  await ws.history.refs.set(options.record ?? pendingRef(ws), target);
  const changed = new Set<string>();
  for (const p of new Set([...headFiles.keys(), ...targetFiles.keys()])) {
    if (headFiles.get(p)?.id !== targetFiles.get(p)?.id) changed.add(p);
  }
  let done: { written: string[]; removed: string[] };
  const progress: string[] = [];
  try {
    done = await checkoutFolder(ws.history, ws.folder, headFiles, targetFiles, {
      // files under the target's submodules are not written, under the head's not removed
      skipWrite: skipFor(ws, targetFiles),
      skipRemove: skip,
      // ignored files may go to make room, a submodule's checkout never
      expendable: expendableFor(ws),
      progress,
    });
  } catch (error) {
    // cut short: the plan to finish it is made now, with what is already done
    const plan = await makePlan(ws, target, headFiles, targetFiles).catch(() => undefined);
    if (plan) {
      plan.done = progress;
      await storePlan(ws, plan).catch(() => undefined);
    }
    throw error;
  } finally {
    invalidate(ws, changed);
  }
  if (options.complete) {
    await options.complete();
  } else {
    await moveBranch(ws, head, target);
    await ws.history.refs.remove(pendingRef(ws));
  }
  return done;
}

/**
 * Brings commit `theirs` (already in the repository) into the workspace: nothing when the
 * branch contains it, a fast-forward when the branch is behind it, a merge commit otherwise
 * (git's recursive strategy over the best common ancestors). Every path of their tree is
 * checked first: a tree naming `.git`, `..` or an absolute path is refused
 * ({@link UnsafePathError}) before anything is written. On a case-insensitive folder, paths
 * that would name one file are moved aside in a commit on top. The folder is checked out
 * before the branch moves. Call it with the folder committed ({@link commitFolder}); a folder
 * that changed since is not overwritten ({@link FolderChangedError}). Like
 * {@link commitFolder} it does not take the workspace's queue.
 *
 * A merge with conflicts, with `onConflict: "stop"` (the default), stops as git stops: the
 * merge result is written into the folder, the branch stays where it was, and the merge is in
 * progress (`kind: "conflicted"`) until {@link concludeMerge} or {@link abortMerge}.
 */
export async function integrateCommit(
  ws: GitWorkspace,
  theirs: ObjectId,
  options: IntegrateOptions = {},
): Promise<Integration> {
  const { commits } = ws.history;
  const head = await workspaceHead(ws);
  if (await ws.history.refs.resolve(mergeRef(ws))) {
    throw new Error(`a merge is in progress on ${ws.branch}: conclude or abort it first`);
  }
  const none = { conflicts: [], written: [], removed: [] };
  if (head === theirs || (head && (await commits.isAncestor(theirs, head)))) {
    return { kind: "up-to-date", head, ...none };
  }
  const theirTree = await readCommitTree(ws.history, theirs);
  assertSafePaths(theirTree.files.keys());
  const ours = await readCommitTree(ws.history, head);
  const branchName = ws.branch.slice("refs/heads/".length);
  const theirsName = options.theirsName ?? "theirs";
  const onConflict = options.onConflict ?? ws.onConflict;

  let kind: Integration["kind"];
  let target: ObjectId;
  let targetFiles: FlatTree;
  const conflicts = new Set<string>();
  if (!head || (await commits.isAncestor(head, theirs))) {
    kind = "fast-forward";
    target = theirs;
    targetFiles = theirTree.files;
  } else {
    kind = "merge";
    const merged = await mergeRecursive(
      ws.history,
      { heads: [head], files: ours.files },
      { heads: [theirs], files: theirTree.files },
      {
        oursLabel: `${branchName} (${head.slice(0, 7)})`,
        theirsLabel: `${theirsName} (${theirs.slice(0, 7)})`,
        oursTag: `ours-${head.slice(0, 7)}`,
        theirsTag: `theirs-${theirs.slice(0, 7)}`,
      },
    );
    for (const c of merged.conflicts) conflicts.add(c);
    const title =
      options.message ?? `Merge ${theirsName} (${theirs.slice(0, 7)}) into ${branchName}`;
    targetFiles = merged.files;
    if (merged.conflicts.length > 0 && onConflict === "stop") {
      return stopMerge(ws, head, ours.files, theirs, targetFiles, conflicts, title);
    }
    const lines = [title];
    if (merged.conflicts.length > 0) {
      lines.push("", "Conflicts:", ...merged.conflicts.map((p) => `\t${p}`));
    }
    target = await commitTree(ws, targetFiles, [head, theirs], lines.join("\n"));
  }
  if (ws.caseInsensitive) {
    const fixed = caseCollisions(targetFiles, `case-${target.slice(0, 7)}`);
    if (fixed.moved.length > 0) {
      for (const c of fixed.moved) conflicts.add(c);
      targetFiles = fixed.files;
      target = await commitTree(
        ws,
        targetFiles,
        [target],
        ["Move aside paths that differ only in case", "", ...fixed.moved.map((p) => `\t${p}`)].join(
          "\n",
        ),
      );
    }
  }
  const done = await checkoutAndMove(ws, head, ours.files, target, targetFiles);
  return { kind, head: target, conflicts: [...conflicts].sort(), ...done };
}

/**
 * A merge with conflicts, stopped as git stops it: the merge result is recorded as the merge
 * in progress (`writing`), written into the folder (from the checkout plan if cut short), and
 * the record becomes `stopped`. The branch does not move; nothing is committed.
 */
async function stopMerge(
  ws: GitWorkspace,
  head: ObjectId,
  headFiles: FlatTree,
  theirs: ObjectId,
  mergedFiles: FlatTree,
  conflicts: Set<string>,
  title: string,
): Promise<Integration> {
  let files = mergedFiles;
  if (ws.caseInsensitive) {
    // the paths a case-insensitive folder would merge are moved aside in the result itself
    const fixed = caseCollisions(files, `case-${theirs.slice(0, 7)}`);
    for (const c of fixed.moved) conflicts.add(c);
    files = fixed.files;
  }
  let record: Omit<MergeRecord, "id"> = {
    kind: "merge",
    phase: "writing",
    head,
    theirs,
    files,
    conflicts: [...conflicts].sort(),
    title,
    leftOut: [],
  };
  let stopped: MergeRecord | undefined;
  // the record's commit is made before the folder is touched (the checkout sets the ref): it
  // freezes what is left out now, so changing `ignore` or removing a nested repository during
  // the merge never lets conclude or abort commit, write or remove those paths
  const begin = async (walked: FolderWalk) => {
    record = { ...record, leftOut: freezeLeftOut(ws, walked, [headFiles, files]) };
    frozenPaths.set(ws, record.leftOut);
    return (await mergeCommit(ws, record)).id;
  };
  const done = await checkoutAndMove(ws, head, headFiles, begin, files, {
    record: mergeRef(ws),
    complete: async () => {
      stopped = await storeMerge(ws, { ...record, phase: "stopped" });
    },
  });
  return {
    kind: "conflicted",
    head,
    conflicts: record.conflicts,
    ...done,
    merge: publicMerge(stopped ?? { ...record, id: "" }),
  };
}

/** Conflicted paths that still hold conflict markers when {@link concludeMerge} is called. */
export class UnresolvedConflictsError extends Error {
  /**
   * @param paths every conflicted path still holding markers
   * @param leftOut those of `paths` that were left out of the folder when the merge stopped
   *   (ignored, in a nested repository, held): their markers are in the merge result only,
   *   and the user never saw them
   */
  constructor(
    readonly paths: string[],
    readonly leftOut: string[] = [],
  ) {
    const inFolder = paths.filter((p) => !leftOut.includes(p));
    const parts: string[] = [];
    if (inFolder.length > 0) parts.push(`conflict markers are still in ${inFolder.join(", ")}`);
    if (leftOut.length > 0) {
      parts.push(
        `conflicted paths left out of the folder (ignored, nested repository or held) would be committed with markers: ${leftOut.join(", ")}; abort the merge, stop leaving them out and sync again, or conclude with force`,
      );
    }
    super(parts.join("; "));
    this.name = "UnresolvedConflictsError";
  }
}

/** {@link concludeMerge} or {@link abortMerge} with no merge in progress. */
export class NoMergeInProgressError extends Error {
  constructor(branch: string) {
    super(`no merge in progress on ${branch}`);
    this.name = "NoMergeInProgressError";
  }
}

async function readBytes(folder: FilesApi, path: string): Promise<Uint8Array | undefined> {
  const stats = await folder.stats(`/${path}`);
  if (stats?.kind !== "file") return undefined;
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of folder.read(`/${path}`)) {
    parts.push(chunk);
    size += chunk.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function blobBytes(ws: GitWorkspace, id: ObjectId): Promise<Uint8Array | undefined> {
  const content = await ws.history.blobs.load(id);
  if (!content) return undefined;
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of content) {
    parts.push(chunk);
    size += chunk.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Options of {@link concludeMerge}. */
export interface ConcludeMergeOptions {
  /** Message of the merge commit (default: git's, with the conflicted paths listed) */
  message?: string;
  /**
   * Conclude although conflicted files still hold marker lines (default false): for files
   * whose content legitimately has such lines; the folder is committed as it is
   */
  force?: boolean;
}

/**
 * Concludes the merge in progress, as `git commit` does after a conflicted merge: the folder
 * as it is now becomes a merge commit with both parents, and the next sync pushes it. Refused
 * ({@link UnresolvedConflictsError}, nothing changed) while a conflicted text file still holds
 * a conflict marker line (`<<<<<<<` or `>>>>>>>`): git refuses unmerged index entries, and
 * markers are this workspace's equivalent. Binary conflicts are not checked: the folder's
 * version is taken, and a `.theirs-<id>` copy still beside it is committed like any file.
 * A conflicted path that was left out when the merge stopped (ignored, say) is never in the
 * folder, so its markers are looked for in the merge result, and refused the same way.
 * `force` skips the marker check. What was left out when the merge stopped (ignored paths,
 * nested repositories, held files) is carried over from the merge result, whatever `ignore` or
 * the folder say now; the next commit brings such paths back by the usual rules.
 *
 * @example
 * ```ts
 * const result = await syncWorkspace(ws, remote);
 * if (result.integration === "conflicted") {
 *   // edit the files in result.conflicts, then:
 *   await concludeMerge(ws);
 *   await syncWorkspace(ws, remote); // pushes the merge
 * }
 * ```
 */
export function concludeMerge(
  ws: GitWorkspace,
  options: ConcludeMergeOptions = {},
): Promise<WorkspaceCommit> {
  return runExclusive(ws, async () => {
    heldPaths.set(ws, new Set((await loadStale(ws)).held));
    let walked = await walk(ws);
    const merging = await recoverMerge(ws);
    if (!merging) throw new NoMergeInProgressError(ws.branch);
    const { record } = merging;
    if (merging.touched.length > 0) walked = await walk(ws, true);
    if ((await workspaceHead(ws)) !== record.head) {
      throw new Error(`${ws.branch} moved during the merge`);
    }
    const unresolved: string[] = [];
    const leftOutUnresolved: string[] = [];
    const frozen = within(record.leftOut);
    for (const path of options.force ? [] : record.conflicts) {
      if (frozen(path)) {
        // carried over from the merge result, never in the folder: its markers are checked there
        const entry = inFolder(record.files.get(path));
        const bytes = entry ? await blobBytes(ws, entry.id) : undefined;
        if (bytes && hasConflictMarkers(bytes)) {
          unresolved.push(path);
          leftOutUnresolved.push(path);
        }
        continue;
      }
      const bytes = await readBytes(ws.folder, path);
      if (bytes && hasConflictMarkers(bytes)) unresolved.push(path);
    }
    if (unresolved.length > 0) throw new UnresolvedConflictsError(unresolved, leftOutUnresolved);
    const tempFiles = new Map<string, number>();
    const { snapshot, skip, skipped } = await folderSnapshot(ws, record.files, walked, tempFiles);
    await sweepTempFiles(ws.folder, tempFiles);
    for (const path of [...(heldPaths.get(ws) ?? [])].sort()) {
      skipped.push({ path, reason: "unignored-local" });
    }
    const message = (options.message ?? mergeMessage(record)).replace(/\n+$/, "");
    const commit = await commitTree(
      ws,
      composeTree(record.files, snapshot, skip, folderHasSymlinks(ws.folder)),
      concludeParents(record),
      message,
    );
    await moveBranch(ws, record.head, commit);
    // a crash here leaves the record; it is dropped once the merge commit is seen (loadMerge)
    if (record.kind === "rejoin") await endRejoin(ws, record.conflicts, "concluded");
    await ws.history.refs.remove(mergeRef(ws));
    frozenPaths.set(ws, []);
    return { head: commit, changed: true, conflicts: record.conflicts, skipped, rejoined: [] };
  });
}

/** What {@link abortMerge} did. */
export interface MergeAbort {
  /** The branch tip, where the merge started */
  head: ObjectId;
  /** Paths brought back to the branch tip's version */
  restored: string[];
  /**
   * Paths left as they are: a directory with files of its own stands where the branch tip
   * has a file, or where the merge put one (nothing in it is removed)
   */
  kept: string[];
}

/** Options of {@link abortMerge}. */
export interface AbortMergeOptions {
  /**
   * Abort although paths that merged cleanly were edited since the merge stopped (default
   * false: refused with {@link MergeAbortRefusedError}); those edits are discarded
   */
  force?: boolean;
}

/**
 * {@link abortMerge} refused, nothing changed: paths that merged cleanly (not conflicted) and
 * that the abort would write over were edited since the merge stopped, as `git merge --abort`
 * refuses ("not uptodate"). Commit nothing, but save the edits elsewhere, or abort with `force`.
 */
export class MergeAbortRefusedError extends Error {
  constructor(readonly paths: string[]) {
    super(
      `the abort would discard edits made since the merge stopped in ${paths.join(", ")}; keep them elsewhere, or abort with force`,
    );
    this.name = "MergeAbortRefusedError";
  }
}

/**
 * Abandons the merge in progress, as `git merge --abort` (`git reset --merge`) does: every
 * path the merge changed gets back the version it had before the merge (files the merge added
 * are removed), and the record goes. Edits made since the merge stopped to conflicted paths
 * are discarded, as git discards them. Edits made since to paths that merged cleanly would be
 * discarded too, so the abort is refused ({@link MergeAbortRefusedError}, nothing changed)
 * unless `force`. Paths the merge did not change are never touched. A directory is never
 * removed with files of its own: such a path is reported in `kept`. What was left out when the
 * merge stopped (ignored paths, nested repositories, held files) is never touched. A merge
 * whose writing was cut short is undone from its stored plan too: copies the plan put beside
 * files are removed.
 *
 * Aborting a stop of a recovery or a rejoin gives the folder's own version back, never the
 * incoming one, and keeps the incoming one in history for the next sync:
 * - `recovery`: every path gets the version of `head`, the commit of the folder's edits (the
 *   user's version of each conflicted path, the version the checkout started from elsewhere).
 *   The branch stays on that commit, as if the edits had been committed before the sync; the
 *   checkout's target is not taken, and the next sync merges the remote's commits again. A
 *   first checkout (nothing committed before it) has the target as `head`: the paths get the
 *   version of `theirs`, the folder's own files, and the branch stays on the target, so the
 *   next commit takes those files as edits on top of it.
 * - `rejoin`: every path gets the version of `theirs`, the folder's copies of the paths that
 *   came back (the branch tip's elsewhere). The branch does not move; the paths stay recorded
 *   as left out with the version the folder last held, so the next commit brings them back
 *   again (and stops again while both sides still differ).
 * A recovery stop whose writing was cut short is finished first (from its plan), then aborted.
 */
export function abortMerge(ws: GitWorkspace, options: AbortMergeOptions = {}): Promise<MergeAbort> {
  return runExclusive(ws, async () => {
    heldPaths.set(ws, new Set((await loadStale(ws)).held));
    await walk(ws);
    let record = await loadMerge(ws);
    if (!record) throw new NoMergeInProgressError(ws.branch);
    if (record.kind === "recovery") record = (await recoverMerge(ws))?.record ?? record;
    const head = await workspaceHead(ws);
    if (head !== record.head) throw new Error(`${ws.branch} moved during the merge`);
    // what the folder gets back: the branch tip's version, or the folder's own side
    const ours = editsOnTop(record) ? record.theirs : head;
    const headFiles = (await readCommitTree(ws.history, ours)).files;
    // a write cut short may have followed a plan that differs from the result (copies beside)
    const plan = record.phase === "writing" ? await loadPlan(ws, record.id) : undefined;
    const planned = plan?.files ?? new Map<string, FlatEntry>();
    const skipWrite = skipFor(ws, headFiles);
    const skipRemove = skipFor(ws, new Map([...record.files, ...planned]));
    const expendable = expendableFor(ws);
    const accept = (now: ObjectId | undefined) => !now?.startsWith("directory:");
    const restored: string[] = [];
    const kept: string[] = [];
    const paths = [
      ...new Set([...headFiles.keys(), ...record.files.keys(), ...planned.keys()]),
    ].sort();
    const differs = (p: string) => {
      const h = inFolder(headFiles.get(p))?.id;
      return (
        h !== inFolder(record.files.get(p))?.id || (plan && h !== inFolder(planned.get(p))?.id)
      );
    };
    const removals = paths.filter((p) => differs(p) && !inFolder(headFiles.get(p)));
    const writes = paths.filter((p) => differs(p) && inFolder(headFiles.get(p)));
    if (!options.force) {
      // git's reset --merge: a path that merged cleanly and was edited since is not discarded
      const conflicted = new Set(record.conflicts);
      const edited: string[] = [];
      for (const path of [...removals, ...writes]) {
        const h = inFolder(headFiles.get(path));
        if (conflicted.has(path) || (h ? skipWrite(path) : skipRemove(path))) continue;
        const now = await currentFileId(ws.folder, path);
        if (now === undefined || !isBlobId(now) || now === h?.id) continue;
        if (now === inFolder(record.files.get(path))?.id) continue;
        if (plan && now === inFolder(planned.get(path))?.id) continue;
        edited.push(path);
      }
      if (edited.length > 0) throw new MergeAbortRefusedError(edited.sort());
    }
    try {
      for (const path of [...removals, ...writes]) {
        const h = inFolder(headFiles.get(path));
        if (h ? skipWrite(path) : skipRemove(path)) continue;
        try {
          const did = await applyFolderPath(ws.history, ws.folder, path, h, { accept, expendable });
          if (did !== "unchanged") restored.push(path);
        } catch (error) {
          if (!(error instanceof FolderChangedError)) throw error;
          kept.push(path);
        }
      }
    } finally {
      invalidate(ws, paths.filter(differs));
    }
    if (record.kind === "rejoin") await endRejoin(ws, record.conflicts, "aborted");
    await ws.history.refs.remove(planRef(ws));
    await ws.history.refs.remove(mergeRef(ws));
    frozenPaths.set(ws, []);
    return { head, restored: restored.sort(), kept: kept.sort() };
  });
}
