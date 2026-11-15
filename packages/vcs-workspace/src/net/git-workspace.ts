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

import type { HistoryWithOperations, ObjectId, PersonIdent } from "@statewalker/vcs-core";
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
  sameEntry,
  storeFlatTree,
} from "./flat-tree.js";
import {
  checkoutFolder,
  currentFileId,
  defaultIgnore,
  FolderChangedError,
  type FolderSnapshot,
  type IgnorePath,
  isSyncTempFile,
  probeCaseInsensitive,
  snapshotFolder,
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

/** What a checkout or a commit leaves alone in the folder. */
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

async function folderSnapshot(ws: GitWorkspace, skip: IgnorePath): Promise<FolderSnapshot> {
  const snapshot = await snapshotFolder(ws.history, ws.folder, skip, snapshots.get(ws));
  snapshots.set(ws, snapshot);
  return snapshot;
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

/**
 * Finishes a checkout cut short: files still at the branch's content get the target's, files
 * already at the target's stay, and files changed meanwhile are merged with the target's
 * content (both kept, reported). Then the branch moves to the target.
 */
async function finishPendingCheckout(ws: GitWorkspace): Promise<string[]> {
  const ref = pendingRef(ws);
  const target = (await ws.history.refs.resolve(ref))?.objectId;
  if (!target) return [];
  const head = await workspaceHead(ws);
  const conflicts: string[] = [];
  if (head !== target) {
    const from = (await readCommitTree(ws.history, head)).files;
    const to = (await readCommitTree(ws.history, target)).files;
    const skip = skipFor(ws, to);
    for (const path of new Set([...from.keys(), ...to.keys()])) {
      const h = inFolder(from.get(path));
      const t = inFolder(to.get(path));
      if (sameEntry(h, t) || skip(path)) continue;
      const now = await currentFileId(ws.folder, path);
      if (now === t?.id) continue;
      if (now === h?.id) {
        await checkoutFolder(
          ws.history,
          ws.folder,
          new Map(h ? [[path, h]] : []),
          new Map(t ? [[path, t]] : []),
        );
        continue;
      }
      // changed in the folder meanwhile: keep the edit, merged with the target's content
      conflicts.push(path);
      if (!t || now === undefined) continue;
      const read = async (id: ObjectId | undefined) => {
        if (!id) return new Uint8Array(0);
        const parts: Uint8Array[] = [];
        for await (const c of (await ws.history.blobs.load(id)) ?? []) parts.push(c);
        return concat(parts);
      };
      const parts: Uint8Array[] = [];
      for await (const c of ws.folder.read(`/${path}`)) parts.push(c);
      const merged = mergeLines(await read(h?.id), concat(parts), await read(t.id), {
        oursLabel: "folder",
        theirsLabel: `checkout (${target.slice(0, 7)})`,
      });
      await ws.folder.write(`/${path}`, [merged.content]);
    }
    await moveBranch(ws, head, target);
  }
  await ws.history.refs.remove(ref);
  return conflicts.sort();
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
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
  const snapshot = await folderSnapshot(ws, skip);
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

/** Paths that name one file on a case-insensitive folder: all but the first moved aside. */
function caseCollisions(files: FlatTree, tag: string): { files: FlatTree; moved: string[] } {
  const seen = new Set<string>();
  const taken = new Set([...files.keys()].map((p) => p.toLowerCase()));
  const out: FlatTree = new Map();
  const moved: string[] = [];
  for (const path of [...files.keys()].sort()) {
    const entry = files.get(path) as FlatEntry;
    const key = path.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.set(path, entry);
      continue;
    }
    let name = `${path}.${tag}`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${path}.${tag}-${n}`;
    taken.add(name.toLowerCase());
    seen.add(name.toLowerCase());
    out.set(name, entry);
    moved.push(path);
  }
  return { files: out, moved };
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

async function checkoutAndMove(
  ws: GitWorkspace,
  head: ObjectId | undefined,
  headFiles: FlatTree,
  target: ObjectId,
  targetFiles: FlatTree,
) {
  const skip = skipFor(ws, headFiles);
  const skipBoth = (path: string) => skip(path) || skipFor(ws, targetFiles)(path);
  // the folder must still be what `head` recorded: an edit made since is not overwritten
  const snapshot = await folderSnapshot(ws, skip);
  const expected = composeTree(headFiles, snapshot, skip);
  const tree = await storeFlatTree(ws.history, expected);
  if (tree !== (await readCommitTree(ws.history, head)).tree) throw new FolderChangedError();
  await ws.history.refs.set(pendingRef(ws), target);
  const done = await checkoutFolder(ws.history, ws.folder, headFiles, targetFiles, {
    skip: skipBoth,
  });
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
