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
  type IgnorePath,
  isSyncTempFile,
  probeCaseInsensitive,
  snapshotFolder,
  sweepTempFiles,
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
  };
}

// one queue per workspace: its commits, merges and checkouts never interleave
const queues = new WeakMap<GitWorkspace, Promise<unknown>>();
// the last snapshot of each workspace's folder: unchanged files (size, mtime) are not read again
const snapshots = new WeakMap<GitWorkspace, FolderSnapshot>();

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
  return (path) => ws.ignore(path) || isSyncTempFile(path) || inLink(path);
}

/** What the folder can hold of an entry (submodules: nothing). */
function inFolder(entry: FlatEntry | undefined): FlatEntry | undefined {
  return entry && entry.mode !== MODE_GITLINK ? entry : undefined;
}

/**
 * The tree to commit: the folder's files, with the modes the branch gave them, plus what the
 * folder cannot hold, carried over from the branch (ignored paths, submodule entries).
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

async function folderSnapshot(
  ws: GitWorkspace,
  skip: IgnorePath,
  tempFiles?: Map<string, number>,
): Promise<FolderSnapshot> {
  const snapshot = await snapshotFolder(ws.history, ws.folder, {
    skip,
    cache: snapshots.get(ws),
    racyWindowMs: ws.racyWindowMs,
    tempFiles,
  });
  snapshots.set(ws, snapshot);
  return snapshot;
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
}

/** Marks the plan of an unfinished checkout (a commit on top of its target). */
const PLAN_MARK = "vcs-workspace pending checkout";

interface CheckoutPlan {
  target: ObjectId;
  /** What the folder must hold when the checkout is done */
  files: FlatTree;
  /** Folder edits found when the plan was made: path to blob id (null: removed) */
  seen: Record<string, ObjectId | null>;
  conflicts: string[];
}

async function textOf(ws: GitWorkspace, entry: FlatEntry | undefined) {
  if (!entry) return new Uint8Array(0);
  const probe = await probeBlob(ws.history.blobs, entry.id, { loadText: true });
  return probe.binary ? undefined : probe.content;
}

/**
 * The plan to finish a checkout from `head` to `target`: the target's files, except where the
 * folder holds neither the head's nor the target's content (an edit made meanwhile). Such a
 * file keeps the edit, merged with the target's content: lines with git's markers for text,
 * the target's version next to it for binary content. Made once and stored, so finishing is
 * idempotent: a retry never merges a merged file again.
 */
async function makePlan(
  ws: GitWorkspace,
  head: ObjectId | undefined,
  target: ObjectId,
): Promise<CheckoutPlan> {
  const from = (await readCommitTree(ws.history, head)).files;
  const to = (await readCommitTree(ws.history, target)).files;
  const skipWrite = skipFor(ws, to);
  const skipRemove = skipFor(ws, from);
  const files: FlatTree = new Map(to);
  const seen: Record<string, ObjectId | null> = {};
  const conflicts: string[] = [];
  const taken = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...taken].sort()) {
    const h = inFolder(from.get(path));
    const t = inFolder(to.get(path));
    if (h?.id === t?.id || (t ? skipWrite(path) : skipRemove(path))) continue;
    const now = await currentFileId(ws.folder, path);
    if (now === t?.id || now === h?.id || now?.startsWith("directory:")) continue;
    conflicts.push(path);
    if (now === undefined) {
      seen[path] = null; // removed meanwhile: the target's change is kept
      continue;
    }
    const id = await ws.history.blobs.store(ws.folder.read(`/${path}`));
    seen[path] = id;
    const mine: FlatEntry = { id, mode: t?.mode ?? h?.mode ?? MODE_FILE };
    if (!t) {
      files.set(path, mine); // the target removes it: the edit is kept
      continue;
    }
    const [base, ours, theirs] = [await textOf(ws, h), await textOf(ws, mine), await textOf(ws, t)];
    if (base && ours && theirs) {
      const merged = mergeLines(base, ours, theirs, {
        oursLabel: "folder",
        theirsLabel: `checkout (${target.slice(0, 7)})`,
      });
      files.set(path, { id: await ws.history.blobs.store([merged.content]), mode: t.mode });
      continue;
    }
    files.set(path, mine);
    let aside = `${path}.theirs-${target.slice(0, 7)}`;
    for (let n = 2; taken.has(aside) || files.has(aside); n++) {
      aside = `${path}.theirs-${target.slice(0, 7)}-${n}`;
    }
    files.set(aside, t);
  }
  return { target, files, seen, conflicts };
}

async function storePlan(ws: GitWorkspace, plan: CheckoutPlan): Promise<ObjectId> {
  const meta = JSON.stringify({ seen: plan.seen, conflicts: plan.conflicts });
  return commitTree(ws, plan.files, [plan.target], `${PLAN_MARK}\n\n${meta}`);
}

async function loadPlan(ws: GitWorkspace, id: ObjectId): Promise<CheckoutPlan | undefined> {
  const commit = await ws.history.commits.load(id);
  if (!commit?.message.startsWith(PLAN_MARK)) return undefined;
  const meta = JSON.parse(commit.message.slice(PLAN_MARK.length).trim()) as {
    seen: Record<string, ObjectId | null>;
    conflicts: string[];
  };
  return {
    target: commit.parents[0],
    files: (await readCommitTree(ws.history, id)).files,
    seen: meta.seen,
    conflicts: meta.conflicts,
  };
}

/**
 * Finishes a checkout cut short, from its stored plan (made on the first attempt): every file
 * still holding the head's or the target's content, or the edit the plan saw, gets the plan's
 * content; then the branch moves to the target. A file edited again since the plan was made is
 * left as it is (the next commit records it).
 */
async function finishPendingCheckout(ws: GitWorkspace): Promise<string[]> {
  const ref = pendingRef(ws);
  const pending = (await ws.history.refs.resolve(ref))?.objectId;
  if (!pending) return [];
  const head = await workspaceHead(ws);
  let plan = await loadPlan(ws, pending);
  const target = plan?.target ?? pending;
  if (head === target) {
    await ws.history.refs.remove(ref);
    return [];
  }
  if (!plan) {
    plan = await makePlan(ws, head, target);
    await ws.history.refs.set(ref, await storePlan(ws, plan));
  }
  const from = (await readCommitTree(ws.history, head)).files;
  const to = (await readCommitTree(ws.history, target)).files;
  const skipWrite = skipFor(ws, to);
  const skipRemove = skipFor(ws, from);
  const touched: string[] = [];
  try {
    for (const path of new Set([...from.keys(), ...to.keys(), ...plan.files.keys()])) {
      const h = inFolder(from.get(path));
      const t = inFolder(to.get(path));
      const want = inFolder(plan.files.get(path));
      if (h?.id === want?.id && !(path in plan.seen)) continue;
      if (want ? skipWrite(path) : skipRemove(path)) continue;
      const seen = plan.seen[path];
      const accept = (now: ObjectId | undefined) =>
        now === h?.id ||
        now === t?.id ||
        now === want?.id ||
        (seen !== undefined && now === (seen ?? undefined));
      touched.push(path);
      try {
        await applyFolderPath(ws.history, ws.folder, path, want, {
          accept,
          expendable: skipRemove,
        });
      } catch (error) {
        // edited again since the plan was made: the edit stays, the next commit records it
        if (!(error instanceof FolderChangedError)) throw error;
      }
    }
  } finally {
    invalidate(ws, touched);
  }
  await moveBranch(ws, head, target);
  await ws.history.refs.remove(ref);
  return plan.conflicts;
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
  const conflicts = await finishPendingCheckout(ws);
  const head = await workspaceHead(ws);
  const current = await readCommitTree(ws.history, head);
  const skip = skipFor(ws, current.files);
  const tempFiles = new Map<string, number>();
  const snapshot = await folderSnapshot(ws, skip, tempFiles);
  await sweepTempFiles(ws.folder, tempFiles);
  const tree = await storeFlatTree(ws.history, composeTree(current.files, snapshot, skip));
  if (tree === current.tree) return { head, changed: false, conflicts };
  const who = person(ws);
  const commit = await ws.history.commits.store({
    tree,
    parents: head ? [head] : [],
    author: who,
    committer: who,
    message: message.endsWith("\n") ? message : `${message}\n`,
  });
  await moveBranch(ws, head, commit);
  return { head: commit, changed: true, conflicts };
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
  const skip = skipFor(ws, headFiles);
  // the folder must still be what `head` recorded: an edit made since is not overwritten
  const snapshot = await folderSnapshot(ws, skip);
  const expected = composeTree(headFiles, snapshot, skip);
  const tree = await storeFlatTree(ws.history, expected);
  if (tree !== (await readCommitTree(ws.history, head)).tree) throw new FolderChangedError();
  await ws.history.refs.set(pendingRef(ws), target);
  const changed = new Set<string>();
  for (const p of new Set([...headFiles.keys(), ...targetFiles.keys()])) {
    if (headFiles.get(p)?.id !== targetFiles.get(p)?.id) changed.add(p);
  }
  let done: { written: string[]; removed: string[] };
  try {
    done = await checkoutFolder(ws.history, ws.folder, headFiles, targetFiles, {
      // files under the target's submodules are not written, under the head's not removed
      skipWrite: skipFor(ws, targetFiles),
      skipRemove: skip,
      expendable: skip,
    });
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
