/**
 * {@link publish} — the local → remote workflow.
 *
 * Sequence (each step an INDEPENDENT engine call, each idempotent):
 *   1. `files-sync` sync workingTree → every fileRemote (Axis A).
 *   2. (policy.commitAfterSync) `repository.commit(...)` (Axis B).
 *   3. upload missing large objects to each history remote's object store.
 *   4. (policy.pushAfterCommit) push every history remote (Axis B).
 *   5. record a {@link WorkspaceCheckpoint} tying the manifest to the commit.
 *
 * Best-effort + resumable: a failing step emits `failed` + a progress-recording
 * `checkpoint`, then stops. Re-running with that checkpoint in `opts.resume`
 * skips the steps it already records — no duplicate commit, no duplicate push.
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

export async function* publish(
  ws: Workspace,
  remotes: WorkspaceRemotes,
  policy: SyncVersioningPolicy,
  opts: WorkflowOptions,
): AsyncIterable<WorkspaceEvent> {
  const { hashContent } = opts;
  const resume = opts.resume;
  const workingTreeManifest = await manifestOf(ws.workingTree, hashContent);

  const fileRemotes: Record<string, string> = { ...(resume?.fileRemotes ?? {}) };
  const historyRemotes: Record<string, string> = { ...(resume?.historyRemotes ?? {}) };

  // 1. file sync (Axis A) — one-way mirror workingTree → each fileRemote.
  for (const [name, remote] of remotes.fileRemotes) {
    if (fileRemotes[name]) {
      yield { type: "skipped", step: `sync:${name}`, reason: "already synced" };
      continue;
    }
    const syncOpts = buildSyncOptions(hashContent, policy, opts);
    const syncPlan = await plan(ws.workingTree, remote, "sync", syncOpts);
    yield { type: "scan", remote: name, op: "sync", actions: syncPlan.actions.length };
    for await (const e of execute(syncPlan, ws.workingTree, remote, syncOpts)) {
      if (e.type === "done" && (e.action.kind === "copy" || e.action.kind === "update")) {
        yield { type: "transfer", remote: name, index: e.index, path: e.action.path };
      }
    }
    fileRemotes[name] = workingTreeManifest;
  }

  // 2. commit (Axis B) — skipped on resume when a commit is already recorded.
  let commit = resume?.commit;
  if (policy.commitAfterSync && ws.repository && !commit) {
    if (policy.commitOnlyWhenChanged && !(await ws.repository.hasChanges())) {
      yield { type: "skipped", step: "commit", reason: "no changes" };
    } else {
      const r = await ws.repository.commit({ message: opts.message });
      commit = r.commit;
      yield { type: "commit", commit: r.commit, changed: r.changed };
    }
  }

  // 3. upload missing large objects to each history remote that accepts them.
  if (ws.largeObjects && opts.largeObjects?.length) {
    for (const [name, remote] of remotes.historyRemotes) {
      if (!remote.objects) continue;
      for (const id of opts.largeObjects) {
        if (await remote.objects.has(id)) continue;
        await remote.objects.put(ws.largeObjects.read(id));
        yield { type: "upload", remote: name, object: id };
      }
    }
  }

  // 4. push (Axis B) — skipped per remote when already recorded on resume.
  if (policy.pushAfterCommit && commit) {
    const refspecs = opts.refspecs ?? ["refs/heads/main:refs/heads/main"];
    for (const [name, remote] of remotes.historyRemotes) {
      if (historyRemotes[name]) {
        yield { type: "skipped", step: `push:${name}`, reason: "already pushed" };
        continue;
      }
      try {
        const r = await remote.push(refspecs);
        historyRemotes[name] = r.commit;
        yield { type: "push", remote: name, commit: r.commit };
      } catch (err) {
        yield { type: "failed", step: `push:${name}`, reason: String(err) };
        yield {
          type: "checkpoint",
          checkpoint: makeCheckpoint(opts, {
            workingTreeManifest,
            commit,
            fileRemotes,
            historyRemotes,
          }),
        };
        return;
      }
    }
  }

  // 5. record the correspondence checkpoint.
  yield {
    type: "checkpoint",
    checkpoint: makeCheckpoint(opts, { workingTreeManifest, commit, fileRemotes, historyRemotes }),
  };
}
