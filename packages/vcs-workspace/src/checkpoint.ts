/**
 * {@link checkpoint} — snapshot the current cross-axis correspondence WITHOUT
 * running a workflow, and {@link makeCheckpoint} — the shared builder the
 * workflows use to record progress. A checkpoint answers "which commit
 * corresponds to the exact synced file state" from the record alone.
 */

import { manifestOf } from "./sync-options.js";
import type { WorkflowOptions, Workspace, WorkspaceCheckpoint, WorkspaceRemotes } from "./types.js";

/** Assemble a {@link WorkspaceCheckpoint} from accumulated progress. */
export function makeCheckpoint(
  opts: Pick<WorkflowOptions, "id" | "now">,
  progress: {
    workingTreeManifest: string;
    commit?: string;
    fileRemotes: Record<string, string>;
    historyRemotes: Record<string, string>;
  },
): WorkspaceCheckpoint {
  return {
    id: opts.id ?? progress.workingTreeManifest,
    workingTreeManifest: progress.workingTreeManifest,
    commit: progress.commit,
    fileRemotes: { ...progress.fileRemotes },
    historyRemotes: { ...progress.historyRemotes },
    createdAt: opts.now ?? new Date().toISOString(),
  };
}

/**
 * Record the current correspondence: the working-tree manifest, the repository's
 * current HEAD commit (if any), and each file remote's current manifest. History
 * remotes are left empty — a pushed-commit id is only known after a push, and
 * this snapshot performs no network round-trip.
 */
export async function checkpoint(
  ws: Workspace,
  remotes: WorkspaceRemotes,
  opts: Pick<WorkflowOptions, "hashContent" | "id" | "now">,
): Promise<WorkspaceCheckpoint> {
  const workingTreeManifest = await manifestOf(ws.workingTree, opts.hashContent);
  const commit = ws.repository ? await ws.repository.head() : undefined;
  const fileRemotes: Record<string, string> = {};
  for (const [name, remote] of remotes.fileRemotes) {
    fileRemotes[name] = await manifestOf(remote, opts.hashContent);
  }
  return makeCheckpoint(opts, { workingTreeManifest, commit, fileRemotes, historyRemotes: {} });
}
