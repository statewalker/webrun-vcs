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
  findNestedRepositories,
  type IgnorePath,
  isExpendableDirectory,
  isSyncTempFile,
  probeCaseInsensitive,
  type SkippedPath,
  type SnapshotReport,
  snapshotFolder,
  sweepTempFiles,
  under,
} from "./folder-tree.js";
import { mergeRecursive } from "./merge-trees.js";
import { assertSafePaths } from "./path-rules.js";

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
}

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
  };
}

// one queue per workspace: its commits, merges and checkouts never interleave
const queues = new WeakMap<GitWorkspace, Promise<unknown>>();
// the last snapshot of each workspace's folder: unchanged files (size, mtime) are not read again
const snapshots = new WeakMap<GitWorkspace, FolderSnapshot>();
// the nested repositories the last snapshot found: their files are left alone like ignored ones
const nestedRoots = new WeakMap<GitWorkspace, string[]>();

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
  return (path) => ws.ignore(path) || isSyncTempFile(path) || inLink(path) || inNested(path);
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
function composeTree(headFiles: FlatTree, snapshot: FolderSnapshot, skip: IgnorePath): FlatTree {
  const out: FlatTree = new Map();
  for (const [path, entry] of headFiles) {
    if (entry.mode === MODE_GITLINK || skip(path)) out.set(path, entry);
  }
  for (const [path, file] of snapshot) {
    const previous = inFolder(headFiles.get(path));
    out.set(path, { id: file.id, mode: previous ? previous.mode : MODE_FILE });
  }
  return out;
}

/**
 * Snapshots the folder, remembering the nested repositories it found (see {@link skipFor}).
 * Returns the snapshot, what to skip now (nested repositories included) and what was left out
 * (submodule checkouts of `headFiles` not counted).
 */
async function folderSnapshot(
  ws: GitWorkspace,
  headFiles: FlatTree,
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
      // the nested repositories this round decided on: what the snapshot leaves out is
      // exactly what the tree carries over
      nested: nestedRoots.get(ws) ?? [],
    },
    report,
  );
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
 */
async function finishPendingCheckout(ws: GitWorkspace): Promise<string[]> {
  const ref = pendingRef(ws);
  const target = (await ws.history.refs.resolve(ref))?.objectId;
  if (!target) return [];
  const head = await workspaceHead(ws);
  if (head === target) {
    await ws.history.refs.remove(ref);
    await ws.history.refs.remove(planRef(ws));
    return [];
  }
  const from = (await readCommitTree(ws.history, head)).files;
  const to = (await readCommitTree(ws.history, target)).files;
  await recordLeftAlone(ws, from, to);
  let plan = await loadPlan(ws, target);
  if (!plan) {
    plan = await makePlan(ws, target, from, to);
    await storePlan(ws, plan);
  }
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
  await moveBranch(ws, head, target);
  await ws.history.refs.remove(ref);
  await ws.history.refs.remove(planRef(ws));
  return plan.conflicts;
}

/**
 * Where the workspace remembers the folder's copies that checkouts left alone: paths that were
 * ignored or inside a nested repository while the branch moved on. A ref only this workspace
 * writes (never pushed).
 */
function staleRef(ws: GitWorkspace): string {
  return `refs/workspace/skip/${ws.branch.slice("refs/heads/".length)}`;
}

/**
 * Paths whose folder copy may be behind the branch because they were left out: the version
 * the folder last held (null: it never held one, a file the remote added meanwhile).
 */
type StaleRecord = Map<string, FlatEntry | null>;

/** What checkouts leave alone and later come back: ignored paths and nested repositories. */
function staleSkip(ws: GitWorkspace): IgnorePath {
  const inNested = under(nestedRoots.get(ws) ?? []);
  return (path) => ws.ignore(path) || inNested(path);
}

async function loadStale(ws: GitWorkspace): Promise<StaleRecord> {
  const record: StaleRecord = new Map();
  const id = (await ws.history.refs.resolve(staleRef(ws)))?.objectId;
  if (!id) return record;
  try {
    const commit = await ws.history.commits.load(id);
    if (!commit) return record;
    for (const [path, entry] of (await readCommitTree(ws.history, id)).files)
      record.set(path, entry);
    const meta = JSON.parse(commit.message.slice(commit.message.indexOf("\n\n") + 2)) as {
      absent?: unknown;
    };
    if (Array.isArray(meta.absent)) {
      for (const p of meta.absent) if (typeof p === "string") record.set(p, null);
    }
  } catch {
    // an unreadable record is an empty one: nothing is taken for stale
  }
  return record;
}

async function saveStale(ws: GitWorkspace, record: StaleRecord): Promise<void> {
  if (record.size === 0) {
    await ws.history.refs.remove(staleRef(ws));
    return;
  }
  const files: FlatTree = new Map();
  const absent: string[] = [];
  for (const [path, entry] of record) {
    if (entry) files.set(path, entry);
    else absent.push(path);
  }
  const id = await commitTree(ws, files, [], `skipped paths\n\n${JSON.stringify({ absent })}`);
  await ws.history.refs.set(staleRef(ws), id);
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
    if (h?.id === t?.id || !skip(path) || record.has(path)) continue;
    record.set(path, h ?? null);
    changed = true;
  }
  if (changed) await saveStale(ws, record);
}

/**
 * Brings back a path that is no longer left out: a three-way merge of the version the folder
 * last held (`base`), the folder's copy and the branch's. A copy unchanged in the folder gets
 * the branch's version (written, or removed); one changed only in the folder is kept; one
 * changed on both sides is merged (text, git's markers) or kept with the branch's version
 * beside it (binary, or a directory in its place), and reported. Returns whether it conflicted.
 */
async function rejoinPath(
  ws: GitWorkspace,
  path: string,
  base: FlatEntry | null,
  theirs: FlatEntry | undefined,
  taken: Set<string>,
): Promise<boolean> {
  const expendable = expendableFor(ws);
  const ours = await currentFileId(ws.folder, path);
  const write = (entry: FlatEntry | undefined, at = path, expect = ours) =>
    applyFolderPath(ws.history, ws.folder, at, entry, {
      accept: (now) => now === expect,
      expendable,
    });
  const aside = () => {
    let name = `${path}.theirs-${theirs?.id.slice(0, 7)}`;
    for (let n = 2; taken.has(name); n++) name = `${path}.theirs-${theirs?.id.slice(0, 7)}-${n}`;
    taken.add(name);
    return name;
  };
  if (ours === theirs?.id) return false;
  if (ours === (base?.id ?? undefined)) {
    await write(theirs);
    return false;
  }
  if (theirs?.id === (base?.id ?? undefined)) return false; // changed only in the folder
  if (ours?.startsWith("directory:")) {
    if (theirs) await write(theirs, aside(), undefined);
    return true;
  }
  if (ours === undefined) {
    if (theirs) await write(theirs); // removed in the folder, changed on the branch: it comes back
    return true;
  }
  if (!theirs) return true; // removed on the branch, changed in the folder: kept
  const mine: FlatEntry = {
    id: await ws.history.blobs.store(ws.folder.read(`/${path}`)),
    mode: theirs.mode,
  };
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
    await write({ id, mode: theirs.mode }, path, mine.id);
    return merged.conflicts > 0;
  }
  await write(theirs, aside(), undefined);
  return true;
}

/**
 * Paths that were left out and no longer are (a nested repository removed, an `ignore` that
 * changed) come back, one by one (see {@link rejoinPath}); paths the branch has that are left
 * out now are recorded with the version the folder holds.
 */
async function rejoinLeftOut(
  ws: GitWorkspace,
  headFiles: FlatTree,
): Promise<{ rejoined: string[]; conflicts: string[] }> {
  const skip = staleSkip(ws);
  const record = await loadStale(ws);
  const rejoined: string[] = [];
  const conflicts: string[] = [];
  const taken = new Set([...headFiles.keys(), ...record.keys()]);
  try {
    for (const [path, base] of [...record]) {
      if (skip(path)) continue;
      if (await rejoinPath(ws, path, base, inFolder(headFiles.get(path)), taken)) {
        conflicts.push(path);
      }
      record.delete(path);
      rejoined.push(path);
      await saveStale(ws, record); // each path once, even when a later one fails
    }
  } finally {
    invalidate(ws, rejoined);
  }
  let changed = false;
  for (const [path, entry] of headFiles) {
    if (entry.mode === MODE_GITLINK || !skip(path) || record.has(path)) continue;
    record.set(path, entry);
    changed = true;
  }
  if (changed) await saveStale(ws, record);
  return { rejoined: rejoined.sort(), conflicts: conflicts.sort() };
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
 * The commit step of {@link commitWorkspaceChanges}, without taking the workspace's queue: for
 * code that already runs inside {@link runExclusive} (a sync).
 */
export async function commitFolder(ws: GitWorkspace, message: string): Promise<WorkspaceCommit> {
  // one set of nested repositories for the whole round: the finish, the rejoin, the snapshot
  // and the tree all leave out the same paths
  nestedRoots.set(ws, await findNestedRepositories(ws.folder));
  const conflicts = await finishPendingCheckout(ws);
  const head = await workspaceHead(ws);
  const current = await readCommitTree(ws.history, head);
  const back = await rejoinLeftOut(ws, current.files);
  conflicts.push(...back.conflicts.filter((c) => !conflicts.includes(c)));
  const { rejoined } = back;
  const tempFiles = new Map<string, number>();
  const { snapshot, skip, skipped } = await folderSnapshot(ws, current.files, tempFiles);
  await sweepTempFiles(ws.folder, tempFiles);
  const tree = await storeFlatTree(ws.history, composeTree(current.files, snapshot, skip));
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
 *
 * @example
 * ```ts
 * const { head, changed } = await commitWorkspaceChanges(ws, "notes from the train");
 * ```
 */
export function commitWorkspaceChanges(
  ws: GitWorkspace,
  message = "Workspace changes",
): Promise<WorkspaceCommit> {
  return runExclusive(ws, () => commitFolder(ws, message));
}

/** How {@link integrateCommit} brought `theirs` into the workspace. */
export interface Integration {
  kind: "up-to-date" | "fast-forward" | "merge";
  /** The branch tip afterwards */
  head?: ObjectId;
  /** Paths merged with both sides kept, or moved aside (see the merge) */
  conflicts: string[];
  /** Folder paths written and removed */
  written: string[];
  removed: string[];
}

/** Options of {@link integrateCommit}. */
export interface IntegrateOptions {
  /** Names their side in conflict markers (default `theirs`) */
  theirsName?: string;
  /** Message of a merge commit */
  message?: string;
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

async function checkoutAndMove(
  ws: GitWorkspace,
  head: ObjectId | undefined,
  headFiles: FlatTree,
  target: ObjectId,
  targetFiles: FlatTree,
) {
  nestedRoots.set(ws, await findNestedRepositories(ws.folder));
  // the folder must still be what `head` recorded: an edit made since is not overwritten
  const { snapshot, skip } = await folderSnapshot(ws, headFiles);
  const expected = composeTree(headFiles, snapshot, skip);
  const tree = await storeFlatTree(ws.history, expected);
  if (tree !== (await readCommitTree(ws.history, head)).tree) throw new FolderChangedError();
  await ws.history.refs.remove(planRef(ws));
  await recordLeftAlone(ws, headFiles, targetFiles);
  await ws.history.refs.set(pendingRef(ws), target);
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
  await moveBranch(ws, head, target);
  await ws.history.refs.remove(pendingRef(ws));
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
 */
export async function integrateCommit(
  ws: GitWorkspace,
  theirs: ObjectId,
  options: IntegrateOptions = {},
): Promise<Integration> {
  const { commits } = ws.history;
  const head = await workspaceHead(ws);
  const none = { conflicts: [], written: [], removed: [] };
  if (head === theirs || (head && (await commits.isAncestor(theirs, head)))) {
    return { kind: "up-to-date", head, ...none };
  }
  const theirTree = await readCommitTree(ws.history, theirs);
  assertSafePaths(theirTree.files.keys());
  const ours = await readCommitTree(ws.history, head);
  const branchName = ws.branch.slice("refs/heads/".length);
  const theirsName = options.theirsName ?? "theirs";

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
    const lines = [
      options.message ?? `Merge ${theirsName} (${theirs.slice(0, 7)}) into ${branchName}`,
    ];
    if (merged.conflicts.length > 0) {
      lines.push("", "Conflicts:", ...merged.conflicts.map((p) => `\t${p}`));
    }
    targetFiles = merged.files;
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
