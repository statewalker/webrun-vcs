/**
 * `syncWorkspace`: one round trip between a workspace and a remote repository, as `git commit
 * -a && git pull && git push` would do it for a folder — commit the folder, fetch the remote
 * branch, bring it in (fast-forward or merge), push the result, never forced. A push the remote
 * refuses because it moved meanwhile starts the round again, a bounded number of times.
 */

import type { ObjectId } from "@statewalker/vcs-core";
import type { PushRefUpdate } from "@statewalker/vcs-transport";
import { FolderChangedError, type SkippedPath } from "./folder-tree.js";
import {
  type ConflictMode,
  commitFolder,
  type GitWorkspace,
  type Integration,
  integrateCommit,
  type MergeInProgress,
  runExclusive,
  workspaceHead,
} from "./git-workspace.js";
import type { SyncRemote } from "./sync-remote.js";

/** A step of a sync, in the order they happen (a retried round repeats them). */
export type SyncEvent =
  | { type: "commit"; attempt: number; commit: ObjectId }
  | { type: "fetch"; attempt: number; remoteHead?: ObjectId }
  | {
      type: "integrate";
      attempt: number;
      kind: Integration["kind"];
      head?: ObjectId;
      conflicts: string[];
    }
  | { type: "push"; attempt: number; head: ObjectId; status: PushRefUpdate["status"] }
  | { type: "retry"; attempt: number; reason: string }
  | { type: "skipped"; attempt: number; paths: SkippedPath[] }
  | { type: "rejoined"; attempt: number; paths: string[] }
  /**
   * A merge with conflicts is in progress: `started` when this sync's merge stopped, false
   * when the sync was refused because an earlier one is not concluded yet
   */
  | {
      type: "conflicted";
      attempt: number;
      started: boolean;
      theirs: ObjectId;
      conflicts: string[];
    };

/** Options of {@link syncWorkspace}. */
export interface SyncWorkspaceOptions {
  /** Message of the commit of local changes (default `Workspace changes`) */
  message?: string;
  /** Rounds before giving up when the remote keeps moving (default 5) */
  maxAttempts?: number;
  /** Aborts the fetch and the push */
  signal?: AbortSignal;
  /** Each step as it happens */
  onEvent?: (event: SyncEvent) => void;
  /**
   * What a merge with conflicts does (default: the workspace's `onConflict`, itself `stop` by
   * default): `stop` writes the merge result into the folder and stops, as git does, with
   * nothing committed or pushed; `commit` commits the conflicts, pushes, and goes on
   */
  onConflict?: ConflictMode;
  /** Files back from being ignored to commit as the folder holds them (see `commitWorkspaceChanges`) */
  include?: string[];
}

/** What {@link syncWorkspace} did. */
export interface SyncWorkspaceResult {
  /** The commit the workspace and the remote branch both hold now (undefined: both empty) */
  head?: ObjectId;
  /** Whether local changes were committed */
  committed: boolean;
  /**
   * How the remote's commits came in (the last round's). `conflicted`: a merge with conflicts
   * is in progress (`merge`), started by this sync or left by an earlier one; nothing was
   * pushed, and syncs do nothing more until it is concluded or aborted
   */
  integration: Integration["kind"];
  /** Whether the push moved the remote branch */
  pushed: boolean;
  /**
   * Paths merged with both sides kept (git's conflict markers in text files; the other side
   * as `<path>.theirs-<id>` for binary ones), for someone to resolve: in the folder, with the
   * merge in progress (`onConflict: "stop"`), or committed and pushed (`"commit"`). Empty when
   * the merge was clean.
   */
  conflicts: string[];
  /** Rounds it took (more than one when the remote moved during a round) */
  attempts: number;
  /**
   * Folder paths left out of history (as the last commit saw the folder): nested
   * repositories, whose files belong to them (the branch keeps what it had there), and names
   * no tree may hold
   */
  skipped: SkippedPath[];
  /**
   * Paths that were left out and came back during this sync (a nested repository removed,
   * `ignore` changed): brought up to the branch, or merged where both sides changed
   */
  rejoined: string[];
  /** The merge with conflicts in progress (`integration: "conflicted"`) */
  merge?: MergeInProgress;
}

/** A sync that could not finish; the workspace and its repository are left consistent. */
export class SyncError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SyncError";
  }
}

/** Refusals that mean "the remote moved since you looked": fetch, merge and push again. */
const RETRY_STATUSES = new Set<PushRefUpdate["status"]>([
  "rejected-nonfastforward",
  "rejected-fetch-first",
  "rejected-stale",
]);
/**
 * receive-pack's reasons for a ref that moved under its compare-and-swap (git's ref
 * transaction messages); anything else, a declined hook for one, is a refusal
 */
const RETRY_REASONS =
  /cannot lock ref|failed to lock|is at [0-9a-f]+ but expected|failed to update ref|non-fast-forward|fetch first|stale info|^locked$/i;

function asSyncError(what: string, error: unknown): SyncError {
  if (error instanceof SyncError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new SyncError(`${what}: ${reason}`, { cause: error });
}

function shouldRetry(update: PushRefUpdate): boolean {
  if (RETRY_STATUSES.has(update.status)) return true;
  return update.status === "remote-rejected" && RETRY_REASONS.test(update.message ?? "");
}

/**
 * Syncs the workspace with `remote`: commits the folder's changes, fetches the remote branch
 * into `refs/remotes/<remote.name>/<branch>`, integrates it (a fast-forward, or a merge commit),
 * and pushes the branch. A merge with conflicts stops as git stops (the default,
 * `onConflict: "stop"`): the conflicts are written into the folder, nothing is committed or
 * pushed, and later syncs only report them until {@link concludeMerge} or {@link abortMerge}.
 * With `onConflict: "commit"` the conflicts are committed in the files and pushed instead. A push refused because the remote moved meanwhile (non-fast-forward, or a ref that
 * changed under receive-pack's compare-and-swap) runs the round again, up to `maxAttempts`.
 *
 * Failures (an unreachable remote, a link cut mid-transfer, a push refused for another reason)
 * reject with the workspace consistent: the branch always names the commit the folder holds,
 * objects arrive before refs move on both sides, and the next sync completes the work.
 *
 * Syncs and commits of one workspace run one at a time.
 *
 * @example
 * ```ts
 * const result = await syncWorkspace(ws, httpRemote({ url: "https://example.com/notes.git" }));
 * if (result.integration === "conflicted") console.warn("resolve, then concludeMerge:", result.conflicts);
 * ```
 */
export function syncWorkspace(
  ws: GitWorkspace,
  remote: SyncRemote,
  options: SyncWorkspaceOptions = {},
): Promise<SyncWorkspaceResult> {
  return runExclusive(ws, () => syncRounds(ws, remote, options));
}

async function syncRounds(
  ws: GitWorkspace,
  remote: SyncRemote,
  options: SyncWorkspaceOptions,
): Promise<SyncWorkspaceResult> {
  const maxAttempts = options.maxAttempts ?? 5;
  const emit = (event: SyncEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // a listener cannot break the sync
    }
  };
  const branchName = ws.branch.slice("refs/heads/".length);
  const tracking = `refs/remotes/${remote.name}/${branchName}`;
  const transfer = {
    repository: ws.repository,
    refStore: ws.refStore,
    signal: options.signal,
  };
  const conflicts = new Set<string>();
  let committed = false;
  let skipped: SkippedPath[] = [];
  const rejoined = new Set<string>();
  let lastReason = "";
  let folderKeptChanging = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let local: Awaited<ReturnType<typeof commitFolder>>;
    try {
      local = await commitFolder(ws, options.message ?? "Workspace changes", {
        include: options.include,
      });
    } catch (error) {
      throw asSyncError("committing the folder failed", error);
    }
    if (local.merge) {
      // a merge with conflicts in progress: nothing is fetched, merged or pushed until the
      // user concludes it (or aborts it)
      if (local.skipped.length > 0) emit({ type: "skipped", attempt, paths: local.skipped });
      emit({
        type: "conflicted",
        attempt,
        started: false,
        theirs: local.merge.theirs,
        conflicts: local.merge.conflicts,
      });
      return {
        head: local.head,
        committed: false,
        integration: "conflicted",
        pushed: false,
        conflicts: [...new Set([...conflicts, ...local.merge.conflicts])].sort(),
        attempts: attempt,
        skipped: local.skipped,
        rejoined: [...rejoined].sort(),
        merge: local.merge,
      };
    }
    for (const path of local.conflicts) conflicts.add(path);
    skipped = local.skipped;
    if (skipped.length > 0) emit({ type: "skipped", attempt, paths: skipped });
    for (const path of local.rejoined) rejoined.add(path);
    if (local.rejoined.length > 0) emit({ type: "rejoined", attempt, paths: local.rejoined });
    if (local.changed && local.head) {
      committed = true;
      emit({ type: "commit", attempt, commit: local.head });
    }

    try {
      await remote.fetch({ ...transfer, refspecs: [`+${ws.branch}:${tracking}`] });
    } catch (error) {
      throw new SyncError(`fetch from ${remote.name} failed: ${String(error)}`, { cause: error });
    }
    const theirs = (await ws.history.refs.resolve(tracking))?.objectId;
    emit({ type: "fetch", attempt, remoteHead: theirs });

    let integration: Integration = {
      kind: "up-to-date",
      head: local.head,
      conflicts: [],
      written: [],
      removed: [],
    };
    if (theirs) {
      try {
        integration = await integrateCommit(ws, theirs, {
          theirsName: `${remote.name}/${branchName}`,
          onConflict: options.onConflict,
        });
      } catch (error) {
        if (!(error instanceof FolderChangedError)) {
          throw asSyncError(`bringing in ${remote.name}/${branchName} failed`, error);
        }
        lastReason = error.message;
        folderKeptChanging = true;
        emit({ type: "retry", attempt, reason: lastReason });
        continue;
      }
      for (const path of integration.conflicts) conflicts.add(path);
      emit({
        type: "integrate",
        attempt,
        kind: integration.kind,
        head: integration.head,
        conflicts: integration.conflicts,
      });
    }
    if (integration.kind === "conflicted" && integration.merge) {
      // stopped as git stops: the merge result is in the folder, nothing committed or pushed
      emit({
        type: "conflicted",
        attempt,
        started: true,
        theirs: integration.merge.theirs,
        conflicts: integration.merge.conflicts,
      });
      return {
        head: await workspaceHead(ws),
        committed,
        integration: "conflicted",
        pushed: false,
        conflicts: [...conflicts].sort(),
        attempts: attempt,
        skipped,
        rejoined: [...rejoined].sort(),
        merge: integration.merge,
      };
    }

    const head = await workspaceHead(ws);
    const done = (pushed: boolean): SyncWorkspaceResult => ({
      head,
      committed,
      integration: integration.kind,
      pushed,
      conflicts: [...conflicts].sort(),
      attempts: attempt,
      skipped,
      rejoined: [...rejoined].sort(),
    });
    if (!head || head === theirs) return done(false);

    let update: PushRefUpdate | undefined;
    try {
      const result = await remote.push({ ...transfer, refspecs: [`${ws.branch}:${ws.branch}`] });
      update = result.updates.find((u) => u.remoteRef === ws.branch);
      if (result.unpack && !result.unpack.ok) {
        throw new Error(`unpack failed: ${result.unpack.message ?? "unknown"}`);
      }
    } catch (error) {
      throw new SyncError(`push to ${remote.name} failed: ${String(error)}`, { cause: error });
    }
    if (!update) throw new SyncError(`push to ${remote.name}: no report for ${ws.branch}`);
    emit({ type: "push", attempt, head, status: update.status });
    if (update.status === "ok" || update.status === "up-to-date") {
      // the remote holds `head` now: remember it, as git updates the tracking ref on push
      await ws.history.refs.set(tracking, head).catch(() => undefined);
      return done(update.status === "ok");
    }
    if (!shouldRetry(update)) {
      throw new SyncError(
        `push to ${remote.name} refused: ${update.summary}${update.message ? ` (${update.message})` : ""}`,
      );
    }
    lastReason = update.message ?? update.summary;
    folderKeptChanging = false;
    emit({ type: "retry", attempt, reason: lastReason });
  }
  if (folderKeptChanging) {
    throw new SyncError(
      `the folder kept changing during the sync (${maxAttempts} attempts; last: ${lastReason})`,
    );
  }
  throw new SyncError(
    `no agreement with ${remote.name} after ${maxAttempts} attempts (last: ${lastReason})`,
  );
}
