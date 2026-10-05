/**
 * {@link restore} — drive the working tree back to a recorded correspondence.
 *
 * Given a {@link WorkspaceCheckpoint}, reset the working tree to the commit the
 * checkpoint ties to the synced file state (`repository.checkout`). It reads the
 * correspondence from the record ALONE — no git walk to infer which commit
 * matches the files. With no repository or no recorded commit there is nothing
 * to check out; the workflow just echoes the target checkpoint.
 */

import type { Workspace, WorkspaceCheckpoint, WorkspaceEvent } from "./types.js";

export async function* restore(
  ws: Workspace,
  checkpoint: WorkspaceCheckpoint,
): AsyncIterable<WorkspaceEvent> {
  if (ws.repository && checkpoint.commit) {
    await ws.repository.checkout(checkpoint.commit);
    yield { type: "commit", commit: checkpoint.commit, changed: false };
  } else {
    yield { type: "skipped", step: "checkout", reason: "no repository or commit recorded" };
  }
  yield { type: "checkpoint", checkpoint };
}
