/**
 * Pure helpers shared by the workflows.
 *
 * {@link buildSyncOptions} constructs the {@link SyncOptions} the orchestrator
 * hands to `@statewalker/webrun-files-sync`. It encodes the BASELINE RULE: the file
 * sync is anchored ONLY by the file axis' own state — it NEVER carries a commit
 * id. It sets no `anchorStore` and no commit-derived `pairKey`; change detection
 * is against the destination's current state, not any git commit.
 */

import type { ByteStream, SyncOptions } from "@statewalker/webrun-files-sync";
import { buildAnchor } from "@statewalker/webrun-files-sync";
import type { FilesApi, SyncVersioningPolicy, WorkflowOptions } from "./types.js";

/** file-sync options for a workflow — no commit id ever leaks in as a baseline. */
export function buildSyncOptions(
  hashContent: (input: ByteStream) => Promise<string>,
  policy: SyncVersioningPolicy,
  opts: Pick<WorkflowOptions, "filter">,
): SyncOptions {
  const syncOpts: SyncOptions = { hashContent };
  if (policy.verify) syncOpts.verify = policy.verify;
  if (opts.filter) syncOpts.filter = opts.filter;
  return syncOpts;
}

async function* one(bytes: Uint8Array): ByteStream {
  yield bytes;
}

/**
 * The file-state identity of an endpoint — a content manifest of the tree,
 * decoupled from git. Two trees with identical file content hash identically;
 * this is what a {@link WorkspaceCheckpoint} records as `workingTreeManifest`.
 */
export async function manifestOf(
  files: FilesApi,
  hashContent: (input: ByteStream) => Promise<string>,
): Promise<string> {
  const anchor = await buildAnchor(files, hashContent);
  const canonical: Record<string, string> = {};
  for (const path of Object.keys(anchor.entries).sort()) {
    canonical[path] = anchor.entries[path].contentId;
  }
  return hashContent(one(new TextEncoder().encode(JSON.stringify(canonical))));
}
