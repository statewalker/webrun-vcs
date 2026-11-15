/**
 * A folder kept as git history: the folder's files are committed on one branch of a
 * repository, and that branch's tip is always the commit the folder was last committed or
 * checked out at. Everything that changes the branch here first brings the folder to the new
 * commit and moves the branch last, so a failure in between leaves the branch at a commit
 * whose changes the folder still shows (the next commit records them again, and a merge sees
 * the same change on both sides).
 */

import type { HistoryWithOperations, ObjectId, PersonIdent } from "@statewalker/vcs-core";
import {
  createRepositoryFacade,
  createTransportRefStore,
  type RefStore,
  type RepositoryFacade,
} from "@statewalker/vcs-transport";
import type { FilesApi } from "@statewalker/webrun-files";
import { type FlatTree, readCommitTree, storeFlatTree } from "./flat-tree.js";
import {
  checkoutFolder,
  defaultIgnore,
  folderMatches,
  type IgnorePath,
  snapshotFolder,
} from "./folder-tree.js";
import { mergeFlatTrees } from "./merge-trees.js";

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
  /** Folder paths left out of history (default: `.git/`) */
  ignore?: IgnorePath;
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
  };
}

// one queue per workspace: its commits, merges and checkouts never interleave
const queues = new WeakMap<GitWorkspace, Promise<unknown>>();

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

/** What {@link commitWorkspaceChanges} did. */
export interface WorkspaceCommit {
  /** The branch tip afterwards (undefined: nothing ever committed, the folder is empty) */
  head?: ObjectId;
  /** Whether a commit was made */
  changed: boolean;
}

/**
 * The commit step of {@link commitWorkspaceChanges}, without taking the workspace's queue: for
 * code that already runs inside {@link runExclusive} (a sync).
 */
export async function commitFolder(ws: GitWorkspace, message: string): Promise<WorkspaceCommit> {
  const head = await workspaceHead(ws);
  const current = await readCommitTree(ws.history, head);
  const files = await snapshotFolder(ws.history, ws.folder, ws.ignore);
  const tree = await storeFlatTree(ws.history, files);
  if (tree === current.tree) return { head, changed: false };
  const who = person(ws);
  const commit = await ws.history.commits.store({
    tree,
    parents: head ? [head] : [],
    author: who,
    committer: who,
    message: message.endsWith("\n") ? message : `${message}\n`,
  });
  await moveBranch(ws, head, commit);
  return { head: commit, changed: true };
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
  /** Paths merged with both sides kept (see the merge) */
  conflicts: string[];
  /** Folder paths written and removed */
  written: string[];
  removed: string[];
}

/** The folder changed while a fetched commit was being checked out: commit and try again. */
export class FolderChangedError extends Error {
  constructor() {
    super("the folder changed during the sync");
    this.name = "FolderChangedError";
  }
}

async function checkoutAndMove(
  ws: GitWorkspace,
  head: ObjectId | undefined,
  headFiles: FlatTree,
  target: ObjectId,
  targetFiles: FlatTree,
) {
  // the folder must still be what `head` recorded: an edit made since is not overwritten
  if (!(await folderMatches(ws.history, ws.folder, headFiles, ws.ignore))) {
    throw new FolderChangedError();
  }
  const done = await checkoutFolder(ws.history, ws.folder, headFiles, targetFiles);
  await moveBranch(ws, head, target);
  return done;
}

/**
 * Brings commit `theirs` (already in the repository) into the workspace: nothing when the
 * branch contains it, a fast-forward when the branch is behind it, a merge commit otherwise.
 * The folder is checked out at the result before the branch moves. Call it with the folder
 * committed (see {@link commitWorkspaceChanges}); a folder that changed since is not touched
 * ({@link FolderChangedError}). Like {@link commitFolder} it does not take the workspace's queue.
 */
export async function integrateCommit(
  ws: GitWorkspace,
  theirs: ObjectId,
  message?: string,
): Promise<Integration> {
  const { commits } = ws.history;
  const head = await workspaceHead(ws);
  const none = { conflicts: [], written: [], removed: [] };
  if (head === theirs || (head && (await commits.isAncestor(theirs, head)))) {
    return { kind: "up-to-date", head, ...none };
  }
  const ours = await readCommitTree(ws.history, head);
  if (!head || (await commits.isAncestor(head, theirs))) {
    const target = await readCommitTree(ws.history, theirs);
    const done = await checkoutAndMove(ws, head, ours.files, theirs, target.files);
    return { kind: "fast-forward", head: theirs, conflicts: [], ...done };
  }
  const [base] = await commits.findMergeBase(head, theirs);
  const baseTree = await readCommitTree(ws.history, base);
  const theirTree = await readCommitTree(ws.history, theirs);
  const merged = await mergeFlatTrees(
    ws.history,
    baseTree.files,
    ours.files,
    theirTree.files,
    `theirs-${theirs.slice(0, 7)}`,
  );
  const tree = await storeFlatTree(ws.history, merged.files);
  const who = person(ws);
  const lines = [message ?? `Merge ${theirs.slice(0, 7)} into ${ws.branch.slice(11)}`];
  if (merged.conflicts.length > 0) {
    lines.push("", "Conflicts:", ...merged.conflicts.map((p) => `\t${p}`));
  }
  const commit = await commits.store({
    tree,
    parents: [head, theirs],
    author: who,
    committer: who,
    message: `${lines.join("\n")}\n`,
  });
  const done = await checkoutAndMove(ws, head, ours.files, commit, merged.files);
  return { kind: "merge", head: commit, conflicts: merged.conflicts, ...done };
}
