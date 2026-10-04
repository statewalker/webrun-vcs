/**
 * Shared utilities for the staging and checkout example
 */

import { Git } from "@statewalker/vcs-commands";
import { createMemoryHistory, FileMode, type History } from "@statewalker/vcs-core";
import {
  createMemoryCheckout,
  createMemoryGitStaging,
  createMemoryWorkingCopy,
  createMemoryWorktree,
  MergeStage,
  type WorkingCopy,
} from "@statewalker/vcs-working-tree";

// Shared state
let sharedWorkingCopy: WorkingCopy | null = null;
let sharedGit: Git | null = null;
let sharedHistory: History | null = null;

/**
 * Get or create the shared Git working copy and facade
 */
export async function getGit(): Promise<{
  git: Git;
  workingCopy: WorkingCopy;
  history: History;
}> {
  if (!sharedWorkingCopy || !sharedGit || !sharedHistory) {
    // Create the History (object store)
    sharedHistory = createMemoryHistory();
    await sharedHistory.initialize();

    // Create the Staging area
    const staging = createMemoryGitStaging();

    // Create the Checkout (HEAD, staging, operation states)
    const checkout = createMemoryCheckout({ staging });

    // Create the Worktree (filesystem access)
    const worktree = createMemoryWorktree({
      blobs: sharedHistory.blobs,
      trees: sharedHistory.trees,
    });

    // Compose into WorkingCopy
    sharedWorkingCopy = createMemoryWorkingCopy({
      history: sharedHistory,
      checkout,
      worktree,
    });

    // Create Git facade
    sharedGit = Git.fromWorkingCopy(sharedWorkingCopy);
  }
  return { git: sharedGit, workingCopy: sharedWorkingCopy, history: sharedHistory };
}

/**
 * Reset the shared state (for fresh start)
 */
export async function resetState(): Promise<void> {
  if (sharedHistory) {
    await sharedHistory.close();
  }
  sharedWorkingCopy = null;
  sharedGit = null;
  sharedHistory = null;
}

/**
 * Helper function to add a file to staging
 */
export async function addFileToStaging(
  workingCopy: WorkingCopy,
  path: string,
  content: string,
): Promise<string> {
  const data = new TextEncoder().encode(content);
  const objectId = await workingCopy.history.blobs.store([data]);

  const editor = workingCopy.checkout.staging.createEditor();
  editor.add({
    path,
    apply: () => ({
      path,
      mode: FileMode.REGULAR_FILE,
      objectId,
      stage: MergeStage.MERGED,
      size: data.length,
      mtime: Date.now(),
    }),
  });
  await editor.finish();

  return objectId;
}

/**
 * Format ObjectId for display
 */
export function shortId(id: string): string {
  return id.slice(0, 7);
}

/**
 * Print a section header
 */
export function printSection(title: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

/**
 * Print a step header
 */
export function printStep(num: number, title: string): void {
  console.log(`\n--- Step ${num}: ${title} ---`);
}

/**
 * Format file mode for display
 */
export function formatMode(mode: number): string {
  if (mode === FileMode.REGULAR_FILE) return "100644 (file)";
  if (mode === FileMode.EXECUTABLE_FILE) return "100755 (executable)";
  if (mode === FileMode.SYMLINK) return "120000 (symlink)";
  if (mode === FileMode.TREE) return "040000 (tree)";
  return mode.toString(8);
}

export type { Git } from "@statewalker/vcs-commands";
// Re-export types
export { FileMode } from "@statewalker/vcs-core";
export type { WorkingCopy } from "@statewalker/vcs-working-tree";
export { MergeStage } from "@statewalker/vcs-working-tree";
