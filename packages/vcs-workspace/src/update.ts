/**
 * {@link update} — the remote → local workflow (the pull direction).
 *
 * Composition: `files-sync` copy every fileRemote → workingTree (Axis A). It is
 * a `copy` (not `sync`): remote changes land locally, local-only files are kept.
 * A pull creates NO commit, and the history axis is not fetched here — the
 * structural {@link GitRemote} is push-only per the WorkspaceRemotes contract, so
 * history-fetch is out of scope for this thin orchestrator. Ends with a recorded
 * {@link WorkspaceCheckpoint} of the resulting file-state correspondence.
 */

import { execute, plan } from "@statewalker/webrun-files-sync";
import { makeCheckpoint } from "./checkpoint.js";
import { buildSyncOptions, manifestOf } from "./sync-options.js";
import type {
  SyncVersioningPolicy,
  WorkflowOptions,
  Workspace,
  WorkspaceEvent,
  WorkspaceRemotes,
} from "./types.js";

export async function* update(
  ws: Workspace,
  remotes: WorkspaceRemotes,
  policy: SyncVersioningPolicy,
  opts: WorkflowOptions,
): AsyncIterable<WorkspaceEvent> {
  const { hashContent } = opts;
  const fileRemotes: Record<string, string> = {};

  for (const [name, remote] of remotes.fileRemotes) {
    const syncOpts = buildSyncOptions(hashContent, policy, opts);
    const syncPlan = await plan(remote, ws.workingTree, "copy", syncOpts);
    yield { type: "scan", remote: name, op: "copy", actions: syncPlan.actions.length };
    for await (const e of execute(syncPlan, remote, ws.workingTree, syncOpts)) {
      if (e.type === "done" && (e.action.kind === "copy" || e.action.kind === "update")) {
        yield { type: "transfer", remote: name, index: e.index, path: e.action.path };
      }
    }
    fileRemotes[name] = await manifestOf(remote, hashContent);
  }

  const workingTreeManifest = await manifestOf(ws.workingTree, hashContent);
  const commit = ws.repository ? await ws.repository.head() : undefined;
  yield {
    type: "checkpoint",
    checkpoint: makeCheckpoint(opts, {
      workingTreeManifest,
      commit,
      fileRemotes,
      historyRemotes: {},
    }),
  };
}
