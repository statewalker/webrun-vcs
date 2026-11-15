/**
 * Step 03: Garbage Collection
 *
 * This step demonstrates how Git garbage collection works:
 * - Identifies loose objects that are already packed
 * - Removes duplicate loose objects
 * - Compacts multiple pack files into one
 *
 * Key concepts:
 * - GC reduces storage by removing redundant objects
 * - Objects are kept if reachable from refs
 * - Unreachable objects may be pruned
 */

import { joinPath } from "@statewalker/vcs-utils/files";
import {
  countLooseObjects,
  createFileHistory,
  createFilesApi,
  GIT_DIR,
  getPackFileStats,
  listPackFiles,
  log,
  logInfo,
  logSection,
  logSuccess,
  looseObjectPath,
  OBJECTS_DIR,
  state,
} from "../shared/index.js";

/**
 * Delete loose object from filesystem.
 */
async function deleteLooseObject(objectId: string): Promise<void> {
  const files = createFilesApi();
  await files.remove(looseObjectPath(objectId));

  // Remove the fanout directory if it is now empty
  const parentDir = joinPath(OBJECTS_DIR, objectId.substring(0, 2));
  for await (const _entry of files.list(parentDir)) {
    return;
  }
  await files.remove(parentDir);
}

export async function run(): Promise<void> {
  logSection("Step 03: Garbage Collection");

  const history = state.history;
  if (!history) {
    throw new Error("History not initialized. Run step 01 first.");
  }

  // Check current state
  const { count: looseBefore, objects: looseObjectIds } = await countLooseObjects();
  const packsBefore = await listPackFiles();
  const packStatsBefore = await getPackFileStats();

  log("State before GC:");
  logInfo("  Loose objects", looseBefore);
  logInfo("  Pack files", packsBefore.length);
  if (packStatsBefore.length > 0) {
    for (const pack of packStatsBefore) {
      log(`    ${pack.name} (${pack.sizeFormatted})`);
    }
  }

  // Explain what GC does
  log("\n--- What Garbage Collection Does ---\n");
  log("1. Identifies loose objects that are already in pack files");
  log("2. Removes redundant loose objects");
  log("3. Optionally combines multiple pack files");
  log("4. Prunes unreachable objects (objects not referenced by any ref)");
  log("5. Repacks objects using delta compression");

  if (looseBefore === 0) {
    log("\nNo loose objects to clean up.");
    logSuccess("Repository is already optimized!");
    return;
  }

  // Check which objects are packed (by checking if pack exists)
  const packFiles = await listPackFiles();

  if (packFiles.length === 0) {
    log("\nNo pack files exist. Run step 02 first to create a pack.");
    log("Then run this step again to see GC in action.");
    return;
  }

  log("\n--- Performing Garbage Collection ---\n");

  // Close history before deleting files
  await history.close();

  // Delete loose objects that are now in the pack
  let deleted = 0;
  for (const objectId of looseObjectIds) {
    await deleteLooseObject(objectId);
    deleted++;
    log(`  Removed loose: ${objectId.substring(0, 7)}...`);
  }

  log(`\nDeleted ${deleted} loose objects`);

  // Reopen history
  const files = createFilesApi();
  state.history = await createFileHistory({
    files,
    gitDir: GIT_DIR,
    create: false,
  });

  // Check final state
  const { count: looseAfter } = await countLooseObjects();
  const packsAfter = await listPackFiles();
  const packStatsAfter = await getPackFileStats();

  log("\n--- State After GC ---\n");
  logInfo("  Loose objects", looseAfter);
  logInfo("  Pack files", packsAfter.length);
  if (packStatsAfter.length > 0) {
    for (const pack of packStatsAfter) {
      log(`    ${pack.name} (${pack.sizeFormatted})`);
    }
  }

  // Calculate savings
  if (looseBefore > looseAfter) {
    const reduction = ((looseBefore - looseAfter) / looseBefore) * 100;
    log(`\nReduced loose objects by ${reduction.toFixed(0)}%`);
  }

  // Explain GC strategies
  log("\n--- GC Strategies ---\n");
  log("Git supports different GC strategies:");
  log("");
  log("1. Auto GC (git gc --auto)");
  log("   - Runs when loose objects exceed threshold (~6700)");
  log("   - Runs when pack files exceed threshold (~50)");
  log("");
  log("2. Aggressive GC (git gc --aggressive)");
  log("   - Recomputes all deltas from scratch");
  log("   - Uses more CPU but may find better compression");
  log("   - Window size: 250 (vs default 10)");
  log("");
  log("3. Pruning (git gc --prune=<date>)");
  log("   - Removes unreachable objects older than date");
  log("   - Default: 2 weeks (to protect unfinished work)");

  logSuccess("\nGarbage collection complete!");
}
